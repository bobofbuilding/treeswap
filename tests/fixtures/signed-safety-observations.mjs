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
  return REQUIRED_SAFETY_CHECKS.map((kind, index) => Object.freeze({
    kind,
    collectorId: id(`treeswap-test-safety-collector:${kind}`).toLowerCase(),
    wallet: new Wallet(`0x${(index + 1).toString(16).padStart(64, "0")}`),
  }));
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
    collectors: Object.freeze(collectors.map(({ kind, collectorId, wallet }) => Object.freeze({
      kind,
      collectorId,
      signer: wallet.address,
    }))),
  });
  const policyDigest = safetyMonitorPolicyDigest(policy);

  async function observations(overrides = {}) {
    return Promise.all(collectors.map(async ({ kind, wallet }) => {
      const override = overrides[kind] ?? {};
      const observedAt = override.observedAt ?? now - 2;
      const validUntil = override.validUntil ?? observedAt + maximumObservationAgeSeconds;
      const prepared = prepareSafetyObservation({
        policy,
        expectedPolicyDigest: policyDigest,
        kind,
        status: override.status ?? "healthy",
        observedAt,
        validUntil,
        evidenceDigest: override.evidenceDigest ?? id(`safety-monitor:${kind}`).toLowerCase(),
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
