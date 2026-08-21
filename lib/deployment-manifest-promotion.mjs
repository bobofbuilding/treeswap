import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "./bit-deployment-observer.mjs";
import { compareDeploymentObservations } from "./deployment-observer.mjs";
import { validateDeploymentManifest } from "./deployment-policy.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const UINT64_MAX = (1n << 64n) - 1n;

const APPROVER_ROLES = Object.freeze([
  "contract-reviewer",
  "operations-reviewer",
  "provider",
]);

const POLICY_FIELDS = Object.freeze([
  "approvers",
  "chainId",
  "deploymentPolicyDigest",
  "environment",
  "manifestDigest",
  "maximumObservationAgeSeconds",
  "maximumPromotionLifetimeSeconds",
  "minimumProviderCount",
  "reviewedBuildCommit",
  "schema",
  "verifyingContract",
]);

const RECORD_FIELDS = Object.freeze([
  "chainId",
  "deploymentPolicyDigest",
  "environment",
  "finalizedBlockHash",
  "finalizedBlockNumber",
  "manifestDigest",
  "promotedAt",
  "promotionId",
  "providerObservations",
  "reviewArtifacts",
  "reviewedBuildCommit",
  "schema",
  "validUntil",
  "verifyingContract",
]);

const REVIEW_FIELDS = Object.freeze([
  "compilerInputs",
  "findingsDisposition",
  "providerIndependence",
  "rolesAndStorage",
  "sourceBundles",
  "upgradeBehavior",
]);

const OBSERVATION_FIELDS = Object.freeze([
  "chainId",
  "evidenceStatus",
  "finalizedBlock",
  "manifest",
  "manifestDigest",
  "observedAt",
  "providerFinalizedHead",
  "providerIdentity",
  "providerLabel",
  "schema",
  "sourceCommit",
  "stateAnchor",
]);

const DEPLOYMENT_POLICY_FIELDS = Object.freeze([
  "absoluteMaxFeeBps",
  "absoluteMaxPriceDeviationBps",
  "bitImplementationAddress",
  "bitProxyAddress",
  "chainId",
  "codeHashes",
  "independentReviewDigest",
  "maxOpenDurationSeconds",
  "minResumeDelaySeconds",
  "referenceSatsPerBit",
  "reviewedBuildCommit",
]);

const CODE_HASH_FIELDS = Object.freeze([
  "bitImplementation",
  "bitProxy",
  "controller",
  "feeCollector",
  "gate",
  "guardian",
  "paymentHashRegistry",
  "userEscrow",
  "vault",
]);

const MANIFEST_FIELDS = Object.freeze([
  "accounting",
  "bit",
  "chainId",
  "controller",
  "feeCollector",
  "gate",
  "guardian",
  "independentReviewDigest",
  "paymentHashRegistry",
  "reviewedBuildCommit",
  "userEscrow",
  "vault",
]);

const ACCOUNTING_FIELDS = Object.freeze([
  "userEscrowBitBalanceWei",
  "userEscrowTotalLockedWei",
  "vaultAccountedBalanceWei",
  "vaultBitBalanceWei",
  "vaultTotalAvailableWei",
  "vaultTotalLockedWei",
]);

const ROLE_FIELDS = Object.freeze([
  "address",
  "codeHash",
  "isContract",
  "ownerAddresses",
  "owners",
  "threshold",
]);

const GATE_FIELDS = Object.freeze([
  "address",
  "codeHash",
  "controller",
  "defaultClosed",
  "guardian",
  "maxOpenDurationSeconds",
  "resumeDelaySeconds",
]);

const ESCROW_FIELDS = Object.freeze([
  "address",
  "bit",
  "codeHash",
  "epochDurationSeconds",
  "feeCollector",
  "immutable",
  "maxEpochVolumeWei",
  "maxFeeBps",
  "maxLockDurationSeconds",
  "maxPriceDeviationBps",
  "maxSwapAmountWei",
  "minClaimBufferSeconds",
  "minSettlementWindowSeconds",
  "openGate",
  "paymentHashRegistry",
  "proxy",
  "referenceSatsPerBit",
]);

