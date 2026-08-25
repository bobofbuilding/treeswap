import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  buildSolverDaemonEvidenceRequest,
  createSolverDaemonEvidenceControls,
  signSolverDaemonEvidenceRequest,
} from "../lib/solver-daemon-evidence-client.mjs";
import {
  createSolverDaemonEvidenceProviderReader,
  createSolverDaemonEvidenceProviderRoute,
  isSolverDaemonEvidenceProviderReader,
  isSolverDaemonEvidenceProviderRoute,
  isSolverDaemonEvidenceReplayStore,
  SOLVER_DAEMON_EVIDENCE_REPLAY_SCHEMA,
  SolverDaemonEvidenceReplayStore,
} from "../lib/solver-daemon-evidence-provider.mjs";
import {
  SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
  verifiedSolverDaemonEvidence,
} from "../lib/solver-daemon-evidence.mjs";

const NOW = 2_100_000_000;
const CHAIN_ID = "31337";
const SETTLEMENT_CONTRACT = "0x1111111111111111111111111111111111111111";
const CONTRACT_CODE_HASH = id("provider settlement runtime").toLowerCase();
const RELEASE_RECORD_DIGEST = id("provider release record").toLowerCase();
const SOLVER = new Wallet(`0x${"22".repeat(32)}`);
const LIGHTNING_OPERATOR = new Wallet(`0x${"33".repeat(32)}`);
const SECURITY_REVIEWER = new Wallet(`0x${"44".repeat(32)}`);
const WRONG_SIGNER = new Wallet(`0x${"55".repeat(32)}`);
const requesterKeys = generateKeyPairSync("ed25519");
const REQUESTER_KEY_ID = "coordinator-evidence-provider-one";

function hash(label) {
  return id(`treeswap-evidence-provider:${label}`).toLowerCase();
}

function policy(overrides = {}) {
  return {
    schema: SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    chainId: CHAIN_ID,
    settlementContract: SETTLEMENT_CONTRACT,
    settlementContractCodeHash: CONTRACT_CODE_HASH,
    solver: SOLVER.address,
    direction: "bit-to-lightning",
    approvers: {
      lightningOperator: LIGHTNING_OPERATOR.address,
      securityReviewer: SECURITY_REVIEWER.address,
    },
    maxEvidenceAgeSeconds: 30,
    maxEvidenceLifetimeSeconds: 30,
    maxClockSkewSeconds: 2,
    ...overrides,
  };
}

function settlement({ observed = false, direction = "bit-to-lightning" } = {}) {
  return {
    settlementId: hash("settlement"),
    direction,
    intentDigest: hash("intent"),
    reservationId: observed ? hash("reservation") : null,
    reservationTxHash: observed ? hash("reservation transaction") : null,
    reservationBlockNumber: observed ? 9 : null,
    reservationBlockHash: observed ? hash("reservation block") : null,
  };
}

function action() {
  return { actionId: hash("action") };
}

function packet() {
  return {
    quoteExpiresAt: NOW + 25,
    lightningActionDeadline: NOW + 20,
    evmRefundAt: NOW + 120,
  };
}

function envelope({
  kind = "RESERVATION",
  requestId = hash("request"),
  requestedAt = NOW,
  expiresAt = NOW + 15,
  evidencePolicy = policy(),
} = {}) {
  const isDispatch = kind === "LIGHTNING_DISPATCH" || kind === "EVM_CLAIM_DISPATCH";
  const request = buildSolverDaemonEvidenceRequest({
    kind,
    policy: evidencePolicy,
    settlement: settlement({ observed: kind !== "RESERVATION", direction: evidencePolicy.direction }),
    action: isDispatch ? action() : null,
    packet: isDispatch ? packet() : null,
    packetResponseDigest: isDispatch ? hash("packet response") : null,
    terminalState: kind === "TERMINAL_COMPLETED"
      ? "COMPLETED"
      : kind === "TERMINAL_REFUNDED" ? "REFUNDED" : "NONE",
    requestId,
    requesterKeyId: REQUESTER_KEY_ID,
    requestedAt,
    expiresAt,
  });
  return signSolverDaemonEvidenceRequest(request, requesterKeys.privateKey);
}

function providerRequest(requestEnvelope, origin = "https://lightning-operator.internal") {
  return new Request(`${origin}/v1/solver-daemon-evidence`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json",
    },
    body: JSON.stringify(requestEnvelope),
  });
}

