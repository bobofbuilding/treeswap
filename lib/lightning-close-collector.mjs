import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { lightningCloseSafetyObservation } from "./lightning-close-monitor.mjs";

export const LIGHTNING_CLOSE_COLLECTOR_ATTESTATION_SCHEMA =
  "treeswap.lightning-close-collector-attestation.v2";
export const LIGHTNING_CLOSE_COLLECTOR_QUORUM_SCHEMA =
  "treeswap.lightning-close-collector-quorum.v2";
export const MAXIMUM_LIGHTNING_CLOSE_ATTESTATION_LIFETIME_SECONDS = 60;

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COLLECTOR_ID = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function bytes(value) {
  return Buffer.from(JSON.stringify(canonical(value)));
}

function digest(value) {
  return `0x${createHash("sha256").update(bytes(value)).digest("hex")}`;
}

function safeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function collectorId(value) {
  const normalized = String(value ?? "");
  if (!COLLECTOR_ID.test(normalized)) throw new TypeError("collectorId is invalid");
  return normalized;
}

function bytes32(value, name) {
  const normalized = String(value ?? "");
  if (!BYTES32.test(normalized)) throw new TypeError(`${name} must be lowercase bytes32`);
  return normalized;
}

function reasonCodes(value, status) {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("reasonCodes are invalid");
  const normalized = value.map((entry) => String(entry));
  if (normalized.some((entry) => !REASON_CODE.test(entry))
      || new Set(normalized).size !== normalized.length
      || [...normalized].sort().some((entry, index) => entry !== normalized[index])) {
    throw new TypeError("reasonCodes must be unique, sorted, bounded codes");
  }
  if ((status === "healthy") !== (normalized.length === 0)) {
    throw new Error("collector status and reasonCodes disagree");
  }
  return Object.freeze(normalized);
}

function ed25519PrivateKey(value) {
  const key = value?.type === "private" ? value : createPrivateKey(value);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("collector signing key must be an Ed25519 private key");
  }
  return key;
}

function ed25519PublicKey(value) {
  const key = value?.type === "public" ? value : createPublicKey(value);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("collector public key must be an Ed25519 public key");
  }
  return key;
}

