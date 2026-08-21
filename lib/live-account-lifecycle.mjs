import { Wallet } from "ethers";
import { buildSiweMessage } from "./account.mjs";
import { liveAccountEvidencePolicy } from "./live-account-evidence.mjs";

const SESSION_COOKIE = "__Host-treeswap_session";
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

function requireSession(value, walletAddress) {
  exactKeys(value, ["chainId", "expiresAt", "notifications", "walletAddress"], "session");
  if (
    value.walletAddress !== walletAddress.toLowerCase()
    || value.chainId !== 1
    || value.notifications !== null
    || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= Date.now()
  ) {
    throw new Error("the deployed session is not the expected mainnet wallet session");
  }
}

export function inspectSessionCookie(setCookie) {
  const header = String(setCookie ?? "");
  const match = header.match(/(?:^|,?\s*)__Host-treeswap_session=([0-9a-f]{64})(?:;|$)/);
  if (!match) throw new Error("the session cookie is missing or malformed");
  const attributes = header.split(";").slice(1).map((attribute) => attribute.trim().toLowerCase());
  const attributeSet = new Set(attributes);
  if (
    !attributeSet.has("httponly")
    || !attributeSet.has("secure")
    || !attributeSet.has("samesite=strict")
    || !attributeSet.has("path=/")
    || !attributeSet.has("max-age=86400")
    || attributes.some((attribute) => attribute.startsWith("domain="))
  ) {
    throw new Error("the session cookie attributes are not hardened");
  }
  return `${SESSION_COOKIE}=${match[1]}`;
}

function challengeFrom(response, origin) {
  requireStatus(response, 200, "nonce issuance");
  exactKeys(response.json, ["domain", "expiresAt", "nonce", "uri"], "nonce");
  const url = new URL(origin);
  if (
    !/^[0-9a-f]{32}$/.test(response.json.nonce)
    || response.json.domain !== url.host
    || response.json.uri !== origin
    || !Number.isFinite(Date.parse(response.json.expiresAt))
    || Date.parse(response.json.expiresAt) <= Date.now()
    || Date.parse(response.json.expiresAt) > Date.now() + 11 * 60 * 1_000
  ) {
    throw new Error("the deployed nonce challenge is outside policy");
  }
  return response.json;
}

async function signedChallenge(request, wallet, origin) {
  const challenge = challengeFrom(await request({ path: "/api/auth/nonce" }), origin);
  const message = buildSiweMessage({
    domain: challenge.domain,
    address: wallet.address,
    uri: challenge.uri,
    nonce: challenge.nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: challenge.expiresAt,
  });
  return Object.freeze({ message, signature: await wallet.signMessage(message) });
}

async function verifySigned(request, signed, phase) {
  const response = requireStatus(await request({
    path: "/api/auth/verify",
    method: "POST",
    originHeader: liveAccountEvidencePolicy.origin,
    body: signed,
  }), 200, phase);
  exactKeys(response.json, ["session"], phase);
  return response;
}

async function readSession(request, cookie) {
  const response = requireStatus(await request({ path: "/api/auth/session", cookie }), 200, "session lookup");
  exactKeys(response.json, ["account", "session"], "session lookup");
  requireCapability(response.json.account);
  return response.json.session;
}

export async function runLiveAccountLifecycle({ request, wallet = Wallet.createRandom() }) {
  if (typeof request !== "function") throw new TypeError("request must be a function");
  const origin = liveAccountEvidencePolicy.origin;
  const cleanupCookies = new Set();
  try {
    const anonymous = requireStatus(await request({ path: "/api/auth/session" }), 200, "capability lookup");
    exactKeys(anonymous.json, ["account", "session"], "capability lookup");
    requireCapability(anonymous.json.account);
    if (anonymous.json.session !== null) throw new Error("the evidence client unexpectedly inherited a session");

    const initialSigned = await signedChallenge(request, wallet, origin);
    const initial = await verifySigned(request, initialSigned, "initial sign-in");
    requireSession(initial.json.session, wallet.address);
    const initialCookie = inspectSessionCookie(initial.setCookie);
    cleanupCookies.add(initialCookie);

    const replay = requireStatus(await request({
      path: "/api/auth/verify",
      method: "POST",
      originHeader: origin,
      body: initialSigned,
    }), 401, "nonce replay");
    if (replay.json?.error !== "This sign-in request expired or was already used.") {
      throw new Error("nonce replay did not fail with the expected policy response");
    }
    requireSession(await readSession(request, initialCookie), wallet.address);

    const replacementSigned = await signedChallenge(request, wallet, origin);
    const replacement = await verifySigned(request, replacementSigned, "session replacement");
    requireSession(replacement.json.session, wallet.address);
    const replacementCookie = inspectSessionCookie(replacement.setCookie);
    cleanupCookies.add(replacementCookie);
    if (await readSession(request, initialCookie) !== null) throw new Error("the prior wallet session remained valid");
    requireSession(await readSession(request, replacementCookie), wallet.address);

    const concurrentSigned = await Promise.all([
      signedChallenge(request, wallet, origin),
      signedChallenge(request, wallet, origin),
    ]);
    const concurrentResponses = await Promise.all(concurrentSigned.map((signed, index) =>
      verifySigned(request, signed, `concurrent sign-in ${index + 1}`)));
    for (const response of concurrentResponses) requireSession(response.json.session, wallet.address);
    const concurrentCookies = concurrentResponses.map((response) => inspectSessionCookie(response.setCookie));
    for (const cookie of concurrentCookies) cleanupCookies.add(cookie);
    const concurrentSessions = await Promise.all(concurrentCookies.map((cookie) => readSession(request, cookie)));
    const activeIndexes = concurrentSessions
      .map((session, index) => session === null ? -1 : index)
      .filter((index) => index >= 0);
    if (activeIndexes.length !== 1) throw new Error("concurrent wallet sessions did not serialize to one active session");
    const activeCookie = concurrentCookies[activeIndexes[0]];
    requireSession(concurrentSessions[activeIndexes[0]], wallet.address);

    const crossOrigin = requireStatus(await request({
      path: "/api/auth/session",
      method: "DELETE",
      originHeader: ATTACKER_ORIGIN,
      cookie: activeCookie,
    }), 403, "cross-origin sign-out");
    if (crossOrigin.json?.error !== "Cross-origin sign-out rejected.") {
      throw new Error("cross-origin sign-out did not fail with the expected policy response");
    }
    requireSession(await readSession(request, activeCookie), wallet.address);

    const signout = requireStatus(await request({
      path: "/api/auth/session",
      method: "DELETE",
      originHeader: origin,
      cookie: activeCookie,
    }), 200, "same-origin sign-out");
    exactKeys(signout.json, ["account", "session"], "same-origin sign-out");
    requireCapability(signout.json.account);
    if (signout.json.session !== null || await readSession(request, activeCookie) !== null) {
      throw new Error("server-side sign-out did not invalidate the active session");
    }
    cleanupCookies.clear();

    return Object.freeze(Object.fromEntries(liveAccountEvidencePolicy.checkKeys.map((key) => [key, true])));
  } finally {
    for (const cookie of cleanupCookies) {
      await request({
        path: "/api/auth/session",
        method: "DELETE",
        originHeader: origin,
        cookie,
      }).catch(() => {});
    }
  }
}