function observationFor(request, overrides = {}) {
  return {
    reservation: request.kind === "RESERVATION" ? {
      reservationId: hash("observed reservation"),
      reservationTxHash: hash("observed reservation transaction"),
      reservationBlockNumber: 17,
      reservationBlockHash: hash("observed reservation block"),
    } : null,
    proofDigest: hash(`${request.kind}:proof`),
    observedAt: NOW,
    expiresAt: NOW + 10,
    ...overrides,
  };
}

async function memoryStore(maximumLiveRequests = 32) {
  return SolverDaemonEvidenceReplayStore.open({
    path: ":memory:",
    allowMemory: true,
    initialize: true,
    maximumLiveRequests,
  });
}

async function route({
  role = "lightningOperator",
  signer = LIGHTNING_OPERATOR,
  replayStore,
  read,
  evidencePolicy = policy(),
  nowSeconds = () => NOW + 1,
  maximumRequestBytes = 65_536,
} = {}) {
  const reader = createSolverDaemonEvidenceProviderReader({
    read: read ?? (async (request) => observationFor(request)),
  });
  return createSolverDaemonEvidenceProviderRoute({
    role,
    policy: evidencePolicy,
    requesterPublicKey: requesterKeys.publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    replayStore,
    evidenceReader: reader,
    signer,
    nowSeconds,
    maximumRequestBytes,
  });
}

test("persists atomic replay claims in one exact private SQLite schema", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-evidence-replay-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "private", "replay.sqlite");
  const store = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  assert.equal(isSolverDaemonEvidenceReplayStore(store), true);
  assert.equal(isSolverDaemonEvidenceReplayStore({ ...store }), false);
  assert.equal(Object.isFrozen(store), true);
  assert.equal(Object.isFrozen(SolverDaemonEvidenceReplayStore.prototype), true);
  assert.throws(() => { store.claim = () => null; }, /read only|not extensible/);
  assert.throws(
    () => { SolverDaemonEvidenceReplayStore.prototype.claim = () => null; },
    /read only/,
  );
  assert.equal(store.path, await realpath(path));
  assert.equal((await lstat(path)).mode & 0o077, 0);
  assert.deepEqual(store.status({ now: NOW }), {
    schema: SOLVER_DAEMON_EVIDENCE_REPLAY_SCHEMA,
    status: "healthy-private-replay-store",
    liveClaimedRequests: 0,
    liveConsumedRequests: 0,
    expiredRequestsAwaitingCleanup: 0,
    maximumLiveRequests: 8,
  });
  const claim = store.claim({
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent request"),
    expiresAt: NOW + 15,
    now: NOW,
  });
  assert.equal(claim.status, "request-claimed");
  assert.equal(store.claim({
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent request"),
    expiresAt: NOW + 15,
    now: NOW,
  }), null);
  assert.throws(() => store.consume({ ...claim }, {
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent request"),
    expiresAt: NOW + 15,
    now: NOW + 1,
  }), /provenance is invalid/);
  assert.equal(store.consume(claim, {
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent request"),
    expiresAt: NOW + 15,
    now: NOW + 1,
  }), true);
  assert.equal(store.consume(claim, {
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent request"),
    expiresAt: NOW + 15,
    now: NOW + 1,
  }), false);
  const secondConnection = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  });
  assert.equal(secondConnection.claim({
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent request"),
    expiresAt: NOW + 15,
    now: NOW + 1,
  }), null);
  secondConnection.close();
  assert.equal(store.close(), true);
  assert.equal(store.close(), false);

  const reopened = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.claim({
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("persistent request"),
    expiresAt: NOW + 15,
    now: NOW + 2,
  }), null);
  assert.equal(reopened.status({ now: NOW + 2 }).liveConsumedRequests, 1);
});

