import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { id } from "ethers";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";

const NOW = 2_000_000_000;
const USER = "0x1111111111111111111111111111111111111111";
const SOLVER = "0x2222222222222222222222222222222222222222";
const SOLVER_TWO = "0x3333333333333333333333333333333333333333";
const BIT = 10n ** 18n;
const SETTLE_INVOICE = "/invoicesrpc.Invoices/SettleInvoice";

function hash(label) {
  return id(label).toLowerCase();
}

function policy(overrides = {}) {
  return {
    minimumNotionalSats: "1000",
    maxRfqTtlSeconds: 120,
    maxActiveRequestsPerIdentity: 10,
    maxRequestsPerWindow: 2,
    maxCancellationsPerWindow: 2,
    quotaWindowSeconds: 60,
    maxFirmQuoteTtlSeconds: 120,
    maxCapacityAgeSeconds: 30,
    maxActiveFirmQuotesPerSolver: 4,
    maxConsecutiveFailures: 2,
    minimumReliabilitySample: "4",
    minimumReliabilityBps: "9000",
    minimumCompletedFillsForEstablished: "3",
    unknownSolverMaxBitToLightningSats: "5000",
    establishedSolverMaxBitToLightningSats: "100000",
    maxGlobalBitToLightningInFlightSats: "500000",
    ...overrides,
  };
}

function identity() {
  return { authenticated: true, commitment: hash("opaque-pricing-identity"), key: USER };
}

function request(label, nonce, overrides = {}) {
  return {
    requestId: hash(`request:${label}`),
    user: USER,
    direction: "lightning-to-bit",
    notionalSats: "10000",
    nonce: String(nonce),
    expiresAt: NOW + 120,
    ...overrides,
  };
}

function snapshot(epoch = 7, overrides = {}) {
  return {
    solverId: SOLVER,
    capabilityDigest: hash(`solver-capability:${epoch}`),
    capabilityExpiresAt: NOW + 300 + (epoch - 7),
    capabilityVerified: true,
    capacityEpoch: epoch,
    availableBitWei: String(100n * BIT),
    availableLightningSats: "100000",
    observedAt: NOW + (epoch - 7),
    ...overrides,
  };
}

function reservation(value, label, overrides = {}) {
  return {
    offerId: hash(`offer:${label}`),
    offerDigest: hash(`offer-digest:${label}`),
    selectionAuthorizationDigest: hash(`selection-authorization:${label}`),
    selectionAuthorizationExpiresAt: NOW + 30,
    requestId: value.requestId,
    solverId: SOLVER,
    offer: {
      direction: value.direction,
      capabilityDigest: hash("solver-capability:7"),
      bitAmountWei: String(60n * BIT),
      lightningAmountSats: value.notionalSats,
      maxRoutingFeeSats: "0",
      capacityEpoch: 7,
      expiresAt: NOW + 30,
      signatureVerified: true,
    },
    policy: policy(),
    now: NOW + 1,
    ...overrides,
  };
}

function completeSelectedSettlement(store, firmOffer, label, proofDigest) {
  const settlement = {
    settlementId: hash(`settlement:${label}`),
    pricingId: hash(`pricing:${label}`),
    direction: "lightning-to-bit",
    nonceAuthorityDigest: hash(`nonce-authority:${label}`),
    intentNonce: String(100 + firmOffer.capacityEpoch),
    intentDigest: hash(`intent:${label}`),
    paymentHash: hash(`payment:${label}`),
    invoiceDigest: hash(`invoice:${label}`),
    amountSats: "10000",
    quoteReceiptDigest: hash(`quote-receipt:${label}`),
    selectedSetDigest: hash(`selected-set:${label}`),
    selectedOfferId: firmOffer.offerId,
    capacityEpoch: firmOffer.capacityEpoch,
    createdAt: NOW + 2,
  };
  store.acceptSettlement(settlement);
  store.recordReservation({
    settlementId: settlement.settlementId,
    reservationId: hash(`reservation:${label}`),
    reservationTxHash: hash(`reservation-tx:${label}`),
    reservationBlockNumber: 20_000_000,
    reservationBlockHash: hash(`reservation-block:${label}`),
    reservationIntentDigest: settlement.intentDigest,
    observedAt: NOW + 3,
  });
  const action = store.planAction({
    actionId: hash(`action:${label}`),
    settlementId: settlement.settlementId,
    method: SETTLE_INVOICE,
    requestId: hash(`action-request:${label}`),
    payloadDigest: hash(`action-payload:${label}`),
    intentDigest: settlement.intentDigest,
    paymentHash: settlement.paymentHash,
    invoiceDigest: settlement.invoiceDigest,
    amountSats: settlement.amountSats,
    capacityEpoch: settlement.capacityEpoch,
    plannedAt: NOW + 4,
  });
  store.claimAction(action.actionId, NOW + 5);
  store.recordActionResult({
    actionId: action.actionId,
    outcome: "confirmed",
    resultDigest: hash(`action-result:${label}`),
    resultCode: "SETTLED",
    recordedAt: NOW + 6,
  });
  store.recordTerminal({
    settlementId: settlement.settlementId,
    terminalState: "COMPLETED",
    proofDigest,
    assetsReconciled: true,
    recordedAt: NOW + 7,
  });
}

