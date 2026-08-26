import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  reconstructWalletSessionRouteDeploymentEvidenceChain,
} from "../lib/wallet-session-route-deployment-evidence-chain.mjs";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES,
  assertWalletSessionRouteDeploymentLiveReviewIsSecretFree,
  buildWalletSessionRouteDeploymentLiveReviewMessage,
  buildWalletSessionRouteDeploymentLiveReviewSummary,
  prepareWalletSessionRouteDeploymentLiveReview,
  verifyWalletSessionRouteDeploymentLiveReview,
  walletSessionRouteDeploymentLiveReviewControlSetDigest,
} from "../lib/wallet-session-route-deployment-live-review.mjs";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_OPERATORS,
} from "./fixtures/verified-wallet-session-route-deployment-preflight.mjs";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_DEPLOYED_AT,
  WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVED_AT,
  WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVERS,
  createVerifiedWalletSessionRouteDeploymentPostflightFixture,
} from "./fixtures/verified-wallet-session-route-deployment-postflight.mjs";
import {
  WALLET_SESSION_ROUTE_REVIEWER_WALLETS,
} from "./fixtures/verified-wallet-session-route-review.mjs";

const MONITORING_STARTED_AT = WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_DEPLOYED_AT;
const MONITORING_ENDED_AT = MONITORING_STARTED_AT + 24 * 60 * 60;
const PREPARED_AT = MONITORING_ENDED_AT + 10;
const OBSERVED_AT = PREPARED_AT + 10;
const LIVE_REVIEWERS = Object.freeze([
  new Wallet(id("wallet session route live platform control reviewer")),
  new Wallet(id("wallet session route live wallet security reviewer")),
  new Wallet(id("wallet session route live privacy operations reviewer")),
]);

function livePolicy(postflight, overrides = {}) {
  return {
    schema: "treeswap.wallet-session-route-deployment-live-review-policy.v1",
    status: "independent-live-review-planned-no-activation-authority",
    scope: "live-review-only-no-deployment-dispatch-settlement-gate-opening-or-funding-authorization",
    environment: "closed-test",
    sourceBranch: postflight.preflight.plan.sourceBranch,
    sourceCommit: postflight.preflight.plan.sourceCommit,
    postflightEvidenceDigest: postflight.verification.evidenceDigest,
    postflightRecordDigest: postflight.verification.recordDigest,
    configurationDigest: postflight.verification.record.configurationDigest,
    monitoringWindowStartedAt: MONITORING_STARTED_AT,
    monitoringWindowEndedAt: MONITORING_ENDED_AT,
    preparedAt: PREPARED_AT,
    validUntil: PREPARED_AT + 3_600,
    reviewApprovers: WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES.map((role, index) => ({
      role,
      reviewerId: id(`wallet session route live reviewer:${index}`).toLowerCase(),
      organizationId: id(`wallet session route live reviewer organization:${index}`).toLowerCase(),
      identityEvidenceDigest: id(
        `wallet session route live reviewer identity evidence:${index}`,
      ).toLowerCase(),
      signer: LIVE_REVIEWERS[index].address,
    })),
    ...overrides,
  };
}

function liveReports(overrides = {}) {
  return WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES.map((role, index) => ({
    schema: "treeswap.wallet-session-route-deployment-live-review-report.v1",
    status: "independent-live-controls-passed-no-open-findings",
    role,
    reviewId: id(`wallet session route live review:${index}`).toLowerCase(),
    reportDigest: id(`wallet session route live report:${index}`).toLowerCase(),
    controlSetDigest: walletSessionRouteDeploymentLiveReviewControlSetDigest(role),
    directPlatformQueryDigest: id(`wallet session route live platform query:${index}`).toLowerCase(),
    retainedArtifactInspectionDigest: id(
      `wallet session route live retained artifact inspection:${index}`,
    ).toLowerCase(),
    independenceEvidenceDigest: id(
      `wallet session route live independence evidence:${index}`,
    ).toLowerCase(),
    directReproductionDigest: id(
      `wallet session route live direct reproduction:${index}`,
    ).toLowerCase(),
    monitoringEvidenceDigest: id(
      `wallet session route live monitoring evidence:${index}`,
    ).toLowerCase(),
    findingsDispositionDigest: id(
      `wallet session route live findings disposition:${index}`,
    ).toLowerCase(),
    findingCounts: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 1,
      informational: 1,
      open: 0,
    },
    reviewedAt: PREPARED_AT + index,
    validUntil: PREPARED_AT + 1_800 + index,
    ...overrides[index],
  }));
}

