import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  REQUIRED_OPERATIONAL_DRILLS,
  buildOperationalReadinessAttestationMessage,
  buildOperationalReadinessEvidenceSummary,
  buildOperationalReadinessReleaseEvidence,
  prepareOperationalReadinessEvidenceCandidate,
  verifyOperationalReadinessEvidence,
} from "../lib/operational-readiness-evidence.mjs";
import { createVerifiedDeploymentPromotionFixture } from "./fixtures/verified-deployment-promotion.mjs";
import { createVerifiedPublicTestnetBootstrapFixture } from "./fixtures/verified-public-testnet-bootstrap.mjs";
import { createVerifiedServiceIsolationFixture } from "./fixtures/verified-service-isolation.mjs";
import {
  createVerifiedOperationalReadinessFixture,
  fixture,
  sign,
} from "./fixtures/verified-operational-readiness.mjs";

const PREPARED_AT = 1_800_000_100;

async function bootstrapFixture() {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const upstream = await createVerifiedPublicTestnetBootstrapFixture({
    deployment,
    preparedAt: PREPARED_AT - 100,
    now: PREPARED_AT,
  });
  const serviceIsolation = await createVerifiedServiceIsolationFixture({
    deployment,
    preparedAt: PREPARED_AT,
    now: PREPARED_AT,
  });
  return { deployment, serviceIsolation, upstream };
}

async function validFixture(overrides = {}) {
  const { deployment, serviceIsolation, upstream } = await bootstrapFixture();
  return createVerifiedOperationalReadinessFixture({
    deployment,
    upstream,
    serviceIsolation,
    fundingMode: "operator-testnet-bootstrap",
    preparedAt: PREPARED_AT,
    now: PREPARED_AT + 60,
    ...overrides,
  });
}

test("verifies five signed operational roles and derives complete release evidence", async () => {
  const value = await validFixture();
  const evidence = buildOperationalReadinessReleaseEvidence(value.verification);
  assert.equal(evidence.fundingMode, "operator-testnet-bootstrap");
  assert.equal(evidence.participants.length, 5);
  assert.equal(evidence.drills.length, REQUIRED_OPERATIONAL_DRILLS.length);
  assert.equal(evidence.alertChannelEvidenceDigests.length, 2);
  assert.equal(evidence.adoptionPolicy.fees.baseBitToLightningBps, 72);
  assert.equal(evidence.adoptionPolicy.fees.baseLightningToBitBps, 18);
  assert.match(evidence.adoptionPolicyDigest, /^0x[0-9a-f]{64}$/);
  assert.match(evidence.recordDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(buildOperationalReadinessEvidenceSummary(value.verification).drillCount, 14);
  assert.equal(value.verification.authorizations.funding, false);
  assert.throws(
    () => buildOperationalReadinessReleaseEvidence(structuredClone(value.verification)),
    /provenance/,
  );
});

test("requires live matching service-isolation provenance for the complete operational interval", async () => {
  const { deployment, serviceIsolation, upstream } = await bootstrapFixture();
  const fresh = () => fixture({
    deployment,
    upstream,
    serviceIsolation,
    fundingMode: "operator-testnet-bootstrap",
    preparedAt: PREPARED_AT,
  });

  const copied = fresh();
  copied.serviceIsolationVerification = structuredClone(copied.serviceIsolationVerification);
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(copied), /provenance/);

  const substituted = fresh();
  substituted.record.artifacts.serviceIsolation = id("substituted isolation evidence").toLowerCase();
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(substituted), /does not match verified provenance/);

  const overlong = fresh();
  overlong.record.validUntil += 1;
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(overlong), /outside the verified service isolation interval/);
});

test("requires the exact drill set, passed status, bounded time, observers, and distinct evidence", async () => {
  const { deployment, serviceIsolation, upstream } = await bootstrapFixture();
  const fresh = () => fixture({
    deployment,
    upstream,
    serviceIsolation,
    fundingMode: "operator-testnet-bootstrap",
    preparedAt: PREPARED_AT,
  });
  const mutations = [
    [(value) => value.record.drills.pop(), /complete exact drill set/],
    [(value) => { value.record.drills[0].name = "unreviewed-drill"; }, /name is invalid|required set/],
    [(value) => { value.record.drills[0].status = "skipped"; }, /did not pass/],
    [(value) => { value.record.drills[0].finishedAt = PREPARED_AT + 1; }, /future-dated/],
    [(value) => { value.record.drills[0].startedAt = PREPARED_AT - 90_000; }, /duration exceeds/],
    [(value) => { value.record.drills[0].observerOperatorIds.length = 1; }, /retained observers/],
    [(value) => {
      value.record.drills[0].observerOperatorIds[0] = value.record.drills[0].primaryOperatorId;
      value.record.drills[0].observerOperatorIds.sort();
    }, /non-primary/],
    [(value) => { value.record.drills[1].evidenceDigest = value.record.drills[0].evidenceDigest; }, /distinct evidence/],
  ];
  for (const [mutate, pattern] of mutations) {
    const value = fresh();
    mutate(value);
    assert.throws(() => prepareOperationalReadinessEvidenceCandidate(value), pattern);
  }
});