test("persists exact rolling RFQ quotas, idempotency, and backward-clock rejection across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-admission-rolling-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await CoordinatorStore.open(path);
  const one = request("rolling-one", 2);
  const two = request("rolling-two", 3);
  const three = request("rolling-three", 4, { expiresAt: NOW + 180 });
  try {
    const admitted = first.admitRfq({ identity: identity(), request: one, policy: policy(), now: NOW });
    assert.equal(admitted.request.state, "ACTIVE");
    assert.equal(admitted.usage.acceptedInWindow, 1);
    assert.equal(first.admitRfq({ identity: identity(), request: one, policy: policy(), now: NOW + 1 }).usage.acceptedInWindow, 1);
    assert.equal(first.admitRfq({ identity: identity(), request: two, policy: policy(), now: NOW + 1 }).usage.acceptedInWindow, 2);
    assert.throws(
      () => first.admitRfq({ identity: identity(), request: three, policy: policy(), now: NOW + 2 }),
      /request quota exhausted/,
    );
  } finally {
    first.close();
  }

  const reopened = await CoordinatorStore.open(path);
  try {
    assert.throws(
      () => reopened.admitRfq({ identity: identity(), request: three, policy: policy(), now: NOW + 2 }),
      /request quota exhausted/,
    );
    const afterWindow = reopened.admitRfq({ identity: identity(), request: three, policy: policy(), now: NOW + 62 });
    assert.equal(afterWindow.usage.acceptedInWindow, 1);
    assert.throws(
      () => reopened.admitRfq({
        identity: identity(),
        request: request("clock-regression", 5, { expiresAt: NOW + 180 }),
        policy: policy(),
        now: NOW + 61,
      }),
      /clock moved backward/,
    );
  } finally {
    reopened.close();
  }
});

test("persists cancellation sequences, releases affected requests, and counts cancellation churn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-admission-cancel-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CoordinatorStore.open(path);
  const admissionPolicy = policy({ maxRequestsPerWindow: 10, maxCancellationsPerWindow: 1 });
  const one = request("cancel-one", 2);
  const two = request("cancel-two", 3);
  const cancellation = {
    identity: identity(),
    cancellationId: hash("cancel-through-two"),
    cancellationSequence: "2",
    recordedAt: NOW + 2,
  };
  try {
    store.admitRfq({ identity: identity(), request: one, policy: admissionPolicy, now: NOW });
    assert.throws(
      () => store.admitRfq({
        identity: identity(),
        request: request("policy-drift", 9),
        policy: policy({ maxRequestsPerWindow: 11, maxCancellationsPerWindow: 1 }),
        now: NOW + 1,
      }),
      /policy changed after the coordinator policy was bound/,
    );
    store.admitRfq({ identity: identity(), request: two, policy: admissionPolicy, now: NOW + 1 });
    const canceled = store.cancelRfqs(cancellation);
    assert.deepEqual(canceled, { cancellationSequence: "2", canceledRequests: 1, idempotent: false });
    assert.equal(store.getRfqRequest(one.requestId).state, "CANCELED");
    assert.equal(store.getRfqRequest(two.requestId).state, "ACTIVE");
    assert.equal(store.cancelRfqs(cancellation).idempotent, true);
    assert.throws(
      () => store.cancelRfqs({ ...cancellation, cancellationId: hash("stale-cancel") }),
      /must advance permanently/,
    );
    assert.throws(
      () => store.admitRfq({
        identity: identity(),
        request: request("canceled-nonce-reuse", 2),
        policy: admissionPolicy,
        now: NOW + 3,
      }),
      /cancelled or already superseded/,
    );
    assert.throws(
      () => store.admitRfq({
        identity: identity(),
        request: request("cancellation-churn", 4),
        policy: admissionPolicy,
        now: NOW + 3,
      }),
      /cancellation quota exhausted/,
    );
    const recovered = store.admitRfq({
      identity: identity(),
      request: request("after-cancel-window", 4, { expiresAt: NOW + 180 }),
      policy: admissionPolicy,
      now: NOW + 63,
    });
    assert.equal(recovered.request.state, "ACTIVE");
  } finally {
    store.close();
  }
});

