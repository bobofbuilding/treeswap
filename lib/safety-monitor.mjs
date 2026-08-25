import { keccak256, toUtf8Bytes } from "ethers";
import {
  REQUIRED_SAFETY_CHECKS,
  REQUIRED_SAFETY_COLLECTORS_PER_DOMAIN,
  verifiedSafetyObservationBinding,
  verifiedSafetyMonitorActionBinding,
} from "./safety-observation-attestation.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const LOWERCASE_ADDRESS = /^0x[0-9a-f]{40}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;

export { REQUIRED_SAFETY_CHECKS };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function safeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function exactObservation(value, expectedPolicyDigest, maximumObservationAgeSeconds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 5 || keys.join("|") !== "collectorId|evidenceDigest|kind|observedAt|status") return null;
  if (!REQUIRED_SAFETY_CHECKS.includes(value.kind)) return null;
  if (value.status !== "healthy" && value.status !== "unsafe") return null;
  if (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0) return null;
  if (!BYTES32.test(String(value.collectorId ?? ""))) return null;
  if (!BYTES32.test(String(value.evidenceDigest ?? ""))) return null;
  try {
    const binding = verifiedSafetyObservationBinding(value);
    if (binding.policyDigest !== expectedPolicyDigest
        || binding.maximumObservationAgeSeconds !== maximumObservationAgeSeconds
        || binding.collectorId !== value.collectorId) return null;
    return Object.freeze({ observation: value, binding });
  } catch {
    return null;
  }
}

function monitorEvaluation({ evidence, observedAt, reasonCodes, monitorPolicyDigest }) {
  const evidenceSetDigest = digest({
    schema: "treeswap.safety-monitor-evidence-set.v5",
    monitorPolicyDigest,
    evidence,
  });
  const sortedReasons = Object.freeze([...new Set(reasonCodes)].sort());
  const alertBody = Object.freeze({
    schema: "treeswap.safety-monitor-alert.v5",
    triggeredAt: observedAt,
    reasonCodes: sortedReasons,
    monitorPolicyDigest,
    evidenceSetDigest,
  });
  const alertDigest = digest(alertBody);
  return Object.freeze({
    healthy: sortedReasons.length === 0,
    reasonCodes: sortedReasons,
    monitorPolicyDigest,
    evidenceSetDigest,
    alertDigest,
    alert: Object.freeze({ ...alertBody, alertDigest }),
  });
}

