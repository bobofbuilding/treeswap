import { randomBytes } from "node:crypto";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { TextDecoder as NodeTextDecoder } from "node:util";
import {
  getAddress,
  id,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
} from "ethers";
import {
  isProductionClientSafeBlindQuoteSession,
  isClientSafeBlindQuoteSession,
} from "./blind-quote-preview.mjs";
import { assertPublicPricingRequest } from "./privacy.mjs";
import { rfqDeliveryPayloadDigest } from "./rfq-delivery.mjs";
import {
  isRfqQuoteIngressStore,
  rfqQuoteIngressSelectionBinding,
  rfqQuoteIngressStoreBinding,
} from "./rfq-quote-ingress-store.mjs";
import {
  claimRfqQuoteIngressReaderOwnership,
  createRfqQuoteIngressReader,
  createTestRfqQuoteIngressReader,
  createTestRfqQuoteIngressServiceReader,
  isRfqQuoteIngressReader,
  rfqQuoteIngressReaderMode,
} from "./rfq-quote-ingress-reader.mjs";

export {
  createRfqQuoteIngressReader,
  createTestRfqQuoteIngressReader,
  createTestRfqQuoteIngressServiceReader,
  isRfqQuoteIngressReader,
};

function frozenFields(fields) {
  return Object.freeze(fields.map((field) => Object.freeze(field)));
}

const QUOTE_AUTHORIZATION_FIELDS = frozenFields([
  { name: "pricingId", type: "bytes32" },
  { name: "pricingDigest", type: "bytes32" },
  { name: "direction", type: "bytes32" },
  { name: "user", type: "address" },
  { name: "requestNonce", type: "uint256" },
  { name: "requestExpiresAt", type: "uint64" },
  { name: "authorizationExpiresAt", type: "uint64" },
  { name: "clientOriginDigest", type: "bytes32" },
]);

export const RFQ_QUOTE_AUTHORIZATION_TYPES = Object.freeze({
  QuoteRequestAuthorization: QUOTE_AUTHORIZATION_FIELDS,
});

const DATE_NOW = Date.now.bind(Date);
const LOWER_BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-f]{128}(?:1b|1c)$/i;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const PUBLIC_PRICING_FIELDS = Object.freeze([
  "capacityEpoch", "chainId", "direction", "exactOutput", "expiresAt", "maxFeeBps",
  "maxRoutingFeeSats", "outputUnit", "pricingId",
]);
const AUTHORIZATION_FIELDS = Object.freeze(QUOTE_AUTHORIZATION_FIELDS.map(({ name }) => name));
const CREATE_BODY_FIELDS = Object.freeze(["authorization", "pricing", "signature"]);
const SELECT_BODY_FIELDS = Object.freeze(["choiceId", "sessionToken"]);
const ROUTE_FIELDS = Object.freeze(["policy", "quoteReader", "replayStore", "signal"]);
const TEST_ROUTE_FIELDS = Object.freeze([
  "nowSeconds", "policy", "quoteReader", "randomBytesImpl", "replayStore", "signal",
]);
const POLICY_FIELDS = Object.freeze([
  "apiOrigin",
  "bitToLightningContract",
  "chainId",
  "clientOrigin",
  "lightningToBitContract",
  "maximumActiveSessionsPerIdentity",
  "maximumAuthorizationTtlSeconds",
  "maximumExactBitOutputWei",
  "maximumExactLightningOutputSats",
  "maximumFeeBps",
  "maximumLiveRequests",
  "maximumProcessingMilliseconds",
  "maximumRequestBytes",
  "maximumRequestLifetimeSeconds",
  "maximumResponseBytes",
  "maximumRequestsPerIdentityWindow",
  "maximumRequestsPerWindowGlobal",
  "maximumRoutingFeeSats",
  "minimumExactBitOutputWei",
  "minimumExactLightningOutputSats",
  "quotaWindowSeconds",
]);
const ROUTES = new WeakMap();
const BOUND_READERS = new WeakSet();

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

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function uint(value, name, maximum) {
  const raw = String(value ?? "");
  if (!DECIMAL.test(raw) || raw.length > maximum.toString().length) {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
  const parsed = BigInt(raw);
  if (parsed > maximum) throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  return parsed;
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!LOWER_BYTES32.test(raw)) throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  return raw;
}

