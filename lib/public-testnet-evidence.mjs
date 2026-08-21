import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL_CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const UINT64_MAX = (1n << 64n) - 1n;

const PARTICIPANT_ROLES = Object.freeze([
  "evm-provider",
  "lightning-observer",
  "monitor",
  "relay",
  "solver",
]);

const COUNT_FIELDS = Object.freeze([
  "alertChannels",
  "evmProviders",
  "lightningObservers",
  "monitors",
  "relays",
  "solvers",
]);

const ROLE_TO_COUNT = Object.freeze({
  "evm-provider": "evmProviders",
  "lightning-observer": "lightningObservers",
  monitor: "monitors",
  relay: "relays",
  solver: "solvers",
});

const ABSOLUTE_MINIMUM_COUNTS = Object.freeze({
  alertChannels: 2,
  evmProviders: 2,
  lightningObservers: 2,
  monitors: 2,
  relays: 2,
  solvers: 2,
});

export const REQUIRED_PUBLIC_TESTNET_SCENARIOS = Object.freeze([
  "alert-delivery-and-escalation",
  "backup-restore",
  "bit-implementation-change",
  "bit-pause",
  "bit-to-lightning-success",
  "credential-compromise",
  "evm-finality-rollback",
  "evm-finalized-success",
  "evm-provider-disagreement",
  "evm-provider-outage",
  "evm-reorg-after-claim",
  "evm-reorg-before-authorization",
  "gate-halt-preserves-exits",
  "inventory-mismatch",
  "lightning-to-bit-success",
  "lnd-outage",
  "monitor-outage",
  "preimage-leak-response",
  "price-source-disagreement",
  "relay-censorship",
  "solver-competition",
  "solver-insolvency",
  "solver-restart",
  "solver-withholding",
]);

const POLICY_FIELDS = Object.freeze([
  "admissionPolicyDigest",
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "feeScheduleDigest",
  "maximumCampaignDurationSeconds",
  "maximumCapacityFreshnessP95Seconds",
  "maximumEvidenceAgeSeconds",
  "maximumFailureRateBps",
  "maximumFinalReconciliationAgeSeconds",
  "maximumMedianCompletionSeconds",
  "maximumTimeoutRateBps",
  "minimumCampaignDurationSeconds",
  "minimumCounts",
  "minimumSelectedSwapsPerDirectionPerSolver",
  "minimumSelectedSwapsPerSolver",
  "requiredScenarios",
  "reviewedBuildCommit",
  "riskPolicyDigest",
  "schema",
  "verifyingContract",
]);

const RECORD_FIELDS = Object.freeze([
  "alertChannelEvidenceDigests",
  "artifacts",
  "campaignId",
  "chainId",
  "counts",
  "deploymentManifestDigest",
  "environment",
  "features",
  "finishedAt",
  "gate",
  "participants",
  "reconciliation",
  "reviewedBuildCommit",
  "scenarios",
  "schema",
  "solverMetrics",
  "startedAt",
  "verifyingContract",
]);

const ARTIFACT_FIELDS = Object.freeze([
  "backupRestore",
  "findingsDisposition",
  "incidentDrills",
  "monitoring",
  "providerQuorum",
  "solverOperations",
  "testQualification",
]);

const FEATURE_FIELDS = Object.freeze([
  "lpShares",
  "mainnetAssets",
  "makerRewards",
  "operatorOwnedTestInventory",
  "partialFills",
  "publicLpDeposits",
  "promisedYield",
  "rewards",
]);

const verifiedCampaigns = new WeakSet();

export const PUBLIC_TESTNET_ATTESTATION_TYPES = Object.freeze({
  CampaignAttestation: Object.freeze([
    Object.freeze({ name: "campaignId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "role", type: "string" }),
    Object.freeze({ name: "operatorId", type: "bytes32" }),
    Object.freeze({ name: "finishedAt", type: "uint64" }),
  ]),
});

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function digest(value, name) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || normalized === ZERO_DIGEST) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return normalized;
}

