import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ACCOUNT_MAINTENANCE_BATCH_LIMIT,
  ACCOUNT_MAINTENANCE_ORIGIN,
  ACCOUNT_MAINTENANCE_SQL,
  isExactAccountMaintenanceOrigin,
  purgeExpiredAccountRecords,
} from "../lib/account-maintenance.mjs";

function binding(responses = [
  { success: true, results: [{ nonce: "redacted" }] },
  { success: true, results: [] },
  { success: true, results: [] },
]) {
  const observed = { sql: [], binds: [], statements: null };
  return {
    observed,
    prepare(sql) {
      observed.sql.push(sql);
      return {
        bind(...values) {
          observed.binds.push(values);
          return { sql, values };
        },
      };
    },
    async batch(statements) {
      observed.statements = statements;
      return responses;
    },
  };
}

test("deletes only bounded expired rows in one D1 batch and returns aggregate counts", async () => {
  const db = binding();
  const result = await purgeExpiredAccountRecords(db, new Date("2026-08-21T20:00:00.000Z"));

  assert.deepEqual(result, {
    schema: "treeswap.account-maintenance.v1",
    status: "completed",
    observedAt: "2026-08-21T20:00:00.000Z",
    batchLimit: 100,
    deleted: { nonces: 1, sessions: 0, notifications: 0 },
    moreWorkPossible: false,
  });
  assert.deepEqual(db.observed.sql, Object.values(ACCOUNT_MAINTENANCE_SQL));
  assert.equal(db.observed.statements.length, 3);
  assert.deepEqual(db.observed.binds, Array(3).fill(["2026-08-21T20:00:00.000Z", ACCOUNT_MAINTENANCE_BATCH_LIMIT]));
  for (const sql of db.observed.sql) {
    assert.match(sql, /WHERE [a-z_]+ <= \?/);
    assert.match(sql, /ORDER BY [a-z_]+ ASC/);
    assert.match(sql, /LIMIT \?/);
    assert.match(sql, /RETURNING/);
    assert.doesNotMatch(sql, /DROP|TRUNCATE/i);
  }
  assert.doesNotMatch(JSON.stringify(result), /redacted|token_hash|wallet_address/);
});

