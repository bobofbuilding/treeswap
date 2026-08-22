import { evaluateLightningCloseRecovery } from "./lightning-close-monitor.mjs";
import { signLightningCloseCollectorAttestation } from "./lightning-close-collector.mjs";

function safeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function lndBlockHeight(value) {
  if (typeof value === "number") return safeInteger(value, "LND block height");
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("LND block height is invalid");
  }
  return safeInteger(Number(value), "LND block height");
}

export async function collectLightningCloseAttestation({
  lnd,
  collectorId,
  nodeCommitment,
  signingKey,
  attestationLifetimeSeconds,
  requestTimeoutMs,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
}) {
  if (!lnd || typeof lnd.getInfo !== "function"
      || typeof lnd.pendingChannels !== "function"
      || typeof lnd.pendingSweeps !== "function") {
    throw new TypeError("collector requires the exact read-only LND interface");
  }
  const observedAt = safeInteger(nowSeconds(), "collector observation time");
  const timeoutMs = safeInteger(requestTimeoutMs, "collector request timeout", 120_000);
  const lifetimeSeconds = safeInteger(attestationLifetimeSeconds, "collector attestation lifetime", 60);
  if (timeoutMs === 0 || lifetimeSeconds === 0) throw new RangeError("collector bounds must be positive");

  let evidence;
  try {
    const [pendingChannels, pendingSweeps, info] = await Promise.all([
      lnd.pendingChannels(timeoutMs),
      lnd.pendingSweeps(timeoutMs),
      lnd.getInfo(timeoutMs),
    ]);
    evidence = evaluateLightningCloseRecovery({
      pendingChannels,
      pendingSweeps,
      blockHeight: lndBlockHeight(info?.block_height),
      observedAt,
    });
  } catch {
    evidence = evaluateLightningCloseRecovery({
      pendingChannels: null,
      pendingSweeps: null,
      blockHeight: 0,
      observedAt,
    });
  }

  return signLightningCloseCollectorAttestation({
    collectorId,
    nodeCommitment,
    evidence,
    expiresAt: observedAt + lifetimeSeconds,
  }, signingKey);
}
