export const PAR_SATS = 100;

/**
 * @param {string | number} value
 */
export function parseAmount(value) {
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {string} value
 * @param {boolean} [allowDecimal]
 */
export function sanitizeAmount(value, allowDecimal = true) {
  const cleaned = String(value).replace(allowDecimal ? /[^0-9.]/g : /[^0-9]/g, "");
  if (!allowDecimal) return cleaned;
  const [whole = "", ...fraction] = cleaned.split(".");
  return fraction.length > 0 ? `${whole}.${fraction.join("")}` : whole;
}

/**
 * @param {"lightning-to-bit" | "bit-to-lightning"} direction
 * @param {number} inputAmount
 * @param {number} feeBps
 * @param {number} routeFee
 */
export function calculateQuote(direction, inputAmount, feeBps, routeFee = 0) {
  const safeInput = Number.isFinite(inputAmount) ? Math.max(inputAmount, 0) : 0;
  const safeFeeBps = Number.isFinite(feeBps) ? Math.max(feeBps, 0) : 0;
  const safeRouteFee = Number.isFinite(routeFee) ? Math.max(routeFee, 0) : 0;
  const inputIsSats = direction === "lightning-to-bit";
  const referenceOutput = inputIsSats ? safeInput / PAR_SATS : safeInput * PAR_SATS;
  const fee = (referenceOutput * safeFeeBps) / 10_000;

  return {
    inputIsSats,
    referenceOutput,
    fee,
    output: Math.max(referenceOutput - fee - safeRouteFee, 0),
  };
}

/**
 * Calculates the input needed to deliver an exact invoice or BIT amount.
 * @param {"lightning-to-bit" | "bit-to-lightning"} direction
 * @param {number} outputAmount
 * @param {number} feeBps
 * @param {number} routeFee
 */
export function calculateRequiredInput(direction, outputAmount, feeBps, routeFee = 0) {
  const safeOutput = Number.isFinite(outputAmount) ? Math.max(outputAmount, 0) : 0;
  const safeFeeBps = Number.isFinite(feeBps) ? Math.max(feeBps, 0) : 0;
  const safeRouteFee = Number.isFinite(routeFee) ? Math.max(routeFee, 0) : 0;
  const remainingRatio = 1 - safeFeeBps / 10_000;

  if (safeOutput === 0 || remainingRatio <= 0) return 0;

  return direction === "lightning-to-bit"
    ? (safeOutput * PAR_SATS) / remainingRatio
    : (safeOutput + safeRouteFee) / (PAR_SATS * remainingRatio);
}

/**
 * Rounds required input upward so a displayed quote cannot underfund its output.
 * @param {number} value
 * @param {number} decimalPlaces
 */
export function roundUpAmount(value, decimalPlaces = 0) {
  const safeValue = Number.isFinite(value) ? Math.max(value, 0) : 0;
  const safePlaces = Number.isFinite(decimalPlaces)
    ? Math.min(Math.max(Math.trunc(decimalPlaces), 0), 18)
    : 0;
  const factor = 10 ** safePlaces;
  return Math.ceil(safeValue * factor) / factor;
}

/**
 * Normalizes a pasted BOLT 11 payment request for preview only.
 * @param {string} value
 */
export function normalizeBolt11(value) {
  return String(value).trim().replace(/^lightning:/i, "").replace(/\s/g, "").toLowerCase();
}

/**
 * Performs only a basic mainnet BOLT 11 shape check. Production must also
 * verify the Bech32 checksum, signature, expiry, features, and tagged fields.
 * @param {string} value
 */
export function hasMainnetBolt11Shape(value) {
  const invoice = normalizeBolt11(value);
  const separator = invoice.lastIndexOf("1");
  const humanReadablePart = invoice.slice(0, separator);
  const dataPart = invoice.slice(separator + 1);
  return (
    invoice.length >= 20 &&
    invoice.length <= 4096 &&
    /^lnbc(?:\d+(?:[munp])?)?$/.test(humanReadablePart) &&
    /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(dataPart)
  );
}

/**
 * Reads an amount from the BOLT 11 human-readable prefix when present.
 * Returns null for amountless or malformed invoices.
 * @param {string} value
 */
export function parseBolt11AmountSats(value) {
  const invoice = normalizeBolt11(value);
  const separator = invoice.lastIndexOf("1");
  if (!invoice.startsWith("lnbc") || separator < 4) return null;

  const amountPart = invoice.slice(4, separator);
  if (!amountPart) return null;

  const suffix = amountPart.at(-1);
  const hasMultiplier = suffix === "m" || suffix === "u" || suffix === "n" || suffix === "p";
  const numericPart = hasMultiplier ? amountPart.slice(0, -1) : amountPart;
  if (!/^\d+$/.test(numericPart) || numericPart.startsWith("0")) return null;

  const amount = Number(numericPart);
  const satsPerUnit = {
    m: 100_000,
    u: 100,
    n: 0.1,
    p: 0.0001,
  };
  const sats = hasMultiplier ? amount * satsPerUnit[suffix] : amount * 100_000_000;
  return Number.isFinite(sats) && sats > 0 ? sats : null;
}

/**
 * @param {number} lightningSats
 * @param {number} bitAmount
 * @param {number} [reserveRatio]
 * @param {number} [firstFillRatio]
 */
export function calculateLiquidityPlan(
  lightningSats,
  bitAmount,
  reserveRatio = 0.25,
  firstFillRatio = 0.05,
) {
  const safeLightning = Number.isFinite(lightningSats) ? Math.max(lightningSats, 0) : 0;
  const safeBit = Number.isFinite(bitAmount) ? Math.max(bitAmount, 0) : 0;
  const quotedRatio = 1 - Math.min(Math.max(reserveRatio, 0), 1);
  const usableLightning = Math.floor(safeLightning * quotedRatio);
  const usableBit = safeBit * quotedRatio;
  const balancedCapacity = Math.min(usableLightning, usableBit * PAR_SATS);

  return {
    lightningReserve: safeLightning,
    bitReserve: safeBit,
    usableLightning,
    usableBit,
    balancedCapacity,
    fillCap: Math.floor(balancedCapacity * Math.min(Math.max(firstFillRatio, 0), 1)),
  };
}
