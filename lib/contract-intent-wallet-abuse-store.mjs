import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CONTRACT_INTENT_WALLET_ABUSE_STORE_SCHEMA =
  "treeswap.contract-intent-wallet-abuse-store.v1";

const SESSION_DIGEST = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const MAXIMUM_SESSION_SECONDS = 24 * 60 * 60;
const MAXIMUM_ENTRIES = 128;
const RATE_WINDOW_SECONDS = 60;
const RATE_REQUESTS_PER_WINDOW = 8;
const META_TABLE = "wallet_intent_abuse_meta";
const WINDOW_TABLE = "wallet_intent_abuse_windows";
const META_SQL = `CREATE TABLE ${META_TABLE} (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT`;
const WINDOW_SQL = `CREATE TABLE ${WINDOW_TABLE} (
  session_key TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  session_expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  CHECK (length(session_key) = 66),
  CHECK (window_started_at > 0),
  CHECK (request_count >= 1 AND request_count <= 8),
  CHECK (session_expires_at > window_started_at),
  CHECK (session_expires_at <= window_started_at + 86400),
  CHECK (last_seen_at >= window_started_at),
  CHECK (last_seen_at < window_started_at + 60),
  CHECK (last_seen_at < session_expires_at)
) STRICT`;
const STORE_FIELDS = Object.freeze(["allowMemory", "initialize", "path"]);
const CONSUME_FIELDS = Object.freeze(["now", "sessionDigest", "sessionExpiresAt"]);
const STORE_TOKEN = Symbol("TreeSwap contract-intent wallet abuse store");
const STORE_CONTEXTS = new WeakMap();

export class ContractIntentWalletAbuseRateLimitError extends Error {}
export class ContractIntentWalletAbuseClockRollbackError extends Error {}

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

function canonicalStoredInteger(value, name) {
  const raw = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${name} is not a canonical stored integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== raw) {
    throw new Error(`${name} is outside the safe stored range`);
  }
  return parsed;
}

function normalizedSql(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "");
}

function sessionKey(value) {
  if (typeof value !== "string" || !SESSION_DIGEST.test(value)) {
    throw new TypeError("wallet abuse session digest must be nonzero lowercase bytes32");
  }
  return `0x${createHash("sha256")
    .update("TreeSwap durable wallet-intent abuse session v1\n", "utf8")
    .update(value, "utf8")
    .digest("hex")}`;
}

