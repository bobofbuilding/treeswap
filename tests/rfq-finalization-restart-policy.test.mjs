import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { id } from "ethers";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  createRfqFinalizationRestartPolicy,
  createTestRfqFinalizationRestartPolicy,
  isRfqFinalizationRestartPolicy,
  rfqFinalizationRestartPolicyMode,
} from "../lib/rfq-finalization-restart-policy.mjs";

const NOW = 2_000_000_000;
const USER = "0x1111111111111111111111111111111111111111";
const SOLVER = "0x2222222222222222222222222222222222222222";
const SOLVER_TWO = "0x3333333333333333333333333333333333333333";
const BIT = 10n ** 18n;

function hash(label) {
  return id(label).toLowerCase();
}

function admissionPolicy(overrides = {}) {
  return {
    minimumNotionalSats: "1000",
    maxRfqTtlSeconds: 180,
    maxActiveRequestsPerIdentity: 10,
    maxRequestsPerWindow: 10,
    maxCancellationsPerWindow: 10,
    quotaWindowSeconds: 60,
    maxFirmQuoteTtlSeconds: 120,
    maxCapacityAgeSeconds: 30,
    maxActiveFirmQuotesPerSolver: 10,
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
  return {
    authenticated: true,
    commitment: hash("restart-policy-opaque-identity"),
    key: USER,
  };
}

function request(label, nonce) {
  return {
    requestId: hash(`restart-request:${label}`),
    user: USER,
    direction: "lightning-to-bit",
    notionalSats: "10000",
    nonce: String(nonce),
    expiresAt: NOW + 120,
  };
}

function capacity(solverId = SOLVER, epoch = 1) {
  return {
    solverId,
    capabilityDigest: hash(`restart-capability:${solverId}:${epoch}`),
    capabilityExpiresAt: NOW + 300,
    capabilityVerified: true,
    capacityEpoch: epoch,
    availableBitWei: String(100n * BIT),
    availableLightningSats: "100000",
    observedAt: NOW,
  };
}

function reservation(rfq, label, solverId = SOLVER, epoch = 1) {
  return {
    offerId: hash(`restart-offer:${label}`),
    offerDigest: hash(`restart-offer-digest:${label}`),
    marketRiskDigest: hash(`restart-risk:${label}`),
    marketRiskPolicyDigest: hash("restart-reviewed-risk-policy"),
    marketRiskValidUntil: NOW + 30,
    selectionAuthorizationDigest: hash(`restart-selection-authorization:${label}`),
    selectionAuthorizationExpiresAt: NOW + 30,
    requestId: rfq.requestId,
    solverId,
    offer: {
      direction: rfq.direction,
      capabilityDigest: hash(`restart-capability:${solverId}:${epoch}`),
      bitAmountWei: String(10n * BIT),
      lightningAmountSats: rfq.notionalSats,
      maxRoutingFeeSats: "0",
      capacityEpoch: epoch,
      expiresAt: NOW + 30,
      signatureVerified: true,
    },
    policy: admissionPolicy(),
    now: NOW + 1,
  };
}

function bindExecutable(store, offer, label) {
  return store.bindFirmOfferExecution({
    offerId: offer.offerId,
    privateRequestDigest: hash(`restart-private-request:${label}`),
    executableOfferDigest: hash(`restart-executable-offer:${label}`),
    finalizedAt: NOW + 2,
  });
}

function bindAuthorization(store, executable, label) {
  return store.bindFirmOfferUserAuthorization({
    offerId: executable.offerId,
    executionBindingDigest: executable.executionBindingDigest,
    executionAuthorizationDigest: hash(`restart-execution-authorization:${label}`),
    authorizationExpiresAt: NOW + 20,
    authorizedAt: NOW + 3,
  });
}

function acceptSettlement(store, rfq, offer, label) {
  return store.acceptSettlement({
    settlementId: hash(`restart-settlement:${label}`),
    pricingId: rfq.requestId,
    direction: rfq.direction,
    nonceAuthorityDigest: hash(`restart-nonce-authority:${label}`),
    intentNonce: "1",
    intentDigest: hash(`restart-intent:${label}`),
    paymentHash: hash(`restart-payment:${label}`),
    invoiceDigest: hash(`restart-invoice:${label}`),
    amountSats: rfq.notionalSats,
    quoteReceiptDigest: hash(`restart-receipt:${label}`),
    selectedSetDigest: hash(`restart-selected-set:${label}`),
    selectedOfferId: offer.offerId,
    capacityEpoch: offer.capacityEpoch,
    createdAt: NOW + 4,
  });
}

async function durableStore(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `treeswap-${label}-`));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path, store: await CoordinatorStore.open(path) };
}