function address(value, name) {
  try {
    const normalized = getAddress(value);
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function origin(value, name) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    throw new TypeError(`${name} must be a canonical HTTPS origin`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || (parsed.port && parsed.port !== "443") || parsed.pathname !== "/"
      || parsed.search || parsed.hash || String(value) !== parsed.origin) {
    throw new TypeError(`${name} must be a canonical HTTPS origin`);
  }
  return parsed.origin;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function normalizedPolicy(input) {
  const raw = exactDataRecord(input, POLICY_FIELDS, "RFQ quote ingress policy");
  const policy = Object.freeze({
    apiOrigin: origin(raw.apiOrigin, "RFQ quote ingress API origin"),
    bitToLightningContract: address(raw.bitToLightningContract, "RFQ quote ingress BIT-to-Lightning contract"),
    chainId: integer(raw.chainId, "RFQ quote ingress chain ID", 1),
    clientOrigin: origin(raw.clientOrigin, "RFQ quote ingress client origin"),
    lightningToBitContract: address(raw.lightningToBitContract, "RFQ quote ingress Lightning-to-BIT contract"),
    maximumActiveSessionsPerIdentity: integer(
      raw.maximumActiveSessionsPerIdentity,
      "RFQ quote ingress maximum active sessions per identity",
      1,
      20,
    ),
    maximumAuthorizationTtlSeconds: integer(
      raw.maximumAuthorizationTtlSeconds,
      "RFQ quote ingress authorization lifetime",
      1,
      120,
    ),
    maximumExactBitOutputWei: uint(raw.maximumExactBitOutputWei, "maximum exact BIT output", UINT256_MAX).toString(),
    maximumExactLightningOutputSats: uint(
      raw.maximumExactLightningOutputSats,
      "maximum exact Lightning output",
      UINT64_MAX,
    ).toString(),
    maximumFeeBps: integer(raw.maximumFeeBps, "RFQ quote ingress maximum fee", 0, 10_000),
    maximumLiveRequests: integer(raw.maximumLiveRequests, "RFQ quote ingress maximum live requests", 1, 4_096),
    maximumProcessingMilliseconds: integer(
      raw.maximumProcessingMilliseconds,
      "RFQ quote ingress processing timeout",
      250,
      30_000,
    ),
    maximumRequestBytes: integer(raw.maximumRequestBytes, "RFQ quote ingress maximum request bytes", 1_024, 65_536),
    maximumRequestLifetimeSeconds: integer(
      raw.maximumRequestLifetimeSeconds,
      "RFQ quote ingress request lifetime",
      1,
      300,
    ),
    maximumResponseBytes: integer(raw.maximumResponseBytes, "RFQ quote ingress maximum response bytes", 4_096, 1_048_576),
    maximumRequestsPerIdentityWindow: integer(
      raw.maximumRequestsPerIdentityWindow,
      "RFQ quote ingress identity request quota",
      1,
      1_000,
    ),
    maximumRequestsPerWindowGlobal: integer(
      raw.maximumRequestsPerWindowGlobal,
      "RFQ quote ingress global request quota",
      1,
      100_000,
    ),
    maximumRoutingFeeSats: uint(raw.maximumRoutingFeeSats, "maximum RFQ routing fee", UINT64_MAX).toString(),
    minimumExactBitOutputWei: uint(raw.minimumExactBitOutputWei, "minimum exact BIT output", UINT256_MAX).toString(),
    minimumExactLightningOutputSats: uint(
      raw.minimumExactLightningOutputSats,
      "minimum exact Lightning output",
      UINT64_MAX,
    ).toString(),
    quotaWindowSeconds: integer(raw.quotaWindowSeconds, "RFQ quote ingress quota window", 1, 86_400),
  });
  if (policy.apiOrigin === policy.clientOrigin) {
    throw new Error("RFQ quote ingress API and browser origins must be separated");
  }
  if (policy.lightningToBitContract.toLowerCase() === policy.bitToLightningContract.toLowerCase()) {
    throw new Error("RFQ quote ingress settlement contracts must be direction-specific");
  }
  if (BigInt(policy.minimumExactBitOutputWei) === 0n
      || BigInt(policy.maximumExactBitOutputWei) < BigInt(policy.minimumExactBitOutputWei)
      || BigInt(policy.minimumExactLightningOutputSats) === 0n
      || BigInt(policy.maximumExactLightningOutputSats) < BigInt(policy.minimumExactLightningOutputSats)) {
    throw new RangeError("RFQ quote ingress exact-output bounds are invalid");
  }
  if (policy.maximumRequestsPerWindowGlobal < policy.maximumRequestsPerIdentityWindow) {
    throw new RangeError("RFQ quote ingress global request quota is below one identity quota");
  }
  return policy;
}

export function rfqQuoteIngressPolicyDigest(policy) {
  return keccak256(toUtf8Bytes(canonicalize(normalizedPolicy(policy))));
}

function publicPricing(input) {
  const raw = exactDataRecord(input, PUBLIC_PRICING_FIELDS, "RFQ quote ingress public pricing");
  const pricing = Object.freeze({
    pricingId: bytes32(raw.pricingId, "RFQ quote ingress pricing ID"),
    direction: raw.direction,
    chainId: integer(raw.chainId, "RFQ quote ingress pricing chain ID", 1),
    exactOutput: uint(raw.exactOutput, "RFQ quote ingress exact output", UINT256_MAX).toString(),
    outputUnit: raw.outputUnit,
    maxFeeBps: uint(raw.maxFeeBps, "RFQ quote ingress maximum fee", 10_000n).toString(),
    maxRoutingFeeSats: uint(raw.maxRoutingFeeSats, "RFQ quote ingress maximum routing fee", UINT64_MAX).toString(),
    capacityEpoch: integer(raw.capacityEpoch, "RFQ quote ingress minimum capacity epoch"),
    expiresAt: integer(raw.expiresAt, "RFQ quote ingress pricing expiry", 1),
  });
  assertPublicPricingRequest(pricing);
  return pricing;
}

function assertPricingPolicy(pricing, policy, now) {
  if (pricing.chainId !== policy.chainId) throw new Error("RFQ quote ingress pricing chain is unsupported");
  if (pricing.expiresAt <= now || pricing.expiresAt - now > policy.maximumRequestLifetimeSeconds) {
    throw new Error("RFQ quote ingress pricing expiry is outside policy");
  }
  if (BigInt(pricing.maxFeeBps) > BigInt(policy.maximumFeeBps)
      || BigInt(pricing.maxRoutingFeeSats) > BigInt(policy.maximumRoutingFeeSats)) {
    throw new Error("RFQ quote ingress pricing caps exceed policy");
  }
  if (pricing.direction === "lightning-to-bit") {
    if (BigInt(pricing.exactOutput) < BigInt(policy.minimumExactBitOutputWei)
        || BigInt(pricing.exactOutput) > BigInt(policy.maximumExactBitOutputWei)) {
      throw new Error("RFQ quote ingress BIT output is outside policy");
    }
  } else if (BigInt(pricing.exactOutput) < BigInt(policy.minimumExactLightningOutputSats)
      || BigInt(pricing.exactOutput) > BigInt(policy.maximumExactLightningOutputSats)) {
    throw new Error("RFQ quote ingress Lightning output is outside policy");
  }
}

function settlementContract(pricing, policy) {
  return pricing.direction === "lightning-to-bit"
    ? policy.lightningToBitContract
    : policy.bitToLightningContract;
}

export function rfqQuoteAuthorizationDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Quote Request",
    version: "1",
    chainId: uint(chainId, "RFQ quote authorization chain ID", UINT256_MAX),
    verifyingContract: address(verifyingContract, "RFQ quote authorization verifying contract"),
  });
}

