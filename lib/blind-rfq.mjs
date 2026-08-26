import {
  getAddress,
  id,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
} from "ethers";
import { CoordinatorStore, coordinatorCommitmentDigest } from "./coordinator-store.mjs";
import { invoiceDigest as canonicalInvoiceDigest } from "./lnd-rest-client.mjs";
import {
  MAX_RFQ_DELIVERY_OFFER_CANDIDATES,
  rfqDeliveryPayloadDigest,
  verifiedRfqDeliveryCollection,
} from "./rfq-delivery.mjs";
import {
  EXECUTABLE_RFQ_OFFER_TYPES,
  rfqDomain,
  rfqRequestDigest,
  rfqRequestPayload,
  validateExecutableSolverOffer,
} from "./rfq.mjs";
import {
  assertCurrentBitRiskAttestation,
  bitRiskRequestDigest,
} from "./risk-policy.mjs";
import {
  verifiedSolverCapacityRecord,
  verifiedSolverQuoteBinding,
  verifiedSolverRecoveryAuthority,
} from "./solver-capability.mjs";
import {
  USER_EXECUTION_AUTHORIZATION_FIELDS,
  USER_EXECUTION_AUTHORIZATION_TYPES,
  USER_SELECTION_AUTHORIZATION_FIELDS,
  USER_SELECTION_AUTHORIZATION_TYPES,
  userAuthorizationDomain,
} from "./user-authorization-wallet.mjs";

export {
  USER_EXECUTION_AUTHORIZATION_TYPES,
  USER_SELECTION_AUTHORIZATION_TYPES,
  userAuthorizationDomain,
};

function frozenTypedFields(fields) {
  return Object.freeze(fields.map((field) => Object.freeze(field)));
}

const BLIND_OFFER_FIELDS = frozenTypedFields([
  { name: "offerId", type: "bytes32" },
  { name: "pricingId", type: "bytes32" },
  { name: "direction", type: "bytes32" },
  { name: "solver", type: "address" },
  { name: "grossBitAmount", type: "uint256" },
  { name: "feeBitAmount", type: "uint256" },
  { name: "lightningAmountSats", type: "uint64" },
  { name: "maxRoutingFeeSats", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "capacityEpoch", type: "uint64" },
  { name: "capabilityDigest", type: "bytes32" },
  { name: "capacitySnapshotDigest", type: "bytes32" },
  { name: "endpointPublicKeyDigest", type: "bytes32" },
  { name: "settlementContractCodeHash", type: "bytes32" },
  { name: "availableBitWei", type: "uint256" },
  { name: "availableLightningSats", type: "uint64" },
]);

export const BLIND_RFQ_OFFER_TYPES = Object.freeze({ BlindSolverOffer: BLIND_OFFER_FIELDS });

const BYTES32 = /^0x[0-9a-f]{64}$/;
const UINT_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const VERIFIED_BLIND_BOOKS = new WeakSet();
const BLIND_BOOK_CONTEXTS = new WeakMap();
const VERIFIED_BLIND_SELECTIONS = new WeakSet();
const BLIND_SELECTION_CONTEXTS = new WeakMap();
const VERIFIED_SELECTION_AUTHORIZATIONS = new WeakSet();
const SELECTION_AUTHORIZATION_CONTEXTS = new WeakMap();
const VERIFIED_BLIND_RESERVATIONS = new WeakSet();
const RESERVATION_BY_SELECTION = new WeakMap();
const RESERVATION_CONTEXTS = new WeakMap();
const VERIFIED_FINALIZATIONS = new WeakSet();
const FINALIZATION_BY_RESERVATION = new WeakMap();
const FINALIZATION_CONTEXTS = new WeakMap();
const VERIFIED_USER_AUTHORIZED_FINALIZATIONS = new WeakSet();
const AUTHORIZED_FINALIZATION_BY_CANDIDATE = new WeakMap();
const AUTHORIZED_FINALIZATION_CONTEXTS = new WeakMap();
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const BLIND_ENVELOPE_FIELDS = Object.freeze(["offer", "signature"]);
const BLIND_OFFER_VALIDATION_INPUT_FIELDS = Object.freeze([
  "capabilityVerification", "envelope", "now", "policy", "pricing",
]);
const BLIND_QUOTE_BOOK_INPUT_FIELDS = Object.freeze([
  "capabilityVerifications", "collection", "marketRiskAttestations", "now", "policy", "pricing",
]);
const COORDINATOR_METHODS = Object.freeze({
  acceptAuthorizedFirmOfferSettlement: CoordinatorStore.prototype.acceptAuthorizedFirmOfferSettlement,
  bindContractIntent: CoordinatorStore.prototype.bindContractIntent,
  bindFirmOfferExecution: CoordinatorStore.prototype.bindFirmOfferExecution,
  bindFirmOfferUserAuthorization: CoordinatorStore.prototype.bindFirmOfferUserAuthorization,
  getFirmOffer: CoordinatorStore.prototype.getFirmOffer,
  getRfqRequest: CoordinatorStore.prototype.getRfqRequest,
  getSettlement: CoordinatorStore.prototype.getSettlement,
  getSolverCapacity: CoordinatorStore.prototype.getSolverCapacity,
  reserveVerifiedFirmOffer: CoordinatorStore.prototype.reserveVerifiedFirmOffer,
});

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

function exactDataRecord(value, expected, name) {
  const source = dataRecord(value, name, expected.length);
  const keys = Reflect.ownKeys(source).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return source;
}

function exactKeys(value, expected, name) {
  exactDataRecord(value, expected, name);
}

function exactDataArray(value, name, maximumLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)
      || lengthDescriptor.enumerable !== false || lengthDescriptor.configurable !== false
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new RangeError(`${name} length is invalid or unbounded`);
  }
  if (lengthDescriptor.value > maximumLength) {
    throw new RangeError(`${name} exceeds the bounded candidate limit`);
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

function ownEnumerableDataValue(value, key, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`${name}.${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function uint(value, name, maximum) {
  let raw;
  if (typeof value === "string") raw = value;
  else if (typeof value === "bigint" && value >= 0n) raw = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) raw = String(value);
  else throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  if (!UINT_DECIMAL.test(raw) || raw.length > maximum.toString().length) {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
  const parsed = BigInt(raw);
  if (parsed > maximum) throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  return parsed;
}

function bytes32(value, name, { nonzero = false } = {}) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be ${nonzero ? "non-zero " : ""}lowercase bytes32`);
  }
  const raw = value;
  if (!BYTES32.test(raw) || (nonzero && raw === `0x${"00".repeat(32)}`)) {
    throw new TypeError(`${name} must be ${nonzero ? "non-zero " : ""}lowercase bytes32`);
  }
  return raw;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function exactString(left, right, name) {
  if (String(left) !== String(right)) throw new Error(`${name} changed`);
}

function exactAddress(left, right, name) {
  if (!sameAddress(left, right)) throw new Error(`${name} changed`);
}

function coordinatorAuthority(store) {
  if (!(store instanceof CoordinatorStore)) {
    throw new TypeError("blind quote reservation requires the durable coordinator store");
  }
  for (const [name, method] of Object.entries(COORDINATOR_METHODS)) {
    if (CoordinatorStore.prototype[name] !== method || store[name] !== method) {
      throw new TypeError("blind quote reservation requires unmodified coordinator store methods");
    }
  }
  return store;
}

function directionHash(direction) {
  if (direction !== "lightning-to-bit" && direction !== "bit-to-lightning") {
    throw new RangeError("blind RFQ direction is unsupported");
  }
  return id(direction);
}

function normalizedPricing(raw) {
  const source = exactDataRecord(raw, [
    "capacityEpoch", "chainId", "direction", "exactOutput", "expiresAt", "maxFeeBps",
    "maxRoutingFeeSats", "outputUnit", "pricingId",
  ], "blind pricing request");
  if (source.direction !== "lightning-to-bit" && source.direction !== "bit-to-lightning") {
    throw new RangeError("blind pricing direction is unsupported");
  }
  if (typeof source.outputUnit !== "string") throw new TypeError("blind pricing output unit must be a string");
  const outputUnit = source.outputUnit;
  if ((source.direction === "lightning-to-bit" && outputUnit !== "bit-wei")
      || (source.direction === "bit-to-lightning" && outputUnit !== "sats")) {
    throw new Error("blind pricing output unit changed");
  }
  const pricing = Object.freeze({
    pricingId: bytes32(source.pricingId, "pricing.pricingId", { nonzero: true }),
    direction: source.direction,
    chainId: integer(source.chainId, "pricing.chainId"),
    exactOutput: uint(source.exactOutput, "pricing.exactOutput", UINT256_MAX),
    outputUnit,
    maxFeeBps: uint(source.maxFeeBps, "pricing.maxFeeBps", 10_000n),
    maxRoutingFeeSats: uint(source.maxRoutingFeeSats, "pricing.maxRoutingFeeSats", UINT64_MAX),
    capacityEpoch: integer(source.capacityEpoch, "pricing.capacityEpoch"),
    expiresAt: integer(source.expiresAt, "pricing.expiresAt"),
  });
  if (pricing.exactOutput === 0n) throw new RangeError("blind pricing output must be positive");
  return pricing;
}

function serializedPricing(pricing) {
  return Object.freeze({
    pricingId: pricing.pricingId,
    direction: pricing.direction,
    chainId: pricing.chainId,
    exactOutput: pricing.exactOutput.toString(),
    outputUnit: pricing.outputUnit,
    maxFeeBps: pricing.maxFeeBps.toString(),
    maxRoutingFeeSats: pricing.maxRoutingFeeSats.toString(),
    capacityEpoch: pricing.capacityEpoch,
    expiresAt: pricing.expiresAt,
  });
}

