import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  WALLET_SESSION_ROUTE_REVIEW_FILES,
  WALLET_SESSION_ROUTE_REVIEW_ROLES,
  assertWalletSessionRouteReviewIsSecretFree,
  buildWalletSessionRouteReviewApprovalMessage,
  buildWalletSessionRouteReviewArtifact,
  buildWalletSessionRouteReviewDeploymentEvidence,
  buildWalletSessionRouteReviewSummary,
  hashWalletSessionRouteReviewArtifactFile,
  prepareWalletSessionRouteReviewCandidate,
  serializeWalletSessionRouteReviewArtifact,
  verifyWalletSessionRouteReview,
  verifyWalletSessionRouteReviewAtSignedBoundary,
  walletSessionRouteReviewControlSetDigest,
} from "../lib/wallet-session-route-review.mjs";

const REVIEWED_AT = 1_800_000_000;
const SOURCE_COMMIT = "a".repeat(40);
const REVIEWERS = Object.freeze([
  new Wallet(id("wallet session route application security reviewer")),
  new Wallet(id("wallet session route platform data isolation reviewer")),
]);

function sourceFiles(overrides = {}) {
  return Object.fromEntries(WALLET_SESSION_ROUTE_REVIEW_FILES.map((path) => [
    path,
    overrides[path] ?? Buffer.from(`exact published source:${path}\n`),
  ]));
}

function unsignedFixture(overrides = {}) {
  const artifact = buildWalletSessionRouteReviewArtifact({
    sourceBranch: overrides.sourceBranch ?? "codex/wallet-session-route-review",
    sourceCommit: overrides.sourceCommit ?? SOURCE_COMMIT,
    sourceFiles: overrides.sourceFiles ?? sourceFiles(),
  });
  const artifactFileBytes = serializeWalletSessionRouteReviewArtifact(artifact);
  const policy = {
    schema: "treeswap.wallet-session-route-review-policy.v1",
    environment: "closed-test",
    reviewScope: "repository-only",
    deploymentEvidenceRequired: true,
    sourceBranch: artifact.sourceBranch,
    sourceCommit: artifact.sourceCommit,
    artifactFileDigest: hashWalletSessionRouteReviewArtifactFile(artifactFileBytes),
    maximumReviewLifetimeSeconds: 7_200,
    reviewApprovers: WALLET_SESSION_ROUTE_REVIEW_ROLES.map((role, index) => ({
      role,
      reviewerId: id(`wallet session route reviewer:${index}`).toLowerCase(),
      organizationId: id(`wallet session route reviewer organization:${index}`).toLowerCase(),
      identityEvidenceDigest: id(`wallet session route reviewer identity evidence:${index}`).toLowerCase(),
      signer: REVIEWERS[index].address,
    })),
  };
  const reports = WALLET_SESSION_ROUTE_REVIEW_ROLES.map((role, index) => ({
    schema: "treeswap.wallet-session-route-review-report.v1",
    status: "repository-scope-passed-no-open-findings",
    role,
    reviewId: id(`wallet session route review:${index}`).toLowerCase(),
    reportDigest: id(`wallet session route report:${index}`).toLowerCase(),
    findingsDispositionDigest: id(`wallet session route findings disposition:${index}`).toLowerCase(),
    controlSetDigest: walletSessionRouteReviewControlSetDigest(role),
    findingCounts: {
      critical: 0,
      high: 0,
      medium: index,
      low: 1,
      informational: 2,
      open: 0,
    },
    reviewedAt: REVIEWED_AT + index,
    validUntil: REVIEWED_AT + 3_600 + index,
  }));
  return { artifact, artifactFileBytes, policy, reports };
}

