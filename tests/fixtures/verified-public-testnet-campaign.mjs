import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import {
  REQUIRED_PUBLIC_TESTNET_SCENARIOS,
  buildPublicTestnetAttestationMessage,
  verifyPublicTestnetCampaign,
} from "../../lib/public-testnet-evidence.mjs";

const CHAIN_ID = "11155111";
const COMMIT = "1".repeat(40);
const VERIFYING_CONTRACT = "0x1000000000000000000000000000000000000001";
export const FINISHED_AT = 1_800_000_000;
export const NOW = FINISHED_AT + 100;
const ROLES = ["evm-provider", "lightning-observer", "monitor", "relay", "solver"];

export function id(value) {
  return keccak256(toUtf8Bytes(value)).toLowerCase();
}

export function canonical(values, selector) {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right)));
}

export function fixture({
  finishedAt = FINISHED_AT,
  chainId = CHAIN_ID,
  reviewedBuildCommit = COMMIT,
  verifyingContract = VERIFYING_CONTRACT,
  deploymentManifestDigest = id("public testnet deployment manifest"),
} = {}) {
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
  const policy = {
    schema: "treeswap.public-testnet-evidence-policy.v1",
    environment: "public-testnet",
    chainId,
    verifyingContract,
    reviewedBuildCommit,
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
    chainId,
    verifyingContract,
    reviewedBuildCommit,
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

export async function sign(value) {
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

export async function validFixture(options = {}) {
  return sign(fixture(options));
}

export async function createVerifiedPublicTestnetCampaignFixture(options = {}) {
  const candidate = await validFixture(options);
  const verification = verifyPublicTestnetCampaign({
    ...candidate,
    now: options.now ?? candidate.record.finishedAt + 100,
  });
  return Object.freeze({ candidate, verification });
}
