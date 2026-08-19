import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const TERMINAL_STATES = new Set(["COMPLETED", "REFUNDED", "FAILED", "CANCELED"]);
const VALUE_METHODS = new Set([
  "/invoicesrpc.Invoices/AddHoldInvoice",
  "/invoicesrpc.Invoices/SettleInvoice",
  "/invoicesrpc.Invoices/CancelInvoice",
  "/routerrpc.Router/SendPaymentV2",
  "evm:claim",
]);
const METHODS_REQUIRING_RESERVATION = new Set([
  "/invoicesrpc.Invoices/SettleInvoice",
  "/routerrpc.Router/SendPaymentV2",
  "evm:claim",
]);

export const COORDINATOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settlements (
  settlement_id TEXT PRIMARY KEY NOT NULL,
  pricing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lightning-to-bit', 'bit-to-lightning')),
  nonce_authority_digest TEXT NOT NULL,
  intent_nonce TEXT NOT NULL,
  intent_digest TEXT NOT NULL UNIQUE,
  payment_hash TEXT NOT NULL UNIQUE,
  invoice_digest TEXT NOT NULL,
  amount_sats TEXT NOT NULL,
  quote_receipt_digest TEXT NOT NULL,
  selected_set_digest TEXT NOT NULL,
  selected_offer_id TEXT NOT NULL,
  capacity_epoch INTEGER NOT NULL,
  record_digest TEXT NOT NULL,
  reservation_id TEXT UNIQUE,
  reservation_tx_hash TEXT,
  reservation_block_number INTEGER,
  reservation_block_hash TEXT,
  reservation_digest TEXT,
  last_action_id TEXT,
  state TEXT NOT NULL,
  reconciliation_required INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_required IN (0, 1)),
  halt_code TEXT,
  terminal_state TEXT CHECK (terminal_state IS NULL OR terminal_state IN ('COMPLETED', 'REFUNDED', 'FAILED', 'CANCELED')),
  terminal_proof_digest TEXT,
  terminal_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (direction, nonce_authority_digest, intent_nonce),
  CHECK (pricing_id <> settlement_id),
  CHECK ((reservation_id IS NULL) = (reservation_digest IS NULL)),
  CHECK ((terminal_state IS NULL) = (terminal_at IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS coordinator_actions (
  action_id TEXT PRIMARY KEY NOT NULL,
  settlement_id TEXT NOT NULL REFERENCES settlements(settlement_id) ON DELETE RESTRICT,
  method TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  payload_digest TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  payment_hash TEXT NOT NULL,
  invoice_digest TEXT NOT NULL,
  amount_sats TEXT NOT NULL,
  capacity_epoch INTEGER NOT NULL,
  record_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'DISPATCHING', 'CONFIRMED', 'FAILED', 'UNKNOWN')),
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0 AND dispatch_count <= 1),
  result_digest TEXT,
  result_code TEXT,
  planned_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  resolved_at INTEGER,
  UNIQUE (settlement_id, method)
) STRICT;