export function evaluateSafetyMonitor({
  observations,
  now,
  maximumObservationAgeSeconds,
  expectedSafetyPolicyDigest,
}) {
  const observedAt = safeInteger(now, "now");
  const maximumAge = safeInteger(maximumObservationAgeSeconds, "maximumObservationAgeSeconds");
  if (maximumAge === 0) throw new RangeError("maximumObservationAgeSeconds must be positive");
  const monitorPolicyDigest = String(expectedSafetyPolicyDigest ?? "").toLowerCase();
  if (!BYTES32.test(monitorPolicyDigest) || monitorPolicyDigest === ZERO_DIGEST) {
    throw new TypeError("expectedSafetyPolicyDigest must be a nonzero lowercase bytes32 digest");
  }
  const reasons = new Set();
  const accepted = new Map(REQUIRED_SAFETY_CHECKS.map((kind) => [kind, new Map()]));

  if (!Array.isArray(observations)) {
    reasons.add("MONITOR_INPUT_INVALID");
  } else {
    try {
      for (const raw of observations) {
        const verified = exactObservation(raw, monitorPolicyDigest, maximumAge);
        if (!verified) {
          reasons.add("MONITOR_INPUT_INVALID");
          continue;
        }
        const { observation } = verified;
        const domain = accepted.get(observation.kind);
        if (domain.has(observation.collectorId)) {
          reasons.add(`${observation.kind.toUpperCase().replaceAll("-", "_")}_COLLECTOR_DUPLICATE`);
          continue;
        }
        domain.set(observation.collectorId, verified);
      }
    } catch { reasons.add("MONITOR_INPUT_INVALID"); }
  }

  for (const kind of REQUIRED_SAFETY_CHECKS) {
    const code = kind.toUpperCase().replaceAll("-", "_");
    const domain = accepted.get(kind);
    if (domain.size === 0) {
      reasons.add(`${code}_MISSING`);
    }
    if (domain.size < REQUIRED_SAFETY_COLLECTORS_PER_DOMAIN) reasons.add(`${code}_COLLECTOR_OUTAGE`);
    const statuses = new Set();
    const operators = new Set();
    for (const { observation, binding } of domain.values()) {
      statuses.add(observation.status);
      operators.add(binding.operatorId);
      if (observation.observedAt > observedAt) reasons.add(`${code}_FUTURE`);
      else if (observedAt - observation.observedAt > maximumAge) reasons.add(`${code}_STALE`);
      if (binding.validUntil <= observedAt) reasons.add(`${code}_EXPIRED`);
      if (observation.status !== "healthy") reasons.add(`${code}_UNSAFE`);
    }
    if (domain.size === REQUIRED_SAFETY_COLLECTORS_PER_DOMAIN
        && operators.size !== REQUIRED_SAFETY_COLLECTORS_PER_DOMAIN) {
      reasons.add(`${code}_OPERATOR_DIVERSITY`);
    }
    if (statuses.size > 1) reasons.add(`${code}_DISAGREEMENT`);
  }

  const evidence = REQUIRED_SAFETY_CHECKS
    .flatMap((kind) => [...accepted.get(kind).values()]
      .sort((left, right) => {
        if (left.observation.collectorId === right.observation.collectorId) return 0;
        return left.observation.collectorId < right.observation.collectorId ? -1 : 1;
      })
      .map(({ observation, binding }) => Object.freeze({
        kind,
        collectorId: observation.collectorId,
        operatorId: binding.operatorId,
        status: observation.status,
        observedAt: observation.observedAt,
        evidenceDigest: observation.evidenceDigest,
      })));
  return monitorEvaluation({
    evidence,
    observedAt,
    reasonCodes: [...reasons],
    monitorPolicyDigest,
  });
}

