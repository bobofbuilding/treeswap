import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  acquireCoordinatorServiceLease,
  assertCoordinatorServiceLeaseOwnership,
  buildCoordinatorClosedStatus,
  buildCoordinatorRecoveryExecutionBootstrapStatus,
  buildCoordinatorRecoveryExecutionStatus,
  buildCoordinatorRecoveryVerificationStatus,
  buildCoordinatorReleaseVerificationStatus,
  normalizeCoordinatorServiceConfig,
  readCoordinatorServiceHealth,
  validateCoordinatorClosedStatus,
  validateCoordinatorRecoveryExecutionBootstrapStatus,
  validateCoordinatorRecoveryExecutionStatus,
  validateCoordinatorRecoveryVerificationStatus,
  validateCoordinatorReleaseVerificationStatus,
} from "../lib/coordinator-service-state.mjs";

function fixture(t) {
  return mkdtemp(join(tmpdir(), "treeswap-coordinator-service-")).then(async (temporaryRoot) => {
    const root = await realpath(temporaryRoot);
    t.after(() => rm(root, { recursive: true, force: true }));
    return {
      root,
      databasePath: join(root, "data", "coordinator.sqlite"),
      runtimeDirectory: join(root, "run"),
    };
  });
}

function config(paths, overrides = {}) {
  return normalizeCoordinatorServiceConfig({
    COORDINATOR_DATABASE_PATH: paths.databasePath,
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "30",
    ...overrides,
  });
}

function deterministicRandom() {
  let counter = 0;
  return (size) => Buffer.alloc(size, ++counter);
}

function wholeSecond(milliseconds) {
  return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString();
}

test("accepts only separated, bounded closed, release, recovery-verification, or recovery-execution configuration", async (t) => {
  const paths = await fixture(t);
  const valid = config(paths);
  assert.equal(valid.databasePath, paths.databasePath);
  assert.equal(valid.runtimeDirectory, paths.runtimeDirectory);
  assert.equal(valid.heartbeatSeconds, 5);
  assert.equal(valid.mode, "closed");
  assert.throws(() => config(paths, { COORDINATOR_MODE: "active" }), /mode is not supported/);
  assert.throws(() => config(paths, { TREESWAP_FUNDING_ENABLED: "true" }), /cannot enable funding by configuration/);
  const manifestPath = join(paths.root, "inputs", "activation.json");
  const release = config(paths, {
    COORDINATOR_MODE: "release-verification-only",
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: manifestPath,
    COORDINATOR_RELEASE_REFRESH_SECONDS: "5",
    COORDINATOR_RELEASE_PROVIDER_TIMEOUT_MS: "1000",
  });
  assert.equal(release.mode, "release-verification-only");
  assert.equal(release.releaseActivationManifestPath, manifestPath);
  assert.equal(release.releaseRefreshSeconds, 5);
  assert.equal(release.releaseProviderTimeoutMs, 1000);
  assert.equal(release.recoveryActivationManifestPath, null);
  const recoveryManifestPath = join(paths.root, "recovery-inputs", "activation.json");
  const recovery = config(paths, {
    COORDINATOR_MODE: "recovery-verification-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
    COORDINATOR_RECOVERY_REFRESH_SECONDS: "6",
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "2000",
  });
  assert.equal(recovery.mode, "recovery-verification-only");
  assert.equal(recovery.recoveryActivationManifestPath, recoveryManifestPath);
  assert.equal(recovery.recoveryRefreshSeconds, 6);
  assert.equal(recovery.recoveryProviderTimeoutMs, 2000);
  assert.equal(recovery.recoveryActionIntervalSeconds, null);
  assert.equal(recovery.recoveryPreparationTimeoutSeconds, null);
  assert.equal(recovery.releaseActivationManifestPath, null);
  const recoveryExecution = config(paths, {
    COORDINATOR_MODE: "recovery-execution-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
    COORDINATOR_RECOVERY_REFRESH_SECONDS: "6",
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "2000",
    COORDINATOR_RECOVERY_ACTION_INTERVAL_SECONDS: "7",
    COORDINATOR_RECOVERY_PREPARATION_TIMEOUT_SECONDS: "45",
  });
  assert.equal(recoveryExecution.mode, "recovery-execution-only");
  assert.equal(recoveryExecution.recoveryActionIntervalSeconds, 7);
  assert.equal(recoveryExecution.recoveryPreparationTimeoutSeconds, 45);
  assert.throws(() => config(paths, {
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: manifestPath,
  }), /closed coordinator mode cannot accept/);
  assert.throws(() => config(paths, {
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
  }), /closed coordinator mode cannot accept/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "release-verification-only",
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: manifestPath,
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
  }), /cannot accept recovery verification inputs/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "recovery-verification-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: manifestPath,
  }), /cannot accept release verification inputs/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "release-verification-only",
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: join(paths.runtimeDirectory, "activation.json"),
  }), /separate read-only directory/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "release-verification-only",
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: manifestPath,
    COORDINATOR_RELEASE_PROVIDER_TIMEOUT_MS: "30000",
  }), /does not cover verification work/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "recovery-verification-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: join(paths.runtimeDirectory, "recovery.json"),
  }), /separate read-only directory/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "recovery-verification-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
    COORDINATOR_RECOVERY_ACTION_INTERVAL_SECONDS: "5",
  }), /cannot accept recovery action inputs/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "recovery-verification-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
    COORDINATOR_RECOVERY_PREPARATION_TIMEOUT_SECONDS: "60",
  }), /cannot accept recovery action inputs/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "recovery-execution-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: manifestPath,
  }), /cannot accept release verification inputs/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "recovery-execution-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "1000",
    COORDINATOR_RECOVERY_ACTION_INTERVAL_SECONDS: "4",
  }), /outside policy/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "recovery-execution-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "1000",
    COORDINATOR_RECOVERY_PREPARATION_TIMEOUT_SECONDS: "9",
  }), /outside policy/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "recovery-verification-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: recoveryManifestPath,
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "30000",
  }), /does not cover verification work/);
  assert.throws(() => normalizeCoordinatorServiceConfig({
    COORDINATOR_DATABASE_PATH: "coordinator.sqlite",
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
  }), /canonical absolute/);
  assert.throws(() => normalizeCoordinatorServiceConfig({
    COORDINATOR_DATABASE_PATH: join(paths.runtimeDirectory, "coordinator.sqlite"),
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
  }), /separate directories/);
  assert.throws(() => normalizeCoordinatorServiceConfig({
    COORDINATOR_DATABASE_PATH: "/coordinator.sqlite",
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
  }), /non-root directories/);
  assert.throws(() => normalizeCoordinatorServiceConfig({
    COORDINATOR_DATABASE_PATH: paths.databasePath,
    COORDINATOR_RUNTIME_DIRECTORY: "/",
  }), /non-root directories/);
  assert.throws(() => config(paths, { COORDINATOR_HEARTBEAT_SECONDS: "4" }), /outside policy/);
  assert.throws(() => config(paths, { COORDINATOR_LEASE_STALE_SECONDS: "30", COORDINATOR_HEARTBEAT_SECONDS: "11" }), /three heartbeats/);
  assert.throws(() => config(paths, {
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_HEARTBEAT_SECONDS: "11",
    COORDINATOR_LEASE_STALE_SECONDS: "60",
  }), /cannot be shorter/);
});

