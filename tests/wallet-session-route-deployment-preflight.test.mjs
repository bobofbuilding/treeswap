import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import {
  assertWalletSessionRouteDeploymentPreflightIsSecretFree,
  buildWalletSessionRouteDeploymentPreflightMessage,
  buildWalletSessionRouteDeploymentPostflightEvidence,
  buildWalletSessionRouteDeploymentPreflightSummary,
  prepareWalletSessionRouteDeploymentPreflight,
  verifyWalletSessionRouteDeploymentPreflight,
} from "../lib/wallet-session-route-deployment-preflight.mjs";
import {
  WALLET_SESSION_ROUTE_REVIEWER_WALLETS,
  createVerifiedWalletSessionRouteReviewFixture,
} from "./fixtures/verified-wallet-session-route-review.mjs";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_OBSERVED_AT as OBSERVED_AT,
  WALLET_SESSION_ROUTE_DEPLOYMENT_PREPARED_AT as PREPARED_AT,
  WALLET_SESSION_ROUTE_REVIEWED_AT as REVIEWED_AT,
  createVerifiedWalletSessionRouteDeploymentPreflightFixture,
  createWalletSessionRouteDeploymentPlan,
} from "./fixtures/verified-wallet-session-route-deployment-preflight.mjs";

async function signedFixture(planOverrides = {}) {
  return createVerifiedWalletSessionRouteDeploymentPreflightFixture({ planOverrides });
}

test("verifies one reviewed private closed-test plan while every live fact and authority stays false", async () => {
  const fixture = await signedFixture();
  const verification = verifyWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: fixture.plan,
    attestations: fixture.attestations,
    observedAt: OBSERVED_AT,
  });
  assert.equal(verification.participantCount, 2);
  assert.equal(verification.status.includes("live-platform-evidence-still-required"), true);
  assert.equal(Object.values(verification.externalEvidence).every((value) => value === false), true);
  assert.equal(Object.values(verification.authorizations).every((value) => value === false), true);
  const summary = buildWalletSessionRouteDeploymentPreflightSummary(verification);
  assert.equal(summary.sourceCommit, fixture.review.artifact.sourceCommit);
  assert.equal("plan" in summary, false);
  const postflightEvidence = buildWalletSessionRouteDeploymentPostflightEvidence(verification);
  assert.equal(postflightEvidence.configuration.runtime.routeMode, "closed-test");
  assert.equal(postflightEvidence.reviewers.length, 2);
  assert.equal(postflightEvidence.operators.length, 2);
  const defaultTimestampMessage = buildWalletSessionRouteDeploymentPreflightMessage({
    routeReviewVerification: fixture.review.verification,
    plan: fixture.plan,
    role: fixture.plan.participants[0].role,
    observedAt: OBSERVED_AT,
  });
  assert.equal(defaultTimestampMessage.value.attestedAt, OBSERVED_AT);
  assert.throws(
    () => buildWalletSessionRouteDeploymentPreflightSummary(structuredClone(verification)),
    /provenance/,
  );
  assert.throws(
    () => buildWalletSessionRouteDeploymentPostflightEvidence(structuredClone(verification)),
    /provenance/,
  );
});

test("requires live route-review provenance and a causally bounded plan", async () => {
  const fixture = await signedFixture();
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: structuredClone(fixture.review.verification),
    plan: fixture.plan,
    observedAt: OBSERVED_AT,
  }), /review verification provenance/);
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: { ...fixture.plan, sourceCommit: "b".repeat(40) },
    observedAt: OBSERVED_AT,
  }), /does not match the reviewed source/);
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: { ...fixture.plan, preparedAt: REVIEWED_AT - 1 },
    observedAt: OBSERVED_AT,
  }), /stale relative to review/);
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: { ...fixture.plan, validUntil: PREPARED_AT + 3_601 },
    observedAt: OBSERVED_AT,
  }), /validity exceeds/);
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: fixture.plan,
    observedAt: REVIEWED_AT + 3_601,
  }), /review expired/);

  const laterVerification = await createVerifiedWalletSessionRouteReviewFixture({
    reviewedAt: REVIEWED_AT,
    observedAt: PREPARED_AT + 10,
  });
  assert.doesNotThrow(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: laterVerification.verification,
    plan: createWalletSessionRouteDeploymentPlan(laterVerification),
    observedAt: PREPARED_AT + 20,
  }));
});

test("rejects public access, production data, migrations, R2, and schema changes", async () => {
  const fixture = await signedFixture();
  const prepare = (plan) => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan,
    observedAt: OBSERVED_AT,
  });
  assert.throws(() => prepare({
    ...fixture.plan,
    access: { ...fixture.plan.access, anonymousAccess: true },
  }), /owner-only private/);
  assert.throws(() => prepare({
    ...fixture.plan,
    access: { ...fixture.plan.access, publicBypass: true },
  }), /owner-only private/);
  assert.throws(() => prepare({
    ...fixture.plan,
    bindings: { ...fixture.plan.bindings, d1DataClass: "production" },
  }), /non-production D1 copy/);
  assert.throws(() => prepare({
    ...fixture.plan,
    bindings: { ...fixture.plan.bindings, d1MigrationRequired: true },
  }), /non-production D1 copy/);
  assert.throws(() => prepare({
    ...fixture.plan,
    bindings: { ...fixture.plan.bindings, r2Binding: "FILES" },
  }), /non-production D1 copy/);
});

