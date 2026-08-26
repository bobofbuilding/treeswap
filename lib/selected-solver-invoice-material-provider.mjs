import { createPrivateKey } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";
import {
  claimSelectedSolverInvoiceMaterialService,
  selectedSolverInvoiceMaterialBinding,
  selectedSolverInvoiceMaterialServiceMode,
} from "./selected-solver-invoice-material.mjs";
import {
  buildSignedSelectedSolverInvoiceMaterialResponse,
  selectedSolverInvoiceMaterialResponseDigest,
  verifySelectedSolverInvoiceMaterialRequest,
} from "./selected-solver-invoice-material-transport.mjs";
import { isPrivateLndHostname } from "./lnd-rest-client.mjs";

export const SELECTED_SOLVER_INVOICE_MATERIAL_PROVIDER_STORE_SCHEMA =
  "treeswap.selected-solver-invoice-material-provider-store.v1";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_REQUEST_BYTES = 16_384;
const MAX_LIVE_REQUESTS = 4_096;
const MAX_REQUEST_LIFETIME_SECONDS = 30;
const STORE_KEYS = Object.freeze(["allowMemory", "initialize", "maximumLiveRequests", "path"]);
const BEGIN_KEYS = Object.freeze([
  "expiresAt",
  "leaseSeconds",
  "materialDigest",
  "now",
  "paymentSecretKeyId",
  "requestId",
  "requesterKeyId",
]);
const COMPLETE_KEYS = Object.freeze([
  "now",
  "responseDigest",
  "responseExpiresAt",
  "responseJson",
]);
const ROUTE_KEYS = Object.freeze([
  "expectedRequesterKeyId",
  "invoiceService",
  "maxClockSkewSeconds",
  "maximumRequestBytes",
  "paymentSecretKeyId",
  "providerKeyId",
  "providerOrigin",
  "providerPrivateKey",
  "recoveryLeaseSeconds",
  "requestTimeoutMs",
  "requesterPublicKey",
  "responseTtlSeconds",
  "signal",
  "store",
]);
const TEST_ROUTE_KEYS = Object.freeze([...ROUTE_KEYS, "nowSeconds"]);
const META_TABLE = "invoice_material_meta";
const REQUEST_TABLE = "invoice_material_requests";
const META_SQL = `CREATE TABLE ${META_TABLE} (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT`;
const REQUEST_SQL = `CREATE TABLE ${REQUEST_TABLE} (
  request_id TEXT PRIMARY KEY NOT NULL,
  material_digest TEXT NOT NULL,
  requester_key_id TEXT NOT NULL,
  payment_secret_key_id TEXT NOT NULL,
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
  CHECK (response_json IS NULL OR length(CAST(response_json AS BLOB)) <= 16384)
) STRICT`;
const STORE_TOKEN = Symbol("TreeSwap selected-solver invoice-material provider store");
const STORES = new WeakSet();
const LEASES = new WeakMap();
const ROUTES = new WeakSet();
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const DATE_NOW = Date.now.bind(Date);

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
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

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  }
  return value;
}

function keyId(value, name) {
  if (typeof value !== "string" || !KEY_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function sql(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "");
}

function storedInteger(value, name) {
  const raw = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} is not canonical`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== raw) {
    throw new Error(`${name} is outside the safe range`);
  }
  return parsed;
}

function storedClock(database) {
  const row = database.prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'clock_high_water'`).get();
  if (!row) throw new Error("invoice-material provider clock high-water mark is missing");
  return storedInteger(row.value, "invoice-material provider clock high-water mark");
}

function advanceClock(database, now) {
  const previous = storedClock(database);
  if (now < previous) throw new Error("invoice-material provider clock regressed");
  if (now === previous) return;
  const updated = database.prepare(`
    UPDATE ${META_TABLE} SET value = ? WHERE key = 'clock_high_water' AND value = ?
  `).run(String(now), String(previous));
  if (Number(updated.changes) !== 1) throw new Error("invoice-material provider clock update failed");
}

