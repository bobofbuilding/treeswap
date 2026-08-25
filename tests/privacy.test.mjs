import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import {
  PRIVACY_RETENTION_SECONDS,
  assertPublicPricingRequest,
  buildBlindPricingRequest,
  privacySafeAudit,
  retentionDeadline,
  unlinkablePricingId,
} from "../lib/privacy.mjs";

const NOW = 2_000_000_000;
const request = {
  pricingId: unlinkablePricingId(id("random pricing nonce")),
  requestId: id("private settlement"),
  direction: "bit-to-lightning",
  chainId: 1,
  exactBitOutputWei: 0n,
  exactLightningOutputSats: 25_000n,
  maxFeeBps: 100n,
  maxRoutingFeeSats: 20n,
  capacityEpoch: 9,
  expiresAt: NOW + 90,
  user: "0x2222222222222222222222222222222222222222",
  beneficiary: "0x3333333333333333333333333333333333333333",
  paymentHash: id("payment"),
  invoiceDigest: id("invoice"),
};

test("publishes only the minimum unlinkable fields required to price an exact swap", () => {
  const publicRequest = buildBlindPricingRequest(request);
  assert.deepEqual(Object.keys(publicRequest), [
    "pricingId", "direction", "chainId", "exactOutput", "outputUnit", "maxFeeBps",
    "maxRoutingFeeSats", "capacityEpoch", "expiresAt",
  ]);
  const encoded = JSON.stringify(publicRequest);
  for (const secret of [request.requestId, request.user, request.beneficiary, request.paymentHash, request.invoiceDigest]) {
    assert.doesNotMatch(encoded.toLowerCase(), new RegExp(secret.slice(2).toLowerCase()));
  }
});

test("rejects every field outside the exact public pricing allowlist", () => {
  const publicRequest = buildBlindPricingRequest(request);
  for (const key of ["requestId", "PAYMENT_HASH", "payment-hash", "ｉｎｖｏｉｃｅＤｉｇｅｓｔ"]) {
    assert.throws(() => assertPublicPricingRequest({ ...publicRequest, [key]: "secret" }), /fields are not exact/);
  }
  assert.throws(() => buildBlindPricingRequest({ ...request, pricingId: request.requestId }), /must be unlinkable/);
});

test("validates only exact primitive public fields without invoking accessors or nested objects", () => {
  const publicRequest = buildBlindPricingRequest(request);
  let getterReads = 0;
  const accessor = { ...publicRequest };
  Object.defineProperty(accessor, "exactOutput", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return "25000";
    },
  });
  assert.throws(() => assertPublicPricingRequest(accessor), /enumerable data properties/);
  assert.equal(getterReads, 0);

  const nested = { ...publicRequest };
  nested.exactOutput = nested;
  assert.throws(() => assertPublicPricingRequest(nested), /positive decimal string/);

  const prototypeField = { ...publicRequest };
  Object.defineProperty(prototypeField, "__proto__", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { invoice: request.invoice },
  });
  assert.throws(() => assertPublicPricingRequest(prototypeField), /fields are not exact/);
  assert.equal(Object.prototype.invoice, undefined);

  assert.throws(() => assertPublicPricingRequest({
    ...publicRequest,
    outputUnit: "bit-wei",
  }), /outputUnit does not match direction/);
  assert.throws(() => assertPublicPricingRequest({
    ...publicRequest,
    pricingId: publicRequest.pricingId.toUpperCase().replace("0X", "0x"),
  }), /canonical lowercase bytes32/);
  assert.throws(() => assertPublicPricingRequest({
    ...publicRequest,
    maxFeeBps: "01",
  }), /canonical unsigned decimal strings/);
  assert.throws(() => assertPublicPricingRequest({
    ...publicRequest,
    chainId: "1",
  }), /integer fields are invalid/);
});

test("redacts cross-network identifiers and supplies deletion deadlines", () => {
  assert.deepEqual(privacySafeAudit("settled", {
    requestId: request.requestId,
    paymentHash: request.paymentHash,
    invoice: "lnbc...",
    beneficiary: request.beneficiary,
    amountSats: 25_000n,
  }), {
    event: "settled",
    requestId: request.requestId,
    paymentHash: "[redacted]",
    invoice: "[redacted]",
    beneficiary: "[redacted]",
    amountSats: "25000",
  });
  assert.equal(retentionDeadline({ kind: "publicPricing", createdAt: NOW }), NOW + PRIVACY_RETENTION_SECONDS.publicPricing);
  assert.equal(
    retentionDeadline({ kind: "privateSettlement", createdAt: NOW, terminalAt: NOW + 100 }),
    NOW + 100 + PRIVACY_RETENTION_SECONDS.privateSettlementAfterTerminal,
  );
});

test("keeps the trusted privacy event immutable without invoking record accessors", () => {
  let getterReads = 0;
  const record = { event: "forged", amountSats: 25_000n };
  Object.defineProperty(record, "__proto__", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: "retained as data",
  });
  Object.defineProperty(record, "hostile", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return request.invoice;
    },
  });

  const audit = privacySafeAudit("settled", record);
  assert.equal(audit.event, "settled");
  assert.equal(audit.amountSats, "25000");
  assert.equal(Object.hasOwn(audit, "__proto__"), true);
  assert.equal(audit.__proto__, "retained as data");
  assert.equal(getterReads, 0);
  assert.equal(Object.getPrototypeOf(audit), Object.prototype);
});

test("redacts normalized sensitive-key variants in privacy-safe audit records", () => {
  const audit = privacySafeAudit("settled", {
    PAYMENT_HASH: request.paymentHash,
    "invoice-digest": request.invoiceDigest,
    ｂｅｎｅｆｉｃｉａｒｙ: request.beneficiary,
  });
  assert.deepEqual(audit, {
    event: "settled",
    PAYMENT_HASH: "[redacted]",
    "invoice-digest": "[redacted]",
    ｂｅｎｅｆｉｃｉａｒｙ: "[redacted]",
  });
});

test("does not coerce an object-shaped privacy audit event", () => {
  let coercions = 0;
  const hostile = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return "forged";
    },
  };
  assert.deepEqual(privacySafeAudit(hostile, { amountSats: 25_000n }), {
    event: "unknown",
    amountSats: "25000",
  });
  assert.equal(coercions, 0);
});
