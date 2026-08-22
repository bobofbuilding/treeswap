import { getAddress, keccak256, toUtf8Bytes } from "ethers";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const DECIMAL_CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const UINT256_MAX = (1n << 256n) - 1n;

const FUNDING_MODES = Object.freeze([
  "operator-testnet",
  "operator-testnet-bootstrap",
]);

export const ADOPTION_LIMIT_FIELDS = Object.freeze([
  "maxDailyLightningSats",
  "maxEpochSats",
  "maxInFlightSats",
  "maxPriceBandBps",
  "maxRoutingFeeSats",
  "maxSwapSats",
  "minBitReserveWei",
  "minLightningReserveSats",
]);

const POLICY_FIELDS = Object.freeze([
  "admissionPolicyDigest",
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "feeScheduleDigest",
  "fees",
  "fundingMode",
  "incidentCommanderId",
  "limits",
  "liveness",
  "lossAllocation",
  "preparedAt",
  "privacy",
  "protocolVersion",
  "reviewedBuildCommit",
  "riskPolicyDigest",
  "schema",
  "support",
  "supportOwnerId",
  "upgrades",
  "validUntil",
  "verifyingContract",
]);

const FEE_FIELDS = Object.freeze([
  "baseBitToLightningBps",
  "baseLightningToBitBps",
  "maxFeeBps",
  "reserveFloorBps",
  "scarcityStartsBps",
]);

const LIVENESS_FIELDS = Object.freeze([
  "bondPolicy",
  "establishedSolverMaxBitToLightningSats",
  "lastLookAllowed",
  "maxActiveFirmQuotesPerSolver",
  "maxCapacityAgeSeconds",
  "maxConsecutiveFailures",
  "maxFirmQuoteTtlSeconds",
  "maxGlobalBitToLightningInFlightSats",
  "minimumCompletedFillsForEstablished",
  "minimumReliabilityBps",
  "minimumReliabilitySample",
  "partialFillsAllowed",
  "unknownSolverMaxBitToLightningSats",
]);

const LOSS_FIELDS = Object.freeze([
  "automaticReimbursement",
  "inventoryOwnerBearsCustodyRisk",
  "protocolInsuranceFund",
  "solverBearsLightningDeliveryFailure",
  "solverPaysLightningRoutingFees",
  "unresolvedIncidentAction",
  "userBearsOwnWalletAndNetworkFees",
]);

const PRIVACY_FIELDS = Object.freeze([
  "emailDeliveryEnabled",
  "onchainLinkageDisclosed",
  "preimageLoggingAllowed",
  "pricingRequestRetentionSeconds",
  "rawInvoiceLoggingAllowed",
  "rawTerminalPacketRetentionSeconds",
  "receiptRetentionSeconds",
  "selectedSolverMayLinkBothLegs",
]);

const SUPPORT_FIELDS = Object.freeze([
  "maxIncidentAcknowledgementSeconds",
  "maxUserResponseSeconds",
  "publicIncidentUpdates",
  "securityUri",
  "statusUri",
  "supportUri",
]);

const UPGRADE_FIELDS = Object.freeze([
  "activeLiabilityMigrationAllowed",
  "bitImplementationChangeAction",
  "bitPauseAction",
  "emergencyAuthorityMayIncreaseRisk",
  "treeswapContractChangeAction",
]);

