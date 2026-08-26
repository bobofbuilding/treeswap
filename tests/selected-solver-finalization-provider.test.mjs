import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { id, Wallet } from "ethers";
import { invoiceDigest } from "../lib/lnd-rest-client.mjs";
import {
  SelectedSolverFinalizationProviderStore,
  createSelectedSolverFinalizationProviderFinalizer,
  createSelectedSolverFinalizationProviderRoute,
  isSelectedSolverFinalizationProviderFinalizer,
  isSelectedSolverFinalizationProviderRoute,
  isSelectedSolverFinalizationProviderStore,
} from "../lib/selected-solver-finalization-provider.mjs";
import {
  createTestSelectedSolverFinalizationClient,
} from "../lib/selected-solver-finalization-transport.mjs";
import {
  SOLVER_CAPABILITY_TYPES,
  solverCapabilityClaimsDigest,
  solverCapabilityDomain,
  solverCapabilityProofMessage,
  solverEndpointOriginDigest,
  solverEndpointPublicKeyDigest,
  solverLightningNodePubkeyDigest,
  verifySolverCapability,
} from "../lib/solver-capability.mjs";

const NOW = 2_110_000_000;
const ORIGIN = "https://solver-provider.example";
const LIGHTNING_TO_BIT_CONTRACT = "0x1111111111111111111111111111111111111111";
const BIT_TO_LIGHTNING_CONTRACT = "0x2222222222222222222222222222222222222222";
const LIGHTNING_TO_BIT_CODE_HASH = id("provider-lightning-to-bit-runtime");
const BIT_TO_LIGHTNING_CODE_HASH = id("provider-bit-to-lightning-runtime");
const NODE_PUBKEY = `02${"44".repeat(32)}`;
const solver = new Wallet(`0x${"51".repeat(32)}`);
const endpointKeys = generateKeyPairSync("ed25519");
const requesterKeys = generateKeyPairSync("ed25519");
const endpointPublicKey = endpointKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
const requesterPublicKey = requesterKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
const requesterPublicKeyDigest = solverEndpointPublicKeyDigest(requesterPublicKey);
const capabilityPolicy = {
  chainId: "1",
  lightningToBitContract: LIGHTNING_TO_BIT_CONTRACT,
  bitToLightningContract: BIT_TO_LIGHTNING_CONTRACT,
  lightningToBitContractCodeHash: LIGHTNING_TO_BIT_CODE_HASH,
  bitToLightningContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
  maxCapabilityTtlSeconds: 120,
  maxCapacityObservationAgeSeconds: 30,
  maxClockSkewSeconds: 5,
};

async function capabilityVerification(direction = "lightning-to-bit") {
  const verifyingContract = direction === "lightning-to-bit"
    ? LIGHTNING_TO_BIT_CONTRACT
    : BIT_TO_LIGHTNING_CONTRACT;
  const declaration = {
    capabilityId: id(`provider-capability:${direction}`),
    direction: id(direction),
    solver: solver.address,
    lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(NODE_PUBKEY),
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    endpointOriginDigest: solverEndpointOriginDigest(ORIGIN),
    availableBitWei: direction === "lightning-to-bit" ? String(100n * 10n ** 18n) : "0",
    availableLightningSats: "250000",
    capacityEpoch: "7",
    issuedAt: NOW,
    expiresAt: NOW + 60,
  };
  declaration.proofChallenge = solverCapabilityClaimsDigest(declaration, {
    chainId: capabilityPolicy.chainId,
    verifyingContract,
  });
  const proof = solverCapabilityProofMessage(declaration.proofChallenge);
  return verifySolverCapability({
    envelope: {
      declaration,
      endpointOrigin: ORIGIN,
      endpointPublicKey,
      endpointSignature: sign(null, proof, endpointKeys.privateKey).toString("base64"),
      evmSignature: await solver.signTypedData(
        solverCapabilityDomain({ chainId: capabilityPolicy.chainId, verifyingContract }),
        SOLVER_CAPABILITY_TYPES,
        declaration,
      ),
      lightningNodePubkey: NODE_PUBKEY,
      lightningSignature: "z".repeat(104),
    },
    now: NOW,
    policy: capabilityPolicy,
    verifyLightningNodeSignature: async () => ({ valid: true, pubkey: NODE_PUBKEY }),
    readVerifiedBitInventory: async () => ({
      solverId: solver.address,
      availableBitWei: declaration.availableBitWei,
      observedAt: NOW,
    }),
    readVerifiedLightningCapacity: async () => ({
      nodePubkey: NODE_PUBKEY,
      availableLightningSats: declaration.availableLightningSats,
      capacityEpoch: declaration.capacityEpoch,
      observedAt: NOW,
    }),
  });
}

