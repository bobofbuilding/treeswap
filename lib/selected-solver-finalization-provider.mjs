import {
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";
import { getAddress } from "ethers";
import { invoiceDigest } from "./lnd-rest-client.mjs";
import {
  buildSignedSelectedSolverFinalizationResponse,
  selectedSolverFinalizationResponseDigest,
  verifySelectedSolverFinalizationRequest,
} from "./selected-solver-finalization-transport.mjs";
import { solverEndpointPublicKeyDigest } from "./solver-capability.mjs";
import { publicSolverEndpointOrigin } from "./solver-endpoint-transport.mjs";

export const SELECTED_SOLVER_FINALIZATION_PROVIDER_STORE_SCHEMA =
  "treeswap.selected-solver-finalization-provider-store.v1";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const MAXIMUM_REQUEST_BYTES = 65_536;
const MAXIMUM_LIVE_REQUESTS = 4_096;
const MAXIMUM_REQUEST_LIFETIME_SECONDS = 30;
const STORE_KEYS = Object.freeze(["allowMemory", "initialize", "maximumLiveRequests", "path"]);
const BEGIN_KEYS = Object.freeze([
  "capabilityDigest",
  "direction",
  "expiresAt",
  "leaseSeconds",
  "now",
  "requestDigest",
  "requestId",
  "requesterPublicKeyDigest",
  "solverId",
]);
const COMPLETE_KEYS = Object.freeze([
  "now",
  "responseDigest",
  "responseExpiresAt",
  "responseJson",
]);
const FINALIZER_KEYS = Object.freeze(["finalize", "recover"]);
const ROUTE_KEYS = Object.freeze([
  "authority",
  "endpointPrivateKey",
  "finalizer",
  "maximumRequestBytes",
  "nowSeconds",
  "providerOrigin",
  "recoveryLeaseSeconds",
  "requestTimeoutMs",
  "store",
]);
const META_TABLE = "selected_solver_finalization_meta";
const REQUEST_TABLE = "selected_solver_finalization_requests";
const META_SQL = `CREATE TABLE ${META_TABLE} (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT`;
const REQUEST_SQL = `CREATE TABLE ${REQUEST_TABLE} (
  request_id TEXT PRIMARY KEY NOT NULL,
  request_digest TEXT NOT NULL,
  requester_public_key_digest TEXT NOT NULL,
  capability_digest TEXT NOT NULL,
  solver_id TEXT NOT NULL,
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
  CHECK (response_json IS NULL OR length(CAST(response_json AS BLOB)) <= 65536)
) STRICT`;
const STORE_TOKEN = Symbol("TreeSwap selected solver finalization provider store");
const STORES = new WeakSet();
const LEASES = new WeakMap();
const FINALIZERS = new WeakMap();
const ROUTES = new WeakSet();
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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
  const result = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotJson(value, name, depth = 0, counter = { value: 0 }) {
  counter.value += 1;
  if (depth > 8 || counter.value > 512) throw new RangeError(`${name} is outside bounded JSON policy`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 16_384) throw new RangeError(`${name} contains an oversized string`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== "object") throw new TypeError(`${name} contains unsupported data`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
      throw new TypeError(`${name} must be a bounded plain array`);
    }
    const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.size
        || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
      throw new TypeError(`${name} array fields are not exact`);
    }
    return Object.freeze(value.map((item, index) => snapshotJson(
      item,
      `${name}[${index}]`,
      depth + 1,
      counter,
    )));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must contain only plain data objects`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} object fields are outside policy`);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name}.${key} must be an enumerable data property`);
    }
    result[key] = snapshotJson(descriptor.value, `${name}.${key}`, depth + 1, counter);
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

function address(value, name) {
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function direction(value) {
  const raw = String(value ?? "");
  if (!DIRECTIONS.has(raw)) throw new RangeError("selected-solver provider direction is unsupported");
  return raw;
}

function sql(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "");
}

function storedInteger(value, name) {
  const raw = String(value ?? "");
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} is not canonical`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== raw) {
    throw new Error(`${name} is outside the safe range`);
  }
  return parsed;
}