function address(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function safeInteger(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new TypeError(`${name} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function timestamp(value, name) {
  const normalized = safeInteger(value, name, { positive: true });
  if (BigInt(normalized) > UINT64_MAX) throw new RangeError(`${name} exceeds uint64`);
  return normalized;
}

function canonicalChainId(value, name) {
  const normalized = String(value ?? "");
  if (!DECIMAL_CHAIN_ID.test(normalized)) throw new TypeError(`${name} must be a canonical positive decimal string`);
  if (BigInt(normalized) > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe integer range`);
  return normalized;
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function normalizedCounts(value, name) {
  exactKeys(value, COUNT_FIELDS, name);
  return Object.freeze(Object.fromEntries(COUNT_FIELDS.map((field) => [
    field,
    safeInteger(value[field], `${name}.${field}`),
  ])));
}

function requireCanonicalOrder(values, selector, name) {
  const keys = values.map(selector);
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) throw new Error(`${name} are not canonically ordered`);
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "public-testnet evidence policy");
  if (raw.schema !== "treeswap.public-testnet-evidence-policy.v1") throw new TypeError("policy schema is invalid");
  if (raw.environment !== "public-testnet") throw new TypeError("policy environment must be public-testnet");
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("policy build commit is invalid");
  const minimumCounts = normalizedCounts(raw.minimumCounts, "minimumCounts");
  for (const [field, minimum] of Object.entries(ABSOLUTE_MINIMUM_COUNTS)) {
    if (minimumCounts[field] < minimum) throw new Error(`${field} policy is below the absolute minimum`);
    if (minimumCounts[field] > 20) throw new Error(`${field} policy exceeds the bounded participant maximum`);
  }
  if (!Array.isArray(raw.requiredScenarios) || raw.requiredScenarios.length === 0) {
    throw new TypeError("requiredScenarios must be a non-empty array");
  }
  const requiredScenarios = raw.requiredScenarios.map((value, index) => {
    const name = String(value ?? "");
    if (!/^[a-z0-9-]{3,80}$/.test(name)) throw new TypeError(`requiredScenarios[${index}] is invalid`);
    return name;
  });
  requireCanonicalOrder(requiredScenarios, (value) => value, "required scenarios");
  if (new Set(requiredScenarios).size !== requiredScenarios.length) throw new Error("required scenarios are duplicated");
  if (requiredScenarios.length > 64) throw new Error("required scenario set exceeds the bounded maximum");
  for (const scenario of REQUIRED_PUBLIC_TESTNET_SCENARIOS) {
    if (!requiredScenarios.includes(scenario)) throw new Error(`required scenario ${scenario} cannot be omitted`);
  }

  const minimumCampaignDurationSeconds = safeInteger(
    raw.minimumCampaignDurationSeconds,
    "minimumCampaignDurationSeconds",
    { positive: true },
  );
  const maximumCampaignDurationSeconds = safeInteger(
    raw.maximumCampaignDurationSeconds,
    "maximumCampaignDurationSeconds",
    { positive: true },
  );
  const maximumEvidenceAgeSeconds = safeInteger(
    raw.maximumEvidenceAgeSeconds,
    "maximumEvidenceAgeSeconds",
    { positive: true },
  );
  const maximumFinalReconciliationAgeSeconds = safeInteger(
    raw.maximumFinalReconciliationAgeSeconds,
    "maximumFinalReconciliationAgeSeconds",
    { positive: true },
  );
  const minimumSelectedSwapsPerSolver = safeInteger(
    raw.minimumSelectedSwapsPerSolver,
    "minimumSelectedSwapsPerSolver",
    { positive: true },
  );
  const minimumSelectedSwapsPerDirectionPerSolver = safeInteger(
    raw.minimumSelectedSwapsPerDirectionPerSolver,
    "minimumSelectedSwapsPerDirectionPerSolver",
    { positive: true },
  );
  const maximumCapacityFreshnessP95Seconds = safeInteger(
    raw.maximumCapacityFreshnessP95Seconds,
    "maximumCapacityFreshnessP95Seconds",
    { positive: true },
  );
  const maximumMedianCompletionSeconds = safeInteger(
    raw.maximumMedianCompletionSeconds,
    "maximumMedianCompletionSeconds",
    { positive: true },
  );
  const maximumTimeoutRateBps = safeInteger(raw.maximumTimeoutRateBps, "maximumTimeoutRateBps");
  const maximumFailureRateBps = safeInteger(raw.maximumFailureRateBps, "maximumFailureRateBps");

  if (minimumCampaignDurationSeconds < 604_800) throw new Error("campaign policy must require at least seven days");
  if (maximumCampaignDurationSeconds < minimumCampaignDurationSeconds || maximumCampaignDurationSeconds > 2_678_400) {
    throw new Error("campaign duration policy is outside seven to thirty-one days");
  }
  if (maximumEvidenceAgeSeconds > 7_776_000) throw new Error("evidence may not remain current longer than ninety days");
  if (maximumFinalReconciliationAgeSeconds > 300) {
    throw new Error("final reconciliation policy exceeds five minutes");
  }
  if (minimumSelectedSwapsPerSolver < 20) throw new Error("policy must require at least twenty selected swaps per solver");
  if (minimumSelectedSwapsPerDirectionPerSolver < 10
      || minimumSelectedSwapsPerDirectionPerSolver * 2 > minimumSelectedSwapsPerSolver) {
    throw new Error("policy must require at least ten selected swaps per direction per solver");
  }
  if (maximumCapacityFreshnessP95Seconds > 120) throw new Error("capacity freshness policy exceeds two minutes");
  if (maximumMedianCompletionSeconds > 900) throw new Error("median completion policy exceeds fifteen minutes");
  if (maximumTimeoutRateBps > 2_000) throw new Error("timeout-rate policy exceeds twenty percent");
  if (maximumFailureRateBps > 1_000) throw new Error("failure-rate policy exceeds ten percent");

  return Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    chainId: canonicalChainId(raw.chainId, "chainId"),
    verifyingContract: address(raw.verifyingContract, "verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "deploymentManifestDigest"),
    admissionPolicyDigest: digest(raw.admissionPolicyDigest, "admissionPolicyDigest"),
    riskPolicyDigest: digest(raw.riskPolicyDigest, "riskPolicyDigest"),
    feeScheduleDigest: digest(raw.feeScheduleDigest, "feeScheduleDigest"),
    minimumCampaignDurationSeconds,
    maximumCampaignDurationSeconds,
    maximumEvidenceAgeSeconds,
    maximumFinalReconciliationAgeSeconds,
    minimumCounts,
    minimumSelectedSwapsPerSolver,
    minimumSelectedSwapsPerDirectionPerSolver,
    maximumCapacityFreshnessP95Seconds,
    maximumMedianCompletionSeconds,
    maximumTimeoutRateBps,
    maximumFailureRateBps,
    requiredScenarios: Object.freeze(requiredScenarios),
  });
}

