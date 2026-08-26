import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keccak256, toUtf8Bytes } from "ethers";
import { contractIntentWalletJournalArtifact } from "./contract-intent-wallet.mjs";

export const CONTRACT_INTENT_WALLET_STORE_SCHEMA = "treeswap.contract-intent-wallet-store.v2";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const DATA = /^0x(?:[0-9a-f]{2})*$/;
const MAXIMUM_INTENTS = 4_096;
const META_TABLE = "contract_intent_wallet_meta";
const INTENT_TABLE = "contract_intent_wallet_intents";
const ARTIFACT_TABLE = "contract_intent_wallet_artifacts";
const STATES = Object.freeze([
  "WALLET_REQUEST_CLAIMED",
  "USER_REJECTED",
  "USER_REJECTED_CONTEXT_CHANGED",
  "SUBMISSION_UNKNOWN",
  "SUBMISSION_UNKNOWN_CONTEXT_CHANGED",
  "SUBMISSION_REPORTED",
  "SUBMISSION_REPORTED_CONTEXT_CHANGED",
  "PENDING",
  "INCLUDED",
  "NOT_FOUND",
  "REORGED",
  "REVERTED",
  "MISMATCH",
  "FINALITY_QUORUM_PENDING",
  "FINALIZED_CORE",
]);
const META_SQL = `CREATE TABLE ${META_TABLE} (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT`;
const INTENT_SQL = `CREATE TABLE ${INTENT_TABLE} (
  request_digest TEXT PRIMARY KEY NOT NULL,
  settlement_id TEXT NOT NULL UNIQUE,
  contract_intent_digest TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('lightning-to-bit', 'bit-to-lightning')),
  contract_code_hash TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  calldata TEXT NOT NULL,
  calldata_digest TEXT NOT NULL,
  value_hex TEXT NOT NULL CHECK (value_hex = '0x0'),
  quote_json TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'WALLET_REQUEST_CLAIMED', 'USER_REJECTED', 'USER_REJECTED_CONTEXT_CHANGED',
    'SUBMISSION_UNKNOWN', 'SUBMISSION_UNKNOWN_CONTEXT_CHANGED',
    'SUBMISSION_REPORTED', 'SUBMISSION_REPORTED_CONTEXT_CHANGED',
    'PENDING', 'INCLUDED', 'NOT_FOUND', 'REORGED', 'REVERTED', 'MISMATCH',
    'FINALITY_QUORUM_PENDING', 'FINALIZED_CORE'
  )),
  transaction_hash TEXT,
  nonce TEXT,
  replacement_count INTEGER NOT NULL,
  inclusion_block_hash TEXT,
  inclusion_block_number INTEGER,
  consensus_digest TEXT,
  claimed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  artifact_count INTEGER NOT NULL,
  record_digest TEXT NOT NULL,
  CHECK (expires_at > prepared_at),
  CHECK (claimed_at >= prepared_at AND updated_at >= claimed_at),
  CHECK (replacement_count >= 0 AND artifact_count > 0),
  CHECK ((inclusion_block_hash IS NULL) = (inclusion_block_number IS NULL)),
  CHECK (length(CAST(calldata AS BLOB)) <= 262146),
  CHECK (length(CAST(quote_json AS BLOB)) <= 32768)
) STRICT`;
const ARTIFACT_SQL = `CREATE TABLE ${ARTIFACT_TABLE} (
  request_digest TEXT NOT NULL REFERENCES ${INTENT_TABLE}(request_digest) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('PREFLIGHT', 'SUBMISSION', 'TRANSACTION', 'OBSERVATION', 'QUORUM')),
  resulting_state TEXT NOT NULL CHECK (resulting_state IN (
    'WALLET_REQUEST_CLAIMED', 'USER_REJECTED', 'USER_REJECTED_CONTEXT_CHANGED',
    'SUBMISSION_UNKNOWN', 'SUBMISSION_UNKNOWN_CONTEXT_CHANGED',
    'SUBMISSION_REPORTED', 'SUBMISSION_REPORTED_CONTEXT_CHANGED',
    'PENDING', 'INCLUDED', 'NOT_FOUND', 'REORGED', 'REVERTED', 'MISMATCH',
    'FINALITY_QUORUM_PENDING', 'FINALIZED_CORE'
  )),
  observed_at INTEGER NOT NULL,
  artifact_digest TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (request_digest, sequence),
  CHECK (sequence > 0 AND observed_at > 0),
  CHECK (length(CAST(payload_json AS BLOB)) <= 524288)
) STRICT`;
const STORE_TOKEN = Symbol("TreeSwap contract-intent wallet store");
const STORES = new WeakSet();
const DISPATCH_CLAIMS = new WeakMap();
const ARTIFACT_FIELDS = Object.freeze({
  PREFLIGHT: Object.freeze([
    "calldata",
    "calldataDigest",
    "chainId",
    "contractCodeHash",
    "contractIntentDigest",
    "direction",
    "expiresAt",
    "from",
    "kind",
    "preparedAt",
    "quote",
    "requestDigest",
    "settlementId",
    "to",
    "value",
  ]),
  SUBMISSION: Object.freeze([
    "contextChanged",
    "contractIntentDigest",
    "expiredAtResponse",
    "kind",
    "observedAt",
    "postContextUnavailable",
    "requestDigest",
    "requiresIndependentReconciliation",
    "retryAuthorized",
    "settlementId",
    "state",
    "transactionHash",
  ]),
  TRANSACTION: Object.freeze([
    "contractIntentDigest",
    "exactIntentCall",
    "inclusionBlockHash",
    "inclusionBlockNumber",
    "kind",
    "nonce",
    "replacementOf",
    "requestDigest",
    "state",
    "transactionHash",
  ]),
  OBSERVATION: Object.freeze([
    "blockHash",
    "blockNumber",
    "consensusDigest",
    "contractCodeHash",
    "contractIntentDigest",
    "finalizedBlockHash",
    "finalizedBlockNumber",
    "kind",
    "observedAt",
    "providerIdentity",
    "receiptDigest",
    "requestDigest",
    "state",
    "transactionHash",
  ]),
  QUORUM: Object.freeze([
    "blockHash",
    "blockNumber",
    "canonicalFinalizedReservation",
    "consensusDigest",
    "contractIntentDigest",
    "independentProviderOperationVerified",
    "kind",
    "providerIdentities",
    "requestDigest",
    "state",
    "transactionHash",
  ]),
});
const QUOTE_FIELDS = Object.freeze([
  "amount",
  "beneficiary",
  "fee",
  "invoiceDigest",
  "lastSafeClaimAt",
  "lightningAmountSats",
  "nonce",
  "paymentHash",
  "quoteExpiresAt",
  "quoteId",
  "refundAfter",
  "solver",
  "user",
]);

