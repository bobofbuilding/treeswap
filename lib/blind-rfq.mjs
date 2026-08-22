import {
  getAddress,
  id,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
} from "ethers";
import { rfqDeliveryPayloadDigest, verifiedRfqDeliveryCollection } from "./rfq-delivery.mjs";
import {
  rfqRequestDigest,
  rfqRequestPayload,
  validateExecutableSolverOffer,
} from "./rfq.mjs";
import { verifiedSolverQuoteBinding } from "./solver-capability.mjs";

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
const VERIFIED_BLIND_SELECTIONS = new WeakSet();
const VERIFIED_FINALIZATIONS = new WeakSet();

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
  const offerReceipt = offers.map((envelope) => ({
    offerDigest: TypedDataEncoder.hash(
      blindRfqDomain({ chainId: boundPolicy.chainId, verifyingContract: settlementContract(boundPricing, boundPolicy) }),
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
  return book;
}

export function selectBlindQuote(book, offerId) {
  if (!book || !VERIFIED_BLIND_BOOKS.has(book)) {
    throw new TypeError("blind quote book must be built from an authenticated complete delivery collection");
  }
  const selected = book.offers.find((envelope) => envelope.offer.offerId === offerId);
  if (!selected) throw new RangeError("selected blind quote is not in the verified received set");
  const selection = Object.freeze({
    pricingId: book.pricingId,
    pricingDigest: book.pricingDigest,
    pricing: book.pricing,
    receivedSetDigest: book.receiptDigest,
    selected,
    requiresPrivatePeerDisclosure: true,
    requiresExactUserAuthorization: true,
  });
  VERIFIED_BLIND_SELECTIONS.add(selection);
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

export function finalizeSelectedBlindQuote({
  request,
  selection,
  envelope,
  capabilityVerification,
  now,
  quotePolicy,
}) {
  if (!selection || !VERIFIED_BLIND_SELECTIONS.has(selection)) {
    throw new TypeError("executable finalization requires one locally selected blind quote");
  }
  const requestPayload = rfqRequestPayload(request);
  assertPrivateRequestMatchesPricing(requestPayload, selection.pricing);
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
  const finalization = Object.freeze({
    pricingId: selection.pricingId,
    pricingDigest: selection.pricingDigest,
    receivedSetDigest: selection.receivedSetDigest,
    selectedBlindOfferDigest: TypedDataEncoder.hash(
      blindRfqDomain({
        chainId: selection.pricing.chainId,
        verifyingContract: requestPayload.verifyingContract,
      }),
      BLIND_RFQ_OFFER_TYPES,
      blind,
    ),
    requestId: requestPayload.requestId,
    requestDigest: rfqRequestDigest(request),
    envelope: result.envelope,
    requiresExactUserAuthorization: true,
  });
  VERIFIED_FINALIZATIONS.add(finalization);
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
