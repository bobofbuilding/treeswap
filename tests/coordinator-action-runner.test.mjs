import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { id, sha256 } from "ethers";
import {
  dispatchLightningAction,
  lightningActionCommitment,
  reconcileLightningAction,
} from "../lib/coordinator-action-runner.mjs";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";

const NOW = 2_000_000_000;
const PREIMAGE = id("coordinator-runner-preimage").toLowerCase();
const PAYMENT_HASH = sha256(PREIMAGE).toLowerCase();
const PAYMENT_REQUEST = "lnbc100u1coordinatorrunner";
const { privateKey } = generateKeyPairSync("ed25519");

function hash(label) {
  return id(label).toLowerCase();
}

function settlement(label) {
  return {
    settlementId: hash(`${label}:settlement`),
    pricingId: hash(`${label}:pricing`),
    direction: "bit-to-lightning",
    nonceAuthorityDigest: hash(`${label}:nonce-authority`),
    intentNonce: "11",
    intentDigest: hash(`${label}:intent`),
    paymentHash: PAYMENT_HASH,
    invoiceDigest: hash(`${label}:invoice`),
    amountSats: "10000",
    quoteReceiptDigest: hash(`${label}:quote-receipt`),
    selectedSetDigest: hash(`${label}:selected-set`),
    selectedOfferId: hash(`${label}:selected-offer`),
    capacityEpoch: 3,
    createdAt: NOW,
  };
}

function reservation(value) {
  return {
    settlementId: value.settlementId,
    reservationId: hash(`${value.settlementId}:reservation`),
    reservationTxHash: hash(`${value.settlementId}:tx`),
    reservationBlockNumber: 20_000_000,
    reservationBlockHash: hash(`${value.settlementId}:block`),
    reservationIntentDigest: value.intentDigest,
    observedAt: NOW + 10,
  };
}

function operation() {
  return { paymentRequest: PAYMENT_REQUEST, timeoutSeconds: 30, feeLimitSats: "5" };
}

function pendingAction(value, op = operation()) {
  const draft = {
    actionId: hash(`${value.settlementId}:action`),
    settlementId: value.settlementId,
    method: "/routerrpc.Router/SendPaymentV2",
    requestId: hash(`${value.settlementId}:request`),
    payloadDigest: hash("placeholder"),
    intentDigest: value.intentDigest,
    paymentHash: value.paymentHash,
    invoiceDigest: value.invoiceDigest,
    amountSats: value.amountSats,
    capacityEpoch: value.capacityEpoch,
    plannedAt: NOW + 20,
  };
  return { ...draft, payloadDigest: lightningActionCommitment(draft, op) };
}

async function setup(label) {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const value = settlement(label);
  store.acceptSettlement(value);
  store.recordReservation(reservation(value));
  const action = pendingAction(value);
  store.planAction(action);
  return { store, value, action };
}

async function makeUnknown(label) {
  const prepared = await setup(label);
  await assert.rejects(() => dispatchLightningAction({
    store: prepared.store,
    actionId: prepared.action.actionId,
    operation: operation(),
    privateKey,
    keyId: "coordinator-test-1",
    adapterUrl: "http://payer-adapter:3000",
    nowSeconds: () => NOW + 21,
    requestImpl: async () => { throw new Error("lost after dispatch"); },
  }));
  return prepared;
}

