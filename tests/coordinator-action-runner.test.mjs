import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { id, sha256 } from "ethers";
import {
  dispatchLightningAction as dispatchLightningActionRaw,
  lightningActionCommitment,
  readConfirmedLightningPaymentProof as readConfirmedLightningPaymentProofRaw,
  reconcileLightningAction as reconcileLightningActionRaw,
} from "../lib/coordinator-action-runner.mjs";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import { signLightningAdapterResponseEnvelope } from "../lib/lightning-adapter-response.mjs";

const NOW = 2_000_000_000;
const PREIMAGE = id("coordinator-runner-preimage").toLowerCase();
const PAYMENT_HASH = sha256(PREIMAGE).toLowerCase();
const PAYMENT_REQUEST = "lnbc100u1coordinatorrunner";
const { privateKey } = generateKeyPairSync("ed25519");
const responseKeys = generateKeyPairSync("ed25519");
const wrongResponseKeys = generateKeyPairSync("ed25519");
const RESPONSE_KEY_ID = "coordinator-test-response-1";

function responseAuthentication() {
  return { responsePublicKey: responseKeys.publicKey, responseKeyId: RESPONSE_KEY_ID };
}

function dispatchLightningAction(input) {
  return dispatchLightningActionRaw({ ...responseAuthentication(), ...input });
}

function reconcileLightningAction(input) {
  return reconcileLightningActionRaw({ ...responseAuthentication(), ...input });
}

function readConfirmedLightningPaymentProof(input) {
  return readConfirmedLightningPaymentProofRaw({ ...responseAuthentication(), ...input });
}

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

