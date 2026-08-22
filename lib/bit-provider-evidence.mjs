import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import {
  BIT_DEPLOYMENT_COMPARISON_SCHEMA,
  BIT_MAINNET_CONTRACT,
  BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS,
  bitDeploymentComparisonValueDigest,
  bitDeploymentObservationValueDigest,
  buildBitDeploymentComparisonReport,
  normalizeBitDeploymentComparisonReport,
  normalizeBitDeploymentObservation,
} from "./bit-deployment-observer.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const MAXIMUM_PROVIDER_EVIDENCE_LIFETIME_SECONDS = 3_600;

const CANDIDATE_FIELDS = Object.freeze([
  "comparison",
  "observations",
  "policy",
  "record",
  "schema",
]);

const POLICY_FIELDS = Object.freeze([
  "chainId",
  "maximumEvidenceLifetimeSeconds",
  "providerApprovers",
  "schema",
  "sourceCommit",
  "verifyingContract",
]);

const PROVIDER_APPROVER_FIELDS = Object.freeze([
  "identityEvidenceDigest",
  "organizationId",
  "providerIdentity",
  "serviceEvidenceDigest",
  "signer",
]);

const RECORD_FIELDS = Object.freeze([
  "chainId",
  "comparisonDigest",
  "evidenceStatus",
  "finalizedBlockHash",
  "finalizedBlockNumber",
  "fundingAuthorization",
  "independenceStatus",
  "preparedAt",
  "providerObservations",
  "schema",
  "sourceCommit",
  "validUntil",
  "verifyingContract",
]);

const PROVIDER_OBSERVATION_FIELDS = Object.freeze([
  "observationDigest",
  "providerIdentity",
]);

const ATTESTATION_FIELDS = Object.freeze([
  "providerIdentity",
  "signature",
  "signer",
]);

const verifiedProviderEvidence = new WeakSet();

