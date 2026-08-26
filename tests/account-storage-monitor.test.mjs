import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ACCOUNT_STORAGE_BACKLOG_PROBE_LIMIT,
  ACCOUNT_STORAGE_MONITOR_PRIVACY,
  ACCOUNT_STORAGE_MONITOR_SQL,
  buildAccountStorageAccessObservation,
  buildAccountStorageMaintenanceObservation,
  collectAccountStorageDatabaseObservation,
  collectAccountStorageDatabaseObservationForTests,
  evaluateAccountStorageMonitor,
  runAccountStorageMonitorCycleForTests,
  runAccountStorageMonitorCycle,
} from "../lib/account-storage-monitor.mjs";

const NOW = 2_100_000_000;
const digest = (label) => `0x${createHash("sha256").update(label).digest("hex")}`;

function databaseBinding(counts = [0, 0, 0], overrides = {}) {
  const observed = { sql: [], binds: [], statements: null };
  return {
    observed,
    prepare(sql) {
      observed.sql.push(sql);
      if (overrides.prepareThrows) throw new Error("credential-bearing database failure");
      return {
        bind(...values) {
          observed.binds.push(values);
          return { sql, values };
        },
      };
    },
    async batch(statements) {
      observed.statements = statements;
      if (overrides.batchThrows) throw new Error("raw row and storage secret");
      if (overrides.results) return overrides.results;
      return [
        { success: true, results: [] },
        ...counts.map((count) => ({ success: true, results: [{ count }] })),
      ];
    },
  };
}

