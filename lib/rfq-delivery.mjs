import {
  createPrivateKey,
  createPublicKey,
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
import { canonicalRelaySource } from "./untrusted-text.mjs";

export const RFQ_DELIVERY_REQUEST_SCHEMA = "treeswap.rfq-delivery-request.v1";
export const RFQ_DELIVERY_RESPONSE_SCHEMA = "treeswap.rfq-delivery-response.v1";
export const MAX_RFQ_DELIVERY_OFFER_CANDIDATES = 128;

const BYTES32 = /^0x[0-9a-f]{64}$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const PATH_KINDS = new Set(["relay", "direct-solver"]);
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
const VERIFIED_DELIVERIES = new WeakSet();
const VERIFIED_COLLECTIONS = new WeakSet();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function bytes32(value, name, { nonzero = false } = {}) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw) || (nonzero && raw === ZERO_BYTES32)) {
    throw new TypeError(`${name} must be ${nonzero ? "non-zero " : ""}lowercase bytes32`);
  }
  return raw;
}

function address(value, name) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function publicKey(value, name) {
  const raw = String(value ?? "");
  if (raw.length === 0 || raw.length > 512) throw new TypeError(`${name} is invalid`);
  let key;
  try {
    key = createPublicKey(raw);
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`${name} must be Ed25519`);
  return Object.freeze({
    digest: solverEndpointPublicKeyDigest(raw),
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
  exactKeys(raw, [
    "capacityEpoch", "chainId", "direction", "exactOutput", "expiresAt", "maxFeeBps",
    "maxRoutingFeeSats", "outputUnit", "pricingId",
  ], "blind RFQ delivery payload");
  assertBoundedJson(raw);
  if (raw.direction !== "lightning-to-bit" && raw.direction !== "bit-to-lightning") {
    throw new RangeError("RFQ delivery payload direction is unsupported");
  }
  bytes32(raw.pricingId, "rfq.pricingId", { nonzero: true });
  if ((raw.direction === "lightning-to-bit" && raw.outputUnit !== "bit-wei")
      || (raw.direction === "bit-to-lightning" && raw.outputUnit !== "sats")) {
    throw new Error("RFQ delivery output unit changed");
  }
  for (const field of ["exactOutput", "maxRoutingFeeSats", "maxFeeBps"]) {
    const value = String(raw[field] ?? "");
    if (!UINT_DECIMAL.test(value) || value.length > 78) {
      throw new TypeError(`rfq.${field} must be a canonical bounded unsigned integer`);
    }
  }
  if (BigInt(raw.exactOutput) === 0n) throw new RangeError("rfq.exactOutput must be positive");
  if (BigInt(raw.maxFeeBps) > 10_000n) throw new RangeError("rfq.maxFeeBps exceeds 10000");
  integer(raw.chainId, "rfq.chainId");
  integer(raw.capacityEpoch, "rfq.capacityEpoch");
  integer(raw.expiresAt, "rfq.expiresAt");
  return Object.freeze({ ...raw });
}

export function rfqDeliveryPayloadDigest(rfq) {
  return keccak256(toUtf8Bytes(canonicalize(normalizedRfqPayload(rfq))));
}

function assertBoundedJson(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new Error("RFQ delivery response nesting exceeded its limit");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("RFQ delivery response contains an unsafe number");
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_JSON_STRING_BYTES) {
      throw new Error("RFQ delivery response contains an oversized string");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) throw new Error("RFQ delivery response array exceeded its limit");
    for (const item of value) assertBoundedJson(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw new Error("RFQ delivery response contains a non-JSON value");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("RFQ delivery response contains a non-plain object");
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_JSON_OBJECT_KEYS) throw new Error("RFQ delivery response has too many fields");
  for (const key of keys) {
    if (Buffer.byteLength(key) > 64) throw new Error("RFQ delivery response contains an oversized field name");
    assertBoundedJson(value[key], depth + 1);
  }
}

function normalizedPolicy(raw) {
  exactKeys(raw, [
    "maxClockSkewSeconds", "maxOffersPerPath", "maxPaths", "maxResponseTtlSeconds",
    "minimumDirectSolverPaths", "minimumRelayPaths",
  ], "RFQ delivery policy");
  const policy = Object.freeze({
    maxClockSkewSeconds: integer(raw.maxClockSkewSeconds, "policy.maxClockSkewSeconds", 60),
    maxOffersPerPath: integer(raw.maxOffersPerPath, "policy.maxOffersPerPath", 128),
    maxPaths: integer(raw.maxPaths, "policy.maxPaths", 32),
    maxResponseTtlSeconds: integer(raw.maxResponseTtlSeconds, "policy.maxResponseTtlSeconds", 30),
    minimumDirectSolverPaths: integer(raw.minimumDirectSolverPaths, "policy.minimumDirectSolverPaths", 16),
    minimumRelayPaths: integer(raw.minimumRelayPaths, "policy.minimumRelayPaths", 16),
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
  const kind = String(raw?.kind ?? "");
  if (!PATH_KINDS.has(kind)) throw new RangeError("RFQ delivery path kind is unsupported");
  exactKeys(raw, kind === "relay"
    ? ["endpointOrigin", "kind", "operatorCommitment", "pathId", "publicKey"]
    : ["capabilityVerification", "endpointOrigin", "kind", "operatorCommitment", "pathId", "publicKey", "solverId"],
  "RFQ delivery path");
  const pathId = canonicalRelaySource(raw.pathId, 64);
  const endpointOrigin = publicSolverEndpointOrigin(raw.endpointOrigin);
  const key = publicKey(raw.publicKey, "path.publicKey");
  const operatorCommitment = bytes32(raw.operatorCommitment, "path.operatorCommitment", { nonzero: true });
  let solverId = null;
  let authorityExpiresAt = null;
  let directQuoteBinding = null;
  if (kind === "direct-solver") {
    const binding = verifiedSolverQuoteBinding(raw.capabilityVerification);
    solverId = address(raw.solverId, "path.solverId");
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
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > policy.maxPaths) {
    throw new RangeError("RFQ delivery path plan is outside policy");
  }
  const normalized = paths.map(normalizedPath);
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
  exactKeys(raw, [
    "challenge", "expiresAt", "pathIdentityDigest", "requestDigest", "requestId", "requestedAt", "rfq", "schema",
  ], "RFQ delivery request");
  if (raw.schema !== RFQ_DELIVERY_REQUEST_SCHEMA) throw new Error("RFQ delivery request schema is unsupported");
  const requestedAt = integer(raw.requestedAt, "request.requestedAt");
  const expiresAt = integer(raw.expiresAt, "request.expiresAt");
  if (expiresAt <= requestedAt || expiresAt - requestedAt > 30) {
    throw new RangeError("RFQ delivery request lifetime is outside policy");
  }
  const rfq = normalizedRfqPayload(raw.rfq);
  const requestId = bytes32(raw.requestId, "request.requestId", { nonzero: true });
  const requestDigest = bytes32(raw.requestDigest, "request.requestDigest", { nonzero: true });
  if (rfq.pricingId !== requestId) throw new Error("RFQ delivery request identifier changed in its payload");
  if (rfqDeliveryPayloadDigest(rfq) !== requestDigest) {
    throw new Error("RFQ delivery request payload does not match its digest");
  }
  return Object.freeze({
    schema: RFQ_DELIVERY_REQUEST_SCHEMA,
    challenge: bytes32(raw.challenge, "request.challenge", { nonzero: true }),
    requestId,
    requestDigest,
    pathIdentityDigest: bytes32(raw.pathIdentityDigest, "request.pathIdentityDigest", { nonzero: true }),
    rfq,
    requestedAt,
    expiresAt,
  });
}

function normalizedEnvelope(raw) {
  exactKeys(raw, ["offer", "signature"], "RFQ delivered offer envelope");
  assertBoundedJson(raw.offer);
  exactKeys(raw.offer, BLIND_OFFER_FIELDS, "RFQ delivered blind solver offer");
  if (Object.values(raw.offer).some((value) => typeof value !== "string"
      && !(typeof value === "number" && Number.isSafeInteger(value)))) {
    throw new TypeError("RFQ delivered blind solver offer contains a non-scalar field");
  }
  const signature = String(raw.signature ?? "");
  if (!EVM_SIGNATURE.test(signature)) throw new TypeError("RFQ delivered solver signature is not canonical");
  return Object.freeze({ offer: Object.freeze({ ...raw.offer }), signature });
}

function normalizedResponse(raw, policy) {
  assertBoundedJson(raw);
  exactKeys(raw, ["envelopes", "expiresAt", "request", "schema", "servedAt", "signature"], "RFQ delivery response");
  if (raw.schema !== RFQ_DELIVERY_RESPONSE_SCHEMA) throw new Error("RFQ delivery response schema is unsupported");
  if (!Array.isArray(raw.envelopes) || raw.envelopes.length > policy.maxOffersPerPath) {
    throw new RangeError("RFQ delivery response exceeds its bounded offer limit");
  }
  const signature = String(raw.signature ?? "");
  const decodedSignature = Buffer.from(signature, "base64");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || decodedSignature.length !== 64
      || decodedSignature.toString("base64") !== signature) {
    throw new TypeError("RFQ delivery response signature is not canonical");
  }
  return Object.freeze({
    schema: RFQ_DELIVERY_RESPONSE_SCHEMA,
    request: normalizedRequest(raw.request),
    envelopes: Object.freeze(raw.envelopes.map(normalizedEnvelope)),
    servedAt: integer(raw.servedAt, "response.servedAt"),
    expiresAt: integer(raw.expiresAt, "response.expiresAt"),
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
  const raw = { ...response };
  delete raw.signature;
  return keccak256(toUtf8Bytes(canonicalize(raw)));
}

export function buildRfqDeliveryRequest({
  challenge,
  requestId,
  requestDigest,
  pathIdentityDigest,
  rfq,
  requestedAt,
  expiresAt,
}) {
  return normalizedRequest({
    schema: RFQ_DELIVERY_REQUEST_SCHEMA,
    challenge,
    requestId,
    requestDigest,
    pathIdentityDigest,
    rfq,
    requestedAt,
    expiresAt,
  });
}

export function buildSignedRfqDeliveryResponse({ request, envelopes, servedAt, expiresAt, privateKey }) {
  const normalized = normalizedRequest(request);
  if (!Array.isArray(envelopes) || envelopes.length > MAX_JSON_ARRAY_ITEMS) {
    throw new RangeError("RFQ delivery response exceeds its hard offer limit");
  }
  const normalizedEnvelopes = Object.freeze(envelopes.map(normalizedEnvelope));
  const normalizedServedAt = integer(servedAt, "servedAt");
  const normalizedExpiresAt = integer(expiresAt, "expiresAt");
  if (normalizedServedAt < normalized.requestedAt - 5 || normalizedServedAt > normalized.expiresAt) {
    throw new RangeError("RFQ delivery response time is outside the request window");
  }
  if (normalizedExpiresAt <= normalizedServedAt || normalizedExpiresAt > normalized.expiresAt) {
    throw new RangeError("RFQ delivery response expiry is outside the request window");
  }
  let signingKey;
  try {
    signingKey = privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey);
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

async function boundedJson(response, maximumBytes) {
  const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw new Error("RFQ delivery response content type is invalid");
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("RFQ delivery response exceeded its size limit");
  }
  if (!response.body) throw new Error("RFQ delivery endpoint returned an empty response");
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new Error("RFQ delivery response exceeded its size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  const hardDeadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("RFQ delivery endpoint timed out"));
    }, requestTimeout);
  });
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
  } finally {
    clearTimeout(timer);
  }
  if (!rawResponse || typeof rawResponse !== "object") {
    throw new RfqDeliveryError("RFQ delivery endpoint returned an invalid response", { code: "INVALID_RESPONSE" });
  }
  if (rawResponse.redirected === true) {
    throw new RfqDeliveryError("RFQ delivery redirect was refused", { code: "REDIRECT_REFUSED" });
  }
  if (rawResponse.status !== 200) {
    throw new RfqDeliveryError("RFQ delivery request was rejected", { code: "HTTP_REJECTED" });
  }
  let response;
  try {
    response = normalizedResponse(await boundedJson(rawResponse, responseLimit), policy);
  } catch {
    throw new RfqDeliveryError("RFQ delivery endpoint returned an invalid response", { code: "INVALID_RESPONSE" });
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

export async function queryVerifiedRfqDelivery({
  path,
  requestId,
  requestDigest,
  rfq,
  policy,
  requestImpl = null,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  randomBytesImpl = randomBytes,
  requestTtlSeconds = 15,
  timeoutMs = 5_000,
  maximumResponseBytes = 262_144,
}) {
  const boundPolicy = normalizedPolicy(policy);
  const boundRequestDigest = bytes32(requestDigest, "requestDigest", { nonzero: true });
  if (rfqDeliveryPayloadDigest(rfq) !== boundRequestDigest) {
    throw new Error("RFQ payload does not match its request digest");
  }
  return queryNormalizedPath({
    path: normalizedPath(path),
    requestId: bytes32(requestId, "requestId", { nonzero: true }),
    requestDigest: boundRequestDigest,
    rfq,
    policy: boundPolicy,
    requestImpl,
    nowSeconds,
    randomBytesImpl,
    requestTtlSeconds,
    timeoutMs,
    maximumResponseBytes,
  });
}

export async function collectVerifiedRfqDeliveries({
  paths,
  requestId,
  requestDigest,
  rfq,
  policy,
  requestImpl = null,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  randomBytesImpl = randomBytes,
  requestTtlSeconds = 15,
  timeoutMs = 5_000,
  maximumResponseBytes = 262_144,
}) {
  const boundPolicy = normalizedPolicy(policy);
  const plan = normalizedPlan(paths, boundPolicy);
  const boundRequestId = bytes32(requestId, "requestId", { nonzero: true });
  const boundRequestDigest = bytes32(requestDigest, "requestDigest", { nonzero: true });
  const boundRfq = Object.freeze({ ...rfq });
  if (rfqDeliveryPayloadDigest(boundRfq) !== boundRequestDigest) {
    throw new Error("RFQ payload does not match its request digest");
  }
  const attempts = await Promise.allSettled(plan.map((path) => queryNormalizedPath({
    path,
    requestId: boundRequestId,
    requestDigest: boundRequestDigest,
    rfq: boundRfq,
    policy: boundPolicy,
    requestImpl,
    nowSeconds,
    randomBytesImpl,
    requestTtlSeconds,
    timeoutMs,
    maximumResponseBytes,
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