test("rejects weak role separation, alert routing, schema drift, and secret-bearing evidence", async () => {
  const { deployment, serviceIsolation, upstream } = await bootstrapFixture();
  const fresh = () => fixture({
    deployment,
    upstream,
    serviceIsolation,
    fundingMode: "operator-testnet-bootstrap",
    preparedAt: PREPARED_AT,
  });
  const duplicateSigner = fresh();
  duplicateSigner.record.participants[1].signer = duplicateSigner.record.participants[0].signer;
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(duplicateSigner), /distinct signers/);

  const oneOrganization = fresh();
  for (const participant of oneOrganization.record.participants) {
    participant.organizationId = oneOrganization.record.participants[0].organizationId;
  }
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(oneOrganization), /organization commitments/);

  const oneAlert = fresh();
  oneAlert.record.alertChannelEvidenceDigests.length = 1;
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(oneAlert), /alert channels/);

  const duplicateArtifact = fresh();
  duplicateArtifact.record.artifacts.supportPolicy = duplicateArtifact.record.artifacts.lossAllocation;
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(duplicateArtifact), /distinct evidence digests/);

  const extra = fresh();
  extra.record.artifacts.unreviewed = id("unreviewed operations artifact").toLowerCase();
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(extra), /fields are not exact/);

  const secret = fresh();
  secret.record.rpcUrl = "https://secret.invalid";
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(secret), /fields are not exact|secret/);

  const stalePolicy = fresh();
  stalePolicy.policy.maximumEvidenceAgeSeconds = 2_592_001;
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(stalePolicy), /thirty days/);

  const incompletePolicy = fresh();
  incompletePolicy.policy.requiredDrills.pop();
  assert.throws(() => prepareOperationalReadinessEvidenceCandidate(incompletePolicy), /complete exact drill set/);

  const wrongSupportOwner = fresh();
  wrongSupportOwner.adoptionPolicy.supportOwnerId = id("substituted support owner").toLowerCase();
  assert.throws(
    () => prepareOperationalReadinessEvidenceCandidate(wrongSupportOwner),
    /support and incident owners/,
  );

  const shortAdoptionWindow = fresh();
  shortAdoptionWindow.adoptionPolicy.validUntil = shortAdoptionWindow.record.validUntil - 1;
  assert.throws(
    () => prepareOperationalReadinessEvidenceCandidate(shortAdoptionWindow),
    /outside the exact adoption policy interval/,
  );
});

test("rejects missing, substituted, replayed, stale, future, and mutated attestations", async () => {
  const { deployment, serviceIsolation, upstream } = await bootstrapFixture();
  const input = await sign(fixture({
    deployment,
    upstream,
    serviceIsolation,
    fundingMode: "operator-testnet-bootstrap",
    preparedAt: PREPARED_AT,
  }));
  assert.throws(() => verifyOperationalReadinessEvidence({
    ...input,
    attestations: input.attestations.slice(1),
    now: PREPARED_AT + 60,
  }), /one attestation/);
  assert.throws(() => verifyOperationalReadinessEvidence({
    ...input,
    attestations: input.attestations.map((value, index) => (
      index === 0 ? { ...value, signer: Wallet.createRandom().address } : value
    )),
    now: PREPARED_AT + 60,
  }), /does not exactly match/);
  assert.throws(() => verifyOperationalReadinessEvidence({
    ...input,
    attestations: [input.attestations[1], input.attestations[0], ...input.attestations.slice(2)],
    now: PREPARED_AT + 60,
  }), /canonically ordered/);
  assert.throws(() => verifyOperationalReadinessEvidence({ ...input, now: PREPARED_AT - 1 }), /future/);
  assert.throws(() => verifyOperationalReadinessEvidence({ ...input, now: input.record.validUntil + 1 }), /expired/);

  const mutated = { ...input, record: structuredClone(input.record) };
  mutated.record.artifacts.supportPolicy = id("substituted support policy").toLowerCase();
  assert.throws(
    () => verifyOperationalReadinessEvidence({ ...mutated, now: PREPARED_AT + 60 }),
    /does not match the exact adoption policy/,
  );
});

