import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes as nodeRandomBytes,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import { TextDecoder as NodeTextDecoder } from "node:util";
import { getAddress } from "ethers";
import {
  discardJsonResponseBody,
  readStrictJsonResponse,
} from "./private-json-response.mjs";
import { pinnedPublicWalletSessionRequest } from "./solver-endpoint-transport.mjs";

export const CONTRACT_INTENT_WALLET_SESSION_QUERY = `SELECT
  token_hash AS tokenHash,
  wallet_address AS walletAddress,
  chain_id AS chainId,
  created_at AS createdAt,
  expires_at AS expiresAt
FROM auth_sessions
WHERE token_hash = ? AND expires_at > ?
LIMIT 2`;
export const CONTRACT_INTENT_WALLET_SESSION_REQUEST_SCHEMA =
  "treeswap.contract-intent-wallet-session-request.v1";
export const CONTRACT_INTENT_WALLET_SESSION_RESPONSE_SCHEMA =
  "treeswap.contract-intent-wallet-session-response.v1";

const READ_PATH = "/api/internal/wallet-session-read";
export const CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER =
  "x-treeswap-wallet-session-requester-key-id";
const TOKEN_HASH = /^(?!0{64}$)[0-9a-f]{64}$/;
const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const KEY_ID = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_SESSION_SECONDS = 24 * 60 * 60;
const MAXIMUM_REQUEST_TTL_SECONDS = 5;
const MAXIMUM_CLOCK_SKEW_SECONDS = 2;
const MAXIMUM_REQUEST_BYTES = 4 * 1_024;
const MAXIMUM_RESPONSE_BYTES = 4 * 1_024;
const MAXIMUM_PROCESSING_MILLISECONDS = 5_000;
const MAXIMUM_IN_FLIGHT = 16;
const MAXIMUM_PENDING_READS = 128;
const REQUEST_FIELDS = Object.freeze([
  "expiresAt",
  "issuedAt",
  "observedAt",
  "requestId",
  "requesterKeyId",
  "schema",
  "signature",
  "tokenHash",
]);
const RESPONSE_FIELDS = Object.freeze([
  "active",
  "expiresAt",
  "issuedAt",
  "requestDigest",
  "requestId",
  "responseKeyId",
  "schema",
  "session",
  "signature",
]);
const SESSION_FIELDS = Object.freeze([
  "chainId",
  "createdAt",
  "expiresAt",
  "walletAddress",
]);
const READ_FIELDS = Object.freeze(["observedAt", "tokenHash"]);
const CONSUME_FIELDS = Object.freeze(["observedAt", "tokenHash"]);
const PROVIDERS = new WeakMap();
const READERS = new WeakMap();
const READER_LEASES = new WeakMap();
const VERIFIED_READS = new WeakMap();

export class ContractIntentWalletSessionReaderFatalError extends Error {}

class ProviderStorageError extends Error {}
class ProviderClockError extends Error {}

