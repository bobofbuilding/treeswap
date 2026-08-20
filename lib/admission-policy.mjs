const BPS = 10_000n;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
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

function sameIdentity(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function addReason(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

export function assessRfqAdmission({ request, identity, usage, policy, now }) {
  const reasons = [];
  const observedAt = integer(now, "now");
  const expiresAt = integer(request.expiresAt, "request.expiresAt");
  const notionalSats = bigint(request.notionalSats, "request.notionalSats");
  const nonce = bigint(request.nonce, "request.nonce");

  addReason(reasons, identity.authenticated !== true, "authenticated identity required");
  addReason(reasons, !sameIdentity(identity.key, request.user), "request identity mismatch");
  addReason(reasons, !BYTES32.test(String(request.requestId ?? "")), "invalid request identifier");
  addReason(
    reasons,
    request.direction !== "lightning-to-bit" && request.direction !== "bit-to-lightning",
    "unsupported direction",
  );
  addReason(reasons, notionalSats < bigint(policy.minimumNotionalSats, "policy.minimumNotionalSats"), "request is below minimum quantity");
  addReason(reasons, expiresAt <= observedAt, "request expired");
  addReason(reasons, expiresAt > observedAt + integer(policy.maxRfqTtlSeconds, "policy.maxRfqTtlSeconds"), "request expiry exceeds RFQ limit");
  addReason(
    reasons,
    integer(usage.activeRequests, "usage.activeRequests") >= integer(policy.maxActiveRequestsPerIdentity, "policy.maxActiveRequestsPerIdentity"),
    "identity has too many active requests",
  );
  addReason(
    reasons,
    integer(usage.acceptedInWindow, "usage.acceptedInWindow") >= integer(policy.maxRequestsPerWindow, "policy.maxRequestsPerWindow"),
    "identity request quota exhausted",
  );
  addReason(
    reasons,
    integer(usage.cancellationsInWindow, "usage.cancellationsInWindow") >= integer(policy.maxCancellationsPerWindow, "policy.maxCancellationsPerWindow"),
    "identity cancellation quota exhausted",
  );
  addReason(
    reasons,
    nonce <= bigint(usage.cancellationSequence, "usage.cancellationSequence"),
    "request nonce was cancelled or already superseded",
  );

  return Object.freeze({
    allowed: reasons.length === 0,
    reasons,
    inventoryReserved: false,
    nextUsage: reasons.length === 0
      ? Object.freeze({
          ...usage,
          activeRequests: integer(usage.activeRequests, "usage.activeRequests") + 1,
          acceptedInWindow: integer(usage.acceptedInWindow, "usage.acceptedInWindow") + 1,
        })
      : null,
  });
}

function solverReliabilityBps(solver) {
  const successful = bigint(solver.successfulFills, "solver.successfulFills");
  const failed = bigint(solver.attributableFailures, "solver.attributableFailures");
  return successful + failed === 0n ? BPS : successful * BPS / (successful + failed);
}

export function assessFirmOffer({ offer, solver, policy, now }) {
  const reasons = [];
  const observedAt = integer(now, "now");
  const expiresAt = integer(offer.expiresAt, "offer.expiresAt");
  const snapshotAt = integer(solver.capacityObservedAt, "solver.capacityObservedAt");
  const capabilityExpiresAt = integer(solver.capabilityExpiresAt, "solver.capabilityExpiresAt");
  const amount = offer.direction === "lightning-to-bit"
    ? bigint(offer.bitAmountWei, "offer.bitAmountWei")
    : bigint(offer.lightningAmountSats, "offer.lightningAmountSats");
  const available = offer.direction === "lightning-to-bit"
    ? bigint(solver.availableBitWei, "solver.availableBitWei")
    : bigint(solver.availableLightningSats, "solver.availableLightningSats");
  const committed = offer.direction === "lightning-to-bit"
    ? bigint(solver.committedBitWei, "solver.committedBitWei")
    : bigint(solver.committedLightningSats, "solver.committedLightningSats");
  const successful = bigint(solver.successfulFills, "solver.successfulFills");
  const failed = bigint(solver.attributableFailures, "solver.attributableFailures");
  const reliabilityBps = solverReliabilityBps(solver);
  const capabilityDigest = String(solver.capabilityDigest ?? "");
  const snapshotDigest = String(solver.snapshotDigest ?? "");
  const establishedFillThreshold = bigint(
    policy.minimumCompletedFillsForEstablished,
    "policy.minimumCompletedFillsForEstablished",
  );
  const unknownExposureCapSats = bigint(
    policy.unknownSolverMaxBitToLightningSats,
    "policy.unknownSolverMaxBitToLightningSats",
  );
  const establishedExposureCapSats = bigint(
    policy.establishedSolverMaxBitToLightningSats,
    "policy.establishedSolverMaxBitToLightningSats",
  );
  if (establishedFillThreshold === 0n) {
    throw new RangeError("policy.minimumCompletedFillsForEstablished must be positive");
  }
  if (unknownExposureCapSats === 0n) {
    throw new RangeError("policy.unknownSolverMaxBitToLightningSats must be positive");
  }
  if (establishedExposureCapSats < unknownExposureCapSats) {
    throw new RangeError("established solver exposure cap cannot be below unknown solver cap");
  }
  const exposureTier = successful >= establishedFillThreshold ? "established" : "unknown";
  const exposureCapSats = exposureTier === "established"
    ? establishedExposureCapSats
    : unknownExposureCapSats;

  addReason(reasons, !BYTES32.test(capabilityDigest), "solver capability is not cryptographically verified");
  addReason(reasons, !BYTES32.test(snapshotDigest), "solver capacity snapshot is not cryptographically bound");
  addReason(reasons, solver.suspended === true, "solver is suspended");
  addReason(reasons, solver.capacityConflict === true, "solver capacity conflicts with active commitments");
  addReason(reasons, offer.solverSigned !== true, "firm offer lacks solver commitment");
  addReason(reasons, amount <= 0n, "firm offer amount must be positive");
  addReason(reasons, expiresAt <= observedAt, "firm offer expired");
  addReason(reasons, expiresAt > observedAt + integer(policy.maxFirmQuoteTtlSeconds, "policy.maxFirmQuoteTtlSeconds"), "firm offer expiry exceeds limit");
  addReason(reasons, capabilityExpiresAt <= observedAt, "solver capability expired");
  addReason(reasons, expiresAt > capabilityExpiresAt, "firm offer outlives solver capability");
  addReason(reasons, snapshotAt > observedAt || observedAt - snapshotAt > integer(policy.maxCapacityAgeSeconds, "policy.maxCapacityAgeSeconds"), "solver capacity is stale");
  addReason(reasons, integer(offer.capacityEpoch, "offer.capacityEpoch") !== integer(solver.capacityEpoch, "solver.capacityEpoch"), "solver capacity epoch changed");
  addReason(reasons, available < committed || available - committed < amount, "firm offer exceeds uncommitted capacity");
  addReason(
    reasons,
    integer(solver.activeFirmQuotes, "solver.activeFirmQuotes") >= integer(policy.maxActiveFirmQuotesPerSolver, "policy.maxActiveFirmQuotesPerSolver"),
    "solver firm-quote capacity exhausted",
  );
  if (offer.direction === "bit-to-lightning") {
    addReason(reasons, amount > exposureCapSats, `${exposureTier} solver BIT-to-Lightning cap exceeded`);
  }
  addReason(
    reasons,
    integer(solver.consecutiveFailures, "solver.consecutiveFailures") >= integer(policy.maxConsecutiveFailures, "policy.maxConsecutiveFailures"),
    "solver failed consecutive firm quotes",
  );
  if (successful + failed >= bigint(policy.minimumReliabilitySample, "policy.minimumReliabilitySample")) {
    addReason(reasons, reliabilityBps < bigint(policy.minimumReliabilityBps, "policy.minimumReliabilityBps"), "solver reliability is below admission floor");
  }

  return Object.freeze({
    allowed: reasons.length === 0,
    reasons,
    reliabilityBps,
    exposureTier,
    exposureCapSats,
    commitment: reasons.length === 0
      ? Object.freeze({
          direction: offer.direction,
          amount,
          capacityEpoch: offer.capacityEpoch,
          expiresAt,
        })
      : null,
  });
}

export function reserveFirmOfferCapacity({ solver, assessment }) {
  if (!assessment?.allowed || !assessment.commitment) throw new Error("only a verified firm offer can reserve capacity");
  const commitment = assessment.commitment;
  const next = { ...solver, activeFirmQuotes: integer(solver.activeFirmQuotes, "solver.activeFirmQuotes") + 1 };
  if (commitment.direction === "lightning-to-bit") {
    next.committedBitWei = bigint(solver.committedBitWei, "solver.committedBitWei") + commitment.amount;
  } else {
    next.committedLightningSats = bigint(solver.committedLightningSats, "solver.committedLightningSats") + commitment.amount;
  }
  return Object.freeze(next);
}

export function recordFirmOfferOutcome({ solver, commitment, outcome, policy }) {
  const permitted = new Set(["filled", "solver-failed", "expired-unexercised", "user-abandoned"]);
  if (!permitted.has(outcome)) throw new RangeError("unsupported firm-offer outcome");
  const next = {
    ...solver,
    activeFirmQuotes: Math.max(0, integer(solver.activeFirmQuotes, "solver.activeFirmQuotes") - 1),
  };
  if (commitment.direction === "lightning-to-bit") {
    const committed = bigint(solver.committedBitWei, "solver.committedBitWei");
    if (committed < commitment.amount) throw new RangeError("BIT commitment accounting underflow");
    next.committedBitWei = committed - commitment.amount;
  } else {
    const committed = bigint(solver.committedLightningSats, "solver.committedLightningSats");
    if (committed < commitment.amount) throw new RangeError("Lightning commitment accounting underflow");
    next.committedLightningSats = committed - commitment.amount;
  }

  if (outcome === "filled") {
    next.successfulFills = bigint(solver.successfulFills, "solver.successfulFills") + 1n;
    next.consecutiveFailures = 0;
  } else if (outcome === "solver-failed") {
    next.attributableFailures = bigint(solver.attributableFailures, "solver.attributableFailures") + 1n;
    next.consecutiveFailures = integer(solver.consecutiveFailures, "solver.consecutiveFailures") + 1;
    if (next.consecutiveFailures >= integer(policy.maxConsecutiveFailures, "policy.maxConsecutiveFailures")) {
      next.suspended = true;
    }
  }
  return Object.freeze(next);
}