function monotonic(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

async function databaseObservation({ counts = [0, 0, 0], elapsed = 25, binding } = {}) {
  return collectAccountStorageDatabaseObservationForTests({
    binding: binding ?? databaseBinding(counts),
    observedAt: NOW,
    monotonicMilliseconds: monotonic(1_000, 1_000 + elapsed),
  });
}

function accessObservation(overrides = {}) {
  return buildAccountStorageAccessObservation({
    auditCoverageComplete: true,
    evidenceDigest: digest("retained access evidence"),
    observedAt: NOW,
    observedFrom: NOW - 300,
    privilegeChangeEvents: 0,
    unauthorizedReadAttempts: 0,
    unauthorizedWriteAttempts: 0,
    ...overrides,
  });
}

function maintenanceObservation(overrides = {}) {
  return buildAccountStorageMaintenanceObservation({
    evidenceDigest: digest("retained maintenance evidence"),
    lastCompletedAt: NOW - 60,
    moreWorkPossible: false,
    observedAt: NOW,
    status: "completed",
    ...overrides,
  });
}

async function healthyInput(overrides = {}) {
  return {
    accessObservation: accessObservation(),
    databaseObservation: await databaseObservation(),
    maintenanceObservation: maintenanceObservation(),
    now: NOW,
    ...overrides,
  };
}

test("collects one bounded aggregate D1 probe without retaining account rows", async () => {
  const db = databaseBinding([1, 2, 3]);
  const observation = await databaseObservation({ binding: db });

  assert.equal(observation.status, "healthy");
  assert.equal(observation.storageAvailable, true);
  assert.equal(observation.schemaValid, true);
  assert.equal(observation.latencyMilliseconds, 25);
  assert.deepEqual(observation.expired, { nonces: 1, sessions: 2, notifications: 3 });
  assert.equal(observation.backlogProbeSaturated, false);
  assert.equal(observation.privacy, ACCOUNT_STORAGE_MONITOR_PRIVACY);
  assert.deepEqual(db.observed.sql, Object.values(ACCOUNT_STORAGE_MONITOR_SQL));
  assert.equal(db.observed.statements.length, 4);
  assert.deepEqual(db.observed.binds, [
    ...Array(3).fill([new Date(NOW * 1_000).toISOString(), ACCOUNT_STORAGE_BACKLOG_PROBE_LIMIT]),
  ]);
  for (const sql of db.observed.sql.slice(1)) {
    assert.match(sql, /COUNT\(\*\)/);
    assert.match(sql, /LIMIT \?/);
    assert.doesNotMatch(sql, /SELECT\s+(?:nonce|token_hash|wallet_address|email)/i);
  }
  assert.doesNotMatch(JSON.stringify(observation), /(credential-bearing|raw row|wallet.?address|token.?hash|email|invoice|preimage)/i);
});

test("production collector and cycle do not accept caller clocks, timeouts, or policies", async () => {
  const db = databaseBinding();
  await assert.rejects(() => collectAccountStorageDatabaseObservation({
    binding: db,
    observedAt: NOW,
    monotonicMilliseconds: () => 0,
  }), /fields are not exact/);

  const input = await healthyInput();
  await assert.rejects(() => runAccountStorageMonitorCycle({
    accessObservation: input.accessObservation,
    alertRoutes: [async () => ({ delivered: true }), async () => ({ delivered: true })],
    databaseObservation: input.databaseObservation,
    maintenanceObservation: input.maintenanceObservation,
    nowSeconds: () => NOW,
  }), /fields are not exact/);
});

test("database outage, malformed results, rollback, saturation, and latency fail closed", async () => {
  const outage = await databaseObservation({ binding: databaseBinding([0, 0, 0], { batchThrows: true }) });
  assert.equal(outage.status, "unsafe");
  assert.equal(outage.storageAvailable, false);
  assert.equal(outage.collectionFailure, "DATABASE_PROBE_FAILED");
  assert.equal(JSON.stringify(outage).includes("storage secret"), false);

  const malformed = await databaseObservation({
    binding: databaseBinding([], { results: [{ success: true, results: [] }] }),
  });
  assert.equal(malformed.collectionFailure, "DATABASE_RESPONSE_INVALID");

  const rollback = await collectAccountStorageDatabaseObservationForTests({
    binding: databaseBinding(),
    observedAt: NOW,
    monotonicMilliseconds: monotonic(1_000, 999, 998),
  });
  assert.equal(rollback.status, "unsafe");
  assert.equal(rollback.collectionFailure, "DATABASE_PROBE_FAILED");

  const saturated = await databaseObservation({ counts: [ACCOUNT_STORAGE_BACKLOG_PROBE_LIMIT, 0, 0] });
  const slow = await databaseObservation({ elapsed: 1_001 });
  const saturatedResult = evaluateAccountStorageMonitor(await healthyInput({ databaseObservation: saturated }));
  const slowResult = evaluateAccountStorageMonitor(await healthyInput({ databaseObservation: slow }));
  assert.ok(saturatedResult.reasonCodes.includes("PURGE_BACKLOG_PROBE_SATURATED"));
  assert.ok(saturatedResult.reasonCodes.includes("CHALLENGE_PURGE_BACKLOG_EXCEEDED"));
  assert.ok(slowResult.reasonCodes.includes("DATABASE_LATENCY_EXCEEDED"));
});

test("a fresh complete access window, fast D1 probe, and recent drained maintenance are healthy", async () => {
  const result = evaluateAccountStorageMonitor(await healthyInput());
  assert.equal(result.status, "healthy");
  assert.deepEqual(result.reasonCodes, []);
  assert.match(result.policyDigest, /^0x[0-9a-f]{64}$/);
  assert.match(result.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(result.accountDisableAuthority, false);
  assert.equal(result.externalInputAuthenticationVerified, false);
  assert.equal(result.continuousDeploymentVerified, false);
  assert.equal(result.retainedMonitoringWindowVerified, false);
  assert.equal(result.pagingProviderIndependenceVerified, false);
  assert.equal(result.walletDispatchAuthority, false);
  assert.equal(result.lightningDispatchAuthority, false);
  assert.equal(result.settlementAuthority, false);
  assert.equal(result.fundingAuthorization, false);
  assert.equal(result.releaseActivationAuthority, false);
});

test("access gaps, unauthorized use, privilege changes, maintenance failure, and backlog are unsafe", async () => {
  const access = accessObservation({
    auditCoverageComplete: false,
    observedFrom: NOW - 299,
    privilegeChangeEvents: 1,
    unauthorizedReadAttempts: 2,
    unauthorizedWriteAttempts: 3,
  });
  const maintenance = maintenanceObservation({
    lastCompletedAt: NOW - 1_801,
    moreWorkPossible: true,
    status: "failed",
  });
  const result = evaluateAccountStorageMonitor(await healthyInput({
    accessObservation: access,
    maintenanceObservation: maintenance,
  }));
  for (const reason of [
    "ACCESS_AUDIT_COVERAGE_INCOMPLETE",
    "ACCESS_AUDIT_WINDOW_TOO_SHORT",
    "ACCESS_PRIVILEGE_CHANGE_OBSERVED",
    "UNAUTHORIZED_READ_OBSERVED",
    "UNAUTHORIZED_WRITE_OBSERVED",
    "MAINTENANCE_FAILED",
    "MAINTENANCE_STALE",
    "PURGE_BACKLOG_REMAINS",
  ]) assert.ok(result.reasonCodes.includes(reason), reason);
  assert.equal(result.status, "unsafe");
  assert.doesNotMatch(JSON.stringify(result), /(wallet.?address|token.?hash|session.?cookie|email|invoice|payment.?hash|preimage|nonce)/i);
});

test("future, stale, copied, decorated, coercible, or accessor observations and policies reject safely", async () => {
  const stale = evaluateAccountStorageMonitor(await healthyInput({ now: NOW + 121 }));
  assert.ok(stale.reasonCodes.includes("DATABASE_OBSERVATION_STALE"));
  assert.ok(stale.reasonCodes.includes("ACCESS_OBSERVATION_STALE"));
  assert.ok(stale.reasonCodes.includes("MAINTENANCE_OBSERVATION_STALE"));

  const future = evaluateAccountStorageMonitor(await healthyInput({
    accessObservation: accessObservation({ observedAt: NOW + 1 }),
  }));
  assert.ok(future.reasonCodes.includes("ACCESS_OBSERVATION_FUTURE"));

  const original = await healthyInput();
  const copied = evaluateAccountStorageMonitor({
    ...original,
    accessObservation: { ...original.accessObservation },
    databaseObservation: { ...original.databaseObservation },
    maintenanceObservation: { ...original.maintenanceObservation },
  });
  assert.deepEqual(copied.reasonCodes, [
    "ACCESS_OBSERVATION_INVALID",
    "DATABASE_OBSERVATION_INVALID",
    "MAINTENANCE_OBSERVATION_INVALID",
  ]);

  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "observedAt", {
    enumerable: true,
    get() { getterCalls += 1; return NOW; },
  });
  for (const candidate of [
    accessor,
    { auditCoverageComplete: true },
    Object.assign(Object.create({ inherited: true }), {
      auditCoverageComplete: true,
      evidenceDigest: digest("x"),
      observedAt: NOW,
      observedFrom: NOW - 300,
      privilegeChangeEvents: 0,
      unauthorizedReadAttempts: 0,
      unauthorizedWriteAttempts: 0,
    }),
  ]) assert.throws(() => buildAccountStorageAccessObservation(candidate), /plain|fields/);
  assert.equal(getterCalls, 0);

  assert.throws(() => evaluateAccountStorageMonitor({
    ...original,
    now: { valueOf: () => NOW },
  }), /safe integer/);
  assert.throws(() => evaluateAccountStorageMonitor({
    ...original,
    policy: { maximumDatabaseLatencyMilliseconds: 1_000 },
  }), /fields are not exact/);
});

test("healthy cycles take no action; unsafe cycles use both secret-free alert routes", async () => {
  let calls = 0;
  const healthy = await runAccountStorageMonitorCycleForTests({
    ...await healthyInput(),
    nowSeconds: () => NOW,
    alertRoutes: [async () => { calls += 1; return { delivered: true }; }, async () => {
      calls += 1;
      return { delivered: true };
    }],
  });
  assert.equal(healthy.outcome, "HEALTHY");
  assert.equal(calls, 0);

  const alerts = [];
  const unsafeInput = await healthyInput({
    accessObservation: accessObservation({ unauthorizedReadAttempts: 1 }),
  });
  const escalated = await runAccountStorageMonitorCycleForTests({
    ...unsafeInput,
    nowSeconds: () => NOW,
    alertRoutes: [
      async (alert, { signal }) => {
        alerts.push(alert);
        assert.equal(signal.aborted, false);
        return { delivered: true };
      },
      async (alert) => {
        alerts.push(alert);
        return { delivered: true };
      },
    ],
  });
  assert.equal(escalated.outcome, "ESCALATED");
  assert.equal(escalated.alertRoutesAttempted, 2);
  assert.equal(escalated.alertRoutesDelivered, 2);
  assert.equal(escalated.alertDeliveryDegraded, false);
  assert.equal(escalated.accountDisableAuthority, false);
  assert.equal(escalated.fundingAuthorization, false);
  assert.equal(escalated.productionReadiness, false);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0], alerts[1]);
  assert.doesNotMatch(JSON.stringify(alerts), /(wallet.?address|token.?hash|email|invoice|payment.?hash|preimage|nonce)/i);
});

