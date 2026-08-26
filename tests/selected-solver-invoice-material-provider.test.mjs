import assert from "node:assert/strict";
import {
  createSecretKey,
  generateKeyPairSync,
} from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { id } from "ethers";
import { LndRestError } from "../lib/lnd-rest-client.mjs";
import {
  createTestSelectedSolverInvoiceMaterialNode,
  createTestSelectedSolverInvoiceMaterialService,
} from "../lib/selected-solver-invoice-material.mjs";
import {
  SelectedSolverInvoiceMaterialProviderStore,
  createTestSelectedSolverInvoiceMaterialProviderRoute,
} from "../lib/selected-solver-invoice-material-provider.mjs";
import {
  SelectedSolverInvoiceMaterialTransportError,
  buildSignedSelectedSolverInvoiceMaterialRequest,
  createTestSelectedSolverInvoiceMaterialClient,
  selectedSolverInvoiceMaterialResponseDigest,
  verifySelectedSolverInvoiceMaterialRequest,
  verifiedSelectedSolverInvoiceMaterialResponse,
} from "../lib/selected-solver-invoice-material-transport.mjs";

const NOW = 1_800_000_000;
const ORIGIN = "https://invoice-material.internal";
const MEMO = "TreeSwap selected solver hold invoice";
const PAYMENT_KEY_ID = "solver-payment-secret-1";
const REQUESTER_KEY_ID = "selected-solver-provider-1";
const PROVIDER_KEY_ID = "invoice-material-provider-1";
const PAYMENT_SECRET = createSecretKey(Buffer.alloc(32, 0x4a));
const REQUESTER = generateKeyPairSync("ed25519");
const PROVIDER = generateKeyPairSync("ed25519");
const POLICY = Object.freeze({
  addTimeoutMs: 1_000,
  lookupTimeoutMs: 500,
  invoiceExpirySeconds: 3_600,
  cltvExpiry: 80,
  maximumInvoiceBytes: 4_096,
});

function request(overrides = {}) {
  return {
    requestId: id("private-invoice-material-request"),
    requestDigest: id("private-invoice-material-request-digest"),
    capabilityDigest: id("private-invoice-material-capability"),
    selectedOfferId: id("private-invoice-material-offer"),
    amountSats: "10000",
    authorizationExpiresAt: NOW + 30,
    ...overrides,
  };
}

function notFound() {
  return new LndRestError("invoice not found", {
    httpStatus: 404,
    grpcCode: 5,
    ambiguous: false,
    reason: "invoice-not-found",
  });
}

function invoiceRecord(paymentHash, amountSats) {
  return {
    r_hash: Buffer.from(paymentHash.slice(2), "hex").toString("base64"),
    r_preimage: Buffer.alloc(32).toString("base64"),
    payment_request: `lnbcrt1treeswap${paymentHash.slice(2)}`,
    payment_addr: Buffer.alloc(32, 0x33).toString("base64"),
    value: amountSats,
    expiry: "3600",
    cltv_expiry: "80",
    memo: MEMO,
    state: "OPEN",
    private: false,
    is_amp: false,
    is_keysend: false,
    is_blinded: false,
    settled: false,
    add_index: "1",
  };
}

function memoryNode(options = {}) {
  const invoices = options.invoices ?? new Map();
  const calls = { add: 0, lookup: 0 };
  const node = createTestSelectedSolverInvoiceMaterialNode({
    lookupInvoice: options.lookupInvoice ?? (async (paymentHash) => {
      calls.lookup += 1;
      const invoice = invoices.get(paymentHash);
      if (!invoice) throw notFound();
      return invoice;
    }),
    addHoldInvoice: options.addHoldInvoice ?? (async (input) => {
      calls.add += 1;
      const invoice = invoiceRecord(input.paymentHash, input.amountSats);
      invoices.set(input.paymentHash, invoice);
      return { payment_request: invoice.payment_request, add_index: invoice.add_index };
    }),
  });
  return { calls, invoices, node };
}

function service(node) {
  return createTestSelectedSolverInvoiceMaterialService({
    invoiceNode: node,
    memo: MEMO,
    paymentSecretKey: PAYMENT_SECRET,
    paymentSecretKeyId: PAYMENT_KEY_ID,
    policy: POLICY,
  });
}

async function memoryStore() {
  return SelectedSolverInvoiceMaterialProviderStore.open({
    path: ":memory:",
    initialize: true,
    allowMemory: true,
    maximumLiveRequests: 64,
  });
}