function normalizedPolicy(raw) {
  const source = exactDataRecord(raw, [
    "bitToLightningContract", "bitToLightningContractCodeHash", "chainId", "lightningToBitContract",
    "lightningToBitContractCodeHash", "maxClockSkewSeconds", "maxOffersPerRequest",
    "marketRiskPolicyDigest", "maxQuoteTtlSeconds", "minimumIndependentSolvers",
  ], "blind RFQ policy");
  const policy = Object.freeze({
    chainId: uint(source.chainId, "policy.chainId", UINT256_MAX),
    lightningToBitContract: address(source.lightningToBitContract, "policy.lightningToBitContract"),
    bitToLightningContract: address(source.bitToLightningContract, "policy.bitToLightningContract"),
    lightningToBitContractCodeHash: bytes32(
      source.lightningToBitContractCodeHash,
      "policy.lightningToBitContractCodeHash",
    ),
    bitToLightningContractCodeHash: bytes32(
      source.bitToLightningContractCodeHash,
      "policy.bitToLightningContractCodeHash",
    ),
    marketRiskPolicyDigest: bytes32(
      source.marketRiskPolicyDigest,
      "policy.marketRiskPolicyDigest",
      { nonzero: true },
    ),
    maxClockSkewSeconds: integer(source.maxClockSkewSeconds, "policy.maxClockSkewSeconds", 60),
    maxOffersPerRequest: integer(source.maxOffersPerRequest, "policy.maxOffersPerRequest", 128),
    maxQuoteTtlSeconds: integer(source.maxQuoteTtlSeconds, "policy.maxQuoteTtlSeconds", 300),
    minimumIndependentSolvers: integer(source.minimumIndependentSolvers, "policy.minimumIndependentSolvers", 128),
  });
  if (policy.maxOffersPerRequest < 2 || policy.maxQuoteTtlSeconds === 0
      || policy.minimumIndependentSolvers < 2
      || policy.minimumIndependentSolvers > policy.maxOffersPerRequest) {
    throw new RangeError("blind RFQ policy limits are unsafe");
  }
  if (policy.lightningToBitContract === policy.bitToLightningContract) {
    throw new Error("blind RFQ settlement contracts must be direction-specific");
  }
  return policy;
}

function normalizedOffer(raw) {
  const source = exactDataRecord(raw, BLIND_OFFER_FIELDS.map(({ name }) => name), "blind solver offer");
  for (const field of [
    "offerId", "pricingId", "direction", "capabilityDigest", "capacitySnapshotDigest",
    "endpointPublicKeyDigest", "settlementContractCodeHash",
  ]) bytes32(source[field], `offer.${field}`, { nonzero: field === "offerId" || field === "pricingId" });
  return Object.freeze({
    offerId: source.offerId,
    pricingId: source.pricingId,
    direction: source.direction,
    solver: address(source.solver, "offer.solver"),
    grossBitAmount: uint(source.grossBitAmount, "offer.grossBitAmount", UINT256_MAX),
    feeBitAmount: uint(source.feeBitAmount, "offer.feeBitAmount", UINT256_MAX),
    lightningAmountSats: uint(source.lightningAmountSats, "offer.lightningAmountSats", UINT64_MAX),
    maxRoutingFeeSats: uint(source.maxRoutingFeeSats, "offer.maxRoutingFeeSats", UINT64_MAX),
    expiresAt: integer(source.expiresAt, "offer.expiresAt"),
    capacityEpoch: integer(source.capacityEpoch, "offer.capacityEpoch"),
    capabilityDigest: source.capabilityDigest,
    capacitySnapshotDigest: source.capacitySnapshotDigest,
    endpointPublicKeyDigest: source.endpointPublicKeyDigest,
    settlementContractCodeHash: source.settlementContractCodeHash,
    availableBitWei: uint(source.availableBitWei, "offer.availableBitWei", UINT256_MAX),
    availableLightningSats: uint(source.availableLightningSats, "offer.availableLightningSats", UINT64_MAX),
  });
}

export function blindRfqDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Blind RFQ",
    version: "1",
    chainId: uint(chainId, "chainId", UINT256_MAX),
    verifyingContract: address(verifyingContract, "verifyingContract"),
  });
}

function settlementContract(pricing, policy) {
  return pricing.direction === "lightning-to-bit"
    ? policy.lightningToBitContract
    : policy.bitToLightningContract;
}

function settlementCodeHash(pricing, policy) {
  return pricing.direction === "lightning-to-bit"
    ? policy.lightningToBitContractCodeHash
    : policy.bitToLightningContractCodeHash;
}

export function validateBlindSolverOffer(input) {
  const reasons = [];
  let observedAt;
  let boundPricing;
  let boundPolicy;
  let offer;
  let capability;
  let signature = "";
  try {
    const source = exactDataRecord(input, BLIND_OFFER_VALIDATION_INPUT_FIELDS, "blind offer validation input");
    const envelope = exactDataRecord(source.envelope, BLIND_ENVELOPE_FIELDS, "blind solver envelope");
    observedAt = integer(source.now, "now");
    boundPricing = normalizedPricing(source.pricing);
    boundPolicy = normalizedPolicy(source.policy);
    offer = normalizedOffer(envelope.offer);
    capability = verifiedSolverQuoteBinding(source.capabilityVerification);
    if (typeof envelope.signature !== "string") throw new TypeError("blind solver signature must be a string");
    signature = envelope.signature;
  } catch (error) {
    return Object.freeze({ valid: false, reasons: Object.freeze([error.message]) });
  }
  if (BigInt(boundPricing.chainId) !== boundPolicy.chainId) reasons.push("blind pricing chain changed");
  if (offer.pricingId !== boundPricing.pricingId) reasons.push("blind offer belongs to another pricing request");
  if (offer.direction !== directionHash(boundPricing.direction)) reasons.push("blind offer direction changed");
  if (offer.grossBitAmount === 0n || offer.lightningAmountSats === 0n || offer.feeBitAmount >= offer.grossBitAmount) {
    reasons.push("blind offer amount is invalid");
  }
  if (offer.expiresAt <= observedAt || offer.expiresAt > boundPricing.expiresAt
      || offer.expiresAt > observedAt + boundPolicy.maxQuoteTtlSeconds) {
    reasons.push("blind offer expiry is outside policy");
  }
  if (offer.maxRoutingFeeSats > boundPricing.maxRoutingFeeSats) reasons.push("blind offer routing cap changed");
  if (offer.feeBitAmount * 10_000n > offer.grossBitAmount * boundPricing.maxFeeBps) {
    reasons.push("blind offer BIT fee exceeds the user cap");
  }
  if (boundPricing.direction === "lightning-to-bit") {
    if (offer.grossBitAmount - offer.feeBitAmount !== boundPricing.exactOutput) {
      reasons.push("blind offer exact BIT output changed");
    }
  } else if (offer.lightningAmountSats !== boundPricing.exactOutput) {
    reasons.push("blind offer exact Lightning output changed");
  }
  if (BigInt(capability.chainId) !== boundPolicy.chainId) reasons.push("blind capability chain changed");
  if (capability.direction !== boundPricing.direction) reasons.push("blind capability direction changed");
  if (!sameAddress(capability.solverId, offer.solver)) reasons.push("blind capability belongs to another solver");
  if (!sameAddress(capability.settlementContract, settlementContract(boundPricing, boundPolicy))) {
    reasons.push("blind capability settlement contract changed");
  }
  if (offer.capabilityDigest !== capability.capabilityDigest) reasons.push("blind capability digest changed");
  if (offer.capacitySnapshotDigest !== capability.capacitySnapshotDigest) reasons.push("blind capacity snapshot changed");
  if (offer.endpointPublicKeyDigest !== capability.endpointPublicKeyDigest) reasons.push("blind endpoint key changed");
  if (offer.settlementContractCodeHash !== capability.settlementContractCodeHash
      || offer.settlementContractCodeHash !== settlementCodeHash(boundPricing, boundPolicy)) {
    reasons.push("blind settlement contract version changed");
  }
  if (offer.capacityEpoch !== capability.capacityEpoch || offer.capacityEpoch < boundPricing.capacityEpoch) {
    reasons.push("blind capacity epoch changed or predates the request minimum");
  }
  if (offer.availableBitWei !== BigInt(capability.availableBitWei)
      || offer.availableLightningSats !== BigInt(capability.availableLightningSats)) {
    reasons.push("blind verified capacity changed");
  }
  if (offer.expiresAt > capability.expiresAt) reasons.push("blind offer outlives the verified capability");
  if (boundPricing.direction === "lightning-to-bit") {
    if (offer.availableBitWei < offer.grossBitAmount) reasons.push("blind offer exceeds prefunded BIT inventory");
    if (offer.availableLightningSats < offer.lightningAmountSats) {
      reasons.push("blind offer exceeds verified inbound Lightning capacity");
    }
  } else {
    if (offer.availableBitWei !== 0n) reasons.push("blind BIT-to-Lightning offer must not claim BIT inventory");
    if (offer.availableLightningSats < offer.lightningAmountSats + offer.maxRoutingFeeSats) {
      reasons.push("blind offer exceeds verified outbound Lightning capacity");
    }
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    reasons.push("blind solver signature is not canonical");
  } else {
    try {
      const recovered = verifyTypedData(
        blindRfqDomain({ chainId: boundPolicy.chainId, verifyingContract: settlementContract(boundPricing, boundPolicy) }),
        BLIND_RFQ_OFFER_TYPES,
        offer,
        signature,
      );
      if (!sameAddress(recovered, offer.solver)) reasons.push("blind solver signature is invalid");
    } catch {
      reasons.push("blind solver signature is invalid");
    }
  }
  return Object.freeze({
    valid: reasons.length === 0,
    reasons: Object.freeze(reasons),
    ...(reasons.length === 0 ? { envelope: Object.freeze({ offer, signature }) } : {}),
  });
}