const MODE_MAXIMUMS = Object.freeze({
  "operator-testnet-bootstrap": Object.freeze({
    maxDailyLightningSats: 10_000n,
    maxEpochSats: 5_000n,
    maxInFlightSats: 1_000n,
    maxPriceBandBps: 250n,
    maxRoutingFeeSats: 50n,
    maxSwapSats: 500n,
  }),
  "operator-testnet": Object.freeze({
    maxDailyLightningSats: 100_000n,
    maxEpochSats: 50_000n,
    maxInFlightSats: 10_000n,
    maxPriceBandBps: 500n,
    maxRoutingFeeSats: 100n,
    maxSwapSats: 5_000n,
  }),
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
  if (!BYTES32.test(normalized) || normalized === `0x${"00".repeat(32)}`) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return normalized;
}

function decimal(value, name, { positive = false } = {}) {
  const normalized = String(value ?? "");
  if (!DECIMAL.test(normalized)) throw new TypeError(`${name} must be a canonical uint256 decimal string`);
  const parsed = BigInt(normalized);
  if (parsed > UINT256_MAX || (positive && parsed === 0n)) {
    throw new RangeError(`${name} is outside its permitted range`);
  }
  return normalized;
}

function integer(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(`${name} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function requiredBoolean(value, expected, name) {
  if (value !== expected) throw new Error(`${name} must be ${expected}`);
  return value;
}

function publicHttpsUri(value, name) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    throw new TypeError(`${name} must be an HTTPS URI`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.port || hostname.length === 0 || parsed.href.length > 240
      || !hostname.includes(".") || hostname === "localhost"
      || hostname.endsWith(".localhost") || hostname.endsWith(".local")
      || hostname.endsWith(".internal") || hostname.startsWith("[")
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || parsed.pathname.includes("%")) {
    throw new TypeError(`${name} must be a bounded public HTTPS URI without credentials, query, fragment, or port`);
  }
  return parsed.href;
}

function normalizeLimits(raw, fundingMode) {
  exactKeys(raw, ADOPTION_LIMIT_FIELDS, "adoption limits");
  const limits = Object.freeze(Object.fromEntries(ADOPTION_LIMIT_FIELDS.map((field) => [
    field,
    decimal(raw[field], `limits.${field}`, { positive: true }),
  ])));
  if (BigInt(limits.maxSwapSats) > BigInt(limits.maxEpochSats)) {
    throw new RangeError("maxSwapSats exceeds maxEpochSats");
  }
  if (BigInt(limits.maxInFlightSats) > BigInt(limits.maxEpochSats)) {
    throw new RangeError("maxInFlightSats exceeds maxEpochSats");
  }
  if (BigInt(limits.maxEpochSats) > BigInt(limits.maxDailyLightningSats)) {
    throw new RangeError("maxEpochSats exceeds maxDailyLightningSats");
  }
  for (const [field, maximum] of Object.entries(MODE_MAXIMUMS[fundingMode])) {
    if (BigInt(limits[field]) > maximum) throw new RangeError(`${field} exceeds the ${fundingMode} ceiling`);
  }
  return limits;
}

function normalizeFees(raw) {
  exactKeys(raw, FEE_FIELDS, "adoption fees");
  const fees = Object.freeze(Object.fromEntries(FEE_FIELDS.map((field) => [
    field,
    integer(raw[field], `fees.${field}`, { positive: true }),
  ])));
  if (fees.baseBitToLightningBps <= fees.baseLightningToBitBps) {
    throw new Error("BIT to Lightning base fee must be higher than Lightning to BIT");
  }
  if (fees.maxFeeBps > 500 || fees.baseBitToLightningBps > fees.maxFeeBps
      || fees.baseLightningToBitBps > fees.maxFeeBps) {
    throw new RangeError("adoption fees exceed the reviewed ceiling");
  }
  if (fees.reserveFloorBps >= fees.scarcityStartsBps || fees.scarcityStartsBps > 10_000) {
    throw new RangeError("inventory scarcity thresholds are not safely ordered");
  }
  return fees;
}

function normalizeLiveness(raw, limits) {
  exactKeys(raw, LIVENESS_FIELDS, "adoption liveness");
  if (raw.bondPolicy !== "no-bond-objective-history-only") {
    throw new Error("bondPolicy must avoid subjective slashing");
  }
  const liveness = Object.freeze({
    bondPolicy: raw.bondPolicy,
    lastLookAllowed: requiredBoolean(raw.lastLookAllowed, false, "liveness.lastLookAllowed"),
    partialFillsAllowed: requiredBoolean(raw.partialFillsAllowed, false, "liveness.partialFillsAllowed"),
    maxFirmQuoteTtlSeconds: integer(raw.maxFirmQuoteTtlSeconds, "liveness.maxFirmQuoteTtlSeconds", { positive: true }),
    maxCapacityAgeSeconds: integer(raw.maxCapacityAgeSeconds, "liveness.maxCapacityAgeSeconds", { positive: true }),
    maxActiveFirmQuotesPerSolver: integer(raw.maxActiveFirmQuotesPerSolver, "liveness.maxActiveFirmQuotesPerSolver", { positive: true }),
    maxConsecutiveFailures: integer(raw.maxConsecutiveFailures, "liveness.maxConsecutiveFailures", { positive: true }),
    minimumReliabilitySample: integer(raw.minimumReliabilitySample, "liveness.minimumReliabilitySample", { positive: true }),
    minimumReliabilityBps: integer(raw.minimumReliabilityBps, "liveness.minimumReliabilityBps", { positive: true }),
    minimumCompletedFillsForEstablished: integer(
      raw.minimumCompletedFillsForEstablished,
      "liveness.minimumCompletedFillsForEstablished",
      { positive: true },
    ),
    unknownSolverMaxBitToLightningSats: decimal(
      raw.unknownSolverMaxBitToLightningSats,
      "liveness.unknownSolverMaxBitToLightningSats",
      { positive: true },
    ),
    establishedSolverMaxBitToLightningSats: decimal(
      raw.establishedSolverMaxBitToLightningSats,
      "liveness.establishedSolverMaxBitToLightningSats",
      { positive: true },
    ),
    maxGlobalBitToLightningInFlightSats: decimal(
      raw.maxGlobalBitToLightningInFlightSats,
      "liveness.maxGlobalBitToLightningInFlightSats",
      { positive: true },
    ),
  });
  if (liveness.maxFirmQuoteTtlSeconds > 300 || liveness.maxCapacityAgeSeconds > 300
      || liveness.maxActiveFirmQuotesPerSolver > 5 || liveness.maxConsecutiveFailures > 5) {
    throw new RangeError("solver liveness window or concurrency exceeds the adoption ceiling");
  }
  if (liveness.minimumReliabilitySample < 20 || liveness.minimumReliabilityBps < 9_000
      || liveness.minimumReliabilityBps > 10_000 || liveness.minimumCompletedFillsForEstablished < 20) {
    throw new RangeError("solver promotion or reliability policy is too weak");
  }
  if (BigInt(liveness.unknownSolverMaxBitToLightningSats)
        > BigInt(liveness.establishedSolverMaxBitToLightningSats)
      || BigInt(liveness.establishedSolverMaxBitToLightningSats) > BigInt(limits.maxSwapSats)
      || BigInt(liveness.maxGlobalBitToLightningInFlightSats) > BigInt(limits.maxInFlightSats)) {
    throw new RangeError("solver exposure exceeds the signed release limits");
  }
  return liveness;
}

function normalizePrivacy(raw) {
  exactKeys(raw, PRIVACY_FIELDS, "adoption privacy");
  const privacy = Object.freeze({
    emailDeliveryEnabled: requiredBoolean(raw.emailDeliveryEnabled, false, "privacy.emailDeliveryEnabled"),
    onchainLinkageDisclosed: requiredBoolean(raw.onchainLinkageDisclosed, true, "privacy.onchainLinkageDisclosed"),
    preimageLoggingAllowed: requiredBoolean(raw.preimageLoggingAllowed, false, "privacy.preimageLoggingAllowed"),
    rawInvoiceLoggingAllowed: requiredBoolean(raw.rawInvoiceLoggingAllowed, false, "privacy.rawInvoiceLoggingAllowed"),
    selectedSolverMayLinkBothLegs: requiredBoolean(
      raw.selectedSolverMayLinkBothLegs,
      true,
      "privacy.selectedSolverMayLinkBothLegs",
    ),
    pricingRequestRetentionSeconds: integer(
      raw.pricingRequestRetentionSeconds,
      "privacy.pricingRequestRetentionSeconds",
      { positive: true },
    ),
    rawTerminalPacketRetentionSeconds: integer(
      raw.rawTerminalPacketRetentionSeconds,
      "privacy.rawTerminalPacketRetentionSeconds",
      { positive: true },
    ),
    receiptRetentionSeconds: integer(raw.receiptRetentionSeconds, "privacy.receiptRetentionSeconds", { positive: true }),
  });
  if (privacy.pricingRequestRetentionSeconds > 600 || privacy.rawTerminalPacketRetentionSeconds > 3_600
      || privacy.receiptRetentionSeconds > 2_592_000
      || privacy.pricingRequestRetentionSeconds > privacy.rawTerminalPacketRetentionSeconds
      || privacy.rawTerminalPacketRetentionSeconds > privacy.receiptRetentionSeconds) {
    throw new RangeError("privacy retention exceeds or reverses the public policy ceilings");
  }
  return privacy;
}

function normalizeLossAllocation(raw) {
  exactKeys(raw, LOSS_FIELDS, "adoption loss allocation");
  if (raw.unresolvedIncidentAction !== "halt-and-case-review") {
    throw new Error("unresolvedIncidentAction must halt exposure and require case review");
  }
  return Object.freeze({
    automaticReimbursement: requiredBoolean(raw.automaticReimbursement, false, "lossAllocation.automaticReimbursement"),
    inventoryOwnerBearsCustodyRisk: requiredBoolean(
      raw.inventoryOwnerBearsCustodyRisk,
      true,
      "lossAllocation.inventoryOwnerBearsCustodyRisk",
    ),
    protocolInsuranceFund: requiredBoolean(raw.protocolInsuranceFund, false, "lossAllocation.protocolInsuranceFund"),
    solverBearsLightningDeliveryFailure: requiredBoolean(
      raw.solverBearsLightningDeliveryFailure,
      true,
      "lossAllocation.solverBearsLightningDeliveryFailure",
    ),
    solverPaysLightningRoutingFees: requiredBoolean(
      raw.solverPaysLightningRoutingFees,
      true,
      "lossAllocation.solverPaysLightningRoutingFees",
    ),
    unresolvedIncidentAction: raw.unresolvedIncidentAction,
    userBearsOwnWalletAndNetworkFees: requiredBoolean(
      raw.userBearsOwnWalletAndNetworkFees,
      true,
      "lossAllocation.userBearsOwnWalletAndNetworkFees",
    ),
  });
}

function normalizeSupport(raw) {
  exactKeys(raw, SUPPORT_FIELDS, "adoption support");
  const support = Object.freeze({
    supportUri: publicHttpsUri(raw.supportUri, "support.supportUri"),
    securityUri: publicHttpsUri(raw.securityUri, "support.securityUri"),
    statusUri: publicHttpsUri(raw.statusUri, "support.statusUri"),
    maxIncidentAcknowledgementSeconds: integer(
      raw.maxIncidentAcknowledgementSeconds,
      "support.maxIncidentAcknowledgementSeconds",
      { positive: true },
    ),
    maxUserResponseSeconds: integer(raw.maxUserResponseSeconds, "support.maxUserResponseSeconds", { positive: true }),
    publicIncidentUpdates: requiredBoolean(raw.publicIncidentUpdates, true, "support.publicIncidentUpdates"),
  });
  if (new Set([support.supportUri, support.securityUri, support.statusUri]).size !== 3) {
    throw new Error("support, security, and status paths must be distinct");
  }
  if (support.maxIncidentAcknowledgementSeconds > 900 || support.maxUserResponseSeconds > 172_800) {
    throw new RangeError("support response objective exceeds the adoption ceiling");
  }
  return support;
}

function normalizeUpgrades(raw) {
  exactKeys(raw, UPGRADE_FIELDS, "adoption upgrades");
  if (raw.bitImplementationChangeAction !== "halt-review-new-observation"
      || raw.bitPauseAction !== "halt-until-unpaused-and-reviewed"
      || raw.treeswapContractChangeAction !== "deploy-new-immutable-release") {
    throw new Error("upgrade response is not fail-closed and immutable");
  }
  return Object.freeze({
    activeLiabilityMigrationAllowed: requiredBoolean(
      raw.activeLiabilityMigrationAllowed,
      false,
      "upgrades.activeLiabilityMigrationAllowed",
    ),
    bitImplementationChangeAction: raw.bitImplementationChangeAction,
    bitPauseAction: raw.bitPauseAction,
    emergencyAuthorityMayIncreaseRisk: requiredBoolean(
      raw.emergencyAuthorityMayIncreaseRisk,
      false,
      "upgrades.emergencyAuthorityMayIncreaseRisk",
    ),
    treeswapContractChangeAction: raw.treeswapContractChangeAction,
  });
}

export function normalizeAdoptionPolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "adoption policy");
  if (raw.schema !== "treeswap.adoption-policy.v1") throw new TypeError("adoption policy schema is invalid");
  if (raw.environment !== "public-testnet") throw new TypeError("adoption policy environment must be public-testnet");
  if (!FUNDING_MODES.includes(raw.fundingMode)) throw new TypeError("adoption policy fundingMode is invalid");
  if (!DECIMAL_CHAIN_ID.test(String(raw.chainId ?? ""))) throw new TypeError("adoption policy chainId is invalid");
  let verifyingContract;
  try {
    verifyingContract = getAddress(raw.verifyingContract);
  } catch {
    throw new TypeError("adoption policy verifyingContract is invalid");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("adoption policy build commit is invalid");
  if (!VERSION.test(String(raw.protocolVersion ?? ""))) throw new TypeError("adoption policy protocol version is invalid");
  const preparedAt = integer(raw.preparedAt, "preparedAt", { positive: true });
  const validUntil = integer(raw.validUntil, "validUntil", { positive: true });
  if (validUntil <= preparedAt || validUntil - preparedAt > 7_776_000) {
    throw new RangeError("adoption policy validity must be positive and no longer than ninety days");
  }
  const supportOwnerId = digest(raw.supportOwnerId, "supportOwnerId");
  const incidentCommanderId = digest(raw.incidentCommanderId, "incidentCommanderId");
  if (supportOwnerId === incidentCommanderId) throw new Error("support owner and incident commander must be distinct");
  const limits = normalizeLimits(raw.limits, raw.fundingMode);
  const policy = Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    fundingMode: raw.fundingMode,
    chainId: String(raw.chainId),
    verifyingContract,
    reviewedBuildCommit: raw.reviewedBuildCommit,
    protocolVersion: raw.protocolVersion,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "deploymentManifestDigest"),
    admissionPolicyDigest: digest(raw.admissionPolicyDigest, "admissionPolicyDigest"),
    riskPolicyDigest: digest(raw.riskPolicyDigest, "riskPolicyDigest"),
    feeScheduleDigest: digest(raw.feeScheduleDigest, "feeScheduleDigest"),
    preparedAt,
    validUntil,
    supportOwnerId,
    incidentCommanderId,
    limits,
    fees: normalizeFees(raw.fees),
    liveness: normalizeLiveness(raw.liveness, limits),
    privacy: normalizePrivacy(raw.privacy),
    lossAllocation: normalizeLossAllocation(raw.lossAllocation),
    support: normalizeSupport(raw.support),
    upgrades: normalizeUpgrades(raw.upgrades),
  });
  return policy;
}

export function assertAdoptionPolicyIsPublic(value) {
  const serialized = JSON.stringify(value);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(serialized)
      || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(serialized)) {
    throw new Error("adoption policy contains secret or invoice material");
  }
  return true;
}

export function buildAdoptionPolicyEvidence(raw) {
  const policy = normalizeAdoptionPolicy(raw);
  assertAdoptionPolicyIsPublic(policy);
  const policyDigest = hash(policy);
  return Object.freeze({
    schema: "treeswap.adoption-policy-evidence.v1",
    status: "exact-public-policy-validated",
    scope: "public-policy-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    policyDigest,
    lossAllocationDigest: hash(Object.freeze({
      schema: "treeswap.adoption-loss-allocation.v1",
      policyDigest,
      policy: policy.lossAllocation,
    })),
    privacyRetentionDigest: hash(Object.freeze({
      schema: "treeswap.adoption-privacy-retention.v1",
      policyDigest,
      policy: policy.privacy,
    })),
    supportPolicyDigest: hash(Object.freeze({
      schema: "treeswap.adoption-support-policy.v1",
      policyDigest,
      policy: policy.support,
    })),
    policy,
    authorizations: Object.freeze({ signing: false, broadcast: false, gateOpening: false, funding: false }),
  });
}
