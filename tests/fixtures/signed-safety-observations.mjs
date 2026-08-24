import { Wallet, id } from "ethers";
import {
  prepareSafetyObservation,
  REQUIRED_SAFETY_CHECKS,
  SAFETY_MONITOR_POLICY_SCHEMA,
  safetyMonitorPolicyDigest,
  verifySafetyObservationAttestation,
} from "../../lib/safety-observation-attestation.mjs";

const VERIFYING_CONTRACT = "0x1111111111111111111111111111111111111111";

function wallets() {
  return REQUIRED_SAFETY_CHECKS.flatMap((kind, kindIndex) => [0, 1].map((operatorIndex) => Object.freeze({
    kind,
    operatorIndex,
    operatorId: id(`treeswap-test-safety-operator:${operatorIndex}`).toLowerCase(),
    collectorId: id(`treeswap-test-safety-collector:${kind}:${operatorIndex}`).toLowerCase(),
    wallet: new Wallet(`0x${(kindIndex * 2 + operatorIndex + 1).toString(16).padStart(64, "0")}`),
  })).sort((left, right) => left.collectorId < right.collectorId ? -1 : 1));
}

export function createSignedSafetyObservationFixture({
  now,
  maximumObservationAgeSeconds = 15,
} = {}) {
  const collectors = wallets();
  const policy = Object.freeze({
    schema: SAFETY_MONITOR_POLICY_SCHEMA,
    chainId: "31337",
    verifyingContract: VERIFYING_CONTRACT,
    releaseRecordDigest: id("treeswap-test-release-record").toLowerCase(),
    validFrom: now - 3_600,
    validUntil: now + 3_600,
    maximumObservationAgeSeconds,
    collectors: Object.freeze(collectors.map(({ kind, collectorId, operatorId, wallet }) => Object.freeze({
      kind,
      collectorId,
      operatorId,
      signer: wallet.address,
    }))),
  });
  const policyDigest = safetyMonitorPolicyDigest(policy);

  async function observations(overrides = {}) {
    return Promise.all(collectors.map(async ({ kind, collectorId, operatorIndex, wallet }) => {
      const override = overrides[collectorId] ?? overrides[`${kind}:${operatorIndex}`] ?? overrides[kind] ?? {};
      const observedAt = override.observedAt ?? now - 2;
      const validUntil = override.validUntil ?? observedAt + maximumObservationAgeSeconds;
      const prepared = prepareSafetyObservation({
        policy,
        expectedPolicyDigest: policyDigest,
        collectorId,
        kind,
        status: override.status ?? "healthy",
        observedAt,
        validUntil,
        evidenceDigest: override.evidenceDigest ?? id(`safety-monitor:${kind}:${collectorId}`).toLowerCase(),
      });
      const signature = await wallet.signTypedData(prepared.domain, prepared.types, prepared.message);
      return verifySafetyObservationAttestation({
        policy,
        expectedPolicyDigest: policyDigest,
        attestation: Object.freeze({ ...prepared.message, signature }),
        now: override.verifiedAt ?? Math.min(now, validUntil - 1),
        maximumClockSkewSeconds: 1,
      });
    }));
  }

  return Object.freeze({
    policy,
    policyDigest,
    collectors,
    observations,
  });
}
