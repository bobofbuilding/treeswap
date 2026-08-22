import { keccak256, toUtf8Bytes } from "ethers";
import { buildBitIndependentReviewManifestEvidence } from "./bit-independent-review.mjs";
import { buildBitProviderDeploymentEvidence } from "./bit-provider-evidence.mjs";
import { BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS } from "./bit-deployment-observer.mjs";

const verifiedReviewedBitManifests = new WeakSet();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
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
        throw new Error(`reviewed BIT manifest contains forbidden field ${key}`);
      }
      if (typeof nested === "string"
          && /(?:https?|wss?):\/\/|bearer\s+|api[_-]?key|private[_-]?key/i.test(nested)) {
        throw new Error("reviewed BIT manifest contains secret or endpoint material");
      }
      visit(nested);
    }
  };
  visit(value);
}

function requireExactReviewLink(provider, review) {
  const fields = [
    ["sourceCommit", "source commit"],
    ["chainId", "chain"],
    ["verifyingContract", "BIT proxy"],
    ["comparisonDigest", "provider comparison"],
    ["recordDigest", "provider evidence record"],
    ["policyDigest", "provider evidence policy"],
    ["providerSetDigest", "provider set"],
  ];
  for (const [providerField, label] of fields) {
    const reviewField = providerField === "recordDigest"
      ? "providerEvidenceRecordDigest"
      : providerField === "policyDigest"
        ? "providerEvidencePolicyDigest"
        : providerField;
    if (provider[providerField] !== review[reviewField]) {
      throw new Error(`reviewed BIT manifest ${label} does not match`);
    }
  }
  if (provider.finalizedBlock.number !== review.finalizedBlockNumber
      || provider.finalizedBlock.hash !== review.finalizedBlockHash) {
    throw new Error("reviewed BIT manifest finalized block does not match");
  }
}

export function promoteReviewedBitDeploymentManifest({
  providerVerification,
  reviewVerification,
  promotedAt = new Date(),
  observedAt = new Date(),
} = {}) {
  const provider = buildBitProviderDeploymentEvidence(providerVerification);
  const review = buildBitIndependentReviewManifestEvidence(reviewVerification);
  requireExactReviewLink(provider, review);

  const timestamp = promotedAt instanceof Date ? promotedAt : new Date(promotedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("reviewed BIT manifest promotion time is invalid");
  const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(observed.getTime())) throw new TypeError("reviewed BIT manifest observation time is invalid");
  const promotedAtSeconds = Math.floor(timestamp.getTime() / 1_000);
  const observedAtSeconds = Math.floor(observed.getTime() / 1_000);
  const providerVerifiedAtSeconds = Math.floor(Date.parse(provider.verifiedAt) / 1_000);
  const reviewVerifiedAtSeconds = Math.floor(Date.parse(review.verifiedAt) / 1_000);
  if (promotedAtSeconds < providerVerifiedAtSeconds || promotedAtSeconds < reviewVerifiedAtSeconds) {
    throw new Error("reviewed BIT manifest promotion predates verified evidence");
  }
  if (promotedAtSeconds > observedAtSeconds + BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS) {
    throw new Error("reviewed BIT manifest promotion is future-dated");
  }
  const validUntil = Math.min(provider.validUntil, review.validUntil);
  if (promotedAtSeconds >= validUntil || observedAtSeconds >= validUntil) {
    throw new Error("reviewed BIT evidence expired before promotion");
  }

  const manifest = Object.freeze({
    schema: "treeswap.reviewed-bit-deployment-manifest.v1",
    status: "cryptographically-reviewed-bit-deployment",
    scope: "reviewed-mainnet-bit-deployment-no-funding-authorization",
    sourceCommit: provider.sourceCommit,
    chainId: provider.chainId,
    verifyingContract: provider.verifyingContract,
    finalizedBlock: provider.finalizedBlock,
    stateAnchor: provider.stateAnchor,
    proxy: provider.proxy,
    implementation: provider.implementation,
    token: provider.token,
    providerHeads: provider.providerHeads,
    providerEvidence: Object.freeze({
      recordDigest: provider.recordDigest,
      policyDigest: provider.policyDigest,
      providerSetDigest: provider.providerSetDigest,
      comparisonDigest: provider.comparisonDigest,
      providerCount: provider.providerCount,
    }),
    reviewEvidence: Object.freeze({
      recordDigest: review.reviewRecordDigest,
      policyDigest: review.reviewPolicyDigest,
      reviewerSetDigest: review.reviewerSetDigest,
      artifactSetDigest: review.artifactSetDigest,
      findingCountsDigest: review.findingCountsDigest,
      reviewerCount: review.reviewers.length,
    }),
    reviewArtifacts: review.artifacts,
    findingCounts: review.findingCounts,
    reviewers: review.reviewers,
    promotedAt: promotedAtSeconds,
    validUntil,
    providerIndependenceStatus: review.providerIndependenceStatus,
    fundingAuthorization: false,
  });
  assertSecretFree(manifest);
  const verification = Object.freeze({
    schema: "treeswap.verified-reviewed-bit-deployment-manifest.v1",
    status: manifest.status,
    manifest,
    manifestDigest: digest(manifest),
    promotedAt: timestamp.toISOString(),
    validUntil,
    fundingAuthorization: false,
  });
  verifiedReviewedBitManifests.add(verification);
  return verification;
}

export function buildReviewedBitDeploymentManifestSummary(verification) {
  if (!verifiedReviewedBitManifests.has(verification)) {
    throw new Error("reviewed BIT deployment manifest provenance is invalid");
  }
  const manifest = verification.manifest;
  return Object.freeze({
    schema: "treeswap.reviewed-bit-deployment-manifest-summary.v1",
    status: manifest.status,
    scope: manifest.scope,
    manifestDigest: verification.manifestDigest,
    sourceCommit: manifest.sourceCommit,
    chainId: manifest.chainId,
    verifyingContract: manifest.verifyingContract,
    finalizedBlock: manifest.finalizedBlock,
    stateAnchor: manifest.stateAnchor,
    proxy: manifest.proxy,
    implementation: manifest.implementation,
    token: manifest.token,
    providerHeads: manifest.providerHeads,
    providerEvidence: manifest.providerEvidence,
    reviewEvidence: manifest.reviewEvidence,
    reviewArtifacts: manifest.reviewArtifacts,
    findingCounts: manifest.findingCounts,
    reviewers: manifest.reviewers,
    providerIndependenceStatus: manifest.providerIndependenceStatus,
    promotedAt: manifest.promotedAt,
    validUntil: manifest.validUntil,
    fundingAuthorization: false,
  });
}
