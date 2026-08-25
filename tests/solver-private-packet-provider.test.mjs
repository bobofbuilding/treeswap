import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invoiceDigest } from "../lib/lnd-rest-client.mjs";
import {
  SolverPrivatePacketReplayStore,
  createSolverPrivatePacketProviderReader,
  createSolverPrivatePacketProviderRoute,
  isSolverPrivatePacketProviderReader,
  isSolverPrivatePacketProviderRoute,
  isSolverPrivatePacketReplayStore,
} from "../lib/solver-private-packet-provider.mjs";
import {
  buildPrivatePacketRequest,
  fetchVerifiedPrivatePacket,
  signPrivatePacketRequest,
} from "../lib/solver-private-packet.mjs";

const NOW = 2_000;
const REQUESTER_KEY_ID = "coordinator-provider-test";
const PROVIDER_KEY_ID = "packet-provider-test";
const PROVIDER_ORIGIN = "https://packet-provider.internal";
const requesterKeys = generateKeyPairSync("ed25519");
const providerKeys = generateKeyPairSync("ed25519");

function hash(label) {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

function settlement(label = "provider") {
  const paymentRequest = `lnbcrt-private-provider-${label}`;
  return Object.freeze({
    settlementId: hash(`${label}:settlement`),
    reservationId: hash(`${label}:reservation`),
    direction: "bit-to-lightning",
    intentDigest: hash(`${label}:intent`),
    paymentHash: hash(`${label}:payment`),
    invoiceDigest: invoiceDigest(paymentRequest),
    quoteReceiptDigest: hash(`${label}:quote`),
    selectedSetDigest: hash(`${label}:set`),
    selectedOfferId: hash(`${label}:offer`),
    capacityEpoch: 9,
    paymentRequest,
  });
}

function envelope(label = "provider", overrides = {}) {
  const value = settlement(label);
  const payload = buildPrivatePacketRequest({
    settlement: value,
    purpose: "SEND_PAYMENT",
    requestId: hash(`${label}:request`),
    requesterKeyId: REQUESTER_KEY_ID,
    requestedAt: NOW,
    expiresAt: NOW + 15,
    ...overrides,
  });
  return Object.freeze({
    value,
    requestEnvelope: signPrivatePacketRequest(payload, requesterKeys.privateKey),
  });
}

function packetFor(request, value) {
  return {
    settlementId: request.settlementId,
    reservationId: request.reservationId,
    actionId: request.actionId,
    payloadDigest: request.payloadDigest,
    purpose: request.purpose,
    direction: request.direction,
    intentDigest: request.intentDigest,
    paymentHash: request.paymentHash,
    invoiceDigest: request.invoiceDigest,
    quoteReceiptDigest: request.quoteReceiptDigest,
    selectedSetDigest: request.selectedSetDigest,
    selectedOfferId: request.selectedOfferId,
    capacityEpoch: request.capacityEpoch,
    quoteExpiresAt: NOW + 60,
    lightningActionDeadline: NOW + 120,
    evmRefundAt: NOW + 720,
    operation: {
      paymentRequest: value.paymentRequest,
      feeLimitSats: "20",
      timeoutSeconds: 30,
    },
  };
}

function webRequest(requestEnvelope, overrides = {}) {
  return new Request(`${PROVIDER_ORIGIN}/v1/private-packet`, {
    method: "POST",
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...overrides.headers,
    },
    body: JSON.stringify(requestEnvelope),
    signal: overrides.signal,
  });
}

async function memoryStore(maximumLiveRequests = 8) {
  return SolverPrivatePacketReplayStore.open({
    path: ":memory:",
    allowMemory: true,
    initialize: true,
    maximumLiveRequests,
  });
}

async function route({
  replayStore,
  read = async (request) => packetFor(request, settlement()),
  nowSeconds = () => NOW + 1,
  packetReader = null,
  ...overrides
} = {}) {
  return createSolverPrivatePacketProviderRoute({
    providerOrigin: PROVIDER_ORIGIN,
    requesterPublicKey: requesterKeys.publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    providerPrivateKey: providerKeys.privateKey,
    providerKeyId: PROVIDER_KEY_ID,
    replayStore,
    packetReader: packetReader ?? createSolverPrivatePacketProviderReader({ read }),
    nowSeconds,
    maximumRequestBytes: 65_536,
    maxClockSkewSeconds: 2,
    minimumEvmSafetySeconds: 600,
    responseTtlSeconds: 5,
    timeoutMs: 1_000,
    ...overrides,
  });
}

