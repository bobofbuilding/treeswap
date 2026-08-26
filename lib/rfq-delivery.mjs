import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomBytes,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { solverEndpointPublicKeyDigest, verifiedSolverQuoteBinding } from "./solver-capability.mjs";
import {
  pinnedPublicRfqRequest,
  publicSolverEndpointOrigin,
} from "./solver-endpoint-transport.mjs";
import {
  discardJsonResponseBody,
  readStrictJsonResponse,
} from "./private-json-response.mjs";
import { canonicalRelaySource } from "./untrusted-text.mjs";

export const RFQ_DELIVERY_REQUEST_SCHEMA = "treeswap.rfq-delivery-request.v1";
export const RFQ_DELIVERY_RESPONSE_SCHEMA = "treeswap.rfq-delivery-response.v1";
export const MAX_RFQ_DELIVERY_OFFER_CANDIDATES = 128;

const BYTES32 = /^0x[0-9a-f]{64}$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const PATH_KINDS = new Set(["relay", "direct-solver"]);
const RFQ_FIELDS = Object.freeze([
  "capacityEpoch", "chainId", "direction", "exactOutput", "expiresAt", "maxFeeBps",
  "maxRoutingFeeSats", "outputUnit", "pricingId",
]);
const BLIND_OFFER_FIELDS = Object.freeze([
  "offerId", "pricingId", "direction", "solver", "grossBitAmount", "feeBitAmount",
  "lightningAmountSats", "maxRoutingFeeSats", "expiresAt", "capacityEpoch", "capabilityDigest",
  "capacitySnapshotDigest", "endpointPublicKeyDigest", "settlementContractCodeHash",
  "availableBitWei", "availableLightningSats",
]);
const MAX_JSON_DEPTH = 8;
const MAX_JSON_OBJECT_KEYS = 64;
const MAX_JSON_ARRAY_ITEMS = MAX_RFQ_DELIVERY_OFFER_CANDIDATES;
const MAX_JSON_STRING_BYTES = 8_192;
const MAX_JSON_NODES = 8_192;
const VERIFIED_DELIVERIES = new WeakSet();
const VERIFIED_COLLECTIONS = new WeakSet();

