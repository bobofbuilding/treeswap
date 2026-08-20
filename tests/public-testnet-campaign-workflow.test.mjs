import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import {
  appendPublicTestnetScenario,
  appendPublicTestnetSolverMetric,
  buildPublicTestnetCampaignCheckpoint,
  finalizePublicTestnetCampaign,
  initializePublicTestnetCampaign,
  publicTestnetCampaignStateDigest,
  verifyPublicTestnetCampaignTransition,
} from "../lib/public-testnet-campaign-workflow.mjs";
import {
  REQUIRED_PUBLIC_TESTNET_SCENARIOS,
  preparePublicTestnetCampaignCandidate,
} from "../lib/public-testnet-evidence.mjs";

const STARTED_AT = 1_800_000_000;
const FINISHED_AT = STARTED_AT + 604_800;
const ROLES = ["evm-provider", "lightning-observer", "monitor", "relay", "solver"];

function id(value) {
  return keccak256(toUtf8Bytes(value)).toLowerCase();
}

function fixture() {
  let signerIndex = 1;
  const participants = [];
  for (const role of ROLES) {
    for (let index = 0; index < 2; index += 1) {
      participants.push({
        role,
        operatorId: id(`${role} operator ${index}`),
        signer: getAddress(`0x${(signerIndex++).toString(16).padStart(40, "0")}`),
        evidenceDigest: id(`${role} operator ${index} evidence`),
      });
    }
  }
  const orderedParticipants = [...participants]
    .sort((left, right) => `${left.role}:${left.operatorId}`.localeCompare(`${right.role}:${right.operatorId}`));
  const deploymentManifestDigest = id("deployment manifest");
  const policy = {
    schema: "treeswap.public-testnet-evidence-policy.v1",
    environment: "public-testnet",
    chainId: "11155111",
    verifyingContract: "0x1000000000000000000000000000000000000001",
    reviewedBuildCommit: "1".repeat(40),
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
  const observerOperatorIds = orderedParticipants
    .filter((participant) => participant.role === "evm-provider")
    .map((participant) => participant.operatorId)
    .sort();
  const scenarios = REQUIRED_PUBLIC_TESTNET_SCENARIOS.map((name, index) => ({
    name,
    status: "passed",
    startedAt: STARTED_AT + index + 1,
    finishedAt: STARTED_AT + index + 2,
    observerOperatorIds,
    evidenceDigest: id(`${name} evidence`),
  }));
  const solverMetrics = orderedParticipants
    .filter((participant) => participant.role === "solver")
    .map((participant, index) => ({
      solverId: id(`solver ${index}`),
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
    }));
  const finalization = {
    alertChannelEvidenceDigests: [id("alert 2"), id("alert 1")],
    artifacts: {
      backupRestore: id("backup restore"),
      findingsDisposition: id("findings disposition"),
      incidentDrills: id("incident drills"),
      monitoring: id("monitoring"),
      providerQuorum: id("provider quorum"),
      solverOperations: id("solver operations"),
      testQualification: id("test qualification"),
    },
    gate: {
      initiallyClosed: true,
      finallyClosed: true,
      unsafeObservationsHalted: true,
      haltPreservedExits: true,
      closureEvidenceDigest: id("closed gate"),
    },
    reconciliation: {
      reconciledAt: FINISHED_AT,
      unreconciledLiabilities: "0",
      bitInventoryDigest: id("bit inventory"),
      lightningInventoryDigest: id("lightning inventory"),
      inFlightDigest: id("in flight"),
      reconciliationDigest: id("reconciliation"),
    },
  };
  return {
    policy,
    participants,
    orderedParticipants,
    scenarios,
    solverMetrics,
    finalization,
  };
}

function initialized(value = fixture()) {
  return initializePublicTestnetCampaign({
    policy: value.policy,
    participants: [...value.participants].reverse(),
    campaignId: id("campaign"),
    startedAt: STARTED_AT,
  });
}

function completed(value = fixture()) {
  let state = initialized(value);
  for (const scenario of [...value.scenarios].reverse()) state = appendPublicTestnetScenario(state, scenario);
  for (const metric of [...value.solverMetrics].reverse()) state = appendPublicTestnetSolverMetric(state, metric);
  return state;
}

test("builds immutable hash-linked campaign snapshots and a verifier-compatible record", () => {
  const value = fixture();
  let state = initialized(value);
  assert.deepEqual(state.participants, value.orderedParticipants);
  let checkpoint = buildPublicTestnetCampaignCheckpoint(state);
  assert.equal(checkpoint.collectionComplete, false);
  assert.equal(checkpoint.missingScenarios.length, REQUIRED_PUBLIC_TESTNET_SCENARIOS.length);
  assert.equal(checkpoint.missingSolverOperatorIds.length, 2);
  assert.equal(checkpoint.scope, "checkpoint-only-no-signing-or-funding-authorization");

  for (const entry of [...value.scenarios, ...value.solverMetrics]) {
    const previous = state;
    state = "name" in entry
      ? appendPublicTestnetScenario(state, entry)
      : appendPublicTestnetSolverMetric(state, entry);
    const transition = verifyPublicTestnetCampaignTransition(previous, state);
    assert.equal(transition.previousStateDigest, publicTestnetCampaignStateDigest(previous));
    assert.equal(transition.stateDigest, publicTestnetCampaignStateDigest(state));
    assert.equal(transition.revision, transition.previousRevision + 1);
  }

  checkpoint = buildPublicTestnetCampaignCheckpoint(state);
  assert.equal(checkpoint.collectionComplete, true);
  assert.equal(checkpoint.status, "collection-complete-awaiting-final-reconciliation");
  assert.deepEqual(checkpoint.missingScenarios, []);
  assert.deepEqual(checkpoint.missingSolverOperatorIds, []);

  const finalized = finalizePublicTestnetCampaign({
    state,
    finishedAt: FINISHED_AT,
    finalization: value.finalization,
  });
  assert.equal(finalized.status, "validated-awaiting-independent-participant-attestations");
  assert.equal(finalized.scope, "campaign-construction-only-no-signing-or-funding-authorization");
  assert.equal(finalized.sourceStateDigest, publicTestnetCampaignStateDigest(state));
  assert.equal(finalized.record.features.operatorOwnedTestInventory, true);
  assert.equal(finalized.record.features.mainnetAssets, false);
  assert.deepEqual(finalized.record.alertChannelEvidenceDigests, [...value.finalization.alertChannelEvidenceDigests].sort());
  assert.equal("attestations" in finalized, false);
  assert.equal("fundingAuthorization" in finalized, false);

  const independentlyPrepared = preparePublicTestnetCampaignCandidate({
    record: finalized.record,
    policy: value.policy,
  });
  assert.equal(independentlyPrepared.recordDigest, finalized.recordDigest);
  assert.equal(independentlyPrepared.policyDigest, finalized.policyDigest);
});

test("workspace mutations, substitutions, duplicates, and unsafe metrics fail closed", () => {
  const value = fixture();
  const initial = initialized(value);
  const reusedOperator = structuredClone(value.participants);
  reusedOperator[2].operatorId = reusedOperator[0].operatorId;
  assert.throws(() => initializePublicTestnetCampaign({
    policy: value.policy,
    participants: reusedOperator,
    campaignId: id("reused operator campaign"),
    startedAt: STARTED_AT,
  }), /cannot count in more than one participant role/);
  const reusedSigner = structuredClone(value.participants);
  reusedSigner[2].signer = reusedSigner[0].signer;
  assert.throws(() => initializePublicTestnetCampaign({
    policy: value.policy,
    participants: reusedSigner,
    campaignId: id("reused signer campaign"),
    startedAt: STARTED_AT,
  }), /cannot count in more than one participant role/);
  const first = appendPublicTestnetScenario(initial, value.scenarios[0]);
  assert.throws(() => appendPublicTestnetScenario(first, value.scenarios[0]), /already collected/);
  assert.throws(() => appendPublicTestnetScenario(initial, {
    ...value.scenarios[0],
    observerOperatorIds: [value.scenarios[0].observerOperatorIds[0]],
  }), /at least two/);
  assert.throws(() => appendPublicTestnetScenario(initial, {
    ...value.scenarios[0],
    name: "invented-success",
  }), /not required by policy/);
  assert.throws(() => appendPublicTestnetSolverMetric(initial, {
    ...value.solverMetrics[0],
    selectedSwaps: 26,
  }), /direction samples do not reconcile/);

  const revisionTamper = structuredClone(first);
  revisionTamper.revision += 1;
  assert.throws(() => buildPublicTestnetCampaignCheckpoint(revisionTamper), /revision does not match/);
  const policyTamper = structuredClone(first);
  policyTamper.policy.maximumFailureRateBps -= 1;
  assert.throws(() => buildPublicTestnetCampaignCheckpoint(policyTamper), /policy digest does not match/);
  const unknownField = { ...structuredClone(first), rpcUrl: "https://example.invalid" };
  assert.throws(() => buildPublicTestnetCampaignCheckpoint(unknownField), /fields are invalid/);

  const substituted = structuredClone(appendPublicTestnetScenario(first, value.scenarios[1]));
  substituted.scenarios[0].evidenceDigest = id("substituted evidence");
  assert.throws(() => verifyPublicTestnetCampaignTransition(first, substituted), /retain all evidence and add exactly one/);
});

test("finalization requires complete collection, duration, exact alert evidence, and zero liabilities", () => {
  const value = fixture();
  assert.throws(() => finalizePublicTestnetCampaign({
    state: initialized(value),
    finishedAt: FINISHED_AT,
    finalization: value.finalization,
  }), /collection is incomplete/);
  const state = completed(value);
  assert.throws(() => finalizePublicTestnetCampaign({
    state,
    finishedAt: FINISHED_AT - 1,
    finalization: {
      ...value.finalization,
      reconciliation: { ...value.finalization.reconciliation, reconciledAt: FINISHED_AT - 1 },
    },
  }), /duration is outside policy/);
  assert.throws(() => finalizePublicTestnetCampaign({
    state,
    finishedAt: FINISHED_AT,
    finalization: { ...value.finalization, alertChannelEvidenceDigests: [id("one alert")] },
  }), /alertChannels is below policy/);
  assert.throws(() => finalizePublicTestnetCampaign({
    state,
    finishedAt: FINISHED_AT,
    finalization: {
      ...value.finalization,
      reconciliation: { ...value.finalization.reconciliation, unreconciledLiabilities: "1" },
    },
  }), /unreconciled liabilities/);
  assert.throws(() => finalizePublicTestnetCampaign({
    state,
    finishedAt: FINISHED_AT,
    finalization: { ...value.finalization, privateKey: "0xdead" },
  }), /fields are invalid/);
});

test("campaign CLI writes private immutable snapshots, verifies transitions, and never signs or funds", async (context) => {
  const value = fixture();
  const directory = await mkdtemp(join(tmpdir(), "treeswap-public-testnet-workflow-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, "policy.json");
  const participantsPath = join(directory, "participants.json");
  const scenarioPath = join(directory, "scenario.json");
  const initialPath = join(directory, "snapshot-000.json");
  const nextPath = join(directory, "snapshot-001.json");
  await Promise.all([
    writeFile(policyPath, JSON.stringify(value.policy), { mode: 0o600 }),
    writeFile(participantsPath, JSON.stringify(value.participants), { mode: 0o600 }),
    writeFile(scenarioPath, JSON.stringify(value.scenarios[0]), { mode: 0o600 }),
  ]);

  const init = spawnSync(process.execPath, [
    "scripts/manage-public-testnet-campaign.mjs",
    "init",
    "--policy", policyPath,
    "--participants", participantsPath,
    "--campaign-id", id("campaign"),
    "--started-at", String(STARTED_AT),
    "--out", initialPath,
  ], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).status, "initialized-immutable-campaign-snapshot");
  assert.equal((await stat(initialPath)).mode & 0o777, 0o600);

  const append = spawnSync(process.execPath, [
    "scripts/manage-public-testnet-campaign.mjs",
    "scenario",
    "--state", initialPath,
    "--entry", scenarioPath,
    "--out", nextPath,
  ], { encoding: "utf8" });
  assert.equal(append.status, 0, append.stderr);
  const appendOutput = JSON.parse(append.stdout);
  assert.equal(appendOutput.status, "wrote-hash-linked-immutable-campaign-snapshot");
  assert.equal(appendOutput.addition.kind, "scenario");
  assert.equal("signature" in appendOutput, false);
  assert.equal("fundingAuthorization" in appendOutput, false);

  const transition = spawnSync(process.execPath, [
    "scripts/manage-public-testnet-campaign.mjs",
    "verify-transition",
    "--previous", initialPath,
    "--next", nextPath,
  ], { encoding: "utf8" });
  assert.equal(transition.status, 0, transition.stderr);
  assert.equal(JSON.parse(transition.stdout).status, "hash-linked-single-entry-transition");

  const overwrite = spawnSync(process.execPath, [
    "scripts/manage-public-testnet-campaign.mjs",
    "scenario",
    "--state", initialPath,
    "--entry", scenarioPath,
    "--out", nextPath,
  ], { encoding: "utf8" });
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /exist/i);

  const linkedPath = join(directory, "linked-state.json");
  await symlink(initialPath, linkedPath);
  const linked = spawnSync(process.execPath, [
    "scripts/manage-public-testnet-campaign.mjs",
    "checkpoint",
    "--state", linkedPath,
  ], { encoding: "utf8" });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /non-symlink/);

  const completedStatePath = join(directory, "completed.json");
  const finalizationPath = join(directory, "finalization.json");
  const recordPath = join(directory, "campaign.json");
  await Promise.all([
    writeFile(completedStatePath, JSON.stringify(completed(value)), { mode: 0o600 }),
    writeFile(finalizationPath, JSON.stringify(value.finalization), { mode: 0o600 }),
  ]);
  const finalized = spawnSync(process.execPath, [
    "scripts/manage-public-testnet-campaign.mjs",
    "finalize",
    "--state", completedStatePath,
    "--finalization", finalizationPath,
    "--finished-at", String(FINISHED_AT),
    "--out", recordPath,
  ], { encoding: "utf8" });
  assert.equal(finalized.status, 0, finalized.stderr);
  const finalizedOutput = JSON.parse(finalized.stdout);
  assert.equal(finalizedOutput.status, "validated-awaiting-independent-participant-attestations");
  assert.equal("signature" in finalizedOutput, false);
  assert.equal("fundingAuthorization" in finalizedOutput, false);
  assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
});
