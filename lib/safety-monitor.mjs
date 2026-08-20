import { keccak256, toUtf8Bytes } from "ethers";

const BYTES32 = /^0x[0-9a-f]{64}$/;

export const REQUIRED_SAFETY_CHECKS = Object.freeze([
  "asset-reconciliation",
  "audit-pipeline",
  "bit-contract",
  "ethereum-finality",
  "evm-provider-quorum",
  "lightning-node",
  "price-quorum",
  "solver-capacity",
]);

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

function exactObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 4 || keys.join("|") !== "evidenceDigest|kind|observedAt|status") return null;
  if (!REQUIRED_SAFETY_CHECKS.includes(value.kind)) return null;
  if (value.status !== "healthy" && value.status !== "unsafe") return null;
  if (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0) return null;
  if (!BYTES32.test(String(value.evidenceDigest ?? ""))) return null;
  return Object.freeze({
    kind: value.kind,
    status: value.status,
    observedAt: value.observedAt,
    evidenceDigest: value.evidenceDigest,
  });
}

function monitorEvaluation({ evidence, observedAt, reasonCodes }) {
  const evidenceSetDigest = digest({ schema: "treeswap.safety-monitor-evidence-set.v1", evidence });
  const sortedReasons = Object.freeze([...new Set(reasonCodes)].sort());
  const alertBody = Object.freeze({
    schema: "treeswap.safety-monitor-alert.v1",
    triggeredAt: observedAt,
    reasonCodes: sortedReasons,
    evidenceSetDigest,
  });
  const alertDigest = digest(alertBody);
  return Object.freeze({
    healthy: sortedReasons.length === 0,
    reasonCodes: sortedReasons,
    evidenceSetDigest,
    alertDigest,
    alert: Object.freeze({ ...alertBody, alertDigest }),
  });
}

export function evaluateSafetyMonitor({ observations, now, maximumObservationAgeSeconds }) {
  const observedAt = safeInteger(now, "now");
  const maximumAge = safeInteger(maximumObservationAgeSeconds, "maximumObservationAgeSeconds");
  if (maximumAge === 0) throw new RangeError("maximumObservationAgeSeconds must be positive");
  const reasons = new Set();
  const accepted = new Map();

  if (!Array.isArray(observations)) {
    reasons.add("MONITOR_INPUT_INVALID");
  } else {
    try {
      for (const raw of observations) {
        const observation = exactObservation(raw);
        if (!observation) {
          reasons.add("MONITOR_INPUT_INVALID");
          continue;
        }
        if (accepted.has(observation.kind)) {
          reasons.add(`${observation.kind.toUpperCase().replaceAll("-", "_")}_DUPLICATE`);
          continue;
        }
        accepted.set(observation.kind, observation);
      }
    } catch { reasons.add("MONITOR_INPUT_INVALID"); }
  }

  for (const kind of REQUIRED_SAFETY_CHECKS) {
    const code = kind.toUpperCase().replaceAll("-", "_");
    const observation = accepted.get(kind);
    if (!observation) {
      reasons.add(`${code}_MISSING`);
      continue;
    }
    if (observation.observedAt > observedAt) reasons.add(`${code}_FUTURE`);
    else if (observedAt - observation.observedAt > maximumAge) reasons.add(`${code}_STALE`);
    if (observation.status !== "healthy") reasons.add(`${code}_UNSAFE`);
  }

  const evidence = REQUIRED_SAFETY_CHECKS
    .filter((kind) => accepted.has(kind))
    .map((kind) => Object.freeze({ kind, evidenceDigest: accepted.get(kind).evidenceDigest }));
  return monitorEvaluation({ evidence, observedAt, reasonCodes: [...reasons] });
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
    });
  } catch {
    evaluation = monitorEvaluation({
      evidence: [],
      observedAt,
      reasonCodes: ["MONITOR_INPUT_INVALID"],
    });
  }
  if (actionTimeoutInvalid) {
    evaluation = monitorEvaluation({
      evidence: [],
      observedAt,
      reasonCodes: [...evaluation.reasonCodes, "MONITOR_INPUT_INVALID"],
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
