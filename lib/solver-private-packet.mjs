import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { getAddress } from "ethers";
import { invoiceDigest, isPrivateLndHostname } from "./lnd-rest-client.mjs";

export const PRIVATE_PACKET_REQUEST_SCHEMA = "treeswap.private-packet-request.v1";
export const PRIVATE_PACKET_RESPONSE_SCHEMA = "treeswap.private-packet-response.v1";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const PURPOSES = new Set(["SEND_PAYMENT", "SETTLE_INVOICE", "EVM_CLAIM"]);
const MAX_REQUEST_LIFETIME_SECONDS = 30;
const MAX_RESPONSE_BYTES = 65_536;
const VERIFIED_PRIVATE_PACKETS = new WeakSet();

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

function uint(value, name, { nonzero = false } = {}) {
  const raw = String(value ?? "");
  if (!UINT.test(raw)) throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  const parsed = BigInt(raw);
  if (parsed > (1n << 256n) - 1n || (nonzero && parsed === 0n)) throw new RangeError(`${name} is outside its range`);
  return raw;
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function optionalBytes32(value, name) {
  return value === null ? null : bytes32(value, name);
}

function keyId(value, name) {
  const raw = String(value ?? "");
  if (!KEY_ID.test(raw)) throw new TypeError(`${name} is invalid`);
  return raw;
}

function direction(value) {
  const raw = String(value ?? "");
  if (!DIRECTIONS.has(raw)) throw new RangeError("private packet direction is unsupported");
  return raw;
}

function purpose(value) {
  const raw = String(value ?? "");
  if (!PURPOSES.has(raw)) throw new RangeError("private packet purpose is unsupported");
  return raw;
}

function address(value, name) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("private packet contains an unsafe number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("private packet contains a non-plain object");
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("private packet contains an unsupported value");
}

function digest(value) {
  return `0x${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function privateEd25519Key(value, name) {
  let key;
  try {
    key = value?.type === "private" ? value : createPrivateKey(value);
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`${name} must be Ed25519`);
  return key;
}

function publicEd25519Key(value, name) {
  let key;
  try {
    key = value?.type === "public" ? value : createPublicKey(value);
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`${name} must be Ed25519`);
  return key;
}

function signature(value, name) {
  const raw = String(value ?? "");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== raw) throw new TypeError(`${name} is invalid`);
  return decoded;
}

function requestMessage(requestDigest) {
  return Buffer.from(`TreeSwap private packet request v1\n${bytes32(requestDigest, "request digest")}\n`, "utf8");
}

function responseMessage(responseDigest) {
  return Buffer.from(`TreeSwap private packet response v1\n${bytes32(responseDigest, "response digest")}\n`, "utf8");
}

function normalizeRequestPayload(raw) {
  exactKeys(raw, [
    "actionId", "capacityEpoch", "direction", "expiresAt", "intentDigest", "invoiceDigest", "payloadDigest",
    "paymentHash", "purpose", "quoteReceiptDigest", "requestId", "requestedAt", "requesterKeyId",
    "reservationId", "schema", "selectedOfferId", "selectedSetDigest", "settlementId",
  ], "private packet request payload");
  const requestedAt = integer(raw.requestedAt, "private packet requestedAt");
  const expiresAt = integer(raw.expiresAt, "private packet request expiresAt");
  if (raw.schema !== PRIVATE_PACKET_REQUEST_SCHEMA) throw new TypeError("private packet request schema is unsupported");
  if (expiresAt <= requestedAt || expiresAt - requestedAt > MAX_REQUEST_LIFETIME_SECONDS) {
    throw new RangeError("private packet request lifetime is outside policy");
  }
  const actionId = optionalBytes32(raw.actionId, "private packet actionId");
  const payloadDigest = optionalBytes32(raw.payloadDigest, "private packet payloadDigest");
  if ((actionId === null) !== (payloadDigest === null)) {
    throw new Error("private packet action and payload commitments must appear together");
  }
  return Object.freeze({
    schema: PRIVATE_PACKET_REQUEST_SCHEMA,
    requestId: bytes32(raw.requestId, "private packet requestId"),
    requesterKeyId: keyId(raw.requesterKeyId, "private packet requesterKeyId"),
    settlementId: bytes32(raw.settlementId, "private packet settlementId"),
    reservationId: bytes32(raw.reservationId, "private packet reservationId"),
    actionId,
    payloadDigest,
    purpose: purpose(raw.purpose),
    direction: direction(raw.direction),
    intentDigest: bytes32(raw.intentDigest, "private packet intentDigest"),
    paymentHash: bytes32(raw.paymentHash, "private packet paymentHash"),
    invoiceDigest: bytes32(raw.invoiceDigest, "private packet invoiceDigest"),
    quoteReceiptDigest: bytes32(raw.quoteReceiptDigest, "private packet quoteReceiptDigest"),
    selectedSetDigest: bytes32(raw.selectedSetDigest, "private packet selectedSetDigest"),
    selectedOfferId: bytes32(raw.selectedOfferId, "private packet selectedOfferId"),
    capacityEpoch: integer(raw.capacityEpoch, "private packet capacityEpoch"),
    requestedAt,
    expiresAt,
  });
}

function normalizeSendPaymentOperation(raw, request) {
  exactKeys(raw, ["feeLimitSats", "paymentRequest", "timeoutSeconds"], "private send-payment operation");
  const paymentRequest = String(raw.paymentRequest ?? "");
  if (!paymentRequest || Buffer.byteLength(paymentRequest) > 8_192) throw new TypeError("private payment request is invalid");
  if (invoiceDigest(paymentRequest) !== request.invoiceDigest) throw new Error("private payment request digest changed");
  return Object.freeze({
    feeLimitSats: uint(raw.feeLimitSats, "private payment fee limit"),
    paymentRequest,
    timeoutSeconds: integer(raw.timeoutSeconds, "private payment timeout", 600),
  });
}

function normalizeSettleInvoiceOperation(raw, request) {
  exactKeys(raw, ["preimage"], "private settle-invoice operation");
  const preimage = bytes32(raw.preimage, "private invoice preimage");
  const paymentHash = `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
  if (paymentHash !== request.paymentHash) throw new Error("private preimage does not match the settlement payment hash");
  return Object.freeze({ preimage });
}

function normalizeEvmClaimOperation(raw, request) {
  exactKeys(raw, [
    "chainId", "contract", "contractCodeHash", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "nonce",
    "quoteId", "value",
  ], "private EVM claim operation");
  const operation = Object.freeze({
    chainId: uint(raw.chainId, "private claim chainId", { nonzero: true }),
    contract: address(raw.contract, "private claim contract"),
    contractCodeHash: bytes32(raw.contractCodeHash, "private claim contractCodeHash"),
    nonce: uint(raw.nonce, "private claim nonce"),
    gasLimit: uint(raw.gasLimit, "private claim gasLimit", { nonzero: true }),
    maxFeePerGas: uint(raw.maxFeePerGas, "private claim maxFeePerGas", { nonzero: true }),
    maxPriorityFeePerGas: uint(raw.maxPriorityFeePerGas, "private claim maxPriorityFeePerGas"),
    value: uint(raw.value, "private claim value"),
    quoteId: bytes32(raw.quoteId, "private claim quoteId"),
  });
  if (operation.quoteId !== request.reservationId) throw new Error("private claim quote changed");
  if (operation.value !== "0") throw new Error("private claim cannot transfer native value");
  if (BigInt(operation.maxPriorityFeePerGas) > BigInt(operation.maxFeePerGas)) {
    throw new Error("private claim priority fee exceeds its maximum fee");
  }
  return operation;
}

function normalizeOperation(raw, request) {
  if (request.purpose === "SEND_PAYMENT") {
    if (request.direction !== "bit-to-lightning") throw new Error("send-payment packet has the wrong direction");
    return normalizeSendPaymentOperation(raw, request);
  }
  if (request.purpose === "SETTLE_INVOICE") {
    if (request.direction !== "lightning-to-bit") throw new Error("settle-invoice packet has the wrong direction");
    return normalizeSettleInvoiceOperation(raw, request);
  }
  if (request.direction !== "bit-to-lightning") throw new Error("EVM-claim packet has the wrong direction");
  return normalizeEvmClaimOperation(raw, request);
}

function normalizePacket(raw, request, minimumEvmSafetySeconds) {
  exactKeys(raw, [
    "actionId", "capacityEpoch", "direction", "evmRefundAt", "intentDigest", "invoiceDigest",
    "lightningActionDeadline", "operation", "payloadDigest", "paymentHash", "purpose", "quoteExpiresAt",
    "quoteReceiptDigest", "reservationId", "selectedOfferId", "selectedSetDigest", "settlementId",
  ], "private packet");
  const packet = {
    settlementId: bytes32(raw.settlementId, "packet settlementId"),
    reservationId: bytes32(raw.reservationId, "packet reservationId"),
    actionId: optionalBytes32(raw.actionId, "packet actionId"),
    payloadDigest: optionalBytes32(raw.payloadDigest, "packet payloadDigest"),
    purpose: purpose(raw.purpose),
    direction: direction(raw.direction),
    intentDigest: bytes32(raw.intentDigest, "packet intentDigest"),
    paymentHash: bytes32(raw.paymentHash, "packet paymentHash"),
    invoiceDigest: bytes32(raw.invoiceDigest, "packet invoiceDigest"),
    quoteReceiptDigest: bytes32(raw.quoteReceiptDigest, "packet quoteReceiptDigest"),
    selectedSetDigest: bytes32(raw.selectedSetDigest, "packet selectedSetDigest"),
    selectedOfferId: bytes32(raw.selectedOfferId, "packet selectedOfferId"),
    capacityEpoch: integer(raw.capacityEpoch, "packet capacityEpoch"),
    quoteExpiresAt: integer(raw.quoteExpiresAt, "packet quoteExpiresAt"),
    lightningActionDeadline: integer(raw.lightningActionDeadline, "packet lightningActionDeadline"),
    evmRefundAt: integer(raw.evmRefundAt, "packet evmRefundAt"),
  };
  for (const field of [
    "settlementId", "reservationId", "actionId", "payloadDigest", "purpose", "direction", "intentDigest",
    "paymentHash", "invoiceDigest", "quoteReceiptDigest", "selectedSetDigest", "selectedOfferId", "capacityEpoch",
  ]) {
    if (packet[field] !== request[field]) throw new Error(`private packet changed ${field}`);
  }
  const safety = integer(minimumEvmSafetySeconds, "minimum EVM safety seconds", 86_400);
  if (safety === 0 || packet.lightningActionDeadline >= packet.evmRefundAt
      || packet.evmRefundAt - packet.lightningActionDeadline < safety) {
    throw new Error("private packet deadline ordering is unsafe");
  }
  packet.operation = normalizeOperation(raw.operation, request);
  return Object.freeze(packet);
}

export function buildPrivatePacketRequest({
  settlement,
  action = null,
  purpose: requestedPurpose,
  requestId,
  requesterKeyId,
  requestedAt,
  expiresAt,
}) {
  if (!settlement?.reservationId) throw new Error("private packet request requires an observed reservation");
  if (action && action.settlementId !== settlement.settlementId) throw new Error("private packet action belongs to another settlement");
  return normalizeRequestPayload({
    schema: PRIVATE_PACKET_REQUEST_SCHEMA,
    requestId,
    requesterKeyId,
    settlementId: settlement.settlementId,
    reservationId: settlement.reservationId,
    actionId: action?.actionId ?? null,
    payloadDigest: action?.payloadDigest ?? null,
    purpose: requestedPurpose,
    direction: settlement.direction,
    intentDigest: settlement.intentDigest,
    paymentHash: settlement.paymentHash,
    invoiceDigest: settlement.invoiceDigest,
    quoteReceiptDigest: settlement.quoteReceiptDigest,
    selectedSetDigest: settlement.selectedSetDigest,
    selectedOfferId: settlement.selectedOfferId,
    capacityEpoch: settlement.capacityEpoch,
    requestedAt,
    expiresAt,
  });
}

export function privatePacketRequestDigest(payload) {
  return digest(normalizeRequestPayload(payload));
}

export function signPrivatePacketRequest(payload, privateKey) {
  const normalized = normalizeRequestPayload(payload);
  const key = privateEd25519Key(privateKey, "private packet requester key");
  return Object.freeze({
    payload: normalized,
    signature: signMessage(null, requestMessage(privatePacketRequestDigest(normalized)), key).toString("base64"),
  });
}

export function verifyPrivatePacketRequest({ envelope, publicKey, expectedKeyId, now, maxClockSkewSeconds = 5 }) {
  exactKeys(envelope, ["payload", "signature"], "private packet request envelope");
  const payload = normalizeRequestPayload(envelope.payload);
  const key = publicEd25519Key(publicKey, "private packet requester public key");
  const observedAt = integer(now, "private packet request verification time");
  const skew = integer(maxClockSkewSeconds, "private packet request clock skew", 60);
  if (payload.requesterKeyId !== keyId(expectedKeyId, "expected requester keyId")
      || payload.requestedAt > observedAt + skew || payload.expiresAt <= observedAt) {
    throw new Error("private packet request is outside its authority window");
  }
  if (!verifyMessage(null, requestMessage(privatePacketRequestDigest(payload)), key, signature(envelope.signature, "request signature"))) {
    throw new Error("private packet request signature is invalid");
  }
  return payload;
}

function unsignedResponse(response) {
  return Object.freeze({
    schema: response.schema,
    request: response.request,
    packet: response.packet,
    providerKeyId: response.providerKeyId,
    servedAt: response.servedAt,
    expiresAt: response.expiresAt,
  });
}

export async function buildSignedPrivatePacketResponse({
  requestEnvelope,
  requesterPublicKey,
  expectedRequesterKeyId,
  packet,
  providerKeyId,
  providerPrivateKey,
  consumeRequest,
  servedAt,
  expiresAt,
  minimumEvmSafetySeconds,
}) {
  const responseServedAt = integer(servedAt, "private packet servedAt");
  const request = verifyPrivatePacketRequest({
    envelope: requestEnvelope,
    publicKey: requesterPublicKey,
    expectedKeyId: expectedRequesterKeyId,
    now: responseServedAt,
  });
  const normalizedPacket = normalizePacket(packet, request, minimumEvmSafetySeconds);
  const responseExpiresAt = integer(expiresAt, "private packet response expiresAt");
  if (responseServedAt < request.requestedAt || responseServedAt > request.expiresAt
      || responseExpiresAt <= responseServedAt || responseExpiresAt > request.expiresAt
      || responseExpiresAt > normalizedPacket.quoteExpiresAt) {
    throw new Error("private packet response is outside its authority window");
  }
  if (request.purpose !== "EVM_CLAIM" && responseExpiresAt > normalizedPacket.lightningActionDeadline) {
    throw new Error("private packet response outlives the Lightning action deadline");
  }
  if (request.purpose === "EVM_CLAIM" && responseExpiresAt > normalizedPacket.evmRefundAt) {
    throw new Error("private packet response outlives the EVM refund deadline");
  }
  const unsigned = Object.freeze({
    schema: PRIVATE_PACKET_RESPONSE_SCHEMA,
    request: Object.freeze({ payload: request, signature: requestEnvelope.signature }),
    packet: normalizedPacket,
    providerKeyId: keyId(providerKeyId, "private packet providerKeyId"),
    servedAt: responseServedAt,
    expiresAt: responseExpiresAt,
  });
  const key = privateEd25519Key(providerPrivateKey, "private packet provider key");
  if (typeof consumeRequest !== "function") {
    throw new TypeError("private packet response requires a durable request replay consumer");
  }
  const consumed = await consumeRequest(Object.freeze({
    requesterKeyId: request.requesterKeyId,
    requestId: request.requestId,
    requestDigest: privatePacketRequestDigest(request),
    servedAt: responseServedAt,
    expiresAt: request.expiresAt,
  }));
  if (consumed !== true) throw new Error("private packet request was already consumed");
  const responseDigest = digest(unsigned);
  return Object.freeze({
    ...unsigned,
    signature: signMessage(null, responseMessage(responseDigest), key).toString("base64"),
  });
}

export function verifyPrivatePacketResponse({
  envelope,
  expectedRequestEnvelope,
  providerPublicKey,
  expectedProviderKeyId,
  now,
  minimumEvmSafetySeconds,
}) {
  exactKeys(envelope, ["expiresAt", "packet", "providerKeyId", "request", "schema", "servedAt", "signature"], "private packet response");
  if (envelope.schema !== PRIVATE_PACKET_RESPONSE_SCHEMA) throw new Error("private packet response schema is unsupported");
  const expectedRequest = normalizeRequestPayload(expectedRequestEnvelope.payload);
  exactKeys(expectedRequestEnvelope, ["payload", "signature"], "expected private packet request");
  signature(expectedRequestEnvelope.signature, "expected private packet request signature");
  if (canonicalize(envelope.request) !== canonicalize(expectedRequestEnvelope)) {
    throw new Error("private packet response changed the request");
  }
  const packet = normalizePacket(envelope.packet, expectedRequest, minimumEvmSafetySeconds);
  const servedAt = integer(envelope.servedAt, "private packet servedAt");
  const expiresAt = integer(envelope.expiresAt, "private packet response expiresAt");
  const observedAt = integer(now, "private packet verification time");
  if (keyId(envelope.providerKeyId, "private packet providerKeyId") !== keyId(expectedProviderKeyId, "expected provider keyId")) {
    throw new Error("private packet provider key is not active");
  }
  if (servedAt < expectedRequest.requestedAt || servedAt > observedAt + 5 || expiresAt <= observedAt
      || expiresAt <= servedAt || expiresAt > expectedRequest.expiresAt || expiresAt > packet.quoteExpiresAt
      || (expectedRequest.purpose === "EVM_CLAIM" ? expiresAt > packet.evmRefundAt : expiresAt > packet.lightningActionDeadline)) {
    throw new Error("private packet response is outside its authority window");
  }
  const normalizedUnsigned = unsignedResponse({
    schema: PRIVATE_PACKET_RESPONSE_SCHEMA,
    request: expectedRequestEnvelope,
    packet,
    providerKeyId: envelope.providerKeyId,
    servedAt,
    expiresAt,
  });
  const key = publicEd25519Key(providerPublicKey, "private packet provider public key");
  const responseDigest = digest(normalizedUnsigned);
  if (!verifyMessage(null, responseMessage(responseDigest), key, signature(envelope.signature, "private packet response signature"))) {
    throw new Error("private packet response signature is invalid");
  }
  const verified = Object.freeze({
    packet,
    responseDigest,
    servedAt,
    expiresAt,
  });
  VERIFIED_PRIVATE_PACKETS.add(verified);
  return verified;
}

export function isVerifiedPrivatePacketResult(value) {
  return Boolean(value && VERIFIED_PRIVATE_PACKETS.has(value));
}

export function privatePacketProviderOrigin(origin) {
  let url;
  try {
    url = new URL(String(origin ?? ""));
  } catch {
    throw new Error("private packet provider must use an isolated private HTTPS origin on port 443");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "") || !isPrivateLndHostname(url.hostname)) {
    throw new Error("private packet provider must use an isolated private HTTPS origin on port 443");
  }
  return url.origin;
}