async function makeUnknownInvoice(label) {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const value = { ...settlement(label), direction: "lightning-to-bit" };
  const settleOperation = { preimage: PREIMAGE };
  const draft = {
    actionId: hash(`${value.settlementId}:action`),
    settlementId: value.settlementId,
    method: "/invoicesrpc.Invoices/SettleInvoice",
    requestId: hash(`${label}:settle-request`),
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
  return { store, value, action };
}

function adapterAudit(action, {
  method = action.method,
  requestId = action.requestId,
  observedAt = NOW + 21,
  ...overrides
} = {}) {
  const role = method.startsWith("/invoicesrpc.Invoices/") ? "invoice" : "payer";
  return {
    observedAt,
    decision: "allowed",
    role,
    method,
    credentialIdHash: hash(`${role}:credential`),
    requestId,
    intentDigest: action.intentDigest,
    paymentHash: action.paymentHash,
    invoiceDigest: action.invoiceDigest,
    amountSats: action.amountSats,
    capacityEpoch: action.capacityEpoch,
    reasons: [],
    ...overrides,
  };
}

function signedResponse(body, { privateKey: signingKey = responseKeys.privateKey, keyId = RESPONSE_KEY_ID } = {}) {
  return new Response(JSON.stringify(signLightningAdapterResponseEnvelope({
    body,
    keyId,
    privateKey: signingKey,
  })), { status: 200, headers: { "content-type": "application/json" } });
}

function successResponse(action, overrides = {}, auditOverrides = {}, signing = {}) {
  return signedResponse({
    result: {
      status: "SUCCEEDED",
      paymentHash: PAYMENT_HASH,
      amountSats: "10000",
      feeSats: "2",
      preimage: PREIMAGE,
      ...overrides,
    },
    audit: adapterAudit(action, auditOverrides),
  }, signing);
}

function reconciliationResponse(action, {
  method,
  requestId,
  result,
  observedAt = NOW + 30,
  auditOverrides = {},
  signing = {},
}) {
  return signedResponse({
    result,
    audit: adapterAudit(action, { method, requestId, observedAt, ...auditOverrides }),
  }, signing);
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
        return successResponse(action);
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

test("requires every success audit to bind the exact action and signed authorization window", async () => {
  const malformedAudits = [
    { requestId: hash("another-request") },
    { intentDigest: hash("another-intent") },
    { paymentHash: hash("another-payment") },
    { invoiceDigest: hash("another-invoice") },
    { amountSats: "9999" },
    { capacityEpoch: 4 },
    { method: "/routerrpc.Router/TrackPaymentV2" },
    { role: "invoice" },
    { observedAt: NOW + 20 },
    { observedAt: NOW + 36 },
    { decision: "denied" },
    { reasons: ["generic denial"] },
    { credentialIdHash: "not-a-hash" },
    { credentialIdHash: `0x${"0".repeat(64)}` },
    { unexpected: "field" },
  ];
  for (let index = 0; index < malformedAudits.length; index += 1) {
    const prepared = await setup(`dispatch-audit-mismatch-${index}`);
    try {
      await assert.rejects(() => dispatchLightningAction({
        store: prepared.store,
        actionId: prepared.action.actionId,
        operation: operation(),
        privateKey,
        keyId: "coordinator-test-1",
        adapterUrl: "http://payer-adapter:3000",
        nowSeconds: () => NOW + 21,
        requestImpl: async () => successResponse(prepared.action, {}, malformedAudits[index]),
      }), (error) => error.ambiguous === true && error.actionState === "UNKNOWN");
      assert.equal(prepared.store.getAction(prepared.action.actionId).state, "UNKNOWN");
    } finally {
      prepared.store.close();
    }
  }

  const generic = await setup("dispatch-generic-audit");
  try {
    await assert.rejects(() => dispatchLightningAction({
      store: generic.store,
      actionId: generic.action.actionId,
      operation: operation(),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 21,
      requestImpl: async () => signedResponse({
        result: {
          status: "SUCCEEDED",
          paymentHash: PAYMENT_HASH,
          amountSats: "10000",
          feeSats: "2",
          preimage: PREIMAGE,
        },
        audit: { decision: "allowed" },
      }),
    }), /invalid success proof/);
    assert.equal(generic.store.getAction(generic.action.actionId).state, "UNKNOWN");
  } finally {
    generic.store.close();
  }
});

test("keeps an action unknown when adapter response authentication is missing or wrong", async () => {
  const responses = [
    async (action) => {
      const envelope = await successResponse(action).json();
      return new Response(JSON.stringify(envelope.payload.body), { status: 200 });
    },
    async (action) => successResponse(action, {}, {}, { privateKey: wrongResponseKeys.privateKey }),
    async (action) => successResponse(action, {}, {}, { keyId: "retired-response-key" }),
  ];
  for (let index = 0; index < responses.length; index += 1) {
    const prepared = await setup(`dispatch-response-authentication-${index}`);
    try {
      await assert.rejects(() => dispatchLightningAction({
        store: prepared.store,
        actionId: prepared.action.actionId,
        operation: operation(),
        privateKey,
        keyId: "coordinator-test-1",
        adapterUrl: "http://payer-adapter:3000",
        nowSeconds: () => NOW + 21,
        requestImpl: async () => responses[index](prepared.action),
      }), (error) => error.ambiguous === true && error.actionState === "UNKNOWN");
      assert.equal(prepared.store.getAction(prepared.action.actionId).state, "UNKNOWN");
    } finally {
      prepared.store.close();
    }
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
      requestImpl: async () => { called = true; return successResponse(action); },
    }), /does not match the durable commitment/);
    assert.equal(called, false);
    assert.equal(store.getAction(action.actionId).state, "PENDING");
  } finally {
    store.close();
  }
});

