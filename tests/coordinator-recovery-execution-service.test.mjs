import assert from "node:assert/strict";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCoordinatorRecoveryExecutionBootstrap,
  startCoordinatorRecoveryExecutionService,
} from "../lib/coordinator-recovery-execution-service.mjs";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  acquireCoordinatorServiceLease,
  normalizeCoordinatorServiceConfig,
  readCoordinatorServiceHealth,
} from "../lib/coordinator-service-state.mjs";

async function fixture(t) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "treeswap-recovery-service-"));
  const root = await realpath(temporaryRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return Object.freeze({
    root,
    databasePath: join(root, "data", "coordinator.sqlite"),
    runtimeDirectory: join(root, "run"),
    manifestPath: join(root, "inputs", "recovery.json"),
  });
}

function environment(paths, overrides = {}) {
  return {
    COORDINATOR_MODE: "recovery-execution-only",
    COORDINATOR_DATABASE_PATH: paths.databasePath,
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "30",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: paths.manifestPath,
    COORDINATOR_RECOVERY_REFRESH_SECONDS: "5",
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "1000",
    COORDINATOR_RECOVERY_ACTION_INTERVAL_SECONDS: "5",
    COORDINATOR_RECOVERY_PREPARATION_TIMEOUT_SECONDS: "10",
    TREESWAP_FUNDING_ENABLED: "false",
    ...overrides,
  };
}

function activeRecoveryVerification(now) {
  const attemptAt = new Date(now * 1_000).toISOString();
  return Object.freeze({
    schema: "treeswap.coordinator-recovery-verification.v1",
    state: "active",
    scope: "verification-only-no-recovery-context-action-dispatch-new-exposure-or-funding-authority",
    lastAttemptAt: attemptAt,
    lastSuccessAt: attemptAt,
    consecutiveFailures: 0,
    releaseId: `0x${"1".repeat(64)}`,
    validUntil: now + 60,
    recordDigest: `0x${"2".repeat(64)}`,
    policyDigest: `0x${"3".repeat(64)}`,
    inputManifestDigest: `0x${"4".repeat(64)}`,
    approvalBundleDigest: `0x${"5".repeat(64)}`,
    providerConsensusDigest: `0x${"6".repeat(64)}`,
    runtimeBlockNumber: 1_200,
    runtimeBlockHash: `0x${"7".repeat(64)}`,
    gateOpen: false,
    emergencyHalted: true,
    bitPaused: false,
    balancesReconciled: true,
    authorizations: Object.freeze({
      signing: false,
      broadcast: false,
      gateOpening: false,
      lightningDispatch: false,
      newExposure: false,
      funding: false,
    }),
  });
}

test("bootstrap stays unhealthy and aborts cooperative custody preparation before releasing resources", async (t) => {
  const paths = await fixture(t);
  const config = normalizeCoordinatorServiceConfig(environment(paths));
  const lease = await acquireCoordinatorServiceLease(config);
  const store = await CoordinatorStore.open(paths.databasePath);
  let active = true;
  let refreshCalls = 0;
  let stopCalls = 0;
  const recoverySupervisor = Object.freeze({
    refresh: async () => {
      refreshCalls += 1;
      return activeRecoveryVerification(Math.floor(Date.now() / 1_000));
    },
    status: ({ now = Math.floor(Date.now() / 1_000) } = {}) => (
      active ? activeRecoveryVerification(now) : { state: "inactive" }
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
  const bootstrap = createCoordinatorRecoveryExecutionBootstrap({
    heartbeatSeconds: 5,
    intervalSeconds: 5,
    preparationTimeoutSeconds: 10,
    prepareJobSetVerification: ({ abortSignal, recoverySupervisor: receivedSupervisor,
      serviceLease: receivedLease, store: receivedStore }) => {
      assert.equal(receivedSupervisor, recoverySupervisor);
      assert.equal(receivedLease, lease);
      assert.equal(receivedStore, store);
      preparationStarted();
      return new Promise((_, reject) => {
        abortSignal.addEventListener("abort", () => {
          preparationAborted = true;
          reject(new Error("test custody preparation aborted"));
        }, { once: true });
      });
    },
    recoveredInterruptedActions: 0,
    recoveryRefreshSeconds: 5,
    recoverySupervisor,
    serviceLease: lease,
    signal: controller.signal,
    store,
  });
  try {
    const starting = bootstrap.start();
    await didStart;
    const status = bootstrap.status();
    assert.equal(status.schema, "treeswap.coordinator-recovery-execution-bootstrap-status.v1");
    assert.equal(status.phase, "preparing-custody-job-set");
    assert.equal(status.boundedExistingLiabilityEvmClaimRecovery, false);
    assert.equal(status.lightningDispatchAuthorization, false);
    assert.equal(status.newExposureAuthorization, false);
    assert.equal(status.fundingAuthorization, false);
    assert.equal(JSON.stringify(status).includes("test-only"), false);
    await assert.rejects(readCoordinatorServiceHealth(config), /bootstrap is incomplete/);
    controller.abort();
    const stopped = bootstrap.waitUntilStopped();
    await assert.rejects(starting, /test custody preparation aborted/);
    assert.deepEqual(await stopped, { reason: "aborted" });
    assert.deepEqual(await bootstrap.stop(), { reason: "aborted" });
    assert.equal(preparationAborted, true);
    assert.equal(refreshCalls, 0);
    assert.equal(stopCalls, 1);
    await assert.rejects(bootstrap.publishStatus(), /is stopped/);
    await assert.rejects(bootstrap.start(), /cannot be restarted/);
  } finally {
    store.close();
    await lease.release();
  }
});

test("packaged recovery service releases its lease when recovery evidence is unavailable", async (t) => {
  const paths = await fixture(t);
  let preparationCalled = false;
  await assert.rejects(startCoordinatorRecoveryExecutionService({
    environment: environment(paths),
    fetchImpl: async () => { throw new Error("network must not be reached"); },
    prepareJobSetVerification: async () => {
      preparationCalled = true;
      throw new Error("must not prepare without verified custody");
    },
    signal: null,
  }), /verification is inactive/);
  assert.equal(preparationCalled, false);
  assert.equal((await lstat(paths.databasePath)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.runtimeDirectory)).mode & 0o777, 0o700);
  await assert.rejects(lstat(join(paths.runtimeDirectory, "coordinator.lease")), { code: "ENOENT" });
});

test("packaged recovery service rejects the wrong mode or an already-aborted start before acquiring custody", async (t) => {
  const wrongMode = await fixture(t);
  await assert.rejects(startCoordinatorRecoveryExecutionService({
    environment: {
      COORDINATOR_DATABASE_PATH: wrongMode.databasePath,
      COORDINATOR_RUNTIME_DIRECTORY: wrongMode.runtimeDirectory,
    },
    fetchImpl: async () => { throw new Error("unreachable"); },
    prepareJobSetVerification: async () => { throw new Error("unreachable"); },
    signal: null,
  }), /requires recovery-execution-only mode/);
  await assert.rejects(lstat(wrongMode.databasePath), { code: "ENOENT" });
  await assert.rejects(lstat(wrongMode.runtimeDirectory), { code: "ENOENT" });

  const aborted = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startCoordinatorRecoveryExecutionService({
    environment: environment(aborted),
    fetchImpl: async () => { throw new Error("unreachable"); },
    prepareJobSetVerification: async () => { throw new Error("unreachable"); },
    signal: controller.signal,
  }), /was aborted/);
  await assert.rejects(lstat(aborted.databasePath), { code: "ENOENT" });
  await assert.rejects(lstat(aborted.runtimeDirectory), { code: "ENOENT" });
});