test("restart policy burns browser authority and releases every unowned phase only at signed expiry", async (t) => {
  const fixture = await durableStore(t, "finalization-restart-phases");
  const offers = [];
  try {
    fixture.store.recordSolverCapacity(capacity());
    for (const [index, phase] of ["reserved", "finalized", "authorized"].entries()) {
      const rfq = request(phase, index + 1);
      fixture.store.admitRfq({
        identity: identity(),
        request: rfq,
        policy: admissionPolicy(),
        now: NOW,
      });
      const offer = fixture.store.reserveVerifiedFirmOffer(reservation(rfq, phase));
      offers.push(offer);
      if (phase !== "reserved") {
        const executable = bindExecutable(fixture.store, offer, phase);
        if (phase === "authorized") bindAuthorization(fixture.store, executable, phase);
      }
    }
  } finally {
    fixture.store.close();
  }

  const reopened = await CoordinatorStore.open(fixture.path);
  let now = NOW + 29;
  const abort = new AbortController();
  try {
    const policy = createTestRfqFinalizationRestartPolicy({
      coordinatorStore: reopened,
      limit: 10,
      nowSeconds: () => now,
      signal: abort.signal,
    });
    assert.equal(isRfqFinalizationRestartPolicy(policy), true);
    assert.equal(rfqFinalizationRestartPolicyMode(policy), "injected-test");
    assert.deepEqual(policy.status().reconciliation, {
      schema: "treeswap.rfq-finalization-restart.v1",
      state: "waiting-for-expiry",
      observedAt: NOW + 29,
      releasedExpiredCommitments: 0,
      expiredRequestsClosed: 0,
      pendingReservedCommitments: 1,
      pendingFinalizedCommitments: 1,
      pendingAuthorizedCommitments: 1,
      earliestPendingExpiry: NOW + 30,
      expiredReleaseBacklog: 0,
      settlementOwnedCommitments: 0,
      nonterminalSettlementOwnedCommitments: 0,
      terminalSettlementOwnedCommitments: 0,
      browserAuthorityRestored: false,
      privateRequestRecovered: false,
      invoiceCreationRequests: 0,
      externalCalls: 0,
      fundingAuthorization: false,
      newExposureAuthorization: false,
      settlementDispatchAuthority: false,
      snapshotDigest: policy.status().reconciliation.snapshotDigest,
    });
    assert.match(policy.status().reconciliation.snapshotDigest, /^0x[0-9a-f]{64}$/);
    for (const offer of offers) assert.equal(reopened.getFirmOffer(offer.offerId).state, "ACTIVE");

    now = NOW + 30;
    const expired = policy.sweep();
    assert.equal(expired.releasedExpiredCommitments, 3);
    assert.equal(expired.pendingReservedCommitments, 0);
    assert.equal(expired.pendingFinalizedCommitments, 0);
    assert.equal(expired.pendingAuthorizedCommitments, 0);
    assert.equal(expired.invoiceCreationRequests, 0);
    assert.equal(expired.externalCalls, 0);
    for (const offer of offers) {
      assert.equal(reopened.getFirmOffer(offer.offerId).state, "EXPIRED_UNEXERCISED");
    }
    const solver = reopened.getSolverCapacity(SOLVER);
    assert.equal(solver.committedBitWei, "0");
    assert.equal(solver.committedLightningSats, "0");
    assert.equal(solver.attributableFailures, "0");

    const serialized = JSON.stringify(policy.status());
    for (const secret of [USER, SOLVER, ...offers.map(({ offerId }) => offerId)]) {
      assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false);
    }
    now = NOW + 120;
    const closed = policy.sweep();
    assert.equal(closed.expiredRequestsClosed, 3);
    for (const offer of offers) {
      assert.equal(reopened.getRfqRequest(offer.requestId).state, "EXPIRED");
    }
    now = NOW + 119;
    assert.throws(() => policy.sweep(), /clock moved backward/);
    abort.abort();
    assert.equal(policy.status().state, "stopped");
    assert.throws(() => policy.sweep(), /is stopped/);
  } finally {
    reopened.close();
  }
});

