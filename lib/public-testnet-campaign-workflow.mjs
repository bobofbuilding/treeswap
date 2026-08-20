import {
  getAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  assertPublicTestnetEvidenceIsSecretFree,
  preparePublicTestnetCampaignCandidate,
  preparePublicTestnetEvidencePolicy,
} from "./public-testnet-evidence.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const UINT64_MAX = (1n << 64n) - 1n;
const STATE_SCHEMA = "treeswap.public-testnet-campaign-workspace.v1";
const STATE_SCOPE = "operator-testnet-evidence-only-no-signing-or-funding-authorization";

const ROLES = Object.freeze([
  "evm-provider",
  "lightning-observer",
  "monitor",
  "relay",
  "solver",
]);

const ROLE_TO_COUNT = Object.freeze({
  "evm-provider": "evmProviders",
  "lightning-observer": "lightningObservers",
  monitor: "monitors",
  relay: "relays",
  solver: "solvers",
});

const STATE_FIELDS = Object.freeze([
  "campaignId",
  "parentStateDigest",
  "participants",
  "policy",
  "policyDigest",
  "revision",
  "scenarios",
  "schema",
  "scope",
  "solverMetrics",
  "startedAt",
]);

const PARTICIPANT_FIELDS = Object.freeze([
  "evidenceDigest",
  "operatorId",
  "role",
  "signer",
]);

const SCENARIO_FIELDS = Object.freeze([
  "evidenceDigest",
  "finishedAt",
  "name",
  "observerOperatorIds",
  "startedAt",
  "status",
]);

const SOLVER_METRIC_FIELDS = Object.freeze([
  "abandonedSwaps",
  "capacityFreshnessP95Seconds",
  "completedSwaps",
  "failedSwaps",
  "haltCount",
  "haltHistoryDigest",
  "medianCompletionSeconds",
  "operatorId",
  "quoteRequests",
  "selectedSwaps",
  "selectedBitToLightningSwaps",
  "selectedLightningToBitSwaps",
  "solverId",
  "timedOutSwaps",
]);

