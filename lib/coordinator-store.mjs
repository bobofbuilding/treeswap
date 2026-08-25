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
import {
  validateCoordinatorActiveExecutionBootstrapStatus,
  validateCoordinatorActiveExecutionStatus,
} from "./coordinator-service-state.mjs";

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
const COORDINATOR_SCHEMA = "treeswap.coordinator.v9";
const COORDINATOR_SERVICE_RUN_SCHEMA = "treeswap.coordinator-service-run.v1";
const COORDINATOR_SERVICE_RUN_HANDLE_SCHEMA = "treeswap.coordinator-service-run-handle.v1";
const ACTIVE_SERVICE_MODE = "active-execution-only";
const SERVICE_RUN_REASONS = new Set([
  "requested",
  "aborted",
  "startup-failure",
  "background-failure",
]);
const FAILURE_REASONS = new Set(["startup-failure", "background-failure", "abrupt-exit"]);
const SERVICE_RUN_META_KEYS = Object.freeze({
  schema: "service_run_schema",
  runDigest: "service_run_digest",
  mode: "service_run_mode",
  state: "service_run_state",
  startedAt: "service_run_started_at",
  updatedAt: "service_run_updated_at",
  outcome: "service_run_outcome",
  lastStatusAt: "service_run_last_status_at",
  lastStatusDigest: "service_run_last_status_digest",
  lastStatusPhase: "service_run_last_status_phase",
  lastStatusHealthy: "service_run_last_status_healthy",
  failureWindowSeconds: "service_run_failure_window_seconds",
  maximumFailures: "service_run_maximum_failures",
  failureWindowStartedAt: "service_run_failure_window_started_at",
  failureCount: "service_run_failure_count",
  lastFailureAt: "service_run_last_failure_at",
  lastFailureReason: "service_run_last_failure_reason",
});
const coordinatorServiceRunHandles = new WeakMap();
const activeCoordinatorServiceRuns = new WeakMap();

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
  selected_offer_id TEXT NOT NULL UNIQUE,
  capacity_epoch INTEGER NOT NULL,
  release_record_digest TEXT,
  risk_policy_digest TEXT,
  evidence_policy_digest TEXT,
  solver_capability_digest TEXT,
  execution_policy_binding_digest TEXT,
  execution_policy_bound_at INTEGER,
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
  CHECK ((release_record_digest IS NULL) = (evidence_policy_digest IS NULL)),
  CHECK ((release_record_digest IS NULL) = (risk_policy_digest IS NULL)),
  CHECK ((release_record_digest IS NULL) = (solver_capability_digest IS NULL)),
  CHECK ((release_record_digest IS NULL) = (execution_policy_binding_digest IS NULL)),
  CHECK ((release_record_digest IS NULL) = (execution_policy_bound_at IS NULL)),
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
  selection_authorization_digest TEXT NOT NULL,
  selection_authorization_expires_at INTEGER NOT NULL,
  market_risk_digest TEXT NOT NULL,
  market_risk_policy_digest TEXT NOT NULL,
  market_risk_valid_until INTEGER NOT NULL,
  request_id TEXT NOT NULL REFERENCES rfq_requests(request_id) ON DELETE RESTRICT,
  solver_id TEXT NOT NULL REFERENCES solver_capacity(solver_id) ON DELETE RESTRICT,
  capability_digest TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lightning-to-bit', 'bit-to-lightning')),
  amount TEXT NOT NULL,
  bit_amount_wei TEXT NOT NULL,
  lightning_amount_sats TEXT NOT NULL,
  private_request_digest TEXT,
  executable_offer_digest TEXT,
  execution_binding_digest TEXT,
  execution_authorization_digest TEXT,
  execution_authorization_expires_at INTEGER,
  finalized_at INTEGER,
  authorized_at INTEGER,
  capacity_epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  record_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'FILLED', 'SOLVER_FAILED', 'EXPIRED_UNEXERCISED', 'USER_ABANDONED')),
  outcome_digest TEXT,
  reserved_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (request_id, solver_id),
  CHECK ((outcome_digest IS NULL) = (resolved_at IS NULL)),
  CHECK ((private_request_digest IS NULL) = (executable_offer_digest IS NULL)),
  CHECK ((private_request_digest IS NULL) = (execution_binding_digest IS NULL)),
  CHECK ((private_request_digest IS NULL) = (finalized_at IS NULL)),
  CHECK ((execution_authorization_digest IS NULL) = (execution_authorization_expires_at IS NULL)),
  CHECK ((execution_authorization_digest IS NULL) = (authorized_at IS NULL)),
  CHECK (execution_authorization_digest IS NULL OR execution_binding_digest IS NOT NULL),
  CHECK (selection_authorization_expires_at <= expires_at),
  CHECK (expires_at <= market_risk_valid_until),
  CHECK (execution_authorization_expires_at IS NULL OR execution_authorization_expires_at <= selection_authorization_expires_at),
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
CREATE UNIQUE INDEX IF NOT EXISTS settlements_selected_offer_idx ON settlements(selected_offer_id);
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

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside policy`);
  }
  return value;
}

function wholeSecondIso(seconds) {
  return new Date(integer(seconds, "service run time") * 1_000).toISOString();
}

function parseStoredInteger(value, name, { nullable = false } = {}) {
  if (nullable && (value === null || value === "")) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value ?? ""))) {
    throw new Error(`${name} is corrupt`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is corrupt`);
  return parsed;
}

function parseStoredBoolean(value, name, { nullable = false } = {}) {
  if (nullable && (value === null || value === "")) return null;
  if (value !== "0" && value !== "1") throw new Error(`${name} is corrupt`);
  return value === "1";
}

function serviceStatusSummary(status, observedAt, startedAt) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new TypeError("coordinator service run status must be an object");
  }
  if (status.mode !== ACTIVE_SERVICE_MODE) {
    throw new Error("coordinator service run status belongs to another mode");
  }
  const expectedStartedAt = wholeSecondIso(startedAt);
  if (status.serviceStartedAt !== expectedStartedAt || status.heartbeatAt !== wholeSecondIso(observedAt)) {
    throw new Error("coordinator service run status time changed");
  }
  let phase;
  let healthy;
  if (status.schema === "treeswap.coordinator-active-execution-bootstrap-status.v1") {
    const validated = validateCoordinatorActiveExecutionBootstrapStatus(status);
    phase = validated.phase;
    healthy = false;
  } else if (status.schema === "treeswap.coordinator-active-execution-service-status.v1") {
    const validated = validateCoordinatorActiveExecutionStatus(status);
    phase = validated.activeExecution.state;
    healthy = phase === "active";
  } else {
    throw new Error("coordinator service run status schema is unsupported");
  }
  return Object.freeze({
    observedAt,
    statusDigest: digest(status),
    phase,
    healthy,
  });
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