test("persists packet replay consumption across restart with uncopyable claims", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-packet-replay-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "replay.sqlite");
  const store = await SolverPrivatePacketReplayStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  assert.equal(isSolverPrivatePacketReplayStore(store), true);
  assert.equal(isSolverPrivatePacketReplayStore({ ...store }), false);
  assert.equal(store.path, await realpath(path));
  assert.equal((await lstat(path)).mode & 0o077, 0);
  const claim = store.claim({
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent packet request"),
    expiresAt: NOW + 15,
    now: NOW,
  });
  assert.throws(() => store.consume({ ...claim }, {
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent packet request"),
    expiresAt: NOW + 15,
    now: NOW + 1,
  }), /provenance is invalid/);
  assert.equal(store.consume(claim, {
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent packet request"),
    expiresAt: NOW + 15,
    now: NOW + 1,
  }), true);
  assert.equal(store.consume(claim, {
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent packet request"),
    expiresAt: NOW + 15,
    now: NOW + 1,
  }), false);
  store.close();

  const reopened = await SolverPrivatePacketReplayStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.claim({
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent packet request"),
    expiresAt: NOW + 15,
    now: NOW + 2,
  }), null);
  assert.deepEqual(reopened.status({ now: NOW + 2 }), {
    schema: "treeswap.private-packet-replay.v1",
    status: "healthy-private-packet-replay-store",
    liveClaimedRequests: 0,
    liveConsumedRequests: 1,
    expiredRequestsAwaitingCleanup: 0,
    maximumLiveRequests: 8,
  });
});

test("serves one durable response and integrates with the authenticated client", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-packet-route-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "replay.sqlite");
  const store = await SolverPrivatePacketReplayStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  const fixture = envelope();
  let reads = 0;
  const provider = await route({
    replayStore: store,
    read: async (request) => {
      reads += 1;
      return packetFor(request, fixture.value);
    },
  });
  assert.equal(isSolverPrivatePacketProviderRoute(provider), true);
  assert.equal(isSolverPrivatePacketProviderRoute({ ...provider }), false);
  const reader = createSolverPrivatePacketProviderReader({ read: async () => ({}) });
  assert.equal(isSolverPrivatePacketProviderReader(reader), true);
  assert.equal(isSolverPrivatePacketProviderReader({ ...reader }), false);

  const verified = await fetchVerifiedPrivatePacket({
    providerOrigin: PROVIDER_ORIGIN,
    requestEnvelope: fixture.requestEnvelope,
    providerPublicKey: providerKeys.publicKey,
    expectedProviderKeyId: PROVIDER_KEY_ID,
    minimumEvmSafetySeconds: 600,
    nowSeconds: () => NOW + 2,
    requestImpl: (endpoint, options) => provider.handle(new Request(endpoint, options)),
  });
  assert.equal(verified.packet.operation.paymentRequest, fixture.value.paymentRequest);
  assert.equal(provider.status().liveConsumedRequests, 1);
  assert.equal((await provider.handle(webRequest(fixture.requestEnvelope))).status, 400);
  assert.equal(reads, 1);
  store.close();

  const invoiceBytes = Buffer.from(fixture.value.paymentRequest, "utf8");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      assert.equal((await readFile(`${path}${suffix}`)).includes(invoiceBytes), false);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const reopened = await SolverPrivatePacketReplayStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  });
  t.after(() => reopened.close());
  const restartedProvider = await route({
    replayStore: reopened,
    read: async () => {
      reads += 1;
      throw new Error("replay reached the private source");
    },
  });
  assert.equal((await restartedProvider.handle(webRequest(fixture.requestEnvelope))).status, 400);
  assert.equal(reads, 1);
});

test("allows one concurrent claim and never repeats the private read", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const fixture = envelope("concurrent");
  let reads = 0;
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const provider = await route({
    replayStore: store,
    read: async (request) => {
      reads += 1;
      await gate;
      return packetFor(request, fixture.value);
    },
  });
  const first = provider.handle(webRequest(fixture.requestEnvelope));
  const second = provider.handle(webRequest(fixture.requestEnvelope));
  await new Promise((resolve) => setImmediate(resolve));
  releaseRead();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 400]);
  assert.equal(reads, 1);
});