CREATE TABLE IF NOT EXISTS coordinator_evm_transactions (
  action_id TEXT PRIMARY KEY NOT NULL REFERENCES coordinator_actions(action_id) ON DELETE RESTRICT,
  chain_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  transaction_hash TEXT NOT NULL UNIQUE,
  signed_transaction_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PREPARED', 'BROADCASTING', 'UNKNOWN', 'INCLUDED', 'FINALIZED', 'REVERTED', 'REORGED', 'MISMATCH')),
  broadcast_count INTEGER NOT NULL DEFAULT 0 CHECK (broadcast_count >= 0 AND broadcast_count <= 16),
  inclusion_block_number INTEGER,
  inclusion_block_hash TEXT,
  bound_at INTEGER NOT NULL,
  last_broadcast_at INTEGER,
  last_observed_at INTEGER,
  CHECK ((inclusion_block_number IS NULL) = (inclusion_block_hash IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS coordinator_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id TEXT NOT NULL REFERENCES settlements(settlement_id) ON DELETE RESTRICT,
  action_id TEXT REFERENCES coordinator_actions(action_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  event_code TEXT NOT NULL,
  data_digest TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS settlements_state_idx ON settlements(state, updated_at);
CREATE INDEX IF NOT EXISTS settlements_payment_hash_idx ON settlements(payment_hash);
CREATE INDEX IF NOT EXISTS actions_state_idx ON coordinator_actions(state, planned_at);
CREATE INDEX IF NOT EXISTS evm_transactions_state_idx ON coordinator_evm_transactions(state, last_observed_at);
CREATE INDEX IF NOT EXISTS events_settlement_idx ON coordinator_events(settlement_id, sequence);
`;

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function address(value, name) {
  const raw = String(value ?? "");
  if (!ADDRESS.test(raw)) throw new TypeError(`${name} must be a lowercase Ethereum address`);
  return raw;
}

function uint(value, name, { nonzero = false, maximum = null } = {}) {
  const raw = String(value ?? "");
  if (!UINT.test(raw)) throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  const parsed = BigInt(raw);
  if (nonzero && parsed === 0n) throw new RangeError(`${name} must be non-zero`);
  if (maximum !== null && parsed > maximum) throw new RangeError(`${name} exceeds its maximum`);
  return raw;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function code(value, name) {
  const raw = String(value ?? "");
  if (!CODE.test(raw)) throw new TypeError(`${name} must be a bounded machine code`);
  return raw;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("canonical value contains an unsupported type");
}

function digest(value) {
  return `0x${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function normalizeSettlement(input) {
  exactKeys(input, [
    "amountSats", "capacityEpoch", "createdAt", "direction", "intentDigest", "intentNonce", "invoiceDigest",
    "nonceAuthorityDigest", "paymentHash", "pricingId", "quoteReceiptDigest", "selectedOfferId",
    "selectedSetDigest", "settlementId",
  ], "settlement");
  if (!DIRECTIONS.has(input.direction)) throw new RangeError("settlement direction is unsupported");
  const normalized = {
    settlementId: bytes32(input.settlementId, "settlementId"),
    pricingId: bytes32(input.pricingId, "pricingId"),
    direction: input.direction,
    nonceAuthorityDigest: bytes32(input.nonceAuthorityDigest, "nonceAuthorityDigest"),
    intentNonce: uint(input.intentNonce, "intentNonce", { maximum: (1n << 256n) - 1n }),
    intentDigest: bytes32(input.intentDigest, "intentDigest"),
    paymentHash: bytes32(input.paymentHash, "paymentHash"),
    invoiceDigest: bytes32(input.invoiceDigest, "invoiceDigest"),
    amountSats: uint(input.amountSats, "amountSats", { nonzero: true, maximum: (1n << 64n) - 1n }),
    quoteReceiptDigest: bytes32(input.quoteReceiptDigest, "quoteReceiptDigest"),
    selectedSetDigest: bytes32(input.selectedSetDigest, "selectedSetDigest"),
    selectedOfferId: bytes32(input.selectedOfferId, "selectedOfferId"),
    capacityEpoch: integer(input.capacityEpoch, "capacityEpoch"),
    createdAt: integer(input.createdAt, "createdAt"),
  };
  if (normalized.pricingId === normalized.settlementId) throw new Error("public pricing and private settlement IDs must differ");
  return Object.freeze(normalized);
}

function normalizeReservation(input) {
  exactKeys(input, [
    "observedAt", "reservationBlockHash", "reservationBlockNumber", "reservationId", "reservationIntentDigest",
    "reservationTxHash", "settlementId",
  ], "reservation");
  return Object.freeze({
    settlementId: bytes32(input.settlementId, "settlementId"),
    reservationId: bytes32(input.reservationId, "reservationId"),
    reservationTxHash: bytes32(input.reservationTxHash, "reservationTxHash"),
    reservationBlockNumber: integer(input.reservationBlockNumber, "reservationBlockNumber"),
    reservationBlockHash: bytes32(input.reservationBlockHash, "reservationBlockHash"),
    reservationIntentDigest: bytes32(input.reservationIntentDigest, "reservationIntentDigest"),
    observedAt: integer(input.observedAt, "observedAt"),
  });
}

function normalizeAction(input) {
  exactKeys(input, [
    "actionId", "amountSats", "capacityEpoch", "intentDigest", "invoiceDigest", "method", "paymentHash",
    "payloadDigest", "plannedAt", "requestId", "settlementId",
  ], "coordinator action");
  const method = String(input.method ?? "");
  if (!VALUE_METHODS.has(method)) throw new RangeError("coordinator action method is not value-moving or supported");
  return Object.freeze({
    actionId: bytes32(input.actionId, "actionId"),
    settlementId: bytes32(input.settlementId, "settlementId"),
    method,
    requestId: bytes32(input.requestId, "requestId"),
    payloadDigest: bytes32(input.payloadDigest, "payloadDigest"),
    intentDigest: bytes32(input.intentDigest, "intentDigest"),
    paymentHash: bytes32(input.paymentHash, "paymentHash"),
    invoiceDigest: bytes32(input.invoiceDigest, "invoiceDigest"),
    amountSats: uint(input.amountSats, "amountSats", { nonzero: true, maximum: (1n << 64n) - 1n }),
    capacityEpoch: integer(input.capacityEpoch, "capacityEpoch"),
    plannedAt: integer(input.plannedAt, "plannedAt"),
  });
}

function asSettlement(row) {
  if (!row) return null;
  return Object.freeze({
    settlementId: row.settlement_id,
    pricingId: row.pricing_id,
    direction: row.direction,
    nonceAuthorityDigest: row.nonce_authority_digest,
    intentNonce: row.intent_nonce,
    intentDigest: row.intent_digest,
    paymentHash: row.payment_hash,
    invoiceDigest: row.invoice_digest,
    amountSats: row.amount_sats,
    quoteReceiptDigest: row.quote_receipt_digest,
    selectedSetDigest: row.selected_set_digest,
    selectedOfferId: row.selected_offer_id,
    capacityEpoch: row.capacity_epoch,
    recordDigest: row.record_digest,
    reservationId: row.reservation_id,
    reservationTxHash: row.reservation_tx_hash,
    reservationBlockNumber: row.reservation_block_number,
    reservationBlockHash: row.reservation_block_hash,
    lastActionId: row.last_action_id,
    state: row.state,
    reconciliationRequired: row.reconciliation_required === 1,
    haltCode: row.halt_code,
    terminalState: row.terminal_state,
    terminalProofDigest: row.terminal_proof_digest,
    terminalAt: row.terminal_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function asAction(row) {
  if (!row) return null;
  return Object.freeze({
    actionId: row.action_id,
    settlementId: row.settlement_id,
    method: row.method,
    requestId: row.request_id,
    payloadDigest: row.payload_digest,
    intentDigest: row.intent_digest,
    paymentHash: row.payment_hash,
    invoiceDigest: row.invoice_digest,
    amountSats: row.amount_sats,
    capacityEpoch: row.capacity_epoch,
    state: row.state,
    dispatchCount: row.dispatch_count,
    resultDigest: row.result_digest,
    resultCode: row.result_code,
    plannedAt: row.planned_at,
    dispatchedAt: row.dispatched_at,
    resolvedAt: row.resolved_at,
  });
}

function asEvmTransaction(row) {
  if (!row) return null;
  return Object.freeze({
    actionId: row.action_id,
    chainId: row.chain_id,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    nonce: row.nonce,
    transactionHash: row.transaction_hash,
    signedTransactionDigest: row.signed_transaction_digest,
    state: row.state,
    broadcastCount: row.broadcast_count,
    inclusionBlockNumber: row.inclusion_block_number,
    inclusionBlockHash: row.inclusion_block_hash,
    boundAt: row.bound_at,
    lastBroadcastAt: row.last_broadcast_at,
    lastObservedAt: row.last_observed_at,
  });
}

function reconciliationDisposition(method, observedState) {
  const status = code(observedState, "observedState");
  const decisions = {
    "/invoicesrpc.Invoices/AddHoldInvoice": {
      OPEN: "confirmed", ACCEPTED: "confirmed", SETTLED: "confirmed", CANCELED: "failed", NOT_FOUND: "unresolved",
    },
    "/routerrpc.Router/SendPaymentV2": {
      SUCCEEDED: "confirmed", FAILED: "failed", IN_FLIGHT: "unresolved", INITIATED: "unresolved", NOT_FOUND: "unresolved",
    },
    "/invoicesrpc.Invoices/SettleInvoice": {
      SETTLED: "confirmed", ACCEPTED: "unresolved", OPEN: "unresolved", CANCELED: "failed", NOT_FOUND: "unresolved",
    },
    "/invoicesrpc.Invoices/CancelInvoice": {
      CANCELED: "confirmed", OPEN: "unresolved", ACCEPTED: "unresolved", SETTLED: "mismatch", NOT_FOUND: "unresolved",
    },
    "evm:claim": {
      CLAIMED: "confirmed", INCLUDED: "unresolved", LOCKED: "unresolved", NOT_FOUND: "unresolved",
      REVERTED: "failed", REFUNDED: "mismatch", REORGED: "mismatch", MISMATCH: "mismatch",
    },
  };
  return { status, disposition: decisions[method]?.[status] ?? "mismatch" };
}

export class CoordinatorStore {
  #db;
  #path;

  constructor(database, path) {
    this.#db = database;
    this.#path = path;
  }

  static async open(path, { allowMemory = false } = {}) {
    if (path === ":memory:") {
      if (!allowMemory) throw new Error("in-memory coordinator storage is test-only");
    } else {
      if (!isAbsolute(path)) throw new Error("coordinator database path must be absolute");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        const state = await lstat(path);
        if (state.isSymbolicLink() || !state.isFile()) throw new Error("coordinator database path must be a regular file");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
    database.exec(COORDINATOR_SCHEMA_SQL);
    database.prepare("INSERT OR IGNORE INTO coordinator_meta(key, value) VALUES ('schema', 'treeswap.coordinator.v2')").run();
    const schema = database.prepare("SELECT value FROM coordinator_meta WHERE key = 'schema'").get();
    if (schema?.value === "treeswap.coordinator.v1") {
      database.prepare("UPDATE coordinator_meta SET value = 'treeswap.coordinator.v2' WHERE key = 'schema'").run();
    } else if (schema?.value !== "treeswap.coordinator.v2") {
      database.close();
      throw new Error("coordinator database schema is unsupported");
    }
    if (path !== ":memory:") await chmod(path, 0o600);
    return new CoordinatorStore(database, path);
  }

  close() {
    this.#db.close();
  }

  get path() {
    return this.#path;
  }

  #transaction(callback) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  #event({ settlementId, actionId = null, eventType, eventCode, dataDigest, occurredAt }) {
    this.#db.prepare(`
      INSERT INTO coordinator_events(settlement_id, action_id, event_type, event_code, data_digest, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(settlementId, actionId, code(eventType, "eventType"), code(eventCode, "eventCode"), bytes32(dataDigest, "dataDigest"), occurredAt);
  }

  getSettlement(settlementId) {
    return asSettlement(this.#db.prepare("SELECT * FROM settlements WHERE settlement_id = ?").get(bytes32(settlementId, "settlementId")));
  }

  getAction(actionId) {
    return asAction(this.#db.prepare("SELECT * FROM coordinator_actions WHERE action_id = ?").get(bytes32(actionId, "actionId")));
  }

  getEvmTransaction(actionId) {
    return asEvmTransaction(this.#db.prepare("SELECT * FROM coordinator_evm_transactions WHERE action_id = ?")
      .get(bytes32(actionId, "actionId")));
  }

  acceptSettlement(input) {
    const value = normalizeSettlement(input);
    const recordDigest = digest(value);
    return this.#transaction(() => {
      const existing = this.getSettlement(value.settlementId);
      if (existing) {
        if (existing.recordDigest !== recordDigest) throw new Error("settlement identifier was already bound to different terms");
        return existing;
      }
      try {
        this.#db.prepare(`
          INSERT INTO settlements(
            settlement_id, pricing_id, direction, nonce_authority_digest, intent_nonce, intent_digest, payment_hash,
            invoice_digest, amount_sats, quote_receipt_digest, selected_set_digest, selected_offer_id, capacity_epoch,
            record_digest, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INTENT_ACCEPTED', ?, ?)
        `).run(
          value.settlementId, value.pricingId, value.direction, value.nonceAuthorityDigest, value.intentNonce,
          value.intentDigest, value.paymentHash, value.invoiceDigest, value.amountSats, value.quoteReceiptDigest,
          value.selectedSetDigest, value.selectedOfferId, value.capacityEpoch, recordDigest, value.createdAt, value.createdAt,
        );
      } catch (error) {
        if (/constraint|unique/i.test(String(error?.message))) {
          throw new Error("settlement conflicts with an existing nonce, intent, or payment hash");
        }
        throw error;
      }
      this.#event({
        settlementId: value.settlementId,
        eventType: "SETTLEMENT",
        eventCode: "INTENT_ACCEPTED",
        dataDigest: recordDigest,
        occurredAt: value.createdAt,
      });
      return this.getSettlement(value.settlementId);
    });
  }

  recordReservation(input) {
    const value = normalizeReservation(input);
    const reservationDigest = digest(value);
    return this.#transaction(() => {
      const settlement = this.getSettlement(value.settlementId);
      if (!settlement) throw new Error("settlement does not exist");
      if (settlement.terminalState || settlement.haltCode) throw new Error("settlement cannot accept a reservation");
      if (settlement.intentDigest !== value.reservationIntentDigest) throw new Error("reservation intent digest does not match");
      if (settlement.reservationId) {
        const row = this.#db.prepare("SELECT reservation_digest FROM settlements WHERE settlement_id = ?").get(value.settlementId);
        if (row.reservation_digest !== reservationDigest) throw new Error("settlement was already bound to a different reservation");
        return settlement;
      }
      this.#db.prepare(`
        UPDATE settlements SET reservation_id = ?, reservation_tx_hash = ?, reservation_block_number = ?,
          reservation_block_hash = ?, reservation_digest = ?, state = 'RESERVATION_OBSERVED', version = version + 1,
          updated_at = ? WHERE settlement_id = ?
      `).run(
        value.reservationId, value.reservationTxHash, value.reservationBlockNumber, value.reservationBlockHash,
        reservationDigest, value.observedAt, value.settlementId,
      );
      this.#event({
        settlementId: value.settlementId,
        eventType: "RESERVATION",
        eventCode: "OBSERVED",
        dataDigest: reservationDigest,
        occurredAt: value.observedAt,
      });
      return this.getSettlement(value.settlementId);
    });
  }

  planAction(input) {
    const value = normalizeAction(input);
    const recordDigest = digest(value);
    return this.#transaction(() => {
      const existing = this.getAction(value.actionId);
      if (existing) {
        const row = this.#db.prepare("SELECT record_digest FROM coordinator_actions WHERE action_id = ?").get(value.actionId);
        if (row.record_digest !== recordDigest) throw new Error("action identifier was already bound to different terms");
        return existing;
      }
      const settlement = this.getSettlement(value.settlementId);
      if (!settlement) throw new Error("settlement does not exist");
      if (settlement.terminalState || settlement.haltCode) throw new Error("settlement is closed to new actions");
      if (settlement.reconciliationRequired) throw new Error("settlement requires reconciliation before another action");
      if (METHODS_REQUIRING_RESERVATION.has(value.method) && !settlement.reservationId) {
        throw new Error("action requires an observed reservation");
      }
      if (
        settlement.intentDigest !== value.intentDigest || settlement.paymentHash !== value.paymentHash
          || settlement.invoiceDigest !== value.invoiceDigest || settlement.amountSats !== value.amountSats
          || settlement.capacityEpoch !== value.capacityEpoch
      ) throw new Error("action terms do not match the persisted settlement");
      const active = this.#db.prepare(`
        SELECT action_id FROM coordinator_actions
        WHERE settlement_id = ? AND state IN ('PENDING', 'DISPATCHING', 'UNKNOWN') LIMIT 1
      `).get(value.settlementId);
      if (active) throw new Error("settlement already has an unresolved action");
      try {
        this.#db.prepare(`
          INSERT INTO coordinator_actions(
            action_id, settlement_id, method, request_id, payload_digest, intent_digest, payment_hash, invoice_digest,
            amount_sats, capacity_epoch, record_digest, state, planned_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
        `).run(
          value.actionId, value.settlementId, value.method, value.requestId, value.payloadDigest, value.intentDigest,
          value.paymentHash, value.invoiceDigest, value.amountSats, value.capacityEpoch, recordDigest, value.plannedAt,
        );
      } catch (error) {
        if (/constraint|unique/i.test(String(error?.message))) throw new Error("action conflicts with an existing method or request identifier");
        throw error;
      }
      this.#db.prepare(`
        UPDATE settlements SET last_action_id = ?, state = 'ACTION_PENDING', version = version + 1, updated_at = ?
        WHERE settlement_id = ?
      `).run(value.actionId, value.plannedAt, value.settlementId);
      this.#event({
        settlementId: value.settlementId,
        actionId: value.actionId,
        eventType: "ACTION",
        eventCode: "PLANNED",
        dataDigest: recordDigest,
        occurredAt: value.plannedAt,
      });
      return this.getAction(value.actionId);
    });
  }

  bindEvmTransaction(input) {
    exactKeys(input, [
      "actionId", "boundAt", "chainId", "fromAddress", "nonce", "signedTransactionDigest", "toAddress",
      "transactionHash",
    ], "EVM transaction binding");
    const value = Object.freeze({
      actionId: bytes32(input.actionId, "actionId"),
      chainId: uint(input.chainId, "chainId", { nonzero: true, maximum: (1n << 256n) - 1n }),
      fromAddress: address(input.fromAddress, "fromAddress"),
      toAddress: address(input.toAddress, "toAddress"),
      nonce: uint(input.nonce, "nonce", { maximum: (1n << 256n) - 1n }),
      transactionHash: bytes32(input.transactionHash, "transactionHash"),
      signedTransactionDigest: bytes32(input.signedTransactionDigest, "signedTransactionDigest"),
      boundAt: integer(input.boundAt, "boundAt"),
    });
    const bindingDigest = digest(value);
    return this.#transaction(() => {
      const action = this.getAction(value.actionId);
      if (!action) throw new Error("action does not exist");
      if (action.method !== "evm:claim") throw new Error("only an EVM claim can bind a transaction");
      if (action.state !== "PENDING" || action.dispatchCount !== 0) throw new Error("EVM action is no longer bindable");
      const existing = this.getEvmTransaction(value.actionId);
      if (existing) {
        const existingDigest = digest({
          actionId: existing.actionId,
          chainId: existing.chainId,
          fromAddress: existing.fromAddress,
          toAddress: existing.toAddress,
          nonce: existing.nonce,
          transactionHash: existing.transactionHash,
          signedTransactionDigest: existing.signedTransactionDigest,
          boundAt: existing.boundAt,
        });
        if (existingDigest !== bindingDigest) throw new Error("EVM action was already bound to another signed transaction");
        return existing;
      }
      this.#db.prepare(`
        INSERT INTO coordinator_evm_transactions(
          action_id, chain_id, from_address, to_address, nonce, transaction_hash, signed_transaction_digest,
          state, bound_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?)
      `).run(
        value.actionId, value.chainId, value.fromAddress, value.toAddress, value.nonce, value.transactionHash,
        value.signedTransactionDigest, value.boundAt,
      );
      this.#event({
        settlementId: action.settlementId,
        actionId: action.actionId,
        eventType: "EVM",
        eventCode: "TRANSACTION_BOUND",
        dataDigest: bindingDigest,
        occurredAt: value.boundAt,
      });
      return this.getEvmTransaction(value.actionId);
    });
  }

  claimEvmBroadcast(actionId, broadcastAt) {
    const id = bytes32(actionId, "actionId");
    const at = integer(broadcastAt, "broadcastAt");
    return this.#transaction(() => {
      const action = this.getAction(id);
      const transaction = this.getEvmTransaction(id);
      if (!action || !transaction || action.method !== "evm:claim") throw new Error("bound EVM action does not exist");
      if (transaction.inclusionBlockHash) throw new Error("an included EVM transaction cannot be rebroadcast");
      if (transaction.broadcastCount >= 16) throw new Error("EVM rebroadcast limit reached");
      const initial = action.state === "PENDING" && action.dispatchCount === 0 && transaction.state === "PREPARED";
      const replay = action.state === "UNKNOWN" && ["UNKNOWN", "BROADCASTING"].includes(transaction.state);
      if (!initial && !replay) throw new Error("EVM transaction is not broadcastable");
      const settlement = this.getSettlement(action.settlementId);
      if (settlement.terminalState || settlement.haltCode) throw new Error("settlement is not broadcastable");
      if (initial) {
        this.#db.prepare(`
          UPDATE coordinator_actions SET state = 'DISPATCHING', dispatch_count = 1, dispatched_at = ? WHERE action_id = ?
        `).run(at, id);
        this.#db.prepare(`
          UPDATE settlements SET state = 'ACTION_DISPATCHING', version = version + 1, updated_at = ? WHERE settlement_id = ?
        `).run(at, action.settlementId);
      }
      this.#db.prepare(`
        UPDATE coordinator_evm_transactions SET state = 'BROADCASTING', broadcast_count = broadcast_count + 1,
          last_broadcast_at = ? WHERE action_id = ?
      `).run(at, id);
      this.#event({
        settlementId: action.settlementId,
        actionId: id,
        eventType: "EVM",
        eventCode: initial ? "BROADCASTING" : "REBROADCASTING",
        dataDigest: transaction.signedTransactionDigest,
        occurredAt: at,
      });
      return Object.freeze({ action: this.getAction(id), transaction: this.getEvmTransaction(id) });
    });
  }

  recordEvmInclusion(input) {
    exactKeys(input, [
      "actionId", "blockHash", "blockNumber", "observationDigest", "observedAt", "transactionHash",
    ], "EVM inclusion");
    const id = bytes32(input.actionId, "actionId");
    const txHash = bytes32(input.transactionHash, "transactionHash");
    const blockHash = bytes32(input.blockHash, "blockHash");
    const blockNumber = integer(input.blockNumber, "blockNumber");
    const proof = bytes32(input.observationDigest, "observationDigest");
    const at = integer(input.observedAt, "observedAt");
    return this.#transaction(() => {
      const action = this.getAction(id);
      const transaction = this.getEvmTransaction(id);
      if (!action || !transaction || action.state !== "UNKNOWN") throw new Error("unknown EVM action does not exist");
      if (transaction.transactionHash !== txHash) throw new Error("EVM inclusion transaction hash changed");
      if (transaction.inclusionBlockHash && (
        transaction.inclusionBlockHash !== blockHash || transaction.inclusionBlockNumber !== blockNumber
      )) throw new Error("EVM transaction inclusion changed");
      this.#db.prepare(`
        UPDATE coordinator_evm_transactions SET state = 'INCLUDED', inclusion_block_number = ?,
          inclusion_block_hash = ?, last_observed_at = ? WHERE action_id = ?
      `).run(blockNumber, blockHash, at, id);
      this.#event({
        settlementId: action.settlementId,
        actionId: id,
        eventType: "EVM",
        eventCode: "INCLUDED",
        dataDigest: proof,
        occurredAt: at,
      });
      return this.getEvmTransaction(id);
    });
  }

  claimAction(actionId, dispatchedAt) {
    const id = bytes32(actionId, "actionId");
    const at = integer(dispatchedAt, "dispatchedAt");
    return this.#transaction(() => {
      const action = this.getAction(id);
      if (!action) throw new Error("action does not exist");
      if (action.method === "evm:claim") throw new Error("EVM actions require the signed-transaction broadcast path");
      if (action.state !== "PENDING" || action.dispatchCount !== 0) throw new Error("action is not dispatchable");
      const settlement = this.getSettlement(action.settlementId);
      if (settlement.reconciliationRequired || settlement.terminalState || settlement.haltCode) {
        throw new Error("settlement is not dispatchable");
      }
      this.#db.prepare(`
        UPDATE coordinator_actions SET state = 'DISPATCHING', dispatch_count = 1, dispatched_at = ? WHERE action_id = ?
      `).run(at, id);
      this.#db.prepare(`
        UPDATE settlements SET state = 'ACTION_DISPATCHING', version = version + 1, updated_at = ? WHERE settlement_id = ?
      `).run(at, action.settlementId);
      this.#event({
        settlementId: action.settlementId,
        actionId: id,
        eventType: "ACTION",
        eventCode: "DISPATCHING",
        dataDigest: action.payloadDigest,
        occurredAt: at,
      });
      return this.getAction(id);
    });
  }

  recordActionResult(input) {
    exactKeys(input, [
      "actionId", "outcome", "recordedAt", "resultCode", "resultDigest",
    ], "action result");
    const { actionId, outcome, resultDigest, resultCode, recordedAt } = input;
    const id = bytes32(actionId, "actionId");
    const at = integer(recordedAt, "recordedAt");
    const proof = bytes32(resultDigest, "resultDigest");
    const outcomeCode = code(resultCode, "resultCode");
    const states = { confirmed: "CONFIRMED", ambiguous: "UNKNOWN" };
    const nextState = states[outcome];
    if (!nextState) throw new RangeError("action outcome is unsupported");
    return this.#transaction(() => {
      const action = this.getAction(id);
      if (!action) throw new Error("action does not exist");
      if (action.method === "evm:claim" && nextState === "CONFIRMED") {
        throw new Error("EVM actions require finalized receipt reconciliation");
      }
      if (action.method === "evm:claim" && action.state === "UNKNOWN" && nextState === "UNKNOWN") {
        const transaction = this.getEvmTransaction(id);
        if (!transaction || transaction.state !== "BROADCASTING") throw new Error("EVM rebroadcast is not awaiting a result");
        this.#db.prepare(`
          UPDATE coordinator_actions SET result_digest = ?, result_code = ?, resolved_at = ? WHERE action_id = ?
        `).run(proof, outcomeCode, at, id);
        this.#db.prepare(`
          UPDATE coordinator_evm_transactions SET state = 'UNKNOWN', last_observed_at = ? WHERE action_id = ?
        `).run(at, id);
        this.#event({
          settlementId: action.settlementId,
          actionId: id,
          eventType: "EVM",
          eventCode: "REBROADCAST_UNKNOWN",
          dataDigest: proof,
          occurredAt: at,
        });
        return this.getAction(id);
      }
      if (action.state !== "DISPATCHING") {
        if (action.state === nextState && action.resultDigest === proof && action.resultCode === outcomeCode) return action;
        throw new Error("action is not awaiting a dispatch result");
      }
      this.#db.prepare(`
        UPDATE coordinator_actions SET state = ?, result_digest = ?, result_code = ?, resolved_at = ? WHERE action_id = ?
      `).run(nextState, proof, outcomeCode, at, id);
      if (action.method === "evm:claim") {
        this.#db.prepare(`
          UPDATE coordinator_evm_transactions SET state = 'UNKNOWN', last_observed_at = ? WHERE action_id = ?
        `).run(at, id);
      }
      const mustReconcile = nextState === "UNKNOWN";
      this.#db.prepare(`
        UPDATE settlements SET state = ?, reconciliation_required = ?, version = version + 1, updated_at = ?
        WHERE settlement_id = ?
      `).run(mustReconcile ? "RECONCILIATION_REQUIRED" : `ACTION_${nextState}`, mustReconcile ? 1 : 0, at, action.settlementId);
      this.#event({
        settlementId: action.settlementId,
        actionId: id,
        eventType: "ACTION",
        eventCode: nextState,
        dataDigest: proof,
        occurredAt: at,
      });
      return this.getAction(id);
    });
  }

  recoverInterruptedActions(recordedAt) {
    const at = integer(recordedAt, "recordedAt");
    return this.#transaction(() => {
      const actions = this.#db.prepare("SELECT * FROM coordinator_actions WHERE state = 'DISPATCHING' ORDER BY planned_at").all();
      for (const row of actions) {
        const recoveryDigest = digest({ actionId: row.action_id, code: "PROCESS_RESTART", recordedAt: at });
        this.#db.prepare(`
          UPDATE coordinator_actions SET state = 'UNKNOWN', result_digest = ?, result_code = 'PROCESS_RESTART', resolved_at = ?
          WHERE action_id = ?
        `).run(recoveryDigest, at, row.action_id);
        if (row.method === "evm:claim") {
          this.#db.prepare(`
            UPDATE coordinator_evm_transactions SET state = 'UNKNOWN', last_observed_at = ? WHERE action_id = ?
          `).run(at, row.action_id);
        }
        this.#db.prepare(`
          UPDATE settlements SET state = 'RECONCILIATION_REQUIRED', reconciliation_required = 1,
            version = version + 1, updated_at = ? WHERE settlement_id = ?
        `).run(at, row.settlement_id);
        this.#event({
          settlementId: row.settlement_id,
          actionId: row.action_id,
          eventType: "RECOVERY",
          eventCode: "PROCESS_RESTART",
          dataDigest: recoveryDigest,
          occurredAt: at,
        });
      }
      return actions.length;
    });
  }

  reconcileAction(input) {
    exactKeys(input, [
      "actionId", "observationDigest", "observedAt", "observedState",
    ], "action reconciliation");
    const { actionId, observedState, observationDigest, observedAt } = input;
    const id = bytes32(actionId, "actionId");
    const proof = bytes32(observationDigest, "observationDigest");
    const at = integer(observedAt, "observedAt");
    return this.#transaction(() => {
      const action = this.getAction(id);
      if (!action) throw new Error("action does not exist");
      if (action.state !== "UNKNOWN") throw new Error("only an unknown action can be reconciled");
      const { status, disposition } = reconciliationDisposition(action.method, observedState);
      if (disposition === "unresolved") {
        this.#db.prepare("UPDATE coordinator_actions SET result_digest = ?, result_code = ?, resolved_at = ? WHERE action_id = ?")
          .run(proof, status, at, id);
        if (action.method === "evm:claim") {
          this.#db.prepare(`
            UPDATE coordinator_evm_transactions SET state = ?, last_observed_at = ? WHERE action_id = ?
          `).run(status === "INCLUDED" ? "INCLUDED" : "UNKNOWN", at, id);
        }
        this.#event({
          settlementId: action.settlementId,
          actionId: id,
          eventType: "RECONCILIATION",
          eventCode: "UNRESOLVED",
          dataDigest: proof,
          occurredAt: at,
        });
        return Object.freeze({ disposition, action: this.getAction(id), settlement: this.getSettlement(action.settlementId) });
      }
      if (disposition === "mismatch") {
        this.#db.prepare(`
          UPDATE settlements SET state = 'HALTED', reconciliation_required = 1, halt_code = 'RECONCILIATION_MISMATCH',
            version = version + 1, updated_at = ? WHERE settlement_id = ?
        `).run(at, action.settlementId);
        this.#db.prepare("UPDATE coordinator_actions SET result_digest = ?, result_code = ?, resolved_at = ? WHERE action_id = ?")
          .run(proof, status, at, id);
        if (action.method === "evm:claim") {
          this.#db.prepare(`
            UPDATE coordinator_evm_transactions SET state = ?, last_observed_at = ? WHERE action_id = ?
          `).run(status === "REORGED" ? "REORGED" : "MISMATCH", at, id);
        }
        this.#event({
          settlementId: action.settlementId,
          actionId: id,
          eventType: "RECONCILIATION",
          eventCode: "MISMATCH",
          dataDigest: proof,
          occurredAt: at,
        });
        return Object.freeze({ disposition, action: this.getAction(id), settlement: this.getSettlement(action.settlementId) });
      }
      const state = disposition === "confirmed" ? "CONFIRMED" : "FAILED";
      this.#db.prepare(`
        UPDATE coordinator_actions SET state = ?, result_digest = ?, result_code = ?, resolved_at = ? WHERE action_id = ?
      `).run(state, proof, status, at, id);
      if (action.method === "evm:claim") {
        this.#db.prepare(`
          UPDATE coordinator_evm_transactions SET state = ?, last_observed_at = ? WHERE action_id = ?
        `).run(state === "CONFIRMED" ? "FINALIZED" : "REVERTED", at, id);
      }
      this.#db.prepare(`
        UPDATE settlements SET state = ?, reconciliation_required = 0, version = version + 1, updated_at = ?
        WHERE settlement_id = ?
      `).run(`ACTION_${state}`, at, action.settlementId);
      this.#event({
        settlementId: action.settlementId,
        actionId: id,
        eventType: "RECONCILIATION",
        eventCode: state,
        dataDigest: proof,
        occurredAt: at,
      });
      return Object.freeze({ disposition, action: this.getAction(id), settlement: this.getSettlement(action.settlementId) });
    });
  }

  haltSettlement(input) {
    exactKeys(input, [
      "evidenceDigest", "haltCode", "recordedAt", "settlementId",
    ], "settlement halt");
    const { settlementId, haltCode, evidenceDigest, recordedAt } = input;
    const id = bytes32(settlementId, "settlementId");
    const reason = code(haltCode, "haltCode");
    const evidence = bytes32(evidenceDigest, "evidenceDigest");
    const at = integer(recordedAt, "recordedAt");
    return this.#transaction(() => {
      const settlement = this.getSettlement(id);
      if (!settlement) throw new Error("settlement does not exist");
      if (settlement.terminalState) throw new Error("terminal settlement cannot be halted");
      if (settlement.haltCode && settlement.haltCode !== reason) throw new Error("settlement is already halted for another reason");
      this.#db.prepare(`
        UPDATE settlements SET state = 'HALTED', reconciliation_required = 1, halt_code = ?,
          version = version + 1, updated_at = ? WHERE settlement_id = ?
      `).run(reason, at, id);
      this.#event({
        settlementId: id,
        eventType: "RISK",
        eventCode: reason,
        dataDigest: evidence,
        occurredAt: at,
      });
      return this.getSettlement(id);
    });
  }

  recordTerminal(input) {
    exactKeys(input, [
      "assetsReconciled", "proofDigest", "recordedAt", "settlementId", "terminalState",
    ], "terminal settlement");
    const { settlementId, terminalState, proofDigest, assetsReconciled, recordedAt } = input;
    const id = bytes32(settlementId, "settlementId");
    const terminal = String(terminalState ?? "");
    if (!TERMINAL_STATES.has(terminal)) throw new RangeError("terminal state is unsupported");
    if (assetsReconciled !== true) throw new Error("both assets must reconcile before a terminal transition");
    const proof = bytes32(proofDigest, "proofDigest");
    const at = integer(recordedAt, "recordedAt");
    return this.#transaction(() => {
      const settlement = this.getSettlement(id);
      if (!settlement) throw new Error("settlement does not exist");
      if (settlement.terminalState) {
        if (settlement.terminalState === terminal && settlement.terminalProofDigest === proof) return settlement;
        throw new Error("settlement already has a different terminal outcome");
      }
      if (settlement.reconciliationRequired || settlement.haltCode) throw new Error("unresolved settlement cannot become terminal");
      const unresolved = this.#db.prepare(`
        SELECT action_id FROM coordinator_actions
        WHERE settlement_id = ? AND state IN ('PENDING', 'DISPATCHING', 'UNKNOWN') LIMIT 1
      `).get(id);
      if (unresolved) throw new Error("settlement has an unresolved action");
      if (terminal === "COMPLETED") {
        const requiredMethod = settlement.direction === "bit-to-lightning"
          ? "/routerrpc.Router/SendPaymentV2"
          : "/invoicesrpc.Invoices/SettleInvoice";
        const confirmed = this.#db.prepare(`
          SELECT action_id FROM coordinator_actions WHERE settlement_id = ? AND method = ? AND state = 'CONFIRMED'
        `).get(id, requiredMethod);
        if (!confirmed) throw new Error("completed settlement lacks its confirmed Lightning action");
      }
      if (terminal === "REFUNDED") {
        const dangerousMethod = settlement.direction === "bit-to-lightning"
          ? "/routerrpc.Router/SendPaymentV2"
          : "/invoicesrpc.Invoices/SettleInvoice";
        const paid = this.#db.prepare(`
          SELECT action_id FROM coordinator_actions WHERE settlement_id = ? AND method = ? AND state = 'CONFIRMED'
        `).get(id, dangerousMethod);
        if (paid) throw new Error("a confirmed Lightning leg cannot be recorded as refunded");
      }
      this.#db.prepare(`
        UPDATE settlements SET state = ?, terminal_state = ?, terminal_proof_digest = ?, terminal_at = ?,
          version = version + 1, updated_at = ? WHERE settlement_id = ?
      `).run(terminal, terminal, proof, at, at, id);
      this.#event({
        settlementId: id,
        eventType: "TERMINAL",
        eventCode: terminal,
        dataDigest: proof,
        occurredAt: at,
      });
      return this.getSettlement(id);
    });
  }

  metrics() {
    const settlementStates = Object.fromEntries(
      this.#db.prepare("SELECT state, COUNT(*) AS count FROM settlements GROUP BY state ORDER BY state").all()
        .map((row) => [row.state, Number(row.count)]),
    );
    const actionStates = Object.fromEntries(
      this.#db.prepare("SELECT state, COUNT(*) AS count FROM coordinator_actions GROUP BY state ORDER BY state").all()
        .map((row) => [row.state, Number(row.count)]),
    );
    const evmTransactionStates = Object.fromEntries(
      this.#db.prepare("SELECT state, COUNT(*) AS count FROM coordinator_evm_transactions GROUP BY state ORDER BY state").all()
        .map((row) => [row.state, Number(row.count)]),
    );
    const reconciliationRequired = Number(
      this.#db.prepare("SELECT COUNT(*) AS count FROM settlements WHERE reconciliation_required = 1").get().count,
    );
    return Object.freeze({ settlementStates, actionStates, evmTransactionStates, reconciliationRequired });
  }

  secretFreeEvents(limit = 100) {
    const bounded = integer(limit, "limit");
    if (bounded === 0 || bounded > 1_000) throw new RangeError("event limit is outside policy");
    return Object.freeze(this.#db.prepare(`
      SELECT sequence, event_type, event_code, occurred_at FROM coordinator_events ORDER BY sequence DESC LIMIT ?
    `).all(bounded).map((row) => Object.freeze({
      sequence: Number(row.sequence),
      eventType: row.event_type,
      eventCode: row.event_code,
      occurredAt: row.occurred_at,
    })));
  }
}

export function coordinatorCommitmentDigest(value) {
  return digest(value);
}