test("executes the exact bounded SQL while preserving every unexpired row", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE siwe_nonces (nonce TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
    CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
    CREATE TABLE notification_preferences (wallet_address TEXT PRIMARY KEY, retention_expires_at TEXT NOT NULL);
    INSERT INTO siwe_nonces VALUES ('expired-nonce', '2026-08-21T19:59:59.999Z');
    INSERT INTO siwe_nonces VALUES ('active-nonce', '2026-08-21T20:00:00.001Z');
    INSERT INTO auth_sessions VALUES ('expired-session', '2026-08-21T20:00:00.000Z');
    INSERT INTO auth_sessions VALUES ('active-session', '2026-08-22T20:00:00.000Z');
    INSERT INTO notification_preferences VALUES ('expired-wallet', '2026-08-20T20:00:00.000Z');
    INSERT INTO notification_preferences VALUES ('active-wallet', '2026-08-22T20:00:00.000Z');
  `);
  const d1 = {
    prepare(sql) {
      return { bind: (...values) => ({ sql, values }) };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({
          success: true,
          results: sqlite.prepare(statement.sql).all(...statement.values),
        }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };

  try {
    const result = await purgeExpiredAccountRecords(d1, "2026-08-21T20:00:00.000Z");
    assert.deepEqual(result.deleted, { nonces: 1, sessions: 1, notifications: 1 });
    assert.equal(sqlite.prepare("SELECT nonce FROM siwe_nonces").all()[0]?.nonce, "active-nonce");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM siwe_nonces").get().count, 1);
    assert.equal(sqlite.prepare("SELECT token_hash FROM auth_sessions").all()[0]?.token_hash, "active-session");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count, 1);
    assert.deepEqual(
      sqlite.prepare("SELECT wallet_address FROM notification_preferences").all()[0]?.wallet_address,
      "active-wallet",
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notification_preferences").get().count, 1);
  } finally {
    sqlite.close();
  }
});

test("signals possible continuation only at the fixed per-table bound", async () => {
  const rows = Array.from({ length: ACCOUNT_MAINTENANCE_BATCH_LIMIT }, (_, index) => ({ nonce: String(index) }));
  const result = await purgeExpiredAccountRecords(binding([
    { success: true, results: rows },
    { success: true, results: [] },
    { success: true, results: [] },
  ]), "2026-08-21T20:00:00.000Z");
  assert.equal(result.moreWorkPossible, true);
  assert.equal(result.deleted.nonces, ACCOUNT_MAINTENANCE_BATCH_LIMIT);
});

test("fails closed on malformed time, storage, batch, failed statements, or oversized results", async (t) => {
  await assert.rejects(() => purgeExpiredAccountRecords(undefined), /storage is unavailable/);
  await assert.rejects(() => purgeExpiredAccountRecords(binding(), "2026-08-21 20:00:00"), /canonical UTC/);
  await assert.rejects(() => purgeExpiredAccountRecords({ prepare() { throw new Error("secret backend detail"); }, batch() {} }), /could not be completed/);
  await assert.rejects(() => purgeExpiredAccountRecords({ prepare() { return {}; }, batch() {} }), /could not be completed/);

  const cases = [
    ["wrong result count", []],
    ["failed statement", [{ success: false, results: [] }, { success: true, results: [] }, { success: true, results: [] }]],
    ["malformed rows", [{ success: true }, { success: true, results: [] }, { success: true, results: [] }]],
    ["oversized rows", [{ success: true, results: Array(101).fill({}) }, { success: true, results: [] }, { success: true, results: [] }]],
  ];
  for (const [name, responses] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () => purgeExpiredAccountRecords(binding(responses), "2026-08-21T20:00:00.000Z"),
        /result|deletion bound/,
      );
    });
  }
});

test("accepts only the exact owner-only deployment origin on both request surfaces", () => {
  assert.equal(isExactAccountMaintenanceOrigin(`${ACCOUNT_MAINTENANCE_ORIGIN}/api/internal/account-maintenance`, ACCOUNT_MAINTENANCE_ORIGIN), true);
  for (const [url, origin] of [
    [`${ACCOUNT_MAINTENANCE_ORIGIN}/api/internal/account-maintenance`, null],
    [`${ACCOUNT_MAINTENANCE_ORIGIN}/api/internal/account-maintenance`, "https://attacker.invalid"],
    ["https://treeswap.vercel.app/api/internal/account-maintenance", ACCOUNT_MAINTENANCE_ORIGIN],
    ["not-a-url", ACCOUNT_MAINTENANCE_ORIGIN],
  ]) assert.equal(isExactAccountMaintenanceOrigin(url, origin), false);
});

test("maintenance route requires exact origin, durable storage, and an active SIWE session", async () => {
  const route = await readFile(new URL("../app/api/internal/account-maintenance/route.ts", import.meta.url), "utf8");
  const nonceRoute = await readFile(new URL("../app/api/auth/nonce/route.ts", import.meta.url), "utf8");
  const server = await readFile(new URL("../lib/siwe-server.ts", import.meta.url), "utf8");
  const routeBody = route.slice(route.indexOf("export async function POST"));

  assert.match(routeBody, /isExactAccountMaintenanceOrigin\(request\.url, request\.headers\.get\("Origin"\)\)/);
  assert.ok(routeBody.indexOf("isExactAccountMaintenanceOrigin") < routeBody.indexOf("requireAccountStorage()"));
  assert.ok(routeBody.indexOf("requireAccountStorage()") < routeBody.indexOf("getCurrentSession"));
  assert.ok(routeBody.indexOf("getCurrentSession") < routeBody.indexOf("purgeExpiredAccountRecords"));
  assert.match(route, /status: 403/);
  assert.match(route, /status: 401/);
  assert.match(route, /noStoreJson/);
  assert.doesNotMatch(nonceRoute, /delete\(siweNonces\)/);
  assert.match(server, /eq\(notificationPreferences\.walletAddress, session\.walletAddress\)/);
  assert.match(server, /lte\(notificationPreferences\.retentionExpiresAt, observedAtIso\)/);
  assert.doesNotMatch(server, /delete\(notificationPreferences\)\.where\(lt\(/);
});
