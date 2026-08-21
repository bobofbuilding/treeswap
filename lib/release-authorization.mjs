import {
  getAddress,
  Interface,
  isHexString,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
} from "ethers";

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const UINT256_MAX = (1n << 256n) - 1n;

const APPROVAL_ROLES = Object.freeze([
  "controller",
  "guardian",
  "lightningOperator",
  "securityReviewer",
  "incidentCommander",
]);

const EVIDENCE_FIELDS = Object.freeze([
  "admissionPolicy",
  "backupRestore",
  "deploymentManifest",
  "deploymentPostflight",
  "deploymentPromotion",
  "feeSchedule",
  "findingsDisposition",
  "incidentDrills",
  "lossAllocation",
  "monitoring",
  "providerQuorum",
  "publicTestnet",
  "riskPolicy",
  "solverOperations",
  "supportPolicy",
  "testQualification",
]);

const REVIEW_FIELDS = Object.freeze([
  "contracts",
  "coordinator",
  "identityPrivacy",
  "lightning",
  "operations",
]);

const COUNT_FIELDS = Object.freeze([
  "alertChannels",
  "independentEvmProviders",
  "independentLightningObservers",
  "independentRelays",
  "independentSolvers",
  "multisigOwnerCount",
  "multisigThreshold",
]);

const LIMIT_FIELDS = Object.freeze([
  "maxDailyLightningSats",
  "maxEpochSats",
  "maxInFlightSats",
  "maxPriceBandBps",
  "maxRoutingFeeSats",
  "maxSwapSats",
  "minBitReserveWei",
  "minLightningReserveSats",
]);

const FEATURE_FIELDS = Object.freeze([
  "lpShares",
  "makerRewards",
  "partialFills",
  "promisedYield",
  "publicLpDeposits",
  "publicPermissionlessExecution",
  "webSolverFunding",
]);

const ABSOLUTE_FUNDING_COUNT_MINIMUMS = Object.freeze({
  alertChannels: 2,
  independentEvmProviders: 2,
  independentLightningObservers: 2,
  independentRelays: 2,
  independentSolvers: 2,
  multisigOwnerCount: 3,
  multisigThreshold: 2,
});

const POLICY_FIELDS = Object.freeze([
  "admissionPolicyDigest",
  "approvers",
  "chainId",
  "deploymentManifestDigest",
  "deploymentPostflightDigest",
  "deploymentPromotionDigest",
  "environment",
  "feeScheduleDigest",
  "limitPolicy",
  "maximumReleaseLifetimeSeconds",
  "maximumRuntimeObservationAgeSeconds",
  "minimumCounts",
  "reviewedBuildCommit",
  "riskPolicyDigest",
  "schema",
  "verifyingContract",
]);

const RECORD_FIELDS = Object.freeze([
  "approvalBlockHash",
  "approvalBlockNumber",
  "approvalBlockTimestamp",
  "approvalProviderSetDigest",
  "chainId",
  "counts",
  "environment",
  "evidenceDigests",
  "features",
  "fundingMode",
  "limits",
  "priorReleaseDigest",
  "protocolVersion",
  "releaseId",
  "reviewDigests",
  "reviewedBuildCommit",
  "schema",
  "validFrom",
  "validUntil",
  "verifyingContract",
]);

