import { getBytes } from "ethers";
import {
  Bolt11DecodeError,
  decodeBolt11Invoice,
  normalizeBolt11Invoice,
} from "./bolt11.mjs";
import { invoiceDigest as canonicalInvoiceDigest } from "./lnd-rest-client.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/;
const INPUT_FIELDS = Object.freeze(["now", "policy", "rawInvoice", "registry", "request"]);
const POLICY_FIELDS = Object.freeze([
  "allowHashedDescriptions",
  "maxExpirySeconds",
  "maxInvoiceLength",
  "maxRouteHints",
  "maximumFinalCltvDelta",
  "minimumFinalCltvDelta",
  "minimumRemainingSeconds",
]);
const REQUEST_FIELDS = Object.freeze([
  "amountSats",
  "childIndex",
  "expectedPayee",
  "fillAmountSats",
  "invoiceDigest",
  "parentIntentId",
  "paymentHash",
  "totalAmountSats",
]);
const REGISTRY_FIELDS = Object.freeze(["consumedPaymentHashes", "reservedPaymentHashes"]);

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

function exactDataArray(value, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 4_096) {
    throw new TypeError(`${name} must be a bounded plain array`);
  }
  const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size
      || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return Object.freeze(value.map((item, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name}[${index}] must be an enumerable data property`);
    }
    if (typeof descriptor.value !== "string" || !BYTES32.test(descriptor.value)) {
      throw new TypeError(`${name}[${index}] must be lowercase bytes32`);
    }
    return descriptor.value;
  }));
}

function uint(value, name) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${name} must be a non-negative integer`);
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(value, name) {
  if (value !== true && value !== false) throw new TypeError(`${name} must be a boolean`);
  return value;
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) throw new TypeError(`${name} must be lowercase bytes32`);
  return value;
}

function optionalPayee(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !COMPRESSED_PUBKEY.test(value.toLowerCase())) {
    throw new TypeError("request.expectedPayee must be a compressed secp256k1 public key or null");
  }
  return value.toLowerCase();
}

