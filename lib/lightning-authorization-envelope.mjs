import { sign, verify } from "node:crypto";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_UINT64 = (1n << 64n) - 1n;
const PAYLOAD_KEYS = Object.freeze([
  "amountSats", "authorizedAt", "capacityEpoch", "expiresAt", "intentDigest", "invoiceDigest",
  "keyId", "method", "operation", "paymentHash", "requestId", "schema",
]);
const VERIFY_KEYS = Object.freeze([
  "envelope", "expectedKeyId", "maxLifetimeSeconds", "now", "publicKey",
]);
const OPERATION_KEYS = Object.freeze({
  "/invoicesrpc.Invoices/AddHoldInvoice": Object.freeze([
    "cltvExpiry", "expirySeconds", "isPrivate", "memo",
  ]),
  "/invoicesrpc.Invoices/CancelInvoice": Object.freeze([]),
  "/invoicesrpc.Invoices/LookupInvoiceV2": Object.freeze([]),
  "/invoicesrpc.Invoices/SettleInvoice": Object.freeze(["preimage"]),
  "/lnrpc.Lightning/DecodePayReq": Object.freeze(["paymentRequest"]),
  "/routerrpc.Router/SendPaymentV2": Object.freeze([
    "feeLimitSats", "paymentRequest", "timeoutSeconds",
  ]),
  "/routerrpc.Router/TrackPaymentV2": Object.freeze([]),
});

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const actual = [...keys].sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotOperation(value, method) {
  const expected = OPERATION_KEYS[method];
  if (!expected) throw new TypeError("authorization method is unsupported");
  const source = exactDataRecord(value, expected, "authorization operation");
  const result = {};
  for (const key of expected) {
    const child = source[key];
    if (typeof child !== "string" && typeof child !== "boolean"
        && !(typeof child === "number" && Number.isSafeInteger(child))) {
      throw new TypeError(`authorization operation.${key} contains an unsupported value`);
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: child,
    });
  }
  return Object.freeze(result);
}

function exactInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function bytes32(value, name) {
  if (typeof value !== "string" || value !== value.toLowerCase() || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be lowercase bytes32`);
  }
  return value;
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
  const source = exactDataRecord(payload, PAYLOAD_KEYS, "authorization payload");
  const keyId = source.keyId;
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) {
    throw new TypeError("authorization keyId is invalid");
  }
  const method = source.method;
  if (typeof method !== "string" || !method.startsWith("/") || method.length > 120) {
    throw new TypeError("authorization method is invalid");
  }

  const normalized = {
    schema: "treeswap.lightning-authorization.v1",
    keyId,
    method,
    requestId: bytes32(source.requestId, "requestId"),
    intentDigest: bytes32(source.intentDigest, "intentDigest"),
    paymentHash: bytes32(source.paymentHash, "paymentHash"),
    invoiceDigest: bytes32(source.invoiceDigest, "invoiceDigest"),
    amountSats: amount(source.amountSats),
    capacityEpoch: exactInteger(source.capacityEpoch, "capacityEpoch"),
    authorizedAt: exactInteger(source.authorizedAt, "authorizedAt"),
    expiresAt: exactInteger(source.expiresAt, "expiresAt"),
    operation: snapshotOperation(source.operation, method),
  };
  if (source.schema !== normalized.schema) throw new TypeError("authorization schema is unsupported");
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

export function verifyLightningAuthorizationEnvelope(input) {
  const source = exactDataRecord(input, VERIFY_KEYS, "authorization verification");
  const envelope = exactDataRecord(source.envelope, ["payload", "signature"], "authorization envelope");
  if (source.publicKey?.asymmetricKeyType !== "ed25519") {
    throw new TypeError("coordinator verification key must be Ed25519");
  }
  if (typeof source.expectedKeyId !== "string" || !KEY_ID.test(source.expectedKeyId)) {
    throw new TypeError("expected authorization keyId is invalid");
  }
  const payload = normalizeLightningAuthorizationPayload(envelope.payload);
  const observedAt = exactInteger(source.now, "now");
  const maximumLifetime = exactInteger(source.maxLifetimeSeconds, "maxLifetimeSeconds");
  if (payload.keyId !== source.expectedKeyId) throw new Error("authorization key is not active");
  if (payload.authorizedAt > observedAt) throw new Error("authorization time is in the future");
  if (observedAt >= payload.expiresAt) throw new Error("authorization expired");
  if (payload.expiresAt <= payload.authorizedAt || payload.expiresAt - payload.authorizedAt > maximumLifetime) {
    throw new Error("authorization lifetime exceeds policy");
  }
  if (typeof envelope.signature !== "string") throw new Error("authorization signature is invalid");
  const signature = Buffer.from(envelope.signature, "base64");
  if (
    signature.length !== 64
    || signature.toString("base64") !== envelope.signature
    || !verify(null, Buffer.from(canonicalize(payload)), source.publicKey, signature)
  ) {
    throw new Error("authorization signature is invalid");
  }
  return payload;
}