async function privateDatabasePath(rawPath) {
  if (typeof rawPath !== "string" || !isAbsolute(rawPath) || rawPath.includes("\0")
      || rawPath.length > 4_096 || basename(rawPath).length === 0) {
    throw new TypeError("wallet abuse database path must be a bounded absolute path");
  }
  const requested = resolve(rawPath);
  const parent = dirname(requested);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentState = await lstat(parent);
  if (parentState.isSymbolicLink() || !parentState.isDirectory()) {
    throw new Error("wallet abuse database parent must be a private directory");
  }
  await chmod(parent, 0o700);
  const canonicalParent = await realpath(parent);
  const path = join(canonicalParent, basename(requested));
  let exists = false;
  try {
    const state = await lstat(path);
    exists = true;
    if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0) {
      throw new Error("wallet abuse database must be a private regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ exists, path });
}

function storedMeta(database) {
  return new Map(database.prepare(
    `SELECT key, value FROM ${META_TABLE} ORDER BY key`,
  ).all().map(({ key, value }) => [key, value]));
}

function verifyStoredWindows(database, clockHighWater) {
  const rows = database.prepare(`
    SELECT session_key AS sessionKey,
           window_started_at AS windowStartedAt,
           request_count AS requestCount,
           session_expires_at AS sessionExpiresAt,
           last_seen_at AS lastSeenAt
    FROM ${WINDOW_TABLE}
    ORDER BY session_key
  `).all();
  if (rows.length > MAXIMUM_ENTRIES) {
    throw new Error("wallet abuse database exceeds the active-window bound");
  }
  for (const value of rows) {
    const row = exactRecord(value, [
      "lastSeenAt",
      "requestCount",
      "sessionExpiresAt",
      "sessionKey",
      "windowStartedAt",
    ], "wallet abuse stored window");
    if (typeof row.sessionKey !== "string" || !/^0x(?!0{64}$)[0-9a-f]{64}$/.test(row.sessionKey)) {
      throw new Error("wallet abuse stored session key is invalid");
    }
    const windowStartedAt = integer(
      row.windowStartedAt,
      "wallet abuse stored window start",
      1,
      clockHighWater,
    );
    const lastSeenAt = integer(
      row.lastSeenAt,
      "wallet abuse stored last-seen time",
      windowStartedAt,
      clockHighWater,
    );
    const sessionExpiresAt = integer(
      row.sessionExpiresAt,
      "wallet abuse stored session expiry",
      lastSeenAt + 1,
      windowStartedAt + MAXIMUM_SESSION_SECONDS,
    );
    integer(
      row.requestCount,
      "wallet abuse stored request count",
      1,
      RATE_REQUESTS_PER_WINDOW,
    );
    if (lastSeenAt >= windowStartedAt + RATE_WINDOW_SECONDS
        || sessionExpiresAt <= lastSeenAt) {
      throw new Error("wallet abuse stored window timing is invalid");
    }
  }
}

function verifyDatabase(database, { requireSchema = true } = {}) {
  const check = database.prepare("PRAGMA quick_check").all();
  if (check.length !== 1 || Object.values(check[0]).length !== 1
      || Object.values(check[0])[0] !== "ok") {
    throw new Error("wallet abuse database quick check failed");
  }
  const objects = database.prepare(`
    SELECT name, sql, type FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  if (objects.length === 0 && !requireSchema) return;
  if (objects.length !== 2
      || objects[0].type !== "table" || objects[0].name !== META_TABLE
      || objects[1].type !== "table" || objects[1].name !== WINDOW_TABLE
      || normalizedSql(objects[0].sql) !== normalizedSql(META_SQL)
      || normalizedSql(objects[1].sql) !== normalizedSql(WINDOW_SQL)) {
    throw new Error("wallet abuse database layout is unsupported");
  }
  const meta = storedMeta(database);
  const expected = new Map([
    ["clock_high_water", meta.get("clock_high_water")],
    ["maximum_entries", String(MAXIMUM_ENTRIES)],
    ["rate_requests_per_window", String(RATE_REQUESTS_PER_WINDOW)],
    ["rate_window_seconds", String(RATE_WINDOW_SECONDS)],
    ["schema", CONTRACT_INTENT_WALLET_ABUSE_STORE_SCHEMA],
  ]);
  if (meta.size !== expected.size || [...expected].some(([key, value]) => meta.get(key) !== value)) {
    throw new Error("wallet abuse database policy or schema is unsupported");
  }
  const clockHighWater = canonicalStoredInteger(
    meta.get("clock_high_water"),
    "wallet abuse clock high-water mark",
  );
  verifyStoredWindows(database, clockHighWater);
}

function openDatabase(path) {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  database.exec(`
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA trusted_schema=OFF;
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=DELETE;
  `);
  return database;
}

function createSchema(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`${META_SQL}; ${WINDOW_SQL};`);
    for (const [key, value] of [
      ["schema", CONTRACT_INTENT_WALLET_ABUSE_STORE_SCHEMA],
      ["clock_high_water", "0"],
      ["maximum_entries", String(MAXIMUM_ENTRIES)],
      ["rate_window_seconds", String(RATE_WINDOW_SECONDS)],
      ["rate_requests_per_window", String(RATE_REQUESTS_PER_WINDOW)],
    ]) database.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`).run(key, value);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function contextFor(value) {
  const context = value && typeof value === "object" ? STORE_CONTEXTS.get(value) : null;
  if (!context) throw new TypeError("wallet abuse store requires its original factory product");
  return context;
}

function assertReceiver(context, receiver) {
  const expected = context.lease ?? context.store;
  if (receiver !== expected || context.state !== "active") {
    throw new TypeError("wallet abuse operation requires the original active store lifecycle");
  }
}

function countEntries(database) {
  const value = database.prepare(`SELECT COUNT(*) AS count FROM ${WINDOW_TABLE}`).get()?.count;
  return integer(Number(value), "wallet abuse active entry count", 0, MAXIMUM_ENTRIES);
}

function consume(context, receiver, input) {
  assertReceiver(context, receiver);
  const source = exactRecord(input, CONSUME_FIELDS, "wallet abuse consumption");
  const now = integer(source.now, "wallet abuse time", 1);
  const sessionExpiresAt = integer(
    source.sessionExpiresAt,
    "wallet abuse session expiry",
    now + 1,
    now + MAXIMUM_SESSION_SECONDS,
  );
  const key = sessionKey(source.sessionDigest);
  let transactionOpen = false;
  let rejected = false;
  try {
    context.database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const meta = storedMeta(context.database);
    if (meta.size !== 5
        || meta.get("schema") !== CONTRACT_INTENT_WALLET_ABUSE_STORE_SCHEMA
        || meta.get("maximum_entries") !== String(MAXIMUM_ENTRIES)
        || meta.get("rate_window_seconds") !== String(RATE_WINDOW_SECONDS)
        || meta.get("rate_requests_per_window") !== String(RATE_REQUESTS_PER_WINDOW)) {
      throw new Error("wallet abuse database policy changed");
    }
    const previousClock = canonicalStoredInteger(
      meta.get("clock_high_water"),
      "wallet abuse clock high-water mark",
    );
    if (now < previousClock) {
      throw new ContractIntentWalletAbuseClockRollbackError("wallet abuse clock regressed");
    }
    if (now > previousClock) {
      const changed = context.database.prepare(`
        UPDATE ${META_TABLE} SET value = ?
        WHERE key = 'clock_high_water' AND value = ?
      `).run(String(now), String(previousClock));
      if (Number(changed.changes) !== 1) throw new Error("wallet abuse clock update failed");
    }
    context.database.prepare(`
      DELETE FROM ${WINDOW_TABLE}
      WHERE session_expires_at <= ? OR window_started_at + ? <= ?
    `).run(now, RATE_WINDOW_SECONDS, now);
    const existing = context.database.prepare(`
      SELECT request_count AS requestCount,
             session_expires_at AS sessionExpiresAt,
             window_started_at AS windowStartedAt,
             last_seen_at AS lastSeenAt
      FROM ${WINDOW_TABLE}
      WHERE session_key = ?
    `).get(key);
    if (!existing) {
      if (countEntries(context.database) >= MAXIMUM_ENTRIES) {
        rejected = true;
      } else {
        const inserted = context.database.prepare(`
          INSERT INTO ${WINDOW_TABLE} (
            session_key, window_started_at, request_count, session_expires_at, last_seen_at
          ) VALUES (?, ?, 1, ?, ?)
        `).run(key, now, sessionExpiresAt, now);
        if (Number(inserted.changes) !== 1) throw new Error("wallet abuse window insert failed");
      }
    } else {
      const record = exactRecord(existing, [
        "lastSeenAt",
        "requestCount",
        "sessionExpiresAt",
        "windowStartedAt",
      ], "wallet abuse stored window");
      const requestCount = integer(
        record.requestCount,
        "wallet abuse stored request count",
        1,
        RATE_REQUESTS_PER_WINDOW,
      );
      const storedExpiresAt = integer(
        record.sessionExpiresAt,
        "wallet abuse stored session expiry",
        now + 1,
        now + MAXIMUM_SESSION_SECONDS,
      );
      const windowStartedAt = integer(
        record.windowStartedAt,
        "wallet abuse stored window start",
        1,
        now,
      );
      integer(record.lastSeenAt, "wallet abuse stored last-seen time", windowStartedAt, now);
      if (storedExpiresAt !== sessionExpiresAt
          || windowStartedAt + RATE_WINDOW_SECONDS <= now) {
        throw new Error("wallet abuse stored window is inconsistent");
      }
      if (requestCount >= RATE_REQUESTS_PER_WINDOW) {
        rejected = true;
      } else {
        const updated = context.database.prepare(`
          UPDATE ${WINDOW_TABLE}
          SET request_count = ?, last_seen_at = ?
          WHERE session_key = ? AND request_count = ?
            AND session_expires_at = ? AND window_started_at = ?
        `).run(
          requestCount + 1,
          now,
          key,
          requestCount,
          sessionExpiresAt,
          windowStartedAt,
        );
        if (Number(updated.changes) !== 1) throw new Error("wallet abuse window update failed");
      }
    }
    context.database.exec("COMMIT");
    transactionOpen = false;
    if (rejected) {
      context.rateRejected += 1;
      throw new ContractIntentWalletAbuseRateLimitError("wallet abuse rate limit is exceeded");
    }
    context.accepted += 1;
    return Object.freeze({
      schema: "treeswap.contract-intent-wallet-abuse-consumption.v1",
      accepted: true,
      durable: true,
      requestLimit: RATE_REQUESTS_PER_WINDOW,
      windowSeconds: RATE_WINDOW_SECONDS,
      walletDispatchAuthority: false,
      lightningDispatchAuthority: false,
      fundingAuthorization: false,
    });
  } catch (error) {
    if (transactionOpen) {
      try { context.database.exec("ROLLBACK"); } catch {}
    }
    if (error instanceof ContractIntentWalletAbuseRateLimitError) throw error;
    context.state = "halted";
    if (error instanceof ContractIntentWalletAbuseClockRollbackError) {
      context.haltedOnClockRollback = true;
      throw error;
    }
    context.haltedOnStorageFailure = true;
    throw new Error("wallet abuse store failed closed", { cause: error });
  }
}

function status(context, receiver) {
  const expected = context.lease ?? context.store;
  if (receiver !== expected || context.state === "closed") {
    throw new TypeError("wallet abuse status requires the original store lifecycle");
  }
  let activeWindows = 0;
  if (context.state !== "closed") {
    try {
      activeWindows = countEntries(context.database);
    } catch {
      context.state = "halted";
      context.haltedOnStorageFailure = true;
    }
  }
  return Object.freeze({
    schema: "treeswap.contract-intent-wallet-abuse-store-status.v1",
    state: context.state,
    acceptedRequests: context.accepted,
    rateRejectedRequests: context.rateRejected,
    activeWindows,
    maximumEntries: MAXIMUM_ENTRIES,
    requestLimit: RATE_REQUESTS_PER_WINDOW,
    windowSeconds: RATE_WINDOW_SECONDS,
    durableClockHighWater: true,
    rawSessionTokensStored: false,
    sessionTokenHashesStored: false,
    sessionDigestsStored: false,
    walletsStored: false,
    requestBodiesStored: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
    haltedOnClockRollback: context.haltedOnClockRollback,
    haltedOnStorageFailure: context.haltedOnStorageFailure,
  });
}

export class ContractIntentWalletAbuseStore {
  constructor(database, path, token) {
    if (token !== STORE_TOKEN) {
      throw new TypeError("wallet abuse stores must be opened through the factory");
    }
    const context = {
      accepted: 0,
      database,
      haltedOnClockRollback: false,
      haltedOnStorageFailure: false,
      lease: null,
      path,
      rateRejected: 0,
      state: "active",
      store: this,
    };
    STORE_CONTEXTS.set(this, context);
    Object.freeze(this);
  }

  static async open(input) {
    const source = exactRecord(input, STORE_FIELDS, "wallet abuse store input");
    if (source.initialize !== true && source.initialize !== false) {
      throw new TypeError("wallet abuse initialize must be a boolean");
    }
    let path;
    if (source.path === ":memory:") {
      if (source.allowMemory !== true || source.initialize !== true) {
        throw new Error("wallet abuse memory storage is initialized test-only state");
      }
      path = ":memory:";
    } else {
      if (source.allowMemory !== false) {
        throw new Error("wallet abuse allowMemory must be false for persistent storage");
      }
      const resolved = await privateDatabasePath(source.path);
      if (source.initialize && resolved.exists) throw new Error("wallet abuse database already exists");
      if (!source.initialize && !resolved.exists) {
        throw new Error("wallet abuse database requires explicit initialization");
      }
      path = resolved.path;
      if (source.initialize) {
        const handle = await open(path, "wx", 0o600);
        await handle.close();
      }
    }
    let database;
    try {
      database = openDatabase(path);
      verifyDatabase(database, { requireSchema: false });
      const count = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
      `).get().count);
      if (count === 0 && !source.initialize) throw new Error("wallet abuse database is uninitialized");
      if (count === 0) createSchema(database);
      verifyDatabase(database);
      if (path !== ":memory:") {
        await chmod(path, 0o600);
        const state = await lstat(path);
        if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0) {
          throw new Error("wallet abuse database is not a private regular file");
        }
      }
      return new ContractIntentWalletAbuseStore(database, path, STORE_TOKEN);
    } catch (error) {
      try { database?.close(); } catch {}
      throw error;
    }
  }

  consume(input) {
    return consume(contextFor(this), this, input);
  }

  status() {
    return status(contextFor(this), this);
  }

  close() {
    const context = contextFor(this);
    if (context.state === "closed") return;
    if (context.lease !== null && context.state === "active") {
      throw new TypeError("wallet abuse store close requires its edge lifecycle to stop first");
    }
    context.state = "closed";
    context.database.close();
  }
}

export function isContractIntentWalletAbuseStore(value) {
  return Boolean(value && typeof value === "object" && STORE_CONTEXTS.has(value));
}

export function assertContractIntentWalletAbuseStoreLifecycle(store) {
  const context = contextFor(store);
  if (context.state !== "active" || context.lease !== null) {
    throw new TypeError("wallet abuse edge requires an unclaimed active store lifecycle");
  }
  return Object.freeze({
    schema: CONTRACT_INTENT_WALLET_ABUSE_STORE_SCHEMA,
    maximumEntries: MAXIMUM_ENTRIES,
    requestLimit: RATE_REQUESTS_PER_WINDOW,
    windowSeconds: RATE_WINDOW_SECONDS,
  });
}

export function claimContractIntentWalletAbuseStoreEdge(store, signal) {
  const context = contextFor(store);
  if (!(signal instanceof AbortSignal) || signal.aborted || context.state !== "active") {
    throw new TypeError("wallet abuse edge claim requires an active deployment lifecycle");
  }
  if (context.lease !== null) throw new Error("wallet abuse store already belongs to a SIWE edge");
  let lease;
  lease = Object.freeze({
    consume(input) {
      if (this !== lease || context.lease !== lease) {
        throw new TypeError("wallet abuse edge consumption requires the original lease");
      }
      return consume(context, lease, input);
    },
    status() {
      if (this !== lease || context.lease !== lease) {
        throw new TypeError("wallet abuse edge status requires the original lease");
      }
      return status(context, lease);
    },
    stop() {
      if (this !== lease || context.lease !== lease) {
        throw new TypeError("wallet abuse edge stop requires the original lease");
      }
      if (context.state === "active") context.state = "stopped";
      return status(context, lease);
    },
  });
  context.lease = lease;
  signal.addEventListener("abort", () => {
    if (context.state === "active") context.state = "stopped";
  }, { once: true });
  return lease;
}