function exactRecord(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...fields].sort();
  if (keys.some((key) => typeof key !== "string") || keys.length !== expected.length
      || [...keys].sort().some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function canonicalize(value, depth = 0) {
  if (depth > 12) throw new RangeError("wallet journal artifact is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("wallet journal numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("wallet journal artifacts must contain plain data only");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("wallet journal artifacts cannot contain symbols");
    }
    keys.sort();
    return `{${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new TypeError("wallet journal artifacts require enumerable data properties");
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  }
  throw new TypeError("wallet journal artifact contains unsupported data");
}

function digest(value) {
  return keccak256(toUtf8Bytes(canonicalize(value))).toLowerCase();
}

function sql(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "");
}

function storedInteger(value, name) {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${name} is not canonical`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`${name} is outside the safe range`);
  }
  return parsed;
}

function rowRecord(row) {
  return Object.freeze({
    requestDigest: row.request_digest,
    settlementId: row.settlement_id,
    contractIntentDigest: row.contract_intent_digest,
    direction: row.direction,
    contractCodeHash: row.contract_code_hash,
    chainId: row.chain_id,
    from: row.from_address,
    to: row.to_address,
    calldata: row.calldata,
    calldataDigest: row.calldata_digest,
    value: row.value_hex,
    quoteJson: row.quote_json,
    preparedAt: Number(row.prepared_at),
    expiresAt: Number(row.expires_at),
    state: row.state,
    transactionHash: row.transaction_hash,
    nonce: row.nonce,
    replacementCount: Number(row.replacement_count),
    inclusionBlockHash: row.inclusion_block_hash,
    inclusionBlockNumber: row.inclusion_block_number === null ? null : Number(row.inclusion_block_number),
    consensusDigest: row.consensus_digest,
    claimedAt: Number(row.claimed_at),
    updatedAt: Number(row.updated_at),
    artifactCount: Number(row.artifact_count),
  });
}

function databaseInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is outside the safe range`);
  }
  return value;
}

function validateRow(database, row) {
  const record = rowRecord(row);
  databaseInteger(record.preparedAt, "contract-intent wallet prepared time");
  databaseInteger(record.expiresAt, "contract-intent wallet expiry");
  databaseInteger(record.claimedAt, "contract-intent wallet claim time");
  databaseInteger(record.updatedAt, "contract-intent wallet update time");
  databaseInteger(record.replacementCount, "contract-intent wallet replacement count");
  databaseInteger(record.artifactCount, "contract-intent wallet artifact count");
  if (record.inclusionBlockNumber !== null) {
    databaseInteger(record.inclusionBlockNumber, "contract-intent wallet inclusion block");
  }
  if (!BYTES32.test(record.requestDigest) || !BYTES32.test(record.settlementId)
      || !BYTES32.test(record.contractIntentDigest)
      || !BYTES32.test(record.contractCodeHash) || !BYTES32.test(record.calldataDigest)
      || !ADDRESS.test(record.from) || !ADDRESS.test(record.to)
      || !DATA.test(record.calldata) || keccak256(record.calldata).toLowerCase() !== record.calldataDigest
      || !DECIMAL.test(record.chainId) || record.value !== "0x0" || !STATES.includes(record.state)
      || (record.transactionHash !== null && !BYTES32.test(record.transactionHash))
      || (record.nonce !== null && !DECIMAL.test(record.nonce))
      || (record.inclusionBlockHash !== null && !BYTES32.test(record.inclusionBlockHash))
      || (record.consensusDigest !== null && !BYTES32.test(record.consensusDigest))
      || digest(record) !== row.record_digest) {
    throw new Error("contract-intent wallet durable record changed");
  }
  const noTransactionStates = [
    "WALLET_REQUEST_CLAIMED",
    "USER_REJECTED",
    "USER_REJECTED_CONTEXT_CHANGED",
    "SUBMISSION_UNKNOWN",
    "SUBMISSION_UNKNOWN_CONTEXT_CHANGED",
  ];
  const preNonceStates = ["SUBMISSION_REPORTED", "SUBMISSION_REPORTED_CONTEXT_CHANGED"];
  const includedStates = ["INCLUDED", "REVERTED", "MISMATCH", "FINALITY_QUORUM_PENDING", "FINALIZED_CORE"];
  if ((noTransactionStates.includes(record.state)
      && (record.transactionHash !== null || record.nonce !== null))
      || (preNonceStates.includes(record.state)
        && (record.transactionHash === null || record.nonce !== null))
      || (![...noTransactionStates, ...preNonceStates].includes(record.state)
        && (record.transactionHash === null || record.nonce === null))
      || (includedStates.includes(record.state) && record.inclusionBlockHash === null)
      || ([...noTransactionStates, ...preNonceStates, "PENDING"]
        .includes(record.state) && record.consensusDigest !== null)
      || (["NOT_FOUND", "REORGED", "REVERTED", "MISMATCH", "FINALITY_QUORUM_PENDING", "FINALIZED_CORE"]
        .includes(record.state) && record.consensusDigest === null)) {
    throw new Error("contract-intent wallet durable state fields are inconsistent");
  }
  const quote = JSON.parse(record.quoteJson);
  if (canonicalize(quote) !== record.quoteJson) {
    throw new Error("contract-intent wallet quote record is not canonical");
  }
  const artifacts = database.prepare(`
    SELECT sequence, kind, resulting_state, observed_at, artifact_digest, payload_json
    FROM ${ARTIFACT_TABLE} WHERE request_digest = ? ORDER BY sequence
  `).all(record.requestDigest);
  if (artifacts.length !== record.artifactCount || artifacts.length === 0
      || artifacts[0].sequence !== 1 || artifacts[0].kind !== "PREFLIGHT"
      || artifacts[0].resulting_state !== "WALLET_REQUEST_CLAIMED"
      || artifacts.at(-1).resulting_state !== record.state) {
    throw new Error("contract-intent wallet artifact journal is inconsistent");
  }
  let replayState = null;
  let previousObservedAt = 0;
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    const payload = JSON.parse(artifact.payload_json);
    if (!ARTIFACT_FIELDS[payload.kind]) throw new Error("contract-intent wallet artifact kind changed");
    exactRecord(payload, ARTIFACT_FIELDS[payload.kind], "stored contract-intent wallet artifact");
    if (payload.kind === "PREFLIGHT") {
      exactRecord(payload.quote, QUOTE_FIELDS, "stored contract-intent wallet quote");
    }
    if (artifact.sequence !== index + 1 || payload.requestDigest !== record.requestDigest
        || payload.contractIntentDigest !== record.contractIntentDigest
        || payload.kind !== artifact.kind || canonicalize(payload) !== artifact.payload_json
        || digest(payload) !== artifact.artifact_digest) {
      throw new Error("contract-intent wallet artifact changed");
    }
    databaseInteger(artifact.observed_at, "contract-intent wallet artifact observation time");
    if (artifact.observed_at < previousObservedAt || artifact.observed_at > record.updatedAt
        || (payload.observedAt !== undefined && payload.observedAt > artifact.observed_at)) {
      throw new Error("contract-intent wallet artifact time changed");
    }
    previousObservedAt = artifact.observed_at;
    if (index === 0) {
      if (payload.kind !== "PREFLIGHT" || payload.settlementId !== record.settlementId
          || payload.direction !== record.direction || payload.contractCodeHash !== record.contractCodeHash
          || payload.chainId !== record.chainId || payload.from !== record.from || payload.to !== record.to
          || payload.calldata !== record.calldata || payload.calldataDigest !== record.calldataDigest
          || payload.value !== record.value || canonicalize(payload.quote) !== record.quoteJson
          || payload.preparedAt !== record.preparedAt || payload.expiresAt !== record.expiresAt) {
        throw new Error("contract-intent wallet durable preflight changed");
      }
      replayState = "WALLET_REQUEST_CLAIMED";
    } else {
      replayState = artifactState(replayState, payload);
    }
    if (artifact.resulting_state !== replayState) {
      throw new Error("contract-intent wallet artifact transition changed");
    }
  }
  if (replayState !== record.state || previousObservedAt !== record.updatedAt) {
    throw new Error("contract-intent wallet durable state changed");
  }
}

function verifyDatabase(database, { requireSchema = true, maximumIntents = MAXIMUM_INTENTS } = {}) {
  const quick = database.prepare("PRAGMA quick_check").all();
  if (quick.length !== 1 || Object.values(quick[0]).length !== 1
      || Object.values(quick[0])[0] !== "ok") {
    throw new Error("contract-intent wallet database quick check failed");
  }
  const objects = database.prepare(`
    SELECT name, sql, type FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all();
  if (objects.length === 0 && !requireSchema) return;
  const expected = new Map([
    [ARTIFACT_TABLE, ARTIFACT_SQL],
    [INTENT_TABLE, INTENT_SQL],
    [META_TABLE, META_SQL],
  ]);
  if (objects.length !== expected.size || objects.some((entry) => entry.type !== "table"
      || !expected.has(entry.name) || sql(entry.sql) !== sql(expected.get(entry.name)))) {
    throw new Error("contract-intent wallet database layout is unsupported");
  }
  const meta = database.prepare(`SELECT key, value FROM ${META_TABLE} ORDER BY key`).all();
  if (meta.length !== 2 || meta[0].key !== "clock_high_water" || meta[1].key !== "schema"
      || meta[1].value !== CONTRACT_INTENT_WALLET_STORE_SCHEMA) {
    throw new Error("contract-intent wallet database schema is unsupported");
  }
  storedInteger(meta[0].value, "contract-intent wallet clock high-water mark");
  const rows = database.prepare(`SELECT * FROM ${INTENT_TABLE} ORDER BY request_digest`).all();
  if (rows.length > maximumIntents) throw new Error("contract-intent wallet database exceeds its bound");
  for (const row of rows) validateRow(database, row);
}