function disclosure(direction = "lightning-to-bit") {
  const userInvoice = "lnbc4u1userprovidedproviderinvoice";
  const bitToLightning = direction === "bit-to-lightning";
  return {
    requestId: id("provider private selected request"),
    pricingCommitment: id("provider private pricing commitment"),
    direction,
    chainId: "1",
    verifyingContract: bitToLightning ? BIT_TO_LIGHTNING_CONTRACT : LIGHTNING_TO_BIT_CONTRACT,
    user: "0x3333333333333333333333333333333333333333",
    beneficiary: "0x4444444444444444444444444444444444444444",
    paymentHash: bitToLightning ? id("provider user invoice payment hash") : `0x${"0".repeat(64)}`,
    invoiceDigest: bitToLightning ? invoiceDigest(userInvoice) : `0x${"0".repeat(64)}`,
    invoice: bitToLightning ? userInvoice : "",
    selectedSolver: solver.address,
    selectedOfferId: id("provider selected blind offer"),
    requestNonce: "9",
    exactBitOutputWei: String(4n * 10n ** 18n),
    exactLightningOutputSats: "400",
    maxFeeBps: "500",
    maxRoutingFeeSats: "10",
    expiresAt: NOW + 45,
  };
}

function executable(request, overrides = {}) {
  const invoice = request.direction === "bit-to-lightning"
    ? request.disclosure.invoice
    : "lnbc4u1selectedsolverproviderinvoice";
  return {
    invoice,
    envelope: {
      offer: {
        invoiceDigest: invoiceDigest(invoice),
        paymentHash: request.direction === "bit-to-lightning"
          ? request.disclosure.paymentHash
          : id("provider selected solver payment hash"),
      },
      signature: `0x${"11".repeat(65)}`,
    },
    expiresAt: NOW + 10,
    ...overrides,
  };
}

async function signedRequest(direction = "lightning-to-bit", requestedAt = NOW) {
  const capability = await capabilityVerification(direction);
  const controller = new AbortController();
  let captured;
  const client = createTestSelectedSolverFinalizationClient({
    requesterPrivateKey: requesterKeys.privateKey,
    signal: controller.signal,
    nowSeconds: () => requestedAt,
    requestImpl: async (_url, options) => {
      captured = JSON.parse(options.body);
      return new Response(JSON.stringify({ error: "capture" }), {
        status: 400,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      });
    },
  });
  const attempt = client.prepare({
    capabilityVerification: capability,
    disclosure: disclosure(direction),
    requestTtlSeconds: 15,
  });
  await assert.rejects(client.send(attempt));
  controller.abort();
  return { capability, request: captured };
}

function authority(request) {
  return {
    requesterPublicKeyDigest,
    capabilityDigest: request.capabilityDigest,
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    solverId: solver.address,
    direction: request.direction,
  };
}

function webRequest(request, overrides = {}) {
  return new Request(`${ORIGIN}/v1/finalize`, {
    method: "POST",
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...overrides.headers,
    },
    body: JSON.stringify(request),
    signal: overrides.signal,
  });
}

async function memoryStore(maximumLiveRequests = 8) {
  return SelectedSolverFinalizationProviderStore.open({
    path: ":memory:",
    allowMemory: true,
    initialize: true,
    maximumLiveRequests,
  });
}

async function route({
  request,
  store,
  nowSeconds = () => NOW,
  finalize = async (verified) => executable(verified),
  recover = async (verified) => executable(verified),
  finalizer,
  ...overrides
}) {
  return createSelectedSolverFinalizationProviderRoute({
    providerOrigin: ORIGIN,
    authority: authority(request),
    endpointPrivateKey: endpointKeys.privateKey,
    store,
    finalizer: finalizer ?? createSelectedSolverFinalizationProviderFinalizer({ finalize, recover }),
    nowSeconds,
    maximumRequestBytes: 65_536,
    recoveryLeaseSeconds: 2,
    requestTimeoutMs: 1_000,
    ...overrides,
  });
}

