import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import {
  REQUIRED_PUBLIC_TESTNET_SCENARIOS,
  assertPublicTestnetEvidenceIsSecretFree,
  buildPublicTestnetAdoptionSummary,
  buildPublicTestnetAttestationMessage,
  buildPublicTestnetReleaseEvidence,
  verifyPublicTestnetCampaign,
} from "../lib/public-testnet-evidence.mjs";

const CHAIN_ID = "11155111";
const COMMIT = "1".repeat(40);
const VERIFYING_CONTRACT = "0x1000000000000000000000000000000000000001";
const FINISHED_AT = 1_800_000_000;
const NOW = FINISHED_AT + 100;
const ROLES = ["evm-provider", "lightning-observer", "monitor", "relay", "solver"];

function id(value) {
  return keccak256(toUtf8Bytes(value)).toLowerCase();
}

function canonical(values, selector) {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right)));
}

function fixture({ finishedAt = FINISHED_AT } = {}) {
  const startedAt = finishedAt - 604_800;
  const wallets = new Map();
  const participants = [];
  for (const role of ROLES) {
    for (let index = 0; index < 2; index += 1) {
      const wallet = Wallet.createRandom();
      wallets.set(wallet.address, wallet);
      participants.push({
        role,
        operatorId: id(`${role} operator ${index}`),
        signer: wallet.address,
        evidenceDigest: id(`${role} operator ${index} retained evidence`),
      });
    }
  }
  const orderedParticipants = canonical(participants, (value) => `${value.role}:${value.operatorId}`);
  const observerOperatorIds = canonical(
    orderedParticipants.filter((value) => value.role === "evm-provider").map((value) => value.operatorId),
    (value) => value,
  );
  const solverParticipants = orderedParticipants.filter((value) => value.role === "solver");
  const deploymentManifestDigest = id("public testnet deployment manifest");
  const policy = {
    schema: "treeswap.public-testnet-evidence-policy.v1",
    environment: "public-testnet",
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    reviewedBuildCommit: COMMIT,
    deploymentManifestDigest,
    admissionPolicyDigest: id("admission policy"),
    riskPolicyDigest: id("risk policy"),
    feeScheduleDigest: id("fee schedule"),
    minimumCampaignDurationSeconds: 604_800,
    maximumCampaignDurationSeconds: 2_678_400,
    maximumEvidenceAgeSeconds: 2_592_000,
    maximumFinalReconciliationAgeSeconds: 300,
    minimumCounts: {
      alertChannels: 2,
      evmProviders: 2,
      lightningObservers: 2,
      monitors: 2,
      relays: 2,
      solvers: 2,
    },
    minimumSelectedSwapsPerSolver: 20,
    minimumSelectedSwapsPerDirectionPerSolver: 10,
    maximumCapacityFreshnessP95Seconds: 120,
    maximumMedianCompletionSeconds: 900,
    maximumTimeoutRateBps: 2_000,
    maximumFailureRateBps: 1_000,
    requiredScenarios: [...REQUIRED_PUBLIC_TESTNET_SCENARIOS],
  };
  const record = {
    schema: "treeswap.public-testnet-campaign.v1",
    campaignId: id("public testnet campaign 1"),
    environment: "public-testnet",
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    reviewedBuildCommit: COMMIT,
    deploymentManifestDigest,
    startedAt,
    finishedAt,
    counts: {
      alertChannels: 2,
      evmProviders: 2,
      lightningObservers: 2,
      monitors: 2,
      relays: 2,
      solvers: 2,
    },
    alertChannelEvidenceDigests: canonical([
      id("alert channel 1 delivery evidence"),
      id("alert channel 2 delivery evidence"),
    ], (value) => value),
    participants: orderedParticipants,
    scenarios: REQUIRED_PUBLIC_TESTNET_SCENARIOS.map((name, index) => ({
      name,
      status: "passed",
      startedAt: startedAt + index + 1,
      finishedAt: startedAt + index + 2,
      observerOperatorIds,
      evidenceDigest: id(`${name} evidence`),
    })),
    solverMetrics: canonical(solverParticipants.map((participant, index) => ({
      solverId: id(`solver identity ${index}`),
      operatorId: participant.operatorId,
      quoteRequests: 40,
      selectedSwaps: 25,
      selectedBitToLightningSwaps: 12,
      selectedLightningToBitSwaps: 13,
      completedSwaps: 22,
      timedOutSwaps: 1,
      failedSwaps: 1,
      abandonedSwaps: 1,
      medianCompletionSeconds: 120,
      capacityFreshnessP95Seconds: 30,
      haltCount: 1,
      haltHistoryDigest: id(`solver ${index} halt history`),
    })), (value) => value.solverId),
    artifacts: {
      backupRestore: id("backup restore artifact"),
      findingsDisposition: id("findings disposition artifact"),
      incidentDrills: id("incident drills artifact"),
      monitoring: id("monitoring artifact"),
      providerQuorum: id("provider quorum artifact"),
      solverOperations: id("solver operations artifact"),
      testQualification: id("test qualification artifact"),
    },
    features: {
      lpShares: false,
      mainnetAssets: false,
      makerRewards: false,
      operatorOwnedTestInventory: true,
      partialFills: false,
      publicLpDeposits: false,
      promisedYield: false,
      rewards: false,
    },
    gate: {
      initiallyClosed: true,
      finallyClosed: true,
      unsafeObservationsHalted: true,
      haltPreservedExits: true,
      closureEvidenceDigest: id("closed gate evidence"),
    },
    reconciliation: {
      reconciledAt: finishedAt,
      unreconciledLiabilities: "0",
      bitInventoryDigest: id("bit inventory"),
      lightningInventoryDigest: id("lightning inventory"),
      inFlightDigest: id("in flight state"),
      reconciliationDigest: id("final reconciliation"),
    },
  };
  return { attestations: [], policy, record, wallets };
}