test("atomically persists firm capacity, fails closed on conflicting snapshots, and releases exact commitments", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const one = request("capacity-one", 2);
  const two = request("capacity-two", 3);
  try {
    store.admitRfq({ identity: identity(), request: one, policy: policy(), now: NOW });
    store.admitRfq({ identity: identity(), request: two, policy: policy(), now: NOW });
    assert.equal(store.recordSolverCapacity(snapshot()).capacityConflict, false);
    const first = store.reserveVerifiedFirmOffer(reservation(one, "capacity-one"));
    assert.equal(first.state, "ACTIVE");
    assert.equal(store.getSolverCapacity(SOLVER).committedBitWei, String(60n * BIT));
    assert.equal(store.getSolverCapacity(SOLVER).committedLightningSats, one.notionalSats);
    assert.equal(store.reserveVerifiedFirmOffer(reservation(one, "capacity-one")).offerId, first.offerId);
    assert.equal(store.getSolverCapacity(SOLVER).activeFirmQuotes, 1);

    assert.throws(
      () => store.reserveVerifiedFirmOffer(reservation(two, "capacity-two", {
        offer: { ...reservation(two, "capacity-two").offer, bitAmountWei: String(50n * BIT) },
      })),
      /exceeds uncommitted capacity/,
    );
    const conflicted = store.recordSolverCapacity(snapshot(8, {
      availableBitWei: String(50n * BIT),
      observedAt: NOW + 2,
    }));
    assert.equal(conflicted.capacityConflict, true);
    assert.throws(
      () => store.reserveVerifiedFirmOffer(reservation(two, "conflicted", {
        offer: {
          ...reservation(two, "conflicted").offer,
          capabilityDigest: hash("solver-capability:8"),
          capacityEpoch: 8,
          bitAmountWei: String(10n * BIT),
        },
        now: NOW + 3,
      })),
      /capacity conflicts with active commitments/,
    );
    assert.throws(() => store.recordFirmOfferOutcome({
      offerId: first.offerId,
      outcome: "expired-unexercised",
      evidenceDigest: hash("too-early-expiry"),
      recordedAt: NOW + 29,
      policy: policy(),
    }), /before its signed deadline/);
    const expired = store.recordFirmOfferOutcome({
      offerId: first.offerId,
      outcome: "expired-unexercised",
      evidenceDigest: hash("exact-expiry"),
      recordedAt: NOW + 30,
      policy: policy(),
    });
    assert.equal(expired.state, "EXPIRED_UNEXERCISED");
    assert.equal(store.getSolverCapacity(SOLVER).committedBitWei, "0");
    assert.equal(store.getSolverCapacity(SOLVER).committedLightningSats, "0");
    assert.equal(store.getSolverCapacity(SOLVER).capacityConflict, false);

    const refreshed = store.recordSolverCapacity(snapshot(9, { observedAt: NOW + 31 }));
    assert.equal(refreshed.capacityEpoch, 9);
    const admitted = store.reserveVerifiedFirmOffer(reservation(two, "capacity-recovered", {
      selectionAuthorizationExpiresAt: NOW + 60,
      offer: {
        ...reservation(two, "capacity-recovered").offer,
        capabilityDigest: hash("solver-capability:9"),
        capacityEpoch: 9,
        bitAmountWei: String(50n * BIT),
        expiresAt: NOW + 60,
      },
      now: NOW + 32,
    }));
    assert.equal(admitted.state, "ACTIVE");
  } finally {
    store.close();
  }
});

