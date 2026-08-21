import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  REQUIRED_ISOLATED_SERVICES,
  buildServiceIsolationAttestationMessage,
  buildServiceIsolationEvidenceSummary,
  buildServiceIsolationReleaseEvidence,
  prepareServiceIsolationEvidenceCandidate,
  verifyServiceIsolationEvidence,
} from "../lib/service-isolation-evidence.mjs";
import { createVerifiedDeploymentPromotionFixture } from "./fixtures/verified-deployment-promotion.mjs";
import {
  createVerifiedServiceIsolationFixture,
  fixture,
  sign,
} from "./fixtures/verified-service-isolation.mjs";

const PREPARED_AT = 1_800_000_100;

async function deploymentFixture() {
  return createVerifiedDeploymentPromotionFixture();
}

test("verifies exact isolated services and derives provenance-bound release evidence", async () => {
  const deployment = await deploymentFixture();
  const value = await createVerifiedServiceIsolationFixture({
    deployment,
    preparedAt: PREPARED_AT,
    now: PREPARED_AT + 60,
  });
  const evidence = buildServiceIsolationReleaseEvidence(value.verification);
  assert.equal(evidence.serviceCount, REQUIRED_ISOLATED_SERVICES.length);
  assert.equal(evidence.participantCount, 3);
  assert.equal(value.verification.record.services.every((service) => service.encryptedTransport), true);
  assert.equal(new Set(value.verification.record.services.map((service) => service.trustDomainId)).size, 12);
  assert.match(evidence.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(buildServiceIsolationEvidenceSummary(value.verification).authorizations.funding, false);
  assert.throws(
    () => buildServiceIsolationReleaseEvidence(structuredClone(value.verification)),
    /provenance/,
  );
});

test("rejects missing services, public credential exposure, weak transport, and policy drift", async () => {
  const deployment = await deploymentFixture();
  const fresh = () => fixture({ deployment, preparedAt: PREPARED_AT });
  const mutations = [
    [(value) => value.record.services.pop(), /complete exact service set/],
    [(value) => { value.record.services[0].publicIngress = true; }, /network placement/],
    [(value) => { value.record.services[0].encryptedTransport = false; }, /encrypted transport/],
    [(value) => { value.record.services[0].credentialClasses = []; }, /least-privilege policy/],
    [(value) => { value.policy.requiredServices.pop(); }, /complete exact service set/],
    [(value) => { value.policy.maximumCredentialLifetimeSeconds = 7_776_001; }, /ninety days/],
    [(value) => { value.record.services[0].networkZone = "public-edge"; }, /network placement/],
  ];
  for (const [mutate, pattern] of mutations) {
    const value = fresh();
    mutate(value);
    assert.throws(() => prepareServiceIsolationEvidenceCandidate(value), pattern);
  }
});

test("rejects shared trust domains, credential sets, evidence, identities, and invalid credential windows", async () => {
  const deployment = await deploymentFixture();
  const fresh = () => fixture({ deployment, preparedAt: PREPARED_AT });

  const sharedDomain = fresh();
  sharedDomain.record.services[1].trustDomainId = sharedDomain.record.services[0].trustDomainId;
  assert.throws(() => prepareServiceIsolationEvidenceCandidate(sharedDomain), /trust domains must be unique/);

  const credentialServices = fresh().record.services.filter((service) => (
    service.credentialSetDigest !== `0x${"00".repeat(32)}`
  ));
  const sharedCredential = fresh();
  const credentialIndexes = credentialServices.map((service) => (
    sharedCredential.record.services.findIndex((value) => value.role === service.role)
  ));
  sharedCredential.record.services[credentialIndexes[1]].credentialSetDigest = (
    sharedCredential.record.services[credentialIndexes[0]].credentialSetDigest
  );
  assert.throws(() => prepareServiceIsolationEvidenceCandidate(sharedCredential), /credential sets must be unique/);

  const sharedEvidence = fresh();
  sharedEvidence.record.services[1].deploymentEvidenceDigest = sharedEvidence.record.services[0].deploymentEvidenceDigest;
  assert.throws(() => prepareServiceIsolationEvidenceCandidate(sharedEvidence), /deployment evidence must be unique/);

  const sharedSigner = fresh();
  sharedSigner.record.participants[1].signer = sharedSigner.record.participants[0].signer;
  assert.throws(() => prepareServiceIsolationEvidenceCandidate(sharedSigner), /must be distinct/);

  const expiredCredential = fresh();
  expiredCredential.record.services[0].credentialExpiresAt = PREPARED_AT;
  assert.throws(() => prepareServiceIsolationEvidenceCandidate(expiredCredential), /does not cover the evidence interval/);

  const fakeCredentialFree = fresh();
  const browser = fakeCredentialFree.record.services.find((service) => service.role === "browser-client");
  browser.credentialSetDigest = id("browser secret").toLowerCase();
  assert.throws(() => prepareServiceIsolationEvidenceCandidate(fakeCredentialFree), /exact zero credential fields/);
});

test("rejects missing, substituted, replayed, stale, future, and mutated attestations", async () => {
  const deployment = await deploymentFixture();
  const input = await sign(fixture({ deployment, preparedAt: PREPARED_AT }));
  assert.throws(() => verifyServiceIsolationEvidence({
    ...input,
    attestations: input.attestations.slice(1),
    now: PREPARED_AT + 60,
  }), /one attestation/);
  assert.throws(() => verifyServiceIsolationEvidence({
    ...input,
    attestations: input.attestations.map((value, index) => (
      index === 0 ? { ...value, signer: Wallet.createRandom().address } : value
    )),
    now: PREPARED_AT + 60,
  }), /does not exactly match/);
  assert.throws(() => verifyServiceIsolationEvidence({
    ...input,
    attestations: [input.attestations[1], input.attestations[0], input.attestations[2]],
    now: PREPARED_AT + 60,
  }), /canonically ordered/);
  assert.throws(() => verifyServiceIsolationEvidence({ ...input, now: PREPARED_AT - 1 }), /future/);
  assert.throws(() => verifyServiceIsolationEvidence({ ...input, now: input.record.validUntil + 1 }), /expired/);

  const mutated = structuredClone(input);
  mutated.record.services[0].deploymentEvidenceDigest = id("substituted deployment evidence").toLowerCase();
  assert.throws(() => verifyServiceIsolationEvidence({ ...mutated, now: PREPARED_AT + 60 }), /signature is invalid/);
});

test("typed payload is restricted to one exact service-isolation participant", async () => {
  const deployment = await deploymentFixture();
  const input = fixture({ deployment, preparedAt: PREPARED_AT });
  const participant = input.record.participants[0];
  const typed = buildServiceIsolationAttestationMessage({
    ...input,
    role: participant.role,
    operatorId: participant.operatorId,
  });
  assert.equal(typed.value.isolationId, input.record.isolationId);
  assert.equal(typed.value.role, participant.role);
  assert.throws(() => buildServiceIsolationAttestationMessage({
    ...input,
    role: participant.role,
    operatorId: id("not a participant").toLowerCase(),
  }), /not a participant/);
});

test("service-isolation CLIs expose no secrets, signing, or funding authority", async () => {
  const deployment = await deploymentFixture();
  const preparedAt = Math.floor(Date.now() / 1_000) - 30;
  const input = await sign(fixture({ deployment, preparedAt }));
  const directory = await mkdtemp(join(tmpdir(), "treeswap-service-isolation-"));
  try {
    const recordPath = join(directory, "record.json");
    const policyPath = join(directory, "policy.json");
    const attestationsPath = join(directory, "attestations.json");
    await Promise.all([
      writeFile(recordPath, JSON.stringify(input.record)),
      writeFile(policyPath, JSON.stringify(input.policy)),
      writeFile(attestationsPath, JSON.stringify(input.attestations)),
    ]);
    const participant = input.record.participants[0];
    const payload = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-service-isolation-attestation.mjs",
      "--record", recordPath,
      "--policy", policyPath,
      "--role", participant.role,
      "--operator-id", participant.operatorId,
    ], { encoding: "utf8" }));
    assert.equal(payload.primaryType, "ServiceIsolationAttestation");
    assert.equal(payload.scope.includes("no-secrets"), true);
    assert.equal(JSON.stringify(payload).includes("signature"), false);

    const summary = JSON.parse(execFileSync(process.execPath, [
      "scripts/verify-service-isolation-evidence.mjs",
      "--record", recordPath,
      "--policy", policyPath,
      "--attestations", attestationsPath,
    ], { encoding: "utf8" }));
    assert.equal(summary.serviceCount, REQUIRED_ISOLATED_SERVICES.length);
    assert.equal(summary.authorizations.funding, false);
    assert.equal(JSON.stringify(summary).includes("signature"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