function activeReleaseVerification(attemptAt, validUntil) {
  return {
    schema: "treeswap.coordinator-release-verification.v1",
    state: "active",
    scope: "verification-only-no-listener-solver-context-dispatch-or-funding-authority",
    lastAttemptAt: attemptAt,
    lastSuccessAt: attemptAt,
    consecutiveFailures: 0,
    releaseId: `0x${"1".repeat(64)}`,
    fundingMode: "operator-testnet-bootstrap",
    validUntil,
    recordDigest: `0x${"2".repeat(64)}`,
    policyDigest: `0x${"3".repeat(64)}`,
    inputManifestDigest: `0x${"4".repeat(64)}`,
    approvalBundleDigest: `0x${"5".repeat(64)}`,
    reconciliationDigest: `0x${"6".repeat(64)}`,
    providerConsensusDigest: `0x${"7".repeat(64)}`,
    runtimeBlockNumber: 1200,
    runtimeBlockHash: `0x${"8".repeat(64)}`,
    authorizations: {
      signing: false,
      broadcast: false,
      gateOpening: false,
      dispatch: false,
      funding: false,
    },
  };
}

function activeRecoveryVerification(attemptAt, validUntil) {
  return {
    schema: "treeswap.coordinator-recovery-verification.v1",
    state: "active",
    scope: "verification-only-no-recovery-context-action-dispatch-new-exposure-or-funding-authority",
    lastAttemptAt: attemptAt,
    lastSuccessAt: attemptAt,
    consecutiveFailures: 0,
    releaseId: `0x${"1".repeat(64)}`,
    validUntil,
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
    authorizations: {
      signing: false,
      broadcast: false,
      gateOpening: false,
      lightningDispatch: false,
      newExposure: false,
      funding: false,
    },
  };
}

function activeRecoveryAction(attemptAt) {
  const startedAt = attemptAt;
  return {
    schema: "treeswap.coordinator-recovery-action-loop.v2",
    state: "active",
    scope: "already-bound-settlement-recovery-only-no-lightning-planning-dispatch-new-exposure-or-funding-authority",
    startedAt,
    lastAttemptAt: attemptAt,
    lastSuccessAt: attemptAt,
    consecutiveFailures: 0,
    releaseId: `0x${"1".repeat(64)}`,
    releaseRecordDigest: `0x${"2".repeat(64)}`,
    jobSetDigest: `0x${"a".repeat(64)}`,
    jobCount: 1,
    counts: {
      attempted: 1,
      advanced: 0,
      waiting: 1,
      gateClosed: 0,
      done: 0,
      halted: 0,
    },
    cycleDigest: `0x${"9".repeat(64)}`,
    authorizations: {
      funding: false,
      lightningDispatch: false,
      newExposure: false,
    },
  };
}