function inputAmount(direction, offer) {
  return direction === "lightning-to-bit" ? offer.lightningAmountSats : offer.grossBitAmount;
}

function marketRiskRequest(direction, offer, now) {
  return Object.freeze({
    now,
    direction,
    bitWei: offer.grossBitAmount - offer.feeBitAmount,
    lightningSats: offer.lightningAmountSats,
  });
}

function indexedMarketRiskAttestations(attestations) {
  const source = exactDataArray(
    attestations,
    "blind market-risk attestation set",
    MAX_RFQ_DELIVERY_OFFER_CANDIDATES,
  );
  const byRequest = new Map();
  for (const attestation of source) {
    const requestDigest = ownEnumerableDataValue(
      attestation,
      "requestDigest",
      "blind market-risk attestation",
    );
    if (!BYTES32.test(requestDigest) || requestDigest === ZERO_BYTES32) {
      throw new TypeError("blind market-risk attestation request digest is invalid");
    }
    if (byRequest.has(requestDigest)) {
      throw new Error("blind market-risk attestation set contains a duplicate request");
    }
    byRequest.set(requestDigest, attestation);
  }
  return byRequest;
}

function semanticEnvelopeKey(pricing, policy, envelope) {
  try {
    const digest = TypedDataEncoder.hash(
      blindRfqDomain({ chainId: policy.chainId, verifyingContract: settlementContract(pricing, policy) }),
      BLIND_RFQ_OFFER_TYPES,
      envelope.offer,
    );
    return `${digest}:${String(envelope.signature).toLowerCase()}`;
  } catch {
    return `invalid:${keccak256(toUtf8Bytes(JSON.stringify(envelope)))}`;
  }
}

export function buildMultipathBlindQuoteBook(input) {
  const source = exactDataRecord(input, BLIND_QUOTE_BOOK_INPUT_FIELDS, "blind quote-book input");
  const boundPricing = normalizedPricing(source.pricing);
  const boundPolicy = normalizedPolicy(source.policy);
  const observedAt = integer(source.now, "now");
  const marketRiskByRequest = indexedMarketRiskAttestations(source.marketRiskAttestations);
  const delivery = verifiedRfqDeliveryCollection(source.collection);
  const serialized = serializedPricing(boundPricing);
  const pricingDigest = rfqDeliveryPayloadDigest(serialized);
  if (delivery.requestId !== boundPricing.pricingId || delivery.requestDigest !== pricingDigest
      || delivery.rfqPayloadDigest !== pricingDigest) {
    throw new Error("RFQ delivery collection belongs to a different blind pricing request");
  }
  const capabilityVerifications = exactDataArray(
    source.capabilityVerifications,
    "blind capability verification set",
    MAX_RFQ_DELIVERY_OFFER_CANDIDATES,
  );
  const capabilityBySolver = new Map();
  for (const verification of capabilityVerifications) {
    const binding = verifiedSolverQuoteBinding(verification);
    const solver = binding.solverId.toLowerCase();
    if (capabilityBySolver.has(solver)) throw new Error("blind capability set contains a duplicate solver");
    capabilityBySolver.set(solver, verification);
  }

  const uniqueRaw = new Map();
  const exactPaths = new Map();
  for (const pathDelivery of delivery.deliveries) {
    for (const envelope of pathDelivery.envelopes) {
      const fingerprint = keccak256(toUtf8Bytes(JSON.stringify(envelope)));
      const paths = exactPaths.get(fingerprint) ?? [];
      if (!paths.some((path) => path.pathId === pathDelivery.path.pathId)) {
        paths.push(Object.freeze({ kind: pathDelivery.path.kind, pathId: pathDelivery.path.pathId }));
      }
      exactPaths.set(fingerprint, paths);
      const candidate = Object.freeze({
        source: pathDelivery.path.pathId,
        receivedAt: pathDelivery.receivedAt,
        offer: envelope.offer,
        signature: envelope.signature,
      });
      const prior = uniqueRaw.get(fingerprint);
      if (!prior || candidate.receivedAt < prior.receivedAt
          || (candidate.receivedAt === prior.receivedAt && candidate.source < prior.source)) {
        uniqueRaw.set(fingerprint, candidate);
      }
    }
  }
  if (uniqueRaw.size > MAX_RFQ_DELIVERY_OFFER_CANDIDATES) {
    throw new RangeError("blind quote response exceeds the bounded candidate limit");
  }
  const offerPaths = new Map();
  for (const [fingerprint, envelope] of uniqueRaw) {
    const key = semanticEnvelopeKey(boundPricing, boundPolicy, envelope);
    const paths = offerPaths.get(key) ?? [];
    for (const path of exactPaths.get(fingerprint) ?? []) {
      if (!paths.some((known) => known.pathId === path.pathId)) paths.push(path);
    }
    offerPaths.set(key, paths);
  }

  const rejected = [];
  const valid = [];
  const seenOfferIds = new Set();
  for (const envelope of uniqueRaw.values()) {
    let capabilityVerification = null;
    try {
      capabilityVerification = capabilityBySolver.get(address(envelope.offer?.solver, "offer.solver").toLowerCase()) ?? null;
    } catch {
      capabilityVerification = null;
    }
    const result = validateBlindSolverOffer({
      pricing: boundPricing,
      envelope: Object.freeze({ offer: envelope.offer, signature: envelope.signature }),
      capabilityVerification,
      now: observedAt,
      policy: boundPolicy,
    });
    const offerId = result.envelope?.offer.offerId ?? envelope.offer?.offerId ?? "unknown";
    let marketRiskAttestation = null;
    if (result.valid) {
      const request = marketRiskRequest(boundPricing.direction, result.envelope.offer, observedAt);
      marketRiskAttestation = marketRiskByRequest.get(bitRiskRequestDigest(request)) ?? null;
      try {
        assertCurrentBitRiskAttestation({
          attestation: marketRiskAttestation,
          request,
          now: observedAt,
          requiredValidUntil: result.envelope.offer.expiresAt,
        });
        if (marketRiskAttestation.policyDigest !== boundPolicy.marketRiskPolicyDigest) {
          throw new Error("market-risk attestation uses an unreviewed policy");
        }
      } catch {
        marketRiskAttestation = null;
      }
    }
    if (!result.valid || marketRiskAttestation === null || seenOfferIds.has(offerId)) {
      rejected.push(Object.freeze({
        offerId,
        reasons: Object.freeze(!result.valid
          ? [...result.reasons]
          : marketRiskAttestation === null
            ? ["blind offer lacks current market-risk authorization through expiry"]
            : ["duplicate blind offer identifier"]),
      }));
      continue;
    }
    seenOfferIds.add(offerId);
    valid.push(Object.freeze({
      source: envelope.source,
      receivedAt: envelope.receivedAt,
      ...result.envelope,
      marketRiskDigest: marketRiskAttestation.riskDigest,
      marketRiskPolicyDigest: marketRiskAttestation.policyDigest,
      marketRiskValidUntil: marketRiskAttestation.validUntil,
    }));
  }
  valid.sort((left, right) => {
    const leftInput = inputAmount(boundPricing.direction, left.offer);
    const rightInput = inputAmount(boundPricing.direction, right.offer);
    if (leftInput !== rightInput) return leftInput < rightInput ? -1 : 1;
    if (left.receivedAt !== right.receivedAt) return left.receivedAt - right.receivedAt;
    return left.offer.offerId.localeCompare(right.offer.offerId);
  });
  const offers = [];
  const seenSolvers = new Set();
  for (const envelope of valid) {
    const solver = envelope.offer.solver.toLowerCase();
    if (seenSolvers.has(solver)) {
      rejected.push(Object.freeze({
        offerId: envelope.offer.offerId,
        reasons: Object.freeze(["only the best valid blind offer per solver is retained"]),
      }));
      continue;
    }
    seenSolvers.add(solver);
    if (offers.length >= boundPolicy.maxOffersPerRequest) {
      rejected.push(Object.freeze({
        offerId: envelope.offer.offerId,
        reasons: Object.freeze(["valid blind offer is outside the deterministic retained-offer limit"]),
      }));
      continue;
    }
    offers.push(envelope);
  }
  if (offers.length < boundPolicy.minimumIndependentSolvers) {
    throw new RangeError("not enough independent valid blind solver offers");
  }
  const relayPaths = new Set();
  const directPaths = new Set();
  for (const envelope of offers) {
    const key = semanticEnvelopeKey(boundPricing, boundPolicy, envelope);
    for (const path of offerPaths.get(key) ?? []) {
      if (path.kind === "relay") relayPaths.add(path.pathId);
      if (path.kind === "direct-solver") directPaths.add(path.pathId);
    }
  }
  if (relayPaths.size < delivery.minimumRelayPaths || directPaths.size < delivery.minimumDirectSolverPaths) {
    throw new RangeError("not enough authenticated delivery paths supplied valid blind offers");
  }
  const verifyingContract = settlementContract(boundPricing, boundPolicy);
  const offerReceipt = offers.map((envelope) => ({
    offerDigest: TypedDataEncoder.hash(
      blindRfqDomain({ chainId: boundPolicy.chainId, verifyingContract }),
      BLIND_RFQ_OFFER_TYPES,
      envelope.offer,
    ),
    source: envelope.source,
    receivedAt: envelope.receivedAt,
    signature: envelope.signature,
    marketRiskDigest: envelope.marketRiskDigest,
    marketRiskPolicyDigest: envelope.marketRiskPolicyDigest,
    marketRiskValidUntil: envelope.marketRiskValidUntil.toString(),
  }));
  const offerReceiptDigest = keccak256(toUtf8Bytes(JSON.stringify(offerReceipt)));
  const receiptDigest = keccak256(toUtf8Bytes(JSON.stringify({
    schema: "treeswap.blind-multipath-received-set.v2",
    pricingDigest,
    deliveryCollectionDigest: delivery.collectionDigest,
    offerReceiptDigest,
  })));
  const book = Object.freeze({
    pricingId: boundPricing.pricingId,
    pricingDigest,
    pricing: serialized,
    label: "Best received quote",
    marketRiskBound: true,
    marketRiskPolicyDigest: boundPolicy.marketRiskPolicyDigest,
    deliveryAuthenticated: true,
    deliveryCollectionDigest: delivery.collectionDigest,
    deliveryAttemptCount: delivery.attemptCount,
    deliveryFailureCount: delivery.failures.length,
    relayPathCount: delivery.relayCount,
    directSolverPathCount: delivery.directSolverCount,
    relayOfferPathCount: relayPaths.size,
    directSolverOfferPathCount: directPaths.size,
    solverCount: offers.length,
    offers: Object.freeze(offers),
    rejected: Object.freeze(rejected),
    offerReceiptDigest,
    receiptDigest,
  });
  VERIFIED_BLIND_BOOKS.add(book);
  BLIND_BOOK_CONTEXTS.set(book, Object.freeze({
    capabilityBySolver,
    verifyingContract,
    offerDigests: new Map(offerReceipt.map(({ offerDigest }, index) => [offers[index].offer.offerId, offerDigest])),
  }));
  return book;
}

