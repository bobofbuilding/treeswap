import { createHash, createHmac } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const RFQ_QUOTE_INGRESS_STORE_SCHEMA = "treeswap.rfq-quote-ingress-store.v1";

const LOWER_BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const META_TABLE = "rfq_quote_ingress_meta";
const REQUEST_TABLE = "rfq_quote_ingress_requests";
const META_SQL = `CREATE TABLE ${META_TABLE} (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT`;
const REQUEST_SQL = `CREATE TABLE ${REQUEST_TABLE} (
  request_id TEXT PRIMARY KEY NOT NULL,
  identity_commitment TEXT NOT NULL,
  request_nonce TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  authorization_digest TEXT NOT NULL,
  session_digest TEXT UNIQUE,
  request_expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CLAIMED', 'READY', 'SELECTED')),
  claimed_at INTEGER NOT NULL,
  ready_at INTEGER,
  selected_at INTEGER,
  UNIQUE (identity_commitment, request_nonce),
  CHECK (request_expires_at > claimed_at),
  CHECK ((state = 'CLAIMED') = (session_digest IS NULL)),
  CHECK ((state = 'CLAIMED') = (ready_at IS NULL)),
  CHECK ((state = 'SELECTED') = (selected_at IS NOT NULL)),
  CHECK (ready_at IS NULL OR ready_at >= claimed_at),
  CHECK (selected_at IS NULL OR selected_at >= ready_at)
) STRICT`;
const STORE_FIELDS = Object.freeze([
  "allowMemory",
  "identityKey",
  "initialize",
  "maximumActiveSessionsPerIdentity",
  "maximumLiveRequests",
  "maximumRequestLifetimeSeconds",
  "maximumRequestsPerIdentityWindow",
  "maximumRequestsPerWindowGlobal",
  "path",
  "policyDigest",
  "quotaWindowSeconds",
]);
const CLAIM_FIELDS = Object.freeze([
  "authorizationDigest", "expiresAt", "identity", "now", "requestDigest", "requestId", "requestNonce",
]);
const READY_FIELDS = Object.freeze(["expiresAt", "now", "sessionToken"]);
const SELECT_FIELDS = Object.freeze(["now", "sessionToken"]);
const STORE_TOKEN = Symbol("TreeSwap RFQ quote ingress store");
const STORES = new WeakSet();
const STORE_BINDINGS = new WeakMap();
const CLAIMS = new WeakMap();
const SELECTION_CLAIMS = new WeakMap();

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

function decimal(value, name) {
  const raw = String(value ?? "");
  if (!DECIMAL.test(raw) || raw.length > 78 || BigInt(raw) > UINT256_MAX) {
    throw new TypeError(`${name} must be a canonical uint256 decimal integer`);
  }
  return raw;
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!LOWER_BYTES32.test(raw)) throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  return raw;
}

function identity(value) {
  const raw = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(raw) || /^0x0{40}$/.test(raw)) {
    throw new TypeError("RFQ quote ingress identity must be a nonzero Ethereum address");
  }
  return raw;
}

function identityKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("RFQ quote ingress identity key must contain exactly 32 bytes");
  }
  return Buffer.from(value);
}

function digestKey(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function hmac(key, scope, value) {
  return `0x${createHmac("sha256", key).update(`${scope}:${value}`).digest("hex")}`;
}

function sql(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "");
}

