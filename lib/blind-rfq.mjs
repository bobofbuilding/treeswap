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
import { rfqDeliveryPayloadDigest, verifiedRfqDeliveryCollection } from "./rfq-delivery.mjs";
import {
  EXECUTABLE_RFQ_OFFER_TYPES,
  rfqDomain,
  rfqRequestDigest,
  rfqRequestPayload,
  validateExecutableSolverOffer,
} from "./rfq.mjs";
import { verifiedSolverCapacityRecord, verifiedSolverQuoteBinding } from "./solver-capability.mjs";

const BLIND_OFFER_FIELDS = Object.freeze([
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
const VERIFIED_BLIND_RESERVATIONS = new WeakSet();
const RESERVATION_BY_SELECTION = new WeakMap();
const RESERVATION_CONTEXTS = new WeakMap();
const VERIFIED_FINALIZATIONS = new WeakSet();
const FINALIZATION_BY_RESERVATION = new WeakMap();
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const COORDINATOR_METHODS = Object.freeze({
  bindFirmOfferExecution: CoordinatorStore.prototype.bindFirmOfferExecution,
  getFirmOffer: CoordinatorStore.prototype.getFirmOffer,
  getRfqRequest: CoordinatorStore.prototype.getRfqRequest,
  getSolverCapacity: CoordinatorStore.prototype.getSolverCapacity,
  reserveVerifiedFirmOffer: CoordinatorStore.prototype.reserveVerifiedFirmOffer,
});

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

function uint(value, name, maximum) {
  const raw = String(value ?? "");
  if (!UINT_DECIMAL.test(raw) || raw.length > maximum.toString().length) {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
  const parsed = BigInt(raw);
  if (parsed > maximum) throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  return parsed;
}

function bytes32(value, name, { nonzero = false } = {}) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw) || (nonzero && raw === `0x${"00".repeat(32)}`)) {
    throw new TypeError(`${name} must be ${nonzero ? "non-zero " : ""}lowercase bytes32`);
  }
  return raw;
}