export function verifiedBlindQuoteBook(book) {
  if (!book || !VERIFIED_BLIND_BOOKS.has(book)) {
    throw new TypeError("blind quote book must be built from an authenticated complete delivery collection");
  }
  return book;
}

export function verifiedBlindQuoteSelection(selection) {
  if (!selection || !VERIFIED_BLIND_SELECTIONS.has(selection)) {
    throw new TypeError("blind quote selection must come from one locally verified blind quote book");
  }
  return selection;
}

export function assertBlindQuoteSelectionCapability(selection, capabilityVerification) {
  verifiedBlindQuoteSelection(selection);
  const context = BLIND_SELECTION_CONTEXTS.get(selection);
  if (!context || context.capabilityVerification !== capabilityVerification) {
    throw new TypeError("blind quote selection capability is not the exact locally verified capability");
  }
  return selection;
}

export function selectBlindQuote(book, offerId) {
  verifiedBlindQuoteBook(book);
  const selected = book.offers.find((envelope) => envelope.offer.offerId === offerId);
  if (!selected) throw new RangeError("selected blind quote is not in the verified received set");
  const context = BLIND_BOOK_CONTEXTS.get(book);
  const selectedBlindOfferDigest = context?.offerDigests.get(selected.offer.offerId);
  if (!selectedBlindOfferDigest) throw new Error("selected blind quote digest is unavailable");
  const selection = Object.freeze({
    pricingId: book.pricingId,
    pricingDigest: book.pricingDigest,
    pricing: book.pricing,
    receivedSetDigest: book.receiptDigest,
    selectedBlindOfferDigest,
    marketRiskDigest: selected.marketRiskDigest,
    marketRiskPolicyDigest: selected.marketRiskPolicyDigest,
    marketRiskValidUntil: selected.marketRiskValidUntil,
    selected,
    requiresPrivatePeerDisclosure: true,
    requiresExactUserAuthorization: true,
  });
  VERIFIED_BLIND_SELECTIONS.add(selection);
  BLIND_SELECTION_CONTEXTS.set(selection, Object.freeze({
    book,
    capabilityVerification: context.capabilityBySolver.get(selected.offer.solver.toLowerCase()),
    verifyingContract: context.verifyingContract,
  }));
  return selection;
}

function assertAuthorizationWindow({ authorizationExpiresAt, quoteExpiresAt, now = null }) {
  const expiresAt = integer(authorizationExpiresAt, "authorizationExpiresAt");
  if (expiresAt > integer(quoteExpiresAt, "quoteExpiresAt")) {
    throw new RangeError("user authorization outlives the selected quote");
  }
  if (now !== null) {
    const observedAt = integer(now, "now");
    if (expiresAt <= observedAt || expiresAt - observedAt > 120) {
      throw new RangeError("user authorization is expired or exceeds its short-lived limit");
    }
  }
  return expiresAt;
}

function selectionAuthorizationMaterial({ selection, request, authorizationExpiresAt }) {
  if (!selection || !VERIFIED_BLIND_SELECTIONS.has(selection)) {
    throw new TypeError("user authorization requires one locally selected authenticated blind quote");
  }
  const selectionContext = BLIND_SELECTION_CONTEXTS.get(selection);
  if (!selectionContext) throw new TypeError("blind selection provenance is unavailable");
  const requestPayload = rfqRequestPayload(request);
  assertPrivateRequestMatchesPricing(requestPayload, selection.pricing);
  if (!sameAddress(requestPayload.verifyingContract, selectionContext.verifyingContract)) {
    throw new Error("private settlement contract changed before user authorization");
  }
  if (requestPayload.direction === "lightning-to-bit") {
    if (requestPayload.paymentHash !== ZERO_BYTES32 || requestPayload.invoiceDigest !== ZERO_BYTES32) {
      throw new Error("Lightning-to-BIT selection must not prebind a solver invoice");
    }
  } else if (requestPayload.paymentHash === ZERO_BYTES32 || requestPayload.invoiceDigest === ZERO_BYTES32) {
    throw new Error("BIT-to-Lightning selection must bind the user's exact invoice commitments");
  }
  const blind = selection.selected.offer;
  const expiresAt = assertAuthorizationWindow({
    authorizationExpiresAt,
    quoteExpiresAt: Math.min(requestPayload.expiresAt, blind.expiresAt),
  });
  const domain = userAuthorizationDomain({
    chainId: requestPayload.chainId,
    verifyingContract: requestPayload.verifyingContract,
  });
  const message = Object.freeze({
    pricingId: selection.pricingId,
    pricingDigest: selection.pricingDigest,
    receivedSetDigest: selection.receivedSetDigest,
    selectedBlindOfferDigest: selection.selectedBlindOfferDigest,
    requestId: requestPayload.requestId,
    requestDigest: rfqRequestDigest(request),
    direction: id(requestPayload.direction),
    user: requestPayload.user,
    beneficiary: requestPayload.beneficiary,
    selectedSolver: blind.solver,
    grossBitAmount: blind.grossBitAmount,
    feeBitAmount: blind.feeBitAmount,
    lightningAmountSats: blind.lightningAmountSats,
    maxRoutingFeeSats: blind.maxRoutingFeeSats,
    paymentHash: requestPayload.paymentHash,
    invoiceDigest: requestPayload.invoiceDigest,
    requestNonce: requestPayload.nonce,
    quoteExpiresAt: blind.expiresAt,
    authorizationExpiresAt: expiresAt,
  });
  return Object.freeze({
    domain,
    types: USER_SELECTION_AUTHORIZATION_TYPES,
    message,
    digest: TypedDataEncoder.hash(domain, USER_SELECTION_AUTHORIZATION_TYPES, message),
  });
}

export function buildBlindQuoteSelectionAuthorization(input) {
  return selectionAuthorizationMaterial(input);
}

export function verifyBlindQuoteSelectionAuthorization({
  selection,
  request,
  authorization,
  signature,
  now,
}) {
  const expected = selectionAuthorizationMaterial({
    selection,
    request,
    authorizationExpiresAt: authorization?.authorizationExpiresAt,
  });
  exactKeys(
    authorization,
    USER_SELECTION_AUTHORIZATION_FIELDS.map(({ name }) => name),
    "user selection authorization",
  );
  assertAuthorizationWindow({
    authorizationExpiresAt: authorization.authorizationExpiresAt,
    quoteExpiresAt: expected.message.quoteExpiresAt,
    now,
  });
  const actualDigest = TypedDataEncoder.hash(
    expected.domain,
    USER_SELECTION_AUTHORIZATION_TYPES,
    authorization,
  );
  if (actualDigest !== expected.digest) throw new Error("user selection authorization changed exact quote terms");
  let signer;
  try {
    signer = verifyTypedData(
      expected.domain,
      USER_SELECTION_AUTHORIZATION_TYPES,
      authorization,
      String(signature ?? ""),
    );
  } catch {
    throw new Error("user selection authorization signature is invalid");
  }
  if (!sameAddress(signer, expected.message.user)) {
    throw new Error("user selection authorization signer does not match the exact RFQ user");
  }
  const verification = Object.freeze({
    schema: "treeswap.user-selection-authorization.v1",
    user: expected.message.user,
    requestDigest: expected.message.requestDigest,
    selectionAuthorizationDigest: expected.digest,
    authorizationExpiresAt: expected.message.authorizationExpiresAt,
    verifiedAt: integer(now, "now"),
  });
  VERIFIED_SELECTION_AUTHORIZATIONS.add(verification);
  SELECTION_AUTHORIZATION_CONTEXTS.set(verification, Object.freeze({
    requestId: expected.message.requestId,
    requestNonce: expected.message.requestNonce.toString(),
    selection,
  }));
  return verification;
}

function assertPrivateRequestMatchesPricing(requestPayload, pricing) {
  if (requestPayload.direction !== pricing.direction || Number(requestPayload.chainId) !== pricing.chainId) {
    throw new Error("private settlement request changed the blind direction or chain");
  }
  const exactOutput = pricing.direction === "lightning-to-bit"
    ? requestPayload.exactBitOutputWei
    : requestPayload.exactLightningOutputSats;
  if (exactOutput !== pricing.exactOutput || requestPayload.maxFeeBps !== pricing.maxFeeBps
      || requestPayload.maxRoutingFeeSats !== pricing.maxRoutingFeeSats
      || requestPayload.expiresAt !== pricing.expiresAt) {
    throw new Error("private settlement request changed the blind price limits");
  }
}