async function signedFixture({ policyOverrides = {}, reportOverrides = {} } = {}) {
  const postflight = await createVerifiedWalletSessionRouteDeploymentPostflightFixture();
  const policy = livePolicy(postflight, policyOverrides);
  const reports = liveReports(reportOverrides);
  const attestations = [];
  for (let index = 0; index < WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES.length; index += 1) {
    const role = WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES[index];
    const typed = buildWalletSessionRouteDeploymentLiveReviewMessage({
      deploymentPostflightVerification: postflight.verification,
      policy,
      reports,
      role,
      attestedAt: OBSERVED_AT,
      observedAt: OBSERVED_AT,
    });
    attestations.push({
      role,
      reviewerId: policy.reviewApprovers[index].reviewerId,
      signer: LIVE_REVIEWERS[index].address,
      attestedAt: OBSERVED_AT,
      signature: await LIVE_REVIEWERS[index].signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return { postflight, policy, reports, attestations };
}

test("verifies three live-review claims while retaining every verifier and authority limitation", async () => {
  const fixture = await signedFixture();
  const chain = reconstructWalletSessionRouteDeploymentEvidenceChain({
    artifactFileBytes: fixture.postflight.preflight.review.artifactFileBytes,
    reviewPolicy: fixture.postflight.preflight.review.policy,
    reviewReports: fixture.postflight.preflight.review.reports,
    reviewAttestations: fixture.postflight.preflight.review.attestations,
    deploymentPlan: fixture.postflight.preflight.plan,
    deploymentPreflightAttestations: fixture.postflight.preflight.attestations,
    deploymentPostflightEvidence: fixture.postflight.evidence,
    deploymentPostflightAttestations: fixture.postflight.attestations,
  });
  assert.equal(
    chain.deploymentPostflightVerification.evidenceDigest,
    fixture.postflight.verification.evidenceDigest,
  );
  const verification = verifyWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: chain.deploymentPostflightVerification,
    policy: fixture.policy,
    reports: fixture.reports,
    attestations: fixture.attestations,
    observedAt: OBSERVED_AT,
  });
  assert.equal(verification.reviewerCount, 3);
  assert.equal(Object.values(verification.attestedReviewConclusions).every((value) => value === true), true);
  assert.equal(Object.values(verification.verifierLimitations).every((value) => value === false), true);
  assert.equal(Object.values(verification.authorizations).every((value) => value === false), true);
  const summary = buildWalletSessionRouteDeploymentLiveReviewSummary(verification);
  assert.equal(summary.monitoringWindowEndedAt - summary.monitoringWindowStartedAt, 86_400);
  assert.equal("record" in summary, false);
  assert.throws(
    () => buildWalletSessionRouteDeploymentLiveReviewSummary(structuredClone(verification)),
    /provenance/,
  );
});

test("requires original postflight provenance, exact identity, and a bounded 24-hour monitoring window", async () => {
  const fixture = await signedFixture();
  const prepare = (policy) => prepareWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: fixture.postflight.verification,
    policy,
    reports: fixture.reports,
    observedAt: OBSERVED_AT,
  });
  assert.throws(() => prepareWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: structuredClone(fixture.postflight.verification),
    policy: fixture.policy,
    reports: fixture.reports,
    observedAt: OBSERVED_AT,
  }), /postflight provenance/);
  assert.throws(() => prepare({
    ...fixture.policy,
    sourceCommit: "b".repeat(40),
  }), /policy identity is invalid/);
  assert.throws(() => prepare({
    ...fixture.policy,
    monitoringWindowEndedAt: fixture.policy.monitoringWindowEndedAt - 1,
  }), /timing is invalid/);
  assert.throws(() => prepare({
    ...fixture.policy,
    monitoringWindowEndedAt: WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVED_AT + 7 * 86_400 + 1,
    preparedAt: WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVED_AT + 7 * 86_400 + 1,
    validUntil: WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVED_AT + 7 * 86_400 + 100,
  }), /timing is invalid/);
});

