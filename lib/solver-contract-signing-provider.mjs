import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";
import { SigningKey, computeAddress } from "ethers";
import {
  buildSignedSolverContractSigningResponse,
  solverContractSigningResponseDigest,
  verifiedSolverContractSigningRequest,
  verifiedSolverContractSigningResponse,
  verifySolverContractSigningRequest,
} from "./solver-contract-signing-transport.mjs";
import {
  solverEndpointPublicKeyDigest,
  verifiedSolverEndpointTransportBinding,
} from "./solver-capability.mjs";

export const SOLVER_CONTRACT_SIGNING_PROVIDER_STORE_SCHEMA =
  "treeswap.solver-contract-signing-provider-store.v1";

const EVM_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const MAXIMUM_REQUEST_BYTES = 32_768;
const MAXIMUM_LIVE_REQUESTS = 4_096;
const MAXIMUM_IN_FLIGHT_REQUESTS = 128;
const META_TABLE = "solver_contract_signing_meta";
const REQUEST_TABLE = "solver_contract_signing_requests";
const META_SQL = `CREATE TABLE ${META_TABLE} (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT`;
const REQUEST_SQL = `CREATE TABLE ${REQUEST_TABLE} (
  request_id TEXT PRIMARY KEY NOT NULL,
  request_digest TEXT NOT NULL,
  contract_intent_digest TEXT NOT NULL UNIQUE,
  settlement_id TEXT NOT NULL UNIQUE,
  capability_digest TEXT NOT NULL,
  requester_public_key_digest TEXT NOT NULL,
  solver TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lightning-to-bit', 'bit-to-lightning')),
  request_expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CLAIMED', 'READY')),
  claimed_at INTEGER NOT NULL,
  lease_epoch INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  response_json TEXT,
  response_digest TEXT,
  response_expires_at INTEGER,
  ready_at INTEGER,
  CHECK (request_expires_at > claimed_at),
  CHECK (lease_epoch > 0),
  CHECK (lease_expires_at > claimed_at),
  CHECK (
    (state = 'CLAIMED' AND response_json IS NULL AND response_digest IS NULL
      AND response_expires_at IS NULL AND ready_at IS NULL)
    OR
    (state = 'READY' AND response_json IS NOT NULL AND response_digest IS NOT NULL
      AND response_expires_at IS NOT NULL AND ready_at IS NOT NULL
      AND response_expires_at > ready_at AND request_expires_at >= response_expires_at)
  ),
  CHECK (response_json IS NULL OR length(CAST(response_json AS BLOB)) <= 32768)
) STRICT`;
const STORE_TOKEN = Symbol("TreeSwap solver contract signing store");
const STORES = new WeakSet();
const LEASES = new WeakMap();
const ROUTES = new WeakSet();
const SIGNERS = new WeakMap();
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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

function sql(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "");
}

function storedInteger(value, name) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} is not canonical`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`${name} is outside the safe range`);
  }
  return parsed;
}

function verifyDatabase(database, { requireSchema = true } = {}) {
  const quick = database.prepare("PRAGMA quick_check").all();
  if (quick.length !== 1 || Object.values(quick[0]).length !== 1
      || Object.values(quick[0])[0] !== "ok") {
    throw new Error("solver contract signing database quick check failed");
  }
  const objects = database.prepare(`
    SELECT name, sql, type FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  if (objects.length === 0 && !requireSchema) return;
  if (objects.length !== 2
      || objects[0].name !== META_TABLE || objects[0].type !== "table"
      || objects[1].name !== REQUEST_TABLE || objects[1].type !== "table"
      || sql(objects[0].sql) !== sql(META_SQL)
      || sql(objects[1].sql) !== sql(REQUEST_SQL)) {
    throw new Error("solver contract signing database layout is unsupported");
  }
  const meta = database.prepare(`SELECT key, value FROM ${META_TABLE} ORDER BY key`).all();
  if (meta.length !== 2 || meta[0].key !== "clock_high_water" || meta[1].key !== "schema"
      || meta[1].value !== SOLVER_CONTRACT_SIGNING_PROVIDER_STORE_SCHEMA) {
    throw new Error("solver contract signing database schema is unsupported");
  }
  storedInteger(meta[0].value, "solver contract signing clock high-water mark");
}