function normalizeParticipant(value, index) {
  exactKeys(value, ["evidenceDigest", "operatorId", "role", "signer"], `participants[${index}]`);
  if (!PARTICIPANT_ROLES.includes(value.role)) throw new TypeError(`participants[${index}].role is invalid`);
  return Object.freeze({
    role: value.role,
    operatorId: digest(value.operatorId, `participants[${index}].operatorId`),
    signer: address(value.signer, `participants[${index}].signer`),
    evidenceDigest: digest(value.evidenceDigest, `participants[${index}].evidenceDigest`),
  });
}

function normalizeScenario(value, index, participantOperatorIds, startedAt, finishedAt) {
  exactKeys(
    value,
    ["evidenceDigest", "finishedAt", "name", "observerOperatorIds", "startedAt", "status"],
    `scenarios[${index}]`,
  );
  const name = String(value.name ?? "");
  if (!/^[a-z0-9-]{3,80}$/.test(name)) throw new TypeError(`scenarios[${index}].name is invalid`);
  if (value.status !== "passed") throw new Error(`${name} did not pass`);
  const scenarioStartedAt = timestamp(value.startedAt, `${name}.startedAt`);
  const scenarioFinishedAt = timestamp(value.finishedAt, `${name}.finishedAt`);
  if (scenarioStartedAt < startedAt || scenarioFinishedAt > finishedAt || scenarioFinishedAt < scenarioStartedAt) {
    throw new RangeError(`${name} timestamps are outside the campaign`);
  }
  if (!Array.isArray(value.observerOperatorIds) || value.observerOperatorIds.length < 2) {
    throw new Error(`${name} requires at least two observing operators`);
  }
  const observerOperatorIds = value.observerOperatorIds.map((raw, observerIndex) => (
    digest(raw, `${name}.observerOperatorIds[${observerIndex}]`)
  ));
  requireCanonicalOrder(observerOperatorIds, (raw) => raw, `${name} observer operators`);
  if (new Set(observerOperatorIds).size !== observerOperatorIds.length) {
    throw new Error(`${name} observer operators are duplicated`);
  }
  for (const operatorId of observerOperatorIds) {
    if (!participantOperatorIds.has(operatorId)) throw new Error(`${name} has an unknown observing operator`);
  }
  return Object.freeze({
    name,
    status: "passed",
    startedAt: scenarioStartedAt,
    finishedAt: scenarioFinishedAt,
    observerOperatorIds: Object.freeze(observerOperatorIds),
    evidenceDigest: digest(value.evidenceDigest, `${name}.evidenceDigest`),
  });
}