test("attributes solver failures durably while user abandonment does not damage reliability", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const admissionPolicy = policy({ maxRequestsPerWindow: 10 });
  try {
    store.recordSolverCapacity(snapshot());
    for (const [index, nonce] of [[1, 2], [2, 3]]) {
      const rfq = request(`solver-failure-${index}`, nonce);
      store.admitRfq({ identity: identity(), request: rfq, policy: admissionPolicy, now: NOW + index - 1 });
      const firm = store.reserveVerifiedFirmOffer(reservation(rfq, `solver-failure-${index}`, {
        offer: { ...reservation(rfq, `solver-failure-${index}`).offer, bitAmountWei: String(10n * BIT) },
        policy: admissionPolicy,
        now: NOW + index,
      }));
      store.recordFirmOfferOutcome({
        offerId: firm.offerId,
        outcome: "solver-failed",
        evidenceDigest: hash(`solver-failure-proof-${index}`),
        recordedAt: NOW + index + 1,
        policy: admissionPolicy,
      });
    }
    const suspended = store.getSolverCapacity(SOLVER);
    assert.equal(suspended.attributableFailures, "2");
    assert.equal(suspended.consecutiveFailures, 2);
    assert.equal(suspended.suspended, true);

    const blocked = request("suspended-solver", 4);
    store.admitRfq({ identity: identity(), request: blocked, policy: admissionPolicy, now: NOW + 4 });
    assert.throws(
      () => store.reserveVerifiedFirmOffer(reservation(blocked, "suspended-solver", {
        offer: { ...reservation(blocked, "suspended-solver").offer, bitAmountWei: String(10n * BIT) },
        policy: admissionPolicy,
        now: NOW + 5,
      })),
      /solver is suspended/,
    );
  } finally {
    store.close();
  }

  const separate = await CoordinatorStore.open(":memory:", { allowMemory: true });
  try {
    separate.recordSolverCapacity(snapshot());
    const rfq = request("user-abandoned", 2);
    separate.admitRfq({ identity: identity(), request: rfq, policy: policy(), now: NOW });
    const firm = separate.reserveVerifiedFirmOffer(reservation(rfq, "user-abandoned"));
    separate.resolveRfq({
      requestId: rfq.requestId,
      outcome: "user-abandoned",
      evidenceDigest: hash("user-abandoned-proof"),
      recordedAt: NOW + 2,
    });
    assert.equal(separate.getFirmOffer(firm.offerId).state, "USER_ABANDONED");
    assert.equal(separate.getSolverCapacity(SOLVER).attributableFailures, "0");
    assert.equal(separate.getSolverCapacity(SOLVER).suspended, false);
  } finally {
    separate.close();
  }
});

test("records a fill, exercises its RFQ, and releases every competing firm offer in one transaction", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const rfq = request("atomic-fill", 2);
  try {
    store.admitRfq({ identity: identity(), request: rfq, policy: policy(), now: NOW });
    store.recordSolverCapacity(snapshot());
    store.recordSolverCapacity(snapshot(7, {
      solverId: SOLVER_TWO,
      capabilityDigest: hash("solver-two-capability"),
    }));
    const selected = store.reserveVerifiedFirmOffer(reservation(rfq, "atomic-fill-selected", {
      offer: { ...reservation(rfq, "atomic-fill-selected").offer, bitAmountWei: String(10n * BIT) },
    }));
    const competing = store.reserveVerifiedFirmOffer(reservation(rfq, "atomic-fill-competing", {
      solverId: SOLVER_TWO,
      offer: {
        ...reservation(rfq, "atomic-fill-competing").offer,
        capabilityDigest: hash("solver-two-capability"),
        bitAmountWei: String(10n * BIT),
      },
    }));
    const proof = hash("atomic-fill-proof");
    assert.throws(() => store.recordFirmOfferOutcome({
      offerId: selected.offerId,
      outcome: "filled",
      evidenceDigest: proof,
      recordedAt: NOW + 2,
      policy: policy(),
    }), /reconciled completed-settlement proof/);
    completeSelectedSettlement(store, selected, "atomic-fill", proof);
    store.recordFirmOfferOutcome({
      offerId: selected.offerId,
      outcome: "filled",
      evidenceDigest: proof,
      recordedAt: NOW + 8,
      policy: policy(),
    });
    assert.equal(store.getFirmOffer(selected.offerId).state, "FILLED");
    assert.equal(store.getFirmOffer(competing.offerId).state, "USER_ABANDONED");
    assert.equal(store.getRfqRequest(rfq.requestId).state, "EXERCISED");
    assert.equal(store.getRfqRequest(rfq.requestId).resolutionDigest, proof);
    assert.equal(store.getSolverCapacity(SOLVER).successfulFills, "1");
    assert.equal(store.getSolverCapacity(SOLVER).committedBitWei, "0");
    assert.equal(store.getSolverCapacity(SOLVER_TWO).attributableFailures, "0");
    assert.equal(store.getSolverCapacity(SOLVER_TWO).committedBitWei, "0");
  } finally {
    store.close();
  }
});

