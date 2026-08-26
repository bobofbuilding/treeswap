import assert from "node:assert/strict";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { id } from "ethers";
import {
  Bolt11DecodeError,
  decodeBolt11Invoice,
  isDecodedBolt11Invoice,
} from "../lib/bolt11.mjs";
import {
  bolt11BytesTag,
  bolt11FeatureWords,
  bolt11IntegerWords,
  bolt11Tag,
  bolt11WordsFromBytes,
  createRawBolt11Invoice,
  testBolt11Payee,
} from "./bolt11-fixture.mjs";

const NOW = 2_000_000_000;
const PAYMENT_HASH = id("bolt11-payment-hash").toLowerCase();
const PAYMENT_SECRET = id("bolt11-payment-secret").toLowerCase();
const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const OTHER_PRIVATE_KEY = `0x${"22".repeat(32)}`;
const OPTIONS = Object.freeze({ maximumInvoiceLength: 4_096 });
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const OFFICIAL_VECTOR = "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

function bytes(value) {
  return Buffer.from(value.replace(/^0x/, ""), "hex");
}

function requiredTags({
  descriptionTag = bolt11BytesTag("d", Buffer.from("TreeSwap decoder test", "utf8")),
  destinationPrivateKey = null,
  features = [9, 15, 17],
  paymentHash = PAYMENT_HASH,
  paymentSecret = PAYMENT_SECRET,
} = {}) {
  const tags = [
    bolt11BytesTag("p", bytes(paymentHash)),
    bolt11BytesTag("s", bytes(paymentSecret)),
    descriptionTag,
    bolt11Tag("x", bolt11IntegerWords(3_600)),
    bolt11Tag("c", bolt11IntegerWords(80)),
  ];
  if (destinationPrivateKey !== null) {
    tags.push(bolt11BytesTag("n", secp256k1.getPublicKey(bytes(destinationPrivateKey), true)));
  }
  if (features !== null) tags.push(bolt11Tag("9", bolt11FeatureWords(features)));
  return tags;
}

function raw(overrides = {}) {
  return createRawBolt11Invoice({
    humanReadablePart: "lnbc500000n",
    privateKey: PRIVATE_KEY,
    tags: requiredTags(),
    timestamp: NOW - 30,
    ...overrides,
  });
}

test("decodes the official BOLT 11 vector and independently recovers its payee", () => {
  const decoded = decodeBolt11Invoice(OFFICIAL_VECTOR, OPTIONS);
  assert.equal(isDecodedBolt11Invoice(decoded), true);
  assert.equal(decoded.network, "mainnet");
  assert.equal(decoded.amountMsat, 250_000_000n);
  assert.equal(decoded.paymentHash, "0x0001020304050607080900010203040506070809000102030405060708090102");
  assert.equal(decoded.paymentSecret, `0x${"11".repeat(32)}`);
  assert.equal(decoded.destination, "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad");
  assert.equal(decoded.timestamp, 1_496_314_658);
  assert.equal(decoded.expirySeconds, 60);
  assert.deepEqual(decoded.featureBits, [8, 14]);
  assert.equal(
    decodeBolt11Invoice(`lightning:${OFFICIAL_VECTOR.toUpperCase()}`, OPTIONS).invoice,
    OFFICIAL_VECTOR,
  );
});

test("parses every BOLT 11 amount multiplier exactly and rejects noncanonical precision", () => {
  const cases = [
    ["lnbc", 0n],
    ["lnbc1m", 100_000_000n],
    ["lnbc10u", 1_000_000n],
    ["lnbc10n", 1_000n],
    ["lnbc10p", 1n],
    ["lnbc1", 100_000_000_000n],
  ];
  for (const [humanReadablePart, amountMsat] of cases) {
    const invoice = raw({ humanReadablePart });
    assert.equal(decodeBolt11Invoice(invoice, OPTIONS).amountMsat, amountMsat);
  }
  for (const humanReadablePart of ["lnbc0n", "lnbc01n", "lnbc1p", "lnbc1x"]) {
    assert.throws(() => decodeBolt11Invoice(raw({ humanReadablePart }), OPTIONS), Bolt11DecodeError);
  }
});

