import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";
import { isPrivateLndHostname } from "./lnd-rest-client.mjs";
import {
  privateHttpsServername,
  resolvePinnedPrivateAddress,
} from "./private-https-address.mjs";
import {
  discardPrivateResponseBody,
  readStrictPrivateJsonResponse,
} from "./private-json-response.mjs";

export const SELECTED_SOLVER_INVOICE_MATERIAL_REQUEST_SCHEMA =
  "treeswap.selected-solver-invoice-material-request.v1";
export const SELECTED_SOLVER_INVOICE_MATERIAL_RESPONSE_SCHEMA =
  "treeswap.selected-solver-invoice-material-response.v1";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_REQUEST_LIFETIME_SECONDS = 30;
const MAX_RESPONSE_BYTES = 16_384;
const REQUEST_PAYLOAD_KEYS = Object.freeze([
  "amountSats",
  "authorizationExpiresAt",
  "capabilityDigest",
  "expiresAt",
  "materialDigest",
  "paymentSecretKeyId",
  "requestDigest",
  "requestId",
  "requestedAt",
  "requesterKeyId",
  "schema",
  "selectedOfferId",
]);
const ENVELOPE_KEYS = Object.freeze(["payload", "signature"]);
const RESPONSE_KEYS = Object.freeze([
  "addIndex",
  "amountSats",
  "capabilityDigest",
  "expiresAt",
  "invoice",
  "invoiceDigest",
  "invoiceState",
  "materialDigest",
  "paymentHash",
  "paymentSecretKeyId",
  "providerKeyId",
  "requestDigest",
  "requestId",
  "schema",
  "selectedOfferId",
  "servedAt",
  "signature",
]);
const CLIENT_BASE_KEYS = Object.freeze([
  "endpointOrigin",
  "paymentSecretKeyId",
  "providerKeyId",
  "providerPublicKey",
  "requesterKeyId",
  "requesterPrivateKey",
  "requestTtlSeconds",
  "signal",
  "timeoutMs",
]);
const CLIENT_KEYS = Object.freeze([
  ...CLIENT_BASE_KEYS,
  "expectedCertificateFingerprint",
  "providerCertificate",
]);
const TEST_CLIENT_KEYS = Object.freeze([
  ...CLIENT_BASE_KEYS,
  "nowSeconds",
  "requestImpl",
]);
const PREPARE_KEYS = Object.freeze([
  "amountSats",
  "authorizationExpiresAt",
  "capabilityDigest",
  "requestDigest",
  "requestId",
  "selectedOfferId",
]);
const VERIFIED_REQUESTS = new WeakSet();
const VERIFIED_RESPONSES = new WeakSet();
const CLIENTS = new WeakMap();
const ATTEMPTS = new WeakMap();
const DATE_NOW = Date.now.bind(Date);

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const wanted = [...expected].sort();
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const actual = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("invoice-material message contains an unsafe number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("invoice-material message contains a non-plain object");
    }
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    )).join(",")}}`;
  }
  throw new TypeError("invoice-material message contains unsupported data");
}

function digest(value) {
  return `0x${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  }
  return value;
}