async function signedFixture(overrides = {}) {
  const fixture = unsignedFixture(overrides);
  const attestations = [];
  for (let index = 0; index < WALLET_SESSION_ROUTE_REVIEW_ROLES.length; index += 1) {
    const role = WALLET_SESSION_ROUTE_REVIEW_ROLES[index];
    const attestedAt = REVIEWED_AT + 2 + index;
    const typed = buildWalletSessionRouteReviewApprovalMessage({
      artifactFileBytes: fixture.artifactFileBytes,
      policy: fixture.policy,
      reports: fixture.reports,
      role,
      attestedAt,
      observedAt: REVIEWED_AT + 10,
    });
    attestations.push({
      role,
      reviewerId: fixture.policy.reviewApprovers[index].reviewerId,
      signer: REVIEWERS[index].address,
      attestedAt,
      signature: await REVIEWERS[index].signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return { ...fixture, attestations };
}

test("binds the exact repository route scope to two independent reviewers without deployment authority", async () => {
  const fixture = await signedFixture();
  const verification = verifyWalletSessionRouteReview({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: fixture.policy,
    reports: fixture.reports,
    attestations: fixture.attestations,
    observedAt: REVIEWED_AT + 10,
  });
  assert.equal(verification.reviewerCount, 2);
  assert.equal(verification.status.includes("deployment-evidence-still-required"), true);
  assert.deepEqual(verification.externalEvidence, {
    deployedRoute: false,
    d1AccessPolicy: false,
    bodyLoggingDisabled: false,
    versionRetirement: false,
    monitoringAndIncidentDrills: false,
  });
  assert.equal(Object.values(verification.authorizations).every((value) => value === false), true);
  const summary = buildWalletSessionRouteReviewSummary(verification);
  assert.equal(summary.sourceCommit, SOURCE_COMMIT);
  assert.equal(summary.reviewerCount, 2);
  assert.equal("reports" in summary, false);
  const deploymentEvidence = buildWalletSessionRouteReviewDeploymentEvidence(verification);
  assert.equal(deploymentEvidence.validUntil, REVIEWED_AT + 3_600);
  assert.equal(deploymentEvidence.authorizations.deployment, false);
  const historicalVerification = verifyWalletSessionRouteReviewAtSignedBoundary({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: fixture.policy,
    reports: fixture.reports,
    attestations: fixture.attestations,
  });
  assert.equal(historicalVerification.verifiedAt, REVIEWED_AT + 3);
  assert.throws(
    () => buildWalletSessionRouteReviewSummary(structuredClone(verification)),
    /provenance/,
  );
  assert.throws(
    () => buildWalletSessionRouteReviewDeploymentEvidence(structuredClone(verification)),
    /provenance/,
  );
});

test("rejects an incomplete, reordered, duplicated, oversized, or noncanonical artifact", () => {
  const fixture = unsignedFixture();
  const incomplete = sourceFiles();
  delete incomplete[WALLET_SESSION_ROUTE_REVIEW_FILES[0]];
  assert.throws(() => buildWalletSessionRouteReviewArtifact({
    sourceBranch: fixture.artifact.sourceBranch,
    sourceCommit: SOURCE_COMMIT,
    sourceFiles: incomplete,
  }), /exact source file set/);

  const duplicated = structuredClone(fixture.artifact);
  duplicated.files[1].sha256 = duplicated.files[0].sha256;
  duplicated.fileSetDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => serializeWalletSessionRouteReviewArtifact(duplicated),
    /file digests must be distinct|file-set digest/,
  );

  const reordered = structuredClone(fixture.artifact);
  [reordered.files[0], reordered.files[1]] = [reordered.files[1], reordered.files[0]];
  assert.throws(() => serializeWalletSessionRouteReviewArtifact(reordered), /order or path/);

  assert.throws(() => buildWalletSessionRouteReviewArtifact({
    sourceBranch: fixture.artifact.sourceBranch,
    sourceCommit: SOURCE_COMMIT,
    sourceFiles: sourceFiles({
      [WALLET_SESSION_ROUTE_REVIEW_FILES[0]]: Buffer.alloc(500_001, 1),
    }),
  }), /empty or too large/);

  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: Buffer.concat([fixture.artifactFileBytes, Buffer.from(" ")]),
    policy: fixture.policy,
    reports: fixture.reports,
  }), /bytes are not canonical/);

  let getterCalls = 0;
  const accessorFiles = sourceFiles();
  Object.defineProperty(accessorFiles, WALLET_SESSION_ROUTE_REVIEW_FILES[0], {
    enumerable: true,
    get() {
      getterCalls += 1;
      return Buffer.from("substituted source");
    },
  });
  assert.throws(() => buildWalletSessionRouteReviewArtifact({
    sourceBranch: fixture.artifact.sourceBranch,
    sourceCommit: SOURCE_COMMIT,
    sourceFiles: accessorFiles,
  }), /enumerable data property/);
  assert.equal(getterCalls, 0);
});

