import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CONTRACT_INTENT_WALLET_SESSION_QUERY,
  ContractIntentWalletSessionReaderFatalError,
  createContractIntentWalletSessionReaderForTests,
} from "../lib/contract-intent-wallet-session-reader.mjs";
import {
  CONTRACT_INTENT_WALLET_SESSION_ROUTE_ENVIRONMENT_KEYS,
  CONTRACT_INTENT_WALLET_SESSION_ROUTE_MAXIMUM_ROTATION_OVERLAP_SECONDS,
  CONTRACT_INTENT_WALLET_SESSION_ROUTE_MODE,
  createContractIntentWalletSessionRoute,
  createContractIntentWalletSessionRouteForTests,
  createContractIntentWalletSessionRouteFromEnvironment,
} from "../lib/contract-intent-wallet-session-route.mjs";

const NOW = 2_000_000_000;
const ORIGIN = "https://wallet-session.example";
const TOKEN_HASH = createHash("sha256").update("ab".repeat(32), "utf8").digest("hex");
const OTHER_TOKEN_HASH = createHash("sha256").update("cd".repeat(32), "utf8").digest("hex");
const WALLET = "0x1111111111111111111111111111111111111111";

function database() {
  const state = { afterRead: null, mode: "active", queries: 0, binds: [] };
  return {
    state,
    prepare(sql) {
      assert.equal(sql, CONTRACT_INTENT_WALLET_SESSION_QUERY);
      state.queries += 1;
      return {
        bind(...values) {
          state.binds.push(values);
          return {
            async all() {
              if (state.mode === "throw") throw new Error(`D1 secret ${TOKEN_HASH}`);
              if (typeof state.afterRead === "function") state.afterRead();
              if (state.mode === "inactive" || values[0] !== TOKEN_HASH) return { results: [] };
              return {
                results: [{
                  tokenHash: TOKEN_HASH,
                  walletAddress: WALLET,
                  chainId: 1,
                  createdAt: new Date(((NOW - 10) * 1_000) + 321).toISOString(),
                  expiresAt: new Date(((NOW + 600) * 1_000) + 321).toISOString(),
                }],
              };
            },
          };
        },
      };
    },
  };
}

function fixture({ retiring = false, retiringAcceptUntil = NOW + 30 } = {}) {
  const lifecycle = new AbortController();
  const clock = { now: NOW };
  const db = database();
  const currentRequester = generateKeyPairSync("ed25519");
  const currentResponse = generateKeyPairSync("ed25519");
  const retiringRequester = generateKeyPairSync("ed25519");
  const retiringResponse = generateKeyPairSync("ed25519");
  const route = createContractIntentWalletSessionRouteForTests({
    apiOrigin: ORIGIN,
    clock: () => clock.now,
    currentRequesterPublicKey: currentRequester.publicKey,
    currentResponsePrivateKey: currentResponse.privateKey,
    database: db,
    deploymentId: "wallet-session-route-1",
    mode: CONTRACT_INTENT_WALLET_SESSION_ROUTE_MODE,
    retiringAcceptUntil: retiring ? retiringAcceptUntil : null,
    retiringRequesterPublicKey: retiring ? retiringRequester.publicKey : null,
    retiringResponsePrivateKey: retiring ? retiringResponse.privateKey : null,
    signal: lifecycle.signal,
  });
  const observedRequests = [];
  const reader = (requester, response) => createContractIntentWalletSessionReaderForTests({
    apiOrigin: ORIGIN,
    clock: () => clock.now,
    maximumProcessingMilliseconds: 50,
    randomBytes: () => Buffer.alloc(32, requester === currentRequester ? 0x31 : 0x32),
    requesterPrivateKey: requester.privateKey,
    responsePublicKey: response.publicKey,
    signal: lifecycle.signal,
    transport: async (url, options) => {
      observedRequests.push({ url, options: { ...options, headers: { ...options.headers } } });
      return route.handle(new Request(url, options));
    },
  });
  return {
    clock,
    currentReader: reader(currentRequester, currentResponse),
    currentRequester,
    currentResponse,
    db,
    lifecycle,
    observedRequests,
    retiringReader: retiring ? reader(retiringRequester, retiringResponse) : null,
    retiringRequester,
    retiringResponse,
    route,
  };
}