const REGISTRY_FIELDS = Object.freeze([
  "address",
  "approvedEscrows",
  "codeHash",
  "escrowCount",
  "sealed",
]);

const BIT_FIELDS = Object.freeze([
  "decimals",
  "implementationAddress",
  "implementationCodeHash",
  "implementationSlot",
  "implementationSlotMatches",
  "paused",
  "proxyAddress",
  "proxyCodeHash",
  "symbol",
]);

const verifiedPromotions = new WeakSet();

export const DEPLOYMENT_PROMOTION_APPROVAL_TYPES = Object.freeze({
  ManifestPromotionApproval: Object.freeze([
    Object.freeze({ name: "promotionId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "role", type: "string" }),
    Object.freeze({ name: "approverId", type: "bytes32" }),
    Object.freeze({ name: "finalizedBlockNumber", type: "uint64" }),
    Object.freeze({ name: "finalizedBlockHash", type: "bytes32" }),
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

function decimal(value, name, { positive = false } = {}) {
  const normalized = String(value ?? "");
  if (!DECIMAL.test(normalized)) throw new TypeError(`${name} must be a canonical uint64 decimal string`);
  const parsed = BigInt(normalized);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) throw new RangeError(`${name} is outside uint64`);
  return normalized;
}

function canonicalChainId(value, name) {
  const normalized = decimal(value, name, { positive: true });
  if (BigInt(normalized) > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds safe integer`);
  return normalized;
}

function canonicalIso(value, name) {
  const raw = String(value ?? "");
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new TypeError(`${name} must be canonical ISO-8601`);
  }
  return Object.freeze({ raw, seconds: Math.floor(parsed / 1_000) });
}

function requireCanonicalOrder(values, selector, name) {
  const keys = values.map(selector);
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) throw new Error(`${name} are not canonically ordered`);
}

function normalizeReviewArtifacts(raw) {
  exactKeys(raw, REVIEW_FIELDS, "reviewArtifacts");
  return Object.freeze(Object.fromEntries(REVIEW_FIELDS.map((field) => [
    field,
    digest(raw[field], `reviewArtifacts.${field}`),
  ])));
}

function validateExactManifestShape(manifest) {
  exactKeys(manifest, MANIFEST_FIELDS, "deployment manifest");
  exactKeys(manifest.accounting, ACCOUNTING_FIELDS, "deployment manifest accounting");
  for (const role of ["controller", "guardian", "feeCollector"]) {
    exactKeys(manifest[role], ROLE_FIELDS, `deployment manifest ${role}`);
  }
  exactKeys(manifest.gate, GATE_FIELDS, "deployment manifest gate");
  exactKeys(manifest.vault, ESCROW_FIELDS, "deployment manifest vault");
  exactKeys(manifest.userEscrow, ESCROW_FIELDS, "deployment manifest userEscrow");
  exactKeys(manifest.paymentHashRegistry, REGISTRY_FIELDS, "deployment manifest paymentHashRegistry");
  exactKeys(manifest.bit, BIT_FIELDS, "deployment manifest BIT");
  if (manifest.bit.implementationSlot !== EIP1967_IMPLEMENTATION_SLOT) {
    throw new Error("deployment manifest uses the wrong implementation slot");
  }
}

function normalizeDeploymentPolicy(raw) {
  exactKeys(raw, DEPLOYMENT_POLICY_FIELDS, "deployment policy");
  exactKeys(raw.codeHashes, CODE_HASH_FIELDS, "deployment policy codeHashes");
  return Object.freeze(canonical(raw));
}

function normalizeApprover(value, index) {
  exactKeys(value, ["approverId", "role", "signer"], `approvers[${index}]`);
  if (!APPROVER_ROLES.includes(value.role)) throw new TypeError(`approvers[${index}].role is invalid`);
  return Object.freeze({
    role: value.role,
    approverId: digest(value.approverId, `approvers[${index}].approverId`),
    signer: address(value.signer, `approvers[${index}].signer`),
  });
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "deployment-promotion policy");
  if (raw.schema !== "treeswap.deployment-promotion-policy.v1") throw new TypeError("promotion policy schema is invalid");
  if (!["public-testnet", "capped-mainnet-beta"].includes(raw.environment)) {
    throw new TypeError("promotion policy environment is invalid");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("promotion build commit is invalid");
  const minimumProviderCount = safeInteger(raw.minimumProviderCount, "minimumProviderCount", { positive: true });
  const maximumObservationAgeSeconds = safeInteger(
    raw.maximumObservationAgeSeconds,
    "maximumObservationAgeSeconds",
    { positive: true },
  );
  const maximumPromotionLifetimeSeconds = safeInteger(
    raw.maximumPromotionLifetimeSeconds,
    "maximumPromotionLifetimeSeconds",
    { positive: true },
  );
  if (minimumProviderCount < 2 || minimumProviderCount > 5) {
    throw new Error("promotion policy must require two to five providers");
  }
  if (maximumObservationAgeSeconds > 3_600) {
    throw new Error("deployment observations may not be older than one hour at promotion");
  }
  if (maximumPromotionLifetimeSeconds > 86_400) {
    throw new Error("deployment promotion may not remain current longer than one day");
  }
  if (!Array.isArray(raw.approvers) || raw.approvers.length > 7) {
    throw new TypeError("promotion approvers must be a bounded array");
  }
  const approvers = raw.approvers.map(normalizeApprover);
  requireCanonicalOrder(approvers, (value) => `${value.role}:${value.approverId}`, "promotion approvers");
  const keys = new Set();
  const signers = new Set();
  const roleCounts = new Map(APPROVER_ROLES.map((role) => [role, 0]));
  for (const approver of approvers) {
    const key = `${approver.role}:${approver.approverId}`;
    if (keys.has(key)) throw new Error("promotion approver is duplicated");
    keys.add(key);
    const signer = approver.signer.toLowerCase();
    if (signers.has(signer)) throw new Error("promotion approver signers must be globally distinct");
    signers.add(signer);
    roleCounts.set(approver.role, roleCounts.get(approver.role) + 1);
  }
  if (roleCounts.get("provider") < minimumProviderCount || roleCounts.get("provider") > 5) {
    throw new Error("promotion provider approver count is outside policy");
  }
  if (roleCounts.get("contract-reviewer") !== 1 || roleCounts.get("operations-reviewer") !== 1) {
    throw new Error("promotion requires exactly one contract and one operations reviewer");
  }
  return Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    chainId: canonicalChainId(raw.chainId, "policy.chainId"),
    verifyingContract: address(raw.verifyingContract, "policy.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    deploymentPolicyDigest: digest(raw.deploymentPolicyDigest, "policy.deploymentPolicyDigest"),
    manifestDigest: digest(raw.manifestDigest, "policy.manifestDigest"),
    minimumProviderCount,
    maximumObservationAgeSeconds,
    maximumPromotionLifetimeSeconds,
    approvers: Object.freeze(approvers),
  });
}

function normalizeProviderObservationReference(value, index) {
  exactKeys(value, ["observationDigest", "providerIdentity"], `providerObservations[${index}]`);
  return Object.freeze({
    providerIdentity: digest(value.providerIdentity, `providerObservations[${index}].providerIdentity`),
    observationDigest: digest(value.observationDigest, `providerObservations[${index}].observationDigest`),
  });
}

function normalizeRecord(raw, policy) {
  exactKeys(raw, RECORD_FIELDS, "deployment-promotion record");
  if (raw.schema !== "treeswap.deployment-promotion-record.v1") throw new TypeError("promotion record schema is invalid");
  if (raw.environment !== policy.environment) throw new Error("promotion environment does not match policy");
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("promotion build commit is invalid");
  const promotedAt = timestamp(raw.promotedAt, "promotedAt");
  const validUntil = timestamp(raw.validUntil, "validUntil");
  if (validUntil <= promotedAt || validUntil - promotedAt > policy.maximumPromotionLifetimeSeconds) {
    throw new RangeError("promotion validity is reversed or exceeds policy");
  }
  if (!Array.isArray(raw.providerObservations) || raw.providerObservations.length > 5) {
    throw new TypeError("providerObservations must be a bounded array");
  }
  const providerObservations = raw.providerObservations.map(normalizeProviderObservationReference);
  requireCanonicalOrder(providerObservations, (value) => value.providerIdentity, "provider observations");
  if (providerObservations.length < policy.minimumProviderCount) {
    throw new Error("provider observation count is below policy");
  }
  if (new Set(providerObservations.map((value) => value.providerIdentity)).size !== providerObservations.length
      || new Set(providerObservations.map((value) => value.observationDigest)).size !== providerObservations.length) {
    throw new Error("provider observations must have distinct identities and digests");
  }
  const reviewArtifacts = normalizeReviewArtifacts(raw.reviewArtifacts);
  const record = Object.freeze({
    schema: raw.schema,
    promotionId: digest(raw.promotionId, "promotionId"),
    environment: raw.environment,
    chainId: canonicalChainId(raw.chainId, "record.chainId"),
    verifyingContract: address(raw.verifyingContract, "record.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    deploymentPolicyDigest: digest(raw.deploymentPolicyDigest, "record.deploymentPolicyDigest"),
    manifestDigest: digest(raw.manifestDigest, "record.manifestDigest"),
    finalizedBlockNumber: decimal(raw.finalizedBlockNumber, "finalizedBlockNumber", { positive: true }),
    finalizedBlockHash: digest(raw.finalizedBlockHash, "finalizedBlockHash"),
    providerObservations: Object.freeze(providerObservations),
    reviewArtifacts,
    promotedAt,
    validUntil,
  });
  for (const field of [
    "chainId",
    "verifyingContract",
    "reviewedBuildCommit",
    "deploymentPolicyDigest",
    "manifestDigest",
  ]) {
    if (record[field] !== policy[field]) throw new Error(`promotion ${field} does not match policy`);
  }
  const providerApprovers = policy.approvers.filter((value) => value.role === "provider");
  if (providerApprovers.length !== providerObservations.length
      || providerApprovers.some((value, index) => value.approverId !== providerObservations[index].providerIdentity)) {
    throw new Error("provider observations do not exactly match provider approvers");
  }
  return record;
}

function normalizeObservation(raw, index, record, policy) {
  exactKeys(raw, OBSERVATION_FIELDS, `observations[${index}]`);
  if (raw.schema !== "treeswap.deployment-observation.v2"
      || raw.evidenceStatus !== "unreviewed-rpc-observation") {
    throw new TypeError(`observations[${index}] schema or status is invalid`);
  }
  const providerIdentity = digest(raw.providerIdentity, `observations[${index}].providerIdentity`);
  const providerLabel = String(raw.providerLabel ?? "");
  if (providerLabel.length === 0 || providerLabel.length > 80) {
    throw new TypeError(`observations[${index}].providerLabel is invalid`);
  }
  if (!COMMIT.test(String(raw.sourceCommit ?? "")) || raw.sourceCommit !== record.reviewedBuildCommit) {
    throw new Error(`observations[${index}] source commit is invalid`);
  }
  if (safeInteger(raw.chainId, `observations[${index}].chainId`, { positive: true }) !== Number(record.chainId)) {
    throw new Error(`observations[${index}] chain does not match promotion`);
  }
  exactKeys(raw.providerFinalizedHead, ["hash", "number"], `observations[${index}].providerFinalizedHead`);
  exactKeys(raw.finalizedBlock, ["hash", "number"], `observations[${index}].finalizedBlock`);
  exactKeys(raw.stateAnchor, ["blockHash", "requireCanonical"], `observations[${index}].stateAnchor`);
  const finalizedNumber = safeInteger(raw.finalizedBlock.number, `observations[${index}].finalizedBlock.number`);
  const finalizedHash = digest(raw.finalizedBlock.hash, `observations[${index}].finalizedBlock.hash`);
  const headNumber = safeInteger(
    raw.providerFinalizedHead.number,
    `observations[${index}].providerFinalizedHead.number`,
  );
  digest(raw.providerFinalizedHead.hash, `observations[${index}].providerFinalizedHead.hash`);
  if (String(finalizedNumber) !== record.finalizedBlockNumber || finalizedHash !== record.finalizedBlockHash) {
    throw new Error(`observations[${index}] finalized block does not match promotion`);
  }
  if (headNumber < finalizedNumber || raw.stateAnchor.requireCanonical !== true
      || digest(raw.stateAnchor.blockHash, `observations[${index}].stateAnchor.blockHash`) !== finalizedHash) {
    throw new Error(`observations[${index}] is not finalized and canonically anchored`);
  }
  const observedAt = canonicalIso(raw.observedAt, `observations[${index}].observedAt`);
  if (observedAt.seconds > record.promotedAt
      || record.promotedAt - observedAt.seconds > policy.maximumObservationAgeSeconds) {
    throw new Error(`observations[${index}] is future-dated or stale at promotion`);
  }
  validateExactManifestShape(raw.manifest);
  const manifestDigest = digest(raw.manifestDigest, `observations[${index}].manifestDigest`);
  if (hash(raw.manifest) !== manifestDigest || manifestDigest !== record.manifestDigest) {
    throw new Error(`observations[${index}] manifest digest is invalid`);
  }
  return Object.freeze({
    ...raw,
    providerIdentity,
    providerLabel,
    manifestDigest,
  });
}

function normalizeAttestation(value, index) {
  exactKeys(value, ["approverId", "role", "signature", "signer"], `attestations[${index}]`);
  if (!APPROVER_ROLES.includes(value.role)) throw new TypeError(`attestations[${index}].role is invalid`);
  if (!isHexString(value.signature) || ![64, 65].includes((value.signature.length - 2) / 2)) {
    throw new TypeError(`attestations[${index}].signature is invalid`);
  }
  return Object.freeze({
    role: value.role,
    approverId: digest(value.approverId, `attestations[${index}].approverId`),
    signer: address(value.signer, `attestations[${index}].signer`),
    signature: value.signature,
  });
}

export function deploymentPromotionDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Deployment Manifest Promotion",
    version: "1",
    chainId: BigInt(canonicalChainId(chainId, "domain.chainId")),
    verifyingContract: address(verifyingContract, "domain.verifyingContract"),
  });
}

function normalizePromotionInputs({ record, policy, deploymentPolicy, observations }) {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedRecord = normalizeRecord(record, normalizedPolicy);
  const normalizedDeploymentPolicy = normalizeDeploymentPolicy(deploymentPolicy);
  if (hash(normalizedDeploymentPolicy) !== normalizedRecord.deploymentPolicyDigest) {
    throw new Error("deployment policy digest does not match the promotion");
  }
  if (!Array.isArray(observations) || observations.length !== normalizedRecord.providerObservations.length) {
    throw new Error("promotion requires the exact provider observation set");
  }
  const normalizedObservations = observations.map((value, index) => (
    normalizeObservation(value, index, normalizedRecord, normalizedPolicy)
  ));
  requireCanonicalOrder(normalizedObservations, (value) => value.providerIdentity, "deployment observations");
  for (const [index, observation] of normalizedObservations.entries()) {
    const reference = normalizedRecord.providerObservations[index];
    if (observation.providerIdentity !== reference.providerIdentity || hash(observation) !== reference.observationDigest) {
      throw new Error("deployment observation does not match the signed record");
    }
  }
  for (let index = 1; index < normalizedObservations.length; index += 1) {
    const comparison = compareDeploymentObservations(normalizedObservations[0], normalizedObservations[index]);
    if (!comparison.eligible) throw new Error(`deployment observations disagree: ${comparison.reasons.join("; ")}`);
  }
  const manifest = normalizedObservations[0].manifest;
  if (address(manifest.gate.address, "manifest.gate.address") !== normalizedRecord.verifyingContract) {
    throw new Error("promotion verifying contract is not the observed gate");
  }
  const reviewBundleDigest = hash(normalizedRecord.reviewArtifacts);
  if (digest(manifest.independentReviewDigest, "manifest.independentReviewDigest") !== reviewBundleDigest
      || digest(normalizedDeploymentPolicy.independentReviewDigest, "deploymentPolicy.independentReviewDigest")
        !== reviewBundleDigest) {
    throw new Error("independent review bundle is not bound to manifest and deployment policy");
  }
  const policyDecision = validateDeploymentManifest(manifest, normalizedDeploymentPolicy);
  if (!policyDecision.approved) {
    throw new Error(`deployment manifest is not approved by policy: ${policyDecision.reasons.join("; ")}`);
  }
  assertDeploymentPromotionIsSecretFree({
    record: normalizedRecord,
    policy: normalizedPolicy,
    deploymentPolicy: normalizedDeploymentPolicy,
    observations: normalizedObservations,
  });
  return Object.freeze({
    policy: normalizedPolicy,
    record: normalizedRecord,
    deploymentPolicy: normalizedDeploymentPolicy,
    observations: Object.freeze(normalizedObservations),
    manifest,
    reviewBundleDigest,
  });
}

export function buildDeploymentPromotionApprovalMessage({
  record,
  policy,
  deploymentPolicy,
  observations,
  role,
  approverId,
}) {
  const normalized = normalizePromotionInputs({ record, policy, deploymentPolicy, observations });
  if (!APPROVER_ROLES.includes(role)) throw new TypeError("promotion approval role is invalid");
  const normalizedApproverId = digest(approverId, "promotion approverId");
  const approver = normalized.policy.approvers.find((value) => (
    value.role === role && value.approverId === normalizedApproverId
  ));
  if (!approver) throw new Error("promotion approver is not in policy");
  return Object.freeze({
    domain: deploymentPromotionDomain(normalized.record),
    types: DEPLOYMENT_PROMOTION_APPROVAL_TYPES,
    value: Object.freeze({
      promotionId: normalized.record.promotionId,
      recordDigest: hash(normalized.record),
      policyDigest: hash(normalized.policy),
      role,
      approverId: normalizedApproverId,
      finalizedBlockNumber: normalized.record.finalizedBlockNumber,
      finalizedBlockHash: normalized.record.finalizedBlockHash,
    }),
  });
}

export function assertDeploymentPromotionIsSecretFree(value) {
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
        throw new Error("deployment promotion contains secret or unrestricted endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`deployment promotion contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

export function verifyDeploymentManifestPromotion({
  record,
  policy,
  deploymentPolicy,
  observations,
  attestations,
  now = Math.floor(Date.now() / 1_000),
}) {
  const normalized = normalizePromotionInputs({ record, policy, deploymentPolicy, observations });
  const observedAt = timestamp(now, "now");
  if (normalized.record.promotedAt > observedAt) throw new Error("deployment promotion is future-dated");
  if (normalized.record.validUntil < observedAt) throw new Error("deployment promotion is expired");
  if (!Array.isArray(attestations) || attestations.length > 7) {
    throw new TypeError("promotion attestations must be a bounded array");
  }
  const normalizedAttestations = attestations.map(normalizeAttestation);
  requireCanonicalOrder(
    normalizedAttestations,
    (value) => `${value.role}:${value.approverId}`,
    "promotion attestations",
  );
  if (normalizedAttestations.length !== normalized.policy.approvers.length) {
    throw new Error("every promotion approver must attest exactly once");
  }
  const recordDigest = hash(normalized.record);
  const policyDigest = hash(normalized.policy);
  const domain = deploymentPromotionDomain(normalized.record);
  const seen = new Set();
  for (const attestation of normalizedAttestations) {
    const key = `${attestation.role}:${attestation.approverId}`;
    if (seen.has(key)) throw new Error("promotion attestation is duplicated");
    seen.add(key);
    const approver = normalized.policy.approvers.find((value) => (
      value.role === attestation.role && value.approverId === attestation.approverId
    ));
    if (!approver || approver.signer !== attestation.signer) {
      throw new Error("promotion attestation does not match an approver");
    }
    const recovered = verifyTypedData(domain, DEPLOYMENT_PROMOTION_APPROVAL_TYPES, {
      promotionId: normalized.record.promotionId,
      recordDigest,
      policyDigest,
      role: attestation.role,
      approverId: attestation.approverId,
      finalizedBlockNumber: normalized.record.finalizedBlockNumber,
      finalizedBlockHash: normalized.record.finalizedBlockHash,
    }, attestation.signature);
    if (recovered !== approver.signer) throw new Error("promotion attestation signature is invalid");
  }
  assertDeploymentPromotionIsSecretFree({ ...normalized, attestations: normalizedAttestations });
  const result = Object.freeze({
    schema: "treeswap.verified-deployment-manifest-promotion.v1",
    status: "cryptographically-verified-deployment-promotion",
    scope: "candidate-deployment-evidence-no-funding-authorization",
    recordDigest,
    policyDigest,
    record: normalized.record,
    policy: normalized.policy,
    manifest: normalized.manifest,
    reviewBundleDigest: normalized.reviewBundleDigest,
  });
  verifiedPromotions.add(result);
  return result;
}

export function buildDeploymentPromotionReleaseEvidence(verification) {
  if (!verifiedPromotions.has(verification)) throw new Error("deployment promotion provenance is invalid");
  return Object.freeze({
    deploymentManifest: verification.record.manifestDigest,
    providerQuorum: hash(Object.freeze({
      schema: "treeswap.deployment-provider-quorum.v1",
      finalizedBlockNumber: verification.record.finalizedBlockNumber,
      finalizedBlockHash: verification.record.finalizedBlockHash,
      providerObservations: verification.record.providerObservations,
    })),
    findingsDisposition: verification.record.reviewArtifacts.findingsDisposition,
    deploymentPromotion: verification.recordDigest,
    reviewBundle: verification.reviewBundleDigest,
    scope: "candidate-release-evidence-no-funding-authorization",
  });
}

export function buildDeploymentPromotionSummary(verification) {
  if (!verifiedPromotions.has(verification)) throw new Error("deployment promotion provenance is invalid");
  return Object.freeze({
    schema: "treeswap.deployment-promotion-summary.v1",
    promotionDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    sourceCommit: verification.record.reviewedBuildCommit,
    chainId: verification.record.chainId,
    gate: verification.record.verifyingContract,
    manifestDigest: verification.record.manifestDigest,
    finalizedBlockNumber: verification.record.finalizedBlockNumber,
    finalizedBlockHash: verification.record.finalizedBlockHash,
    providerCount: verification.record.providerObservations.length,
    reviewBundleDigest: verification.reviewBundleDigest,
    validUntil: verification.record.validUntil,
    scope: "candidate-deployment-evidence-no-funding-authorization",
  });
}