test("publishes only aggregate closed status and rejects authority or secret-shaped fields", async (t) => {
  const paths = await fixture(t);
  const store = await CoordinatorStore.open(paths.databasePath);
  try {
    const status = buildCoordinatorClosedStatus({
      store,
      serviceStartedAt: "2033-05-18T03:33:20.000Z",
      heartbeatAt: "2033-05-18T03:33:21.000Z",
      leaseIdentifier: `sha256:${"1".repeat(64)}`,
      recoveredInterruptedActions: 0,
    });
    assert.equal(status.mode, "closed");
    assert.equal(status.fundingAuthorization, false);
    assert.equal(status.dispatchAuthorization, false);
    assert.equal(status.networkListener, false);
    assert.throws(() => validateCoordinatorClosedStatus({ ...status, fundingAuthorization: true }), /unavailable authority/);
    assert.throws(() => validateCoordinatorClosedStatus({ ...status, invoice: "lnbc-secret" }), /fields are not exact/);
    assert.throws(() => validateCoordinatorClosedStatus(status, { expectedToken: "2".repeat(64) }), /another lease/);
    assert.throws(() => validateCoordinatorClosedStatus({
      ...status,
      metrics: { ...status.metrics, invoiceDigest: `0x${"1".repeat(64)}` },
    }), /forbidden cross-network/);
  } finally {
    store.close();
  }
});

test("release-verification status can prove fresh verification but never dispatch or funding authority", async (t) => {
  const paths = await fixture(t);
  const store = await CoordinatorStore.open(paths.databasePath);
  const heartbeatAt = "2033-05-18T03:33:21.000Z";
  const validUntil = Math.floor(Date.parse(heartbeatAt) / 1_000) + 60;
  try {
    const status = buildCoordinatorReleaseVerificationStatus({
      store,
      serviceStartedAt: "2033-05-18T03:33:20.000Z",
      heartbeatAt,
      leaseIdentifier: `sha256:${"1".repeat(64)}`,
      recoveredInterruptedActions: 0,
      releaseVerification: activeReleaseVerification(heartbeatAt, validUntil),
    });
    assert.equal(status.mode, "release-verification-only");
    assert.equal(status.releaseVerification.state, "active");
    assert.equal(status.fundingAuthorization, false);
    assert.equal(status.dispatchAuthorization, false);
    assert.equal(status.networkListener, false);
    assert.throws(
      () => validateCoordinatorReleaseVerificationStatus({ ...status, fundingAuthorization: true }),
      /claims unavailable authority/,
    );
    assert.throws(() => validateCoordinatorReleaseVerificationStatus({
      ...status,
      releaseVerification: {
        ...status.releaseVerification,
        state: "inactive",
      },
    }), /retains active release fields/);
    assert.throws(() => validateCoordinatorReleaseVerificationStatus({
      ...status,
      releaseVerification: {
        ...status.releaseVerification,
        authorizations: { ...status.releaseVerification.authorizations, dispatch: true },
      },
    }), /identity or authority/);
  } finally {
    store.close();
  }
});

test("recovery-verification status exposes incident state but no reusable context or authority", async (t) => {
  const paths = await fixture(t);
  const store = await CoordinatorStore.open(paths.databasePath);
  const heartbeatAt = "2033-05-18T03:33:21.000Z";
  const validUntil = Math.floor(Date.parse(heartbeatAt) / 1_000) + 60;
  try {
    const status = buildCoordinatorRecoveryVerificationStatus({
      store,
      serviceStartedAt: "2033-05-18T03:33:20.000Z",
      heartbeatAt,
      leaseIdentifier: `sha256:${"1".repeat(64)}`,
      recoveredInterruptedActions: 0,
      recoveryVerification: activeRecoveryVerification(heartbeatAt, validUntil),
    });
    assert.equal(status.mode, "recovery-verification-only");
    assert.equal(status.recoveryVerification.state, "active");
    assert.equal(status.recoveryVerification.gateOpen, false);
    assert.equal(status.recoveryVerification.emergencyHalted, true);
    assert.equal(status.fundingAuthorization, false);
    assert.equal(status.dispatchAuthorization, false);
    assert.equal(status.networkListener, false);
    assert.throws(
      () => validateCoordinatorRecoveryVerificationStatus({ ...status, dispatchAuthorization: true }),
      /claims unavailable authority/,
    );
    assert.throws(() => validateCoordinatorRecoveryVerificationStatus({
      ...status,
      recoveryVerification: {
        ...status.recoveryVerification,
        state: "inactive",
      },
    }), /retains active recovery fields/);
    assert.throws(() => validateCoordinatorRecoveryVerificationStatus({
      ...status,
      recoveryVerification: {
        ...status.recoveryVerification,
        balancesReconciled: false,
      },
    }), /invalid or unreconciled/);
    assert.throws(() => validateCoordinatorRecoveryVerificationStatus({
      ...status,
      recoveryVerification: {
        ...status.recoveryVerification,
        gateOpen: true,
      },
    }), /cannot be open and emergency halted/);
    assert.throws(() => validateCoordinatorRecoveryVerificationStatus({
      ...status,
      recoveryVerification: {
        ...status.recoveryVerification,
        authorizations: { ...status.recoveryVerification.authorizations, lightningDispatch: true },
      },
    }), /identity or authority/);
  } finally {
    store.close();
  }
});