test("durably caches one exact signed response and replays identical bytes after restart", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-finalization-provider-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "finalization.sqlite");
  const fixture = await signedRequest();
  let finalizeCalls = 0;
  let store = await SelectedSolverFinalizationProviderStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  assert.equal(isSelectedSolverFinalizationProviderStore(store), true);
  assert.equal(isSelectedSolverFinalizationProviderStore({ ...store }), false);
  assert.equal((await lstat(path)).mode & 0o077, 0);
  let provider = await route({
    request: fixture.request,
    store,
    finalize: async (request) => {
      finalizeCalls += 1;
      return executable(request);
    },
  });
  assert.equal(isSelectedSolverFinalizationProviderRoute(provider), true);
  const first = await provider.handle(webRequest(fixture.request));
  assert.equal(first.status, 200);
  const firstBytes = await first.text();
  assert.equal(finalizeCalls, 1);
  for (const file of await readdir(root)) {
    assert.equal((await lstat(join(root, file))).mode & 0o077, 0);
  }
  const status = provider.status();
  assert.equal(status.liveReadyResponses, 1);
  assert.equal(status.liveClaimedRequests, 0);
  assert.equal(status.provider.networkListener, false);
  assert.equal(status.provider.fundingAuthorization, false);
  assert.doesNotMatch(JSON.stringify(status), /invoice|beneficiary|requestId/i);
  assert.throws(() => provider.status("caller-input"), /accepts no input/);
  store.close();

  store = await SelectedSolverFinalizationProviderStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  });
  provider = await route({
    request: fixture.request,
    store,
    finalize: async () => { throw new Error("must not finalize twice"); },
    recover: async () => { throw new Error("must not recover a ready response"); },
  });
  const replay = await provider.handle(webRequest(fixture.request));
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), firstBytes);
  assert.equal(finalizeCalls, 1);
  store.close();
});

test("refuses a cached response whose private database bytes no longer match its digest", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-finalization-tamper-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "finalization.sqlite");
  const fixture = await signedRequest();
  let store = await SelectedSolverFinalizationProviderStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  let provider = await route({ request: fixture.request, store });
  assert.equal((await provider.handle(webRequest(fixture.request))).status, 200);
  store.close();

  const database = new DatabaseSync(path);
  const row = database.prepare(`
    SELECT request_id, response_json FROM selected_solver_finalization_requests
  `).get();
  const changed = JSON.parse(row.response_json);
  changed.invoice = `${changed.invoice}changed`;
  database.prepare(`
    UPDATE selected_solver_finalization_requests SET response_json = ? WHERE request_id = ?
  `).run(JSON.stringify(changed), row.request_id);
  database.close();

  store = await SelectedSolverFinalizationProviderStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  });
  t.after(() => store.close());
  provider = await route({ request: fixture.request, store });
  const refused = await provider.handle(webRequest(fixture.request));
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: "selected-solver finalization recovery required" });
});

test("permits one concurrent finalizer and reports an exact in-flight retry as pending", async (t) => {
  const fixture = await signedRequest();
  const store = await memoryStore();
  t.after(() => store.close());
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  const provider = await route({
    request: fixture.request,
    store,
    finalize: async (request) => {
      calls += 1;
      entered();
      await blocked;
      return executable(request);
    },
  });
  const first = provider.handle(webRequest(fixture.request));
  await started;
  const concurrent = await provider.handle(webRequest(fixture.request));
  assert.equal(concurrent.status, 425);
  assert.equal(concurrent.headers.get("retry-after"), "1");
  release();
  const completed = await first;
  assert.equal(completed.status, 200);
  const completedBytes = await completed.text();
  assert.equal(calls, 1);
  const replay = await provider.handle(webRequest(fixture.request));
  assert.equal(await replay.text(), completedBytes);
  assert.equal(calls, 1);
});

