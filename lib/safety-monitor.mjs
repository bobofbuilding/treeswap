import { keccak256, toUtf8Bytes } from "ethers";
import {
  REQUIRED_SAFETY_CHECKS,
  verifiedSafetyObservationBinding,
} from "./safety-observation-attestation.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
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
  if (keys.length !== 4 || keys.join("|") !== "evidenceDigest|kind|observedAt|status") return null;
  if (!REQUIRED_SAFETY_CHECKS.includes(value.kind)) return null;
  if (value.status !== "healthy" && value.status !== "unsafe") return null;
  if (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0) return null;
  if (!BYTES32.test(String(value.evidenceDigest ?? ""))) return null;
  try {
    const binding = verifiedSafetyObservationBinding(value);
    if (binding.policyDigest !== expectedPolicyDigest
        || binding.maximumObservationAgeSeconds !== maximumObservationAgeSeconds) return null;
    return Object.freeze({ observation: value, binding });
  } catch {
    return null;
  }
}

function monitorEvaluation({ evidence, observedAt, reasonCodes, monitorPolicyDigest }) {
  const evidenceSetDigest = digest({
    schema: "treeswap.safety-monitor-evidence-set.v2",
    monitorPolicyDigest,
    evidence,
  });
  const sortedReasons = Object.freeze([...new Set(reasonCodes)].sort());
  const alertBody = Object.freeze({
    schema: "treeswap.safety-monitor-alert.v2",
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
  const accepted = new Map();

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
        if (accepted.has(observation.kind)) {
          reasons.add(`${observation.kind.toUpperCase().replaceAll("-", "_")}_DUPLICATE`);
          continue;
        }
        accepted.set(observation.kind, verified);
      }
    } catch { reasons.add("MONITOR_INPUT_INVALID"); }
  }

  for (const kind of REQUIRED_SAFETY_CHECKS) {
    const code = kind.toUpperCase().replaceAll("-", "_");
    const verified = accepted.get(kind);
    if (!verified) {
      reasons.add(`${code}_MISSING`);
      continue;
    }
    const { observation, binding } = verified;
    if (observation.observedAt > observedAt) reasons.add(`${code}_FUTURE`);
    else if (observedAt - observation.observedAt > maximumAge) reasons.add(`${code}_STALE`);
    if (binding.validUntil <= observedAt) reasons.add(`${code}_EXPIRED`);
    if (observation.status !== "healthy") reasons.add(`${code}_UNSAFE`);
  }

  const evidence = REQUIRED_SAFETY_CHECKS
    .filter((kind) => accepted.has(kind))
    .map((kind) => Object.freeze({ kind, evidenceDigest: accepted.get(kind).observation.evidenceDigest }));
  return monitorEvaluation({
    evidence,
    observedAt,
    reasonCodes: [...reasons],
    monitorPolicyDigest,
  });
}

function safeClosureResult(value, field) {
  return value && typeof value === "object" && value[field] === true;
}

async function boundedCall(callback, alert, timeoutMs) {
  if (typeof callback !== "function") return null;
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback(alert, { signal: controller.signal })),
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
  maximumObservationAgeSeconds,
  expectedSafetyPolicyDigest,
  actionTimeoutMs = 30_000,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  closeQuoteIssuance,
  haltOnchainGate,
  deliverAlert,
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
  let observedAt;
  try { observedAt = safeInteger(nowSeconds(), "nowSeconds"); } catch { observedAt = Math.floor(Date.now() / 1_000); }
  let evaluation;
  try {
    evaluation = evaluateSafetyMonitor({
      observations,
      now: observedAt,
      maximumObservationAgeSeconds,
      expectedSafetyPolicyDigest,
    });
  } catch {
    evaluation = monitorEvaluation({
      evidence: [],
      observedAt,
      reasonCodes: ["MONITOR_INPUT_INVALID"],
      monitorPolicyDigest: BYTES32.test(String(expectedSafetyPolicyDigest ?? "").toLowerCase())
        ? String(expectedSafetyPolicyDigest).toLowerCase()
        : ZERO_DIGEST,
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
      newExposureClosed: false,
    });
  }

  let quoteIssuanceClosed = false;
  let onchainGateHalted = false;
  let alertDelivered = false;
  try {
    const result = await boundedCall(closeQuoteIssuance, evaluation.alert, timeoutMs);
    quoteIssuanceClosed = safeClosureResult(result, "closed");
  } catch {}
  try {
    const result = await boundedCall(haltOnchainGate, evaluation.alert, timeoutMs);
    onchainGateHalted = safeClosureResult(result, "halted")
      && result.reasonDigest === evaluation.alertDigest
      && BYTES32.test(String(result.transactionHash ?? ""));
  } catch {}
  try {
    const result = await boundedCall(deliverAlert, evaluation.alert, timeoutMs);
    alertDelivered = safeClosureResult(result, "delivered");
  } catch {}

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
    newExposureClosed,
  });
}
