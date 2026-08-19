import assert from "node:assert/strict";
import test from "node:test";
import {
  BIT_WEI_PER_REFERENCE_SAT,
  MAX_UINT64,
  MAX_UINT96,
  assertQuoteConservation,
  msatsToWholeSats,
  protocolFeeBitWei,
  quoteBitToLightning,
  quoteLightningToBit,
  referenceSatsFromBitWei,
  requiredBitForExactLightning,
  requiredSatsForExactBit,
  satsToMsats,
} from "../lib/units.mjs";

test("uses exact integer units at the 100-sat reference", () => {
  assert.equal(BIT_WEI_PER_REFERENCE_SAT, 10n ** 16n);
  assert.equal(satsToMsats(123n), 123_000n);
  assert.equal(msatsToWholeSats(123_000n), 123n);
  assert.throws(() => msatsToWholeSats(123_001n), /not a whole satoshi/);
});

test("rounds protocol fees down only on the BIT leg", () => {
  assert.equal(protocolFeeBitWei(9_999n, 1n), 0n);
  assert.equal(protocolFeeBitWei(10_000n, 1n), 1n);
  const quote = quoteLightningToBit({ inputSats: 250_000n, feeBps: 18n });
  assert.equal(quote.grossBitWei, 2_500n * 10n ** 18n);
  assert.equal(quote.feeBitWei, 4_500_000_000_000_000_000n);
  assert.equal(assertQuoteConservation(quote), true);
});

test("rounds Lightning output down and records every BIT dust wei", () => {
  const quote = quoteBitToLightning({ inputBitWei: 2_500n * 10n ** 18n + 123n, feeBps: 72n, routingFeeSats: 6n });
  assert.equal(quote.outputLightningSats, 248_194n);
  assert.equal(quote.dustBitWei, 123n);
  assert.equal(assertQuoteConservation(quote), true);
});

test("finds the minimum gross input for exact-output swaps", () => {
  const lightning = requiredBitForExactLightning({ outputSats: 250_000n, feeBps: 72n, routingFeeSats: 6n });
  assert.equal(lightning.outputLightningSats, 250_000n);
  const previousLightning = quoteBitToLightning({
    inputBitWei: lightning.grossBitWei - 1n,
    feeBps: 72n,
    routingFeeSats: 6n,
  });
  assert.ok(previousLightning.outputLightningSats < 250_000n);

  const bit = requiredSatsForExactBit({ outputBitWei: 2_500n * 10n ** 18n, feeBps: 18n });
  assert.ok(bit.outputBitWei >= 2_500n * 10n ** 18n);
  const previousBit = quoteLightningToBit({ inputSats: bit.lightningInputSats - 1n, feeBps: 18n });
  assert.ok(previousBit.outputBitWei < 2_500n * 10n ** 18n);
});

test("conserves value across thousands of dust-sized fills", () => {
  let gross = 0n;
  let payouts = 0n;
  let fees = 0n;
  for (let index = 1n; index <= 10_000n; index += 1n) {
    const quote = quoteLightningToBit({ inputSats: index, feeBps: 37n });
    assertQuoteConservation(quote);
    gross += quote.grossBitWei;
    payouts += quote.outputBitWei;
    fees += quote.feeBitWei;
  }
  assert.equal(gross, payouts + fees);
  assert.ok(fees <= protocolFeeBitWei(gross, 37n));
});

test("rejects unsupported dust and overflows at uint64 and uint96 boundaries", () => {
  assert.equal(referenceSatsFromBitWei(MAX_UINT96).dustBitWei < BIT_WEI_PER_REFERENCE_SAT, true);
  assert.throws(() => satsToMsats(MAX_UINT64 + 1n), /outside the supported range/);
  assert.throws(() => protocolFeeBitWei(MAX_UINT96 + 1n, 1n), /outside the supported range/);
  assert.throws(() => protocolFeeBitWei(1n, 10_000n), /outside the supported range/);
});
