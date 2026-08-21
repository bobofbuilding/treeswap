import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertPublicTestnetEvidenceIsSecretFree,
  buildPublicTestnetAdoptionSummary,
  buildPublicTestnetAttestationMessage,
  buildPublicTestnetReleaseEvidence,
  verifyPublicTestnetCampaign,
} from "../lib/public-testnet-evidence.mjs";
import {
  FINISHED_AT,
  NOW,
  canonical,
  fixture,
  id,
  sign,
  validFixture,
} from "./fixtures/verified-public-testnet-campaign.mjs";

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
    (value) => { value.record.participants[2].operatorId = value.record.participants[0].operatorId; },
    (value) => { value.record.participants[2].signer = value.record.participants[0].signer; },
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