test("rejects live-review overlap with every upstream role and with another live reviewer", async () => {
  const fixture = await signedFixture();
  const prepare = (reviewApprovers) => prepareWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: fixture.postflight.verification,
    policy: { ...fixture.policy, reviewApprovers },
    reports: fixture.reports,
    observedAt: OBSERVED_AT,
  });
  for (const upstreamSigner of [
    WALLET_SESSION_ROUTE_REVIEWER_WALLETS[0].address,
    WALLET_SESSION_ROUTE_DEPLOYMENT_OPERATORS[0].address,
    WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_OBSERVERS[0].address,
  ]) {
    assert.throws(() => prepare(fixture.policy.reviewApprovers.map((reviewer, index) => index === 0
      ? { ...reviewer, signer: upstreamSigner }
      : reviewer)), /reuse upstream participant signers/);
  }
  assert.throws(() => prepare(fixture.policy.reviewApprovers.map((reviewer, index) => index === 2
    ? { ...reviewer, reviewerId: fixture.policy.reviewApprovers[0].reviewerId }
    : reviewer)), /commitments must be globally distinct/);
});

test("rejects missing controls, open findings, reused evidence, and invalid report timing", async () => {
  const fixture = await signedFixture();
  const prepare = (reports) => prepareWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: fixture.postflight.verification,
    policy: fixture.policy,
    reports,
    observedAt: OBSERVED_AT,
  });
  assert.throws(() => prepare(fixture.reports.map((report, index) => index === 0
    ? { ...report, controlSetDigest: id("wrong live controls").toLowerCase() }
    : report)), /control set is invalid/);
  assert.throws(() => prepare(fixture.reports.map((report, index) => index === 1
    ? { ...report, findingCounts: { ...report.findingCounts, open: 1 } }
    : report)), /zero critical, high, medium, and open/);
  assert.throws(() => prepare(fixture.reports.map((report, index) => index === 2
    ? { ...report, reportDigest: fixture.reports[0].reportDigest }
    : report)), /commitments must be globally distinct/);
  assert.throws(() => prepare(fixture.reports.map((report, index) => index === 0
    ? { ...report, reviewedAt: fixture.policy.preparedAt - 1 }
    : report)), /report timing is invalid/);
});

test("rejects missing, reordered, copied, mutated, future, and expired attestations", async () => {
  const fixture = await signedFixture();
  const verify = (overrides = {}) => verifyWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: fixture.postflight.verification,
    policy: fixture.policy,
    reports: fixture.reports,
    attestations: fixture.attestations,
    observedAt: OBSERVED_AT,
    ...overrides,
  });
  assert.throws(() => verify({ attestations: fixture.attestations.slice(0, 2) }), /length 3/);
  assert.throws(() => verify({ attestations: [...fixture.attestations].reverse() }), /canonical roles/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((attestation, index) => index === 2
      ? { ...attestation, signature: fixture.attestations[0].signature }
      : attestation),
  }), /signature is invalid/);
  assert.throws(() => verify({
    reports: fixture.reports.map((report, index) => index === 0
      ? { ...report, directReproductionDigest: id("mutated live reproduction").toLowerCase() }
      : report),
  }), /signature is invalid/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((attestation, index) => index === 0
      ? { ...attestation, attestedAt: OBSERVED_AT + 1 }
      : attestation),
  }), /attestation time is invalid/);
  assert.throws(() => verify({ observedAt: fixture.reports[0].validUntil + 10 }), /expired|timing is invalid/);
});

test("rejects secret-bearing, extensible, decorated, accessor, and coercible inputs", async () => {
  const fixture = await signedFixture();
  assert.throws(
    () => assertWalletSessionRouteDeploymentLiveReviewIsSecretFree({ privateKey: "forbidden" }),
    /forbidden field/,
  );
  assert.throws(
    () => assertWalletSessionRouteDeploymentLiveReviewIsSecretFree({ note: "https://secret.invalid" }),
    /endpoint material/,
  );
  assert.throws(() => prepareWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: fixture.postflight.verification,
    policy: { ...fixture.policy, note: "extension" },
    reports: fixture.reports,
    observedAt: OBSERVED_AT,
  }), /fields are not exact/);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "toString", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return () => "hidden";
    },
  });
  assert.throws(() => prepareWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: fixture.postflight.verification,
    policy: {
      ...fixture.policy,
      reviewApprovers: fixture.policy.reviewApprovers.map((reviewer, index) => index === 0
        ? { ...reviewer, reviewerId: accessor }
        : reviewer),
    },
    reports: fixture.reports,
    observedAt: OBSERVED_AT,
  }), /must be a string/);
  assert.equal(getterCalls, 0);

  const decoratedReports = [...fixture.reports];
  decoratedReports.note = "not canonical";
  assert.throws(() => prepareWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: fixture.postflight.verification,
    policy: fixture.policy,
    reports: decoratedReports,
    observedAt: OBSERVED_AT,
  }), /exact dense array/);
});
