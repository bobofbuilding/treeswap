import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  CONTRACT_INTENT_WALLET_SESSION_QUERY,
  CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER,
  ContractIntentWalletSessionReaderFatalError,
  assertContractIntentWalletSessionReaderLifecycle,
  claimContractIntentWalletSessionReaderEdge,
  createContractIntentWalletSessionProvider,
  createContractIntentWalletSessionProviderForTests,
  createContractIntentWalletSessionReader,
  createContractIntentWalletSessionReaderForTests,
} from "../lib/contract-intent-wallet-session-reader.mjs";

const NOW = 2_000_000_000;
const RAW_TOKEN = "cd".repeat(32);
const TOKEN_HASH = createHash("sha256").update(RAW_TOKEN, "utf8").digest("hex");
const OTHER_TOKEN_HASH = createHash("sha256").update("ef".repeat(32), "utf8").digest("hex");
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";

function sessionDatabase() {
  const observed = { binds: [], queries: 0 };
  const state = { mode: "active" };
  return {
    observed,
    state,
    prepare(sql) {
      assert.equal(sql, CONTRACT_INTENT_WALLET_SESSION_QUERY);
      observed.queries += 1;
      return {
        bind(tokenHash, observedAt) {
          observed.binds.push([tokenHash, observedAt]);
          return {
            async all() {
              if (state.mode === "throw") throw new Error("private D1 failure detail");
              if (state.mode === "inactive" || tokenHash !== TOKEN_HASH) return { results: [] };
              const row = {
                tokenHash: TOKEN_HASH,
                walletAddress: WALLET,
                chainId: state.mode === "malformed" ? 5 : 1,
                createdAt: new Date(((NOW - 10) * 1_000) + 123).toISOString(),
                expiresAt: new Date(((NOW + 600) * 1_000) + 123).toISOString(),
              };
              return { results: state.mode === "duplicate" ? [row, { ...row }] : [row] };
            },
          };
        },
      };
    },
  };
}

function strictProviderRequest(body, overrides = {}) {
  const bytes = Buffer.from(body, "utf8");
  const requesterKeyId = JSON.parse(body).requesterKeyId;
  return new Request("https://wallet-session.example/api/internal/wallet-session-read", {
    method: "POST",
    headers: {
      "cache-control": "no-store",
      "content-length": String(bytes.length),
      "content-type": "application/json",
      [CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER]: requesterKeyId,
      ...overrides.headers,
    },
    body: bytes,
  });
}

function framedJsonResponse(value, response) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: response.status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function fixture({ transportHook = null } = {}) {
  const deployment = new AbortController();
  const requesterKeys = generateKeyPairSync("ed25519");
  const responseKeys = generateKeyPairSync("ed25519");
  const database = sessionDatabase();
  const clock = { now: NOW };
  const provider = createContractIntentWalletSessionProviderForTests({
    apiOrigin: "https://wallet-session.example",
    clock: () => clock.now,
    database,
    maximumProcessingMilliseconds: 50,
    requesterPublicKey: requesterKeys.publicKey,
    responsePrivateKey: responseKeys.privateKey,
    signal: deployment.signal,
  });
  const requestBodies = [];
  const requestHeaders = [];
  const forward = async (url, options) => {
    requestBodies.push(String(options.body));
    requestHeaders.push(Object.fromEntries(new Headers(options.headers)));
    return provider.handle(new Request(url, options));
  };
  const reader = createContractIntentWalletSessionReaderForTests({
    apiOrigin: "https://wallet-session.example",
    clock: () => clock.now,
    maximumProcessingMilliseconds: 50,
    randomBytes: () => Buffer.alloc(32, 0x44),
    requesterPrivateKey: requesterKeys.privateKey,
    responsePublicKey: responseKeys.publicKey,
    signal: deployment.signal,
    transport: transportHook === null
      ? forward
      : (url, options) => transportHook({ clock, forward, options, provider, url }),
  });
  return {
    clock,
    database,
    deployment,
    provider,
    reader,
    requestBodies,
    requestHeaders,
    requesterKeys,
    responseKeys,
  };
}