function releaseLiabilitySnapshotForDatabase(database) {
  const rows = database.prepare(`
    SELECT settlement_id, direction, release_record_digest, risk_policy_digest, evidence_policy_digest,
      solver_capability_digest, execution_policy_binding_digest, state,
      reconciliation_required, halt_code, last_action_id
    FROM settlements
    WHERE terminal_state IS NULL
    ORDER BY settlement_id
  `).all().map((row) => Object.freeze({
    settlementId: row.settlement_id,
    direction: row.direction,
    releaseRecordDigest: row.release_record_digest,
    riskPolicyDigest: row.risk_policy_digest,
    evidencePolicyDigest: row.evidence_policy_digest,
    solverCapabilityDigest: row.solver_capability_digest,
    executionPolicyBindingDigest: row.execution_policy_binding_digest,
    state: row.state,
    reconciliationRequired: row.reconciliation_required === 1,
    haltCode: row.halt_code,
    lastActionId: row.last_action_id,
  }));
  const unbound = rows.filter((row) => row.releaseRecordDigest === null);
  const releases = [];
  const releaseDigests = [...new Set(rows
    .map((row) => row.releaseRecordDigest)
    .filter((value) => value !== null))].sort();
  for (const releaseRecordDigest of releaseDigests) {
    const releaseRows = rows.filter((row) => row.releaseRecordDigest === releaseRecordDigest);
    const policyKeys = [...new Set(releaseRows.map(
      (row) => `${row.direction}:${row.riskPolicyDigest}:${row.evidencePolicyDigest}`,
    ))].sort();
    const executionPolicies = policyKeys.map((key) => {
      const [direction, riskPolicyDigest, evidencePolicyDigest] = key.split(":");
      const policyRows = releaseRows.filter((row) => (
        row.direction === direction && row.riskPolicyDigest === riskPolicyDigest
          && row.evidencePolicyDigest === evidencePolicyDigest
      ));
      return Object.freeze({
        direction,
        riskPolicyDigest,
        evidencePolicyDigest,
        historicalSolverCapabilityDigests: Object.freeze(
          [...new Set(policyRows.map((row) => row.solverCapabilityDigest))].sort(),
        ),
        nonterminalSettlementCount: policyRows.length,
      });
    });
    releases.push(Object.freeze({
      releaseRecordDigest,
      nonterminalSettlementCount: releaseRows.length,
      executionPolicyCount: executionPolicies.length,
      executionPolicies: Object.freeze(executionPolicies),
      liabilitySetDigest: digest({
        schema: "treeswap.coordinator-release-liability-set.v1",
        releaseRecordDigest,
        settlements: releaseRows,
      }),
    }));
  }
  const core = Object.freeze({
    schema: "treeswap.coordinator-release-liabilities.v1",
    coordinatorSchema: COORDINATOR_SCHEMA,
    totalNonterminalSettlementCount: rows.length,
    unboundNonterminalSettlementCount: unbound.length,
    unboundActiveFirmOfferCount: Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM firm_offer_commitments AS offers
      LEFT JOIN settlements
        ON settlements.selected_offer_id = offers.offer_id
        AND settlements.terminal_state IS NULL
      WHERE offers.state = 'ACTIVE' AND settlements.settlement_id IS NULL
    `).get().count),
    unboundLiabilitySetDigest: digest({
      schema: "treeswap.coordinator-unbound-liability-set.v1",
      settlements: unbound,
    }),
    releases: Object.freeze(releases),
  });
  return Object.freeze({ ...core, snapshotDigest: digest(core) });
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

function normalizeSettlementExecutionPolicy(input) {
  exactKeys(input, [
    "boundAt", "evidencePolicyDigest", "releaseRecordDigest", "riskPolicyDigest", "settlementId",
    "solverCapabilityDigest",
  ], "settlement execution policy binding");
  const releaseRecordDigest = bytes32(input.releaseRecordDigest, "releaseRecordDigest");
  const riskPolicyDigest = bytes32(input.riskPolicyDigest, "riskPolicyDigest");
  const evidencePolicyDigest = bytes32(input.evidencePolicyDigest, "evidencePolicyDigest");
  const solverCapabilityDigest = bytes32(input.solverCapabilityDigest, "solverCapabilityDigest");
  if ([releaseRecordDigest, riskPolicyDigest, evidencePolicyDigest, solverCapabilityDigest]
    .some((value) => value === `0x${"0".repeat(64)}`)) {
    throw new RangeError("settlement execution-policy digests must be non-zero");
  }
  return Object.freeze({
    settlementId: bytes32(input.settlementId, "settlementId"),
    releaseRecordDigest,
    riskPolicyDigest,
    evidencePolicyDigest,
    solverCapabilityDigest,
    boundAt: integer(input.boundAt, "boundAt"),
  });
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
    "establishedSolverMaxBitToLightningSats", "maxActiveFirmQuotesPerSolver", "maxActiveRequestsPerIdentity", "maxCancellationsPerWindow",
    "maxCapacityAgeSeconds", "maxConsecutiveFailures", "maxFirmQuoteTtlSeconds", "maxGlobalBitToLightningInFlightSats",
    "maxRequestsPerWindow", "maxRfqTtlSeconds", "minimumCompletedFillsForEstablished", "minimumNotionalSats",
    "minimumReliabilityBps", "minimumReliabilitySample", "quotaWindowSeconds", "unknownSolverMaxBitToLightningSats",
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
    minimumCompletedFillsForEstablished: uint(
      input.minimumCompletedFillsForEstablished,
      "policy.minimumCompletedFillsForEstablished",
      { nonzero: true, maximum: (1n << 64n) - 1n },
    ),
    unknownSolverMaxBitToLightningSats: uint(
      input.unknownSolverMaxBitToLightningSats,
      "policy.unknownSolverMaxBitToLightningSats",
      { nonzero: true, maximum: (1n << 64n) - 1n },
    ),
    establishedSolverMaxBitToLightningSats: uint(
      input.establishedSolverMaxBitToLightningSats,
      "policy.establishedSolverMaxBitToLightningSats",
      { nonzero: true, maximum: (1n << 64n) - 1n },
    ),
    maxGlobalBitToLightningInFlightSats: uint(
      input.maxGlobalBitToLightningInFlightSats,
      "policy.maxGlobalBitToLightningInFlightSats",
      { nonzero: true, maximum: (1n << 64n) - 1n },
    ),
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
  if (BigInt(policy.establishedSolverMaxBitToLightningSats) < BigInt(policy.unknownSolverMaxBitToLightningSats)) {
    throw new RangeError("established solver cap cannot be below the unknown-solver cap");
  }
  if (BigInt(policy.maxGlobalBitToLightningInFlightSats) < BigInt(policy.establishedSolverMaxBitToLightningSats)) {
    throw new RangeError("global BIT-to-Lightning cap cannot be below the established per-solver cap");
  }
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
  exactKeys(input, [
    "now", "offer", "offerDigest", "offerId", "policy", "requestId",
    "marketRiskDigest", "marketRiskPolicyDigest", "marketRiskValidUntil", "selectionAuthorizationDigest",
    "selectionAuthorizationExpiresAt", "solverId",
  ], "firm offer reservation");
  exactKeys(input.offer, [
    "bitAmountWei", "capabilityDigest", "capacityEpoch", "direction", "expiresAt", "lightningAmountSats",
    "maxRoutingFeeSats", "signatureVerified",
  ], "verified firm offer");
  if (!DIRECTIONS.has(input.offer.direction)) throw new RangeError("firm offer direction is unsupported");
  if (input.offer.signatureVerified !== true) throw new Error("firm offer signature must be verified before reservation");
  const lightningAmountSats = uint(
    input.offer.lightningAmountSats,
    "offer.lightningAmountSats",
    { maximum: (1n << 64n) - 1n },
  );
  const maxRoutingFeeSats = uint(
    input.offer.maxRoutingFeeSats,
    "offer.maxRoutingFeeSats",
    { maximum: (1n << 64n) - 1n },
  );
  if (BigInt(lightningAmountSats) + BigInt(maxRoutingFeeSats) > (1n << 64n) - 1n) {
    throw new RangeError("firm offer Lightning amount plus routing headroom exceeds uint64");
  }
  const selectionAuthorizationDigest = bytes32(
    input.selectionAuthorizationDigest,
    "selectionAuthorizationDigest",
  );
  if (selectionAuthorizationDigest === `0x${"0".repeat(64)}`) {
    throw new RangeError("selection authorization digest must be non-zero");
  }
  const selectionAuthorizationExpiresAt = integer(
    input.selectionAuthorizationExpiresAt,
    "selectionAuthorizationExpiresAt",
  );
  const now = integer(input.now, "now");
  const offerExpiresAt = integer(input.offer.expiresAt, "offer.expiresAt");
  const marketRiskDigest = bytes32(input.marketRiskDigest, "marketRiskDigest");
  if (marketRiskDigest === `0x${"0".repeat(64)}`) {
    throw new RangeError("market risk digest must be non-zero");
  }
  const marketRiskPolicyDigest = bytes32(input.marketRiskPolicyDigest, "marketRiskPolicyDigest");
  if (marketRiskPolicyDigest === `0x${"0".repeat(64)}`) {
    throw new RangeError("market risk policy digest must be non-zero");
  }
  const marketRiskValidUntil = integer(input.marketRiskValidUntil, "marketRiskValidUntil");
  const capabilityDigest = bytes32(input.offer.capabilityDigest, "offer.capabilityDigest");
  if (capabilityDigest === `0x${"0".repeat(64)}`) {
    throw new RangeError("firm offer capability digest must be non-zero");
  }
  if (selectionAuthorizationExpiresAt <= now || selectionAuthorizationExpiresAt > offerExpiresAt) {
    throw new RangeError("selection authorization must be active and cannot outlive the firm offer");
  }
  if (marketRiskValidUntil < offerExpiresAt || marketRiskValidUntil <= now) {
    throw new RangeError("market risk authorization must remain active through the firm offer");
  }
  return Object.freeze({
    offerId: bytes32(input.offerId, "offerId"),
    offerDigest: bytes32(input.offerDigest, "offerDigest"),
    selectionAuthorizationDigest,
    selectionAuthorizationExpiresAt,
    marketRiskDigest,
    marketRiskPolicyDigest,
    marketRiskValidUntil,
    requestId: bytes32(input.requestId, "requestId"),
    solverId: address(input.solverId, "solverId"),
    offer: Object.freeze({
      direction: input.offer.direction,
      capabilityDigest,
      bitAmountWei: uint(input.offer.bitAmountWei, "offer.bitAmountWei", { maximum: (1n << 256n) - 1n }),
      lightningAmountSats,
      maxRoutingFeeSats,
      capacityEpoch: integer(input.offer.capacityEpoch, "offer.capacityEpoch"),
      expiresAt: offerExpiresAt,
      solverSigned: true,
    }),
    policy: normalizeAdmissionPolicy(input.policy),
    now,
  });
}

function normalizeFirmOfferExecution(input) {
  exactKeys(
    input,
    ["executableOfferDigest", "finalizedAt", "offerId", "privateRequestDigest"],
    "firm offer execution binding",
  );
  const privateRequestDigest = bytes32(input.privateRequestDigest, "privateRequestDigest");
  const executableOfferDigest = bytes32(input.executableOfferDigest, "executableOfferDigest");
  if (privateRequestDigest === `0x${"0".repeat(64)}`
      || executableOfferDigest === `0x${"0".repeat(64)}`) {
    throw new RangeError("firm offer execution digests must be non-zero");
  }
  return Object.freeze({
    offerId: bytes32(input.offerId, "offerId"),
    privateRequestDigest,
    executableOfferDigest,
    finalizedAt: integer(input.finalizedAt, "finalizedAt"),
  });
}

function normalizeFirmOfferUserAuthorization(input) {
  exactKeys(
    input,
    [
      "authorizationExpiresAt", "authorizedAt", "executionAuthorizationDigest",
      "executionBindingDigest", "offerId",
    ],
    "firm offer user authorization",
  );
  const executionBindingDigest = bytes32(input.executionBindingDigest, "executionBindingDigest");
  const executionAuthorizationDigest = bytes32(
    input.executionAuthorizationDigest,
    "executionAuthorizationDigest",
  );
  if (executionBindingDigest === `0x${"0".repeat(64)}`
      || executionAuthorizationDigest === `0x${"0".repeat(64)}`) {
    throw new RangeError("firm offer user-authorization digests must be non-zero");
  }
  return Object.freeze({
    offerId: bytes32(input.offerId, "offerId"),
    executionBindingDigest,
    executionAuthorizationDigest,
    authorizationExpiresAt: integer(input.authorizationExpiresAt, "authorizationExpiresAt"),
    authorizedAt: integer(input.authorizedAt, "authorizedAt"),
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
    selectionAuthorizationDigest: row.selection_authorization_digest,
    selectionAuthorizationExpiresAt: row.selection_authorization_expires_at,
    marketRiskDigest: row.market_risk_digest,
    marketRiskPolicyDigest: row.market_risk_policy_digest,
    marketRiskValidUntil: row.market_risk_valid_until,
    requestId: row.request_id,
    solverId: row.solver_id,
    capabilityDigest: row.capability_digest,
    direction: row.direction,
    amount: row.amount,
    bitAmountWei: row.bit_amount_wei,
    lightningAmountSats: row.lightning_amount_sats,
    privateRequestDigest: row.private_request_digest,
    executableOfferDigest: row.executable_offer_digest,
    executionBindingDigest: row.execution_binding_digest,
    executionAuthorizationDigest: row.execution_authorization_digest,
    executionAuthorizationExpiresAt: row.execution_authorization_expires_at,
    finalizedAt: row.finalized_at,
    authorizedAt: row.authorized_at,
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
    releaseRecordDigest: row.release_record_digest,
    riskPolicyDigest: row.risk_policy_digest,
    evidencePolicyDigest: row.evidence_policy_digest,
    solverCapabilityDigest: row.solver_capability_digest,
    executionPolicyBindingDigest: row.execution_policy_binding_digest,
    executionPolicyBoundAt: row.execution_policy_bound_at,
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

const verifiedCoordinatorStores = new WeakSet();
const COORDINATOR_STORE_CONSTRUCTOR_TOKEN = Symbol("TreeSwap coordinator store constructor");

export function isVerifiedCoordinatorStore(store) {
  return verifiedCoordinatorStores.has(store);
}

export class CoordinatorStore {
  #db;
  #path;
  #backupInProgress = false;

  constructor(database, path, constructorToken) {
    if (constructorToken !== COORDINATOR_STORE_CONSTRUCTOR_TOKEN) {
      throw new TypeError("coordinator stores must be opened through CoordinatorStore.open");
    }
    this.#db = database;
    this.#path = path;
    verifiedCoordinatorStores.add(this);
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
        if (![
          COORDINATOR_SCHEMA,
          "treeswap.coordinator.v1",
          "treeswap.coordinator.v2",
          "treeswap.coordinator.v3",
          "treeswap.coordinator.v4",
          "treeswap.coordinator.v5",
          "treeswap.coordinator.v6",
          "treeswap.coordinator.v7",
          "treeswap.coordinator.v8",
        ].includes(existingSchemaValue)) {
          throw new Error("coordinator database schema is unsupported");
        }
      }
      database.exec(COORDINATOR_SCHEMA_SQL);
      if (existingSchemaValue && existingSchemaValue !== COORDINATOR_SCHEMA) {
        const activeLegacyOffers = Number(database.prepare(
          "SELECT COUNT(*) AS count FROM firm_offer_commitments WHERE state = 'ACTIVE'",
        ).get().count);
        if (activeLegacyOffers !== 0) {
          throw new Error("legacy coordinator schema has active firm offers and cannot migrate safely");
        }
        const openLegacySettlements = Number(database.prepare(
          "SELECT COUNT(*) AS count FROM settlements WHERE terminal_state IS NULL",
        ).get().count);
        if (openLegacySettlements !== 0) {
          throw new Error("legacy coordinator schema has nonterminal settlements and cannot migrate safely");
        }
      }
      const solverCapacityColumns = database.prepare("PRAGMA table_info(solver_capacity)").all();
      if (!solverCapacityColumns.some((column) => column.name === "capability_expires_at")) {
        database.exec("ALTER TABLE solver_capacity ADD COLUMN capability_expires_at INTEGER NOT NULL DEFAULT 0");
      }
      const firmOfferColumns = database.prepare("PRAGMA table_info(firm_offer_commitments)").all();
      if (!firmOfferColumns.some((column) => column.name === "bit_amount_wei")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN bit_amount_wei TEXT NOT NULL DEFAULT '0'");
      }
      if (!firmOfferColumns.some((column) => column.name === "lightning_amount_sats")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN lightning_amount_sats TEXT NOT NULL DEFAULT '0'");
      }
      if (!firmOfferColumns.some((column) => column.name === "private_request_digest")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN private_request_digest TEXT");
      }
      if (!firmOfferColumns.some((column) => column.name === "executable_offer_digest")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN executable_offer_digest TEXT");
      }
      if (!firmOfferColumns.some((column) => column.name === "execution_binding_digest")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN execution_binding_digest TEXT");
      }
      if (!firmOfferColumns.some((column) => column.name === "finalized_at")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN finalized_at INTEGER");
      }
      if (!firmOfferColumns.some((column) => column.name === "selection_authorization_digest")) {
        database.exec(`ALTER TABLE firm_offer_commitments ADD COLUMN selection_authorization_digest TEXT NOT NULL DEFAULT '0x${"0".repeat(64)}'`);
      }
      if (!firmOfferColumns.some((column) => column.name === "selection_authorization_expires_at")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN selection_authorization_expires_at INTEGER NOT NULL DEFAULT 0");
      }
      if (!firmOfferColumns.some((column) => column.name === "execution_authorization_digest")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN execution_authorization_digest TEXT");
      }
      if (!firmOfferColumns.some((column) => column.name === "execution_authorization_expires_at")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN execution_authorization_expires_at INTEGER");
      }
      if (!firmOfferColumns.some((column) => column.name === "authorized_at")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN authorized_at INTEGER");
      }
      if (!firmOfferColumns.some((column) => column.name === "capability_digest")) {
        database.exec(`ALTER TABLE firm_offer_commitments ADD COLUMN capability_digest TEXT NOT NULL DEFAULT '0x${"0".repeat(64)}'`);
      }
      if (!firmOfferColumns.some((column) => column.name === "market_risk_digest")) {
        database.exec(`ALTER TABLE firm_offer_commitments ADD COLUMN market_risk_digest TEXT NOT NULL DEFAULT '0x${"0".repeat(64)}'`);
      }
      if (!firmOfferColumns.some((column) => column.name === "market_risk_policy_digest")) {
        database.exec(`ALTER TABLE firm_offer_commitments ADD COLUMN market_risk_policy_digest TEXT NOT NULL DEFAULT '0x${"0".repeat(64)}'`);
      }
      if (!firmOfferColumns.some((column) => column.name === "market_risk_valid_until")) {
        database.exec("ALTER TABLE firm_offer_commitments ADD COLUMN market_risk_valid_until INTEGER NOT NULL DEFAULT 0");
      }
      const settlementColumns = database.prepare("PRAGMA table_info(settlements)").all();
      if (!settlementColumns.some((column) => column.name === "release_record_digest")) {
        database.exec("ALTER TABLE settlements ADD COLUMN release_record_digest TEXT");
      }
      if (!settlementColumns.some((column) => column.name === "risk_policy_digest")) {
        database.exec("ALTER TABLE settlements ADD COLUMN risk_policy_digest TEXT");
      }
      if (!settlementColumns.some((column) => column.name === "evidence_policy_digest")) {
        database.exec("ALTER TABLE settlements ADD COLUMN evidence_policy_digest TEXT");
      }
      if (!settlementColumns.some((column) => column.name === "solver_capability_digest")) {
        database.exec("ALTER TABLE settlements ADD COLUMN solver_capability_digest TEXT");
      }
      if (!settlementColumns.some((column) => column.name === "execution_policy_binding_digest")) {
        database.exec("ALTER TABLE settlements ADD COLUMN execution_policy_binding_digest TEXT");
      }
      if (!settlementColumns.some((column) => column.name === "execution_policy_bound_at")) {
        database.exec("ALTER TABLE settlements ADD COLUMN execution_policy_bound_at INTEGER");
      }
      if (existingSchemaValue && existingSchemaValue !== COORDINATOR_SCHEMA) {
        database.exec(`
          UPDATE firm_offer_commitments
          SET bit_amount_wei = CASE WHEN direction = 'lightning-to-bit' THEN amount ELSE '0' END,
              lightning_amount_sats = CASE WHEN direction = 'bit-to-lightning' THEN amount ELSE '0' END
        `);
      }
      database.prepare("INSERT OR IGNORE INTO coordinator_meta(key, value) VALUES ('schema', ?)").run(COORDINATOR_SCHEMA);
      const schema = database.prepare("SELECT value FROM coordinator_meta WHERE key = 'schema'").get();
      if ([
        "treeswap.coordinator.v1",
        "treeswap.coordinator.v2",
        "treeswap.coordinator.v3",
        "treeswap.coordinator.v4",
        "treeswap.coordinator.v5",
        "treeswap.coordinator.v6",
        "treeswap.coordinator.v7",
        "treeswap.coordinator.v8",
      ].includes(schema?.value)) {
        database.prepare("UPDATE coordinator_meta SET value = ? WHERE key = 'schema'").run(COORDINATOR_SCHEMA);
      } else if (schema?.value !== COORDINATOR_SCHEMA) {
        throw new Error("coordinator database schema is unsupported");
      }
      verifyDatabase(database, { full: false, requireSchema: true });
      if (path !== ":memory:") await chmod(path, 0o600);
      return new CoordinatorStore(database, path, COORDINATOR_STORE_CONSTRUCTOR_TOKEN);
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

  static async inspectVerifiedBackupReleaseLiabilities(path) {
    await regularFile(path, "coordinator backup");
    inspectReadOnlyDatabase(path, { full: true });
    const database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: 5_000,
    });
    try {
      database.exec("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
      return releaseLiabilitySnapshotForDatabase(database);
    } finally {
      database.close();
    }
  }

  static async inspectServiceRunStatus(path) {
    await regularFile(path, "coordinator database");
    const database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: 5_000,
    });
    const store = new CoordinatorStore(database, path, COORDINATOR_STORE_CONSTRUCTOR_TOKEN);
    try {
      database.exec("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
      verifyDatabase(database, { full: false, requireSchema: true });
      return store.serviceRunStatus();
    } finally {
      store.close();
    }
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

  #readServiceRunState() {
    const rows = this.#db.prepare(`
      SELECT key, value FROM coordinator_meta WHERE key LIKE 'service_run_%' ORDER BY key
    `).all();
    if (rows.length === 0) return null;
    const values = new Map(rows.map(({ key, value }) => [key, value]));
    const requiredKeys = Object.values(SERVICE_RUN_META_KEYS);
    if (values.size !== requiredKeys.length || requiredKeys.some((key) => !values.has(key))) {
      throw new Error("coordinator service run journal is incomplete");
    }
    if (values.get(SERVICE_RUN_META_KEYS.schema) !== COORDINATOR_SERVICE_RUN_SCHEMA) {
      throw new Error("coordinator service run journal schema is unsupported");
    }
    const mode = values.get(SERVICE_RUN_META_KEYS.mode);
    const state = values.get(SERVICE_RUN_META_KEYS.state);
    const outcome = values.get(SERVICE_RUN_META_KEYS.outcome) || null;
    const runDigest = bytes32(values.get(SERVICE_RUN_META_KEYS.runDigest), "service run digest");
    if (mode !== ACTIVE_SERVICE_MODE || !["RUNNING", "STOPPED", "FAILED", "BLOCKED"].includes(state)) {
      throw new Error("coordinator service run journal identity is invalid");
    }
    if (outcome !== null && !SERVICE_RUN_REASONS.has(outcome)
        && outcome !== "abrupt-exit" && outcome !== "crash-loop-open") {
      throw new Error("coordinator service run outcome is invalid");
    }
    const startedAt = parseStoredInteger(
      values.get(SERVICE_RUN_META_KEYS.startedAt),
      "coordinator service run start",
    );
    const updatedAt = parseStoredInteger(
      values.get(SERVICE_RUN_META_KEYS.updatedAt),
      "coordinator service run update",
    );
    const lastStatusAt = parseStoredInteger(
      values.get(SERVICE_RUN_META_KEYS.lastStatusAt),
      "coordinator service run last status time",
      { nullable: true },
    );
    const lastStatusDigest = values.get(SERVICE_RUN_META_KEYS.lastStatusDigest) || null;
    if (lastStatusDigest !== null) bytes32(lastStatusDigest, "coordinator service run last status digest");
    const lastStatusPhase = values.get(SERVICE_RUN_META_KEYS.lastStatusPhase) || null;
    if (lastStatusPhase !== null
        && (!/^[a-z][a-z0-9-]{0,79}$/.test(lastStatusPhase))) {
      throw new Error("coordinator service run last status phase is invalid");
    }
    const lastStatusHealthy = parseStoredBoolean(
      values.get(SERVICE_RUN_META_KEYS.lastStatusHealthy),
      "coordinator service run last status health",
      { nullable: true },
    );
    if ((lastStatusAt === null) !== (lastStatusDigest === null)
        || (lastStatusAt === null) !== (lastStatusPhase === null)
        || (lastStatusAt === null) !== (lastStatusHealthy === null)) {
      throw new Error("coordinator service run status journal is inconsistent");
    }
    const failureWindowSeconds = parseStoredInteger(
      values.get(SERVICE_RUN_META_KEYS.failureWindowSeconds),
      "coordinator service run failure window",
    );
    const maximumFailures = parseStoredInteger(
      values.get(SERVICE_RUN_META_KEYS.maximumFailures),
      "coordinator service run maximum failures",
    );
    boundedInteger(failureWindowSeconds, 60, 3_600, "coordinator service run failure window");
    boundedInteger(maximumFailures, 1, 10, "coordinator service run maximum failures");
    const failureWindowStartedAt = parseStoredInteger(
      values.get(SERVICE_RUN_META_KEYS.failureWindowStartedAt),
      "coordinator service run failure-window start",
      { nullable: true },
    );
    const failureCount = parseStoredInteger(
      values.get(SERVICE_RUN_META_KEYS.failureCount),
      "coordinator service run failure count",
    );
    const lastFailureAt = parseStoredInteger(
      values.get(SERVICE_RUN_META_KEYS.lastFailureAt),
      "coordinator service run last failure time",
      { nullable: true },
    );
    const lastFailureReason = values.get(SERVICE_RUN_META_KEYS.lastFailureReason) || null;
    if (lastFailureReason !== null && !FAILURE_REASONS.has(lastFailureReason)) {
      throw new Error("coordinator service run last failure reason is invalid");
    }
    if ((failureCount === 0) !== (failureWindowStartedAt === null)
        || (failureCount === 0) !== (lastFailureAt === null)
        || (failureCount === 0) !== (lastFailureReason === null)
        || failureCount > maximumFailures) {
      throw new Error("coordinator service run failure journal is inconsistent");
    }
    if (updatedAt < startedAt || (lastStatusAt !== null
        && (lastStatusAt < startedAt || lastStatusAt > updatedAt))
        || (failureWindowStartedAt !== null
          && (lastFailureAt < failureWindowStartedAt || lastFailureAt > updatedAt))) {
      throw new Error("coordinator service run journal time ordering is invalid");
    }
    const cleanOutcome = outcome === "requested" || outcome === "aborted";
    const failedOutcome = outcome === "startup-failure" || outcome === "background-failure";
    if ((state === "RUNNING" && (outcome !== null || failureCount >= maximumFailures))
        || (state === "STOPPED" && !cleanOutcome)
        || (state === "FAILED"
          && (!failedOutcome || failureCount === 0 || lastFailureReason !== outcome))
        || (state === "BLOCKED"
          && (outcome !== "crash-loop-open" || failureCount < maximumFailures
            || lastStatusAt !== null))) {
      throw new Error("coordinator service run lifecycle journal is inconsistent");
    }
    return Object.freeze({
      schema: COORDINATOR_SERVICE_RUN_SCHEMA,
      runDigest,
      mode,
      state,
      startedAt,
      updatedAt,
      outcome,
      lastStatusAt,
      lastStatusDigest,
      lastStatusPhase,
      lastStatusHealthy,
      failureWindowSeconds,
      maximumFailures,
      failureWindowStartedAt,
      failureCount,
      lastFailureAt,
      lastFailureReason,
    });
  }

  #writeServiceRunState(state) {
    const values = {
      [SERVICE_RUN_META_KEYS.schema]: COORDINATOR_SERVICE_RUN_SCHEMA,
      [SERVICE_RUN_META_KEYS.runDigest]: state.runDigest,
      [SERVICE_RUN_META_KEYS.mode]: state.mode,
      [SERVICE_RUN_META_KEYS.state]: state.state,
      [SERVICE_RUN_META_KEYS.startedAt]: String(state.startedAt),
      [SERVICE_RUN_META_KEYS.updatedAt]: String(state.updatedAt),
      [SERVICE_RUN_META_KEYS.outcome]: state.outcome ?? "",
      [SERVICE_RUN_META_KEYS.lastStatusAt]: state.lastStatusAt === null ? "" : String(state.lastStatusAt),
      [SERVICE_RUN_META_KEYS.lastStatusDigest]: state.lastStatusDigest ?? "",
      [SERVICE_RUN_META_KEYS.lastStatusPhase]: state.lastStatusPhase ?? "",
      [SERVICE_RUN_META_KEYS.lastStatusHealthy]: state.lastStatusHealthy === null
        ? "" : state.lastStatusHealthy ? "1" : "0",
      [SERVICE_RUN_META_KEYS.failureWindowSeconds]: String(state.failureWindowSeconds),
      [SERVICE_RUN_META_KEYS.maximumFailures]: String(state.maximumFailures),
      [SERVICE_RUN_META_KEYS.failureWindowStartedAt]: state.failureWindowStartedAt === null
        ? "" : String(state.failureWindowStartedAt),
      [SERVICE_RUN_META_KEYS.failureCount]: String(state.failureCount),
      [SERVICE_RUN_META_KEYS.lastFailureAt]: state.lastFailureAt === null ? "" : String(state.lastFailureAt),
      [SERVICE_RUN_META_KEYS.lastFailureReason]: state.lastFailureReason ?? "",
    };
    const statement = this.#db.prepare(`
      INSERT INTO coordinator_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const key of Object.values(SERVICE_RUN_META_KEYS)) statement.run(key, values[key]);
  }

  #serviceRunSummary(state = this.#readServiceRunState()) {
    if (state === null) {
      return Object.freeze({
        schema: COORDINATOR_SERVICE_RUN_SCHEMA,
        state: "NEVER_STARTED",
        mode: null,
        runDigest: null,
        startedAt: null,
        updatedAt: null,
        outcome: null,
        lastStatusAt: null,
        lastStatusDigest: null,
        lastStatusPhase: null,
        lastStatusHealthy: null,
        failureWindowSeconds: null,
        maximumFailures: null,
        failureWindowStartedAt: null,
        failureCount: 0,
        lastFailureAt: null,
        lastFailureReason: null,
        crashLoopOpen: false,
        fundingAuthorization: false,
      });
    }
    return Object.freeze({
      schema: state.schema,
      state: state.state,
      mode: state.mode,
      runDigest: state.runDigest,
      startedAt: wholeSecondIso(state.startedAt),
      updatedAt: wholeSecondIso(state.updatedAt),
      outcome: state.outcome,
      lastStatusAt: state.lastStatusAt === null ? null : wholeSecondIso(state.lastStatusAt),
      lastStatusDigest: state.lastStatusDigest,
      lastStatusPhase: state.lastStatusPhase,
      lastStatusHealthy: state.lastStatusHealthy,
      failureWindowSeconds: state.failureWindowSeconds,
      maximumFailures: state.maximumFailures,
      failureWindowStartedAt: state.failureWindowStartedAt === null
        ? null : wholeSecondIso(state.failureWindowStartedAt),
      failureCount: state.failureCount,
      lastFailureAt: state.lastFailureAt === null ? null : wholeSecondIso(state.lastFailureAt),
      lastFailureReason: state.lastFailureReason,
      crashLoopOpen: state.state === "BLOCKED" || state.failureCount >= state.maximumFailures,
      fundingAuthorization: false,
    });
  }

  beginServiceRun(input) {
    exactKeys(input, [
      "failureWindowSeconds", "maximumFailures", "mode", "startedAt",
    ], "coordinator service run start");
    if (input.mode !== ACTIVE_SERVICE_MODE) {
      throw new Error("coordinator service run mode is unsupported");
    }
    if (activeCoordinatorServiceRuns.has(this)) {
      throw new Error("coordinator store already has a live service run");
    }
    const startedAt = integer(input.startedAt, "coordinator service run startedAt");
    const failureWindowSeconds = boundedInteger(
      input.failureWindowSeconds,
      60,
      3_600,
      "coordinator service failure window",
    );
    const maximumFailures = boundedInteger(
      input.maximumFailures,
      1,
      10,
      "coordinator service maximum failures",
    );
    const runDigest = digest({
      schema: COORDINATOR_SERVICE_RUN_HANDLE_SCHEMA,
      mode: input.mode,
      startedAt,
      nonce: randomUUID(),
    });
    const handle = Object.freeze({
      schema: COORDINATOR_SERVICE_RUN_HANDLE_SCHEMA,
      runDigest,
    });
    const state = this.#transaction(() => {
      const previous = this.#readServiceRunState();
      if (previous && (previous.updatedAt > startedAt || previous.startedAt > startedAt)) {
        throw new Error("coordinator service run clock moved backwards");
      }
      let failureCount = previous?.failureCount ?? 0;
      let failureWindowStartedAt = previous?.failureWindowStartedAt ?? null;
      let lastFailureAt = previous?.lastFailureAt ?? null;
      let lastFailureReason = previous?.lastFailureReason ?? null;
      const previousWindowExpired = failureWindowStartedAt !== null
        && startedAt - failureWindowStartedAt >= (previous?.failureWindowSeconds ?? failureWindowSeconds);
      if (previousWindowExpired) {
        failureCount = 0;
        failureWindowStartedAt = null;
        lastFailureAt = null;
        lastFailureReason = null;
      } else if (previous && (failureCount > 0 || previous.state === "RUNNING")
          && (previous.failureWindowSeconds !== failureWindowSeconds
            || previous.maximumFailures !== maximumFailures)) {
        throw new Error("coordinator service crash policy changed while failures are retained");
      }
      if (previous?.state === "RUNNING") {
        if (failureWindowStartedAt === null) failureWindowStartedAt = startedAt;
        failureCount += 1;
        lastFailureAt = startedAt;
        lastFailureReason = "abrupt-exit";
      }
      if (failureCount >= maximumFailures) {
        const blocked = Object.freeze({
          schema: COORDINATOR_SERVICE_RUN_SCHEMA,
          runDigest,
          mode: input.mode,
          state: "BLOCKED",
          startedAt,
          updatedAt: startedAt,
          outcome: "crash-loop-open",
          lastStatusAt: null,
          lastStatusDigest: null,
          lastStatusPhase: null,
          lastStatusHealthy: null,
          failureWindowSeconds,
          maximumFailures,
          failureWindowStartedAt,
          failureCount,
          lastFailureAt,
          lastFailureReason,
        });
        this.#writeServiceRunState(blocked);
        return blocked;
      }
      const running = Object.freeze({
        schema: COORDINATOR_SERVICE_RUN_SCHEMA,
        runDigest,
        mode: input.mode,
        state: "RUNNING",
        startedAt,
        updatedAt: startedAt,
        outcome: null,
        lastStatusAt: null,
        lastStatusDigest: null,
        lastStatusPhase: null,
        lastStatusHealthy: null,
        failureWindowSeconds,
        maximumFailures,
        failureWindowStartedAt,
        failureCount,
        lastFailureAt,
        lastFailureReason,
      });
      this.#writeServiceRunState(running);
      return running;
    });
    if (state.state === "BLOCKED") {
      throw new Error("coordinator active service crash-loop breaker is open");
    }
    coordinatorServiceRunHandles.set(handle, { active: true, runDigest, store: this });
    activeCoordinatorServiceRuns.set(this, handle);
    return Object.freeze({ handle, status: this.#serviceRunSummary(state) });
  }

  recordServiceRunStatus(input) {
    exactKeys(input, ["handle", "observedAt", "status"], "coordinator service run status record");
    const context = coordinatorServiceRunHandles.get(input.handle);
    if (!context || context.store !== this || context.active !== true
        || activeCoordinatorServiceRuns.get(this) !== input.handle) {
      throw new TypeError("coordinator service run handle lacks same-process provenance");
    }
    const observedAt = integer(input.observedAt, "coordinator service run status observedAt");
    const state = this.#transaction(() => {
      const current = this.#readServiceRunState();
      if (!current || current.state !== "RUNNING" || current.runDigest !== context.runDigest) {
        throw new Error("coordinator service run is no longer current");
      }
      if (observedAt < current.startedAt
          || (current.lastStatusAt !== null && observedAt < current.lastStatusAt)) {
        throw new Error("coordinator service run status clock moved backwards");
      }
      const status = serviceStatusSummary(input.status, observedAt, current.startedAt);
      const updated = Object.freeze({
        ...current,
        updatedAt: observedAt,
        lastStatusAt: observedAt,
        lastStatusDigest: status.statusDigest,
        lastStatusPhase: status.phase,
        lastStatusHealthy: status.healthy,
      });
      this.#writeServiceRunState(updated);
      return updated;
    });
    return this.#serviceRunSummary(state);
  }

  finishServiceRun(input) {
    exactKeys(input, ["finishedAt", "handle", "reason"], "coordinator service run finish");
    const context = coordinatorServiceRunHandles.get(input.handle);
    if (!context || context.store !== this || context.active !== true
        || activeCoordinatorServiceRuns.get(this) !== input.handle) {
      throw new TypeError("coordinator service run handle lacks same-process provenance");
    }
    const finishedAt = integer(input.finishedAt, "coordinator service run finishedAt");
    const reason = String(input.reason ?? "");
    if (!SERVICE_RUN_REASONS.has(reason)) throw new TypeError("coordinator service run reason is invalid");
    const state = this.#transaction(() => {
      const current = this.#readServiceRunState();
      if (!current || current.state !== "RUNNING" || current.runDigest !== context.runDigest) {
        throw new Error("coordinator service run is no longer current");
      }
      if (finishedAt < current.updatedAt || finishedAt < current.startedAt) {
        throw new Error("coordinator service run finish clock moved backwards");
      }
      let failureCount = current.failureCount;
      let failureWindowStartedAt = current.failureWindowStartedAt;
      let lastFailureAt = current.lastFailureAt;
      let lastFailureReason = current.lastFailureReason;
      const failed = FAILURE_REASONS.has(reason);
      if (failed) {
        if (failureWindowStartedAt === null
            || finishedAt - failureWindowStartedAt >= current.failureWindowSeconds) {
          failureWindowStartedAt = finishedAt;
          failureCount = 0;
        }
        failureCount += 1;
        lastFailureAt = finishedAt;
        lastFailureReason = reason;
      } else if (failureWindowStartedAt !== null
          && finishedAt - failureWindowStartedAt >= current.failureWindowSeconds) {
        failureCount = 0;
        failureWindowStartedAt = null;
        lastFailureAt = null;
        lastFailureReason = null;
      }
      const finished = Object.freeze({
        ...current,
        state: failed ? "FAILED" : "STOPPED",
        updatedAt: finishedAt,
        outcome: reason,
        failureCount,
        failureWindowStartedAt,
        lastFailureAt,
        lastFailureReason,
      });
      this.#writeServiceRunState(finished);
      return finished;
    });
    context.active = false;
    activeCoordinatorServiceRuns.delete(this);
    return this.#serviceRunSummary(state);
  }

  serviceRunStatus() {
    return this.#serviceRunSummary();
  }

  #bindAdmissionPolicy(policy) {
    const policyDigest = digest(policy);
    const existing = this.#db.prepare(
      "SELECT value FROM coordinator_meta WHERE key = 'admission_policy_digest'",
    ).get();
    if (!existing) {
      this.#db.prepare(
        "INSERT INTO coordinator_meta(key, value) VALUES ('admission_policy_digest', ?)",
      ).run(policyDigest);
      return policyDigest;
    }
    if (existing.value !== policyDigest) {
      throw new Error("admission policy changed after the coordinator policy was bound");
    }
    return policyDigest;
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

  listNonterminalSettlements() {
    return Object.freeze(this.#db.prepare(`
      SELECT * FROM settlements WHERE terminal_state IS NULL ORDER BY settlement_id
    `).all().map(asSettlement));
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
    const normalizedSolverId = address(solverId, "solverId");
    const capacity = asSolverCapacity(this.#db.prepare("SELECT * FROM solver_capacity WHERE solver_id = ?")
      .get(normalizedSolverId));
    if (!capacity) return null;
    const active = this.#db.prepare(`
      SELECT bit_amount_wei, lightning_amount_sats
      FROM firm_offer_commitments WHERE solver_id = ? AND state = 'ACTIVE'
    `).all(normalizedSolverId);
    const committed = active.reduce((total, row) => Object.freeze({
      bit: total.bit + BigInt(row.bit_amount_wei),
      lightning: total.lightning + BigInt(row.lightning_amount_sats),
    }), Object.freeze({ bit: 0n, lightning: 0n }));
    if (active.length !== capacity.activeFirmQuotes
        || committed.bit.toString() !== capacity.committedBitWei
        || committed.lightning.toString() !== capacity.committedLightningSats) {
      throw new Error("solver commitment accounting diverged from the active firm-offer ledger");
    }
    return capacity;
  }

  #solverDirectionHistory(solverId, direction) {
    const summary = this.#db.prepare(`
      SELECT
        CAST(COUNT(CASE WHEN state = 'FILLED' THEN 1 END) AS TEXT) AS successful_fills,
        CAST(COUNT(CASE WHEN state = 'SOLVER_FAILED' THEN 1 END) AS TEXT) AS attributable_failures,
        MAX(CASE WHEN state = 'FILLED' THEN resolved_at END) AS latest_success_at
      FROM firm_offer_commitments
      WHERE solver_id = ? AND direction = ?
    `).get(solverId, direction);
    const consecutiveFailures = Number(this.#db.prepare(`
      SELECT COUNT(*) AS count
      FROM firm_offer_commitments
      WHERE solver_id = ? AND direction = ? AND state = 'SOLVER_FAILED'
        AND (? IS NULL OR resolved_at >= ?)
    `).get(solverId, direction, summary.latest_success_at, summary.latest_success_at).count);
    return Object.freeze({
      successfulFills: summary.successful_fills,
      attributableFailures: summary.attributable_failures,
      consecutiveFailures,
    });
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
        bitAmountWei: BigInt(row.bit_amount_wei),
        lightningAmountSats: BigInt(row.lightning_amount_sats),
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
      this.#bindAdmissionPolicy(policy);
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
    const bitAmountWei = value.offer.direction === "lightning-to-bit" ? value.offer.bitAmountWei : "0";
    const lightningAmountSats = value.offer.direction === "bit-to-lightning"
      ? String(BigInt(value.offer.lightningAmountSats) + BigInt(value.offer.maxRoutingFeeSats))
      : value.offer.lightningAmountSats;
    const amount = value.offer.direction === "lightning-to-bit" ? bitAmountWei : lightningAmountSats;
    const recordTerms = Object.freeze({
      offerId: value.offerId,
      offerDigest: value.offerDigest,
      selectionAuthorizationDigest: value.selectionAuthorizationDigest,
      selectionAuthorizationExpiresAt: value.selectionAuthorizationExpiresAt,
      marketRiskDigest: value.marketRiskDigest,
      marketRiskPolicyDigest: value.marketRiskPolicyDigest,
      marketRiskValidUntil: value.marketRiskValidUntil,
      requestId: value.requestId,
      solverId: value.solverId,
      capabilityDigest: value.offer.capabilityDigest,
      direction: value.offer.direction,
      amount,
      bitAmountWei,
      lightningAmountSats,
      capacityEpoch: value.offer.capacityEpoch,
      expiresAt: value.offer.expiresAt,
    });
    const recordDigest = digest(recordTerms);
    return this.#transaction(() => {
      this.#bindAdmissionPolicy(value.policy);
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
      if (solver.capabilityDigest !== value.offer.capabilityDigest) {
        throw new Error("firm offer capability does not match the current verified solver capability");
      }
      const directionHistory = this.#solverDirectionHistory(value.solverId, value.offer.direction);
      const assessment = assessFirmOffer({
        offer: value.offer,
        solver: Object.freeze({ ...solver, ...directionHistory }),
        policy: value.policy,
        now: value.now,
      });
      if (!assessment.allowed) throw new Error(`firm offer admission rejected: ${assessment.reasons.join("; ")}`);
      if (value.offer.direction === "bit-to-lightning") {
        const globalCommitted = this.#db.prepare(`
          SELECT lightning_amount_sats FROM firm_offer_commitments
          WHERE direction = 'bit-to-lightning' AND state = 'ACTIVE'
        `).all().reduce((total, row) => total + BigInt(row.lightning_amount_sats), 0n);
        if (globalCommitted + BigInt(lightningAmountSats) > BigInt(value.policy.maxGlobalBitToLightningInFlightSats)) {
          throw new Error("global BIT-to-Lightning in-flight cap exceeded");
        }
      }
      const next = applyFirmOfferReservation({ solver, assessment });
      try {
        this.#db.prepare(`
          INSERT INTO firm_offer_commitments(
            offer_id, offer_digest, selection_authorization_digest, selection_authorization_expires_at,
            market_risk_digest, market_risk_policy_digest, market_risk_valid_until,
            request_id, solver_id, capability_digest, direction, amount, bit_amount_wei, lightning_amount_sats,
            capacity_epoch, expires_at, record_digest, state, reserved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
        `).run(
          value.offerId, value.offerDigest, value.selectionAuthorizationDigest,
          value.selectionAuthorizationExpiresAt, value.marketRiskDigest, value.marketRiskPolicyDigest,
          value.marketRiskValidUntil,
          value.requestId, value.solverId, value.offer.capabilityDigest,
          value.offer.direction, String(amount), String(bitAmountWei), String(lightningAmountSats),
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

  bindFirmOfferExecution(input) {
    const value = normalizeFirmOfferExecution(input);
    const bindingTerms = Object.freeze({
      offerId: value.offerId,
      privateRequestDigest: value.privateRequestDigest,
      executableOfferDigest: value.executableOfferDigest,
    });
    const executionBindingDigest = digest(bindingTerms);
    return this.#transaction(() => {
      const current = this.getFirmOffer(value.offerId);
      if (!current) throw new Error("firm offer does not exist");
      if (current.state !== "ACTIVE" || current.expiresAt <= value.finalizedAt) {
        throw new Error("only an active unexpired firm offer can bind an executable quote");
      }
      if (value.finalizedAt < current.reservedAt) {
        throw new Error("executable quote binding predates the firm reservation");
      }
      const request = this.getRfqRequest(current.requestId);
      if (!request || request.state !== "ACTIVE" || request.expiresAt <= value.finalizedAt) {
        throw new Error("executable quote requires an active unexpired RFQ");
      }
      if (current.executionBindingDigest) {
        if (current.executionBindingDigest !== executionBindingDigest
            || current.privateRequestDigest !== value.privateRequestDigest
            || current.executableOfferDigest !== value.executableOfferDigest) {
          throw new Error("firm offer is already bound to another executable quote");
        }
        return current;
      }
      this.#db.prepare(`
        UPDATE firm_offer_commitments
        SET private_request_digest = ?, executable_offer_digest = ?, execution_binding_digest = ?, finalized_at = ?
        WHERE offer_id = ? AND state = 'ACTIVE' AND execution_binding_digest IS NULL
      `).run(
        value.privateRequestDigest,
        value.executableOfferDigest,
        executionBindingDigest,
        value.finalizedAt,
        value.offerId,
      );
      const bound = this.getFirmOffer(value.offerId);
      if (!bound || bound.executionBindingDigest !== executionBindingDigest) {
        throw new Error("firm offer executable binding was not persisted atomically");
      }
      return bound;
    });
  }

  bindFirmOfferUserAuthorization(input) {
    const value = normalizeFirmOfferUserAuthorization(input);
    return this.#transaction(() => {
      const current = this.getFirmOffer(value.offerId);
      if (!current) throw new Error("firm offer does not exist");
      if (current.state !== "ACTIVE" || current.expiresAt <= value.authorizedAt) {
        throw new Error("only an active unexpired firm offer can bind user authorization");
      }
      if (!current.executionBindingDigest || current.executionBindingDigest !== value.executionBindingDigest) {
        throw new Error("user authorization does not match the executable quote binding");
      }
      if (current.finalizedAt > value.authorizedAt) {
        throw new Error("user authorization predates executable quote finalization");
      }
      if (value.authorizationExpiresAt <= value.authorizedAt
          || value.authorizationExpiresAt > current.selectionAuthorizationExpiresAt) {
        throw new Error("user authorization is expired or outlives the selected quote authorization");
      }
      if (current.executionAuthorizationDigest) {
        if (current.executionAuthorizationDigest !== value.executionAuthorizationDigest
            || current.executionAuthorizationExpiresAt !== value.authorizationExpiresAt
            || current.authorizedAt !== value.authorizedAt) {
          throw new Error("firm offer is already bound to another user authorization");
        }
        return current;
      }
      this.#db.prepare(`
        UPDATE firm_offer_commitments
        SET execution_authorization_digest = ?, execution_authorization_expires_at = ?, authorized_at = ?
        WHERE offer_id = ? AND state = 'ACTIVE' AND execution_authorization_digest IS NULL
      `).run(
        value.executionAuthorizationDigest,
        value.authorizationExpiresAt,
        value.authorizedAt,
        value.offerId,
      );
      const bound = this.getFirmOffer(value.offerId);
      if (!bound || bound.executionAuthorizationDigest !== value.executionAuthorizationDigest
          || bound.executionAuthorizationExpiresAt !== value.authorizationExpiresAt) {
        throw new Error("firm offer user authorization was not persisted atomically");
      }
      return bound;
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
      this.#bindAdmissionPolicy(policy);
      const current = this.getFirmOffer(offerId);
      if (!current) throw new Error("firm offer does not exist");
      if (current.state !== "ACTIVE") {
        if (current.state === state && current.outcomeDigest === evidenceDigest) return current;
        throw new Error("firm offer already has another outcome");
      }
      if (input.outcome === "filled") {
        const completed = this.#db.prepare(`
          SELECT settlement_id, terminal_proof_digest FROM settlements
          WHERE selected_offer_id = ? AND terminal_state = 'COMPLETED' LIMIT 1
        `).get(offerId);
        if (!completed || completed.terminal_proof_digest !== evidenceDigest) {
          throw new Error("filled offer requires the exact reconciled completed-settlement proof");
        }
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

  bindSettlementExecutionPolicy(input) {
    const value = normalizeSettlementExecutionPolicy(input);
    return this.#transaction(() => {
      const settlement = this.getSettlement(value.settlementId);
      if (!settlement) throw new Error("settlement does not exist");
      const offer = this.getFirmOffer(settlement.selectedOfferId);
      const request = offer ? this.getRfqRequest(offer.requestId) : null;
      if (settlement.executionPolicyBindingDigest) {
        if (!offer) throw new Error("settlement execution policy lost its firm offer");
        const expected = digest({
          schema: "treeswap.settlement-execution-policy.v3",
          settlementId: settlement.settlementId,
          selectedOfferId: settlement.selectedOfferId,
          marketRiskDigest: offer.marketRiskDigest,
          riskPolicyDigest: value.riskPolicyDigest,
          marketRiskValidUntil: offer.marketRiskValidUntil,
          releaseRecordDigest: value.releaseRecordDigest,
          evidencePolicyDigest: value.evidencePolicyDigest,
          solverCapabilityDigest: value.solverCapabilityDigest,
          boundAt: value.boundAt,
        });
        if (settlement.releaseRecordDigest !== value.releaseRecordDigest
            || settlement.riskPolicyDigest !== value.riskPolicyDigest
            || settlement.evidencePolicyDigest !== value.evidencePolicyDigest
            || settlement.solverCapabilityDigest !== value.solverCapabilityDigest
            || settlement.executionPolicyBindingDigest !== expected
            || settlement.executionPolicyBoundAt !== value.boundAt) {
          throw new Error("settlement execution policy is already bound to different authority");
        }
        return settlement;
      }
      if (settlement.state !== "INTENT_ACCEPTED" || settlement.reservationId || settlement.lastActionId
          || settlement.terminalState || settlement.haltCode || settlement.reconciliationRequired) {
        throw new Error("settlement execution policy must bind before reservation, actions, or closure");
      }
      if (value.boundAt < settlement.createdAt) {
        throw new Error("settlement execution policy binding predates settlement acceptance");
      }
      if (!offer || offer.state !== "ACTIVE" || offer.expiresAt <= value.boundAt
          || offer.marketRiskValidUntil < offer.expiresAt || offer.marketRiskValidUntil <= value.boundAt
          || !offer.marketRiskDigest || offer.marketRiskDigest === `0x${"0".repeat(64)}`
          || offer.marketRiskPolicyDigest !== value.riskPolicyDigest
          || offer.selectionAuthorizationExpiresAt <= value.boundAt
          || offer.executionAuthorizationExpiresAt <= value.boundAt
          || offer.reservedAt > value.boundAt || offer.finalizedAt > value.boundAt || offer.authorizedAt > value.boundAt
          || !offer.privateRequestDigest || !offer.executableOfferDigest || !offer.executionBindingDigest
          || !offer.executionAuthorizationDigest) {
        throw new Error("settlement execution policy requires an active fully authorized firm offer");
      }
      if (!request || request.state !== "ACTIVE" || request.expiresAt <= value.boundAt
          || request.requestId !== settlement.pricingId
          || request.direction !== settlement.direction || request.notionalSats !== settlement.amountSats
          || offer.direction !== settlement.direction
          || offer.capacityEpoch !== settlement.capacityEpoch
          || offer.capabilityDigest !== value.solverCapabilityDigest) {
        throw new Error("settlement execution policy does not match its durable RFQ, offer, capability, or amount");
      }
      const executionPolicyBindingDigest = digest({
        schema: "treeswap.settlement-execution-policy.v3",
        settlementId: settlement.settlementId,
        selectedOfferId: settlement.selectedOfferId,
        marketRiskDigest: offer.marketRiskDigest,
        riskPolicyDigest: value.riskPolicyDigest,
        marketRiskValidUntil: offer.marketRiskValidUntil,
        releaseRecordDigest: value.releaseRecordDigest,
        evidencePolicyDigest: value.evidencePolicyDigest,
        solverCapabilityDigest: value.solverCapabilityDigest,
        boundAt: value.boundAt,
      });
      const update = this.#db.prepare(`
        UPDATE settlements
        SET release_record_digest = ?, risk_policy_digest = ?, evidence_policy_digest = ?, solver_capability_digest = ?,
          execution_policy_binding_digest = ?, execution_policy_bound_at = ?, version = version + 1, updated_at = ?
        WHERE settlement_id = ? AND state = 'INTENT_ACCEPTED' AND release_record_digest IS NULL
      `).run(
        value.releaseRecordDigest,
        value.riskPolicyDigest,
        value.evidencePolicyDigest,
        value.solverCapabilityDigest,
        executionPolicyBindingDigest,
        value.boundAt,
        value.boundAt,
        settlement.settlementId,
      );
      if (update.changes !== 1) throw new Error("settlement execution policy was not persisted atomically");
      this.#event({
        settlementId: settlement.settlementId,
        eventType: "SETTLEMENT",
        eventCode: "EXECUTION_POLICY_BOUND",
        dataDigest: executionPolicyBindingDigest,
        occurredAt: value.boundAt,
      });
      return this.getSettlement(settlement.settlementId);
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

  recoverInterruptedAction(actionId, recordedAt) {
    const id = bytes32(actionId, "actionId");
    const at = integer(recordedAt, "recordedAt");
    return this.#transaction(() => {
      const row = this.#db.prepare("SELECT * FROM coordinator_actions WHERE action_id = ?").get(id);
      if (!row) throw new Error("action does not exist");
      if (row.state !== "DISPATCHING") throw new Error("action is not interrupted");
      const recoveryDigest = digest({ actionId: id, code: "PROCESS_RESTART", recordedAt: at });
      this.#db.prepare(`
        UPDATE coordinator_actions SET state = 'UNKNOWN', result_digest = ?, result_code = 'PROCESS_RESTART', resolved_at = ?
        WHERE action_id = ?
      `).run(recoveryDigest, at, id);
      if (row.method === "evm:claim") {
        this.#db.prepare(`
          UPDATE coordinator_evm_transactions SET state = 'UNKNOWN', last_observed_at = ? WHERE action_id = ?
        `).run(at, id);
      }
      this.#db.prepare(`
        UPDATE settlements SET state = 'RECONCILIATION_REQUIRED', reconciliation_required = 1,
          version = version + 1, updated_at = ? WHERE settlement_id = ?
      `).run(at, row.settlement_id);
      this.#event({
        settlementId: row.settlement_id,
        actionId: id,
        eventType: "RECOVERY",
        eventCode: "PROCESS_RESTART",
        dataDigest: recoveryDigest,
        occurredAt: at,
      });
      return Object.freeze({ action: this.getAction(id), settlement: this.getSettlement(row.settlement_id) });
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
    const activeBitToLightningInFlightSats = this.#db.prepare(`
      SELECT amount FROM firm_offer_commitments
      WHERE direction = 'bit-to-lightning' AND state = 'ACTIVE'
    `).all().reduce((total, row) => total + BigInt(row.amount), 0n).toString();
    return Object.freeze({
      rfqStates,
      firmOfferStates,
      solverHealth,
      activeCommitments,
      activeBitToLightningInFlightSats,
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

  releaseLiabilitySnapshot() {
    return releaseLiabilitySnapshotForDatabase(this.#db);
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