function dataRecord(value, name, maximumFields = MAX_JSON_OBJECT_KEYS) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumFields || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are outside policy`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value,
    });
  }
  return Object.freeze(result);
}

function exactSnapshotFields(value, expected, name) {
  const keys = Reflect.ownKeys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return value;
}

function exactDataRecord(value, expected, name) {
  return exactSnapshotFields(dataRecord(value, name, expected.length), expected, name);
}

function dataRecordWithOptionalFields(value, required, optional, name) {
  const source = dataRecord(value, name, required.length + optional.length);
  const keys = Reflect.ownKeys(source);
  const allowed = new Set([...required, ...optional]);
  if (required.some((field) => !keys.includes(field)) || keys.some((field) => !allowed.has(field))) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return source;
}

function exactDataArray(value, name, maximumLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)
      || lengthDescriptor.enumerable !== false || lengthDescriptor.configurable !== false
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
      || lengthDescriptor.value > maximumLength) {
    throw new RangeError(`${name} length is invalid or unbounded`);
  }
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (keys.length !== expected.size
      || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError(`${name} must be dense and contain no extra properties`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function bytes32(value, name, { nonzero = false } = {}) {
  if (typeof value !== "string" || !BYTES32.test(value) || (nonzero && value === ZERO_BYTES32)) {
    throw new TypeError(`${name} must be ${nonzero ? "non-zero " : ""}lowercase bytes32`);
  }
  return value;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function publicKey(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError(`${name} is invalid`);
  }
  let key;
  try {
    key = createPublicKey(value);
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`${name} must be Ed25519`);
  return Object.freeze({
    digest: solverEndpointPublicKeyDigest(value),
    key,
  });
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function normalizedRfqPayload(raw) {
  const rfq = exactDataRecord(raw, RFQ_FIELDS, "blind RFQ delivery payload");
  if (rfq.direction !== "lightning-to-bit" && rfq.direction !== "bit-to-lightning") {
    throw new RangeError("RFQ delivery payload direction is unsupported");
  }
  const pricingId = bytes32(rfq.pricingId, "rfq.pricingId", { nonzero: true });
  if ((rfq.direction === "lightning-to-bit" && rfq.outputUnit !== "bit-wei")
      || (rfq.direction === "bit-to-lightning" && rfq.outputUnit !== "sats")) {
    throw new Error("RFQ delivery output unit changed");
  }
  const unsigned = {};
  for (const field of ["exactOutput", "maxRoutingFeeSats", "maxFeeBps"]) {
    const value = rfq[field];
    if (typeof value !== "string" || !UINT_DECIMAL.test(value) || value.length > 78) {
      throw new TypeError(`rfq.${field} must be a canonical bounded unsigned integer`);
    }
    unsigned[field] = value;
  }
  if (BigInt(unsigned.exactOutput) === 0n) throw new RangeError("rfq.exactOutput must be positive");
  if (BigInt(unsigned.maxFeeBps) > 10_000n) throw new RangeError("rfq.maxFeeBps exceeds 10000");
  return Object.freeze({
    capacityEpoch: integer(rfq.capacityEpoch, "rfq.capacityEpoch"),
    chainId: integer(rfq.chainId, "rfq.chainId"),
    direction: rfq.direction,
    exactOutput: unsigned.exactOutput,
    expiresAt: integer(rfq.expiresAt, "rfq.expiresAt"),
    maxFeeBps: unsigned.maxFeeBps,
    maxRoutingFeeSats: unsigned.maxRoutingFeeSats,
    outputUnit: rfq.outputUnit,
    pricingId,
  });
}

export function rfqDeliveryPayloadDigest(rfq) {
  return keccak256(toUtf8Bytes(canonicalize(normalizedRfqPayload(rfq))));
}

function snapshotBoundedJson(value, name = "RFQ delivery response", state = {
  depth: 0,
  counter: { value: 0 },
}) {
  state.counter.value += 1;
  if (state.counter.value > MAX_JSON_NODES || state.depth > MAX_JSON_DEPTH) {
    throw new Error(`${name} nesting or node count exceeded its limit`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${name} contains an unsafe number`);
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_JSON_STRING_BYTES) {
      throw new Error(`${name} contains an oversized string`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = exactDataArray(value, `${name} array`, MAX_JSON_ARRAY_ITEMS);
    return Object.freeze(items.map((item, index) => snapshotBoundedJson(item, `${name}[${index}]`, {
      depth: state.depth + 1,
      counter: state.counter,
    })));
  }
  if (!value || typeof value !== "object") throw new Error(`${name} contains a non-JSON value`);
  const record = dataRecord(value, name);
  const result = {};
  for (const key of Reflect.ownKeys(record)) {
    if (Buffer.byteLength(key) > 64) throw new Error(`${name} contains an oversized field name`);
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: snapshotBoundedJson(record[key], `${name}.${key}`, {
        depth: state.depth + 1,
        counter: state.counter,
      }),
    });
  }
  return Object.freeze(result);
}

function normalizedPolicy(raw) {
  const source = exactDataRecord(raw, [
    "maxClockSkewSeconds", "maxOffersPerPath", "maxPaths", "maxResponseTtlSeconds",
    "minimumDirectSolverPaths", "minimumRelayPaths",
  ], "RFQ delivery policy");
  const policy = Object.freeze({
    maxClockSkewSeconds: integer(source.maxClockSkewSeconds, "policy.maxClockSkewSeconds", 60),
    maxOffersPerPath: integer(source.maxOffersPerPath, "policy.maxOffersPerPath", 128),
    maxPaths: integer(source.maxPaths, "policy.maxPaths", 32),
    maxResponseTtlSeconds: integer(source.maxResponseTtlSeconds, "policy.maxResponseTtlSeconds", 30),
    minimumDirectSolverPaths: integer(source.minimumDirectSolverPaths, "policy.minimumDirectSolverPaths", 16),
    minimumRelayPaths: integer(source.minimumRelayPaths, "policy.minimumRelayPaths", 16),
  });
  if (policy.maxOffersPerPath === 0) throw new RangeError("RFQ delivery offer limit must be non-zero");
  if (policy.maxPaths < 4) throw new RangeError("RFQ delivery path limit must permit multipath collection");
  if (policy.maxResponseTtlSeconds === 0) throw new RangeError("RFQ delivery response lifetime must be non-zero");
  if (policy.maxOffersPerPath * policy.maxPaths > MAX_RFQ_DELIVERY_OFFER_CANDIDATES) {
    throw new RangeError("RFQ delivery plan can expose too many total offer candidates");
  }
  if (policy.minimumRelayPaths < 2 || policy.minimumDirectSolverPaths < 2
      || policy.minimumRelayPaths + policy.minimumDirectSolverPaths > policy.maxPaths) {
    throw new RangeError("RFQ delivery diversity minimum is outside policy");
  }
  return policy;
}

