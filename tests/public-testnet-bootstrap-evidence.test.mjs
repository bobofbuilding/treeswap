import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { id } from "ethers";
import {
  assertPublicTestnetBootstrapEvidenceIsSecretFree,
  buildPublicTestnetBootstrapAttestationMessage,
  buildPublicTestnetBootstrapEvidenceSummary,
  buildPublicTestnetBootstrapReleaseEvidence,
  preparePublicTestnetBootstrapEvidenceCandidate,
  verifyPublicTestnetBootstrapEvidence,
} from "../lib/public-testnet-bootstrap-evidence.mjs";
import {
  NOW,
  createVerifiedDeploymentPromotionFixture,
} from "./fixtures/verified-deployment-promotion.mjs";
import {
  canonical,
  createVerifiedPublicTestnetBootstrapFixture,
  fixture,
  sign,
} from "./fixtures/verified-public-testnet-bootstrap.mjs";

async function deployedFixture() {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const bootstrap = await createVerifiedPublicTestnetBootstrapFixture({
    deployment,
    preparedAt: NOW,
    now: NOW + 60,
  });
  return { bootstrap, deployment };
}

test("verifies an exact independently signed bootstrap roster and derives counts instead of trusting them", async () => {
  const { bootstrap } = await deployedFixture();
  const verification = bootstrap.verification;
  assert.equal(verification.status, "cryptographically-verified-bootstrap-operator-attestations");
  assert.equal(verification.authorizations.funding, false);
  assert.match(verification.recordDigest, /^0x[0-9a-f]{64}$/);
  assert.match(verification.attestationSetDigest, /^0x[0-9a-f]{64}$/);
  const evidence = buildPublicTestnetBootstrapReleaseEvidence(verification);
  assert.deepEqual(evidence.counts, {
    alertChannels: 2,
    independentEvmProviders: 2,
    independentLightningObservers: 2,
    independentMonitors: 2,
    independentRelays: 2,
    independentSolvers: 2,
  });
  assert.equal(evidence.evmProviders.length, 2);
  assert.equal(evidence.reviewedBuildCommit, verification.record.reviewedBuildCommit);
  const summary = buildPublicTestnetBootstrapEvidenceSummary(verification);
  assert.equal(summary.participantSetDigest, evidence.participantSetDigest);
  assert.equal("participants" in summary, false);
  assert.equal("attestations" in summary, false);
});

test("requires live verifier provenance and cannot activate from copied output", async () => {
  const { bootstrap } = await deployedFixture();
  assert.throws(
    () => buildPublicTestnetBootstrapReleaseEvidence(structuredClone(bootstrap.verification)),
    /provenance/,
  );
  assert.throws(
    () => buildPublicTestnetBootstrapEvidenceSummary({ ...bootstrap.verification }),
    /provenance/,
  );
});

test("rejects missing, substituted, replayed, or mutated operator attestations", async () => {
  const { bootstrap, deployment } = await deployedFixture();
  const missing = structuredClone(bootstrap.candidate);
  missing.attestations.pop();
  assert.throws(
    () => verifyPublicTestnetBootstrapEvidence({ ...missing, now: NOW + 60 }),
    /one attestation from every participant/,
  );

  const substituted = structuredClone(bootstrap.candidate);
  substituted.attestations[0].signer = substituted.attestations[1].signer;
  assert.throws(
    () => verifyPublicTestnetBootstrapEvidence({ ...substituted, now: NOW + 60 }),
    /exactly match its participant/,
  );

  const wrongRole = structuredClone(bootstrap.candidate);
  wrongRole.attestations[0].role = "solver";
  wrongRole.attestations = canonical(wrongRole.attestations, (value) => `${value.role}:${value.operatorId}`);
  assert.throws(
    () => verifyPublicTestnetBootstrapEvidence({ ...wrongRole, now: NOW + 60 }),
    /ordered|exactly match|signature/,
  );

  const changedArtifact = structuredClone(bootstrap.candidate);
  changedArtifact.record.artifacts.monitoring = id("substituted monitoring evidence").toLowerCase();
  assert.throws(
    () => verifyPublicTestnetBootstrapEvidence({ ...changedArtifact, now: NOW + 60 }),
    /signature is invalid/,
  );

  const other = await sign(fixture({ deployment, preparedAt: NOW + 1 }));
  other.attestations = structuredClone(bootstrap.candidate.attestations);
  assert.throws(
    () => verifyPublicTestnetBootstrapEvidence({ ...other, now: NOW + 60 }),
    /exactly match|signature is invalid/,
  );
});

test("participant identities, signers, evidence, ordering, and minimums are independently enforced", async () => {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const mutations = [
    (value) => { value.record.participants[1].operatorId = value.record.participants[0].operatorId; },
    (value) => { value.record.participants[1].signer = value.record.participants[0].signer; },
    (value) => { value.record.participants[1].evidenceDigest = value.record.participants[0].evidenceDigest; },
    (value) => { value.record.participants.reverse(); },
    (value) => { value.record.participants = value.record.participants.filter((entry) => entry.role !== "solver" || entry === value.record.participants.find((candidate) => candidate.role === "solver")); },
    (value) => { value.record.alertChannelEvidenceDigests.pop(); },
  ];
  for (const mutate of mutations) {
    const value = fixture({ deployment, preparedAt: NOW });
    mutate(value);
    assert.throws(
      () => preparePublicTestnetBootstrapEvidenceCandidate(value),
      /operator identity|signer|distinct evidence|ordered|below policy|alert channel/,
    );
  }
});

