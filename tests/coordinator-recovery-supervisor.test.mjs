import assert from "node:assert/strict";
import test from "node:test";
import { createCoordinatorRecoveryVerificationSupervisor } from "../lib/coordinator-recovery-supervisor.mjs";

function digest(character) {
  return `0x${character.repeat(64)}`;
}

function activationResult({ sequence = 1, validUntil = 200, bitPaused = false } = {}) {
  const releaseId = digest("1");
  const activation = Object.freeze({
    schema: "treeswap.active-public-testnet-recovery.v1",
    status: "same-process-recovery-only-runtime-verification-active",
    scope: "existing-settlement-recovery-only-no-lightning-dispatch-new-exposure-or-funding-authority",
    releaseId,
    validUntil,
    runtimeBlockNumber: 1_200 + sequence,
    runtimeBlockHash: digest("2"),
    providerConsensusDigest: digest("3"),
    receipt: Object.freeze({ approvalBundleDigest: digest("4") }),
    deployment: Object.freeze({
      gateOpen: false,
      emergencyHalted: true,
      bitPaused,
      balancesReconciled: true,
    }),
    authorizations: Object.freeze({ funding: false, newExposure: false, lightningDispatch: false }),
  });
  return Object.freeze({
    manifestDigest: digest("5"),
    candidate: Object.freeze({
      record: Object.freeze({ releaseId }),
      recordDigest: digest("6"),
      policyDigest: digest("7"),
    }),
    activation,
  });
}

test("retains only the current recovery activation and emits an authority-free status", async () => {
  const events = [];
  let sequence = 0;
  const environment = { TREESWAP_RECOVERY_RPC_ONE_URL: "https://provider.example/private-token" };
  const supervisor = createCoordinatorRecoveryVerificationSupervisor({
    manifestPath: "/run/treeswap/credentials/recovery.json",
    environment,
    timeoutMs: 5_000,
    activate: async (input) => {
      sequence += 1;
      events.push(`activate-${sequence}`);
      assert.equal(input.manifestPath, "/run/treeswap/credentials/recovery.json");
      assert.equal(input.environment, environment);
      assert.equal(input.timeoutMs, 5_000);
      return activationResult({ sequence, validUntil: input.now + 20, bitPaused: sequence === 2 });
    },
    deactivate: (activation) => {
      events.push(`deactivate-${activation.runtimeBlockNumber - 1_200}`);
      return true;
    },
    isActive: (activation) => !events.includes(`deactivate-${activation.runtimeBlockNumber - 1_200}`),
  });

  assert.equal(supervisor.status({ now: 100 }).state, "inactive");
  const first = await supervisor.refresh({ now: 101 });
  assert.equal(first.state, "active");
  assert.equal(first.lastAttemptAt, "1970-01-01T00:01:41.000Z");
  assert.equal(first.lastSuccessAt, first.lastAttemptAt);
  assert.equal(first.runtimeBlockNumber, 1_201);
  assert.equal(first.gateOpen, false);
  assert.equal(first.emergencyHalted, true);
  assert.equal(first.bitPaused, false);
  assert.equal(first.balancesReconciled, true);
  assert.deepEqual(first.authorizations, {
    signing: false,
    broadcast: false,
    gateOpening: false,
    lightningDispatch: false,
    newExposure: false,
    funding: false,
  });
  assert.equal(JSON.stringify(first).includes("private-token"), false);
  assert.equal(supervisor.useActiveActivation((result) => result.activation.runtimeBlockNumber, { now: 102 }), 1_201);

  const second = await supervisor.refresh({ now: 105 });
  assert.equal(second.runtimeBlockNumber, 1_202);
  assert.equal(second.bitPaused, true);
  assert.deepEqual(events, ["activate-1", "deactivate-1", "activate-2"]);
  assert.equal(supervisor.stop(), true);
  assert.equal(supervisor.stop(), false);
  assert.deepEqual(events, ["activate-1", "deactivate-1", "activate-2", "deactivate-2"]);
  assert.throws(() => supervisor.useActiveActivation(() => true, { now: 106 }), /not active/);
  await assert.rejects(supervisor.refresh({ now: 106 }), /is stopped/);
});

