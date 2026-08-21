import { Wallet } from "ethers";
import { buildSiweMessage } from "./account.mjs";
import { extractSessionCookie, inspectSessionCookie } from "./live-account-lifecycle.mjs";
import { liveAccountMaintenanceEvidencePolicy } from "./live-account-maintenance-evidence.mjs";

const ATTACKER_ORIGIN = "https://attacker.invalid";
const ACCOUNT_SCHEMA = "treeswap.account-capability.v1";

function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} response is malformed`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} response fields changed`);
  }
  return value;
}

function requireStatus(response, expected, phase) {
  if (response?.status !== expected) throw new Error(`${phase} returned an unexpected status`);
  return response;
}

function requireCapability(value) {
  exactKeys(value, ["durableStorage", "emailDeliveryEnabled", "enabled", "schema"], "account capability");
  if (
    value.schema !== ACCOUNT_SCHEMA
    || value.enabled !== true
    || value.durableStorage !== true
    || value.emailDeliveryEnabled !== false
  ) {
    throw new Error("the deployed account capability is not safely enabled");
  }
}

function requireSession(value, walletAddress, observedAt = Date.now()) {
  exactKeys(value, ["chainId", "expiresAt", "notifications", "walletAddress"], "session");
  if (
    value.walletAddress !== walletAddress.toLowerCase()
    || value.chainId !== 1
    || value.notifications !== null
    || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= observedAt
  ) {
    throw new Error("the deployed session is not the expected mainnet wallet session");
  }
}

function challengeFrom(response, origin, observedAt = Date.now()) {
  requireStatus(response, 200, "nonce issuance");
  exactKeys(response.json, ["domain", "expiresAt", "nonce", "uri"], "nonce");
  const url = new URL(origin);
  if (
    !/^[0-9a-f]{32}$/.test(response.json.nonce)
    || response.json.domain !== url.host
    || response.json.uri !== origin
    || !Number.isFinite(Date.parse(response.json.expiresAt))
    || Date.parse(response.json.expiresAt) <= observedAt
    || Date.parse(response.json.expiresAt) > observedAt + 11 * 60 * 1_000
  ) {
    throw new Error("the deployed nonce challenge is outside policy");
  }
  return response.json;
}

function requireMaintenance(value) {
  exactKeys(value, ["batchLimit", "deleted", "moreWorkPossible", "observedAt", "schema", "status"], "maintenance");
  exactKeys(value.deleted, ["nonces", "notifications", "sessions"], "maintenance deletion counts");
  if (
    value.schema !== liveAccountMaintenanceEvidencePolicy.maintenanceSchema
    || value.status !== "completed"
    || value.batchLimit !== liveAccountMaintenanceEvidencePolicy.batchLimit
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt)
    || !Number.isFinite(Date.parse(value.observedAt))
    || new Date(Date.parse(value.observedAt)).toISOString() !== value.observedAt
    || typeof value.moreWorkPossible !== "boolean"
  ) {
    throw new Error("the deployed maintenance result is outside policy");
  }
  for (const count of Object.values(value.deleted)) {
    if (!Number.isInteger(count) || count < 0 || count > value.batchLimit) {
      throw new Error("the deployed maintenance deletion count is outside policy");
    }
  }
  if (value.moreWorkPossible !== Object.values(value.deleted).some((count) => count === value.batchLimit)) {
    throw new Error("the deployed maintenance continuation signal is inconsistent");
  }
  const serialized = JSON.stringify(value);
  if (/wallet|email|nonce(?:\"|:)|signature|message|cookie|token|bearer|private.?key/i.test(serialized)) {
    throw new Error("the deployed maintenance response contains account material");
  }
  return value;
}

async function readSession(request, cookie, observedAt) {
  const response = requireStatus(await request({ path: "/api/auth/session", cookie }), 200, "session lookup");
  exactKeys(response.json, ["account", "session"], "session lookup");
  requireCapability(response.json.account);
  if (response.json.session) requireSession(response.json.session, response.json.session.walletAddress, observedAt);
  return response.json.session;
}