test("snapshots exact operation data without accessors, coercion, or post-review mutation", async () => {
  const value = settlement("operation-exact-data");
  const action = pendingAction(value);
  let calls = 0;
  const accessor = operation();
  Object.defineProperty(accessor, "feeLimitSats", {
    configurable: true,
    enumerable: true,
    get() {
      calls += 1;
      return "5";
    },
  });
  assert.throws(
    () => lightningActionCommitment(action, accessor),
    /enumerable data properties/,
  );
  assert.equal(calls, 0);

  for (const malformed of [
    (() => {
      const candidate = operation();
      Object.defineProperty(candidate, "hidden", { value: true });
      return candidate;
    })(),
    { ...operation(), [Symbol("hidden")]: true },
    Object.assign(Object.create({ inherited: true }), operation()),
    (() => {
      const candidate = operation();
      Object.defineProperty(candidate, "__proto__", {
        configurable: true,
        enumerable: true,
        value: { captured: true },
        writable: true,
      });
      return candidate;
    })(),
  ]) {
    assert.throws(
      () => lightningActionCommitment(action, malformed),
      /fields are not exact|exact data properties|plain data object/,
    );
  }

  let coercions = 0;
  assert.throws(() => lightningActionCommitment(action, {
    ...operation(),
    feeLimitSats: {
      toString() {
        coercions += 1;
        return "5";
      },
    },
  }), /canonical unsigned decimal string/);
  assert.equal(coercions, 0);
  assert.throws(() => lightningActionCommitment(action, {
    ...operation(),
    feeLimitSats: "18446744073709551616",
  }), /must fit uint64/);

  const holdAction = {
    ...action,
    method: "/invoicesrpc.Invoices/AddHoldInvoice",
  };
  assert.throws(() => lightningActionCommitment(holdAction, {
    cltvExpiry: 80,
    expirySeconds: 300,
    isPrivate: "true",
    memo: "TreeSwap hold invoice",
  }), /isPrivate must be a boolean/);

  const prepared = await setup("dispatch-operation-snapshot");
  const mutable = operation();
  try {
    const dispatched = await dispatchLightningAction({
      store: prepared.store,
      actionId: prepared.action.actionId,
      operation: mutable,
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 21,
      beforeSideEffect: async (boundary) => {
        if (boundary === "lightning-dispatch-claim") {
          mutable.feeLimitSats = "999999";
          mutable.paymentRequest = "lnbc1substituted";
          mutable.timeoutSeconds = 999;
        }
      },
      requestImpl: async (_url, options) => {
        const envelope = JSON.parse(options.body);
        assert.deepEqual(envelope.payload.operation, operation());
        return successResponse(prepared.action);
      },
    });
    assert.equal(dispatched.action.state, "CONFIRMED");
    assert.equal(mutable.feeLimitSats, "999999");
  } finally {
    prepared.store.close();
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
      requestImpl: async () => successResponse(second.action, { paymentHash: hash("wrong-payment") }),
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
        return reconciliationResponse(action, {
          method: "/routerrpc.Router/TrackPaymentV2",
          requestId: hash("reconcile-success:read-request"),
          result: {
            status: "SUCCEEDED",
            paymentHash: PAYMENT_HASH,
            amountSats: "10000",
            feeSats: "2",
            preimage: PREIMAGE,
          },
        });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.disposition, "confirmed");
    assert.equal(result.transientResult.preimage, PREIMAGE);
    assert.equal(store.getAction(action.actionId).state, "CONFIRMED");
    assert.equal(store.getSettlement(value.settlementId).reconciliationRequired, false);
  } finally {
    store.close();
  }
});

test("rejects a successful payment lookup without the exact bound preimage", async () => {
  for (const tracked of [
    { status: "SUCCEEDED", paymentHash: PAYMENT_HASH, amountSats: "10000", feeSats: "2" },
    {
      status: "SUCCEEDED",
      paymentHash: PAYMENT_HASH,
      amountSats: "10000",
      feeSats: "2",
      preimage: id("wrong-tracked-preimage").toLowerCase(),
    },
  ]) {
    const unknown = await makeUnknown(`reconcile-invalid-preimage-${"preimage" in tracked}`);
    try {
      await assert.rejects(() => reconcileLightningAction({
        store: unknown.store,
        actionId: unknown.action.actionId,
        reconciliationRequestId: hash(`reconcile-invalid-preimage-${"preimage" in tracked}:request`),
        privateKey,
        keyId: "coordinator-test-1",
        adapterUrl: "http://payer-adapter:3000",
        nowSeconds: () => NOW + 30,
        requestImpl: async () => reconciliationResponse(unknown.action, {
          method: "/routerrpc.Router/TrackPaymentV2",
          requestId: hash(`reconcile-invalid-preimage-${"preimage" in tracked}:request`),
          result: tracked,
        }),
      }), /proof was invalid/);
      assert.equal(unknown.store.getAction(unknown.action.actionId).state, "UNKNOWN");
    } finally {
      unknown.store.close();
    }
  }
});

