import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES,
  assertWalletSessionRouteDeploymentPostflightIsSecretFree,
  buildWalletSessionRouteDeploymentPostflightMessage,
  buildWalletSessionRouteDeploymentLiveReviewEvidence,
  buildWalletSessionRouteDeploymentPostflightSummary,
  prepareWalletSessionRouteDeploymentPostflight,
  verifyWalletSessionRouteDeploymentPostflight,
  verifyWalletSessionRouteDeploymentPostflightAtSignedBoundary,
  walletSessionRouteDeploymentPostflightControlSetDigest,
} from "../lib/wallet-session-route-deployment-postflight.mjs";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_OPERATORS,
  WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT,
  createVerifiedWalletSessionRouteDeploymentPreflightFixture,
} from "./fixtures/verified-wallet-session-route-deployment-preflight.mjs";
import { WALLET_SESSION_ROUTE_REVIEWER_WALLETS } from "./fixtures/verified-wallet-session-route-review.mjs";

const DEPLOYED_AT = WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT + 10;
const OBSERVED_AT = DEPLOYED_AT + 10;
const OBSERVERS = Object.freeze([
  new Wallet(id("wallet session route Sites platform observer")),
  new Wallet(id("wallet session route wallet edge observer")),
  new Wallet(id("wallet session route privacy data observer")),
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

function postflightEvidence(preflight, overrides = {}) {
  const observers = WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.map((role, index) => ({
    role,
    observerId: id(`wallet session route postflight observer:${index}`).toLowerCase(),
    organizationId: id(`wallet session route postflight organization:${index}`).toLowerCase(),
    identityEvidenceDigest: id(`wallet session route postflight identity evidence:${index}`).toLowerCase(),
    signer: OBSERVERS[index].address,
  }));
  const reports = WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.map((role, index) => ({
    schema: "treeswap.wallet-session-route-deployment-postflight-report.v1",
    status: "live-private-deployment-controls-passed-no-open-findings",
    role,
    controlSetDigest: walletSessionRouteDeploymentPostflightControlSetDigest(role),
    observedAt: OBSERVED_AT - 2 + index,
    validUntil: OBSERVED_AT + 600 + index,
    collectionMethodDigest: id(`wallet session postflight collection method:${index}`).toLowerCase(),
    evidenceArtifactDigest: id(`wallet session postflight evidence artifact:${index}`).toLowerCase(),
    evidenceCustodyDigest: id(`wallet session postflight evidence custody:${index}`).toLowerCase(),
    findingsDispositionDigest: id(`wallet session postflight findings:${index}`).toLowerCase(),
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
    deployedAt: DEPLOYED_AT,
    configuration: deploymentConfiguration(preflight.plan),
    observers,
    reports,
    ...overrides,
  };
}

async function signedFixture(evidenceOverrides = {}) {
  const preflight = await createVerifiedWalletSessionRouteDeploymentPreflightFixture();
  const evidence = postflightEvidence(preflight, evidenceOverrides);
  const attestations = [];
  for (let index = 0; index < WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.length; index += 1) {
    const role = WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES[index];
    const typed = buildWalletSessionRouteDeploymentPostflightMessage({
      deploymentPreflightVerification: preflight.verification,
      evidence,
      role,
      observedAt: OBSERVED_AT,
    });
    attestations.push({
      role,
      observerId: evidence.observers[index].observerId,
      signer: OBSERVERS[index].address,
      attestedAt: OBSERVED_AT,
      signature: await OBSERVERS[index].signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return { preflight, evidence, attestations };
}

test("verifies three accountable live claims while retaining every external and authority limitation", async () => {
  const fixture = await signedFixture();
  const verification = verifyWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: fixture.evidence,
    attestations: fixture.attestations,
    observedAt: OBSERVED_AT,
  });
  assert.equal(verification.observerCount, 3);
  assert.equal(Object.values(verification.attestedClaims).every((value) => value === true), true);
  assert.equal(Object.values(verification.externalVerification).every((value) => value === false), true);
  assert.equal(Object.values(verification.authorizations).every((value) => value === false), true);
  const summary = buildWalletSessionRouteDeploymentPostflightSummary(verification);
  assert.equal(summary.sourceCommit, fixture.preflight.plan.sourceCommit);
  assert.equal("record" in summary, false);
  const historicalVerification = verifyWalletSessionRouteDeploymentPostflightAtSignedBoundary({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: fixture.evidence,
    attestations: fixture.attestations,
  });
  assert.equal(historicalVerification.verifiedAt, OBSERVED_AT);
  const liveReviewEvidence = buildWalletSessionRouteDeploymentLiveReviewEvidence(historicalVerification);
  assert.equal(liveReviewEvidence.reviewers.length, 2);
  assert.equal(liveReviewEvidence.operators.length, 2);
  assert.equal(liveReviewEvidence.observers.length, 3);
  assert.throws(
    () => buildWalletSessionRouteDeploymentLiveReviewEvidence(structuredClone(historicalVerification)),
    /provenance/,
  );
  assert.throws(
    () => buildWalletSessionRouteDeploymentPostflightSummary(structuredClone(verification)),
    /provenance/,
  );
});

test("requires original preflight provenance and the exact planned private configuration", async () => {
  const fixture = await signedFixture();
  assert.throws(() => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: structuredClone(fixture.preflight.verification),
    evidence: fixture.evidence,
    observedAt: OBSERVED_AT,
  }), /preflight provenance/);
  assert.throws(() => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: { ...fixture.evidence, sourceCommit: "b".repeat(40) },
    observedAt: OBSERVED_AT,
  }), /identity is invalid/);
  assert.throws(() => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: {
      ...fixture.evidence,
      configuration: {
        ...fixture.evidence.configuration,
        access: { ...fixture.evidence.configuration.access, publicBypass: true },
      },
    },
    observedAt: OBSERVED_AT,
  }), /does not match the signed deployment plan/);
  assert.throws(() => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: { ...fixture.evidence, deployedAt: WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT - 1 },
    observedAt: OBSERVED_AT,
  }), /outside its signed preflight/);
  assert.throws(() => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: {
      ...fixture.evidence,
      deployedAt: fixture.preflight.verification.attestedThrough - 1,
    },
    observedAt: OBSERVED_AT,
  }), /outside its signed preflight/);
});