export const RELEASE_APPROVAL_TYPES = Object.freeze({
  ReleaseApproval: Object.freeze([
    Object.freeze({ name: "releaseId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "environment", type: "string" }),
    Object.freeze({ name: "validFrom", type: "uint64" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
  ]),
});

const verifiedAuthorizations = new WeakSet();
const activeCapabilityProfiles = new WeakSet();
const contractSignatureVerifiers = new WeakMap();
const ERC1271_INTERFACE = new Interface([
  "function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)",
]);

function exactKeys(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
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

function digest(value, name, { allowZero = false } = {}) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || (!allowZero && normalized === ZERO_DIGEST)) {
    throw new TypeError(`${name} must be a nonzero bytes32 digest`);
  }
  return normalized;
}

function canonicalAddress(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be a canonical address`);
  }
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

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function count(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new TypeError(`${name} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function normalizeDigestMap(value, fields, name, allowZero = false) {
  exactKeys(value, fields, name);
  return Object.freeze(Object.fromEntries(fields.map((field) => [
    field,
    digest(value[field], `${name}.${field}`, { allowZero }),
  ])));
}

function normalizeCounts(value, name) {
  exactKeys(value, COUNT_FIELDS, name);
  const normalized = Object.fromEntries(COUNT_FIELDS.map((field) => [field, count(value[field], `${name}.${field}`)]));
  if (normalized.multisigThreshold > normalized.multisigOwnerCount) {
    throw new RangeError(`${name}.multisigThreshold exceeds its owner count`);
  }
  return Object.freeze(normalized);
}

function normalizeLimits(value, name) {
  exactKeys(value, LIMIT_FIELDS, name);
  const normalized = Object.fromEntries(LIMIT_FIELDS.map((field) => [
    field,
    decimal(value[field], `${name}.${field}`, { positive: true }),
  ]));
  if (BigInt(normalized.maxPriceBandBps) > 10_000n) throw new RangeError(`${name}.maxPriceBandBps exceeds 100%`);
  if (BigInt(normalized.maxSwapSats) > BigInt(normalized.maxEpochSats)) {
    throw new RangeError(`${name}.maxSwapSats exceeds the epoch cap`);
  }
  if (BigInt(normalized.maxInFlightSats) > BigInt(normalized.maxEpochSats)) {
    throw new RangeError(`${name}.maxInFlightSats exceeds the epoch cap`);
  }
  return Object.freeze(normalized);
}

function normalizeFeatures(value) {
  exactKeys(value, FEATURE_FIELDS, "release features");
  const features = Object.freeze(Object.fromEntries(FEATURE_FIELDS.map((field) => [
    field,
    boolean(value[field], `features.${field}`),
  ])));
  for (const forbidden of ["publicLpDeposits", "lpShares", "promisedYield", "makerRewards", "partialFills"]) {
    if (features[forbidden]) throw new Error(`${forbidden} is outside the reviewed TreeSwap bridge scope`);
  }
  return features;
}

function normalizeFundingMode(value, environment) {
  if (!["closed", "operator-testnet"].includes(value)) {
    throw new TypeError("fundingMode is invalid");
  }
  if (value === "operator-testnet" && environment !== "public-testnet") {
    throw new Error("testnet funding mode requires the public-testnet environment");
  }
  return value;
}

function normalizeRecord(raw) {
  exactKeys(raw, RECORD_FIELDS, "release record");
  if (raw.schema !== "treeswap.release-record.v2") throw new TypeError("release record schema is invalid");
  if (raw.environment !== "public-testnet") {
    throw new TypeError("release v2 supports only the closed public-testnet deployment ceremony");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("reviewed build commit is invalid");
  if (!VERSION.test(String(raw.protocolVersion ?? ""))) throw new TypeError("protocol version is invalid");
  const validFrom = timestamp(raw.validFrom, "validFrom");
  const validUntil = timestamp(raw.validUntil, "validUntil");
  if (validUntil <= validFrom) throw new RangeError("release validity interval is reversed or empty");
  const approvalBlockTimestamp = timestamp(raw.approvalBlockTimestamp, "approvalBlockTimestamp");
  if (approvalBlockTimestamp < validFrom || approvalBlockTimestamp > validUntil) {
    throw new RangeError("approval block timestamp is outside the release validity interval");
  }
  const features = normalizeFeatures(raw.features);
  const fundingMode = normalizeFundingMode(raw.fundingMode, raw.environment);
  if ((fundingMode === "closed") !== (features.webSolverFunding === false)) {
    throw new Error("web solver funding must exactly match whether the release is closed");
  }
  const normalized = Object.freeze({
    schema: raw.schema,
    releaseId: digest(raw.releaseId, "releaseId"),
    protocolVersion: raw.protocolVersion,
    environment: raw.environment,
    fundingMode,
    chainId: decimal(raw.chainId, "chainId", { positive: true }),
    verifyingContract: canonicalAddress(raw.verifyingContract, "verifyingContract"),
    approvalBlockNumber: decimal(raw.approvalBlockNumber, "approvalBlockNumber", { positive: true }),
    approvalBlockHash: digest(raw.approvalBlockHash, "approvalBlockHash"),
    approvalBlockTimestamp,
    approvalProviderSetDigest: digest(raw.approvalProviderSetDigest, "approvalProviderSetDigest"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    priorReleaseDigest: digest(raw.priorReleaseDigest, "priorReleaseDigest", { allowZero: true }),
    evidenceDigests: normalizeDigestMap(raw.evidenceDigests, EVIDENCE_FIELDS, "evidenceDigests", true),
    reviewDigests: normalizeDigestMap(raw.reviewDigests, REVIEW_FIELDS, "reviewDigests", true),
    counts: normalizeCounts(raw.counts, "counts"),
    limits: normalizeLimits(raw.limits, "limits"),
    features,
    validFrom,
    validUntil,
  });
  for (const field of [
    "deploymentManifest",
    "deploymentPostflight",
    "deploymentPromotion",
    "admissionPolicy",
    "riskPolicy",
    "feeSchedule",
    "testQualification",
  ]) {
    if (normalized.evidenceDigests[field] === ZERO_DIGEST) throw new Error(`${field} evidence is required`);
  }
  for (const field of ["providerQuorum", "solverOperations", "monitoring", "backupRestore", "incidentDrills"] ) {
    if (fundingMode !== "closed" && normalized.evidenceDigests[field] === ZERO_DIGEST) {
      throw new Error(`${field} evidence is required before operator funding`);
    }
  }
  if (fundingMode !== "closed") {
    for (const [field, minimum] of Object.entries(ABSOLUTE_FUNDING_COUNT_MINIMUMS)) {
      if (normalized.counts[field] < minimum) throw new Error(`${field} is below the absolute funding minimum`);
    }
  }
  return normalized;
}

function normalizeApproverPolicy(value) {
  exactKeys(value, APPROVAL_ROLES, "release approvers");
  const normalized = {};
  const addresses = new Set();
  for (const role of APPROVAL_ROLES) {
    exactKeys(value[role], ["address", "codeHash", "signatureKind"], `approvers.${role}`);
    const signer = canonicalAddress(value[role].address, `approvers.${role}.address`);
    if (!["eip712", "erc1271"].includes(value[role].signatureKind)) {
      throw new TypeError(`approvers.${role}.signatureKind is invalid`);
    }
    const identity = signer.toLowerCase();
    if (addresses.has(identity)) throw new Error("release approval roles must use distinct signer identities");
    addresses.add(identity);
    const codeHash = digest(value[role].codeHash, `approvers.${role}.codeHash`, { allowZero: true });
    if ((value[role].signatureKind === "erc1271") !== (codeHash !== ZERO_DIGEST)) {
      throw new Error(`approvers.${role}.codeHash must identify only an ERC-1271 contract signer`);
    }
    normalized[role] = Object.freeze({ address: signer, codeHash, signatureKind: value[role].signatureKind });
  }
  return Object.freeze(normalized);
}

function normalizeLimitPolicy(value) {
  exactKeys(value, ["maximums", "minimumReserves"], "limitPolicy");
  exactKeys(value.maximums, [
    "maxDailyLightningSats",
    "maxEpochSats",
    "maxInFlightSats",
    "maxPriceBandBps",
    "maxRoutingFeeSats",
    "maxSwapSats",
  ], "limitPolicy.maximums");
  exactKeys(value.minimumReserves, ["minBitReserveWei", "minLightningReserveSats"], "limitPolicy.minimumReserves");
  return Object.freeze({
    maximums: Object.freeze(Object.fromEntries(Object.entries(value.maximums).map(([field, raw]) => [
      field,
      decimal(raw, `limitPolicy.maximums.${field}`, { positive: true }),
    ]))),
    minimumReserves: Object.freeze(Object.fromEntries(Object.entries(value.minimumReserves).map(([field, raw]) => [
      field,
      decimal(raw, `limitPolicy.minimumReserves.${field}`, { positive: true }),
    ]))),
  });
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "release policy");
  if (raw.schema !== "treeswap.release-policy.v2") throw new TypeError("release policy schema is invalid");
  if (raw.environment !== "public-testnet") {
    throw new TypeError("release policy v2 supports only public testnet");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("policy build commit is invalid");
  const maximumReleaseLifetimeSeconds = count(
    raw.maximumReleaseLifetimeSeconds,
    "maximumReleaseLifetimeSeconds",
    { positive: true },
  );
  const maximumRuntimeObservationAgeSeconds = count(
    raw.maximumRuntimeObservationAgeSeconds,
    "maximumRuntimeObservationAgeSeconds",
    { positive: true },
  );
  if (maximumReleaseLifetimeSeconds > 604_800) throw new RangeError("release lifetime exceeds seven days");
  if (maximumRuntimeObservationAgeSeconds > 300) throw new RangeError("runtime observation age exceeds five minutes");
  const minimumCounts = normalizeCounts(raw.minimumCounts, "minimumCounts");
  for (const [field, minimum] of Object.entries(ABSOLUTE_FUNDING_COUNT_MINIMUMS)) {
    if (minimumCounts[field] < minimum) throw new Error(`${field} policy is below the absolute funding minimum`);
  }
  return Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    chainId: decimal(raw.chainId, "policy.chainId", { positive: true }),
    verifyingContract: canonicalAddress(raw.verifyingContract, "policy.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "policy.deploymentManifestDigest"),
    deploymentPostflightDigest: digest(raw.deploymentPostflightDigest, "policy.deploymentPostflightDigest"),
    deploymentPromotionDigest: digest(raw.deploymentPromotionDigest, "policy.deploymentPromotionDigest"),
    admissionPolicyDigest: digest(raw.admissionPolicyDigest, "policy.admissionPolicyDigest"),
    riskPolicyDigest: digest(raw.riskPolicyDigest, "policy.riskPolicyDigest"),
    feeScheduleDigest: digest(raw.feeScheduleDigest, "policy.feeScheduleDigest"),
    maximumReleaseLifetimeSeconds,
    maximumRuntimeObservationAgeSeconds,
    minimumCounts,
    limitPolicy: normalizeLimitPolicy(raw.limitPolicy),
    approvers: normalizeApproverPolicy(raw.approvers),
  });
}

function validateRecordPolicy(record, policy) {
  const reasons = [];
  if (record.environment !== policy.environment) reasons.push("release environment does not match policy");
  if (record.chainId !== policy.chainId) reasons.push("release chain does not match policy");
  if (record.verifyingContract !== policy.verifyingContract) reasons.push("release gate does not match policy");
  if (record.reviewedBuildCommit !== policy.reviewedBuildCommit) reasons.push("release build does not match policy");
  for (const [recordField, policyField] of [
    ["deploymentManifest", "deploymentManifestDigest"],
    ["deploymentPostflight", "deploymentPostflightDigest"],
    ["deploymentPromotion", "deploymentPromotionDigest"],
    ["admissionPolicy", "admissionPolicyDigest"],
    ["riskPolicy", "riskPolicyDigest"],
    ["feeSchedule", "feeScheduleDigest"],
  ]) {
    if (record.evidenceDigests[recordField] !== policy[policyField]) {
      reasons.push(`${recordField} digest does not match release policy`);
    }
  }
  if (record.validUntil - record.validFrom > policy.maximumReleaseLifetimeSeconds) {
    reasons.push("release validity exceeds policy");
  }
  for (const field of COUNT_FIELDS) {
    if (record.counts[field] < policy.minimumCounts[field]) reasons.push(`${field} is below release policy`);
  }
  for (const [field, maximum] of Object.entries(policy.limitPolicy.maximums)) {
    if (BigInt(record.limits[field]) > BigInt(maximum)) reasons.push(`${field} exceeds release policy`);
  }
  for (const [field, minimum] of Object.entries(policy.limitPolicy.minimumReserves)) {
    if (BigInt(record.limits[field]) < BigInt(minimum)) reasons.push(`${field} is below release policy`);
  }
  return reasons;
}

function releaseDigest(record) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(record)))).toLowerCase();
}

function releasePolicyDigest(policy) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(policy)))).toLowerCase();
}