test("rejects checksum corruption, mixed case, malformed separators, truncation, and length exhaustion", () => {
  const invoice = raw();
  assert.throws(() => decodeBolt11Invoice(`${invoice.slice(0, -1)}q`, OPTIONS), /checksum/);
  for (let index = invoice.lastIndexOf("1") + 1; index < invoice.length; index += 1) {
    const replacement = invoice[index] === BECH32_CHARSET[0]
      ? BECH32_CHARSET[1]
      : BECH32_CHARSET[0];
    const mutated = `${invoice.slice(0, index)}${replacement}${invoice.slice(index + 1)}`;
    assert.throws(() => decodeBolt11Invoice(mutated, OPTIONS), /checksum/);
  }
  assert.throws(() => decodeBolt11Invoice(`${invoice.slice(0, 8).toUpperCase()}${invoice.slice(8)}`, OPTIONS), /mixed case/);
  assert.throws(() => decodeBolt11Invoice("lnbcwithoutseparator", OPTIONS), /separator/);
  assert.throws(() => decodeBolt11Invoice(OFFICIAL_VECTOR.slice(0, 80), OPTIONS), Bolt11DecodeError);
  assert.throws(() => decodeBolt11Invoice(invoice, { maximumInvoiceLength: 256 }), /length limit/);
});

test("enforces fixed tag lengths, singleton rules, description choice, UTF-8, and zero padding", () => {
  const duplicateHash = raw({ tags: [...requiredTags(), bolt11BytesTag("p", bytes(PAYMENT_HASH))] });
  assert.throws(() => decodeBolt11Invoice(duplicateHash, OPTIONS), /repeats singleton tag p/);
  const noDescription = raw({ tags: requiredTags().filter((tag) => tag.type !== "d") });
  assert.throws(() => decodeBolt11Invoice(noDescription, OPTIONS), /description/);
  const bothDescriptions = raw({
    tags: [...requiredTags(), bolt11BytesTag("h", bytes(id("description")))],
  });
  assert.throws(() => decodeBolt11Invoice(bothDescriptions, OPTIONS), /description/);
  const invalidUtf8 = raw({
    tags: requiredTags({ descriptionTag: bolt11BytesTag("d", Buffer.from([0xff])) }),
  });
  assert.throws(() => decodeBolt11Invoice(invalidUtf8, OPTIONS), /UTF-8/);
  const badPadding = bolt11WordsFromBytes(bytes(PAYMENT_HASH));
  badPadding[badPadding.length - 1] |= 1;
  const paddedHash = raw({
    tags: requiredTags().map((tag) => (tag.type === "p" ? bolt11Tag("p", badPadding) : tag)),
  });
  assert.throws(() => decodeBolt11Invoice(paddedHash, OPTIONS), /padding/);
});

test("validates an explicit payee with low-S and rejects a changed key or high-S signature", () => {
  const tags = requiredTags({ destinationPrivateKey: PRIVATE_KEY });
  const decoded = decodeBolt11Invoice(raw({ tags }), OPTIONS);
  assert.equal(decoded.destination, testBolt11Payee(PRIVATE_KEY));
  const wrongDestination = requiredTags({ destinationPrivateKey: OTHER_PRIVATE_KEY });
  assert.throws(() => decodeBolt11Invoice(raw({ tags: wrongDestination }), OPTIONS), /explicit payee/);
  assert.throws(() => decodeBolt11Invoice(raw({ highS: true, tags }), OPTIONS), /low-S/);
});

test("accepts a recoverable high-S signature only when no explicit payee tag exists", () => {
  const decoded = decodeBolt11Invoice(raw({ highS: true }), OPTIONS);
  assert.equal(decoded.destination, testBolt11Payee(PRIVATE_KEY));
});