test("rejects runtime fallback, retiring credentials, and all four-way key reuse", async () => {
  const fixture = await signedFixture();
  const prepare = (runtime) => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: { ...fixture.plan, runtime },
    observedAt: OBSERVED_AT,
  });
  assert.throws(() => prepare({
    ...fixture.plan.runtime,
    processEnvironmentFallbackAllowed: true,
  }), /fresh closed-test Sites rollout/);
  assert.throws(() => prepare({
    ...fixture.plan.runtime,
    retiringCredentialSlotConfigured: true,
  }), /fresh closed-test Sites rollout/);
  assert.throws(() => prepare({
    ...fixture.plan.runtime,
    gatewayResponseKeyId: fixture.plan.runtime.currentRequesterKeyId,
  }), /key identities must be globally distinct/);
});

test("rejects every sensitive-body capture or persistence path", async () => {
  const fixture = await signedFixture();
  for (const field of Object.keys(fixture.plan.dataHandling)) {
    assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
      routeReviewVerification: fixture.review.verification,
      plan: {
        ...fixture.plan,
        dataHandling: { ...fixture.plan.dataHandling, [field]: true },
      },
      observedAt: OBSERVED_AT,
    }), new RegExp(`must keep ${field} disabled`));
  }
});

test("rejects reused controls and any reviewer/operator authority overlap", async () => {
  const fixture = await signedFixture();
  const duplicatedControls = {
    ...fixture.plan.controlCommitments,
    monitoringPolicyDigest: fixture.plan.controlCommitments.accessPolicyDigest,
  };
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: { ...fixture.plan, controlCommitments: duplicatedControls },
    observedAt: OBSERVED_AT,
  }), /plan commitments must be globally distinct/);

  const reusedReviewer = fixture.plan.participants.map((participant, index) => index === 0
    ? {
        ...participant,
        participantId: fixture.review.policy.reviewApprovers[0].reviewerId,
        signer: WALLET_SESSION_ROUTE_REVIEWER_WALLETS[0].address,
      }
    : participant);
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: { ...fixture.plan, participants: reusedReviewer },
    observedAt: OBSERVED_AT,
  }), /reuse reviewer commitments|reuse reviewer signers/);
});

test("rejects missing, reordered, copied, substituted, future, and expired attestations", async () => {
  const fixture = await signedFixture();
  const verify = (overrides = {}) => verifyWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: fixture.plan,
    attestations: fixture.attestations,
    observedAt: OBSERVED_AT,
    ...overrides,
  });
  assert.throws(() => verify({ attestations: fixture.attestations.slice(0, 1) }), /length 2/);
  assert.throws(() => verify({ attestations: [...fixture.attestations].reverse() }), /canonical order/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((attestation, index) => index === 1
      ? { ...attestation, signature: fixture.attestations[0].signature }
      : attestation),
  }), /signature is invalid/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((attestation, index) => index === 0
      ? { ...attestation, attestedAt: attestation.attestedAt + 1 }
      : attestation),
  }), /signature is invalid/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((attestation, index) => index === 0
      ? { ...attestation, attestedAt: PREPARED_AT - 1 }
      : attestation),
  }), /outside the signed plan window/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((attestation, index) => index === 0
      ? { ...attestation, attestedAt: OBSERVED_AT + 1 }
      : attestation),
  }), /outside the signed plan window/);
  assert.throws(() => verify({
    plan: {
      ...fixture.plan,
      controlCommitments: {
        ...fixture.plan.controlCommitments,
        monitoringPolicyDigest: id("mutated signed monitoring policy").toLowerCase(),
      },
    },
  }), /signature is invalid/);
  assert.throws(() => verify({ observedAt: PREPARED_AT - 1 }), /future/);
  assert.throws(() => verify({ observedAt: fixture.plan.validUntil + 1 }), /expired/);
});

test("rejects secret-bearing, extensible, accessor, and endpoint material", async () => {
  const fixture = await signedFixture();
  assert.throws(
    () => assertWalletSessionRouteDeploymentPreflightIsSecretFree({ privateKey: "forbidden" }),
    /forbidden field/,
  );
  assert.throws(
    () => assertWalletSessionRouteDeploymentPreflightIsSecretFree({ note: "https://secret.invalid" }),
    /endpoint material/,
  );
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: { ...fixture.plan, notes: "extension" },
    observedAt: OBSERVED_AT,
  }), /fields are not exact/);
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "note", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "hidden";
    },
  });
  assert.throws(
    () => assertWalletSessionRouteDeploymentPreflightIsSecretFree(accessor),
    /non-data material/,
  );
  assert.equal(getterCalls, 0);

  const coerciblePlan = {
    ...fixture.plan,
    participants: fixture.plan.participants.map((participant, index) => index === 0
      ? { ...participant, participantId: accessor }
      : participant),
  };
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: coerciblePlan,
    observedAt: OBSERVED_AT,
  }), /must be a string/);
  assert.equal(getterCalls, 0);

  const decoratedParticipants = [...fixture.plan.participants];
  decoratedParticipants.note = "not canonical";
  assert.throws(() => prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification: fixture.review.verification,
    plan: { ...fixture.plan, participants: decoratedParticipants },
    observedAt: OBSERVED_AT,
  }), /exact dense array/);

  const accessorArray = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "hidden";
    },
  });
  assert.throws(
    () => assertWalletSessionRouteDeploymentPreflightIsSecretFree(accessorArray),
    /enumerable data properties/,
  );
  assert.equal(getterCalls, 0);
});