function publicPem(key) {
  return key.export({ format: "pem", type: "spki" });
}

function privatePem(key) {
  return key.export({ format: "pem", type: "pkcs8" });
}

async function builtText(directory) {
  const chunks = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (/\.(?:js|json|map)$/.test(entry.name)) chunks.push(await readFile(child, "utf8"));
    }
  }
  await visit(directory);
  return chunks.join("\n");
}

test("serves active and inactive authoritative D1 reads through the closed route", async () => {
  const item = fixture();
  const active = await item.currentReader.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  assert.equal(active.active, true);
  assert.equal(active.walletAddress, WALLET);
  item.currentReader.consume(active, { tokenHash: TOKEN_HASH, observedAt: NOW });

  const inactive = await item.currentReader.read({ tokenHash: OTHER_TOKEN_HASH, observedAt: NOW });
  assert.equal(inactive.active, false);
  item.currentReader.consume(inactive, { tokenHash: OTHER_TOKEN_HASH, observedAt: NOW });

  assert.equal(item.db.state.queries, 2);
  assert.deepEqual(item.db.state.binds, [
    [TOKEN_HASH, new Date(NOW * 1_000).toISOString()],
    [OTHER_TOKEN_HASH, new Date(NOW * 1_000).toISOString()],
  ]);
  const response = await item.route.handle(new Request(ORIGIN, { method: "GET" }));
  assert.equal(response.status, 400);
  for (const name of [
    "cache-control",
    "cdn-cache-control",
    "cloudflare-cdn-cache-control",
    "surrogate-control",
  ]) assert.match(response.headers.get(name) ?? "", /no-store/);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("server-timing"), null);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet");

  const status = item.route.status();
  assert.equal(status.mode, "closed-test");
  assert.equal(status.currentRequests, 2);
  assert.equal(status.activeResponses, 1);
  assert.equal(status.inactiveResponses, 1);
  assert.equal(status.authoritativeD1ReadOnly, true);
  assert.equal(status.sensitiveBodyLoggingAllowed, false);
  assert.equal(status.walletDispatchAuthority, false);
  assert.equal(status.lightningDispatchAuthority, false);
  assert.equal(status.settlementAuthority, false);
  assert.equal(status.fundingAuthorization, false);
  assert.equal(status.releaseActivationAuthority, false);
  const statusBytes = JSON.stringify(status).toLowerCase();
  for (const secret of [TOKEN_HASH, WALLET.slice(2), "wallet-session-route-1"]) {
    assert.equal(statusBytes.includes(secret.toLowerCase()), false);
  }
  item.lifecycle.abort();
});

test("rejects unknown keys before D1 and contains storage failures without logs", async () => {
  const item = fixture();
  const missingKey = new Request(`${ORIGIN}/api/internal/wallet-session-read`, {
    method: "POST",
    headers: {
      "cache-control": "no-store",
      "content-length": "2",
      "content-type": "application/json",
    },
    body: "{}",
  });
  const rejected = await item.route.handle(missingKey);
  assert.equal(rejected.status, 400);
  assert.equal(item.db.state.queries, 0);
  assert.deepEqual(await rejected.json(), { error: "wallet session request rejected" });

  const messages = [];
  const methods = ["error", "log", "warn"];
  const originals = Object.fromEntries(methods.map((name) => [name, console[name]]));
  for (const name of methods) console[name] = (...values) => messages.push([name, ...values]);
  try {
    item.db.state.mode = "throw";
    await assert.rejects(
      item.currentReader.read({ tokenHash: TOKEN_HASH, observedAt: NOW }),
      ContractIntentWalletSessionReaderFatalError,
    );
  } finally {
    for (const name of methods) console[name] = originals[name];
  }
  assert.deepEqual(messages, []);
  assert.equal(item.route.status().state, "halted");
  assert.equal(item.route.status().providerFailures, 1);
  assert.equal(item.db.state.queries, 1);

  const replay = item.observedRequests[0];
  const afterHalt = await item.route.handle(new Request(replay.url, replay.options));
  assert.equal(afterHalt.status, 503);
  assert.equal(item.db.state.queries, 1);
  const body = await afterHalt.text();
  for (const secret of [TOKEN_HASH, WALLET.slice(2), "D1 secret"]) {
    assert.equal(body.includes(secret), false);
  }
  item.lifecycle.abort();
});