test("recovers a crashed claimed request after lease expiry without calling finalize again", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-finalization-recovery-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "finalization.sqlite");
  const fixture = await signedRequest();
  let now = NOW;
  let durableExternalResult;
  let store = await SelectedSolverFinalizationProviderStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  let provider = await route({
    request: fixture.request,
    store,
    nowSeconds: () => now,
    finalize: async (request) => {
      durableExternalResult = executable(request);
      throw new Error("process died after the external idempotency record committed");
    },
  });
  const interrupted = await provider.handle(webRequest(fixture.request));
  assert.equal(interrupted.status, 503);
  assert.equal(provider.status().liveClaimedRequests, 1);
  store.close();

  now += 3;
  let recoverCalls = 0;
  store = await SelectedSolverFinalizationProviderStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  });
  provider = await route({
    request: fixture.request,
    store,
    nowSeconds: () => now,
    finalize: async () => { throw new Error("recovery must not invoke finalize"); },
    recover: async (_request, options) => {
      recoverCalls += 1;
      assert.equal(options.recovery, true);
      assert.equal(options.requestId, fixture.request.requestId);
      return durableExternalResult;
    },
  });
  const recovered = await provider.handle(webRequest(fixture.request));
  assert.equal(recovered.status, 200);
  const recoveredBytes = await recovered.text();
  assert.equal(recoverCalls, 1);
  const replay = await provider.handle(webRequest(fixture.request));
  assert.equal(await replay.text(), recoveredBytes);
  assert.equal(recoverCalls, 1);
  store.close();
});

test("bounds finalizer work under one deadline and leaves timed-out work recovery-only", async (t) => {
  const fixture = await signedRequest();
  const store = await memoryStore();
  t.after(() => store.close());
  let now = NOW;
  let observedAbort = false;
  const provider = await route({
    request: fixture.request,
    store,
    nowSeconds: () => now,
    recoveryLeaseSeconds: 1,
    requestTimeoutMs: 100,
    finalize: async (_request, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("aborted"));
      }, { once: true });
    }),
  });
  const timedOut = await provider.handle(webRequest(fixture.request));
  assert.equal(timedOut.status, 503);
  assert.equal(observedAbort, true);
  assert.equal(provider.status().liveClaimedRequests, 1);

  now += 2;
  let recovered = 0;
  const recoveryProvider = await route({
    request: fixture.request,
    store,
    nowSeconds: () => now,
    recover: async (request, options) => {
      recovered += 1;
      assert.equal(options.recovery, true);
      return executable(request);
    },
  });
  assert.equal((await recoveryProvider.handle(webRequest(fixture.request))).status, 200);
  assert.equal(recovered, 1);
});

test("retains an atomic claim after SIGKILL and issues one recovery lease", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-finalization-sigkill-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "finalization.sqlite");
  const initialized = await SelectedSolverFinalizationProviderStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  initialized.close();
  const child = spawn(process.execPath, [
    join(import.meta.dirname, "fixtures/selected-finalization-provider-abrupt-kill.mjs"),
    path,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.includes("CLAIMED\n")) break;
  }
  assert.match(output, /CLAIMED/);
  child.kill("SIGKILL");
  await once(child, "exit");

  const recovered = await SelectedSolverFinalizationProviderStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  });
  t.after(() => recovered.close());
  const lease = recovered.begin({
    requestId: `0x${"11".repeat(32)}`,
    requestDigest: `0x${"22".repeat(32)}`,
    requesterPublicKeyDigest: `0x${"33".repeat(32)}`,
    capabilityDigest: `0x${"44".repeat(32)}`,
    solverId: "0x5555555555555555555555555555555555555555",
    direction: "lightning-to-bit",
    expiresAt: 1_015,
    now: 1_003,
    leaseSeconds: 2,
  });
  assert.equal(lease.status, "LEASE");
  assert.equal(lease.lease.recovery, true);
  assert.equal(recovered.begin({
    requestId: `0x${"11".repeat(32)}`,
    requestDigest: `0x${"22".repeat(32)}`,
    requesterPublicKeyDigest: `0x${"33".repeat(32)}`,
    capabilityDigest: `0x${"44".repeat(32)}`,
    solverId: "0x5555555555555555555555555555555555555555",
    direction: "lightning-to-bit",
    expiresAt: 1_015,
    now: 1_003,
    leaseSeconds: 2,
  }).status, "PENDING");
});