function exactRecord(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...fields].sort();
  if (keys.some((key) => typeof key !== "string") || keys.length !== expected.length
      || [...keys].sort().some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function exactDenseArray(value, maximum, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maximum) {
    throw new TypeError(`${name} must be a bounded dense array`);
  }
  const expected = new Set([...Array(value.length).keys()].map(String).concat("length"));
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size
      || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError(`${name} must be an undecorated dense array`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function tokenHash(value) {
  if (typeof value !== "string" || !TOKEN_HASH.test(value)) {
    throw new TypeError("wallet session token hash must be nonzero lowercase sha256");
  }
  return value;
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  }
  return value;
}

function canonicalize(value, depth = 0) {
  if (depth > 8) throw new RangeError("wallet session value is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("wallet session numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = exactDenseArray(value, 16, "wallet session array");
    return `[${entries.map((entry) => canonicalize(entry, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("wallet session values must contain plain data only");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 24 || keys.some((key) => typeof key !== "string")) {
      throw new TypeError("wallet session object fields are outside policy");
    }
    keys.sort();
    return `{${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new TypeError("wallet session values require enumerable data properties");
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  }
  throw new TypeError("wallet session value contains unsupported data");
}

function digest(value) {
  return `0x${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
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

export function contractIntentWalletSessionKeyId(value) {
  let key;
  try {
    key = value?.type === "private" ? createPublicKey(value) : publicKey(value, "wallet session key");
  } catch {
    throw new TypeError("wallet session key must be Ed25519");
  }
  return `sha256:${createHash("sha256").update(key.export({
    format: "der",
    type: "spki",
  })).digest("hex")}`;
}

function signature(value, name) {
  if (typeof value !== "string" || !BASE64_SIGNATURE.test(value)) {
    throw new TypeError(`${name} must be a canonical Ed25519 signature`);
  }
  return value;
}

function keyId(value, name) {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw new TypeError(`${name} must be a wallet session key identifier`);
  }
  return value;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function canonicalIso(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(`${name} must be canonical millisecond UTC time`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${name} must be canonical millisecond UTC time`);
  }
  return integer(Math.floor(milliseconds / 1_000), name, 1);
}

function canonicalHttpsOrigin(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a canonical HTTPS origin`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password
      || url.port || url.pathname !== "/" || url.search || url.hash
      || !url.hostname.includes(".")) {
    throw new TypeError(`${name} must be a canonical default-port HTTPS origin`);
  }
  return url.origin;
}

function unsigned(value, fields) {
  return Object.freeze(Object.fromEntries(fields
    .filter((field) => field !== "signature")
    .map((field) => [field, value[field]])));
}

function signedRecord(value, fields, key) {
  const recordDigest = digest(unsigned(value, fields));
  return Object.freeze({
    ...value,
    signature: signMessage(null, Buffer.from(recordDigest.slice(2), "hex"), key).toString("base64"),
  });
}

function verifySignedRecord(value, fields, key, name) {
  const recordDigest = digest(unsigned(value, fields));
  if (!verifyMessage(
    null,
    Buffer.from(recordDigest.slice(2), "hex"),
    key,
    Buffer.from(value.signature, "base64"),
  )) throw new Error(`${name} signature is invalid`);
  return recordDigest;
}

function normalizeRequest(value, now, expectedRequesterKeyId) {
  const source = exactRecord(value, REQUEST_FIELDS, "wallet session request");
  if (source.schema !== CONTRACT_INTENT_WALLET_SESSION_REQUEST_SCHEMA) {
    throw new Error("wallet session request schema is unsupported");
  }
  const request = Object.freeze({
    schema: source.schema,
    requestId: bytes32(source.requestId, "wallet session requestId"),
    requesterKeyId: keyId(source.requesterKeyId, "wallet session requesterKeyId"),
    tokenHash: tokenHash(source.tokenHash),
    observedAt: integer(source.observedAt, "wallet session observation time", 1),
    issuedAt: integer(source.issuedAt, "wallet session request issue time", 1),
    expiresAt: integer(source.expiresAt, "wallet session request expiry", 1),
    signature: signature(source.signature, "wallet session request signature"),
  });
  if (request.requesterKeyId !== expectedRequesterKeyId
      || request.observedAt !== request.issuedAt
      || request.issuedAt > now + MAXIMUM_CLOCK_SKEW_SECONDS
      || request.expiresAt <= now
      || request.expiresAt - request.issuedAt > MAXIMUM_REQUEST_TTL_SECONDS) {
    throw new Error("wallet session request window or identity is invalid");
  }
  return request;
}

function normalizeSession(value, observedAt, expectedTokenHash = null) {
  const source = exactRecord(value, expectedTokenHash === null
    ? SESSION_FIELDS
    : ["chainId", "createdAt", "expiresAt", "tokenHash", "walletAddress"],
  "wallet session row");
  const walletAddress = address(source.walletAddress, "wallet session wallet");
  const createdAt = canonicalIso(source.createdAt, "wallet session creation time");
  const expiresAt = canonicalIso(source.expiresAt, "wallet session expiry");
  if (source.walletAddress !== walletAddress || source.chainId !== 1
      || createdAt > observedAt || expiresAt <= observedAt
      || expiresAt - createdAt > MAXIMUM_SESSION_SECONDS
      || (expectedTokenHash !== null && source.tokenHash !== expectedTokenHash)) {
    throw new Error("wallet session row is outside policy");
  }
  return Object.freeze({
    walletAddress,
    chainId: 1,
    createdAt: source.createdAt,
    expiresAt: source.expiresAt,
  });
}

function normalizeResponse(value, now, request, expectedResponseKeyId) {
  const source = exactRecord(value, RESPONSE_FIELDS, "wallet session response");
  if (source.schema !== CONTRACT_INTENT_WALLET_SESSION_RESPONSE_SCHEMA) {
    throw new Error("wallet session response schema is unsupported");
  }
  const active = source.active;
  if (active !== true && active !== false) throw new Error("wallet session response state is invalid");
  const response = Object.freeze({
    schema: source.schema,
    requestId: bytes32(source.requestId, "wallet session response requestId"),
    requestDigest: bytes32(source.requestDigest, "wallet session response requestDigest"),
    responseKeyId: keyId(source.responseKeyId, "wallet session responseKeyId"),
    issuedAt: integer(source.issuedAt, "wallet session response issue time", 1),
    expiresAt: integer(source.expiresAt, "wallet session response expiry", 1),
    active,
    session: active ? normalizeSession(source.session, request.observedAt) : source.session,
    signature: signature(source.signature, "wallet session response signature"),
  });
  if ((!active && response.session !== null)
      || response.requestId !== request.requestId
      || response.requestDigest !== digest(unsigned(request, REQUEST_FIELDS))
      || response.responseKeyId !== expectedResponseKeyId
      || response.issuedAt < request.issuedAt
      || response.issuedAt > now + MAXIMUM_CLOCK_SKEW_SECONDS
      || response.expiresAt <= now
      || response.expiresAt > request.expiresAt
      || response.expiresAt - response.issuedAt > MAXIMUM_REQUEST_TTL_SECONDS) {
    throw new Error("wallet session response binding or window is invalid");
  }
  return response;
}

function systemClock() {
  return Math.floor(Date.now() / 1_000);
}

function randomRequestId(randomBytesImpl) {
  const value = randomBytesImpl(32);
  if ((!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) || value.byteLength !== 32) {
    throw new Error("wallet session request randomness is invalid");
  }
  const requestId = `0x${Buffer.from(value).toString("hex")}`;
  return bytes32(requestId, "wallet session requestId");
}

function databaseBinding(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")
      || typeof value.prepare !== "function") {
    throw new TypeError("wallet session D1 binding is unavailable");
  }
  return value;
}

function responseHeaders() {
  return {
    "cache-control": "no-store, max-age=0",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-site",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function jsonResponse(status, body) {
  const bytes = JSON.stringify(body);
  if (Buffer.byteLength(bytes, "utf8") > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("wallet session response exceeds its bound");
  }
  return new Response(bytes, {
    status,
    headers: {
      ...responseHeaders(),
      "content-length": String(Buffer.byteLength(bytes, "utf8")),
    },
  });
}

function rejectedResponse(status) {
  return jsonResponse(status, Object.freeze({ error: "wallet session request rejected" }));
}

async function strictRequestJson(request, maximumMilliseconds, deploymentSignal) {
  const declared = request.headers.get("content-length");
  if (declared === null || !/^[1-9][0-9]*$/.test(declared)
      || Number(declared) > MAXIMUM_REQUEST_BYTES || !request.body) {
    throw new Error("wallet session request framing is invalid");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  deploymentSignal.addEventListener("abort", abort, { once: true });
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, maximumMilliseconds);
  let reader;
  try {
    reader = request.body.getReader();
    const interrupted = new Promise((_, reject) => controller.signal.addEventListener(
      "abort",
      () => reject(new Error("wallet session request was interrupted")),
      { once: true },
    ));
    const chunks = [];
    let received = 0;
    while (true) {
      if (controller.signal.aborted) throw new Error("wallet session request was interrupted");
      const frame = await Promise.race([reader.read(), interrupted]);
      if (frame.done) break;
      if (!(frame.value instanceof Uint8Array)) throw new Error("wallet session request chunk is invalid");
      received += frame.value.byteLength;
      if (received > MAXIMUM_REQUEST_BYTES || received > Number(declared)) {
        throw new Error("wallet session request is too large");
      }
      chunks.push(Buffer.from(frame.value));
    }
    if (received !== Number(declared) || received === 0) {
      throw new Error("wallet session request length changed");
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error("wallet session request has a forbidden byte order mark");
    }
    return JSON.parse(new NodeTextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
    deploymentSignal.removeEventListener("abort", abort);
    request.signal.removeEventListener("abort", abort);
    if (controller.signal.aborted) void reader?.cancel?.().catch(() => {});
  }
}

function validateProviderRequest(request, apiOrigin, expectedRequesterKeyId) {
  if (!(request instanceof Request)) throw new TypeError("wallet session provider requires a Request");
  const url = new URL(request.url);
  if (request.method !== "POST" || url.origin !== apiOrigin || url.pathname !== READ_PATH
      || url.search || url.hash || request.headers.get("content-type") !== "application/json"
      || !String(request.headers.get("cache-control") ?? "").toLowerCase()
        .split(",").some((value) => value.trim() === "no-store")
      || request.headers.has("authorization") || request.headers.has("proxy-authorization")
      || request.headers.has("cookie") || request.headers.has("origin")
      || request.headers.has("transfer-encoding") || request.headers.has("upgrade")
      || request.headers.has("expect")
      || request.headers.get(CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER)
        !== expectedRequesterKeyId
      || String(request.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") {
    throw new Error("wallet session provider request is invalid");
  }
}

function createProvider(input, injected) {
  const fields = injected
    ? [
        "apiOrigin",
        "clock",
        "database",
        "maximumProcessingMilliseconds",
        "requesterPublicKey",
        "responsePrivateKey",
        "signal",
      ]
    : [
        "apiOrigin",
        "database",
        "requesterPublicKey",
        "responsePrivateKey",
        "signal",
      ];
  const source = exactRecord(input, fields, "wallet session provider options");
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("wallet session provider requires an active lifecycle");
  }
  const requesterKey = publicKey(source.requesterPublicKey, "wallet session requester public key");
  const responseKey = privateKey(source.responsePrivateKey, "wallet session response private key");
  const requesterKeyId = contractIntentWalletSessionKeyId(requesterKey);
  const responseKeyId = contractIntentWalletSessionKeyId(responseKey);
  if (requesterKeyId === responseKeyId) throw new Error("wallet session provider keys must be separate");
  const context = {
    activeResponses: 0,
    apiOrigin: canonicalHttpsOrigin(source.apiOrigin, "wallet session provider origin"),
    clock: injected ? source.clock : systemClock,
    clockFailures: 0,
    clockHighWater: 0,
    database: databaseBinding(source.database),
    databaseFailures: 0,
    inactiveResponses: 0,
    inFlight: 0,
    maximumProcessingMilliseconds: injected
      ? integer(source.maximumProcessingMilliseconds, "wallet session provider timeout", 1, MAXIMUM_PROCESSING_MILLISECONDS)
      : MAXIMUM_PROCESSING_MILLISECONDS,
    rejected: 0,
    requesterKey,
    requesterKeyId,
    responseKey,
    responseKeyId,
    signal: source.signal,
    state: "active",
  };
  if (typeof context.clock !== "function") throw new TypeError("wallet session provider clock is invalid");
  const observeNow = () => {
    let now;
    try {
      now = integer(context.clock(), "wallet session provider time", 1);
    } catch (error) {
      throw new ProviderClockError("wallet session provider clock is invalid", { cause: error });
    }
    if (now < context.clockHighWater) {
      throw new ProviderClockError("wallet session provider clock regressed");
    }
    context.clockHighWater = now;
    return now;
  };
  const provider = Object.freeze({
    async handle(request) {
      if (this !== provider || PROVIDERS.get(this) !== context) {
        throw new TypeError("wallet session provider request requires the original service");
      }
      if (context.state !== "active" || context.signal.aborted) return rejectedResponse(503);
      if (context.inFlight >= MAXIMUM_IN_FLIGHT) {
        context.rejected += 1;
        return rejectedResponse(429);
      }
      context.inFlight += 1;
      try {
        validateProviderRequest(request, context.apiOrigin, context.requesterKeyId);
        const now = observeNow();
        const body = await strictRequestJson(
          request,
          context.maximumProcessingMilliseconds,
          context.signal,
        );
        const normalized = normalizeRequest(body, now, context.requesterKeyId);
        verifySignedRecord(
          normalized,
          REQUEST_FIELDS,
          context.requesterKey,
          "wallet session request",
        );
        const statement = context.database.prepare(CONTRACT_INTENT_WALLET_SESSION_QUERY);
        if (!statement || typeof statement.bind !== "function") throw new ProviderStorageError();
        const bound = statement.bind(
          normalized.tokenHash,
          new Date(normalized.observedAt * 1_000).toISOString(),
        );
        if (!bound || typeof bound.all !== "function") throw new ProviderStorageError();
        let result;
        try {
          result = await bound.all();
        } catch (error) {
          throw new ProviderStorageError("wallet session D1 read failed", { cause: error });
        }
        let rows;
        let session;
        try {
          rows = exactDenseArray(result?.results, 2, "wallet session D1 rows");
          if (rows.length > 1) throw new Error("wallet session D1 returned duplicate rows");
          session = rows.length === 0
            ? null
            : normalizeSession(rows[0], normalized.observedAt, normalized.tokenHash);
        } catch (error) {
          throw new ProviderStorageError("wallet session D1 result failed policy", { cause: error });
        }
        const issuedAt = observeNow();
        const expiresAt = Math.min(normalized.expiresAt, issuedAt + MAXIMUM_REQUEST_TTL_SECONDS);
        if (expiresAt <= issuedAt) throw new Error("wallet session request expired during processing");
        const unsignedResponse = Object.freeze({
          schema: CONTRACT_INTENT_WALLET_SESSION_RESPONSE_SCHEMA,
          requestId: normalized.requestId,
          requestDigest: digest(unsigned(normalized, REQUEST_FIELDS)),
          responseKeyId: context.responseKeyId,
          issuedAt,
          expiresAt,
          active: session !== null,
          session,
        });
        if (session === null) context.inactiveResponses += 1;
        else context.activeResponses += 1;
        return jsonResponse(200, signedRecord(
          unsignedResponse,
          RESPONSE_FIELDS,
          context.responseKey,
        ));
      } catch (error) {
        context.rejected += 1;
        if (error instanceof ProviderStorageError || error instanceof ProviderClockError) {
          if (error instanceof ProviderStorageError) context.databaseFailures += 1;
          else context.clockFailures += 1;
          context.state = "halted";
          return rejectedResponse(503);
        }
        return rejectedResponse(400);
      } finally {
        context.inFlight -= 1;
      }
    },
    status() {
      if (this !== provider || PROVIDERS.get(this) !== context) {
        throw new TypeError("wallet session provider status requires the original service");
      }
      return Object.freeze({
        schema: "treeswap.contract-intent-wallet-session-provider-status.v1",
        state: context.state,
        activeResponses: context.activeResponses,
        inactiveResponses: context.inactiveResponses,
        rejectedRequests: context.rejected,
        databaseFailures: context.databaseFailures,
        clockFailures: context.clockFailures,
        inFlightRequests: context.inFlight,
        fixedD1Query: true,
        rawSessionTokensReceived: false,
        tokenHashesReturned: false,
        requesterKeyIdDisclosed: false,
        responseKeyIdDisclosed: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
  });
  PROVIDERS.set(provider, context);
  source.signal.addEventListener("abort", () => { context.state = "stopped"; }, { once: true });
  return provider;
}

export function createContractIntentWalletSessionProvider(input) {
  return createProvider(input, false);
}

export function createContractIntentWalletSessionProviderForTests(input) {
  return createProvider(input, true);
}

function createReader(input, injected) {
  const fields = injected
    ? [
        "apiOrigin",
        "clock",
        "maximumProcessingMilliseconds",
        "randomBytes",
        "requesterPrivateKey",
        "responsePublicKey",
        "signal",
        "transport",
      ]
    : [
        "apiOrigin",
        "requesterPrivateKey",
        "responsePublicKey",
        "signal",
      ];
  const source = exactRecord(input, fields, "wallet session reader options");
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("wallet session reader requires an active lifecycle");
  }
  const requesterKey = privateKey(source.requesterPrivateKey, "wallet session requester private key");
  const responseKey = publicKey(source.responsePublicKey, "wallet session response public key");
  const requesterKeyId = contractIntentWalletSessionKeyId(requesterKey);
  const responseKeyId = contractIntentWalletSessionKeyId(responseKey);
  if (requesterKeyId === responseKeyId) throw new Error("wallet session reader keys must be separate");
  const context = {
    activeReads: 0,
    apiOrigin: canonicalHttpsOrigin(source.apiOrigin, "wallet session reader origin"),
    clock: injected ? source.clock : systemClock,
    clockHighWater: 0,
    failedReads: 0,
    inactiveReads: 0,
    inFlight: 0,
    lease: null,
    maximumProcessingMilliseconds: injected
      ? integer(source.maximumProcessingMilliseconds, "wallet session reader timeout", 1, MAXIMUM_PROCESSING_MILLISECONDS)
      : MAXIMUM_PROCESSING_MILLISECONDS,
    mode: injected ? "test" : "production",
    pending: new Set(),
    randomBytes: injected ? source.randomBytes : nodeRandomBytes,
    requesterKey,
    requesterKeyId,
    responseKey,
    responseKeyId,
    signal: source.signal,
    state: "active",
    transport: injected ? source.transport : pinnedPublicWalletSessionRequest,
  };
  if (typeof context.clock !== "function" || typeof context.randomBytes !== "function"
      || typeof context.transport !== "function") {
    throw new TypeError("wallet session reader dependencies are invalid");
  }
  const assertReceiver = (receiver) => {
    const expected = context.lease ?? reader;
    if (receiver !== expected || context.state !== "active" || context.signal.aborted) {
      throw new TypeError("wallet session read requires the original active lifecycle");
    }
  };
  const observeNow = () => {
    const now = integer(context.clock(), "wallet session reader time", 1);
    if (now < context.clockHighWater) throw new Error("wallet session reader clock regressed");
    context.clockHighWater = now;
    return now;
  };
  const read = async (receiver, input) => {
    assertReceiver(receiver);
    if (context.inFlight >= MAXIMUM_IN_FLIGHT || context.pending.size >= MAXIMUM_PENDING_READS) {
      context.state = "halted";
      context.failedReads += 1;
      throw new ContractIntentWalletSessionReaderFatalError("wallet session reader capacity failed closed");
    }
    const sourceRead = exactRecord(input, READ_FIELDS, "wallet session read");
    const expectedTokenHash = tokenHash(sourceRead.tokenHash);
    const observedAt = integer(sourceRead.observedAt, "wallet session read observation time", 1);
    context.inFlight += 1;
    try {
      const now = observeNow();
      if (observedAt !== now) throw new Error("wallet session read must use current time");
      const unsignedRequest = Object.freeze({
        schema: CONTRACT_INTENT_WALLET_SESSION_REQUEST_SCHEMA,
        requestId: randomRequestId(context.randomBytes),
        requesterKeyId: context.requesterKeyId,
        tokenHash: expectedTokenHash,
        observedAt,
        issuedAt: now,
        expiresAt: now + MAXIMUM_REQUEST_TTL_SECONDS,
      });
      const request = signedRecord(unsignedRequest, REQUEST_FIELDS, context.requesterKey);
      const body = JSON.stringify(request);
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, context.maximumProcessingMilliseconds);
      let response;
      try {
        response = await context.transport(
          `${context.apiOrigin}${READ_PATH}`,
          {
            method: "POST",
            headers: {
              "cache-control": "no-store",
              "content-length": String(Buffer.byteLength(body, "utf8")),
              "content-type": "application/json",
              [CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER]: context.requesterKeyId,
            },
            body,
            signal: controller.signal,
          },
        );
        if (!response || response.status !== 200 || response.redirected === true
            || typeof response.headers?.get !== "function"
            || response.headers.get("content-type") !== "application/json; charset=utf-8"
            || !String(response.headers.get("cache-control") ?? "").toLowerCase()
              .split(",").some((value) => value.trim() === "no-store")
            || response.headers.get("set-cookie") !== null
            || response.headers.get("location") !== null) {
          discardJsonResponseBody(response);
          throw new Error("wallet session provider response is invalid");
        }
        const raw = await readStrictJsonResponse(response, {
          label: "wallet session provider response",
          maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
          signal: controller.signal,
        });
        const responseNow = observeNow();
        const normalized = normalizeResponse(raw, responseNow, request, context.responseKeyId);
        verifySignedRecord(
          normalized,
          RESPONSE_FIELDS,
          context.responseKey,
          "wallet session response",
        );
        const readResult = Object.freeze({
          schema: "treeswap.contract-intent-wallet-session-read.v1",
          active: normalized.active,
          walletAddress: normalized.active ? normalized.session.walletAddress : null,
          chainId: normalized.active ? normalized.session.chainId : null,
          createdAt: normalized.active ? normalized.session.createdAt : null,
          expiresAt: normalized.active ? normalized.session.expiresAt : null,
          rawSessionTokenDisclosed: false,
          tokenHashDisclosed: false,
          walletDispatchAuthority: false,
          lightningDispatchAuthority: false,
          fundingAuthorization: false,
        });
        const readContext = {
          consumed: false,
          context,
          observedAt,
          tokenHash: expectedTokenHash,
        };
        VERIFIED_READS.set(readResult, readContext);
        context.pending.add(readResult);
        if (normalized.active) context.activeReads += 1;
        else context.inactiveReads += 1;
        return readResult;
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
      }
    } catch (error) {
      context.failedReads += 1;
      context.state = "halted";
      context.pending.clear();
      if (error instanceof ContractIntentWalletSessionReaderFatalError) throw error;
      throw new ContractIntentWalletSessionReaderFatalError(
        "wallet session reader failed closed",
        { cause: error },
      );
    } finally {
      context.inFlight -= 1;
    }
  };
  const consume = (receiver, value, input) => {
    assertReceiver(receiver);
    const sourceConsume = exactRecord(input, CONSUME_FIELDS, "wallet session read consumption");
    const readContext = VERIFIED_READS.get(value);
    if (!readContext || readContext.context !== context || readContext.consumed
        || !context.pending.has(value)
        || sourceConsume.tokenHash !== readContext.tokenHash
        || sourceConsume.observedAt !== readContext.observedAt) {
      throw new TypeError("wallet session read provenance or binding is invalid");
    }
    readContext.consumed = true;
    context.pending.delete(value);
    return value;
  };
  const status = (receiver) => {
    const expected = context.lease ?? reader;
    if (receiver !== expected || context.state === "closed") {
      throw new TypeError("wallet session reader status requires the original lifecycle");
    }
    return Object.freeze({
      schema: "treeswap.contract-intent-wallet-session-reader-status.v1",
      state: context.state,
      activeReads: context.activeReads,
      inactiveReads: context.inactiveReads,
      failedReads: context.failedReads,
      inFlightReads: context.inFlight,
      pendingReads: context.pending.size,
      fixedHttpsTransport: !injected,
      exactD1ProviderProtocol: true,
      rawSessionTokensSent: false,
      tokenHashesInStatus: false,
      walletsInStatus: false,
      walletDispatchAuthority: false,
      lightningDispatchAuthority: false,
      fundingAuthorization: false,
    });
  };
  const stop = (receiver) => {
    const expected = context.lease ?? reader;
    if (receiver !== expected) throw new TypeError("wallet session reader stop requires the original lifecycle");
    if (context.state !== "closed") context.state = "stopped";
    context.pending.clear();
    return status(receiver);
  };
  const reader = Object.freeze({
    read(input) { return read(this, input); },
    consume(value, input) { return consume(this, value, input); },
    status() { return status(this); },
    stop() { return stop(this); },
  });
  READERS.set(reader, context);
  source.signal.addEventListener("abort", () => {
    if (context.state !== "closed") context.state = "stopped";
    context.pending.clear();
  }, { once: true });
  return reader;
}

export function createContractIntentWalletSessionReader(input) {
  return createReader(input, false);
}

export function createContractIntentWalletSessionReaderForTests(input) {
  return createReader(input, true);
}

export function assertContractIntentWalletSessionReaderLifecycle(reader, signal) {
  const context = reader && typeof reader === "object" ? READERS.get(reader) : null;
  if (!context || !(signal instanceof AbortSignal) || context.signal !== signal
      || signal.aborted || context.state !== "active" || context.lease !== null) {
    throw new TypeError("wallet session edge requires an unclaimed active reader lifecycle");
  }
  return Object.freeze({
    schema: "treeswap.contract-intent-wallet-session-reader-binding.v1",
    mode: context.mode,
    apiOrigin: context.apiOrigin,
    requesterKeyId: context.requesterKeyId,
    responseKeyId: context.responseKeyId,
  });
}

export function claimContractIntentWalletSessionReaderEdge(reader, signal) {
  const binding = assertContractIntentWalletSessionReaderLifecycle(reader, signal);
  const context = READERS.get(reader);
  let lease;
  lease = Object.freeze({
    read(input) {
      if (this !== lease || READER_LEASES.get(this) !== context) {
        throw new TypeError("wallet session edge read requires the original lease");
      }
      return reader.read.call(lease, input);
    },
    consume(value, input) {
      if (this !== lease || READER_LEASES.get(this) !== context) {
        throw new TypeError("wallet session edge consumption requires the original lease");
      }
      return reader.consume.call(lease, value, input);
    },
    status() {
      if (this !== lease || READER_LEASES.get(this) !== context) {
        throw new TypeError("wallet session edge status requires the original lease");
      }
      return reader.status.call(lease);
    },
    stop() {
      if (this !== lease || READER_LEASES.get(this) !== context) {
        throw new TypeError("wallet session edge stop requires the original lease");
      }
      return reader.stop.call(lease);
    },
  });
  context.lease = lease;
  READER_LEASES.set(lease, context);
  return Object.freeze({ lease, binding });
}
