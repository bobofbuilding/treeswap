import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { id } from "ethers";
import {
  lightningAuthorizationEnvelopeDigest,
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

test("derives one exact authorization-envelope digest for response binding", () => {
  const envelope = signLightningAuthorizationEnvelope(payload(), privateKey);
  const digest = lightningAuthorizationEnvelopeDigest(envelope);
  assert.match(digest, /^0x[0-9a-f]{64}$/);
  assert.equal(lightningAuthorizationEnvelopeDigest({
    signature: envelope.signature,
    payload: {
      operation: { paymentRequest: "lnbcrt...", timeoutSeconds: 10, feeLimitSats: "10" },
      expiresAt: NOW + 15,
      authorizedAt: NOW,
      capacityEpoch: 7,
      amountSats: "10000",
      invoiceDigest: payload().invoiceDigest,
      paymentHash: payload().paymentHash,
      intentDigest: payload().intentDigest,
      requestId: payload().requestId,
      method: "/routerrpc.Router/SendPaymentV2",
      keyId: "coordinator-regtest-1",
      schema: "treeswap.lightning-authorization.v1",
    },
  }), digest);
  assert.notEqual(
    lightningAuthorizationEnvelopeDigest(signLightningAuthorizationEnvelope(
      payload({ requestId: id("other-authorization-request").toLowerCase() }),
      privateKey,
    )),
    digest,
  );
  assert.throws(() => lightningAuthorizationEnvelopeDigest({ ...envelope, extra: true }), /fields are not exact/);
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

test("snapshots only exact authorization data without getters or coercion", () => {
  const operation = { timeoutSeconds: 10, feeLimitSats: "10", paymentRequest: "lnbcrt..." };
  const input = payload({ operation });
  const envelope = signLightningAuthorizationEnvelope(input, privateKey);
  operation.timeoutSeconds = 30;
  input.keyId = "changed-key";
  assert.equal(envelope.payload.keyId, "coordinator-regtest-1");
  assert.equal(envelope.payload.operation.timeoutSeconds, 10);
  assert.equal(Object.isFrozen(envelope.payload), true);
  assert.equal(Object.isFrozen(envelope.payload.operation), true);

  let payloadGetterCalls = 0;
  const payloadAccessor = payload();
  Object.defineProperty(payloadAccessor, "operation", {
    enumerable: true,
    get() {
      payloadGetterCalls += 1;
      return operation;
    },
  });
  assert.throws(
    () => signLightningAuthorizationEnvelope(payloadAccessor, privateKey),
    /enumerable data properties/,
  );
  assert.equal(payloadGetterCalls, 0);

  let operationGetterCalls = 0;
  const operationAccessor = { timeoutSeconds: 10, feeLimitSats: "10" };
  Object.defineProperty(operationAccessor, "paymentRequest", {
    enumerable: true,
    get() {
      operationGetterCalls += 1;
      return "lnbcrt...";
    },
  });
  assert.throws(
    () => signLightningAuthorizationEnvelope(payload({ operation: operationAccessor }), privateKey),
    /enumerable data properties/,
  );
  assert.equal(operationGetterCalls, 0);

  let coercionCalls = 0;
  const coercible = {
    toString() {
      coercionCalls += 1;
      return "10";
    },
    valueOf() {
      coercionCalls += 1;
      return 10;
    },
  };
  assert.throws(
    () => signLightningAuthorizationEnvelope(payload({ method: coercible }), privateKey),
    /method is invalid/,
  );
  assert.throws(
    () => signLightningAuthorizationEnvelope(payload({
      operation: { ...operation, feeLimitSats: coercible },
    }), privateKey),
    /unsupported value/,
  );
  assert.equal(coercionCalls, 0);

  const symbolPayload = payload();
  symbolPayload[Symbol("authority")] = true;
  assert.throws(() => signLightningAuthorizationEnvelope(symbolPayload, privateKey), /exact data properties/);
  const hiddenPayload = payload();
  Object.defineProperty(hiddenPayload, "hidden", { enumerable: false, value: true });
  assert.throws(() => signLightningAuthorizationEnvelope(hiddenPayload, privateKey), /fields are not exact/);
  assert.throws(
    () => signLightningAuthorizationEnvelope(
      Object.assign(Object.create({ inherited: true }), payload()),
      privateKey,
    ),
    /plain data object/,
  );
  const prototypePayload = payload();
  Object.defineProperty(prototypePayload, "__proto__", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { method: "/attacker" },
  });
  assert.throws(() => signLightningAuthorizationEnvelope(prototypePayload, privateKey), /fields are not exact/);

  const symbolOperation = { ...operation, [Symbol("authority")]: true };
  assert.throws(
    () => signLightningAuthorizationEnvelope(payload({ operation: symbolOperation }), privateKey),
    /exact data properties/,
  );
  const hiddenOperation = { ...operation };
  Object.defineProperty(hiddenOperation, "hidden", { enumerable: false, value: true });
  assert.throws(
    () => signLightningAuthorizationEnvelope(payload({ operation: hiddenOperation }), privateKey),
    /fields are not exact/,
  );
  assert.throws(
    () => signLightningAuthorizationEnvelope(payload({
      operation: Object.assign(Object.create({ inherited: true }), operation),
    }), privateKey),
    /plain data object/,
  );
  assert.throws(
    () => signLightningAuthorizationEnvelope(payload({ method: "/unsupported", operation: {} }), privateKey),
    /method is unsupported/,
  );
  assert.equal(Object.prototype.authority, undefined);
});

test("verifier snapshots exact call and envelope records without invoking accessors", () => {
  const envelope = signLightningAuthorizationEnvelope(payload(), privateKey);
  const verification = {
    envelope,
    publicKey,
    expectedKeyId: "coordinator-regtest-1",
    now: NOW + 1,
    maxLifetimeSeconds: 30,
  };
  let callGetterCalls = 0;
  const callAccessor = { ...verification };
  Object.defineProperty(callAccessor, "envelope", {
    enumerable: true,
    get() {
      callGetterCalls += 1;
      return envelope;
    },
  });
  assert.throws(() => verifyLightningAuthorizationEnvelope(callAccessor), /enumerable data properties/);
  assert.equal(callGetterCalls, 0);

  let envelopeGetterCalls = 0;
  const envelopeAccessor = { signature: envelope.signature };
  Object.defineProperty(envelopeAccessor, "payload", {
    enumerable: true,
    get() {
      envelopeGetterCalls += 1;
      return envelope.payload;
    },
  });
  assert.throws(
    () => verifyLightningAuthorizationEnvelope({ ...verification, envelope: envelopeAccessor }),
    /enumerable data properties/,
  );
  assert.equal(envelopeGetterCalls, 0);

  const hiddenEnvelope = { ...envelope };
  Object.defineProperty(hiddenEnvelope, "hidden", { enumerable: false, value: true });
  assert.throws(
    () => verifyLightningAuthorizationEnvelope({ ...verification, envelope: hiddenEnvelope }),
    /fields are not exact/,
  );
  const symbolCall = { ...verification, [Symbol("authority")]: true };
  assert.throws(() => verifyLightningAuthorizationEnvelope(symbolCall), /exact data properties/);
});