function canonicalStoredInteger(value, name) {
  const raw = String(value ?? "");
  if (!DECIMAL.test(raw)) throw new Error(`${name} is not a canonical stored integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== raw) {
    throw new Error(`${name} is outside the safe stored range`);
  }
  return parsed;
}

function storedMeta(database) {
  return new Map(database.prepare(`SELECT key, value FROM ${META_TABLE} ORDER BY key`).all()
    .map(({ key, value }) => [key, value]));
}

function verifyDatabase(database, binding, { requireSchema = true } = {}) {
  const check = database.prepare("PRAGMA quick_check").all();
  if (check.length !== 1 || Object.values(check[0]).length !== 1
      || Object.values(check[0])[0] !== "ok") {
    throw new Error("RFQ quote ingress database quick check failed");
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
    throw new Error("RFQ quote ingress database layout is unsupported");
  }
  const meta = storedMeta(database);
  const expected = new Map([
    ["clock_high_water", meta.get("clock_high_water")],
    ["identity_key_digest", binding.identityKeyDigest],
    ["maximum_active_sessions_per_identity", String(binding.maximumActiveSessionsPerIdentity)],
    ["maximum_live_requests", String(binding.maximumLiveRequests)],
    ["maximum_request_lifetime_seconds", String(binding.maximumRequestLifetimeSeconds)],
    ["maximum_requests_per_identity_window", String(binding.maximumRequestsPerIdentityWindow)],
    ["maximum_requests_per_window_global", String(binding.maximumRequestsPerWindowGlobal)],
    ["policy_digest", binding.policyDigest],
    ["quota_window_seconds", String(binding.quotaWindowSeconds)],
    ["schema", RFQ_QUOTE_INGRESS_STORE_SCHEMA],
  ]);
  if (meta.size !== expected.size || [...expected].some(([key, value]) => meta.get(key) !== value)) {
    throw new Error("RFQ quote ingress database policy or schema is unsupported");
  }
  canonicalStoredInteger(meta.get("clock_high_water"), "RFQ quote ingress clock high-water mark");
}

function storedClock(database) {
  const value = database.prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'clock_high_water'`).get()?.value;
  return canonicalStoredInteger(value, "RFQ quote ingress clock high-water mark");
}

function advanceClock(database, now) {
  const previous = storedClock(database);
  if (now < previous) throw new Error("RFQ quote ingress clock regressed");
  if (now === previous) return;
  const changed = database.prepare(`
    UPDATE ${META_TABLE} SET value = ? WHERE key = 'clock_high_water' AND value = ?
  `).run(String(now), String(previous));
  if (Number(changed.changes) !== 1) throw new Error("RFQ quote ingress clock update failed");
}

