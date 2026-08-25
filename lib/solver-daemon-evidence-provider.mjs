import { createPublicKey } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddress } from "ethers";
import {
  buildSolverDaemonEvidenceRouteResponse,
  verifySolverDaemonEvidenceRequest,
} from "./solver-daemon-evidence-client.mjs";
import {
  buildSolverDaemonEvidenceApproval,
  SOLVER_DAEMON_EVIDENCE_SCHEMA,
  SOLVER_DAEMON_ZERO_BYTES32,
  solverDaemonEvidencePolicyDigest,
} from "./solver-daemon-evidence.mjs";

export const SOLVER_DAEMON_EVIDENCE_REPLAY_SCHEMA =
  "treeswap.solver-daemon-evidence-replay.v1";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const ROLES = new Set(["lightningOperator", "securityReviewer"]);
const MAX_REQUEST_BYTES = 65_536;
const MAX_REQUEST_LIFETIME_SECONDS = 30;
const MAX_REPLAY_CLAIM_WINDOW_SECONDS = MAX_REQUEST_LIFETIME_SECONDS + 30;
const MAXIMUM_LIVE_REQUESTS = 4_096;
const STORE_INPUT_KEYS = Object.freeze(["allowMemory", "initialize", "maximumLiveRequests", "path"]);
const CLAIM_KEYS = Object.freeze(["expiresAt", "now", "requesterKeyId", "requestId"]);
const CONSUME_KEYS = Object.freeze(["expiresAt", "now", "requesterKeyId", "requestId"]);
const READER_KEYS = Object.freeze(["read"]);
const ROUTE_KEYS = Object.freeze([
  "evidenceReader",
  "expectedRequesterKeyId",
  "maximumRequestBytes",
  "nowSeconds",
  "policy",
  "replayStore",
  "requesterPublicKey",
  "role",
  "signer",
]);
const META_TABLE = "solver_evidence_replay_meta";
const REQUEST_TABLE = "solver_evidence_replay_requests";
const META_SQL = `CREATE TABLE ${META_TABLE} (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT`;
const REQUEST_SQL = `CREATE TABLE ${REQUEST_TABLE} (
  requester_key_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CLAIMED', 'CONSUMED')),
  claimed_at INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (requester_key_id, request_id),
  CHECK ((state = 'CLAIMED') = (consumed_at IS NULL)),
  CHECK (request_expires_at > claimed_at),
  CHECK (consumed_at IS NULL OR consumed_at >= claimed_at)
) STRICT`;
const STORE_CONSTRUCTOR_TOKEN = Symbol("TreeSwap solver evidence replay store");
const replayStores = new WeakSet();
const replayClaims = new WeakMap();
const evidenceReaders = new WeakSet();
const evidenceRoutes = new WeakSet();

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Reflect.ownKeys(value);
  const wanted = [...expected].sort();
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const actual = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotPlainData(value, name, state = { depth: 0, counter: { value: 0 } }) {
  state.counter.value += 1;
  if (state.counter.value > 512 || state.depth > 16) {
    throw new RangeError(`${name} is outside the bounded data policy`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== "object") throw new TypeError(`${name} contains an unsupported value`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
      throw new TypeError(`${name} contains an unsupported array`);
    }
    const expected = [...Array(value.length).keys()].map(String).concat("length");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length
        || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
      throw new TypeError(`${name} array fields are not exact`);
    }
    return Object.freeze([...Array(value.length).keys()].map((index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${name}[${index}] must be an enumerable data property`);
      }
      return snapshotPlainData(descriptor.value, `${name}[${index}]`, {
        depth: state.depth + 1,
        counter: state.counter,
      });
    }));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} contains an unsupported object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} object fields are outside policy`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name}.${key} must be an enumerable data property`);
    }
    result[key] = snapshotPlainData(descriptor.value, `${name}.${key}`, {
      depth: state.depth + 1,
      counter: state.counter,
    });
  }
  return Object.freeze(result);
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  return raw;
}

function keyId(value, name) {
  const raw = String(value ?? "");
  if (!KEY_ID.test(raw)) throw new TypeError(`${name} is invalid`);
  return raw;
}

function address(value, name) {
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function role(value) {
  const raw = String(value ?? "");
  if (!ROLES.has(raw)) throw new RangeError("solver evidence provider role is unsupported");
  return raw;
}

function sql(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "");
}

function verifyDatabase(database, { requireSchema = true } = {}) {
  const check = database.prepare("PRAGMA quick_check").all();
  if (check.length !== 1 || Object.values(check[0]).length !== 1
      || Object.values(check[0])[0] !== "ok") {
    throw new Error("solver evidence replay database quick check failed");
  }
  const objects = database.prepare(`
    SELECT name, sql, type FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  if (objects.length === 0 && !requireSchema) return;
  if (objects.length !== 2
      || objects[0].type !== "table" || objects[0].name !== META_TABLE
      || objects[1].type !== "table" || objects[1].name !== REQUEST_TABLE
      || sql(objects[0].sql) !== sql(META_SQL)
      || sql(objects[1].sql) !== sql(REQUEST_SQL)) {
    throw new Error("solver evidence replay database layout is unsupported");
  }
  const schemaRows = database.prepare(`SELECT key, value FROM ${META_TABLE}`).all();
  if (schemaRows.length !== 1 || schemaRows[0].key !== "schema"
      || schemaRows[0].value !== SOLVER_DAEMON_EVIDENCE_REPLAY_SCHEMA) {
    throw new Error("solver evidence replay database schema is unsupported");
  }
}

async function privateDatabasePath(rawPath) {
  if (!isAbsolute(rawPath) || rawPath.includes("\0") || rawPath.length > 4_096) {
    throw new TypeError("solver evidence replay database path must be a bounded absolute path");
  }
  const requested = resolve(rawPath);
  const parent = dirname(requested);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentState = await lstat(parent);
  if (parentState.isSymbolicLink() || !parentState.isDirectory()) {
    throw new Error("solver evidence replay parent must be a private directory");
  }
  await chmod(parent, 0o700);
  const resolvedParent = await realpath(parent);
  const path = join(resolvedParent, basename(requested));
  let exists = false;
  try {
    const state = await lstat(path);
    exists = true;
    if (state.isSymbolicLink() || !state.isFile()) {
      throw new Error("solver evidence replay database must be a regular file");
    }
    if ((state.mode & 0o077) !== 0) {
      throw new Error("solver evidence replay database permissions must exclude group and other access");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ path, exists });
}

export class SolverDaemonEvidenceReplayStore {
  #database;
  #maximumLiveRequests;
  #path;
  #closed = false;

  constructor(database, path, maximumLiveRequests, token) {
    if (token !== STORE_CONSTRUCTOR_TOKEN) {
      throw new TypeError("solver evidence replay stores must be opened through the factory");
    }
    this.#database = database;
    this.#path = path;
    this.#maximumLiveRequests = maximumLiveRequests;
    replayStores.add(this);
    Object.freeze(this);
  }

  static async open(input) {
    const source = exactDataRecord(input, STORE_INPUT_KEYS, "solver evidence replay store");
    const allowMemory = source.allowMemory === true;
    if (source.initialize !== true && source.initialize !== false) {
      throw new TypeError("solver evidence replay initialize must be a boolean");
    }
    const initialize = source.initialize;
    const maximumLiveRequests = integer(
      source.maximumLiveRequests,
      "solver evidence maximum live replay requests",
      1,
      MAXIMUM_LIVE_REQUESTS,
    );
    let path;
    if (source.path === ":memory:") {
      if (!allowMemory) throw new Error("in-memory solver evidence replay storage is test-only");
      if (!initialize) throw new Error("in-memory solver evidence replay storage must be initialized");
      path = source.path;
    } else {
      if (allowMemory) throw new Error("solver evidence replay allowMemory is valid only for :memory:");
      const resolved = await privateDatabasePath(String(source.path ?? ""));
      path = resolved.path;
      if (initialize && resolved.exists) {
        throw new Error("solver evidence replay database already exists");
      }
      if (!initialize && !resolved.exists) {
        throw new Error("solver evidence replay database is missing; explicit initialization is required");
      }
      if (initialize) {
        const handle = await open(path, "wx", 0o600);
        await handle.close();
      }
    }
    let database;
    try {
      database = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        timeout: 5_000,
      });
      database.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
      if (path !== ":memory:") database.exec("PRAGMA journal_mode=WAL;");
      verifyDatabase(database, { requireSchema: false });
      const count = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
      `).get().count);
      if (count === 0 && !initialize) {
        throw new Error("solver evidence replay database is empty or uninitialized");
      }
      if (count === 0) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(`${META_SQL}; ${REQUEST_SQL};`);
          database.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES ('schema', ?)`).run(
            SOLVER_DAEMON_EVIDENCE_REPLAY_SCHEMA,
          );
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      verifyDatabase(database);
      if (path !== ":memory:") {
        await chmod(path, 0o600);
        const state = await lstat(path);
        if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0) {
          throw new Error("solver evidence replay database is not a private regular file");
        }
      }
      return new SolverDaemonEvidenceReplayStore(
        database,
        path,
        maximumLiveRequests,
        STORE_CONSTRUCTOR_TOKEN,
      );
    } catch (error) {
      try { database?.close(); } catch {}
      throw error;
    }
  }

  #assertOpen() {
    if (this.#closed) throw new Error("solver evidence replay store is closed");
  }

  claim(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, CLAIM_KEYS, "solver evidence replay claim");
    const requesterKeyId = keyId(source.requesterKeyId, "solver evidence replay requesterKeyId");
    const requestId = bytes32(source.requestId, "solver evidence replay requestId");
    const now = integer(source.now, "solver evidence replay claim time", 1);
    const expiresAt = integer(source.expiresAt, "solver evidence replay request expiry", 1);
    if (expiresAt <= now || expiresAt - now > MAX_REPLAY_CLAIM_WINDOW_SECONDS) {
      throw new Error("solver evidence replay request is outside its live window");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`DELETE FROM ${REQUEST_TABLE} WHERE request_expires_at <= ?`).run(now);
      const live = Number(this.#database.prepare(`SELECT COUNT(*) AS count FROM ${REQUEST_TABLE}`).get().count);
      if (live >= this.#maximumLiveRequests) {
        throw new Error("solver evidence replay store reached its live-request bound");
      }
      const inserted = this.#database.prepare(`
        INSERT OR IGNORE INTO ${REQUEST_TABLE} (
          requester_key_id, request_id, request_expires_at, state, claimed_at, consumed_at
        ) VALUES (?, ?, ?, 'CLAIMED', ?, NULL)
      `).run(requesterKeyId, requestId, expiresAt, now);
      if (Number(inserted.changes) !== 1) {
        this.#database.exec("ROLLBACK");
        return null;
      }
      this.#database.exec("COMMIT");
      const claim = Object.freeze({
        schema: SOLVER_DAEMON_EVIDENCE_REPLAY_SCHEMA,
        status: "request-claimed",
        expiresAt,
      });
      replayClaims.set(claim, Object.freeze({
        store: this,
        requesterKeyId,
        requestId,
        expiresAt,
        consumed: false,
      }));
      return claim;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  consume(claim, input) {
    this.#assertOpen();
    const context = replayClaims.get(claim);
    if (!context || context.store !== this) {
      throw new TypeError("solver evidence replay claim provenance is invalid");
    }
    if (context.consumed) return false;
    const source = exactDataRecord(input, CONSUME_KEYS, "solver evidence replay consumption");
    const now = integer(source.now, "solver evidence replay consumption time", 1);
    if (keyId(source.requesterKeyId, "solver evidence replay requesterKeyId") !== context.requesterKeyId
        || bytes32(source.requestId, "solver evidence replay requestId") !== context.requestId
        || integer(source.expiresAt, "solver evidence replay request expiry", 1) !== context.expiresAt
        || context.expiresAt <= now) {
      return false;
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.#database.prepare(`
        UPDATE ${REQUEST_TABLE}
        SET state = 'CONSUMED', consumed_at = ?
        WHERE requester_key_id = ? AND request_id = ? AND request_expires_at = ?
          AND state = 'CLAIMED' AND consumed_at IS NULL
      `).run(now, context.requesterKeyId, context.requestId, context.expiresAt);
      if (Number(updated.changes) !== 1) {
        this.#database.exec("ROLLBACK");
        return false;
      }
      this.#database.exec("COMMIT");
      replayClaims.set(claim, Object.freeze({ ...context, consumed: true }));
      return true;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  status(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, ["now"], "solver evidence replay status");
    const observedAt = integer(source.now, "solver evidence replay status time", 1);
    verifyDatabase(this.#database);
    const row = this.#database.prepare(`
      SELECT
        SUM(CASE WHEN request_expires_at > ? AND state = 'CLAIMED' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN request_expires_at > ? AND state = 'CONSUMED' THEN 1 ELSE 0 END) AS consumed,
        SUM(CASE WHEN request_expires_at <= ? THEN 1 ELSE 0 END) AS expired
      FROM ${REQUEST_TABLE}
    `).get(observedAt, observedAt, observedAt);
    return Object.freeze({
      schema: SOLVER_DAEMON_EVIDENCE_REPLAY_SCHEMA,
      status: "healthy-private-replay-store",
      liveClaimedRequests: Number(row.claimed ?? 0),
      liveConsumedRequests: Number(row.consumed ?? 0),
      expiredRequestsAwaitingCleanup: Number(row.expired ?? 0),
      maximumLiveRequests: this.#maximumLiveRequests,
    });
  }

  get path() {
    return this.#path;
  }

  close() {
    if (this.#closed) return false;
    this.#closed = true;
    this.#database.close();
    replayStores.delete(this);
    return true;
  }
}

Object.freeze(SolverDaemonEvidenceReplayStore.prototype);
Object.freeze(SolverDaemonEvidenceReplayStore);

export function isSolverDaemonEvidenceReplayStore(value) {
  return Boolean(value && replayStores.has(value));
}

export function createSolverDaemonEvidenceProviderReader(input) {
  const source = exactDataRecord(input, READER_KEYS, "solver evidence provider reader");
  if (typeof source.read !== "function") {
    throw new TypeError("solver evidence provider reader requires a read function");
  }
  const readImpl = source.read;
  const reader = Object.freeze({
    read: (request, options) => readImpl(request, options),
  });
  evidenceReaders.add(reader);
  return reader;
}

export function isSolverDaemonEvidenceProviderReader(value) {
  return Boolean(value && evidenceReaders.has(value));
}

function assertRequestPolicy(request, policy, policyDigest) {
  const expected = {
    releaseRecordDigest: policy.releaseRecordDigest,
    evidencePolicyDigest: policyDigest,
    chainId: String(policy.chainId),
    settlementContract: address(policy.settlementContract, "solver evidence provider settlement contract"),
    settlementContractCodeHash: policy.settlementContractCodeHash,
    solver: address(policy.solver, "solver evidence provider solver"),
    direction: policy.direction,
  };
  for (const [field, value] of Object.entries(expected)) {
    const actual = field === "settlementContract" || field === "solver"
      ? address(request.policy[field], `solver evidence request policy ${field}`)
      : String(request.policy[field] ?? "");
    if (actual !== value) throw new Error("solver evidence request belongs to another provider policy");
  }
}

function reservation(value, name) {
  const source = exactDataRecord(value, [
    "reservationBlockHash", "reservationBlockNumber", "reservationId", "reservationTxHash",
  ], name);
  return Object.freeze({
    reservationId: bytes32(source.reservationId, `${name} reservationId`),
    reservationTxHash: bytes32(source.reservationTxHash, `${name} reservationTxHash`),
    reservationBlockNumber: integer(source.reservationBlockNumber, `${name} reservationBlockNumber`, 1),
    reservationBlockHash: bytes32(source.reservationBlockHash, `${name} reservationBlockHash`),
  });
}

function buildRecord({ observation: rawObservation, policy, request, now }) {
  const observation = exactDataRecord(rawObservation, [
    "expiresAt", "observedAt", "proofDigest", "reservation",
  ], "solver evidence provider observation");
  const observedAt = integer(observation.observedAt, "solver evidence provider observedAt", 1);
  const expiresAt = integer(observation.expiresAt, "solver evidence provider expiresAt", 1);
  if (observedAt > now + policy.maxClockSkewSeconds
      || (now > observedAt && now - observedAt > policy.maxEvidenceAgeSeconds)
      || expiresAt <= now || expiresAt > request.expiresAt
      || expiresAt <= observedAt || expiresAt - observedAt > policy.maxEvidenceLifetimeSeconds) {
    throw new Error("solver evidence provider observation is stale, future-dated, or outside authority");
  }
  let observedReservation;
  if (request.kind === "RESERVATION") {
    if (observation.reservation === null) {
      throw new Error("solver evidence provider did not observe the requested reservation");
    }
    observedReservation = reservation(observation.reservation, "solver evidence provider reservation");
  } else {
    if (observation.reservation !== null) {
      throw new Error("solver evidence provider cannot replace the request reservation");
    }
    observedReservation = request.settlement.reservation;
  }
  const action = request.action;
  const record = Object.freeze({
    schema: SOLVER_DAEMON_EVIDENCE_SCHEMA,
    kind: request.kind,
    releaseRecordDigest: policy.releaseRecordDigest,
    evidencePolicyDigest: solverDaemonEvidencePolicyDigest(policy),
    chainId: policy.chainId,
    settlementContract: policy.settlementContract,
    settlementContractCodeHash: policy.settlementContractCodeHash,
    solver: policy.solver,
    direction: policy.direction,
    settlementId: request.settlement.settlementId,
    reservationId: observedReservation.reservationId,
    reservationTxHash: observedReservation.reservationTxHash,
    reservationBlockNumber: observedReservation.reservationBlockNumber,
    reservationBlockHash: observedReservation.reservationBlockHash,
    actionId: action?.actionId ?? SOLVER_DAEMON_ZERO_BYTES32,
    intentDigest: request.settlement.intentDigest,
    packetResponseDigest: action?.packetResponseDigest ?? SOLVER_DAEMON_ZERO_BYTES32,
    quoteExpiresAt: action?.quoteExpiresAt ?? 0,
    lightningActionDeadline: action?.lightningActionDeadline ?? 0,
    evmRefundAt: action?.evmRefundAt ?? 0,
    terminalState: request.terminalState,
    proofDigest: bytes32(observation.proofDigest, "solver evidence provider proof digest"),
    observedAt,
    expiresAt,
  });
  buildSolverDaemonEvidenceApproval({ record, policy });
  return record;
}

async function boundedRequestJson(request, maximumBytes) {
  const contentType = String(request.headers?.get?.("content-type") ?? "")
    .split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("solver evidence provider content type is invalid");
  const cacheControl = String(request.headers.get("cache-control") ?? "").toLowerCase();
  if (!cacheControl.split(",").some((value) => value.trim() === "no-store")) {
    throw new Error("solver evidence provider request must disable storage");
  }
  const contentEncoding = String(request.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (contentEncoding !== "identity") {
    throw new Error("solver evidence provider request content encoding is invalid");
  }
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null && !/^[0-9]+$/.test(declaredHeader)) {
    throw new Error("solver evidence provider content length is invalid");
  }
  if (Number(declaredHeader ?? 0) > maximumBytes) {
    throw new Error("solver evidence provider request is too large");
  }
  if (!request.body) throw new Error("solver evidence provider request body is empty");
  const reader = request.body.getReader();
  const signal = request.signal;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (signal?.aborted) cancel();
  else signal?.addEventListener?.("abort", cancel, { once: true });
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new Error("solver evidence provider request is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener?.("abort", cancel);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("solver evidence provider request is malformed");
  }
}

function jsonResponse(status, body) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  return new Response(bytes, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-length": String(bytes.length),
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
  });
}

function requestShape(value) {
  return value instanceof Request;
}

export async function createSolverDaemonEvidenceProviderRoute(input) {
  const source = exactDataRecord(input, ROUTE_KEYS, "solver evidence provider route");
  const providerRole = role(source.role);
  const policy = snapshotPlainData(source.policy, "solver evidence provider policy");
  const policyDigest = solverDaemonEvidencePolicyDigest(policy);
  if (!isSolverDaemonEvidenceReplayStore(source.replayStore)) {
    throw new TypeError("solver evidence provider requires the concrete durable replay store");
  }
  if (!isSolverDaemonEvidenceProviderReader(source.evidenceReader)) {
    throw new TypeError("solver evidence provider requires the concrete evidence reader");
  }
  if (!source.signer || typeof source.signer !== "object"
      || typeof source.signer.getAddress !== "function"
      || typeof source.signer.signTypedData !== "function") {
    throw new TypeError("solver evidence provider requires a typed-data signer");
  }
  const signerAddress = address(await source.signer.getAddress(), "solver evidence provider signer");
  if (signerAddress !== address(policy.approvers[providerRole], "solver evidence provider policy signer")) {
    throw new Error("solver evidence provider signer does not match its policy role");
  }
  let requesterPublicKey;
  try {
    requesterPublicKey = source.requesterPublicKey?.type === "public"
      ? source.requesterPublicKey
      : createPublicKey(source.requesterPublicKey);
  } catch {
    throw new TypeError("solver evidence provider requester public key is invalid");
  }
  if (requesterPublicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("solver evidence provider requester public key must be Ed25519");
  }
  const expectedRequesterKeyId = keyId(
    source.expectedRequesterKeyId,
    "solver evidence provider expected requester key ID",
  );
  const maximumRequestBytes = integer(
    source.maximumRequestBytes,
    "solver evidence provider maximum request bytes",
    1_024,
    MAX_REQUEST_BYTES,
  );
  if (typeof source.nowSeconds !== "function") {
    throw new TypeError("solver evidence provider requires a clock");
  }
  const nowSeconds = source.nowSeconds;
  const replayStore = source.replayStore;
  const readEvidence = source.evidenceReader.read;
  const signTypedData = source.signer.signTypedData.bind(source.signer);

  const handle = async (webRequest) => {
    try {
      if (!requestShape(webRequest) || webRequest.method !== "POST") {
        throw new Error("solver evidence provider request method is invalid");
      }
      const url = new URL(webRequest.url);
      if (url.protocol !== "https:" || (url.port && url.port !== "443")
          || url.username || url.password
          || url.pathname !== "/v1/solver-daemon-evidence" || url.search || url.hash) {
        throw new Error("solver evidence provider request target is invalid");
      }
      const rawEnvelope = await boundedRequestJson(webRequest, maximumRequestBytes);
      const requestEnvelope = snapshotPlainData(rawEnvelope, "solver evidence provider request envelope");
      const verifiedAt = integer(nowSeconds(), "solver evidence provider verification time", 1);
      const request = verifySolverDaemonEvidenceRequest({
        envelope: requestEnvelope,
        requesterPublicKey,
        expectedRequesterKeyId,
        now: verifiedAt,
        maxClockSkewSeconds: policy.maxClockSkewSeconds,
      });
      assertRequestPolicy(request, policy, policyDigest);
      const claim = replayStore.claim({
        requesterKeyId: request.requesterKeyId,
        requestId: request.requestId,
        expiresAt: request.expiresAt,
        now: verifiedAt,
      });
      if (!claim) throw new Error("solver evidence provider request was already claimed");
      if (webRequest.signal?.aborted) throw new Error("solver evidence provider request was aborted");
      const rawObservation = await readEvidence(request, { signal: webRequest.signal });
      if (webRequest.signal?.aborted) throw new Error("solver evidence provider request was aborted");
      const responseAt = integer(nowSeconds(), "solver evidence provider response time", 1);
      const record = buildRecord({
        observation: snapshotPlainData(rawObservation, "solver evidence provider reader result"),
        policy,
        request,
        now: responseAt,
      });
      const signingPayload = buildSolverDaemonEvidenceApproval({ record, policy });
      const approval = Object.freeze({
        role: providerRole,
        signer: signerAddress,
        signature: await signTypedData(
          signingPayload.domain,
          signingPayload.types,
          signingPayload.message,
        ),
      });
      if (webRequest.signal?.aborted) throw new Error("solver evidence provider request was aborted");
      const signedAt = integer(nowSeconds(), "solver evidence provider signed response time", 1);
      if (record.expiresAt <= signedAt || request.expiresAt <= signedAt) {
        throw new Error("solver evidence provider response expired during signing");
      }
      const response = await buildSolverDaemonEvidenceRouteResponse({
        requestEnvelope,
        requesterPublicKey,
        expectedRequesterKeyId,
        consumeRequest: (descriptor) => replayStore.consume(claim, {
          ...descriptor,
          now: integer(nowSeconds(), "solver evidence provider consumption time", 1),
        }),
        record,
        policy,
        approval,
        now: signedAt,
      });
      return jsonResponse(200, response);
    } catch {
      return jsonResponse(400, { error: "solver evidence request rejected" });
    }
  };
  const route = Object.freeze({
    handle,
    status: (statusInput) => replayStore.status(statusInput),
  });
  evidenceRoutes.add(route);
  return route;
}

export function isSolverDaemonEvidenceProviderRoute(value) {
  return Boolean(value && evidenceRoutes.has(value));
}
