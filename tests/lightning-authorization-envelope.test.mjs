import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { id } from "ethers";
import {
  serializeLightningAuthorizationPayload,
  signLightningAuthorizationEnvelope,
  verifyLightningAuthorizationEnvelope,
} from "../lib/lightning-authorization-envelope.mjs";

const NOW = 2_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function payload(overrides = {}) {
  return {
    schema: "treeswap.lightning-authorization.v1",
    keyId: "coordinator-regtest-1",
    method: "/routerrpc.Router/SendPaymentV2",
    requestId: id("authorization-request").toLowerCase(),
    intentDigest: id("authorization-intent").toLowerCase(),
    paymentHash: id("authorization-payment").toLowerCase(),
    invoiceDigest: id("authorization-invoice").toLowerCase(),
    amountSats: "10000",
    capacityEpoch: 7,
    authorizedAt: NOW,
    expiresAt: NOW + 15,
    operation: { timeoutSeconds: 10, feeLimitSats: "10", paymentRequest: "lnbcrt..." },
    ...overrides,
  };
}

test("verifies one exact short-lived coordinator authorization", () => {
  const envelope = signLightningAuthorizationEnvelope(payload(), privateKey);
  const verified = verifyLightningAuthorizationEnvelope({
    envelope,
    publicKey,
    expectedKeyId: "coordinator-regtest-1",
    now: NOW + 1,
    maxLifetimeSeconds: 30,
  });
  assert.equal(verified.paymentHash, payload().paymentHash);
});

test("canonical serialization is independent of object insertion order", () => {
  const first = payload({ operation: { paymentRequest: "lnbcrt...", feeLimitSats: "10", timeoutSeconds: 10 } });
  const second = payload({ operation: { timeoutSeconds: 10, feeLimitSats: "10", paymentRequest: "lnbcrt..." } });
  assert.equal(serializeLightningAuthorizationPayload(first), serializeLightningAuthorizationPayload(second));
});

test("rejects mutation, expiry, excessive lifetime, and an inactive key", () => {
  const envelope = signLightningAuthorizationEnvelope(payload(), privateKey);
  const cases = [
    { envelope: { ...envelope, payload: { ...envelope.payload, amountSats: "10001" } }, now: NOW + 1, key: "coordinator-regtest-1", lifetime: 30 },
    { envelope, now: NOW + 15, key: "coordinator-regtest-1", lifetime: 30 },
    { envelope, now: NOW + 1, key: "coordinator-regtest-1", lifetime: 14 },
    { envelope, now: NOW + 1, key: "retired-key", lifetime: 30 },
  ];
  for (const entry of cases) {
    assert.throws(() => verifyLightningAuthorizationEnvelope({
      envelope: entry.envelope,
      publicKey,
      expectedKeyId: entry.key,
      now: entry.now,
      maxLifetimeSeconds: entry.lifetime,
    }));
  }
});

test("rejects ambiguous integer and digest encodings before signature verification", () => {
  for (const changed of [
    payload({ amountSats: "010000" }),
    payload({ amountSats: 10_000 }),
    payload({ paymentHash: payload().paymentHash.toUpperCase() }),
    payload({ authorizedAt: 1.5 }),
  ]) {
    assert.throws(() => signLightningAuthorizationEnvelope(changed, privateKey));
  }
  assert.throws(() => signLightningAuthorizationEnvelope({ ...payload(), extra: true }, privateKey), /fields are not exact/);
});
