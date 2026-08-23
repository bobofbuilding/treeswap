import { Wallet, id } from "ethers";
import {
  RELEASE_QUALIFICATION_CAMPAIGN_NAMES,
  RELEASE_QUALIFICATION_CONFIGURATION_FILES,
  buildQualificationEvidence,
  hashQualificationFile,
} from "../../lib/qualification-evidence.mjs";
import { buildProductionDurationEvidence } from "../../lib/production-duration-evidence.mjs";
import {
  buildQualificationReviewAttestationMessage,
  verifyQualificationReviewEvidence,
} from "../../lib/qualification-review-evidence.mjs";

const REVIEWER = new Wallet(id("independent qualification artifact reviewer"));

function configurationHashes() {
  return Object.fromEntries(RELEASE_QUALIFICATION_CONFIGURATION_FILES.map((name, index) => [
    name,
    `sha256:${(index + 1).toString(16).padStart(64, "0")}`,
  ]));
}

export function qualificationArtifact({ sourceCommit, finishedAt }) {
  const qualificationFinishedAt = finishedAt - 20;
  const qualificationStartedAt = qualificationFinishedAt - 3_700;
  return buildQualificationEvidence({
    branch: "main",
    sourceCommit,
    startedAt: new Date(qualificationStartedAt * 1_000).toISOString(),
    finishedAt: new Date(qualificationFinishedAt * 1_000).toISOString(),
    runtimeVersions: {
      node: "v22.19.0",
      docker: "28.4.0",
      dockerCompose: "2.39.0",
      forge: "forge 1.4.4",
    },
    pinnedImages: [
      `bitcoin/bitcoin:31.1@sha256:${"1".repeat(64)}`,
      `lightninglabs/lnd:v0.21.2-beta@sha256:${"2".repeat(64)}`,
      `node:22.19.0-alpine@sha256:${"3".repeat(64)}`,
    ],
    configurationHashes: configurationHashes(),
    campaigns: RELEASE_QUALIFICATION_CAMPAIGN_NAMES.map((name) => ({ name, status: "passed" })),
    productionDurationEvidence: buildProductionDurationEvidence({
      sourceCommit,
      startedAtEpochSeconds: qualificationStartedAt + 30,
      finishedAtEpochSeconds: qualificationStartedAt + 3_634,
      maximumObservationGapSeconds: 32,
      monotonicElapsedSeconds: 3_604,
      observationCount: 119,
      restartElapsedSeconds: 1_814,
    }),
  });
}

export async function createVerifiedQualificationReviewFixture({
  deployment,
  fundingMode,
  protocolVersion = "1.0.0-testnet.1",
  reviewerWallet = REVIEWER,
  reviewedAt,
  now = reviewedAt + 10,
}) {
  const artifact = qualificationArtifact({
    sourceCommit: deployment.verification.record.reviewedBuildCommit,
    finishedAt: reviewedAt,
  });
  const qualificationFileBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const policy = {
    schema: "treeswap.qualification-review-policy.v1",
    environment: "public-testnet",
    fundingMode,
    chainId: deployment.verification.record.chainId,
    verifyingContract: deployment.verification.record.verifyingContract,
    protocolVersion,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    reviewerId: id(`qualification reviewer:${fundingMode}`).toLowerCase(),
    reviewerOrganizationId: id(`qualification reviewer organization:${fundingMode}`).toLowerCase(),
    reviewerIdentityEvidenceDigest: id(`qualification reviewer identity evidence:${fundingMode}`).toLowerCase(),
    reviewer: reviewerWallet.address,
    maximumQualificationAgeSeconds: 86_400,
    maximumReviewLifetimeSeconds: 7_200,
  };
  const review = {
    schema: "treeswap.qualification-review.v1",
    status: "passed-no-open-findings",
    reviewId: id(`qualification review:${fundingMode}:${reviewedAt}`).toLowerCase(),
    qualificationFileDigest: hashQualificationFile(qualificationFileBytes),
    reportDigest: id(`qualification review report:${fundingMode}`).toLowerCase(),
    findingsDispositionDigest: id(`qualification findings disposition:${fundingMode}`).toLowerCase(),
    reviewedAt,
    validUntil: reviewedAt + 7_200,
  };
  const typed = buildQualificationReviewAttestationMessage({ qualificationFileBytes, review, policy });
  const attestation = {
    reviewerId: policy.reviewerId,
    signer: reviewerWallet.address,
    signature: await reviewerWallet.signTypedData(typed.domain, typed.types, typed.value),
  };
  const verification = verifyQualificationReviewEvidence({
    qualificationFileBytes,
    review,
    policy,
    attestation,
    now,
  });
  return Object.freeze({ artifact, attestation, policy, qualificationFileBytes, review, verification });
}