function assertCapabilityMatchesSelection(selection, selectionContext, capabilityVerification) {
  if (selectionContext.capabilityVerification !== capabilityVerification) {
    throw new TypeError("reservation requires the exact locally verified capability used for blind selection");
  }
  const binding = verifiedSolverQuoteBinding(capabilityVerification);
  const blind = selection.selected.offer;
  exactString(binding.chainId, selection.pricing.chainId, "verified capability chain");
  exactString(binding.direction, selection.pricing.direction, "verified capability direction");
  exactAddress(binding.solverId, blind.solver, "verified capability solver");
  exactAddress(binding.settlementContract, selectionContext.verifyingContract, "verified settlement contract");
  for (const field of [
    "capabilityDigest", "capacitySnapshotDigest", "endpointPublicKeyDigest",
    "settlementContractCodeHash", "capacityEpoch", "availableBitWei", "availableLightningSats",
  ]) exactString(binding[field], blind[field], `verified ${field}`);
  if (binding.expiresAt < blind.expiresAt) throw new Error("verified capability expires before the blind offer");
  return Object.freeze({ binding, capacity: verifiedSolverCapacityRecord(capabilityVerification) });
}

function assertStoredCapacityMatches(capacityRecord, expected) {
  if (!capacityRecord) throw new Error("selected solver has no durable verified capacity record");
  exactAddress(capacityRecord.solverId, expected.solverId, "durable capacity solver");
  exactString(capacityRecord.capabilityDigest, expected.capabilityDigest, "durable capability digest");
  exactString(capacityRecord.capabilityExpiresAt, expected.capabilityExpiresAt, "durable capability expiry");
  exactString(capacityRecord.capacityEpoch, expected.capacityEpoch, "durable capacity epoch");
  exactString(capacityRecord.capacityObservedAt, expected.observedAt, "durable capacity observation");
  exactString(capacityRecord.availableBitWei, expected.availableBitWei, "durable BIT capacity");
  exactString(
    capacityRecord.availableLightningSats,
    expected.availableLightningSats,
    "durable Lightning capacity",
  );
  const snapshotDigest = coordinatorCommitmentDigest({
    solverId: String(expected.solverId).toLowerCase(),
    capabilityDigest: expected.capabilityDigest,
    capabilityExpiresAt: expected.capabilityExpiresAt,
    capacityEpoch: expected.capacityEpoch,
    capacityObservedAt: expected.observedAt,
    availableBitWei: expected.availableBitWei,
    availableLightningSats: expected.availableLightningSats,
  });
  exactString(capacityRecord.snapshotDigest, snapshotDigest, "durable capacity snapshot digest");
  if (capacityRecord.suspended || capacityRecord.capacityConflict) {
    throw new Error("selected solver durable capacity is suspended or conflicted");
  }
  return snapshotDigest;
}

function assertActiveRfqMatches(rfq, selection, now) {
  if (!rfq || rfq.state !== "ACTIVE") throw new Error("blind quote reservation requires an active durable RFQ");
  exactString(rfq.requestId, selection.pricingId, "durable RFQ identifier");
  exactString(rfq.direction, selection.pricing.direction, "durable RFQ direction");
  exactString(rfq.notionalSats, selection.selected.offer.lightningAmountSats, "durable RFQ notional");
  exactString(rfq.expiresAt, selection.pricing.expiresAt, "durable RFQ expiry");
  if (rfq.expiresAt <= now) throw new Error("durable RFQ is expired");
  return rfq;
}

function assertFirmRecordMatches(
  record,
  selection,
  reservation = null,
  selectionAuthorizationDigest = null,
  selectionAuthorizationExpiresAt = null,
) {
  if (!record) throw new Error("blind quote reservation record is missing");
  const blind = selection.selected.offer;
  const bitAmountWei = selection.pricing.direction === "lightning-to-bit" ? blind.grossBitAmount : 0n;
  const lightningAmountSats = selection.pricing.direction === "bit-to-lightning"
    ? blind.lightningAmountSats + blind.maxRoutingFeeSats
    : blind.lightningAmountSats;
  const amount = selection.pricing.direction === "lightning-to-bit" ? bitAmountWei : lightningAmountSats;
  exactString(record.offerId, blind.offerId, "durable offer identifier");
  exactString(record.offerDigest, selection.selectedBlindOfferDigest, "durable blind offer digest");
  exactString(record.marketRiskDigest, selection.marketRiskDigest, "durable market-risk digest");
  exactString(
    record.marketRiskPolicyDigest,
    selection.marketRiskPolicyDigest,
    "durable market-risk policy digest",
  );
  exactString(
    record.marketRiskValidUntil,
    selection.marketRiskValidUntil,
    "durable market-risk validity",
  );
  if (selectionAuthorizationDigest) {
    exactString(
      record.selectionAuthorizationDigest,
      selectionAuthorizationDigest,
      "durable user selection authorization digest",
    );
  }
  if (selectionAuthorizationExpiresAt !== null) {
    exactString(
      record.selectionAuthorizationExpiresAt,
      selectionAuthorizationExpiresAt,
      "durable user selection authorization expiry",
    );
  }
  exactString(record.requestId, selection.pricingId, "durable offer RFQ");
  exactAddress(record.solverId, blind.solver, "durable offer solver");
  exactString(record.capabilityDigest, blind.capabilityDigest, "durable offer capability digest");
  exactString(record.direction, selection.pricing.direction, "durable offer direction");
  exactString(record.amount, amount, "durable reserved amount");
  exactString(record.bitAmountWei, bitAmountWei, "durable reserved BIT amount");
  exactString(record.lightningAmountSats, lightningAmountSats, "durable reserved Lightning amount");
  exactString(record.capacityEpoch, blind.capacityEpoch, "durable offer capacity epoch");
  exactString(record.expiresAt, blind.expiresAt, "durable offer expiry");
  if (reservation) {
    exactString(record.recordDigest, reservation.firmRecordDigest, "durable firm record digest");
    exactString(record.reservedAt, reservation.reservedAt, "durable offer reservation time");
  }
  return String(amount);
}

export function reserveSelectedBlindQuote({
  selection,
  userAuthorization,
  capabilityVerification,
  coordinatorStore,
  admissionPolicy,
  now,
}) {
  if (!selection || !VERIFIED_BLIND_SELECTIONS.has(selection)) {
    throw new TypeError("reservation requires one locally selected authenticated blind quote");
  }
  const observedAt = integer(now, "now");
  if (!userAuthorization || !VERIFIED_SELECTION_AUTHORIZATIONS.has(userAuthorization)) {
    throw new TypeError("reservation requires the exact verified user selection authorization");
  }
  const authorizationContext = SELECTION_AUTHORIZATION_CONTEXTS.get(userAuthorization);
  if (authorizationContext?.selection !== selection) {
    throw new Error("user selection authorization does not match the selected quote");
  }
  if (userAuthorization.verifiedAt > observedAt) {
    throw new Error("user selection authorization verification is from the future");
  }
  if (userAuthorization.authorizationExpiresAt <= observedAt) {
    throw new Error("user selection authorization is expired");
  }
  const prior = RESERVATION_BY_SELECTION.get(selection);
  if (prior) {
    const priorContext = RESERVATION_CONTEXTS.get(prior);
    const selectionContext = BLIND_SELECTION_CONTEXTS.get(selection);
    if (priorContext?.store !== coordinatorStore
        || selectionContext?.capabilityVerification !== capabilityVerification
        || priorContext?.userAuthorization?.selectionAuthorizationDigest
          !== userAuthorization.selectionAuthorizationDigest
        || priorContext?.userAuthorization?.requestDigest !== userAuthorization.requestDigest
        || priorContext?.userAuthorization?.authorizationExpiresAt
          !== userAuthorization.authorizationExpiresAt) {
      throw new TypeError("blind selection is already bound to another durable reservation authority");
    }
    return activeBlindQuoteReservationBinding(prior, { now: observedAt });
  }
  const store = coordinatorAuthority(coordinatorStore);
  const selectionContext = BLIND_SELECTION_CONTEXTS.get(selection);
  if (!selectionContext) throw new TypeError("blind selection provenance is unavailable");
  const { capacity } = assertCapabilityMatchesSelection(selection, selectionContext, capabilityVerification);
  const storedCapacity = COORDINATOR_METHODS.getSolverCapacity.call(store, capacity.solverId);
  const capacitySnapshotDigest = assertStoredCapacityMatches(storedCapacity, capacity);
  assertActiveRfqMatches(
    COORDINATOR_METHODS.getRfqRequest.call(store, selection.pricingId),
    selection,
    observedAt,
  );
  const blind = selection.selected.offer;
  const record = COORDINATOR_METHODS.reserveVerifiedFirmOffer.call(store, {
    offerId: blind.offerId,
    offerDigest: selection.selectedBlindOfferDigest,
    marketRiskDigest: selection.marketRiskDigest,
    marketRiskPolicyDigest: selection.marketRiskPolicyDigest,
    marketRiskValidUntil: Number(selection.marketRiskValidUntil),
    selectionAuthorizationDigest: userAuthorization.selectionAuthorizationDigest,
    selectionAuthorizationExpiresAt: userAuthorization.authorizationExpiresAt,
    requestId: selection.pricingId,
    solverId: blind.solver.toLowerCase(),
    offer: {
      direction: selection.pricing.direction,
      capabilityDigest: blind.capabilityDigest,
      bitAmountWei: selection.pricing.direction === "lightning-to-bit"
        ? blind.grossBitAmount.toString()
        : "0",
      lightningAmountSats: blind.lightningAmountSats.toString(),
      maxRoutingFeeSats: blind.maxRoutingFeeSats.toString(),
      capacityEpoch: blind.capacityEpoch,
      expiresAt: blind.expiresAt,
      signatureVerified: true,
    },
    policy: admissionPolicy,
    now: observedAt,
  });
  const amount = assertFirmRecordMatches(
    record,
    selection,
    null,
    userAuthorization.selectionAuthorizationDigest,
    userAuthorization.authorizationExpiresAt,
  );
  if (record.state !== "ACTIVE" || record.expiresAt <= observedAt) {
    throw new Error("blind offer was not reserved as an active durable record");
  }
  const reservation = Object.freeze({
    schema: "treeswap.blind-offer-reservation.v2",
    pricingId: selection.pricingId,
    receivedSetDigest: selection.receivedSetDigest,
    selectedBlindOfferDigest: selection.selectedBlindOfferDigest,
    marketRiskDigest: selection.marketRiskDigest,
    marketRiskPolicyDigest: selection.marketRiskPolicyDigest,
    marketRiskValidUntil: Number(selection.marketRiskValidUntil),
    selectedOfferId: blind.offerId,
    selectedSolver: blind.solver,
    direction: selection.pricing.direction,
    amount,
    capacityEpoch: blind.capacityEpoch,
    expiresAt: blind.expiresAt,
    firmRecordDigest: record.recordDigest,
    reservedAt: record.reservedAt,
    state: "ACTIVE",
  });
  VERIFIED_BLIND_RESERVATIONS.add(reservation);
  RESERVATION_BY_SELECTION.set(selection, reservation);
  RESERVATION_CONTEXTS.set(reservation, Object.freeze({
    capacitySnapshotDigest,
    expectedCapacity: capacity,
    selection,
    store,
    userAuthorization,
  }));
  return reservation;
}

