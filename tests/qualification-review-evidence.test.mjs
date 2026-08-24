import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  RELEASE_QUALIFICATION_CONFIGURATION_FILES,
  buildQualificationEvidence,
  hashQualificationFile,
} from "../lib/qualification-evidence.mjs";
import {
  assertQualificationReviewIsSecretFree,
  buildQualificationReviewReleaseEvidence,
  buildQualificationReviewSummary,
  prepareQualificationReviewCandidate,
  verifyQualificationReviewEvidence,
} from "../lib/qualification-review-evidence.mjs";
import { createVerifiedDeploymentPromotionFixture } from "./fixtures/verified-deployment-promotion.mjs";
import {
  createVerifiedQualificationReviewFixture,
} from "./fixtures/verified-qualification-review.mjs";

const REVIEWED_AT = 1_800_000_000;

async function validFixture(overrides = {}) {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const reviewedAt = overrides.reviewedAt ?? REVIEWED_AT;
  const qualification = await createVerifiedQualificationReviewFixture({
    deployment,
    fundingMode: "operator-testnet-bootstrap",
    reviewedAt,
    now: overrides.now ?? reviewedAt + 10,
    ...overrides,
  });
  return { deployment, qualification };
}

test("reconstructs the exact sealed artifact and binds one independent reviewer", async () => {
  const { qualification } = await validFixture();
  const evidence = buildQualificationReviewReleaseEvidence(qualification.verification);
  assert.equal(evidence.fundingMode, "operator-testnet-bootstrap");
  assert.equal(evidence.campaignCount, 42);
  assert.equal(evidence.configurationHashCount, RELEASE_QUALIFICATION_CONFIGURATION_FILES.length);
  assert.equal(evidence.pinnedImageCount, 3);
  assert.equal(evidence.qualificationFileDigest, qualification.review.qualificationFileDigest);
  const summary = buildQualificationReviewSummary(qualification.verification);
  assert.equal(summary.schema, "treeswap.qualification-review-summary.v1");
  assert.equal(summary.authorizations.funding, false);
  assert.throws(
    () => buildQualificationReviewReleaseEvidence(structuredClone(qualification.verification)),
    /provenance/,
  );
});

test("rejects byte substitution, missing mandatory coverage, and source drift", async () => {
  const { qualification } = await validFixture();
  assert.throws(() => prepareQualificationReviewCandidate({
    qualificationFileBytes: Buffer.concat([qualification.qualificationFileBytes, Buffer.from(" ")]),
    review: qualification.review,
    policy: qualification.policy,
  }), /file digest/);

  const incomplete = buildQualificationEvidence({
    branch: qualification.artifact.source.branch,
    sourceCommit: qualification.artifact.source.commit,
    startedAt: qualification.artifact.startedAt,
    finishedAt: qualification.artifact.finishedAt,
    runtimeVersions: qualification.artifact.runtimeVersions,
    pinnedImages: qualification.artifact.pinnedImages,
    configurationHashes: qualification.artifact.configurationHashes,
    campaigns: qualification.artifact.campaigns.slice(1),
    productionDurationEvidence: qualification.artifact.productionDuration,
  });
  const incompleteBytes = Buffer.from(`${JSON.stringify(incomplete, null, 2)}\n`);
  assert.throws(() => prepareQualificationReviewCandidate({
    qualificationFileBytes: incompleteBytes,
    review: { ...qualification.review, qualificationFileDigest: hashQualificationFile(incompleteBytes) },
    policy: qualification.policy,
  }), /exact mandatory campaign plan/);

  const substitutedConfiguration = Object.fromEntries([
    ...Object.entries(qualification.artifact.configurationHashes).slice(1),
    ["tests/qualification-manifest-filler.mjs", `sha256:${"f".repeat(64)}`],
  ]);
  const substituted = buildQualificationEvidence({
    branch: qualification.artifact.source.branch,
    sourceCommit: qualification.artifact.source.commit,
    startedAt: qualification.artifact.startedAt,
    finishedAt: qualification.artifact.finishedAt,
    runtimeVersions: qualification.artifact.runtimeVersions,
    pinnedImages: qualification.artifact.pinnedImages,
    configurationHashes: substitutedConfiguration,
    campaigns: qualification.artifact.campaigns,
    productionDurationEvidence: qualification.artifact.productionDuration,
  });
  const substitutedBytes = Buffer.from(`${JSON.stringify(substituted, null, 2)}\n`);
  assert.throws(() => prepareQualificationReviewCandidate({
    qualificationFileBytes: substitutedBytes,
    review: { ...qualification.review, qualificationFileDigest: hashQualificationFile(substitutedBytes) },
    policy: qualification.policy,
  }), /exact configuration manifest/);

  assert.throws(() => prepareQualificationReviewCandidate({
    qualificationFileBytes: qualification.qualificationFileBytes,
    review: qualification.review,
    policy: { ...qualification.policy, reviewedBuildCommit: "f".repeat(40) },
  }), /reviewed build commit/);
});