test("freshness, lifetime, deployment binding, safe features, exact fields, and secret-free output fail closed", async () => {
  const { bootstrap, deployment } = await deployedFixture();
  assert.throws(
    () => verifyPublicTestnetBootstrapEvidence({ ...bootstrap.candidate, now: NOW - 1 }),
    /future/,
  );
  assert.throws(
    () => verifyPublicTestnetBootstrapEvidence({ ...bootstrap.candidate, now: NOW + 3_601 }),
    /expired|stale/,
  );

  const weakAge = fixture({ deployment, preparedAt: NOW });
  weakAge.policy.maximumEvidenceAgeSeconds = 3_601;
  assert.throws(() => preparePublicTestnetBootstrapEvidenceCandidate(weakAge), /one hour/);
  const weakLifetime = fixture({ deployment, preparedAt: NOW });
  weakLifetime.policy.maximumEvidenceLifetimeSeconds = 86_401;
  assert.throws(() => preparePublicTestnetBootstrapEvidenceCandidate(weakLifetime), /one day/);
  const wrongDeployment = fixture({ deployment, preparedAt: NOW });
  wrongDeployment.record.deploymentManifestDigest = id("substituted deployment").toLowerCase();
  assert.throws(() => preparePublicTestnetBootstrapEvidenceCandidate(wrongDeployment), /does not match its policy/);
  const unsafe = fixture({ deployment, preparedAt: NOW });
  unsafe.record.features.publicLpDeposits = true;
  assert.throws(() => preparePublicTestnetBootstrapEvidenceCandidate(unsafe), /operator-owned public-testnet boundary/);
  const extra = fixture({ deployment, preparedAt: NOW });
  extra.record.fundingAuthorization = true;
  assert.throws(() => preparePublicTestnetBootstrapEvidenceCandidate(extra), /fields are not exact/);
  assert.throws(
    () => assertPublicTestnetBootstrapEvidenceIsSecretFree({ rpcUrl: "https://provider.example/key" }),
    /forbidden/,
  );
  assert.throws(
    () => assertPublicTestnetBootstrapEvidenceIsSecretFree({ note: "lnbc1234567890123456789012345" }),
    /secret/,
  );
});

test("operator preparation and verification CLIs disclose no signing or funding authority", async (context) => {
  const { bootstrap } = await deployedFixture();
  const directory = await mkdtemp(join(tmpdir(), "treeswap-bootstrap-evidence-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const recordPath = join(directory, "record.json");
  const policyPath = join(directory, "policy.json");
  const attestationsPath = join(directory, "attestations.json");
  await Promise.all([
    writeFile(recordPath, JSON.stringify(bootstrap.candidate.record)),
    writeFile(policyPath, JSON.stringify(bootstrap.candidate.policy)),
    writeFile(attestationsPath, JSON.stringify(bootstrap.candidate.attestations)),
  ]);

  const participant = bootstrap.candidate.record.participants[0];
  const prepared = spawnSync(process.execPath, [
    "scripts/prepare-public-testnet-bootstrap-attestation.mjs",
    "--record", recordPath,
    "--policy", policyPath,
    "--role", participant.role,
    "--operator-id", participant.operatorId,
  ], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const typed = JSON.parse(prepared.stdout);
  assert.equal(typed.primaryType, "BootstrapOperatorAttestation");
  assert.equal(typed.message.bootstrapId, bootstrap.candidate.record.bootstrapId);
  assert.equal(typed.scope.includes("no-signing"), true);

  const verified = spawnSync(process.execPath, [
    "scripts/verify-public-testnet-bootstrap-evidence.mjs",
    "--record", recordPath,
    "--policy", policyPath,
    "--attestations", attestationsPath,
  ], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  const summary = JSON.parse(verified.stdout);
  assert.equal(summary.status, "cryptographically-verified-bootstrap-operator-attestations");
  assert.equal(summary.authorizations.funding, false);
  assert.equal("signatures" in summary, false);
});

test("typed payload can only be prepared for an exact roster participant", async () => {
  const { bootstrap } = await deployedFixture();
  const participant = bootstrap.candidate.record.participants[0];
  const typed = buildPublicTestnetBootstrapAttestationMessage({
    record: bootstrap.candidate.record,
    policy: bootstrap.candidate.policy,
    role: participant.role,
    operatorId: participant.operatorId,
  });
  assert.equal(typed.value.operatorId, participant.operatorId);
  assert.throws(
    () => buildPublicTestnetBootstrapAttestationMessage({
      record: bootstrap.candidate.record,
      policy: bootstrap.candidate.policy,
      role: participant.role,
      operatorId: id("unlisted operator").toLowerCase(),
    }),
    /not a participant/,
  );
});