test("recovery-execution bootstrap status proves preparation without claiming executable work", async (t) => {
  const paths = await fixture(t);
  const store = await CoordinatorStore.open(paths.databasePath);
  const heartbeatAt = "2033-05-18T03:33:21.000Z";
  const validUntil = Math.floor(Date.parse(heartbeatAt) / 1_000) + 60;
  try {
    const status = buildCoordinatorRecoveryExecutionBootstrapStatus({
      store,
      serviceStartedAt: "2033-05-18T03:33:19.000Z",
      heartbeatAt,
      leaseIdentifier: `sha256:${"1".repeat(64)}`,
      recoveredInterruptedActions: 0,
      recoveryVerification: activeRecoveryVerification(heartbeatAt, validUntil),
    });
    assert.equal(status.schema, "treeswap.coordinator-recovery-execution-bootstrap-status.v1");
    assert.equal(status.phase, "preparing-custody-job-set");
    assert.equal(status.boundedExistingLiabilityEvmClaimRecovery, false);
    assert.equal(status.fundingAuthorization, false);
    assert.equal(status.lightningDispatchAuthorization, false);
    assert.equal(status.newExposureAuthorization, false);
    assert.equal(status.networkListener, false);
    assert.throws(() => validateCoordinatorRecoveryExecutionBootstrapStatus({
      ...status,
      boundedExistingLiabilityEvmClaimRecovery: true,
    }), /claims unavailable authority/);
    assert.throws(() => validateCoordinatorRecoveryExecutionBootstrapStatus({
      ...status,
      recoveryVerification: {
        ...status.recoveryVerification,
        state: "inactive",
      },
    }), /inactive coordinator recovery verification retains active recovery fields/);
    assert.throws(() => validateCoordinatorRecoveryExecutionBootstrapStatus({
      ...status,
      jobSetDigest: `0x${"1".repeat(64)}`,
    }), /fields are not exact/);
    assert.throws(() => validateCoordinatorRecoveryExecutionBootstrapStatus({
      ...status,
      invoice: "lnbc-secret",
    }), /fields are not exact/);
  } finally {
    store.close();
  }
});

test("recovery-execution status reports bounded existing-liability work without claiming funding authority", async (t) => {
  const paths = await fixture(t);
  const store = await CoordinatorStore.open(paths.databasePath);
  const heartbeatAt = "2033-05-18T03:33:21.000Z";
  const validUntil = Math.floor(Date.parse(heartbeatAt) / 1_000) + 60;
  try {
    const status = buildCoordinatorRecoveryExecutionStatus({
      store,
      serviceStartedAt: "2033-05-18T03:33:19.000Z",
      heartbeatAt,
      leaseIdentifier: `sha256:${"1".repeat(64)}`,
      recoveredInterruptedActions: 0,
      recoveryVerification: activeRecoveryVerification(heartbeatAt, validUntil),
      recoveryAction: activeRecoveryAction(heartbeatAt),
    });
    assert.equal(status.mode, "recovery-execution-only");
    assert.equal(status.boundedExistingLiabilityEvmClaimRecovery, true);
    assert.equal(status.fundingAuthorization, false);
    assert.equal(status.lightningDispatchAuthorization, false);
    assert.equal(status.newExposureAuthorization, false);
    assert.equal(status.networkListener, false);
    assert.equal(Object.hasOwn(status, "dispatchAuthorization"), false);
    assert.throws(() => validateCoordinatorRecoveryExecutionStatus({
      ...status,
      boundedExistingLiabilityEvmClaimRecovery: false,
    }), /not derived from live state/);
    assert.throws(() => validateCoordinatorRecoveryExecutionStatus({
      ...status,
      recoveryAction: {
        ...status.recoveryAction,
        counts: { ...status.recoveryAction.counts, done: 1 },
      },
    }), /counts do not reconcile/);
    assert.throws(() => validateCoordinatorRecoveryExecutionStatus({
      ...status,
      recoveryAction: {
        ...status.recoveryAction,
        authorizations: { ...status.recoveryAction.authorizations, lightningDispatch: true },
      },
    }), /identity or authority/);
    assert.throws(() => validateCoordinatorRecoveryExecutionStatus({
      ...status,
      recoveryAction: {
        ...status.recoveryAction,
        releaseId: `0x${"3".repeat(64)}`,
      },
    }), /another verified release/);
    assert.throws(() => validateCoordinatorRecoveryExecutionStatus({
      ...status,
      recoveryAction: {
        ...status.recoveryAction,
        jobSetDigest: `0x${"0".repeat(64)}`,
      },
    }), /release or job-set digest/);
    assert.throws(() => validateCoordinatorRecoveryExecutionStatus({
      ...status,
      recoveryAction: { ...status.recoveryAction, settlementId: `0x${"1".repeat(64)}` },
    }), /fields are not exact/);
    const paused = buildCoordinatorRecoveryExecutionStatus({
      store,
      serviceStartedAt: "2033-05-18T03:33:19.000Z",
      heartbeatAt,
      leaseIdentifier: `sha256:${"1".repeat(64)}`,
      recoveredInterruptedActions: 0,
      recoveryVerification: {
        ...activeRecoveryVerification(heartbeatAt, validUntil),
        bitPaused: true,
      },
      recoveryAction: activeRecoveryAction(heartbeatAt),
    });
    assert.equal(paused.boundedExistingLiabilityEvmClaimRecovery, false);
    const running = buildCoordinatorRecoveryExecutionStatus({
      store,
      serviceStartedAt: "2033-05-18T03:33:19.000Z",
      heartbeatAt,
      leaseIdentifier: `sha256:${"1".repeat(64)}`,
      recoveredInterruptedActions: 0,
      recoveryVerification: activeRecoveryVerification(heartbeatAt, validUntil),
      recoveryAction: {
        ...activeRecoveryAction(heartbeatAt),
        state: "running",
        lastSuccessAt: null,
        counts: {
          attempted: 0,
          advanced: 0,
          waiting: 0,
          gateClosed: 0,
          done: 0,
          halted: 0,
        },
        cycleDigest: null,
      },
    });
    assert.equal(running.boundedExistingLiabilityEvmClaimRecovery, false);
  } finally {
    store.close();
  }
});