async function waitUntilExpired(expiresAt, wait, now) {
  const deadline = Date.parse(expiresAt) + 2_000;
  if (!Number.isFinite(deadline)) throw new Error("nonce expiry is malformed");
  while (now() < deadline) {
    await wait(Math.min(30_000, deadline - now()));
  }
}

export async function runLiveAccountMaintenanceLifecycle({
  request,
  wallet = Wallet.createRandom(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
}) {
  if (typeof request !== "function" || typeof wait !== "function" || typeof now !== "function") {
    throw new TypeError("request, wait, and now must be functions");
  }
  const origin = liveAccountMaintenanceEvidencePolicy.origin;
  let sessionCookie = null;
  try {
    const anonymous = requireStatus(await request({ path: "/api/auth/session" }), 200, "capability lookup");
    exactKeys(anonymous.json, ["account", "session"], "capability lookup");
    requireCapability(anonymous.json.account);
    if (anonymous.json.session !== null) throw new Error("the evidence client unexpectedly inherited a session");

    const signInChallenge = challengeFrom(await request({ path: "/api/auth/nonce" }), origin, now());
    const message = buildSiweMessage({
      domain: signInChallenge.domain,
      address: wallet.address,
      uri: signInChallenge.uri,
      nonce: signInChallenge.nonce,
      issuedAt: new Date(now()).toISOString(),
      expiresAt: signInChallenge.expiresAt,
    });
    const signedIn = requireStatus(await request({
      path: "/api/auth/verify",
      method: "POST",
      originHeader: origin,
      body: { message, signature: await wallet.signMessage(message) },
    }), 200, "sign-in");
    exactKeys(signedIn.json, ["session"], "sign-in");
    requireSession(signedIn.json.session, wallet.address, now());
    sessionCookie = inspectSessionCookie(signedIn.setCookie);

    const expiringChallenge = challengeFrom(await request({ path: "/api/auth/nonce" }), origin, now());
    const crossOrigin = requireStatus(await request({
      path: "/api/internal/account-maintenance",
      method: "POST",
      originHeader: ATTACKER_ORIGIN,
      cookie: sessionCookie,
    }), 403, "cross-origin maintenance");
    if (crossOrigin.json?.error !== "Account maintenance origin rejected.") {
      throw new Error("cross-origin maintenance did not fail with the expected policy response");
    }
    requireSession(await readSession(request, sessionCookie, now()), wallet.address, now());

    await waitUntilExpired(expiringChallenge.expiresAt, wait, now);
    const maintenanceResponse = requireStatus(await request({
      path: "/api/internal/account-maintenance",
      method: "POST",
      originHeader: origin,
      cookie: sessionCookie,
    }), 200, "same-origin maintenance");
    const maintenance = requireMaintenance(maintenanceResponse.json);
    if (maintenance.deleted.nonces < 1) throw new Error("no expired nonce deletion was observed");
    requireSession(await readSession(request, sessionCookie, now()), wallet.address, now());

    const signout = requireStatus(await request({
      path: "/api/auth/session",
      method: "DELETE",
      originHeader: origin,
      cookie: sessionCookie,
    }), 200, "same-origin sign-out");
    exactKeys(signout.json, ["account", "session"], "same-origin sign-out");
    requireCapability(signout.json.account);
    if (signout.json.session !== null) throw new Error("sign-out returned an active session");

    const rejected = requireStatus(await request({
      path: "/api/internal/account-maintenance",
      method: "POST",
      originHeader: origin,
      cookie: sessionCookie,
    }), 401, "post-signout maintenance");
    if (rejected.json?.error !== "Sign in with Ethereum first.") {
      throw new Error("post-signout maintenance did not fail with the expected policy response");
    }
    sessionCookie = null;

    return Object.freeze(Object.fromEntries(liveAccountMaintenanceEvidencePolicy.checkKeys.map((key) => [key, true])));
  } finally {
    if (sessionCookie) {
      await request({
        path: "/api/auth/session",
        method: "DELETE",
        originHeader: origin,
        cookie: extractSessionCookie(sessionCookie),
      }).catch(() => {});
    }
  }
}