test("restart and generic RFQ expiry preserve settlement-owned liability for settlement recovery", async (t) => {
  const fixture = await durableStore(t, "finalization-restart-settlement");
  const rfq = request("settlement-owned", 1);
  let selected;
  let competing;
  try {
    fixture.store.admitRfq({
      identity: identity(),
      request: rfq,
      policy: admissionPolicy(),
      now: NOW,
    });
    fixture.store.recordSolverCapacity(capacity());
    fixture.store.recordSolverCapacity(capacity(SOLVER_TWO, 2));
    selected = fixture.store.reserveVerifiedFirmOffer(reservation(rfq, "selected"));
    competing = fixture.store.reserveVerifiedFirmOffer(
      reservation(rfq, "competing", SOLVER_TWO, 2),
    );
    bindAuthorization(fixture.store, bindExecutable(fixture.store, selected, "selected"), "selected");
    acceptSettlement(fixture.store, rfq, selected, "selected");
  } finally {
    fixture.store.close();
  }

  const reopened = await CoordinatorStore.open(fixture.path);
  const abort = new AbortController();
  try {
    assert.equal(reopened.expireRfqs(NOW + 120), 0);
    assert.equal(reopened.getFirmOffer(selected.offerId).state, "ACTIVE");
    assert.equal(reopened.getFirmOffer(competing.offerId).state, "EXPIRED_UNEXERCISED");
    assert.equal(reopened.getRfqRequest(rfq.requestId).state, "ACTIVE");
    assert.equal(reopened.getSolverCapacity(SOLVER).committedBitWei, String(10n * BIT));
    assert.equal(reopened.getSolverCapacity(SOLVER_TWO).committedBitWei, "0");

    const policy = createTestRfqFinalizationRestartPolicy({
      coordinatorStore: reopened,
      limit: 10,
      nowSeconds: () => NOW + 121,
      signal: abort.signal,
    });
    const status = policy.status().reconciliation;
    assert.equal(status.state, "settlement-recovery-required");
    assert.equal(status.settlementOwnedCommitments, 1);
    assert.equal(status.nonterminalSettlementOwnedCommitments, 1);
    assert.equal(status.releasedExpiredCommitments, 0);
    assert.equal(status.invoiceCreationRequests, 0);
    assert.throws(() => reopened.recordFirmOfferOutcome({
      evidenceDigest: hash("restart-expire-settlement-owned"),
      offerId: selected.offerId,
      outcome: "expired-unexercised",
      policy: admissionPolicy(),
      recordedAt: NOW + 122,
    }), /settlement-owned firm offer requires exact terminal settlement reconciliation/);
    assert.throws(() => reopened.cancelRfqs({
      cancellationId: hash("restart-cancel-settlement-owned"),
      cancellationSequence: "1",
      identity: identity(),
      recordedAt: NOW + 122,
    }), /settlement-owned firm offer requires settlement reconciliation/);
    assert.throws(() => reopened.resolveRfq({
      evidenceDigest: hash("restart-abandon-settlement-owned"),
      outcome: "user-abandoned",
      recordedAt: NOW + 122,
      requestId: rfq.requestId,
    }), /settlement-owned firm offer requires settlement reconciliation/);
    assert.equal(reopened.getFirmOffer(selected.offerId).state, "ACTIVE");
    assert.equal(reopened.getRfqRequest(rfq.requestId).state, "ACTIVE");
    const terminalProof = hash("restart-refunded-settlement-proof");
    reopened.recordTerminal({
      assetsReconciled: true,
      proofDigest: terminalProof,
      recordedAt: NOW + 123,
      settlementId: hash("restart-settlement:selected"),
      terminalState: "REFUNDED",
    });
    assert.throws(() => reopened.recordFirmOfferOutcome({
      evidenceDigest: hash("wrong-terminal-proof"),
      offerId: selected.offerId,
      outcome: "user-abandoned",
      policy: admissionPolicy(),
      recordedAt: NOW + 124,
    }), /exact terminal settlement reconciliation/);
    const reconciled = reopened.recordFirmOfferOutcome({
      evidenceDigest: terminalProof,
      offerId: selected.offerId,
      outcome: "user-abandoned",
      policy: admissionPolicy(),
      recordedAt: NOW + 124,
    });
    assert.equal(reconciled.state, "USER_ABANDONED");
    assert.equal(reopened.getRfqRequest(rfq.requestId).state, "ABANDONED");
    assert.equal(reopened.getSolverCapacity(SOLVER).committedBitWei, "0");
  } finally {
    abort.abort();
    reopened.close();
  }
});