test("fails closed on refresh error, malformed output, expiry, external revocation, and clock rollback", async () => {
  const deactivated = [];
  let behavior = "success";
  const supervisor = createCoordinatorRecoveryVerificationSupervisor({
    manifestPath: "/inputs/recovery.json",
    activate: async ({ now }) => {
      if (behavior === "throw") throw new Error("provider URL and secret must not escape");
      if (behavior === "malformed") return { ...activationResult({ validUntil: now + 10 }), candidate: {} };
      return activationResult({ validUntil: now + 10 });
    },
    deactivate: (activation) => {
      deactivated.push(activation);
      return true;
    },
    isActive: (activation) => !deactivated.includes(activation),
  });

  assert.equal((await supervisor.refresh({ now: 300 })).state, "active");
  behavior = "throw";
  const failed = await supervisor.refresh({ now: 301 });
  assert.equal(failed.state, "inactive");
  assert.equal(failed.consecutiveFailures, 1);
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(deactivated.length, 1);

  behavior = "malformed";
  const malformed = await supervisor.refresh({ now: 302 });
  assert.equal(malformed.state, "inactive");
  assert.equal(malformed.consecutiveFailures, 2);
  assert.equal(deactivated.length, 2);

  behavior = "success";
  assert.equal((await supervisor.refresh({ now: 303 })).state, "active");
  assert.equal(supervisor.status({ now: 313 }).state, "active");
  assert.equal(supervisor.status({ now: 314 }).state, "inactive");
  assert.equal(deactivated.length, 3);

  assert.equal((await supervisor.refresh({ now: 320 })).state, "active");
  deactivated.push(activationResult().activation);
  const activation = supervisor.useActiveActivation((result) => result.activation, { now: 320 });
  deactivated.push(activation);
  const revoked = supervisor.status({ now: 321 });
  assert.equal(revoked.state, "inactive");
  assert.equal(revoked.consecutiveFailures, 1);

  assert.equal((await supervisor.refresh({ now: 330 })).state, "active");
  const regressed = supervisor.status({ now: 329 });
  assert.equal(regressed.state, "inactive");
  assert.equal(regressed.consecutiveFailures, 1);
  assert.throws(() => supervisor.useActiveActivation(() => true, { now: 329 }), /not active/);
});

test("serialization and a new supervisor cannot restore recovery provenance", async () => {
  const options = {
    manifestPath: "/inputs/recovery.json",
    activate: async ({ now }) => activationResult({ validUntil: now + 10 }),
    deactivate: () => true,
    isActive: () => true,
  };
  const original = createCoordinatorRecoveryVerificationSupervisor(options);
  const active = await original.refresh({ now: 400 });
  assert.equal(JSON.parse(JSON.stringify(active)).state, "active");

  const restarted = createCoordinatorRecoveryVerificationSupervisor(options);
  assert.equal(restarted.status({ now: 401 }).state, "inactive");
  assert.throws(() => restarted.useActiveActivation(() => true, { now: 401 }), /not active/);
  assert.equal(original.useActiveActivation(() => true, { now: 401 }), true);
});

test("rejects concurrent refresh, invalid construction, and destroys a late result after shutdown", async () => {
  assert.throws(() => createCoordinatorRecoveryVerificationSupervisor(), /manifest path is required/);
  assert.throws(() => createCoordinatorRecoveryVerificationSupervisor({
    manifestPath: "/inputs/recovery.json",
    timeoutMs: 30_001,
  }), /timeout is outside policy/);
  assert.throws(() => createCoordinatorRecoveryVerificationSupervisor({
    manifestPath: "/inputs/recovery.json",
    activate: null,
  }), /dependencies are invalid/);

  let resolveActivation;
  const pendingActivation = new Promise((resolve) => { resolveActivation = resolve; });
  const deactivated = [];
  const supervisor = createCoordinatorRecoveryVerificationSupervisor({
    manifestPath: "/inputs/recovery.json",
    activate: () => pendingActivation,
    deactivate: (activation) => {
      deactivated.push(activation);
      return true;
    },
    isActive: (activation) => !deactivated.includes(activation),
  });
  const refresh = supervisor.refresh({ now: 500 });
  await assert.rejects(supervisor.refresh({ now: 500 }), /already running/);
  assert.equal(supervisor.stop(), true);
  const result = activationResult({ validUntil: 510 });
  resolveActivation(result);
  assert.equal((await refresh).state, "inactive");
  assert.deepEqual(deactivated, [result.activation]);
  assert.throws(() => supervisor.useActiveActivation(() => true, { now: 501 }), /not active/);
});