function verifyDatabase(database, { requireSchema = true } = {}) {
  const quick = database.prepare("PRAGMA quick_check").all();
  if (quick.length !== 1 || Object.values(quick[0]).length !== 1
      || Object.values(quick[0])[0] !== "ok") {
    throw new Error("invoice-material provider database quick check failed");
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
    throw new Error("invoice-material provider database layout is unsupported");
  }
  const meta = database.prepare(`SELECT key, value FROM ${META_TABLE} ORDER BY key`).all();
  if (meta.length !== 2 || meta[0].key !== "clock_high_water"
      || meta[1].key !== "schema"
      || meta[1].value !== SELECTED_SOLVER_INVOICE_MATERIAL_PROVIDER_STORE_SCHEMA) {
    throw new Error("invoice-material provider database schema is unsupported");
  }
  storedInteger(meta[0].value, "invoice-material provider clock high-water mark");
}

async function privateDatabasePath(rawPath) {
  if (typeof rawPath !== "string" || !isAbsolute(rawPath)
      || rawPath.includes("\0") || rawPath.length > 4_096) {
    throw new TypeError("invoice-material provider database path must be a bounded absolute path");
  }
  const requested = resolve(rawPath);
  const parent = dirname(requested);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentState = await lstat(parent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (parentState.isSymbolicLink() || !parentState.isDirectory()
      || (parentState.mode & 0o077) !== 0
      || (currentUid !== null && parentState.uid !== currentUid)) {
    throw new Error("invoice-material provider database parent must be private and owner-controlled");
  }
  const path = join(await realpath(parent), basename(requested));
  let exists = false;
  try {
    const state = await lstat(path);
    exists = true;
    if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0
        || (currentUid !== null && state.uid !== currentUid)) {
      throw new Error("invoice-material provider database must be a private owner-controlled file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ exists, path });
}

async function secureDatabaseFiles(path) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const before = await lstat(candidate);
      if (before.isSymbolicLink() || !before.isFile()
          || (currentUid !== null && before.uid !== currentUid)) {
        throw new Error("invoice-material provider database files must be owner-controlled regular files");
      }
      await chmod(candidate, 0o600);
      const after = await lstat(candidate);
      if (after.isSymbolicLink() || !after.isFile() || (after.mode & 0o077) !== 0) {
        throw new Error("invoice-material provider database file permissions are unsafe");
      }
    } catch (error) {
      if (candidate !== path && error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

function leaseResult(store, row, recovery) {
  const lease = Object.freeze({
    schema: SELECTED_SOLVER_INVOICE_MATERIAL_PROVIDER_STORE_SCHEMA,
    status: recovery ? "recovery-lease" : "new-lease",
    requestId: row.request_id,
    materialDigest: row.material_digest,
    paymentSecretKeyId: row.payment_secret_key_id,
    expiresAt: Number(row.request_expires_at),
    recovery,
    fundingAuthorization: false,
    settlementAuthorization: false,
  });
  LEASES.set(lease, Object.freeze({
    store,
    requestId: row.request_id,
    materialDigest: row.material_digest,
    paymentSecretKeyId: row.payment_secret_key_id,
    leaseEpoch: Number(row.lease_epoch),
    leaseExpiresAt: Number(row.lease_expires_at),
    requestExpiresAt: Number(row.request_expires_at),
    consumed: false,
  }));
  return Object.freeze({ status: "LEASE", lease });
}

export class SelectedSolverInvoiceMaterialProviderStore {
  #database;
  #maximumLiveRequests;
  #path;
  #closed = false;

  constructor(database, path, maximumLiveRequests, token) {
    if (token !== STORE_TOKEN) {
      throw new TypeError("invoice-material provider stores must be opened through the factory");
    }
    this.#database = database;
    this.#path = path;
    this.#maximumLiveRequests = maximumLiveRequests;
    STORES.add(this);
    Object.freeze(this);
  }

  static async open(input) {
    const source = exactDataRecord(input, STORE_KEYS, "invoice-material provider store");
    const allowMemory = source.allowMemory === true;
    if (source.initialize !== true && source.initialize !== false) {
      throw new TypeError("invoice-material provider store initialize must be a boolean");
    }
    const maximumLiveRequests = integer(
      source.maximumLiveRequests,
      "invoice-material provider maximum live requests",
      1,
      MAX_LIVE_REQUESTS,
    );
    let path;
    if (source.path === ":memory:") {
      if (!allowMemory || !source.initialize) {
        throw new Error("invoice-material memory storage is initialized test-only storage");
      }
      path = source.path;
    } else {
      if (allowMemory) throw new Error("allowMemory is valid only for invoice-material :memory: storage");
      const resolved = await privateDatabasePath(source.path);
      path = resolved.path;
      if (source.initialize && resolved.exists) throw new Error("invoice-material provider database already exists");
      if (!source.initialize && !resolved.exists) {
        throw new Error("invoice-material provider database is missing; explicit initialization is required");
      }
      if (source.initialize) {
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
      if (count === 0 && !source.initialize) throw new Error("invoice-material provider database is uninitialized");
      if (count === 0) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(`${META_SQL}; ${REQUEST_SQL};`);
          database.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES ('schema', ?)`).run(
            SELECTED_SOLVER_INVOICE_MATERIAL_PROVIDER_STORE_SCHEMA,
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
      if (path !== ":memory:") await secureDatabaseFiles(path);
      return new SelectedSolverInvoiceMaterialProviderStore(
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
    if (this.#closed) throw new Error("invoice-material provider store is closed");
  }

  observeTime(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, ["now"], "invoice-material provider clock observation");
    const now = integer(source.now, "invoice-material provider observation time", 1);
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
    const source = exactDataRecord(input, BEGIN_KEYS, "invoice-material provider request claim");
    const requestId = bytes32(source.requestId, "invoice-material provider request ID");
    const materialDigest = bytes32(source.materialDigest, "invoice-material provider semantic digest");
    const requesterKeyId = keyId(source.requesterKeyId, "invoice-material provider requester key ID");
    const paymentSecretKeyId = keyId(
      source.paymentSecretKeyId,
      "invoice-material provider payment-secret key ID",
    );
    const expiresAt = integer(source.expiresAt, "invoice-material provider request expiry", 1);
    const now = integer(source.now, "invoice-material provider claim time", 1);
    const leaseSeconds = integer(source.leaseSeconds, "invoice-material provider lease", 1, 15);
    if (expiresAt <= now || expiresAt - now > MAX_REQUEST_LIFETIME_SECONDS) {
      throw new Error("invoice-material provider request is outside its live window");
    }
    const leaseExpiresAt = Math.min(expiresAt, now + leaseSeconds);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database);
      advanceClock(this.#database, now);
      this.#database.prepare(`DELETE FROM ${REQUEST_TABLE} WHERE request_expires_at <= ?`).run(now);
      let row = this.#database.prepare(`SELECT * FROM ${REQUEST_TABLE} WHERE request_id = ?`).get(requestId);
      if (row) {
        if (row.material_digest !== materialDigest || row.requester_key_id !== requesterKeyId
            || row.payment_secret_key_id !== paymentSecretKeyId
            || Number(row.request_expires_at) !== expiresAt) {
          this.#database.exec("ROLLBACK");
          return Object.freeze({ status: "CONFLICT" });
        }
        if (row.state === "READY") {
          const responseJson = String(row.response_json);
          const storedDigest = bytes32(row.response_digest, "stored invoice-material response digest");
          let reconstructed;
          try {
            reconstructed = selectedSolverInvoiceMaterialResponseDigest(JSON.parse(responseJson));
          } catch {
            throw new Error("cached invoice-material response is invalid");
          }
          if (reconstructed !== storedDigest) throw new Error("cached invoice-material response changed");
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
          WHERE request_id = ? AND material_digest = ? AND state = 'CLAIMED'
            AND lease_expires_at <= ?
        `).run(leaseExpiresAt, requestId, materialDigest, now);
        if (Number(updated.changes) !== 1) throw new Error("invoice-material recovery lease raced");
        row = this.#database.prepare(`SELECT * FROM ${REQUEST_TABLE} WHERE request_id = ?`).get(requestId);
        this.#database.exec("COMMIT");
        return leaseResult(this, row, true);
      }
      const live = Number(this.#database.prepare(`SELECT COUNT(*) AS count FROM ${REQUEST_TABLE}`).get().count);
      if (live >= this.#maximumLiveRequests) {
        throw new Error("invoice-material provider store reached its live-request bound");
      }
      this.#database.prepare(`
        INSERT INTO ${REQUEST_TABLE} (
          request_id, material_digest, requester_key_id, payment_secret_key_id,
          request_expires_at, state, claimed_at, lease_epoch, lease_expires_at,
          response_json, response_digest, response_expires_at, ready_at
        ) VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?, 1, ?, NULL, NULL, NULL, NULL)
      `).run(
        requestId,
        materialDigest,
        requesterKeyId,
        paymentSecretKeyId,
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
      throw new TypeError("invoice-material provider lease provenance is invalid");
    }
    if (context.consumed) return false;
    const source = exactDataRecord(input, COMPLETE_KEYS, "invoice-material provider completion");
    const now = integer(source.now, "invoice-material provider completion time", 1);
    const responseExpiresAt = integer(
      source.responseExpiresAt,
      "invoice-material provider response expiry",
      now + 1,
      context.requestExpiresAt,
    );
    const responseDigest = bytes32(source.responseDigest, "invoice-material provider response digest");
    if (typeof source.responseJson !== "string" || !source.responseJson
        || Buffer.byteLength(source.responseJson) > MAX_REQUEST_BYTES) {
      throw new RangeError("invoice-material provider response JSON is outside policy");
    }
    let reconstructed;
    try {
      reconstructed = selectedSolverInvoiceMaterialResponseDigest(JSON.parse(source.responseJson));
    } catch {
      throw new Error("invoice-material provider response JSON is invalid");
    }
    if (reconstructed !== responseDigest) {
      throw new Error("invoice-material provider response digest does not match its JSON");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database);
      advanceClock(this.#database, now);
      const updated = this.#database.prepare(`
        UPDATE ${REQUEST_TABLE}
        SET state = 'READY', response_json = ?, response_digest = ?,
          response_expires_at = ?, ready_at = ?
        WHERE request_id = ? AND material_digest = ? AND payment_secret_key_id = ?
          AND state = 'CLAIMED' AND lease_epoch = ? AND lease_expires_at > ?
          AND request_expires_at >= ?
      `).run(
        source.responseJson,
        responseDigest,
        responseExpiresAt,
        now,
        context.requestId,
        context.materialDigest,
        context.paymentSecretKeyId,
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
    const source = exactDataRecord(input, ["now"], "invoice-material provider status");
    const now = integer(source.now, "invoice-material provider status time", 1);
    verifyDatabase(this.#database);
    if (now < storedClock(this.#database)) throw new Error("invoice-material provider clock regressed");
    const row = this.#database.prepare(`
      SELECT
        SUM(CASE WHEN request_expires_at > ? AND state = 'CLAIMED' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN request_expires_at > ? AND state = 'READY' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN request_expires_at <= ? THEN 1 ELSE 0 END) AS expired
      FROM ${REQUEST_TABLE}
    `).get(now, now, now);
    return Object.freeze({
      schema: SELECTED_SOLVER_INVOICE_MATERIAL_PROVIDER_STORE_SCHEMA,
      status: "healthy-selected-solver-invoice-material-provider-store",
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

Object.freeze(SelectedSolverInvoiceMaterialProviderStore.prototype);
Object.freeze(SelectedSolverInvoiceMaterialProviderStore);

export function isSelectedSolverInvoiceMaterialProviderStore(value) {
  return Boolean(value && STORES.has(value));
}

function providerOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("invoice-material provider origin must be private HTTPS on port 443");
  }
  if (typeof value !== "string" || url.protocol !== "https:"
      || (url.port && url.port !== "443") || url.username || url.password
      || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")
      || !isPrivateLndHostname(url.hostname) || value !== url.origin) {
    throw new TypeError("invoice-material provider origin must be private HTTPS on port 443");
  }
  return url.origin;
}

async function boundedRequestJson(request, maximumBytes, signal) {
  const contentType = String(request.headers?.get?.("content-type") ?? "").trim().toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw new Error("invoice-material provider content type is invalid");
  }
  const cacheControl = String(request.headers.get("cache-control") ?? "").toLowerCase();
  if (!cacheControl.split(",").some((value) => value.trim() === "no-store")) {
    throw new Error("invoice-material provider request must disable storage");
  }
  if (String(request.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") {
    throw new Error("invoice-material provider content encoding is invalid");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && !/^(?:0|[1-9][0-9]*)$/.test(declared)) {
    throw new Error("invoice-material provider content length is invalid");
  }
  const transferEncoding = request.headers.get("transfer-encoding");
  if (transferEncoding !== null
      && (declared !== null || transferEncoding.trim().toLowerCase() !== "chunked")) {
    throw new Error("invoice-material provider request framing is ambiguous");
  }
  if (Number(declared ?? 0) > maximumBytes || request.headers.has("authorization")
      || request.headers.has("cookie") || !request.body) {
    throw new Error("invoice-material provider request framing is invalid");
  }
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const frame = await reader.read();
      if (frame.done) break;
      received += frame.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new Error("invoice-material provider request is too large");
      }
      chunks.push(Buffer.from(frame.value));
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (declared !== null && received !== Number(declared)) {
    throw new Error("invoice-material provider request length changed");
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("invoice-material provider request contains a byte order mark");
  }
  try {
    return JSON.parse(FATAL_UTF8.decode(bytes));
  } catch {
    throw new Error("invoice-material provider request is malformed");
  }
}

function jsonResponse(status, body, extraHeaders = {}) {
  const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  if (bytes.length > MAX_REQUEST_BYTES) throw new Error("invoice-material provider response is too large");
  return new Response(bytes, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-encoding": "identity",
      "content-length": String(bytes.length),
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function createRoute(input, mode) {
  const expected = mode === "production" ? ROUTE_KEYS : TEST_ROUTE_KEYS;
  const source = exactDataRecord(input, expected, "invoice-material provider route");
  if (!isSelectedSolverInvoiceMaterialProviderStore(source.store)) {
    throw new TypeError("invoice-material provider requires its concrete durable store");
  }
  if (mode === "production" && source.store.path === ":memory:") {
    throw new Error("invoice-material production provider requires durable storage");
  }
  if (selectedSolverInvoiceMaterialServiceMode(source.invoiceService) !== mode) {
    throw new TypeError("invoice-material provider and core service modes do not match");
  }
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("invoice-material provider requires an active deployment signal");
  }
  const expectedRequesterKeyId = keyId(source.expectedRequesterKeyId, "expected requester key ID");
  const paymentSecretKeyId = keyId(source.paymentSecretKeyId, "payment-secret key ID");
  const providerKeyId = keyId(source.providerKeyId, "provider key ID");
  const providerPrivateKey = (() => {
    try {
      const key = source.providerPrivateKey?.type === "private"
        ? source.providerPrivateKey : createPrivateKey(source.providerPrivateKey);
      if (key.asymmetricKeyType !== "ed25519") throw new Error();
      return key;
    } catch {
      throw new TypeError("invoice-material provider private key must be Ed25519");
    }
  })();
  const origin = providerOrigin(source.providerOrigin);
  const maximumRequestBytes = integer(
    source.maximumRequestBytes,
    "invoice-material provider maximum request bytes",
    1_024,
    MAX_REQUEST_BYTES,
  );
  const maxClockSkewSeconds = integer(source.maxClockSkewSeconds, "invoice-material clock skew", 0, 60);
  const requestTimeoutMs = integer(source.requestTimeoutMs, "invoice-material timeout", 100, 10_000);
  const recoveryLeaseSeconds = integer(source.recoveryLeaseSeconds, "invoice-material lease", 1, 15);
  const responseTtlSeconds = integer(source.responseTtlSeconds, "invoice-material response TTL", 1, 30);
  if (recoveryLeaseSeconds * 1_000 <= requestTimeoutMs) {
    throw new Error("invoice-material recovery lease must outlive the request timeout");
  }
  const nowSeconds = mode === "production" ? () => Math.floor(DATE_NOW() / 1_000) : source.nowSeconds;
  if (typeof nowSeconds !== "function") throw new TypeError("invoice-material provider requires a clock");
  const serviceLease = claimSelectedSolverInvoiceMaterialService(source.invoiceService, {
    paymentSecretKeyId,
    signal: source.signal,
  });
  const store = source.store;

  const route = Object.freeze({
    async handle(webRequest) {
      if (this !== route || !ROUTES.has(this) || source.signal.aborted) {
        throw new TypeError("invoice-material provider route lacks active provenance");
      }
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      source.signal.addEventListener("abort", forwardAbort, { once: true });
      webRequest?.signal?.addEventListener?.("abort", forwardAbort, { once: true });
      let timer;
      let claimed = false;
      let claimAttempted = false;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("invoice-material provider request timed out"));
        }, requestTimeoutMs);
      });
      try {
        const startedAt = integer(nowSeconds(), "invoice-material provider start time", 1);
        if (!(webRequest instanceof Request) || webRequest.method !== "POST") {
          throw new Error("invoice-material provider method is invalid");
        }
        const url = new URL(webRequest.url);
        if (url.origin !== origin || url.pathname !== "/v1/invoice-material"
            || url.search || url.hash || url.username || url.password) {
          throw new Error("invoice-material provider target is invalid");
        }
        store.observeTime({ now: startedAt });
        const raw = await Promise.race([
          boundedRequestJson(webRequest, maximumRequestBytes, controller.signal),
          deadline,
        ]);
        const verifiedAt = integer(nowSeconds(), "invoice-material provider verification time", 1);
        store.observeTime({ now: verifiedAt });
        const request = verifySelectedSolverInvoiceMaterialRequest({
          envelope: raw,
          requesterPublicKey: source.requesterPublicKey,
          expectedRequesterKeyId,
          expectedPaymentSecretKeyId: paymentSecretKeyId,
          maxClockSkewSeconds,
          now: verifiedAt,
        });
        claimAttempted = true;
        const claim = store.begin({
          requestId: request.requestId,
          materialDigest: request.materialDigest,
          requesterKeyId: request.requesterKeyId,
          paymentSecretKeyId: request.paymentSecretKeyId,
          expiresAt: request.authorizationExpiresAt,
          now: verifiedAt,
          leaseSeconds: recoveryLeaseSeconds,
        });
        if (claim.status === "READY") return jsonResponse(200, claim.responseJson);
        if (claim.status === "PENDING") {
          return jsonResponse(425, { error: "invoice-material request pending" }, { "retry-after": "1" });
        }
        if (claim.status === "CONFLICT" || claim.status === "EXPIRED") {
          return jsonResponse(400, { error: "invoice-material request rejected" });
        }
        claimed = true;
        const material = selectedSolverInvoiceMaterialBinding(await Promise.race([
          serviceLease.resolve({
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            capabilityDigest: request.capabilityDigest,
            selectedOfferId: request.selectedOfferId,
            amountSats: request.amountSats,
          }, {
            recovery: claim.lease.recovery,
            signal: controller.signal,
          }),
          deadline,
        ]));
        if (controller.signal.aborted) throw new Error("invoice-material provider was interrupted");
        const servedAt = integer(nowSeconds(), "invoice-material provider response time", 1);
        store.observeTime({ now: servedAt });
        const expiresAt = Math.min(request.expiresAt, servedAt + responseTtlSeconds);
        if (expiresAt <= servedAt) throw new Error("invoice-material response window expired");
        const response = buildSignedSelectedSolverInvoiceMaterialResponse({
          request,
          material,
          providerKeyId,
          providerPrivateKey,
          servedAt,
          expiresAt,
        });
        const responseJson = JSON.stringify(response);
        const responseDigest = selectedSolverInvoiceMaterialResponseDigest(response);
        const completedAt = integer(nowSeconds(), "invoice-material provider commit time", 1);
        store.observeTime({ now: completedAt });
        if (controller.signal.aborted || !store.complete(claim.lease, {
          responseJson,
          responseDigest,
          responseExpiresAt: response.expiresAt,
          now: completedAt,
        })) throw new Error("invoice-material provider lost its completion lease");
        return jsonResponse(200, responseJson);
      } catch {
        return claimed || claimAttempted
          ? jsonResponse(503, { error: "invoice-material recovery required" }, { "retry-after": "1" })
          : jsonResponse(400, { error: "invoice-material request rejected" });
      } finally {
        clearTimeout(timer);
        controller.abort();
        source.signal.removeEventListener("abort", forwardAbort);
        webRequest?.signal?.removeEventListener?.("abort", forwardAbort);
      }
    },
    status() {
      if (this !== route || !ROUTES.has(this)) {
        throw new TypeError("invoice-material provider route lacks provenance");
      }
      const now = integer(nowSeconds(), "invoice-material provider status time", 1);
      store.observeTime({ now });
      return Object.freeze({
        ...store.status({ now }),
        provider: Object.freeze({
          schema: "treeswap.selected-solver-invoice-material-provider.v1",
          state: source.signal.aborted ? "stopped" : "active",
          mode,
          authenticated: true,
          encryptedTransportRequired: true,
          recoveryCapable: true,
          networkListener: false,
          exposesPreimage: false,
          exposesLndCredential: false,
          fundingAuthorization: false,
          settlementAuthorization: false,
        }),
      });
    },
  });
  ROUTES.add(route);
  return route;
}

export function createSelectedSolverInvoiceMaterialProviderRoute(input) {
  return createRoute(input, "production");
}

export function createTestSelectedSolverInvoiceMaterialProviderRoute(input) {
  return createRoute(input, "injected-test");
}

export function isSelectedSolverInvoiceMaterialProviderRoute(value) {
  return Boolean(value && ROUTES.has(value));
}