function normalizeSolverMetric(value, index, solverOperators, policy) {
  exactKeys(value, [
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
  ], `solverMetrics[${index}]`);
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
  if (!solverOperators.has(metric.operatorId)) throw new Error("solver metric is not bound to a solver operator");
  if (metric.selectedSwaps > metric.quoteRequests) throw new Error("selected swaps exceed quote requests");
  if (metric.selectedSwaps !== metric.selectedBitToLightningSwaps + metric.selectedLightningToBitSwaps) {
    throw new Error("solver direction samples do not reconcile");
  }
  if (metric.selectedSwaps !== metric.completedSwaps + metric.timedOutSwaps + metric.failedSwaps + metric.abandonedSwaps) {
    throw new Error("solver selected-swap outcomes do not reconcile");
  }
  if (metric.selectedSwaps < policy.minimumSelectedSwapsPerSolver) throw new Error("solver sample is below policy");
  if (metric.selectedBitToLightningSwaps < policy.minimumSelectedSwapsPerDirectionPerSolver
      || metric.selectedLightningToBitSwaps < policy.minimumSelectedSwapsPerDirectionPerSolver) {
    throw new Error("solver direction sample is below policy");
  }
  if (metric.completedSwaps === 0) throw new Error("solver has no completed swaps");
  if (metric.medianCompletionSeconds > policy.maximumMedianCompletionSeconds) {
    throw new Error("solver median completion exceeds policy");
  }
  if (metric.capacityFreshnessP95Seconds > policy.maximumCapacityFreshnessP95Seconds) {
    throw new Error("solver capacity freshness exceeds policy");
  }
  if (BigInt(metric.timedOutSwaps) * 10_000n > BigInt(policy.maximumTimeoutRateBps) * BigInt(metric.selectedSwaps)) {
    throw new Error("solver timeout rate exceeds policy");
  }
  if (BigInt(metric.failedSwaps) * 10_000n > BigInt(policy.maximumFailureRateBps) * BigInt(metric.selectedSwaps)) {
    throw new Error("solver failure rate exceeds policy");
  }
  return metric;
}