test("keeps failed reads claimed and fails before reads when storage is unavailable", async (t) => {
  const store = await memoryStore();
  let reads = 0;
  const fixture = envelope("failed-read");
  const provider = await route({
    replayStore: store,
    read: async () => {
      reads += 1;
      throw new Error("private source unavailable");
    },
  });
  assert.equal((await provider.handle(webRequest(fixture.requestEnvelope))).status, 400);
  assert.equal((await provider.handle(webRequest(fixture.requestEnvelope))).status, 400);
  assert.equal(reads, 1);
  assert.equal(store.status({ now: NOW + 1 }).liveClaimedRequests, 1);
  store.close();
  assert.equal((await provider.handle(webRequest(envelope("closed-store").requestEnvelope))).status, 400);
  assert.equal(reads, 1);
  t.after(() => store.close());
});

test("rejects copied dependencies, wrong targets, accessors, and clock rollback", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const concreteReader = createSolverPrivatePacketProviderReader({ read: async () => ({}) });
  await assert.rejects(route({ replayStore: { ...store }, packetReader: concreteReader }), /concrete durable replay store/);
  await assert.rejects(route({ replayStore: store, packetReader: { ...concreteReader } }), /concrete packet reader/);

  let getterCalls = 0;
  const fixture = envelope("accessor");
  const result = packetFor(fixture.requestEnvelope.payload, fixture.value);
  Object.defineProperty(result, "quoteExpiresAt", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return NOW + 60;
    },
  });
  const provider = await route({ replayStore: store, read: async () => result });
  assert.equal((await provider.handle(webRequest(fixture.requestEnvelope))).status, 400);
  assert.equal(getterCalls, 0);
  assert.equal((await provider.handle(new Request("https://packet-provider.internal/wrong", {
    method: "POST",
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify(envelope("wrong-target").requestEnvelope),
  }))).status, 400);

  store.observeTime({ now: NOW + 20 });
  assert.throws(() => provider.status(), /clock regressed/);
});

test("bounds request methods, media types, encodings, and bodies before the private read", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  let reads = 0;
  const provider = await route({ replayStore: store, read: async () => {
    reads += 1;
    throw new Error("must not read");
  } });
  const fixture = envelope("request-bounds");
  const cases = [
    new Request(`${PROVIDER_ORIGIN}/v1/private-packet`, { method: "GET" }),
    webRequest(fixture.requestEnvelope, { headers: { "content-type": "text/plain" } }),
    webRequest(fixture.requestEnvelope, { headers: { "content-encoding": "gzip" } }),
    new Request(`${PROVIDER_ORIGIN}/v1/private-packet`, {
      method: "POST",
      headers: { "cache-control": "no-store", "content-type": "application/json" },
      body: `"${"x".repeat(65_536)}"`,
    }),
  ];
  for (const request of cases) {
    const response = await provider.handle(request);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "private packet request rejected" });
  }
  assert.equal(reads, 0);
});

test("consumes but withholds a response that expires before delivery", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const fixture = envelope("late-delivery");
  const times = [NOW + 1, NOW + 1, NOW + 1, NOW + 1, NOW + 7];
  const provider = await route({
    replayStore: store,
    nowSeconds: () => times.shift() ?? NOW + 7,
    read: async (request) => packetFor(request, fixture.value),
  });
  const response = await provider.handle(webRequest(fixture.requestEnvelope));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "private packet request rejected" });
  assert.equal(store.status({ now: NOW + 7 }).liveConsumedRequests, 1);
});

test("bounds a stalled private read under one provider timeout", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const fixture = envelope("stalled-read");
  let observedAbort = false;
  const provider = await route({
    replayStore: store,
    timeoutMs: 20,
    read: async (_request, { signal }) => {
      await new Promise((resolve) => signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve();
      }, { once: true }));
      throw new Error("aborted");
    },
  });
  const startedAt = Date.now();
  assert.equal((await provider.handle(webRequest(fixture.requestEnvelope))).status, 400);
  assert.ok(Date.now() - startedAt < 500, "provider timeout must remain bounded");
  assert.equal(observedAbort, true);
  assert.equal(store.status({ now: NOW + 1 }).liveClaimedRequests, 1);
});
