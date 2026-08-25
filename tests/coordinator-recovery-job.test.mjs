import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCoordinatorRecoveryJobs,
  snapshotCoordinatorActiveRuntime,
  snapshotCoordinatorRecoveryEvidencePolicy,
  snapshotCoordinatorRecoveryRuntime,
} from "../lib/coordinator-recovery-job.mjs";

const settlementId = (value) => `0x${value.toString(16).padStart(64, "0")}`;

function job(value = 1, overrides = {}) {
  return {
    settlementId: settlementId(value),
    solverCapabilityVerification: Object.freeze({ localFixture: true }),
    evidencePolicy: { schema: "test-policy", nested: { value } },
    runtime: {
      packetClient: null,
      controls: {},
      lightning: null,
      evm: null,
    },
    ...overrides,
  };
}

test("snapshots an exact bounded recovery job before caller mutation", () => {
  let originalCalls = 0;
  let replacementCalls = 0;
  let originalProviderCalls = 0;
  let replacementProviderCalls = 0;
  const controls = {
    observeReservation: async () => {
      originalCalls += 1;
      return "original";
    },
  };
  const evidencePolicy = { schema: "test-policy", nested: { value: 1 } };
  const provider = {
    label: "one",
    rpcUrl: "https://one.example",
    rpcRequestImpl: async () => { originalProviderCalls += 1; return "original-provider"; },
  };
  const signer = {
    async getAddress() { return "original-address"; },
    async signTransaction() { return "original-transaction"; },
  };
  const lightning = { reconciliationProviders: ["one", "two"], timeoutMs: 1000 };
  const evm = { signer, reconciliationProviders: [provider] };
  const packetClient = { async read() { return "original-packet"; } };
  const jobs = normalizeCoordinatorRecoveryJobs([job(1, {
    evidencePolicy,
    runtime: { packetClient, controls, lightning, evm },
  })]);
  evidencePolicy.nested.value = 2;
  lightning.timeoutMs = 9999;
  lightning.reconciliationProviders.push("three");
  controls.observeReservation = async () => {
    replacementCalls += 1;
    return "replacement";
  };
  provider.label = "changed";
  provider.rpcRequestImpl = async () => { replacementProviderCalls += 1; return "replacement-provider"; };
  signer.getAddress = async () => "replacement-address";
  packetClient.read = async () => "replacement-packet";
  assert.equal(jobs[0].evidencePolicy.nested.value, 1);
  assert.deepEqual(jobs[0].runtime.lightning, {
    reconciliationProviders: ["one", "two"],
    timeoutMs: 1000,
  });
  assert.equal(jobs[0].runtime.evm.reconciliationProviders[0].label, "one");
  return Promise.all([
    jobs[0].runtime.controls.observeReservation(),
    jobs[0].runtime.evm.reconciliationProviders[0].rpcRequestImpl(),
    jobs[0].runtime.evm.signer.getAddress(),
    jobs[0].runtime.packetClient.read(),
  ]).then(([controlResult, providerResult, signerAddress, packetResult]) => {
    assert.equal(controlResult, "original");
    assert.equal(providerResult, "original-provider");
    assert.equal(signerAddress, "original-address");
    assert.equal(packetResult, "original-packet");
    assert.equal(originalCalls, 1);
    assert.equal(replacementCalls, 0);
    assert.equal(originalProviderCalls, 1);
    assert.equal(replacementProviderCalls, 0);
  });
});

test("enforces exact job, runtime, control, identifier, duplicate, and count boundaries", () => {
  assert.throws(() => normalizeCoordinatorRecoveryJobs([]), /between 1 and 64/);
  assert.equal(normalizeCoordinatorRecoveryJobs(
    Array.from({ length: 64 }, (_, index) => job(index + 1)),
  ).length, 64);
  assert.throws(() => normalizeCoordinatorRecoveryJobs(
    Array.from({ length: 65 }, (_, index) => job(index + 1)),
  ), /between 1 and 64/);
  assert.throws(() => normalizeCoordinatorRecoveryJobs([job(), job()]), /duplicated/);
  assert.throws(() => normalizeCoordinatorRecoveryJobs([job(1, { settlementId: settlementId(0) })]), /nonzero/);
  assert.throws(() => normalizeCoordinatorRecoveryJobs([job(1, { unexpected: true })]), /fields are not exact/);
  assert.throws(() => snapshotCoordinatorRecoveryRuntime({
    packetClient: null,
    controls: { authorizeLightning: async () => true },
    lightning: null,
    evm: null,
  }), /control is not permitted/);
  assert.throws(() => snapshotCoordinatorRecoveryRuntime({
    packetClient: null,
    controls: {},
    lightning: null,
    evm: null,
    beforeSideEffect: async () => {},
  }), /fields are not exact/);
  assert.throws(() => snapshotCoordinatorRecoveryEvidencePolicy([]), /must be an object/);
});

test("active runtime snapshots the Lightning authorizer without widening recovery authority", async () => {
  let originalCalls = 0;
  let replacementCalls = 0;
  const controls = {
    authorizeLightning: async () => {
      originalCalls += 1;
      return "original";
    },
  };
  const runtime = snapshotCoordinatorActiveRuntime({
    packetClient: null,
    controls,
    lightning: null,
    evm: null,
  });
  controls.authorizeLightning = async () => {
    replacementCalls += 1;
    return "replacement";
  };
  assert.equal(await runtime.controls.authorizeLightning(), "original");
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
  assert.throws(() => snapshotCoordinatorActiveRuntime({
    packetClient: null,
    controls: { attackerChosenBoundary: async () => true },
    lightning: null,
    evm: null,
  }), /control is not permitted/);
});
