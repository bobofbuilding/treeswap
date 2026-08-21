import { Wallet, id } from "ethers";
import {
  INDEPENDENT_REVIEW_ROLES,
  buildIndependentReviewAttestationMessage,
  verifyIndependentReviewEvidence,
} from "../../lib/independent-review-evidence.mjs";

const ROLE_TO_REPORT_FIELD = Object.freeze({
  contracts: "contracts",
  coordinator: "coordinator",
  "identity-privacy": "identityPrivacy",
  lightning: "lightning",
  operations: "operations",
});

function canonical(values, selector) {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right)));
}

export function fixture({
  deployment,
  finishedAt,
  protocolVersion = "1.0.0-testnet.1",
  validUntil = finishedAt + 4_000,
}) {
  if (!deployment?.verification || !Number.isSafeInteger(finishedAt)) {
    throw new TypeError("verified deployment and finishedAt are required");
  }
  const wallets = new Map();
  const participants = INDEPENDENT_REVIEW_ROLES.map((role, index) => {
    const wallet = new Wallet(id(`independent ${role} reviewer wallet ${index}`));
    wallets.set(wallet.address, wallet);
    return {
      role,
      reviewerId: id(`independent ${role} reviewer identity`).toLowerCase(),
      organizationId: id(`independent ${role} review organization`).toLowerCase(),
      signer: wallet.address,
      evidenceDigest: id(`retained independent ${role} reviewer evidence`).toLowerCase(),
    };
  });
  const reports = {};
  for (const role of INDEPENDENT_REVIEW_ROLES) {
    const field = ROLE_TO_REPORT_FIELD[role];
    reports[field] = {
      reportDigest: id(`independent ${role} report`).toLowerCase(),
      findingsDispositionDigest: id(`independent ${role} findings disposition`).toLowerCase(),
      findingCount: 3,
      fixedFindingCount: 2,
      acceptedRiskCount: 1,
      notApplicableFindingCount: 0,
      openFindingCount: 0,
      acceptedCriticalRiskCount: 0,
      acceptedHighRiskCount: 0,
    };
  }
  const record = {
    schema: "treeswap.independent-review-evidence.v1",
    reviewId: id(`independent review:${finishedAt}`).toLowerCase(),
    environment: "public-testnet",
    chainId: deployment.verification.record.chainId,
    verifyingContract: deployment.verification.record.verifyingContract,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    protocolVersion,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    startedAt: finishedAt - 86_400,
    finishedAt,
    validUntil,
    participants: canonical(participants, (value) => value.role),
    reports,
  };
  const policy = {
    schema: "treeswap.independent-review-evidence-policy.v1",
    environment: record.environment,
    chainId: record.chainId,
    verifyingContract: record.verifyingContract,
    reviewedBuildCommit: record.reviewedBuildCommit,
    protocolVersion: record.protocolVersion,
    deploymentManifestDigest: record.deploymentManifestDigest,
    maximumEvidenceAgeSeconds: 86_400,
    maximumEvidenceLifetimeSeconds: 604_800,
    maximumFindingsPerReview: 100,
  };
  return { attestations: [], policy, record, wallets };
}

export async function sign(value) {
  value.attestations = [];
  for (const participant of value.record.participants) {
    const typed = buildIndependentReviewAttestationMessage({
      record: value.record,
      policy: value.policy,
      role: participant.role,
      reviewerId: participant.reviewerId,
    });
    const wallet = value.wallets.get(participant.signer);
    value.attestations.push({
      role: participant.role,
      reviewerId: participant.reviewerId,
      signer: participant.signer,
      signature: await wallet.signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  value.attestations = canonical(value.attestations, (item) => item.role);
  return value;
}

export async function createVerifiedIndependentReviewFixture({
  deployment,
  finishedAt,
  now = finishedAt + 40,
  protocolVersion,
  validUntil,
}) {
  const candidate = await sign(fixture({ deployment, finishedAt, protocolVersion, validUntil }));
  const verification = verifyIndependentReviewEvidence({ ...candidate, now });
  return Object.freeze({ candidate, verification });
}
