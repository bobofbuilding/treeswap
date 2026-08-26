import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES,
  assertWalletSessionRouteDeploymentPreflightIsSecretFree,
  buildWalletSessionRouteDeploymentPreflightMessage,
  buildWalletSessionRouteDeploymentPreflightSummary,
  prepareWalletSessionRouteDeploymentPreflight,
  verifyWalletSessionRouteDeploymentPreflight,
} from "../lib/wallet-session-route-deployment-preflight.mjs";
import {
  WALLET_SESSION_ROUTE_REVIEWER_WALLETS,
  createVerifiedWalletSessionRouteReviewFixture,
} from "./fixtures/verified-wallet-session-route-review.mjs";

const REVIEWED_AT = 1_800_000_000;
const PREPARED_AT = REVIEWED_AT + 10;
const OBSERVED_AT = PREPARED_AT + 5;
const OPERATORS = Object.freeze([
  new Wallet(id("wallet session Sites deployment owner")),
  new Wallet(id("wallet session edge operations owner")),
]);

function deploymentPlan(review, overrides = {}) {
  const participants = WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES.map((role, index) => ({
    role,
    participantId: id(`wallet session deployment participant:${index}`).toLowerCase(),
    organizationId: id(`wallet session deployment organization:${index}`).toLowerCase(),
    identityEvidenceDigest: id(`wallet session deployment identity evidence:${index}`).toLowerCase(),
    signer: OPERATORS[index].address,
  }));
  return {
    schema: "treeswap.wallet-session-route-deployment-plan.v1",
    status: "private-closed-test-deployment-planned-live-evidence-required",
    scope: "preflight-only-no-deployment-dispatch-settlement-or-funding-authorization",
    environment: "closed-test",
    sourceBranch: review.artifact.sourceBranch,
    sourceCommit: review.artifact.sourceCommit,
    routePath: "/api/internal/wallet-session-read",
    preparedAt: PREPARED_AT,
    validUntil: PREPARED_AT + 1_800,
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

async function signedFixture(planOverrides = {}) {
  const review = await createVerifiedWalletSessionRouteReviewFixture({
    reviewedAt: REVIEWED_AT,
    observedAt: REVIEWED_AT + 5,
  });
  const plan = deploymentPlan(review, planOverrides);
  const attestations = [];
  for (let index = 0; index < WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES.length; index += 1) {
    const role = WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES[index];
    const typed = buildWalletSessionRouteDeploymentPreflightMessage({
      routeReviewVerification: review.verification,
      plan,
      role,
      observedAt: OBSERVED_AT,
    });
    attestations.push({
      role,
      participantId: plan.participants[index].participantId,
      signer: OPERATORS[index].address,
      signature: await OPERATORS[index].signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return { review, plan, attestations };
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
  assert.throws(
    () => buildWalletSessionRouteDeploymentPreflightSummary(structuredClone(verification)),
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
    plan: deploymentPlan(laterVerification),
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