function normalizeRecord(raw, policy) {
  exactKeys(raw, RECORD_FIELDS, "public-testnet campaign record");
  if (raw.schema !== "treeswap.public-testnet-campaign.v1") throw new TypeError("campaign schema is invalid");
  if (raw.environment !== "public-testnet") throw new TypeError("campaign environment must be public-testnet");
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("campaign build commit is invalid");
  const startedAt = timestamp(raw.startedAt, "startedAt");
  const finishedAt = timestamp(raw.finishedAt, "finishedAt");
  if (finishedAt <= startedAt) throw new RangeError("campaign time interval is reversed or empty");
  const duration = finishedAt - startedAt;
  if (duration < policy.minimumCampaignDurationSeconds || duration > policy.maximumCampaignDurationSeconds) {
    throw new RangeError("campaign duration is outside policy");
  }
  const record = {
    schema: raw.schema,
    campaignId: digest(raw.campaignId, "campaignId"),
    environment: raw.environment,
    chainId: canonicalChainId(raw.chainId, "chainId"),
    verifyingContract: address(raw.verifyingContract, "verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "deploymentManifestDigest"),
    startedAt,
    finishedAt,
  };
  if (record.chainId !== policy.chainId
      || record.verifyingContract !== policy.verifyingContract
      || record.reviewedBuildCommit !== policy.reviewedBuildCommit
      || record.deploymentManifestDigest !== policy.deploymentManifestDigest) {
    throw new Error("campaign does not match its evidence policy");
  }

  const counts = normalizedCounts(raw.counts, "counts");
  for (const field of COUNT_FIELDS) {
    if (counts[field] < policy.minimumCounts[field]) throw new Error(`${field} is below policy`);
    if (counts[field] > 20) throw new Error(`${field} exceeds the bounded maximum`);
  }
  if (!Array.isArray(raw.participants)) throw new TypeError("participants must be an array");
  const participants = raw.participants.map(normalizeParticipant);
  if (participants.length > 100) throw new Error("participant set exceeds the bounded maximum");
  requireCanonicalOrder(participants, (value) => `${value.role}:${value.operatorId}`, "participants");
  const participantKeys = new Set();
  const participantOperators = new Set();
  const participantSigners = new Set();
  const roleOperators = new Map(PARTICIPANT_ROLES.map((role) => [role, new Set()]));
  const roleSigners = new Map(PARTICIPANT_ROLES.map((role) => [role, new Set()]));
  for (const participant of participants) {
    const key = `${participant.role}:${participant.operatorId}`;
    if (participantKeys.has(key)) throw new Error("participant role and operator are duplicated");
    participantKeys.add(key);
    const signer = participant.signer.toLowerCase();
    if (participantOperators.has(participant.operatorId)) {
      throw new Error("operator identity cannot count in more than one participant role");
    }
    if (participantSigners.has(signer)) {
      throw new Error("participant signer cannot count in more than one participant role");
    }
    if (roleOperators.get(participant.role).has(participant.operatorId)) throw new Error("operator is duplicated within a role");
    if (roleSigners.get(participant.role).has(signer)) throw new Error("signer is duplicated within a role");
    participantOperators.add(participant.operatorId);
    participantSigners.add(signer);
    roleOperators.get(participant.role).add(participant.operatorId);
    roleSigners.get(participant.role).add(signer);
  }
  for (const role of PARTICIPANT_ROLES) {
    if (roleOperators.get(role).size !== counts[ROLE_TO_COUNT[role]]) throw new Error(`${role} count does not match participants`);
  }
  const participantOperatorIds = new Set(participants.map((value) => value.operatorId));

  if (!Array.isArray(raw.alertChannelEvidenceDigests)) {
    throw new TypeError("alertChannelEvidenceDigests must be an array");
  }
  const alertChannelEvidenceDigests = raw.alertChannelEvidenceDigests.map((value, index) => (
    digest(value, `alertChannelEvidenceDigests[${index}]`)
  ));
  requireCanonicalOrder(alertChannelEvidenceDigests, (value) => value, "alert channel evidence digests");
  if (alertChannelEvidenceDigests.length !== counts.alertChannels
      || new Set(alertChannelEvidenceDigests).size !== alertChannelEvidenceDigests.length) {
    throw new Error("alert channel evidence count is not exact and distinct");
  }

  if (!Array.isArray(raw.scenarios)) throw new TypeError("scenarios must be an array");
  const scenarios = raw.scenarios.map((value, index) => (
    normalizeScenario(value, index, participantOperatorIds, startedAt, finishedAt)
  ));
  requireCanonicalOrder(scenarios, (value) => value.name, "scenarios");
  if (scenarios.length !== policy.requiredScenarios.length
      || scenarios.some((value, index) => value.name !== policy.requiredScenarios[index])) {
    throw new Error("campaign scenarios do not exactly match policy");
  }

  if (!Array.isArray(raw.solverMetrics)) throw new TypeError("solverMetrics must be an array");
  const solverMetrics = raw.solverMetrics.map((value, index) => (
    normalizeSolverMetric(value, index, roleOperators.get("solver"), policy)
  ));
  requireCanonicalOrder(solverMetrics, (value) => value.solverId, "solver metrics");
  if (solverMetrics.length !== counts.solvers) throw new Error("solver metric count does not match solver count");
  if (new Set(solverMetrics.map((value) => value.solverId)).size !== solverMetrics.length) {
    throw new Error("solver metrics contain a duplicate solver identity");
  }
  if (new Set(solverMetrics.map((value) => value.operatorId)).size !== solverMetrics.length) {
    throw new Error("solver metrics must represent independent solver operators");
  }

  exactKeys(raw.artifacts, ARTIFACT_FIELDS, "artifacts");
  const artifacts = Object.freeze(Object.fromEntries(ARTIFACT_FIELDS.map((field) => [
    field,
    digest(raw.artifacts[field], `artifacts.${field}`),
  ])));
  exactKeys(raw.features, FEATURE_FIELDS, "features");
  const features = Object.freeze(Object.fromEntries(FEATURE_FIELDS.map((field) => [
    field,
    boolean(raw.features[field], `features.${field}`),
  ])));
  if (features.mainnetAssets || features.lpShares || features.makerRewards || features.partialFills
      || features.promisedYield || features.publicLpDeposits || features.rewards
      || !features.operatorOwnedTestInventory) {
    throw new Error("campaign features exceed the public-testnet operator-inventory boundary");
  }

  exactKeys(raw.gate, [
    "closureEvidenceDigest",
    "finallyClosed",
    "haltPreservedExits",
    "initiallyClosed",
    "unsafeObservationsHalted",
  ], "gate");
  const gate = Object.freeze({
    initiallyClosed: boolean(raw.gate.initiallyClosed, "gate.initiallyClosed"),
    finallyClosed: boolean(raw.gate.finallyClosed, "gate.finallyClosed"),
    unsafeObservationsHalted: boolean(raw.gate.unsafeObservationsHalted, "gate.unsafeObservationsHalted"),
    haltPreservedExits: boolean(raw.gate.haltPreservedExits, "gate.haltPreservedExits"),
    closureEvidenceDigest: digest(raw.gate.closureEvidenceDigest, "gate.closureEvidenceDigest"),
  });
  if (!gate.initiallyClosed || !gate.finallyClosed || !gate.unsafeObservationsHalted || !gate.haltPreservedExits) {
    throw new Error("campaign gate safety conditions did not all pass");
  }

  exactKeys(raw.reconciliation, [
    "bitInventoryDigest",
    "inFlightDigest",
    "lightningInventoryDigest",
    "reconciledAt",
    "reconciliationDigest",
    "unreconciledLiabilities",
  ], "reconciliation");
  const reconciliation = Object.freeze({
    reconciledAt: timestamp(raw.reconciliation.reconciledAt, "reconciliation.reconciledAt"),
    unreconciledLiabilities: raw.reconciliation.unreconciledLiabilities,
    bitInventoryDigest: digest(raw.reconciliation.bitInventoryDigest, "reconciliation.bitInventoryDigest"),
    lightningInventoryDigest: digest(
      raw.reconciliation.lightningInventoryDigest,
      "reconciliation.lightningInventoryDigest",
    ),
    inFlightDigest: digest(raw.reconciliation.inFlightDigest, "reconciliation.inFlightDigest"),
    reconciliationDigest: digest(raw.reconciliation.reconciliationDigest, "reconciliation.reconciliationDigest"),
  });
  if (typeof reconciliation.unreconciledLiabilities !== "string"
      || reconciliation.unreconciledLiabilities !== "0") {
    throw new Error("campaign has unreconciled liabilities");
  }
  if (reconciliation.reconciledAt < startedAt || reconciliation.reconciledAt > finishedAt) {
    throw new Error("final reconciliation is outside the campaign");
  }
  if (finishedAt - reconciliation.reconciledAt > policy.maximumFinalReconciliationAgeSeconds) {
    throw new Error("final reconciliation is stale");
  }

  return Object.freeze({
    ...record,
    counts,
    alertChannelEvidenceDigests: Object.freeze(alertChannelEvidenceDigests),
    participants: Object.freeze(participants),
    scenarios: Object.freeze(scenarios),
    solverMetrics: Object.freeze(solverMetrics),
    artifacts,
    features,
    gate,
    reconciliation,
  });
}

function normalizeAttestation(value, index) {
  exactKeys(value, ["operatorId", "role", "signature", "signer"], `attestations[${index}]`);
  if (!PARTICIPANT_ROLES.includes(value.role)) throw new TypeError(`attestations[${index}].role is invalid`);
  if (!isHexString(value.signature) || ![64, 65].includes((value.signature.length - 2) / 2)) {
    throw new TypeError(`attestations[${index}].signature is invalid`);
  }
  return Object.freeze({
    role: value.role,
    operatorId: digest(value.operatorId, `attestations[${index}].operatorId`),
    signer: address(value.signer, `attestations[${index}].signer`),
    signature: value.signature,
  });
}

export function publicTestnetEvidenceDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Public Testnet Evidence",
    version: "1",
    chainId: BigInt(canonicalChainId(chainId, "domain.chainId")),
    verifyingContract: address(verifyingContract, "domain.verifyingContract"),
  });
}

