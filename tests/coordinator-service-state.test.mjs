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
  buildCoordinatorReleaseVerificationStatus,
  normalizeCoordinatorServiceConfig,
  readCoordinatorServiceHealth,
  validateCoordinatorClosedStatus,
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

test("accepts only separated, bounded closed or release-verification coordinator configuration", async (t) => {
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
  assert.throws(() => config(paths, {
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: manifestPath,
  }), /closed coordinator mode cannot accept/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "release-verification-only",
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: join(paths.runtimeDirectory, "activation.json"),
  }), /separate read-only directory/);
  assert.throws(() => config(paths, {
    COORDINATOR_MODE: "release-verification-only",
    COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH: manifestPath,
    COORDINATOR_RELEASE_PROVIDER_TIMEOUT_MS: "30000",
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