test("reads active and inactive D1 sessions without sending the bearer token", async () => {
  const item = fixture();
  const active = await item.reader.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  assert.equal(active.active, true);
  assert.equal(active.walletAddress, WALLET);
  assert.equal(active.rawSessionTokenDisclosed, false);
  assert.equal(active.tokenHashDisclosed, false);
  assert.equal(active.walletDispatchAuthority, false);
  assert.equal(active.lightningDispatchAuthority, false);
  assert.equal(active.fundingAuthorization, false);
  assert.equal(
    item.reader.consume(active, { tokenHash: TOKEN_HASH, observedAt: NOW }),
    active,
  );
  assert.throws(
    () => item.reader.consume(active, { tokenHash: TOKEN_HASH, observedAt: NOW }),
    /provenance or binding/,
  );

  const inactive = await item.reader.read({ tokenHash: OTHER_TOKEN_HASH, observedAt: NOW });
  assert.equal(inactive.active, false);
  assert.equal(inactive.walletAddress, null);
  item.reader.consume(inactive, { tokenHash: OTHER_TOKEN_HASH, observedAt: NOW });

  assert.equal(item.database.observed.queries, 2);
  assert.deepEqual(item.database.observed.binds, [
    [TOKEN_HASH, new Date(NOW * 1_000).toISOString()],
    [OTHER_TOKEN_HASH, new Date(NOW * 1_000).toISOString()],
  ]);
  assert.equal(item.requestBodies.length, 2);
  assert.equal(JSON.parse(item.requestBodies[0]).tokenHash, TOKEN_HASH);
  assert.equal(
    item.requestHeaders[0][CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER],
    JSON.parse(item.requestBodies[0]).requesterKeyId,
  );
  assert.equal(item.requestBodies.some((body) => body.includes(RAW_TOKEN)), false);
  assert.equal(item.reader.status().state, "active");
  assert.equal(item.reader.status().activeReads, 1);
  assert.equal(item.reader.status().inactiveReads, 1);
  item.deployment.abort();
});

test("accepts harmless signed read replay but rejects cookies and malformed framing", async () => {
  const item = fixture();
  const result = await item.reader.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  item.reader.consume(result, { tokenHash: TOKEN_HASH, observedAt: NOW });
  const signedBody = item.requestBodies[0];

  const replay = await item.provider.handle(strictProviderRequest(signedBody));
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.active, true);
  assert.equal("walletDispatchAuthority" in replayBody, false);
  assert.equal("lightningDispatchAuthority" in replayBody, false);
  assert.equal("fundingAuthorization" in replayBody, false);

  const withCookie = await item.provider.handle(strictProviderRequest(signedBody, {
    headers: { cookie: `__Host-treeswap_session=${RAW_TOKEN}` },
  }));
  assert.equal(withCookie.status, 400);
  assert.deepEqual(await withCookie.json(), { error: "wallet session request rejected" });
  const wrongLength = await item.provider.handle(strictProviderRequest(signedBody, {
    headers: { "content-length": "1" },
  }));
  assert.equal(wrongLength.status, 400);
  const missingKeyHeaderRequest = strictProviderRequest(signedBody);
  missingKeyHeaderRequest.headers.delete(CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER);
  const missingKeyHeader = await item.provider.handle(missingKeyHeaderRequest);
  assert.equal(missingKeyHeader.status, 400);
  const wrongKeyHeader = await item.provider.handle(strictProviderRequest(signedBody, {
    headers: {
      [CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER]: `sha256:${"f".repeat(64)}`,
    },
  }));
  assert.equal(wrongKeyHeader.status, 400);
  assert.equal(item.provider.status().state, "active");
  item.deployment.abort();
});

test("accepts the bounded response shape returned by the pinned HTTPS adapter", async () => {
  const item = fixture({
    transportHook: async ({ forward, options, url }) => {
      const response = await forward(url, options);
      return {
        status: response.status,
        redirected: false,
        headers: response.headers,
        body: response.body,
      };
    },
  });
  const result = await item.reader.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  assert.equal(result.active, true);
  item.reader.consume(result, { tokenHash: TOKEN_HASH, observedAt: NOW });
  assert.equal(item.reader.status().state, "active");
  item.deployment.abort();
});

test("halts both sides when D1 returns malformed, duplicate, or unreadable authority", async () => {
  for (const mode of ["malformed", "duplicate", "throw"]) {
    const item = fixture();
    item.database.state.mode = mode;
    await assert.rejects(
      item.reader.read({ tokenHash: TOKEN_HASH, observedAt: NOW }),
      (error) => error instanceof ContractIntentWalletSessionReaderFatalError
        && !error.message.includes("private D1 failure detail"),
    );
    assert.equal(item.provider.status().state, "halted");
    assert.equal(item.provider.status().databaseFailures, 1);
    assert.equal(item.reader.status().state, "halted");
    assert.equal(item.reader.status().failedReads, 1);
    item.deployment.abort();
  }
});