function normalizedPath(raw) {
  const source = dataRecord(raw, "RFQ delivery path", 7);
  const kind = source.kind;
  if (!PATH_KINDS.has(kind)) throw new RangeError("RFQ delivery path kind is unsupported");
  exactSnapshotFields(source, kind === "relay"
    ? ["endpointOrigin", "kind", "operatorCommitment", "pathId", "publicKey"]
    : ["capabilityVerification", "endpointOrigin", "kind", "operatorCommitment", "pathId", "publicKey", "solverId"],
  "RFQ delivery path");
  if (typeof source.pathId !== "string" || typeof source.endpointOrigin !== "string") {
    throw new TypeError("RFQ delivery path identifiers must be strings");
  }
  const pathId = canonicalRelaySource(source.pathId, 64);
  const endpointOrigin = publicSolverEndpointOrigin(source.endpointOrigin);
  const key = publicKey(source.publicKey, "path.publicKey");
  const operatorCommitment = bytes32(source.operatorCommitment, "path.operatorCommitment", { nonzero: true });
  let solverId = null;
  let authorityExpiresAt = null;
  let directQuoteBinding = null;
  if (kind === "direct-solver") {
    const binding = verifiedSolverQuoteBinding(source.capabilityVerification);
    solverId = address(source.solverId, "path.solverId");
    if (binding.solverId.toLowerCase() !== solverId) throw new Error("direct RFQ path belongs to another solver");
    if (binding.endpointOrigin !== endpointOrigin) throw new Error("direct RFQ path origin changed");
    if (binding.endpointPublicKeyDigest !== key.digest) throw new Error("direct RFQ path endpoint key changed");
    authorityExpiresAt = binding.expiresAt;
    directQuoteBinding = Object.freeze({
      chainId: String(binding.chainId),
      direction: binding.direction,
      capabilityDigest: binding.capabilityDigest,
      capacitySnapshotDigest: binding.capacitySnapshotDigest,
      endpointPublicKeyDigest: binding.endpointPublicKeyDigest,
      settlementContractCodeHash: binding.settlementContractCodeHash,
      capacityEpoch: String(binding.capacityEpoch),
      availableBitWei: String(binding.availableBitWei),
      availableLightningSats: String(binding.availableLightningSats),
    });
  }
  const identity = Object.freeze({
    kind,
    pathId,
    endpointOrigin,
    publicKeyDigest: key.digest,
    operatorCommitment,
    solverId,
    capabilityDigest: directQuoteBinding?.capabilityDigest ?? null,
    capacitySnapshotDigest: directQuoteBinding?.capacitySnapshotDigest ?? null,
  });
  return Object.freeze({
    ...identity,
    authorityExpiresAt,
    directQuoteBinding,
    identityDigest: keccak256(toUtf8Bytes(canonicalize(identity))),
    key: key.key,
  });
}

function normalizedPlan(paths, policy) {
  const source = exactDataArray(paths, "RFQ delivery path plan", policy.maxPaths);
  if (source.length === 0) {
    throw new RangeError("RFQ delivery path plan is outside policy");
  }
  const normalized = source.map(normalizedPath);
  const uniqueFields = [
    ["pathId", "path identifier"],
    ["endpointOrigin", "endpoint origin"],
    ["publicKeyDigest", "endpoint key"],
    ["operatorCommitment", "operator commitment"],
    ["identityDigest", "path identity"],
  ];
  for (const [field, label] of uniqueFields) {
    if (new Set(normalized.map((path) => path[field])).size !== normalized.length) {
      throw new Error(`RFQ delivery plan contains a duplicate ${label}`);
    }
  }
  const relayCount = normalized.filter((path) => path.kind === "relay").length;
  const directPaths = normalized.filter((path) => path.kind === "direct-solver");
  if (relayCount < policy.minimumRelayPaths || directPaths.length < policy.minimumDirectSolverPaths) {
    throw new RangeError("RFQ delivery plan lacks required path diversity");
  }
  if (new Set(directPaths.map((path) => path.solverId)).size !== directPaths.length) {
    throw new Error("RFQ delivery plan contains a duplicate direct solver");
  }
  return Object.freeze([...normalized]);
}