function authorizationMaterial({ pricing: pricingInput, user, requestNonce, authorizationExpiresAt, policy }) {
  const boundPolicy = normalizedPolicy(policy);
  const pricing = publicPricing(pricingInput);
  const normalizedUser = address(user, "RFQ quote authorization user");
  const nonce = uint(requestNonce, "RFQ quote authorization nonce", UINT256_MAX).toString();
  const expiresAt = integer(authorizationExpiresAt, "RFQ quote authorization expiry", 1);
  const domain = rfqQuoteAuthorizationDomain({
    chainId: pricing.chainId,
    verifyingContract: settlementContract(pricing, boundPolicy),
  });
  const message = Object.freeze({
    pricingId: pricing.pricingId,
    pricingDigest: rfqDeliveryPayloadDigest(pricing),
    direction: id(pricing.direction),
    user: normalizedUser,
    requestNonce: nonce,
    requestExpiresAt: pricing.expiresAt,
    authorizationExpiresAt: expiresAt,
    clientOriginDigest: keccak256(toUtf8Bytes(boundPolicy.clientOrigin)),
  });
  return Object.freeze({
    domain,
    types: RFQ_QUOTE_AUTHORIZATION_TYPES,
    message,
    digest: TypedDataEncoder.hash(domain, RFQ_QUOTE_AUTHORIZATION_TYPES, message),
  });
}