export function releaseAuthorizationDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Release Authorization",
    version: "2",
    chainId: BigInt(decimal(chainId, "domain.chainId", { positive: true })),
    verifyingContract: canonicalAddress(verifyingContract, "domain.verifyingContract"),
  });
}

function hexQuantity(value, name) {
  if (!HEX_QUANTITY.test(String(value ?? ""))) throw new TypeError(`${name} is not a canonical hex quantity`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe integer range`);
  return Number(parsed);
}

function rpcBlock(value, name) {
  if (!value || !BYTES32.test(String(value.hash ?? "")) || !HEX_QUANTITY.test(String(value.number ?? ""))
      || !HEX_QUANTITY.test(String(value.timestamp ?? ""))) {
    throw new TypeError(`${name} block is malformed`);
  }
  return Object.freeze({
    number: hexQuantity(value.number, `${name} block number`),
    hash: String(value.hash).toLowerCase(),
    timestamp: hexQuantity(value.timestamp, `${name} block timestamp`),
  });
}

async function boundedRpcWork(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("ERC-1271 provider timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function erc1271ProviderSetDigest(providerIdentities) {
  if (!Array.isArray(providerIdentities) || providerIdentities.length < 2 || providerIdentities.length > 8) {
    throw new TypeError("ERC-1271 provider identity set must contain two to eight entries");
  }
  const identities = providerIdentities.map((value, index) => digest(value, `ERC-1271 provider identity ${index}`)).sort();
  if (new Set(identities).size !== identities.length) throw new Error("ERC-1271 provider identities must be distinct");
  return keccak256(toUtf8Bytes(JSON.stringify(identities))).toLowerCase();
}

export function createErc1271QuorumVerifier({
  providers,
  chainId,
  anchor,
  expectedContracts,
  timeoutMs = 10_000,
}) {
  const normalizedChainId = decimal(chainId, "ERC-1271 verifier chainId", { positive: true });
  exactKeys(anchor, ["hash", "number", "timestamp"], "ERC-1271 verifier anchor");
  const anchorNumber = count(anchor.number, "ERC-1271 verifier anchor.number");
  const anchorHash = digest(anchor.hash, "ERC-1271 verifier anchor.hash");
  const anchorTimestamp = timestamp(anchor.timestamp, "ERC-1271 verifier anchor.timestamp");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new RangeError("ERC-1271 verifier timeout is outside policy");
  }
  if (!Array.isArray(providers) || providers.length < 2 || providers.length > 8) {
    throw new TypeError("ERC-1271 verification requires two to eight providers");
  }
  const providerIdentities = new Set();
  const normalizedProviders = providers.map((provider, index) => {
    exactKeys(provider, ["identity", "rpcCall"], `ERC-1271 provider ${index}`);
    const identity = digest(provider.identity, `ERC-1271 provider ${index} identity`);
    if (providerIdentities.has(identity)) throw new Error("ERC-1271 providers must have distinct identities");
    if (typeof provider.rpcCall !== "function") throw new TypeError(`ERC-1271 provider ${index} rpcCall is required`);
    providerIdentities.add(identity);
    return Object.freeze({ identity, rpcCall: provider.rpcCall });
  });
  const providerSetDigest = erc1271ProviderSetDigest([...providerIdentities]);
  if (!Array.isArray(expectedContracts) || expectedContracts.length < 1 || expectedContracts.length > APPROVAL_ROLES.length) {
    throw new TypeError("ERC-1271 expected contracts are required");
  }
  const contracts = new Map();
  for (const [index, value] of expectedContracts.entries()) {
    exactKeys(value, ["address", "codeHash"], `ERC-1271 expected contract ${index}`);
    const address = canonicalAddress(value.address, `ERC-1271 expected contract ${index}.address`);
    const identity = address.toLowerCase();
    if (contracts.has(identity)) throw new Error("ERC-1271 expected contracts contain a duplicate");
    contracts.set(identity, digest(value.codeHash, `ERC-1271 expected contract ${index}.codeHash`));
  }
  const blockTag = `0x${anchorNumber.toString(16)}`;
  const stateAnchor = Object.freeze({ blockHash: anchorHash, requireCanonical: true });

  const verifier = async ({ signer, digest: signedDigest, signature }) => {
    const target = canonicalAddress(signer, "ERC-1271 signer");
    const expectedCodeHash = contracts.get(target.toLowerCase());
    if (!expectedCodeHash) throw new Error("ERC-1271 signer is not in the reviewed verifier set");
    const approvalDigest = digest(signedDigest, "ERC-1271 approval digest");
    if (!HEX.test(String(signature ?? "")) || String(signature).length > 16_386) {
      throw new TypeError("ERC-1271 signature is malformed or oversized");
    }
    const callData = ERC1271_INTERFACE.encodeFunctionData("isValidSignature", [approvalDigest, signature]);
    await Promise.all(normalizedProviders.map((provider) => boundedRpcWork(async () => {
      const rpcChainId = await provider.rpcCall("eth_chainId", []);
      if (BigInt(rpcChainId) !== BigInt(normalizedChainId)) throw new Error("ERC-1271 provider returned the wrong chain");
      const [targetBlockRaw, finalizedBlockRaw] = await Promise.all([
        provider.rpcCall("eth_getBlockByNumber", [blockTag, false]),
        provider.rpcCall("eth_getBlockByNumber", ["finalized", false]),
      ]);
      const targetBlock = rpcBlock(targetBlockRaw, "ERC-1271 target");
      const finalizedBlock = rpcBlock(finalizedBlockRaw, "ERC-1271 finalized");
      if (targetBlock.number !== anchorNumber || targetBlock.hash !== anchorHash) {
        throw new Error("ERC-1271 provider disagrees with the canonical anchor");
      }
      if (targetBlock.timestamp !== anchorTimestamp || finalizedBlock.number < anchorNumber) {
        throw new Error("ERC-1271 approval anchor is not finalized or has a different timestamp");
      }
      const [code, response] = await Promise.all([
        provider.rpcCall("eth_getCode", [target, stateAnchor]),
        provider.rpcCall("eth_call", [{ to: target, data: callData }, stateAnchor]),
      ]);
      if (!isHexString(code) || code === "0x" || keccak256(code).toLowerCase() !== expectedCodeHash) {
        throw new Error("ERC-1271 signer code does not match the reviewed release policy");
      }
      let magic;
      try {
        magic = ERC1271_INTERFACE.decodeFunctionResult("isValidSignature", response)[0];
      } catch {
        throw new Error("ERC-1271 signer returned malformed data");
      }
      if (String(magic).toLowerCase() !== ERC1271_MAGIC_VALUE) throw new Error("ERC-1271 signature is invalid");
    }, timeoutMs)));
    return ERC1271_MAGIC_VALUE;
  };
  contractSignatureVerifiers.set(verifier, Object.freeze({
    chainId: normalizedChainId,
    anchor: Object.freeze({ number: anchorNumber, hash: anchorHash, timestamp: anchorTimestamp }),
    providerSetDigest,
    providerCount: normalizedProviders.length,
    contracts,
  }));
  return verifier;
}

export function buildReleaseApprovalMessage(recordInput, policyInput) {
  const record = normalizeRecord(recordInput);
  const policy = normalizePolicy(policyInput);
  const reasons = validateRecordPolicy(record, policy);
  if (reasons.length > 0) throw new Error(`release record does not satisfy policy: ${reasons.join("; ")}`);
  return Object.freeze({
    releaseId: record.releaseId,
    recordDigest: releaseDigest(record),
    policyDigest: releasePolicyDigest(policy),
    environment: record.environment,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
  });
}

export function releaseRecordDigest(recordInput) {
  return releaseDigest(normalizeRecord(recordInput));
}

function normalizeApproval(raw) {
  exactKeys(raw, ["role", "signature", "signatureKind", "signer"], "release approval");
  if (!APPROVAL_ROLES.includes(raw.role)) throw new TypeError("release approval role is invalid");
  if (!["eip712", "erc1271"].includes(raw.signatureKind)) throw new TypeError("release signature kind is invalid");
  if (!HEX.test(String(raw.signature ?? "")) || String(raw.signature).length > 16_386) {
    throw new TypeError("release signature is malformed or oversized");
  }
  if (raw.signatureKind === "eip712" && String(raw.signature).length !== 132) {
    throw new TypeError("EIP-712 release signature must be 65 bytes");
  }
  return Object.freeze({
    role: raw.role,
    signer: canonicalAddress(raw.signer, "release approval signer"),
    signatureKind: raw.signatureKind,
    signature: raw.signature,
  });
}

export async function verifyReleaseAuthorization({
  record: recordInput,
  approvals: approvalInputs,
  policy: policyInput,
  verifyContractSignature,
  now = Math.floor(Date.now() / 1_000),
}) {
  const reasons = [];
  let record;
  let policy;
  try {
    record = normalizeRecord(recordInput);
    policy = normalizePolicy(policyInput);
    reasons.push(...validateRecordPolicy(record, policy));
  } catch (error) {
    return Object.freeze({ valid: false, reasons: Object.freeze([String(error?.message ?? "release input is invalid")]) });
  }
  if (!Number.isSafeInteger(now) || now <= 0) reasons.push("release verification time is invalid");
  else if (now > record.validUntil) reasons.push("release authorization is expired");

  const message = Object.freeze({
    releaseId: record.releaseId,
    recordDigest: releaseDigest(record),
    policyDigest: releasePolicyDigest(policy),
    environment: record.environment,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
  });
  const domain = releaseAuthorizationDomain(record);
  const typedDigest = TypedDataEncoder.hash(domain, RELEASE_APPROVAL_TYPES, message).toLowerCase();
  const contractVerifierBinding = contractSignatureVerifiers.get(verifyContractSignature);
  const approvals = new Map();
  if (!Array.isArray(approvalInputs)) {
    reasons.push("release approvals are missing");
  } else {
    for (const raw of approvalInputs) {
      try {
        const approval = normalizeApproval(raw);
        if (approvals.has(approval.role)) {
          reasons.push(`duplicate ${approval.role} approval`);
          continue;
        }
        approvals.set(approval.role, approval);
      } catch (error) {
        reasons.push(String(error?.message ?? "release approval is invalid"));
      }
    }
  }

  for (const role of APPROVAL_ROLES) {
    const expected = policy.approvers[role];
    const approval = approvals.get(role);
    if (!approval) {
      reasons.push(`${role} approval is missing`);
      continue;
    }
    if (approval.signer !== expected.address || approval.signatureKind !== expected.signatureKind) {
      reasons.push(`${role} approval identity does not match policy`);
      continue;
    }
    if (approval.signatureKind === "eip712") {
      try {
        const recovered = getAddress(verifyTypedData(domain, RELEASE_APPROVAL_TYPES, message, approval.signature));
        if (recovered !== expected.address) reasons.push(`${role} EIP-712 signature is invalid`);
      } catch {
        reasons.push(`${role} EIP-712 signature is invalid`);
      }
    } else {
      if (!contractVerifierBinding
          || contractVerifierBinding.chainId !== record.chainId
          || String(contractVerifierBinding.anchor.number) !== record.approvalBlockNumber
          || contractVerifierBinding.anchor.hash !== record.approvalBlockHash
          || contractVerifierBinding.anchor.timestamp !== record.approvalBlockTimestamp
          || contractVerifierBinding.providerSetDigest !== record.approvalProviderSetDigest
          || contractVerifierBinding.providerCount !== record.counts.independentEvmProviders
          || contractVerifierBinding.contracts.get(expected.address.toLowerCase()) !== expected.codeHash) {
        reasons.push(`${role} ERC-1271 quorum verifier does not match release policy`);
        continue;
      }
      try {
        const magic = await verifyContractSignature(Object.freeze({
          role,
          signer: expected.address,
          digest: typedDigest,
          signature: approval.signature,
        }));
        if (String(magic).toLowerCase() !== ERC1271_MAGIC_VALUE) reasons.push(`${role} ERC-1271 signature is invalid`);
      } catch {
        reasons.push(`${role} ERC-1271 signature is invalid`);
      }
    }
  }

  if (reasons.length > 0) return Object.freeze({ valid: false, reasons: Object.freeze(reasons) });
  const result = Object.freeze({
    valid: true,
    reasons: Object.freeze([]),
    record,
    recordDigest: message.recordDigest,
    policyDigest: message.policyDigest,
    typedDigest,
    policy: Object.freeze({
      maximumRuntimeObservationAgeSeconds: policy.maximumRuntimeObservationAgeSeconds,
    }),
  });
  verifiedAuthorizations.add(result);
  return result;
}

export function verifiedReleaseAuthorizationBinding(verification) {
  if (!verifiedAuthorizations.has(verification)) {
    throw new TypeError("release authorization was not verified by this process");
  }
  return Object.freeze({
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    releaseId: verification.record.releaseId,
    environment: verification.record.environment,
    fundingMode: verification.record.fundingMode,
    deploymentManifestDigest: verification.record.evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: verification.record.evidenceDigests.deploymentPostflight,
    deploymentPromotionDigest: verification.record.evidenceDigests.deploymentPromotion,
    validFrom: verification.record.validFrom,
    validUntil: verification.record.validUntil,
    maximumRuntimeObservationAgeSeconds: verification.policy.maximumRuntimeObservationAgeSeconds,
    features: verification.record.features,
  });
}

export function activateReleaseCapabilities({ verification, now = Math.floor(Date.now() / 1_000) }) {
  const binding = verifiedReleaseAuthorizationBinding(verification);
  if (!Number.isSafeInteger(now) || now < binding.validFrom || now > binding.validUntil) {
    throw new Error("release authorization is not active");
  }
  if (binding.fundingMode === "closed" || binding.features.webSolverFunding !== true) {
    throw new Error("release authorization does not enable operator funding");
  }
  const profile = Object.freeze({
    ...binding.features,
    openCryptographicSolverAdmission: true,
    publicOrderBook: false,
    solverInventoryPlanner: true,
    releaseId: binding.releaseId,
    releaseRecordDigest: binding.recordDigest,
    releasePolicyDigest: binding.policyDigest,
    deploymentManifestDigest: binding.deploymentManifestDigest,
    deploymentPostflightDigest: binding.deploymentPostflightDigest,
    deploymentPromotionDigest: binding.deploymentPromotionDigest,
    environment: binding.environment,
    fundingMode: binding.fundingMode,
    validFrom: binding.validFrom,
    validUntil: binding.validUntil,
    maximumRuntimeObservationAgeSeconds: binding.maximumRuntimeObservationAgeSeconds,
  });
  activeCapabilityProfiles.add(profile);
  return profile;
}

export function verifiedReleaseCapabilityBinding(profile) {
  if (!activeCapabilityProfiles.has(profile)) {
    throw new TypeError("capability profile is not backed by a verified release authorization");
  }
  return Object.freeze({
    releaseId: profile.releaseId,
    releaseRecordDigest: profile.releaseRecordDigest,
    releasePolicyDigest: profile.releasePolicyDigest,
    deploymentManifestDigest: profile.deploymentManifestDigest,
    deploymentPostflightDigest: profile.deploymentPostflightDigest,
    deploymentPromotionDigest: profile.deploymentPromotionDigest,
    environment: profile.environment,
    fundingMode: profile.fundingMode,
    validFrom: profile.validFrom,
    validUntil: profile.validUntil,
    maximumRuntimeObservationAgeSeconds: profile.maximumRuntimeObservationAgeSeconds,
  });
}