function route({
  store,
  node,
  nowSeconds,
  signal = new AbortController().signal,
  requestTimeoutMs = 500,
  recoveryLeaseSeconds = 2,
} = {}) {
  return createTestSelectedSolverInvoiceMaterialProviderRoute({
    store,
    invoiceService: service(node),
    providerOrigin: ORIGIN,
    requesterPublicKey: REQUESTER.publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    providerPrivateKey: PROVIDER.privateKey,
    providerKeyId: PROVIDER_KEY_ID,
    paymentSecretKeyId: PAYMENT_KEY_ID,
    maximumRequestBytes: 16_384,
    maxClockSkewSeconds: 5,
    requestTimeoutMs,
    recoveryLeaseSeconds,
    responseTtlSeconds: 20,
    nowSeconds,
    signal,
  });
}

function client({ route: target, nowSeconds, overrides = {} }) {
  return createTestSelectedSolverInvoiceMaterialClient({
    endpointOrigin: ORIGIN,
    requesterPrivateKey: REQUESTER.privateKey,
    requesterKeyId: REQUESTER_KEY_ID,
    providerPublicKey: PROVIDER.publicKey,
    providerKeyId: PROVIDER_KEY_ID,
    paymentSecretKeyId: PAYMENT_KEY_ID,
    requestTtlSeconds: 20,
    timeoutMs: 500,
    signal: new AbortController().signal,
    nowSeconds,
    requestImpl: (endpoint, options) => target.handle(new Request(endpoint, options)),
    ...overrides,
  });
}

test("authenticates, durably binds a key version, and replays one exact response after client restart", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const fixture = memoryNode();
  let now = NOW;
  const providerRoute = route({ store, node: fixture.node, nowSeconds: () => now });
  const firstClient = client({ route: providerRoute, nowSeconds: () => now });
  const firstAttempt = firstClient.prepare(request());
  const first = await firstClient.send(firstAttempt);

  assert.equal(first.paymentSecretKeyId, PAYMENT_KEY_ID);
  assert.equal(first.amountSats, "10000");
  assert.equal(first.invoiceState, "OPEN");
  assert.equal(first.requestId, request().requestId);
  assert.equal(verifiedSelectedSolverInvoiceMaterialResponse(first), first);
  assert.match(selectedSolverInvoiceMaterialResponseDigest(first), /^0x[0-9a-f]{64}$/);
  assert.equal(fixture.calls.add, 1);
  assert.equal(fixture.calls.lookup, 2);

  now += 1;
  const restartedClient = client({ route: providerRoute, nowSeconds: () => now });
  const restarted = await restartedClient.send(restartedClient.prepare(request()));
  assert.deepEqual(restarted, first);
  assert.equal(fixture.calls.add, 1);
  assert.equal(fixture.calls.lookup, 2);

  const status = providerRoute.status();
  assert.equal(status.liveReadyResponses, 1);
  assert.equal(status.provider.authenticated, true);
  assert.equal(status.provider.encryptedTransportRequired, true);
  assert.equal(status.provider.exposesPreimage, false);
  assert.equal(status.provider.exposesLndCredential, false);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(
    `${request().requestId.slice(2)}|${PAYMENT_KEY_ID}|${REQUESTER_KEY_ID}|${PROVIDER_KEY_ID}`,
    "i",
  ));
});

test("one concurrent semantic request owns the durable lease and a retry receives the committed response", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const invoices = new Map();
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let lookupCalls = 0;
  let addCalls = 0;
  const fixture = memoryNode({
    invoices,
    lookupInvoice: async (paymentHash) => {
      lookupCalls += 1;
      if (lookupCalls === 1) {
        entered();
        await gate;
      }
      const invoice = invoices.get(paymentHash);
      if (!invoice) throw notFound();
      return invoice;
    },
    addHoldInvoice: async (input) => {
      addCalls += 1;
      const invoice = invoiceRecord(input.paymentHash, input.amountSats);
      invoices.set(input.paymentHash, invoice);
      return { payment_request: invoice.payment_request, add_index: "1" };
    },
  });
  const providerRoute = route({ store, node: fixture.node, nowSeconds: () => NOW });
  const leftClient = client({ route: providerRoute, nowSeconds: () => NOW });
  const rightClient = client({ route: providerRoute, nowSeconds: () => NOW });
  const left = leftClient.send(leftClient.prepare(request()));
  await started;
  const rightAttempt = rightClient.prepare(request());
  await assert.rejects(
    rightClient.send(rightAttempt),
    (error) => error instanceof SelectedSolverInvoiceMaterialTransportError
      && error.ambiguous === true && error.code === "RECOVERY_REQUIRED",
  );
  release();
  const first = await left;
  const recovered = await rightClient.send(rightAttempt);
  assert.deepEqual(recovered, first);
  assert.equal(addCalls, 1);
  assert.equal(lookupCalls, 2);
});

