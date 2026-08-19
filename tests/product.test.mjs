import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateLiquidityPlan,
  calculateQuote,
  calculateRequiredInput,
  hasMainnetBolt11Shape,
  normalizeBolt11,
  parseAmount,
  parseBolt11AmountSats,
  roundUpAmount,
  sanitizeAmount,
} from "../lib/product.mjs";

test("converts Lightning sats to BIT at the reference before fees", () => {
  const quote = calculateQuote("lightning-to-bit", 250_000, 18);
  assert.equal(quote.referenceOutput, 2_500);
  assert.equal(quote.fee, 4.5);
  assert.equal(quote.output, 2_495.5);
});

test("converts BIT to Lightning and includes routing in the net output", () => {
  const quote = calculateQuote("bit-to-lightning", 2_500, 72, 6);
  assert.equal(quote.referenceOutput, 250_000);
  assert.equal(quote.fee, 1_800);
  assert.equal(quote.output, 248_194);
});

test("never displays a negative output", () => {
  assert.equal(calculateQuote("bit-to-lightning", 1, 10_000, 500).output, 0);
  assert.equal(calculateQuote("lightning-to-bit", Number.NaN, 18).output, 0);
});

test("calculates the input required to satisfy an exact invoice amount", () => {
  const bitRequired = calculateRequiredInput("bit-to-lightning", 250_000, 72, 6);
  assert.ok(Math.abs(bitRequired - 2_518.190975) < 0.0001);

  const satsRequired = calculateRequiredInput("lightning-to-bit", 2_500, 18);
  assert.ok(Math.abs(satsRequired - 250_450.81146) < 0.0001);
  assert.equal(calculateRequiredInput("lightning-to-bit", 2_500, 10_000), 0);
  assert.equal(roundUpAmount(bitRequired, 6), 2_518.190976);
  assert.equal(roundUpAmount(satsRequired), 250_451);
});

test("normalizes and previews mainnet BOLT 11 invoice amounts", () => {
  const invoice = "LIGHTNING: LNBC2500U1QPZ RY9X8GF2TVDW0S3JN54KHCE6MUA7L";
  assert.equal(normalizeBolt11(invoice), "lnbc2500u1qpzry9x8gf2tvdw0s3jn54khce6mua7l");
  assert.equal(hasMainnetBolt11Shape(invoice), true);
  assert.equal(parseBolt11AmountSats(invoice), 250_000);
  assert.equal(parseBolt11AmountSats("lnbc1amountlessrequestdemo"), null);
  assert.equal(hasMainnetBolt11Shape("lntb2500u1testnetrequestdemo"), false);
});

test("keeps a reserve and caps the suggested first fill", () => {
  const plan = calculateLiquidityPlan(5_000_000, 50_000);
  assert.equal(plan.usableLightning, 3_750_000);
  assert.equal(plan.usableBit, 37_500);
  assert.equal(plan.balancedCapacity, 3_750_000);
  assert.equal(plan.fillCap, 187_500);
});

test("uses the smaller side as balanced capacity", () => {
  const plan = calculateLiquidityPlan(10_000_000, 10_000);
  assert.equal(plan.balancedCapacity, 750_000);
  assert.equal(plan.fillCap, 37_500);
});

test("sanitizes malformed amounts before calculation", () => {
  assert.equal(sanitizeAmount("1,2a3..45"), "123.45");
  assert.equal(sanitizeAmount("1,2a3..45", false), "12345");
  assert.equal(parseAmount("1,250.5"), 1_250.5);
  assert.equal(parseAmount("not-a-number"), 0);
  assert.equal(parseAmount("-3"), 0);
});
