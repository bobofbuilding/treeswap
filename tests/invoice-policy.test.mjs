import assert from "node:assert/strict";
import test from "node:test";
import { id, keccak256, toUtf8Bytes } from "ethers";
import { reserveValidatedPaymentHash, validateFullFillInvoice } from "../lib/invoice-policy.mjs";

const NOW = 2_000_000_000;
const INVOICE = "lnbc500u1validsignedinvoiceplaceholder";
const PAYMENT_HASH = id("invoice-payment-hash");
const SECRET = id("payment-secret");
const DESTINATION = `02${"11".repeat(32)}`;
const request = {
  invoiceDigest: keccak256(toUtf8Bytes(INVOICE)),
  paymentHash: PAYMENT_HASH,
  amountSats: 50_000n,
  expectedPayee: DESTINATION,
  requiresHoldInvoice: false,
  fillAmountSats: 50_000n,
  totalAmountSats: 50_000n,
  parentIntentId: null,
  childIndex: null,
};
const decoded = {
  decodeSucceeded: true,
  signatureValid: true,
  network: "mainnet",
  amountMsat: 50_000_000n,
  paymentHash: PAYMENT_HASH,
  paymentSecret: SECRET,
  destination: DESTINATION,
  timestamp: NOW - 30,
  expirySeconds: 3_600,
  minFinalCltvDelta: 80,
  amp: false,
  keysend: false,
  bolt12: false,
  basicMpp: true,
  unknownRequiredFeatures: [],
  routeHintCount: 1,
  singletonTagCounts: { p: 1, s: 1, d: 1, h: 0, n: 1, x: 1, c: 1, 9: 1 },
  invoiceKind: "standard",
};
const policy = {
  maxInvoiceLength: 4_096,
  maxExpirySeconds: 86_400,
  minimumRemainingSeconds: 900,
  minimumFinalCltvDelta: 40,
  maximumFinalCltvDelta: 288,
  maxRouteHints: 20,
};
const registry = { reservedPaymentHashes: [], consumedPaymentHashes: [] };

function validate(overrides = {}) {
  return validateFullFillInvoice({ rawInvoice: INVOICE, decoded, request, registry, policy, now: NOW, ...overrides });
}

test("validates one exact full-fill mainnet invoice and reserves its unique hash", () => {
  const result = validate();
  assert.equal(result.valid, true);
  assert.equal(result.canonical.amountSats, 50_000n);
  assert.equal(result.canonical.multiPartPaymentAllowedOnlyForSingleFullInvoice, true);
  const next = reserveValidatedPaymentHash(registry, result);
  assert.deepEqual(next.reservedPaymentHashes, [PAYMENT_HASH.toLowerCase()]);
});

test("rejects partial fills, child intents, AMP, keysend, and BOLT 12", () => {
  for (const changed of [
    { request: { ...request, fillAmountSats: 25_000n } },
    { request: { ...request, parentIntentId: id("parent"), childIndex: 0 } },
    { decoded: { ...decoded, amp: true } },
    { decoded: { ...decoded, keysend: true } },
    { decoded: { ...decoded, bolt12: true } },
  ]) {
    assert.equal(validate(changed).valid, false);
  }
});

test("rejects amountless, millisatoshi dust, and changed exact amounts", () => {
  assert.match(validate({ decoded: { ...decoded, amountMsat: 0n } }).reasons.join("; "), /amountless/);
  assert.match(validate({ decoded: { ...decoded, amountMsat: 50_000_001n } }).reasons.join("; "), /whole satoshi/);
  assert.match(validate({ decoded: { ...decoded, amountMsat: 50_001_000n } }).reasons.join("; "), /amount changed/);
});

test("rejects substituted invoice, hash, payee, secret, network, or signature", () => {
  for (const changed of [
    { rawInvoice: `${INVOICE}changed` },
    { decoded: { ...decoded, paymentHash: id("changed") } },
    { decoded: { ...decoded, destination: `03${"22".repeat(32)}` } },
    { decoded: { ...decoded, paymentSecret: "0x" } },
    { decoded: { ...decoded, network: "testnet" } },
    { decoded: { ...decoded, signatureValid: false } },
  ]) {
    assert.equal(validate(changed).valid, false);
  }
});

test("rejects expired, unsafe-CLTV, duplicate-tag, or unknown-required-feature invoices", () => {
  for (const changedDecoded of [
    { ...decoded, timestamp: NOW - 4_000 },
    { ...decoded, minFinalCltvDelta: 39 },
    { ...decoded, singletonTagCounts: { ...decoded.singletonTagCounts, p: 2 } },
    { ...decoded, unknownRequiredFeatures: [100] },
  ]) {
    assert.equal(validate({ decoded: changedDecoded }).valid, false);
  }
});

test("requires the direction-specific hold or standard invoice kind", () => {
  assert.match(
    validate({ request: { ...request, requiresHoldInvoice: true } }).reasons.join("; "),
    /requires a hold invoice/,
  );
  assert.equal(
    validate({ request: { ...request, requiresHoldInvoice: true }, decoded: { ...decoded, invoiceKind: "hold" } }).valid,
    true,
  );
});

test("rejects a hash reserved or consumed anywhere in the coordinator registry", () => {
  const reserved = validate({ registry: { reservedPaymentHashes: [PAYMENT_HASH], consumedPaymentHashes: [] } });
  assert.match(reserved.reasons.join("; "), /already reserved/);
  const consumed = validate({ registry: { reservedPaymentHashes: [], consumedPaymentHashes: [PAYMENT_HASH] } });
  assert.match(consumed.reasons.join("; "), /already consumed/);
});