test("persists a clock high-water mark so prune then rollback cannot resurrect a request", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-evidence-clock-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "replay.sqlite");
  const store = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  const oldRequestId = hash("clock rollback old request");
  const oldClaim = store.claim({
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: oldRequestId,
    expiresAt: NOW + 10,
    now: NOW,
  });
  assert.equal(store.consume(oldClaim, {
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: oldRequestId,
    expiresAt: NOW + 10,
    now: NOW + 1,
  }), true);
  assert.ok(store.claim({
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: hash("clock rollback advancing request"),
    expiresAt: NOW + 30,
    now: NOW + 20,
  }));

  const probe = new DatabaseSync(path);
  assert.equal(Number(probe.prepare(`
    SELECT COUNT(*) AS count FROM solver_evidence_replay_requests
    WHERE requester_key_id = ? AND request_id = ?
  `).get(REQUESTER_KEY_ID, oldRequestId).count), 0);
  assert.equal(probe.prepare(`
    SELECT value FROM solver_evidence_replay_meta WHERE key = 'clock_high_water'
  `).get().value, String(NOW + 20));
  probe.close();

  assert.throws(() => store.claim({
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: oldRequestId,
    expiresAt: NOW + 10,
    now: NOW + 2,
  }), /clock regressed/);
  assert.throws(() => store.status({ now: NOW + 19 }), /clock regressed/);
  store.close();

  const reopened = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  });
  t.after(() => reopened.close());
  assert.throws(() => reopened.observeTime({ now: NOW + 19 }), /clock regressed/);
  assert.equal(reopened.observeTime({ now: NOW + 20 }), true);
});

test("rejects relative, permissive, symlinked, and altered replay databases", async (t) => {
  await assert.rejects(SolverDaemonEvidenceReplayStore.open({
    path: "relative.sqlite",
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  }), /bounded absolute path/);
  await assert.rejects(SolverDaemonEvidenceReplayStore.open({
    path: ":memory:",
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  }), /test-only/);
  assert.throws(
    () => new SolverDaemonEvidenceReplayStore({}, ":memory:", 8, Symbol("copy")),
    /opened through the factory/,
  );

  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-evidence-layout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "replay.sqlite");
  await assert.rejects(SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  }), /explicit initialization is required/);
  const store = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  store.close();
  await assert.rejects(SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  }), /already exists/);
  await chmod(path, 0o644);
  await assert.rejects(SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  }), /permissions must exclude/);
  await chmod(path, 0o600);
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE injected (value TEXT) STRICT");
  database.close();
  await assert.rejects(SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  }), /layout is unsupported/);

  const target = join(root, "target.sqlite");
  await writeFile(target, "not sqlite", { mode: 0o600 });
  const link = join(root, "linked.sqlite");
  await symlink(target, link);
  await assert.rejects(SolverDaemonEvidenceReplayStore.open({
    path: link,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  }), /regular file/);

  const clockPath = join(root, "malformed-clock.sqlite");
  const clockStore = await SolverDaemonEvidenceReplayStore.open({
    path: clockPath,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  clockStore.close();
  const malformedClock = new DatabaseSync(clockPath);
  malformedClock.prepare(`
    UPDATE solver_evidence_replay_meta SET value = '01' WHERE key = 'clock_high_water'
  `).run();
  malformedClock.close();
  await assert.rejects(SolverDaemonEvidenceReplayStore.open({
    path: clockPath,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 8,
  }), /canonical stored integer/);
});

test("fails closed when the exact replay layout changes while the provider is running", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-evidence-live-layout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "replay.sqlite");
  const store = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  t.after(() => store.close());
  assert.equal(store.observeTime({ now: NOW }), true);

  const mutator = new DatabaseSync(path);
  mutator.exec("CREATE TABLE injected (value TEXT) STRICT");
  mutator.close();

  assert.throws(() => store.observeTime({ now: NOW + 1 }), /layout is unsupported/);
  assert.throws(() => store.status({ now: NOW + 1 }), /layout is unsupported/);
});

test("serves one policy-bound signed response and persists replay before returning", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-evidence-route-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "route.sqlite");
  let reads = 0;
  const store = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 16,
  });
  const provider = await route({
    replayStore: store,
    read: async (request) => {
      reads += 1;
      return observationFor(request);
    },
  });
  assert.equal(isSolverDaemonEvidenceProviderRoute(provider), true);
  assert.equal(isSolverDaemonEvidenceProviderRoute({ ...provider }), false);
  const requestEnvelope = envelope();
  const first = await provider.handle(providerRequest(requestEnvelope));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const body = await first.json();
  assert.equal(body.requestEnvelope.payload.requestId, requestEnvelope.payload.requestId);
  assert.equal(body.approval.role, "lightningOperator");
  assert.equal(body.record.reservationId, hash("observed reservation"));
  assert.equal(provider.status().liveConsumedRequests, 1);
  const duplicate = await provider.handle(providerRequest(requestEnvelope));
  assert.equal(duplicate.status, 400);
  assert.deepEqual(await duplicate.json(), { error: "solver evidence request rejected" });
  assert.equal(reads, 1);
  store.close();

  const reopened = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: false,
    maximumLiveRequests: 16,
  });
  t.after(() => reopened.close());
  const restartedProvider = await route({ replayStore: reopened, read: async () => {
    reads += 1;
    throw new Error("a replay must not reach the evidence data path");
  } });
  assert.equal((await restartedProvider.handle(providerRequest(requestEnvelope))).status, 400);
  assert.equal(reads, 1);
});