function keyId(value, name) {
  if (typeof value !== "string" || !KEY_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function uint(value, name, maximum = (1n << 63n) - 1n) {
  if (typeof value !== "string" || !UINT.test(value)) {
    throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed > maximum) throw new RangeError(`${name} is outside policy`);
  return value;
}

function signature(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value) {
    throw new TypeError(`${name} is invalid`);
  }
  return decoded;
}

function privateKey(value, name) {
  try {
    const key = value?.type === "private" ? value : createPrivateKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new TypeError(`${name} must be an Ed25519 private key`);
  }
}

function publicKey(value, name) {
  try {
    const key = value?.type === "public" ? value : createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new TypeError(`${name} must be an Ed25519 public key`);
  }
}

function materialFields(value) {
  return Object.freeze({
    schema: SELECTED_SOLVER_INVOICE_MATERIAL_REQUEST_SCHEMA,
    requestId: bytes32(value.requestId, "invoice-material request ID"),
    requestDigest: bytes32(value.requestDigest, "invoice-material request digest"),
    capabilityDigest: bytes32(value.capabilityDigest, "invoice-material capability digest"),
    selectedOfferId: bytes32(value.selectedOfferId, "invoice-material selected offer ID"),
    amountSats: uint(value.amountSats, "invoice-material amount"),
    paymentSecretKeyId: keyId(value.paymentSecretKeyId, "invoice-material payment-secret key ID"),
    authorizationExpiresAt: integer(
      value.authorizationExpiresAt,
      "invoice-material authorization expiry",
      1,
    ),
  });
}

function materialDigest(value) {
  return digest(materialFields(value));
}

function requestMessage(value) {
  return Buffer.from(`TreeSwap selected-solver invoice-material request v1\n${digest(value)}\n`, "utf8");
}

function responseMessage(value) {
  return Buffer.from(`TreeSwap selected-solver invoice-material response v1\n${digest(value)}\n`, "utf8");
}

function normalizePayload(raw) {
  const source = exactDataRecord(raw, REQUEST_PAYLOAD_KEYS, "invoice-material request payload");
  if (source.schema !== SELECTED_SOLVER_INVOICE_MATERIAL_REQUEST_SCHEMA) {
    throw new Error("invoice-material request schema is unsupported");
  }
  const requestedAt = integer(source.requestedAt, "invoice-material requestedAt", 1);
  const expiresAt = integer(source.expiresAt, "invoice-material expiresAt", requestedAt + 1);
  const authorizationExpiresAt = integer(
    source.authorizationExpiresAt,
    "invoice-material authorization expiry",
    expiresAt,
  );
  if (expiresAt - requestedAt > MAX_REQUEST_LIFETIME_SECONDS) {
    throw new RangeError("invoice-material request lifetime is outside policy");
  }
  const material = materialFields(source);
  const normalized = Object.freeze({
    ...material,
    requesterKeyId: keyId(source.requesterKeyId, "invoice-material requester key ID"),
    materialDigest: bytes32(source.materialDigest, "invoice-material semantic digest"),
    requestedAt,
    expiresAt,
    authorizationExpiresAt,
  });
  if (normalized.materialDigest !== materialDigest(material)) {
    throw new Error("invoice-material semantic digest changed");
  }
  return normalized;
}

export function buildSignedSelectedSolverInvoiceMaterialRequest(input) {
  const source = exactDataRecord(input, [
    "amountSats",
    "authorizationExpiresAt",
    "capabilityDigest",
    "expiresAt",
    "paymentSecretKeyId",
    "requestDigest",
    "requestId",
    "requestedAt",
    "requesterKeyId",
    "requesterPrivateKey",
    "selectedOfferId",
  ], "invoice-material signed request input");
  const key = privateKey(source.requesterPrivateKey, "invoice-material requester private key");
  const material = materialFields({
    ...source,
    paymentSecretKeyId: source.paymentSecretKeyId,
  });
  const payload = normalizePayload({
    ...material,
    requesterKeyId: source.requesterKeyId,
    materialDigest: materialDigest(material),
    requestedAt: source.requestedAt,
    expiresAt: source.expiresAt,
    authorizationExpiresAt: source.authorizationExpiresAt,
  });
  return Object.freeze({
    payload,
    signature: signMessage(null, requestMessage(payload), key).toString("base64"),
  });
}

export function verifySelectedSolverInvoiceMaterialRequest(input) {
  const source = exactDataRecord(input, [
    "envelope",
    "expectedPaymentSecretKeyId",
    "expectedRequesterKeyId",
    "maxClockSkewSeconds",
    "now",
    "requesterPublicKey",
  ], "invoice-material request verification");
  const envelope = exactDataRecord(source.envelope, ENVELOPE_KEYS, "invoice-material request envelope");
  const payload = normalizePayload(envelope.payload);
  const observedAt = integer(source.now, "invoice-material verification time", 1);
  const skew = integer(source.maxClockSkewSeconds, "invoice-material clock skew", 0, 60);
  if (payload.requesterKeyId !== keyId(source.expectedRequesterKeyId, "expected requester key ID")
      || payload.paymentSecretKeyId !== keyId(
        source.expectedPaymentSecretKeyId,
        "expected payment-secret key ID",
      )
      || payload.requestedAt > observedAt + skew || payload.expiresAt <= observedAt
      || payload.authorizationExpiresAt < payload.expiresAt) {
    throw new Error("invoice-material request is outside its authority window");
  }
  if (!verifyMessage(
    null,
    requestMessage(payload),
    publicKey(source.requesterPublicKey, "invoice-material requester public key"),
    signature(envelope.signature, "invoice-material request signature"),
  )) throw new Error("invoice-material request signature is invalid");
  VERIFIED_REQUESTS.add(payload);
  return payload;
}

function unsignedResponse(response) {
  return Object.freeze(Object.fromEntries(RESPONSE_KEYS
    .filter((field) => field !== "signature")
    .map((field) => [field, response[field]])));
}

function canonicalInvoice(value) {
  if (typeof value !== "string") throw new TypeError("invoice-material invoice is invalid");
  const invoice = value.trim().replace(/^lightning:/i, "").toLowerCase();
  if (!invoice || Buffer.byteLength(invoice) > 8_192 || !/^ln[a-z0-9]+$/.test(invoice)) {
    throw new TypeError("invoice-material invoice is invalid");
  }
  return invoice;
}

function normalizeResponse(raw) {
  const source = exactDataRecord(raw, RESPONSE_KEYS, "invoice-material response");
  if (source.schema !== SELECTED_SOLVER_INVOICE_MATERIAL_RESPONSE_SCHEMA) {
    throw new Error("invoice-material response schema is unsupported");
  }
  const servedAt = integer(source.servedAt, "invoice-material response servedAt", 1);
  const expiresAt = integer(source.expiresAt, "invoice-material response expiresAt", servedAt + 1);
  const invoiceState = String(source.invoiceState ?? "");
  if (invoiceState !== "OPEN" && invoiceState !== "ACCEPTED") {
    throw new Error("invoice-material response state is unsafe");
  }
  return Object.freeze({
    schema: SELECTED_SOLVER_INVOICE_MATERIAL_RESPONSE_SCHEMA,
    requestId: bytes32(source.requestId, "invoice-material response request ID"),
    requestDigest: bytes32(source.requestDigest, "invoice-material response request digest"),
    capabilityDigest: bytes32(source.capabilityDigest, "invoice-material response capability digest"),
    selectedOfferId: bytes32(source.selectedOfferId, "invoice-material response selected offer ID"),
    amountSats: uint(source.amountSats, "invoice-material response amount"),
    materialDigest: bytes32(source.materialDigest, "invoice-material response semantic digest"),
    paymentSecretKeyId: keyId(source.paymentSecretKeyId, "invoice-material response key ID"),
    paymentHash: bytes32(source.paymentHash, "invoice-material response payment hash"),
    invoice: canonicalInvoice(source.invoice),
    invoiceDigest: bytes32(source.invoiceDigest, "invoice-material response invoice digest"),
    invoiceState,
    addIndex: uint(source.addIndex, "invoice-material response add index", (1n << 64n) - 1n),
    providerKeyId: keyId(source.providerKeyId, "invoice-material provider key ID"),
    servedAt,
    expiresAt,
    signature: String(source.signature ?? ""),
  });
}

export function selectedSolverInvoiceMaterialResponseDigest(raw) {
  const response = normalizeResponse(raw);
  return digest(response);
}

export function buildSignedSelectedSolverInvoiceMaterialResponse(input) {
  const source = exactDataRecord(input, [
    "expiresAt",
    "material",
    "providerKeyId",
    "providerPrivateKey",
    "request",
    "servedAt",
  ], "invoice-material signed response input");
  if (!source.request || !VERIFIED_REQUESTS.has(source.request)) {
    throw new TypeError("invoice-material response requires the original verified request");
  }
  const material = exactDataRecord(source.material, [
    "addIndex",
    "amountSats",
    "capabilityDigest",
    "fundingAuthorization",
    "invoice",
    "invoiceDigest",
    "invoiceState",
    "paymentHash",
    "paymentSecretKeyId",
    "requestDigest",
    "requestId",
    "schema",
    "selectedOfferId",
    "settlementAuthorization",
  ], "invoice-material core result");
  for (const field of [
    "requestId",
    "requestDigest",
    "capabilityDigest",
    "selectedOfferId",
    "amountSats",
    "paymentSecretKeyId",
  ]) {
    if (material[field] !== source.request[field]) {
      throw new Error(`invoice-material core changed ${field}`);
    }
  }
  if (material.fundingAuthorization !== false || material.settlementAuthorization !== false) {
    throw new Error("invoice-material core result gained authority");
  }
  const servedAt = integer(source.servedAt, "invoice-material response servedAt", 1);
  const expiresAt = integer(
    source.expiresAt,
    "invoice-material response expiresAt",
    servedAt + 1,
    source.request.expiresAt,
  );
  const unsigned = normalizeResponse({
    schema: SELECTED_SOLVER_INVOICE_MATERIAL_RESPONSE_SCHEMA,
    requestId: material.requestId,
    requestDigest: material.requestDigest,
    capabilityDigest: material.capabilityDigest,
    selectedOfferId: material.selectedOfferId,
    amountSats: material.amountSats,
    materialDigest: source.request.materialDigest,
    paymentSecretKeyId: material.paymentSecretKeyId,
    paymentHash: material.paymentHash,
    invoice: material.invoice,
    invoiceDigest: material.invoiceDigest,
    invoiceState: material.invoiceState,
    addIndex: material.addIndex,
    providerKeyId: source.providerKeyId,
    servedAt,
    expiresAt,
    signature: "",
  });
  const response = Object.freeze({
    ...unsignedResponse(unsigned),
    signature: signMessage(
      null,
      responseMessage(unsignedResponse(unsigned)),
      privateKey(source.providerPrivateKey, "invoice-material provider private key"),
    ).toString("base64"),
  });
  return normalizeResponse(response);
}

export function verifySelectedSolverInvoiceMaterialResponse(input) {
  const source = exactDataRecord(input, [
    "expectedProviderKeyId",
    "now",
    "providerPublicKey",
    "request",
    "response",
  ], "invoice-material response verification");
  const request = normalizePayload(source.request);
  const response = normalizeResponse(source.response);
  const observedAt = integer(source.now, "invoice-material response verification time", 1);
  if (response.providerKeyId !== keyId(source.expectedProviderKeyId, "expected provider key ID")
      || response.servedAt > observedAt + 5
      || response.expiresAt <= observedAt || response.expiresAt > request.expiresAt) {
    throw new Error("invoice-material response is outside its authority window");
  }
  for (const field of [
    "requestId",
    "requestDigest",
    "capabilityDigest",
    "selectedOfferId",
    "amountSats",
    "materialDigest",
    "paymentSecretKeyId",
  ]) {
    if (response[field] !== request[field]) throw new Error(`invoice-material response changed ${field}`);
  }
  if (!verifyMessage(
    null,
    responseMessage(unsignedResponse(response)),
    publicKey(source.providerPublicKey, "invoice-material provider public key"),
    signature(response.signature, "invoice-material response signature"),
  )) throw new Error("invoice-material response signature is invalid");
  VERIFIED_RESPONSES.add(response);
  return response;
}

function endpointUrl(origin) {
  let url;
  try {
    url = new URL(String(origin ?? ""));
  } catch {
    throw new Error("invoice-material route must use an isolated private HTTPS origin on port 443");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "") || !isPrivateLndHostname(url.hostname)) {
    throw new Error("invoice-material route must use an isolated private HTTPS origin on port 443");
  }
  return new URL("/v1/invoice-material", url);
}