async function sign(value) {
  value.attestations = [];
  for (const participant of value.record.participants) {
    const message = buildPublicTestnetAttestationMessage({
      record: value.record,
      policy: value.policy,
      role: participant.role,
      operatorId: participant.operatorId,
    });
    const wallet = value.wallets.get(participant.signer);
    value.attestations.push({
      role: participant.role,
      operatorId: participant.operatorId,
      signer: participant.signer,
      signature: await wallet.signTypedData(message.domain, message.types, message.value),
    });
  }
  value.attestations = canonical(value.attestations, (item) => `${item.role}:${item.operatorId}`);
  return value;
}

async function validFixture() {
  return sign(fixture());
}

test("verifies a seven-day multi-operator campaign and derives release evidence without funding authority", async () => {
  const value = await validFixture();
  const verified = verifyPublicTestnetCampaign({ ...value, now: NOW });
  assert.equal(verified.status, "cryptographically-verified-operator-attestations");
  assert.equal(verified.scope, "candidate-release-evidence-no-funding-authorization");
  assert.match(verified.recordDigest, /^0x[0-9a-f]{64}$/);
  const release = buildPublicTestnetReleaseEvidence(verified);
  assert.equal(release.publicTestnet, verified.recordDigest);
  assert.equal(release.deploymentManifest, value.record.deploymentManifestDigest);
  assert.equal(release.admissionPolicy, value.policy.admissionPolicyDigest);
  assert.equal(release.counts.independentSolvers, 2);
  assert.equal(release.counts.independentEvmProviders, 2);
  const summary = buildPublicTestnetAdoptionSummary(verified);
  assert.equal(summary.durationSeconds, 604_800);
  assert.equal(summary.gateFinallyClosed, true);
  assert.equal(summary.unreconciledLiabilities, "0");
  assert.equal(summary.solvers.length, 2);
  assert.equal(summary.solvers[0].fillRateBps, 8_800);
  assert.equal(summary.solvers[0].timeoutRateBps, 400);
  assert.equal(summary.solvers[0].failureRateBps, 400);
  assert.equal("signer" in summary.solvers[0], false);
});

test("requires provenance instead of accepting copied campaign-verification claims", async () => {
  const value = await validFixture();
  const verified = verifyPublicTestnetCampaign({ ...value, now: NOW });
  assert.throws(() => buildPublicTestnetReleaseEvidence({ ...verified }), /provenance/);
  assert.throws(() => buildPublicTestnetAdoptionSummary(structuredClone(verified)), /provenance/);
});