test("restart reconciliation is bounded, persisted, and never retries invoice creation", async (t) => {
  const fixture = await durableStore(t, "finalization-restart-bounded");
  try {
    fixture.store.recordSolverCapacity(capacity());
    for (const [index, label] of ["one", "two"].entries()) {
      const rfq = request(`bounded-${label}`, index + 1);
      fixture.store.admitRfq({
        identity: identity(),
        request: rfq,
        policy: admissionPolicy(),
        now: NOW,
      });
      fixture.store.reserveVerifiedFirmOffer(reservation(rfq, `bounded-${label}`));
    }
  } finally {
    fixture.store.close();
  }
  const reopened = await CoordinatorStore.open(fixture.path);
  const abort = new AbortController();
  try {
    const policy = createTestRfqFinalizationRestartPolicy({
      coordinatorStore: reopened,
      limit: 1,
      nowSeconds: () => NOW + 30,
      signal: abort.signal,
    });
    assert.equal(policy.status().reconciliation.releasedExpiredCommitments, 1);
    assert.equal(policy.status().reconciliation.expiredReleaseBacklog, 1);
    assert.equal(policy.status().reconciliation.state, "cleanup-incomplete");
    const complete = policy.sweep();
    assert.equal(complete.releasedExpiredCommitments, 1);
    assert.equal(complete.expiredReleaseBacklog, 0);
    assert.equal(complete.state, "ready");
    assert.equal(complete.invoiceCreationRequests, 0);
    const expiredOffer = reopened.getFirmOffer(hash("restart-offer:bounded-one"));
    assert.throws(() => acceptSettlement(
      reopened,
      request("bounded-one", 1),
      expiredOffer,
      "late-after-expiry",
    ), /requires an active fully authorized firm offer/);
  } finally {
    abort.abort();
    reopened.close();
  }

  const second = await CoordinatorStore.open(fixture.path);
  try {
    assert.throws(() => second.reconcileRfqFinalizationRestart({
      limit: 1,
      observedAt: NOW + 29,
    }), /clock moved backward/);
  } finally {
    second.close();
  }
});

test("restart policy rejects unsafe ownership, method substitution, and production memory", async (t) => {
  const fixture = await durableStore(t, "finalization-restart-corrupt-ownership");
  const abort = new AbortController();
  const rfq = request("unsafe-settlement", 1);
  let offer;
  try {
    fixture.store.admitRfq({
      identity: identity(),
      request: rfq,
      policy: admissionPolicy(),
      now: NOW,
    });
    fixture.store.recordSolverCapacity(capacity());
    offer = fixture.store.reserveVerifiedFirmOffer(reservation(rfq, "unsafe-settlement"));
  } finally {
    fixture.store.close();
  }
  const mutation = new DatabaseSync(fixture.path);
  try {
    mutation.prepare(`
      INSERT INTO settlements(
        settlement_id, pricing_id, direction, nonce_authority_digest, intent_nonce, intent_digest,
        payment_hash, invoice_digest, amount_sats, quote_receipt_digest, selected_set_digest,
        selected_offer_id, capacity_epoch, record_digest, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INTENT_ACCEPTED', ?, ?)
    `).run(
      hash("corrupt-restart-settlement"), rfq.requestId, rfq.direction,
      hash("corrupt-restart-nonce-authority"), "1", hash("corrupt-restart-intent"),
      hash("corrupt-restart-payment"), hash("corrupt-restart-invoice"), rfq.notionalSats,
      hash("corrupt-restart-receipt"), hash("corrupt-restart-selected-set"), offer.offerId,
      offer.capacityEpoch, hash("corrupt-restart-record"), NOW + 4, NOW + 4,
    );
  } finally {
    mutation.close();
  }
  const unsafe = await CoordinatorStore.open(fixture.path);
  try {
    assert.throws(() => createTestRfqFinalizationRestartPolicy({
      coordinatorStore: unsafe,
      limit: 10,
      nowSeconds: () => NOW + 30,
      signal: abort.signal,
    }), /lacks complete user authorization/);
    assert.equal(unsafe.getFirmOffer(offer.offerId).state, "ACTIVE");
  } finally {
    unsafe.close();
  }

  const memory = await CoordinatorStore.open(":memory:", { allowMemory: true });
  try {
    const preclaimedRfq = request("preclaimed-settlement", 1);
    memory.admitRfq({
      identity: identity(),
      request: preclaimedRfq,
      policy: admissionPolicy(),
      now: NOW,
    });
    memory.recordSolverCapacity(capacity());
    const future = reservation(preclaimedRfq, "preclaimed-settlement");
    assert.throws(
      () => acceptSettlement(memory, preclaimedRfq, {
        capacityEpoch: future.offer.capacityEpoch,
        offerId: future.offerId,
      }, "preclaimed-settlement"),
      /settlement selected firm offer does not exist/,
    );
    assert.throws(() => createRfqFinalizationRestartPolicy({
      coordinatorStore: memory,
      limit: 10,
      signal: abort.signal,
    }), /requires durable coordinator storage/);
    Object.defineProperty(memory, "reconcileRfqFinalizationRestart", {
      configurable: true,
      value: () => ({ state: "ready" }),
    });
    assert.throws(() => createTestRfqFinalizationRestartPolicy({
      coordinatorStore: memory,
      limit: 10,
      nowSeconds: () => NOW,
      signal: abort.signal,
    }), /unmodified factory-opened coordinator store/);
  } finally {
    memory.close();
    abort.abort();
  }
});
