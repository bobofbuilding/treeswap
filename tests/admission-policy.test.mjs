import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import {
  assessFirmOffer,
  assessRfqAdmission,
  recordFirmOfferOutcome,
  reserveFirmOfferCapacity,
} from "../lib/admission-policy.mjs";

const NOW = 2_000_000_000;
const BIT = 10n ** 18n;
const USER = "0x1111111111111111111111111111111111111111";
const policy = {
  minimumNotionalSats: 1_000n,
  maxRfqTtlSeconds: 30,
  maxActiveRequestsPerIdentity: 2,
  maxRequestsPerWindow: 5,
  maxCancellationsPerWindow: 3,
  maxFirmQuoteTtlSeconds: 30,
  maxCapacityAgeSeconds: 10,
  maxActiveFirmQuotesPerSolver: 2,
  maxConsecutiveFailures: 2,
  minimumReliabilitySample: 4n,
  minimumReliabilityBps: 9_000n,
  minimumCompletedFillsForEstablished: 3n,
  unknownSolverMaxBitToLightningSats: 5_000n,
  establishedSolverMaxBitToLightningSats: 100_000n,
  maxGlobalBitToLightningInFlightSats: 500_000n,
};

function request(overrides = {}) {
  return {
    requestId: id("request"),
    user: USER,
    direction: "lightning-to-bit",
    notionalSats: 10_000n,
    nonce: 2n,
    expiresAt: NOW + 20,
    ...overrides,
  };
}

function usage(overrides = {}) {
  return { activeRequests: 0, acceptedInWindow: 0, cancellationsInWindow: 0, cancellationSequence: 1n, ...overrides };
}

