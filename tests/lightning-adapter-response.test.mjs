import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { id } from "ethers";
import {
  LIGHTNING_ADAPTER_RESPONSE_SCHEMA,
  signLightningAdapterResponseEnvelope,
  verifyLightningAdapterResponseEnvelope,
} from "../lib/lightning-adapter-response.mjs";

const keys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");

function hash(label) {
  return id(label).toLowerCase();
}

function body() {
  return {
    result: {
      status: "SUCCEEDED",
      paymentHash: hash("response-payment"),
      amountSats: "10000",
      feeSats: "2",
      preimage: hash("response-preimage"),
    },
    audit: {
      observedAt: 2_000_000_000,
      decision: "allowed",
      role: "payer",
      method: "/routerrpc.Router/SendPaymentV2",
      credentialIdHash: hash("response-credential"),
      requestId: hash("response-request"),
      intentDigest: hash("response-intent"),
      paymentHash: hash("response-payment"),
      invoiceDigest: hash("response-invoice"),
      amountSats: "10000",
      capacityEpoch: 4,
      reasons: [],
    },
  };
}

function signed(value = body(), privateKey = keys.privateKey) {
  return signLightningAdapterResponseEnvelope({
    body: value,
    keyId: "payer-response-1",
    privateKey,
  });
}

test("authenticates one exact secret-free adapter response under a dedicated key", () => {
  const envelope = signed();
  assert.equal(envelope.payload.schema, LIGHTNING_ADAPTER_RESPONSE_SCHEMA);
  const verified = verifyLightningAdapterResponseEnvelope({
    envelope,
    publicKey: keys.publicKey,
    expectedKeyId: "payer-response-1",
  });
  assert.deepEqual(verified.body, body());
  assert.match(verified.publicKeyDigest, /^0x[0-9a-f]{64}$/);
  assert.match(verified.responseDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(verified.body), true);
  assert.equal(JSON.stringify(envelope).includes("privateKey"), false);

  const sameResponseFromAnotherKey = verifyLightningAdapterResponseEnvelope({
    envelope: signed(body(), otherKeys.privateKey),
    publicKey: otherKeys.publicKey,
    expectedKeyId: "payer-response-1",
  });
  assert.equal(sameResponseFromAnotherKey.responseDigest, verified.responseDigest);
  assert.notEqual(sameResponseFromAnotherKey.publicKeyDigest, verified.publicKeyDigest);
});

test("rejects mutation, wrong key, wrong key identifier, and unsigned bodies", () => {
  const envelope = signed();
  const attempts = [
    { ...envelope, payload: { ...envelope.payload, body: { ...envelope.payload.body, extra: true } } },
    { ...envelope, payload: { ...envelope.payload, keyId: "payer-response-2" } },
    { ...envelope, payload: { ...envelope.payload, schema: "treeswap.lightning-adapter-response.v0" } },
  ];
  for (const candidate of attempts) {
    assert.throws(() => verifyLightningAdapterResponseEnvelope({
      envelope: candidate,
      publicKey: keys.publicKey,
      expectedKeyId: "payer-response-1",
    }));
  }
  assert.throws(() => verifyLightningAdapterResponseEnvelope({
    envelope,
    publicKey: otherKeys.publicKey,
    expectedKeyId: "payer-response-1",
  }), /signature is invalid/);
  assert.throws(() => verifyLightningAdapterResponseEnvelope({
    envelope,
    publicKey: keys.publicKey,
    expectedKeyId: "payer-response-2",
  }), /not active/);
  assert.throws(() => verifyLightningAdapterResponseEnvelope({
    envelope: body(),
    publicKey: keys.publicKey,
    expectedKeyId: "payer-response-1",
  }), /fields are not exact/);
});

test("snapshots exact bounded response data without invoking accessors", () => {
  let accessed = false;
  const hostile = body();
  Object.defineProperty(hostile, "result", {
    enumerable: true,
    get() {
      accessed = true;
      return {};
    },
  });
  assert.throws(() => signed(hostile), /enumerable data property/);
  assert.equal(accessed, false);
  assert.throws(() => signed({ ...body(), oversized: "x".repeat(8_193) }), /too long/);
  assert.throws(() => signed({ ...body(), sparse: Array(2) }), /array fields are not exact/);
});

test("does not accept a response signed by another adapter identity", () => {
  const envelope = signed(body(), otherKeys.privateKey);
  assert.throws(() => verifyLightningAdapterResponseEnvelope({
    envelope,
    publicKey: keys.publicKey,
    expectedKeyId: "payer-response-1",
  }), /signature is invalid/);
});
