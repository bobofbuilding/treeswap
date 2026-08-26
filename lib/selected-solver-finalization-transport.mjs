import {
  createPrivateKey,
  createPublicKey,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { invoiceDigest as canonicalInvoiceDigest } from "./lnd-rest-client.mjs";
import {
  discardJsonResponseBody,
  readStrictJsonResponse,
} from "./private-json-response.mjs";
import { pinnedPublicSelectedSolverRequest } from "./solver-endpoint-transport.mjs";
import {
  solverEndpointPublicKeyDigest,
  verifiedSolverEndpointTransportBinding,
} from "./solver-capability.mjs";

export const SELECTED_SOLVER_FINALIZATION_REQUEST_SCHEMA =
  "treeswap.selected-solver-finalization-request.v1";
export const SELECTED_SOLVER_FINALIZATION_RESPONSE_SCHEMA =
  "treeswap.selected-solver-finalization-response.v1";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const NONZERO_BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const HEX_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const MAX_REQUEST_TTL_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 5;
const MAX_RESPONSE_BYTES = 65_536;
const DATE_NOW = Date.now.bind(Date);
const CLIENTS = new WeakMap();
const ATTEMPTS = new WeakMap();
const VERIFIED_PROVIDER_REQUESTS = new WeakSet();

const DISCLOSURE_FIELDS = Object.freeze([
  "beneficiary",
  "chainId",
  "direction",
  "exactBitOutputWei",
  "exactLightningOutputSats",
  "expiresAt",
  "invoice",
  "invoiceDigest",
  "maxFeeBps",
  "maxRoutingFeeSats",
  "paymentHash",
  "pricingCommitment",
  "requestId",
  "requestNonce",
  "selectedOfferId",
  "selectedSolver",
  "user",
  "verifyingContract",
]);
const REQUEST_FIELDS = Object.freeze([
  "capabilityDigest",
  "capacitySnapshotDigest",
  "direction",
  "disclosure",
  "disclosureDigest",
  "endpointPublicKeyDigest",
  "expiresAt",
  "requestId",
  "requestedAt",
  "requesterPublicKey",
  "requesterPublicKeyDigest",
  "schema",
  "signature",
  "solverId",
]);
const RESPONSE_FIELDS = Object.freeze([
  "capabilityDigest",
  "envelope",
  "expiresAt",
  "invoice",
  "requestDigest",
  "requestId",
  "schema",
  "servedAt",
  "signature",
  "solverId",
]);

function dataRecord(value, name, maximumFields = 64) {
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
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function exactRecord(value, expected, name) {
  const source = dataRecord(value, name, expected.length);
  const actual = Reflect.ownKeys(source).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return source;
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function decimal(value, name, maximumDigits = 78) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`${name} must be a canonical unsigned integer`);
  }
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${name} must be a canonical unsigned integer`);
  }
  const raw = String(value);
  if (!DECIMAL.test(raw) || raw.length > maximumDigits) {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
  return raw;
}

function bytes32(value, name, { nonzero = false } = {}) {
  const raw = String(value ?? "");
  if (!(nonzero ? NONZERO_BYTES32 : BYTES32).test(raw)) {
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

function direction(value) {
  const raw = String(value ?? "");
  if (!DIRECTIONS.has(raw)) throw new RangeError("selected-solver direction is unsupported");
  return raw;
}

function canonicalInvoice(value) {
  return String(value ?? "").trim().replace(/^lightning:/i, "").toLowerCase();
}

function snapshotJson(value, name, depth = 0) {
  if (depth > 5) throw new RangeError(`${name} nesting is outside policy`);
  if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError(`${name} must not contain a negative integer`);
    return value.toString();
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && Buffer.byteLength(value) > 8_192) {
      throw new RangeError(`${name} contains an oversized string`);
    }
    return value;
  }
  if (typeof value === "number") return integer(value, name);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
      throw new TypeError(`${name} must be a bounded plain array`);
    }
    const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
      throw new TypeError(`${name} must be dense and undecorated`);
    }
    return Object.freeze(value.map((item, index) => snapshotJson(item, `${name}[${index}]`, depth + 1)));
  }
  const source = dataRecord(value, name, 64);
  return Object.freeze(Object.fromEntries(Object.entries(source).map(([key, item]) => [
    key,
    snapshotJson(item, `${name}.${key}`, depth + 1),
  ])));
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function normalizeDisclosure(raw) {
  const source = exactRecord(raw, DISCLOSURE_FIELDS, "selected-solver disclosure");
  const invoice = String(source.invoice ?? "");
  if (Buffer.byteLength(invoice) > 4_096) throw new RangeError("selected-solver invoice is too long");
  const normalized = Object.freeze({
    requestId: bytes32(source.requestId, "disclosure.requestId", { nonzero: true }),
    pricingCommitment: bytes32(source.pricingCommitment, "disclosure.pricingCommitment", { nonzero: true }),
    direction: direction(source.direction),
    chainId: decimal(source.chainId, "disclosure.chainId"),
    verifyingContract: address(source.verifyingContract, "disclosure.verifyingContract"),
    user: address(source.user, "disclosure.user"),
    beneficiary: address(source.beneficiary, "disclosure.beneficiary"),
    paymentHash: bytes32(source.paymentHash, "disclosure.paymentHash"),
    invoiceDigest: bytes32(source.invoiceDigest, "disclosure.invoiceDigest"),
    invoice,
    selectedSolver: address(source.selectedSolver, "disclosure.selectedSolver"),
    selectedOfferId: bytes32(source.selectedOfferId, "disclosure.selectedOfferId", { nonzero: true }),
    requestNonce: decimal(source.requestNonce, "disclosure.requestNonce"),
    exactBitOutputWei: decimal(source.exactBitOutputWei, "disclosure.exactBitOutputWei"),
    exactLightningOutputSats: decimal(
      source.exactLightningOutputSats,
      "disclosure.exactLightningOutputSats",
      20,
    ),
    maxFeeBps: decimal(source.maxFeeBps, "disclosure.maxFeeBps", 5),
    maxRoutingFeeSats: decimal(source.maxRoutingFeeSats, "disclosure.maxRoutingFeeSats", 20),
    expiresAt: integer(source.expiresAt, "disclosure.expiresAt", 1),
  });
  const zero = `0x${"0".repeat(64)}`;
  if (normalized.direction === "bit-to-lightning") {
    if (!canonicalInvoice(invoice) || normalized.paymentHash === zero || normalized.invoiceDigest === zero
        || canonicalInvoiceDigest(canonicalInvoice(invoice)) !== normalized.invoiceDigest) {
      throw new Error("BIT-to-Lightning disclosure invoice commitments are invalid");
    }
  } else if (invoice || normalized.paymentHash !== zero || normalized.invoiceDigest !== zero) {
    throw new Error("Lightning-to-BIT disclosure must leave invoice commitments empty");
  }
  return normalized;
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

function unsignedRequest(request) {
  return Object.freeze(Object.fromEntries(REQUEST_FIELDS
    .filter((field) => field !== "signature")
    .map((field) => [field, request[field]])));
}

function expectedRequestId(request) {
  return keccak256(toUtf8Bytes(canonicalize({
    schema: request.schema,
    capabilityDigest: request.capabilityDigest,
    disclosureDigest: request.disclosureDigest,
    requesterPublicKeyDigest: request.requesterPublicKeyDigest,
  })));
}

export function selectedSolverFinalizationRequestDigest(raw) {
  const request = normalizeRequest(raw);
  return keccak256(toUtf8Bytes(canonicalize(unsignedRequest(request))));
}

function requestMessage(digest) {
  return Buffer.from(`TreeSwap selected solver finalization request v1\n${bytes32(digest, "request digest")}\n`, "utf8");
}

function normalizeRequest(raw) {
  const source = exactRecord(raw, REQUEST_FIELDS, "selected-solver finalization request");
  if (source.schema !== SELECTED_SOLVER_FINALIZATION_REQUEST_SCHEMA) {
    throw new Error("selected-solver finalization request schema is unsupported");
  }
  const disclosure = normalizeDisclosure(source.disclosure);
  const requester = publicKey(source.requesterPublicKey, "request requester key");
  const requesterPublicKey = requester.export({ format: "pem", type: "spki" }).toString();
  const requesterPublicKeyDigest = solverEndpointPublicKeyDigest(requesterPublicKey);
  if (requesterPublicKeyDigest !== bytes32(
    source.requesterPublicKeyDigest,
    "request.requesterPublicKeyDigest",
    { nonzero: true },
  )) throw new Error("selected-solver requester key digest changed");
  const requestedAt = integer(source.requestedAt, "request.requestedAt", 1);
  const expiresAt = integer(source.expiresAt, "request.expiresAt", requestedAt + 1);
  if (expiresAt - requestedAt > MAX_REQUEST_TTL_SECONDS || expiresAt > disclosure.expiresAt) {
    throw new RangeError("selected-solver finalization request lifetime is outside policy");
  }
  const disclosureDigest = keccak256(toUtf8Bytes(canonicalize(disclosure)));
  if (disclosureDigest !== bytes32(source.disclosureDigest, "request.disclosureDigest", { nonzero: true })) {
    throw new Error("selected-solver disclosure digest changed");
  }
  const signature = String(source.signature ?? "");
  if (!BASE64_SIGNATURE.test(signature)) throw new TypeError("selected-solver request signature is invalid");
  const request = Object.freeze({
    schema: SELECTED_SOLVER_FINALIZATION_REQUEST_SCHEMA,
    requestId: bytes32(source.requestId, "request.requestId", { nonzero: true }),
    capabilityDigest: bytes32(source.capabilityDigest, "request.capabilityDigest", { nonzero: true }),
    capacitySnapshotDigest: bytes32(
      source.capacitySnapshotDigest,
      "request.capacitySnapshotDigest",
      { nonzero: true },
    ),
    endpointPublicKeyDigest: bytes32(
      source.endpointPublicKeyDigest,
      "request.endpointPublicKeyDigest",
      { nonzero: true },
    ),
    solverId: address(source.solverId, "request.solverId"),
    direction: direction(source.direction),
    disclosureDigest,
    disclosure,
    requesterPublicKey,
    requesterPublicKeyDigest,
    requestedAt,
    expiresAt,
    signature,
  });
  if (request.requestId !== expectedRequestId(request)) {
    throw new Error("selected-solver finalization request identifier changed");
  }
  if (request.solverId !== disclosure.selectedSolver || request.direction !== disclosure.direction) {
    throw new Error("selected-solver finalization request changed its selected solver or direction");
  }
  return request;
}

export function verifySelectedSolverFinalizationRequest({ request, authority, now }) {
  const normalized = normalizeRequest(request);
  const expected = exactRecord(authority, [
    "capabilityDigest",
    "direction",
    "endpointPublicKeyDigest",
    "requesterPublicKeyDigest",
    "solverId",
  ], "selected-solver provider authority");
  const observedAt = integer(now, "now", 1);
  if (normalized.requestedAt > observedAt + MAX_CLOCK_SKEW_SECONDS || normalized.expiresAt <= observedAt) {
    throw new Error("selected-solver finalization request is outside its time window");
  }
  if (normalized.requesterPublicKeyDigest !== bytes32(
    expected.requesterPublicKeyDigest,
    "expected requester key digest",
    { nonzero: true },
  )) throw new Error("selected-solver finalization requester is not allowlisted");
  if (normalized.capabilityDigest !== bytes32(
    expected.capabilityDigest,
    "expected capability digest",
    { nonzero: true },
  ) || normalized.endpointPublicKeyDigest !== bytes32(
    expected.endpointPublicKeyDigest,
    "expected endpoint key digest",
    { nonzero: true },
  ) || normalized.solverId !== address(expected.solverId, "expected solver")
      || normalized.direction !== direction(expected.direction)) {
    throw new Error("selected-solver finalization request does not match provider authority");
  }
  const digest = keccak256(toUtf8Bytes(canonicalize(unsignedRequest(normalized))));
  if (!verifyMessage(
    null,
    requestMessage(digest),
    publicKey(normalized.requesterPublicKey, "request requester key"),
    Buffer.from(normalized.signature, "base64"),
  )) throw new Error("selected-solver finalization request signature is invalid");
  const verified = Object.freeze({ ...normalized, requestDigest: digest });
  VERIFIED_PROVIDER_REQUESTS.add(verified);
  return verified;
}

function unsignedResponse(response) {
  return Object.freeze(Object.fromEntries(RESPONSE_FIELDS
    .filter((field) => field !== "signature")
    .map((field) => [field, response[field]])));
}

function responseMessage(digest) {
  return Buffer.from(`TreeSwap selected solver finalization response v1\n${bytes32(digest, "response digest")}\n`, "utf8");
}

function normalizeEnvelope(raw) {
  const source = exactRecord(raw, ["offer", "signature"], "selected-solver executable envelope");
  const signature = String(source.signature ?? "");
  if (!HEX_SIGNATURE.test(signature)) throw new TypeError("selected-solver executable signature is invalid");
  return Object.freeze({
    offer: snapshotJson(source.offer, "selected-solver executable offer"),
    signature,
  });
}

function normalizeResponse(raw) {
  const source = exactRecord(raw, RESPONSE_FIELDS, "selected-solver finalization response");
  if (source.schema !== SELECTED_SOLVER_FINALIZATION_RESPONSE_SCHEMA) {
    throw new Error("selected-solver finalization response schema is unsupported");
  }
  const invoice = String(source.invoice ?? "");
  if (Buffer.byteLength(invoice) > 4_096) throw new RangeError("selected-solver response invoice is too long");
  const signature = String(source.signature ?? "");
  if (!BASE64_SIGNATURE.test(signature)) throw new TypeError("selected-solver response signature is invalid");
  return Object.freeze({
    schema: SELECTED_SOLVER_FINALIZATION_RESPONSE_SCHEMA,
    requestId: bytes32(source.requestId, "response.requestId", { nonzero: true }),
    requestDigest: bytes32(source.requestDigest, "response.requestDigest", { nonzero: true }),
    capabilityDigest: bytes32(source.capabilityDigest, "response.capabilityDigest", { nonzero: true }),
    solverId: address(source.solverId, "response.solverId"),
    invoice,
    envelope: normalizeEnvelope(source.envelope),
    servedAt: integer(source.servedAt, "response.servedAt", 1),
    expiresAt: integer(source.expiresAt, "response.expiresAt", 1),
    signature,
  });
}

export function selectedSolverFinalizationResponseDigest(raw) {
  const response = normalizeResponse(raw);
  return keccak256(toUtf8Bytes(canonicalize(unsignedResponse(response))));
}

export function buildSignedSelectedSolverFinalizationResponse({
  request,
  invoice,
  envelope,
  servedAt,
  expiresAt,
  endpointPrivateKey,
}) {
  if (!request || !VERIFIED_PROVIDER_REQUESTS.has(request)) {
    throw new TypeError("selected-solver response requires the original verified requester packet");
  }
  const key = privateKey(endpointPrivateKey, "selected-solver endpoint private key");
  const endpointPem = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
  if (solverEndpointPublicKeyDigest(endpointPem) !== request.endpointPublicKeyDigest) {
    throw new Error("selected-solver endpoint key does not match the requested capability");
  }
  const normalizedServedAt = integer(servedAt, "servedAt", request.requestedAt - MAX_CLOCK_SKEW_SECONDS);
  const normalizedExpiresAt = integer(expiresAt, "expiresAt", normalizedServedAt + 1, request.expiresAt);
  const unsigned = Object.freeze({
    schema: SELECTED_SOLVER_FINALIZATION_RESPONSE_SCHEMA,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    capabilityDigest: request.capabilityDigest,
    solverId: request.solverId,
    invoice: String(invoice ?? ""),
    envelope: normalizeEnvelope(envelope),
    servedAt: normalizedServedAt,
    expiresAt: normalizedExpiresAt,
  });
  const digest = keccak256(toUtf8Bytes(canonicalize(unsigned)));
  return Object.freeze({
    ...unsigned,
    signature: signMessage(null, responseMessage(digest), key).toString("base64"),
  });
}

function validateInvoiceBinding(response, request) {
  const invoice = canonicalInvoice(response.invoice);
  const offer = dataRecord(response.envelope.offer, "selected-solver executable offer", 64);
  const invoiceDigest = bytes32(offer.invoiceDigest, "offer.invoiceDigest", { nonzero: true });
  bytes32(offer.paymentHash, "offer.paymentHash", { nonzero: true });
  if (!invoice || canonicalInvoiceDigest(invoice) !== invoiceDigest) {
    throw new Error("selected-solver response invoice does not match its executable commitment");
  }
  if (request.direction === "bit-to-lightning" && invoice !== canonicalInvoice(request.disclosure.invoice)) {
    throw new Error("selected solver changed the user-provided Lightning invoice");
  }
}

function createSignedRequest({ binding, disclosure, requesterPrivateKey, requestedAt, expiresAt }) {
  const requesterPem = createPublicKey(requesterPrivateKey).export({ format: "pem", type: "spki" }).toString();
  const requesterPublicKeyDigest = solverEndpointPublicKeyDigest(requesterPem);
  const disclosureDigest = keccak256(toUtf8Bytes(canonicalize(disclosure)));
  const partial = Object.freeze({
    schema: SELECTED_SOLVER_FINALIZATION_REQUEST_SCHEMA,
    capabilityDigest: binding.capabilityDigest,
    capacitySnapshotDigest: binding.capacitySnapshotDigest,
    endpointPublicKeyDigest: binding.endpointPublicKeyDigest,
    solverId: binding.solverId,
    direction: binding.direction,
    disclosureDigest,
    disclosure,
    requesterPublicKey: requesterPem,
    requesterPublicKeyDigest,
    requestedAt,
    expiresAt,
  });
  const requestId = expectedRequestId(partial);
  const unsigned = Object.freeze({
    schema: partial.schema,
    requestId,
    capabilityDigest: partial.capabilityDigest,
    capacitySnapshotDigest: partial.capacitySnapshotDigest,
    endpointPublicKeyDigest: partial.endpointPublicKeyDigest,
    solverId: partial.solverId,
    direction: partial.direction,
    disclosureDigest: partial.disclosureDigest,
    disclosure: partial.disclosure,
    requesterPublicKey: partial.requesterPublicKey,
    requesterPublicKeyDigest: partial.requesterPublicKeyDigest,
    requestedAt: partial.requestedAt,
    expiresAt: partial.expiresAt,
  });
  const digest = keccak256(toUtf8Bytes(canonicalize(unsigned)));
  return normalizeRequest(Object.freeze({
    ...unsigned,
    signature: signMessage(null, requestMessage(digest), requesterPrivateKey).toString("base64"),
  }));
}

function abortSignal(value, name) {
  if (!(value instanceof AbortSignal) || value.aborted) throw new TypeError(`${name} must be active`);
  return value;
}

function createClient(input, mode, dependencies) {
  const expected = mode === "production"
    ? ["requesterPrivateKey", "signal"]
    : ["nowSeconds", "requestImpl", "requesterPrivateKey", "signal"];
  const source = exactRecord(input, expected, "selected-solver finalization client input");
  const requester = privateKey(source.requesterPrivateKey, "selected-solver requester private key");
  const signal = abortSignal(source.signal, "selected-solver client signal");
  if (typeof dependencies.nowSeconds !== "function" || (mode !== "production" && typeof dependencies.requestImpl !== "function")) {
    throw new TypeError("selected-solver client dependencies are invalid");
  }
  const context = {
    mode,
    nowSeconds: dependencies.nowSeconds,
    requestImpl: dependencies.requestImpl,
    requester,
    signal,
    state: "active",
  };
  const stop = () => { context.state = "stopped"; };
  signal.addEventListener("abort", stop, { once: true });
  const assertActive = () => {
    if (context.state !== "active" || signal.aborted) throw new Error("selected-solver finalization client is stopped");
  };

  const client = Object.freeze({
    prepare(inputValue) {
      if (this !== client || CLIENTS.get(this) !== context) {
        throw new TypeError("selected-solver client lacks factory provenance");
      }
      assertActive();
      const value = exactRecord(
        inputValue,
        ["capabilityVerification", "disclosure", "requestTtlSeconds"],
        "selected-solver finalization preparation",
      );
      const binding = verifiedSolverEndpointTransportBinding(value.capabilityVerification);
      const endpointPem = publicKey(binding.endpointPublicKey, "capability endpoint key")
        .export({ format: "pem", type: "spki" }).toString();
      if (solverEndpointPublicKeyDigest(endpointPem) !== binding.endpointPublicKeyDigest) {
        throw new Error("selected-solver capability endpoint key changed");
      }
      const disclosure = normalizeDisclosure(value.disclosure);
      if (disclosure.selectedSolver !== binding.solverId || disclosure.direction !== binding.direction) {
        throw new Error("selected-solver disclosure does not match the verified capability");
      }
      const requestedAt = integer(context.nowSeconds(), "selected-solver client time", 1);
      const ttl = integer(value.requestTtlSeconds, "selected-solver request TTL", 1, MAX_REQUEST_TTL_SECONDS);
      const expiresAt = Math.min(requestedAt + ttl, disclosure.expiresAt, binding.expiresAt);
      if (expiresAt <= requestedAt) throw new Error("selected-solver finalization authority is expired");
      const request = createSignedRequest({
        binding,
        disclosure,
        requesterPrivateKey: requester,
        requestedAt,
        expiresAt,
      });
      const attempt = Object.freeze({
        schema: "treeswap.selected-solver-finalization-attempt.v1",
        requestId: request.requestId,
        requestDigest: keccak256(toUtf8Bytes(canonicalize(unsignedRequest(request)))),
        solverId: binding.solverId,
        direction: binding.direction,
        expiresAt,
        fundingAuthorization: false,
        settlementAuthorization: false,
      });
      ATTEMPTS.set(attempt, {
        binding,
        capabilityVerification: value.capabilityVerification,
        client,
        inFlight: false,
        request,
        result: null,
      });
      return attempt;
    },

    async send(attempt) {
      if (this !== client || CLIENTS.get(this) !== context) {
        throw new TypeError("selected-solver client lacks factory provenance");
      }
      assertActive();
      const attemptContext = ATTEMPTS.get(attempt);
      if (!attemptContext || attemptContext.client !== client) {
        throw new TypeError("selected-solver send requires the original prepared attempt");
      }
      if (attemptContext.result) return attemptContext.result;
      if (attemptContext.inFlight) throw new Error("selected-solver finalization request is already in flight");
      const now = integer(context.nowSeconds(), "selected-solver client time", 1);
      if (attempt.expiresAt <= now) throw new Error("selected-solver finalization request is expired");
      attemptContext.inFlight = true;
      try {
        const response = await sendPreparedRequest({
          binding: attemptContext.binding,
          request: attemptContext.request,
          requestImpl: context.requestImpl,
          nowSeconds: context.nowSeconds,
          signal,
        });
        const result = Object.freeze({
          schema: "treeswap.verified-selected-solver-finalization.v1",
          requestId: attempt.requestId,
          requestDigest: attempt.requestDigest,
          responseDigest: response.responseDigest,
          solverId: attempt.solverId,
          direction: attempt.direction,
          invoice: response.invoice,
          envelope: response.envelope,
          servedAt: response.servedAt,
          expiresAt: response.expiresAt,
          channel: Object.freeze({
            authenticated: true,
            encrypted: true,
            peer: attempt.solverId,
          }),
          fundingAuthorization: false,
          settlementAuthorization: false,
        });
        attemptContext.result = result;
        return result;
      } finally {
        attemptContext.inFlight = false;
      }
    },

    status() {
      if (this !== client || CLIENTS.get(this) !== context) {
        throw new TypeError("selected-solver client lacks factory provenance");
      }
      return Object.freeze({
        schema: "treeswap.selected-solver-finalization-client-status.v1",
        state: context.state,
        mode: context.mode,
        networkListener: false,
        fundingAuthorization: false,
        settlementAuthorization: false,
      });
    },
  });
  CLIENTS.set(client, context);
  return client;
}

export function createSelectedSolverFinalizationClient(input) {
  return createClient(input, "production", {
    nowSeconds: () => Math.floor(DATE_NOW() / 1_000),
    requestImpl: null,
  });
}

export function createTestSelectedSolverFinalizationClient(input) {
  const source = exactRecord(
    input,
    ["nowSeconds", "requestImpl", "requesterPrivateKey", "signal"],
    "test selected-solver finalization client input",
  );
  return createClient(source, "injected-test", {
    nowSeconds: source.nowSeconds,
    requestImpl: source.requestImpl,
  });
}

export function selectedSolverFinalizationClientMode(value) {
  const context = CLIENTS.get(value);
  if (!context) throw new TypeError("selected-solver client lacks factory provenance");
  return context.mode;
}

export function assertSelectedSolverFinalizationClientLifecycle(value, signal) {
  const context = CLIENTS.get(value);
  if (!context) throw new TypeError("selected-solver client lacks factory provenance");
  if (signal !== context.signal || signal.aborted || context.state !== "active") {
    throw new TypeError("selected-solver client and consumer must share one active deployment lifecycle");
  }
  return value;
}

async function sendPreparedRequest({ binding, request, requestImpl, nowSeconds, signal }) {
  const endpoint = new URL("/v1/finalize", binding.endpointOrigin);
  const controller = new AbortController();
  const transportSignal = AbortSignal.any([controller.signal, signal]);
  const performRequest = requestImpl ?? ((url, options) => pinnedPublicSelectedSolverRequest(url, options, {
    maximumResponseBytes: MAX_RESPONSE_BYTES,
  }));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("selected-solver finalization request timed out"));
    }, 5_000);
  });
  let response;
  try {
    let raw;
    try {
      raw = await Promise.race([performRequest(endpoint, {
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
      throw new SelectedSolverFinalizationError("selected-solver transport is ambiguous", {
        ambiguous: true,
        code: "TRANSPORT_AMBIGUOUS",
      });
    }
    if (!raw || typeof raw !== "object" || raw.redirected === true || raw.status !== 200) {
      discardJsonResponseBody(raw);
      throw new SelectedSolverFinalizationError("selected-solver endpoint rejected the request", {
        ambiguous: false,
        code: "HTTP_REJECTED",
      });
    }
    try {
      response = normalizeResponse(await Promise.race([readStrictJsonResponse(raw, {
        label: "selected-solver finalization response",
        maximumResponseBytes: MAX_RESPONSE_BYTES,
        signal: transportSignal,
      }), timeout]));
    } catch (error) {
      if (error instanceof SelectedSolverFinalizationError) throw error;
      throw new SelectedSolverFinalizationError("selected-solver response is invalid", {
        ambiguous: false,
        code: "INVALID_RESPONSE",
      });
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const receivedAt = integer(nowSeconds(), "selected-solver client time", 1);
  const requestDigest = keccak256(toUtf8Bytes(canonicalize(unsignedRequest(request))));
  if (response.requestId !== request.requestId || response.requestDigest !== requestDigest
      || response.capabilityDigest !== binding.capabilityDigest || response.solverId !== binding.solverId) {
    throw new SelectedSolverFinalizationError("selected-solver response changed its request or authority", {
      ambiguous: false,
      code: "AUTHORITY_CHANGED",
    });
  }
  if (response.servedAt < request.requestedAt - MAX_CLOCK_SKEW_SECONDS
      || response.servedAt > receivedAt + MAX_CLOCK_SKEW_SECONDS
      || response.expiresAt <= receivedAt || response.expiresAt <= response.servedAt
      || response.expiresAt > request.expiresAt || response.expiresAt > binding.expiresAt) {
    throw new SelectedSolverFinalizationError("selected-solver response is outside its time window", {
      ambiguous: false,
      code: "STALE_RESPONSE",
    });
  }
  const responseDigest = keccak256(toUtf8Bytes(canonicalize(unsignedResponse(response))));
  if (!verifyMessage(
    null,
    responseMessage(responseDigest),
    publicKey(binding.endpointPublicKey, "capability endpoint key"),
    Buffer.from(response.signature, "base64"),
  )) {
    throw new SelectedSolverFinalizationError("selected-solver response signature is invalid", {
      ambiguous: false,
      code: "INVALID_RESPONSE_SIGNATURE",
    });
  }
  try {
    validateInvoiceBinding(response, request);
  } catch {
    throw new SelectedSolverFinalizationError("selected-solver response invoice binding is invalid", {
      ambiguous: false,
      code: "INVALID_INVOICE_BINDING",
    });
  }
  return Object.freeze({ ...response, responseDigest });
}

export class SelectedSolverFinalizationError extends Error {
  constructor(message, { ambiguous, code }) {
    super(message);
    this.name = "SelectedSolverFinalizationError";
    this.ambiguous = ambiguous === true;
    this.code = code;
  }
}