test("rejects a valid re-sign under the same stable request ID with a different digest", async (t) => {
  const firstFixture = await signedRequest("lightning-to-bit", NOW);
  const changedTimeFixture = await signedRequest("lightning-to-bit", NOW + 1);
  assert.equal(firstFixture.request.requestId, changedTimeFixture.request.requestId);
  const store = await memoryStore();
  t.after(() => store.close());
  let calls = 0;
  const provider = await route({
    request: firstFixture.request,
    store,
    nowSeconds: () => NOW + 1,
    finalize: async (request) => {
      calls += 1;
      return executable(request);
    },
  });
  assert.equal((await provider.handle(webRequest(firstFixture.request))).status, 200);
  assert.equal((await provider.handle(webRequest(changedTimeFixture.request))).status, 400);
  assert.equal(calls, 1);
});

test("preserves the user invoice in BIT-to-Lightning and rejects changed commitments", async (t) => {
  const fixture = await signedRequest("bit-to-lightning");
  const validStore = await memoryStore();
  t.after(() => validStore.close());
  const valid = await route({ request: fixture.request, store: validStore });
  const response = await valid.handle(webRequest(fixture.request));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).invoice, fixture.request.disclosure.invoice);

  const invalidStore = await memoryStore();
  t.after(() => invalidStore.close());
  const invalid = await route({
    request: fixture.request,
    store: invalidStore,
    finalize: async (request) => executable(request, {
      invoice: "lnbc4u1attackerreplacementinvoice",
    }),
  });
  assert.equal((await invalid.handle(webRequest(fixture.request))).status, 503);
  assert.equal(invalid.status().liveClaimedRequests, 1);
});

test("fails closed on copied provenance, clock rollback, malformed HTTP, and expired response replay", async (t) => {
  const fixture = await signedRequest();
  const store = await memoryStore();
  t.after(() => store.close());
  const finalizer = createSelectedSolverFinalizationProviderFinalizer({
    finalize: async (request) => executable(request, { expiresAt: NOW + 1 }),
    recover: async (request) => executable(request, { expiresAt: NOW + 1 }),
  });
  assert.equal(isSelectedSolverFinalizationProviderFinalizer(finalizer), true);
  assert.equal(isSelectedSolverFinalizationProviderFinalizer({ ...finalizer }), false);
  assert.equal(finalizer.finalize, undefined);
  assert.equal(finalizer.recover, undefined);
  assert.equal(finalizer.status().state, "unbound");
  assert.equal(finalizer.status().fundingAuthorization, false);
  await assert.rejects(route({
    request: fixture.request,
    store: { ...store },
    finalizer,
  }), /concrete durable store/);
  await assert.rejects(route({
    request: fixture.request,
    store,
    finalizer: { ...finalizer },
  }), /concrete recovery-capable finalizer/);
  const provider = await route({ request: fixture.request, store, finalizer });
  assert.equal(finalizer.status().state, "bound");
  await assert.rejects(route({
    request: fixture.request,
    store,
    finalizer,
  }), /already bound/);
  assert.equal((await provider.handle(new Request(`${ORIGIN}/wrong`, {
    method: "POST",
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify(fixture.request),
  }))).status, 400);
  assert.equal((await provider.handle(webRequest(fixture.request, {
    headers: { "content-encoding": "gzip" },
  }))).status, 400);
  assert.equal((await provider.handle(webRequest(fixture.request, {
    headers: { cookie: "forbidden=secret" },
  }))).status, 400);
  assert.equal((await provider.handle(new Request(`${ORIGIN}/v1/finalize`, {
    method: "POST",
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: Uint8Array.from([0xc3, 0x28]),
  }))).status, 400);
  assert.equal((await provider.handle(webRequest(fixture.request))).status, 200);
  let later = NOW + 1;
  const expiredProvider = await route({
    request: fixture.request,
    store,
    finalize: async (request) => executable(request, { expiresAt: NOW + 1 }),
    recover: async (request) => executable(request, { expiresAt: NOW + 1 }),
    nowSeconds: () => later,
  });
  assert.equal((await expiredProvider.handle(webRequest(fixture.request))).status, 400);
  assert.throws(() => store.status({ now: NOW }), /clock regressed/);
  later += 1;
  assert.equal(expiredProvider.status().expiredRequestsAwaitingCleanup, 0);
});
