import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { id } from "ethers";
import {
  assertIndependentReviewEvidenceIsSecretFree,
  buildIndependentReviewAttestationMessage,
  buildIndependentReviewEvidenceSummary,
  buildIndependentReviewReleaseEvidence,
  prepareIndependentReviewEvidenceCandidate,
  verifyIndependentReviewEvidence,
} from "../lib/independent-review-evidence.mjs";
import {
  NOW,
  createVerifiedDeploymentPromotionFixture,
} from "./fixtures/verified-deployment-promotion.mjs";
import {
  createVerifiedIndependentReviewFixture,
  fixture,
  sign,
} from "./fixtures/verified-independent-review.mjs";

async function deployedFixture() {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const review = await createVerifiedIndependentReviewFixture({
    deployment,
    finishedAt: NOW + 20,
    now: NOW + 60,
  });
  return { deployment, review };
}

test("verifies five distinct signed reviews and derives report and findings evidence", async () => {
  const { review } = await deployedFixture();
  assert.equal(review.verification.status, "five-independent-reviewer-attestations-cryptographically-verified");
  assert.equal(review.verification.authorizations.funding, false);
  const evidence = buildIndependentReviewReleaseEvidence(review.verification);
  assert.equal(evidence.reviewerCount, 5);
  assert.equal(Object.keys(evidence.reviewDigests).length, 5);
  assert.equal(new Set(Object.values(evidence.reviewDigests)).size, 5);
  assert.match(evidence.findingsDispositionDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(evidence.reviewedBuildCommit, review.candidate.record.reviewedBuildCommit);
  const summary = buildIndependentReviewEvidenceSummary(review.verification);
  assert.equal(summary.attestationSetDigest, evidence.attestationSetDigest);
  assert.equal("participants" in summary, false);
  assert.equal("attestations" in summary, false);
});

test("requires live verifier provenance instead of copied review claims", async () => {
  const { review } = await deployedFixture();
  assert.throws(
    () => buildIndependentReviewReleaseEvidence(structuredClone(review.verification)),
    /provenance/,
  );
  assert.throws(
    () => buildIndependentReviewEvidenceSummary({ ...review.verification }),
    /provenance/,
  );
});

test("rejects missing, substituted, replayed, and report-mutated attestations", async () => {
  const { deployment, review } = await deployedFixture();
  const missing = structuredClone(review.candidate);
  missing.attestations.pop();
  assert.throws(
    () => verifyIndependentReviewEvidence({ ...missing, now: NOW + 60 }),
    /one attestation from every participant/,
  );
  const substituted = structuredClone(review.candidate);
  substituted.attestations[0].signer = substituted.attestations[1].signer;
  assert.throws(
    () => verifyIndependentReviewEvidence({ ...substituted, now: NOW + 60 }),
    /exactly match its participant/,
  );
  const mutated = structuredClone(review.candidate);
  mutated.record.reports.contracts.reportDigest = id("substituted contract review").toLowerCase();
  assert.throws(
    () => verifyIndependentReviewEvidence({ ...mutated, now: NOW + 60 }),
    /signature is invalid/,
  );
  const other = await sign(fixture({ deployment, finishedAt: NOW + 21 }));
  other.attestations = structuredClone(review.candidate.attestations);
  assert.throws(
    () => verifyIndependentReviewEvidence({ ...other, now: NOW + 60 }),
    /exactly match|signature is invalid/,
  );
});

test("reviewer roles, identities, organizations, signers, evidence, and ordering are exact", async () => {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const mutations = [
    (value) => { value.record.participants.pop(); },
    (value) => { value.record.participants[1].reviewerId = value.record.participants[0].reviewerId; },
    (value) => { value.record.participants[1].organizationId = value.record.participants[0].organizationId; },
    (value) => { value.record.participants[1].signer = value.record.participants[0].signer; },
    (value) => { value.record.participants[1].evidenceDigest = value.record.participants[0].evidenceDigest; },
    (value) => { value.record.participants.reverse(); },
    (value) => { value.record.reports.coordinator.reportDigest = value.record.reports.contracts.reportDigest; },
    (value) => { value.record.reports.coordinator.findingsDispositionDigest = value.record.reports.contracts.findingsDispositionDigest; },
  ];
  for (const mutate of mutations) {
    const value = fixture({ deployment, finishedAt: NOW + 20 });
    mutate(value);
    assert.throws(
      () => prepareIndependentReviewEvidenceCandidate(value),
      /exactly one|identities|organization|signers|identity evidence|ordered|reports must be distinct|dispositions must be distinct/,
    );
  }
});

test("finding accounting fails closed on open, unreconciled, critical, high, or unbounded findings", async () => {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const mutations = [
    (value) => { value.record.reports.contracts.openFindingCount = 1; },
    (value) => { value.record.reports.contracts.findingCount = 4; },
    (value) => { value.record.reports.contracts.acceptedCriticalRiskCount = 1; },
    (value) => { value.record.reports.contracts.acceptedHighRiskCount = 1; },
    (value) => {
      value.record.reports.contracts.findingCount = 101;
      value.record.reports.contracts.fixedFindingCount = 100;
    },
  ];
  for (const mutate of mutations) {
    const value = fixture({ deployment, finishedAt: NOW + 20 });
    mutate(value);
    assert.throws(
      () => prepareIndependentReviewEvidenceCandidate(value),
      /unresolved|do not reconcile|critical or high|exceeds policy/,
    );
  }
});

test("freshness, lifetime, deployment bindings, exact fields, and secret-free boundaries fail closed", async () => {
  const { deployment, review } = await deployedFixture();
  assert.throws(
    () => verifyIndependentReviewEvidence({ ...review.candidate, now: NOW + 19 }),
    /future/,
  );
  assert.throws(
    () => verifyIndependentReviewEvidence({ ...review.candidate, now: review.candidate.record.validUntil + 1 }),
    /expired/,
  );
  const weakAge = fixture({ deployment, finishedAt: NOW + 20 });
  weakAge.policy.maximumEvidenceAgeSeconds = 2_592_001;
  assert.throws(() => prepareIndependentReviewEvidenceCandidate(weakAge), /thirty days/);
  const weakLifetime = fixture({ deployment, finishedAt: NOW + 20 });
  weakLifetime.policy.maximumEvidenceLifetimeSeconds = 7_776_001;
  assert.throws(() => prepareIndependentReviewEvidenceCandidate(weakLifetime), /ninety days/);
  const weakFindings = fixture({ deployment, finishedAt: NOW + 20 });
  weakFindings.policy.maximumFindingsPerReview = 1_001;
  assert.throws(() => prepareIndependentReviewEvidenceCandidate(weakFindings), /one thousand/);
  const wrongDeployment = fixture({ deployment, finishedAt: NOW + 20 });
  wrongDeployment.record.deploymentManifestDigest = id("wrong review deployment").toLowerCase();
  assert.throws(() => prepareIndependentReviewEvidenceCandidate(wrongDeployment), /does not match its policy/);
  const extra = fixture({ deployment, finishedAt: NOW + 20 });
  extra.record.reviewComplete = true;
  assert.throws(() => prepareIndependentReviewEvidenceCandidate(extra), /fields are not exact/);
  assert.throws(
    () => assertIndependentReviewEvidenceIsSecretFree({ rpcUrl: "https://provider.example/key" }),
    /forbidden/,
  );
  assert.throws(
    () => assertIndependentReviewEvidenceIsSecretFree({ note: "lnbc1234567890123456789012345" }),
    /secret/,
  );
});

test("review preparation and verification CLIs expose no signing or funding authority", async (context) => {
  const { review } = await deployedFixture();
  const directory = await mkdtemp(join(tmpdir(), "treeswap-independent-review-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const recordPath = join(directory, "record.json");
  const policyPath = join(directory, "policy.json");
  const attestationsPath = join(directory, "attestations.json");
  await Promise.all([
    writeFile(recordPath, JSON.stringify(review.candidate.record)),
    writeFile(policyPath, JSON.stringify(review.candidate.policy)),
    writeFile(attestationsPath, JSON.stringify(review.candidate.attestations)),
  ]);
  const participant = review.candidate.record.participants[0];
  const prepared = spawnSync(process.execPath, [
    "scripts/prepare-independent-review-attestation.mjs",
    "--record", recordPath,
    "--policy", policyPath,
    "--role", participant.role,
    "--reviewer-id", participant.reviewerId,
  ], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const typed = JSON.parse(prepared.stdout);
  assert.equal(typed.primaryType, "IndependentReviewAttestation");
  assert.equal(typed.message.reviewId, review.candidate.record.reviewId);
  assert.equal(typed.scope.includes("no-signing"), true);

  const verified = spawnSync(process.execPath, [
    "scripts/verify-independent-review-evidence.mjs",
    "--record", recordPath,
    "--policy", policyPath,
    "--attestations", attestationsPath,
  ], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  const summary = JSON.parse(verified.stdout);
  assert.equal(summary.status, "five-independent-reviewer-attestations-cryptographically-verified");
  assert.equal(summary.authorizations.funding, false);
  assert.equal("signatures" in summary, false);
});

test("typed review payload can only be prepared for an exact participant", async () => {
  const { review } = await deployedFixture();
  const participant = review.candidate.record.participants[0];
  const typed = buildIndependentReviewAttestationMessage({
    record: review.candidate.record,
    policy: review.candidate.policy,
    role: participant.role,
    reviewerId: participant.reviewerId,
  });
  assert.equal(typed.value.reviewerId, participant.reviewerId);
  assert.throws(
    () => buildIndependentReviewAttestationMessage({
      record: review.candidate.record,
      policy: review.candidate.policy,
      role: participant.role,
      reviewerId: id("unlisted reviewer").toLowerCase(),
    }),
    /not a participant/,
  );
});
