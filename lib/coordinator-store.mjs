import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open as openFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";
import {
  assessFirmOffer,
  assessRfqAdmission,
  recordFirmOfferOutcome as applyFirmOfferOutcome,
  reserveFirmOfferCapacity as applyFirmOfferReservation,
} from "./admission-policy.mjs";

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
const RFQ_STATES = new Set(["ACTIVE", "CANCELED", "EXPIRED", "EXERCISED", "ABANDONED"]);
const FIRM_OFFER_STATES = new Set([
  "ACTIVE", "FILLED", "SOLVER_FAILED", "EXPIRED_UNEXERCISED", "USER_ABANDONED",
]);
const FIRM_OFFER_OUTCOMES = new Map([
  ["filled", "FILLED"],
  ["solver-failed", "SOLVER_FAILED"],
  ["expired-unexercised", "EXPIRED_UNEXERCISED"],
  ["user-abandoned", "USER_ABANDONED"],
]);
const COORDINATOR_SCHEMA = "treeswap.coordinator.v4";

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error("coordinator storage parent must be a private directory");
  }
  await chmod(path, 0o700);
}

async function regularFile(path, name) {
  if (!isAbsolute(path)) throw new Error(`${name} path must be absolute`);
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile()) throw new Error(`${name} must be a regular file`);
  if ((state.mode & 0o077) !== 0) throw new Error(`${name} permissions must exclude group and other access`);
  return state;
}