test("recovers the same LND invoice after a provider crash without adding another invoice", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const fixture = memoryNode();
  let calls = 0;
  const firstRoute = route({
    store,
    node: fixture.node,
    recoveryLeaseSeconds: 3,
    nowSeconds: () => {
      calls += 1;
      if (calls === 4) throw new Error("simulated process failure before durable response commit");
      return NOW;
    },
  });
  const firstClient = client({ route: firstRoute, nowSeconds: () => NOW });
  await assert.rejects(
    firstClient.send(firstClient.prepare(request())),
    (error) => error instanceof SelectedSolverInvoiceMaterialTransportError
      && error.ambiguous === true,
  );
  assert.equal(fixture.calls.add, 1);

  const recoveredAt = NOW + 3;
  const recoveredRoute = route({
    store,
    node: fixture.node,
    recoveryLeaseSeconds: 3,
    nowSeconds: () => recoveredAt,
  });
  const recoveredClient = client({ route: recoveredRoute, nowSeconds: () => recoveredAt });
  const recovered = await recoveredClient.send(recoveredClient.prepare(request()));
  assert.equal(recovered.requestId, request().requestId);
  assert.equal(fixture.calls.add, 1);
  assert.equal(fixture.calls.lookup, 3);
});

test("rejects semantic conflicts, key-version substitution, and copied protocol provenance before LND", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const fixture = memoryNode();
  const providerRoute = route({ store, node: fixture.node, nowSeconds: () => NOW });
  const originalClient = client({ route: providerRoute, nowSeconds: () => NOW });
  const original = await originalClient.send(originalClient.prepare(request()));

  const changedClient = client({ route: providerRoute, nowSeconds: () => NOW });
  await assert.rejects(
    changedClient.send(changedClient.prepare(request({ amountSats: "10001" }))),
    (error) => error instanceof SelectedSolverInvoiceMaterialTransportError
      && error.ambiguous === false && error.code === "REQUEST_REJECTED",
  );
  const wrongVersion = client({
    route: providerRoute,
    nowSeconds: () => NOW,
    overrides: { paymentSecretKeyId: "solver-payment-secret-2" },
  });
  await assert.rejects(
    wrongVersion.send(wrongVersion.prepare(request())),
    (error) => error instanceof SelectedSolverInvoiceMaterialTransportError
      && error.ambiguous === false,
  );
  assert.equal(fixture.calls.add, 1);
  assert.equal(fixture.calls.lookup, 2);
  assert.throws(
    () => verifiedSelectedSolverInvoiceMaterialResponse({ ...original }),
    /provenance is invalid/,
  );
});

test("signatures bind every semantic field and reject stale or substituted requester authority", () => {
  const envelope = buildSignedSelectedSolverInvoiceMaterialRequest({
    ...request(),
    paymentSecretKeyId: PAYMENT_KEY_ID,
    requesterKeyId: REQUESTER_KEY_ID,
    requestedAt: NOW,
    expiresAt: NOW + 20,
    requesterPrivateKey: REQUESTER.privateKey,
  });
  const verified = verifySelectedSolverInvoiceMaterialRequest({
    envelope,
    requesterPublicKey: REQUESTER.publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    expectedPaymentSecretKeyId: PAYMENT_KEY_ID,
    maxClockSkewSeconds: 5,
    now: NOW,
  });
  assert.equal(verified.requestId, request().requestId);
  for (const [field, value] of [
    ["requestDigest", id("changed request digest")],
    ["capabilityDigest", id("changed capability")],
    ["selectedOfferId", id("changed offer")],
    ["amountSats", "10001"],
    ["paymentSecretKeyId", "solver-payment-secret-2"],
    ["authorizationExpiresAt", NOW + 29],
  ]) {
    assert.throws(() => verifySelectedSolverInvoiceMaterialRequest({
      envelope: {
        ...envelope,
        payload: { ...envelope.payload, [field]: value },
      },
      requesterPublicKey: REQUESTER.publicKey,
      expectedRequesterKeyId: REQUESTER_KEY_ID,
      expectedPaymentSecretKeyId: field === "paymentSecretKeyId" ? value : PAYMENT_KEY_ID,
      maxClockSkewSeconds: 5,
      now: NOW,
    }));
  }
  assert.throws(() => verifySelectedSolverInvoiceMaterialRequest({
    envelope,
    requesterPublicKey: generateKeyPairSync("ed25519").publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    expectedPaymentSecretKeyId: PAYMENT_KEY_ID,
    maxClockSkewSeconds: 5,
    now: NOW,
  }), /signature is invalid/);
  assert.throws(() => verifySelectedSolverInvoiceMaterialRequest({
    envelope,
    requesterPublicKey: REQUESTER.publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    expectedPaymentSecretKeyId: PAYMENT_KEY_ID,
    maxClockSkewSeconds: 5,
    now: NOW + 20,
  }), /authority window/);
});