test("opens admission without an allowlist while enforcing the unknown BIT-to-Lightning cap", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  try {
    store.recordSolverCapacity(snapshot(7, { availableBitWei: "0" }));
    const above = request("unknown-cap-above", 2, {
      direction: "bit-to-lightning",
      notionalSats: "5001",
    });
    store.admitRfq({ identity: identity(), request: above, policy: policy(), now: NOW });
    assert.throws(() => store.reserveVerifiedFirmOffer(reservation(above, "unknown-cap-above", {
      offer: {
        ...reservation(above, "unknown-cap-above").offer,
        direction: "bit-to-lightning",
        bitAmountWei: "0",
        lightningAmountSats: "5001",
      },
    })), /unknown solver BIT-to-Lightning cap exceeded/);

    const bounded = request("unknown-cap-bounded", 3, {
      direction: "bit-to-lightning",
      notionalSats: "5000",
    });
    store.admitRfq({
      identity: identity(),
      request: bounded,
      policy: policy(),
      now: NOW,
    });
    const accepted = store.reserveVerifiedFirmOffer(reservation(bounded, "unknown-cap-bounded", {
      offer: {
        ...reservation(bounded, "unknown-cap-bounded").offer,
        direction: "bit-to-lightning",
        bitAmountWei: "0",
        lightningAmountSats: "5000",
      },
      policy: policy(),
    }));
    assert.equal(accepted.state, "ACTIVE");
    assert.equal(store.getSolverCapacity(SOLVER).successfulFills, "0");
  } finally {
    store.close();
  }
});

test("atomically caps aggregate BIT-to-Lightning exposure across permissionless solver identities", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const boundedPolicy = policy({
    establishedSolverMaxBitToLightningSats: "5000",
    maxGlobalBitToLightningInFlightSats: "9000",
  });
  try {
    store.recordSolverCapacity(snapshot(7, { availableBitWei: "0" }));
    store.recordSolverCapacity(snapshot(7, {
      solverId: SOLVER_TWO,
      capabilityDigest: hash("solver-two-capability"),
      availableBitWei: "0",
    }));

    const first = request("global-cap-first", 2, { direction: "bit-to-lightning", notionalSats: "5000" });
    const second = request("global-cap-second", 3, { direction: "bit-to-lightning", notionalSats: "5000" });
    store.admitRfq({ identity: identity(), request: first, policy: boundedPolicy, now: NOW });
    store.admitRfq({ identity: identity(), request: second, policy: boundedPolicy, now: NOW });
    store.reserveVerifiedFirmOffer(reservation(first, "global-cap-first", {
      offer: {
        ...reservation(first, "global-cap-first").offer,
        direction: "bit-to-lightning",
        bitAmountWei: "0",
        lightningAmountSats: "5000",
      },
      policy: boundedPolicy,
    }));
    assert.equal(store.admissionMetrics().activeBitToLightningInFlightSats, "5000");
    assert.throws(() => store.reserveVerifiedFirmOffer(reservation(second, "global-cap-second", {
      solverId: SOLVER_TWO,
      offer: {
        ...reservation(second, "global-cap-second").offer,
        capabilityDigest: hash("solver-two-capability"),
        direction: "bit-to-lightning",
        bitAmountWei: "0",
        lightningAmountSats: "5000",
      },
      policy: boundedPolicy,
    })), /global BIT-to-Lightning in-flight cap exceeded/);
  } finally {
    store.close();
  }
});

test("serializes competing admissions across independent database connections", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-admission-race-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await CoordinatorStore.open(path);
  const second = await CoordinatorStore.open(path);
  try {
    const restrictive = policy({ maxActiveRequestsPerIdentity: 1, maxRequestsPerWindow: 10 });
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => first.admitRfq({
        identity: identity(), request: request("race-one", 2), policy: restrictive, now: NOW,
      })),
      Promise.resolve().then(() => second.admitRfq({
        identity: identity(), request: request("race-two", 3), policy: restrictive, now: NOW,
      })),
    ]);
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.match(String(outcomes.find(({ status }) => status === "rejected").reason), /too many active requests/);
    assert.deepEqual(first.admissionMetrics().rfqStates, { ACTIVE: 1 });
  } finally {
    first.close();
    second.close();
  }
});