test("fresh lease excludes a second supervisor and stale takeover cannot be removed by the old owner", async (t) => {
  const paths = await fixture(t);
  const policy = config(paths);
  const randomBytesImpl = deterministicRandom();
  let observedAt = Date.parse("2033-05-18T03:33:20.000Z");
  const first = await acquireCoordinatorServiceLease(policy, { now: () => observedAt, randomBytesImpl });
  assert.equal("token" in first, false);
  assert.equal(/token/i.test(JSON.stringify(first)), false);
  assert.deepEqual(await assertCoordinatorServiceLeaseOwnership(first), {
    leaseId: first.leaseId,
    startedAt: first.startedAt,
  });
  await assert.rejects(
    assertCoordinatorServiceLeaseOwnership(JSON.parse(JSON.stringify(first))),
    /original same-process service lease/,
  );
  const store = await CoordinatorStore.open(paths.databasePath);
  try {
    await first.publish(buildCoordinatorClosedStatus({
      store,
      serviceStartedAt: first.startedAt,
      heartbeatAt: wholeSecond(observedAt),
      leaseIdentifier: first.leaseId,
      recoveredInterruptedActions: 0,
    }));
    assert.deepEqual(await readCoordinatorServiceHealth(policy, { now: () => observedAt + 5_000 }), {
      schema: "treeswap.coordinator-service-status.v1",
      mode: "closed",
      heartbeatAt: wholeSecond(observedAt),
      databaseStatus: "ok",
      fundingAuthorization: false,
    });
    await assert.rejects(
      acquireCoordinatorServiceLease(policy, { now: () => observedAt + 5_000, randomBytesImpl }),
      /fresh lease/,
    );
    observedAt += 31_000;
    await assert.rejects(readCoordinatorServiceHealth(policy, { now: () => observedAt }), /stale/);
    await assert.rejects(assertCoordinatorServiceLeaseOwnership(first), /lease is stale/);
    const replacement = await acquireCoordinatorServiceLease(policy, { now: () => observedAt, randomBytesImpl });
    try {
      await replacement.publish(buildCoordinatorClosedStatus({
        store,
        serviceStartedAt: replacement.startedAt,
        heartbeatAt: wholeSecond(observedAt),
        leaseIdentifier: replacement.leaseId,
        recoveredInterruptedActions: 0,
      }));
      await assert.rejects(assertCoordinatorServiceLeaseOwnership(first), /no longer owns/);
      assert.equal((await assertCoordinatorServiceLeaseOwnership(replacement)).leaseId, replacement.leaseId);
      assert.equal(await first.release(), false);
      assert.equal((await readCoordinatorServiceHealth(policy, { now: () => observedAt })).fundingAuthorization, false);
    } finally {
      assert.equal(await replacement.release(), true);
      await assert.rejects(assertCoordinatorServiceLeaseOwnership(replacement), /ENOENT|no such file/i);
    }
  } finally {
    store.close();
  }
});