function normalizedRequest(raw) {
  const source = exactDataRecord(raw, [
    "challenge", "expiresAt", "pathIdentityDigest", "requestDigest", "requestId", "requestedAt", "rfq", "schema",
  ], "RFQ delivery request");
  if (source.schema !== RFQ_DELIVERY_REQUEST_SCHEMA) throw new Error("RFQ delivery request schema is unsupported");
  const requestedAt = integer(source.requestedAt, "request.requestedAt");
  const expiresAt = integer(source.expiresAt, "request.expiresAt");
  if (expiresAt <= requestedAt || expiresAt - requestedAt > 30) {
    throw new RangeError("RFQ delivery request lifetime is outside policy");
  }
  const rfq = normalizedRfqPayload(source.rfq);
  const requestId = bytes32(source.requestId, "request.requestId", { nonzero: true });
  const requestDigest = bytes32(source.requestDigest, "request.requestDigest", { nonzero: true });
  if (rfq.pricingId !== requestId) throw new Error("RFQ delivery request identifier changed in its payload");
  if (rfqDeliveryPayloadDigest(rfq) !== requestDigest) {
    throw new Error("RFQ delivery request payload does not match its digest");
  }
  return Object.freeze({
    schema: RFQ_DELIVERY_REQUEST_SCHEMA,
    challenge: bytes32(source.challenge, "request.challenge", { nonzero: true }),
    requestId,
    requestDigest,
    pathIdentityDigest: bytes32(source.pathIdentityDigest, "request.pathIdentityDigest", { nonzero: true }),
    rfq,
    requestedAt,
    expiresAt,
  });
}

function normalizedEnvelope(raw) {
  const bounded = snapshotBoundedJson(raw, "RFQ delivered offer envelope");
  const envelope = exactDataRecord(bounded, ["offer", "signature"], "RFQ delivered offer envelope");
  const offer = exactDataRecord(envelope.offer, BLIND_OFFER_FIELDS, "RFQ delivered blind solver offer");
  if (Object.values(offer).some((value) => typeof value !== "string"
      && !(typeof value === "number" && Number.isSafeInteger(value)))) {
    throw new TypeError("RFQ delivered blind solver offer contains a non-scalar field");
  }
  const signature = envelope.signature;
  if (typeof signature !== "string" || !EVM_SIGNATURE.test(signature)) {
    throw new TypeError("RFQ delivered solver signature is not canonical");
  }
  return Object.freeze({ offer, signature });
}

function normalizedResponse(raw, policy) {
  const bounded = snapshotBoundedJson(raw);
  const response = exactDataRecord(
    bounded,
    ["envelopes", "expiresAt", "request", "schema", "servedAt", "signature"],
    "RFQ delivery response",
  );
  if (response.schema !== RFQ_DELIVERY_RESPONSE_SCHEMA) {
    throw new Error("RFQ delivery response schema is unsupported");
  }
  const envelopes = exactDataArray(response.envelopes, "RFQ delivery response envelopes", policy.maxOffersPerPath);
  const signature = response.signature;
  if (typeof signature !== "string") throw new TypeError("RFQ delivery response signature is not canonical");
  const decodedSignature = Buffer.from(signature, "base64");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || decodedSignature.length !== 64
      || decodedSignature.toString("base64") !== signature) {
    throw new TypeError("RFQ delivery response signature is not canonical");
  }
  return Object.freeze({
    schema: RFQ_DELIVERY_RESPONSE_SCHEMA,
    request: normalizedRequest(response.request),
    envelopes: Object.freeze(envelopes.map(normalizedEnvelope)),
    servedAt: integer(response.servedAt, "response.servedAt"),
    expiresAt: integer(response.expiresAt, "response.expiresAt"),
    signature,
    decodedSignature,
  });
}