function storedClock(database) {
  const row = database.prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'clock_high_water'`).get();
  if (!row) throw new Error("contract-intent wallet durable clock is missing");
  return storedInteger(row.value, "contract-intent wallet clock high-water mark");
}

function advanceClock(database, now) {
  const previous = storedClock(database);
  if (now < previous) throw new Error("contract-intent wallet clock regressed");
  if (now === previous) return;
  const result = database.prepare(`
    UPDATE ${META_TABLE} SET value = ? WHERE key = 'clock_high_water' AND value = ?
  `).run(String(now), String(previous));
  if (Number(result.changes) !== 1) throw new Error("contract-intent wallet clock update failed");
}

async function privateDatabasePath(raw) {
  if (typeof raw !== "string" || !isAbsolute(raw) || raw.includes("\0") || raw.length > 4_096) {
    throw new TypeError("contract-intent wallet database path must be bounded and absolute");
  }
  const path = resolve(raw);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentState = await lstat(parent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (parentState.isSymbolicLink() || !parentState.isDirectory()
      || (parentState.mode & 0o077) !== 0
      || (currentUid !== null && parentState.uid !== currentUid)) {
    throw new Error("contract-intent wallet database parent must be private");
  }
  const canonicalPath = join(await realpath(parent), basename(path));
  try {
    const state = await lstat(canonicalPath);
    if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0
        || (currentUid !== null && state.uid !== currentUid)) {
      throw new Error("contract-intent wallet database must be a private regular file");
    }
    return Object.freeze({ exists: true, path: canonicalPath });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return Object.freeze({ exists: false, path: canonicalPath });
  }
}

async function secureDatabaseFiles(path) {
  await chmod(path, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    try { await chmod(`${path}${suffix}`, 0o600); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function artifactState(currentState, artifact) {
  if (artifact.kind === "SUBMISSION") {
    if (currentState !== "WALLET_REQUEST_CLAIMED") {
      throw new Error("contract-intent wallet submission transition is invalid");
    }
    if (!STATES.includes(artifact.state) || ![
      "USER_REJECTED",
      "USER_REJECTED_CONTEXT_CHANGED",
      "SUBMISSION_UNKNOWN",
      "SUBMISSION_UNKNOWN_CONTEXT_CHANGED",
      "SUBMISSION_REPORTED",
      "SUBMISSION_REPORTED_CONTEXT_CHANGED",
    ].includes(artifact.state)) throw new Error("contract-intent wallet submission state is invalid");
    return artifact.state;
  }
  if (artifact.kind === "TRANSACTION") {
    if (![
      "SUBMISSION_REPORTED",
      "SUBMISSION_REPORTED_CONTEXT_CHANGED",
      "PENDING",
      "INCLUDED",
      "NOT_FOUND",
      "REORGED",
    ].includes(currentState) || !["PENDING", "INCLUDED"].includes(artifact.state)) {
      throw new Error("contract-intent wallet transaction transition is invalid");
    }
    return artifact.state;
  }
  if (artifact.kind === "OBSERVATION") {
    if ([
      "WALLET_REQUEST_CLAIMED",
      "USER_REJECTED",
      "USER_REJECTED_CONTEXT_CHANGED",
      "SUBMISSION_UNKNOWN",
      "SUBMISSION_UNKNOWN_CONTEXT_CHANGED",
      "SUBMISSION_REPORTED",
      "SUBMISSION_REPORTED_CONTEXT_CHANGED",
    ].includes(currentState)) throw new Error("contract-intent wallet receipt transition is invalid");
    const observedState = artifact.state === "FINALIZED" ? "FINALITY_QUORUM_PENDING" : artifact.state;
    if (!["NOT_FOUND", "REORGED", "REVERTED", "MISMATCH", "INCLUDED", "FINALITY_QUORUM_PENDING"]
      .includes(observedState)) throw new Error("contract-intent wallet receipt state is invalid");
    if (["MISMATCH", "REVERTED", "FINALIZED_CORE"].includes(currentState)
        && observedState !== "REORGED") {
      throw new Error("contract-intent wallet post-decision observation is invalid");
    }
    return observedState;
  }
  if (artifact.kind === "QUORUM") {
    if (currentState !== "FINALITY_QUORUM_PENDING" || artifact.state !== "REPOSITORY_CORE_VERIFIED") {
      throw new Error("contract-intent wallet quorum transition is invalid");
    }
    return "FINALIZED_CORE";
  }
  throw new Error("contract-intent wallet artifact kind is unsupported");
}

function verifyStoredQuorumPrerequisites(database, artifact) {
  if (!Array.isArray(artifact.providerIdentities) || artifact.providerIdentities.length !== 2
      || artifact.providerIdentities.some((identity) => !BYTES32.test(identity))
      || artifact.providerIdentities[0] === artifact.providerIdentities[1]) {
    throw new Error("contract-intent wallet quorum provider set is invalid");
  }
  const providers = new Set();
  const rows = database.prepare(`
    SELECT payload_json FROM ${ARTIFACT_TABLE}
    WHERE request_digest = ? AND kind = 'OBSERVATION'
  `).all(artifact.requestDigest);
  for (const row of rows) {
    const observation = JSON.parse(row.payload_json);
    if (observation.state === "FINALIZED"
        && observation.transactionHash === artifact.transactionHash
        && observation.consensusDigest === artifact.consensusDigest
        && artifact.providerIdentities.includes(observation.providerIdentity)) {
      providers.add(observation.providerIdentity);
    }
  }
  if (providers.size !== 2) {
    throw new Error("contract-intent wallet quorum lacks both durable provider observations");
  }
}

function recoveryAction(state) {
  if (["WALLET_REQUEST_CLAIMED", "SUBMISSION_UNKNOWN", "SUBMISSION_UNKNOWN_CONTEXT_CHANGED"]
    .includes(state)) return "SEARCH_QUOTE_NO_RESEND";
  if (["SUBMISSION_REPORTED", "SUBMISSION_REPORTED_CONTEXT_CHANGED", "PENDING", "NOT_FOUND"]
    .includes(state)) return "RECONCILE_TRANSACTION_NO_RESEND";
  if (["INCLUDED", "FINALITY_QUORUM_PENDING"].includes(state)) {
    return "RECONCILE_RECEIPT_NO_LIGHTNING";
  }
  if (state === "FINALIZED_CORE") return "REQUIRE_DEPLOYED_FINALITY_PROOF_NO_LIGHTNING";
  return "HALT_AND_RECONCILE_NO_RESEND";
}

function publicResult(row, status) {
  return Object.freeze({
    schema: "treeswap.contract-intent-wallet-store-result.v1",
    status,
    requestDigest: row.request_digest,
    state: row.state,
    transactionHash: row.transaction_hash,
    retryAuthorized: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
}

export class ContractIntentWalletStore {
  #database;
  #path;
  #maximumIntents;
  #closed = false;

  constructor(database, path, maximumIntents, token) {
    if (token !== STORE_TOKEN) throw new TypeError("contract-intent wallet stores require the factory");
    this.#database = database;
    this.#path = path;
    this.#maximumIntents = maximumIntents;
    STORES.add(this);
    Object.freeze(this);
  }

  static async open(input) {
    const source = exactRecord(input, [
      "allowMemory",
      "initialize",
      "maximumIntents",
      "path",
    ], "contract-intent wallet storage options");
    const maximumIntents = integer(
      source.maximumIntents,
      "contract-intent wallet maximum intents",
      1,
      MAXIMUM_INTENTS,
    );
    let resolvedPath;
    if (source.path === ":memory:") {
      if (source.allowMemory !== true || source.initialize !== true) {
        throw new Error("contract-intent wallet memory storage is initialized test-only storage");
      }
      resolvedPath = source.path;
    } else {
      if (source.allowMemory !== false
          || (source.initialize !== true && source.initialize !== false)) {
        throw new TypeError("contract-intent wallet storage options are invalid");
      }
      const resolvedPathState = await privateDatabasePath(source.path);
      if (source.initialize && resolvedPathState.exists) {
        throw new Error("contract-intent wallet database already exists");
      }
      if (!source.initialize && !resolvedPathState.exists) {
        throw new Error("contract-intent wallet database is missing");
      }
      resolvedPath = resolvedPathState.path;
      if (source.initialize) {
        const handle = await open(resolvedPath, "wx", 0o600);
        await handle.close();
      }
    }
    let database;
    try {
      database = new DatabaseSync(resolvedPath, { enableForeignKeyConstraints: true, timeout: 5_000 });
      database.exec("PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      if (resolvedPath !== ":memory:") database.exec("PRAGMA journal_mode=WAL;");
      verifyDatabase(database, { requireSchema: false, maximumIntents });
      const count = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
      `).get().count);
      if (count === 0 && !source.initialize) throw new Error("contract-intent wallet database is uninitialized");
      if (count === 0) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(`${META_SQL}; ${INTENT_SQL}; ${ARTIFACT_SQL};`);
          database.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES ('schema', ?)`).run(
            CONTRACT_INTENT_WALLET_STORE_SCHEMA,
          );
          database.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES ('clock_high_water', '0')`).run();
          database.exec("COMMIT");
        } catch (error) {
          try { database.exec("ROLLBACK"); } catch {}
          throw error;
        }
      }
      verifyDatabase(database, { maximumIntents });
      if (resolvedPath !== ":memory:") await secureDatabaseFiles(resolvedPath);
      return new ContractIntentWalletStore(database, resolvedPath, maximumIntents, STORE_TOKEN);
    } catch (error) {
      try { database?.close(); } catch {}
      throw error;
    }
  }

  claim(preflight, input) {
    if (this.#closed) throw new Error("contract-intent wallet store is closed");
    const source = exactRecord(input, ["now"], "contract-intent wallet durable claim");
    const now = integer(source.now, "contract-intent wallet durable claim time", 1);
    const artifact = contractIntentWalletJournalArtifact(preflight);
    if (artifact.kind !== "PREFLIGHT") throw new TypeError("wallet durable claim requires a preflight");
    if (now < artifact.preparedAt || now >= artifact.expiresAt) {
      throw new Error("contract-intent wallet durable claim is outside the request window");
    }
    const payloadJson = canonicalize(artifact);
    const artifactDigest = digest(artifact);
    if (artifact.observedAt !== undefined && artifact.observedAt > now) {
      throw new Error("contract-intent wallet artifact cannot be persisted before observation");
    }
    const quoteJson = canonicalize(artifact.quote);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database, { maximumIntents: this.#maximumIntents });
      advanceClock(this.#database, now);
      const existing = this.#database.prepare(`SELECT * FROM ${INTENT_TABLE} WHERE request_digest = ?`)
        .get(artifact.requestDigest);
      if (existing) {
        this.#database.exec("COMMIT");
        return publicResult(existing, existing.record_digest === digest(rowRecord(existing)) ? "EXISTS" : "CONFLICT");
      }
      const total = Number(this.#database.prepare(`SELECT COUNT(*) AS count FROM ${INTENT_TABLE}`).get().count);
      if (total >= this.#maximumIntents) throw new Error("contract-intent wallet store reached its bound");
      const duplicate = this.#database.prepare(`
        SELECT request_digest FROM ${INTENT_TABLE}
        WHERE settlement_id = ? OR contract_intent_digest = ? LIMIT 1
      `).get(artifact.settlementId, artifact.contractIntentDigest);
      if (duplicate) throw new Error("contract-intent wallet durable intent conflicts");
      const record = Object.freeze({
        requestDigest: artifact.requestDigest,
        settlementId: artifact.settlementId,
        contractIntentDigest: artifact.contractIntentDigest,
        direction: artifact.direction,
        contractCodeHash: artifact.contractCodeHash,
        chainId: artifact.chainId,
        from: artifact.from,
        to: artifact.to,
        calldata: artifact.calldata,
        calldataDigest: artifact.calldataDigest,
        value: artifact.value,
        quoteJson,
        preparedAt: artifact.preparedAt,
        expiresAt: artifact.expiresAt,
        state: "WALLET_REQUEST_CLAIMED",
        transactionHash: null,
        nonce: null,
        replacementCount: 0,
        inclusionBlockHash: null,
        inclusionBlockNumber: null,
        consensusDigest: null,
        claimedAt: now,
        updatedAt: now,
        artifactCount: 1,
      });
      this.#database.prepare(`
        INSERT INTO ${INTENT_TABLE} (
          request_digest, settlement_id, contract_intent_digest, direction, contract_code_hash,
          chain_id, from_address, to_address, calldata, calldata_digest, value_hex, quote_json,
          prepared_at, expires_at, state, replacement_count, claimed_at, updated_at,
          artifact_count, record_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?)
      `).run(
        artifact.requestDigest,
        artifact.settlementId,
        artifact.contractIntentDigest,
        artifact.direction,
        artifact.contractCodeHash,
        artifact.chainId,
        artifact.from,
        artifact.to,
        artifact.calldata,
        artifact.calldataDigest,
        artifact.value,
        quoteJson,
        artifact.preparedAt,
        artifact.expiresAt,
        "WALLET_REQUEST_CLAIMED",
        now,
        now,
        digest(record),
      );
      this.#database.prepare(`
        INSERT INTO ${ARTIFACT_TABLE} (
          request_digest, sequence, kind, resulting_state, observed_at, artifact_digest, payload_json
        ) VALUES (?, 1, 'PREFLIGHT', 'WALLET_REQUEST_CLAIMED', ?, ?, ?)
      `).run(artifact.requestDigest, now, artifactDigest, payloadJson);
      const row = this.#database.prepare(`SELECT * FROM ${INTENT_TABLE} WHERE request_digest = ?`)
        .get(artifact.requestDigest);
      validateRow(this.#database, row);
      this.#database.exec("COMMIT");
      return publicResult(row, "CLAIMED");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  record(value, input) {
    if (this.#closed) throw new Error("contract-intent wallet store is closed");
    const source = exactRecord(input, ["now"], "contract-intent wallet durable recording");
    const now = integer(source.now, "contract-intent wallet durable recording time", 1);
    const artifact = contractIntentWalletJournalArtifact(value);
    if (artifact.kind === "PREFLIGHT") throw new TypeError("wallet preflights must use the durable claim");
    const payloadJson = canonicalize(artifact);
    const artifactDigest = digest(artifact);
    if (artifact.observedAt !== undefined && artifact.observedAt > now) {
      throw new Error("contract-intent wallet artifact cannot be persisted before observation");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database, { maximumIntents: this.#maximumIntents });
      advanceClock(this.#database, now);
      const duplicate = this.#database.prepare(`
        SELECT request_digest FROM ${ARTIFACT_TABLE} WHERE artifact_digest = ?
      `).get(artifactDigest);
      if (duplicate) {
        const existing = this.#database.prepare(`SELECT * FROM ${INTENT_TABLE} WHERE request_digest = ?`)
          .get(duplicate.request_digest);
        this.#database.exec("COMMIT");
        return publicResult(existing, "EXISTS");
      }
      const row = this.#database.prepare(`SELECT * FROM ${INTENT_TABLE} WHERE request_digest = ?`)
        .get(artifact.requestDigest);
      if (!row || artifact.contractIntentDigest !== row.contract_intent_digest) {
        throw new Error("contract-intent wallet artifact lacks its exact durable preflight");
      }
      if (now < Number(row.updated_at)) throw new Error("contract-intent wallet artifact time regressed");
      const nextState = artifactState(row.state, artifact);
      let transactionHash = row.transaction_hash;
      let nonce = row.nonce;
      let replacementCount = Number(row.replacement_count);
      let inclusionBlockHash = row.inclusion_block_hash;
      let inclusionBlockNumber = row.inclusion_block_number === null ? null : Number(row.inclusion_block_number);
      let consensusDigest = row.consensus_digest;
      if (artifact.kind === "SUBMISSION") transactionHash = artifact.transactionHash;
      if (artifact.kind === "TRANSACTION") {
        if ((artifact.replacementOf === null && transactionHash !== artifact.transactionHash)
            || (artifact.replacementOf !== null && artifact.replacementOf !== transactionHash)
            || (nonce !== null && artifact.nonce !== nonce)) {
          throw new Error("contract-intent wallet transaction forked the durable replacement chain");
        }
        transactionHash = artifact.transactionHash;
        nonce = artifact.nonce;
        if (artifact.replacementOf !== null) replacementCount += 1;
        inclusionBlockHash = artifact.inclusionBlockHash;
        inclusionBlockNumber = artifact.inclusionBlockNumber;
        consensusDigest = null;
      }
      if (artifact.kind === "OBSERVATION") {
        if (transactionHash !== artifact.transactionHash) {
          throw new Error("contract-intent wallet receipt changed the durable transaction");
        }
        consensusDigest = artifact.consensusDigest;
        inclusionBlockHash = artifact.blockHash;
        inclusionBlockNumber = artifact.blockNumber;
      }
      if (artifact.kind === "QUORUM") {
        verifyStoredQuorumPrerequisites(this.#database, artifact);
        if (transactionHash !== artifact.transactionHash) {
          throw new Error("contract-intent wallet quorum changed the durable transaction");
        }
        consensusDigest = artifact.consensusDigest;
        inclusionBlockHash = artifact.blockHash;
        inclusionBlockNumber = artifact.blockNumber;
      }
      const updatedRecord = Object.freeze({
        ...rowRecord(row),
        state: nextState,
        transactionHash,
        nonce,
        replacementCount,
        inclusionBlockHash,
        inclusionBlockNumber,
        consensusDigest,
        updatedAt: now,
        artifactCount: Number(row.artifact_count) + 1,
      });
      const result = this.#database.prepare(`
        UPDATE ${INTENT_TABLE} SET
          state = ?, transaction_hash = ?, nonce = ?, replacement_count = ?,
          inclusion_block_hash = ?, inclusion_block_number = ?, consensus_digest = ?,
          updated_at = ?, artifact_count = ?, record_digest = ?
        WHERE request_digest = ? AND record_digest = ?
      `).run(
        nextState,
        transactionHash,
        nonce,
        replacementCount,
        inclusionBlockHash,
        inclusionBlockNumber,
        consensusDigest,
        now,
        updatedRecord.artifactCount,
        digest(updatedRecord),
        artifact.requestDigest,
        row.record_digest,
      );
      if (Number(result.changes) !== 1) throw new Error("contract-intent wallet durable update raced");
      this.#database.prepare(`
        INSERT INTO ${ARTIFACT_TABLE} (
          request_digest, sequence, kind, resulting_state, observed_at, artifact_digest, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.requestDigest,
        updatedRecord.artifactCount,
        artifact.kind,
        nextState,
        now,
        artifactDigest,
        payloadJson,
      );
      const updated = this.#database.prepare(`SELECT * FROM ${INTENT_TABLE} WHERE request_digest = ?`)
        .get(artifact.requestDigest);
      validateRow(this.#database, updated);
      this.#database.exec("COMMIT");
      return publicResult(updated, "RECORDED");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  recover(input) {
    if (this.#closed) throw new Error("contract-intent wallet store is closed");
    const source = exactRecord(input, ["limit", "now"], "contract-intent wallet restart recovery");
    const now = integer(source.now, "contract-intent wallet recovery time", 1);
    const limit = integer(source.limit, "contract-intent wallet recovery limit", 1, 128);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database, { maximumIntents: this.#maximumIntents });
      advanceClock(this.#database, now);
      const rows = this.#database.prepare(`
        SELECT * FROM ${INTENT_TABLE}
        WHERE state NOT IN ('USER_REJECTED', 'USER_REJECTED_CONTEXT_CHANGED')
        ORDER BY updated_at, request_digest LIMIT ?
      `).all(limit);
      const recoveries = rows.map((row) => Object.freeze({
        schema: "treeswap.contract-intent-wallet-recovery.v1",
        requestDigest: row.request_digest,
        settlementId: row.settlement_id,
        contractIntentDigest: row.contract_intent_digest,
        direction: row.direction,
        chainId: row.chain_id,
        from: row.from_address,
        to: row.to_address,
        calldata: row.calldata,
        calldataDigest: row.calldata_digest,
        contractCodeHash: row.contract_code_hash,
        quote: Object.freeze(JSON.parse(row.quote_json)),
        expiresAt: Number(row.expires_at),
        state: row.state,
        transactionHash: row.transaction_hash,
        nonce: row.nonce,
        replacementCount: Number(row.replacement_count),
        inclusionBlockHash: row.inclusion_block_hash,
        inclusionBlockNumber: row.inclusion_block_number === null ? null : Number(row.inclusion_block_number),
        consensusDigest: row.consensus_digest,
        action: recoveryAction(row.state),
        expired: now >= Number(row.expires_at),
        retryAuthorized: false,
        walletDispatchAuthority: false,
        canonicalFinalizedReservation: false,
        independentProviderOperationVerified: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      }));
      this.#database.exec("COMMIT");
      return Object.freeze(recoveries);
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  status() {
    if (this.#closed) throw new Error("contract-intent wallet store is closed");
    verifyDatabase(this.#database, { maximumIntents: this.#maximumIntents });
    const counts = this.#database.prepare(`
      SELECT state, COUNT(*) AS count FROM ${INTENT_TABLE} GROUP BY state ORDER BY state
    `).all();
    const count = (state) => Number(counts.find((entry) => entry.state === state)?.count ?? 0);
    return Object.freeze({
      schema: "treeswap.contract-intent-wallet-store-status.v1",
      state: "open",
      durable: this.#path !== ":memory:",
      clockHighWater: storedClock(this.#database),
      totalIntents: counts.reduce((total, entry) => total + Number(entry.count), 0),
      unresolvedAttempts: counts
        .filter((entry) => !["USER_REJECTED", "USER_REJECTED_CONTEXT_CHANGED"].includes(entry.state))
        .reduce((total, entry) => total + Number(entry.count), 0),
      repositoryFinalized: count("FINALIZED_CORE"),
      retryAuthorizationCount: 0,
      walletDispatchAuthority: false,
      lightningDispatchAuthority: false,
      fundingAuthorization: false,
    });
  }

  close() {
    if (this.#closed) return false;
    this.#closed = true;
    this.#database.close();
    return true;
  }
}

Object.freeze(ContractIntentWalletStore.prototype);
Object.freeze(ContractIntentWalletStore);

export function claimContractIntentWalletForDispatch(store, preflight, input) {
  if (!STORES.has(store)) {
    throw new TypeError("wallet dispatch requires an original durable wallet store");
  }
  const source = exactRecord(input, ["now"], "contract-intent wallet dispatch claim");
  const now = integer(source.now, "contract-intent wallet dispatch claim time", 1);
  const artifact = contractIntentWalletJournalArtifact(preflight);
  if (artifact.kind !== "PREFLIGHT") {
    throw new TypeError("wallet dispatch claim requires an original preflight");
  }
  const claim = store.claim(preflight, { now });
  if (claim.status !== "CLAIMED" || claim.state !== "WALLET_REQUEST_CLAIMED"
      || claim.transactionHash !== null) {
    throw new Error("contract-intent wallet attempt was already claimed; reconcile without resend");
  }
  DISPATCH_CLAIMS.set(claim, {
    consumed: false,
    preflight,
    store,
  });
  return claim;
}

export function consumeContractIntentWalletDispatchClaim(claim, input) {
  const source = exactRecord(input, ["now"], "contract-intent wallet dispatch consumption");
  const now = integer(source.now, "contract-intent wallet dispatch consumption time", 1);
  const context = DISPATCH_CLAIMS.get(claim);
  if (!context || context.consumed) {
    throw new TypeError("wallet dispatch requires one original unconsumed durable claim");
  }
  const current = context.store.claim(context.preflight, { now });
  if (current.status !== "EXISTS" || current.state !== "WALLET_REQUEST_CLAIMED"
      || current.transactionHash !== null) {
    throw new Error("contract-intent wallet durable claim is no longer dispatchable");
  }
  context.consumed = true;
  return Object.freeze({
    preflight: context.preflight,
    store: context.store,
  });
}