export function activeBlindQuoteReservationBinding(reservation, { now }) {
  if (!reservation || !VERIFIED_BLIND_RESERVATIONS.has(reservation)) {
    throw new TypeError("private disclosure requires a module-private blind-offer reservation");
  }
  const observedAt = integer(now, "now");
  const context = RESERVATION_CONTEXTS.get(reservation);
  const store = coordinatorAuthority(context?.store);
  if (observedAt < reservation.reservedAt) throw new Error("blind reservation clock moved backward");
  if (context.userAuthorization.authorizationExpiresAt <= observedAt) {
    throw new Error("user selection authorization is expired");
  }
  const record = COORDINATOR_METHODS.getFirmOffer.call(store, reservation.selectedOfferId);
  assertFirmRecordMatches(
    record,
    context.selection,
    reservation,
    context.userAuthorization.selectionAuthorizationDigest,
    context.userAuthorization.authorizationExpiresAt,
  );
  if (record.state !== "ACTIVE" || record.expiresAt <= observedAt) {
    throw new Error("blind offer reservation is no longer active");
  }
  assertActiveRfqMatches(
    COORDINATOR_METHODS.getRfqRequest.call(store, reservation.pricingId),
    context.selection,
    observedAt,
  );
  const capacityRecord = COORDINATOR_METHODS.getSolverCapacity.call(store, reservation.selectedSolver.toLowerCase());
  const capacitySnapshotDigest = assertStoredCapacityMatches(capacityRecord, context.expectedCapacity);
  exactString(capacitySnapshotDigest, context.capacitySnapshotDigest, "reserved capacity snapshot");
  const finalization = FINALIZATION_BY_RESERVATION.get(reservation);
  if (finalization) {
    exactString(record.privateRequestDigest, finalization.requestDigest, "durable private request digest");
    exactString(record.executableOfferDigest, finalization.executableOfferDigest, "durable executable offer digest");
    exactString(record.executionBindingDigest, finalization.executionBindingDigest, "durable execution binding");
    exactString(record.finalizedAt, finalization.finalizedAt, "durable finalization time");
    const authorized = AUTHORIZED_FINALIZATION_BY_CANDIDATE.get(finalization);
    if (authorized) {
      exactString(
        record.executionAuthorizationDigest,
        authorized.userAuthorizationDigest,
        "durable user execution authorization digest",
      );
      exactString(record.authorizedAt, authorized.userAuthorizedAt, "durable user authorization time");
      exactString(
        record.executionAuthorizationExpiresAt,
        authorized.userAuthorizationExpiresAt,
        "durable user execution authorization expiry",
      );
    }
  }
  return reservation;
}

export function buildSelectedSolverDisclosure({
  request,
  reservation,
  invoice,
  channel,
  now,
  maxDisclosureTtlSeconds = 120,
}) {
  const observedAt = integer(now, "now");
  const active = activeBlindQuoteReservationBinding(reservation, { now: observedAt });
  const reservationContext = RESERVATION_CONTEXTS.get(active);
  const selection = reservationContext.selection;
  const firmRecord = COORDINATOR_METHODS.getFirmOffer.call(
    reservationContext.store,
    active.selectedOfferId,
  );
  if (firmRecord.executionBindingDigest) {
    throw new Error("private disclosure is already bound to an executable quote");
  }
  const requestPayload = rfqRequestPayload(request);
  assertPrivateRequestMatchesPricing(requestPayload, selection.pricing);
  const userAuthorization = reservationContext.userAuthorization;
  const userAuthorizationContext = SELECTION_AUTHORIZATION_CONTEXTS.get(userAuthorization);
  exactString(rfqRequestDigest(request), userAuthorization.requestDigest, "user-authorized private request digest");
  exactString(requestPayload.requestId, userAuthorizationContext.requestId, "user-authorized private request identifier");
  exactString(requestPayload.nonce, userAuthorizationContext.requestNonce, "user-authorized private request nonce");
  exactAddress(requestPayload.user, userAuthorization.user, "user-authorized RFQ user");
  if (!sameAddress(requestPayload.verifyingContract, BLIND_SELECTION_CONTEXTS.get(selection).verifyingContract)) {
    throw new Error("private settlement contract changed after blind selection");
  }
  if (channel?.authenticated !== true || channel?.encrypted !== true
      || !sameAddress(channel?.peer, active.selectedSolver)) {
    throw new TypeError("selected solver disclosure requires an authenticated encrypted peer-bound channel");
  }
  const expiresAt = Math.min(requestPayload.expiresAt, active.expiresAt);
  const disclosureTtl = integer(maxDisclosureTtlSeconds, "maxDisclosureTtlSeconds");
  if (disclosureTtl === 0 || disclosureTtl > 120) {
    throw new RangeError("private disclosure lifetime is outside policy");
  }
  if (expiresAt <= observedAt || expiresAt - observedAt > disclosureTtl) {
    throw new RangeError("private disclosure is expired or exceeds its short-lived limit");
  }
  if (requestPayload.requestId === active.pricingId) {
    throw new TypeError("public pricing and private settlement identifiers must be unlinkable");
  }
  const privateInvoice = String(invoice ?? "");
  if (privateInvoice.length > 4096) throw new RangeError("private invoice is too long");
  const packet = {
    requestId: requestPayload.requestId,
    pricingCommitment: keccak256(toUtf8Bytes(`${active.pricingId}:${active.selectedOfferId}`)),
    direction: requestPayload.direction,
    chainId: requestPayload.chainId,
    verifyingContract: requestPayload.verifyingContract,
    user: requestPayload.user,
    beneficiary: requestPayload.beneficiary,
    paymentHash: requestPayload.paymentHash,
    invoiceDigest: requestPayload.invoiceDigest,
    invoice: privateInvoice,
    selectedSolver: active.selectedSolver,
    selectedOfferId: active.selectedOfferId,
    requestNonce: requestPayload.nonce,
    exactBitOutputWei: requestPayload.exactBitOutputWei,
    exactLightningOutputSats: requestPayload.exactLightningOutputSats,
    maxFeeBps: requestPayload.maxFeeBps,
    maxRoutingFeeSats: requestPayload.maxRoutingFeeSats,
    expiresAt,
  };
  if (packet.direction === "bit-to-lightning") {
    if (!packet.invoice) throw new RangeError("BIT-to-Lightning private invoice is missing");
    if (packet.paymentHash === ZERO_BYTES32 || packet.invoiceDigest === ZERO_BYTES32) {
      throw new RangeError("BIT-to-Lightning private invoice commitments are missing");
    }
    if (canonicalInvoiceDigest(packet.invoice.trim().replace(/^lightning:/i, "").toLowerCase())
        !== packet.invoiceDigest) {
      throw new RangeError("BIT-to-Lightning private invoice does not match its commitment");
    }
  } else if (packet.invoice || packet.paymentHash !== ZERO_BYTES32 || packet.invoiceDigest !== ZERO_BYTES32) {
    throw new RangeError("Lightning-to-BIT disclosure must leave solver invoice fields unbound");
  }
  return Object.freeze(packet);
}