function unsignedResponse(response) {
  return {
    schema: response.schema,
    request: response.request,
    envelopes: response.envelopes,
    servedAt: response.servedAt,
    expiresAt: response.expiresAt,
  };
}

function responseMessage(digest) {
  return Buffer.from(`TreeSwap RFQ delivery response v1\n${bytes32(digest, "responseDigest")}\n`, "utf8");
}

export function rfqDeliveryResponseDigest(response) {
  const source = snapshotBoundedJson(response, "RFQ delivery response digest input");
  const record = dataRecordWithOptionalFields(
    source,
    ["envelopes", "expiresAt", "request", "schema", "servedAt"],
    ["signature"],
    "RFQ delivery response digest input",
  );
  return keccak256(toUtf8Bytes(canonicalize({
    schema: record.schema,
    request: record.request,
    envelopes: record.envelopes,
    servedAt: record.servedAt,
    expiresAt: record.expiresAt,
  })));
}

export function buildRfqDeliveryRequest(raw) {
  const source = exactDataRecord(raw, [
    "challenge", "expiresAt", "pathIdentityDigest", "requestDigest", "requestId", "requestedAt", "rfq",
  ], "RFQ delivery request builder input");
  return normalizedRequest({
    schema: RFQ_DELIVERY_REQUEST_SCHEMA,
    challenge: source.challenge,
    requestId: source.requestId,
    requestDigest: source.requestDigest,
    pathIdentityDigest: source.pathIdentityDigest,
    rfq: source.rfq,
    requestedAt: source.requestedAt,
    expiresAt: source.expiresAt,
  });
}

export function buildSignedRfqDeliveryResponse(raw) {
  const source = exactDataRecord(
    raw,
    ["envelopes", "expiresAt", "privateKey", "request", "servedAt"],
    "RFQ delivery response builder input",
  );
  const normalized = normalizedRequest(source.request);
  const envelopes = exactDataArray(source.envelopes, "RFQ delivery response envelopes", MAX_JSON_ARRAY_ITEMS);
  const normalizedEnvelopes = Object.freeze(envelopes.map(normalizedEnvelope));
  const normalizedServedAt = integer(source.servedAt, "servedAt");
  const normalizedExpiresAt = integer(source.expiresAt, "expiresAt");
  if (normalizedServedAt < normalized.requestedAt - 5 || normalizedServedAt > normalized.expiresAt) {
    throw new RangeError("RFQ delivery response time is outside the request window");
  }
  if (normalizedExpiresAt <= normalizedServedAt || normalizedExpiresAt > normalized.expiresAt) {
    throw new RangeError("RFQ delivery response expiry is outside the request window");
  }
  let signingKey;
  try {
    signingKey = source.privateKey instanceof KeyObject
      ? source.privateKey
      : createPrivateKey(source.privateKey);
  } catch {
    throw new TypeError("RFQ delivery response private key is invalid");
  }
  if (signingKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("RFQ delivery response private key must be Ed25519");
  }
  const unsigned = Object.freeze({
    schema: RFQ_DELIVERY_RESPONSE_SCHEMA,
    request: normalized,
    envelopes: normalizedEnvelopes,
    servedAt: normalizedServedAt,
    expiresAt: normalizedExpiresAt,
  });
  const digest = keccak256(toUtf8Bytes(canonicalize(unsigned)));
  const signature = signMessage(null, responseMessage(digest), signingKey).toString("base64");
  return Object.freeze({ ...unsigned, signature });
}

export class RfqDeliveryError extends Error {
  constructor(message, { code }) {
    super(message);
    this.name = "RfqDeliveryError";
    this.code = code;
    this.ambiguous = false;
  }
}

