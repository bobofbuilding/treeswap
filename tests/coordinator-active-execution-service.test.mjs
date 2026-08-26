import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCoordinatorActiveExecutionBootstrap,
  startCoordinatorActiveExecutionService,
} from "../lib/coordinator-active-execution-service.mjs";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  acquireCoordinatorServiceLease,
  buildCoordinatorActiveExecutionStatus,
  normalizeCoordinatorServiceConfig,
  readCoordinatorServiceHealth,
} from "../lib/coordinator-service-state.mjs";

async function fixture(t) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "treeswap-active-service-"));
  const root = await realpath(temporaryRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return Object.freeze({
    root,
    databasePath: join(root, "data", "coordinator.sqlite"),
    runtimeDirectory: join(root, "run"),
    manifestPath: join(root, "inputs", "release.json"),
  });
}

function environment(paths, overrides = {}) {
  return {
    COORDINATOR_MODE: "active-execution-only",
    COORDINATOR_DATABASE_PATH: paths.databasePath,
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "30",
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: paths.manifestPath,
    COORDINATOR_RELEASE_REFRESH_SECONDS: "5",
    COORDINATOR_RELEASE_PROVIDER_TIMEOUT_MS: "1000",
    COORDINATOR_ACTIVE_EXECUTION_INTERVAL_SECONDS: "5",
    COORDINATOR_ACTIVE_MAX_SETTLEMENTS_PER_CYCLE: "8",
    COORDINATOR_ACTIVE_PREPARATION_TIMEOUT_SECONDS: "10",
    COORDINATOR_ACTIVE_REPLICA_MODE: "single-host",
    COORDINATOR_ACTIVE_EXPECTED_REPLICAS: "1",
    TREESWAP_FUNDING_ENABLED: "false",
    ...overrides,
  };
}

function activeReleaseVerification(now) {
  const attemptAt = new Date(now * 1_000).toISOString();
  return Object.freeze({
    schema: "treeswap.coordinator-release-verification.v1",
    state: "active",
    scope: "verification-only-no-listener-solver-context-dispatch-or-funding-authority",
    lastAttemptAt: attemptAt,
    lastSuccessAt: attemptAt,
    consecutiveFailures: 0,
    releaseId: `0x${"1".repeat(64)}`,
    fundingMode: "operator-testnet-bootstrap",
    validUntil: now + 60,
    recordDigest: `0x${"2".repeat(64)}`,
    policyDigest: `0x${"3".repeat(64)}`,
    inputManifestDigest: `0x${"4".repeat(64)}`,
    approvalBundleDigest: `0x${"5".repeat(64)}`,
    reconciliationDigest: `0x${"6".repeat(64)}`,
    providerConsensusDigest: `0x${"7".repeat(64)}`,
    runtimeBlockNumber: 1_200,
    runtimeBlockHash: `0x${"8".repeat(64)}`,
    authorizations: Object.freeze({
      signing: false,
      broadcast: false,
      gateOpening: false,
      dispatch: false,
      funding: false,
    }),
  });
}

function aggregateActiveServiceStatus(store, startedAt, observedAt) {
  const observed = new Date(observedAt * 1_000).toISOString();
  const releaseVerification = activeReleaseVerification(observedAt);
  return buildCoordinatorActiveExecutionStatus({
    store,
    serviceStartedAt: new Date(startedAt * 1_000).toISOString(),
    heartbeatAt: observed,
    leaseIdentifier: `sha256:${"1".repeat(64)}`,
    recoveredInterruptedActions: 0,
    releaseVerification,
    activeExecution: {
      schema: "treeswap.coordinator-active-execution-lifecycle.v1",
      state: "active",
      scope: "database-derived-lightning-bit-settlements-only-no-network-job-intake",
      workSource: "original-coordinator-store-nonterminal-settlements",
      networkListener: false,
      startedAt: new Date(startedAt * 1_000).toISOString(),
      lastAttemptAt: observed,
      lastSuccessAt: observed,
      consecutiveFailures: 0,
      releaseRecordDigest: releaseVerification.recordDigest,
      policySetDigest: `0x${"9".repeat(64)}`,
      policyCount: 1,
      counts: {
        discovered: 0,
        eligible: 0,
        attempted: 0,
        advanced: 0,
        waiting: 0,
        gateClosed: 0,
        done: 0,
        halted: 0,
        backlog: 0,
      },
      cycleDigest: `0x${"a".repeat(64)}`,
      cursorDigest: null,
      authorizations: {
        funding: true,
        lightningDispatch: true,
        newExposure: true,
      },
    },
  });
}