test("allows exactly one concurrent claimant and never repeats the evidence read", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  let reads = 0;
  let releaseRead;
  const readerGate = new Promise((resolve) => { releaseRead = resolve; });
  const provider = await route({
    replayStore: store,
    read: async (request) => {
      reads += 1;
      await readerGate;
      return observationFor(request);
    },
  });
  const requestEnvelope = envelope({ requestId: hash("concurrent request") });
  const first = provider.handle(providerRequest(requestEnvelope));
  const second = provider.handle(providerRequest(requestEnvelope));
  await new Promise((resolve) => setImmediate(resolve));
  releaseRead();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 400]);
  assert.equal(reads, 1);
});

test("keeps a failed or aborted claim consumed until expiry and purges it safely", async (t) => {
  let now = NOW + 1;
  const store = await memoryStore(1);
  t.after(() => store.close());
  let reads = 0;
  const provider = await route({
    replayStore: store,
    nowSeconds: () => now,
    read: async () => {
      reads += 1;
      throw new Error("independent evidence unavailable");
    },
  });
  const failedEnvelope = envelope({ requestId: hash("failed request") });
  assert.equal((await provider.handle(providerRequest(failedEnvelope))).status, 400);
  assert.equal((await provider.handle(providerRequest(failedEnvelope))).status, 400);
  assert.equal(reads, 1);
  assert.equal(store.status({ now }).liveClaimedRequests, 1);

  now = NOW + 20;
  const recovered = await route({ replayStore: store, nowSeconds: () => now, read: async (request) => {
    reads += 1;
    return observationFor(request, { observedAt: now, expiresAt: now + 5 });
  } });
  const freshEnvelope = envelope({
    requestId: hash("fresh after failure"),
    requestedAt: now - 1,
    expiresAt: now + 10,
  });
  assert.equal((await recovered.handle(providerRequest(freshEnvelope))).status, 200);
  assert.equal(reads, 2);
  assert.equal(store.status({ now }).expiredRequestsAwaitingCleanup, 0);
});

test("fails before the evidence read when durable replay storage is unavailable", async () => {
  const store = await memoryStore();
  let reads = 0;
  const provider = await route({
    replayStore: store,
    read: async (request) => {
      reads += 1;
      return observationFor(request);
    },
  });
  store.close();
  const response = await provider.handle(providerRequest(envelope({
    requestId: hash("closed replay store"),
  })));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "solver evidence request rejected" });
  assert.equal(reads, 0);
});

test("halts an expired request and health status after wall-clock rollback", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  let reads = 0;
  const expiredProvider = await route({
    replayStore: store,
    nowSeconds: () => NOW + 20,
    read: async (request) => {
      reads += 1;
      return observationFor(request);
    },
  });
  const oldEnvelope = envelope({
    requestId: hash("route clock rollback"),
  });
  assert.equal((await expiredProvider.handle(providerRequest(oldEnvelope))).status, 400);
  assert.equal(reads, 0);

  const rollbackProvider = await route({
    replayStore: store,
    nowSeconds: () => NOW + 5,
    read: async (request) => {
      reads += 1;
      return observationFor(request, { observedAt: NOW + 5, expiresAt: NOW + 10 });
    },
  });
  const response = await rollbackProvider.handle(providerRequest(oldEnvelope));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "solver evidence request rejected" });
  assert.equal(reads, 0);
  assert.throws(() => rollbackProvider.status(), /clock regressed/);
  assert.equal(store.status({ now: NOW + 20 }).liveClaimedRequests, 0);
});

