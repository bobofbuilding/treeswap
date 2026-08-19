import { sign, verify } from "node:crypto";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_UINT64 = (1n << 64n) - 1n;
const PAYLOAD_KEYS = Object.freeze([
  "amountSats", "authorizedAt", "capacityEpoch", "expiresAt", "intentDigest", "invoiceDigest",
  "keyId", "method", "operation", "paymentHash", "requestId", "schema",
]);

function requireExactKeys(value, expected, name) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function exactInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function bytes32(value, name) {
  const original = String(value ?? "");
  const normalized = original.toLowerCase();
  if (original !== normalized || !BYTES32.test(normalized)) throw new TypeError(`${name} must be lowercase bytes32`);
  return normalized;
}

function amount(value) {
  if (typeof value !== "string") throw new TypeError("amountSats must be a canonical unsigned decimal string");
  const normalized = value;
  if (!UINT.test(normalized)) throw new TypeError("amountSats must be a canonical unsigned decimal string");
  const parsed = BigInt(normalized);
  if (parsed === 0n || parsed > MAX_UINT64) throw new RangeError("amountSats must fit uint64 and be non-zero");
  return normalized;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("signed authorization numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("signed authorization contains an unsupported value");
}

export function normalizeLightningAuthorizationPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("authorization payload must be an object");
  }
  requireExactKeys(payload, PAYLOAD_KEYS, "authorization payload");
  const keyId = String(payload.keyId ?? "");
  if (!KEY_ID.test(keyId)) throw new TypeError("authorization keyId is invalid");
  const method = String(payload.method ?? "");
  if (!method.startsWith("/") || method.length > 120) throw new TypeError("authorization method is invalid");
  if (!payload.operation || typeof payload.operation !== "object" || Array.isArray(payload.operation)) {
    throw new TypeError("authorization operation must be an object");
  }

  const normalized = {
    schema: "treeswap.lightning-authorization.v1",
    keyId,
    method,
    requestId: bytes32(payload.requestId, "requestId"),
    intentDigest: bytes32(payload.intentDigest, "intentDigest"),
    paymentHash: bytes32(payload.paymentHash, "paymentHash"),
    invoiceDigest: bytes32(payload.invoiceDigest, "invoiceDigest"),
    amountSats: amount(payload.amountSats),
    capacityEpoch: exactInteger(payload.capacityEpoch, "capacityEpoch"),
    authorizedAt: exactInteger(payload.authorizedAt, "authorizedAt"),
    expiresAt: exactInteger(payload.expiresAt, "expiresAt"),
    operation: structuredClone(payload.operation),
  };
  if (payload.schema !== normalized.schema) throw new TypeError("authorization schema is unsupported");
  canonicalize(normalized.operation);
  return Object.freeze(normalized);
}

export function serializeLightningAuthorizationPayload(payload) {
  return canonicalize(normalizeLightningAuthorizationPayload(payload));
}

export function signLightningAuthorizationEnvelope(payload, privateKey) {
  if (privateKey?.asymmetricKeyType !== "ed25519") throw new TypeError("coordinator signing key must be Ed25519");
  const normalized = normalizeLightningAuthorizationPayload(payload);
  const signature = sign(null, Buffer.from(canonicalize(normalized)), privateKey).toString("base64");
  return Object.freeze({ payload: normalized, signature });
}

export function verifyLightningAuthorizationEnvelope({ envelope, publicKey, expectedKeyId, now, maxLifetimeSeconds }) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TypeError("authorization envelope must be an object");
  }
  requireExactKeys(envelope, ["payload", "signature"], "authorization envelope");
  if (publicKey?.asymmetricKeyType !== "ed25519") throw new TypeError("coordinator verification key must be Ed25519");
  const payload = normalizeLightningAuthorizationPayload(envelope.payload);
  const observedAt = exactInteger(now, "now");
  const maximumLifetime = exactInteger(maxLifetimeSeconds, "maxLifetimeSeconds");
  if (payload.keyId !== expectedKeyId) throw new Error("authorization key is not active");
  if (payload.authorizedAt > observedAt) throw new Error("authorization time is in the future");
  if (observedAt >= payload.expiresAt) throw new Error("authorization expired");
  if (payload.expiresAt <= payload.authorizedAt || payload.expiresAt - payload.authorizedAt > maximumLifetime) {
    throw new Error("authorization lifetime exceeds policy");
  }
  const signature = Buffer.from(String(envelope.signature ?? ""), "base64");
  if (
    signature.length !== 64
    || signature.toString("base64") !== envelope.signature
    || !verify(null, Buffer.from(canonicalize(payload)), publicKey, signature)
  ) {
    throw new Error("authorization signature is invalid");
  }
  return payload;
}
