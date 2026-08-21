import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildLiveAccountMaintenanceEvidence,
  liveAccountMaintenanceEvidencePolicy,
} from "../lib/live-account-maintenance-evidence.mjs";
import { runLiveAccountMaintenanceLifecycle } from "../lib/live-account-maintenance-lifecycle.mjs";

const SOURCE = { branch: "main", commit: "a".repeat(40), clean: true, published: true };
const DEPLOYMENT = {
  origin: liveAccountMaintenanceEvidencePolicy.origin,
  platform: "OpenAI Sites",
  access: "owner-only",
  version: "12",
};
const CHECKS = Object.fromEntries(liveAccountMaintenanceEvidencePolicy.checkKeys.map((key) => [key, true]));

function evidence(overrides = {}) {
  return buildLiveAccountMaintenanceEvidence({
    source: SOURCE,
    deployment: DEPLOYMENT,
    startedAt: "2026-08-21T20:00:00.000Z",
    finishedAt: "2026-08-21T20:10:03.000Z",
    checks: CHECKS,
    ...overrides,
  });
}

function mockEndpoint() {
  const account = { schema: "treeswap.account-capability.v1", enabled: true, durableStorage: true, emailDeliveryEnabled: false };
  let nonceSequence = 0;
  let activeCookie = null;
  let activeSession = null;
  let expiredNonceReady = false;
  let signoutCalls = 0;
  let observedNow = Date.now();
  return {
    get signoutCalls() { return signoutCalls; },
    now() { return observedNow; },
    async request({ path, method = "GET", originHeader, cookie, body }) {
      if (path === "/api/auth/nonce" && method === "GET") {
        nonceSequence += 1;
        return {
          status: 200,
          json: {
            nonce: nonceSequence.toString(16).padStart(32, "0"),
            domain: "treeswap-lightning-bit.bobofbuilding.chatgpt.site",
            uri: liveAccountMaintenanceEvidencePolicy.origin,
            expiresAt: new Date(observedNow + 10 * 60 * 1_000).toISOString(),
          },
          setCookie: null,
        };
      }
      if (path === "/api/auth/verify" && method === "POST") {
        const walletAddress = body.message.match(/account:\n(0x[0-9a-fA-F]{40})\n/)?.[1].toLowerCase();
        const token = "c".repeat(64);
        activeCookie = `__Host-treeswap_session=${token}`;
        activeSession = {
          walletAddress,
          chainId: 1,
          expiresAt: new Date(observedNow + 24 * 60 * 60 * 1_000).toISOString(),
          notifications: null,
        };
        return {
          status: 200,
          json: { session: activeSession },
          setCookie: `${activeCookie}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`,
        };
      }
      if (path === "/api/auth/session" && method === "GET") {
        return { status: 200, json: { account, session: cookie === activeCookie ? activeSession : null }, setCookie: null };
      }
      if (path === "/api/auth/session" && method === "DELETE") {
        signoutCalls += 1;
        if (originHeader === liveAccountMaintenanceEvidencePolicy.origin && cookie === activeCookie) {
          activeCookie = null;
          activeSession = null;
        }
        return { status: 200, json: { account, session: null }, setCookie: null };
      }
      if (path === "/api/internal/account-maintenance" && method === "POST") {
        if (originHeader !== liveAccountMaintenanceEvidencePolicy.origin) {
          return { status: 403, json: { error: "Account maintenance origin rejected." }, setCookie: null };
        }
        if (!cookie || cookie !== activeCookie) {
          return { status: 401, json: { error: "Sign in with Ethereum first." }, setCookie: null };
        }
        return {
          status: 200,
          json: {
            schema: "treeswap.account-maintenance.v1",
            status: "completed",
            observedAt: new Date(observedNow).toISOString(),
            batchLimit: 100,
            deleted: { nonces: expiredNonceReady ? 2 : 0, sessions: 0, notifications: 0 },
            moreWorkPossible: false,
          },
          setCookie: null,
        };
      }
      throw new Error("unexpected mock account request");
    },
    async wait(milliseconds) {
      observedNow += milliseconds;
      expiredNonceReady = true;
    },
  };
}

test("builds an exact secret-free maintenance record without funding authority", () => {
  const result = evidence();
  assert.equal(result.schema, "treeswap.live-account-maintenance-evidence.v1");
  assert.equal(result.status, "passed");
  assert.equal(result.policy.batchLimitPerTable, 100);
  assert.match(result.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(result.limitations.backgroundSchedulerIncluded, false);
  assert.equal(result.limitations.backupRestoreIncluded, false);
  assert.equal(result.limitations.fundingAuthorization, false);
  assert.doesNotMatch(JSON.stringify(result), /private.?key|signature|set-cookie|bearer|walletAddress|email@|\"nonce\":/i);
  assert.equal(evidence().evidenceDigest, result.evidenceDigest);
});

test("fails closed on missed checks, source drift, deployment substitution, extra data, or reversed time", () => {
  assert.throws(() => evidence({ checks: { ...CHECKS, expiredNonceDeletionObserved: false } }), /expiredNonceDeletionObserved/);
  assert.throws(() => evidence({ source: { ...SOURCE, clean: false } }), /clean published main/);
  assert.throws(() => evidence({ deployment: { ...DEPLOYMENT, origin: "https://attacker.invalid" } }), /owner-only/);
  assert.throws(() => evidence({ deployment: { ...DEPLOYMENT, credential: "secret" } }), /fields are not exact/);
  assert.throws(() => evidence({ finishedAt: "2026-08-21T19:59:59.999Z" }), /finished before/);
});

test("exercises origin, authorization, bounded response, expired deletion, and active-session survival", async () => {
  const endpoint = mockEndpoint();
  const checks = await runLiveAccountMaintenanceLifecycle({
    request: endpoint.request.bind(endpoint),
    wait: endpoint.wait.bind(endpoint),
    now: endpoint.now.bind(endpoint),
  });
  assert.deepEqual(checks, CHECKS);
  assert.equal(endpoint.signoutCalls, 1);
});

test("best-effort sign-out runs when maintenance evidence fails", async () => {
  const endpoint = mockEndpoint();
  const request = async (input) => {
    const response = await endpoint.request(input);
    if (input.path === "/api/internal/account-maintenance" && input.originHeader === liveAccountMaintenanceEvidencePolicy.origin && response.status === 200) {
      return { ...response, json: { ...response.json, deleted: { ...response.json.deleted, nonces: 0 } } };
    }
    return response;
  };
  await assert.rejects(() => runLiveAccountMaintenanceLifecycle({
    request,
    wait: endpoint.wait.bind(endpoint),
    now: endpoint.now.bind(endpoint),
  }), /no expired nonce/);
  assert.equal(endpoint.signoutCalls, 1);
});

test("live runner is fixed to owner-only Sites and writes a non-overwriting private record", async () => {
  const runner = await readFile(new URL("../scripts/run-live-account-maintenance-evidence.mjs", import.meta.url), "utf8");
  assert.match(runner, /liveAccountMaintenanceEvidencePolicy\.origin/);
  assert.doesNotMatch(runner, /TREESWAP_ACCOUNT_(?:ORIGIN|URL|EMAIL|WALLET|PRIVATE_KEY)/);
  assert.match(runner, /delete process\.env\.TREESWAP_ACCOUNT_BYPASS_TOKEN/);
  assert.match(runner, /ls-remote.*refs\/heads\/main/);
  assert.match(runner, /mode: 0o600/);
  assert.match(runner, /flag: "wx"/);
  assert.match(runner, /waiting-for-expired-nonce/);
});