export const BIT_PROVIDER_EVIDENCE_APPROVAL_TYPES = Object.freeze({
  BitProviderEvidenceApproval: Object.freeze([
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "comparisonDigest", type: "bytes32" }),
    Object.freeze({ name: "providerIdentity", type: "bytes32" }),
    Object.freeze({ name: "observationDigest", type: "bytes32" }),
    Object.freeze({ name: "finalizedBlockNumber", type: "uint64" }),
    Object.freeze({ name: "finalizedBlockHash", type: "bytes32" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
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

function valueDigest(value) {
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

function sourceCommit(value, name) {
  const normalized = String(value ?? "");
  if (!COMMIT.test(normalized)) throw new TypeError(`${name} must be a full lowercase commit`);
  return normalized;
}

function safeInteger(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(`${name} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function requireStrictOrder(values, selector, name) {
  for (let index = 1; index < values.length; index += 1) {
    if (selector(values[index - 1]).localeCompare(selector(values[index])) >= 0) {
      throw new Error(`${name} must be strictly canonically ordered`);
    }
  }
}

function requireDistinct(values, selector, name) {
  if (new Set(values.map(selector)).size !== values.length) throw new Error(`${name} must be distinct`);
}

function normalizeProviderApprover(raw, index) {
  exactKeys(raw, PROVIDER_APPROVER_FIELDS, `providerApprovers[${index}]`);
  const normalized = Object.freeze({
    providerIdentity: digest(raw.providerIdentity, `providerApprovers[${index}].providerIdentity`),
    organizationId: digest(raw.organizationId, `providerApprovers[${index}].organizationId`),
    signer: address(raw.signer, `providerApprovers[${index}].signer`),
    identityEvidenceDigest: digest(
      raw.identityEvidenceDigest,
      `providerApprovers[${index}].identityEvidenceDigest`,
    ),
    serviceEvidenceDigest: digest(
      raw.serviceEvidenceDigest,
      `providerApprovers[${index}].serviceEvidenceDigest`,
    ),
  });
  if (normalized.signer.toLowerCase() === ZERO_ADDRESS) {
    throw new TypeError(`providerApprovers[${index}].signer must be nonzero`);
  }
  return normalized;
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "BIT provider evidence policy");
  if (raw.schema !== "treeswap.bit-provider-evidence-policy.v1") {
    throw new TypeError("BIT provider evidence policy schema is invalid");
  }
  const chainId = safeInteger(raw.chainId, "policy.chainId", { positive: true });
  if (chainId !== 1) throw new Error("BIT provider evidence policy must use Ethereum mainnet");
  const verifyingContract = address(raw.verifyingContract, "policy.verifyingContract");
  if (verifyingContract !== BIT_MAINNET_CONTRACT) {
    throw new Error("BIT provider evidence policy uses the wrong verifying contract");
  }
  const maximumEvidenceLifetimeSeconds = safeInteger(
    raw.maximumEvidenceLifetimeSeconds,
    "policy.maximumEvidenceLifetimeSeconds",
    { positive: true },
  );
  if (maximumEvidenceLifetimeSeconds > MAXIMUM_PROVIDER_EVIDENCE_LIFETIME_SECONDS) {
    throw new RangeError("BIT provider evidence lifetime may not exceed one hour");
  }
  if (!Array.isArray(raw.providerApprovers) || raw.providerApprovers.length !== 2) {
    throw new TypeError("BIT provider evidence policy requires exactly two provider approvers");
  }
  const providerApprovers = raw.providerApprovers.map(normalizeProviderApprover);
  requireStrictOrder(providerApprovers, (value) => value.providerIdentity, "provider approvers");
  requireDistinct(providerApprovers, (value) => value.signer.toLowerCase(), "provider approver signers");
  requireDistinct(providerApprovers, (value) => value.organizationId, "provider organization commitments");
  requireDistinct(providerApprovers, (value) => value.identityEvidenceDigest, "provider identity evidence");
  requireDistinct(providerApprovers, (value) => value.serviceEvidenceDigest, "provider service evidence");
  const allCommitments = providerApprovers.flatMap((value) => [
    value.providerIdentity,
    value.organizationId,
    value.identityEvidenceDigest,
    value.serviceEvidenceDigest,
  ]);
  if (new Set(allCommitments).size !== allCommitments.length) {
    throw new Error("provider identity and evidence commitments must be globally distinct");
  }
  return Object.freeze({
    schema: raw.schema,
    chainId,
    verifyingContract,
    sourceCommit: sourceCommit(raw.sourceCommit, "policy.sourceCommit"),
    maximumEvidenceLifetimeSeconds,
    providerApprovers: Object.freeze(providerApprovers),
  });
}

function normalizeProviderObservation(raw, index) {
  exactKeys(raw, PROVIDER_OBSERVATION_FIELDS, `providerObservations[${index}]`);
  return Object.freeze({
    providerIdentity: digest(raw.providerIdentity, `providerObservations[${index}].providerIdentity`),
    observationDigest: digest(raw.observationDigest, `providerObservations[${index}].observationDigest`),
  });
}

function normalizeRecord(raw, policy) {
  exactKeys(raw, RECORD_FIELDS, "BIT provider evidence record");
  if (raw.schema !== "treeswap.bit-provider-evidence-record.v1") {
    throw new TypeError("BIT provider evidence record schema is invalid");
  }
  if (raw.evidenceStatus !== "provider-signed-comparison-candidate") {
    throw new TypeError("BIT provider evidence status is invalid");
  }
  if (raw.independenceStatus !== "requires-external-organizational-verification") {
    throw new TypeError("BIT provider independence status is invalid");
  }
  if (raw.fundingAuthorization !== false) throw new Error("BIT provider evidence may not authorize funding");
  const preparedAt = safeInteger(raw.preparedAt, "record.preparedAt", { positive: true });
  const validUntil = safeInteger(raw.validUntil, "record.validUntil", { positive: true });
  if (validUntil <= preparedAt || validUntil - preparedAt > policy.maximumEvidenceLifetimeSeconds) {
    throw new Error("BIT provider evidence validity is reversed or exceeds policy");
  }
  const chainId = safeInteger(raw.chainId, "record.chainId", { positive: true });
  const verifyingContract = address(raw.verifyingContract, "record.verifyingContract");
  const commit = sourceCommit(raw.sourceCommit, "record.sourceCommit");
  if (chainId !== policy.chainId || verifyingContract !== policy.verifyingContract
      || commit !== policy.sourceCommit) {
    throw new Error("BIT provider evidence record does not match policy");
  }
  if (!Array.isArray(raw.providerObservations) || raw.providerObservations.length !== 2) {
    throw new TypeError("BIT provider evidence record requires exactly two provider observations");
  }
  const providerObservations = raw.providerObservations.map(normalizeProviderObservation);
  requireStrictOrder(providerObservations, (value) => value.providerIdentity, "provider observations");
  requireDistinct(providerObservations, (value) => value.observationDigest, "provider observation digests");
  return Object.freeze({
    schema: raw.schema,
    evidenceStatus: raw.evidenceStatus,
    chainId,
    verifyingContract,
    sourceCommit: commit,
    comparisonDigest: digest(raw.comparisonDigest, "record.comparisonDigest"),
    finalizedBlockNumber: safeInteger(
      raw.finalizedBlockNumber,
      "record.finalizedBlockNumber",
      { positive: true },
    ),
    finalizedBlockHash: digest(raw.finalizedBlockHash, "record.finalizedBlockHash"),
    providerObservations: Object.freeze(providerObservations),
    preparedAt,
    validUntil,
    independenceStatus: raw.independenceStatus,
    fundingAuthorization: false,
  });
}

function assertCandidateIsSecretFree(value) {
  const forbiddenKey = /(?:url|endpoint|authorization|api.?key|secret|credential|cookie|signature|private.?key)/i;
  const visit = (current) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      if (key !== "fundingAuthorization" && forbiddenKey.test(key)) {
        throw new Error(`BIT provider evidence contains forbidden field ${key}`);
      }
      if (typeof nested === "string"
          && /(?:https?|wss?):\/\/|bearer\s+|api[_-]?key|private[_-]?key/i.test(nested)) {
        throw new Error("BIT provider evidence contains secret or endpoint material");
      }
      visit(nested);
    }
  };
  visit(value);
}

export function normalizeBitProviderEvidenceCandidate(raw) {
  exactKeys(raw, CANDIDATE_FIELDS, "BIT provider evidence candidate");
  if (raw.schema !== "treeswap.bit-provider-evidence-candidate.v1") {
    throw new TypeError("BIT provider evidence candidate schema is invalid");
  }
  const policy = normalizePolicy(raw.policy);
  if (!Array.isArray(raw.observations) || raw.observations.length !== 2) {
    throw new TypeError("BIT provider evidence candidate requires exactly two observations");
  }
  const observations = raw.observations.map((value, index) => (
    normalizeBitDeploymentObservation(value, `candidate.observations[${index}]`)
  ));
  const comparison = normalizeBitDeploymentComparisonReport(raw.comparison);
  const reconstructed = buildBitDeploymentComparisonReport(observations[0], observations[1], {
    comparedAt: comparison.comparedAt,
  });
  if (JSON.stringify(canonical(reconstructed)) !== JSON.stringify(canonical(comparison))) {
    throw new Error("BIT provider comparison does not match the exact observations");
  }
  if (!comparison.eligible || comparison.schema !== BIT_DEPLOYMENT_COMPARISON_SCHEMA) {
    throw new Error("BIT provider evidence requires an eligible comparison");
  }
  const record = normalizeRecord(raw.record, policy);
  const comparedAtMs = Date.parse(comparison.comparedAt);
  if (Math.floor(comparedAtMs / 1_000) !== record.preparedAt) {
    throw new Error("BIT provider evidence preparation time does not match the comparison");
  }
  if (comparison.sourceCommit !== record.sourceCommit
      || comparison.finalizedBlock.number !== record.finalizedBlockNumber
      || comparison.finalizedBlock.hash !== record.finalizedBlockHash
      || bitDeploymentComparisonValueDigest(comparison) !== record.comparisonDigest) {
    throw new Error("BIT provider comparison does not match the signed record");
  }
  const observationReferences = observations
    .map((value) => ({
      providerIdentity: value.providerIdentity,
      observationDigest: bitDeploymentObservationValueDigest(value),
    }))
    .sort((left, right) => left.providerIdentity.localeCompare(right.providerIdentity));
  if (JSON.stringify(observationReferences) !== JSON.stringify(record.providerObservations)) {
    throw new Error("BIT provider observations do not match the signed record");
  }
  const policyProviders = policy.providerApprovers.map((value) => value.providerIdentity);
  const recordProviders = record.providerObservations.map((value) => value.providerIdentity);
  if (JSON.stringify(policyProviders) !== JSON.stringify(recordProviders)) {
    throw new Error("BIT provider approvers do not match the observation set");
  }
  assertCandidateIsSecretFree({ policy, record, comparison, observations });
  const normalized = Object.freeze({
    schema: raw.schema,
    policy,
    record,
    comparison,
    observations: Object.freeze(observations),
  });
  if (JSON.stringify(canonical(normalized)) !== JSON.stringify(canonical(raw))) {
    throw new Error("BIT provider evidence candidate is not canonical");
  }
  return normalized;
}

export function prepareBitProviderEvidenceCandidate({
  observations,
  policy,
  preparedAt = new Date(),
} = {}) {
  const normalizedPolicy = normalizePolicy(policy);
  if (!Array.isArray(observations) || observations.length !== 2) {
    throw new TypeError("exactly two BIT observations are required");
  }
  const normalizedObservations = observations.map((value, index) => (
    normalizeBitDeploymentObservation(value, `observations[${index}]`)
  ));
  const timestamp = preparedAt instanceof Date ? preparedAt : new Date(preparedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("BIT provider evidence preparedAt is invalid");
  const comparison = buildBitDeploymentComparisonReport(normalizedObservations[0], normalizedObservations[1], {
    comparedAt: timestamp,
  });
  if (!comparison.eligible) {
    throw new Error(`BIT provider observations are not eligible: ${comparison.reasons.join("; ")}`);
  }
  if (comparison.sourceCommit !== normalizedPolicy.sourceCommit) {
    throw new Error("BIT provider observations do not match the policy source commit");
  }
  const preparedAtSeconds = Math.floor(timestamp.getTime() / 1_000);
  const providerObservations = normalizedObservations
    .map((value) => ({
      providerIdentity: value.providerIdentity,
      observationDigest: bitDeploymentObservationValueDigest(value),
    }))
    .sort((left, right) => left.providerIdentity.localeCompare(right.providerIdentity));
  const candidate = {
    schema: "treeswap.bit-provider-evidence-candidate.v1",
    policy: normalizedPolicy,
    record: {
      schema: "treeswap.bit-provider-evidence-record.v1",
      evidenceStatus: "provider-signed-comparison-candidate",
      chainId: 1,
      verifyingContract: BIT_MAINNET_CONTRACT,
      sourceCommit: comparison.sourceCommit,
      comparisonDigest: bitDeploymentComparisonValueDigest(comparison),
      finalizedBlockNumber: comparison.finalizedBlock.number,
      finalizedBlockHash: comparison.finalizedBlock.hash,
      providerObservations,
      preparedAt: preparedAtSeconds,
      validUntil: preparedAtSeconds + normalizedPolicy.maximumEvidenceLifetimeSeconds,
      independenceStatus: "requires-external-organizational-verification",
      fundingAuthorization: false,
    },
    comparison,
    observations: normalizedObservations,
  };
  return normalizeBitProviderEvidenceCandidate(candidate);
}

export function buildBitProviderEvidenceApprovalMessage({ candidate, providerIdentity }) {
  const normalized = normalizeBitProviderEvidenceCandidate(candidate);
  const identity = digest(providerIdentity, "providerIdentity");
  const provider = normalized.policy.providerApprovers.find((value) => value.providerIdentity === identity);
  const observation = normalized.record.providerObservations.find((value) => value.providerIdentity === identity);
  if (!provider || !observation) throw new Error("BIT provider is not in the evidence policy");
  return Object.freeze({
    domain: Object.freeze({
      name: "TreeSwap BIT Provider Evidence",
      version: "1",
      chainId: BigInt(normalized.record.chainId),
      verifyingContract: normalized.record.verifyingContract,
    }),
    types: BIT_PROVIDER_EVIDENCE_APPROVAL_TYPES,
    value: Object.freeze({
      recordDigest: valueDigest(normalized.record),
      policyDigest: valueDigest(normalized.policy),
      comparisonDigest: normalized.record.comparisonDigest,
      providerIdentity: identity,
      observationDigest: observation.observationDigest,
      finalizedBlockNumber: BigInt(normalized.record.finalizedBlockNumber),
      finalizedBlockHash: normalized.record.finalizedBlockHash,
      validUntil: BigInt(normalized.record.validUntil),
    }),
  });
}

function normalizeAttestation(raw, index) {
  exactKeys(raw, ATTESTATION_FIELDS, `attestations[${index}]`);
  const signature = String(raw.signature ?? "");
  if (!isHexString(signature) || ![130, 132].includes(signature.length)) {
    throw new TypeError(`attestations[${index}].signature is invalid`);
  }
  return Object.freeze({
    providerIdentity: digest(raw.providerIdentity, `attestations[${index}].providerIdentity`),
    signer: address(raw.signer, `attestations[${index}].signer`),
    signature,
  });
}

export function verifyBitProviderEvidence({ candidate, attestations, observedAt = new Date() } = {}) {
  const normalized = normalizeBitProviderEvidenceCandidate(candidate);
  const now = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(now.getTime())) throw new TypeError("BIT provider evidence observedAt is invalid");
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (normalized.record.preparedAt > nowSeconds + BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS) {
    throw new Error("BIT provider evidence is future-dated");
  }
  if (normalized.record.validUntil <= nowSeconds) throw new Error("BIT provider evidence is expired");
  if (!Array.isArray(attestations) || attestations.length !== normalized.policy.providerApprovers.length) {
    throw new TypeError("every BIT provider approver must attest exactly once");
  }
  const normalizedAttestations = attestations.map(normalizeAttestation);
  requireStrictOrder(normalizedAttestations, (value) => value.providerIdentity, "BIT provider attestations");
  requireDistinct(normalizedAttestations, (value) => value.signer.toLowerCase(), "BIT provider attestation signers");
  for (const attestation of normalizedAttestations) {
    const provider = normalized.policy.providerApprovers.find(
      (value) => value.providerIdentity === attestation.providerIdentity,
    );
    if (!provider || provider.signer !== attestation.signer) {
      throw new Error("BIT provider attestation does not match the evidence policy");
    }
    const typed = buildBitProviderEvidenceApprovalMessage({
      candidate: normalized,
      providerIdentity: attestation.providerIdentity,
    });
    let recovered;
    try {
      recovered = verifyTypedData(typed.domain, typed.types, typed.value, attestation.signature);
    } catch {
      throw new Error("BIT provider attestation signature is invalid");
    }
    if (recovered !== provider.signer) throw new Error("BIT provider attestation signature is invalid");
  }
  const verification = Object.freeze({
    schema: "treeswap.verified-bit-provider-evidence.v1",
    status: "cryptographically-verified-provider-comparison",
    record: normalized.record,
    policy: normalized.policy,
    comparison: normalized.comparison,
    recordDigest: valueDigest(normalized.record),
    policyDigest: valueDigest(normalized.policy),
    providerSetDigest: valueDigest(normalized.policy.providerApprovers),
    verifiedAt: now.toISOString(),
    independenceStatus: "requires-external-organizational-verification",
    fundingAuthorization: false,
  });
  verifiedProviderEvidence.add(verification);
  return verification;
}

export function buildBitProviderEvidenceSummary(verification) {
  if (!verifiedProviderEvidence.has(verification)) throw new Error("BIT provider evidence provenance is invalid");
  return Object.freeze({
    schema: "treeswap.bit-provider-evidence-summary.v1",
    status: verification.status,
    sourceCommit: verification.record.sourceCommit,
    chainId: verification.record.chainId,
    verifyingContract: verification.record.verifyingContract,
    finalizedBlockNumber: verification.record.finalizedBlockNumber,
    finalizedBlockHash: verification.record.finalizedBlockHash,
    comparisonDigest: verification.record.comparisonDigest,
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    providerSetDigest: verification.providerSetDigest,
    providerCount: verification.policy.providerApprovers.length,
    preparedAt: verification.record.preparedAt,
    validUntil: verification.record.validUntil,
    verifiedAt: verification.verifiedAt,
    independenceStatus: verification.independenceStatus,
    fundingAuthorization: false,
  });
}
