import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import {
  solverEndpointOriginDigest,
  solverEndpointPublicKeyDigest,
  verifySolverCapability,
} from "./solver-capability.mjs";
import {
  discardJsonResponseBody,
  readStrictJsonResponse,
} from "./private-json-response.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const REQUEST_SCHEMA = "treeswap.solver-capability-request.v1";
const RESPONSE_SCHEMA = "treeswap.solver-capability-response.v1";
const MAX_REQUEST_TTL_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 5;
const MAX_JSON_DEPTH = 4;
const MAX_JSON_OBJECT_KEYS = 32;
const MAX_JSON_STRING_BYTES = 4_096;
const BLOCKED_ENDPOINT_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) BLOCKED_ENDPOINT_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["100:0:0:1::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8],
]) BLOCKED_ENDPOINT_ADDRESSES.addSubnet(network, prefix, "ipv6");

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

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function address(value, name) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function direction(value) {
  const raw = String(value ?? "");
  if (!DIRECTIONS.has(raw)) throw new RangeError("solver endpoint direction is unsupported");
  return raw;
}

export function isPublicSolverEndpointAddress(value) {
  const raw = String(value ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  // Treat every IPv4-mapped IPv6 literal conservatively. Node's BlockList
  // performs cross-family matching inconsistently across supported runtimes,
  // and accepting a mapped address would make the DNS pinning rule ambiguous.
  if (raw.startsWith("::ffff:")) return false;
  const family = isIP(raw);
  if (family === 0) return false;
  return !BLOCKED_ENDPOINT_ADDRESSES.check(raw, family === 4 ? "ipv4" : "ipv6");
}

function publicEndpointUrl(origin) {
  solverEndpointOriginDigest(origin);
  const url = new URL(origin);
  if (url.port) throw new Error("solver endpoint must use the default HTTPS port");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  if (family !== 0 && !isPublicSolverEndpointAddress(hostname)) {
    throw new Error("solver endpoint address is not public");
  }
  if (family === 0 && (!hostname.includes(".") || hostname === "localhost"
      || hostname.endsWith(".localhost") || hostname.endsWith(".local")
      || hostname.endsWith(".internal") || hostname.endsWith(".svc.cluster.local"))) {
    throw new Error("solver endpoint hostname is not public");
  }
  return url;
}

export function publicSolverEndpointOrigin(origin) {
  return publicEndpointUrl(origin).origin;
}

async function resolvePinnedPublicAddress(hostname, lookupImpl) {
  const literalFamily = isIP(hostname);
  const resolved = literalFamily === 0
    ? await lookupImpl(hostname, { all: true, verbatim: true })
    : [{ address: hostname, family: literalFamily }];
  if (!Array.isArray(resolved) || resolved.length === 0) throw new Error("solver endpoint did not resolve");
  const normalized = resolved.map((entry) => ({
    address: String(entry?.address ?? "").toLowerCase(),
    family: Number(entry?.family),
  }));
  if (normalized.some((entry) => (entry.family !== 4 && entry.family !== 6)
      || !isPublicSolverEndpointAddress(entry.address))) {
    throw new Error("solver endpoint resolved outside the public network");
  }
  return normalized[0];
}

function boundedNodeResponseBody(response, maximumBytes) {
  const reader = Readable.toWeb(response).getReader();
  let received = 0;
  let finished = false;
  return new ReadableStream({
    async pull(controller) {
      if (finished) return;
      try {
        const { value, done } = await reader.read();
        if (done) {
          finished = true;
          controller.close();
          return;
        }
        if (!(value instanceof Uint8Array)) throw new Error("invalid response chunk");
        received += value.byteLength;
        if (received > maximumBytes) {
          finished = true;
          void reader.cancel().catch(() => {});
          response.destroy?.();
          controller.error(new Error("solver endpoint response exceeded its size limit"));
          return;
        }
        controller.enqueue(value);
      } catch {
        if (!finished) {
          finished = true;
          response.destroy?.();
          controller.error(new Error("solver endpoint response was interrupted"));
        }
      }
    },
    cancel() {
      if (finished) return;
      finished = true;
      void reader.cancel().catch(() => {});
      response.destroy?.();
    },
  });
}

async function pinnedPublicEndpointRequest(urlValue, options, {
  expectedPath,
  lookupImpl = dnsLookup,
  httpsRequestImpl = httpsRequest,
  maximumResponseBytes = 65_536,
} = {}) {
  const url = publicEndpointUrl(new URL(urlValue).origin);
  const requestUrl = new URL(urlValue);
  if (requestUrl.origin !== url.origin || requestUrl.pathname !== expectedPath || requestUrl.search || requestUrl.hash) {
    throw new Error("solver endpoint request URL is invalid");
  }
  const limit = integer(maximumResponseBytes, "maximumResponseBytes", 262_144);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const target = await resolvePinnedPublicAddress(hostname, lookupImpl);
  const body = String(options?.body ?? "");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = httpsRequestImpl({
      protocol: "https:",
      hostname: target.address,
      family: target.family,
      port: 443,
      servername: isIP(hostname) === 0 ? hostname : undefined,
      method: "POST",
      path: expectedPath,
      agent: false,
      rejectUnauthorized: true,
      signal: options?.signal,
      headers: {
        ...options?.headers,
        host: url.host,
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const headers = response.headers;
      finish(resolve, {
        status: response.statusCode ?? 0,
        redirected: false,
        headers: {
          get(name) {
            const value = headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(", ") : value ?? null;
          },
        },
        body: boundedNodeResponseBody(response, limit),
      });
    });
    request.on("error", (error) => finish(reject, error));
    request.end(body);
  });
}