export function finalizeSelectedBlindQuote({
  request,
  reservation,
  envelope,
  capabilityVerification,
  now,
  quotePolicy,
}) {
  const active = activeBlindQuoteReservationBinding(reservation, { now });
  const selection = RESERVATION_CONTEXTS.get(active).selection;
  const selectionContext = BLIND_SELECTION_CONTEXTS.get(selection);
  assertCapabilityMatchesSelection(selection, selectionContext, capabilityVerification);
  const requestPayload = rfqRequestPayload(request);
  assertPrivateRequestMatchesPricing(requestPayload, selection.pricing);
  const reservationContext = RESERVATION_CONTEXTS.get(active);
  const userAuthorization = reservationContext.userAuthorization;
  const userAuthorizationContext = SELECTION_AUTHORIZATION_CONTEXTS.get(userAuthorization);
  exactString(rfqRequestDigest(request), userAuthorization.requestDigest, "user-authorized private request digest");
  exactString(requestPayload.requestId, userAuthorizationContext.requestId, "user-authorized private request identifier");
  exactString(requestPayload.nonce, userAuthorizationContext.requestNonce, "user-authorized private request nonce");
  exactAddress(requestPayload.user, userAuthorization.user, "user-authorized RFQ user");
  if (!sameAddress(requestPayload.verifyingContract, selectionContext.verifyingContract)) {
    throw new Error("private settlement contract changed after blind selection");
  }
  const result = validateExecutableSolverOffer({
    request,
    envelope: {
      source: "selected-private-endpoint",
      receivedAt: integer(now, "now"),
      offer: envelope?.offer,
      signature: envelope?.signature,
    },
    capabilityVerification,
    now,
    policy: quotePolicy,
  });
  if (!result.valid) throw new Error(`selected solver executable quote is invalid: ${result.reasons.join("; ")}`);
  const blind = selection.selected.offer;
  const executable = result.envelope.offer;
  for (const field of [
    "offerId", "solver", "grossBitAmount", "feeBitAmount", "lightningAmountSats", "maxRoutingFeeSats",
    "capacityEpoch", "capabilityDigest", "capacitySnapshotDigest", "endpointPublicKeyDigest",
    "settlementContractCodeHash", "availableBitWei", "availableLightningSats",
  ]) {
    const left = typeof blind[field] === "bigint" ? blind[field].toString() : String(blind[field]).toLowerCase();
    const right = typeof executable[field] === "bigint"
      ? executable[field].toString()
      : String(executable[field]).toLowerCase();
    if (left !== right) throw new Error(`selected solver changed ${field} after blind selection`);
  }
  if (executable.expiresAt > blind.expiresAt) throw new Error("selected solver extended expiry after blind selection");
  const requestDigest = rfqRequestDigest(request);
  const executableOfferDigest = TypedDataEncoder.hash(
    rfqDomain(request),
    EXECUTABLE_RFQ_OFFER_TYPES,
    executable,
  );
  const executionRecord = COORDINATOR_METHODS.bindFirmOfferExecution.call(reservationContext.store, {
    offerId: blind.offerId,
    privateRequestDigest: requestDigest,
    executableOfferDigest,
    finalizedAt: integer(now, "now"),
  });
  exactString(executionRecord.offerId, active.selectedOfferId, "executable firm offer identifier");
  exactString(executionRecord.privateRequestDigest, requestDigest, "executable private request digest");
  exactString(executionRecord.executableOfferDigest, executableOfferDigest, "executable offer digest");
  if (!executionRecord.executionBindingDigest) throw new Error("executable quote binding is missing");
  const prior = FINALIZATION_BY_RESERVATION.get(active);
  if (prior) {
    exactString(prior.requestDigest, requestDigest, "idempotent private request digest");
    exactString(prior.executableOfferDigest, executableOfferDigest, "idempotent executable offer digest");
    return prior;
  }
  const finalization = Object.freeze({
    pricingId: selection.pricingId,
    pricingDigest: selection.pricingDigest,
    receivedSetDigest: selection.receivedSetDigest,
    selectedBlindOfferDigest: selection.selectedBlindOfferDigest,
    requestId: requestPayload.requestId,
    requestDigest,
    executableOfferDigest,
    executionBindingDigest: executionRecord.executionBindingDigest,
    finalizedAt: executionRecord.finalizedAt,
    envelope: result.envelope,
    requiresExactUserAuthorization: true,
  });
  VERIFIED_FINALIZATIONS.add(finalization);
  FINALIZATION_BY_RESERVATION.set(active, finalization);
  FINALIZATION_CONTEXTS.set(finalization, Object.freeze({ reservation: active, request }));
  return finalization;
}

function executionAuthorizationMaterial({ request, finalization, authorizationExpiresAt }) {
  if (!finalization || !VERIFIED_FINALIZATIONS.has(finalization)) {
    throw new TypeError("user authorization requires a locally finalized executable quote");
  }
  const finalizationContext = FINALIZATION_CONTEXTS.get(finalization);
  const reservationContext = RESERVATION_CONTEXTS.get(finalizationContext?.reservation);
  const selectionAuthorization = reservationContext?.userAuthorization;
  if (!selectionAuthorization || !VERIFIED_SELECTION_AUTHORIZATIONS.has(selectionAuthorization)) {
    throw new TypeError("finalized quote is missing verified selection authorization provenance");
  }
  const requestPayload = rfqRequestPayload(request);
  exactString(rfqRequestDigest(request), finalization.requestDigest, "final user-authorization request digest");
  exactAddress(requestPayload.user, selectionAuthorization.user, "final user-authorization RFQ user");
  const offer = finalization.envelope.offer;
  const expiresAt = assertAuthorizationWindow({
    authorizationExpiresAt,
    quoteExpiresAt: Math.min(offer.expiresAt, selectionAuthorization.authorizationExpiresAt),
  });
  const domain = userAuthorizationDomain({
    chainId: requestPayload.chainId,
    verifyingContract: requestPayload.verifyingContract,
  });
  const message = Object.freeze({
    selectionAuthorizationDigest: selectionAuthorization.selectionAuthorizationDigest,
    requestDigest: finalization.requestDigest,
    executableOfferDigest: finalization.executableOfferDigest,
    executionBindingDigest: finalization.executionBindingDigest,
    direction: id(requestPayload.direction),
    user: requestPayload.user,
    beneficiary: requestPayload.beneficiary,
    selectedSolver: offer.solver,
    grossBitAmount: offer.grossBitAmount,
    feeBitAmount: offer.feeBitAmount,
    lightningAmountSats: offer.lightningAmountSats,
    maxRoutingFeeSats: offer.maxRoutingFeeSats,
    paymentHash: offer.paymentHash,
    invoiceDigest: offer.invoiceDigest,
    quoteExpiresAt: offer.expiresAt,
    authorizationExpiresAt: expiresAt,
  });
  return Object.freeze({
    domain,
    types: USER_EXECUTION_AUTHORIZATION_TYPES,
    message,
    digest: TypedDataEncoder.hash(domain, USER_EXECUTION_AUTHORIZATION_TYPES, message),
  });
}

export function buildFinalizedQuoteUserAuthorization(input) {
  return executionAuthorizationMaterial(input);
}

export function authorizeFinalizedBlindQuote({
  request,
  finalization,
  authorization,
  signature,
  now,
}) {
  const expected = executionAuthorizationMaterial({
    request,
    finalization,
    authorizationExpiresAt: authorization?.authorizationExpiresAt,
  });
  exactKeys(
    authorization,
    USER_EXECUTION_AUTHORIZATION_FIELDS.map(({ name }) => name),
    "user execution authorization",
  );
  assertAuthorizationWindow({
    authorizationExpiresAt: authorization.authorizationExpiresAt,
    quoteExpiresAt: expected.message.authorizationExpiresAt,
    now,
  });
  const actualDigest = TypedDataEncoder.hash(
    expected.domain,
    USER_EXECUTION_AUTHORIZATION_TYPES,
    authorization,
  );
  if (actualDigest !== expected.digest) throw new Error("user execution authorization changed exact quote or invoice terms");
  let signer;
  try {
    signer = verifyTypedData(
      expected.domain,
      USER_EXECUTION_AUTHORIZATION_TYPES,
      authorization,
      String(signature ?? ""),
    );
  } catch {
    throw new Error("user execution authorization signature is invalid");
  }
  if (!sameAddress(signer, expected.message.user)) {
    throw new Error("user execution authorization signer does not match the exact RFQ user");
  }
  const finalizationContext = FINALIZATION_CONTEXTS.get(finalization);
  const reservation = activeBlindQuoteReservationBinding(finalizationContext.reservation, { now });
  const reservationContext = RESERVATION_CONTEXTS.get(reservation);
  const authorizedAt = integer(now, "now");
  const prior = AUTHORIZED_FINALIZATION_BY_CANDIDATE.get(finalization);
  if (prior) {
    exactString(prior.userAuthorizationDigest, expected.digest, "idempotent user authorization digest");
    assertAuthorizedSettlementBinding(prior);
    return prior;
  }
  const requestPayload = rfqRequestPayload(finalizationContext.request);
  const selection = reservationContext.selection;
  const offer = finalization.envelope.offer;
  const handoff = COORDINATOR_METHODS.acceptAuthorizedFirmOfferSettlement.call(
    reservationContext.store,
    {
      offerId: reservation.selectedOfferId,
      executionBindingDigest: finalization.executionBindingDigest,
      executionAuthorizationDigest: expected.digest,
      authorizationExpiresAt: expected.message.authorizationExpiresAt,
      authorizedAt,
      settlement: {
        settlementId: requestPayload.requestId,
        pricingId: selection.pricingId,
        direction: requestPayload.direction,
        nonceAuthorityDigest: reservationContext.userAuthorization.selectionAuthorizationDigest,
        intentNonce: requestPayload.nonce,
        intentDigest: expected.digest,
        paymentHash: offer.paymentHash,
        invoiceDigest: offer.invoiceDigest,
        amountSats: offer.lightningAmountSats.toString(),
        quoteReceiptDigest: selection.receivedSetDigest,
        selectedSetDigest: selection.selectedBlindOfferDigest,
        selectedOfferId: reservation.selectedOfferId,
        capacityEpoch: offer.capacityEpoch,
        createdAt: authorizedAt,
      },
    },
  );
  const record = handoff.offer;
  exactString(record.executionAuthorizationDigest, expected.digest, "persisted user execution authorization digest");
  exactString(
    record.executionAuthorizationExpiresAt,
    expected.message.authorizationExpiresAt,
    "persisted user execution authorization expiry",
  );
  exactString(record.authorizedAt, authorizedAt, "persisted user authorization time");
  exactString(handoff.settlement.settlementId, requestPayload.requestId, "durable private settlement identifier");
  exactString(handoff.settlement.pricingId, selection.pricingId, "durable public pricing identifier");
  exactString(handoff.settlement.intentDigest, expected.digest, "durable settlement authorization digest");
  exactString(handoff.settlement.paymentHash, offer.paymentHash, "durable settlement payment hash");
  exactString(handoff.settlement.invoiceDigest, offer.invoiceDigest, "durable settlement invoice digest");
  exactString(
    handoff.settlement.quoteReceiptDigest,
    selection.receivedSetDigest,
    "durable received quote-set digest",
  );
  exactString(
    handoff.settlement.selectedSetDigest,
    selection.selectedBlindOfferDigest,
    "durable selected-offer digest",
  );
  const authorized = Object.freeze({
    ...finalization,
    settlementId: handoff.settlement.settlementId,
    settlementRecordDigest: handoff.settlement.recordDigest,
    userAuthorizationDigest: expected.digest,
    userAuthorizationExpiresAt: expected.message.authorizationExpiresAt,
    userAuthorizedAt: authorizedAt,
    requiresExactUserAuthorization: false,
  });
  VERIFIED_USER_AUTHORIZED_FINALIZATIONS.add(authorized);
  AUTHORIZED_FINALIZATION_BY_CANDIDATE.set(finalization, authorized);
  AUTHORIZED_FINALIZATION_CONTEXTS.set(authorized, Object.freeze({
    candidate: finalization,
    reservation,
  }));
  return authorized;
}

