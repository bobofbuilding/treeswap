import { Wallet, id } from "ethers";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES,
  buildWalletSessionRouteDeploymentPreflightMessage,
  verifyWalletSessionRouteDeploymentPreflight,
} from "../../lib/wallet-session-route-deployment-preflight.mjs";
import {
  createVerifiedWalletSessionRouteReviewFixture,
} from "./verified-wallet-session-route-review.mjs";

export const WALLET_SESSION_ROUTE_REVIEWED_AT = 1_800_000_000;
export const WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT = WALLET_SESSION_ROUTE_REVIEWED_AT + 10;
export const WALLET_SESSION_ROUTE_DEPLOYMENT_OBSERVED_AT = WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT + 5;
export const WALLET_SESSION_ROUTE_DEPLOYMENT_OPERATORS = Object.freeze([
  new Wallet(id("wallet session Sites deployment owner")),
  new Wallet(id("wallet session edge operations owner")),
]);

export function createWalletSessionRouteDeploymentPlan(review, overrides = {}) {
  const participants = WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES.map((role, index) => ({
    role,
    participantId: id(`wallet session deployment participant:${index}`).toLowerCase(),
    organizationId: id(`wallet session deployment organization:${index}`).toLowerCase(),
    identityEvidenceDigest: id(`wallet session deployment identity evidence:${index}`).toLowerCase(),
    signer: WALLET_SESSION_ROUTE_DEPLOYMENT_OPERATORS[index].address,
  }));
  return {
    schema: "treeswap.wallet-session-route-deployment-plan.v1",
    status: "private-closed-test-deployment-planned-live-evidence-required",
    scope: "preflight-only-no-deployment-dispatch-settlement-or-funding-authorization",
    environment: "closed-test",
    sourceBranch: review.artifact.sourceBranch,
    sourceCommit: review.artifact.sourceCommit,
    routePath: "/api/internal/wallet-session-read",
    preparedAt: WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT,
    validUntil: WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT + 1_800,
    access: {
      accessClass: "owner-only-private",
      anonymousAccess: false,
      publicBypass: false,
      externalVisitorCount: 0,
      workspaceGroupCount: 0,
      ownerCount: 2,
    },
    bindings: {
      d1Binding: "DB",
      d1DataClass: "non-production-copy",
      d1MigrationRequired: false,
      r2Binding: null,
      schemaChangeRequired: false,
    },
    runtime: {
      routeMode: "closed-test",
      runtimeValuesSource: "sites-runtime-values",
      processEnvironmentFallbackAllowed: false,
      retiringCredentialSlotConfigured: false,
      apiOriginDigest: id("wallet session private API origin").toLowerCase(),
      deploymentIdDigest: id("wallet session private deployment ID").toLowerCase(),
      currentRequesterKeyId: `sha256:${"1".repeat(64)}`,
      currentResponseKeyId: `sha256:${"2".repeat(64)}`,
      gatewayRequesterKeyId: `sha256:${"3".repeat(64)}`,
      gatewayResponseKeyId: `sha256:${"4".repeat(64)}`,
    },
    dataHandling: {
      analyticsBodyCapture: false,
      cdnCaching: false,
      errorBodyRetention: false,
      requestBodyLogging: false,
      requestBodyPersistence: false,
      responseBodyLogging: false,
      responseBodyPersistence: false,
      tracingBodyCapture: false,
      trafficCapture: false,
    },
    controlCommitments: {
      accessPolicyDigest: id("wallet session access policy").toLowerCase(),
      bodyHandlingPolicyDigest: id("wallet session body handling policy").toLowerCase(),
      d1AccessPolicyDigest: id("wallet session D1 access policy").toLowerCase(),
      d1BackupRestorePolicyDigest: id("wallet session D1 backup restore policy").toLowerCase(),
      d1PurgePolicyDigest: id("wallet session D1 purge policy").toLowerCase(),
      incidentDrillPolicyDigest: id("wallet session incident drill policy").toLowerCase(),
      keyCustodyPolicyDigest: id("wallet session key custody policy").toLowerCase(),
      monitoringPolicyDigest: id("wallet session monitoring policy").toLowerCase(),
      versionRetirementPolicyDigest: id("wallet session version retirement policy").toLowerCase(),
    },
    participants,
    ...overrides,
  };
}

export async function createVerifiedWalletSessionRouteDeploymentPreflightFixture({
  planOverrides = {},
  reviewedAt = WALLET_SESSION_ROUTE_REVIEWED_AT,
  reviewObservedAt = WALLET_SESSION_ROUTE_REVIEWED_AT + 5,
  observedAt = WALLET_SESSION_ROUTE_DEPLOYMENT_OBSERVED_AT,
} = {}) {
  const review = await createVerifiedWalletSessionRouteReviewFixture({
    reviewedAt,
    observedAt: reviewObservedAt,
  });
  const plan = createWalletSessionRouteDeploymentPlan(review, planOverrides);
  const attestations = [];
  for (let index = 0; index < WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES.length; index += 1) {
    const role = WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES[index];
    const attestedAt = observedAt - 1 + index;
    const typed = buildWalletSessionRouteDeploymentPreflightMessage({
      routeReviewVerification: review.verification,
      plan,
      role,
      attestedAt,
      observedAt,
    });
    attestations.push({
      role,
      participantId: plan.participants[index].participantId,
      signer: WALLET_SESSION_ROUTE_DEPLOYMENT_OPERATORS[index].address,
      attestedAt,
      signature: await WALLET_SESSION_ROUTE_DEPLOYMENT_OPERATORS[index].signTypedData(
        typed.domain,
        typed.types,
        typed.value,
      ),
    });
  }
  const verification = verifyWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: review.verification,
    plan,
    attestations,
    observedAt,
  });
  return Object.freeze({ review, plan, attestations, verification });
}