test("rejects stale, future, copied, substituted, and mutated review authority", async () => {
  const { qualification } = await validFixture();
  assert.throws(() => verifyQualificationReviewEvidence({
    qualificationFileBytes: qualification.qualificationFileBytes,
    review: qualification.review,
    policy: qualification.policy,
    attestation: qualification.attestation,
    now: qualification.review.reviewedAt - 1,
  }), /future/);
  assert.throws(() => verifyQualificationReviewEvidence({
    qualificationFileBytes: qualification.qualificationFileBytes,
    review: qualification.review,
    policy: qualification.policy,
    attestation: qualification.attestation,
    now: qualification.review.validUntil + 1,
  }), /expired/);
  assert.throws(() => verifyQualificationReviewEvidence({
    qualificationFileBytes: qualification.qualificationFileBytes,
    review: qualification.review,
    policy: qualification.policy,
    attestation: { ...qualification.attestation, signer: Wallet.createRandom().address },
    now: REVIEWED_AT + 10,
  }), /policy-pinned reviewer/);
  assert.throws(() => verifyQualificationReviewEvidence({
    qualificationFileBytes: qualification.qualificationFileBytes,
    review: { ...qualification.review, reportDigest: id("substituted report").toLowerCase() },
    policy: qualification.policy,
    attestation: qualification.attestation,
    now: REVIEWED_AT + 10,
  }), /signature/);
  assert.throws(() => prepareQualificationReviewCandidate({
    qualificationFileBytes: qualification.qualificationFileBytes,
    review: { ...qualification.review, validUntil: qualification.review.reviewedAt + 86_401 },
    policy: qualification.policy,
  }), /validity exceeds/);
  assert.throws(() => prepareQualificationReviewCandidate({
    qualificationFileBytes: qualification.qualificationFileBytes,
    review: qualification.review,
    policy: {
      ...qualification.policy,
      reviewerOrganizationId: qualification.policy.reviewerId,
    },
  }), /commitments must be distinct/);
});

test("rejects secret-bearing or extensible review envelopes", async () => {
  const { qualification } = await validFixture();
  assert.throws(() => assertQualificationReviewIsSecretFree({ rpcUrl: "https://secret.invalid" }), /forbidden field/);
  assert.throws(() => prepareQualificationReviewCandidate({
    qualificationFileBytes: qualification.qualificationFileBytes,
    review: { ...qualification.review, endpoint: "https://secret.invalid" },
    policy: qualification.policy,
  }), /fields are not exact/);
});

test("operator CLIs emit typed data and verify without gaining funding authority", async () => {
  const { qualification } = await validFixture({ reviewedAt: Math.floor(Date.now() / 1_000) - 30 });
  const directory = await mkdtemp(join(tmpdir(), "treeswap-qualification-review-"));
  try {
    const paths = {
      artifact: join(directory, "artifact.json"),
      review: join(directory, "review.json"),
      policy: join(directory, "policy.json"),
      attestation: join(directory, "attestation.json"),
    };
    await Promise.all([
      writeFile(paths.artifact, qualification.qualificationFileBytes),
      writeFile(paths.review, `${JSON.stringify(qualification.review)}\n`),
      writeFile(paths.policy, `${JSON.stringify(qualification.policy)}\n`),
      writeFile(paths.attestation, `${JSON.stringify(qualification.attestation)}\n`),
    ]);
    const typed = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-qualification-review-attestation.mjs",
      "--artifact", paths.artifact,
      "--review", paths.review,
      "--policy", paths.policy,
    ], { encoding: "utf8" }));
    assert.equal(typed.primaryType, "QualificationReviewAttestation");
    assert.equal(typed.scope.includes("no-signing"), true);
    const verified = JSON.parse(execFileSync(process.execPath, [
      "scripts/verify-qualification-review-evidence.mjs",
      "--artifact", paths.artifact,
      "--review", paths.review,
      "--policy", paths.policy,
      "--attestation", paths.attestation,
    ], { encoding: "utf8" }));
    assert.equal(verified.authorizations.funding, false);
    assert.equal(verified.campaignCount, 42);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