export function pinnedPublicHttpsRequest(urlValue, options, dependencies = {}) {
  return pinnedPublicEndpointRequest(urlValue, options, {
    ...dependencies,
    expectedPath: "/v1/capability",
  });
}

export function pinnedPublicRfqRequest(urlValue, options, dependencies = {}) {
  return pinnedPublicEndpointRequest(urlValue, options, {
    ...dependencies,
    expectedPath: "/v1/rfq",
  });
}

export function pinnedPublicSelectedSolverRequest(urlValue, options, dependencies = {}) {
  return pinnedPublicEndpointRequest(urlValue, options, {
    ...dependencies,
    expectedPath: "/v1/finalize",
  });
}

function assertBoundedJson(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new Error("solver endpoint response nesting exceeded its limit");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("solver endpoint response contains an unsafe number");
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_JSON_STRING_BYTES) {
      throw new Error("solver endpoint response contains an oversized string");
    }
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("solver endpoint response contains a non-JSON value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("solver endpoint response contains a non-plain object");
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_JSON_OBJECT_KEYS) throw new Error("solver endpoint response has too many fields");
  for (const key of keys) {
    if (Buffer.byteLength(key) > 64) throw new Error("solver endpoint response contains an oversized field name");
    assertBoundedJson(value[key], depth + 1);
  }
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function normalizeRequest(raw) {
  exactKeys(raw, ["challenge", "direction", "expiresAt", "requestedAt", "schema", "solverId"], "solver endpoint request");
  if (raw.schema !== REQUEST_SCHEMA) throw new Error("solver endpoint request schema is unsupported");
  const requestedAt = integer(raw.requestedAt, "request.requestedAt");
  const expiresAt = integer(raw.expiresAt, "request.expiresAt");
  if (expiresAt <= requestedAt || expiresAt - requestedAt > MAX_REQUEST_TTL_SECONDS) {
    throw new RangeError("solver endpoint request lifetime is outside policy");
  }
  return Object.freeze({
    schema: REQUEST_SCHEMA,
    challenge: bytes32(raw.challenge, "request.challenge"),
    solverId: address(raw.solverId, "request.solverId"),
    direction: direction(raw.direction),
    requestedAt,
    expiresAt,
  });
}