function address(value, name) {
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
  exactKeys(raw, [
    "capacityEpoch", "chainId", "direction", "exactOutput", "expiresAt", "maxFeeBps",
    "maxRoutingFeeSats", "outputUnit", "pricingId",
  ], "blind pricing request");
  if (raw.direction !== "lightning-to-bit" && raw.direction !== "bit-to-lightning") {
    throw new RangeError("blind pricing direction is unsupported");
  }
  const outputUnit = String(raw.outputUnit ?? "");
  if ((raw.direction === "lightning-to-bit" && outputUnit !== "bit-wei")
      || (raw.direction === "bit-to-lightning" && outputUnit !== "sats")) {
    throw new Error("blind pricing output unit changed");
  }
  const pricing = Object.freeze({
    pricingId: bytes32(raw.pricingId, "pricing.pricingId", { nonzero: true }),
    direction: raw.direction,
    chainId: integer(raw.chainId, "pricing.chainId"),
    exactOutput: uint(raw.exactOutput, "pricing.exactOutput", UINT256_MAX),
    outputUnit,
    maxFeeBps: uint(raw.maxFeeBps, "pricing.maxFeeBps", 10_000n),
    maxRoutingFeeSats: uint(raw.maxRoutingFeeSats, "pricing.maxRoutingFeeSats", UINT64_MAX),
    capacityEpoch: integer(raw.capacityEpoch, "pricing.capacityEpoch"),
    expiresAt: integer(raw.expiresAt, "pricing.expiresAt"),
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
  exactKeys(raw, [
    "bitToLightningContract", "bitToLightningContractCodeHash", "chainId", "lightningToBitContract",
    "lightningToBitContractCodeHash", "maxClockSkewSeconds", "maxOffersPerRequest",
    "maxQuoteTtlSeconds", "minimumIndependentSolvers",
  ], "blind RFQ policy");
  const policy = Object.freeze({
    chainId: uint(raw.chainId, "policy.chainId", UINT256_MAX),
    lightningToBitContract: address(raw.lightningToBitContract, "policy.lightningToBitContract"),
    bitToLightningContract: address(raw.bitToLightningContract, "policy.bitToLightningContract"),
    lightningToBitContractCodeHash: bytes32(
      raw.lightningToBitContractCodeHash,
      "policy.lightningToBitContractCodeHash",
    ),
    bitToLightningContractCodeHash: bytes32(
      raw.bitToLightningContractCodeHash,
      "policy.bitToLightningContractCodeHash",
    ),
    maxClockSkewSeconds: integer(raw.maxClockSkewSeconds, "policy.maxClockSkewSeconds", 60),
    maxOffersPerRequest: integer(raw.maxOffersPerRequest, "policy.maxOffersPerRequest", 128),
    maxQuoteTtlSeconds: integer(raw.maxQuoteTtlSeconds, "policy.maxQuoteTtlSeconds", 300),
    minimumIndependentSolvers: integer(raw.minimumIndependentSolvers, "policy.minimumIndependentSolvers", 128),
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
  exactKeys(raw, BLIND_OFFER_FIELDS.map(({ name }) => name), "blind solver offer");
  for (const field of [
    "offerId", "pricingId", "direction", "capabilityDigest", "capacitySnapshotDigest",
    "endpointPublicKeyDigest", "settlementContractCodeHash",
  ]) bytes32(raw[field], `offer.${field}`, { nonzero: field === "offerId" || field === "pricingId" });
  return Object.freeze({
    offerId: raw.offerId,
    pricingId: raw.pricingId,
    direction: raw.direction,
    solver: address(raw.solver, "offer.solver"),
    grossBitAmount: uint(raw.grossBitAmount, "offer.grossBitAmount", UINT256_MAX),
    feeBitAmount: uint(raw.feeBitAmount, "offer.feeBitAmount", UINT256_MAX),
    lightningAmountSats: uint(raw.lightningAmountSats, "offer.lightningAmountSats", UINT64_MAX),
    maxRoutingFeeSats: uint(raw.maxRoutingFeeSats, "offer.maxRoutingFeeSats", UINT64_MAX),
    expiresAt: integer(raw.expiresAt, "offer.expiresAt"),
    capacityEpoch: integer(raw.capacityEpoch, "offer.capacityEpoch"),
    capabilityDigest: raw.capabilityDigest,
    capacitySnapshotDigest: raw.capacitySnapshotDigest,
    endpointPublicKeyDigest: raw.endpointPublicKeyDigest,
    settlementContractCodeHash: raw.settlementContractCodeHash,
    availableBitWei: uint(raw.availableBitWei, "offer.availableBitWei", UINT256_MAX),
    availableLightningSats: uint(raw.availableLightningSats, "offer.availableLightningSats", UINT64_MAX),
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

export function validateBlindSolverOffer({ pricing, envelope, capabilityVerification, now, policy }) {
  const reasons = [];
  const observedAt = integer(now, "now");
  let boundPricing;
  let boundPolicy;
  let offer;
  let capability;
  let signature = "";
  try {
    boundPricing = normalizedPricing(pricing);
    boundPolicy = normalizedPolicy(policy);
    offer = normalizedOffer(envelope?.offer ?? {});
    capability = verifiedSolverQuoteBinding(capabilityVerification);
    signature = String(envelope?.signature ?? "");
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

export function buildMultipathBlindQuoteBook({ pricing, collection, capabilityVerifications, now, policy }) {
  const boundPricing = normalizedPricing(pricing);
  const boundPolicy = normalizedPolicy(policy);
  const delivery = verifiedRfqDeliveryCollection(collection);
  const serialized = serializedPricing(boundPricing);
  const pricingDigest = rfqDeliveryPayloadDigest(serialized);
  if (delivery.requestId !== boundPricing.pricingId || delivery.requestDigest !== pricingDigest
      || delivery.rfqPayloadDigest !== pricingDigest) {
    throw new Error("RFQ delivery collection belongs to a different blind pricing request");
  }
  if (!Array.isArray(capabilityVerifications)) {
    throw new TypeError("blind quote verification requires locally verified solver capabilities");
  }
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
  if (uniqueRaw.size > boundPolicy.maxOffersPerRequest) {
    throw new RangeError("blind quote response exceeds the bounded offer limit");
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
      envelope,
      capabilityVerification,
      now,
      policy: boundPolicy,
    });
    const offerId = result.envelope?.offer.offerId ?? envelope.offer?.offerId ?? "unknown";
    if (!result.valid || seenOfferIds.has(offerId)) {
      rejected.push(Object.freeze({
        offerId,
        reasons: Object.freeze(result.valid ? ["duplicate blind offer identifier"] : [...result.reasons]),
      }));
      continue;
    }
    seenOfferIds.add(offerId);
    valid.push(Object.freeze({
      source: envelope.source,
      receivedAt: envelope.receivedAt,
      ...result.envelope,
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
  }));
  const offerReceiptDigest = keccak256(toUtf8Bytes(JSON.stringify(offerReceipt)));
  const receiptDigest = keccak256(toUtf8Bytes(JSON.stringify({
    schema: "treeswap.blind-multipath-received-set.v1",
    pricingDigest,
    deliveryCollectionDigest: delivery.collectionDigest,
    offerReceiptDigest,
  })));
  const book = Object.freeze({
    pricingId: boundPricing.pricingId,
    pricingDigest,
    pricing: serialized,
    label: "Best received quote",
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

export function selectBlindQuote(book, offerId) {
  if (!book || !VERIFIED_BLIND_BOOKS.has(book)) {
    throw new TypeError("blind quote book must be built from an authenticated complete delivery collection");
  }
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

function assertFirmRecordMatches(record, selection, reservation = null) {
  if (!record) throw new Error("blind quote reservation record is missing");
  const blind = selection.selected.offer;
  const bitAmountWei = selection.pricing.direction === "lightning-to-bit" ? blind.grossBitAmount : 0n;
  const lightningAmountSats = selection.pricing.direction === "bit-to-lightning"
    ? blind.lightningAmountSats + blind.maxRoutingFeeSats
    : blind.lightningAmountSats;
  const amount = selection.pricing.direction === "lightning-to-bit" ? bitAmountWei : lightningAmountSats;
  exactString(record.offerId, blind.offerId, "durable offer identifier");
  exactString(record.offerDigest, selection.selectedBlindOfferDigest, "durable blind offer digest");
  exactString(record.requestId, selection.pricingId, "durable offer RFQ");
  exactAddress(record.solverId, blind.solver, "durable offer solver");
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
  capabilityVerification,
  coordinatorStore,
  admissionPolicy,
  now,
}) {
  if (!selection || !VERIFIED_BLIND_SELECTIONS.has(selection)) {
    throw new TypeError("reservation requires one locally selected authenticated blind quote");
  }
  const observedAt = integer(now, "now");
  const prior = RESERVATION_BY_SELECTION.get(selection);
  if (prior) {
    const priorContext = RESERVATION_CONTEXTS.get(prior);
    const selectionContext = BLIND_SELECTION_CONTEXTS.get(selection);
    if (priorContext?.store !== coordinatorStore
        || selectionContext?.capabilityVerification !== capabilityVerification) {
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
    requestId: selection.pricingId,
    solverId: blind.solver.toLowerCase(),
    offer: {
      direction: selection.pricing.direction,
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
  const amount = assertFirmRecordMatches(record, selection);
  if (record.state !== "ACTIVE" || record.expiresAt <= observedAt) {
    throw new Error("blind offer was not reserved as an active durable record");
  }
  const reservation = Object.freeze({
    schema: "treeswap.blind-offer-reservation.v1",
    pricingId: selection.pricingId,
    receivedSetDigest: selection.receivedSetDigest,
    selectedBlindOfferDigest: selection.selectedBlindOfferDigest,
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
  const record = COORDINATOR_METHODS.getFirmOffer.call(store, reservation.selectedOfferId);
  assertFirmRecordMatches(record, context.selection, reservation);
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
  const reservationContext = RESERVATION_CONTEXTS.get(active);
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
  return finalization;
}

export function verifiedFinalizedExecutableQuote(finalization) {
  if (!finalization || !VERIFIED_FINALIZATIONS.has(finalization)) {
    throw new TypeError("executable quote must come from selected blind-offer finalization");
  }
  return finalization;
}

export function bindFinalizedSolverInvoice(request, finalization) {
  const verified = verifiedFinalizedExecutableQuote(finalization);
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