function solver(overrides = {}) {
  return {
    capabilityDigest: id("verified-capability"),
    snapshotDigest: id("verified-capacity-snapshot"),
    suspended: false,
    capacityObservedAt: NOW - 2,
    capabilityExpiresAt: NOW + 30,
    capacityEpoch: 7,
    availableBitWei: 100n * BIT,
    committedBitWei: 0n,
    availableLightningSats: 100_000n,
    committedLightningSats: 0n,
    activeFirmQuotes: 0,
    successfulFills: 9n,
    attributableFailures: 1n,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function offer(overrides = {}) {
  return {
    direction: "lightning-to-bit",
    bitAmountWei: 10n * BIT,
    lightningAmountSats: 1_000n,
    maxRoutingFeeSats: 0n,
    capacityEpoch: 7,
    expiresAt: NOW + 20,
    solverSigned: true,
    ...overrides,
  };
}

test("admits a short authenticated RFQ without reserving solver inventory", () => {
  const result = assessRfqAdmission({
    request: request(),
    identity: { authenticated: true, key: USER },
    usage: usage(),
    policy,
    now: NOW,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.inventoryReserved, false);
  assert.equal(result.nextUsage.activeRequests, 1);
});

test("rejects request flooding, cancellation churn, stale nonces, and dust", () => {
  for (const [changedRequest, changedUsage, reason] of [
    [request(), usage({ activeRequests: 2 }), /too many active/],
    [request(), usage({ acceptedInWindow: 5 }), /request quota/],
    [request(), usage({ cancellationsInWindow: 3 }), /cancellation quota/],
    [request({ nonce: 1n }), usage(), /cancelled or already superseded/],
    [request({ notionalSats: 999n }), usage(), /minimum quantity/],
  ]) {
    const result = assessRfqAdmission({
      request: changedRequest,
      identity: { authenticated: true, key: USER },
      usage: changedUsage,
      policy,
      now: NOW,
    });
    assert.equal(result.allowed, false);
    assert.match(result.reasons.join("; "), reason);
  }
});

test("requires cryptographically verified, fresh, reliable, signed solver capacity", () => {
  const accepted = assessFirmOffer({ offer: offer(), solver: solver(), policy, now: NOW });
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.reliabilityBps, 9_000n);

  for (const [changed, reason] of [
    [solver({ capabilityDigest: "operator-admitted" }), /not cryptographically verified/],
    [solver({ snapshotDigest: "operator-approved" }), /not cryptographically bound/],
    [solver({ capabilityExpiresAt: NOW }), /capability expired/],
    [solver({ capabilityExpiresAt: NOW + 10 }), /outlives solver capability/],
    [solver({ capacityObservedAt: NOW - 11 }), /capacity is stale/],
    [solver({ successfulFills: 8n, attributableFailures: 2n }), /reliability/],
    [solver({ availableBitWei: 10n * BIT, committedBitWei: 1n }), /uncommitted capacity/],
  ]) {
    const result = assessFirmOffer({ offer: offer(), solver: changed, policy, now: NOW });
    assert.equal(result.allowed, false);
    assert.match(result.reasons.join("; "), reason);
  }
});

test("caps unknown BIT-to-Lightning solvers and promotes only from completed-fill history", () => {
  const unknown = solver({ successfulFills: 0n, attributableFailures: 0n });
  const withinCap = assessFirmOffer({
    offer: offer({ direction: "bit-to-lightning", bitAmountWei: 0n, lightningAmountSats: 5_000n }),
    solver: unknown,
    policy,
    now: NOW,
  });
  assert.equal(withinCap.allowed, true);
  assert.equal(withinCap.exposureTier, "unknown");
  assert.equal(withinCap.exposureCapSats, 5_000n);

  const routingAboveCap = assessFirmOffer({
    offer: offer({
      direction: "bit-to-lightning",
      bitAmountWei: 0n,
      lightningAmountSats: 5_000n,
      maxRoutingFeeSats: 1n,
    }),
    solver: unknown,
    policy,
    now: NOW,
  });
  assert.equal(routingAboveCap.allowed, false);
  assert.match(routingAboveCap.reasons.join("; "), /unknown solver BIT-to-Lightning cap exceeded/);

  const aboveCap = assessFirmOffer({
    offer: offer({ direction: "bit-to-lightning", bitAmountWei: 0n, lightningAmountSats: 5_001n }),
    solver: unknown,
    policy,
    now: NOW,
  });
  assert.equal(aboveCap.allowed, false);
  assert.match(aboveCap.reasons.join("; "), /unknown solver BIT-to-Lightning cap exceeded/);

  const established = assessFirmOffer({
    offer: offer({ direction: "bit-to-lightning", bitAmountWei: 0n, lightningAmountSats: 50_000n }),
    solver: solver({ successfulFills: 3n, attributableFailures: 0n }),
    policy,
    now: NOW,
  });
  assert.equal(established.allowed, true);
  assert.equal(established.exposureTier, "established");
  assert.equal(established.exposureCapSats, 100_000n);
});

test("rejects malformed solver exposure policy instead of weakening after promotion", () => {
  for (const changedPolicy of [
    { ...policy, minimumCompletedFillsForEstablished: 0n },
    { ...policy, unknownSolverMaxBitToLightningSats: 0n },
    { ...policy, establishedSolverMaxBitToLightningSats: 4_999n },
  ]) {
    assert.throws(
      () => assessFirmOffer({ offer: offer(), solver: solver(), policy: changedPolicy, now: NOW }),
      RangeError,
    );
  }
});

test("atomically accounts for capacity committed to a firm offer", () => {
  const current = solver();
  const assessment = assessFirmOffer({ offer: offer(), solver: current, policy, now: NOW });
  const reserved = reserveFirmOfferCapacity({ solver: current, assessment });
  assert.equal(reserved.committedBitWei, 10n * BIT);
  assert.equal(reserved.committedLightningSats, 1_000n);
  assert.equal(reserved.activeFirmQuotes, 1);

  const released = recordFirmOfferOutcome({
    solver: reserved,
    commitment: assessment.commitment,
    outcome: "filled",
    policy,
  });
  assert.equal(released.committedBitWei, 0n);
  assert.equal(released.committedLightningSats, 0n);
  assert.equal(released.successfulFills, 10n);
  assert.equal(released.consecutiveFailures, 0);
});

test("suspends repeated attributable last-look failures but not user expiry", () => {
  const current = solver({ successfulFills: 0n, attributableFailures: 0n });
  const assessment = assessFirmOffer({ offer: offer(), solver: current, policy, now: NOW });
  const firstReserved = reserveFirmOfferCapacity({ solver: current, assessment });
  const expired = recordFirmOfferOutcome({
    solver: firstReserved,
    commitment: assessment.commitment,
    outcome: "expired-unexercised",
    policy,
  });
  assert.equal(expired.attributableFailures, 0n);
  assert.equal(expired.suspended, false);

  const firstFailureReserved = reserveFirmOfferCapacity({ solver: expired, assessment });
  const firstFailure = recordFirmOfferOutcome({
    solver: firstFailureReserved,
    commitment: assessment.commitment,
    outcome: "solver-failed",
    policy,
  });
  assert.equal(firstFailure.suspended, false);

  const secondFailureReserved = reserveFirmOfferCapacity({ solver: firstFailure, assessment });
  const secondFailure = recordFirmOfferOutcome({
    solver: secondFailureReserved,
    commitment: assessment.commitment,
    outcome: "solver-failed",
    policy,
  });
  assert.equal(secondFailure.suspended, true);
});