test("supervision status is healthy only for one current durably recorded active run", async (t) => {
  const paths = await fixture(t);
  const activeEnvironment = environment(paths);
  const now = Math.floor(Date.now() / 1_000);
  const store = await CoordinatorStore.open(paths.databasePath);
  const run = store.beginServiceRun({
    mode: "active-execution-only",
    startedAt: now,
    failureWindowSeconds: 300,
    maximumFailures: 3,
  });
  store.recordServiceRunStatus({
    handle: run.handle,
    observedAt: now,
    status: aggregateActiveServiceStatus(store, now, now),
  });
  const healthy = spawnSync(process.execPath, ["infra/coordinator/supervision-status.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ...activeEnvironment },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).lastStatusHealthy, true);
  store.finishServiceRun({ handle: run.handle, finishedAt: now, reason: "requested" });
  store.close();
  const stopped = spawnSync(process.execPath, ["infra/coordinator/supervision-status.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ...activeEnvironment },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(stopped.status, 1);
  assert.equal(JSON.parse(stopped.stdout).state, "STOPPED");
});

test("active bootstrap stays unhealthy and revokes verification while aborting policy preparation", async (t) => {
  const paths = await fixture(t);
  const config = normalizeCoordinatorServiceConfig(environment(paths));
  const lease = await acquireCoordinatorServiceLease(config);
  const store = await CoordinatorStore.open(paths.databasePath);
  let active = true;
  let stopCalls = 0;
  const releaseSupervisor = Object.freeze({
    refresh: async () => activeReleaseVerification(Math.floor(Date.now() / 1_000)),
    status: ({ now = Math.floor(Date.now() / 1_000) } = {}) => (
      active ? activeReleaseVerification(now) : { state: "inactive" }
    ),
    stop: () => {
      stopCalls += 1;
      active = false;
      return true;
    },
    useActiveActivation: (callback) => callback(Object.freeze({ activation: "test-only" })),
  });
  let preparationStarted;
  const didStart = new Promise((resolve) => { preparationStarted = resolve; });
  let preparationAborted = false;
  const controller = new AbortController();
  const bootstrap = createCoordinatorActiveExecutionBootstrap({
    heartbeatSeconds: 5,
    integritySeconds: 10,
    intervalSeconds: 5,
    maxSettlementsPerCycle: 8,
    preparationTimeoutSeconds: 10,
    prepareExecutionPolicySet: ({ abortSignal, releaseSupervisor: receivedSupervisor,
      serviceLease: receivedLease, store: receivedStore }) => {
      assert.equal(receivedSupervisor, releaseSupervisor);
      assert.equal(receivedLease, lease);
      assert.equal(receivedStore, store);
      preparationStarted();
      return new Promise((_, reject) => {
        abortSignal.addEventListener("abort", () => {
          preparationAborted = true;
          reject(new Error("test active policy preparation aborted"));
        }, { once: true });
      });
    },
    recordStatus: async () => {},
    recoveredInterruptedActions: 0,
    releaseRefreshSeconds: 5,
    releaseSupervisor,
    serviceLease: lease,
    signal: controller.signal,
    store,
  });
  try {
    const starting = bootstrap.start();
    await didStart;
    const status = bootstrap.status();
    assert.equal(status.schema, "treeswap.coordinator-active-execution-bootstrap-status.v1");
    assert.equal(status.phase, "preparing-active-execution-policy-set");
    assert.equal(status.expectedReplicas, 1);
    assert.equal(status.fundingAuthorization, false);
    assert.equal(status.lightningDispatchAuthorization, false);
    assert.equal(status.newExposureAuthorization, false);
    assert.equal(JSON.stringify(status).includes("test-only"), false);
    await assert.rejects(readCoordinatorServiceHealth(config), /bootstrap is incomplete/);
    controller.abort();
    const stopped = bootstrap.waitUntilStopped();
    await assert.rejects(starting, /test active policy preparation aborted/);
    assert.deepEqual(await stopped, { reason: "aborted" });
    assert.deepEqual(await bootstrap.stop(), { reason: "aborted" });
    assert.equal(preparationAborted, true);
    assert.equal(stopCalls, 1);
    await assert.rejects(bootstrap.publishStatus(), /is stopped/);
    await assert.rejects(bootstrap.start(), /cannot be restarted/);
  } finally {
    store.close();
    await lease.release();
  }
});

test("packaged active service releases its lease when release evidence is unavailable", async (t) => {
  const paths = await fixture(t);
  let preparationCalled = false;
  await assert.rejects(startCoordinatorActiveExecutionService({
    environment: environment(paths),
    fetchImpl: async () => { throw new Error("network must not be reached"); },
    prepareExecutionPolicySet: async () => {
      preparationCalled = true;
      throw new Error("must not prepare without a verified release");
    },
    signal: null,
  }), /verification is inactive/);
  assert.equal(preparationCalled, false);
  assert.equal((await lstat(paths.databasePath)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.runtimeDirectory)).mode & 0o777, 0o700);
  await assert.rejects(lstat(join(paths.runtimeDirectory, "coordinator.lease")), { code: "ENOENT" });
  const failedStore = await CoordinatorStore.open(paths.databasePath);
  assert.equal(failedStore.serviceRunStatus().state, "FAILED");
  assert.equal(failedStore.serviceRunStatus().outcome, "startup-failure");
  assert.equal(failedStore.serviceRunStatus().failureCount, 1);
  assert.equal(failedStore.serviceRunStatus().fundingAuthorization, false);
  failedStore.close();
});

test("packaged active service opens its durable crash-loop breaker before another release attempt", async (t) => {
  const paths = await fixture(t);
  const activeEnvironment = environment(paths, {
    COORDINATOR_ACTIVE_FAILURE_WINDOW_SECONDS: "300",
    COORDINATOR_ACTIVE_MAXIMUM_FAILURES: "2",
  });
  let policyPreparations = 0;
  const start = () => startCoordinatorActiveExecutionService({
    environment: activeEnvironment,
    fetchImpl: async () => { throw new Error("network must not be reached"); },
    prepareExecutionPolicySet: async () => {
      policyPreparations += 1;
      throw new Error("must not prepare without a verified release");
    },
    signal: null,
  });
  await assert.rejects(start(), /verification is inactive/);
  await assert.rejects(start(), /verification is inactive/);
  await assert.rejects(start(), /crash-loop breaker is open/);
  assert.equal(policyPreparations, 0);
  const store = await CoordinatorStore.open(paths.databasePath);
  const status = store.serviceRunStatus();
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.failureCount, 2);
  assert.equal(status.maximumFailures, 2);
  assert.equal(status.crashLoopOpen, true);
  assert.equal(status.fundingAuthorization, false);
  store.close();
  await assert.rejects(lstat(join(paths.runtimeDirectory, "coordinator.lease")), { code: "ENOENT" });
});

test("packaged active service rejects the wrong mode, missing replica declaration, or aborted start", async (t) => {
  const wrongMode = await fixture(t);
  await assert.rejects(startCoordinatorActiveExecutionService({
    environment: {
      COORDINATOR_DATABASE_PATH: wrongMode.databasePath,
      COORDINATOR_RUNTIME_DIRECTORY: wrongMode.runtimeDirectory,
    },
    fetchImpl: async () => { throw new Error("unreachable"); },
    prepareExecutionPolicySet: async () => { throw new Error("unreachable"); },
    signal: null,
  }), /requires active-execution-only mode/);
  await assert.rejects(lstat(wrongMode.databasePath), { code: "ENOENT" });
  await assert.rejects(lstat(wrongMode.runtimeDirectory), { code: "ENOENT" });

  const missingReplica = await fixture(t);
  await assert.rejects(startCoordinatorActiveExecutionService({
    environment: environment(missingReplica, {
      COORDINATOR_ACTIVE_REPLICA_MODE: undefined,
      COORDINATOR_ACTIVE_EXPECTED_REPLICAS: undefined,
    }),
    fetchImpl: async () => { throw new Error("unreachable"); },
    prepareExecutionPolicySet: async () => { throw new Error("unreachable"); },
    signal: null,
  }), /single-host replica mode/);
  await assert.rejects(lstat(missingReplica.databasePath), { code: "ENOENT" });

  const aborted = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startCoordinatorActiveExecutionService({
    environment: environment(aborted),
    fetchImpl: async () => { throw new Error("unreachable"); },
    prepareExecutionPolicySet: async () => { throw new Error("unreachable"); },
    signal: controller.signal,
  }), /was aborted/);
  await assert.rejects(lstat(aborted.databasePath), { code: "ENOENT" });
  await assert.rejects(lstat(aborted.runtimeDirectory), { code: "ENOENT" });
});
