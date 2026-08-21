import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildLiveAccountEvidence, liveAccountEvidencePolicy } from "../lib/live-account-evidence.mjs";
import {
  extractSessionCookie,
  inspectSessionCookie,
  runLiveAccountLifecycle,
} from "../lib/live-account-lifecycle.mjs";

const SOURCE = {
  branch: "main",
  commit: "a".repeat(40),
  clean: true,
  published: true,
};
const DEPLOYMENT = {
  origin: liveAccountEvidencePolicy.origin,
  platform: "OpenAI Sites",
  access: "owner-only",
  version: "9",
};
const CHECKS = Object.fromEntries(liveAccountEvidencePolicy.checkKeys.map((key) => [key, true]));

function evidence(overrides = {}) {
  return buildLiveAccountEvidence({
    source: SOURCE,
    deployment: DEPLOYMENT,
    startedAt: "2026-08-21T16:00:00.000Z",
    finishedAt: "2026-08-21T16:01:00.000Z",
    checks: CHECKS,
    ...overrides,
  });
}

function mockAccountEndpoint() {
  const account = Object.freeze({
    schema: "treeswap.account-capability.v1",
    enabled: true,
    durableStorage: true,
    emailDeliveryEnabled: false,
  });
  const usedNonces = new Set();
  let nonceSequence = 0;
  let sessionSequence = 0;
  let activeCookie = null;
  let activeSession = null;

  return async ({ path, method = "GET", originHeader, cookie, body }) => {
    if (path === "/api/auth/nonce" && method === "GET") {
      nonceSequence += 1;
      return {
        status: 200,
        json: {
          nonce: nonceSequence.toString(16).padStart(32, "0"),
          domain: "treeswap-lightning-bit.bobofbuilding.chatgpt.site",
          uri: liveAccountEvidencePolicy.origin,
          expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
        },
        setCookie: null,
      };
    }
    if (path === "/api/auth/verify" && method === "POST") {
      const nonce = body.message.match(/\nNonce: ([0-9a-f]{32})\n/)?.[1];
      if (!nonce || usedNonces.has(nonce)) {
        return { status: 401, json: { error: "This sign-in request expired or was already used." }, setCookie: null };
      }
      usedNonces.add(nonce);
      const walletAddress = body.message.match(/account:\n(0x[0-9a-fA-F]{40})\n/)?.[1].toLowerCase();
      sessionSequence += 1;
      const token = sessionSequence.toString(16).padStart(64, "0");
      activeCookie = `__Host-treeswap_session=${token}`;
      activeSession = {
        walletAddress,
        chainId: 1,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        notifications: null,
      };
      return {
        status: 200,
        json: { session: activeSession },
        setCookie: `${activeCookie}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`,
      };
    }
    if (path === "/api/auth/session" && method === "DELETE") {
      if (originHeader !== liveAccountEvidencePolicy.origin) {
        return { status: 403, json: { error: "Cross-origin sign-out rejected." }, setCookie: null };
      }
      if (cookie === activeCookie) {
        activeCookie = null;
        activeSession = null;
      }
      return { status: 200, json: { account, session: null }, setCookie: null };
    }
    if (path === "/api/auth/session" && method === "GET") {
      return { status: 200, json: { account, session: cookie && cookie === activeCookie ? activeSession : null }, setCookie: null };
    }
    throw new Error("unexpected mock account request");
  };
}