test("recovers a confirmed payment preimage after restart without changing durable state", async () => {
  const { store, action } = await setup("confirmed-proof-recovery");
  try {
    await dispatchLightningAction({
      store,
      actionId: action.actionId,
      operation: operation(),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 21,
      requestImpl: async () => successResponse(action),
    });
    const before = store.getAction(action.actionId);
    const proof = await readConfirmedLightningPaymentProof({
      store,
      actionId: action.actionId,
      requestId: hash("confirmed-proof-recovery:read"),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 30,
      requestImpl: async (_url, options) => {
        const envelope = JSON.parse(options.body);
        assert.equal(envelope.payload.method, "/routerrpc.Router/TrackPaymentV2");
        return reconciliationResponse(action, {
          method: "/routerrpc.Router/TrackPaymentV2",
          requestId: hash("confirmed-proof-recovery:read"),
          result: {
            status: "SUCCEEDED",
            paymentHash: PAYMENT_HASH,
            amountSats: "10000",
            feeSats: "2",
            preimage: PREIMAGE,
          },
        });
      },
    });
    assert.equal(proof.preimage, PREIMAGE);
    assert.deepEqual(store.getAction(action.actionId), before);
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
        return reconciliationResponse(action, {
          method: "/invoicesrpc.Invoices/LookupInvoiceV2",
          requestId: hash("reconcile-invoice:lookup-request"),
          result: {
            paymentHash: PAYMENT_HASH,
            state: "SETTLED",
            valueSats: "10000",
            amountPaidSats: "10000",
            htlcs: [{ state: "SETTLED", amountMsat: "10000000", acceptHeight: 900_000, expiryHeight: 900_080 }],
          },
        });
      },
    });
    assert.equal(result.disposition, "confirmed");
    assert.equal(result.action.dispatchCount, 1);
    assert.equal(store.getSettlement(value.settlementId).reconciliationRequired, false);
  } finally {
    store.close();
  }
});