test("supports one bounded retiring credential slot and rejects it at expiry", async () => {
  const item = fixture({ retiring: true });
  const oldRead = await item.retiringReader.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  item.retiringReader.consume(oldRead, { tokenHash: TOKEN_HASH, observedAt: NOW });
  const newRead = await item.currentReader.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  item.currentReader.consume(newRead, { tokenHash: TOKEN_HASH, observedAt: NOW });
  assert.equal(item.route.status().retiringRequests, 1);
  assert.equal(item.route.status().currentRequests, 1);
  assert.equal(item.route.status().retiringCredentialSlotConfigured, true);

  item.clock.now = NOW + 30;
  await assert.rejects(
    item.retiringReader.read({ tokenHash: TOKEN_HASH, observedAt: NOW + 30 }),
    ContractIntentWalletSessionReaderFatalError,
  );
  assert.equal(item.db.state.queries, 2);
  const replacement = await item.currentReader.read({
    tokenHash: TOKEN_HASH,
    observedAt: NOW + 30,
  });
  item.currentReader.consume(replacement, { tokenHash: TOKEN_HASH, observedAt: NOW + 30 });
  assert.equal(item.db.state.queries, 3);
  item.lifecycle.abort();
});

test("does not deliver a retiring-key response that crosses the retirement boundary", async () => {
  const item = fixture({ retiring: true, retiringAcceptUntil: NOW + 1 });
  item.db.state.afterRead = () => { item.clock.now = NOW + 1; };
  await assert.rejects(
    item.retiringReader.read({ tokenHash: TOKEN_HASH, observedAt: NOW }),
    ContractIntentWalletSessionReaderFatalError,
  );
  assert.equal(item.db.state.queries, 1);
  assert.equal(item.route.status().retiringRequests, 1);
  assert.equal(item.route.status().rejectedRequests, 1);
  assert.equal(item.route.status().state, "active");
  item.lifecycle.abort();
});

test("halts the complete route instance on clock rollback", async () => {
  const item = fixture();
  const result = await item.currentReader.read({ tokenHash: TOKEN_HASH, observedAt: NOW });
  item.currentReader.consume(result, { tokenHash: TOKEN_HASH, observedAt: NOW });
  const replay = item.observedRequests[0];
  item.clock.now = NOW - 1;
  const response = await item.route.handle(new Request(replay.url, replay.options));
  assert.equal(response.status, 503);
  assert.equal(item.route.status().state, "halted");
  assert.equal(item.route.status().clockFailures, 1);
  assert.equal(item.db.state.queries, 1);
  item.lifecycle.abort();
});

test("keeps route lifecycle authority on the original object", async () => {
  const item = fixture();
  const copied = { ...item.route };
  assert.throws(() => copied.status(), /original service/);
  await assert.rejects(
    copied.handle(new Request(ORIGIN)),
    /original service/,
  );
  assert.throws(() => copied.stop(), /original service/);
  assert.equal(item.route.stop().state, "stopped");
  item.lifecycle.abort();
});