export function buildRfqQuoteAuthorization(input) {
  const source = exactDataRecord(
    input,
    ["authorizationExpiresAt", "policy", "pricing", "requestNonce", "user"],
    "RFQ quote authorization input",
  );
  return authorizationMaterial(source);
}

function verifiedAuthorization({ pricing, authorization: authorizationInput, signature, policy, now }) {
  const authorization = exactDataRecord(
    authorizationInput,
    AUTHORIZATION_FIELDS,
    "RFQ quote authorization",
  );
  const material = authorizationMaterial({
    pricing,
    user: authorization.user,
    requestNonce: authorization.requestNonce,
    authorizationExpiresAt: authorization.authorizationExpiresAt,
    policy,
  });
  const observedAt = integer(now, "RFQ quote authorization verification time", 1);
  const policyBound = normalizedPolicy(policy);
  if (material.message.authorizationExpiresAt <= observedAt
      || material.message.authorizationExpiresAt > material.message.requestExpiresAt
      || material.message.authorizationExpiresAt - observedAt > policyBound.maximumAuthorizationTtlSeconds) {
    throw new Error("RFQ quote authorization expiry is outside policy");
  }
  const actualDigest = TypedDataEncoder.hash(
    material.domain,
    RFQ_QUOTE_AUTHORIZATION_TYPES,
    authorization,
  );
  if (actualDigest !== material.digest) throw new Error("RFQ quote authorization changed exact pricing terms");
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
    throw new Error("RFQ quote authorization signature is invalid");
  }
  let signer;
  try {
    signer = verifyTypedData(material.domain, RFQ_QUOTE_AUTHORIZATION_TYPES, authorization, signature);
  } catch {
    throw new Error("RFQ quote authorization signature is invalid");
  }
  if (getAddress(signer) !== getAddress(material.message.user)) {
    throw new Error("RFQ quote authorization signer does not match the user");
  }
  return Object.freeze({
    authorizationDigest: material.digest,
    authorizationExpiresAt: material.message.authorizationExpiresAt,
    requestNonce: material.message.requestNonce,
    user: material.message.user,
  });
}

function randomToken(randomBytesImpl) {
  const value = randomBytesImpl(32);
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("RFQ quote ingress entropy must return exactly 32 bytes");
  }
  return bytes32(`0x${Buffer.from(value).toString("hex")}`, "RFQ quote ingress generated token");
}

function response(status, body, maximumBytes, clientOrigin) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  if (bytes.length > maximumBytes) throw new RangeError("RFQ quote ingress response exceeds policy");
  return new Response(bytes, {
    status,
    headers: {
      "access-control-allow-origin": clientOrigin,
      "cache-control": "no-store",
      "content-length": String(bytes.length),
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "content-type": "application/json",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
      vary: "Origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex",
    },
  });
}