async function requireAbsentFile(path, name) {
  if (!isAbsolute(path)) throw new Error(`${name} path must be absolute`);
  try {
    await lstat(path);
    throw new Error(`${name} already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function verifyDatabase(database, { full = false, requireSchema = true } = {}) {
  const check = full ? "integrity_check" : "quick_check";
  let rows;
  try {
    rows = database.prepare(`PRAGMA ${check}`).all();
  } catch (error) {
    throw new Error(`coordinator database ${check} could not complete`, { cause: error });
  }
  const passed = rows.length === 1 && Object.values(rows[0]).length === 1 && Object.values(rows[0])[0] === "ok";
  if (!passed) throw new Error(`coordinator database ${check} failed`);
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("coordinator database foreign-key check failed");
  }
  if (requireSchema) {
    const schema = database.prepare("SELECT value FROM coordinator_meta WHERE key = 'schema'").get();
    if (schema?.value !== COORDINATOR_SCHEMA) throw new Error("coordinator database schema is unsupported");
  }
  return Object.freeze({ check, schema: requireSchema ? COORDINATOR_SCHEMA : null, status: "ok" });
}

async function syncFileAndParent(path) {
  let fileHandle;
  let directoryHandle;
  try {
    fileHandle = await openFile(path, "r");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    directoryHandle = await openFile(dirname(path), "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = null;
  } finally {
    await fileHandle?.close().catch(() => {});
    await directoryHandle?.close().catch(() => {});
  }
}

function inspectReadOnlyDatabase(path, { full = true } = {}) {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
    return verifyDatabase(database, { full, requireSchema: true });
  } finally {
    database.close();
  }
}

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

CREATE TABLE IF NOT EXISTS rfq_identities (
  identity_commitment TEXT PRIMARY KEY NOT NULL,
  key_binding_digest TEXT NOT NULL,
  cancellation_sequence TEXT NOT NULL DEFAULT '0',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS rfq_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  identity_commitment TEXT NOT NULL REFERENCES rfq_identities(identity_commitment) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('lightning-to-bit', 'bit-to-lightning')),
  notional_sats TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  record_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'CANCELED', 'EXPIRED', 'EXERCISED', 'ABANDONED')),
  resolution_digest TEXT,
  accepted_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (identity_commitment, nonce),
  CHECK ((resolution_digest IS NULL) = (resolved_at IS NULL)),
  CHECK ((state = 'ACTIVE') = (resolved_at IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS rfq_admission_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  identity_commitment TEXT NOT NULL REFERENCES rfq_identities(identity_commitment) ON DELETE RESTRICT,
  request_id TEXT REFERENCES rfq_requests(request_id) ON DELETE RESTRICT,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('ACCEPTED', 'CANCELED')),
  sequence TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  CHECK ((event_kind = 'ACCEPTED') = (request_id IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS solver_capacity (
  solver_id TEXT PRIMARY KEY NOT NULL,
  capability_digest TEXT NOT NULL,
  capability_expires_at INTEGER NOT NULL,
  snapshot_digest TEXT NOT NULL,
  capacity_epoch INTEGER NOT NULL,
  capacity_observed_at INTEGER NOT NULL,
  available_bit_wei TEXT NOT NULL,
  committed_bit_wei TEXT NOT NULL DEFAULT '0',
  available_lightning_sats TEXT NOT NULL,
  committed_lightning_sats TEXT NOT NULL DEFAULT '0',
  active_firm_quotes INTEGER NOT NULL DEFAULT 0 CHECK (active_firm_quotes >= 0),
  successful_fills TEXT NOT NULL DEFAULT '0',
  attributable_failures TEXT NOT NULL DEFAULT '0',
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failure_suspended INTEGER NOT NULL DEFAULT 0 CHECK (failure_suspended IN (0, 1)),
  capacity_conflicted INTEGER NOT NULL DEFAULT 0 CHECK (capacity_conflicted IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS firm_offer_commitments (
  offer_id TEXT PRIMARY KEY NOT NULL,
  offer_digest TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL REFERENCES rfq_requests(request_id) ON DELETE RESTRICT,
  solver_id TEXT NOT NULL REFERENCES solver_capacity(solver_id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('lightning-to-bit', 'bit-to-lightning')),
  amount TEXT NOT NULL,
  capacity_epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  record_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'FILLED', 'SOLVER_FAILED', 'EXPIRED_UNEXERCISED', 'USER_ABANDONED')),
  outcome_digest TEXT,
  reserved_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (request_id, solver_id),
  CHECK ((outcome_digest IS NULL) = (resolved_at IS NULL)),
  CHECK ((state = 'ACTIVE') = (resolved_at IS NULL))
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
CREATE INDEX IF NOT EXISTS rfq_requests_identity_state_idx ON rfq_requests(identity_commitment, state, expires_at);
CREATE INDEX IF NOT EXISTS rfq_events_identity_time_idx ON rfq_admission_events(identity_commitment, event_kind, occurred_at);
CREATE INDEX IF NOT EXISTS solver_capacity_epoch_idx ON solver_capacity(capacity_epoch, capacity_observed_at);
CREATE INDEX IF NOT EXISTS firm_offers_request_state_idx ON firm_offer_commitments(request_id, state, expires_at);
CREATE INDEX IF NOT EXISTS firm_offers_solver_state_idx ON firm_offer_commitments(solver_id, state, expires_at);
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

function normalizeAdmissionPolicy(input) {
  exactKeys(input, [
    "maxActiveFirmQuotesPerSolver", "maxActiveRequestsPerIdentity", "maxCancellationsPerWindow",
    "maxCapacityAgeSeconds", "maxConsecutiveFailures", "maxFirmQuoteTtlSeconds", "maxRequestsPerWindow",
    "maxRfqTtlSeconds", "minimumNotionalSats", "minimumReliabilityBps", "minimumReliabilitySample",
    "quotaWindowSeconds",
  ], "admission policy");
  const policy = Object.freeze({
    minimumNotionalSats: uint(input.minimumNotionalSats, "policy.minimumNotionalSats", { nonzero: true, maximum: (1n << 64n) - 1n }),
    maxRfqTtlSeconds: integer(input.maxRfqTtlSeconds, "policy.maxRfqTtlSeconds"),
    maxActiveRequestsPerIdentity: integer(input.maxActiveRequestsPerIdentity, "policy.maxActiveRequestsPerIdentity"),
    maxRequestsPerWindow: integer(input.maxRequestsPerWindow, "policy.maxRequestsPerWindow"),
    maxCancellationsPerWindow: integer(input.maxCancellationsPerWindow, "policy.maxCancellationsPerWindow"),
    quotaWindowSeconds: integer(input.quotaWindowSeconds, "policy.quotaWindowSeconds"),
    maxFirmQuoteTtlSeconds: integer(input.maxFirmQuoteTtlSeconds, "policy.maxFirmQuoteTtlSeconds"),
    maxCapacityAgeSeconds: integer(input.maxCapacityAgeSeconds, "policy.maxCapacityAgeSeconds"),
    maxActiveFirmQuotesPerSolver: integer(input.maxActiveFirmQuotesPerSolver, "policy.maxActiveFirmQuotesPerSolver"),
    maxConsecutiveFailures: integer(input.maxConsecutiveFailures, "policy.maxConsecutiveFailures"),
    minimumReliabilitySample: uint(input.minimumReliabilitySample, "policy.minimumReliabilitySample", { maximum: (1n << 64n) - 1n }),
    minimumReliabilityBps: uint(input.minimumReliabilityBps, "policy.minimumReliabilityBps", { maximum: 10_000n }),
  });
  if (policy.maxRfqTtlSeconds === 0 || policy.maxRfqTtlSeconds > 300) throw new RangeError("RFQ lifetime is outside policy");
  if (policy.maxFirmQuoteTtlSeconds === 0 || policy.maxFirmQuoteTtlSeconds > 300) throw new RangeError("firm quote lifetime is outside policy");
  if (policy.maxCapacityAgeSeconds === 0 || policy.maxCapacityAgeSeconds > 300) throw new RangeError("capacity age is outside policy");
  if (policy.quotaWindowSeconds === 0 || policy.quotaWindowSeconds > 86_400) throw new RangeError("quota window is outside policy");
  if (policy.maxActiveRequestsPerIdentity === 0 || policy.maxActiveRequestsPerIdentity > 100) throw new RangeError("active RFQ limit is outside policy");
  if (policy.maxRequestsPerWindow === 0 || policy.maxRequestsPerWindow > 10_000) throw new RangeError("RFQ window limit is outside policy");
  if (policy.maxCancellationsPerWindow === 0 || policy.maxCancellationsPerWindow > 1_000) throw new RangeError("cancellation window limit is outside policy");
  if (policy.maxActiveFirmQuotesPerSolver === 0 || policy.maxActiveFirmQuotesPerSolver > 100) throw new RangeError("active firm quote limit is outside policy");
  if (policy.maxConsecutiveFailures === 0 || policy.maxConsecutiveFailures > 100) throw new RangeError("consecutive failure limit is outside policy");
  return policy;
}

function normalizeAuthenticatedIdentity(input) {
  exactKeys(input, ["authenticated", "commitment", "key"], "authenticated RFQ identity");
  if (input.authenticated !== true) throw new Error("authenticated identity required");
  const key = String(input.key ?? "");
  if (key.length === 0 || key.length > 256 || /[\r\n]/.test(key)) throw new TypeError("identity key is invalid");
  const commitment = bytes32(input.commitment, "identity.commitment");
  if (commitment === `0x${"0".repeat(64)}`) throw new RangeError("identity commitment must be non-zero");
  return Object.freeze({
    authenticated: true,
    commitment,
    key,
    keyBindingDigest: digest({ scope: "treeswap-rfq-identity-v1", commitment, key: key.toLowerCase() }),
  });
}

function normalizeRfqRequest(input) {
  exactKeys(input, ["direction", "expiresAt", "nonce", "notionalSats", "requestId", "user"], "RFQ request");
  if (!DIRECTIONS.has(input.direction)) throw new RangeError("RFQ direction is unsupported");
  const user = String(input.user ?? "");
  if (user.length === 0 || user.length > 256 || /[\r\n]/.test(user)) throw new TypeError("RFQ user is invalid");
  return Object.freeze({
    requestId: bytes32(input.requestId, "request.requestId"),
    user,
    direction: input.direction,
    notionalSats: uint(input.notionalSats, "request.notionalSats", { nonzero: true, maximum: (1n << 64n) - 1n }),
    nonce: uint(input.nonce, "request.nonce", { maximum: (1n << 256n) - 1n }),
    expiresAt: integer(input.expiresAt, "request.expiresAt"),
  });
}

function normalizeSolverSnapshot(input) {
  exactKeys(input, [
    "availableBitWei", "availableLightningSats", "capabilityDigest", "capabilityExpiresAt",
    "capabilityVerified", "capacityEpoch", "observedAt", "solverId",
  ], "solver capacity snapshot");
  if (input.capabilityVerified !== true) throw new Error("solver capability signature must be verified before admission");
  const capabilityDigest = bytes32(input.capabilityDigest, "capabilityDigest");
  if (capabilityDigest === `0x${"0".repeat(64)}`) throw new RangeError("capability digest must be non-zero");
  const capacityObservedAt = integer(input.observedAt, "observedAt");
  const capabilityExpiresAt = integer(input.capabilityExpiresAt, "capabilityExpiresAt");
  if (capabilityExpiresAt <= capacityObservedAt) {
    throw new RangeError("solver capability must expire after its capacity observation");
  }
  return Object.freeze({
    solverId: address(input.solverId, "solverId"),
    capabilityDigest,
    capabilityExpiresAt,
    capacityEpoch: integer(input.capacityEpoch, "capacityEpoch"),
    capacityObservedAt,
    availableBitWei: uint(input.availableBitWei, "availableBitWei", { maximum: (1n << 256n) - 1n }),
    availableLightningSats: uint(input.availableLightningSats, "availableLightningSats", { maximum: (1n << 64n) - 1n }),
  });
}

function normalizeFirmOfferReservation(input) {
  exactKeys(input, ["now", "offer", "offerDigest", "offerId", "policy", "requestId", "solverId"], "firm offer reservation");
  exactKeys(input.offer, [
    "bitAmountWei", "capacityEpoch", "direction", "expiresAt", "lightningAmountSats", "signatureVerified",
  ], "verified firm offer");
  if (!DIRECTIONS.has(input.offer.direction)) throw new RangeError("firm offer direction is unsupported");
  if (input.offer.signatureVerified !== true) throw new Error("firm offer signature must be verified before reservation");
  return Object.freeze({
    offerId: bytes32(input.offerId, "offerId"),
    offerDigest: bytes32(input.offerDigest, "offerDigest"),
    requestId: bytes32(input.requestId, "requestId"),
    solverId: address(input.solverId, "solverId"),
    offer: Object.freeze({
      direction: input.offer.direction,
      bitAmountWei: uint(input.offer.bitAmountWei, "offer.bitAmountWei", { maximum: (1n << 256n) - 1n }),
      lightningAmountSats: uint(input.offer.lightningAmountSats, "offer.lightningAmountSats", { maximum: (1n << 64n) - 1n }),
      capacityEpoch: integer(input.offer.capacityEpoch, "offer.capacityEpoch"),
      expiresAt: integer(input.offer.expiresAt, "offer.expiresAt"),
      solverSigned: true,
    }),
    policy: normalizeAdmissionPolicy(input.policy),
    now: integer(input.now, "now"),
  });
}

function asRfqRequest(row) {
  if (!row) return null;
  return Object.freeze({
    requestId: row.request_id,
    identityCommitment: row.identity_commitment,
    direction: row.direction,
    notionalSats: row.notional_sats,
    nonce: row.nonce,
    expiresAt: row.expires_at,
    recordDigest: row.record_digest,
    state: row.state,
    resolutionDigest: row.resolution_digest,
    acceptedAt: row.accepted_at,
    resolvedAt: row.resolved_at,
  });
}

function asSolverCapacity(row) {
  if (!row) return null;
  return Object.freeze({
    solverId: row.solver_id,
    capabilityDigest: row.capability_digest,
    capabilityExpiresAt: row.capability_expires_at,
    snapshotDigest: row.snapshot_digest,
    admitted: true,
    suspended: row.failure_suspended === 1,
    capacityConflict: row.capacity_conflicted === 1,
    capacityObservedAt: row.capacity_observed_at,
    capacityEpoch: row.capacity_epoch,
    availableBitWei: row.available_bit_wei,
    committedBitWei: row.committed_bit_wei,
    availableLightningSats: row.available_lightning_sats,
    committedLightningSats: row.committed_lightning_sats,
    activeFirmQuotes: row.active_firm_quotes,
    successfulFills: row.successful_fills,
    attributableFailures: row.attributable_failures,
    consecutiveFailures: row.consecutive_failures,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function asFirmOffer(row) {
  if (!row) return null;
  return Object.freeze({
    offerId: row.offer_id,
    offerDigest: row.offer_digest,
    requestId: row.request_id,
    solverId: row.solver_id,
    direction: row.direction,
    amount: row.amount,
    capacityEpoch: row.capacity_epoch,
    expiresAt: row.expires_at,
    recordDigest: row.record_digest,
    state: row.state,
    outcomeDigest: row.outcome_digest,
    reservedAt: row.reserved_at,
    resolvedAt: row.resolved_at,
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
  #backupInProgress = false;

  constructor(database, path) {
    this.#db = database;
    this.#path = path;
  }

  static async open(path, { allowMemory = false } = {}) {
    if (path === ":memory:") {
      if (!allowMemory) throw new Error("in-memory coordinator storage is test-only");
    } else {
      if (!isAbsolute(path)) throw new Error("coordinator database path must be absolute");
      await privateDirectory(dirname(path));
      try {
        const state = await lstat(path);
        if (state.isSymbolicLink() || !state.isFile()) throw new Error("coordinator database path must be a regular file");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    let database;
    try {
      database = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        timeout: 5_000,
      });
      database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
      verifyDatabase(database, { full: false, requireSchema: false });
      const existingMeta = database.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'coordinator_meta'
      `).get();
      let existingSchemaValue = null;
      if (existingMeta) {
        const existingSchema = database.prepare("SELECT value FROM coordinator_meta WHERE key = 'schema'").get();
        existingSchemaValue = existingSchema?.value ?? null;
        if (![COORDINATOR_SCHEMA, "treeswap.coordinator.v1", "treeswap.coordinator.v2", "treeswap.coordinator.v3"].includes(existingSchemaValue)) {
          throw new Error("coordinator database schema is unsupported");
        }
      }
      database.exec(COORDINATOR_SCHEMA_SQL);
      const solverCapacityColumns = database.prepare("PRAGMA table_info(solver_capacity)").all();
      if (!solverCapacityColumns.some((column) => column.name === "capability_expires_at")) {
        database.exec("ALTER TABLE solver_capacity ADD COLUMN capability_expires_at INTEGER NOT NULL DEFAULT 0");
      }
      database.prepare("INSERT OR IGNORE INTO coordinator_meta(key, value) VALUES ('schema', ?)").run(COORDINATOR_SCHEMA);
      const schema = database.prepare("SELECT value FROM coordinator_meta WHERE key = 'schema'").get();
      if (["treeswap.coordinator.v1", "treeswap.coordinator.v2", "treeswap.coordinator.v3"].includes(schema?.value)) {
        database.prepare("UPDATE coordinator_meta SET value = ? WHERE key = 'schema'").run(COORDINATOR_SCHEMA);
      } else if (schema?.value !== COORDINATOR_SCHEMA) {
        throw new Error("coordinator database schema is unsupported");
      }
      verifyDatabase(database, { full: false, requireSchema: true });
      if (path !== ":memory:") await chmod(path, 0o600);
      return new CoordinatorStore(database, path);
    } catch (error) {
      try { database?.close(); } catch {}
      throw error;
    }
  }

  close() {
    if (this.#backupInProgress) throw new Error("coordinator backup is still in progress");
    this.#db.close();
  }

  get path() {
    return this.#path;
  }

  integrityCheck({ full = false } = {}) {
    if (typeof full !== "boolean") throw new TypeError("integrity check mode must be boolean");
    return verifyDatabase(this.#db, { full, requireSchema: true });
  }

  async createVerifiedBackup(destination) {
    if (this.#path === ":memory:") throw new Error("in-memory coordinator storage cannot be backed up");
    if (!isAbsolute(destination)) throw new Error("coordinator backup path must be absolute");
    if (resolve(destination) === resolve(this.#path)) throw new Error("coordinator backup cannot replace its source");
    if (this.#backupInProgress) throw new Error("coordinator backup is already in progress");
    await privateDirectory(dirname(destination));
    await requireAbsentFile(destination, "coordinator backup");
    const partial = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.partial`);
    let destinationCreated = false;
    this.#backupInProgress = true;
    try {
      const pages = await backupDatabase(this.#db, partial, { rate: 128 });
      await chmod(partial, 0o600);
      const verification = inspectReadOnlyDatabase(partial, { full: true });
      await syncFileAndParent(partial);
      await copyFile(partial, destination, fsConstants.COPYFILE_EXCL);
      destinationCreated = true;
      await chmod(destination, 0o600);
      await syncFileAndParent(destination);
      return Object.freeze({ ...verification, pages });
    } catch (error) {
      if (destinationCreated) await rm(destination, { force: true }).catch(() => {});
      throw error;
    } finally {
      this.#backupInProgress = false;
      await rm(partial, { force: true }).catch(() => {});
    }
  }

  static async verifyBackup(path) {
    await regularFile(path, "coordinator backup");
    return inspectReadOnlyDatabase(path, { full: true });
  }

  static async restoreVerifiedBackup(backupPath, destination) {
    await regularFile(backupPath, "coordinator backup");
    if (!isAbsolute(destination)) throw new Error("coordinator restore path must be absolute");
    if (resolve(backupPath) === resolve(destination)) throw new Error("coordinator restore cannot replace its backup");
    inspectReadOnlyDatabase(backupPath, { full: true });
    await privateDirectory(dirname(destination));
    await requireAbsentFile(destination, "coordinator restore destination");
    let destinationCreated = false;
    try {
      await copyFile(backupPath, destination, fsConstants.COPYFILE_EXCL);
      destinationCreated = true;
      await chmod(destination, 0o600);
      await syncFileAndParent(destination);
      const restored = await CoordinatorStore.open(destination);
      try {
        const verification = restored.integrityCheck({ full: true });
        return Object.freeze({ ...verification, restoredToFreshPath: true });
      } finally {
        restored.close();
      }
    } catch (error) {
      if (destinationCreated) await rm(destination, { force: true }).catch(() => {});
      throw error;
    }
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

  listSettlementActions(settlementId) {
    const id = bytes32(settlementId, "settlementId");
    return Object.freeze(this.#db.prepare(`
      SELECT * FROM coordinator_actions WHERE settlement_id = ? ORDER BY planned_at, action_id
    `).all(id).map(asAction));
  }

  getEvmTransaction(actionId) {
    return asEvmTransaction(this.#db.prepare("SELECT * FROM coordinator_evm_transactions WHERE action_id = ?")
      .get(bytes32(actionId, "actionId")));
  }

  getRfqRequest(requestId) {
    return asRfqRequest(this.#db.prepare("SELECT * FROM rfq_requests WHERE request_id = ?")
      .get(bytes32(requestId, "requestId")));
  }

  getSolverCapacity(solverId) {
    return asSolverCapacity(this.#db.prepare("SELECT * FROM solver_capacity WHERE solver_id = ?")
      .get(address(solverId, "solverId")));
  }

  getFirmOffer(offerId) {
    return asFirmOffer(this.#db.prepare("SELECT * FROM firm_offer_commitments WHERE offer_id = ?")
      .get(bytes32(offerId, "offerId")));
  }

  #ensureRfqIdentity(identity, observedAt) {
    const existing = this.#db.prepare("SELECT * FROM rfq_identities WHERE identity_commitment = ?")
      .get(identity.commitment);
    if (!existing) {
      this.#db.prepare(`
        INSERT INTO rfq_identities(
          identity_commitment, key_binding_digest, cancellation_sequence, created_at, updated_at, last_observed_at
        ) VALUES (?, ?, '0', ?, ?, ?)
      `).run(identity.commitment, identity.keyBindingDigest, observedAt, observedAt, observedAt);
      return this.#db.prepare("SELECT * FROM rfq_identities WHERE identity_commitment = ?").get(identity.commitment);
    }
    if (existing.key_binding_digest !== identity.keyBindingDigest) {
      throw new Error("RFQ identity commitment is bound to another authenticated key");
    }
    if (observedAt < existing.last_observed_at) throw new Error("RFQ admission clock moved backward");
    return existing;
  }

  #touchRfqIdentity(identityCommitment, observedAt) {
    this.#db.prepare(`
      UPDATE rfq_identities SET version = version + 1, updated_at = ?, last_observed_at = ?
      WHERE identity_commitment = ?
    `).run(observedAt, observedAt, identityCommitment);
  }

  #rfqUsage(identityCommitment, observedAt, quotaWindowSeconds) {
    const identity = this.#db.prepare("SELECT cancellation_sequence FROM rfq_identities WHERE identity_commitment = ?")
      .get(identityCommitment);
    if (!identity) throw new Error("RFQ identity does not exist");
    const activeRequests = Number(this.#db.prepare(`
      SELECT COUNT(*) AS count FROM rfq_requests WHERE identity_commitment = ? AND state = 'ACTIVE'
    `).get(identityCommitment).count);
    const threshold = observedAt - quotaWindowSeconds;
    const acceptedInWindow = Number(this.#db.prepare(`
      SELECT COUNT(*) AS count FROM rfq_admission_events
      WHERE identity_commitment = ? AND event_kind = 'ACCEPTED' AND occurred_at > ?
    `).get(identityCommitment, threshold).count);
    const cancellationsInWindow = Number(this.#db.prepare(`
      SELECT COUNT(*) AS count FROM rfq_admission_events
      WHERE identity_commitment = ? AND event_kind = 'CANCELED' AND occurred_at > ?
    `).get(identityCommitment, threshold).count);
    return Object.freeze({
      activeRequests,
      acceptedInWindow,
      cancellationsInWindow,
      cancellationSequence: identity.cancellation_sequence,
    });
  }

  #writeSolverAccounting(solver, updatedAt) {
    const capacityConflict = BigInt(solver.availableBitWei) < BigInt(solver.committedBitWei)
      || BigInt(solver.availableLightningSats) < BigInt(solver.committedLightningSats);
    this.#db.prepare(`
      UPDATE solver_capacity SET committed_bit_wei = ?, committed_lightning_sats = ?, active_firm_quotes = ?,
        successful_fills = ?, attributable_failures = ?, consecutive_failures = ?, failure_suspended = ?,
        capacity_conflicted = ?, version = version + 1, updated_at = ? WHERE solver_id = ?
    `).run(
      String(solver.committedBitWei), String(solver.committedLightningSats), solver.activeFirmQuotes,
      String(solver.successfulFills), String(solver.attributableFailures), solver.consecutiveFailures,
      solver.suspended === true ? 1 : 0, capacityConflict ? 1 : 0, updatedAt, solver.solverId,
    );
  }

  #completeFirmOffer(row, outcome, outcomeDigest, recordedAt, policy = { maxConsecutiveFailures: 1 }) {
    if (row.state !== "ACTIVE") throw new Error("firm offer is not active");
    if (recordedAt < row.reserved_at) throw new Error("firm offer outcome predates reservation");
    if (outcome === "expired-unexercised" && recordedAt < row.expires_at) {
      throw new Error("firm offer cannot expire before its signed deadline");
    }
    const solver = this.getSolverCapacity(row.solver_id);
    if (!solver) throw new Error("firm offer solver does not exist");
    const next = applyFirmOfferOutcome({
      solver,
      commitment: Object.freeze({
        direction: row.direction,
        amount: BigInt(row.amount),
        capacityEpoch: row.capacity_epoch,
        expiresAt: row.expires_at,
      }),
      outcome,
      policy,
    });
    this.#writeSolverAccounting({ ...next, solverId: solver.solverId }, recordedAt);
    this.#db.prepare(`
      UPDATE firm_offer_commitments SET state = ?, outcome_digest = ?, resolved_at = ? WHERE offer_id = ?
    `).run(FIRM_OFFER_OUTCOMES.get(outcome), outcomeDigest, recordedAt, row.offer_id);
    return this.getFirmOffer(row.offer_id);
  }

  #releaseActiveFirmOffers(requestId, outcome, recordedAt) {
    const rows = this.#db.prepare(`
      SELECT * FROM firm_offer_commitments WHERE request_id = ? AND state = 'ACTIVE' ORDER BY offer_id
    `).all(requestId);
    for (const row of rows) {
      this.#completeFirmOffer(
        row,
        outcome,
        digest({ code: outcome, offerId: row.offer_id, recordedAt, requestId }),
        recordedAt,
      );
    }
    return rows.length;
  }

  #expireRfqRequests(observedAt, { identityCommitment = null, limit = 1_000 } = {}) {
    const rows = identityCommitment
      ? this.#db.prepare(`
          SELECT * FROM rfq_requests
          WHERE identity_commitment = ? AND state = 'ACTIVE' AND expires_at <= ?
          ORDER BY expires_at, request_id LIMIT ?
        `).all(identityCommitment, observedAt, limit)
      : this.#db.prepare(`
          SELECT * FROM rfq_requests WHERE state = 'ACTIVE' AND expires_at <= ?
          ORDER BY expires_at, request_id LIMIT ?
        `).all(observedAt, limit);
    for (const row of rows) {
      this.#releaseActiveFirmOffers(row.request_id, "expired-unexercised", observedAt);
      const proof = digest({ code: "RFQ_EXPIRED", observedAt, requestId: row.request_id });
      this.#db.prepare(`
        UPDATE rfq_requests SET state = 'EXPIRED', resolution_digest = ?, resolved_at = ? WHERE request_id = ?
      `).run(proof, observedAt, row.request_id);
    }
    return rows.length;
  }

  admitRfq(input) {
    exactKeys(input, ["identity", "now", "policy", "request"], "RFQ admission");
    const identity = normalizeAuthenticatedIdentity(input.identity);
    const request = normalizeRfqRequest(input.request);
    const policy = normalizeAdmissionPolicy(input.policy);
    const observedAt = integer(input.now, "now");
    const recordTerms = Object.freeze({
      requestId: request.requestId,
      identityCommitment: identity.commitment,
      direction: request.direction,
      notionalSats: request.notionalSats,
      nonce: request.nonce,
      expiresAt: request.expiresAt,
    });
    const recordDigest = digest(recordTerms);
    return this.#transaction(() => {
      this.#ensureRfqIdentity(identity, observedAt);
      this.#expireRfqRequests(observedAt, { identityCommitment: identity.commitment });
      const existing = this.getRfqRequest(request.requestId);
      if (existing) {
        if (existing.recordDigest !== recordDigest) throw new Error("RFQ request identifier was already bound to different terms");
        this.#touchRfqIdentity(identity.commitment, observedAt);
        return Object.freeze({ request: existing, usage: this.#rfqUsage(identity.commitment, observedAt, policy.quotaWindowSeconds) });
      }
      const usage = this.#rfqUsage(identity.commitment, observedAt, policy.quotaWindowSeconds);
      const assessment = assessRfqAdmission({
        request,
        identity: { authenticated: true, key: identity.key },
        usage,
        policy,
        now: observedAt,
      });
      if (!assessment.allowed) throw new Error(`RFQ admission rejected: ${assessment.reasons.join("; ")}`);
      try {
        this.#db.prepare(`
          INSERT INTO rfq_requests(
            request_id, identity_commitment, direction, notional_sats, nonce, expires_at, record_digest, state, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
        `).run(
          request.requestId, identity.commitment, request.direction, request.notionalSats, request.nonce,
          request.expiresAt, recordDigest, observedAt,
        );
      } catch (error) {
        if (/constraint|unique/i.test(String(error?.message))) throw new Error("RFQ nonce or request identifier was already used");
        throw error;
      }
      this.#db.prepare(`
        INSERT INTO rfq_admission_events(
          event_id, identity_commitment, request_id, event_kind, sequence, record_digest, occurred_at
        ) VALUES (?, ?, ?, 'ACCEPTED', ?, ?, ?)
      `).run(request.requestId, identity.commitment, request.requestId, request.nonce, recordDigest, observedAt);
      this.#touchRfqIdentity(identity.commitment, observedAt);
      return Object.freeze({
        request: this.getRfqRequest(request.requestId),
        usage: this.#rfqUsage(identity.commitment, observedAt, policy.quotaWindowSeconds),
      });
    });
  }

  cancelRfqs(input) {
    exactKeys(input, ["cancellationId", "cancellationSequence", "identity", "recordedAt"], "RFQ cancellation");
    const identity = normalizeAuthenticatedIdentity(input.identity);
    const cancellationId = bytes32(input.cancellationId, "cancellationId");
    const cancellationSequence = uint(input.cancellationSequence, "cancellationSequence", { maximum: (1n << 256n) - 1n });
    const recordedAt = integer(input.recordedAt, "recordedAt");
    const cancellationDigest = digest({
      cancellationId,
      cancellationSequence,
      identityCommitment: identity.commitment,
      recordedAt,
    });
    return this.#transaction(() => {
      const identityRow = this.#ensureRfqIdentity(identity, recordedAt);
      const existing = this.#db.prepare("SELECT * FROM rfq_admission_events WHERE event_id = ?").get(cancellationId);
      if (existing) {
        if (existing.record_digest !== cancellationDigest) throw new Error("cancellation identifier was already bound to different terms");
        this.#touchRfqIdentity(identity.commitment, recordedAt);
        return Object.freeze({ cancellationSequence, canceledRequests: 0, idempotent: true });
      }
      if (BigInt(cancellationSequence) <= BigInt(identityRow.cancellation_sequence)) {
        throw new Error("cancellation sequence must advance permanently");
      }
      this.#expireRfqRequests(recordedAt, { identityCommitment: identity.commitment });
      const active = this.#db.prepare(`
        SELECT * FROM rfq_requests WHERE identity_commitment = ? AND state = 'ACTIVE' ORDER BY accepted_at, request_id
      `).all(identity.commitment).filter((row) => BigInt(row.nonce) <= BigInt(cancellationSequence));
      for (const row of active) {
        this.#releaseActiveFirmOffers(row.request_id, "user-abandoned", recordedAt);
        this.#db.prepare(`
          UPDATE rfq_requests SET state = 'CANCELED', resolution_digest = ?, resolved_at = ? WHERE request_id = ?
        `).run(cancellationDigest, recordedAt, row.request_id);
      }
      this.#db.prepare(`
        UPDATE rfq_identities SET cancellation_sequence = ?, version = version + 1, updated_at = ?, last_observed_at = ?
        WHERE identity_commitment = ?
      `).run(cancellationSequence, recordedAt, recordedAt, identity.commitment);
      this.#db.prepare(`
        INSERT INTO rfq_admission_events(
          event_id, identity_commitment, request_id, event_kind, sequence, record_digest, occurred_at
        ) VALUES (?, ?, NULL, 'CANCELED', ?, ?, ?)
      `).run(cancellationId, identity.commitment, cancellationSequence, cancellationDigest, recordedAt);
      return Object.freeze({ cancellationSequence, canceledRequests: active.length, idempotent: false });
    });
  }

  expireRfqs(observedAt, limit = 1_000) {
    const at = integer(observedAt, "observedAt");
    const bounded = integer(limit, "limit");
    if (bounded === 0 || bounded > 1_000) throw new RangeError("RFQ expiry limit is outside policy");
    return this.#transaction(() => this.#expireRfqRequests(at, { limit: bounded }));
  }

  resolveRfq(input) {
    exactKeys(input, ["evidenceDigest", "outcome", "recordedAt", "requestId"], "RFQ resolution");
    const requestId = bytes32(input.requestId, "requestId");
    const evidenceDigest = bytes32(input.evidenceDigest, "evidenceDigest");
    const recordedAt = integer(input.recordedAt, "recordedAt");
    const state = { exercised: "EXERCISED", "user-abandoned": "ABANDONED" }[input.outcome];
    if (!state || !RFQ_STATES.has(state)) throw new RangeError("RFQ outcome is unsupported");
    return this.#transaction(() => {
      const request = this.getRfqRequest(requestId);
      if (!request) throw new Error("RFQ request does not exist");
      if (request.state !== "ACTIVE") {
        if (request.state === state && request.resolutionDigest === evidenceDigest) return request;
        throw new Error("RFQ request is already resolved");
      }
      if (recordedAt < request.acceptedAt) throw new Error("RFQ resolution predates admission");
      if (state === "EXERCISED") {
        const filled = this.#db.prepare(`
          SELECT offer_id FROM firm_offer_commitments WHERE request_id = ? AND state = 'FILLED' LIMIT 1
        `).get(requestId);
        if (!filled) throw new Error("RFQ cannot be exercised without a filled firm offer");
      }
      this.#releaseActiveFirmOffers(requestId, "user-abandoned", recordedAt);
      this.#db.prepare(`
        UPDATE rfq_requests SET state = ?, resolution_digest = ?, resolved_at = ? WHERE request_id = ?
      `).run(state, evidenceDigest, recordedAt, requestId);
      return this.getRfqRequest(requestId);
    });
  }

  recordSolverCapacity(input) {
    const value = normalizeSolverSnapshot(input);
    const snapshotDigest = digest(value);
    return this.#transaction(() => {
      const existing = this.getSolverCapacity(value.solverId);
      if (!existing) {
        this.#db.prepare(`
          INSERT INTO solver_capacity(
            solver_id, capability_digest, capability_expires_at, snapshot_digest, capacity_epoch, capacity_observed_at,
            available_bit_wei, available_lightning_sats, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          value.solverId, value.capabilityDigest, value.capabilityExpiresAt, snapshotDigest,
          value.capacityEpoch, value.capacityObservedAt,
          value.availableBitWei, value.availableLightningSats, value.capacityObservedAt, value.capacityObservedAt,
        );
        return this.getSolverCapacity(value.solverId);
      }
      if (value.capacityEpoch === existing.capacityEpoch) {
        if (existing.snapshotDigest !== snapshotDigest) throw new Error("capacity epoch was already bound to another snapshot");
        return existing;
      }
      if (value.capacityEpoch < existing.capacityEpoch) throw new Error("capacity epoch moved backward");
      if (value.capacityObservedAt <= existing.capacityObservedAt) throw new Error("capacity observation time must advance");
      const conflict = BigInt(value.availableBitWei) < BigInt(existing.committedBitWei)
        || BigInt(value.availableLightningSats) < BigInt(existing.committedLightningSats);
      this.#db.prepare(`
        UPDATE solver_capacity SET capability_digest = ?, capability_expires_at = ?, snapshot_digest = ?, capacity_epoch = ?,
          capacity_observed_at = ?, available_bit_wei = ?, available_lightning_sats = ?, capacity_conflicted = ?,
          version = version + 1, updated_at = ? WHERE solver_id = ?
      `).run(
        value.capabilityDigest, value.capabilityExpiresAt, snapshotDigest, value.capacityEpoch, value.capacityObservedAt,
        value.availableBitWei, value.availableLightningSats, conflict ? 1 : 0, value.capacityObservedAt, value.solverId,
      );
      return this.getSolverCapacity(value.solverId);
    });
  }

  reserveVerifiedFirmOffer(input) {
    const value = normalizeFirmOfferReservation(input);
    const amount = value.offer.direction === "lightning-to-bit"
      ? value.offer.bitAmountWei
      : value.offer.lightningAmountSats;
    const recordTerms = Object.freeze({
      offerId: value.offerId,
      offerDigest: value.offerDigest,
      requestId: value.requestId,
      solverId: value.solverId,
      direction: value.offer.direction,
      amount,
      capacityEpoch: value.offer.capacityEpoch,
      expiresAt: value.offer.expiresAt,
    });
    const recordDigest = digest(recordTerms);
    return this.#transaction(() => {
      const existing = this.getFirmOffer(value.offerId);
      if (existing) {
        if (existing.recordDigest !== recordDigest) throw new Error("firm offer identifier was already bound to different terms");
        return existing;
      }
      this.#expireRfqRequests(value.now);
      const request = this.getRfqRequest(value.requestId);
      if (!request || request.state !== "ACTIVE") throw new Error("firm offer requires an active RFQ");
      if (request.direction !== value.offer.direction) throw new Error("firm offer direction does not match the RFQ");
      if (value.offer.expiresAt > request.expiresAt) throw new Error("firm offer outlives its RFQ");
      if (value.offer.lightningAmountSats !== request.notionalSats) throw new Error("firm offer notional does not match the RFQ");
      const solver = this.getSolverCapacity(value.solverId);
      if (!solver) throw new Error("solver has no verified capacity declaration");
      const assessment = assessFirmOffer({ offer: value.offer, solver, policy: value.policy, now: value.now });
      if (!assessment.allowed) throw new Error(`firm offer admission rejected: ${assessment.reasons.join("; ")}`);
      const next = applyFirmOfferReservation({ solver, assessment });
      try {
        this.#db.prepare(`
          INSERT INTO firm_offer_commitments(
            offer_id, offer_digest, request_id, solver_id, direction, amount, capacity_epoch, expires_at,
            record_digest, state, reserved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
        `).run(
          value.offerId, value.offerDigest, value.requestId, value.solverId, value.offer.direction, String(amount),
          value.offer.capacityEpoch, value.offer.expiresAt, recordDigest, value.now,
        );
      } catch (error) {
        if (/constraint|unique/i.test(String(error?.message))) throw new Error("solver already has a firm offer for this RFQ or offer digest");
        throw error;
      }
      this.#writeSolverAccounting({ ...next, solverId: solver.solverId }, value.now);
      return this.getFirmOffer(value.offerId);
    });
  }

  recordFirmOfferOutcome(input) {
    exactKeys(input, ["evidenceDigest", "offerId", "outcome", "policy", "recordedAt"], "firm offer outcome");
    const offerId = bytes32(input.offerId, "offerId");
    const evidenceDigest = bytes32(input.evidenceDigest, "evidenceDigest");
    const recordedAt = integer(input.recordedAt, "recordedAt");
    const policy = normalizeAdmissionPolicy(input.policy);
    const state = FIRM_OFFER_OUTCOMES.get(input.outcome);
    if (!state || !FIRM_OFFER_STATES.has(state)) throw new RangeError("firm offer outcome is unsupported");
    return this.#transaction(() => {
      const current = this.getFirmOffer(offerId);
      if (!current) throw new Error("firm offer does not exist");
      if (current.state !== "ACTIVE") {
        if (current.state === state && current.outcomeDigest === evidenceDigest) return current;
        throw new Error("firm offer already has another outcome");
      }
      const row = this.#db.prepare("SELECT * FROM firm_offer_commitments WHERE offer_id = ?").get(offerId);
      const completed = this.#completeFirmOffer(row, input.outcome, evidenceDigest, recordedAt, policy);
      if (input.outcome === "filled") {
        const request = this.getRfqRequest(completed.requestId);
        if (!request || request.state !== "ACTIVE") throw new Error("filled firm offer requires an active RFQ");
        this.#releaseActiveFirmOffers(completed.requestId, "user-abandoned", recordedAt);
        this.#db.prepare(`
          UPDATE rfq_requests SET state = 'EXERCISED', resolution_digest = ?, resolved_at = ? WHERE request_id = ?
        `).run(evidenceDigest, recordedAt, completed.requestId);
      }
      return this.getFirmOffer(offerId);
    });
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

  admissionMetrics() {
    const rfqStates = Object.fromEntries(
      this.#db.prepare("SELECT state, COUNT(*) AS count FROM rfq_requests GROUP BY state ORDER BY state").all()
        .map((row) => [row.state, Number(row.count)]),
    );
    const firmOfferStates = Object.fromEntries(
      this.#db.prepare("SELECT state, COUNT(*) AS count FROM firm_offer_commitments GROUP BY state ORDER BY state").all()
        .map((row) => [row.state, Number(row.count)]),
    );
    const solverHealth = Object.freeze({
      total: Number(this.#db.prepare("SELECT COUNT(*) AS count FROM solver_capacity").get().count),
      failureSuspended: Number(this.#db.prepare("SELECT COUNT(*) AS count FROM solver_capacity WHERE failure_suspended = 1").get().count),
      capacityConflicted: Number(this.#db.prepare("SELECT COUNT(*) AS count FROM solver_capacity WHERE capacity_conflicted = 1").get().count),
    });
    const activeCommitments = Number(
      this.#db.prepare("SELECT COUNT(*) AS count FROM firm_offer_commitments WHERE state = 'ACTIVE'").get().count,
    );
    return Object.freeze({ rfqStates, firmOfferStates, solverHealth, activeCommitments });
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
