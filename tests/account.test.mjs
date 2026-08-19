import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import {
  buildSiweMessage,
  isValidNotificationEmail,
  normalizeNotificationEmail,
} from "../lib/account.mjs";

test("creates a domain-bound mainnet SIWE message that verifies", async () => {
  const wallet = Wallet.createRandom();
  const message = buildSiweMessage({
    domain: "treeswap.example",
    address: wallet.address,
    uri: "https://treeswap.example",
    nonce: "0123456789abcdef0123456789abcdef",
    issuedAt: "2026-08-19T08:00:00.000Z",
    expiresAt: "2026-08-19T08:10:00.000Z",
  });
  const signature = await wallet.signMessage(message);
  const parsed = new SiweMessage(message);
  const result = await parsed.verify({
    signature,
    domain: "treeswap.example",
    nonce: "0123456789abcdef0123456789abcdef",
    time: "2026-08-19T08:05:00.000Z",
  });

  assert.equal(result.success, true);
  assert.equal(parsed.address, wallet.address);
  assert.equal(parsed.chainId, 1);
  assert.doesNotMatch(message, /email|invoice notice|transaction receipt/i);
});

test("rejects a SIWE URI from a different domain", () => {
  assert.throws(
    () =>
      buildSiweMessage({
        domain: "treeswap.example",
        address: "0x1111111111111111111111111111111111111111",
        uri: "https://attacker.example",
        nonce: "0123456789abcdef",
        issuedAt: "2026-08-19T08:00:00.000Z",
        expiresAt: "2026-08-19T08:10:00.000Z",
      }),
    /domain mismatch/i,
  );
});

test("normalizes and bounds optional notification email", () => {
  assert.equal(normalizeNotificationEmail("  Alice@Example.com "), "alice@example.com");
  assert.equal(isValidNotificationEmail("alice@example.com"), true);
  assert.equal(isValidNotificationEmail("not-an-email"), false);
  assert.equal(isValidNotificationEmail(`${"a".repeat(245)}@example.com`), false);
});
