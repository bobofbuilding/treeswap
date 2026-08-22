import {
  getAddress,
  id,
  keccak256,
  TypedDataEncoder,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { verifiedSolverQuoteBinding } from "./solver-capability.mjs";
import { canonicalRelaySource } from "./untrusted-text.mjs";

const OFFER_FIELDS = Object.freeze([
  { name: "offerId", type: "bytes32" },
  { name: "requestId", type: "bytes32" },
  { name: "direction", type: "bytes32" },
  { name: "user", type: "address" },
  { name: "beneficiary", type: "address" },
  { name: "solver", type: "address" },
  { name: "grossBitAmount", type: "uint256" },
  { name: "feeBitAmount", type: "uint256" },
  { name: "lightningAmountSats", type: "uint64" },
  { name: "maxRoutingFeeSats", type: "uint64" },
  { name: "paymentHash", type: "bytes32" },
  { name: "invoiceDigest", type: "bytes32" },
  { name: "requestNonce", type: "uint256" },
  { name: "offerNonce", type: "uint256" },
  { name: "expiresAt", type: "uint64" },
  { name: "capacityEpoch", type: "uint64" },
]);
const EXECUTABLE_BINDING_FIELDS = Object.freeze([
  { name: "capabilityDigest", type: "bytes32" },
  { name: "capacitySnapshotDigest", type: "bytes32" },
  { name: "endpointPublicKeyDigest", type: "bytes32" },
  { name: "settlementContractCodeHash", type: "bytes32" },
  { name: "availableBitWei", type: "uint256" },
  { name: "availableLightningSats", type: "uint64" },
]);

export const RFQ_OFFER_TYPES = Object.freeze({ SolverOffer: OFFER_FIELDS });
export const EXECUTABLE_RFQ_OFFER_TYPES = Object.freeze({
  SolverOffer: Object.freeze([...OFFER_FIELDS, ...EXECUTABLE_BINDING_FIELDS]),
});

const BYTES32 = /^0x[0-9a-f]{64}$/;
const UINT_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
export const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const VERIFIED_BOOKS = new WeakSet();
const EXECUTABLE_BOOKS = new WeakSet();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function uint(value, name, maximum) {
  const raw = String(value ?? "");
  if (raw.length > maximum.toString().length || !UINT_DECIMAL.test(raw)) {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
  const parsed = BigInt(raw);
  if (parsed > maximum) throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  return parsed;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function safeUint(value, name) {
  return Number(uint(value, name, BigInt(Number.MAX_SAFE_INTEGER)));
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
    throw new RangeError("unsupported RFQ direction");
  }
  return id(direction);
}

function normalizedRequest(raw) {
  exactKeys(raw, [
    "beneficiary", "chainId", "direction", "exactBitOutputWei", "exactLightningOutputSats",
    "expiresAt", "invoiceDigest", "maxFeeBps", "maxRoutingFeeSats", "nonce", "paymentHash", "requestId",
    "user", "verifyingContract",
  ], "RFQ request");
  if (raw.direction !== "lightning-to-bit" && raw.direction !== "bit-to-lightning") {
    throw new RangeError("unsupported RFQ direction");
  }
  if (!BYTES32.test(String(raw.requestId)) || !BYTES32.test(String(raw.paymentHash)) || !BYTES32.test(String(raw.invoiceDigest))) {
    throw new TypeError("RFQ request identifiers must be lowercase bytes32");
  }
  return Object.freeze({
    requestId: raw.requestId,
    direction: raw.direction,
    chainId: uint(raw.chainId, "request.chainId", UINT256_MAX),
    verifyingContract: address(raw.verifyingContract, "request.verifyingContract"),
    user: address(raw.user, "request.user"),
    beneficiary: address(raw.beneficiary, "request.beneficiary"),
    paymentHash: raw.paymentHash,
    invoiceDigest: raw.invoiceDigest,
    nonce: uint(raw.nonce, "request.nonce", UINT256_MAX),
    expiresAt: safeUint(raw.expiresAt, "request.expiresAt"),
    exactBitOutputWei: uint(raw.exactBitOutputWei, "request.exactBitOutputWei", UINT256_MAX),
    exactLightningOutputSats: uint(raw.exactLightningOutputSats, "request.exactLightningOutputSats", UINT64_MAX),
    maxRoutingFeeSats: uint(raw.maxRoutingFeeSats, "request.maxRoutingFeeSats", UINT64_MAX),
    maxFeeBps: uint(raw.maxFeeBps, "request.maxFeeBps", 10_000n),
  });
}

function normalizedPolicy(raw) {
  exactKeys(raw, [
    "maxClockSkewSeconds", "maxOffersPerRequest", "maxQuoteTtlSeconds", "maxSourceLength",
    "minimumIndependentSolvers",
  ], "RFQ policy");
  const policy = Object.freeze({
    maxSourceLength: integer(Number(raw.maxSourceLength), "policy.maxSourceLength"),
    maxClockSkewSeconds: integer(Number(raw.maxClockSkewSeconds), "policy.maxClockSkewSeconds"),
    maxQuoteTtlSeconds: integer(Number(raw.maxQuoteTtlSeconds), "policy.maxQuoteTtlSeconds"),
    maxOffersPerRequest: integer(Number(raw.maxOffersPerRequest), "policy.maxOffersPerRequest"),
    minimumIndependentSolvers: integer(Number(raw.minimumIndependentSolvers), "policy.minimumIndependentSolvers"),
  });
  if (policy.maxSourceLength === 0 || policy.maxSourceLength > 64) throw new RangeError("RFQ source length is outside policy");
  if (policy.maxClockSkewSeconds > 60) throw new RangeError("RFQ clock skew is outside policy");
  if (policy.maxQuoteTtlSeconds === 0 || policy.maxQuoteTtlSeconds > 300) throw new RangeError("RFQ quote lifetime is outside policy");
  if (policy.maxOffersPerRequest < 2 || policy.maxOffersPerRequest > 128) throw new RangeError("RFQ offer limit is outside policy");
  if (policy.minimumIndependentSolvers < 2 || policy.minimumIndependentSolvers > policy.maxOffersPerRequest) {
    throw new RangeError("RFQ independent-solver minimum is outside policy");
  }
  return policy;
}

function requestPayload(request) {
  return Object.freeze({
    requestId: request.requestId,
    direction: request.direction,
    chainId: request.chainId.toString(),
    verifyingContract: request.verifyingContract,
    user: request.user,
    beneficiary: request.beneficiary,
    paymentHash: request.paymentHash,
    invoiceDigest: request.invoiceDigest,
    nonce: request.nonce.toString(),
    expiresAt: request.expiresAt,
    exactBitOutputWei: request.exactBitOutputWei.toString(),
    exactLightningOutputSats: request.exactLightningOutputSats.toString(),
    maxRoutingFeeSats: request.maxRoutingFeeSats.toString(),
    maxFeeBps: request.maxFeeBps.toString(),
  });
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function requestDigest(request) {
  return keccak256(toUtf8Bytes(canonicalize(requestPayload(request))));
}

export function rfqRequestDigest(request) {
  return requestDigest(normalizedRequest(request));
}

export function rfqRequestPayload(request) {
  return requestPayload(normalizedRequest(request));
}

export function rfqDomain(request) {
  return {
    name: "TreeSwap RFQ",
    version: "1",
    chainId: uint(request.chainId, "request.chainId", UINT256_MAX),
    verifyingContract: address(request.verifyingContract, "request.verifyingContract"),
  };
}

function normalizedOffer(raw, { executable = false } = {}) {
  const fieldNames = executable
    ? [...OFFER_FIELDS, ...EXECUTABLE_BINDING_FIELDS].map(({ name }) => name)
    : OFFER_FIELDS.map(({ name }) => name);
  exactKeys(raw, fieldNames, executable ? "executable solver offer" : "solver offer");
  const offer = {
    offerId: raw.offerId,
    requestId: raw.requestId,
    direction: raw.direction,
    user: address(raw.user, "offer.user"),
    beneficiary: address(raw.beneficiary, "offer.beneficiary"),
    solver: address(raw.solver, "offer.solver"),
    grossBitAmount: uint(raw.grossBitAmount, "offer.grossBitAmount", UINT256_MAX),
    feeBitAmount: uint(raw.feeBitAmount, "offer.feeBitAmount", UINT256_MAX),
    lightningAmountSats: uint(raw.lightningAmountSats, "offer.lightningAmountSats", UINT64_MAX),
    maxRoutingFeeSats: uint(raw.maxRoutingFeeSats, "offer.maxRoutingFeeSats", UINT64_MAX),
    paymentHash: raw.paymentHash,
    invoiceDigest: raw.invoiceDigest,
    requestNonce: uint(raw.requestNonce, "offer.requestNonce", UINT256_MAX),
    offerNonce: uint(raw.offerNonce, "offer.offerNonce", UINT256_MAX),
    expiresAt: safeUint(raw.expiresAt, "offer.expiresAt"),
    capacityEpoch: safeUint(raw.capacityEpoch, "offer.capacityEpoch"),
  };
  if (executable) {
    for (const [field, label] of [
      ["capabilityDigest", "offer.capabilityDigest"],
      ["capacitySnapshotDigest", "offer.capacitySnapshotDigest"],
      ["endpointPublicKeyDigest", "offer.endpointPublicKeyDigest"],
      ["settlementContractCodeHash", "offer.settlementContractCodeHash"],
    ]) {
      if (!BYTES32.test(String(raw[field]))) throw new TypeError(`${label} must be lowercase bytes32`);
      offer[field] = raw[field];
    }
    offer.availableBitWei = uint(raw.availableBitWei, "offer.availableBitWei", UINT256_MAX);
    offer.availableLightningSats = uint(raw.availableLightningSats, "offer.availableLightningSats", UINT64_MAX);
  }
  return offer;
}

function inputAmount(direction, offer) {
  return direction === "lightning-to-bit" ? offer.lightningAmountSats : offer.grossBitAmount;
}

function compareEnvelopes(direction, left, right) {
  const leftInput = inputAmount(direction, left.offer);
  const rightInput = inputAmount(direction, right.offer);
  if (leftInput !== rightInput) return leftInput < rightInput ? -1 : 1;
  if (left.receivedAt !== right.receivedAt) return left.receivedAt - right.receivedAt;
  return left.offer.offerId.localeCompare(right.offer.offerId);
}

export function validateSolverOffer({ request, envelope, now, policy, capabilityVerification = null, executable = false }) {
  const reasons = [];
  const observedAt = integer(now, "now");
  const receivedAt = integer(envelope.receivedAt, "envelope.receivedAt");
  let source = "";
  let offer;
  let capabilityBinding = null;
  let boundRequest;
  let boundPolicy;

  try {
    boundRequest = normalizedRequest(request);
    boundPolicy = normalizedPolicy(policy);
    source = canonicalRelaySource(envelope.source, boundPolicy.maxSourceLength);
    offer = normalizedOffer(envelope.offer ?? {}, { executable });
    if (executable) capabilityBinding = verifiedSolverQuoteBinding(capabilityVerification);
  } catch (error) {
    return { valid: false, reasons: [error.message] };
  }

  if (receivedAt > observedAt + boundPolicy.maxClockSkewSeconds) reasons.push("quote receipt time is in the future");
  if (!BYTES32.test(offer.offerId) || !BYTES32.test(offer.requestId)) reasons.push("invalid offer or request identifier");
  if (!BYTES32.test(offer.paymentHash) || !BYTES32.test(offer.invoiceDigest)) reasons.push("invalid payment or invoice digest");
  if (offer.requestId !== boundRequest.requestId) reasons.push("offer belongs to a different request");
  if (offer.direction !== directionHash(boundRequest.direction)) reasons.push("offer direction changed");
  if (!sameAddress(offer.user, boundRequest.user)) reasons.push("offer user changed");
  if (!sameAddress(offer.beneficiary, boundRequest.beneficiary)) reasons.push("offer beneficiary changed");
  if (boundRequest.direction === "lightning-to-bit") {
    if (boundRequest.paymentHash !== ZERO_BYTES32 || boundRequest.invoiceDigest !== ZERO_BYTES32) {
      reasons.push("Lightning-to-BIT request must leave solver invoice fields unbound");
    }
    if (offer.paymentHash === ZERO_BYTES32 || offer.invoiceDigest === ZERO_BYTES32) {
      reasons.push("Lightning-to-BIT solver offer must bind its own hold invoice");
    }
  } else {
    if (offer.paymentHash !== boundRequest.paymentHash) reasons.push("offer payment hash changed");
    if (offer.invoiceDigest !== boundRequest.invoiceDigest) reasons.push("offer invoice digest changed");
  }
  if (offer.requestNonce !== boundRequest.nonce) reasons.push("offer request nonce changed");
  if (offer.grossBitAmount === 0n || offer.lightningAmountSats === 0n || offer.feeBitAmount >= offer.grossBitAmount) {
    reasons.push("offer amount is invalid");
  }
  if (offer.expiresAt <= observedAt) reasons.push("offer expired");
  if (offer.expiresAt > boundRequest.expiresAt) reasons.push("offer outlives the request");
  if (offer.expiresAt > observedAt + boundPolicy.maxQuoteTtlSeconds) reasons.push("offer expiry exceeds the short-lived quote limit");
  if (offer.maxRoutingFeeSats > boundRequest.maxRoutingFeeSats) {
    reasons.push("routing fee cap changed");
  }

  if (offer.feeBitAmount * 10_000n > offer.grossBitAmount * boundRequest.maxFeeBps) {
    reasons.push("BIT fee exceeds the user cap");
  }

  if (boundRequest.direction === "lightning-to-bit") {
    if (offer.grossBitAmount - offer.feeBitAmount !== boundRequest.exactBitOutputWei) {
      reasons.push("exact BIT output changed");
    }
  } else if (offer.lightningAmountSats !== boundRequest.exactLightningOutputSats) {
    reasons.push("exact Lightning output changed");
  }

  if (executable && capabilityBinding) {
    if (BigInt(capabilityBinding.chainId) !== boundRequest.chainId) reasons.push("capability chain changed");
    if (capabilityBinding.direction !== boundRequest.direction) reasons.push("capability direction changed");
    if (!sameAddress(capabilityBinding.solverId, offer.solver)) reasons.push("capability belongs to another solver");
    if (!sameAddress(capabilityBinding.settlementContract, boundRequest.verifyingContract)) {
      reasons.push("capability settlement contract changed");
    }
    if (offer.capabilityDigest !== capabilityBinding.capabilityDigest) reasons.push("capability digest changed");
    if (offer.capacitySnapshotDigest !== capabilityBinding.capacitySnapshotDigest) {
      reasons.push("capacity snapshot digest changed");
    }
    if (offer.endpointPublicKeyDigest !== capabilityBinding.endpointPublicKeyDigest) {
      reasons.push("solver endpoint key changed");
    }
    if (offer.settlementContractCodeHash !== capabilityBinding.settlementContractCodeHash) {
      reasons.push("settlement contract version changed");
    }
    if (offer.capacityEpoch !== capabilityBinding.capacityEpoch) reasons.push("offer capacity declaration is stale");
    if (offer.availableBitWei !== BigInt(capabilityBinding.availableBitWei)) {
      reasons.push("verified BIT inventory snapshot changed");
    }
    if (offer.availableLightningSats !== BigInt(capabilityBinding.availableLightningSats)) {
      reasons.push("verified Lightning capacity snapshot changed");
    }
    if (offer.expiresAt > capabilityBinding.expiresAt) reasons.push("offer outlives the verified capability");
    if (boundRequest.direction === "lightning-to-bit") {
      if (offer.availableBitWei < offer.grossBitAmount) reasons.push("offer exceeds prefunded solver BIT inventory");
      if (offer.availableLightningSats < offer.lightningAmountSats) {
        reasons.push("offer exceeds verified inbound Lightning capacity");
      }
    } else {
      if (offer.availableBitWei !== 0n) reasons.push("BIT-to-Lightning offer must not claim solver BIT inventory");
      if (offer.availableLightningSats < offer.lightningAmountSats + offer.maxRoutingFeeSats) {
        reasons.push("offer exceeds verified outbound Lightning capacity");
      }
    }
  }

  const signature = String(envelope.signature ?? "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    reasons.push("solver signature is not canonical");
  } else {
    try {
      const offerTypes = executable ? EXECUTABLE_RFQ_OFFER_TYPES : RFQ_OFFER_TYPES;
      const recovered = verifyTypedData(rfqDomain(boundRequest), offerTypes, offer, signature);
      if (!sameAddress(recovered, offer.solver)) reasons.push("solver signature is invalid");
    } catch {
      reasons.push("solver signature is invalid");
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    envelope: Object.freeze({ source, receivedAt, signature, offer: Object.freeze(offer) }),
  };
}

export function validateExecutableSolverOffer({ request, envelope, capabilityVerification, now, policy }) {
  return validateSolverOffer({
    request,
    envelope,
    capabilityVerification,
    now,
    policy,
    executable: true,
  });
}

function buildQuoteBook({
  request,
  envelopes,
  capabilityVerifications = null,
  executable = false,
  now,
  policy,
}) {
  if (!Array.isArray(envelopes)) throw new TypeError("envelopes must be an array");
  const boundRequest = normalizedRequest(request);
  const boundPolicy = normalizedPolicy(policy);
  if (envelopes.length > boundPolicy.maxOffersPerRequest) throw new RangeError("quote response exceeds the bounded offer limit");

  let capabilityBySolver = null;
  if (executable) {
    if (!Array.isArray(capabilityVerifications)) {
      throw new TypeError("executable quote verification requires locally verified solver capabilities");
    }
    capabilityBySolver = new Map();
    for (const verification of capabilityVerifications) {
      const binding = verifiedSolverQuoteBinding(verification);
      const solverId = binding.solverId.toLowerCase();
      if (capabilityBySolver.has(solverId)) throw new Error("solver capability set contains a duplicate solver");
      capabilityBySolver.set(solverId, verification);
    }
  }

  const rejected = [];
  const valid = [];
  const seenOfferIds = new Set();
  const seenPaymentHashes = new Set();
  const seenInvoiceDigests = new Set();
  for (const envelope of envelopes) {
    let capabilityVerification = null;
    if (executable) {
      try {
        capabilityVerification = capabilityBySolver.get(address(envelope?.offer?.solver, "offer.solver").toLowerCase()) ?? null;
      } catch {
        capabilityVerification = null;
      }
    }
    const result = validateSolverOffer({
      request: boundRequest,
      envelope,
      capabilityVerification,
      executable,
      now,
      policy: boundPolicy,
    });
    const offerId = result.envelope?.offer?.offerId ?? envelope?.offer?.offerId ?? "unknown";
    const paymentHash = result.envelope?.offer?.paymentHash;
    const invoiceDigest = result.envelope?.offer?.invoiceDigest;
    const duplicateInvoice = boundRequest.direction === "lightning-to-bit"
      && (seenPaymentHashes.has(paymentHash) || seenInvoiceDigests.has(invoiceDigest));
    if (!result.valid || seenOfferIds.has(offerId) || duplicateInvoice) {
      const duplicateReasons = seenOfferIds.has(offerId)
        ? ["duplicate offer identifier"]
        : ["Lightning-to-BIT solver offers must use distinct hold invoices"];
      rejected.push({ offerId, reasons: result.valid ? duplicateReasons : result.reasons });
      continue;
    }
    seenOfferIds.add(offerId);
    if (boundRequest.direction === "lightning-to-bit") {
      seenPaymentHashes.add(paymentHash);
      seenInvoiceDigests.add(invoiceDigest);
    }
    valid.push(result.envelope);
  }

  valid.sort((left, right) => compareEnvelopes(boundRequest.direction, left, right));
  const uniqueSolvers = [];
  const seenSolvers = new Set();
  for (const envelope of valid) {
    const solver = envelope.offer.solver.toLowerCase();
    if (seenSolvers.has(solver)) {
      rejected.push({ offerId: envelope.offer.offerId, reasons: ["only the best valid offer per solver is retained"] });
      continue;
    }
    seenSolvers.add(solver);
    uniqueSolvers.push(envelope);
  }

  if (uniqueSolvers.length < boundPolicy.minimumIndependentSolvers) {
    throw new RangeError("not enough independent valid solver offers");
  }

  const receipt = uniqueSolvers.map(({ source, receivedAt, signature, offer }) => ({
    offerDigest: TypedDataEncoder.hash(
      rfqDomain(boundRequest),
      executable ? EXECUTABLE_RFQ_OFFER_TYPES : RFQ_OFFER_TYPES,
      offer,
    ),
    source,
    receivedAt,
    signature,
  }));
  const offerReceiptDigest = keccak256(toUtf8Bytes(JSON.stringify(receipt)));
  const receiptDigest = offerReceiptDigest;

  const frozenRejected = Object.freeze(rejected.map((item) => Object.freeze({
    offerId: item.offerId,
    reasons: Object.freeze([...item.reasons]),
  })));
  const book = Object.freeze({
    requestId: boundRequest.requestId,
    requestDigest: requestDigest(boundRequest),
    label: "Best received quote",
    executable,
    deliveryAuthenticated: false,
    receiptDigest,
    offerReceiptDigest,
    solverCount: uniqueSolvers.length,
    sourceCount: new Set(uniqueSolvers.map((envelope) => envelope.source)).size,
    offers: Object.freeze([...uniqueSolvers]),
    rejected: frozenRejected,
  });
  VERIFIED_BOOKS.add(book);
  if (executable) EXECUTABLE_BOOKS.add(book);
  return book;
}

export function buildReceivedQuoteBook({ request, envelopes, now, policy }) {
  return buildQuoteBook({ request, envelopes, now, policy });
}

export function buildExecutableQuoteBook({ request, envelopes, capabilityVerifications, now, policy }) {
  return buildQuoteBook({ request, envelopes, capabilityVerifications, executable: true, now, policy });
}

export function selectReceivedQuote(book, offerId) {
  if (!book || !VERIFIED_BOOKS.has(book)) throw new TypeError("quote book must be built from locally verified offers");
  const selected = book.offers.find((envelope) => envelope.offer.offerId === offerId);
  if (!selected) throw new RangeError("selected quote is not in the verified received set");
  return Object.freeze({
    executable: EXECUTABLE_BOOKS.has(book),
    deliveryAuthenticated: false,
    requestId: book.requestId,
    receiptDigest: book.receiptDigest,
    selected,
    requiresExactUserAuthorization: true,
  });
}

export function selectExecutableQuote(book, offerId) {
  if (!book || !EXECUTABLE_BOOKS.has(book)) {
    throw new TypeError("executable selection requires capability-bound locally verified offers");
  }
  return selectReceivedQuote(book, offerId);
}

export function bindSelectedSolverInvoice() {
  throw new TypeError("invoice binding requires privacy-preserving selected-offer finalization");
}

export function fallbackAuthorization(previousSelection, nextSelection) {
  const sameOffer = previousSelection.selected.offer.offerId === nextSelection.selected.offer.offerId;
  return {
    allowed: sameOffer,
    requiresFreshAuthorization: !sameOffer,
    reason: sameOffer ? "same signed offer" : "every fallback solver requires a new exact user authorization",
  };
}

export { directionHash };