function assertAuthorizedSettlementBinding(authorized) {
  const context = AUTHORIZED_FINALIZATION_CONTEXTS.get(authorized);
  const candidate = context?.candidate;
  const reservation = context?.reservation;
  const reservationContext = RESERVATION_CONTEXTS.get(reservation);
  const finalizationContext = FINALIZATION_CONTEXTS.get(candidate);
  if (!candidate || !reservation || !reservationContext || !finalizationContext) {
    throw new TypeError("authorized settlement provenance is unavailable");
  }
  const store = coordinatorAuthority(reservationContext.store);
  const settlement = COORDINATOR_METHODS.getSettlement.call(store, authorized.settlementId);
  const request = rfqRequestPayload(finalizationContext.request);
  const selection = reservationContext.selection;
  const offer = candidate.envelope.offer;
  if (!settlement) throw new Error("durable authorized settlement is missing");
  exactString(settlement.recordDigest, authorized.settlementRecordDigest, "durable settlement record digest");
  exactString(settlement.settlementId, request.requestId, "durable private settlement identifier");
  exactString(settlement.pricingId, selection.pricingId, "durable settlement pricing identifier");
  exactString(settlement.direction, request.direction, "durable settlement direction");
  exactString(
    settlement.nonceAuthorityDigest,
    reservationContext.userAuthorization.selectionAuthorizationDigest,
    "durable settlement nonce authority",
  );
  exactString(settlement.intentNonce, request.nonce, "durable settlement nonce");
  exactString(settlement.intentDigest, authorized.userAuthorizationDigest, "durable settlement authorization");
  exactString(settlement.paymentHash, offer.paymentHash, "durable settlement payment hash");
  exactString(settlement.invoiceDigest, offer.invoiceDigest, "durable settlement invoice digest");
  exactString(settlement.amountSats, offer.lightningAmountSats, "durable settlement Lightning amount");
  exactString(settlement.quoteReceiptDigest, selection.receivedSetDigest, "durable received quote-set digest");
  exactString(settlement.selectedSetDigest, selection.selectedBlindOfferDigest, "durable selected-offer digest");
  exactString(settlement.selectedOfferId, reservation.selectedOfferId, "durable selected offer");
  exactString(settlement.capacityEpoch, offer.capacityEpoch, "durable settlement capacity epoch");
  exactString(settlement.createdAt, authorized.userAuthorizedAt, "durable settlement acceptance time");
  return settlement;
}

export function verifiedFinalizedExecutableQuote(finalization, { now } = {}) {
  if (!finalization || !VERIFIED_USER_AUTHORIZED_FINALIZATIONS.has(finalization)) {
    throw new TypeError("executable quote requires exact verified user authorization");
  }
  const observedAt = integer(now, "now");
  if (observedAt < finalization.userAuthorizedAt) {
    throw new Error("user execution authorization verification is from the future");
  }
  if (finalization.userAuthorizationExpiresAt <= observedAt) {
    throw new Error("user execution authorization is expired");
  }
  const context = AUTHORIZED_FINALIZATION_CONTEXTS.get(finalization);
  activeBlindQuoteReservationBinding(context.reservation, { now: observedAt });
  assertAuthorizedSettlementBinding(finalization);
  return finalization;
}

export function verifiedFinalizedContractIntentContext(finalization, { now } = {}) {
  const verified = verifiedFinalizedExecutableQuote(finalization, { now });
  const authorizedContext = AUTHORIZED_FINALIZATION_CONTEXTS.get(verified);
  const candidate = authorizedContext?.candidate;
  const reservation = authorizedContext?.reservation;
  const reservationContext = RESERVATION_CONTEXTS.get(reservation);
  const selection = reservationContext?.selection;
  const selectionContext = BLIND_SELECTION_CONTEXTS.get(selection);
  const finalizationContext = FINALIZATION_CONTEXTS.get(candidate);
  if (!candidate || !reservation || !selection || !selectionContext || !finalizationContext) {
    throw new TypeError("contract intent provenance is unavailable");
  }
  const request = rfqRequestPayload(finalizationContext.request);
  const offer = candidate.envelope.offer;
  const capability = verifiedSolverRecoveryAuthority(selectionContext.capabilityVerification);
  exactString(capability.direction, request.direction, "contract intent capability direction");
  exactAddress(capability.solverId, offer.solver, "contract intent capability solver");
  exactAddress(
    capability.settlementContract,
    request.verifyingContract,
    "contract intent settlement contract",
  );
  exactString(
    capability.settlementContractCodeHash,
    offer.settlementContractCodeHash,
    "contract intent settlement code hash",
  );
  return Object.freeze({
    schema: "treeswap.verified-contract-intent-context.v1",
    settlementId: verified.settlementId,
    userAuthorizationDigest: verified.userAuthorizationDigest,
    userAuthorizationExpiresAt: verified.userAuthorizationExpiresAt,
    direction: request.direction,
    chainId: request.chainId.toString(),
    settlementContract: capability.settlementContract,
    settlementContractCodeHash: capability.settlementContractCodeHash,
    user: offer.user,
    beneficiary: offer.beneficiary,
    solver: offer.solver,
    lightningNodePubkey: capability.lightningNodePubkey,
    selectedOfferId: offer.offerId,
    grossBitAmount: offer.grossBitAmount.toString(),
    feeBitAmount: offer.feeBitAmount.toString(),
    lightningAmountSats: offer.lightningAmountSats.toString(),
    maxRoutingFeeSats: offer.maxRoutingFeeSats.toString(),
    paymentHash: offer.paymentHash,
    invoiceDigest: offer.invoiceDigest,
    requestNonce: offer.requestNonce.toString(),
    offerNonce: offer.offerNonce.toString(),
    offerExpiresAt: offer.expiresAt,
    capacityEpoch: offer.capacityEpoch,
  });
}

export function persistFinalizedContractIntentBinding(finalization, binding, { now } = {}) {
  const verified = verifiedFinalizedExecutableQuote(finalization, { now });
  const observedAt = integer(now, "contract intent persistence time");
  const authorizedContext = AUTHORIZED_FINALIZATION_CONTEXTS.get(verified);
  const reservationContext = RESERVATION_CONTEXTS.get(authorizedContext?.reservation);
  if (!reservationContext) throw new TypeError("contract intent persistence provenance is unavailable");
  const store = coordinatorAuthority(reservationContext.store);
  const settlement = COORDINATOR_METHODS.bindContractIntent.call(store, {
    binding,
    boundAt: observedAt,
  });
  exactString(settlement.settlementId, verified.settlementId, "durable contract intent settlement");
  exactString(
    settlement.intentDigest,
    verified.userAuthorizationDigest,
    "durable offchain user authorization digest",
  );
  if (!settlement.contractIntentDigest || !settlement.contractIntentRecordDigest) {
    throw new Error("durable contract intent binding is incomplete");
  }
  return settlement;
}

export function bindFinalizedSolverInvoice(request, finalization, { now } = {}) {
  const verified = verifiedFinalizedExecutableQuote(finalization, { now });
  const payload = rfqRequestPayload(request);
  if (payload.direction !== "lightning-to-bit") {
    throw new RangeError("only Lightning-to-BIT selects a solver-created invoice");
  }
  if (payload.paymentHash !== `0x${"00".repeat(32)}` || payload.invoiceDigest !== `0x${"00".repeat(32)}`) {
    throw new Error("request already contains invoice terms");
  }
  if (verified.requestDigest !== rfqRequestDigest(request) || verified.requestId !== payload.requestId) {
    throw new Error("private settlement request changed after executable finalization");
  }
  const offer = verified.envelope.offer;
  return Object.freeze({
    ...payload,
    chainId: BigInt(payload.chainId),
    nonce: BigInt(payload.nonce),
    exactBitOutputWei: BigInt(payload.exactBitOutputWei),
    exactLightningOutputSats: BigInt(payload.exactLightningOutputSats),
    maxRoutingFeeSats: BigInt(payload.maxRoutingFeeSats),
    maxFeeBps: BigInt(payload.maxFeeBps),
    paymentHash: offer.paymentHash,
    invoiceDigest: offer.invoiceDigest,
    selectedOfferId: offer.offerId,
    selectedSolver: offer.solver,
    capabilityDigest: offer.capabilityDigest,
    capacitySnapshotDigest: offer.capacitySnapshotDigest,
    endpointPublicKeyDigest: offer.endpointPublicKeyDigest,
    settlementContractCodeHash: offer.settlementContractCodeHash,
    capacityEpoch: offer.capacityEpoch,
    receivedSetDigest: verified.receivedSetDigest,
    pricingId: verified.pricingId,
    pricingDigest: verified.pricingDigest,
    selectedBlindOfferDigest: verified.selectedBlindOfferDigest,
  });
}