export function buildPublicTestnetAttestationMessage({ record, policy, role, operatorId }) {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedRecord = normalizeRecord(record, normalizedPolicy);
  if (!PARTICIPANT_ROLES.includes(role)) throw new TypeError("attestation role is invalid");
  const normalizedOperatorId = digest(operatorId, "attestation operatorId");
  const participant = normalizedRecord.participants.find((value) => (
    value.role === role && value.operatorId === normalizedOperatorId
  ));
  if (!participant) throw new Error("attestation identity is not a campaign participant");
  return Object.freeze({
    domain: publicTestnetEvidenceDomain(normalizedRecord),
    types: PUBLIC_TESTNET_ATTESTATION_TYPES,
    value: Object.freeze({
      campaignId: normalizedRecord.campaignId,
      recordDigest: hash(normalizedRecord),
      policyDigest: hash(normalizedPolicy),
      role,
      operatorId: normalizedOperatorId,
      finishedAt: normalizedRecord.finishedAt,
    }),
  });
}

export function assertPublicTestnetEvidenceIsSecretFree(value) {
  const forbiddenKey = /(email|invoice|macaroon|mnemonic|password|preimage|private.?key|rpc.?url|seed)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string"
          && (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(entry)
            || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)
            || /https?:\/\//i.test(entry))) {
        throw new Error("public-testnet evidence contains secret or unrestricted endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`public-testnet evidence contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

export function preparePublicTestnetEvidencePolicy(policy) {
  const normalizedPolicy = normalizePolicy(policy);
  assertPublicTestnetEvidenceIsSecretFree(normalizedPolicy);
  return Object.freeze({
    schema: "treeswap.prepared-public-testnet-evidence-policy.v1",
    status: "validated-public-testnet-policy",
    scope: "campaign-construction-only-no-signing-or-funding-authorization",
    policyDigest: hash(normalizedPolicy),
    policy: normalizedPolicy,
  });
}

export function preparePublicTestnetCampaignCandidate({ record, policy }) {
  const preparedPolicy = preparePublicTestnetEvidencePolicy(policy);
  const normalizedRecord = normalizeRecord(record, preparedPolicy.policy);
  assertPublicTestnetEvidenceIsSecretFree({
    record: normalizedRecord,
    policy: preparedPolicy.policy,
  });
  return Object.freeze({
    schema: "treeswap.prepared-public-testnet-campaign.v1",
    status: "validated-awaiting-independent-participant-attestations",
    scope: "campaign-construction-only-no-signing-or-funding-authorization",
    recordDigest: hash(normalizedRecord),
    policyDigest: preparedPolicy.policyDigest,
    record: normalizedRecord,
    policy: preparedPolicy.policy,
  });
}

export function verifyPublicTestnetCampaign({ record, policy, attestations, now = Math.floor(Date.now() / 1_000) }) {
  const candidate = preparePublicTestnetCampaignCandidate({ record, policy });
  const normalizedPolicy = candidate.policy;
  const normalizedRecord = candidate.record;
  const observedAt = timestamp(now, "now");
  if (normalizedRecord.finishedAt > observedAt) throw new Error("campaign finish is in the future");
  if (observedAt - normalizedRecord.finishedAt > normalizedPolicy.maximumEvidenceAgeSeconds) {
    throw new Error("campaign evidence is stale");
  }
  if (!Array.isArray(attestations)) throw new TypeError("attestations must be an array");
  const normalizedAttestations = attestations.map(normalizeAttestation);
  if (normalizedAttestations.length > 100) throw new Error("attestation set exceeds the bounded maximum");
  requireCanonicalOrder(
    normalizedAttestations,
    (value) => `${value.role}:${value.operatorId}`,
    "attestations",
  );
  if (normalizedAttestations.length !== normalizedRecord.participants.length) {
    throw new Error("every participant must attest exactly once");
  }

  const recordDigest = candidate.recordDigest;
  const policyDigest = candidate.policyDigest;
  const domain = publicTestnetEvidenceDomain(normalizedRecord);
  const seen = new Set();
  for (const attestation of normalizedAttestations) {
    const key = `${attestation.role}:${attestation.operatorId}`;
    if (seen.has(key)) throw new Error("campaign attestation is duplicated");
    seen.add(key);
    const participant = normalizedRecord.participants.find((value) => (
      value.role === attestation.role && value.operatorId === attestation.operatorId
    ));
    if (!participant || participant.signer !== attestation.signer) {
      throw new Error("campaign attestation does not match a participant");
    }
    const recovered = verifyTypedData(domain, PUBLIC_TESTNET_ATTESTATION_TYPES, {
      campaignId: normalizedRecord.campaignId,
      recordDigest,
      policyDigest,
      role: attestation.role,
      operatorId: attestation.operatorId,
      finishedAt: normalizedRecord.finishedAt,
    }, attestation.signature);
    if (recovered !== participant.signer) throw new Error("campaign attestation signature is invalid");
  }
  assertPublicTestnetEvidenceIsSecretFree({
    record: normalizedRecord,
    policy: normalizedPolicy,
    attestations: normalizedAttestations,
  });
  const result = Object.freeze({
    schema: "treeswap.verified-public-testnet-campaign.v1",
    status: "cryptographically-verified-operator-attestations",
    scope: "candidate-release-evidence-no-funding-authorization",
    recordDigest,
    policyDigest,
    record: normalizedRecord,
    policy: normalizedPolicy,
  });
  verifiedCampaigns.add(result);
  return result;
}

function rate(value, total) {
  return Math.floor(value * 10_000 / total);
}

export function buildPublicTestnetAdoptionSummary(verification) {
  if (!verifiedCampaigns.has(verification)) throw new Error("public-testnet campaign verification provenance is invalid");
  return Object.freeze({
    schema: "treeswap.public-testnet-adoption-summary.v1",
    campaignDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    sourceCommit: verification.record.reviewedBuildCommit,
    chainId: verification.record.chainId,
    durationSeconds: verification.record.finishedAt - verification.record.startedAt,
    counts: verification.record.counts,
    gateFinallyClosed: verification.record.gate.finallyClosed,
    unreconciledLiabilities: verification.record.reconciliation.unreconciledLiabilities,
    solvers: Object.freeze(verification.record.solverMetrics.map((metric) => Object.freeze({
      solverId: metric.solverId,
      quoteRequests: metric.quoteRequests,
      selectedSwaps: metric.selectedSwaps,
      selectedBitToLightningSwaps: metric.selectedBitToLightningSwaps,
      selectedLightningToBitSwaps: metric.selectedLightningToBitSwaps,
      completedSwaps: metric.completedSwaps,
      fillRateBps: rate(metric.completedSwaps, metric.selectedSwaps),
      timeoutRateBps: rate(metric.timedOutSwaps, metric.selectedSwaps),
      failureRateBps: rate(metric.failedSwaps, metric.selectedSwaps),
      medianCompletionSeconds: metric.medianCompletionSeconds,
      capacityFreshnessP95Seconds: metric.capacityFreshnessP95Seconds,
      haltCount: metric.haltCount,
      haltHistoryDigest: metric.haltHistoryDigest,
    }))),
  });
}

export function buildPublicTestnetReleaseEvidence(verification) {
  if (!verifiedCampaigns.has(verification)) throw new Error("public-testnet campaign verification provenance is invalid");
  const { artifacts, counts } = verification.record;
  return Object.freeze({
    deploymentManifest: verification.record.deploymentManifestDigest,
    admissionPolicy: verification.policy.admissionPolicyDigest,
    riskPolicy: verification.policy.riskPolicyDigest,
    feeSchedule: verification.policy.feeScheduleDigest,
    publicTestnet: verification.recordDigest,
    providerQuorum: artifacts.providerQuorum,
    solverOperations: artifacts.solverOperations,
    monitoring: artifacts.monitoring,
    backupRestore: artifacts.backupRestore,
    incidentDrills: artifacts.incidentDrills,
    findingsDisposition: artifacts.findingsDisposition,
    testQualification: artifacts.testQualification,
    counts: Object.freeze({
      independentEvmProviders: counts.evmProviders,
      independentLightningObservers: counts.lightningObservers,
      independentMonitors: counts.monitors,
      independentRelays: counts.relays,
      independentSolvers: counts.solvers,
      alertChannels: counts.alertChannels,
    }),
  });
}
