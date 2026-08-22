import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import {
  buildBitProviderEvidenceSummary,
} from "./bit-provider-evidence.mjs";
import {
  BIT_MAINNET_CONTRACT,
  BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS,
} from "./bit-deployment-observer.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const MINIMUM_REVIEW_LIFETIME_SECONDS = 300;
const MAXIMUM_REVIEW_LIFETIME_SECONDS = 3_600;

const REVIEW_ROLES = Object.freeze([
  "contract-security-reviewer",
  "provider-independence-reviewer",
]);

const CANDIDATE_FIELDS = Object.freeze([
  "artifacts",
  "findingCounts",
  "policy",
  "record",
  "schema",
]);

const POLICY_FIELDS = Object.freeze([
  "chainId",
  "maximumReviewLifetimeSeconds",
  "reviewApprovers",
  "schema",
  "sourceCommit",
  "verifyingContract",
]);

const REVIEW_APPROVER_FIELDS = Object.freeze([
  "identityEvidenceDigest",
  "organizationId",
  "reviewerIdentity",
  "role",
  "signer",
]);

const ARTIFACT_FIELDS = Object.freeze([
  "compilerInputDigest",
  "findingsDispositionDigest",
  "implementationSourceBundleDigest",
  "providerIndependenceReportDigest",
  "proxySourceBundleDigest",
  "rolesAndStorageReportDigest",
  "upgradeBehaviorReportDigest",
]);

const FINDING_COUNT_FIELDS = Object.freeze([
  "critical",
  "high",
  "informational",
  "low",
  "medium",
  "open",
]);

const RECORD_FIELDS = Object.freeze([
  "artifactSetDigest",
  "chainId",
  "comparisonDigest",
  "evidenceStatus",
  "finalizedBlockHash",
  "finalizedBlockNumber",
  "findingCountsDigest",
  "fundingAuthorization",
  "preparedAt",
  "providerEvidencePolicyDigest",
  "providerEvidenceRecordDigest",
  "providerSetDigest",
  "schema",
  "sourceCommit",
  "validUntil",
  "verifyingContract",
]);

const ATTESTATION_FIELDS = Object.freeze([
  "reviewerIdentity",
  "role",
  "signature",
  "signer",
]);

const verifiedBitReviews = new WeakSet();