function normalizeResponseShape(raw) {
  assertBoundedJson(raw);
  exactKeys(raw, ["capabilityEnvelope", "expiresAt", "request", "schema", "servedAt", "signature"], "solver endpoint response");
  if (raw.schema !== RESPONSE_SCHEMA) throw new Error("solver endpoint response schema is unsupported");
  exactKeys(raw.capabilityEnvelope, [
    "declaration", "endpointOrigin", "endpointPublicKey", "endpointSignature", "evmSignature",
    "lightningNodePubkey", "lightningSignature",
  ], "solver capability envelope");
  exactKeys(raw.capabilityEnvelope.declaration, [
    "availableBitWei", "availableLightningSats", "capabilityId", "capacityEpoch", "direction",
    "endpointOriginDigest", "endpointPublicKeyDigest", "expiresAt", "issuedAt",
    "lightningNodePubkeyDigest", "proofChallenge", "solver",
  ], "solver capability declaration");
  const signature = String(raw.signature ?? "");
  if (!BASE64_SIGNATURE.test(signature)) throw new TypeError("solver endpoint response signature is invalid");
  return Object.freeze({
    schema: RESPONSE_SCHEMA,
    request: normalizeRequest(raw.request),
    capabilityEnvelope: raw.capabilityEnvelope,
    servedAt: integer(raw.servedAt, "response.servedAt"),
    expiresAt: integer(raw.expiresAt, "response.expiresAt"),
    signature,
  });
}

function unsignedResponse(response) {
  return Object.freeze({
    schema: response.schema,
    request: response.request,
    capabilityEnvelope: response.capabilityEnvelope,
    servedAt: response.servedAt,
    expiresAt: response.expiresAt,
  });
}

export function solverEndpointResponseDigest(response) {
  const normalized = normalizeResponseShape({ ...response, signature: response.signature ?? "A".repeat(86) + "==" });
  return keccak256(toUtf8Bytes(canonicalize(unsignedResponse(normalized))));
}

export function solverEndpointResponseMessage(responseDigest) {
  return Buffer.from(`TreeSwap solver endpoint response v1\n${bytes32(responseDigest, "responseDigest")}\n`, "utf8");
}

export function buildSolverCapabilityRequest({ challenge, solverId, direction: requestedDirection, requestedAt, expiresAt }) {
  return normalizeRequest({
    schema: REQUEST_SCHEMA,
    challenge,
    solverId,
    direction: requestedDirection,
    requestedAt,
    expiresAt,
  });
}

