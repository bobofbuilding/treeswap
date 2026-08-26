import {
  verifyWalletSessionRouteDeploymentPostflightAtSignedBoundary,
} from "./wallet-session-route-deployment-postflight.mjs";
import {
  verifyWalletSessionRouteDeploymentPreflightAtSignedBoundary,
} from "./wallet-session-route-deployment-preflight.mjs";
import {
  verifyWalletSessionRouteReviewAtSignedBoundary,
} from "./wallet-session-route-review.mjs";

export function reconstructWalletSessionRouteDeploymentEvidenceChain({
  artifactFileBytes,
  reviewPolicy,
  reviewReports,
  reviewAttestations,
  deploymentPlan,
  deploymentPreflightAttestations,
  deploymentPostflightEvidence,
  deploymentPostflightAttestations,
}) {
  const routeReviewVerification = verifyWalletSessionRouteReviewAtSignedBoundary({
    artifactFileBytes,
    policy: reviewPolicy,
    reports: reviewReports,
    attestations: reviewAttestations,
  });
  const deploymentPreflightVerification =
    verifyWalletSessionRouteDeploymentPreflightAtSignedBoundary({
      routeReviewVerification,
      plan: deploymentPlan,
      attestations: deploymentPreflightAttestations,
    });
  const deploymentPostflightVerification =
    verifyWalletSessionRouteDeploymentPostflightAtSignedBoundary({
      deploymentPreflightVerification,
      evidence: deploymentPostflightEvidence,
      attestations: deploymentPostflightAttestations,
    });
  return Object.freeze({
    schema: "treeswap.reconstructed-wallet-session-route-deployment-evidence-chain.v1",
    status: "signed-boundaries-reconstructed-for-later-independent-live-review",
    scope: "historical-cryptographic-provenance-only-no-current-freshness-platform-proof-or-authority",
    routeReviewVerification,
    deploymentPreflightVerification,
    deploymentPostflightVerification,
  });
}
