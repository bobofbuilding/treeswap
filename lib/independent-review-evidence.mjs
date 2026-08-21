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
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const UINT64_MAX = (1n << 64n) - 1n;

export const INDEPENDENT_REVIEW_ROLES = Object.freeze([
  "contracts",
  "coordinator",
  "identity-privacy",
  "lightning",
  "operations",
]);

const REPORT_FIELDS = Object.freeze([
  "contracts",
  "coordinator",
  "identityPrivacy",
  "lightning",
  "operations",
]);

const REPORT_VALUE_FIELDS = Object.freeze([
  "acceptedCriticalRiskCount",
  "acceptedHighRiskCount",
  "acceptedRiskCount",
  "findingCount",
  "findingsDispositionDigest",
  "fixedFindingCount",
  "notApplicableFindingCount",
  "openFindingCount",
  "reportDigest",
]);

const POLICY_FIELDS = Object.freeze([
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "maximumEvidenceAgeSeconds",
  "maximumEvidenceLifetimeSeconds",
  "maximumFindingsPerReview",
  "protocolVersion",
  "reviewedBuildCommit",
  "schema",
  "verifyingContract",
]);

const RECORD_FIELDS = Object.freeze([
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "finishedAt",
  "participants",
  "protocolVersion",
  "reports",
  "reviewId",
  "reviewedBuildCommit",
  "schema",
  "startedAt",
  "validUntil",
  "verifyingContract",
]);

const verifiedIndependentReviews = new WeakSet();