test("release-verification health requires a fresh active release and still reports false funding authority", async (t) => {
  const paths = await fixture(t);
  const observedAt = Date.parse("2033-05-18T03:33:20.000Z");
  const policy = config(paths, {
    COORDINATOR_MODE: "release-verification-only",
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: join(paths.root, "inputs", "activation.json"),
    COORDINATOR_RELEASE_REFRESH_SECONDS: "5",
    COORDINATOR_RELEASE_PROVIDER_TIMEOUT_MS: "1000",
  });
  const lease = await acquireCoordinatorServiceLease(policy, {
    now: () => observedAt,
    randomBytesImpl: deterministicRandom(),
  });
  const store = await CoordinatorStore.open(paths.databasePath);
  const validUntil = Math.floor(observedAt / 1_000) + 20;
  try {
    await lease.publish(buildCoordinatorReleaseVerificationStatus({
      store,
      serviceStartedAt: lease.startedAt,
      heartbeatAt: wholeSecond(observedAt),
      leaseIdentifier: lease.leaseId,
      recoveredInterruptedActions: 0,
      releaseVerification: activeReleaseVerification(wholeSecond(observedAt), validUntil),
    }));
    assert.deepEqual(await readCoordinatorServiceHealth(policy, { now: () => observedAt + 5_000 }), {
      schema: "treeswap.coordinator-release-verification-service-status.v1",
      mode: "release-verification-only",
      heartbeatAt: wholeSecond(observedAt),
      databaseStatus: "ok",
      fundingAuthorization: false,
      releaseVerification: "active",
      releaseValidUntil: validUntil,
    });
    await assert.rejects(
      readCoordinatorServiceHealth(policy, { now: () => observedAt + 21_000 }),
      /release verification is expired/,
    );
  } finally {
    store.close();
    await lease.release();
  }
});

test("recovery-verification health requires fresh provider-bound recovery and reports incident state", async (t) => {
  const paths = await fixture(t);
  const observedAt = Date.parse("2033-05-18T03:33:20.000Z");
  const policy = config(paths, {
    COORDINATOR_MODE: "recovery-verification-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: join(paths.root, "inputs", "recovery.json"),
    COORDINATOR_RECOVERY_REFRESH_SECONDS: "5",
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "1000",
  });
  const lease = await acquireCoordinatorServiceLease(policy, {
    now: () => observedAt,
    randomBytesImpl: deterministicRandom(),
  });
  const store = await CoordinatorStore.open(paths.databasePath);
  const validUntil = Math.floor(observedAt / 1_000) + 20;
  try {
    await lease.publish(buildCoordinatorRecoveryVerificationStatus({
      store,
      serviceStartedAt: lease.startedAt,
      heartbeatAt: wholeSecond(observedAt),
      leaseIdentifier: lease.leaseId,
      recoveredInterruptedActions: 0,
      recoveryVerification: activeRecoveryVerification(wholeSecond(observedAt), validUntil),
    }));
    assert.deepEqual(await readCoordinatorServiceHealth(policy, { now: () => observedAt + 5_000 }), {
      schema: "treeswap.coordinator-recovery-verification-service-status.v1",
      mode: "recovery-verification-only",
      heartbeatAt: wholeSecond(observedAt),
      databaseStatus: "ok",
      fundingAuthorization: false,
      recoveryVerification: "active",
      recoveryValidUntil: validUntil,
      gateOpen: false,
      emergencyHalted: true,
      bitPaused: false,
    });
    await assert.rejects(
      readCoordinatorServiceHealth(policy, { now: () => observedAt + 21_000 }),
      /recovery verification is expired/,
    );
  } finally {
    store.close();
    await lease.release();
  }
});

