import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import {
  hashQualificationFile,
  verifyReleaseQualificationEvidence,
} from "./qualification-evidence.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const FUNDING_MODES = Object.freeze(["operator-testnet", "operator-testnet-bootstrap"]);
const MAXIMUM_QUALIFICATION_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAXIMUM_REVIEW_LIFETIME_SECONDS = 24 * 60 * 60;

const POLICY_FIELDS = Object.freeze([
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "fundingMode",
  "maximumQualificationAgeSeconds",
  "maximumReviewLifetimeSeconds",
  "protocolVersion",
  "reviewedBuildCommit",
  "reviewer",
  "reviewerId",
  "reviewerIdentityEvidenceDigest",
  "reviewerOrganizationId",
  "schema",
  "verifyingContract",
]);

const REVIEW_FIELDS = Object.freeze([
  "findingsDispositionDigest",
  "qualificationFileDigest",
  "reportDigest",
  "reviewId",
  "reviewedAt",
  "schema",
  "status",
  "validUntil",
]);

const verifiedQualificationReviews = new WeakSet();

export const QUALIFICATION_REVIEW_ATTESTATION_TYPES = Object.freeze({
  QualificationReviewAttestation: Object.freeze([
    Object.freeze({ name: "reviewId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "qualificationEvidenceDigest", type: "bytes32" }),
    Object.freeze({ name: "qualificationFileDigest", type: "bytes32" }),
    Object.freeze({ name: "reviewerId", type: "bytes32" }),
    Object.freeze({ name: "reviewedAt", type: "uint64" }),
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

function sha256Digest(value, name) {
  const normalized = String(value ?? "").toLowerCase();
  if (!SHA256.test(normalized) || normalized === `sha256:${"00".repeat(32)}`) {
    throw new TypeError(`${name} must be a nonzero lowercase SHA-256 digest`);
  }
  return normalized;
}

function sha256Bytes32(value, name) {
  return `0x${sha256Digest(value, name).slice("sha256:".length)}`;
}

function address(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function boundedPositive(value, name, maximum) {
  const normalized = timestamp(value, name);
  if (normalized > maximum) throw new RangeError(`${name} exceeds its hard maximum`);
  return normalized;
}

function chainId(value) {
  const normalized = String(value ?? "");
  if (!/^[1-9][0-9]{0,15}$/.test(normalized) || BigInt(normalized) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("qualification review chainId is invalid");
  }
  return normalized;
}

function fundingMode(value) {
  if (!FUNDING_MODES.includes(value)) throw new TypeError("qualification review fundingMode is invalid");
  return value;
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "qualification review policy");
  if (raw.schema !== "treeswap.qualification-review-policy.v1") {
    throw new TypeError("qualification review policy schema is invalid");
  }
  if (raw.environment !== "public-testnet") {
    throw new TypeError("qualification review environment must be public-testnet");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) {
    throw new TypeError("qualification review source commit is invalid");
  }
  if (!VERSION.test(String(raw.protocolVersion ?? ""))) {
    throw new TypeError("qualification review protocol version is invalid");
  }
  const reviewerId = digest(raw.reviewerId, "reviewerId");
  const reviewerOrganizationId = digest(raw.reviewerOrganizationId, "reviewerOrganizationId");
  const reviewerIdentityEvidenceDigest = digest(
    raw.reviewerIdentityEvidenceDigest,
    "reviewerIdentityEvidenceDigest",
  );
  if (new Set([reviewerId, reviewerOrganizationId, reviewerIdentityEvidenceDigest]).size !== 3) {
    throw new Error("qualification reviewer identity, organization, and evidence commitments must be distinct");
  }
  return Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    fundingMode: fundingMode(raw.fundingMode),
    chainId: chainId(raw.chainId),
    verifyingContract: address(raw.verifyingContract, "verifyingContract"),
    protocolVersion: raw.protocolVersion,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "deploymentManifestDigest"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    reviewerId,
    reviewerOrganizationId,
    reviewerIdentityEvidenceDigest,
    reviewer: address(raw.reviewer, "reviewer"),
    maximumQualificationAgeSeconds: boundedPositive(
      raw.maximumQualificationAgeSeconds,
      "maximumQualificationAgeSeconds",
      MAXIMUM_QUALIFICATION_AGE_SECONDS,
    ),
    maximumReviewLifetimeSeconds: boundedPositive(
      raw.maximumReviewLifetimeSeconds,
      "maximumReviewLifetimeSeconds",
      MAXIMUM_REVIEW_LIFETIME_SECONDS,
    ),
  });
}

function normalizeReview(raw, policy, qualificationFileDigest) {
  exactKeys(raw, REVIEW_FIELDS, "qualification review");
  if (raw.schema !== "treeswap.qualification-review.v1"
      || raw.status !== "passed-no-open-findings") {
    throw new Error("qualification review identity or status is invalid");
  }
  const reviewedAt = timestamp(raw.reviewedAt, "reviewedAt");
  const validUntil = timestamp(raw.validUntil, "validUntil");
  if (validUntil <= reviewedAt || validUntil - reviewedAt > policy.maximumReviewLifetimeSeconds) {
    throw new Error("qualification review validity exceeds policy");
  }
  const normalized = Object.freeze({
    schema: raw.schema,
    status: raw.status,
    reviewId: digest(raw.reviewId, "reviewId"),
    qualificationFileDigest: sha256Digest(raw.qualificationFileDigest, "qualificationFileDigest"),
    reportDigest: digest(raw.reportDigest, "reportDigest"),
    findingsDispositionDigest: digest(raw.findingsDispositionDigest, "findingsDispositionDigest"),
    reviewedAt,
    validUntil,
  });
  if (normalized.qualificationFileDigest !== qualificationFileDigest) {
    throw new Error("qualification review file digest does not match the exact supplied artifact bytes");
  }
  if (new Set([
    normalized.reviewId,
    normalized.reportDigest,
    normalized.findingsDispositionDigest,
    policy.reviewerIdentityEvidenceDigest,
  ]).size !== 4) {
    throw new Error("qualification review commitments must be distinct");
  }
  return normalized;
}

function parseQualificationFile(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (raw.byteLength === 0 || raw.byteLength > 1_000_000) {
    throw new Error("qualification artifact must be a non-empty file no larger than 1 MB");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("qualification artifact is not valid JSON");
  }
  return Object.freeze({
    bytes: raw,
    fileDigest: hashQualificationFile(raw),
    qualification: verifyReleaseQualificationEvidence(parsed),
  });
}

export function qualificationReviewDomain({ chainId: rawChainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Qualification Review",
    version: "1",
    chainId: BigInt(chainId(rawChainId)),
    verifyingContract: address(verifyingContract, "domain.verifyingContract"),
  });
}

export function assertQualificationReviewIsSecretFree(value) {
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
        throw new Error("qualification review contains secret or unrestricted endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`qualification review contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

export function prepareQualificationReviewCandidate({ qualificationFileBytes, review, policy }) {
  const normalizedPolicy = normalizePolicy(policy);
  const parsed = parseQualificationFile(qualificationFileBytes);
  const normalizedReview = normalizeReview(review, normalizedPolicy, parsed.fileDigest);
  const qualification = parsed.qualification;
  if (qualification.source.commit !== normalizedPolicy.reviewedBuildCommit) {
    throw new Error("qualification artifact does not match the reviewed build commit");
  }
  const qualificationFinishedAt = Date.parse(qualification.finishedAt) / 1_000;
  if (!Number.isSafeInteger(qualificationFinishedAt)
      || qualificationFinishedAt > normalizedReview.reviewedAt
      || normalizedReview.reviewedAt - qualificationFinishedAt > normalizedPolicy.maximumQualificationAgeSeconds) {
    throw new Error("qualification artifact is future-dated or too old for review");
  }
  const record = Object.freeze({
    schema: "treeswap.reviewed-qualification-evidence.v1",
    status: "qualification-artifact-reconstructed-and-passed-with-no-open-findings",
    environment: normalizedPolicy.environment,
    fundingMode: normalizedPolicy.fundingMode,
    chainId: normalizedPolicy.chainId,
    verifyingContract: normalizedPolicy.verifyingContract,
    protocolVersion: normalizedPolicy.protocolVersion,
    deploymentManifestDigest: normalizedPolicy.deploymentManifestDigest,
    reviewedBuildCommit: normalizedPolicy.reviewedBuildCommit,
    reviewId: normalizedReview.reviewId,
    reviewerId: normalizedPolicy.reviewerId,
    reviewerOrganizationId: normalizedPolicy.reviewerOrganizationId,
    reviewerIdentityEvidenceDigest: normalizedPolicy.reviewerIdentityEvidenceDigest,
    reviewer: normalizedPolicy.reviewer,
    reportDigest: normalizedReview.reportDigest,
    findingsDispositionDigest: normalizedReview.findingsDispositionDigest,
    reviewedAt: normalizedReview.reviewedAt,
    validUntil: normalizedReview.validUntil,
    qualificationFileDigest: normalizedReview.qualificationFileDigest,
    qualificationEvidenceDigest: qualification.evidenceDigest,
    qualificationStartedAt: qualification.startedAt,
    qualificationFinishedAt: qualification.finishedAt,
    productionDurationEvidenceDigest: qualification.productionDuration.evidenceDigest,
    campaignCount: qualification.campaigns.length,
    configurationHashCount: Object.keys(qualification.configurationHashes).length,
    pinnedImageCount: qualification.pinnedImages.length,
  });
  const candidate = Object.freeze({
    schema: "treeswap.prepared-qualification-review-evidence.v1",
    status: "qualification-artifact-reconstructed-awaiting-reviewer-attestation",
    scope: "qualification-review-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: hash(record),
    policyDigest: hash(normalizedPolicy),
    record,
    policy: normalizedPolicy,
    review: normalizedReview,
    qualification,
  });
  assertQualificationReviewIsSecretFree({
    record: candidate.record,
    policy: candidate.policy,
  });
  return candidate;
}

export function buildQualificationReviewAttestationMessage(input) {
  const candidate = prepareQualificationReviewCandidate(input);
  return Object.freeze({
    domain: qualificationReviewDomain(candidate.record),
    types: QUALIFICATION_REVIEW_ATTESTATION_TYPES,
    value: Object.freeze({
      reviewId: candidate.record.reviewId,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      qualificationEvidenceDigest: sha256Bytes32(
        candidate.record.qualificationEvidenceDigest,
        "qualificationEvidenceDigest",
      ),
      qualificationFileDigest: sha256Bytes32(
        candidate.record.qualificationFileDigest,
        "qualificationFileDigest",
      ),
      reviewerId: candidate.record.reviewerId,
      reviewedAt: candidate.record.reviewedAt,
      validUntil: candidate.record.validUntil,
    }),
  });
}

function normalizeAttestation(raw) {
  exactKeys(raw, ["reviewerId", "signature", "signer"], "qualification review attestation");
  if (!isHexString(raw.signature) || ![64, 65].includes((raw.signature.length - 2) / 2)) {
    throw new TypeError("qualification review attestation signature is invalid");
  }
  return Object.freeze({
    reviewerId: digest(raw.reviewerId, "attestation.reviewerId"),
    signer: address(raw.signer, "attestation.signer"),
    signature: raw.signature.toLowerCase(),
  });
}

export function verifyQualificationReviewEvidence({
  qualificationFileBytes,
  review,
  policy,
  attestation,
  now = Math.floor(Date.now() / 1_000),
}) {
  const candidate = prepareQualificationReviewCandidate({ qualificationFileBytes, review, policy });
  const observedAt = timestamp(now, "now");
  if (observedAt < candidate.record.reviewedAt) throw new Error("qualification review is from the future");
  if (observedAt > candidate.record.validUntil) throw new Error("qualification review is expired");
  const normalizedAttestation = normalizeAttestation(attestation);
  if (normalizedAttestation.reviewerId !== candidate.record.reviewerId
      || normalizedAttestation.signer !== candidate.record.reviewer) {
    throw new Error("qualification review attestation does not match the policy-pinned reviewer");
  }
  const typed = buildQualificationReviewAttestationMessage({ qualificationFileBytes, review, policy });
  const recovered = verifyTypedData(
    typed.domain,
    typed.types,
    typed.value,
    normalizedAttestation.signature,
  );
  if (getAddress(recovered) !== candidate.record.reviewer) {
    throw new Error("qualification review signature is invalid");
  }
  const attestationDigest = hash(normalizedAttestation);
  const evidenceDigest = hash({
    schema: "treeswap.qualification-review-release-binding.v1",
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    attestationDigest,
    qualificationEvidenceDigest: candidate.record.qualificationEvidenceDigest,
    qualificationFileDigest: candidate.record.qualificationFileDigest,
  });
  const result = Object.freeze({
    schema: "treeswap.verified-qualification-review-evidence.v1",
    status: "qualification-artifact-and-reviewer-attestation-verified",
    scope: "qualification-review-evidence-no-signing-broadcast-gate-opening-or-funding-authorization",
    evidenceDigest,
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    attestationDigest,
    record: candidate.record,
    policy: candidate.policy,
    authorizations: Object.freeze({ signing: false, broadcast: false, gateOpening: false, funding: false }),
  });
  assertQualificationReviewIsSecretFree(result);
  verifiedQualificationReviews.add(result);
  return result;
}

export function buildQualificationReviewReleaseEvidence(verification) {
  if (!verifiedQualificationReviews.has(verification)) {
    throw new Error("qualification review evidence provenance is invalid");
  }
  return Object.freeze({
    schema: "treeswap.qualification-review-release-evidence.v1",
    evidenceDigest: verification.evidenceDigest,
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    attestationDigest: verification.attestationDigest,
    environment: verification.record.environment,
    fundingMode: verification.record.fundingMode,
    chainId: verification.record.chainId,
    verifyingContract: verification.record.verifyingContract,
    protocolVersion: verification.record.protocolVersion,
    deploymentManifestDigest: verification.record.deploymentManifestDigest,
    reviewedBuildCommit: verification.record.reviewedBuildCommit,
    reviewerId: verification.record.reviewerId,
    reviewerOrganizationId: verification.record.reviewerOrganizationId,
    reviewer: verification.record.reviewer,
    reviewedAt: verification.record.reviewedAt,
    validUntil: verification.record.validUntil,
    reportDigest: verification.record.reportDigest,
    findingsDispositionDigest: verification.record.findingsDispositionDigest,
    qualificationFileDigest: verification.record.qualificationFileDigest,
    qualificationEvidenceDigest: verification.record.qualificationEvidenceDigest,
    productionDurationEvidenceDigest: verification.record.productionDurationEvidenceDigest,
    campaignCount: verification.record.campaignCount,
    configurationHashCount: verification.record.configurationHashCount,
    pinnedImageCount: verification.record.pinnedImageCount,
  });
}

export function buildQualificationReviewSummary(verification) {
  const evidence = buildQualificationReviewReleaseEvidence(verification);
  return Object.freeze({
    ...evidence,
    schema: "treeswap.qualification-review-summary.v1",
    status: verification.status,
    scope: verification.scope,
    authorizations: verification.authorizations,
  });
}