function exactResult(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function safeClosureResult(value, field) {
  try {
    return exactResult(value, [field]) && value[field] === true;
  } catch {
    return false;
  }
}

function safeBroadcastTransactionHash(value, alertDigest) {
  try {
    const transactionHash = String(value?.transactionHash ?? "").toLowerCase();
    return exactResult(value, ["halted", "reasonDigest", "transactionHash"])
      && value.halted === true
      && value.reasonDigest === alertDigest
      && value.transactionHash === transactionHash
      && BYTES32.test(transactionHash)
      && transactionHash !== ZERO_DIGEST
      ? transactionHash
      : null;
  } catch {
    return null;
  }
}

function safeGateConfirmation(value, {
  alertDigest,
  acceptedTransactionHashes,
  verifyingContract,
}) {
  try {
    if (!exactResult(value, [
      "activeRiskDigest",
      "alertDigest",
      "blockHash",
      "blockNumber",
      "confirmed",
      "emergencyHalted",
      "finalized",
      "gateAddress",
      "gateOpen",
      "openUntil",
      "pendingExecuteAfter",
      "pendingRiskDigest",
      "pendingValidUntil",
      "transactionHash",
    ])) return null;
    const transactionHash = String(value.transactionHash ?? "").toLowerCase();
    const blockHash = String(value.blockHash ?? "").toLowerCase();
    const blockNumber = String(value.blockNumber ?? "");
    if (value.confirmed !== true
        || value.finalized !== true
        || value.alertDigest !== alertDigest
        || value.transactionHash !== transactionHash
        || !acceptedTransactionHashes.includes(transactionHash)
        || value.gateAddress !== verifyingContract
        || !LOWERCASE_ADDRESS.test(value.gateAddress)
        || value.blockHash !== blockHash
        || !BYTES32.test(blockHash)
        || blockHash === ZERO_DIGEST
        || !POSITIVE_DECIMAL.test(blockNumber)
        || BigInt(blockNumber) > 18_446_744_073_709_551_615n
        || value.gateOpen !== false
        || value.emergencyHalted !== true
        || value.openUntil !== "0"
        || value.activeRiskDigest !== ZERO_DIGEST
        || value.pendingRiskDigest !== ZERO_DIGEST
        || value.pendingExecuteAfter !== "0"
        || value.pendingValidUntil !== "0") return null;
    return JSON.stringify({
      transactionHash,
      blockNumber,
      blockHash,
      gateAddress: value.gateAddress,
      alertDigest: value.alertDigest,
    });
  } catch {
    return null;
  }
}

async function boundedCall(callback, alert, timeoutMs, context = {}) {
  if (typeof callback !== "function") return null;
  const controller = new AbortController();
  const callbackContext = Object.freeze({ ...context, signal: controller.signal });
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback(alert, callbackContext)),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runSafetyMonitorCycle({
  observations,
  actionPlan,
  actionTimeoutMs = 30_000,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
}) {
  let timeoutMs = 30_000;
  let actionTimeoutInvalid = false;
  try {
    const configuredTimeout = safeInteger(actionTimeoutMs, "actionTimeoutMs");
    if (configuredTimeout === 0 || configuredTimeout > 300_000) throw new RangeError("actionTimeoutMs is outside its safety bound");
    timeoutMs = configuredTimeout;
  } catch {
    actionTimeoutInvalid = true;
  }
  let actionBinding;
  try { actionBinding = verifiedSafetyMonitorActionBinding(actionPlan); } catch {}
  let observedAt;
  let clockInvalid = false;
  try { observedAt = safeInteger(nowSeconds(), "nowSeconds"); } catch {
    observedAt = Math.floor(Date.now() / 1_000);
    clockInvalid = true;
  }
  let evaluation;
  if (!actionBinding) {
    evaluation = monitorEvaluation({
      evidence: [],
      observedAt,
      reasonCodes: ["MONITOR_ACTION_PLAN_INVALID"],
      monitorPolicyDigest: ZERO_DIGEST,
    });
  } else if (clockInvalid) {
    evaluation = monitorEvaluation({
      evidence: [],
      observedAt,
      reasonCodes: ["MONITOR_INPUT_INVALID"],
      monitorPolicyDigest: actionBinding.policyDigest,
    });
  } else try {
    evaluation = evaluateSafetyMonitor({
      observations,
      now: observedAt,
      maximumObservationAgeSeconds: actionBinding.maximumObservationAgeSeconds,
      expectedSafetyPolicyDigest: actionBinding.policyDigest,
    });
  } catch {
    evaluation = monitorEvaluation({
      evidence: [],
      observedAt,
      reasonCodes: ["MONITOR_INPUT_INVALID"],
      monitorPolicyDigest: actionBinding.policyDigest,
    });
  }
  if (actionBinding && !clockInvalid
      && (observedAt < actionBinding.validFrom || observedAt >= actionBinding.validUntil)) {
    evaluation = monitorEvaluation({
      evidence: [],
      observedAt,
      reasonCodes: [...evaluation.reasonCodes, "MONITOR_POLICY_INACTIVE"],
      monitorPolicyDigest: actionBinding.policyDigest,
    });
  }
  if (actionTimeoutInvalid) {
    evaluation = monitorEvaluation({
      evidence: [],
      observedAt,
      reasonCodes: [...evaluation.reasonCodes, "MONITOR_INPUT_INVALID"],
      monitorPolicyDigest: evaluation.monitorPolicyDigest,
    });
  }
  if (evaluation.healthy) {
    return Object.freeze({
      outcome: "HEALTHY",
      alertDigest: null,
      quoteIssuanceClosed: false,
      onchainGateHalted: false,
      alertDelivered: false,
      guardianBroadcastsAttempted: 0,
      guardianBroadcastsAccepted: 0,
      guardianBroadcastDegraded: false,
      gateConfirmationsAttempted: 0,
      gateConfirmationsSucceeded: 0,
      gateConfirmationAgreement: false,
      gateConfirmationDegraded: false,
      alertRoutesAttempted: 0,
      alertRoutesDelivered: 0,
      alertDeliveryDegraded: false,
      newExposureClosed: false,
    });
  }

  let quoteIssuanceClosed = false;
  let onchainGateHalted = false;
  let alertDelivered = false;
  let guardianBroadcastsAttempted = 0;
  let guardianBroadcastsAccepted = 0;
  let gateConfirmationsAttempted = 0;
  let gateConfirmationsSucceeded = 0;
  let gateConfirmationAgreement = false;
  let alertRoutesAttempted = 0;
  let alertRoutesDelivered = 0;
  if (actionBinding) {
    try {
      const result = await boundedCall(actionBinding.quoteClosure.execute, evaluation.alert, timeoutMs);
      quoteIssuanceClosed = safeClosureResult(result, "closed");
    } catch {}
    guardianBroadcastsAttempted = actionBinding.guardianBroadcasters.length;
    const guardianResults = await Promise.all(actionBinding.guardianBroadcasters.map(async ({ execute }) => {
      try { return await boundedCall(execute, evaluation.alert, timeoutMs); } catch { return null; }
    }));
    const acceptedTransactionHashes = Object.freeze([...new Set(guardianResults
      .map((result) => safeBroadcastTransactionHash(result, evaluation.alertDigest))
      .filter(Boolean))].sort());
    guardianBroadcastsAccepted = guardianResults
      .filter((result) => safeBroadcastTransactionHash(result, evaluation.alertDigest)).length;
    gateConfirmationsAttempted = actionBinding.gateConfirmers.length;
    const gateConfirmationResults = await Promise.all(actionBinding.gateConfirmers.map(async ({ execute }) => {
      try {
        return await boundedCall(execute, evaluation.alert, timeoutMs, { acceptedTransactionHashes });
      } catch { return null; }
    }));
    const confirmationFingerprints = gateConfirmationResults.map((result) => safeGateConfirmation(result, {
      alertDigest: evaluation.alertDigest,
      acceptedTransactionHashes,
      verifyingContract: actionBinding.verifyingContract,
    })).filter(Boolean);
    gateConfirmationsSucceeded = confirmationFingerprints.length;
    gateConfirmationAgreement = gateConfirmationsSucceeded === gateConfirmationsAttempted
      && new Set(confirmationFingerprints).size === 1;
    onchainGateHalted = gateConfirmationAgreement;
    alertRoutesAttempted = actionBinding.alertRoutes.length;
    const alertResults = await Promise.all(actionBinding.alertRoutes.map(async ({ execute }) => {
      try { return await boundedCall(execute, evaluation.alert, timeoutMs); } catch { return null; }
    }));
    alertRoutesDelivered = alertResults.filter((result) => safeClosureResult(result, "delivered")).length;
    alertDelivered = alertRoutesDelivered > 0;
  }

  const newExposureClosed = quoteIssuanceClosed && onchainGateHalted;
  return Object.freeze({
    outcome: newExposureClosed
      ? alertDelivered ? "HALTED_AND_ALERTED" : "HALTED_ALERT_UNDELIVERED"
      : "HALT_INCOMPLETE",
    alertDigest: evaluation.alertDigest,
    reasonCodes: evaluation.reasonCodes,
    quoteIssuanceClosed,
    onchainGateHalted,
    alertDelivered,
    guardianBroadcastsAttempted,
    guardianBroadcastsAccepted,
    guardianBroadcastDegraded: guardianBroadcastsAccepted < guardianBroadcastsAttempted,
    gateConfirmationsAttempted,
    gateConfirmationsSucceeded,
    gateConfirmationAgreement,
    gateConfirmationDegraded: !gateConfirmationAgreement,
    alertRoutesAttempted,
    alertRoutesDelivered,
    alertDeliveryDegraded: alertRoutesDelivered < alertRoutesAttempted,
    newExposureClosed,
  });
}