test("classifies required feature safety and rejects malformed feature encodings", () => {
  const unknownRequired = decodeBolt11Invoice(raw({
    tags: requiredTags({ features: [2, 9, 15] }),
  }), OPTIONS);
  assert.deepEqual(unknownRequired.unknownRequiredFeatures, [2]);
  const unsupportedRequired = decodeBolt11Invoice(raw({
    tags: requiredTags({ features: [9, 15, 24] }),
  }), OPTIONS);
  assert.deepEqual(unsupportedRequired.unsupportedRequiredFeatures, [24]);
  const optionalUnknown = decodeBolt11Invoice(raw({
    tags: requiredTags({ features: [9, 15, 101] }),
  }), OPTIONS);
  assert.deepEqual(optionalUnknown.unknownRequiredFeatures, []);
  const bothPairBits = raw({ tags: requiredTags({ features: [8, 9, 15] }) });
  assert.throws(() => decodeBolt11Invoice(bothPairBits, OPTIONS), /sets both bits/);
  const nonminimal = raw({
    tags: requiredTags().map((tag) => (tag.type === "9" ? bolt11Tag("9", [0, ...tag.words]) : tag)),
  });
  assert.throws(() => decodeBolt11Invoice(nonminimal, OPTIONS), /not minimally encoded/);
  const metadataWithoutFeature = raw({
    tags: [...requiredTags({ features: [9, 15] }), bolt11BytesTag("m", Buffer.from("metadata"))],
  });
  assert.throws(() => decodeBolt11Invoice(metadataWithoutFeature, OPTIONS), /lacks its feature bit/);
});

test("validates route-hint and fallback structure without exposing their private contents", () => {
  const route = Buffer.concat([
    Buffer.from(secp256k1.getPublicKey(bytes(PRIVATE_KEY), true)),
    Buffer.alloc(18, 1),
  ]);
  const fallback = [0, ...bolt11WordsFromBytes(Buffer.alloc(20, 2))];
  const decoded = decodeBolt11Invoice(raw({
    tags: [
      ...requiredTags(),
      bolt11BytesTag("r", route),
      bolt11Tag("f", fallback),
    ],
  }), OPTIONS);
  assert.equal(decoded.routeHintCount, 1);
  assert.equal(decoded.fallbackCount, 1);
  assert.equal("routeHints" in decoded, false);
  const invalidRoute = raw({
    tags: [...requiredTags(), bolt11BytesTag("r", Buffer.alloc(51))],
  });
  assert.throws(() => decodeBolt11Invoice(invalidRoute, OPTIONS), /route hint/);
  const invalidFallback = raw({
    tags: [...requiredTags(), bolt11Tag("f", [0, ...bolt11WordsFromBytes(Buffer.alloc(21))])],
  });
  assert.throws(() => decodeBolt11Invoice(invalidFallback, OPTIONS), /fallback/);
});

test("bounds total tagged fields before an invoice can consume unbounded parser work", () => {
  const emptyUnknownTags = Array.from({ length: 129 }, () => bolt11Tag("q", []));
  const invoice = raw({ tags: [...requiredTags(), ...emptyUnknownTags] });
  assert.throws(() => decodeBolt11Invoice(invoice, OPTIONS), /too many tagged fields/);
});

test("rejects decorated decoder options without invoking accessors", () => {
  let read = false;
  const options = {};
  Object.defineProperty(options, "maximumInvoiceLength", {
    enumerable: true,
    get() {
      read = true;
      throw new Error("decoder option getter executed");
    },
  });
  assert.throws(() => decodeBolt11Invoice(raw(), options), /data properties/);
  assert.equal(read, false);
  assert.throws(() => decodeBolt11Invoice(raw(), { maximumInvoiceLength: 4_096, extra: true }), /fields are not exact/);
});