test("rejects observer overlap with reviewers, operators, and each other", async () => {
  const fixture = await signedFixture();
  const prepare = (observers) => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: { ...fixture.evidence, observers },
    observedAt: OBSERVED_AT,
  });
  const reviewerOverlap = fixture.evidence.observers.map((observer, index) => index === 0
    ? { ...observer, signer: WALLET_SESSION_ROUTE_REVIEWER_WALLETS[0].address }
    : observer);
  assert.throws(() => prepare(reviewerOverlap), /reuse reviewer or operator signers/);
  const operatorOverlap = fixture.evidence.observers.map((observer, index) => index === 1
    ? { ...observer, signer: WALLET_SESSION_ROUTE_DEPLOYMENT_OPERATORS[0].address }
    : observer);
  assert.throws(() => prepare(operatorOverlap), /reuse reviewer or operator signers/);
  const identityOverlap = fixture.evidence.observers.map((observer, index) => index === 2
    ? { ...observer, observerId: fixture.evidence.observers[0].observerId }
    : observer);
  assert.throws(() => prepare(identityOverlap), /commitments must be globally distinct/);
});

test("rejects missing controls, open findings, stale reports, and observation spread", async () => {
  const fixture = await signedFixture();
  const prepare = (reports, observedAt = OBSERVED_AT) => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: { ...fixture.evidence, reports },
    observedAt,
  });
  const wrongControl = fixture.evidence.reports.map((report, index) => index === 0
    ? { ...report, controlSetDigest: id("wrong postflight control set").toLowerCase() }
    : report);
  assert.throws(() => prepare(wrongControl), /control set is invalid/);
  const openFinding = fixture.evidence.reports.map((report, index) => index === 1
    ? { ...report, findingCounts: { ...report.findingCounts, open: 1 } }
    : report);
  assert.throws(() => prepare(openFinding), /zero critical, high, medium, and open/);
  const stale = fixture.evidence.reports.map((report) => ({
    ...report,
    observedAt: OBSERVED_AT - 601,
    validUntil: OBSERVED_AT + 1,
  }));
  assert.throws(() => prepare(stale), /timing is invalid/);
  const spread = fixture.evidence.reports.map((report, index) => index === 2
    ? { ...report, observedAt: report.observedAt + 121, validUntil: report.validUntil + 121 }
    : report);
  assert.throws(() => prepare(spread, OBSERVED_AT + 121), /too widely separated/);
});

test("rejects missing, reordered, copied, mutated, future, and expired attestations", async () => {
  const fixture = await signedFixture();
  const verify = (overrides = {}) => verifyWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: fixture.evidence,
    attestations: fixture.attestations,
    observedAt: OBSERVED_AT,
    ...overrides,
  });
  assert.throws(() => verify({ attestations: fixture.attestations.slice(0, 2) }), /length 3/);
  assert.throws(() => verify({ attestations: [...fixture.attestations].reverse() }), /canonical roles/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((attestation, index) => index === 0
      ? { ...attestation, attestedAt: fixture.evidence.reports[0].observedAt - 1 }
      : attestation),
  }), /attestation time is invalid/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((attestation, index) => index === 1
      ? { ...attestation, attestedAt: OBSERVED_AT + 1 }
      : attestation),
  }), /attestation time is invalid/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((attestation, index) => index === 2
      ? { ...attestation, signature: fixture.attestations[0].signature }
      : attestation),
  }), /signature is invalid/);
  const mutatedEvidence = {
    ...fixture.evidence,
    reports: fixture.evidence.reports.map((report, index) => index === 0
      ? { ...report, evidenceArtifactDigest: id("mutated live artifact").toLowerCase() }
      : report),
  };
  assert.throws(() => verify({ evidence: mutatedEvidence }), /signature is invalid/);
  assert.throws(() => verify({ observedAt: OBSERVED_AT - 3 }), /future/);
  assert.throws(
    () => verify({ observedAt: fixture.evidence.reports[0].validUntil + 3 }),
    /expired|timing is invalid/,
  );
});

test("rejects secret-bearing, extensible, decorated, accessor, and coercible inputs", async () => {
  const fixture = await signedFixture();
  assert.throws(
    () => assertWalletSessionRouteDeploymentPostflightIsSecretFree({ privateKey: "forbidden" }),
    /forbidden field/,
  );
  assert.throws(
    () => assertWalletSessionRouteDeploymentPostflightIsSecretFree({ note: "https://secret.invalid" }),
    /endpoint material/,
  );
  assert.throws(() => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: { ...fixture.evidence, note: "extension" },
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
  const coercibleObservers = fixture.evidence.observers.map((observer, index) => index === 0
    ? { ...observer, observerId: accessor }
    : observer);
  assert.throws(() => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: { ...fixture.evidence, observers: coercibleObservers },
    observedAt: OBSERVED_AT,
  }), /must be a string/);
  assert.equal(getterCalls, 0);

  const decoratedReports = [...fixture.evidence.reports];
  decoratedReports.note = "not canonical";
  assert.throws(() => prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification: fixture.preflight.verification,
    evidence: { ...fixture.evidence, reports: decoratedReports },
    observedAt: OBSERVED_AT,
  }), /exact dense array/);
});
