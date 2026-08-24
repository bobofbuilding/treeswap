import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import {
  prepareSafetyObservation,
  SAFETY_MONITOR_POLICY_SCHEMA,
  SAFETY_OBSERVATION_SCHEMA,
  safetyMonitorPolicyDigest,
  verifySafetyObservationAttestation,
  verifiedSafetyObservationBinding,
} from "../lib/safety-observation-attestation.mjs";
import { createSignedSafetyObservationFixture } from "./fixtures/signed-safety-observations.mjs";

const NOW = 2_100_000_000;
const safety = createSignedSafetyObservationFixture({ now: NOW });

async function signedAttestation(overrides = {}) {
  const collector = safety.collectors.find((candidate) => candidate.kind === "price-quorum");
  const prepared = prepareSafetyObservation({
    policy: safety.policy,
    expectedPolicyDigest: safety.policyDigest,
    kind: "price-quorum",
    status: "healthy",
    observedAt: NOW - 2,
    validUntil: NOW + 10,
    evidenceDigest: id("verified-price-quorum-evidence").toLowerCase(),
    ...overrides,
  });
  return Object.freeze({
    ...prepared.message,
    signature: await collector.wallet.signTypedData(prepared.domain, prepared.types, prepared.message),
  });
}

test("verifies a short-lived EIP-712 observation against the exact release-bound collector policy", async () => {
  const observation = verifySafetyObservationAttestation({
    policy: safety.policy,
    expectedPolicyDigest: safety.policyDigest,
    attestation: await signedAttestation(),
    now: NOW,
    maximumClockSkewSeconds: 1,
  });
  assert.deepEqual(observation, {
    kind: "price-quorum",
    status: "healthy",
    observedAt: NOW - 2,
    evidenceDigest: id("verified-price-quorum-evidence").toLowerCase(),
  });
  const binding = verifiedSafetyObservationBinding(observation);
  assert.equal(binding.policyDigest, safety.policyDigest);
  assert.equal(binding.releaseRecordDigest, safety.policy.releaseRecordDigest);
  assert.equal(binding.validUntil, NOW + 10);
});

test("rejects mutation, copied provenance, wrong signer, expiry, and policy substitution", async () => {
  const attestation = await signedAttestation();
  const verify = (candidate, overrides = {}) => verifySafetyObservationAttestation({
    policy: safety.policy,
    expectedPolicyDigest: safety.policyDigest,
    attestation: candidate,
    now: NOW,
    maximumClockSkewSeconds: 1,
    ...overrides,
  });
  assert.throws(
    () => verify({ ...attestation, evidenceDigest: id("tampered").toLowerCase() }),
    /signature|signer/,
  );
  assert.throws(
    () => verify({ ...attestation, schema: "treeswap.safety-observation-attestation.v0" }),
    /schema is invalid/,
  );
  assert.throws(() => verify(attestation, { now: NOW + 10 }), /expired/);

  const wrongCollector = safety.collectors.find((candidate) => candidate.kind === "solver-capacity");
  const prepared = prepareSafetyObservation({
    policy: safety.policy,
    expectedPolicyDigest: safety.policyDigest,
    kind: "price-quorum",
    status: "healthy",
    observedAt: NOW - 2,
    validUntil: NOW + 10,
    evidenceDigest: id("verified-price-quorum-evidence").toLowerCase(),
  });
  const wrongSignature = await wrongCollector.wallet.signTypedData(prepared.domain, prepared.types, prepared.message);
  assert.throws(() => verify({ ...prepared.message, signature: wrongSignature }), /not the configured collector/);

  const substitutedPolicy = {
    ...safety.policy,
    releaseRecordDigest: id("substituted-release").toLowerCase(),
  };
  assert.notEqual(safetyMonitorPolicyDigest(substitutedPolicy), safety.policyDigest);
  assert.throws(() => verify(attestation, { policy: substitutedPolicy }), /policy digest does not match/);

  const observation = verify(attestation);
  assert.throws(() => verifiedSafetyObservationBinding({ ...observation }), /lacks same-process/);
});

test("requires a complete, exact, canonically ordered policy with separate collector identities", () => {
  assert.equal(safety.policy.schema, SAFETY_MONITOR_POLICY_SCHEMA);
  assert.equal(SAFETY_OBSERVATION_SCHEMA, "treeswap.safety-observation-attestation.v1");
  assert.throws(
    () => safetyMonitorPolicyDigest({ ...safety.policy, extra: true }),
    /fields are not exact/,
  );
  assert.throws(
    () => safetyMonitorPolicyDigest({
      ...safety.policy,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    }),
    /nonzero Ethereum address/,
  );
  assert.throws(
    () => safetyMonitorPolicyDigest({
      ...safety.policy,
      collectors: [...safety.policy.collectors].reverse(),
    }),
    /canonically ordered/,
  );
  assert.throws(
    () => safetyMonitorPolicyDigest({
      ...safety.policy,
      collectors: safety.policy.collectors.map((collector, index) => index === 1
        ? { ...collector, signer: safety.policy.collectors[0].signer }
        : collector),
    }),
    /identities and signers must be distinct/,
  );
});