function rejectedResponse(policy) {
  return response(400, { error: "quote request rejected" }, policy.maximumResponseBytes, policy.clientOrigin);
}

function preflightResponse(request, policy) {
  const requestedMethod = request.headers.get("access-control-request-method");
  const requestedHeaders = String(request.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (requestedMethod !== "POST"
      || requestedHeaders.length !== 2
      || requestedHeaders[0] !== "cache-control"
      || requestedHeaders[1] !== "content-type"
      || request.headers.get("access-control-request-private-network") !== null
      || request.headers.get("authorization") !== null
      || request.headers.get("cookie") !== null
      || request.body !== null) {
    throw new Error("RFQ quote ingress preflight is invalid");
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-headers": "cache-control, content-type",
      "access-control-allow-methods": "POST",
      "access-control-allow-origin": policy.clientOrigin,
      "cache-control": "no-store",
      "content-length": "0",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
      vary: "Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex",
    },
  });
}

async function strictRequestJson(request, maximumBytes, signal) {
  const rawType = String(request.headers.get("content-type") ?? "");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(rawType)) {
    throw new Error("RFQ quote ingress content type is invalid");
  }
  const cacheControl = String(request.headers.get("cache-control") ?? "").toLowerCase();
  if (!cacheControl.split(",").some((item) => item.trim() === "no-store")) {
    throw new Error("RFQ quote ingress request must disable storage");
  }
  const contentEncoding = String(request.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (contentEncoding !== "identity" || request.headers.get("transfer-encoding") !== null) {
    throw new Error("RFQ quote ingress request framing is unsupported");
  }
  if (request.headers.get("authorization") !== null || request.headers.get("cookie") !== null) {
    throw new Error("RFQ quote ingress request carries unsupported ambient credentials");
  }
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader === null || !/^[1-9][0-9]*$/.test(declaredHeader)) {
    throw new Error("RFQ quote ingress content length is invalid");
  }
  const declared = Number(declaredHeader);
  if (!Number.isSafeInteger(declared) || declared > maximumBytes) {
    throw new Error("RFQ quote ingress request is too large");
  }
  if (!request.body) throw new Error("RFQ quote ingress request body is empty");
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const frame = await reader.read();
      if (frame.done) break;
      if (!(frame.value instanceof Uint8Array)) throw new Error("RFQ quote ingress body chunk is invalid");
      received += frame.value.byteLength;
      if (received > maximumBytes || received > declared) {
        await reader.cancel();
        throw new Error("RFQ quote ingress request is too large");
      }
      chunks.push(Buffer.from(frame.value));
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (signal.aborted || received !== declared) throw new Error("RFQ quote ingress request length changed");
  const bytes = Buffer.concat(chunks);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("RFQ quote ingress request contains a forbidden UTF-8 byte order mark");
  }
  let text;
  try {
    text = new NodeTextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("RFQ quote ingress request is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("RFQ quote ingress request contains malformed JSON");
  }
}

function assertPreviewMatches(preview, pricing, policy, now) {
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    throw new TypeError("RFQ quote ingress preview is invalid");
  }
  if (preview.schema !== "treeswap.client-safe-blind-quote-set.v1"
      || preview.pricingId !== pricing.pricingId
      || preview.pricingDigest !== rfqDeliveryPayloadDigest(pricing)
      || preview.direction !== pricing.direction
      || preview.exactOutput !== pricing.exactOutput
      || preview.outputUnit !== pricing.outputUnit
      || !Number.isSafeInteger(preview.expiresAt)
      || preview.expiresAt <= now
      || preview.expiresAt > pricing.expiresAt
      || !Number.isSafeInteger(preview.quoteCount)
      || preview.quoteCount < 2
      || preview.quoteCount > 128
      || !LOWER_BYTES32.test(String(preview.receivedSetDigest ?? ""))
      || !LOWER_BYTES32.test(String(preview.marketRiskPolicyDigest ?? ""))) {
    throw new Error("RFQ quote ingress preview changed authenticated pricing or provenance");
  }
  const encoded = Buffer.byteLength(JSON.stringify(preview), "utf8");
  if (encoded > policy.maximumResponseBytes) throw new RangeError("RFQ quote ingress preview exceeds response policy");
}