function privateProviderUrl(origin) {
  return new URL("/v1/private-packet", `${privatePacketProviderOrigin(origin)}/`);
}

export function fixedPrivatePacketHttpsRequest(endpoint, options) {
  const requestUrl = new URL(endpoint);
  const expected = privateProviderUrl(requestUrl.origin);
  if (requestUrl.href !== expected.href || options?.method !== "POST"
      || options?.redirect !== "error" || typeof options?.body !== "string") {
    throw new Error("private packet fixed HTTPS request is invalid");
  }
  const hostname = requestUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const body = options.body;
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname,
      port: 443,
      servername: isIP(hostname) === 0 ? hostname : undefined,
      method: "POST",
      path: expected.pathname,
      agent: false,
      rejectUnauthorized: true,
      signal: options.signal,
      headers: {
        ...options.headers,
        host: expected.host,
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const headers = response.headers;
      resolve({
        status: response.statusCode ?? 0,
        redirected: false,
        headers: {
          get(name) {
            const value = headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(", ") : value ?? null;
          },
        },
        body: Readable.toWeb(response),
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function boundedJson(response, signal) {
  const type = String(response?.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new Error("private packet response content type is invalid");
  const cacheControl = String(response.headers.get("cache-control") ?? "").toLowerCase();
  if (!cacheControl.split(",").some((directive) => directive.trim() === "no-store")) {
    throw new Error("private packet response must disable storage");
  }
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null && !/^[0-9]+$/.test(declaredHeader)) {
    throw new Error("private packet response content length is invalid");
  }
  const declared = Number(declaredHeader ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("private packet response is too large");
  if (!response.body) throw new Error("private packet provider returned an empty response");
  const reader = response.body.getReader();
  const cancelOnAbort = () => { void reader.cancel().catch(() => {}); };
  if (signal?.aborted) cancelOnAbort();
  else signal?.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("private packet response is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("private packet provider returned malformed JSON");
  }
}

export async function fetchVerifiedPrivatePacket({
  providerOrigin,
  requestEnvelope,
  providerPublicKey,
  expectedProviderKeyId,
  minimumEvmSafetySeconds,
  requestImpl = fixedPrivatePacketHttpsRequest,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  timeoutMs = 5_000,
}) {
  const endpoint = privateProviderUrl(providerOrigin);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("private packet TLS certificate verification is disabled");
  }
  const timeout = integer(timeoutMs, "private packet request timeout", 30_000);
  if (timeout === 0) throw new RangeError("private packet request timeout must be non-zero");
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("private packet provider timed out"));
    }, timeout);
  });
  try {
    let response;
    try {
      response = await Promise.race([
        requestImpl(endpoint, {
          method: "POST",
          redirect: "error",
          headers: { accept: "application/json", "cache-control": "no-store", "content-type": "application/json" },
          body: JSON.stringify(requestEnvelope),
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch {
      throw new Error("private packet transport failed");
    }
    if (response?.redirected === true || response?.status !== 200) throw new Error("private packet provider rejected the request");
    let body;
    try {
      body = await Promise.race([boundedJson(response, controller.signal), deadline]);
    } catch (error) {
      if (timedOut) throw new Error("private packet transport failed");
      throw error;
    }
    return verifyPrivatePacketResponse({
      envelope: body,
      expectedRequestEnvelope: requestEnvelope,
      providerPublicKey,
      expectedProviderKeyId,
      now: integer(nowSeconds(), "private packet response time"),
      minimumEvmSafetySeconds,
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