test("builds one exact, secret-free, no-funding live account record", () => {
  const result = evidence();
  assert.equal(result.schema, "treeswap.live-account-evidence.v1");
  assert.equal(result.status, "passed");
  assert.equal(result.scope, "owner-only-live-d1-siwe-no-funding-authorization");
  assert.match(result.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(result.limitations.fundingAuthorization, false);
  assert.equal(result.limitations.backupRestoreIncluded, false);
  assert.equal(result.limitations.continuousMonitoringIncluded, false);
  assert.equal(result.limitations.expiredRecordPurgeIncluded, false);
  assert.equal(result.limitations.emailDeliveryIncluded, false);
  assert.doesNotMatch(JSON.stringify(result), /private.?key|signature|set-cookie|bearer|walletAddress|email@|"nonce":/i);
  assert.equal(evidence().evidenceDigest, result.evidenceDigest);
});

test("fails closed on a missed check, source drift, deployment substitution, extra data, or reversed time", () => {
  const missed = { ...CHECKS, sessionPersisted: false };
  assert.throws(() => evidence({ checks: missed }), /sessionPersisted/);
  assert.throws(() => evidence({ source: { ...SOURCE, clean: false } }), /clean published main/);
  assert.throws(() => evidence({ deployment: { ...DEPLOYMENT, origin: "https://attacker.invalid" } }), /owner-only/);
  assert.throws(() => evidence({ deployment: { ...DEPLOYMENT, bypassToken: "secret" } }), /fields are not exact/);
  assert.throws(() => evidence({ finishedAt: "2026-08-21T15:59:59.999Z" }), /finished before/);
});

test("recognizes only the hardened host session cookie", () => {
  const token = "b".repeat(64);
  const combined = `__Host-treeswap_session=${token}; Path=/; Expires=Sat, 22 Aug 2026 17:41:15 GMT; Max-Age=86400; Secure; HttpOnly; SameSite=strict, __cf_bm=edge-value; HttpOnly; SameSite=None; Secure; Path=/; Domain=chatgpt.site`;
  assert.equal(
    inspectSessionCookie(`__Host-treeswap_session=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`),
    `__Host-treeswap_session=${token}`,
  );
  assert.equal(inspectSessionCookie(combined), `__Host-treeswap_session=${token}`);
  assert.equal(extractSessionCookie(combined), `__Host-treeswap_session=${token}`);
  for (const header of [
    `treeswap_session=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`,
    `__Host-treeswap_session=${token}; Path=/; Max-Age=86400; Secure; SameSite=Strict`,
    `__Host-treeswap_session=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
    `__Host-treeswap_session=${token}; Domain=example.com; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`,
  ]) assert.throws(() => inspectSessionCookie(header), /cookie/);
});

test("exercises nonce replay, persistence, rotation, origin, sign-out, and notification isolation", async () => {
  const checks = await runLiveAccountLifecycle({ request: mockAccountEndpoint() });
  assert.deepEqual(checks, CHECKS);
});

test("best-effort sign-out runs if a live check fails after session creation", async () => {
  const endpoint = mockAccountEndpoint();
  let signedIn = false;
  let cleanupCalls = 0;
  const request = async (input) => {
    if (input.method === "DELETE" && input.originHeader === liveAccountEvidencePolicy.origin) {
      cleanupCalls += 1;
      return endpoint(input);
    }
    const response = await endpoint(input);
    if (input.path === "/api/auth/verify" && response.status === 200) signedIn = true;
    if (signedIn && input.path === "/api/auth/session" && input.cookie) throw new Error("injected observation failure");
    return response;
  };

  await assert.rejects(() => runLiveAccountLifecycle({ request }), /injected observation failure/);
  assert.equal(cleanupCalls, 1);
});

test("best-effort sign-out survives a cookie-attribute observation failure", async () => {
  const endpoint = mockAccountEndpoint();
  let cleanupCalls = 0;
  const request = async (input) => {
    if (input.method === "DELETE" && input.originHeader === liveAccountEvidencePolicy.origin) cleanupCalls += 1;
    const response = await endpoint(input);
    if (input.path === "/api/auth/verify" && response.status === 200) {
      return { ...response, setCookie: response.setCookie.replace("; HttpOnly", "") };
    }
    return response;
  };

  await assert.rejects(() => runLiveAccountLifecycle({ request }), /attributes are not hardened/);
  assert.equal(cleanupCalls, 1);
});

test("session replacement is one transactional D1 batch and the live runner is fixed to owner-only Sites", async () => {
  const server = await readFile(new URL("../lib/siwe-server.ts", import.meta.url), "utf8");
  const runner = await readFile(new URL("../scripts/run-live-account-evidence.mjs", import.meta.url), "utf8");
  assert.match(server, /await db\.batch\(\[/);
  assert.ok(server.indexOf("db.delete(authSessions)") < server.indexOf("db.insert(authSessions)"));
  assert.match(runner, /liveAccountEvidencePolicy\.origin/);
  assert.doesNotMatch(runner, /TREESWAP_ACCOUNT_(?:ORIGIN|URL|EMAIL|WALLET|PRIVATE_KEY)/);
  assert.match(runner, /delete process\.env\.TREESWAP_ACCOUNT_BYPASS_TOKEN/);
  assert.match(runner, /ls-remote.*refs\/heads\/main/);
  assert.match(runner, /mode: 0o600/);
  assert.match(runner, /flag: "wx"/);
});