test("absolute duration, count, sample, freshness, and reliability limits cannot be weakened", async () => {
  for (const mutate of [
    (value) => { value.policy.minimumCampaignDurationSeconds = 86_400; },
    (value) => { value.policy.minimumCounts.solvers = 1; },
    (value) => { value.policy.minimumSelectedSwapsPerSolver = 1; },
    (value) => { value.policy.minimumSelectedSwapsPerDirectionPerSolver = 1; },
    (value) => { value.policy.maximumCapacityFreshnessP95Seconds = 121; },
    (value) => { value.policy.maximumMedianCompletionSeconds = 901; },
    (value) => { value.policy.maximumTimeoutRateBps = 2_001; },
    (value) => { value.policy.maximumFailureRateBps = 1_001; },
    (value) => { value.policy.maximumFinalReconciliationAgeSeconds = 301; },
    (value) => { value.policy.maximumEvidenceAgeSeconds = 7_776_001; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => buildPublicTestnetAttestationMessage({
        record: value.record,
        policy: value.policy,
        role: value.record.participants[0].role,
        operatorId: value.record.participants[0].operatorId,
      }),
      /minimum|seven days|twenty|ten selected|freshness|fifteen minutes|twenty percent|ten percent|five minutes|ninety days/,
    );
  }
});

test("requires the complete exact adversarial scenario set and two retained observers per scenario", async () => {
  for (const mutate of [
    (value) => { value.policy.requiredScenarios = value.policy.requiredScenarios.slice(1); },
    (value) => { value.record.scenarios = value.record.scenarios.slice(1); },
    (value) => { value.record.scenarios[0].status = "failed"; },
    (value) => { value.record.scenarios[0].observerOperatorIds = [value.record.scenarios[0].observerOperatorIds[0]]; },
    (value) => { value.record.scenarios[0].observerOperatorIds[0] = id("unknown operator"); },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => buildPublicTestnetAttestationMessage({
        record: value.record,
        policy: value.policy,
        role: value.record.participants[0].role,
        operatorId: value.record.participants[0].operatorId,
      }),
      /required scenario|exactly match|did not pass|at least two|unknown observing|canonically ordered/,
    );
  }
});

test("rejects self-counting, duplicate, misordered, or incomplete participant sets", async () => {
  for (const mutate of [
    (value) => { value.record.counts.solvers = 3; },
    (value) => { value.record.counts.alertChannels = 3; },
    (value) => { value.record.participants[1].operatorId = value.record.participants[0].operatorId; },
    (value) => { value.record.participants[1].signer = value.record.participants[0].signer; },
    (value) => { value.record.participants.reverse(); },
    (value) => { value.record.solverMetrics.pop(); },
    (value) => { value.record.alertChannelEvidenceDigests[1] = value.record.alertChannelEvidenceDigests[0]; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => buildPublicTestnetAttestationMessage({
        record: value.record,
        policy: value.policy,
        role: value.record.participants[0].role,
        operatorId: value.record.participants[0].operatorId,
      }),
      /count|distinct|duplicated|ordered|metric/,
    );
  }
});

test("solver adoption metrics must reconcile and remain within policy", async () => {
  for (const mutate of [
    (metric) => { metric.selectedSwaps = 19; },
    (metric) => { metric.selectedBitToLightningSwaps = 9; metric.selectedLightningToBitSwaps = 16; },
    (metric) => { metric.selectedBitToLightningSwaps = 11; },
    (metric) => { metric.quoteRequests = 20; metric.selectedSwaps = 21; },
    (metric) => { metric.completedSwaps = 21; },
    (metric) => { metric.medianCompletionSeconds = 901; },
    (metric) => { metric.capacityFreshnessP95Seconds = 121; },
    (metric) => { metric.timedOutSwaps = 6; metric.completedSwaps = 16; },
    (metric) => { metric.failedSwaps = 3; metric.completedSwaps = 20; },
  ]) {
    const value = fixture();
    mutate(value.record.solverMetrics[0]);
    assert.throws(
      () => buildPublicTestnetAttestationMessage({
        record: value.record,
        policy: value.policy,
        role: value.record.participants[0].role,
        operatorId: value.record.participants[0].operatorId,
      }),
      /sample|quote requests|reconcile|median|freshness|timeout|failure/,
    );
  }
});

test("campaigns must start and finish closed with reconciled zero liabilities and test assets only", async () => {
  for (const mutate of [
    (value) => { value.record.features.mainnetAssets = true; },
    (value) => { value.record.features.publicLpDeposits = true; },
    (value) => { value.record.features.promisedYield = true; },
    (value) => { value.record.features.operatorOwnedTestInventory = false; },
    (value) => { value.record.gate.initiallyClosed = false; },
    (value) => { value.record.gate.finallyClosed = false; },
    (value) => { value.record.gate.haltPreservedExits = false; },
    (value) => { value.record.reconciliation.unreconciledLiabilities = "1"; },
    (value) => { value.record.reconciliation.unreconciledLiabilities = 0; },
    (value) => { value.record.reconciliation.reconciledAt = FINISHED_AT + 1; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => buildPublicTestnetAttestationMessage({
        record: value.record,
        policy: value.policy,
        role: value.record.participants[0].role,
        operatorId: value.record.participants[0].operatorId,
      }),
      /features|gate safety|unreconciled|outside the campaign/,
    );
  }
});

test("every exact participant must sign the record and policy without replay or role substitution", async () => {
  const missing = await validFixture();
  missing.attestations.pop();
  assert.throws(() => verifyPublicTestnetCampaign({ ...missing, now: NOW }), /every participant/);

  const duplicate = await validFixture();
  duplicate.attestations[1] = { ...duplicate.attestations[0] };
  assert.throws(() => verifyPublicTestnetCampaign({ ...duplicate, now: NOW }), /ordered|duplicated|participant/);

  const wrongRole = await validFixture();
  wrongRole.attestations[0] = { ...wrongRole.attestations[0], role: "solver" };
  wrongRole.attestations = canonical(wrongRole.attestations, (value) => `${value.role}:${value.operatorId}`);
  assert.throws(() => verifyPublicTestnetCampaign({ ...wrongRole, now: NOW }), /participant|signature/);

  const replay = await validFixture();
  replay.policy.maximumEvidenceAgeSeconds -= 1;
  assert.throws(() => verifyPublicTestnetCampaign({ ...replay, now: NOW }), /signature/);

  const tampered = await validFixture();
  tampered.record.artifacts.monitoring = id("different monitoring evidence");
  assert.throws(() => verifyPublicTestnetCampaign({ ...tampered, now: NOW }), /signature/);
});

test("future, stale, short, or overlong campaigns fail closed", async () => {
  const future = await validFixture();
  assert.throws(() => verifyPublicTestnetCampaign({ ...future, now: FINISHED_AT - 1 }), /future/);
  const stale = await validFixture();
  assert.throws(
    () => verifyPublicTestnetCampaign({ ...stale, now: FINISHED_AT + stale.policy.maximumEvidenceAgeSeconds + 1 }),
    /stale/,
  );
  for (const duration of [604_799, 2_678_401]) {
    const value = fixture();
    value.record.startedAt = FINISHED_AT - duration;
    assert.throws(
      () => buildPublicTestnetAttestationMessage({
        record: value.record,
        policy: value.policy,
        role: value.record.participants[0].role,
        operatorId: value.record.participants[0].operatorId,
      }),
      /duration|timestamps/,
    );
  }
});

test("unknown fields, noncanonical chain values, secrets, endpoints, and invoices are rejected", async () => {
  const extra = fixture();
  extra.record.fundingApproved = true;
  assert.throws(
    () => buildPublicTestnetAttestationMessage({
      record: extra.record,
      policy: extra.policy,
      role: extra.record.participants[0].role,
      operatorId: extra.record.participants[0].operatorId,
    }),
    /fields are not exact/,
  );
  const noncanonical = fixture();
  noncanonical.record.chainId = "011155111";
  assert.throws(
    () => buildPublicTestnetAttestationMessage({
      record: noncanonical.record,
      policy: noncanonical.policy,
      role: noncanonical.record.participants[0].role,
      operatorId: noncanonical.record.participants[0].operatorId,
    }),
    /canonical positive decimal/,
  );
  assert.throws(() => assertPublicTestnetEvidenceIsSecretFree({ rpcUrl: "https://rpc.example/key" }), /forbidden/);
  assert.throws(() => assertPublicTestnetEvidenceIsSecretFree({ note: "lnbc1234567890123456789012345" }), /secret/);
  assert.throws(() => assertPublicTestnetEvidenceIsSecretFree({ note: "https://relay.example" }), /endpoint/);
});

test("operator preparation and complete bundle verification CLIs emit no funding authority", async (context) => {
  const finishedAt = Math.floor(Date.now() / 1_000) - 5;
  const value = await sign(fixture({ finishedAt }));
  const directory = await mkdtemp(join(tmpdir(), "treeswap-public-testnet-evidence-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const recordPath = join(directory, "record.json");
  const policyPath = join(directory, "policy.json");
  const attestationsPath = join(directory, "attestations.json");
  await Promise.all([
    writeFile(recordPath, JSON.stringify(value.record)),
    writeFile(policyPath, JSON.stringify(value.policy)),
    writeFile(attestationsPath, JSON.stringify(value.attestations)),
  ]);

  const participant = value.record.participants[0];
  const prepared = spawnSync(process.execPath, [
    "scripts/prepare-public-testnet-attestation.mjs",
    "--record", recordPath,
    "--policy", policyPath,
    "--role", participant.role,
    "--operator-id", participant.operatorId,
  ], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const typedData = JSON.parse(prepared.stdout);
  assert.equal(typedData.scope, "operator-attestation-only-no-funding-authorization");
  assert.equal(typedData.primaryType, "CampaignAttestation");
  assert.equal(typedData.message.campaignId, value.record.campaignId);
  assert.equal("privateKey" in typedData, false);

  const verified = spawnSync(process.execPath, [
    "scripts/verify-public-testnet-evidence.mjs",
    "--record", recordPath,
    "--policy", policyPath,
    "--attestations", attestationsPath,
  ], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  const output = JSON.parse(verified.stdout);
  assert.equal(output.scope, "candidate-release-evidence-no-funding-authorization");
  assert.match(output.recordDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(output.releaseEvidence.publicTestnet, output.recordDigest);
  assert.equal("fundingAuthorization" in output, false);
});