test("missing, malformed, failed, or timed-out escalation never becomes a successful delivery", async () => {
  const unsafeInput = await healthyInput({
    maintenanceObservation: maintenanceObservation({ status: "failed" }),
  });
  const missing = await runAccountStorageMonitorCycleForTests({
    ...unsafeInput,
    nowSeconds: () => NOW,
    alertRoutes: [async () => ({ delivered: true })],
  });
  assert.equal(missing.outcome, "ESCALATION_INCOMPLETE");
  assert.equal(missing.alertRoutesAttempted, 0);

  const degraded = await runAccountStorageMonitorCycleForTests({
    ...unsafeInput,
    nowSeconds: () => NOW,
    alertTimeoutMilliseconds: 5,
    alertRoutes: [
      async () => ({ delivered: true, secret: "must not count" }),
      async () => new Promise(() => {}),
    ],
  });
  assert.equal(degraded.outcome, "ESCALATION_INCOMPLETE");
  assert.equal(degraded.alertRoutesAttempted, 2);
  assert.equal(degraded.alertRoutesDelivered, 0);
  assert.equal(degraded.alertDeliveryDegraded, true);

  const oneRoute = await runAccountStorageMonitorCycleForTests({
    ...unsafeInput,
    nowSeconds: () => NOW,
    alertRoutes: [
      async () => ({ delivered: true }),
      async () => { throw new Error("alert provider secret"); },
    ],
  });
  assert.equal(oneRoute.outcome, "ESCALATED");
  assert.equal(oneRoute.alertRoutesDelivered, 1);
  assert.equal(oneRoute.alertDeliveryDegraded, true);
  assert.equal(JSON.stringify(oneRoute).includes("provider secret"), false);
});