test("rejects malformed invoice states, paid amounts, and HTLC summaries without clearing UNKNOWN", async () => {
  const malformedResults = [
    {
      paymentHash: PAYMENT_HASH,
      state: "UNKNOWN",
      valueSats: "10000",
      amountPaidSats: "10000",
      htlcs: [],
    },
    {
      paymentHash: PAYMENT_HASH,
      state: "SETTLED",
      valueSats: "10000",
      amountPaidSats: "9999",
      htlcs: [{ state: "SETTLED", amountMsat: "10000000", acceptHeight: 900_000, expiryHeight: 900_080 }],
    },
    {
      paymentHash: PAYMENT_HASH,
      state: "SETTLED",
      valueSats: "10000",
      amountPaidSats: "10000",
      htlcs: [{ state: "UNKNOWN", amountMsat: "10000000", acceptHeight: 900_000, expiryHeight: 900_080 }],
    },
    {
      paymentHash: PAYMENT_HASH,
      state: "SETTLED",
      valueSats: "10000",
      amountPaidSats: "10000",
      htlcs: [{ state: "SETTLED", amountMsat: "10000000", acceptHeight: 900_080, expiryHeight: 900_000 }],
    },
  ];
  for (let index = 0; index < malformedResults.length; index += 1) {
    const unknown = await makeUnknownInvoice(`reconcile-malformed-invoice-${index}`);
    const requestId = hash(`reconcile-malformed-invoice-${index}:lookup`);
    try {
      await assert.rejects(() => reconcileLightningAction({
        store: unknown.store,
        actionId: unknown.action.actionId,
        reconciliationRequestId: requestId,
        privateKey,
        keyId: "coordinator-test-1",
        adapterUrl: "http://invoice-adapter:3000",
        nowSeconds: () => NOW + 30,
        requestImpl: async () => reconciliationResponse(unknown.action, {
          method: "/invoicesrpc.Invoices/LookupInvoiceV2",
          requestId,
          result: malformedResults[index],
        }),
      }), /proof was invalid/);
      assert.equal(unknown.store.getAction(unknown.action.actionId).state, "UNKNOWN");
    } finally {
      unknown.store.close();
    }
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
      requestImpl: async () => reconciliationResponse(inflight.action, {
        method: "/routerrpc.Router/TrackPaymentV2",
        requestId: hash("reconcile-inflight:first-read"),
        result: { status: "IN_FLIGHT", paymentHash: PAYMENT_HASH, amountSats: "10000", feeSats: "1" },
      }),
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

test("keeps reconciliation unknown on a copied audit, unsupported state, or malformed NOT_FOUND", async () => {
  const requestId = hash("reconcile-exact-response:request");
  const copied = await makeUnknown("reconcile-copied-audit");
  try {
    await assert.rejects(() => reconcileLightningAction({
      store: copied.store,
      actionId: copied.action.actionId,
      reconciliationRequestId: requestId,
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 30,
      requestImpl: async () => reconciliationResponse(copied.action, {
        method: "/routerrpc.Router/TrackPaymentV2",
        requestId,
        result: {
          status: "SUCCEEDED",
          paymentHash: PAYMENT_HASH,
          amountSats: "10000",
          feeSats: "2",
          preimage: PREIMAGE,
        },
        auditOverrides: { intentDigest: hash("copied-from-another-action") },
      }),
    }), /proof was invalid/);
    assert.equal(copied.store.getAction(copied.action.actionId).state, "UNKNOWN");
  } finally {
    copied.store.close();
  }

  const unsupported = await makeUnknown("reconcile-unsupported-state");
  try {
    await assert.rejects(() => reconcileLightningAction({
      store: unsupported.store,
      actionId: unsupported.action.actionId,
      reconciliationRequestId: hash("reconcile-unsupported-state:request"),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 30,
      requestImpl: async () => reconciliationResponse(unsupported.action, {
        method: "/routerrpc.Router/TrackPaymentV2",
        requestId: hash("reconcile-unsupported-state:request"),
        result: { status: "UNKNOWN", paymentHash: PAYMENT_HASH, amountSats: "10000", feeSats: "0" },
      }),
    }), /proof was invalid/);
    assert.equal(unsupported.store.getAction(unsupported.action.actionId).state, "UNKNOWN");
  } finally {
    unsupported.store.close();
  }

  const malformedMissing = await makeUnknown("reconcile-malformed-not-found");
  try {
    await assert.rejects(() => reconcileLightningAction({
      store: malformedMissing.store,
      actionId: malformedMissing.action.actionId,
      reconciliationRequestId: hash("reconcile-malformed-not-found:request"),
      privateKey,
      keyId: "coordinator-test-1",
      adapterUrl: "http://payer-adapter:3000",
      nowSeconds: () => NOW + 30,
      requestImpl: async () => new Response(JSON.stringify({
        error: "payment not found",
        errorCode: "NOT_FOUND",
        ambiguous: false,
        requestId: hash("attacker-added-binding"),
      }), { status: 502 }),
    }), /was rejected/);
    assert.equal(malformedMissing.store.getAction(malformedMissing.action.actionId).state, "UNKNOWN");
  } finally {
    malformedMissing.store.close();
  }
});

test("keeps reconciliation unknown when response authentication is missing or wrong", async () => {
  const result = {
    status: "SUCCEEDED",
    paymentHash: PAYMENT_HASH,
    amountSats: "10000",
    feeSats: "2",
    preimage: PREIMAGE,
  };
  for (const mode of ["unsigned", "wrong-key", "wrong-key-id"]) {
    const unknown = await makeUnknown(`reconcile-response-authentication-${mode}`);
    const requestId = hash(`reconcile-response-authentication-${mode}:request`);
    try {
      await assert.rejects(() => reconcileLightningAction({
        store: unknown.store,
        actionId: unknown.action.actionId,
        reconciliationRequestId: requestId,
        privateKey,
        keyId: "coordinator-test-1",
        adapterUrl: "http://payer-adapter:3000",
        nowSeconds: () => NOW + 30,
        requestImpl: async () => {
          const signed = reconciliationResponse(unknown.action, {
            method: "/routerrpc.Router/TrackPaymentV2",
            requestId,
            result,
            signing: mode === "wrong-key"
              ? { privateKey: wrongResponseKeys.privateKey }
              : mode === "wrong-key-id"
                ? { keyId: "retired-response-key" }
                : {},
          });
          if (mode !== "unsigned") return signed;
          const envelope = await signed.json();
          return new Response(JSON.stringify(envelope.payload.body), { status: 200 });
        },
      }), /proof was invalid/);
      assert.equal(unknown.store.getAction(unknown.action.actionId).state, "UNKNOWN");
    } finally {
      unknown.store.close();
    }
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
      requestImpl: async () => reconciliationResponse(action, {
        method: "/routerrpc.Router/TrackPaymentV2",
        requestId: hash("reconcile-invalid:read-request"),
        result: { status: "SUCCEEDED", paymentHash: PAYMENT_HASH, amountSats: "9999", feeSats: "2" },
      }),
    }), /proof was invalid/);
    assert.equal(store.getAction(action.actionId).state, "UNKNOWN");
  } finally {
    store.close();
  }
});