test("serializes competing firm reservations so capacity cannot be oversubscribed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-capacity-race-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await CoordinatorStore.open(path);
  const one = request("capacity-race-one", 2);
  const two = request("capacity-race-two", 3);
  first.admitRfq({ identity: identity(), request: one, policy: policy(), now: NOW });
  first.admitRfq({ identity: identity(), request: two, policy: policy(), now: NOW });
  first.recordSolverCapacity(snapshot());
  const second = await CoordinatorStore.open(path);
  try {
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => first.reserveVerifiedFirmOffer(reservation(one, "capacity-race-one"))),
      Promise.resolve().then(() => second.reserveVerifiedFirmOffer(reservation(two, "capacity-race-two"))),
    ]);
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.match(String(outcomes.find(({ status }) => status === "rejected").reason), /exceeds uncommitted capacity/);
    assert.equal(first.getSolverCapacity(SOLVER).committedBitWei, String(60n * BIT));
    assert.equal(first.getSolverCapacity(SOLVER).activeFirmQuotes, 1);
  } finally {
    first.close();
    second.close();
  }
});

test("serializes inbound Lightning commitments even when BIT inventory could cover both quotes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-inbound-capacity-race-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await CoordinatorStore.open(path);
  const one = request("inbound-capacity-race-one", 2);
  const two = request("inbound-capacity-race-two", 3);
  first.admitRfq({ identity: identity(), request: one, policy: policy(), now: NOW });
  first.admitRfq({ identity: identity(), request: two, policy: policy(), now: NOW });
  first.recordSolverCapacity(snapshot(7, {
    availableBitWei: String(200n * BIT),
    availableLightningSats: "15000",
  }));
  const second = await CoordinatorStore.open(path);
  try {
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => first.reserveVerifiedFirmOffer(reservation(one, "inbound-capacity-race-one"))),
      Promise.resolve().then(() => second.reserveVerifiedFirmOffer(reservation(two, "inbound-capacity-race-two"))),
    ]);
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.match(
      String(outcomes.find(({ status }) => status === "rejected").reason),
      /uncommitted capacity \(Lightning\)/,
    );
    assert.equal(first.getSolverCapacity(SOLVER).committedBitWei, String(60n * BIT));
    assert.equal(first.getSolverCapacity(SOLVER).committedLightningSats, "10000");
  } finally {
    first.close();
    second.close();
  }
});

test("binds only one executable quote to a firm offer across coordinator connections", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-executable-binding-race-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await CoordinatorStore.open(path);
  const rfq = request("executable-binding-race", 2);
  first.admitRfq({ identity: identity(), request: rfq, policy: policy(), now: NOW });
  first.recordSolverCapacity(snapshot());
  const firm = first.reserveVerifiedFirmOffer(reservation(rfq, "executable-binding-race"));
  const second = await CoordinatorStore.open(path);
  const shared = {
    offerId: firm.offerId,
    privateRequestDigest: hash("private-request-binding"),
    finalizedAt: NOW + 1,
  };
  try {
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => first.bindFirmOfferExecution({
        ...shared,
        executableOfferDigest: hash("executable-offer-a"),
      })),
      Promise.resolve().then(() => second.bindFirmOfferExecution({
        ...shared,
        executableOfferDigest: hash("executable-offer-b"),
      })),
    ]);
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.match(
      String(outcomes.find(({ status }) => status === "rejected").reason),
      /already bound to another executable quote/,
    );
    const bound = first.getFirmOffer(firm.offerId);
    assert.equal(bound.privateRequestDigest, shared.privateRequestDigest);
    assert.ok([hash("executable-offer-a"), hash("executable-offer-b")].includes(bound.executableOfferDigest));
    assert.equal(first.bindFirmOfferExecution({
      ...shared,
      executableOfferDigest: bound.executableOfferDigest,
    }).executionBindingDigest, bound.executionBindingDigest);
  } finally {
    first.close();
    second.close();
  }
});