test("recovery-execution health requires both live verification and a successful bounded action cycle", async (t) => {
  const paths = await fixture(t);
  const observedAt = Date.parse("2033-05-18T03:33:20.000Z");
  const policy = config(paths, {
    COORDINATOR_MODE: "recovery-execution-only",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: join(paths.root, "inputs", "recovery.json"),
    COORDINATOR_RECOVERY_REFRESH_SECONDS: "5",
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "1000",
    COORDINATOR_RECOVERY_ACTION_INTERVAL_SECONDS: "5",
  });
  const lease = await acquireCoordinatorServiceLease(policy, {
    now: () => observedAt,
    randomBytesImpl: deterministicRandom(),
  });
  const store = await CoordinatorStore.open(paths.databasePath);
  const heartbeatAt = wholeSecond(observedAt);
  const validUntil = Math.floor(observedAt / 1_000) + 20;
  try {
    await lease.publish(buildCoordinatorRecoveryExecutionBootstrapStatus({
      store,
      serviceStartedAt: lease.startedAt,
      heartbeatAt,
      leaseIdentifier: lease.leaseId,
      recoveredInterruptedActions: 0,
      recoveryVerification: activeRecoveryVerification(heartbeatAt, validUntil),
    }));
    await assert.rejects(
      readCoordinatorServiceHealth(policy, { now: () => observedAt + 5_000 }),
      /bootstrap is incomplete/,
    );
    await lease.publish(buildCoordinatorRecoveryExecutionStatus({
      store,
      serviceStartedAt: lease.startedAt,
      heartbeatAt,
      leaseIdentifier: lease.leaseId,
      recoveredInterruptedActions: 0,
      recoveryVerification: activeRecoveryVerification(heartbeatAt, validUntil),
      recoveryAction: activeRecoveryAction(heartbeatAt),
    }));
    assert.deepEqual(await readCoordinatorServiceHealth(policy, { now: () => observedAt + 5_000 }), {
      schema: "treeswap.coordinator-recovery-execution-service-status.v1",
      mode: "recovery-execution-only",
      heartbeatAt,
      databaseStatus: "ok",
      fundingAuthorization: false,
      recoveryVerification: "active",
      recoveryValidUntil: validUntil,
      recoveryAction: "active",
      recoveryJobCount: 1,
      boundedExistingLiabilityEvmClaimRecovery: true,
      lightningDispatchAuthorization: false,
      newExposureAuthorization: false,
      gateOpen: false,
      emergencyHalted: true,
      bitPaused: false,
    });
    const idleAction = {
      ...activeRecoveryAction(heartbeatAt),
      state: "idle",
      lastAttemptAt: null,
      lastSuccessAt: null,
      counts: {
        attempted: 0,
        advanced: 0,
        waiting: 0,
        gateClosed: 0,
        done: 0,
        halted: 0,
      },
      cycleDigest: null,
    };
    await lease.publish(buildCoordinatorRecoveryExecutionStatus({
      store,
      serviceStartedAt: lease.startedAt,
      heartbeatAt,
      leaseIdentifier: lease.leaseId,
      recoveredInterruptedActions: 0,
      recoveryVerification: activeRecoveryVerification(heartbeatAt, validUntil),
      recoveryAction: idleAction,
    }));
    await assert.rejects(
      readCoordinatorServiceHealth(policy, { now: () => observedAt + 5_000 }),
      /action loop is not active/,
    );
  } finally {
    store.close();
    await lease.release();
  }
});

test("refuses a symlink or malformed lease instead of guessing that it is stale", async (t) => {
  const paths = await fixture(t);
  await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.runtimeDirectory, 0o700);
  const target = join(paths.root, "attacker-controlled");
  await mkdir(target);
  await symlink(target, join(paths.runtimeDirectory, "coordinator.lease"));
  await assert.rejects(acquireCoordinatorServiceLease(config(paths)), /not a real directory/);
});

test("lease ownership reads refuse a private-file symlink replacement", async (t) => {
  const paths = await fixture(t);
  const lease = await acquireCoordinatorServiceLease(config(paths));
  const target = join(paths.root, "attacker-owner.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  const ownerPath = join(lease.leaseDirectory, "owner.json");
  await rm(ownerPath);
  await symlink(target, ownerPath);
  await assert.rejects(assertCoordinatorServiceLeaseOwnership(lease), /bounded private regular file/);
});

async function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`coordinator did not become ready: ${stderr}`)), 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(marker)) {
        clearTimeout(timeout);
        resolve({ stdout, stderr });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`coordinator exited before readiness with ${code}: ${stderr}`));
    });
  });
}

async function waitForReady(child) {
  return waitForOutput(child, "ready-closed-no-funding-authority");
}

async function stop(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("coordinator did not stop")), 60_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 && signal !== "SIGTERM") reject(new Error(`coordinator stopped with ${code ?? signal}`));
      else resolve();
    });
    child.kill("SIGTERM");
  });
}

