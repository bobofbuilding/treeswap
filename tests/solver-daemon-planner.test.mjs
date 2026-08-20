import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import { classifySolverDaemonStep, nextSolverDaemonStep } from "../lib/solver-daemon-planner.mjs";

const NOW = 2_000_000_000;
const SEND_PAYMENT = "/routerrpc.Router/SendPaymentV2";
const SETTLE_INVOICE = "/invoicesrpc.Invoices/SettleInvoice";
const EVM_CLAIM = "evm:claim";

function hash(label) {
  return id(label).toLowerCase();
}

function settlement(direction, overrides = {}) {
  return {
    settlementId: hash(`${direction}:settlement`),
    direction,
    reservationId: hash(`${direction}:reservation`),
    reconciliationRequired: false,
    haltCode: null,
    terminalState: null,
    ...overrides,
  };
}

function action(value, method, state, label = method) {
  return {
    actionId: hash(`${value.settlementId}:${label}`),
    settlementId: value.settlementId,
    method,
    state,
  };
}

test("orders every BIT-to-Lightning daemon transition fail closed", () => {
  const waiting = settlement("bit-to-lightning", { reservationId: null });
  assert.equal(classifySolverDaemonStep({ settlement: waiting, actions: [] }).kind, "WAIT_FOR_RESERVATION");

  const value = settlement("bit-to-lightning");
  assert.deepEqual(classifySolverDaemonStep({ settlement: value, actions: [] }), {
    kind: "PLAN_LIGHTNING_ACTION",
    settlementId: value.settlementId,
    direction: value.direction,
    method: SEND_PAYMENT,
  });
  const pending = action(value, SEND_PAYMENT, "PENDING");
  assert.equal(classifySolverDaemonStep({ settlement: value, actions: [pending] }).kind, "AUTHORIZE_AND_DISPATCH_LIGHTNING");

  const unknown = { ...pending, state: "UNKNOWN" };
  assert.equal(classifySolverDaemonStep({
    settlement: { ...value, reconciliationRequired: true },
    actions: [unknown],
  }).kind, "RECONCILE_ACTION");

  const confirmed = { ...pending, state: "CONFIRMED" };
  const proof = classifySolverDaemonStep({ settlement: value, actions: [confirmed] });
  assert.equal(proof.kind, "RECOVER_PAYMENT_PROOF_AND_PREPARE_EVM_CLAIM");
  assert.equal(proof.paymentActionId, confirmed.actionId);

  const prematureClaim = action(value, EVM_CLAIM, "PENDING");
  assert.match(classifySolverDaemonStep({ settlement: value, actions: [pending, prematureClaim] }).reason, /before confirmed/);

  const claim = action(value, EVM_CLAIM, "PENDING");
  assert.equal(classifySolverDaemonStep({ settlement: value, actions: [confirmed, claim] }).kind, "DISPATCH_EVM_CLAIM");
  assert.equal(classifySolverDaemonStep({
    settlement: value,
    actions: [confirmed, { ...claim, state: "CONFIRMED" }],
  }).kind, "VERIFY_BOTH_ASSETS_AND_COMPLETE");
  assert.equal(classifySolverDaemonStep({
    settlement: value,
    actions: [confirmed, { ...claim, state: "FAILED" }],
  }).kind, "HALT_REQUIRED");
  assert.equal(classifySolverDaemonStep({
    settlement: value,
    actions: [{ ...pending, state: "FAILED" }],
  }).kind, "VERIFY_REFUND_AND_RECONCILE");
});

test("orders every Lightning-to-BIT daemon transition without inventing EVM authority", () => {
  const value = settlement("lightning-to-bit");
  const first = classifySolverDaemonStep({ settlement: value, actions: [] });
  assert.equal(first.kind, "PLAN_LIGHTNING_ACTION");
  assert.equal(first.method, SETTLE_INVOICE);

  const pending = action(value, SETTLE_INVOICE, "PENDING");
  assert.equal(classifySolverDaemonStep({ settlement: value, actions: [pending] }).kind, "AUTHORIZE_AND_DISPATCH_LIGHTNING");
  assert.equal(classifySolverDaemonStep({
    settlement: value,
    actions: [{ ...pending, state: "CONFIRMED" }],
  }).kind, "WAIT_FOR_BIT_CLAIM_AND_RECONCILE");
  assert.equal(classifySolverDaemonStep({
    settlement: value,
    actions: [{ ...pending, state: "FAILED" }],
  }).kind, "VERIFY_REFUND_AND_RECONCILE");

  const wrong = action(value, SEND_PAYMENT, "PENDING");
  assert.equal(classifySolverDaemonStep({ settlement: value, actions: [wrong] }).kind, "HALT_REQUIRED");
  const wrongClaim = action(value, EVM_CLAIM, "PENDING");
  assert.equal(classifySolverDaemonStep({ settlement: value, actions: [wrongClaim] }).kind, "HALT_REQUIRED");
});

