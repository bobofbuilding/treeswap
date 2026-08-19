import {
  getAddress,
  id,
  keccak256,
  TypedDataEncoder,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { canonicalRelaySource } from "./untrusted-text.mjs";

export const RFQ_OFFER_TYPES = {
  SolverOffer: [
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
  ],
};

const BYTES32 = /^0x[0-9a-f]{64}$/;
export const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const VERIFIED_BOOKS = new WeakSet();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function bigint(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
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
    "beneficiary", "capacityEpoch", "chainId", "direction", "exactBitOutputWei", "exactLightningOutputSats",
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
    chainId: bigint(raw.chainId, "request.chainId"),
    verifyingContract: address(raw.verifyingContract, "request.verifyingContract"),
    user: address(raw.user, "request.user"),
    beneficiary: address(raw.beneficiary, "request.beneficiary"),
    paymentHash: raw.paymentHash,
    invoiceDigest: raw.invoiceDigest,
    nonce: bigint(raw.nonce, "request.nonce"),
    expiresAt: integer(Number(raw.expiresAt), "request.expiresAt"),
    capacityEpoch: integer(Number(raw.capacityEpoch), "request.capacityEpoch"),
    exactBitOutputWei: bigint(raw.exactBitOutputWei, "request.exactBitOutputWei"),
    exactLightningOutputSats: bigint(raw.exactLightningOutputSats, "request.exactLightningOutputSats"),
    maxRoutingFeeSats: bigint(raw.maxRoutingFeeSats, "request.maxRoutingFeeSats"),
    maxFeeBps: bigint(raw.maxFeeBps, "request.maxFeeBps"),
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

function requestDigest(request) {
  const serialized = JSON.stringify({
    ...request,
    chainId: request.chainId.toString(),
    nonce: request.nonce.toString(),
    exactBitOutputWei: request.exactBitOutputWei.toString(),
    exactLightningOutputSats: request.exactLightningOutputSats.toString(),
    maxRoutingFeeSats: request.maxRoutingFeeSats.toString(),
    maxFeeBps: request.maxFeeBps.toString(),
  });
  return keccak256(toUtf8Bytes(serialized));
}

export function rfqDomain(request) {
  return {
    name: "TreeSwap RFQ",
    version: "1",
    chainId: bigint(request.chainId, "request.chainId"),
    verifyingContract: address(request.verifyingContract, "request.verifyingContract"),
  };
}

function normalizedOffer(raw) {
  return {
    offerId: raw.offerId,
    requestId: raw.requestId,
    direction: raw.direction,
    user: address(raw.user, "offer.user"),
    beneficiary: address(raw.beneficiary, "offer.beneficiary"),
    solver: address(raw.solver, "offer.solver"),
    grossBitAmount: bigint(raw.grossBitAmount, "offer.grossBitAmount"),
    feeBitAmount: bigint(raw.feeBitAmount, "offer.feeBitAmount"),
    lightningAmountSats: bigint(raw.lightningAmountSats, "offer.lightningAmountSats"),
    maxRoutingFeeSats: bigint(raw.maxRoutingFeeSats, "offer.maxRoutingFeeSats"),
    paymentHash: raw.paymentHash,
    invoiceDigest: raw.invoiceDigest,
    requestNonce: bigint(raw.requestNonce, "offer.requestNonce"),
    offerNonce: bigint(raw.offerNonce, "offer.offerNonce"),
    expiresAt: integer(Number(raw.expiresAt), "offer.expiresAt"),
    capacityEpoch: integer(Number(raw.capacityEpoch), "offer.capacityEpoch"),
  };
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

export function validateSolverOffer({ request, envelope, now, policy }) {
  const reasons = [];
  const observedAt = integer(now, "now");
  const receivedAt = integer(envelope.receivedAt, "envelope.receivedAt");
  let source = "";
  let offer;
  let boundRequest;
  let boundPolicy;

  try {
    boundRequest = normalizedRequest(request);
    boundPolicy = normalizedPolicy(policy);
    source = canonicalRelaySource(envelope.source, boundPolicy.maxSourceLength);
    offer = normalizedOffer(envelope.offer ?? {});
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
  if (offer.capacityEpoch !== boundRequest.capacityEpoch) reasons.push("offer capacity declaration is stale");
  if (offer.maxRoutingFeeSats > boundRequest.maxRoutingFeeSats) {
    reasons.push("routing fee cap changed");
  }

  const feeBps = offer.grossBitAmount === 0n ? 10_001n : offer.feeBitAmount * 10_000n / offer.grossBitAmount;
  if (feeBps > boundRequest.maxFeeBps) reasons.push("BIT fee exceeds the user cap");

  if (boundRequest.direction === "lightning-to-bit") {
    if (offer.grossBitAmount - offer.feeBitAmount !== boundRequest.exactBitOutputWei) {
      reasons.push("exact BIT output changed");
    }
  } else if (offer.lightningAmountSats !== boundRequest.exactLightningOutputSats) {
    reasons.push("exact Lightning output changed");
  }

  const signature = String(envelope.signature ?? "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    reasons.push("solver signature is not canonical");
  } else {
    try {
      const recovered = verifyTypedData(rfqDomain(boundRequest), RFQ_OFFER_TYPES, offer, signature);
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

export function buildReceivedQuoteBook({ request, envelopes, now, policy }) {
  if (!Array.isArray(envelopes)) throw new TypeError("envelopes must be an array");
  const boundRequest = normalizedRequest(request);
  const boundPolicy = normalizedPolicy(policy);
  if (envelopes.length > boundPolicy.maxOffersPerRequest) throw new RangeError("quote response exceeds the bounded offer limit");

  const rejected = [];
  const valid = [];
  const seenOfferIds = new Set();
  const seenPaymentHashes = new Set();
  const seenInvoiceDigests = new Set();
  for (const envelope of envelopes) {
    const result = validateSolverOffer({ request: boundRequest, envelope, now, policy: boundPolicy });
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
    offerDigest: TypedDataEncoder.hash(rfqDomain(boundRequest), RFQ_OFFER_TYPES, offer),
    source,
    receivedAt,
    signature,
  }));
  const receiptDigest = keccak256(toUtf8Bytes(JSON.stringify(receipt)));

  const frozenRejected = Object.freeze(rejected.map((item) => Object.freeze({
    offerId: item.offerId,
    reasons: Object.freeze([...item.reasons]),
  })));
  const book = Object.freeze({
    requestId: boundRequest.requestId,
    requestDigest: requestDigest(boundRequest),
    label: "Best received quote",
    receiptDigest,
    solverCount: uniqueSolvers.length,
    sourceCount: new Set(uniqueSolvers.map((envelope) => envelope.source)).size,
    offers: Object.freeze([...uniqueSolvers]),
    rejected: frozenRejected,
  });
  VERIFIED_BOOKS.add(book);
  return book;
}

export function selectReceivedQuote(book, offerId) {
  if (!book || !VERIFIED_BOOKS.has(book)) throw new TypeError("quote book must be built from locally verified offers");
  const selected = book.offers.find((envelope) => envelope.offer.offerId === offerId);
  if (!selected) throw new RangeError("selected quote is not in the verified received set");
  return Object.freeze({
    requestId: book.requestId,
    receiptDigest: book.receiptDigest,
    selected,
    requiresExactUserAuthorization: true,
  });
}

export function bindSelectedSolverInvoice(request, book, offerId) {
  const boundRequest = normalizedRequest(request);
  if (boundRequest.direction !== "lightning-to-bit") throw new RangeError("only Lightning-to-BIT selects a solver-created invoice");
  if (requestDigest(boundRequest) !== book?.requestDigest) throw new Error("request changed after quote verification");
  const selection = selectReceivedQuote(book, offerId);
  if (selection?.requestId !== boundRequest.requestId) throw new Error("selection belongs to a different request");
  const offer = selection.selected?.offer;
  if (!offer || offer.requestId !== boundRequest.requestId) throw new Error("selection is missing its exact signed offer");
  if (boundRequest.paymentHash !== ZERO_BYTES32 || boundRequest.invoiceDigest !== ZERO_BYTES32) {
    throw new Error("request already contains invoice terms");
  }
  return Object.freeze({
    ...boundRequest,
    paymentHash: offer.paymentHash,
    invoiceDigest: offer.invoiceDigest,
    selectedOfferId: offer.offerId,
    selectedSolver: offer.solver,
    receivedSetDigest: selection.receiptDigest,
  });
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
