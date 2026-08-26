import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { id } from "ethers";
import {
  SCHEDULED_ACCOUNT_MAINTENANCE_CRON,
  SCHEDULED_ACCOUNT_MAINTENANCE_EVIDENCE_PREFIX,
  runScheduledAccountMaintenanceTestOnly,
} from "../lib/scheduled-account-maintenance.mjs";

const SCHEDULED_TIME = Date.parse("2026-08-26T14:30:00.000Z");
const SOURCE_COMMIT = "b".repeat(40);

function controller(overrides = {}) {
  return {
    cron: SCHEDULED_ACCOUNT_MAINTENANCE_CRON,
    scheduledTime: SCHEDULED_TIME,
    ...overrides,
  };
}

function environment({ responses, put } = {}) {
  const observed = { batches: 0, puts: [], prepared: [] };
  const rows = responses ?? [
    { success: true, results: [{ nonce: "must-not-escape" }] },
    { success: true, results: [{ token_hash: "must-not-escape" }] },
    { success: true, results: [{ wallet_address: "must-not-escape" }] },
  ];
  const env = {
    ACCOUNT_MAINTENANCE_MODE: "private-scheduled-only",
    ACCOUNT_MAINTENANCE_SOURCE_COMMIT: SOURCE_COMMIT,
    ACCOUNT_MAINTENANCE_DEPLOYMENT_VERSION: "13",
    ACCOUNT_MAINTENANCE_SOURCE_DATABASE_DIGEST: id("scheduled maintenance source database").toLowerCase(),
    ACCOUNT_MAINTENANCE_EVIDENCE_BUCKET_DIGEST: id("locked maintenance evidence bucket").toLowerCase(),
    DB: {
      prepare(sql) {
        observed.prepared.push(sql);
        return { bind: (...values) => ({ sql, values }) };
      },
      async batch(statements) {
        observed.batches += 1;
        assert.equal(statements.length, 3);
        return rows;
      },
    },
    ACCOUNT_MAINTENANCE_EVIDENCE: {
      async put(key, body, options) {
        observed.puts.push({ key, body, options });
        if (put) return put(key, body, options);
        return { key, size: new TextEncoder().encode(body).byteLength, etag: "etag", version: "version" };
      },
    },
  };
  return { env, observed };
}

function clock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

async function run({ env = environment().env, candidateController = controller(), now = [SCHEDULED_TIME + 1_000, SCHEDULED_TIME + 2_000] } = {}) {
  const logs = [];
  const receipt = await runScheduledAccountMaintenanceTestOnly({
    controller: candidateController,
    env,
    clock: clock(...now),
    log: (value) => logs.push(value),
  });
  return { receipt, logs };
}

test("runs one fixed cron purge and retains only aggregate create-only evidence", async () => {
  const { env, observed } = environment();
  const { receipt, logs } = await run({ env });

  assert.deepEqual(receipt.deleted, { nonces: 1, sessions: 1, notifications: 1 });
  assert.equal(receipt.status, "completed-drained");
  assert.equal(receipt.retained, true);
  assert.equal(observed.batches, 1);
  assert.equal(observed.puts.length, 1);
  const retained = observed.puts[0];
  assert.match(retained.key, new RegExp(`^${SCHEDULED_ACCOUNT_MAINTENANCE_EVIDENCE_PREFIX}`));
  assert.equal(retained.options.onlyIf.get("if-none-match"), "*");
  assert.equal(retained.options.httpMetadata.cacheControl, "no-store");
  assert.equal(retained.options.sha256.byteLength, 32);
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), receipt);
  assert.doesNotMatch(JSON.stringify({ receipt, retained, logs }), /must-not-escape|token_hash|wallet_address/);
  assert.deepEqual(receipt.authorizations, {
    accountEnablement: false,
    outboundDelivery: false,
    walletDispatch: false,
    lightningDispatch: false,
    settlement: false,
    funding: false,
    releaseActivation: false,
  });
});

test("rejects the wrong cadence, future, delayed, or non-minute-aligned schedules before D1", async () => {
  const cases = [
    [controller({ cron: "* * * * *" }), [SCHEDULED_TIME + 1_000, SCHEDULED_TIME + 2_000], /reviewed cadence/],
    [controller({ scheduledTime: SCHEDULED_TIME + 1 }), [SCHEDULED_TIME + 1_000, SCHEDULED_TIME + 2_000], /minute-aligned/],
    [controller(), [SCHEDULED_TIME - 1, SCHEDULED_TIME + 2_000], /delay window/],
    [controller(), [SCHEDULED_TIME + 600_001, SCHEDULED_TIME + 600_002], /delay window/],
  ];
  for (const [candidateController, now, expected] of cases) {
    const { env, observed } = environment();
    await assert.rejects(() => run({ env, candidateController, now }), expected);
    assert.equal(observed.batches, 0);
    assert.equal(observed.puts.length, 0);
  }
});