test("prioritizes process recovery, ambiguity, halt, and terminal states", () => {
  const value = settlement("bit-to-lightning");
  const dispatching = action(value, SEND_PAYMENT, "DISPATCHING");
  assert.equal(classifySolverDaemonStep({ settlement: value, actions: [dispatching] }).kind, "RECOVER_INTERRUPTED_ACTION");

  const impossible = { ...value, reconciliationRequired: true };
  assert.equal(classifySolverDaemonStep({ settlement: impossible, actions: [] }).kind, "HALT_REQUIRED");
  assert.equal(classifySolverDaemonStep({ settlement: { ...value, haltCode: "RISK_GATE" }, actions: [] }).kind, "HALTED");
  assert.equal(classifySolverDaemonStep({
    settlement: { ...value, haltCode: "RISK_GATE", reconciliationRequired: true },
    actions: [{ ...dispatching, state: "UNKNOWN" }],
  }).kind, "RECONCILE_ACTION");
  assert.equal(classifySolverDaemonStep({ settlement: { ...value, terminalState: "COMPLETED" }, actions: [] }).kind, "DONE");
});

test("detects an incompatible action even before a reservation exists", () => {
  const value = settlement("lightning-to-bit", { reservationId: null });
  const wrong = action(value, "/invoicesrpc.Invoices/AddHoldInvoice", "CONFIRMED");
  assert.equal(classifySolverDaemonStep({ settlement: value, actions: [wrong] }).kind, "HALT_REQUIRED");
});

test("reads the next step only from the durable coordinator store", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const value = {
    settlementId: hash("store:daemon:settlement"),
    pricingId: hash("store:daemon:pricing"),
    direction: "bit-to-lightning",
    nonceAuthorityDigest: hash("store:daemon:authority"),
    intentNonce: "9",
    intentDigest: hash("store:daemon:intent"),
    paymentHash: hash("store:daemon:payment"),
    invoiceDigest: hash("store:daemon:invoice"),
    amountSats: "10000",
    quoteReceiptDigest: hash("store:daemon:quote"),
    selectedSetDigest: hash("store:daemon:set"),
    selectedOfferId: hash("store:daemon:offer"),
    capacityEpoch: 4,
    createdAt: NOW,
  };
  try {
    store.acceptSettlement(value);
    assert.equal(nextSolverDaemonStep({ store, settlementId: value.settlementId }).kind, "WAIT_FOR_RESERVATION");
    store.recordReservation({
      settlementId: value.settlementId,
      reservationId: hash("store:daemon:reservation"),
      reservationTxHash: hash("store:daemon:tx"),
      reservationBlockNumber: 20_000_000,
      reservationBlockHash: hash("store:daemon:block"),
      reservationIntentDigest: value.intentDigest,
      observedAt: NOW + 1,
    });
    assert.equal(nextSolverDaemonStep({ store, settlementId: value.settlementId }).kind, "PLAN_LIGHTNING_ACTION");
    store.planAction({
      actionId: hash("store:daemon:payment-action"),
      settlementId: value.settlementId,
      method: SEND_PAYMENT,
      requestId: hash("store:daemon:request"),
      payloadDigest: hash("store:daemon:payload"),
      intentDigest: value.intentDigest,
      paymentHash: value.paymentHash,
      invoiceDigest: value.invoiceDigest,
      amountSats: value.amountSats,
      capacityEpoch: value.capacityEpoch,
      plannedAt: NOW + 2,
    });
    assert.equal(nextSolverDaemonStep({ store, settlementId: value.settlementId }).kind, "AUTHORIZE_AND_DISPATCH_LIGHTNING");
    assert.equal(Object.isFrozen(store.listSettlementActions(value.settlementId)), true);
  } finally {
    store.close();
  }
});