test("binds a settlement once to its reviewed release, evidence policy, and selected capability before exposure", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const rfq = request("execution-policy-binding", 2);
  try {
    store.admitRfq({ identity: identity(), request: rfq, policy: policy(), now: NOW });
    store.recordSolverCapacity(snapshot());
    const firm = store.reserveVerifiedFirmOffer(reservation(rfq, "execution-policy-binding"));
    const executable = store.bindFirmOfferExecution({
      offerId: firm.offerId,
      privateRequestDigest: hash("execution-policy-private-request"),
      executableOfferDigest: hash("execution-policy-executable-offer"),
      finalizedAt: NOW + 1,
    });
    store.bindFirmOfferUserAuthorization({
      offerId: firm.offerId,
      executionBindingDigest: executable.executionBindingDigest,
      executionAuthorizationDigest: hash("execution-policy-user-authorization"),
      authorizationExpiresAt: NOW + 20,
      authorizedAt: NOW + 2,
    });
    const value = {
      settlementId: hash("execution-policy-settlement"),
      pricingId: rfq.requestId,
      direction: rfq.direction,
      nonceAuthorityDigest: hash("execution-policy-nonce-authority"),
      intentNonce: "22",
      intentDigest: hash("execution-policy-intent"),
      paymentHash: hash("execution-policy-payment"),
      invoiceDigest: hash("execution-policy-invoice"),
      amountSats: rfq.notionalSats,
      quoteReceiptDigest: hash("execution-policy-quote-receipt"),
      selectedSetDigest: hash("execution-policy-selected-set"),
      selectedOfferId: firm.offerId,
      capacityEpoch: firm.capacityEpoch,
      createdAt: NOW + 2,
    };
    store.acceptSettlement(value);
    const authority = {
      settlementId: value.settlementId,
      releaseRecordDigest: hash("execution-policy-release"),
      evidencePolicyDigest: hash("execution-policy-evidence"),
      solverCapabilityDigest: firm.capabilityDigest,
      boundAt: NOW + 3,
    };
    assert.throws(
      () => store.bindSettlementExecutionPolicy({
        ...authority,
        solverCapabilityDigest: hash("different-capability"),
      }),
      /does not match its durable RFQ, offer, capability, or amount/,
    );
    const bound = store.bindSettlementExecutionPolicy(authority);
    assert.equal(bound.releaseRecordDigest, authority.releaseRecordDigest);
    assert.equal(bound.evidencePolicyDigest, authority.evidencePolicyDigest);
    assert.equal(bound.solverCapabilityDigest, authority.solverCapabilityDigest);
    assert.equal(bound.executionPolicyBoundAt, authority.boundAt);
    assert.match(bound.executionPolicyBindingDigest, /^0x[0-9a-f]{64}$/);
    assert.equal(
      store.bindSettlementExecutionPolicy(authority).executionPolicyBindingDigest,
      bound.executionPolicyBindingDigest,
    );
    assert.throws(
      () => store.bindSettlementExecutionPolicy({ ...authority, boundAt: NOW + 4 }),
      /already bound to different authority/,
    );

    const late = {
      ...value,
      settlementId: hash("execution-policy-late-settlement"),
      pricingId: hash("execution-policy-late-pricing"),
      nonceAuthorityDigest: hash("execution-policy-late-nonce-authority"),
      intentNonce: "23",
      intentDigest: hash("execution-policy-late-intent"),
      paymentHash: hash("execution-policy-late-payment"),
      invoiceDigest: hash("execution-policy-late-invoice"),
      quoteReceiptDigest: hash("execution-policy-late-quote-receipt"),
      selectedSetDigest: hash("execution-policy-late-selected-set"),
      selectedOfferId: hash("execution-policy-late-offer"),
    };
    store.acceptSettlement(late);
    store.recordReservation({
      settlementId: late.settlementId,
      reservationId: hash("execution-policy-late-reservation"),
      reservationTxHash: hash("execution-policy-late-transaction"),
      reservationBlockNumber: 20_000_001,
      reservationBlockHash: hash("execution-policy-late-block"),
      reservationIntentDigest: late.intentDigest,
      observedAt: NOW + 3,
    });
    assert.throws(
      () => store.bindSettlementExecutionPolicy({ ...authority, settlementId: late.settlementId }),
      /must bind before reservation, actions, or closure/,
    );
  } finally {
    store.close();
  }
});

