import { Wallet, id } from "ethers";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES,
  buildWalletSessionRouteDeploymentPostflightMessage,
  verifyWalletSessionRouteDeploymentPostflight,
  walletSessionRouteDeploymentPostflightControlSetDigest,
} from "../../lib/wallet-session-route-deployment-postflight.mjs";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT,
  createVerifiedWalletSessionRouteDeploymentPreflightFixture,
} from "./verified-wallet-session-route-deployment-preflight.mjs";

export const WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_DEPLOYED_AT =
  WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT + 10;
export const WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVED_AT =
  WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_DEPLOYED_AT + 10;
export const WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVERS = Object.freeze([
  new Wallet(id("fixture wallet session route Sites platform observer")),
  new Wallet(id("fixture wallet session route wallet edge observer")),
  new Wallet(id("fixture wallet session route privacy data observer")),
]);

function deploymentConfiguration(plan) {
  return structuredClone({
    routePath: plan.routePath,
    access: plan.access,
    bindings: plan.bindings,
    runtime: plan.runtime,
    dataHandling: plan.dataHandling,
    controlCommitments: plan.controlCommitments,
  });
}

export function createWalletSessionRouteDeploymentPostflightEvidence(preflight, overrides = {}) {
  const observers = WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.map((role, index) => ({
    role,
    observerId: id(`fixture wallet session route postflight observer:${index}`).toLowerCase(),
    organizationId: id(`fixture wallet session route postflight organization:${index}`).toLowerCase(),
    identityEvidenceDigest: id(
      `fixture wallet session route postflight identity evidence:${index}`,
    ).toLowerCase(),
    signer: WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVERS[index].address,
  }));
  const reports = WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.map((role, index) => ({
    schema: "treeswap.wallet-session-route-deployment-postflight-report.v1",
    status: "live-private-deployment-controls-passed-no-open-findings",
    role,
    controlSetDigest: walletSessionRouteDeploymentPostflightControlSetDigest(role),
    observedAt: WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVED_AT - 2 + index,
    validUntil: WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVED_AT + 600 + index,
    collectionMethodDigest: id(`fixture wallet session postflight collection:${index}`).toLowerCase(),
    evidenceArtifactDigest: id(`fixture wallet session postflight artifact:${index}`).toLowerCase(),
    evidenceCustodyDigest: id(`fixture wallet session postflight custody:${index}`).toLowerCase(),
    findingsDispositionDigest: id(`fixture wallet session postflight findings:${index}`).toLowerCase(),
    findingCounts: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 1,
      informational: 1,
      open: 0,
    },
  }));
  return {
    schema: "treeswap.wallet-session-route-deployment-postflight-evidence.v1",
    status: "live-private-deployment-observed-independent-review-required",
    scope: "attestation-only-no-platform-proof-deployment-dispatch-settlement-or-funding-authorization",
    environment: "closed-test",
    sourceBranch: preflight.plan.sourceBranch,
    sourceCommit: preflight.plan.sourceCommit,
    preflightEvidenceDigest: preflight.verification.evidenceDigest,
    planDigest: preflight.verification.planDigest,
    deployedAt: WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_DEPLOYED_AT,
    configuration: deploymentConfiguration(preflight.plan),
    observers,
    reports,
    ...overrides,
  };
}

export async function createVerifiedWalletSessionRouteDeploymentPostflightFixture({
  preflightOptions = {},
  evidenceOverrides = {},
  observedAt = WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVED_AT,
} = {}) {
  const preflight = await createVerifiedWalletSessionRouteDeploymentPreflightFixture(preflightOptions);
  const evidence = createWalletSessionRouteDeploymentPostflightEvidence(preflight, evidenceOverrides);
  const attestations = [];
  for (let index = 0; index < WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.length; index += 1) {
    const role = WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES[index];
    const attestedAt = observedAt;
    const typed = buildWalletSessionRouteDeploymentPostflightMessage({
      deploymentPreflightVerification: preflight.verification,
      evidence,
      role,
      attestedAt,
      observedAt,
    });
    attestations.push({
      role,
      observerId: evidence.observers[index].observerId,
      signer: WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVERS[index].address,
      attestedAt,
      signature: await WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVERS[index].signTypedData(
        typed.domain,
        typed.types,
        typed.value,
      ),
    });
  }
  const verification = verifyWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: preflight.verification,
    evidence,
    attestations,
    observedAt,
  });
  return Object.freeze({ preflight, evidence, attestations, verification });
}