test("two independent provider routes integrate with the original dual-route client", async (t) => {
  const lightningStore = await memoryStore();
  const securityStore = await memoryStore();
  t.after(() => lightningStore.close());
  t.after(() => securityStore.close());
  const lightningRoute = await route({ replayStore: lightningStore });
  const securityRoute = await route({
    role: "securityReviewer",
    signer: SECURITY_REVIEWER,
    replayStore: securityStore,
  });
  let nonce = 0;
  const controls = createSolverDaemonEvidenceControls({
    policy: policy(),
    routes: {
      lightningOperator: "https://lightning-operator.internal",
      securityReviewer: "https://security-reviewer.internal",
    },
    requesterPrivateKey: requesterKeys.privateKey,
    requesterKeyId: REQUESTER_KEY_ID,
    requestImpl: (endpoint, options) => {
      const selected = new URL(endpoint).hostname === "lightning-operator.internal"
        ? lightningRoute
        : securityRoute;
      return selected.handle(new Request(endpoint, options));
    },
    nowSeconds: () => NOW + 1,
    randomBytesImpl: () => Buffer.alloc(32, ++nonce),
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
  });
  const observedSettlement = settlement({ observed: true });
  const cases = [
    ["RESERVATION", await controls.observeReservation({ settlement: settlement() })],
    ["LIGHTNING_DISPATCH", await controls.authorizeLightning({
      settlement: observedSettlement,
      action: action(),
      packet: packet(),
      packetResponseDigest: hash("packet response"),
    })],
    ["EVM_CLAIM_DISPATCH", await controls.authorizeEvmClaim({
      settlement: observedSettlement,
      action: action(),
      packet: packet(),
      packetResponseDigest: hash("packet response"),
    })],
    ["TERMINAL_COMPLETED", await controls.verifyAssets({
      settlement: observedSettlement,
      expectedTerminal: "COMPLETED",
    })],
    ["TERMINAL_REFUNDED", await controls.verifyAssets({
      settlement: observedSettlement,
      expectedTerminal: "REFUNDED",
    })],
  ];
  for (const [kind, verification] of cases) {
    const context = verifiedSolverDaemonEvidence(verification, {
      now: NOW + 1,
      expectedKind: kind,
    });
    assert.equal(
      context.record.reservationId,
      kind === "RESERVATION" ? hash("observed reservation") : hash("reservation"),
    );
  }
  assert.equal(lightningStore.status({ now: NOW + 1 }).liveConsumedRequests, cases.length);
  assert.equal(securityStore.status({ now: NOW + 1 }).liveConsumedRequests, cases.length);
});

test("withholds a response when the request expires during signing", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const times = [NOW + 1, NOW + 1, NOW + 2, NOW + 16];
  const provider = await route({
    replayStore: store,
    nowSeconds: () => times.shift() ?? NOW + 16,
  });
  const requestEnvelope = envelope({ requestId: hash("expires during signing") });
  const response = await provider.handle(providerRequest(requestEnvelope));
  assert.equal(response.status, 400);
  assert.equal(store.status({ now: NOW + 16 }).expiredRequestsAwaitingCleanup, 1);
});

test("derives every authority field from the signed request, not the evidence reader", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  let getterCalls = 0;
  const accessorResult = {
    reservation: null,
    proofDigest: hash("accessor proof"),
    observedAt: NOW,
  };
  Object.defineProperty(accessorResult, "expiresAt", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return NOW + 10;
    },
  });
  const provider = await route({
    replayStore: store,
    read: async () => accessorResult,
  });
  const requestEnvelope = envelope({ kind: "LIGHTNING_DISPATCH", requestId: hash("accessor request") });
  assert.equal((await provider.handle(providerRequest(requestEnvelope))).status, 400);
  assert.equal(getterCalls, 0);
  let statusGetterCalls = 0;
  const statusInput = {};
  Object.defineProperty(statusInput, "now", {
    enumerable: true,
    get: () => {
      statusGetterCalls += 1;
      return NOW + 1;
    },
  });
  assert.throws(() => provider.status(statusInput), /accepts no caller input/);
  assert.equal(statusGetterCalls, 0);

  const replacementStore = await memoryStore();
  t.after(() => replacementStore.close());
  const replacement = await route({
    replayStore: replacementStore,
    read: async (request) => observationFor(request, {
      reservation: {
        reservationId: hash("replacement reservation"),
        reservationTxHash: hash("replacement transaction"),
        reservationBlockNumber: 20,
        reservationBlockHash: hash("replacement block"),
      },
    }),
  });
  const replacementEnvelope = envelope({
    kind: "EVM_CLAIM_DISPATCH",
    requestId: hash("replacement request"),
  });
  assert.equal((await replacement.handle(providerRequest(replacementEnvelope))).status, 400);
});