function storedClock(database) {
  const row = database.prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'clock_high_water'`).get();
  if (!row) throw new Error("solver contract signing clock is missing");
  return storedInteger(row.value, "solver contract signing clock high-water mark");
}

function advanceClock(database, now) {
  const previous = storedClock(database);
  if (now < previous) throw new Error("solver contract signing provider clock regressed");
  if (now === previous) return;
  const updated = database.prepare(`
    UPDATE ${META_TABLE} SET value = ? WHERE key = 'clock_high_water' AND value = ?
  `).run(String(now), String(previous));
  if (Number(updated.changes) !== 1) throw new Error("solver contract signing clock update failed");
}

async function privateDatabasePath(raw) {
  if (typeof raw !== "string" || !isAbsolute(raw) || raw.includes("\0") || raw.length > 4_096) {
    throw new TypeError("solver contract signing database path must be bounded and absolute");
  }
  const path = resolve(raw);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentState = await lstat(parent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (parentState.isSymbolicLink() || !parentState.isDirectory()
      || (parentState.mode & 0o077) !== 0
      || (currentUid !== null && parentState.uid !== currentUid)) {
    throw new Error("solver contract signing database parent must be private");
  }
  const canonicalPath = join(await realpath(parent), basename(path));
  try {
    const state = await lstat(canonicalPath);
    if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0
        || (currentUid !== null && state.uid !== currentUid)) {
      throw new Error("solver contract signing database must be a private regular file");
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

function leaseResult(store, row, recovery) {
  const lease = Object.freeze({
    requestId: row.request_id,
    requestDigest: row.request_digest,
    recovery,
    servedAt: Number(row.claimed_at),
  });
  LEASES.set(lease, Object.freeze({
    store,
    requestId: row.request_id,
    requestDigest: row.request_digest,
    leaseEpoch: Number(row.lease_epoch),
    requestExpiresAt: Number(row.request_expires_at),
    consumed: false,
  }));
  return Object.freeze({ status: "LEASE", lease });
}

export class SolverContractSigningProviderStore {
  #database;
  #path;
  #maximumLiveRequests;
  #closed = false;

  constructor(database, path, maximumLiveRequests, token) {
    if (token !== STORE_TOKEN) throw new TypeError("solver contract signing stores require the factory");
    this.#database = database;
    this.#path = path;
    this.#maximumLiveRequests = maximumLiveRequests;
    STORES.add(this);
    Object.freeze(this);
  }

  static async open(input) {
    const source = exactRecord(input, [
      "allowMemory",
      "initialize",
      "maximumLiveRequests",
      "path",
    ], "solver contract signing storage options");
    const maximum = integer(
      source.maximumLiveRequests,
      "solver contract signing maximum live requests",
      1,
      MAXIMUM_LIVE_REQUESTS,
    );
    let resolvedPath;
    if (source.path === ":memory:") {
      if (source.allowMemory !== true || source.initialize !== true) {
        throw new Error("solver contract signing memory storage is initialized test-only storage");
      }
      resolvedPath = path;
    } else {
      if (source.allowMemory !== false
          || (source.initialize !== true && source.initialize !== false)) {
        throw new TypeError("solver contract signing storage options are invalid");
      }
      const resolved = await privateDatabasePath(source.path);
      if (source.initialize && resolved.exists) {
        throw new Error("solver contract signing database already exists");
      }
      if (!source.initialize && !resolved.exists) {
        throw new Error("solver contract signing database is missing");
      }
      resolvedPath = resolved.path;
      if (source.initialize) {
        const handle = await open(resolvedPath, "wx", 0o600);
        await handle.close();
      }
    }
    let database;
    try {
      database = new DatabaseSync(resolvedPath, { timeout: 5_000 });
      database.exec("PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
      if (resolvedPath !== ":memory:") database.exec("PRAGMA journal_mode=WAL;");
      verifyDatabase(database, { requireSchema: false });
      const count = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
      `).get().count);
      if (count === 0 && !source.initialize) {
        throw new Error("solver contract signing database is uninitialized");
      }
      if (count === 0) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(`${META_SQL}; ${REQUEST_SQL};`);
          database.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES ('schema', ?)`).run(
            SOLVER_CONTRACT_SIGNING_PROVIDER_STORE_SCHEMA,
          );
          database.prepare(
            `INSERT INTO ${META_TABLE} (key, value) VALUES ('clock_high_water', '0')`,
          ).run();
          database.exec("COMMIT");
        } catch (error) {
          try { database.exec("ROLLBACK"); } catch {}
          throw error;
        }
      }
      verifyDatabase(database);
      if (resolvedPath !== ":memory:") await secureDatabaseFiles(resolvedPath);
      return new SolverContractSigningProviderStore(database, resolvedPath, maximum, STORE_TOKEN);
    } catch (error) {
      try { database?.close(); } catch {}
      throw error;
    }
  }

  observeTime(now) {
    if (this.#closed) throw new Error("solver contract signing store is closed");
    const observedAt = integer(now, "solver contract signing observation time", 1);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database);
      advanceClock(this.#database, observedAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  begin(request, input) {
    if (this.#closed) throw new Error("solver contract signing store is closed");
    verifiedSolverContractSigningRequest(request);
    const source = exactRecord(input, ["leaseSeconds", "now"], "solver contract signing claim");
    const observedAt = integer(source.now, "solver contract signing claim time", 1);
    const leaseDuration = integer(source.leaseSeconds, "solver contract signing lease", 1, 15);
    if (request.expiresAt <= observedAt) throw new Error("solver contract signing request is expired");
    const leaseExpiresAt = Math.min(request.expiresAt, observedAt + leaseDuration);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database);
      advanceClock(this.#database, observedAt);
      this.#database.prepare(`DELETE FROM ${REQUEST_TABLE} WHERE request_expires_at <= ?`).run(observedAt);
      let row = this.#database.prepare(`SELECT * FROM ${REQUEST_TABLE} WHERE request_id = ?`).get(request.requestId);
      if (row) {
        if (row.request_digest !== request.requestDigest) {
          this.#database.exec("COMMIT");
          return Object.freeze({ status: "CONFLICT" });
        }
        if (row.state === "READY") {
          const responseJson = row.response_json;
          if (solverContractSigningResponseDigest(JSON.parse(responseJson)) !== row.response_digest) {
            throw new Error("solver contract signing cached response changed");
          }
          this.#database.exec("COMMIT");
          return Number(row.response_expires_at) <= observedAt
            ? Object.freeze({ status: "EXPIRED" })
            : Object.freeze({ status: "READY", responseJson });
        }
        if (Number(row.lease_expires_at) > observedAt) {
          this.#database.exec("COMMIT");
          return Object.freeze({ status: "PENDING" });
        }
        if (Math.min(Number(row.request_expires_at), Number(row.claimed_at) + 15) <= observedAt) {
          this.#database.exec("COMMIT");
          return Object.freeze({ status: "EXPIRED" });
        }
        const updated = this.#database.prepare(`
          UPDATE ${REQUEST_TABLE}
          SET lease_epoch = lease_epoch + 1, lease_expires_at = ?
          WHERE request_id = ? AND request_digest = ? AND state = 'CLAIMED' AND lease_expires_at <= ?
        `).run(leaseExpiresAt, request.requestId, request.requestDigest, observedAt);
        if (Number(updated.changes) !== 1) throw new Error("solver contract signing recovery lease raced");
        row = this.#database.prepare(`SELECT * FROM ${REQUEST_TABLE} WHERE request_id = ?`).get(request.requestId);
        this.#database.exec("COMMIT");
        return leaseResult(this, row, true);
      }
      const duplicate = this.#database.prepare(`
        SELECT request_id FROM ${REQUEST_TABLE}
        WHERE contract_intent_digest = ? OR settlement_id = ?
        LIMIT 1
      `).get(request.contractIntentDigest, request.settlementId);
      if (duplicate) {
        this.#database.exec("COMMIT");
        return Object.freeze({ status: "CONFLICT" });
      }
      const live = Number(this.#database.prepare(`SELECT COUNT(*) AS count FROM ${REQUEST_TABLE}`).get().count);
      if (live >= this.#maximumLiveRequests) throw new Error("solver contract signing store reached its bound");
      this.#database.prepare(`
        INSERT INTO ${REQUEST_TABLE} (
          request_id, request_digest, contract_intent_digest, settlement_id, capability_digest,
          requester_public_key_digest, solver, direction, request_expires_at, state, claimed_at,
          lease_epoch, lease_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, 1, ?)
      `).run(
        request.requestId,
        request.requestDigest,
        request.contractIntentDigest,
        request.settlementId,
        request.capabilityDigest,
        request.requesterPublicKeyDigest,
        request.payload.message.solver,
        request.direction,
        request.expiresAt,
        observedAt,
        leaseExpiresAt,
      );
      row = this.#database.prepare(`SELECT * FROM ${REQUEST_TABLE} WHERE request_id = ?`).get(request.requestId);
      this.#database.exec("COMMIT");
      return leaseResult(this, row, false);
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  complete(lease, response, now) {
    if (this.#closed) throw new Error("solver contract signing store is closed");
    verifiedSolverContractSigningResponse(response);
    const context = LEASES.get(lease);
    if (!context || context.store !== this || context.consumed) {
      throw new TypeError("solver contract signing lease provenance is invalid");
    }
    const observedAt = integer(now, "solver contract signing completion time", 1);
    const responseJson = JSON.stringify(response);
    if (Buffer.byteLength(responseJson) > MAXIMUM_REQUEST_BYTES) {
      throw new RangeError("solver contract signing response is too large");
    }
    const responseDigest = solverContractSigningResponseDigest(response);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database);
      advanceClock(this.#database, observedAt);
      const updated = this.#database.prepare(`
        UPDATE ${REQUEST_TABLE}
        SET state = 'READY', response_json = ?, response_digest = ?, response_expires_at = ?, ready_at = ?
        WHERE request_id = ? AND request_digest = ? AND state = 'CLAIMED'
          AND lease_epoch = ? AND lease_expires_at > ? AND request_expires_at >= ?
      `).run(
        responseJson,
        responseDigest,
        response.expiresAt,
        observedAt,
        context.requestId,
        context.requestDigest,
        context.leaseEpoch,
        observedAt,
        response.expiresAt,
      );
      if (Number(updated.changes) !== 1) {
        this.#database.exec("ROLLBACK");
        return false;
      }
      this.#database.exec("COMMIT");
      LEASES.set(lease, Object.freeze({ ...context, consumed: true }));
      return true;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  close() {
    if (this.#closed) return false;
    this.#closed = true;
    this.#database.close();
    STORES.delete(this);
    return true;
  }

  status() {
    if (this.#closed) throw new Error("solver contract signing store is closed");
    verifyDatabase(this.#database);
    const counts = this.#database.prepare(`
      SELECT state, COUNT(*) AS count FROM ${REQUEST_TABLE} GROUP BY state ORDER BY state
    `).all();
    return Object.freeze({
      schema: "treeswap.solver-contract-signing-provider-store-status.v1",
      state: "open",
      durable: this.#path !== ":memory:",
      clockHighWater: storedClock(this.#database),
      claimedRequests: Number(counts.find(({ state }) => state === "CLAIMED")?.count ?? 0),
      readyRequests: Number(counts.find(({ state }) => state === "READY")?.count ?? 0),
      privateKeyPersisted: false,
      fundingAuthorization: false,
    });
  }
}

Object.freeze(SolverContractSigningProviderStore.prototype);
Object.freeze(SolverContractSigningProviderStore);

function buildSigner(privateKey, expectedSolver, mode) {
  if (typeof privateKey !== "string" || !EVM_PRIVATE_KEY.test(privateKey)) {
    throw new TypeError("solver contract signing EVM key must be exact private key bytes");
  }
  const key = new SigningKey(privateKey);
  const solver = computeAddress(key.publicKey).toLowerCase();
  if (expectedSolver !== undefined
      && (typeof expectedSolver !== "string" || expectedSolver.toLowerCase() !== solver)) {
    throw new Error("solver contract signing EVM key does not match expected solver");
  }
  const signer = Object.freeze({
    status() {
      if (this !== signer || !SIGNERS.has(signer)) {
        throw new TypeError("solver contract signer lacks provenance");
      }
      return Object.freeze({
        schema: "treeswap.solver-contract-signer-status.v1",
        mode,
        solver,
        exportsPrivateKey: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
  });
  SIGNERS.set(signer, Object.freeze({ key, solver }));
  return signer;
}

export function createTestSolverContractSigner(input) {
  const source = exactRecord(input, ["expectedSolver", "privateKey"], "test solver signer");
  return buildSigner(source.privateKey, source.expectedSolver, "injected-test");
}

export async function loadSolverContractSigner(input) {
  const source = exactRecord(input, ["expectedSolver", "path"], "solver signer file");
  if (typeof source.path !== "string" || !isAbsolute(source.path)
      || source.path.includes("\0") || source.path.length > 4_096) {
    throw new TypeError("solver signer key path must be bounded and absolute");
  }
  const requested = resolve(source.path);
  const canonicalParent = await realpath(dirname(requested));
  const parent = await lstat(canonicalParent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0
      || (currentUid !== null && parent.uid !== currentUid)) {
    throw new Error("solver signer key parent must be private and owner-controlled");
  }
  const path = join(canonicalParent, basename(requested));
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o077) !== 0
      || before.size > 67 || (currentUid !== null && before.uid !== currentUid)) {
    throw new Error("solver signer key must be a private bounded regular file");
  }
  if (await realpath(path) !== path) throw new Error("solver signer key changed path");
  const contents = await readFile(path, "utf8");
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) {
    throw new Error("solver signer key changed while loading");
  }
  if (!/^(?:0x)?[0-9a-fA-F]{64}\n?$/.test(contents)) {
    throw new Error("solver signer key file is not exact private key bytes");
  }
  const key = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return buildSigner(key.startsWith("0x") ? key : `0x${key}`, source.expectedSolver, "private-file");
}

async function boundedRequestJson(request, maximumBytes, signal) {
  const contentType = request.headers.get("content-type");
  const contentEncoding = request.headers.get("content-encoding");
  const transferEncoding = request.headers.get("transfer-encoding");
  const contentLength = request.headers.get("content-length");
  if (contentType !== "application/json" || contentEncoding !== null || transferEncoding !== null) {
    throw new Error("solver contract signing request framing is invalid");
  }
  if (contentLength !== null && (!/^[1-9][0-9]*$/.test(contentLength)
      || Number(contentLength) > maximumBytes)) {
    throw new Error("solver contract signing content length is invalid");
  }
  if (!request.body) throw new Error("solver contract signing request body is missing");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error("solver contract signing request is too large");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (size === 0 || (contentLength !== null && Number(contentLength) !== size)) {
    throw new Error("solver contract signing request length changed");
  }
  const bytes = Buffer.concat(chunks.map((value) => Buffer.from(value)));
  const text = FATAL_UTF8.decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) throw new Error("solver contract signing request contains a BOM");
  return JSON.parse(text);
}

function jsonResponse(status, body, extra = {}) {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(json, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
      "referrer-policy": "no-referrer",
      ...extra,
    },
  });
}

export function createSolverContractSigningProviderRoute(input) {
  const source = exactRecord(input, [
    "capability",
    "endpointPrivateKey",
    "maximumInFlightRequests",
    "maximumRequestBytes",
    "nowSeconds",
    "requestTimeoutMs",
    "requesterPublicKey",
    "signer",
    "store",
  ], "solver contract signing provider route");
  if (!STORES.has(source.store)) throw new TypeError("solver contract signing route requires its durable store");
  if (typeof source.nowSeconds !== "function") throw new TypeError("solver contract signing route requires a clock");
  const binding = verifiedSolverEndpointTransportBinding(source.capability);
  const authority = Object.freeze({
    capabilityDigest: binding.capabilityDigest,
    direction: binding.direction,
    endpointPublicKeyDigest: binding.endpointPublicKeyDigest,
    expiresAt: binding.expiresAt,
    settlementContract: binding.settlementContract,
    settlementContractCodeHash: binding.settlementContractCodeHash,
    solver: binding.solverId,
  });
  const endpointPrivateKey = source.endpointPrivateKey?.type === "private"
    ? source.endpointPrivateKey
    : createPrivateKey(source.endpointPrivateKey);
  if (endpointPrivateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("solver contract signing endpoint key must be Ed25519");
  }
  const endpointDigest = solverEndpointPublicKeyDigest(
    createPublicKey(endpointPrivateKey).export({ format: "pem", type: "spki" }).toString(),
  );
  if (endpointDigest !== authority.endpointPublicKeyDigest) {
    throw new Error("solver contract signing endpoint key does not match authority");
  }
  const signer = SIGNERS.get(source.signer);
  if (!signer || signer.solver !== authority.solver.toLowerCase()) {
    throw new Error("solver contract signer does not match authority");
  }
  const requesterPublicKey = source.requesterPublicKey?.type === "public"
    ? source.requesterPublicKey
    : createPublicKey(source.requesterPublicKey);
  if (requesterPublicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("solver contract signing requester key must be Ed25519");
  }
  const origin = binding.endpointOrigin;
  const maximumInFlightRequests = integer(
    source.maximumInFlightRequests,
    "solver contract signing maximum in-flight requests",
    1,
    MAXIMUM_IN_FLIGHT_REQUESTS,
  );
  const maximumRequestBytes = integer(
    source.maximumRequestBytes,
    "solver contract signing maximum request bytes",
    1_024,
    MAXIMUM_REQUEST_BYTES,
  );
  const requestTimeoutMs = integer(source.requestTimeoutMs, "solver contract signing timeout", 100, 10_000);
  const nowSeconds = source.nowSeconds;
  const store = source.store;
  let inFlightRequests = 0;
  const handle = async (webRequest) => {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    let callerSignal = null;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let claimAttempted = false;
    let admitted = false;
    try {
      if (!(webRequest instanceof Request) || webRequest.method !== "POST") throw new Error();
      callerSignal = webRequest.signal;
      callerSignal.addEventListener("abort", abortFromCaller, { once: true });
      const url = new URL(webRequest.url);
      if (url.origin !== origin || url.pathname !== "/v1/sign-contract-intent"
          || url.search || url.hash || url.username || url.password) throw new Error();
      if (inFlightRequests >= maximumInFlightRequests) {
        return jsonResponse(429, { error: "solver signing busy" }, { "retry-after": "1" });
      }
      inFlightRequests += 1;
      admitted = true;
      const startedAt = integer(nowSeconds(), "solver contract signing request start", 1);
      store.observeTime(startedAt);
      const raw = await boundedRequestJson(webRequest, maximumRequestBytes, controller.signal);
      const verifiedAt = integer(nowSeconds(), "solver contract signing verification time", 1);
      const request = verifySolverContractSigningRequest({
        request: raw,
        authority: {
          capabilityDigest: authority.capabilityDigest,
          direction: authority.direction,
          expiresAt: authority.expiresAt,
          settlementContract: authority.settlementContract,
          settlementContractCodeHash: authority.settlementContractCodeHash,
          solver: authority.solver,
        },
        requesterPublicKey,
        now: verifiedAt,
      });
      claimAttempted = true;
      const claim = store.begin(request, { now: verifiedAt, leaseSeconds: 10 });
      if (claim.status === "READY") return jsonResponse(200, claim.responseJson);
      if (claim.status === "PENDING") return jsonResponse(425, { error: "solver signing pending" }, { "retry-after": "1" });
      if (claim.status !== "LEASE") return jsonResponse(400, { error: "solver signing rejected" });
      if (controller.signal.aborted) throw new Error();
      const servedAt = claim.lease.servedAt;
      integer(servedAt, "solver contract signing response time", request.requestedAt);
      const response = buildSignedSolverContractSigningResponse({
        request,
        solverSignature: signer.key.sign(request.contractIntentDigest).serialized,
        endpointPrivateKey,
        servedAt,
        expiresAt: Math.min(request.expiresAt, servedAt + 15),
      });
      if (controller.signal.aborted || !store.complete(claim.lease, response, servedAt)) throw new Error();
      return jsonResponse(200, JSON.stringify(response));
    } catch {
      return claimAttempted
        ? jsonResponse(503, { error: "solver signing recovery required" }, { "retry-after": "1" })
        : jsonResponse(400, { error: "solver signing rejected" });
    } finally {
      if (admitted) inFlightRequests -= 1;
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
      controller.abort();
    }
  };
  const route = Object.freeze({
    handle,
    status() {
      if (this !== route || !ROUTES.has(route)) {
        throw new TypeError("solver contract signing provider route lacks provenance");
      }
      return Object.freeze({
        schema: "treeswap.solver-contract-signing-provider-status.v1",
        state: "repository-only",
        durableReplay: true,
        inFlightRequests,
        maximumInFlightRequests,
        networkListener: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
  });
  ROUTES.add(route);
  return route;
}