test("typed payload is restricted to one exact operational participant", async () => {
  const { deployment, serviceIsolation, upstream } = await bootstrapFixture();
  const input = fixture({
    deployment,
    upstream,
    serviceIsolation,
    fundingMode: "operator-testnet-bootstrap",
    preparedAt: PREPARED_AT,
  });
  const participant = input.record.participants[0];
  const typed = buildOperationalReadinessAttestationMessage({
    ...input,
    role: participant.role,
    operatorId: participant.operatorId,
  });
  assert.equal(typed.value.operationsId, input.record.operationsId);
  assert.equal(typed.value.role, participant.role);
  assert.match(typed.value.adoptionPolicyDigest, /^0x[0-9a-f]{64}$/);
  assert.throws(() => buildOperationalReadinessAttestationMessage({
    ...input,
    role: participant.role,
    operatorId: id("not a participant").toLowerCase(),
  }), /not a participant/);
});

test("operator preparation and verification CLIs expose no signing or funding authority", async () => {
  const { deployment, upstream } = await bootstrapFixture();
  const cliPreparedAt = Math.floor(Date.now() / 1_000) - 30;
  const serviceIsolation = await createVerifiedServiceIsolationFixture({
    deployment,
    preparedAt: cliPreparedAt,
    now: cliPreparedAt,
  });
  const input = await sign(fixture({
    deployment,
    upstream,
    serviceIsolation,
    fundingMode: "operator-testnet-bootstrap",
    preparedAt: cliPreparedAt,
  }));
  const directory = await mkdtemp(join(tmpdir(), "treeswap-operational-readiness-"));
  try {
    const recordPath = join(directory, "record.json");
    const policyPath = join(directory, "policy.json");
    const adoptionPolicyPath = join(directory, "adoption-policy.json");
    const attestationsPath = join(directory, "attestations.json");
    const isolationRecordPath = join(directory, "isolation-record.json");
    const isolationPolicyPath = join(directory, "isolation-policy.json");
    const isolationAttestationsPath = join(directory, "isolation-attestations.json");
    await Promise.all([
      writeFile(recordPath, JSON.stringify(input.record)),
      writeFile(policyPath, JSON.stringify(input.policy)),
      writeFile(adoptionPolicyPath, JSON.stringify(input.adoptionPolicy)),
      writeFile(attestationsPath, JSON.stringify(input.attestations)),
      writeFile(isolationRecordPath, JSON.stringify(serviceIsolation.candidate.record)),
      writeFile(isolationPolicyPath, JSON.stringify(serviceIsolation.candidate.policy)),
      writeFile(isolationAttestationsPath, JSON.stringify(serviceIsolation.candidate.attestations)),
    ]);
    const participant = input.record.participants[0];
    const payload = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-operational-readiness-attestation.mjs",
      "--record", recordPath,
      "--policy", policyPath,
      "--adoption-policy", adoptionPolicyPath,
      "--isolation-record", isolationRecordPath,
      "--isolation-policy", isolationPolicyPath,
      "--isolation-attestations", isolationAttestationsPath,
      "--role", participant.role,
      "--operator-id", participant.operatorId,
    ], { encoding: "utf8" }));
    assert.equal(payload.primaryType, "OperationalReadinessAttestation");
    assert.equal(payload.scope.includes("no-signing"), true);
    assert.equal(JSON.stringify(payload).includes("private"), false);

    const summary = JSON.parse(execFileSync(process.execPath, [
      "scripts/verify-operational-readiness-evidence.mjs",
      "--record", recordPath,
      "--policy", policyPath,
      "--adoption-policy", adoptionPolicyPath,
      "--attestations", attestationsPath,
      "--isolation-record", isolationRecordPath,
      "--isolation-policy", isolationPolicyPath,
      "--isolation-attestations", isolationAttestationsPath,
    ], { encoding: "utf8" }));
    assert.equal(summary.drillCount, REQUIRED_OPERATIONAL_DRILLS.length);
    assert.equal(summary.authorizations.funding, false);
    assert.equal(JSON.stringify(summary).includes("signature"), false);
    assert.equal((await stat(recordPath)).isFile(), true);
    assert.equal(JSON.parse(await readFile(recordPath, "utf8")).operationsId, input.record.operationsId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