test("requires exact private mode, source, database, and evidence bindings before deletion", async () => {
  for (const mutate of [
    (env) => { env.ACCOUNT_MAINTENANCE_MODE = "public"; },
    (env) => { env.ACCOUNT_MAINTENANCE_SOURCE_COMMIT = "main"; },
    (env) => { env.ACCOUNT_MAINTENANCE_DEPLOYMENT_VERSION = "0"; },
    (env) => { env.ACCOUNT_MAINTENANCE_SOURCE_DATABASE_DIGEST = `0x${"00".repeat(32)}`; },
    (env) => { env.ACCOUNT_MAINTENANCE_EVIDENCE_BUCKET_DIGEST = env.ACCOUNT_MAINTENANCE_SOURCE_DATABASE_DIGEST; },
    (env) => { env.ACCOUNT_MAINTENANCE_EVIDENCE = env.DB; },
    (env) => { delete env.ACCOUNT_MAINTENANCE_EVIDENCE; },
    (env) => { delete env.DB; },
  ]) {
    const { env, observed } = environment();
    mutate(env);
    await assert.rejects(() => run({ env }), /scheduled account maintenance/);
    assert.equal(observed.batches, 0);
    assert.equal(observed.puts.length, 0);
  }
});

test("D1 or R2 failure never becomes retained evidence and hides provider details", async () => {
  const databaseFailure = environment();
  databaseFailure.env.DB.batch = async () => { throw new Error("secret D1 endpoint detail"); };
  await assert.rejects(() => run({ env: databaseFailure.env }), (error) => {
    assert.equal(error.message, "scheduled account maintenance failed closed");
    return true;
  });
  assert.equal(databaseFailure.observed.puts.length, 0);

  const storageFailure = environment({ put: async () => { throw new Error("secret R2 credential detail"); } });
  await assert.rejects(() => run({ env: storageFailure.env }), (error) => {
    assert.equal(error.message, "scheduled account maintenance failed closed");
    return true;
  });
  assert.equal(storageFailure.observed.batches, 1);
  assert.equal(storageFailure.observed.puts.length, 1);
});

test("retains a saturated result but fails the invocation until backlog is drained", async () => {
  const full = Array.from({ length: 100 }, (_, index) => ({ nonce: String(index) }));
  const { env, observed } = environment({ responses: [
    { success: true, results: full },
    { success: true, results: [] },
    { success: true, results: [] },
  ] });
  const logs = [];
  await assert.rejects(() => runScheduledAccountMaintenanceTestOnly({
    controller: controller(),
    env,
    clock: clock(SCHEDULED_TIME + 1_000, SCHEDULED_TIME + 2_000),
    log: (value) => logs.push(value),
  }), /backlog remains/);
  assert.equal(observed.puts.length, 1);
  assert.equal(JSON.parse(observed.puts[0].body).status, "completed-backlog-remains");
  assert.equal(JSON.parse(logs[0]).moreWorkPossible, true);
});

test("rejects malformed retention receipts instead of claiming durability", async () => {
  for (const stored of [null, {}, { key: "wrong", size: 1, etag: "etag", version: "version" }]) {
    const { env } = environment({ put: async () => stored });
    await assert.rejects(() => run({ env }), /failed closed/);
  }
});

test("production worker exposes only a scheduled handler and no HTTP or funding surface", async () => {
  const worker = await readFile(
    new URL("../infra/account-maintenance-scheduler/worker.mjs", import.meta.url),
    "utf8",
  );
  const runtime = await readFile(new URL("../lib/scheduled-account-maintenance.mjs", import.meta.url), "utf8");
  assert.match(worker, /async scheduled\(controller, env, _ctx\)/);
  assert.match(worker, /runScheduledAccountMaintenance\(controller, env\)/);
  assert.doesNotMatch(worker, /\bfetch\s*\(|request|Response|Authorization|Bearer/);
  assert.doesNotMatch(worker, /fundingAuthorization|settleInvoice|sendPayment|walletClient/i);
  assert.match(runtime, /export async function runScheduledAccountMaintenance\(controller, env\)/);
  const production = runtime.slice(runtime.indexOf("export async function runScheduledAccountMaintenance(controller, env)"));
  const productionBody = production.split("export async function runScheduledAccountMaintenanceTestOnly")[0];
  assert.match(productionBody, /clock: \(\) => Date\.now\(\)/);
  assert.doesNotMatch(productionBody, /rawInput|observedAt/);
});
