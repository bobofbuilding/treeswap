import { Wallet, id } from "ethers";
import {
  WALLET_SESSION_ROUTE_REVIEW_FILES,
  WALLET_SESSION_ROUTE_REVIEW_ROLES,
  buildWalletSessionRouteReviewApprovalMessage,
  buildWalletSessionRouteReviewArtifact,
  hashWalletSessionRouteReviewArtifactFile,
  serializeWalletSessionRouteReviewArtifact,
  verifyWalletSessionRouteReview,
  walletSessionRouteReviewControlSetDigest,
} from "../../lib/wallet-session-route-review.mjs";

export const WALLET_SESSION_ROUTE_REVIEWER_WALLETS = Object.freeze([
  new Wallet(id("fixture wallet session route application security reviewer")),
  new Wallet(id("fixture wallet session route platform data isolation reviewer")),
]);

function sourceFiles() {
  return Object.fromEntries(WALLET_SESSION_ROUTE_REVIEW_FILES.map((path) => [
    path,
    Buffer.from(`fixture exact source:${path}\n`),
  ]));
}

export async function createVerifiedWalletSessionRouteReviewFixture({
  sourceBranch = "codex/wallet-session-route-review",
  sourceCommit = "a".repeat(40),
  reviewedAt = 1_800_000_000,
  validForSeconds = 3_600,
  observedAt = reviewedAt + 5,
} = {}) {
  const artifact = buildWalletSessionRouteReviewArtifact({
    sourceBranch,
    sourceCommit,
    sourceFiles: sourceFiles(),
  });
  const artifactFileBytes = serializeWalletSessionRouteReviewArtifact(artifact);
  const policy = {
    schema: "treeswap.wallet-session-route-review-policy.v1",
    environment: "closed-test",
    reviewScope: "repository-only",
    deploymentEvidenceRequired: true,
    sourceBranch,
    sourceCommit,
    artifactFileDigest: hashWalletSessionRouteReviewArtifactFile(artifactFileBytes),
    maximumReviewLifetimeSeconds: validForSeconds,
    reviewApprovers: WALLET_SESSION_ROUTE_REVIEW_ROLES.map((role, index) => ({
      role,
      reviewerId: id(`fixture wallet session reviewer:${index}`).toLowerCase(),
      organizationId: id(`fixture wallet session reviewer organization:${index}`).toLowerCase(),
      identityEvidenceDigest: id(`fixture wallet session reviewer identity evidence:${index}`).toLowerCase(),
      signer: WALLET_SESSION_ROUTE_REVIEWER_WALLETS[index].address,
    })),
  };
  const reports = WALLET_SESSION_ROUTE_REVIEW_ROLES.map((role, index) => ({
    schema: "treeswap.wallet-session-route-review-report.v1",
    status: "repository-scope-passed-no-open-findings",
    role,
    reviewId: id(`fixture wallet session review:${index}`).toLowerCase(),
    reportDigest: id(`fixture wallet session review report:${index}`).toLowerCase(),
    findingsDispositionDigest: id(`fixture wallet session findings:${index}`).toLowerCase(),
    controlSetDigest: walletSessionRouteReviewControlSetDigest(role),
    findingCounts: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 1,
      informational: 1,
      open: 0,
    },
    reviewedAt: reviewedAt + index,
    validUntil: reviewedAt + validForSeconds + index,
  }));
  const attestations = [];
  for (let index = 0; index < WALLET_SESSION_ROUTE_REVIEW_ROLES.length; index += 1) {
    const role = WALLET_SESSION_ROUTE_REVIEW_ROLES[index];
    const typed = buildWalletSessionRouteReviewApprovalMessage({
      artifactFileBytes,
      policy,
      reports,
      role,
    });
    attestations.push({
      role,
      reviewerId: policy.reviewApprovers[index].reviewerId,
      signer: WALLET_SESSION_ROUTE_REVIEWER_WALLETS[index].address,
      signature: await WALLET_SESSION_ROUTE_REVIEWER_WALLETS[index].signTypedData(
        typed.domain,
        typed.types,
        typed.value,
      ),
    });
  }
  const verification = verifyWalletSessionRouteReview({
    artifactFileBytes,
    policy,
    reports,
    attestations,
    observedAt,
  });
  return Object.freeze({ artifact, artifactFileBytes, policy, reports, attestations, verification });
}
