export const BPS_DENOMINATOR = 10_000n;
export const MSATS_PER_SAT = 1_000n;
export const BIT_WEI_PER_BIT = 10n ** 18n;
export const REFERENCE_SATS_PER_BIT = 100n;
export const BIT_WEI_PER_REFERENCE_SAT = BIT_WEI_PER_BIT / REFERENCE_SATS_PER_BIT;
export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_UINT96 = (1n << 96n) - 1n;

function unsigned(value, name, maximum) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${name} must be an unsigned integer`);
  }
  if (parsed < 0n || (maximum !== undefined && parsed > maximum)) {
    throw new RangeError(`${name} is outside the supported range`);
  }
  return parsed;
}

function feeRate(value) {
  const parsed = unsigned(value, "feeBps", BPS_DENOMINATOR - 1n);
  return parsed;
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError("division denominator must be positive");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

export function satsToMsats(sats) {
  return unsigned(sats, "sats", MAX_UINT64) * MSATS_PER_SAT;
}

export function msatsToWholeSats(msats) {
  const amount = unsigned(msats, "msats");
  const dustMsats = amount % MSATS_PER_SAT;
  if (dustMsats !== 0n) throw new RangeError("millisatoshi amount is not a whole satoshi");
  const sats = amount / MSATS_PER_SAT;
  if (sats > MAX_UINT64) throw new RangeError("satoshi amount is outside the supported range");
  return sats;
}

export function referenceBitWeiFromSats(sats) {
  const amount = unsigned(sats, "sats", MAX_UINT64);
  const bitWei = amount * BIT_WEI_PER_REFERENCE_SAT;
  if (bitWei > MAX_UINT96) throw new RangeError("reference BIT amount exceeds uint96 escrow range");
  return bitWei;
}

export function referenceSatsFromBitWei(bitWei) {
  const amount = unsigned(bitWei, "bitWei", MAX_UINT96);
  return Object.freeze({
    sats: amount / BIT_WEI_PER_REFERENCE_SAT,
    dustBitWei: amount % BIT_WEI_PER_REFERENCE_SAT,
  });
}

export function protocolFeeBitWei(grossBitWei, feeBps) {
  const gross = unsigned(grossBitWei, "grossBitWei", MAX_UINT96);
  return gross * feeRate(feeBps) / BPS_DENOMINATOR;
}

function minimumGrossBitWeiForNet(targetNetBitWei, feeBps) {
  const target = unsigned(targetNetBitWei, "targetNetBitWei", MAX_UINT96);
  const fee = feeRate(feeBps);
  if (target === 0n) return 0n;

  let low = target;
  let high = ceilDiv(target * BPS_DENOMINATOR, BPS_DENOMINATOR - fee);
  if (high > MAX_UINT96) throw new RangeError("required gross BIT exceeds uint96 escrow range");
  while (low < high) {
    const middle = low + (high - low) / 2n;
    const net = middle - protocolFeeBitWei(middle, fee);
    if (net >= target) high = middle;
    else low = middle + 1n;
  }
  return low;
}

export function quoteLightningToBit({ inputSats, feeBps }) {
  const lightningInputSats = unsigned(inputSats, "inputSats", MAX_UINT64);
  if (lightningInputSats === 0n) throw new RangeError("inputSats must be positive");
  const grossBitWei = referenceBitWeiFromSats(lightningInputSats);
  const feeBitWei = protocolFeeBitWei(grossBitWei, feeBps);
  const outputBitWei = grossBitWei - feeBitWei;
  return Object.freeze({ lightningInputSats, grossBitWei, feeBitWei, outputBitWei });
}

export function quoteBitToLightning({ inputBitWei, feeBps, routingFeeSats = 0n }) {
  const grossBitWei = unsigned(inputBitWei, "inputBitWei", MAX_UINT96);
  const routeSats = unsigned(routingFeeSats, "routingFeeSats", MAX_UINT64);
  if (grossBitWei === 0n) throw new RangeError("inputBitWei must be positive");
  const feeBitWei = protocolFeeBitWei(grossBitWei, feeBps);
  const solverBitWei = grossBitWei - feeBitWei;
  const reference = referenceSatsFromBitWei(solverBitWei);
  if (reference.sats < routeSats) throw new RangeError("routing fee exceeds reference Lightning output");
  return Object.freeze({
    grossBitWei,
    feeBitWei,
    solverBitWei,
    referenceLightningSats: reference.sats,
    routingFeeSats: routeSats,
    outputLightningSats: reference.sats - routeSats,
    dustBitWei: reference.dustBitWei,
  });
}

export function requiredBitForExactLightning({ outputSats, feeBps, routingFeeSats = 0n }) {
  const output = unsigned(outputSats, "outputSats", MAX_UINT64);
  const route = unsigned(routingFeeSats, "routingFeeSats", MAX_UINT64);
  if (output === 0n) throw new RangeError("outputSats must be positive");
  if (output + route > MAX_UINT64) throw new RangeError("Lightning target exceeds uint64 range");
  const targetNetBitWei = (output + route) * BIT_WEI_PER_REFERENCE_SAT;
  const grossBitWei = minimumGrossBitWeiForNet(targetNetBitWei, feeBps);
  const quote = quoteBitToLightning({ inputBitWei: grossBitWei, feeBps, routingFeeSats: route });
  if (quote.outputLightningSats < output) throw new Error("exact Lightning quote underfunded");
  return quote;
}

export function requiredSatsForExactBit({ outputBitWei, feeBps }) {
  const target = unsigned(outputBitWei, "outputBitWei", MAX_UINT96);
  if (target === 0n) throw new RangeError("outputBitWei must be positive");
  const fee = feeRate(feeBps);
  let low = 1n;
  let high = ceilDiv(target * BPS_DENOMINATOR, BIT_WEI_PER_REFERENCE_SAT * (BPS_DENOMINATOR - fee));
  if (high > MAX_UINT64) throw new RangeError("required sats exceed uint64 range");
  while (low < high) {
    const middle = low + (high - low) / 2n;
    const quote = quoteLightningToBit({ inputSats: middle, feeBps: fee });
    if (quote.outputBitWei >= target) high = middle;
    else low = middle + 1n;
  }
  const quote = quoteLightningToBit({ inputSats: low, feeBps: fee });
  if (quote.outputBitWei < target) throw new Error("exact BIT quote underfunded");
  return quote;
}

export function assertQuoteConservation(quote) {
  if ("lightningInputSats" in quote) {
    if (quote.grossBitWei !== quote.outputBitWei + quote.feeBitWei) throw new Error("BIT value is not conserved");
    if (quote.grossBitWei !== referenceBitWeiFromSats(quote.lightningInputSats)) {
      throw new Error("reference conversion is not conserved");
    }
    return true;
  }
  if (quote.grossBitWei !== quote.solverBitWei + quote.feeBitWei) throw new Error("BIT value is not conserved");
  if (quote.referenceLightningSats !== quote.outputLightningSats + quote.routingFeeSats) {
    throw new Error("Lightning value is not conserved");
  }
  if (
    quote.solverBitWei
      !== quote.referenceLightningSats * BIT_WEI_PER_REFERENCE_SAT + quote.dustBitWei
  ) throw new Error("BIT dust is not conserved");
  return true;
}