test("persists a ready response across store restart and rejects unsafe storage paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-invoice-material-provider-"));
  await chmod(directory, 0o700);
  const path = join(directory, "provider.sqlite");
  let store;
  try {
    store = await SelectedSolverInvoiceMaterialProviderStore.open({
      path,
      initialize: true,
      allowMemory: false,
      maximumLiveRequests: 64,
    });
    const fixture = memoryNode();
    const firstRoute = route({ store, node: fixture.node, nowSeconds: () => NOW });
    const firstClient = client({ route: firstRoute, nowSeconds: () => NOW });
    const first = await firstClient.send(firstClient.prepare(request()));
    store.close();
    store = await SelectedSolverInvoiceMaterialProviderStore.open({
      path,
      initialize: false,
      allowMemory: false,
      maximumLiveRequests: 64,
    });
    const nextRoute = route({ store, node: fixture.node, nowSeconds: () => NOW + 1 });
    const nextClient = client({ route: nextRoute, nowSeconds: () => NOW + 1 });
    assert.deepEqual(await nextClient.send(nextClient.prepare(request())), first);
    assert.equal(fixture.calls.add, 1);
    assert.equal(fixture.calls.lookup, 2);
    await assert.rejects(
      SelectedSolverInvoiceMaterialProviderStore.open({
        path: ":memory:",
        initialize: false,
        allowMemory: true,
        maximumLiveRequests: 64,
      }),
      /initialized test-only/,
    );
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects public endpoints, malformed HTTP, copied stores, and inactive lifecycles", async (t) => {
  assert.throws(() => createTestSelectedSolverInvoiceMaterialClient({
    endpointOrigin: "https://example.com",
    requesterPrivateKey: REQUESTER.privateKey,
    requesterKeyId: REQUESTER_KEY_ID,
    providerPublicKey: PROVIDER.publicKey,
    providerKeyId: PROVIDER_KEY_ID,
    paymentSecretKeyId: PAYMENT_KEY_ID,
    requestTtlSeconds: 20,
    timeoutMs: 500,
    signal: new AbortController().signal,
    nowSeconds: () => NOW,
    requestImpl: async () => { throw new Error(); },
  }), /isolated private HTTPS/);

  const store = await memoryStore();
  t.after(() => store.close());
  const fixture = memoryNode();
  const deployment = new AbortController();
  const providerRoute = route({
    store,
    node: fixture.node,
    nowSeconds: () => NOW,
    signal: deployment.signal,
  });
  const rejected = await providerRoute.handle(new Request(`${ORIGIN}/v1/invoice-material`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  }));
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "invoice-material request rejected" });
  assert.throws(() => createTestSelectedSolverInvoiceMaterialProviderRoute({
    store: { ...store },
    invoiceService: service(memoryNode().node),
    providerOrigin: ORIGIN,
    requesterPublicKey: REQUESTER.publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    providerPrivateKey: PROVIDER.privateKey,
    providerKeyId: PROVIDER_KEY_ID,
    paymentSecretKeyId: PAYMENT_KEY_ID,
    maximumRequestBytes: 16_384,
    maxClockSkewSeconds: 5,
    requestTimeoutMs: 500,
    recoveryLeaseSeconds: 2,
    responseTtlSeconds: 20,
    nowSeconds: () => NOW,
    signal: new AbortController().signal,
  }), /concrete durable store/);
  deployment.abort();
  await assert.rejects(
    providerRoute.handle(new Request(`${ORIGIN}/v1/invoice-material`, { method: "POST", body: "{}" })),
    /active provenance/,
  );
});