test("packaged service stays alive, reports closed health, excludes a duplicate, and exits cleanly", async (t) => {
  const paths = await fixture(t);
  const environment = {
    ...process.env,
    COORDINATOR_DATABASE_PATH: paths.databasePath,
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "30",
    TREESWAP_FUNDING_ENABLED: "false",
    TREESWAP_TEST_SECRET: "must-not-enter-status",
  };
  const child = spawn(process.execPath, ["infra/coordinator/service.mjs"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForReady(child);
    const health = spawnSync(process.execPath, ["infra/coordinator/healthcheck.mjs"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.equal(health.status, 0, health.stderr);
    const firstHealth = JSON.parse(health.stdout);
    assert.deepEqual(firstHealth, {
      schema: "treeswap.coordinator-service-status.v1",
      mode: "closed",
      heartbeatAt: firstHealth.heartbeatAt,
      databaseStatus: "ok",
      fundingAuthorization: false,
    });
    const statusBytes = await readFile(join(paths.runtimeDirectory, "coordinator.lease", "status.json"), "utf8");
    assert.equal(statusBytes.includes(environment.TREESWAP_TEST_SECRET), false);
    const duplicate = spawnSync(process.execPath, ["infra/coordinator/service.mjs"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /fresh lease/);
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const laterHealth = spawnSync(process.execPath, ["infra/coordinator/healthcheck.mjs"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.equal(laterHealth.status, 0, laterHealth.stderr);
    assert.ok(Date.parse(JSON.parse(laterHealth.stdout).heartbeatAt) > Date.parse(firstHealth.heartbeatAt));
  } finally {
    if (child.exitCode === null) await stop(child);
  }
  await assert.rejects(lstat(join(paths.runtimeDirectory, "coordinator.lease")), { code: "ENOENT" });
  assert.equal((await lstat(paths.databasePath)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.runtimeDirectory)).mode & 0o777, 0o700);
});

test("packaged release verifier stays alive but unhealthy and authority-free when evidence cannot verify", async (t) => {
  const paths = await fixture(t);
  const environment = {
    ...process.env,
    COORDINATOR_MODE: "release-verification-only",
    COORDINATOR_DATABASE_PATH: paths.databasePath,
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "30",
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: join(paths.root, "inputs", "missing-activation.json"),
    COORDINATOR_RELEASE_REFRESH_SECONDS: "5",
    COORDINATOR_RELEASE_PROVIDER_TIMEOUT_MS: "1000",
    TREESWAP_FUNDING_ENABLED: "false",
    TREESWAP_RELEASE_RPC_TEST_URL: "https://provider.example/private-token",
  };
  const child = spawn(process.execPath, ["infra/coordinator/service.mjs"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForOutput(
      child,
      "running-release-verification-inactive-no-dispatch-or-funding-authority",
    );
    const health = spawnSync(process.execPath, ["infra/coordinator/healthcheck.mjs"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.equal(health.status, 1);
    assert.match(health.stderr, /release verification is inactive/);
    const statusBytes = await readFile(join(paths.runtimeDirectory, "coordinator.lease", "status.json"), "utf8");
    const status = JSON.parse(statusBytes);
    assert.equal(status.releaseVerification.state, "inactive");
    assert.equal(status.releaseVerification.consecutiveFailures, 1);
    assert.equal(status.fundingAuthorization, false);
    assert.equal(status.dispatchAuthorization, false);
    assert.equal(statusBytes.includes("private-token"), false);
    assert.equal(statusBytes.includes(environment.COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH), false);
  } finally {
    if (child.exitCode === null) await stop(child);
  }
});

test("packaged recovery verifier stays alive, inactive, secret-free, and unable to dispatch", async (t) => {
  const paths = await fixture(t);
  const environment = {
    ...process.env,
    COORDINATOR_MODE: "recovery-verification-only",
    COORDINATOR_DATABASE_PATH: paths.databasePath,
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "30",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: join(paths.root, "inputs", "missing-recovery.json"),
    COORDINATOR_RECOVERY_REFRESH_SECONDS: "5",
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "1000",
    TREESWAP_FUNDING_ENABLED: "false",
    TREESWAP_RECOVERY_RPC_TEST_URL: "https://provider.example/private-recovery-token",
  };
  const child = spawn(process.execPath, ["infra/coordinator/service.mjs"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForOutput(
      child,
      "running-recovery-verification-inactive-no-action-dispatch-or-funding-authority",
    );
    const health = spawnSync(process.execPath, ["infra/coordinator/healthcheck.mjs"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.equal(health.status, 1);
    assert.match(health.stderr, /recovery verification is inactive/);
    const statusBytes = await readFile(join(paths.runtimeDirectory, "coordinator.lease", "status.json"), "utf8");
    const status = JSON.parse(statusBytes);
    assert.equal(status.recoveryVerification.state, "inactive");
    assert.equal(status.recoveryVerification.consecutiveFailures, 1);
    assert.equal(status.fundingAuthorization, false);
    assert.equal(status.dispatchAuthorization, false);
    assert.equal(status.networkListener, false);
    assert.equal(statusBytes.includes("private-recovery-token"), false);
    assert.equal(statusBytes.includes(environment.COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH), false);
  } finally {
    if (child.exitCode === null) await stop(child);
  }
});

test("default packaged service refuses recovery execution without a same-process custody bootstrap", async (t) => {
  const paths = await fixture(t);
  const environment = {
    ...process.env,
    COORDINATOR_MODE: "recovery-execution-only",
    COORDINATOR_DATABASE_PATH: paths.databasePath,
    COORDINATOR_RUNTIME_DIRECTORY: paths.runtimeDirectory,
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "60",
    COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH: join(paths.root, "inputs", "recovery.json"),
    COORDINATOR_RECOVERY_REFRESH_SECONDS: "5",
    COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS: "1000",
    COORDINATOR_RECOVERY_ACTION_INTERVAL_SECONDS: "5",
    TREESWAP_FUNDING_ENABLED: "false",
  };
  const child = spawnSync(process.execPath, ["infra/coordinator/service.mjs"], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /deployment-specific same-process retained-custody bootstrap/);
  await assert.rejects(lstat(paths.databasePath), { code: "ENOENT" });
  await assert.rejects(lstat(join(paths.runtimeDirectory, "coordinator.lease")), { code: "ENOENT" });
});
