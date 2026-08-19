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