const FINALIZATION_FIELDS = Object.freeze([
  "alertChannelEvidenceDigests",
  "artifacts",
  "gate",
  "reconciliation",
]);

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are invalid`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return keccak256(toUtf8Bytes(canonical(value))).toLowerCase();
}

function digest(value, name) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized)) throw new TypeError(`${name} must be a lowercase bytes32 digest`);
  return normalized;
}

function safeInteger(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new TypeError(`${name} is invalid`);
  if (BigInt(value) > UINT64_MAX) throw new RangeError(`${name} exceeds uint64`);
  return value;
}

function timestamp(value, name) {
  return safeInteger(value, name, { positive: true });
}

function canonicalOrder(values, selector, name) {
  for (let index = 1; index < values.length; index += 1) {
    if (selector(values[index - 1]).localeCompare(selector(values[index])) >= 0) {
      throw new Error(`${name} must be strictly canonically ordered`);
    }
  }
}

function normalizedParticipant(value, index) {
  exactKeys(value, PARTICIPANT_FIELDS, `participants[${index}]`);
  if (!ROLES.includes(value.role)) throw new TypeError(`participants[${index}].role is invalid`);
  let signer;
  try {
    signer = getAddress(String(value.signer ?? ""));
  } catch {
    throw new TypeError(`participants[${index}].signer is invalid`);
  }
  return Object.freeze({
    role: value.role,
    operatorId: digest(value.operatorId, `participants[${index}].operatorId`),
    signer,
    evidenceDigest: digest(value.evidenceDigest, `participants[${index}].evidenceDigest`),
  });
}

function normalizedParticipants(values, policy) {
  if (!Array.isArray(values)) throw new TypeError("participants must be an array");
  if (values.length > 100) throw new Error("participant set exceeds the bounded maximum");
  const participants = values.map(normalizedParticipant);
  canonicalOrder(participants, (value) => `${value.role}:${value.operatorId}`, "participants");
  const keys = new Set();
  const participantOperators = new Set();
  const participantSigners = new Set();
  const roleOperators = new Map(ROLES.map((role) => [role, new Set()]));
  const roleSigners = new Map(ROLES.map((role) => [role, new Set()]));
  for (const participant of participants) {
    const key = `${participant.role}:${participant.operatorId}`;
    if (keys.has(key)) throw new Error("participant role and operator are duplicated");
    keys.add(key);
    const signer = participant.signer.toLowerCase();
    if (participantOperators.has(participant.operatorId)) {
      throw new Error("operator identity cannot count in more than one participant role");
    }
    if (participantSigners.has(signer)) {
      throw new Error("participant signer cannot count in more than one participant role");
    }
    if (roleOperators.get(participant.role).has(participant.operatorId)) {
      throw new Error("operator is duplicated within a role");
    }
    if (roleSigners.get(participant.role).has(signer)) throw new Error("signer is duplicated within a role");
    roleOperators.get(participant.role).add(participant.operatorId);
    roleSigners.get(participant.role).add(signer);
    participantOperators.add(participant.operatorId);
    participantSigners.add(signer);
  }
  for (const role of ROLES) {
    const count = roleOperators.get(role).size;
    const field = ROLE_TO_COUNT[role];
    if (count < policy.minimumCounts[field]) throw new Error(`${role} participant count is below policy`);
    if (count > 20) throw new Error(`${role} participant count exceeds the bounded maximum`);
  }
  return Object.freeze(participants);
}

function normalizedScenario(value, index, state) {
  exactKeys(value, SCENARIO_FIELDS, `scenarios[${index}]`);
  const name = String(value.name ?? "");
  if (!state.policy.requiredScenarios.includes(name)) throw new Error(`${name || "scenario"} is not required by policy`);
  if (value.status !== "passed") throw new Error(`${name} did not pass`);
  const startedAt = timestamp(value.startedAt, `${name}.startedAt`);
  const finishedAt = timestamp(value.finishedAt, `${name}.finishedAt`);
  if (startedAt < state.startedAt || finishedAt < startedAt
      || finishedAt > state.startedAt + state.policy.maximumCampaignDurationSeconds) {
    throw new RangeError(`${name} timestamps are outside the possible campaign interval`);
  }
  if (!Array.isArray(value.observerOperatorIds) || value.observerOperatorIds.length < 2) {
    throw new Error(`${name} requires at least two observing operators`);
  }
  const participantIds = new Set(state.participants.map((participant) => participant.operatorId));
  const observerOperatorIds = value.observerOperatorIds.map((operatorId, observerIndex) => (
    digest(operatorId, `${name}.observerOperatorIds[${observerIndex}]`)
  ));
  canonicalOrder(observerOperatorIds, (operatorId) => operatorId, `${name} observer operators`);
  for (const operatorId of observerOperatorIds) {
    if (!participantIds.has(operatorId)) throw new Error(`${name} has an unknown observing operator`);
  }
  return Object.freeze({
    name,
    status: "passed",
    startedAt,
    finishedAt,
    observerOperatorIds: Object.freeze(observerOperatorIds),
    evidenceDigest: digest(value.evidenceDigest, `${name}.evidenceDigest`),
  });
}

function normalizedSolverMetric(value, index, state) {
  exactKeys(value, SOLVER_METRIC_FIELDS, `solverMetrics[${index}]`);
  const metric = Object.freeze({
    solverId: digest(value.solverId, `solverMetrics[${index}].solverId`),
    operatorId: digest(value.operatorId, `solverMetrics[${index}].operatorId`),
    quoteRequests: safeInteger(value.quoteRequests, `solverMetrics[${index}].quoteRequests`, { positive: true }),
    selectedSwaps: safeInteger(value.selectedSwaps, `solverMetrics[${index}].selectedSwaps`, { positive: true }),
    selectedBitToLightningSwaps: safeInteger(
      value.selectedBitToLightningSwaps,
      `solverMetrics[${index}].selectedBitToLightningSwaps`,
      { positive: true },
    ),
    selectedLightningToBitSwaps: safeInteger(
      value.selectedLightningToBitSwaps,
      `solverMetrics[${index}].selectedLightningToBitSwaps`,
      { positive: true },
    ),
    completedSwaps: safeInteger(value.completedSwaps, `solverMetrics[${index}].completedSwaps`),
    timedOutSwaps: safeInteger(value.timedOutSwaps, `solverMetrics[${index}].timedOutSwaps`),
    failedSwaps: safeInteger(value.failedSwaps, `solverMetrics[${index}].failedSwaps`),
    abandonedSwaps: safeInteger(value.abandonedSwaps, `solverMetrics[${index}].abandonedSwaps`),
    medianCompletionSeconds: safeInteger(
      value.medianCompletionSeconds,
      `solverMetrics[${index}].medianCompletionSeconds`,
      { positive: true },
    ),
    capacityFreshnessP95Seconds: safeInteger(
      value.capacityFreshnessP95Seconds,
      `solverMetrics[${index}].capacityFreshnessP95Seconds`,
      { positive: true },
    ),
    haltCount: safeInteger(value.haltCount, `solverMetrics[${index}].haltCount`),
    haltHistoryDigest: digest(value.haltHistoryDigest, `solverMetrics[${index}].haltHistoryDigest`),
  });
  const solverOperators = new Set(state.participants.filter((participant) => participant.role === "solver")
    .map((participant) => participant.operatorId));
  if (!solverOperators.has(metric.operatorId)) throw new Error("solver metric is not bound to a solver operator");
  if (metric.selectedSwaps > metric.quoteRequests) throw new Error("selected swaps exceed quote requests");
  if (metric.selectedSwaps !== metric.selectedBitToLightningSwaps + metric.selectedLightningToBitSwaps) {
    throw new Error("solver direction samples do not reconcile");
  }
  if (metric.selectedSwaps !== metric.completedSwaps + metric.timedOutSwaps
      + metric.failedSwaps + metric.abandonedSwaps) {
    throw new Error("solver selected-swap outcomes do not reconcile");
  }
  if (metric.selectedSwaps < state.policy.minimumSelectedSwapsPerSolver) {
    throw new Error("solver sample is below policy");
  }
  if (metric.selectedBitToLightningSwaps < state.policy.minimumSelectedSwapsPerDirectionPerSolver
      || metric.selectedLightningToBitSwaps < state.policy.minimumSelectedSwapsPerDirectionPerSolver) {
    throw new Error("solver direction sample is below policy");
  }
  if (metric.completedSwaps === 0) throw new Error("solver has no completed swaps");
  if (metric.medianCompletionSeconds > state.policy.maximumMedianCompletionSeconds) {
    throw new Error("solver median completion exceeds policy");
  }
  if (metric.capacityFreshnessP95Seconds > state.policy.maximumCapacityFreshnessP95Seconds) {
    throw new Error("solver capacity freshness exceeds policy");
  }
  if (BigInt(metric.timedOutSwaps) * 10_000n
      > BigInt(state.policy.maximumTimeoutRateBps) * BigInt(metric.selectedSwaps)) {
    throw new Error("solver timeout rate exceeds policy");
  }
  if (BigInt(metric.failedSwaps) * 10_000n
      > BigInt(state.policy.maximumFailureRateBps) * BigInt(metric.selectedSwaps)) {
    throw new Error("solver failure rate exceeds policy");
  }
  return metric;
}

function normalizedState(raw) {
  exactKeys(raw, STATE_FIELDS, "campaign workspace");
  if (raw.schema !== STATE_SCHEMA) throw new TypeError("campaign workspace schema is invalid");
  if (raw.scope !== STATE_SCOPE) throw new TypeError("campaign workspace scope is invalid");
  const preparedPolicy = preparePublicTestnetEvidencePolicy(raw.policy);
  const policyDigest = digest(raw.policyDigest, "policyDigest");
  if (policyDigest !== preparedPolicy.policyDigest) throw new Error("campaign workspace policy digest does not match");
  const revision = safeInteger(raw.revision, "revision");
  const parentStateDigest = digest(raw.parentStateDigest, "parentStateDigest");
  if ((revision === 0) !== (parentStateDigest === ZERO_DIGEST)) {
    throw new Error("campaign workspace parent digest is inconsistent with its revision");
  }
  const base = {
    schema: STATE_SCHEMA,
    scope: STATE_SCOPE,
    revision,
    parentStateDigest,
    campaignId: digest(raw.campaignId, "campaignId"),
    startedAt: timestamp(raw.startedAt, "startedAt"),
    policyDigest,
    policy: preparedPolicy.policy,
  };
  if (base.startedAt > Number.MAX_SAFE_INTEGER - base.policy.maximumCampaignDurationSeconds) {
    throw new RangeError("campaign workspace interval exceeds the safe integer range");
  }
  const participants = normalizedParticipants(raw.participants, base.policy);
  const partial = { ...base, participants };
  if (!Array.isArray(raw.scenarios)) throw new TypeError("scenarios must be an array");
  if (!Array.isArray(raw.solverMetrics)) throw new TypeError("solverMetrics must be an array");
  if (raw.scenarios.length > base.policy.requiredScenarios.length) {
    throw new Error("scenario collection exceeds the bounded policy set");
  }
  if (raw.solverMetrics.length > 20) throw new Error("solver metric collection exceeds the bounded maximum");
  const scenarios = raw.scenarios.map((scenario, index) => normalizedScenario(scenario, index, partial));
  canonicalOrder(scenarios, (scenario) => scenario.name, "scenarios");
  const solverMetrics = raw.solverMetrics.map((metric, index) => normalizedSolverMetric(metric, index, partial));
  canonicalOrder(solverMetrics, (metric) => metric.solverId, "solver metrics");
  if (new Set(solverMetrics.map((metric) => metric.operatorId)).size !== solverMetrics.length) {
    throw new Error("solver metrics must represent distinct solver operators");
  }
  if (revision !== scenarios.length + solverMetrics.length) {
    throw new Error("campaign workspace revision does not match its collected entries");
  }
  const state = Object.freeze({
    ...base,
    participants,
    scenarios: Object.freeze(scenarios),
    solverMetrics: Object.freeze(solverMetrics),
  });
  assertPublicTestnetEvidenceIsSecretFree(state);
  return state;
}

function nextState(state, changes) {
  const current = normalizedState(state);
  return normalizedState({
    ...current,
    ...changes,
    revision: current.revision + 1,
    parentStateDigest: hash(current),
  });
}

export function initializePublicTestnetCampaign({ policy, campaignId, startedAt, participants }) {
  const preparedPolicy = preparePublicTestnetEvidencePolicy(policy);
  const orderedParticipants = [...participants].map(normalizedParticipant)
    .sort((left, right) => `${left.role}:${left.operatorId}`.localeCompare(`${right.role}:${right.operatorId}`));
  return normalizedState({
    schema: STATE_SCHEMA,
    scope: STATE_SCOPE,
    revision: 0,
    parentStateDigest: ZERO_DIGEST,
    campaignId,
    startedAt,
    policyDigest: preparedPolicy.policyDigest,
    policy: preparedPolicy.policy,
    participants: orderedParticipants,
    scenarios: [],
    solverMetrics: [],
  });
}

export function appendPublicTestnetScenario(state, scenario) {
  const current = normalizedState(state);
  const candidate = normalizedScenario(scenario, current.scenarios.length, current);
  if (current.scenarios.some((entry) => entry.name === candidate.name)) {
    throw new Error(`scenario ${candidate.name} was already collected`);
  }
  return nextState(current, {
    scenarios: [...current.scenarios, candidate].sort((left, right) => left.name.localeCompare(right.name)),
  });
}

export function appendPublicTestnetSolverMetric(state, metric) {
  const current = normalizedState(state);
  const candidate = normalizedSolverMetric(metric, current.solverMetrics.length, current);
  if (current.solverMetrics.some((entry) => entry.solverId === candidate.solverId
      || entry.operatorId === candidate.operatorId)) {
    throw new Error("solver identity or operator metric was already collected");
  }
  return nextState(current, {
    solverMetrics: [...current.solverMetrics, candidate]
      .sort((left, right) => left.solverId.localeCompare(right.solverId)),
  });
}

export function publicTestnetCampaignStateDigest(state) {
  return hash(normalizedState(state));
}

export function buildPublicTestnetCampaignCheckpoint(state) {
  const current = normalizedState(state);
  const presentScenarios = new Set(current.scenarios.map((scenario) => scenario.name));
  const presentSolverOperators = new Set(current.solverMetrics.map((metric) => metric.operatorId));
  const missingScenarios = current.policy.requiredScenarios.filter((name) => !presentScenarios.has(name));
  const missingSolverOperatorIds = current.participants
    .filter((participant) => participant.role === "solver" && !presentSolverOperators.has(participant.operatorId))
    .map((participant) => participant.operatorId);
  const collectionComplete = missingScenarios.length === 0 && missingSolverOperatorIds.length === 0;
  return Object.freeze({
    schema: "treeswap.public-testnet-campaign-checkpoint.v1",
    status: collectionComplete ? "collection-complete-awaiting-final-reconciliation" : "collecting-independent-evidence",
    scope: "checkpoint-only-no-signing-or-funding-authorization",
    campaignId: current.campaignId,
    revision: current.revision,
    stateDigest: hash(current),
    policyDigest: current.policyDigest,
    startedAt: current.startedAt,
    minimumFinishAt: current.startedAt + current.policy.minimumCampaignDurationSeconds,
    collectedScenarios: current.scenarios.length,
    collectedSolverMetrics: current.solverMetrics.length,
    missingScenarios: Object.freeze(missingScenarios),
    missingSolverOperatorIds: Object.freeze(missingSolverOperatorIds),
    collectionComplete,
  });
}

export function verifyPublicTestnetCampaignTransition(previous, next) {
  const left = normalizedState(previous);
  const right = normalizedState(next);
  if (right.revision !== left.revision + 1 || right.parentStateDigest !== hash(left)) {
    throw new Error("campaign workspace transition does not extend the previous snapshot");
  }
  for (const field of ["campaignId", "startedAt", "policyDigest"]) {
    if (right[field] !== left[field]) throw new Error(`campaign workspace changed immutable ${field}`);
  }
  if (canonical(right.policy) !== canonical(left.policy)
      || canonical(right.participants) !== canonical(left.participants)) {
    throw new Error("campaign workspace changed immutable policy or participants");
  }
  const addedScenarios = right.scenarios.filter((entry) => (
    !left.scenarios.some((previousEntry) => canonical(previousEntry) === canonical(entry))
  ));
  const addedMetrics = right.solverMetrics.filter((entry) => (
    !left.solverMetrics.some((previousEntry) => canonical(previousEntry) === canonical(entry))
  ));
  const retainedScenarios = left.scenarios.every((entry) => (
    right.scenarios.some((nextEntry) => canonical(nextEntry) === canonical(entry))
  ));
  const retainedMetrics = left.solverMetrics.every((entry) => (
    right.solverMetrics.some((nextEntry) => canonical(nextEntry) === canonical(entry))
  ));
  if (!retainedScenarios || !retainedMetrics || addedScenarios.length + addedMetrics.length !== 1) {
    throw new Error("campaign workspace transition must retain all evidence and add exactly one entry");
  }
  return Object.freeze({
    schema: "treeswap.verified-public-testnet-campaign-transition.v1",
    status: "hash-linked-single-entry-transition",
    scope: "transition-verification-only-no-signing-or-funding-authorization",
    campaignId: right.campaignId,
    previousRevision: left.revision,
    revision: right.revision,
    previousStateDigest: hash(left),
    stateDigest: hash(right),
    addition: addedScenarios.length === 1
      ? Object.freeze({ kind: "scenario", identifier: addedScenarios[0].name })
      : Object.freeze({ kind: "solver-metric", identifier: addedMetrics[0].solverId }),
  });
}

export function finalizePublicTestnetCampaign({ state, finishedAt, finalization }) {
  const current = normalizedState(state);
  const checkpoint = buildPublicTestnetCampaignCheckpoint(current);
  if (!checkpoint.collectionComplete) throw new Error("campaign evidence collection is incomplete");
  exactKeys(finalization, FINALIZATION_FIELDS, "campaign finalization");
  const alertChannelEvidenceDigests = Array.isArray(finalization.alertChannelEvidenceDigests)
    ? [...finalization.alertChannelEvidenceDigests].map((value, index) => (
      digest(value, `alertChannelEvidenceDigests[${index}]`)
    )).sort()
    : finalization.alertChannelEvidenceDigests;
  const roleCounts = Object.fromEntries(ROLES.map((role) => [
    ROLE_TO_COUNT[role],
    current.participants.filter((participant) => participant.role === role).length,
  ]));
  const record = {
    schema: "treeswap.public-testnet-campaign.v1",
    campaignId: current.campaignId,
    environment: "public-testnet",
    chainId: current.policy.chainId,
    verifyingContract: current.policy.verifyingContract,
    reviewedBuildCommit: current.policy.reviewedBuildCommit,
    deploymentManifestDigest: current.policy.deploymentManifestDigest,
    startedAt: current.startedAt,
    finishedAt: timestamp(finishedAt, "finishedAt"),
    counts: {
      alertChannels: Array.isArray(alertChannelEvidenceDigests) ? alertChannelEvidenceDigests.length : 0,
      ...roleCounts,
    },
    alertChannelEvidenceDigests,
    participants: current.participants,
    scenarios: current.scenarios,
    solverMetrics: current.solverMetrics,
    artifacts: finalization.artifacts,
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
    gate: finalization.gate,
    reconciliation: finalization.reconciliation,
  };
  const candidate = preparePublicTestnetCampaignCandidate({ record, policy: current.policy });
  return Object.freeze({
    schema: "treeswap.finalized-public-testnet-campaign-workspace.v1",
    status: candidate.status,
    scope: candidate.scope,
    sourceStateDigest: hash(current),
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    record: candidate.record,
  });
}