test("rejects source, environment, reviewer, lifetime, and artifact-policy substitution", () => {
  const fixture = unsignedFixture();
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    reports: fixture.reports,
    policy: { ...fixture.policy, sourceCommit: "b".repeat(40) },
  }), /does not bind/);
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    reports: fixture.reports,
    policy: { ...fixture.policy, environment: "production" },
  }), /identity is invalid/);
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    reports: fixture.reports,
    policy: {
      ...fixture.policy,
      maximumReviewLifetimeSeconds: 86_401,
    },
  }), /maximum lifetime is invalid/);
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    reports: fixture.reports,
    policy: {
      ...fixture.policy,
      reviewApprovers: fixture.policy.reviewApprovers.map((reviewer, index) => ({
        ...reviewer,
        signer: index === 1 ? fixture.policy.reviewApprovers[0].signer : reviewer.signer,
      })),
    },
  }), /signers must be distinct/);
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    reports: fixture.reports,
    policy: {
      ...fixture.policy,
      reviewApprovers: fixture.policy.reviewApprovers.map((reviewer, index) => ({
        ...reviewer,
        organizationId: index === 1 ? fixture.policy.reviewApprovers[0].reviewerId : reviewer.organizationId,
      })),
    },
  }), /globally distinct/);
});

test("rejects missing controls, open findings, duplicated evidence, and overlong reports", () => {
  const fixture = unsignedFixture();
  const missingControl = structuredClone(fixture.reports);
  missingControl[0].controlSetDigest = id("incomplete controls").toLowerCase();
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: fixture.policy,
    reports: missingControl,
  }), /exact role controls/);

  const open = structuredClone(fixture.reports);
  open[1].findingCounts.open = 1;
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: fixture.policy,
    reports: open,
  }), /open findings/);

  const duplicate = structuredClone(fixture.reports);
  duplicate[1].reportDigest = duplicate[0].reportDigest;
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: fixture.policy,
    reports: duplicate,
  }), /globally distinct/);

  const overlong = structuredClone(fixture.reports);
  overlong[0].validUntil = overlong[0].reviewedAt + fixture.policy.maximumReviewLifetimeSeconds + 1;
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: fixture.policy,
    reports: overlong,
  }), /validity exceeds/);
});

test("rejects missing, reordered, copied, mutated, future, and expired attestations", async () => {
  const fixture = await signedFixture();
  const verify = (overrides = {}) => verifyWalletSessionRouteReview({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: fixture.policy,
    reports: fixture.reports,
    attestations: fixture.attestations,
    observedAt: REVIEWED_AT + 10,
    ...overrides,
  });
  assert.throws(() => verify({ attestations: fixture.attestations.slice(0, 1) }), /length 2/);
  assert.throws(() => verify({ attestations: [...fixture.attestations].reverse() }), /canonical order/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((value, index) => index === 1
      ? { ...value, signature: fixture.attestations[0].signature }
      : value),
  }), /signature is invalid/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((value, index) => index === 0
      ? { ...value, attestedAt: value.attestedAt + 1 }
      : value),
  }), /signature is invalid/);
  assert.throws(() => verify({
    attestations: fixture.attestations.map((value, index) => index === 0
      ? { ...value, attestedAt: REVIEWED_AT - 1 }
      : value),
  }), /attestation time is invalid/);
  assert.throws(() => verify({
    reports: fixture.reports.map((value, index) => index === 0
      ? { ...value, reportDigest: id("mutated signed report").toLowerCase() }
      : value),
  }), /signature is invalid/);
  assert.throws(() => verify({ observedAt: REVIEWED_AT - 1 }), /future/);
  assert.throws(() => verify({ observedAt: REVIEWED_AT + 3_602 }), /expired/);
});

test("rejects extensible, decorated, accessor, coercible, or secret-bearing review material", () => {
  const fixture = unsignedFixture();
  assert.throws(
    () => assertWalletSessionRouteReviewIsSecretFree({ privateKey: "not allowed" }),
    /forbidden field/,
  );
  assert.throws(
    () => assertWalletSessionRouteReviewIsSecretFree({ note: "https://secret.invalid" }),
    /unrestricted endpoint/,
  );
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: { ...fixture.policy, notes: "extension" },
    reports: fixture.reports,
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
    () => assertWalletSessionRouteReviewIsSecretFree(accessor),
    /non-data material/,
  );
  assert.equal(getterCalls, 0);

  const coercibleApprovers = fixture.policy.reviewApprovers.map((reviewer, index) => index === 0
    ? { ...reviewer, reviewerId: accessor }
    : reviewer);
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: { ...fixture.policy, reviewApprovers: coercibleApprovers },
    reports: fixture.reports,
  }), /must be a string/);
  assert.equal(getterCalls, 0);

  const decoratedReports = [...fixture.reports];
  decoratedReports.note = "not canonical";
  assert.throws(() => prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes: fixture.artifactFileBytes,
    policy: fixture.policy,
    reports: decoratedReports,
  }), /exact dense array/);
});