async function privateDatabasePath(rawPath) {
  if (!isAbsolute(rawPath) || rawPath.includes("\0") || rawPath.length > 4_096) {
    throw new TypeError("RFQ quote ingress database path must be a bounded absolute path");
  }
  const requested = resolve(rawPath);
  const parent = dirname(requested);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentState = await lstat(parent);
  if (parentState.isSymbolicLink() || !parentState.isDirectory()) {
    throw new Error("RFQ quote ingress database parent must be a private directory");
  }
  await chmod(parent, 0o700);
  const resolvedParent = await realpath(parent);
  const path = join(resolvedParent, basename(requested));
  let exists = false;
  try {
    const state = await lstat(path);
    exists = true;
    if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0) {
      throw new Error("RFQ quote ingress database must be a private regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ exists, path });
}

function normalizedBinding(source, key) {
  const binding = Object.freeze({
    identityKeyDigest: digestKey(key),
    maximumActiveSessionsPerIdentity: integer(
      source.maximumActiveSessionsPerIdentity,
      "RFQ quote ingress maximum active sessions per identity",
      1,
      20,
    ),
    maximumLiveRequests: integer(source.maximumLiveRequests, "RFQ quote ingress maximum live requests", 1, 4_096),
    maximumRequestLifetimeSeconds: integer(
      source.maximumRequestLifetimeSeconds,
      "RFQ quote ingress maximum request lifetime",
      1,
      300,
    ),
    maximumRequestsPerIdentityWindow: integer(
      source.maximumRequestsPerIdentityWindow,
      "RFQ quote ingress identity window quota",
      1,
      1_000,
    ),
    maximumRequestsPerWindowGlobal: integer(
      source.maximumRequestsPerWindowGlobal,
      "RFQ quote ingress global window quota",
      1,
      100_000,
    ),
    policyDigest: bytes32(source.policyDigest, "RFQ quote ingress policy digest"),
    quotaWindowSeconds: integer(source.quotaWindowSeconds, "RFQ quote ingress quota window", 1, 86_400),
  });
  if (binding.maximumRequestsPerWindowGlobal < binding.maximumRequestsPerIdentityWindow) {
    throw new RangeError("RFQ quote ingress global window quota is below one identity quota");
  }
  return binding;
}

export class RfqQuoteIngressStore {
  #binding;
  #database;
  #identityKey;
  #path;
  #closed = false;

  constructor(database, path, identityKeyValue, binding, token) {
    if (token !== STORE_TOKEN) throw new TypeError("RFQ quote ingress stores must be opened through the factory");
    this.#database = database;
    this.#path = path;
    this.#identityKey = identityKeyValue;
    this.#binding = binding;
    STORES.add(this);
    STORE_BINDINGS.set(this, binding);
    Object.freeze(this);
  }

  static async open(input) {
    const source = exactDataRecord(input, STORE_FIELDS, "RFQ quote ingress store input");
    const allowMemory = source.allowMemory === true;
    if (source.initialize !== true && source.initialize !== false) {
      throw new TypeError("RFQ quote ingress initialize must be a boolean");
    }
    const initialize = source.initialize;
    const key = identityKey(source.identityKey);
    const binding = normalizedBinding(source, key);
    let path;
    if (source.path === ":memory:") {
      if (!allowMemory || !initialize) throw new Error("in-memory RFQ quote ingress storage is initialization-only test state");
      path = source.path;
    } else {
      if (allowMemory) throw new Error("RFQ quote ingress allowMemory is valid only for :memory:");
      const resolved = await privateDatabasePath(String(source.path ?? ""));
      path = resolved.path;
      if (initialize && resolved.exists) throw new Error("RFQ quote ingress database already exists");
      if (!initialize && !resolved.exists) throw new Error("RFQ quote ingress database requires explicit initialization");
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
      verifyDatabase(database, binding, { requireSchema: false });
      const count = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
      `).get().count);
      if (count === 0 && !initialize) throw new Error("RFQ quote ingress database is empty");
      if (count === 0) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(`${META_SQL}; ${REQUEST_SQL};`);
          for (const [keyName, value] of [
            ["schema", RFQ_QUOTE_INGRESS_STORE_SCHEMA],
            ["clock_high_water", "0"],
            ["policy_digest", binding.policyDigest],
            ["identity_key_digest", binding.identityKeyDigest],
            ["maximum_active_sessions_per_identity", String(binding.maximumActiveSessionsPerIdentity)],
            ["maximum_live_requests", String(binding.maximumLiveRequests)],
            ["maximum_request_lifetime_seconds", String(binding.maximumRequestLifetimeSeconds)],
            ["maximum_requests_per_identity_window", String(binding.maximumRequestsPerIdentityWindow)],
            ["maximum_requests_per_window_global", String(binding.maximumRequestsPerWindowGlobal)],
            ["quota_window_seconds", String(binding.quotaWindowSeconds)],
          ]) database.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`).run(keyName, value);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      verifyDatabase(database, binding);
      if (path !== ":memory:") {
        await chmod(path, 0o600);
        const state = await lstat(path);
        if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0) {
          throw new Error("RFQ quote ingress database is not a private regular file");
        }
      }
      return new RfqQuoteIngressStore(database, path, key, binding, STORE_TOKEN);
    } catch (error) {
      try { database?.close(); } catch {}
      throw error;
    }
  }

  #assertOpen() {
    if (this.#closed) throw new Error("RFQ quote ingress store is closed");
  }

  #transaction(run) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      verifyDatabase(this.#database, this.#binding);
      const result = run();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  observeTime(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, ["now"], "RFQ quote ingress clock observation");
    const now = integer(source.now, "RFQ quote ingress observation time", 1);
    return this.#transaction(() => {
      advanceClock(this.#database, now);
      return true;
    });
  }

  claim(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, CLAIM_FIELDS, "RFQ quote ingress request claim");
    const requestId = bytes32(source.requestId, "RFQ quote ingress request ID");
    const requestDigest = bytes32(source.requestDigest, "RFQ quote ingress request digest");
    const authorizationDigest = bytes32(source.authorizationDigest, "RFQ quote ingress authorization digest");
    const requestNonce = decimal(source.requestNonce, "RFQ quote ingress request nonce");
    const now = integer(source.now, "RFQ quote ingress claim time", 1);
    const expiresAt = integer(source.expiresAt, "RFQ quote ingress request expiry", 1);
    if (expiresAt <= now || expiresAt - now > this.#binding.maximumRequestLifetimeSeconds) {
      throw new RangeError("RFQ quote ingress request is outside its live window");
    }
    const identityCommitment = hmac(this.#identityKey, "identity", identity(source.identity));
    const inserted = this.#transaction(() => {
      advanceClock(this.#database, now);
      const windowStart = Math.max(0, now - this.#binding.quotaWindowSeconds);
      this.#database.prepare(`
        DELETE FROM ${REQUEST_TABLE} WHERE request_expires_at <= ? AND claimed_at <= ?
      `).run(now, windowStart);
      const globalWindow = Number(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM ${REQUEST_TABLE} WHERE claimed_at > ?
      `).get(windowStart).count);
      const identityWindow = Number(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM ${REQUEST_TABLE}
        WHERE identity_commitment = ? AND claimed_at > ?
      `).get(identityCommitment, windowStart).count);
      const globalLive = Number(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM ${REQUEST_TABLE}
        WHERE request_expires_at > ? AND state != 'SELECTED'
      `).get(now).count);
      const identityLive = Number(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM ${REQUEST_TABLE}
        WHERE identity_commitment = ? AND request_expires_at > ? AND state != 'SELECTED'
      `).get(identityCommitment, now).count);
      if (globalWindow >= this.#binding.maximumRequestsPerWindowGlobal
          || identityWindow >= this.#binding.maximumRequestsPerIdentityWindow
          || globalLive >= this.#binding.maximumLiveRequests
          || identityLive >= this.#binding.maximumActiveSessionsPerIdentity) {
        throw new Error("RFQ quote ingress quota is exhausted");
      }
      const result = this.#database.prepare(`
        INSERT OR IGNORE INTO ${REQUEST_TABLE} (
          request_id, identity_commitment, request_nonce, request_digest, authorization_digest,
          session_digest, request_expires_at, state, claimed_at, ready_at, selected_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'CLAIMED', ?, NULL, NULL)
      `).run(
        requestId,
        identityCommitment,
        requestNonce,
        requestDigest,
        authorizationDigest,
        expiresAt,
        now,
      );
      return Number(result.changes) === 1;
    });
    if (!inserted) return null;
    const claim = Object.freeze({
      schema: RFQ_QUOTE_INGRESS_STORE_SCHEMA,
      status: "request-claimed",
      expiresAt,
    });
    CLAIMS.set(claim, Object.freeze({
      authorizationDigest,
      expiresAt,
      ready: false,
      requestDigest,
      requestId,
      store: this,
    }));
    return claim;
  }

  ready(claim, input) {
    this.#assertOpen();
    const context = CLAIMS.get(claim);
    if (!context || context.store !== this) throw new TypeError("RFQ quote ingress claim provenance is invalid");
    if (context.ready) return null;
    const source = exactDataRecord(input, READY_FIELDS, "RFQ quote ingress ready session");
    const now = integer(source.now, "RFQ quote ingress ready time", 1);
    const expiresAt = integer(source.expiresAt, "RFQ quote ingress session expiry", 1);
    const token = bytes32(source.sessionToken, "RFQ quote ingress session token");
    if (expiresAt <= now || expiresAt > context.expiresAt) return null;
    const sessionDigest = hmac(this.#identityKey, "session", token);
    const changed = this.#transaction(() => {
      advanceClock(this.#database, now);
      const result = this.#database.prepare(`
        UPDATE ${REQUEST_TABLE}
        SET session_digest = ?, request_expires_at = ?, state = 'READY', ready_at = ?
        WHERE request_id = ? AND request_digest = ? AND authorization_digest = ?
          AND request_expires_at > ? AND state = 'CLAIMED' AND session_digest IS NULL
      `).run(
        sessionDigest,
        expiresAt,
        now,
        context.requestId,
        context.requestDigest,
        context.authorizationDigest,
        now,
      );
      return Number(result.changes) === 1;
    });
    if (!changed) return null;
    CLAIMS.set(claim, Object.freeze({ ...context, ready: true }));
    return Object.freeze({
      schema: RFQ_QUOTE_INGRESS_STORE_SCHEMA,
      status: "session-ready",
      expiresAt,
      sessionDigest,
    });
  }

  claimSelection(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, SELECT_FIELDS, "RFQ quote ingress selection claim");
    const now = integer(source.now, "RFQ quote ingress selection time", 1);
    const token = bytes32(source.sessionToken, "RFQ quote ingress session token");
    const sessionDigest = hmac(this.#identityKey, "session", token);
    const row = this.#transaction(() => {
      advanceClock(this.#database, now);
      const record = this.#database.prepare(`
        SELECT request_expires_at FROM ${REQUEST_TABLE}
        WHERE session_digest = ? AND state = 'READY' AND request_expires_at > ?
      `).get(sessionDigest, now);
      if (!record) return null;
      const result = this.#database.prepare(`
        UPDATE ${REQUEST_TABLE} SET state = 'SELECTED', selected_at = ?
        WHERE session_digest = ? AND state = 'READY' AND request_expires_at = ?
      `).run(now, sessionDigest, record.request_expires_at);
      return Number(result.changes) === 1 ? record : null;
    });
    if (!row) return null;
    const selectionClaim = Object.freeze({
      schema: RFQ_QUOTE_INGRESS_STORE_SCHEMA,
      status: "selection-claimed",
      expiresAt: Number(row.request_expires_at),
    });
    SELECTION_CLAIMS.set(selectionClaim, Object.freeze({ sessionDigest, store: this }));
    return selectionClaim;
  }

  status(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, ["now"], "RFQ quote ingress store status");
    const now = integer(source.now, "RFQ quote ingress status time", 1);
    verifyDatabase(this.#database, this.#binding);
    if (now < storedClock(this.#database)) throw new Error("RFQ quote ingress clock regressed");
    const row = this.#database.prepare(`
      SELECT
        SUM(CASE WHEN request_expires_at > ? AND state = 'CLAIMED' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN request_expires_at > ? AND state = 'READY' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN state = 'SELECTED' THEN 1 ELSE 0 END) AS selected,
        SUM(CASE WHEN request_expires_at <= ? AND state != 'SELECTED' THEN 1 ELSE 0 END) AS expired
      FROM ${REQUEST_TABLE}
    `).get(now, now, now);
    return Object.freeze({
      schema: RFQ_QUOTE_INGRESS_STORE_SCHEMA,
      status: "healthy-private-quote-ingress-store",
      liveClaimedRequests: Number(row.claimed ?? 0),
      liveReadySessions: Number(row.ready ?? 0),
      selectedSessions: Number(row.selected ?? 0),
      expiredRequestsAwaitingCleanup: Number(row.expired ?? 0),
      maximumLiveRequests: this.#binding.maximumLiveRequests,
      fundingAuthorization: false,
      settlementAuthorization: false,
      networkListener: false,
    });
  }

  get path() {
    return this.#path;
  }

  close() {
    if (this.#closed) return false;
    this.#closed = true;
    this.#identityKey.fill(0);
    this.#database.close();
    STORES.delete(this);
    return true;
  }
}

Object.freeze(RfqQuoteIngressStore.prototype);
Object.freeze(RfqQuoteIngressStore);

export function isRfqQuoteIngressStore(value) {
  return Boolean(value && STORES.has(value));
}

export function rfqQuoteIngressStoreBinding(store) {
  if (!isRfqQuoteIngressStore(store)) throw new TypeError("RFQ quote ingress store provenance is invalid");
  return STORE_BINDINGS.get(store);
}

export function rfqQuoteIngressSelectionBinding(claim) {
  const context = SELECTION_CLAIMS.get(claim);
  if (!context) throw new TypeError("RFQ quote ingress selection claim provenance is invalid");
  return Object.freeze({ sessionDigest: context.sessionDigest, store: context.store });
}