function addReason(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

function snapshotPolicy(value) {
  const source = exactDataRecord(value, POLICY_FIELDS, "invoice policy");
  const policy = Object.freeze({
    allowHashedDescriptions: boolean(source.allowHashedDescriptions, "policy.allowHashedDescriptions"),
    maxInvoiceLength: integer(source.maxInvoiceLength, "policy.maxInvoiceLength", 256, 8_192),
    maxExpirySeconds: integer(source.maxExpirySeconds, "policy.maxExpirySeconds", 1, 604_800),
    minimumRemainingSeconds: integer(
      source.minimumRemainingSeconds,
      "policy.minimumRemainingSeconds",
      1,
      86_400,
    ),
    minimumFinalCltvDelta: integer(
      source.minimumFinalCltvDelta,
      "policy.minimumFinalCltvDelta",
      1,
      2_016,
    ),
    maximumFinalCltvDelta: integer(
      source.maximumFinalCltvDelta,
      "policy.maximumFinalCltvDelta",
      1,
      2_016,
    ),
    maxRouteHints: integer(source.maxRouteHints, "policy.maxRouteHints", 0, 64),
  });
  if (policy.minimumFinalCltvDelta > policy.maximumFinalCltvDelta) {
    throw new RangeError("invoice final CLTV policy bounds are inverted");
  }
  if (policy.allowHashedDescriptions) {
    throw new RangeError("hashed invoice descriptions cannot be enabled without a verified preimage");
  }
  if (policy.minimumRemainingSeconds >= policy.maxExpirySeconds) {
    throw new RangeError("invoice remaining-time policy cannot reach its maximum expiry");
  }
  return policy;
}

export function validatedInvoicePolicy(value) {
  return snapshotPolicy(value);
}

function snapshotRequest(value) {
  const source = exactDataRecord(value, REQUEST_FIELDS, "invoice request");
  if (source.parentIntentId !== null || source.childIndex !== null) {
    if (source.parentIntentId !== null) bytes32(source.parentIntentId, "request.parentIntentId");
    if (source.childIndex !== null) integer(source.childIndex, "request.childIndex");
  }
  return Object.freeze({
    amountSats: uint(source.amountSats, "request.amountSats"),
    childIndex: source.childIndex,
    expectedPayee: optionalPayee(source.expectedPayee),
    fillAmountSats: uint(source.fillAmountSats, "request.fillAmountSats"),
    invoiceDigest: bytes32(source.invoiceDigest, "request.invoiceDigest"),
    parentIntentId: source.parentIntentId,
    paymentHash: bytes32(source.paymentHash, "request.paymentHash"),
    totalAmountSats: uint(source.totalAmountSats, "request.totalAmountSats"),
  });
}

function snapshotRegistry(value) {
  const source = exactDataRecord(value, REGISTRY_FIELDS, "invoice registry");
  return Object.freeze({
    consumedPaymentHashes: exactDataArray(source.consumedPaymentHashes, "registry.consumedPaymentHashes"),
    reservedPaymentHashes: exactDataArray(source.reservedPaymentHashes, "registry.reservedPaymentHashes"),
  });
}

export function validateFullFillInvoice(input) {
  const source = exactDataRecord(input, INPUT_FIELDS, "invoice validation input");
  if (typeof source.rawInvoice !== "string") throw new TypeError("rawInvoice must be a string");
  const observedAt = integer(source.now, "now", 1);
  const policy = snapshotPolicy(source.policy);
  const request = snapshotRequest(source.request);
  const registry = snapshotRegistry(source.registry);
  let invoice;
  let decoded;
  try {
    invoice = normalizeBolt11Invoice(source.rawInvoice);
    decoded = decodeBolt11Invoice(invoice, { maximumInvoiceLength: policy.maxInvoiceLength });
  } catch (error) {
    if (!(error instanceof Bolt11DecodeError)) throw error;
    return Object.freeze({
      valid: false,
      reasons: Object.freeze(["BOLT 11 invoice encoding, checksum, or signature is invalid"]),
      canonical: null,
    });
  }
  const reasons = [];
  const amountSats = decoded.amountMsat / 1_000n;
  const expiresAt = decoded.timestamp + decoded.expirySeconds;
  const invoiceDigest = canonicalInvoiceDigest(invoice);
  addReason(reasons, decoded.network !== "mainnet", "invoice network is not Bitcoin mainnet");
  addReason(reasons, invoiceDigest !== request.invoiceDigest, "invoice digest changed");
  addReason(reasons, decoded.amountMsat === 0n, "amountless invoices are not supported");
  addReason(reasons, decoded.amountMsat % 1_000n !== 0n, "invoice amount is not a whole satoshi");
  addReason(reasons, amountSats !== request.amountSats, "invoice amount changed");
  addReason(reasons, decoded.paymentHash !== request.paymentHash, "invoice payment hash changed");
  addReason(reasons, !BYTES32.test(decoded.paymentSecret), "invoice payment secret is required");
  try {
    addReason(reasons, getBytes(decoded.paymentSecret).every((value) => value === 0), "invoice payment secret cannot be zero");
  } catch {
    reasons.push("invoice payment secret is malformed");
  }
  addReason(reasons, !COMPRESSED_PUBKEY.test(decoded.destination), "invoice payee is invalid");
  if (request.expectedPayee !== null) {
    addReason(reasons, decoded.destination !== request.expectedPayee, "invoice payee changed");
  }
  addReason(reasons, decoded.timestamp > observedAt, "invoice timestamp is in the future");
  addReason(
    reasons,
    decoded.expirySeconds === 0 || decoded.expirySeconds > policy.maxExpirySeconds,
    "invoice expiry is unsupported",
  );
  addReason(
    reasons,
    expiresAt <= observedAt + policy.minimumRemainingSeconds,
    "invoice does not have enough safe time remaining",
  );
  addReason(
    reasons,
    decoded.minFinalCltvDelta < policy.minimumFinalCltvDelta
      || decoded.minFinalCltvDelta > policy.maximumFinalCltvDelta,
    "invoice final CLTV delta is outside policy",
  );
  addReason(reasons, decoded.amp === true, "AMP invoices are not supported");
  addReason(reasons, decoded.unknownRequiredFeatures.length > 0, "invoice has an unknown required feature");
  addReason(reasons, decoded.unsupportedRequiredFeatures.length > 0, "invoice requires an unsupported feature");
  addReason(reasons, decoded.routeHintCount > policy.maxRouteHints, "invoice has too many route hints");
  addReason(
    reasons,
    decoded.hasHashedDescription,
    "hashed invoice descriptions are not supported without their preimage",
  );
  addReason(
    reasons,
    request.fillAmountSats !== request.totalAmountSats,
    "partial fills are not supported",
  );
  addReason(reasons, request.parentIntentId !== null || request.childIndex !== null, "child intents are not supported in v1");
  const reserved = new Set(registry.reservedPaymentHashes);
  const consumed = new Set(registry.consumedPaymentHashes);
  addReason(reasons, reserved.has(decoded.paymentHash), "payment hash is already reserved");
  addReason(reasons, consumed.has(decoded.paymentHash), "payment hash was already consumed");

  return Object.freeze({
    valid: reasons.length === 0,
    reasons: Object.freeze(reasons),
    canonical: reasons.length === 0
      ? Object.freeze({
          invoice,
          invoiceDigest,
          paymentHash: decoded.paymentHash,
          paymentSecret: decoded.paymentSecret,
          destination: decoded.destination,
          amountSats,
          timestamp: decoded.timestamp,
          expiresAt,
          minFinalCltvDelta: decoded.minFinalCltvDelta,
          featureBits: decoded.featureBits,
          routeHintCount: decoded.routeHintCount,
          multiPartPaymentAllowedOnlyForSingleFullInvoice: decoded.basicMpp === true,
        })
      : null,
  });
}

export function reserveValidatedPaymentHash(registryValue, validation) {
  const registry = snapshotRegistry(registryValue);
  if (!validation?.valid || !validation.canonical) throw new Error("only a validated full-fill invoice can reserve a hash");
  const paymentHash = validation.canonical.paymentHash;
  if (!BYTES32.test(paymentHash)) throw new TypeError("validated payment hash is malformed");
  if (registry.reservedPaymentHashes.includes(paymentHash)
      || registry.consumedPaymentHashes.includes(paymentHash)) {
    throw new Error("validated payment hash is no longer unique");
  }
  return Object.freeze({
    reservedPaymentHashes: Object.freeze([...registry.reservedPaymentHashes, paymentHash]),
    consumedPaymentHashes: registry.consumedPaymentHashes,
  });
}