export function buildSignedSolverCapabilityResponse({
  request,
  capabilityEnvelope,
  servedAt,
  expiresAt,
  endpointPrivateKey,
}) {
  const normalizedRequest = normalizeRequest(request);
  assertBoundedJson(capabilityEnvelope);
  const privateKey = endpointPrivateKey?.type === "private"
    ? endpointPrivateKey
    : createPrivateKey(endpointPrivateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new TypeError("solver endpoint private key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  if (solverEndpointPublicKeyDigest(publicKeyPem) !== solverEndpointPublicKeyDigest(capabilityEnvelope.endpointPublicKey)) {
    throw new Error("solver endpoint private key does not match the capability");
  }
  const normalizedServedAt = integer(servedAt, "servedAt");
  const normalizedExpiresAt = integer(expiresAt, "expiresAt");
  const capabilityExpiresAt = integer(capabilityEnvelope.declaration?.expiresAt, "capability.expiresAt");
  if (normalizedServedAt < normalizedRequest.requestedAt - MAX_CLOCK_SKEW_SECONDS
      || normalizedServedAt > normalizedRequest.expiresAt) {
    throw new RangeError("solver endpoint response time is outside the request window");
  }
  if (normalizedExpiresAt <= normalizedServedAt || normalizedExpiresAt > normalizedRequest.expiresAt
      || normalizedExpiresAt > capabilityExpiresAt) {
    throw new RangeError("solver endpoint response expiry is outside its authority");
  }
  const unsigned = Object.freeze({
    schema: RESPONSE_SCHEMA,
    request: normalizedRequest,
    capabilityEnvelope,
    servedAt: normalizedServedAt,
    expiresAt: normalizedExpiresAt,
  });
  const digest = keccak256(toUtf8Bytes(canonicalize(unsigned)));
  const signature = signMessage(null, solverEndpointResponseMessage(digest), privateKey).toString("base64");
  return Object.freeze({ ...unsigned, signature });
}

async function withAbortSignal(operation, signal) {
  if (signal === null) return operation;
  if (signal.aborted) throw new Error("solver endpoint request was aborted");
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(new Error("solver endpoint request was aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class SolverEndpointError extends Error {
  constructor(message, { code }) {
    super(message);
    this.name = "SolverEndpointError";
    this.code = code;
    this.ambiguous = false;
  }
}

export async function queryVerifiedSolverCapability({
  endpointOrigin,
  solverId,
  direction: requestedDirection,
  policy,
  verifyLightningNodeSignature,
  readVerifiedBitInventory,
  readVerifiedLightningCapacity,
  requestImpl = null,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  randomBytesImpl = randomBytes,
  requestTtlSeconds = 15,
  timeoutMs = 5_000,
  maximumResponseBytes = 65_536,
  signal = null,
}) {
  const origin = String(endpointOrigin ?? "");
  const endpointOriginUrl = publicEndpointUrl(origin);
  const expectedSolver = address(solverId, "solverId");
  const expectedDirection = direction(requestedDirection);
  const requestedAt = integer(nowSeconds(), "nowSeconds");
  const ttl = integer(requestTtlSeconds, "requestTtlSeconds", MAX_REQUEST_TTL_SECONDS);
  if (ttl === 0) throw new RangeError("solver endpoint request lifetime must be non-zero");
  const challengeSource = randomBytesImpl(32);
  if (!Buffer.isBuffer(challengeSource) && !(challengeSource instanceof Uint8Array)) {
    throw new Error("solver endpoint challenge source returned an invalid value");
  }
  const challengeBytes = Buffer.from(challengeSource);
  if (challengeBytes.length !== 32) throw new Error("solver endpoint challenge source returned the wrong size");
  const request = buildSolverCapabilityRequest({
    challenge: `0x${challengeBytes.toString("hex")}`,
    solverId: expectedSolver,
    direction: expectedDirection,
    requestedAt,
    expiresAt: requestedAt + ttl,
  });
  const requestTimeout = integer(timeoutMs, "timeoutMs", 30_000);
  if (requestTimeout === 0) throw new RangeError("solver endpoint timeout must be non-zero");
  const responseLimit = integer(maximumResponseBytes, "maximumResponseBytes", 262_144);
  if (responseLimit < 1_024) throw new RangeError("solver endpoint response limit is too small");
  if (signal !== null && (!signal || typeof signal !== "object"
      || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw new TypeError("solver endpoint abort signal is invalid");
  }
  if (signal?.aborted) {
    throw new SolverEndpointError("solver endpoint request was aborted", { code: "TRANSPORT_FAILED" });
  }
  const endpointUrl = new URL("/v1/capability", endpointOriginUrl);
  const performRequest = requestImpl ?? ((url, options) => pinnedPublicHttpsRequest(url, options, {
    maximumResponseBytes: responseLimit,
  }));
  const controller = new AbortController();
  const requestSignal = signal === null
    ? controller.signal
    : AbortSignal.any([controller.signal, signal]);
  let timer;
  let timedOut = false;
  const hardDeadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("solver endpoint request timed out"));
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
          signal: requestSignal,
        }),
        hardDeadline,
      ]);
    } catch {
      throw new SolverEndpointError("solver endpoint transport failed", { code: "TRANSPORT_FAILED" });
    }
    if (!rawResponse || typeof rawResponse !== "object") {
      throw new SolverEndpointError("solver endpoint returned an invalid response", { code: "INVALID_RESPONSE" });
    }
    if (rawResponse.redirected === true) {
      await discardJsonResponseBody(rawResponse);
      throw new SolverEndpointError("solver endpoint redirect was refused", { code: "REDIRECT_REFUSED" });
    }
    if (rawResponse.status !== 200) {
      await discardJsonResponseBody(rawResponse);
      throw new SolverEndpointError("solver endpoint request was rejected", { code: "HTTP_REJECTED" });
    }
    try {
      response = normalizeResponseShape(await Promise.race([
        readStrictJsonResponse(rawResponse, {
          label: "solver endpoint response",
          maximumResponseBytes: responseLimit,
          signal: requestSignal,
        }),
        hardDeadline,
      ]));
    } catch {
      if (timedOut || signal?.aborted) {
        throw new SolverEndpointError("solver endpoint transport failed", { code: "TRANSPORT_FAILED" });
      }
      throw new SolverEndpointError("solver endpoint returned an invalid response", { code: "INVALID_RESPONSE" });
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const observedAt = integer(nowSeconds(), "nowSeconds");
  if (signal?.aborted) {
    throw new SolverEndpointError("solver endpoint request was aborted", { code: "TRANSPORT_FAILED" });
  }
  if (canonicalize(response.request) !== canonicalize(request)) {
    throw new SolverEndpointError("solver endpoint response changed the request", { code: "REQUEST_CHANGED" });
  }
  if (observedAt > request.expiresAt || response.servedAt < request.requestedAt - MAX_CLOCK_SKEW_SECONDS
      || response.servedAt > observedAt + MAX_CLOCK_SKEW_SECONDS || response.expiresAt <= observedAt
      || response.expiresAt <= response.servedAt || response.expiresAt > request.expiresAt) {
    throw new SolverEndpointError("solver endpoint response is outside its time window", { code: "STALE_RESPONSE" });
  }
  let endpointKey;
  let endpointSignature;
  try {
    endpointKey = createPublicKey(response.capabilityEnvelope.endpointPublicKey);
    if (endpointKey.asymmetricKeyType !== "ed25519") throw new Error();
    endpointSignature = Buffer.from(response.signature, "base64");
  } catch {
    throw new SolverEndpointError("solver endpoint response key is invalid", { code: "INVALID_RESPONSE_KEY" });
  }
  const responseDigest = keccak256(toUtf8Bytes(canonicalize(unsignedResponse(response))));
  if (!verifyMessage(null, solverEndpointResponseMessage(responseDigest), endpointKey, endpointSignature)) {
    throw new SolverEndpointError("solver endpoint response signature is invalid", { code: "INVALID_RESPONSE_SIGNATURE" });
  }
  let capability;
  try {
    capability = await withAbortSignal(verifySolverCapability({
      envelope: response.capabilityEnvelope,
      now: observedAt,
      policy,
      verifyLightningNodeSignature,
      readVerifiedBitInventory,
      readVerifiedLightningCapacity,
    }), signal);
  } catch (error) {
    if (signal?.aborted) {
      throw new SolverEndpointError("solver endpoint request was aborted", { code: "TRANSPORT_FAILED" });
    }
    throw error;
  }
  if (signal?.aborted) {
    throw new SolverEndpointError("solver endpoint request was aborted", { code: "TRANSPORT_FAILED" });
  }
  if (!capability.valid || capability.binding.solverId !== expectedSolver
      || capability.binding.direction !== expectedDirection || capability.binding.endpointOrigin !== origin) {
    throw new SolverEndpointError("solver capability could not be verified", { code: "INVALID_CAPABILITY" });
  }
  if (response.expiresAt > capability.expiresAt) {
    throw new SolverEndpointError("solver endpoint response outlives its capability", { code: "AUTHORITY_EXPIRED" });
  }
  return Object.freeze({
    ...capability,
    transport: Object.freeze({
      authenticated: true,
      challenge: request.challenge,
      endpointOrigin: origin,
      requestExpiresAt: request.expiresAt,
      responseDigest,
      responseExpiresAt: response.expiresAt,
      servedAt: response.servedAt,
    }),
  });
}