function successResponse(overrides = {}) {
  return new Response(JSON.stringify({
    result: {
      status: "SUCCEEDED",
      paymentHash: PAYMENT_HASH,
      amountSats: "10000",
      feeSats: "2",
      preimage: PREIMAGE,
      ...overrides,
    },
    audit: { decision: "allow" },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("dispatches the exact committed operation once and persists only its validated proof", async () => {
  const { store, action } = await setup("dispatch-success");
  let calls = 0;
  try {
    const dispatched = await dispatchLightningAction({
      store,
      actionId: action.actionId,
      operation: operation(),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 21,
      requestImpl: async (url, options) => {
        calls += 1;
        assert.equal(url.href, "http://payer-adapter:3000/v1/action");
        const envelope = JSON.parse(options.body);
        assert.equal(envelope.payload.requestId, action.requestId);
        assert.deepEqual(envelope.payload.operation, operation());
        return successResponse();
      },
    });
    assert.equal(calls, 1);
    assert.equal(dispatched.action.state, "CONFIRMED");
    assert.equal(dispatched.action.dispatchCount, 1);
    assert.equal(dispatched.result.preimage, PREIMAGE);
    await assert.rejects(() => dispatchLightningAction({
      store,
      actionId: action.actionId,
      operation: operation(),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
    }), /not pending/);
  } finally {
    store.close();
  }
});

test("rejects an operation mutation before claiming or contacting the adapter", async () => {
  const { store, action } = await setup("dispatch-mutation");
  let called = false;
  try {
    await assert.rejects(() => dispatchLightningAction({
      store,
      actionId: action.actionId,
      operation: { ...operation(), feeLimitSats: "6" },
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      requestImpl: async () => { called = true; return successResponse(); },
    }), /does not match the durable commitment/);
    assert.equal(called, false);
    assert.equal(store.getAction(action.actionId).state, "PENDING");
  } finally {
    store.close();
  }
});

test("records transport loss and malformed success as UNKNOWN without retrying", async () => {
  const first = await setup("dispatch-transport-loss");
  try {
    await assert.rejects(() => dispatchLightningAction({
      store: first.store,
      actionId: first.action.actionId,
      operation: operation(),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 21,
      requestImpl: async () => { throw new Error("socket ended"); },
    }), (error) => error.ambiguous === true && error.actionState === "UNKNOWN");
    assert.equal(first.store.getAction(first.action.actionId).state, "UNKNOWN");
    assert.equal(first.store.getSettlement(first.value.settlementId).reconciliationRequired, true);
  } finally {
    first.store.close();
  }

  const second = await setup("dispatch-invalid-proof");
  try {
    await assert.rejects(() => dispatchLightningAction({
      store: second.store,
      actionId: second.action.actionId,
      operation: operation(),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 21,
      requestImpl: async () => successResponse({ paymentHash: hash("wrong-payment") }),
    }), (error) => error.ambiguous === true && error.actionState === "UNKNOWN");
    assert.equal(second.store.getAction(second.action.actionId).state, "UNKNOWN");
  } finally {
    second.store.close();
  }
});

test("treats every adapter rejection as unproven after durable dispatch", async () => {
  const rejected = await setup("dispatch-rejected");
  try {
    await assert.rejects(() => dispatchLightningAction({
      store: rejected.store,
      actionId: rejected.action.actionId,
      operation: operation(),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 21,
      requestImpl: async () => new Response(JSON.stringify({ error: "policy denied", ambiguous: false }), { status: 403 }),
    }), (error) => error.ambiguous === true && error.actionState === "UNKNOWN");
    assert.equal(rejected.store.getAction(rejected.action.actionId).state, "UNKNOWN");
    assert.equal(rejected.store.getSettlement(rejected.value.settlementId).reconciliationRequired, true);
  } finally {
    rejected.store.close();
  }

  const conflict = await setup("dispatch-conflict");
  try {
    await assert.rejects(() => dispatchLightningAction({
      store: conflict.store,
      actionId: conflict.action.actionId,
      operation: operation(),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 21,
      requestImpl: async () => new Response(JSON.stringify({ error: "already used", ambiguous: false }), { status: 409 }),
    }), (error) => error.ambiguous === true && error.actionState === "UNKNOWN");
    assert.equal(conflict.store.getAction(conflict.action.actionId).state, "UNKNOWN");
  } finally {
    conflict.store.close();
  }
});

test("refuses public or credential-bearing adapter URLs before dispatch", async () => {
  const { store, action } = await setup("dispatch-url");
  try {
    await assert.rejects(() => dispatchLightningAction({
      store,
      actionId: action.actionId,
      operation: operation(),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "https://example.com?secret=value",
    }), /private origin|isolated network/);
    assert.equal(store.getAction(action.actionId).state, "PENDING");
  } finally {
    store.close();
  }
});

test("reconciles an unknown payment through a fresh signed read-only tracking request", async () => {
  const { store, action, value } = await makeUnknown("reconcile-success");
  let calls = 0;
  try {
    const result = await reconcileLightningAction({
      store,
      actionId: action.actionId,
      reconciliationRequestId: hash("reconcile-success:read-request"),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 30,
      requestImpl: async (_url, options) => {
        calls += 1;
        const envelope = JSON.parse(options.body);
        assert.equal(envelope.payload.method, "/routerrpc.Router/TrackPaymentV2");
        assert.deepEqual(envelope.payload.operation, {});
        return new Response(JSON.stringify({
          result: { status: "SUCCEEDED", paymentHash: PAYMENT_HASH, amountSats: "10000", feeSats: "2" },
          audit: { decision: "allow" },
        }), { status: 200 });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.disposition, "confirmed");
    assert.equal(store.getAction(action.actionId).state, "CONFIRMED");
    assert.equal(store.getSettlement(value.settlementId).reconciliationRequired, false);
  } finally {
    store.close();
  }
});

test("reconciles an unknown invoice settlement through a preimage-free lookup", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const value = { ...settlement("reconcile-invoice"), direction: "lightning-to-bit" };
  const settleOperation = { preimage: PREIMAGE };
  const draft = {
    actionId: hash(`${value.settlementId}:action`),
    settlementId: value.settlementId,
    method: "/invoicesrpc.Invoices/SettleInvoice",
    requestId: hash("reconcile-invoice:settle-request"),
    payloadDigest: hash("placeholder"),
    intentDigest: value.intentDigest,
    paymentHash: value.paymentHash,
    invoiceDigest: value.invoiceDigest,
    amountSats: value.amountSats,
    capacityEpoch: value.capacityEpoch,
    plannedAt: NOW + 20,
  };
  const action = { ...draft, payloadDigest: lightningActionCommitment(draft, settleOperation) };
  store.acceptSettlement(value);
  store.recordReservation(reservation(value));
  store.planAction(action);
  try {
    await assert.rejects(() => dispatchLightningAction({
      store,
      actionId: action.actionId,
      operation: settleOperation,
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://invoice-adapter:3000",
      nowSeconds: () => NOW + 21,
      requestImpl: async () => { throw new Error("lost after settlement"); },
    }), (error) => error.ambiguous === true && error.actionState === "UNKNOWN");
    const result = await reconcileLightningAction({
      store,
      actionId: action.actionId,
      reconciliationRequestId: hash("reconcile-invoice:lookup-request"),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://invoice-adapter:3000",
      nowSeconds: () => NOW + 30,
      requestImpl: async (_url, options) => {
        const envelope = JSON.parse(options.body);
        assert.equal(envelope.payload.method, "/invoicesrpc.Invoices/LookupInvoiceV2");
        assert.deepEqual(envelope.payload.operation, {});
        assert.equal(JSON.stringify(envelope).includes(PREIMAGE), false);
        return new Response(JSON.stringify({
          result: {
            paymentHash: PAYMENT_HASH,
            state: "SETTLED",
            valueSats: "10000",
            amountPaidSats: "10000",
            htlcs: [{ state: "SETTLED", amountMsat: "10000000", acceptHeight: 900_000, expiryHeight: 900_080 }],
          },
          audit: { decision: "allow" },
        }), { status: 200 });
      },
    });
    assert.equal(result.disposition, "confirmed");
    assert.equal(result.action.dispatchCount, 1);
    assert.equal(store.getSettlement(value.settlementId).reconciliationRequired, false);
  } finally {
    store.close();
  }
});

test("keeps IN_FLIGHT and NOT_FOUND observations blocked until a terminal proof arrives", async () => {
  const inflight = await makeUnknown("reconcile-inflight");
  try {
    const pending = await reconcileLightningAction({
      store: inflight.store,
      actionId: inflight.action.actionId,
      reconciliationRequestId: hash("reconcile-inflight:first-read"),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 30,
      requestImpl: async () => new Response(JSON.stringify({
        result: { status: "IN_FLIGHT", paymentHash: PAYMENT_HASH, amountSats: "10000", feeSats: "1" },
        audit: {},
      }), { status: 200 }),
    });
    assert.equal(pending.disposition, "unresolved");
    assert.equal(inflight.store.getAction(inflight.action.actionId).state, "UNKNOWN");
    assert.equal(inflight.store.getSettlement(inflight.value.settlementId).reconciliationRequired, true);
  } finally {
    inflight.store.close();
  }

  const missing = await makeUnknown("reconcile-not-found");
  try {
    const notFound = await reconcileLightningAction({
      store: missing.store,
      actionId: missing.action.actionId,
      reconciliationRequestId: hash("reconcile-not-found:first-read"),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 30,
      requestImpl: async () => new Response(JSON.stringify({
        error: "payment not found",
        errorCode: "NOT_FOUND",
        ambiguous: false,
      }), { status: 502 }),
    });
    assert.equal(notFound.disposition, "unresolved");
    assert.equal(missing.store.getAction(missing.action.actionId).state, "UNKNOWN");
  } finally {
    missing.store.close();
  }
});

test("does not clear UNKNOWN when a tracking response changes the bound amount", async () => {
  const { store, action } = await makeUnknown("reconcile-invalid");
  try {
    await assert.rejects(() => reconcileLightningAction({
      store,
      actionId: action.actionId,
      reconciliationRequestId: hash("reconcile-invalid:read-request"),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 30,
      requestImpl: async () => new Response(JSON.stringify({
        result: { status: "SUCCEEDED", paymentHash: PAYMENT_HASH, amountSats: "9999", feeSats: "2" },
        audit: {},
      }), { status: 200 }),
    }), /proof was invalid/);
    assert.equal(store.getAction(action.actionId).state, "UNKNOWN");
  } finally {
    store.close();
  }
});