test("rejects unsafe rotation configurations and all cross-slot key reuse", () => {
  const item = fixture();
  const options = {
    apiOrigin: ORIGIN,
    clock: () => NOW,
    currentRequesterPublicKey: item.currentRequester.publicKey,
    currentResponsePrivateKey: item.currentResponse.privateKey,
    database: item.db,
    deploymentId: "wallet-session-route-2",
    mode: CONTRACT_INTENT_WALLET_SESSION_ROUTE_MODE,
    retiringAcceptUntil: NOW + 30,
    retiringRequesterPublicKey: item.retiringRequester.publicKey,
    retiringResponsePrivateKey: item.retiringResponse.privateKey,
    signal: item.lifecycle.signal,
  };
  assert.throws(
    () => createContractIntentWalletSessionRouteForTests({
      ...options,
      mode: "production",
    }),
    /closed-test mode/,
  );
  assert.throws(
    () => createContractIntentWalletSessionRouteForTests({
      ...options,
      retiringAcceptUntil: NOW
        + CONTRACT_INTENT_WALLET_SESSION_ROUTE_MAXIMUM_ROTATION_OVERLAP_SECONDS + 1,
    }),
    /retiring credential expiry/,
  );
  assert.throws(
    () => createContractIntentWalletSessionRouteForTests({
      ...options,
      retiringResponsePrivateKey: null,
    }),
    /must be complete/,
  );
  assert.throws(
    () => createContractIntentWalletSessionRouteForTests({
      ...options,
      retiringRequesterPublicKey: item.currentRequester.publicKey,
    }),
    /must all be separate/,
  );
  assert.throws(
    () => createContractIntentWalletSessionRoute(options),
    /fields are not exact/,
  );
  item.lifecycle.abort();
});

test("loads only explicit secret-manager values and stays inert when configuration is absent", async () => {
  const lifecycle = new AbortController();
  const requester = generateKeyPairSync("ed25519");
  const response = generateKeyPairSync("ed25519");
  const keys = CONTRACT_INTENT_WALLET_SESSION_ROUTE_ENVIRONMENT_KEYS;
  const environment = {
    [keys.apiOrigin]: ORIGIN,
    [keys.currentRequesterPublicKey]: publicPem(requester.publicKey),
    [keys.currentResponsePrivateKey]: privatePem(response.privateKey),
    [keys.deploymentId]: "wallet-session-route-env-1",
    [keys.mode]: CONTRACT_INTENT_WALLET_SESSION_ROUTE_MODE,
  };
  const route = createContractIntentWalletSessionRouteFromEnvironment({
    database: database(),
    environment,
    signal: lifecycle.signal,
  });
  assert.equal(route.status().state, "active");
  assert.equal(route.status().retiringCredentialSlotConfigured, false);
  assert.throws(
    () => createContractIntentWalletSessionRouteFromEnvironment({
      database: database(),
      environment: {},
      signal: lifecycle.signal,
    }),
    /environment value/,
  );

  const [routeSource, exampleEnvironment] = await Promise.all([
    readFile(new URL("../app/api/internal/wallet-session-read/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(routeSource, /database: env\.DB/);
  assert.match(routeSource, /createContractIntentWalletSessionRouteFromEnvironment/);
  assert.match(routeSource, /initializationRejected = true/);
  assert.doesNotMatch(routeSource, /console\.|process\.env|request\.json|request\.text/);
  assert.doesNotMatch(exampleEnvironment, /BEGIN (?:PRIVATE|PUBLIC) KEY/);
  for (const key of Object.values(keys)) assert.match(exampleEnvironment, new RegExp(`^${key}=`, "m"));
  lifecycle.abort();
});

test("keeps the route and deployment secret names out of the built browser bundle", async () => {
  const repository = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const [client, server] = await Promise.all([
    builtText(join(repository, "dist", "client")),
    builtText(join(repository, "dist", "server")),
  ]);
  const markers = [
    "TREESWAP_WALLET_SESSION_CURRENT_RESPONSE_PRIVATE_KEY_PEM",
    "treeswap.contract-intent-wallet-session-route-status.v1",
    "wallet session route credential keys must all be separate",
  ];
  for (const marker of markers) {
    assert.equal(client.includes(marker), false);
    assert.equal(server.includes(marker), true);
  }
});
