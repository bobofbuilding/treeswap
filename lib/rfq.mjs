import {
  getAddress,
  id,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";

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

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

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
  const source = String(envelope.source ?? "").trim();
  let offer;

  try {
    offer = normalizedOffer(envelope.offer ?? {});
  } catch (error) {
    return { valid: false, reasons: [error.message] };
  }

  if (!source || source.length > Number(policy.maxSourceLength)) reasons.push("invalid quote source");
  if (receivedAt > observedAt + Number(policy.maxClockSkewSeconds)) reasons.push("quote receipt time is in the future");
  if (!BYTES32.test(offer.offerId) || !BYTES32.test(offer.requestId)) reasons.push("invalid offer or request identifier");
  if (!BYTES32.test(offer.paymentHash) || !BYTES32.test(offer.invoiceDigest)) reasons.push("invalid payment or invoice digest");
  if (offer.requestId !== request.requestId) reasons.push("offer belongs to a different request");
  if (offer.direction !== directionHash(request.direction)) reasons.push("offer direction changed");
  if (!sameAddress(offer.user, request.user)) reasons.push("offer user changed");
  if (!sameAddress(offer.beneficiary, request.beneficiary)) reasons.push("offer beneficiary changed");
  if (offer.paymentHash !== request.paymentHash) reasons.push("offer payment hash changed");
  if (offer.invoiceDigest !== request.invoiceDigest) reasons.push("offer invoice digest changed");
  if (offer.requestNonce !== bigint(request.nonce, "request.nonce")) reasons.push("offer request nonce changed");
  if (offer.grossBitAmount === 0n || offer.lightningAmountSats === 0n || offer.feeBitAmount >= offer.grossBitAmount) {
    reasons.push("offer amount is invalid");
  }
  if (offer.expiresAt <= observedAt) reasons.push("offer expired");
  if (offer.expiresAt > integer(request.expiresAt, "request.expiresAt")) reasons.push("offer outlives the request");
  if (offer.expiresAt > observedAt + Number(policy.maxQuoteTtlSeconds)) reasons.push("offer expiry exceeds the short-lived quote limit");
  if (offer.capacityEpoch !== integer(request.capacityEpoch, "request.capacityEpoch")) reasons.push("offer capacity declaration is stale");
  if (offer.maxRoutingFeeSats > bigint(request.maxRoutingFeeSats, "request.maxRoutingFeeSats")) {
    reasons.push("routing fee cap changed");
  }

  const feeBps = offer.grossBitAmount === 0n ? 10_001n : offer.feeBitAmount * 10_000n / offer.grossBitAmount;
  if (feeBps > bigint(request.maxFeeBps, "request.maxFeeBps")) reasons.push("BIT fee exceeds the user cap");

  if (request.direction === "lightning-to-bit") {
    if (offer.grossBitAmount - offer.feeBitAmount !== bigint(request.exactBitOutputWei, "request.exactBitOutputWei")) {
      reasons.push("exact BIT output changed");
    }
  } else if (offer.lightningAmountSats !== bigint(request.exactLightningOutputSats, "request.exactLightningOutputSats")) {
    reasons.push("exact Lightning output changed");
  }

  const signature = String(envelope.signature ?? "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    reasons.push("solver signature is not canonical");
  } else {
    try {
      const recovered = verifyTypedData(rfqDomain(request), RFQ_OFFER_TYPES, offer, signature);
      if (!sameAddress(recovered, offer.solver)) reasons.push("solver signature is invalid");
    } catch {
      reasons.push("solver signature is invalid");
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    envelope: { source, receivedAt, signature, offer },
  };
}

export function buildReceivedQuoteBook({ request, envelopes, now, policy }) {
  if (!Array.isArray(envelopes)) throw new TypeError("envelopes must be an array");
  if (envelopes.length > Number(policy.maxOffersPerRequest)) throw new RangeError("quote response exceeds the bounded offer limit");

  const rejected = [];
  const valid = [];
  const seenOfferIds = new Set();
  for (const envelope of envelopes) {
    const result = validateSolverOffer({ request, envelope, now, policy });
    const offerId = result.envelope?.offer?.offerId ?? envelope?.offer?.offerId ?? "unknown";
    if (!result.valid || seenOfferIds.has(offerId)) {
      rejected.push({ offerId, reasons: result.valid ? ["duplicate offer identifier"] : result.reasons });
      continue;
    }
    seenOfferIds.add(offerId);
    valid.push(result.envelope);
  }

  valid.sort((left, right) => compareEnvelopes(request.direction, left, right));
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

  if (uniqueSolvers.length < Number(policy.minimumIndependentSolvers)) {
    throw new RangeError("not enough independent valid solver offers");
  }

  const receipt = uniqueSolvers
    .map(({ source, receivedAt, signature, offer }) => `${offer.offerId}:${offer.solver}:${source}:${receivedAt}:${signature}`)
    .join("|");
  const receiptDigest = keccak256(toUtf8Bytes(receipt));

  return Object.freeze({
    requestId: request.requestId,
    label: "Best received quote",
    receiptDigest,
    solverCount: uniqueSolvers.length,
    sourceCount: new Set(uniqueSolvers.map((envelope) => envelope.source)).size,
    offers: uniqueSolvers,
    rejected,
  });
}

export function selectReceivedQuote(book, offerId) {
  const selected = book.offers.find((envelope) => envelope.offer.offerId === offerId);
  if (!selected) throw new RangeError("selected quote is not in the verified received set");
  return Object.freeze({
    requestId: book.requestId,
    receiptDigest: book.receiptDigest,
    selected,
    requiresExactUserAuthorization: true,
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
