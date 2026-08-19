import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateLiquidityPlan,
  calculateQuote,
  parseAmount,
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