async function queryNormalizedPath({
  path,
  requestId,
  requestDigest,
  rfq,
  policy,
  requestImpl,
  nowSeconds,
  randomBytesImpl,
  requestTtlSeconds,
  timeoutMs,
  maximumResponseBytes,
}) {
  const requestedAt = integer(nowSeconds(), "nowSeconds");
  if (path.authorityExpiresAt !== null && path.authorityExpiresAt <= requestedAt) {
    throw new RfqDeliveryError("direct solver delivery authority expired", { code: "AUTHORITY_EXPIRED" });
  }
  if (path.directQuoteBinding !== null
      && (path.directQuoteBinding.direction !== rfq.direction
        || BigInt(path.directQuoteBinding.chainId) !== BigInt(rfq.chainId))) {
    throw new RfqDeliveryError("direct solver delivery authority is for another market", {
      code: "DIRECT_CAPABILITY_CHANGED",
    });
  }
  const ttl = integer(requestTtlSeconds, "requestTtlSeconds", policy.maxResponseTtlSeconds);
  if (ttl === 0) throw new RangeError("RFQ delivery request lifetime must be non-zero");
  const challengeSource = randomBytesImpl(32);
  if (!Buffer.isBuffer(challengeSource) && !(challengeSource instanceof Uint8Array)) {
    throw new Error("RFQ delivery challenge source returned an invalid value");
  }
  const challengeBytes = Buffer.from(challengeSource);
  if (challengeBytes.length !== 32) throw new Error("RFQ delivery challenge source returned the wrong size");
  const request = buildRfqDeliveryRequest({
    challenge: `0x${challengeBytes.toString("hex")}`,
    requestId,
    requestDigest,
    pathIdentityDigest: path.identityDigest,
    rfq,
    requestedAt,
    expiresAt: requestedAt + ttl,
  });
  const responseLimit = integer(maximumResponseBytes, "maximumResponseBytes", 1_048_576);
  if (responseLimit < 1_024) throw new RangeError("RFQ delivery response limit is too small");
  const requestTimeout = integer(timeoutMs, "timeoutMs", 30_000);
  if (requestTimeout === 0) throw new RangeError("RFQ delivery timeout must be non-zero");
  const endpointUrl = new URL("/v1/rfq", path.endpointOrigin);
  const performRequest = requestImpl ?? ((url, options) => pinnedPublicRfqRequest(url, options, {
    maximumResponseBytes: responseLimit,
  }));
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const hardDeadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("RFQ delivery endpoint timed out"));
    }, requestTimeout);
  });
  let response;
  try {
    let rawResponse;
    try {
      rawResponse = await Promise.race([
        performRequest(endpointUrl, {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        }, path.pathId),
        hardDeadline,
      ]);
    } catch {
      throw new RfqDeliveryError("RFQ delivery transport failed", { code: "TRANSPORT_FAILED" });
    }
    if (!rawResponse || typeof rawResponse !== "object") {
      throw new RfqDeliveryError("RFQ delivery endpoint returned an invalid response", { code: "INVALID_RESPONSE" });
    }
    if (rawResponse.redirected === true) {
      discardJsonResponseBody(rawResponse);
      throw new RfqDeliveryError("RFQ delivery redirect was refused", { code: "REDIRECT_REFUSED" });
    }
    if (rawResponse.status !== 200) {
      discardJsonResponseBody(rawResponse);
      throw new RfqDeliveryError("RFQ delivery request was rejected", { code: "HTTP_REJECTED" });
    }
    try {
      response = normalizedResponse(await Promise.race([
        readStrictJsonResponse(rawResponse, {
          label: "RFQ delivery response",
          maximumResponseBytes: responseLimit,
          signal: controller.signal,
        }),
        hardDeadline,
      ]), policy);
    } catch {
      if (timedOut) {
        throw new RfqDeliveryError("RFQ delivery transport failed", { code: "TRANSPORT_FAILED" });
      }
      throw new RfqDeliveryError("RFQ delivery endpoint returned an invalid response", { code: "INVALID_RESPONSE" });
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const receivedAt = integer(nowSeconds(), "nowSeconds");
  if (canonicalize(response.request) !== canonicalize(request)) {
    throw new RfqDeliveryError("RFQ delivery response changed the request", { code: "REQUEST_CHANGED" });
  }
  if (receivedAt > request.expiresAt || response.servedAt < request.requestedAt - policy.maxClockSkewSeconds
      || response.servedAt > receivedAt + policy.maxClockSkewSeconds || response.expiresAt <= receivedAt
      || response.expiresAt <= response.servedAt || response.expiresAt > request.expiresAt
      || response.expiresAt - response.servedAt > policy.maxResponseTtlSeconds) {
    throw new RfqDeliveryError("RFQ delivery response is outside its time window", { code: "STALE_RESPONSE" });
  }
  if (path.authorityExpiresAt !== null && response.expiresAt > path.authorityExpiresAt) {
    throw new RfqDeliveryError("direct solver delivery outlives its capability", { code: "AUTHORITY_EXPIRED" });
  }
  const responseDigest = keccak256(toUtf8Bytes(canonicalize(unsignedResponse(response))));
  if (!verifyMessage(null, responseMessage(responseDigest), path.key, response.decodedSignature)) {
    throw new RfqDeliveryError("RFQ delivery response signature is invalid", { code: "INVALID_RESPONSE_SIGNATURE" });
  }
  if (path.kind === "direct-solver") {
    for (const envelope of response.envelopes) {
      let offeredBy;
      try {
        offeredBy = address(envelope.offer?.solver, "offer.solver");
      } catch {
        throw new RfqDeliveryError("direct RFQ response has an invalid solver", { code: "DIRECT_SOLVER_CHANGED" });
      }
      if (offeredBy !== path.solverId) {
        throw new RfqDeliveryError("direct RFQ response changed the solver", { code: "DIRECT_SOLVER_CHANGED" });
      }
      const offer = envelope.offer ?? {};
      if (offer.capabilityDigest !== path.directQuoteBinding.capabilityDigest
          || offer.capacitySnapshotDigest !== path.directQuoteBinding.capacitySnapshotDigest
          || offer.endpointPublicKeyDigest !== path.directQuoteBinding.endpointPublicKeyDigest
          || offer.settlementContractCodeHash !== path.directQuoteBinding.settlementContractCodeHash
          || String(offer.capacityEpoch) !== path.directQuoteBinding.capacityEpoch
          || String(offer.availableBitWei) !== path.directQuoteBinding.availableBitWei
          || String(offer.availableLightningSats) !== path.directQuoteBinding.availableLightningSats) {
        throw new RfqDeliveryError("direct RFQ response changed its verified capability", {
          code: "DIRECT_CAPABILITY_CHANGED",
        });
      }
    }
  }
  const delivery = Object.freeze({
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    rfqPayloadDigest: rfqDeliveryPayloadDigest(request.rfq),
    path: Object.freeze({
      kind: path.kind,
      pathId: path.pathId,
      endpointOrigin: path.endpointOrigin,
      publicKeyDigest: path.publicKeyDigest,
      operatorCommitment: path.operatorCommitment,
      solverId: path.solverId,
      identityDigest: path.identityDigest,
    }),
    requestChallenge: request.challenge,
    responseDigest,
    servedAt: response.servedAt,
    receivedAt,
    expiresAt: response.expiresAt,
    envelopes: response.envelopes,
  });
  VERIFIED_DELIVERIES.add(delivery);
  return delivery;
}

export async function queryVerifiedRfqDelivery(raw) {
  const source = dataRecordWithOptionalFields(
    raw,
    ["path", "policy", "requestDigest", "requestId", "rfq"],
    ["maximumResponseBytes", "nowSeconds", "randomBytesImpl", "requestImpl", "requestTtlSeconds", "timeoutMs"],
    "RFQ delivery query input",
  );
  const boundPolicy = normalizedPolicy(source.policy);
  const boundRequestDigest = bytes32(source.requestDigest, "requestDigest", { nonzero: true });
  const boundRfq = normalizedRfqPayload(source.rfq);
  if (rfqDeliveryPayloadDigest(boundRfq) !== boundRequestDigest) {
    throw new Error("RFQ payload does not match its request digest");
  }
  return queryNormalizedPath({
    path: normalizedPath(source.path),
    requestId: bytes32(source.requestId, "requestId", { nonzero: true }),
    requestDigest: boundRequestDigest,
    rfq: boundRfq,
    policy: boundPolicy,
    requestImpl: source.requestImpl ?? null,
    nowSeconds: source.nowSeconds ?? (() => Math.floor(Date.now() / 1_000)),
    randomBytesImpl: source.randomBytesImpl ?? randomBytes,
    requestTtlSeconds: source.requestTtlSeconds ?? 15,
    timeoutMs: source.timeoutMs ?? 5_000,
    maximumResponseBytes: source.maximumResponseBytes ?? 262_144,
  });
}

export async function collectVerifiedRfqDeliveries(raw) {
  const source = dataRecordWithOptionalFields(
    raw,
    ["paths", "policy", "requestDigest", "requestId", "rfq"],
    ["maximumResponseBytes", "nowSeconds", "randomBytesImpl", "requestImpl", "requestTtlSeconds", "timeoutMs"],
    "RFQ delivery collection input",
  );
  const boundPolicy = normalizedPolicy(source.policy);
  const plan = normalizedPlan(source.paths, boundPolicy);
  const boundRequestId = bytes32(source.requestId, "requestId", { nonzero: true });
  const boundRequestDigest = bytes32(source.requestDigest, "requestDigest", { nonzero: true });
  const boundRfq = normalizedRfqPayload(source.rfq);
  if (rfqDeliveryPayloadDigest(boundRfq) !== boundRequestDigest) {
    throw new Error("RFQ payload does not match its request digest");
  }
  const attempts = await Promise.allSettled(plan.map((path) => queryNormalizedPath({
    path,
    requestId: boundRequestId,
    requestDigest: boundRequestDigest,
    rfq: boundRfq,
    policy: boundPolicy,
    requestImpl: source.requestImpl ?? null,
    nowSeconds: source.nowSeconds ?? (() => Math.floor(Date.now() / 1_000)),
    randomBytesImpl: source.randomBytesImpl ?? randomBytes,
    requestTtlSeconds: source.requestTtlSeconds ?? 15,
    timeoutMs: source.timeoutMs ?? 5_000,
    maximumResponseBytes: source.maximumResponseBytes ?? 262_144,
  })));
  const deliveries = [];
  const failures = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (attempt.status === "fulfilled") {
      deliveries.push(attempt.value);
    } else {
      failures.push(Object.freeze({
        pathId: plan[index].pathId,
        kind: plan[index].kind,
        code: attempt.reason instanceof RfqDeliveryError ? attempt.reason.code : "LOCAL_FAILURE",
      }));
    }
  }
  const relayCount = deliveries.filter((delivery) => delivery.path.kind === "relay").length;
  const directSolverCount = deliveries.filter((delivery) => delivery.path.kind === "direct-solver").length;
  if (relayCount < boundPolicy.minimumRelayPaths || directSolverCount < boundPolicy.minimumDirectSolverPaths) {
    throw new RfqDeliveryError("RFQ delivery collection lacks responsive path diversity", {
      code: "INSUFFICIENT_PATH_DIVERSITY",
    });
  }
  const planDigest = keccak256(toUtf8Bytes(canonicalize(plan.map((path) => ({
    kind: path.kind,
    pathId: path.pathId,
    identityDigest: path.identityDigest,
  })))));
  const collectionRecord = Object.freeze({
    schema: "treeswap.rfq-delivery-collection.v1",
    requestId: boundRequestId,
    requestDigest: boundRequestDigest,
    rfqPayloadDigest: rfqDeliveryPayloadDigest(boundRfq),
    planDigest,
    attemptCount: plan.length,
    minimumRelayPaths: boundPolicy.minimumRelayPaths,
    minimumDirectSolverPaths: boundPolicy.minimumDirectSolverPaths,
    relayCount,
    directSolverCount,
    deliveries: Object.freeze([...deliveries]),
    failures: Object.freeze([...failures]),
  });
  const collection = Object.freeze({
    ...collectionRecord,
    collectionDigest: keccak256(toUtf8Bytes(canonicalize({
      ...collectionRecord,
      deliveries: deliveries.map((delivery) => ({
        pathIdentityDigest: delivery.path.identityDigest,
        responseDigest: delivery.responseDigest,
        servedAt: delivery.servedAt,
        receivedAt: delivery.receivedAt,
        expiresAt: delivery.expiresAt,
      })),
    }))),
  });
  VERIFIED_COLLECTIONS.add(collection);
  return collection;
}

export function verifiedRfqDeliveryCollection(collection) {
  if (!collection || !VERIFIED_COLLECTIONS.has(collection)) {
    throw new TypeError("RFQ delivery collection must be locally authenticated and complete");
  }
  if (collection.deliveries.some((delivery) => !VERIFIED_DELIVERIES.has(delivery))) {
    throw new TypeError("RFQ delivery collection contains unverified path data");
  }
  return collection;
}