test("stores only opaque identity commitments and exposes aggregate admission metrics", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-admission-privacy-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CoordinatorStore.open(path);
  const rfq = request("privacy", 2);
  store.admitRfq({ identity: identity(), request: rfq, policy: policy(), now: NOW });
  store.recordSolverCapacity(snapshot());
  store.reserveVerifiedFirmOffer(reservation(rfq, "privacy"));
  const metrics = store.admissionMetrics();
  assert.deepEqual(metrics, {
    rfqStates: { ACTIVE: 1 },
    firmOfferStates: { ACTIVE: 1 },
    solverHealth: { total: 1, failureSuspended: 0, capacityConflicted: 0 },
    activeCommitments: 1,
    activeBitToLightningInFlightSats: "0",
  });
  assert.equal(JSON.stringify(metrics).includes(USER), false);
  assert.equal(JSON.stringify(metrics).includes(rfq.requestId), false);
  store.close();

  const persisted = Buffer.concat(await Promise.all(
    (await readdir(directory)).map((filename) => readFile(join(directory, filename))),
  )).toString("utf8");
  assert.equal(persisted.toLowerCase().includes(USER.slice(2)), false);
});

test("migrates a v2 coordinator database forward without treating it as release authorization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-admission-migration-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE coordinator_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;");
  legacy.prepare("INSERT INTO coordinator_meta(key, value) VALUES ('schema', 'treeswap.coordinator.v2')").run();
  legacy.close();

  const store = await CoordinatorStore.open(path);
  try {
    const admitted = store.admitRfq({ identity: identity(), request: request("migration", 2), policy: policy(), now: NOW });
    assert.equal(admitted.request.state, "ACTIVE");
  } finally {
    store.close();
  }
});

test("migrates v3 solver capabilities as expired instead of extending legacy authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-capability-migration-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rfq = request("capability-migration", 2);
  const current = await CoordinatorStore.open(path);
  current.admitRfq({ identity: identity(), request: rfq, policy: policy(), now: NOW });
  current.recordSolverCapacity(snapshot());
  current.close();

  const legacy = new DatabaseSync(path);
  legacy.exec("ALTER TABLE solver_capacity DROP COLUMN capability_expires_at");
  legacy.prepare("UPDATE coordinator_meta SET value = 'treeswap.coordinator.v3' WHERE key = 'schema'").run();
  legacy.close();

  const migrated = await CoordinatorStore.open(path);
  try {
    assert.equal(migrated.getSolverCapacity(SOLVER).capabilityExpiresAt, 0);
    assert.throws(
      () => migrated.reserveVerifiedFirmOffer(reservation(rfq, "capability-migration")),
      /solver capability expired/,
    );
  } finally {
    migrated.close();
  }
});

test("refuses to migrate a legacy one-sided ledger while any firm offer is active", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-active-ledger-migration-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rfq = request("active-ledger-migration", 2);
  const current = await CoordinatorStore.open(path);
  current.admitRfq({ identity: identity(), request: rfq, policy: policy(), now: NOW });
  current.recordSolverCapacity(snapshot());
  current.reserveVerifiedFirmOffer(reservation(rfq, "active-ledger-migration"));
  current.close();

  const legacy = new DatabaseSync(path);
  legacy.exec("ALTER TABLE firm_offer_commitments DROP COLUMN bit_amount_wei");
  legacy.exec("ALTER TABLE firm_offer_commitments DROP COLUMN lightning_amount_sats");
  legacy.prepare("UPDATE coordinator_meta SET value = 'treeswap.coordinator.v4' WHERE key = 'schema'").run();
  legacy.close();

  await assert.rejects(
    CoordinatorStore.open(path),
    /active firm offers and cannot migrate safely/,
  );
  const unchanged = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    unchanged.prepare("SELECT value FROM coordinator_meta WHERE key = 'schema'").get().value,
    "treeswap.coordinator.v4",
  );
  unchanged.close();
});

test("refuses to invent user authorization while migrating an active v5 offer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-v5-authorization-migration-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rfq = request("v5-authorization-migration", 2);
  const current = await CoordinatorStore.open(path);
  current.admitRfq({ identity: identity(), request: rfq, policy: policy(), now: NOW });
  current.recordSolverCapacity(snapshot());
  current.reserveVerifiedFirmOffer(reservation(rfq, "v5-authorization-migration"));
  current.close();

  const legacy = new DatabaseSync(path);
  legacy.prepare("UPDATE coordinator_meta SET value = 'treeswap.coordinator.v5' WHERE key = 'schema'").run();
  legacy.close();

  await assert.rejects(
    CoordinatorStore.open(path),
    /active firm offers and cannot migrate safely/,
  );
  const unchanged = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    unchanged.prepare("SELECT value FROM coordinator_meta WHERE key = 'schema'").get().value,
    "treeswap.coordinator.v5",
  );
  unchanged.close();
});
