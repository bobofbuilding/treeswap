import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import { reserveValidatedPaymentHash, validateFullFillInvoice } from "../lib/invoice-policy.mjs";
import { invoiceDigest } from "../lib/lnd-rest-client.mjs";
import {
  bolt11BytesTag,
  createBolt11Invoice,
  testBolt11Payee,
} from "./bolt11-fixture.mjs";

const NOW = 2_000_000_000;
const PAYMENT_HASH = id("invoice-payment-hash").toLowerCase();
const SECRET = id("payment-secret").toLowerCase();
const DESTINATION = testBolt11Payee();
const INVOICE = createBolt11Invoice({
  amountSats: 50_000n,
  paymentHash: PAYMENT_HASH,
  paymentSecret: SECRET,
  timestamp: NOW - 30,
});
const request = Object.freeze({
  invoiceDigest: invoiceDigest(INVOICE),
  paymentHash: PAYMENT_HASH,
  amountSats: 50_000n,
  expectedPayee: DESTINATION,
  fillAmountSats: 50_000n,
  totalAmountSats: 50_000n,
  parentIntentId: null,
  childIndex: null,
});
const policy = Object.freeze({
  allowHashedDescriptions: false,
  maxInvoiceLength: 4_096,
  maxExpirySeconds: 86_400,
  minimumRemainingSeconds: 900,
  minimumFinalCltvDelta: 40,
  maximumFinalCltvDelta: 288,
  maxRouteHints: 20,
});
const registry = Object.freeze({
  reservedPaymentHashes: Object.freeze([]),
  consumedPaymentHashes: Object.freeze([]),
});

function validate(overrides = {}) {
  return validateFullFillInvoice({
    rawInvoice: INVOICE,
    request,
    registry,
    policy,
    now: NOW,
    ...overrides,
  });
}

function invoice(overrides = {}) {
  return createBolt11Invoice({
    amountSats: 50_000n,
    paymentHash: PAYMENT_HASH,
    paymentSecret: SECRET,
    timestamp: NOW - 30,
    ...overrides,
  });
}

test("independently decodes one exact full-fill mainnet invoice and reserves its unique hash", () => {
  const result = validate();
  assert.equal(result.valid, true);
  assert.equal(result.canonical.amountSats, 50_000n);
  assert.equal(result.canonical.invoiceDigest, invoiceDigest(INVOICE));
  assert.equal(result.canonical.destination, DESTINATION);
  assert.equal(result.canonical.multiPartPaymentAllowedOnlyForSingleFullInvoice, true);
  const next = reserveValidatedPaymentHash(registry, result);
  assert.deepEqual(next.reservedPaymentHashes, [PAYMENT_HASH]);
});

test("rejects partial fills and child intents", () => {
  const partial = validate({ request: { ...request, fillAmountSats: 25_000n } });
  assert.match(partial.reasons.join("; "), /partial fills/);
  const child = validate({
    request: { ...request, parentIntentId: id("parent").toLowerCase(), childIndex: 0 },
  });
  assert.match(child.reasons.join("; "), /child intents/);
});

test("rejects amountless policy substitutions, millisatoshi dust, and changed exact amounts", () => {
  const changed = invoice({ amountSats: 50_001n });
  assert.match(validate({ rawInvoice: changed }).reasons.join("; "), /digest changed|amount changed/);
  const dust = createBolt11Invoice({
    amountSats: 50_000n,
    humanReadablePart: "lnbc5000010p",
    paymentHash: PAYMENT_HASH,
    paymentSecret: SECRET,
    timestamp: NOW - 30,
  });
  assert.match(validate({ rawInvoice: dust }).reasons.join("; "), /whole satoshi/);
  assert.equal(validate({ rawInvoice: "lnbc1invalid" }).valid, false);
});

test("rejects substituted invoice, payment hash, payee, network, or signature", () => {
  const replacements = [
    `${INVOICE.slice(0, -1)}q`,
    invoice({ paymentHash: id("changed").toLowerCase() }),
    invoice({ privateKey: `0x${"22".repeat(32)}` }),
    invoice({ network: "testnet" }),
  ];
  for (const rawInvoice of replacements) assert.equal(validate({ rawInvoice }).valid, false);
});

test("rejects expired or unsafe-CLTV invoices from their signed fields", () => {
  const expired = invoice({ timestamp: NOW - 4_000 });
  assert.match(validate({ rawInvoice: expired }).reasons.join("; "), /safe time remaining/);
  const unsafeCltv = invoice({ minFinalCltvDelta: 39 });
  assert.match(validate({ rawInvoice: unsafeCltv }).reasons.join("; "), /CLTV/);
});

test("rejects unsupported description, feature, route, and secret policy from signed fields", () => {
  const hashedDescription = invoice({
    description: null,
    descriptionHash: id("external-description").toLowerCase(),
  });
  assert.match(validate({ rawInvoice: hashedDescription }).reasons.join("; "), /hashed invoice descriptions/);
  const unknownRequired = invoice({ featureBits: [2, 9, 15] });
  assert.match(validate({ rawInvoice: unknownRequired }).reasons.join("; "), /unknown required feature/);
  const zeroSecret = invoice({ paymentSecret: `0x${"00".repeat(32)}` });
  assert.match(validate({ rawInvoice: zeroSecret }).reasons.join("; "), /cannot be zero/);
  const route = Buffer.concat([Buffer.from(DESTINATION, "hex"), Buffer.alloc(18)]);
  const tooManyRoutes = invoice({
    extraTags: Array.from({ length: 21 }, () => bolt11BytesTag("r", route)),
  });
  assert.match(validate({ rawInvoice: tooManyRoutes }).reasons.join("; "), /too many route hints/);
});

test("rejects a hash reserved or consumed anywhere in the coordinator registry", () => {
  const reserved = validate({
    registry: { reservedPaymentHashes: [PAYMENT_HASH], consumedPaymentHashes: [] },
  });
  assert.match(reserved.reasons.join("; "), /already reserved/);
  const consumed = validate({
    registry: { reservedPaymentHashes: [], consumedPaymentHashes: [PAYMENT_HASH] },
  });
  assert.match(consumed.reasons.join("; "), /already consumed/);
});

test("does not execute accessors or coerce invoice-policy authority inputs", () => {
  let read = false;
  const accessor = { ...request };
  Object.defineProperty(accessor, "paymentHash", {
    enumerable: true,
    get() {
      read = true;
      throw new Error("payment hash getter executed");
    },
  });
  assert.throws(() => validate({ request: accessor }), /data properties/);
  assert.equal(read, false);
  assert.throws(() => validate({ request: { ...request, amountSats: { toString: () => "50000" } } }), /integer/);
  assert.throws(() => validate({ policy: { ...policy, extra: true } }), /fields are not exact/);
  assert.throws(() => validate({
    policy: { ...policy, allowHashedDescriptions: true },
  }), /cannot be enabled/);
  const decorated = [];
  decorated.extra = PAYMENT_HASH;
  assert.throws(() => validate({
    registry: { reservedPaymentHashes: decorated, consumedPaymentHashes: [] },
  }), /fields are not exact/);
});