test("rejects wrong signers, copied readers and stores, and another release policy", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  const reader = createSolverDaemonEvidenceProviderReader({
    read: async (request) => observationFor(request),
  });
  assert.equal(isSolverDaemonEvidenceProviderReader(reader), true);
  assert.equal(isSolverDaemonEvidenceProviderReader({ ...reader }), false);
  await assert.rejects(createSolverDaemonEvidenceProviderRoute({
    role: "lightningOperator",
    policy: policy(),
    requesterPublicKey: requesterKeys.publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    replayStore: store,
    evidenceReader: { ...reader },
    signer: LIGHTNING_OPERATOR,
    nowSeconds: () => NOW + 1,
    maximumRequestBytes: 65_536,
  }), /concrete evidence reader/);
  await assert.rejects(route({ replayStore: store, signer: WRONG_SIGNER }), /does not match/);

  let reads = 0;
  const provider = await route({ replayStore: store, read: async (request) => {
    reads += 1;
    return observationFor(request);
  } });
  const anotherPolicy = policy({ releaseRecordDigest: hash("another release") });
  assert.equal((await provider.handle(providerRequest(envelope({
    requestId: hash("another release request"),
    evidencePolicy: anotherPolicy,
  })))).status, 400);
  assert.equal(reads, 0);
});

test("rejects malformed HTTP input and returns only a generic no-store error", async (t) => {
  const store = await memoryStore();
  t.after(() => store.close());
  let reads = 0;
  const provider = await route({ replayStore: store, maximumRequestBytes: 1_024, read: async (request) => {
    reads += 1;
    return observationFor(request);
  } });
  const requestEnvelope = envelope({ requestId: hash("http request") });
  const cases = [
    new Request("http://lightning-operator.internal/v1/solver-daemon-evidence", {
      method: "POST",
      headers: { "cache-control": "no-store", "content-type": "application/json" },
      body: JSON.stringify(requestEnvelope),
    }),
    new Request("https://lightning-operator.internal/not-the-route", {
      method: "POST",
      headers: { "cache-control": "no-store", "content-type": "application/json" },
      body: JSON.stringify(requestEnvelope),
    }),
    new Request("https://lightning-operator.internal/v1/solver-daemon-evidence", {
      method: "POST",
      headers: { "cache-control": "no-store", "content-type": "text/plain" },
      body: JSON.stringify(requestEnvelope),
    }),
    new Request("https://lightning-operator.internal/v1/solver-daemon-evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestEnvelope),
    }),
    new Request("https://lightning-operator.internal/v1/solver-daemon-evidence", {
      method: "POST",
      headers: {
        "cache-control": "no-store",
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestEnvelope),
    }),
    new Request("https://lightning-operator.internal/v1/solver-daemon-evidence", {
      method: "POST",
      headers: { "cache-control": "no-store", "content-type": "application/json" },
      body: "{".repeat(2_000),
    }),
  ];
  for (const input of cases) {
    const response = await provider.handle(input);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "solver evidence request rejected" });
  }
  assert.equal(reads, 0);
});

test("stores no evidence body, transaction commitment, signature, or proof digest", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-evidence-private-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "replay.sqlite");
  const store = await SolverDaemonEvidenceReplayStore.open({
    path,
    allowMemory: false,
    initialize: true,
    maximumLiveRequests: 8,
  });
  const provider = await route({ replayStore: store });
  const requestEnvelope = envelope({ requestId: hash("privacy request") });
  const response = await provider.handle(providerRequest(requestEnvelope));
  assert.equal(response.status, 200);
  const body = await response.json();
  store.close();
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  for (const secretOrMetadata of [
    body.record.proofDigest,
    body.record.intentDigest,
    body.record.reservationTxHash,
    body.approval.signature,
    requestEnvelope.signature,
  ]) {
    assert.equal(text.includes(secretOrMetadata), false);
  }
  assert.equal(text.includes(requestEnvelope.payload.requestId), true);
  assert.equal(text.includes(REQUESTER_KEY_ID), true);
});