export async function fixedSelectedSolverInvoiceMaterialHttpsRequest(endpoint, options, {
  expectedCertificateFingerprint,
  httpsRequestImpl = httpsRequest,
  lookupImpl,
  providerCertificate,
} = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("invoice-material TLS certificate verification is disabled");
  }
  const requestUrl = new URL(endpoint);
  const expected = endpointUrl(requestUrl.origin);
  if (requestUrl.href !== expected.href || options?.method !== "POST"
      || options?.redirect !== "error" || typeof options?.body !== "string") {
    throw new Error("invoice-material fixed HTTPS request is invalid");
  }
  const hostname = requestUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (typeof providerCertificate !== "string" || !providerCertificate.includes("BEGIN CERTIFICATE")
      || typeof expectedCertificateFingerprint !== "string") {
    throw new Error("invoice-material fixed HTTPS request requires its pinned certificate");
  }
  let configuredFingerprint;
  try {
    configuredFingerprint = new X509Certificate(providerCertificate).fingerprint256;
  } catch {
    throw new Error("invoice-material provider certificate is invalid");
  }
  if (configuredFingerprint !== expectedCertificateFingerprint.toUpperCase()) {
    throw new Error("invoice-material provider certificate fingerprint changed");
  }
  const target = lookupImpl === undefined
    ? await resolvePinnedPrivateAddress(hostname)
    : await resolvePinnedPrivateAddress(hostname, lookupImpl);
  const body = options.body;
  return new Promise((resolve, reject) => {
    const request = httpsRequestImpl({
      protocol: "https:",
      hostname: target.address,
      family: target.family,
      port: 443,
      servername: privateHttpsServername(hostname),
      method: "POST",
      path: expected.pathname,
      agent: false,
      rejectUnauthorized: true,
      ca: providerCertificate,
      signal: options.signal,
      checkServerIdentity: (servername, certificate) => {
        const hostnameError = checkServerIdentity(servername, certificate);
        if (hostnameError) return hostnameError;
        const observed = new X509Certificate(certificate.raw).fingerprint256;
        return observed === configuredFingerprint
          ? undefined : new Error("invoice-material TLS peer fingerprint changed");
      },
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

async function sendAttempt(context, attempt, attemptContext) {
  const endpoint = endpointUrl(context.endpointOrigin);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, context.signal]);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("invoice-material request timed out"));
    }, context.timeoutMs);
  });
  try {
    let response;
    try {
      response = await Promise.race([
        context.requestImpl(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json",
          },
          body: attemptContext.requestJson,
          signal,
        }),
        deadline,
      ]);
    } catch {
      throw new SelectedSolverInvoiceMaterialTransportError(
        "invoice-material transport failed",
        { ambiguous: true, code: "TRANSPORT_AMBIGUOUS" },
      );
    }
    if (response?.redirected === true || (response?.status !== 200
        && response?.status !== 400 && response?.status !== 425 && response?.status !== 503)) {
      await discardPrivateResponseBody(response);
      throw new SelectedSolverInvoiceMaterialTransportError(
        "invoice-material route returned an unsupported response",
        { ambiguous: true, code: "RESPONSE_AMBIGUOUS" },
      );
    }
    if (response.status !== 200) {
      await discardPrivateResponseBody(response);
      throw new SelectedSolverInvoiceMaterialTransportError(
        response.status === 400 ? "invoice-material request was rejected" : "invoice-material recovery required",
        {
          ambiguous: response.status !== 400,
          code: response.status === 400 ? "REQUEST_REJECTED" : "RECOVERY_REQUIRED",
        },
      );
    }
    let raw;
    try {
      raw = await Promise.race([
        readStrictPrivateJsonResponse(response, {
          label: "invoice-material response",
          maximumResponseBytes: MAX_RESPONSE_BYTES,
          signal,
        }),
        deadline,
      ]);
    } catch {
      throw new SelectedSolverInvoiceMaterialTransportError(
        "invoice-material response was unreadable",
        { ambiguous: true, code: "RESPONSE_AMBIGUOUS" },
      );
    }
    try {
      return verifySelectedSolverInvoiceMaterialResponse({
        response: raw,
        request: attemptContext.request.payload,
        providerPublicKey: context.providerPublicKey,
        expectedProviderKeyId: context.providerKeyId,
        now: integer(context.nowSeconds(), "invoice-material client response time", 1),
      });
    } catch {
      throw new SelectedSolverInvoiceMaterialTransportError(
        "invoice-material response authentication failed",
        { ambiguous: true, code: "RESPONSE_AUTHENTICATION_AMBIGUOUS" },
      );
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function createClient(input, mode) {
  const expected = mode === "production" ? CLIENT_KEYS : TEST_CLIENT_KEYS;
  const source = exactDataRecord(input, expected, "invoice-material client");
  const context = {
    mode,
    endpointOrigin: endpointUrl(source.endpointOrigin).origin,
    paymentSecretKeyId: keyId(source.paymentSecretKeyId, "invoice-material payment-secret key ID"),
    providerKeyId: keyId(source.providerKeyId, "invoice-material provider key ID"),
    providerPublicKey: publicKey(source.providerPublicKey, "invoice-material provider public key"),
    requesterKeyId: keyId(source.requesterKeyId, "invoice-material requester key ID"),
    requesterPrivateKey: privateKey(source.requesterPrivateKey, "invoice-material requester private key"),
    requestTtlSeconds: integer(source.requestTtlSeconds, "invoice-material request TTL", 1, 30),
    timeoutMs: integer(source.timeoutMs, "invoice-material request timeout", 100, 10_000),
    signal: source.signal,
    nowSeconds: mode === "production" ? () => Math.floor(DATE_NOW() / 1_000) : source.nowSeconds,
    requestImpl: mode === "production"
      ? (endpoint, options) => fixedSelectedSolverInvoiceMaterialHttpsRequest(endpoint, options, {
        providerCertificate: source.providerCertificate,
        expectedCertificateFingerprint: source.expectedCertificateFingerprint,
      })
      : source.requestImpl,
    state: "active",
  };
  if (!(context.signal instanceof AbortSignal) || context.signal.aborted
      || typeof context.nowSeconds !== "function" || typeof context.requestImpl !== "function") {
    throw new TypeError("invoice-material client dependencies are invalid");
  }
  if (mode === "production") {
    let fingerprint;
    try {
      fingerprint = new X509Certificate(source.providerCertificate).fingerprint256;
    } catch {
      throw new TypeError("invoice-material provider certificate is invalid");
    }
    if (typeof source.expectedCertificateFingerprint !== "string"
        || fingerprint !== source.expectedCertificateFingerprint.toUpperCase()) {
      throw new Error("invoice-material provider certificate pin changed");
    }
  }
  const stop = () => { context.state = "stopped"; };
  context.signal.addEventListener("abort", stop, { once: true });
  const client = Object.freeze({
    prepare(value) {
      if (this !== client || CLIENTS.get(this) !== context || context.state !== "active") {
        throw new TypeError("invoice-material client lacks active factory provenance");
      }
      const request = exactDataRecord(value, PREPARE_KEYS, "invoice-material client preparation");
      const requestedAt = integer(context.nowSeconds(), "invoice-material client request time", 1);
      const authorizationExpiresAt = integer(
        request.authorizationExpiresAt,
        "invoice-material client authorization expiry",
        requestedAt + 1,
      );
      const expiresAt = Math.min(requestedAt + context.requestTtlSeconds, authorizationExpiresAt);
      const envelope = buildSignedSelectedSolverInvoiceMaterialRequest({
        ...request,
        authorizationExpiresAt,
        paymentSecretKeyId: context.paymentSecretKeyId,
        requesterKeyId: context.requesterKeyId,
        requestedAt,
        expiresAt,
        requesterPrivateKey: context.requesterPrivateKey,
      });
      const attempt = Object.freeze({
        schema: "treeswap.selected-solver-invoice-material-attempt.v1",
        requestId: envelope.payload.requestId,
        requestDigest: envelope.payload.requestDigest,
        materialDigest: envelope.payload.materialDigest,
        paymentSecretKeyId: context.paymentSecretKeyId,
        expiresAt,
        fundingAuthorization: false,
        settlementAuthorization: false,
      });
      ATTEMPTS.set(attempt, {
        client,
        inFlight: false,
        request: envelope,
        requestJson: JSON.stringify(envelope),
        result: null,
      });
      return attempt;
    },
    async send(attempt) {
      if (this !== client || CLIENTS.get(this) !== context || context.state !== "active") {
        throw new TypeError("invoice-material client lacks active factory provenance");
      }
      const attemptContext = ATTEMPTS.get(attempt);
      if (!attemptContext || attemptContext.client !== client) {
        throw new TypeError("invoice-material send requires the original prepared attempt");
      }
      if (attemptContext.result) return attemptContext.result;
      if (attemptContext.inFlight) throw new Error("invoice-material request is already in flight");
      if (attempt.expiresAt <= integer(context.nowSeconds(), "invoice-material client time", 1)) {
        throw new SelectedSolverInvoiceMaterialTransportError(
          "invoice-material request expired",
          { ambiguous: false, code: "REQUEST_EXPIRED" },
        );
      }
      attemptContext.inFlight = true;
      try {
        const result = await sendAttempt(context, attempt, attemptContext);
        attemptContext.result = result;
        return result;
      } finally {
        attemptContext.inFlight = false;
      }
    },
    status() {
      if (this !== client || CLIENTS.get(this) !== context) {
        throw new TypeError("invoice-material client lacks factory provenance");
      }
      return Object.freeze({
        schema: "treeswap.selected-solver-invoice-material-client-status.v1",
        state: context.state,
        mode: context.mode,
        authenticated: true,
        encrypted: true,
        networkListener: false,
        fundingAuthorization: false,
        settlementAuthorization: false,
      });
    },
  });
  CLIENTS.set(client, context);
  return client;
}

export function createSelectedSolverInvoiceMaterialClient(input) {
  return createClient(input, "production");
}

export function createTestSelectedSolverInvoiceMaterialClient(input) {
  return createClient(input, "injected-test");
}

export function selectedSolverInvoiceMaterialClientMode(value) {
  const context = CLIENTS.get(value);
  if (!context) throw new TypeError("invoice-material client lacks factory provenance");
  return context.mode;
}

export function assertSelectedSolverInvoiceMaterialClientLifecycle(value, signal) {
  const context = CLIENTS.get(value);
  if (!context) throw new TypeError("invoice-material client lacks factory provenance");
  if (signal !== context.signal || signal.aborted || context.state !== "active") {
    throw new TypeError("invoice-material client and consumer must share one active lifecycle");
  }
  return value;
}

export function verifiedSelectedSolverInvoiceMaterialResponse(value) {
  if (!value || !VERIFIED_RESPONSES.has(value)) {
    throw new TypeError("invoice-material response provenance is invalid");
  }
  return value;
}

export class SelectedSolverInvoiceMaterialTransportError extends Error {
  constructor(message, { ambiguous, code }) {
    super(message);
    this.name = "SelectedSolverInvoiceMaterialTransportError";
    this.ambiguous = ambiguous === true;
    this.code = String(code ?? "UNKNOWN");
  }
}