function storeMatchesPolicy(store, policy, digest) {
  const binding = rfqQuoteIngressStoreBinding(store);
  return binding.policyDigest === digest
    && binding.maximumActiveSessionsPerIdentity === policy.maximumActiveSessionsPerIdentity
    && binding.maximumLiveRequests === policy.maximumLiveRequests
    && binding.maximumRequestLifetimeSeconds === policy.maximumRequestLifetimeSeconds
    && binding.maximumRequestsPerIdentityWindow === policy.maximumRequestsPerIdentityWindow
    && binding.maximumRequestsPerWindowGlobal === policy.maximumRequestsPerWindowGlobal
    && binding.quotaWindowSeconds === policy.quotaWindowSeconds;
}

function createRoute(input, expectedMode, { nowSeconds, randomBytesImpl }) {
  const source = exactDataRecord(input, ROUTE_FIELDS, "RFQ quote ingress route input");
  const policy = normalizedPolicy(source.policy);
  const policyDigest = rfqQuoteIngressPolicyDigest(policy);
  if (!isRfqQuoteIngressStore(source.replayStore) || !storeMatchesPolicy(source.replayStore, policy, policyDigest)) {
    throw new TypeError("RFQ quote ingress route requires the exact policy-bound durable store");
  }
  if (!isRfqQuoteIngressReader(source.quoteReader)
      || rfqQuoteIngressReaderMode(source.quoteReader) !== expectedMode) {
    throw new TypeError("RFQ quote ingress route requires a matching factory-created quote reader");
  }
  if (BOUND_READERS.has(source.quoteReader)) throw new TypeError("RFQ quote ingress reader is already bound");
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("RFQ quote ingress route requires an active deployment AbortSignal");
  }
  const deploymentSignal = source.signal;
  const replayStore = source.replayStore;
  const quoteReader = source.quoteReader;
  const quoteReaderLease = claimRfqQuoteIngressReaderOwnership(quoteReader, deploymentSignal);
  const lifecycle = new AbortController();
  const sessions = new Map();
  const context = {
    accepted: 0,
    completedSelections: 0,
    failed: 0,
    inFlight: 0,
    lifecycle,
    mode: expectedMode,
    policy,
    replayStore,
    sessions,
    started: 0,
    state: "active",
  };

  const cleanupSessions = (now) => {
    for (const [key, record] of sessions) {
      if (record.expiresAt <= now) {
        if (record.state === "ready") {
          try { record.session.close(); } catch {}
        }
        sessions.delete(key);
      }
    }
  };

  const stop = () => {
    if (context.state === "stopped") return;
    context.state = "stopped";
    lifecycle.abort();
    try { quoteReaderLease.close(); } catch {}
    for (const record of sessions.values()) {
      if (record.state === "ready") {
        try { record.session.close(); } catch {}
      }
    }
    sessions.clear();
    deploymentSignal.removeEventListener("abort", stop);
  };
  deploymentSignal.addEventListener("abort", stop, { once: true });

  const handleCreate = async (body, signal) => {
    const sourceBody = exactDataRecord(body, CREATE_BODY_FIELDS, "RFQ quote ingress create body");
    const pricing = publicPricing(sourceBody.pricing);
    const verifiedAt = integer(nowSeconds(), "RFQ quote ingress verification time", 1);
    replayStore.observeTime({ now: verifiedAt });
    assertPricingPolicy(pricing, policy, verifiedAt);
    const authorization = verifiedAuthorization({
      pricing,
      authorization: sourceBody.authorization,
      signature: sourceBody.signature,
      policy,
      now: verifiedAt,
    });
    const requestDigest = rfqDeliveryPayloadDigest(pricing);
    const claim = replayStore.claim({
      authorizationDigest: authorization.authorizationDigest,
      expiresAt: pricing.expiresAt,
      identity: authorization.user,
      now: verifiedAt,
      requestDigest,
      requestId: pricing.pricingId,
      requestNonce: authorization.requestNonce,
    });
    if (!claim) throw new Error("RFQ quote ingress request was already claimed");
    const session = await quoteReaderLease.read({ pricing, signal });
    const validSession = expectedMode === "production"
      ? isProductionClientSafeBlindQuoteSession(session)
      : isClientSafeBlindQuoteSession(session) && !isProductionClientSafeBlindQuoteSession(session);
    if (!validSession) {
      if (isClientSafeBlindQuoteSession(session)) {
        try { session.close(); } catch {}
      }
      throw new TypeError("RFQ quote ingress reader returned an invalid preview session");
    }
    const preview = session.preview();
    const completedAt = integer(nowSeconds(), "RFQ quote ingress completion time", 1);
    replayStore.observeTime({ now: completedAt });
    if (authorization.authorizationExpiresAt <= completedAt || signal.aborted) {
      session.close();
      throw new Error("RFQ quote ingress authorization expired during collection");
    }
    assertPreviewMatches(preview, pricing, policy, completedAt);
    const sessionToken = randomToken(randomBytesImpl);
    const ready = replayStore.ready(claim, {
      expiresAt: preview.expiresAt,
      now: completedAt,
      sessionToken,
    });
    if (!ready) {
      session.close();
      throw new Error("RFQ quote ingress session could not become ready");
    }
    sessions.set(ready.sessionDigest, Object.freeze({
      expiresAt: ready.expiresAt,
      session,
      state: "ready",
    }));
    context.accepted += 1;
    return response(200, Object.freeze({
      schema: "treeswap.rfq-quote-ingress-response.v1",
      sessionToken,
      preview,
      fundingAuthorization: false,
      settlementAuthorization: false,
    }), policy.maximumResponseBytes, policy.clientOrigin);
  };

  const handleSelection = async (body, signal) => {
    const selectedAt = integer(nowSeconds(), "RFQ quote ingress selection time", 1);
    replayStore.observeTime({ now: selectedAt });
    const selectionBody = exactDataRecord(body, SELECT_BODY_FIELDS, "RFQ quote ingress selection body");
    const sessionToken = bytes32(selectionBody.sessionToken, "RFQ quote ingress selection token");
    const choiceId = bytes32(selectionBody.choiceId, "RFQ quote ingress choice ID");
    const claim = replayStore.claimSelection({ now: selectedAt, sessionToken });
    if (!claim || signal.aborted) throw new Error("RFQ quote ingress selection was already claimed");
    const binding = rfqQuoteIngressSelectionBinding(claim);
    if (binding.store !== replayStore) throw new Error("RFQ quote ingress selection store changed");
    const record = sessions.get(binding.sessionDigest);
    if (!record || record.state !== "ready" || record.expiresAt <= selectedAt) {
      throw new Error("RFQ quote ingress in-memory selection provenance is unavailable");
    }
    try {
      const selection = record.session.select({ choiceId });
      sessions.set(binding.sessionDigest, Object.freeze({
        expiresAt: record.expiresAt,
        selection,
        state: "selected",
      }));
    } catch (error) {
      sessions.delete(binding.sessionDigest);
      throw error;
    }
    context.completedSelections += 1;
    return response(200, Object.freeze({
      schema: "treeswap.rfq-quote-selection-ack.v1",
      status: "selected",
      expiresAt: record.expiresAt,
      privateSettlementRequired: true,
      fundingAuthorization: false,
      settlementAuthorization: false,
    }), policy.maximumResponseBytes, policy.clientOrigin);
  };

  const route = Object.freeze({
    async handle(webRequest) {
      if (this !== route || ROUTES.get(this) !== context) {
        throw new TypeError("RFQ quote ingress route lacks factory provenance");
      }
      context.started += 1;
      context.inFlight += 1;
      const controller = new AbortController();
      const abortRequest = () => controller.abort();
      webRequest?.signal?.addEventListener?.("abort", abortRequest, { once: true });
      lifecycle.signal.addEventListener("abort", abortRequest, { once: true });
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setNodeTimeout(() => {
          controller.abort();
          reject(new Error("RFQ quote ingress request timed out"));
        }, policy.maximumProcessingMilliseconds);
      });
      try {
        if (context.state !== "active" || !(webRequest instanceof Request)) {
          throw new Error("RFQ quote ingress request is invalid");
        }
        const url = new URL(webRequest.url);
        if (url.origin !== policy.apiOrigin
            || (url.pathname !== "/v1/quotes" && url.pathname !== "/v1/quotes/select")
            || url.search || url.hash
            || webRequest.headers.get("origin") !== policy.clientOrigin) {
          throw new Error("RFQ quote ingress request target or client origin is invalid");
        }
        if (webRequest.method === "OPTIONS") return preflightResponse(webRequest, policy);
        if (webRequest.method !== "POST") throw new Error("RFQ quote ingress request method is invalid");
        const now = integer(nowSeconds(), "RFQ quote ingress request time", 1);
        replayStore.observeTime({ now });
        cleanupSessions(now);
        const body = await Promise.race([
          strictRequestJson(webRequest, policy.maximumRequestBytes, controller.signal),
          deadline,
        ]);
        const result = url.pathname === "/v1/quotes"
          ? await Promise.race([handleCreate(body, controller.signal), deadline])
          : await Promise.race([handleSelection(body, controller.signal), deadline]);
        return result;
      } catch {
        context.failed += 1;
        return rejectedResponse(policy);
      } finally {
        clearNodeTimeout(timer);
        controller.abort();
        context.inFlight -= 1;
        webRequest?.signal?.removeEventListener?.("abort", abortRequest);
        lifecycle.signal.removeEventListener("abort", abortRequest);
      }
    },
    status() {
      if (this !== route || ROUTES.get(this) !== context) {
        throw new TypeError("RFQ quote ingress route lacks factory provenance");
      }
      const now = integer(nowSeconds(), "RFQ quote ingress status time", 1);
      replayStore.observeTime({ now });
      cleanupSessions(now);
      const storeStatus = replayStore.status({ now });
      let readySessions = 0;
      let selectedSessions = 0;
      for (const record of sessions.values()) {
        if (record.state === "ready") readySessions += 1;
        if (record.state === "selected") selectedSessions += 1;
      }
      return Object.freeze({
        schema: "treeswap.rfq-quote-ingress-status.v1",
        state: context.state,
        mode: context.mode,
        requestsStarted: context.started,
        requestsAccepted: context.accepted,
        requestsRejected: context.failed,
        requestsInFlight: context.inFlight,
        selectionsCompleted: context.completedSelections,
        inMemoryReadySessions: readySessions,
        inMemorySelectedSessions: selectedSessions,
        durableLiveClaimedRequests: storeStatus.liveClaimedRequests,
        durableLiveReadySessions: storeStatus.liveReadySessions,
        fundingAuthorization: false,
        settlementAuthorization: false,
        signingAuthorization: false,
        networkListener: false,
      });
    },
    stop() {
      if (this !== route || ROUTES.get(this) !== context) {
        throw new TypeError("RFQ quote ingress route lacks factory provenance");
      }
      stop();
      return this.status();
    },
  });
  BOUND_READERS.add(quoteReader);
  ROUTES.set(route, context);
  return route;
}

export function createRfqQuoteIngressRoute(input) {
  return createRoute(input, "production", {
    nowSeconds: () => Math.floor(DATE_NOW() / 1_000),
    randomBytesImpl: randomBytes,
  });
}

export function createTestRfqQuoteIngressRoute(input) {
  const source = exactDataRecord(input, TEST_ROUTE_FIELDS, "test RFQ quote ingress route input");
  if (typeof source.nowSeconds !== "function" || typeof source.randomBytesImpl !== "function") {
    throw new TypeError("test RFQ quote ingress route requires injected clock and entropy functions");
  }
  return createRoute(Object.freeze({
    policy: source.policy,
    quoteReader: source.quoteReader,
    replayStore: source.replayStore,
    signal: source.signal,
  }), "injected-test", {
    nowSeconds: source.nowSeconds,
    randomBytesImpl: source.randomBytesImpl,
  });
}

export function isRfqQuoteIngressRoute(value) {
  return Boolean(value && ROUTES.has(value));
}