function publicKeyDigest(key) {
  return `0x${createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
}

function normalizeAttestationBody(raw, {
  now,
  expectedCollectorId,
  expectedNodeCommitment,
  maximumLifetimeSeconds,
  maximumClockSkewSeconds,
}) {
  exactKeys(raw, [
    "collectorId",
    "evidenceDigest",
    "expiresAt",
    "nodeCommitment",
    "observedAt",
    "reasonCodes",
    "schema",
    "stateDigest",
    "status",
  ], "collector attestation body");
  if (raw.schema !== LIGHTNING_CLOSE_COLLECTOR_ATTESTATION_SCHEMA) {
    throw new TypeError("collector attestation schema is invalid");
  }
  const id = collectorId(raw.collectorId);
  if (id !== expectedCollectorId) throw new Error("collector identity mismatch");
  const node = bytes32(raw.nodeCommitment, "nodeCommitment");
  if (node !== expectedNodeCommitment) throw new Error("collector node commitment mismatch");
  const status = raw.status;
  if (status !== "healthy" && status !== "unsafe") throw new TypeError("collector status is invalid");
  const observedAt = safeInteger(raw.observedAt, "collector observedAt");
  const expiresAt = safeInteger(raw.expiresAt, "collector expiresAt");
  if (expiresAt <= observedAt || expiresAt - observedAt > maximumLifetimeSeconds) {
    throw new RangeError("collector attestation lifetime is invalid");
  }
  if (observedAt > now + maximumClockSkewSeconds) throw new Error("collector attestation is from the future");
  if (expiresAt < now) throw new Error("collector attestation is expired");
  return Object.freeze({
    schema: LIGHTNING_CLOSE_COLLECTOR_ATTESTATION_SCHEMA,
    collectorId: id,
    nodeCommitment: node,
    status,
    observedAt,
    expiresAt,
    evidenceDigest: bytes32(raw.evidenceDigest, "evidenceDigest"),
    stateDigest: bytes32(raw.stateDigest, "stateDigest"),
    reasonCodes: reasonCodes(raw.reasonCodes, status),
  });
}

function attestationBody(attestation) {
  const { signature: ignored, ...body } = attestation;
  void ignored;
  return body;
}

export function signLightningCloseCollectorAttestation({
  collectorId: rawCollectorId,
  nodeCommitment: rawNodeCommitment,
  evidence,
  expiresAt: rawExpiresAt,
}, signingKey) {
  const observation = lightningCloseSafetyObservation(evidence);
  const id = collectorId(rawCollectorId);
  const nodeCommitment = bytes32(rawNodeCommitment, "nodeCommitment");
  const expiresAt = safeInteger(rawExpiresAt, "collector expiresAt");
  if (expiresAt <= observation.observedAt
      || expiresAt - observation.observedAt > MAXIMUM_LIGHTNING_CLOSE_ATTESTATION_LIFETIME_SECONDS) {
    throw new RangeError("collector attestation lifetime is invalid");
  }
  const body = Object.freeze({
    schema: LIGHTNING_CLOSE_COLLECTOR_ATTESTATION_SCHEMA,
    collectorId: id,
    nodeCommitment,
    status: observation.status,
    observedAt: observation.observedAt,
    expiresAt,
    evidenceDigest: observation.evidenceDigest,
    stateDigest: bytes32(evidence.stateDigest, "stateDigest"),
    reasonCodes: reasonCodes(evidence.reasonCodes, observation.status),
  });
  const signature = sign(null, bytes(body), ed25519PrivateKey(signingKey)).toString("base64");
  return Object.freeze({ ...body, signature });
}

export function verifyLightningCloseCollectorAttestation({
  attestation,
  publicKey,
  expectedCollectorId,
  expectedNodeCommitment,
  now: rawNow,
  maximumLifetimeSeconds: rawMaximumLifetimeSeconds,
  maximumClockSkewSeconds: rawMaximumClockSkewSeconds,
}) {
  exactKeys(attestation, [
    "collectorId",
    "evidenceDigest",
    "expiresAt",
    "nodeCommitment",
    "observedAt",
    "reasonCodes",
    "schema",
    "signature",
    "stateDigest",
    "status",
  ], "collector attestation");
  const now = safeInteger(rawNow, "collector verification time");
  const maximumLifetimeSeconds = safeInteger(
    rawMaximumLifetimeSeconds,
    "maximum collector attestation lifetime",
    MAXIMUM_LIGHTNING_CLOSE_ATTESTATION_LIFETIME_SECONDS,
  );
  const maximumClockSkewSeconds = safeInteger(
    rawMaximumClockSkewSeconds,
    "maximum collector clock skew",
    MAXIMUM_LIGHTNING_CLOSE_ATTESTATION_LIFETIME_SECONDS,
  );
  if (maximumLifetimeSeconds === 0) throw new RangeError("maximum collector attestation lifetime must be positive");
  const id = collectorId(expectedCollectorId);
  const nodeCommitment = bytes32(expectedNodeCommitment, "expectedNodeCommitment");
  const body = normalizeAttestationBody(attestationBody(attestation), {
    now,
    expectedCollectorId: id,
    expectedNodeCommitment: nodeCommitment,
    maximumLifetimeSeconds,
    maximumClockSkewSeconds,
  });
  const signature = Buffer.from(String(attestation.signature ?? ""), "base64");
  if (signature.length !== 64 || signature.toString("base64") !== attestation.signature) {
    throw new TypeError("collector signature is invalid");
  }
  if (!verify(null, bytes(body), ed25519PublicKey(publicKey), signature)) {
    throw new Error("collector signature verification failed");
  }
  return Object.freeze({
    ...body,
    signature: attestation.signature,
    attestationDigest: digest(body),
  });
}

function normalizeCollectors(rawCollectors) {
  if (!Array.isArray(rawCollectors) || rawCollectors.length !== 2) {
    throw new TypeError("exactly two configured collectors are required");
  }
  const collectors = rawCollectors.map((raw) => {
    exactKeys(raw, ["collectorId", "publicKey"], "collector configuration");
    const publicKey = ed25519PublicKey(raw.publicKey);
    return Object.freeze({
      collectorId: collectorId(raw.collectorId),
      publicKey,
      publicKeyDigest: publicKeyDigest(publicKey),
    });
  }).sort((a, b) => a.collectorId.localeCompare(b.collectorId));
  if (new Set(collectors.map((entry) => entry.collectorId)).size !== collectors.length
      || new Set(collectors.map((entry) => entry.publicKeyDigest)).size !== collectors.length) {
    throw new Error("collector identities and keys must be distinct");
  }
  return Object.freeze(collectors);
}

export function evaluateLightningCloseCollectorQuorum({
  attestations,
  collectors: rawCollectors,
  expectedNodeCommitment: rawExpectedNodeCommitment,
  now: rawNow,
  maximumLifetimeSeconds,
  maximumClockSkewSeconds,
}) {
  const now = safeInteger(rawNow, "collector quorum time");
  const expectedNodeCommitment = bytes32(rawExpectedNodeCommitment, "expectedNodeCommitment");
  let collectors;
  const reasons = [];
  try {
    collectors = normalizeCollectors(rawCollectors);
  } catch {
    reasons.push("COLLECTOR_CONFIGURATION_INVALID");
    collectors = Object.freeze([]);
  }

  const verified = [];
  if (!Array.isArray(attestations) || attestations.length !== 2) {
    reasons.push("COLLECTOR_QUORUM_INVALID");
  }
  if (collectors.length === 2 && Array.isArray(attestations)) {
    for (const collector of collectors) {
      const matches = attestations.filter((entry) => entry?.collectorId === collector.collectorId);
      if (matches.length !== 1) {
        reasons.push("COLLECTOR_QUORUM_INVALID");
        continue;
      }
      try {
        verified.push(verifyLightningCloseCollectorAttestation({
          attestation: matches[0],
          publicKey: collector.publicKey,
          expectedCollectorId: collector.collectorId,
          expectedNodeCommitment,
          now,
          maximumLifetimeSeconds,
          maximumClockSkewSeconds,
        }));
      } catch {
        reasons.push("COLLECTOR_QUORUM_INVALID");
      }
    }
    if (attestations.some((entry) => !collectors.some((collector) => collector.collectorId === entry?.collectorId))) {
      reasons.push("COLLECTOR_QUORUM_INVALID");
    }
  }
  if (verified.some((entry) => entry.status !== "healthy")) reasons.push("COLLECTOR_REPORTED_UNSAFE");
  if (verified.length !== 2) reasons.push("COLLECTOR_QUORUM_INVALID");
  if (verified.length === 2) {
    if (verified[0].stateDigest !== verified[1].stateDigest) {
      reasons.push("COLLECTOR_STATE_DISAGREEMENT");
    }
    if (Math.abs(verified[0].observedAt - verified[1].observedAt) > maximumClockSkewSeconds) {
      reasons.push("COLLECTOR_OBSERVATION_SKEW");
    }
  }

  const sortedReasons = Object.freeze([...new Set(reasons)].sort());
  const collectorEvidence = Object.freeze(collectors.map((collector) => {
    const accepted = verified.find((entry) => entry.collectorId === collector.collectorId);
    return Object.freeze({
      collectorId: collector.collectorId,
      publicKeyDigest: collector.publicKeyDigest,
      status: accepted?.status ?? "invalid",
      observedAt: accepted?.observedAt ?? 0,
      attestationDigest: accepted?.attestationDigest ?? ZERO_DIGEST,
      evidenceDigest: accepted?.evidenceDigest ?? ZERO_DIGEST,
      stateDigest: accepted?.stateDigest ?? ZERO_DIGEST,
    });
  }));
  const evidenceDigest = digest({
    schema: "treeswap.lightning-close-collector-quorum-evidence.v2",
    nodeCommitment: expectedNodeCommitment,
    collectors: collectorEvidence,
    reasonCodes: sortedReasons,
  });
  const observation = Object.freeze({
    kind: "lightning-node",
    status: sortedReasons.length === 0 ? "healthy" : "unsafe",
    observedAt: verified.length === 2 ? Math.min(...verified.map((entry) => entry.observedAt)) : 0,
    evidenceDigest,
  });
  return Object.freeze({
    schema: LIGHTNING_CLOSE_COLLECTOR_QUORUM_SCHEMA,
    status: observation.status,
    nodeCommitment: expectedNodeCommitment,
    reasonCodes: sortedReasons,
    collectors: collectorEvidence,
    observation,
  });
}
