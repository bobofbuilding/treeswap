import {
  createPrivateKey,
  createPublicKey,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import {
  Signature,
  getAddress,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import {
  TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES,
  TREE_SWAP_SELECTED_QUOTE_TYPES,
  validateContractIntentSigningPayload,
} from "./contract-intent-schema.mjs";
import {
  authorizeFinalizedContractIntent,
  verifiedPreparedContractIntent,
} from "./rfq-contract-intent.mjs";
import { discardJsonResponseBody, readStrictJsonResponse } from "./private-json-response.mjs";
import { pinnedPublicSolverContractSigningRequest } from "./solver-endpoint-transport.mjs";
import {
  solverEndpointPublicKeyDigest,
  verifiedSolverEndpointTransportBinding,
} from "./solver-capability.mjs";

export const SOLVER_CONTRACT_SIGNING_REQUEST_SCHEMA =
  "treeswap.solver-contract-signing-request.v1";
export const SOLVER_CONTRACT_SIGNING_RESPONSE_SCHEMA =
  "treeswap.solver-contract-signing-response.v1";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const MAXIMUM_TTL_SECONDS = 30;
const MAXIMUM_CLOCK_SKEW_SECONDS = 5;
const MAXIMUM_RESPONSE_BYTES = 32_768;
const DATE_NOW = Date.now.bind(Date);
const REQUEST_FIELDS = Object.freeze([
  "capabilityDigest",
  "contractIntentDigest",
  "direction",
  "expiresAt",
  "payload",
  "requestId",
  "requestedAt",
  "requesterPublicKey",
  "requesterPublicKeyDigest",
  "schema",
  "selectedOfferId",
  "settlementContractCodeHash",
  "settlementId",
  "signature",
  "userAuthorizationDigest",
]);
const RESPONSE_FIELDS = Object.freeze([
  "capabilityDigest",
  "contractIntentDigest",
  "expiresAt",
  "requestDigest",
  "requestId",
  "schema",
  "servedAt",
  "signature",
  "solver",
  "solverSignature",
]);
const CLIENTS = new WeakMap();
const VERIFIED_REQUESTS = new WeakMap();
const VERIFIED_RESPONSES = new WeakSet();
const VERIFIED_RESULTS = new WeakMap();

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

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  try {
    const result = getAddress(value).toLowerCase();
    if (result === "0x0000000000000000000000000000000000000000") throw new Error();
    return result;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function canonicalSignature(value, name) {
  if (typeof value !== "string" || !EVM_SIGNATURE.test(value)) {
    throw new TypeError(`${name} must be an exact 65-byte ECDSA signature`);
  }
  try {
    const signature = Signature.from(value);
    if (signature.v !== 27 && signature.v !== 28) throw new Error();
    return signature.serialized.toLowerCase();
  } catch {
    throw new TypeError(`${name} must be an exact 65-byte ECDSA signature`);
  }
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("canonical value contains unsupported data");
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

function privateKey(value, name) {
  try {
    const key = value?.type === "private" ? value : createPrivateKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new TypeError(`${name} must be an Ed25519 private key`);
  }
}

function publicPem(key) {
  return publicKey(key, "requester public key").export({ format: "pem", type: "spki" }).toString();
}

function unsignedRequest(value) {
  return Object.freeze(Object.fromEntries(REQUEST_FIELDS
    .filter((field) => field !== "signature")
    .map((field) => [field, value[field]])));
}

function unsignedResponse(value) {
  return Object.freeze(Object.fromEntries(RESPONSE_FIELDS
    .filter((field) => field !== "signature")
    .map((field) => [field, value[field]])));
}

function requestMessage(value) {
  return Buffer.from(`TreeSwap solver contract signing request v1\n${value}\n`, "utf8");
}

function responseMessage(value) {
  return Buffer.from(`TreeSwap solver contract signing response v1\n${value}\n`, "utf8");
}

function signingPayload(raw) {
  const verified = validateContractIntentSigningPayload(raw);
  return Object.freeze({
    direction: verified.direction,
    domain: verified.domain,
    message: verified.message,
    primaryType: verified.primaryType,
  });
}

function normalizeRequest(raw) {
  const source = exactRecord(raw, REQUEST_FIELDS, "solver contract signing request");
  if (source.schema !== SOLVER_CONTRACT_SIGNING_REQUEST_SCHEMA) {
    throw new Error("solver contract signing request schema is unsupported");
  }
  if (typeof source.requesterPublicKey !== "string" || Buffer.byteLength(source.requesterPublicKey) > 2_048) {
    throw new TypeError("solver contract signing requester key is invalid");
  }
  const requesterPublicKey = publicPem(source.requesterPublicKey);
  const requesterPublicKeyDigest = solverEndpointPublicKeyDigest(requesterPublicKey);
  if (requesterPublicKeyDigest !== bytes32(
    source.requesterPublicKeyDigest,
    "solver contract signing requester key digest",
  )) throw new Error("solver contract signing requester key digest changed");
  const verifiedPayload = validateContractIntentSigningPayload(source.payload);
  const payload = signingPayload(source.payload);
  const direction = source.direction;
  if (direction !== payload.direction) throw new Error("solver contract signing direction changed");
  const contractIntentDigest = bytes32(
    source.contractIntentDigest,
    "solver contract signing contract intent digest",
  );
  if (contractIntentDigest !== verifiedPayload.contractIntentDigest) {
    throw new Error("solver contract signing payload digest changed");
  }
  const result = Object.freeze({
    schema: source.schema,
    requestId: bytes32(source.requestId, "solver contract signing request ID"),
    settlementId: bytes32(source.settlementId, "solver contract signing settlement ID"),
    selectedOfferId: bytes32(source.selectedOfferId, "solver contract signing offer ID"),
    userAuthorizationDigest: bytes32(
      source.userAuthorizationDigest,
      "solver contract signing user authorization digest",
    ),
    capabilityDigest: bytes32(source.capabilityDigest, "solver contract signing capability digest"),
    settlementContractCodeHash: bytes32(
      source.settlementContractCodeHash,
      "solver contract signing settlement code hash",
    ),
    direction,
    payload,
    contractIntentDigest,
    requesterPublicKey,
    requesterPublicKeyDigest,
    requestedAt: integer(source.requestedAt, "solver contract signing request time", 1),
    expiresAt: integer(source.expiresAt, "solver contract signing request expiry", 1),
    signature: source.signature,
  });
  if (result.expiresAt <= result.requestedAt
      || result.expiresAt - result.requestedAt > MAXIMUM_TTL_SECONDS) {
    throw new Error("solver contract signing request lifetime is invalid");
  }
  if (typeof result.signature !== "string" || !BASE64_SIGNATURE.test(result.signature)) {
    throw new TypeError("solver contract signing request signature is invalid");
  }
  const expectedRequestId = keccak256(toUtf8Bytes(canonicalize({
    schema: result.schema,
    settlementId: result.settlementId,
    selectedOfferId: result.selectedOfferId,
    capabilityDigest: result.capabilityDigest,
    contractIntentDigest: result.contractIntentDigest,
    requesterPublicKeyDigest: result.requesterPublicKeyDigest,
  }))).toLowerCase();
  if (result.requestId !== expectedRequestId) throw new Error("solver contract signing request ID changed");
  return result;
}

export function solverContractSigningRequestDigest(raw) {
  const request = normalizeRequest(raw);
  return keccak256(toUtf8Bytes(canonicalize(unsignedRequest(request)))).toLowerCase();
}

function normalizeResponse(raw) {
  const source = exactRecord(raw, RESPONSE_FIELDS, "solver contract signing response");
  if (source.schema !== SOLVER_CONTRACT_SIGNING_RESPONSE_SCHEMA) {
    throw new Error("solver contract signing response schema is unsupported");
  }
  const result = Object.freeze({
    schema: source.schema,
    requestId: bytes32(source.requestId, "solver contract signing response request ID"),
    requestDigest: bytes32(source.requestDigest, "solver contract signing response request digest"),
    capabilityDigest: bytes32(source.capabilityDigest, "solver contract signing response capability digest"),
    contractIntentDigest: bytes32(
      source.contractIntentDigest,
      "solver contract signing response intent digest",
    ),
    solver: address(source.solver, "solver contract signing response solver"),
    solverSignature: canonicalSignature(source.solverSignature, "solver contract signature"),
    servedAt: integer(source.servedAt, "solver contract signing response time", 1),
    expiresAt: integer(source.expiresAt, "solver contract signing response expiry", 1),
    signature: source.signature,
  });
  if (result.expiresAt <= result.servedAt
      || typeof result.signature !== "string" || !BASE64_SIGNATURE.test(result.signature)) {
    throw new Error("solver contract signing response window or signature is invalid");
  }
  return result;
}

export function solverContractSigningResponseDigest(raw) {
  const response = normalizeResponse(raw);
  return keccak256(toUtf8Bytes(canonicalize(unsignedResponse(response)))).toLowerCase();
}

export function verifySolverContractSigningRequest(input) {
  const source = exactRecord(input, [
    "authority",
    "now",
    "request",
    "requesterPublicKey",
  ], "solver contract signing request verification");
  const normalized = normalizeRequest(source.request);
  const policy = exactRecord(source.authority, [
    "capabilityDigest",
    "direction",
    "expiresAt",
    "settlementContract",
    "settlementContractCodeHash",
    "solver",
  ], "solver contract signing authority");
  const observedAt = integer(source.now, "solver contract signing provider time", 1);
  const expected = Object.freeze({
    capabilityDigest: bytes32(policy.capabilityDigest, "solver contract signing authority capability"),
    direction: policy.direction,
    expiresAt: integer(policy.expiresAt, "solver contract signing authority expiry", 1),
    settlementContract: address(policy.settlementContract, "solver contract signing authority contract"),
    settlementContractCodeHash: bytes32(
      policy.settlementContractCodeHash,
      "solver contract signing authority code hash",
    ),
    solver: address(policy.solver, "solver contract signing authority solver"),
  });
  if (observedAt < normalized.requestedAt - MAXIMUM_CLOCK_SKEW_SECONDS
      || observedAt >= normalized.expiresAt || observedAt >= expected.expiresAt) {
    throw new Error("solver contract signing request is outside its live window");
  }
  if (normalized.expiresAt > expected.expiresAt
      || normalized.payload.message.quoteExpiresAt > expected.expiresAt) {
    throw new Error("solver contract signing request outlives its reviewed capability");
  }
  if (normalized.capabilityDigest !== expected.capabilityDigest
      || normalized.direction !== expected.direction
      || normalized.settlementContractCodeHash !== expected.settlementContractCodeHash
      || normalized.payload.domain.verifyingContract !== expected.settlementContract
      || normalized.payload.message.solver !== expected.solver) {
    throw new Error("solver contract signing request changed its reviewed authority");
  }
  const expectedRequester = publicPem(source.requesterPublicKey);
  if (expectedRequester !== normalized.requesterPublicKey) {
    throw new Error("solver contract signing requester key is not allowlisted");
  }
  const requestDigest = keccak256(toUtf8Bytes(canonicalize(unsignedRequest(normalized)))).toLowerCase();
  if (!verifyMessage(
    null,
    requestMessage(requestDigest),
    publicKey(expectedRequester, "solver contract signing requester key"),
    Buffer.from(normalized.signature, "base64"),
  )) throw new Error("solver contract signing request signature is invalid");
  const verified = Object.freeze({ ...normalized, requestDigest });
  VERIFIED_REQUESTS.set(verified, Object.freeze({ authority: expected }));
  return verified;
}

export function verifiedSolverContractSigningRequest(value) {
  if (!VERIFIED_REQUESTS.has(value)) {
    throw new TypeError("solver contract signing request lacks verified transport provenance");
  }
  return value;
}

export function buildSignedSolverContractSigningResponse(input) {
  const source = exactRecord(input, [
    "endpointPrivateKey",
    "expiresAt",
    "request",
    "servedAt",
    "solverSignature",
  ], "solver contract signing response construction");
  const request = source.request;
  const context = VERIFIED_REQUESTS.get(request);
  if (!context) throw new TypeError("solver contract signing response requires an original verified request");
  const now = integer(source.servedAt, "solver contract signing response time", request.requestedAt);
  const expiry = integer(
    source.expiresAt,
    "solver contract signing response expiry",
    now + 1,
    request.expiresAt,
  );
  const signature = canonicalSignature(source.solverSignature, "solver contract signature");
  const types = request.direction === "lightning-to-bit"
    ? TREE_SWAP_SELECTED_QUOTE_TYPES
    : TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES;
  const recovered = address(verifyTypedData(
    request.payload.domain,
    types,
    request.payload.message,
    signature,
  ), "solver contract signing recovered solver");
  if (recovered !== context.authority.solver) throw new Error("solver contract signature belongs to another account");
  const unsigned = Object.freeze({
    schema: SOLVER_CONTRACT_SIGNING_RESPONSE_SCHEMA,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    capabilityDigest: request.capabilityDigest,
    contractIntentDigest: request.contractIntentDigest,
    solver: context.authority.solver,
    solverSignature: signature,
    servedAt: now,
    expiresAt: expiry,
  });
  const responseDigest = keccak256(toUtf8Bytes(canonicalize(unsigned))).toLowerCase();
  const endpointKey = privateKey(source.endpointPrivateKey, "solver contract signing endpoint key");
  const response = Object.freeze({
    ...unsigned,
    signature: signMessage(null, responseMessage(responseDigest), endpointKey).toString("base64"),
  });
  VERIFIED_RESPONSES.add(response);
  return response;
}


export function verifiedSolverContractSigningResponse(value) {
  if (!VERIFIED_RESPONSES.has(value)) {
    throw new TypeError("solver contract signing response lacks original provider provenance");
  }
  return value;
}

function buildRequest({ prepared, binding, requesterPrivateKey, now }) {
  const verified = verifiedPreparedContractIntent(prepared, { now });
  const verifiedPayload = validateContractIntentSigningPayload({
    direction: verified.direction,
    domain: verified.domain,
    message: verified.message,
    primaryType: verified.primaryType,
  });
  const payload = signingPayload({
    direction: verifiedPayload.direction,
    domain: verifiedPayload.domain,
    message: verifiedPayload.message,
    primaryType: verifiedPayload.primaryType,
  });
  const requesterKey = privateKey(requesterPrivateKey, "solver contract signing requester key");
  const requesterPublicKey = publicPem(createPublicKey(requesterKey));
  const requesterPublicKeyDigest = solverEndpointPublicKeyDigest(requesterPublicKey);
  const solver = address(binding.solverId, "solver contract signing capability solver");
  if (verified.direction !== binding.direction
      || verifiedPayload.message.solver !== solver
      || verifiedPayload.domain.chainId !== String(binding.chainId)
      || verifiedPayload.domain.verifyingContract !== address(
        binding.settlementContract,
        "solver contract signing capability contract",
      )
      || verified.settlementContractCodeHash !== binding.settlementContractCodeHash
      || verifiedPayload.contractIntentDigest !== verified.digest) {
    throw new Error("prepared contract intent does not match the selected solver capability");
  }
  const expiresAt = Math.min(verified.expiresAt, binding.expiresAt, now + MAXIMUM_TTL_SECONDS);
  if (expiresAt <= now) throw new Error("solver contract signing request has no live window");
  const identity = Object.freeze({
    schema: SOLVER_CONTRACT_SIGNING_REQUEST_SCHEMA,
    settlementId: verified.settlementId,
    selectedOfferId: verified.selectedOfferId,
    capabilityDigest: binding.capabilityDigest,
    contractIntentDigest: verifiedPayload.contractIntentDigest,
    requesterPublicKeyDigest,
  });
  const requestId = keccak256(toUtf8Bytes(canonicalize(identity))).toLowerCase();
  const unsigned = Object.freeze({
    schema: SOLVER_CONTRACT_SIGNING_REQUEST_SCHEMA,
    requestId,
    settlementId: verified.settlementId,
    selectedOfferId: verified.selectedOfferId,
    userAuthorizationDigest: verified.userAuthorizationDigest,
    capabilityDigest: binding.capabilityDigest,
    settlementContractCodeHash: verified.settlementContractCodeHash,
    direction: verified.direction,
    payload,
    contractIntentDigest: verifiedPayload.contractIntentDigest,
    requesterPublicKey,
    requesterPublicKeyDigest,
    requestedAt: now,
    expiresAt,
  });
  const requestDigest = keccak256(toUtf8Bytes(canonicalize(unsigned))).toLowerCase();
  const request = Object.freeze({
    ...unsigned,
    signature: signMessage(null, requestMessage(requestDigest), requesterKey).toString("base64"),
  });
  normalizeRequest(request);
  return Object.freeze({ request, requestDigest, prepared: verified });
}

async function sendRequest({ request, requestDigest, prepared, binding, requestImpl, nowSeconds, signal }) {
  const endpoint = new URL("/v1/sign-contract-intent", binding.endpointOrigin);
  const controller = new AbortController();
  const transportSignal = AbortSignal.any([signal, controller.signal]);
  const perform = requestImpl ?? ((url, options) => pinnedPublicSolverContractSigningRequest(url, options, {
    maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
  }));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("solver contract signing request timed out"));
    }, 5_000);
  });
  let response;
  try {
    let raw;
    try {
      raw = await Promise.race([perform(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json",
          "referrer-policy": "no-referrer",
        },
        body: JSON.stringify(request),
        signal: transportSignal,
      }), timeout]);
    } catch {
      throw new SolverContractSigningError("solver contract signing transport is ambiguous", {
        ambiguous: true,
        code: "TRANSPORT_AMBIGUOUS",
      });
    }
    if (raw && typeof raw === "object" && (raw.status === 425 || raw.status === 503)) {
      discardJsonResponseBody(raw);
      throw new SolverContractSigningError("solver contract signing remains pending", {
        ambiguous: true,
        code: "PROVIDER_RECOVERY_PENDING",
      });
    }
    if (!raw || typeof raw !== "object" || raw.redirected === true || raw.status !== 200) {
      discardJsonResponseBody(raw);
      throw new SolverContractSigningError("solver contract signing endpoint rejected the request", {
        ambiguous: false,
        code: "HTTP_REJECTED",
      });
    }
    response = normalizeResponse(await Promise.race([readStrictJsonResponse(raw, {
      label: "solver contract signing response",
      maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
      signal: transportSignal,
    }), timeout]));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const receivedAt = integer(nowSeconds(), "solver contract signing client time", 1);
  if (response.requestId !== request.requestId || response.requestDigest !== requestDigest
      || response.capabilityDigest !== binding.capabilityDigest
      || response.contractIntentDigest !== prepared.digest
      || response.solver !== address(binding.solverId, "solver contract signing capability solver")) {
    throw new SolverContractSigningError("solver contract signing response changed its authority", {
      ambiguous: false,
      code: "AUTHORITY_CHANGED",
    });
  }
  if (response.servedAt < request.requestedAt - MAXIMUM_CLOCK_SKEW_SECONDS
      || response.servedAt > receivedAt + MAXIMUM_CLOCK_SKEW_SECONDS
      || response.expiresAt <= receivedAt || response.expiresAt > request.expiresAt) {
    throw new SolverContractSigningError("solver contract signing response is outside its live window", {
      ambiguous: false,
      code: "STALE_RESPONSE",
    });
  }
  const responseDigest = keccak256(toUtf8Bytes(canonicalize(unsignedResponse(response)))).toLowerCase();
  if (!verifyMessage(
    null,
    responseMessage(responseDigest),
    publicKey(binding.endpointPublicKey, "solver endpoint response key"),
    Buffer.from(response.signature, "base64"),
  )) throw new SolverContractSigningError("solver contract signing endpoint signature is invalid", {
    ambiguous: false,
    code: "INVALID_RESPONSE_SIGNATURE",
  });
  const types = prepared.direction === "lightning-to-bit"
    ? TREE_SWAP_SELECTED_QUOTE_TYPES
    : TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES;
  const recovered = address(verifyTypedData(
    prepared.domain,
    types,
    prepared.message,
    response.solverSignature,
  ), "solver contract signing recovered solver");
  if (recovered !== response.solver) {
    throw new SolverContractSigningError("solver contract signature is invalid", {
      ambiguous: false,
      code: "INVALID_SOLVER_SIGNATURE",
    });
  }
  const result = Object.freeze({
    schema: "treeswap.verified-solver-contract-signature.v1",
    requestId: request.requestId,
    requestDigest,
    responseDigest,
    contractIntentDigest: prepared.digest,
    solver: response.solver,
    solverSignature: response.solverSignature,
    expiresAt: response.expiresAt,
    networkListener: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
  VERIFIED_RESULTS.set(result, Object.freeze({ prepared }));
  return result;
}

function createClient(input, mode, injected) {
  const source = exactRecord(input, ["requesterPrivateKey", "signal"], "solver contract signing client");
  const signal = source.signal;
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw new TypeError("solver contract signing client requires an active deployment signal");
  }
  const requesterPrivateKey = privateKey(source.requesterPrivateKey, "solver contract signing requester key");
  const context = { mode, signal, requesterPrivateKey, attempts: new WeakMap() };
  const client = Object.freeze({
    async sign(input) {
      if (this !== client || CLIENTS.get(client) !== context || signal.aborted) {
        throw new TypeError("solver contract signing client is inactive or lacks provenance");
      }
      const source = exactRecord(input, ["capability", "prepared"], "solver signing operation");
      const binding = verifiedSolverEndpointTransportBinding(source.capability);
      const prepared = source.prepared;
      let attempt = context.attempts.get(prepared);
      if (!attempt) {
        const now = integer(injected.nowSeconds(), "solver contract signing client time", 1);
        attempt = {
          ...buildRequest({ prepared, binding, requesterPrivateKey, now }),
          binding,
          capability: source.capability,
          inFlight: false,
          result: null,
        };
        context.attempts.set(prepared, attempt);
      } else if (attempt.capability !== source.capability) {
        throw new TypeError("solver contract signing retry changed its original capability");
      }
      if (attempt.result) return attempt.result;
      if (attempt.inFlight) throw new Error("solver contract signing request is already in flight");
      attempt.inFlight = true;
      try {
        attempt.result = await sendRequest({
          ...attempt,
          requestImpl: injected.requestImpl,
          nowSeconds: injected.nowSeconds,
          signal,
        });
        return attempt.result;
      } finally {
        attempt.inFlight = false;
      }
    },
    status() {
      if (this !== client || CLIENTS.get(client) !== context) {
        throw new TypeError("solver contract signing client lacks provenance");
      }
      return Object.freeze({
        schema: "treeswap.solver-contract-signing-client-status.v1",
        mode,
        state: signal.aborted ? "closed" : "active",
        networkListener: false,
        solverSigningAuthority: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
  });
  CLIENTS.set(client, context);
  return client;
}

export function createSolverContractSigningClient(input) {
  return createClient(input, "production", {
    nowSeconds: () => Math.floor(DATE_NOW() / 1_000),
    requestImpl: null,
  });
}

export function createTestSolverContractSigningClient(input) {
  const source = exactRecord(
    input,
    ["nowSeconds", "requestImpl", "requesterPrivateKey", "signal"],
    "test solver contract signing client",
  );
  if (typeof source.nowSeconds !== "function" || typeof source.requestImpl !== "function") {
    throw new TypeError("test solver contract signing client requires time and transport functions");
  }
  return createClient({
    requesterPrivateKey: source.requesterPrivateKey,
    signal: source.signal,
  }, "injected-test", {
    nowSeconds: source.nowSeconds,
    requestImpl: source.requestImpl,
  });
}

export function authorizeContractIntentWithSolverSignature(input) {
  const source = exactRecord(input, [
    "now",
    "prepared",
    "solverResult",
    "userSignature",
  ], "solver contract signature authorization");
  const context = VERIFIED_RESULTS.get(source.solverResult);
  if (!context || context.prepared !== source.prepared) {
    throw new TypeError("contract authorization requires the original verified solver-signing result");
  }
  const observedAt = integer(
    source.now,
    "contract intent authorization time",
    source.prepared.preparedAt,
  );
  if (observedAt >= source.solverResult.expiresAt) {
    throw new Error("verified solver contract signature is expired");
  }
  return authorizeFinalizedContractIntent({
    now: observedAt,
    prepared: source.prepared,
    solverSignature: source.solverResult.solverSignature,
    userSignature: source.userSignature,
  });
}

export class SolverContractSigningError extends Error {
  constructor(message, { ambiguous, code }) {
    super(message);
    this.name = "SolverContractSigningError";
    this.ambiguous = ambiguous === true;
    this.code = code;
  }
}