export const INDEPENDENT_REVIEW_ATTESTATION_TYPES = Object.freeze({
  IndependentReviewAttestation: Object.freeze([
    Object.freeze({ name: "reviewId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "role", type: "string" }),
    Object.freeze({ name: "reviewerId", type: "bytes32" }),
    Object.freeze({ name: "finishedAt", type: "uint64" }),
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

function address(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function canonicalChainId(value, name) {
  const normalized = String(value ?? "");
  if (!DECIMAL_CHAIN_ID.test(normalized)) throw new TypeError(`${name} must be a canonical positive decimal string`);
  if (BigInt(normalized) > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe integer range`);
  return normalized;
}

function safeInteger(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(`${name} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  if (BigInt(value) > UINT64_MAX) throw new RangeError(`${name} exceeds uint64`);
  return value;
}

function timestamp(value, name) {
  return safeInteger(value, name, { positive: true });
}

function requireCanonicalOrder(values, selector, name) {
  for (let index = 1; index < values.length; index += 1) {
    if (selector(values[index - 1]).localeCompare(selector(values[index])) >= 0) {
      throw new Error(`${name} must be strictly canonically ordered`);
    }
  }
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "independent review policy");
  if (raw.schema !== "treeswap.independent-review-evidence-policy.v1") {
    throw new TypeError("independent review policy schema is invalid");
  }
  if (raw.environment !== "public-testnet") throw new TypeError("independent review environment must be public-testnet");
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("independent review build commit is invalid");
  if (!VERSION.test(String(raw.protocolVersion ?? ""))) throw new TypeError("independent review protocol version is invalid");
  const maximumEvidenceAgeSeconds = safeInteger(
    raw.maximumEvidenceAgeSeconds,
    "maximumEvidenceAgeSeconds",
    { positive: true },
  );
  const maximumEvidenceLifetimeSeconds = safeInteger(
    raw.maximumEvidenceLifetimeSeconds,
    "maximumEvidenceLifetimeSeconds",
    { positive: true },
  );
  const maximumFindingsPerReview = safeInteger(
    raw.maximumFindingsPerReview,
    "maximumFindingsPerReview",
    { positive: true },
  );
  if (maximumEvidenceAgeSeconds > 2_592_000) {
    throw new RangeError("independent review freshness may not exceed thirty days");
  }
  if (maximumEvidenceLifetimeSeconds > 7_776_000) {
    throw new RangeError("independent review lifetime may not exceed ninety days");
  }
  if (maximumFindingsPerReview > 1_000) {
    throw new RangeError("independent review finding bound may not exceed one thousand");
  }
  return Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    chainId: canonicalChainId(raw.chainId, "policy.chainId"),
    verifyingContract: address(raw.verifyingContract, "policy.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    protocolVersion: raw.protocolVersion,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "policy.deploymentManifestDigest"),
    maximumEvidenceAgeSeconds,
    maximumEvidenceLifetimeSeconds,
    maximumFindingsPerReview,
  });
}

function normalizeParticipant(raw, index) {
  exactKeys(
    raw,
    ["evidenceDigest", "organizationId", "reviewerId", "role", "signer"],
    `participants[${index}]`,
  );
  if (!INDEPENDENT_REVIEW_ROLES.includes(raw.role)) {
    throw new TypeError(`participants[${index}].role is invalid`);
  }
  return Object.freeze({
    role: raw.role,
    reviewerId: digest(raw.reviewerId, `participants[${index}].reviewerId`),
    organizationId: digest(raw.organizationId, `participants[${index}].organizationId`),
    signer: address(raw.signer, `participants[${index}].signer`),
    evidenceDigest: digest(raw.evidenceDigest, `participants[${index}].evidenceDigest`),
  });
}

function normalizeReport(raw, role, maximumFindingsPerReview) {
  exactKeys(raw, REPORT_VALUE_FIELDS, `reports.${role}`);
  const findingCount = safeInteger(raw.findingCount, `reports.${role}.findingCount`);
  const fixedFindingCount = safeInteger(raw.fixedFindingCount, `reports.${role}.fixedFindingCount`);
  const acceptedRiskCount = safeInteger(raw.acceptedRiskCount, `reports.${role}.acceptedRiskCount`);
  const notApplicableFindingCount = safeInteger(
    raw.notApplicableFindingCount,
    `reports.${role}.notApplicableFindingCount`,
  );
  const openFindingCount = safeInteger(raw.openFindingCount, `reports.${role}.openFindingCount`);
  const acceptedCriticalRiskCount = safeInteger(
    raw.acceptedCriticalRiskCount,
    `reports.${role}.acceptedCriticalRiskCount`,
  );
  const acceptedHighRiskCount = safeInteger(
    raw.acceptedHighRiskCount,
    `reports.${role}.acceptedHighRiskCount`,
  );
  if (findingCount > maximumFindingsPerReview) {
    throw new RangeError(`reports.${role}.findingCount exceeds policy`);
  }
  if (fixedFindingCount + acceptedRiskCount + notApplicableFindingCount + openFindingCount !== findingCount) {
    throw new Error(`reports.${role} finding disposition counts do not reconcile`);
  }
  if (openFindingCount !== 0) throw new Error(`reports.${role} contains unresolved findings`);
  if (acceptedCriticalRiskCount !== 0 || acceptedHighRiskCount !== 0) {
    throw new Error(`reports.${role} cannot risk-accept critical or high findings`);
  }
  if (acceptedCriticalRiskCount + acceptedHighRiskCount > acceptedRiskCount) {
    throw new Error(`reports.${role} accepted severity counts exceed accepted risks`);
  }
  return Object.freeze({
    reportDigest: digest(raw.reportDigest, `reports.${role}.reportDigest`),
    findingsDispositionDigest: digest(
      raw.findingsDispositionDigest,
      `reports.${role}.findingsDispositionDigest`,
    ),
    findingCount,
    fixedFindingCount,
    acceptedRiskCount,
    notApplicableFindingCount,
    openFindingCount,
    acceptedCriticalRiskCount,
    acceptedHighRiskCount,
  });
}

function normalizeRecord(raw, policy) {
  exactKeys(raw, RECORD_FIELDS, "independent review record");
  if (raw.schema !== "treeswap.independent-review-evidence.v1") {
    throw new TypeError("independent review record schema is invalid");
  }
  if (raw.environment !== "public-testnet") throw new TypeError("independent review environment must be public-testnet");
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("independent review build commit is invalid");
  if (!VERSION.test(String(raw.protocolVersion ?? ""))) throw new TypeError("independent review protocol version is invalid");
  const startedAt = timestamp(raw.startedAt, "startedAt");
  const finishedAt = timestamp(raw.finishedAt, "finishedAt");
  const validUntil = timestamp(raw.validUntil, "validUntil");
  if (finishedAt < startedAt) throw new RangeError("independent review timestamps are reversed");
  if (validUntil <= finishedAt) throw new RangeError("independent review validity interval is empty or reversed");
  if (validUntil - finishedAt > policy.maximumEvidenceLifetimeSeconds) {
    throw new RangeError("independent review validity exceeds policy");
  }
  const base = Object.freeze({
    schema: raw.schema,
    reviewId: digest(raw.reviewId, "reviewId"),
    environment: raw.environment,
    chainId: canonicalChainId(raw.chainId, "record.chainId"),
    verifyingContract: address(raw.verifyingContract, "record.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    protocolVersion: raw.protocolVersion,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "record.deploymentManifestDigest"),
    startedAt,
    finishedAt,
    validUntil,
  });
  if (base.chainId !== policy.chainId
      || base.verifyingContract !== policy.verifyingContract
      || base.reviewedBuildCommit !== policy.reviewedBuildCommit
      || base.protocolVersion !== policy.protocolVersion
      || base.deploymentManifestDigest !== policy.deploymentManifestDigest) {
    throw new Error("independent review record does not match its policy");
  }
  if (!Array.isArray(raw.participants) || raw.participants.length !== INDEPENDENT_REVIEW_ROLES.length) {
    throw new Error("independent review requires exactly one participant for every review role");
  }
  const participants = raw.participants.map(normalizeParticipant);
  requireCanonicalOrder(participants, (value) => value.role, "independent review participants");
  const roles = new Set();
  const reviewerIds = new Set();
  const organizations = new Set();
  const signers = new Set();
  const evidenceDigests = new Set();
  for (const participant of participants) {
    const signer = participant.signer.toLowerCase();
    if (roles.has(participant.role)) throw new Error("independent review roles must be unique");
    if (reviewerIds.has(participant.reviewerId)) throw new Error("independent reviewer identities must be distinct");
    if (organizations.has(participant.organizationId)) {
      throw new Error("independent review roles must use distinct organization commitments");
    }
    if (signers.has(signer)) throw new Error("independent review roles must use distinct signers");
    if (evidenceDigests.has(participant.evidenceDigest)) {
      throw new Error("independent reviewers must retain distinct identity evidence");
    }
    roles.add(participant.role);
    reviewerIds.add(participant.reviewerId);
    organizations.add(participant.organizationId);
    signers.add(signer);
    evidenceDigests.add(participant.evidenceDigest);
  }
  for (const role of INDEPENDENT_REVIEW_ROLES) {
    if (!roles.has(role)) throw new Error(`independent review is missing the ${role} role`);
  }
  exactKeys(raw.reports, REPORT_FIELDS, "independent review reports");
  const reports = Object.freeze(Object.fromEntries(REPORT_FIELDS.map((field) => [
    field,
    normalizeReport(raw.reports[field], field, policy.maximumFindingsPerReview),
  ])));
  const reportDigests = new Set();
  const dispositionDigests = new Set();
  for (const report of Object.values(reports)) {
    if (reportDigests.has(report.reportDigest)) throw new Error("independent review reports must be distinct");
    if (dispositionDigests.has(report.findingsDispositionDigest)) {
      throw new Error("independent review findings dispositions must be distinct");
    }
    reportDigests.add(report.reportDigest);
    dispositionDigests.add(report.findingsDispositionDigest);
  }
  return Object.freeze({ ...base, participants: Object.freeze(participants), reports });
}

function normalizeAttestation(raw, index) {
  exactKeys(raw, ["reviewerId", "role", "signature", "signer"], `attestations[${index}]`);
  if (!INDEPENDENT_REVIEW_ROLES.includes(raw.role)) {
    throw new TypeError(`attestations[${index}].role is invalid`);
  }
  if (!isHexString(raw.signature) || ![64, 65].includes((raw.signature.length - 2) / 2)) {
    throw new TypeError(`attestations[${index}].signature is invalid`);
  }
  return Object.freeze({
    role: raw.role,
    reviewerId: digest(raw.reviewerId, `attestations[${index}].reviewerId`),
    signer: address(raw.signer, `attestations[${index}].signer`),
    signature: raw.signature.toLowerCase(),
  });
}

export function independentReviewEvidenceDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Independent Review Evidence",
    version: "1",
    chainId: BigInt(canonicalChainId(chainId, "domain.chainId")),
    verifyingContract: address(verifyingContract, "domain.verifyingContract"),
  });
}

export function assertIndependentReviewEvidenceIsSecretFree(value) {
  const forbiddenKey = /(email|endpoint|invoice|macaroon|mnemonic|password|preimage|private.?key|rpc.?url|seed)/i;
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
        throw new Error("independent review evidence contains secret or unrestricted endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`independent review evidence contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

export function prepareIndependentReviewEvidenceCandidate({ record, policy }) {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedRecord = normalizeRecord(record, normalizedPolicy);
  assertIndependentReviewEvidenceIsSecretFree({ record: normalizedRecord, policy: normalizedPolicy });
  return Object.freeze({
    schema: "treeswap.prepared-independent-review-evidence.v1",
    status: "validated-awaiting-five-independent-reviewer-attestations",
    scope: "review-evidence-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: hash(normalizedRecord),
    policyDigest: hash(normalizedPolicy),
    record: normalizedRecord,
    policy: normalizedPolicy,
  });
}

export function buildIndependentReviewAttestationMessage({ record, policy, role, reviewerId }) {
  const candidate = prepareIndependentReviewEvidenceCandidate({ record, policy });
  if (!INDEPENDENT_REVIEW_ROLES.includes(role)) throw new TypeError("independent review attestation role is invalid");
  const normalizedReviewerId = digest(reviewerId, "independent review attestation reviewerId");
  const participant = candidate.record.participants.find((value) => (
    value.role === role && value.reviewerId === normalizedReviewerId
  ));
  if (!participant) throw new Error("independent review attestation identity is not a participant");
  return Object.freeze({
    domain: independentReviewEvidenceDomain(candidate.record),
    types: INDEPENDENT_REVIEW_ATTESTATION_TYPES,
    value: Object.freeze({
      reviewId: candidate.record.reviewId,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      role,
      reviewerId: normalizedReviewerId,
      finishedAt: candidate.record.finishedAt,
      validUntil: candidate.record.validUntil,
    }),
  });
}

export function verifyIndependentReviewEvidence({
  record,
  policy,
  attestations,
  now = Math.floor(Date.now() / 1_000),
}) {
  const candidate = prepareIndependentReviewEvidenceCandidate({ record, policy });
  const observedAt = timestamp(now, "now");
  if (observedAt < candidate.record.finishedAt) throw new Error("independent review evidence is from the future");
  if (observedAt > candidate.record.validUntil) throw new Error("independent review evidence is expired");
  if (observedAt - candidate.record.finishedAt > candidate.policy.maximumEvidenceAgeSeconds) {
    throw new Error("independent review evidence is stale");
  }
  if (!Array.isArray(attestations) || attestations.length !== candidate.record.participants.length) {
    throw new Error("independent review requires one attestation from every participant");
  }
  const normalizedAttestations = attestations.map(normalizeAttestation);
  requireCanonicalOrder(normalizedAttestations, (value) => value.role, "independent review attestations");
  const domain = independentReviewEvidenceDomain(candidate.record);
  for (let index = 0; index < candidate.record.participants.length; index += 1) {
    const participant = candidate.record.participants[index];
    const attestation = normalizedAttestations[index];
    if (attestation.role !== participant.role
        || attestation.reviewerId !== participant.reviewerId
        || attestation.signer !== participant.signer) {
      throw new Error("independent review attestation does not exactly match its participant");
    }
    const recovered = verifyTypedData(domain, INDEPENDENT_REVIEW_ATTESTATION_TYPES, {
      reviewId: candidate.record.reviewId,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      role: participant.role,
      reviewerId: participant.reviewerId,
      finishedAt: candidate.record.finishedAt,
      validUntil: candidate.record.validUntil,
    }, attestation.signature);
    if (getAddress(recovered) !== participant.signer) throw new Error("independent reviewer signature is invalid");
  }
  const result = Object.freeze({
    schema: "treeswap.verified-independent-review-evidence.v1",
    status: "five-independent-reviewer-attestations-cryptographically-verified",
    scope: "review-release-evidence-no-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    attestationSetDigest: hash(normalizedAttestations),
    record: candidate.record,
    policy: candidate.policy,
    authorizations: Object.freeze({ signing: false, broadcast: false, gateOpening: false, funding: false }),
  });
  assertIndependentReviewEvidenceIsSecretFree(result);
  verifiedIndependentReviews.add(result);
  return result;
}

export function buildIndependentReviewReleaseEvidence(verification) {
  if (!verifiedIndependentReviews.has(verification)) throw new Error("independent review evidence provenance is invalid");
  const reviewDigests = Object.freeze(Object.fromEntries(REPORT_FIELDS.map((field) => [
    field,
    verification.record.reports[field].reportDigest,
  ])));
  return Object.freeze({
    schema: "treeswap.independent-review-release-evidence.v1",
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    attestationSetDigest: verification.attestationSetDigest,
    participantSetDigest: hash(verification.record.participants),
    findingsDispositionDigest: hash(verification.record.reports),
    reviewedBuildCommit: verification.record.reviewedBuildCommit,
    protocolVersion: verification.record.protocolVersion,
    chainId: verification.record.chainId,
    verifyingContract: verification.record.verifyingContract,
    deploymentManifestDigest: verification.record.deploymentManifestDigest,
    finishedAt: verification.record.finishedAt,
    validUntil: verification.record.validUntil,
    reviewerCount: verification.record.participants.length,
    reviewDigests,
    reviewers: Object.freeze(verification.record.participants.map((participant) => Object.freeze({
      role: participant.role,
      reviewerId: participant.reviewerId,
      organizationId: participant.organizationId,
      signer: participant.signer,
    }))),
  });
}

export function buildIndependentReviewEvidenceSummary(verification) {
  const evidence = buildIndependentReviewReleaseEvidence(verification);
  return Object.freeze({
    schema: "treeswap.independent-review-evidence-summary.v1",
    status: verification.status,
    scope: verification.scope,
    recordDigest: evidence.recordDigest,
    policyDigest: evidence.policyDigest,
    attestationSetDigest: evidence.attestationSetDigest,
    participantSetDigest: evidence.participantSetDigest,
    findingsDispositionDigest: evidence.findingsDispositionDigest,
    reviewedBuildCommit: evidence.reviewedBuildCommit,
    protocolVersion: evidence.protocolVersion,
    chainId: evidence.chainId,
    verifyingContract: evidence.verifyingContract,
    deploymentManifestDigest: evidence.deploymentManifestDigest,
    finishedAt: evidence.finishedAt,
    validUntil: evidence.validUntil,
    reviewerCount: evidence.reviewerCount,
    reviewDigests: evidence.reviewDigests,
    authorizations: verification.authorizations,
  });
}
