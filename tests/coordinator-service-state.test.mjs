import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  acquireCoordinatorServiceLease,
  buildCoordinatorClosedStatus,
  normalizeCoordinatorServiceConfig,
  readCoordinatorServiceHealth,
  validateCoordinatorClosedStatus,
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

test("accepts only a separated, closed, bounded coordinator configuration", async (t) => {
  const paths = await fixture(t);
  const valid = config(paths);
  assert.equal(valid.databasePath, paths.databasePath);
  assert.equal(valid.runtimeDirectory, paths.runtimeDirectory);
  assert.equal(valid.heartbeatSeconds, 5);
  assert.throws(() => config(paths, { COORDINATOR_MODE: "active" }), /closed mode only/);
  assert.throws(() => config(paths, { TREESWAP_FUNDING_ENABLED: "true" }), /cannot enable funding/);
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

test("fresh lease excludes a second supervisor and stale takeover cannot be removed by the old owner", async (t) => {
  const paths = await fixture(t);
  const policy = config(paths);
  const randomBytesImpl = deterministicRandom();
  let observedAt = Date.parse("2033-05-18T03:33:20.000Z");
  const first = await acquireCoordinatorServiceLease(policy, { now: () => observedAt, randomBytesImpl });
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
    const replacement = await acquireCoordinatorServiceLease(policy, { now: () => observedAt, randomBytesImpl });
    try {
      await replacement.publish(buildCoordinatorClosedStatus({
        store,
        serviceStartedAt: replacement.startedAt,
        heartbeatAt: wholeSecond(observedAt),
        leaseIdentifier: replacement.leaseId,
        recoveredInterruptedActions: 0,
      }));
      assert.equal(await first.release(), false);
      assert.equal((await readCoordinatorServiceHealth(policy, { now: () => observedAt })).fundingAuthorization, false);
    } finally {
      assert.equal(await replacement.release(), true);
    }
  } finally {
    store.close();
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

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`coordinator did not become ready: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("ready-closed-no-funding-authority")) {
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

async function stop(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("coordinator did not stop")), 10_000);
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
      timeout: 10_000,
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
