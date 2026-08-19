import assert from "node:assert/strict";
import test from "node:test";
import { SiweMessage } from "siwe";
import { buildSiweMessage } from "../lib/account.mjs";
import {
  SIWE_STATEMENT,
  isActiveMainnetSession,
  isAllowedTreeSwapOrigin,
  isExactRequestOrigin,
  ownsNotificationRecord,
  validateSiweMessageFields,
} from "../lib/siwe-policy.mjs";

const CREATED = "2026-08-19T08:00:00.000Z";
const NOW = "2026-08-19T08:05:00.000Z";
const EXPIRES = "2026-08-19T08:10:00.000Z";
const NONCE = "0123456789abcdef0123456789abcdef";
const identity = { domain: "treeswap.vercel.app", origin: "https://treeswap.vercel.app" };
const nonceRecord = { nonce: NONCE, domain: identity.domain, uri: identity.origin, createdAt: CREATED, expiresAt: EXPIRES, consumedAt: null };

function parsed() {
  return new SiweMessage(buildSiweMessage({
    domain: identity.domain,
    uri: identity.origin,
    address: "0x1111111111111111111111111111111111111111",
    nonce: NONCE,
    issuedAt: CREATED,
    expiresAt: EXPIRES,
  }));
}

test("accepts only the two production origins and explicit local development", () => {
  assert.equal(isAllowedTreeSwapOrigin("https://treeswap.vercel.app"), true);
  assert.equal(isAllowedTreeSwapOrigin("https://treeswap-lightning-bit.bobofbuilding.chatgpt.site"), true);
  assert.equal(isAllowedTreeSwapOrigin("http://localhost:3000"), true);
  assert.equal(isAllowedTreeSwapOrigin("https://treeswap.vercel.app.attacker.example"), false);
  assert.equal(isAllowedTreeSwapOrigin("http://treeswap.vercel.app"), false);
});

test("accepts the exact short-lived EIP-4361 challenge", () => {
  assert.equal(parsed().statement, SIWE_STATEMENT);
  assert.deepEqual(validateSiweMessageFields({ message: parsed(), nonceRecord, identity, now: NOW }), { valid: true, reasons: [] });
});

test("rejects every mutable authentication field and nonce replay", () => {
  const mutations = [
    ["domain", "attacker.example", /domain changed/],
    ["uri", "https://attacker.example", /URI changed/],
    ["chainId", 10, /chain changed/],
    ["version", "2", /version changed/],
    ["nonce", "aaaaaaaaaaaaaaaa", /nonce changed/],
    ["statement", "Authorize payment", /statement changed/],
    ["expirationTime", "2026-08-19T08:09:00.000Z", /expiration changed/],
    ["requestId", "unexpected", /request identifier/],
    ["notBefore", "2026-08-19T08:06:00.000Z", /not-before/],
    ["resources", ["https://attacker.example/claim"], /resources/],
  ];
  for (const [field, value, reason] of mutations) {
    const message = parsed();
    message[field] = value;
    const result = validateSiweMessageFields({ message, nonceRecord, identity, now: NOW });
    assert.equal(result.valid, false, `${field} mutation passed`);
    assert.match(result.reasons.join("; "), reason);
  }
  const replay = validateSiweMessageFields({ message: parsed(), nonceRecord: { ...nonceRecord, consumedAt: NOW }, identity, now: NOW });
  assert.match(replay.reasons.join("; "), /already consumed/);
});

test("rejects stale, premature, future-issued, and overlong messages", () => {
  const expired = validateSiweMessageFields({ message: parsed(), nonceRecord, identity, now: EXPIRES });
  assert.match(expired.reasons.join("; "), /expired/);

  const early = parsed();
  early.issuedAt = "2026-08-19T07:59:59.000Z";
  assert.match(validateSiweMessageFields({ message: early, nonceRecord, identity, now: NOW }).reasons.join("; "), /before challenge/);

  const future = parsed();
  future.issuedAt = "2026-08-19T08:06:00.000Z";
  assert.match(validateSiweMessageFields({ message: future, nonceRecord, identity, now: NOW }).reasons.join("; "), /future/);

  const overlongRecord = { ...nonceRecord, expiresAt: "2026-08-19T08:20:00.000Z" };
  const overlong = parsed();
  overlong.expirationTime = overlongRecord.expiresAt;
  assert.match(validateSiweMessageFields({ message: overlong, nonceRecord: overlongRecord, identity, now: NOW }).reasons.join("; "), /too long/);
});

test("rejects cross-origin account mutations and expired sessions", () => {
  assert.equal(isExactRequestOrigin("https://treeswap.vercel.app/api/notifications", "https://treeswap.vercel.app"), true);
  assert.equal(isExactRequestOrigin("https://treeswap.vercel.app/api/notifications", "https://attacker.example"), false);
  assert.equal(isExactRequestOrigin("https://attacker.example/api/notifications", "https://attacker.example"), false);
  assert.equal(isExactRequestOrigin("https://treeswap.vercel.app.attacker.example/api", "https://treeswap.vercel.app.attacker.example"), false);

  const session = { walletAddress: "0x1111111111111111111111111111111111111111", chainId: 1, expiresAt: EXPIRES };
  assert.equal(isActiveMainnetSession(session, NOW), true);
  assert.equal(isActiveMainnetSession(session, EXPIRES), false);
  assert.equal(isActiveMainnetSession({ ...session, chainId: 10 }, NOW), false);
});

test("never exposes a notification record belonging to another wallet", () => {
  const session = { walletAddress: "0x1111111111111111111111111111111111111111" };
  assert.equal(ownsNotificationRecord(session, { walletAddress: session.walletAddress }), true);
  assert.equal(ownsNotificationRecord(session, { walletAddress: "0x2222222222222222222222222222222222222222" }), false);
  assert.equal(ownsNotificationRecord(null, { walletAddress: session.walletAddress }), false);
});
