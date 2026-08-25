import { Wallet, id } from "ethers";
import {
  bindSafetyMonitorActions,
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
  const quoteClosure = Object.freeze({
    routeId: id("treeswap-test-quote-closure-route").toLowerCase(),
    operatorId: id("treeswap-test-quote-closure-operator").toLowerCase(),
  });
  const guardianBroadcasters = Object.freeze([0, 1].map((index) => Object.freeze({
    routeId: id(`treeswap-test-guardian-broadcaster:${index}`).toLowerCase(),
    operatorId: id(`treeswap-test-guardian-operator:${index}`).toLowerCase(),
  })).sort((left, right) => left.routeId < right.routeId ? -1 : 1));
  const gateConfirmers = Object.freeze([0, 1].map((index) => Object.freeze({
    routeId: id(`treeswap-test-gate-confirmer:${index}`).toLowerCase(),
    operatorId: id(`treeswap-test-gate-confirmer-operator:${index}`).toLowerCase(),
  })).sort((left, right) => left.routeId < right.routeId ? -1 : 1));
  const alertRoutes = Object.freeze([0, 1].map((index) => Object.freeze({
    routeId: id(`treeswap-test-alert-route:${index}`).toLowerCase(),
    operatorId: id(`treeswap-test-alert-operator:${index}`).toLowerCase(),
  })).sort((left, right) => left.routeId < right.routeId ? -1 : 1));
  const policy = Object.freeze({
    schema: SAFETY_MONITOR_POLICY_SCHEMA,
    chainId: "31337",
    verifyingContract: VERIFYING_CONTRACT,
    releaseRecordDigest: id("treeswap-test-release-record").toLowerCase(),
    validFrom: now - 3_600,
    validUntil: now + 3_600,
    maximumObservationAgeSeconds,
    quoteClosure,
    guardianBroadcasters,
    gateConfirmers,
    alertRoutes,
    collectors: Object.freeze(collectors.map(({ kind, collectorId, operatorId, wallet }) => Object.freeze({
      kind,
      collectorId,
      operatorId,
      signer: wallet.address,
    }))),
  });
  const policyDigest = safetyMonitorPolicyDigest(policy);

  function bindActions({
    boundAt = now,
    closeQuotes = async () => ({ closed: true }),
    guardianActions = guardianBroadcasters.map((route) => async (alert) => ({
      halted: true,
      reasonDigest: alert.alertDigest,
      transactionHash: route.routeId,
    })),
    gateConfirmationActions = gateConfirmers.map(() => async (alert, { acceptedTransactionHashes }) => ({
      confirmed: true,
      finalized: true,
      alertDigest: alert.alertDigest,
      transactionHash: acceptedTransactionHashes[0],
      gateAddress: VERIFYING_CONTRACT,
      blockNumber: "10",
      blockHash: id("treeswap-test-gate-confirmation-block").toLowerCase(),
      gateOpen: false,
      emergencyHalted: true,
      openUntil: "0",
      activeRiskDigest: `0x${"00".repeat(32)}`,
      pendingRiskDigest: `0x${"00".repeat(32)}`,
      pendingExecuteAfter: "0",
      pendingValidUntil: "0",
    })),
    alertActions = alertRoutes.map(() => async () => ({ delivered: true })),
  } = {}) {
    return bindSafetyMonitorActions({
      policy,
      expectedPolicyDigest: policyDigest,
      now: boundAt,
      quoteClosure: { ...quoteClosure, execute: closeQuotes },
      guardianBroadcasters: guardianBroadcasters.map((route, index) => ({
        ...route,
        execute: guardianActions[index],
      })),
      gateConfirmers: gateConfirmers.map((route, index) => ({
        ...route,
        execute: gateConfirmationActions[index],
      })),
      alertRoutes: alertRoutes.map((route, index) => ({
        ...route,
        execute: alertActions[index],
      })),
    });
  }

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
    quoteClosure,
    guardianBroadcasters,
    gateConfirmers,
    alertRoutes,
    bindActions,
    observations,
  });
}
