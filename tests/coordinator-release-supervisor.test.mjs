import assert from "node:assert/strict";
import test from "node:test";
import { createCoordinatorReleaseVerificationSupervisor } from "../lib/coordinator-release-supervisor.mjs";

function digest(character) {
  return `0x${character.repeat(64)}`;
}

function activationResult({ sequence = 1, validUntil = 200 } = {}) {
  const releaseId = digest("1");
  const activation = Object.freeze({
    schema: "treeswap.active-public-testnet-release.v1",
    status: "same-process-release-and-runtime-verification-active",
    releaseId,
    fundingMode: "operator-testnet-bootstrap",
    validUntil,
    runtimeBlockNumber: 1_200 + sequence,
    runtimeBlockHash: digest("2"),
    providerConsensusDigest: digest("3"),
    receipt: Object.freeze({ approvalBundleDigest: digest("4") }),
    deployment: Object.freeze({ reconciliationDigest: digest("5") }),
  });
  return Object.freeze({
    manifestDigest: digest("6"),
    candidate: Object.freeze({
      record: Object.freeze({ releaseId }),
      recordDigest: digest("7"),
      policyDigest: digest("8"),
    }),
    activation,
  });
}

test("retains only the current in-process activation and emits a non-authorizing status", async () => {
  const events = [];
  let sequence = 0;
  const environment = { TREESWAP_RELEASE_RPC_ONE_URL: "https://provider.example/private-token" };
  const supervisor = createCoordinatorReleaseVerificationSupervisor({
    manifestPath: "/run/treeswap/credentials/activation.json",
    environment,
    timeoutMs: 5_000,
    activate: async (input) => {
      sequence += 1;
      events.push(`activate-${sequence}`);
      assert.equal(input.manifestPath, "/run/treeswap/credentials/activation.json");
      assert.equal(input.environment, environment);
      assert.equal(input.timeoutMs, 5_000);
      return activationResult({ sequence, validUntil: input.now + 20 });
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
  assert.deepEqual(first.authorizations, {
    signing: false,
    broadcast: false,
    gateOpening: false,
    dispatch: false,
    funding: false,
  });
  assert.equal(JSON.stringify(first).includes("private-token"), false);
  assert.equal(supervisor.useActiveActivation((result) => result.activation.runtimeBlockNumber, { now: 102 }), 1_201);

  const second = await supervisor.refresh({ now: 105 });
  assert.equal(second.runtimeBlockNumber, 1_202);
  assert.deepEqual(events, ["activate-1", "deactivate-1", "activate-2"]);
  assert.equal(supervisor.stop(), true);
  assert.equal(supervisor.stop(), false);
  assert.deepEqual(events, ["activate-1", "deactivate-1", "activate-2", "deactivate-2"]);
  assert.throws(() => supervisor.useActiveActivation(() => true, { now: 106 }), /not active/);
  await assert.rejects(supervisor.refresh({ now: 106 }), /is stopped/);
});

test("fails closed on refresh error, malformed output, expiry, and clock rollback", async () => {
  const deactivated = [];
  let behavior = "success";
  const supervisor = createCoordinatorReleaseVerificationSupervisor({
    manifestPath: "/inputs/activation.json",
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
  const expired = supervisor.status({ now: 314 });
  assert.equal(expired.state, "inactive");
  assert.equal(deactivated.length, 3);

  assert.equal((await supervisor.refresh({ now: 320 })).state, "active");
  const regressed = supervisor.status({ now: 319 });
  assert.equal(regressed.state, "inactive");
  assert.equal(regressed.consecutiveFailures, 1);
  assert.equal(deactivated.length, 4);
  assert.throws(() => supervisor.useActiveActivation(() => true, { now: 319 }), /not active/);
});

test("serializing status or constructing a new supervisor cannot restore activation provenance", async () => {
  const options = {
    manifestPath: "/inputs/activation.json",
    activate: async ({ now }) => activationResult({ validUntil: now + 10 }),
    deactivate: () => true,
    isActive: () => true,
  };
  const original = createCoordinatorReleaseVerificationSupervisor(options);
  const active = await original.refresh({ now: 400 });
  assert.equal(JSON.parse(JSON.stringify(active)).state, "active");

  const restarted = createCoordinatorReleaseVerificationSupervisor(options);
  assert.equal(restarted.status({ now: 401 }).state, "inactive");
  assert.throws(() => restarted.useActiveActivation(() => true, { now: 401 }), /not active/);
  assert.equal(original.useActiveActivation(() => true, { now: 401 }), true);
});

test("rejects concurrent refresh and destroys a result that arrives after shutdown", async () => {
  let resolveActivation;
  const pendingActivation = new Promise((resolve) => { resolveActivation = resolve; });
  const deactivated = [];
  const supervisor = createCoordinatorReleaseVerificationSupervisor({
    manifestPath: "/inputs/activation.json",
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