export const BIT_INDEPENDENT_REVIEW_APPROVAL_TYPES = Object.freeze({
  BitIndependentReviewApproval: Object.freeze([
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "providerEvidenceRecordDigest", type: "bytes32" }),
    Object.freeze({ name: "artifactSetDigest", type: "bytes32" }),
    Object.freeze({ name: "findingCountsDigest", type: "bytes32" }),
    Object.freeze({ name: "reviewerRole", type: "bytes32" }),
    Object.freeze({ name: "reviewerIdentity", type: "bytes32" }),
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

function safeInteger(value, name, { positive = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > maximum) {
    throw new TypeError(`${name} must be a bounded ${positive ? "positive" : "non-negative"} safe integer`);
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

function normalizeReviewApprover(raw, index) {
  exactKeys(raw, REVIEW_APPROVER_FIELDS, `reviewApprovers[${index}]`);
  if (!REVIEW_ROLES.includes(raw.role)) throw new TypeError(`reviewApprovers[${index}].role is invalid`);
  const normalized = Object.freeze({
    role: raw.role,
    reviewerIdentity: digest(raw.reviewerIdentity, `reviewApprovers[${index}].reviewerIdentity`),
    organizationId: digest(raw.organizationId, `reviewApprovers[${index}].organizationId`),
    signer: address(raw.signer, `reviewApprovers[${index}].signer`),
    identityEvidenceDigest: digest(
      raw.identityEvidenceDigest,
      `reviewApprovers[${index}].identityEvidenceDigest`,
    ),
  });
  if (normalized.signer.toLowerCase() === ZERO_ADDRESS) {
    throw new TypeError(`reviewApprovers[${index}].signer must be nonzero`);
  }
  return normalized;
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "BIT independent review policy");
  if (raw.schema !== "treeswap.bit-independent-review-policy.v1") {
    throw new TypeError("BIT independent review policy schema is invalid");
  }
  const chainId = safeInteger(raw.chainId, "policy.chainId", { positive: true });
  if (chainId !== 1) throw new Error("BIT independent review policy must use Ethereum mainnet");
  const verifyingContract = address(raw.verifyingContract, "policy.verifyingContract");
  if (verifyingContract !== BIT_MAINNET_CONTRACT) {
    throw new Error("BIT independent review policy uses the wrong verifying contract");
  }
  const maximumReviewLifetimeSeconds = safeInteger(
    raw.maximumReviewLifetimeSeconds,
    "policy.maximumReviewLifetimeSeconds",
    { positive: true },
  );
  if (maximumReviewLifetimeSeconds > MAXIMUM_REVIEW_LIFETIME_SECONDS) {
    throw new RangeError("BIT independent review lifetime may not exceed one hour");
  }
  if (maximumReviewLifetimeSeconds < MINIMUM_REVIEW_LIFETIME_SECONDS) {
    throw new RangeError("BIT independent review lifetime must allow at least five minutes");
  }
  if (!Array.isArray(raw.reviewApprovers) || raw.reviewApprovers.length !== REVIEW_ROLES.length) {
    throw new TypeError("BIT independent review policy requires exactly two reviewers");
  }
  const reviewApprovers = raw.reviewApprovers.map(normalizeReviewApprover);
  requireStrictOrder(reviewApprovers, (value) => value.role, "BIT independent review roles");
  if (JSON.stringify(reviewApprovers.map((value) => value.role)) !== JSON.stringify(REVIEW_ROLES)) {
    throw new Error("BIT independent review policy requires both exact reviewer roles");
  }
  requireDistinct(reviewApprovers, (value) => value.reviewerIdentity, "reviewer identities");
  requireDistinct(reviewApprovers, (value) => value.organizationId, "reviewer organization commitments");
  requireDistinct(reviewApprovers, (value) => value.signer.toLowerCase(), "reviewer signers");
  requireDistinct(reviewApprovers, (value) => value.identityEvidenceDigest, "reviewer identity evidence");
  const commitments = reviewApprovers.flatMap((value) => [
    value.reviewerIdentity,
    value.organizationId,
    value.identityEvidenceDigest,
  ]);
  if (new Set(commitments).size !== commitments.length) {
    throw new Error("reviewer identity and evidence commitments must be globally distinct");
  }
  return Object.freeze({
    schema: raw.schema,
    chainId,
    verifyingContract,
    sourceCommit: sourceCommit(raw.sourceCommit, "policy.sourceCommit"),
    maximumReviewLifetimeSeconds,
    reviewApprovers: Object.freeze(reviewApprovers),
  });
}

function normalizeArtifacts(raw) {
  exactKeys(raw, ARTIFACT_FIELDS, "BIT independent review artifacts");
  const normalized = Object.freeze(Object.fromEntries(ARTIFACT_FIELDS.map((field) => [
    field,
    digest(raw[field], `artifacts.${field}`),
  ])));
  requireDistinct(Object.entries(normalized), (entry) => entry[1], "BIT independent review artifact digests");
  return normalized;
}

function normalizeFindingCounts(raw) {
  exactKeys(raw, FINDING_COUNT_FIELDS, "BIT independent review finding counts");
  const normalized = Object.freeze(Object.fromEntries(FINDING_COUNT_FIELDS.map((field) => [
    field,
    safeInteger(raw[field], `findingCounts.${field}`, { maximum: 10_000 }),
  ])));
  if (normalized.critical !== 0 || normalized.high !== 0 || normalized.open !== 0) {
    throw new Error("BIT independent review may not retain critical, high, or open findings");
  }
  return normalized;
}

function normalizeRecord(raw, policy) {
  exactKeys(raw, RECORD_FIELDS, "BIT independent review record");
  if (raw.schema !== "treeswap.bit-independent-review-record.v1") {
    throw new TypeError("BIT independent review record schema is invalid");
  }
  if (raw.evidenceStatus !== "independent-review-candidate") {
    throw new TypeError("BIT independent review status is invalid");
  }
  if (raw.fundingAuthorization !== false) throw new Error("BIT independent review may not authorize funding");
  const chainId = safeInteger(raw.chainId, "record.chainId", { positive: true });
  const verifyingContract = address(raw.verifyingContract, "record.verifyingContract");
  const commit = sourceCommit(raw.sourceCommit, "record.sourceCommit");
  if (chainId !== policy.chainId || verifyingContract !== policy.verifyingContract
      || commit !== policy.sourceCommit) {
    throw new Error("BIT independent review record does not match policy");
  }
  const preparedAt = safeInteger(raw.preparedAt, "record.preparedAt", { positive: true });
  const validUntil = safeInteger(raw.validUntil, "record.validUntil", { positive: true });
  if (validUntil <= preparedAt || validUntil - preparedAt > policy.maximumReviewLifetimeSeconds) {
    throw new Error("BIT independent review validity is reversed or exceeds policy");
  }
  return Object.freeze({
    schema: raw.schema,
    evidenceStatus: raw.evidenceStatus,
    chainId,
    verifyingContract,
    sourceCommit: commit,
    providerEvidenceRecordDigest: digest(
      raw.providerEvidenceRecordDigest,
      "record.providerEvidenceRecordDigest",
    ),
    providerEvidencePolicyDigest: digest(
      raw.providerEvidencePolicyDigest,
      "record.providerEvidencePolicyDigest",
    ),
    providerSetDigest: digest(raw.providerSetDigest, "record.providerSetDigest"),
    comparisonDigest: digest(raw.comparisonDigest, "record.comparisonDigest"),
    finalizedBlockNumber: safeInteger(
      raw.finalizedBlockNumber,
      "record.finalizedBlockNumber",
      { positive: true },
    ),
    finalizedBlockHash: digest(raw.finalizedBlockHash, "record.finalizedBlockHash"),
    artifactSetDigest: digest(raw.artifactSetDigest, "record.artifactSetDigest"),
    findingCountsDigest: digest(raw.findingCountsDigest, "record.findingCountsDigest"),
    preparedAt,
    validUntil,
    fundingAuthorization: false,
  });
}

function assertSecretFree(value) {
  const forbiddenKey = /(?:url|endpoint|authorization|api.?key|secret|credential|cookie|signature|private.?key)/i;
  const visit = (current) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      if (key !== "fundingAuthorization" && forbiddenKey.test(key)) {
        throw new Error(`BIT independent review contains forbidden field ${key}`);
      }
      if (typeof nested === "string"
          && /(?:https?|wss?):\/\/|bearer\s+|api[_-]?key|private[_-]?key/i.test(nested)) {
        throw new Error("BIT independent review contains secret or endpoint material");
      }
      visit(nested);
    }
  };
  visit(value);
}

export function normalizeBitIndependentReviewCandidate(raw) {
  exactKeys(raw, CANDIDATE_FIELDS, "BIT independent review candidate");
  if (raw.schema !== "treeswap.bit-independent-review-candidate.v1") {
    throw new TypeError("BIT independent review candidate schema is invalid");
  }
  const policy = normalizePolicy(raw.policy);
  const artifacts = normalizeArtifacts(raw.artifacts);
  const findingCounts = normalizeFindingCounts(raw.findingCounts);
  const record = normalizeRecord(raw.record, policy);
  if (record.artifactSetDigest !== valueDigest(artifacts)) {
    throw new Error("BIT independent review artifacts do not match the record");
  }
  if (record.findingCountsDigest !== valueDigest(findingCounts)) {
    throw new Error("BIT independent review finding counts do not match the record");
  }
  assertSecretFree({ policy, record, artifacts, findingCounts });
  const normalized = Object.freeze({
    schema: raw.schema,
    policy,
    record,
    artifacts,
    findingCounts,
  });
  if (JSON.stringify(canonical(normalized)) !== JSON.stringify(canonical(raw))) {
    throw new Error("BIT independent review candidate is not canonical");
  }
  return normalized;
}

function assertProviderLink(candidate, providerVerification) {
  const providerSummary = buildBitProviderEvidenceSummary(providerVerification);
  const record = candidate.record;
  if (record.sourceCommit !== providerSummary.sourceCommit
      || record.chainId !== providerSummary.chainId
      || record.verifyingContract !== providerSummary.verifyingContract
      || record.providerEvidenceRecordDigest !== providerSummary.recordDigest
      || record.providerEvidencePolicyDigest !== providerSummary.policyDigest
      || record.providerSetDigest !== providerSummary.providerSetDigest
      || record.comparisonDigest !== providerSummary.comparisonDigest
      || record.finalizedBlockNumber !== providerSummary.finalizedBlockNumber
      || record.finalizedBlockHash !== providerSummary.finalizedBlockHash
      || record.validUntil > providerSummary.validUntil) {
    throw new Error("BIT independent review does not match the verified provider evidence");
  }
  const providerSigners = new Set(
    providerVerification.policy.providerApprovers.map((value) => value.signer.toLowerCase()),
  );
  const providerOrganizations = new Set(
    providerVerification.policy.providerApprovers.map((value) => value.organizationId),
  );
  const providerCommitments = new Set(providerVerification.policy.providerApprovers.flatMap((value) => [
    value.providerIdentity,
    value.organizationId,
    value.identityEvidenceDigest,
    value.serviceEvidenceDigest,
  ]));
  const allCommitments = [
    ...providerCommitments,
    ...Object.values(candidate.artifacts),
  ];
  for (const reviewer of candidate.policy.reviewApprovers) {
    if (providerSigners.has(reviewer.signer.toLowerCase())) {
      throw new Error("BIT reviewers may not reuse a provider signer");
    }
    if (providerOrganizations.has(reviewer.organizationId)) {
      throw new Error("BIT reviewers may not reuse a provider organization");
    }
    if ([reviewer.reviewerIdentity, reviewer.organizationId, reviewer.identityEvidenceDigest]
      .some((value) => providerCommitments.has(value))) {
      throw new Error("BIT reviewer and provider commitments must be globally distinct");
    }
    allCommitments.push(
      reviewer.reviewerIdentity,
      reviewer.organizationId,
      reviewer.identityEvidenceDigest,
    );
  }
  if (new Set(allCommitments).size !== allCommitments.length) {
    throw new Error("BIT provider, reviewer, and artifact commitments must be globally distinct");
  }
  return providerSummary;
}

export function prepareBitIndependentReviewCandidate({
  providerVerification,
  policy,
  artifacts,
  findingCounts,
  preparedAt = new Date(),
} = {}) {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedArtifacts = normalizeArtifacts(artifacts);
  const normalizedFindingCounts = normalizeFindingCounts(findingCounts);
  const providerSummary = buildBitProviderEvidenceSummary(providerVerification);
  if (normalizedPolicy.sourceCommit !== providerSummary.sourceCommit
      || normalizedPolicy.chainId !== providerSummary.chainId
      || normalizedPolicy.verifyingContract !== providerSummary.verifyingContract) {
    throw new Error("BIT independent review policy does not match the verified provider evidence");
  }
  const timestamp = preparedAt instanceof Date ? preparedAt : new Date(preparedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("BIT independent review preparedAt is invalid");
  const preparedAtSeconds = Math.floor(timestamp.getTime() / 1_000);
  const providerVerifiedAtSeconds = Math.floor(Date.parse(providerSummary.verifiedAt) / 1_000);
  const validUntil = Math.min(
    preparedAtSeconds + normalizedPolicy.maximumReviewLifetimeSeconds,
    providerSummary.validUntil,
  );
  if (preparedAtSeconds < providerSummary.preparedAt
      || preparedAtSeconds < providerVerifiedAtSeconds
      || validUntil - preparedAtSeconds < MINIMUM_REVIEW_LIFETIME_SECONDS) {
    throw new Error("verified BIT provider evidence has insufficient remaining lifetime for review");
  }
  const candidate = normalizeBitIndependentReviewCandidate({
    schema: "treeswap.bit-independent-review-candidate.v1",
    policy: normalizedPolicy,
    record: {
      schema: "treeswap.bit-independent-review-record.v1",
      evidenceStatus: "independent-review-candidate",
      chainId: providerSummary.chainId,
      verifyingContract: providerSummary.verifyingContract,
      sourceCommit: providerSummary.sourceCommit,
      providerEvidenceRecordDigest: providerSummary.recordDigest,
      providerEvidencePolicyDigest: providerSummary.policyDigest,
      providerSetDigest: providerSummary.providerSetDigest,
      comparisonDigest: providerSummary.comparisonDigest,
      finalizedBlockNumber: providerSummary.finalizedBlockNumber,
      finalizedBlockHash: providerSummary.finalizedBlockHash,
      artifactSetDigest: valueDigest(normalizedArtifacts),
      findingCountsDigest: valueDigest(normalizedFindingCounts),
      preparedAt: preparedAtSeconds,
      validUntil,
      fundingAuthorization: false,
    },
    artifacts: normalizedArtifacts,
    findingCounts: normalizedFindingCounts,
  });
  assertProviderLink(candidate, providerVerification);
  return candidate;
}

export function buildBitIndependentReviewApprovalMessage({ candidate, providerVerification, role }) {
  const normalized = normalizeBitIndependentReviewCandidate(candidate);
  assertProviderLink(normalized, providerVerification);
  const reviewer = normalized.policy.reviewApprovers.find((value) => value.role === role);
  if (!reviewer) throw new Error("BIT reviewer role is not in the review policy");
  return Object.freeze({
    domain: Object.freeze({
      name: "TreeSwap BIT Independent Review",
      version: "1",
      chainId: BigInt(normalized.record.chainId),
      verifyingContract: normalized.record.verifyingContract,
    }),
    types: BIT_INDEPENDENT_REVIEW_APPROVAL_TYPES,
    value: Object.freeze({
      recordDigest: valueDigest(normalized.record),
      policyDigest: valueDigest(normalized.policy),
      providerEvidenceRecordDigest: normalized.record.providerEvidenceRecordDigest,
      artifactSetDigest: normalized.record.artifactSetDigest,
      findingCountsDigest: normalized.record.findingCountsDigest,
      reviewerRole: keccak256(toUtf8Bytes(reviewer.role)).toLowerCase(),
      reviewerIdentity: reviewer.reviewerIdentity,
      finalizedBlockNumber: BigInt(normalized.record.finalizedBlockNumber),
      finalizedBlockHash: normalized.record.finalizedBlockHash,
      validUntil: BigInt(normalized.record.validUntil),
    }),
  });
}

function normalizeAttestation(raw, index) {
  exactKeys(raw, ATTESTATION_FIELDS, `attestations[${index}]`);
  if (!REVIEW_ROLES.includes(raw.role)) throw new TypeError(`attestations[${index}].role is invalid`);
  const signature = String(raw.signature ?? "");
  if (!isHexString(signature) || ![130, 132].includes(signature.length)) {
    throw new TypeError(`attestations[${index}].signature is invalid`);
  }
  return Object.freeze({
    role: raw.role,
    reviewerIdentity: digest(raw.reviewerIdentity, `attestations[${index}].reviewerIdentity`),
    signer: address(raw.signer, `attestations[${index}].signer`),
    signature,
  });
}

export function verifyBitIndependentReview({
  candidate,
  providerVerification,
  attestations,
  observedAt = new Date(),
} = {}) {
  const normalized = normalizeBitIndependentReviewCandidate(candidate);
  const providerSummary = assertProviderLink(normalized, providerVerification);
  const now = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(now.getTime())) throw new TypeError("BIT independent review observedAt is invalid");
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (normalized.record.preparedAt > nowSeconds + BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS) {
    throw new Error("BIT independent review is future-dated");
  }
  if (normalized.record.validUntil <= nowSeconds) throw new Error("BIT independent review is expired");
  if (!Array.isArray(attestations) || attestations.length !== REVIEW_ROLES.length) {
    throw new TypeError("every BIT independent reviewer must attest exactly once");
  }
  const normalizedAttestations = attestations.map(normalizeAttestation);
  requireStrictOrder(normalizedAttestations, (value) => value.role, "BIT independent review attestations");
  requireDistinct(normalizedAttestations, (value) => value.reviewerIdentity, "review attestation identities");
  requireDistinct(normalizedAttestations, (value) => value.signer.toLowerCase(), "review attestation signers");
  for (const attestation of normalizedAttestations) {
    const reviewer = normalized.policy.reviewApprovers.find((value) => value.role === attestation.role);
    if (!reviewer || reviewer.reviewerIdentity !== attestation.reviewerIdentity
        || reviewer.signer !== attestation.signer) {
      throw new Error("BIT independent review attestation does not match policy");
    }
    const typed = buildBitIndependentReviewApprovalMessage({
      candidate: normalized,
      providerVerification,
      role: attestation.role,
    });
    let recovered;
    try {
      recovered = verifyTypedData(typed.domain, typed.types, typed.value, attestation.signature);
    } catch {
      throw new Error("BIT independent review attestation signature is invalid");
    }
    if (recovered !== reviewer.signer) {
      throw new Error("BIT independent review attestation signature is invalid");
    }
  }
  const verification = Object.freeze({
    schema: "treeswap.verified-bit-independent-review.v1",
    status: "cryptographically-verified-independent-review",
    record: normalized.record,
    policy: normalized.policy,
    artifacts: normalized.artifacts,
    findingCounts: normalized.findingCounts,
    recordDigest: valueDigest(normalized.record),
    policyDigest: valueDigest(normalized.policy),
    reviewerSetDigest: valueDigest(normalized.policy.reviewApprovers),
    providerEvidenceRecordDigest: providerSummary.recordDigest,
    verifiedAt: now.toISOString(),
    providerIndependenceStatus: "reviewer-attested-requires-retained-evidence-audit",
    fundingAuthorization: false,
  });
  verifiedBitReviews.add(verification);
  return verification;
}

export function buildBitIndependentReviewSummary(verification) {
  if (!verifiedBitReviews.has(verification)) throw new Error("BIT independent review provenance is invalid");
  return Object.freeze({
    schema: "treeswap.bit-independent-review-summary.v1",
    status: verification.status,
    sourceCommit: verification.record.sourceCommit,
    chainId: verification.record.chainId,
    verifyingContract: verification.record.verifyingContract,
    finalizedBlockNumber: verification.record.finalizedBlockNumber,
    finalizedBlockHash: verification.record.finalizedBlockHash,
    providerEvidenceRecordDigest: verification.record.providerEvidenceRecordDigest,
    providerEvidencePolicyDigest: verification.record.providerEvidencePolicyDigest,
    providerSetDigest: verification.record.providerSetDigest,
    comparisonDigest: verification.record.comparisonDigest,
    artifactSetDigest: verification.record.artifactSetDigest,
    findingCountsDigest: verification.record.findingCountsDigest,
    findingCounts: verification.findingCounts,
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    reviewerSetDigest: verification.reviewerSetDigest,
    reviewerCount: verification.policy.reviewApprovers.length,
    preparedAt: verification.record.preparedAt,
    validUntil: verification.record.validUntil,
    verifiedAt: verification.verifiedAt,
    providerIndependenceStatus: verification.providerIndependenceStatus,
    fundingAuthorization: false,
  });
}