test("halts on response mutation, stale response, and either clock rollback", async () => {
  const mutated = fixture({
    transportHook: async ({ forward, options, url }) => {
      const response = await forward(url, options);
      const body = await response.json();
      body.session.walletAddress = OTHER_WALLET;
      return framedJsonResponse(body, response);
    },
  });
  await assert.rejects(
    mutated.reader.read({ tokenHash: TOKEN_HASH, observedAt: NOW }),
    ContractIntentWalletSessionReaderFatalError,
  );
  assert.equal(mutated.reader.status().state, "halted");
  assert.equal(mutated.provider.status().state, "active");
  mutated.deployment.abort();

  const stale = fixture({
    transportHook: async ({ clock, forward, options, url }) => {
      const response = await forward(url, options);
      clock.now = NOW + 6;
      return response;
    },
  });
  await assert.rejects(
    stale.reader.read({ tokenHash: TOKEN_HASH, observedAt: NOW }),
    ContractIntentWalletSessionReaderFatalError,
  );
  assert.equal(stale.reader.status().state, "halted");
  stale.deployment.abort();

  const providerRollback = fixture();
  const first = await providerRollback.reader.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  providerRollback.reader.consume(first, { tokenHash: TOKEN_HASH, observedAt: NOW });
  providerRollback.clock.now = NOW - 1;
  const replay = await providerRollback.provider.handle(
    strictProviderRequest(providerRollback.requestBodies[0]),
  );
  assert.equal(replay.status, 503);
  assert.equal(providerRollback.provider.status().state, "halted");
  assert.equal(providerRollback.provider.status().clockFailures, 1);
  providerRollback.deployment.abort();

  const readerRollback = fixture();
  const original = await readerRollback.reader.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  readerRollback.reader.consume(original, { tokenHash: TOKEN_HASH, observedAt: NOW });
  readerRollback.clock.now = NOW - 1;
  await assert.rejects(
    readerRollback.reader.read({ tokenHash: TOKEN_HASH, observedAt: NOW - 1 }),
    ContractIntentWalletSessionReaderFatalError,
  );
  assert.equal(readerRollback.reader.status().state, "halted");
  readerRollback.deployment.abort();
});

test("binds one reader lifecycle to one edge lease and keeps status aggregate-only", async () => {
  const item = fixture();
  const binding = assertContractIntentWalletSessionReaderLifecycle(
    item.reader,
    item.deployment.signal,
  );
  assert.equal(binding.mode, "test");
  const { lease } = claimContractIntentWalletSessionReaderEdge(
    item.reader,
    item.deployment.signal,
  );
  assert.throws(() => item.reader.status(), /original lifecycle/);
  assert.throws(
    () => assertContractIntentWalletSessionReaderLifecycle(item.reader, item.deployment.signal),
    /unclaimed active reader lifecycle/,
  );
  const copiedLease = { ...lease };
  assert.throws(() => copiedLease.status(), /original lease/);

  const result = await lease.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  lease.consume(result, { tokenHash: TOKEN_HASH, observedAt: NOW });
  const status = lease.status();
  assert.equal(status.pendingReads, 0);
  assert.equal(status.rawSessionTokensSent, false);
  const providerStatus = item.provider.status();
  const statusBytes = JSON.stringify({ providerStatus, status });
  for (const secret of [RAW_TOKEN, TOKEN_HASH, WALLET.slice(2), binding.requesterKeyId]) {
    assert.equal(statusBytes.includes(secret), false);
  }
  assert.equal(lease.stop().state, "stopped");
  item.deployment.abort();
});

test("production factories reject injected clocks, transports, and processing limits", () => {
  const deployment = new AbortController();
  const requesterKeys = generateKeyPairSync("ed25519");
  const responseKeys = generateKeyPairSync("ed25519");
  const database = sessionDatabase();
  assert.throws(
    () => createContractIntentWalletSessionReader({
      apiOrigin: "https://wallet-session.example",
      clock: () => NOW,
      requesterPrivateKey: requesterKeys.privateKey,
      responsePublicKey: responseKeys.publicKey,
      signal: deployment.signal,
    }),
    /fields are not exact/,
  );
  assert.throws(
    () => createContractIntentWalletSessionProvider({
      apiOrigin: "https://wallet-session.example",
      database,
      maximumProcessingMilliseconds: 1,
      requesterPublicKey: requesterKeys.publicKey,
      responsePrivateKey: responseKeys.privateKey,
      signal: deployment.signal,
    }),
    /fields are not exact/,
  );
  const reader = createContractIntentWalletSessionReader({
    apiOrigin: "https://wallet-session.example",
    requesterPrivateKey: requesterKeys.privateKey,
    responsePublicKey: responseKeys.publicKey,
    signal: deployment.signal,
  });
  const provider = createContractIntentWalletSessionProvider({
    apiOrigin: "https://wallet-session.example",
    database,
    requesterPublicKey: requesterKeys.publicKey,
    responsePrivateKey: responseKeys.privateKey,
    signal: deployment.signal,
  });
  assert.equal(reader.status().fixedHttpsTransport, true);
  assert.equal(provider.status().fixedD1Query, true);
  deployment.abort();
});