function storedClock(database) {
  const row = database.prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'clock_high_water'`).get();
  if (!row) throw new Error("selected-solver provider clock high-water mark is missing");
  return storedInteger(row.value, "selected-solver provider clock high-water mark");
}

function advanceClock(database, now) {
  const previous = storedClock(database);
  if (now < previous) throw new Error("selected-solver provider clock regressed");
  if (now === previous) return;
  const updated = database.prepare(`
    UPDATE ${META_TABLE} SET value = ? WHERE key = 'clock_high_water' AND value = ?
  `).run(String(now), String(previous));
  if (Number(updated.changes) !== 1) throw new Error("selected-solver provider clock update failed");
}

function verifyDatabase(database, { requireSchema = true } = {}) {
  const quick = database.prepare("PRAGMA quick_check").all();
  if (quick.length !== 1 || Object.values(quick[0]).length !== 1
      || Object.values(quick[0])[0] !== "ok") {
    throw new Error("selected-solver provider database quick check failed");
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
    throw new Error("selected-solver provider database layout is unsupported");
  }
  const meta = database.prepare(`SELECT key, value FROM ${META_TABLE} ORDER BY key`).all();
  if (meta.length !== 2 || meta[0].key !== "clock_high_water"
      || meta[1].key !== "schema"
      || meta[1].value !== SELECTED_SOLVER_FINALIZATION_PROVIDER_STORE_SCHEMA) {
    throw new Error("selected-solver provider database schema is unsupported");
  }
  storedInteger(meta[0].value, "selected-solver provider clock high-water mark");
}

async function privateDatabasePath(rawPath) {
  if (!isAbsolute(rawPath) || rawPath.includes("\0") || rawPath.length > 4_096) {
    throw new TypeError("selected-solver provider database path must be a bounded absolute path");
  }
  const requested = resolve(rawPath);
  const parent = dirname(requested);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentState = await lstat(parent);
  if (parentState.isSymbolicLink() || !parentState.isDirectory()) {
    throw new Error("selected-solver provider database parent must be a private directory");
  }
  await chmod(parent, 0o700);
  const path = join(await realpath(parent), basename(requested));
  let exists = false;
  try {
    const state = await lstat(path);
    exists = true;
    if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0) {
      throw new Error("selected-solver provider database must be a private regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ exists, path });
}

async function secureDatabaseFiles(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const before = await lstat(candidate);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error("selected-solver provider database files must be private regular files");
      }
      await chmod(candidate, 0o600);
      const after = await lstat(candidate);
      if (after.isSymbolicLink() || !after.isFile() || (after.mode & 0o077) !== 0) {
        throw new Error("selected-solver provider database file permissions are unsafe");
      }
    } catch (error) {
      if (candidate !== path && error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

function leaseResult(store, row, recovery) {
  const lease = Object.freeze({
    schema: SELECTED_SOLVER_FINALIZATION_PROVIDER_STORE_SCHEMA,
    status: recovery ? "recovery-lease" : "new-lease",
    requestId: row.request_id,
    requestDigest: row.request_digest,
    expiresAt: Number(row.request_expires_at),
    recovery,
    fundingAuthorization: false,
    settlementAuthorization: false,
  });
  LEASES.set(lease, Object.freeze({
    store,
    requestId: row.request_id,
    requestDigest: row.request_digest,
    leaseEpoch: Number(row.lease_epoch),
    leaseExpiresAt: Number(row.lease_expires_at),
    requestExpiresAt: Number(row.request_expires_at),
    consumed: false,
  }));
  return Object.freeze({ status: "LEASE", lease });
}

export class SelectedSolverFinalizationProviderStore {
  #database;
  #maximumLiveRequests;
  #path;
  #closed = false;

  constructor(database, path, maximumLiveRequests, token) {
    if (token !== STORE_TOKEN) {
      throw new TypeError("selected-solver provider stores must be opened through the factory");
    }
    this.#database = database;
    this.#path = path;
    this.#maximumLiveRequests = maximumLiveRequests;
    STORES.add(this);
    Object.freeze(this);
  }

  static async open(input) {
    const source = exactDataRecord(input, STORE_KEYS, "selected-solver provider store");
    const allowMemory = source.allowMemory === true;
    if (source.initialize !== true && source.initialize !== false) {
      throw new TypeError("selected-solver provider store initialize must be a boolean");
    }
    const initialize = source.initialize;
    const maximumLiveRequests = integer(
      source.maximumLiveRequests,
      "selected-solver provider maximum live requests",
      1,
      MAXIMUM_LIVE_REQUESTS,
    );
    let path;
    if (source.path === ":memory:") {
      if (!allowMemory || !initialize) {
        throw new Error("selected-solver provider memory storage is initialized test-only storage");
      }
      path = source.path;
    } else {
      if (allowMemory) throw new Error("selected-solver provider allowMemory is valid only for :memory:");
      const resolved = await privateDatabasePath(String(source.path ?? ""));
      path = resolved.path;
      if (initialize && resolved.exists) throw new Error("selected-solver provider database already exists");
      if (!initialize && !resolved.exists) {
        throw new Error("selected-solver provider database is missing; explicit initialization is required");
      }
      if (initialize) {
        const handle = await open(path, "wx", 0o600);
        await handle.close();
      }
    }
    let database;
    try {
      database = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5_000 });
      database.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
      if (path !== ":memory:") database.exec("PRAGMA journal_mode=WAL;");
      verifyDatabase(database, { requireSchema: false });
      const count = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
      `).get().count);
      if (count === 0 && !initialize) throw new Error("selected-solver provider database is uninitialized");
      if (count === 0) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(`${META_SQL}; ${REQUEST_SQL};`);
          database.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES ('schema', ?)`).run(
            SELECTED_SOLVER_FINALIZATION_PROVIDER_STORE_SCHEMA,
          );
          database.prepare(`
            INSERT INTO ${META_TABLE} (key, value) VALUES ('clock_high_water', '0')
          `).run();
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      verifyDatabase(database);
      if (path !== ":memory:") {
        await secureDatabaseFiles(path);
      }
      return new SelectedSolverFinalizationProviderStore(
        database,
        path,
        maximumLiveRequests,
        STORE_TOKEN,
      );
    } catch (error) {
      try { database?.close(); } catch {}
      throw error;
    }
  }

  #assertOpen() {
    if (this.#closed) throw new Error("selected-solver provider store is closed");
  }

  observeTime(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, ["now"], "selected-solver provider clock observation");
    const now = integer(source.now, "selected-solver provider observation time", 1);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database);
      advanceClock(this.#database, now);
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  begin(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, BEGIN_KEYS, "selected-solver provider request claim");
    const requestId = bytes32(source.requestId, "selected-solver provider request ID");
    const requestDigest = bytes32(source.requestDigest, "selected-solver provider request digest");
    const requesterPublicKeyDigest = bytes32(
      source.requesterPublicKeyDigest,
      "selected-solver provider requester key digest",
    );
    const capabilityDigest = bytes32(source.capabilityDigest, "selected-solver provider capability digest");
    const solverId = address(source.solverId, "selected-solver provider solver");
    const requestDirection = direction(source.direction);
    const expiresAt = integer(source.expiresAt, "selected-solver provider request expiry", 1);
    const now = integer(source.now, "selected-solver provider claim time", 1);
    const leaseSeconds = integer(source.leaseSeconds, "selected-solver provider lease seconds", 1, 15);
    if (expiresAt <= now || expiresAt - now > MAXIMUM_REQUEST_LIFETIME_SECONDS) {
      throw new Error("selected-solver provider request is outside its live window");
    }
    const leaseExpiresAt = Math.min(expiresAt, now + leaseSeconds);
    if (leaseExpiresAt <= now) throw new Error("selected-solver provider cannot create a live lease");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database);
      advanceClock(this.#database, now);
      this.#database.prepare(`DELETE FROM ${REQUEST_TABLE} WHERE request_expires_at <= ?`).run(now);
      let row = this.#database.prepare(`SELECT * FROM ${REQUEST_TABLE} WHERE request_id = ?`).get(requestId);
      if (row) {
        if (row.request_digest !== requestDigest) {
          this.#database.exec("ROLLBACK");
          return Object.freeze({ status: "CONFLICT" });
        }
        if (row.state === "READY") {
          const responseJson = String(row.response_json);
          const storedResponseDigest = bytes32(
            row.response_digest,
            "selected-solver provider stored response digest",
          );
          let reconstructedDigest;
          try {
            reconstructedDigest = selectedSolverFinalizationResponseDigest(JSON.parse(responseJson));
          } catch {
            throw new Error("selected-solver provider cached response is invalid");
          }
          if (reconstructedDigest !== storedResponseDigest) {
            throw new Error("selected-solver provider cached response digest changed");
          }
          this.#database.exec("COMMIT");
          if (Number(row.response_expires_at) <= now) return Object.freeze({ status: "EXPIRED" });
          return Object.freeze({ status: "READY", responseJson });
        }
        if (Number(row.lease_expires_at) > now) {
          this.#database.exec("COMMIT");
          return Object.freeze({ status: "PENDING" });
        }
        const updated = this.#database.prepare(`
          UPDATE ${REQUEST_TABLE}
          SET lease_epoch = lease_epoch + 1, lease_expires_at = ?
          WHERE request_id = ? AND request_digest = ? AND state = 'CLAIMED'
            AND lease_expires_at <= ?
        `).run(leaseExpiresAt, requestId, requestDigest, now);
        if (Number(updated.changes) !== 1) throw new Error("selected-solver provider recovery lease raced");
        row = this.#database.prepare(`SELECT * FROM ${REQUEST_TABLE} WHERE request_id = ?`).get(requestId);
        this.#database.exec("COMMIT");
        return leaseResult(this, row, true);
      }
      const live = Number(this.#database.prepare(`SELECT COUNT(*) AS count FROM ${REQUEST_TABLE}`).get().count);
      if (live >= this.#maximumLiveRequests) {
        throw new Error("selected-solver provider store reached its live-request bound");
      }
      this.#database.prepare(`
        INSERT INTO ${REQUEST_TABLE} (
          request_id, request_digest, requester_public_key_digest, capability_digest,
          solver_id, direction, request_expires_at, state, claimed_at,
          lease_epoch, lease_expires_at, response_json, response_digest,
          response_expires_at, ready_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, 1, ?, NULL, NULL, NULL, NULL)
      `).run(
        requestId,
        requestDigest,
        requesterPublicKeyDigest,
        capabilityDigest,
        solverId,
        requestDirection,
        expiresAt,
        now,
        leaseExpiresAt,
      );
      row = this.#database.prepare(`SELECT * FROM ${REQUEST_TABLE} WHERE request_id = ?`).get(requestId);
      this.#database.exec("COMMIT");
      return leaseResult(this, row, false);
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  complete(lease, input) {
    this.#assertOpen();
    const context = LEASES.get(lease);
    if (!context || context.store !== this) {
      throw new TypeError("selected-solver provider lease provenance is invalid");
    }
    if (context.consumed) return false;
    const source = exactDataRecord(input, COMPLETE_KEYS, "selected-solver provider completion");
    const now = integer(source.now, "selected-solver provider completion time", 1);
    const responseExpiresAt = integer(
      source.responseExpiresAt,
      "selected-solver provider response expiry",
      now + 1,
      context.requestExpiresAt,
    );
    const responseDigest = bytes32(source.responseDigest, "selected-solver provider response digest");
    const responseJson = String(source.responseJson ?? "");
    const responseBytes = Buffer.byteLength(responseJson);
    if (!responseJson || responseBytes > MAXIMUM_REQUEST_BYTES) {
      throw new RangeError("selected-solver provider response JSON is outside size policy");
    }
    let reconstructedDigest;
    try {
      reconstructedDigest = selectedSolverFinalizationResponseDigest(JSON.parse(responseJson));
    } catch {
      throw new Error("selected-solver provider response JSON is invalid");
    }
    if (reconstructedDigest !== responseDigest) {
      throw new Error("selected-solver provider response digest does not match its JSON");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database);
      advanceClock(this.#database, now);
      const updated = this.#database.prepare(`
        UPDATE ${REQUEST_TABLE}
        SET state = 'READY', response_json = ?, response_digest = ?,
          response_expires_at = ?, ready_at = ?
        WHERE request_id = ? AND request_digest = ? AND state = 'CLAIMED'
          AND lease_epoch = ? AND lease_expires_at > ? AND request_expires_at >= ?
      `).run(
        responseJson,
        responseDigest,
        responseExpiresAt,
        now,
        context.requestId,
        context.requestDigest,
        context.leaseEpoch,
        now,
        responseExpiresAt,
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

  status(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, ["now"], "selected-solver provider status");
    const now = integer(source.now, "selected-solver provider status time", 1);
    verifyDatabase(this.#database);
    if (now < storedClock(this.#database)) throw new Error("selected-solver provider clock regressed");
    const row = this.#database.prepare(`
      SELECT
        SUM(CASE WHEN request_expires_at > ? AND state = 'CLAIMED' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN request_expires_at > ? AND state = 'READY' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN request_expires_at <= ? THEN 1 ELSE 0 END) AS expired
      FROM ${REQUEST_TABLE}
    `).get(now, now, now);
    return Object.freeze({
      schema: SELECTED_SOLVER_FINALIZATION_PROVIDER_STORE_SCHEMA,
      status: "healthy-selected-solver-finalization-provider-store",
      liveClaimedRequests: Number(row.claimed ?? 0),
      liveReadyResponses: Number(row.ready ?? 0),
      expiredRequestsAwaitingCleanup: Number(row.expired ?? 0),
      maximumLiveRequests: this.#maximumLiveRequests,
      fundingAuthorization: false,
      settlementAuthorization: false,
    });
  }

  get path() {
    return this.#path;
  }

  close() {
    if (this.#closed) return false;
    this.#closed = true;
    this.#database.close();
    STORES.delete(this);
    return true;
  }
}

Object.freeze(SelectedSolverFinalizationProviderStore.prototype);
Object.freeze(SelectedSolverFinalizationProviderStore);

export function isSelectedSolverFinalizationProviderStore(value) {
  return Boolean(value && STORES.has(value));
}

export function createSelectedSolverFinalizationProviderFinalizer(input) {
  const source = exactDataRecord(input, FINALIZER_KEYS, "selected-solver provider finalizer");
  if (typeof source.finalize !== "function" || typeof source.recover !== "function") {
    throw new TypeError("selected-solver provider finalizer requires finalize and recover functions");
  }
  const context = {
    finalize: source.finalize,
    recover: source.recover,
    owner: null,
  };
  const finalizer = Object.freeze({
    status: (...arguments_) => {
      if (arguments_.length !== 0) throw new TypeError("selected-solver finalizer status accepts no input");
      return Object.freeze({
        schema: "treeswap.selected-solver-finalization-provider-finalizer.v1",
        state: context.owner === null ? "unbound" : "bound",
        fundingAuthorization: false,
        settlementAuthorization: false,
      });
    },
  });
  FINALIZERS.set(finalizer, context);
  return finalizer;
}

export function isSelectedSolverFinalizationProviderFinalizer(value) {
  return Boolean(value && FINALIZERS.has(value));
}

function providerOrigin(value) {
  try {
    return publicSolverEndpointOrigin(String(value ?? ""));
  } catch {
    throw new TypeError("selected-solver provider origin must be a canonical public HTTPS origin");
  }
}

function privateKey(value) {
  try {
    const key = value?.type === "private" ? value : createPrivateKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new TypeError("selected-solver provider endpoint private key must be Ed25519");
  }
}

function normalizeAuthority(value) {
  const source = exactDataRecord(value, [
    "capabilityDigest",
    "direction",
    "endpointPublicKeyDigest",
    "requesterPublicKeyDigest",
    "solverId",
  ], "selected-solver provider authority");
  return Object.freeze({
    requesterPublicKeyDigest: bytes32(source.requesterPublicKeyDigest, "provider requester key digest"),
    capabilityDigest: bytes32(source.capabilityDigest, "provider capability digest"),
    endpointPublicKeyDigest: bytes32(source.endpointPublicKeyDigest, "provider endpoint key digest"),
    solverId: address(source.solverId, "provider solver"),
    direction: direction(source.direction),
  });
}

async function boundedRequestJson(request, maximumBytes, signal) {
  const contentType = String(request.headers?.get?.("content-type") ?? "").trim().toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw new Error("selected-solver provider content type is invalid");
  }
  const cacheControl = String(request.headers.get("cache-control") ?? "").toLowerCase();
  if (!cacheControl.split(",").some((value) => value.trim() === "no-store")) {
    throw new Error("selected-solver provider request must disable storage");
  }
  if (String(request.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") {
    throw new Error("selected-solver provider content encoding is invalid");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && !/^[0-9]+$/.test(declared)) {
    throw new Error("selected-solver provider content length is invalid");
  }
  if (Number(declared ?? 0) > maximumBytes) throw new Error("selected-solver provider request is too large");
  if (request.headers.has("authorization") || request.headers.has("cookie")) {
    throw new Error("selected-solver provider request credentials are forbidden");
  }
  if (!request.body) throw new Error("selected-solver provider request body is empty");
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new Error("selected-solver provider request is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (declared !== null && received !== Number(declared)) {
    throw new Error("selected-solver provider request length does not match its framing");
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("selected-solver provider request must not contain a UTF-8 BOM");
  }
  try {
    return JSON.parse(FATAL_UTF8.decode(bytes));
  } catch {
    throw new Error("selected-solver provider request is malformed");
  }
}

function jsonBytesResponse(status, body, extraHeaders = {}) {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(JSON.stringify(body), "utf8");
  if (bytes.length > MAXIMUM_REQUEST_BYTES) throw new Error("selected-solver provider response is too large");
  return new Response(bytes, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-length": String(bytes.length),
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function canonicalInvoice(value) {
  return String(value ?? "").trim().replace(/^lightning:/i, "").toLowerCase();
}

function normalizedFinalizerResult(value, request, now) {
  const bounded = snapshotJson(value, "selected-solver provider finalizer result");
  const source = exactDataRecord(
    bounded,
    ["envelope", "expiresAt", "invoice"],
    "selected-solver provider finalizer result",
  );
  const invoice = canonicalInvoice(source.invoice);
  if (!invoice || Buffer.byteLength(invoice) > 4_096) {
    throw new Error("selected-solver provider finalizer invoice is invalid");
  }
  const envelope = exactDataRecord(
    source.envelope,
    ["offer", "signature"],
    "selected-solver provider executable envelope",
  );
  const offer = source.envelope.offer;
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) {
    throw new TypeError("selected-solver provider executable offer must be an object");
  }
  const offerInvoiceDigest = bytes32(offer.invoiceDigest, "selected-solver provider offer invoice digest");
  const offerPaymentHash = bytes32(offer.paymentHash, "selected-solver provider offer payment hash");
  if (offerInvoiceDigest !== invoiceDigest(invoice)) {
    throw new Error("selected-solver provider invoice does not match the executable offer");
  }
  if (request.direction === "bit-to-lightning") {
    if (invoice !== canonicalInvoice(request.disclosure.invoice)
        || offerPaymentHash !== request.disclosure.paymentHash) {
      throw new Error("selected-solver provider changed the user invoice commitment");
    }
  }
  const expiresAt = integer(
    source.expiresAt,
    "selected-solver provider finalizer result expiry",
    now + 1,
    request.expiresAt,
  );
  return Object.freeze({ envelope, expiresAt, invoice });
}

export async function createSelectedSolverFinalizationProviderRoute(input) {
  const source = exactDataRecord(input, ROUTE_KEYS, "selected-solver provider route");
  if (!isSelectedSolverFinalizationProviderStore(source.store)) {
    throw new TypeError("selected-solver provider requires the concrete durable store");
  }
  if (!isSelectedSolverFinalizationProviderFinalizer(source.finalizer)) {
    throw new TypeError("selected-solver provider requires the concrete recovery-capable finalizer");
  }
  if (typeof source.nowSeconds !== "function") throw new TypeError("selected-solver provider requires a clock");
  const authority = normalizeAuthority(source.authority);
  const endpointPrivateKey = privateKey(source.endpointPrivateKey);
  const endpointPublicKey = createPublicKey(endpointPrivateKey).export({ format: "pem", type: "spki" }).toString();
  if (solverEndpointPublicKeyDigest(endpointPublicKey) !== authority.endpointPublicKeyDigest) {
    throw new Error("selected-solver provider endpoint key does not match its authority");
  }
  const origin = providerOrigin(source.providerOrigin);
  const maximumRequestBytes = integer(
    source.maximumRequestBytes,
    "selected-solver provider maximum request bytes",
    1_024,
    MAXIMUM_REQUEST_BYTES,
  );
  const requestTimeoutMs = integer(
    source.requestTimeoutMs,
    "selected-solver provider request timeout",
    100,
    10_000,
  );
  const recoveryLeaseSeconds = integer(
    source.recoveryLeaseSeconds,
    "selected-solver provider recovery lease",
    1,
    15,
  );
  if (recoveryLeaseSeconds * 1_000 <= requestTimeoutMs) {
    throw new Error("selected-solver provider lease must outlive its request timeout");
  }
  const nowSeconds = source.nowSeconds;
  const store = source.store;
  const finalizer = source.finalizer;
  const finalizerContext = FINALIZERS.get(finalizer);
  if (finalizerContext.owner !== null) {
    throw new Error("selected-solver provider finalizer is already bound to a route");
  }
  finalizerContext.owner = Symbol("TreeSwap selected-solver finalizer route owner");

  const handle = async (webRequest) => {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    webRequest?.signal?.addEventListener?.("abort", forwardAbort, { once: true });
    let timer;
    let claimed = false;
    let claimAttempted = false;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("selected-solver provider request timed out"));
      }, requestTimeoutMs);
    });
    try {
      const startedAt = integer(nowSeconds(), "selected-solver provider request start time", 1);
      if (!(webRequest instanceof Request) || webRequest.method !== "POST") {
        throw new Error("selected-solver provider request method is invalid");
      }
      const url = new URL(webRequest.url);
      if (url.origin !== origin || url.pathname !== "/v1/finalize" || url.search || url.hash
          || url.username || url.password) {
        throw new Error("selected-solver provider request target is invalid");
      }
      store.observeTime({ now: startedAt });
      const raw = await Promise.race([
        boundedRequestJson(webRequest, maximumRequestBytes, controller.signal),
        deadline,
      ]);
      const requestEnvelope = snapshotJson(raw, "selected-solver provider request envelope");
      const verifiedAt = integer(nowSeconds(), "selected-solver provider verification time", 1);
      store.observeTime({ now: verifiedAt });
      const request = verifySelectedSolverFinalizationRequest({
        request: requestEnvelope,
        authority,
        now: verifiedAt,
      });
      claimAttempted = true;
      const claim = store.begin({
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        requesterPublicKeyDigest: request.requesterPublicKeyDigest,
        capabilityDigest: request.capabilityDigest,
        solverId: request.solverId,
        direction: request.direction,
        expiresAt: request.expiresAt,
        now: verifiedAt,
        leaseSeconds: recoveryLeaseSeconds,
      });
      if (claim.status === "READY") return jsonBytesResponse(200, claim.responseJson);
      if (claim.status === "PENDING") {
        return jsonBytesResponse(425, { error: "selected-solver finalization pending" }, { "retry-after": "1" });
      }
      if (claim.status === "CONFLICT" || claim.status === "EXPIRED") {
        return jsonBytesResponse(400, { error: "selected-solver finalization rejected" });
      }
      claimed = true;
      if (controller.signal.aborted) throw new Error("selected-solver provider request was aborted");
      const resolver = claim.lease.recovery ? finalizerContext.recover : finalizerContext.finalize;
      const rawResult = await Promise.race([
        resolver(request, {
          requestId: request.requestId,
          requestDigest: request.requestDigest,
          recovery: claim.lease.recovery,
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (controller.signal.aborted) throw new Error("selected-solver provider request was aborted");
      const responseAt = integer(nowSeconds(), "selected-solver provider response time", 1);
      store.observeTime({ now: responseAt });
      const result = normalizedFinalizerResult(rawResult, request, responseAt);
      const response = buildSignedSelectedSolverFinalizationResponse({
        request,
        invoice: result.invoice,
        envelope: result.envelope,
        servedAt: responseAt,
        expiresAt: result.expiresAt,
        endpointPrivateKey,
      });
      const responseJson = JSON.stringify(response);
      const responseDigest = selectedSolverFinalizationResponseDigest(response);
      const completedAt = integer(nowSeconds(), "selected-solver provider commit time", 1);
      store.observeTime({ now: completedAt });
      if (controller.signal.aborted) throw new Error("selected-solver provider request was aborted");
      if (!store.complete(claim.lease, {
        responseJson,
        responseDigest,
        responseExpiresAt: response.expiresAt,
        now: completedAt,
      })) throw new Error("selected-solver provider lost its completion lease");
      return jsonBytesResponse(200, responseJson);
    } catch {
      return claimed || claimAttempted
        ? jsonBytesResponse(503, { error: "selected-solver finalization recovery required" }, { "retry-after": "1" })
        : jsonBytesResponse(400, { error: "selected-solver finalization rejected" });
    } finally {
      clearTimeout(timer);
      controller.abort();
      webRequest?.signal?.removeEventListener?.("abort", forwardAbort);
    }
  };
  const route = Object.freeze({
    handle,
    status: (...arguments_) => {
      if (arguments_.length !== 0) throw new TypeError("selected-solver provider status accepts no input");
      const now = integer(nowSeconds(), "selected-solver provider status time", 1);
      store.observeTime({ now });
      return Object.freeze({
        ...store.status({ now }),
        provider: Object.freeze({
          schema: "treeswap.selected-solver-finalization-provider.v1",
          state: "repository-only",
          recoveryCapable: true,
          networkListener: false,
          fundingAuthorization: false,
          settlementAuthorization: false,
        }),
      });
    },
  });
  ROUTES.add(route);
  return route;
}

export function isSelectedSolverFinalizationProviderRoute(value) {
  return Boolean(value && ROUTES.has(value));
}
