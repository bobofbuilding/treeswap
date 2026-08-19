import { MaxUint256, ZeroAddress, formatUnits, getAddress, parseUnits } from "ethers";
import {
  hasMainnetBolt11Shape,
  normalizeBolt11,
  parseBolt11AmountSats,
} from "./product.mjs";

export const BIT_DECIMALS = 18;

/**
 * Canonicalizes one direct BIT transfer before the wallet is opened.
 * @param {string} recipient
 * @param {string} amount
 */
export function prepareBitSend(recipient, amount) {
  let checkedRecipient;
  try {
    checkedRecipient = getAddress(String(recipient).trim());
  } catch {
    throw new Error("Enter a valid Ethereum address.");
  }

  if (checkedRecipient === ZeroAddress) {
    throw new Error("The zero address cannot receive BIT.");
  }

  let amountWei;
  try {
    amountWei = parseUnits(String(amount).trim(), BIT_DECIMALS);
  } catch {
    throw new Error("Enter a BIT amount with no more than 18 decimal places.");
  }

  if (amountWei <= 0n) throw new Error("Enter a BIT amount greater than zero.");
  if (amountWei > MaxUint256) throw new Error("The BIT amount is too large.");

  return {
    recipient: checkedRecipient,
    amountWei,
    displayAmount: formatUnits(amountWei, BIT_DECIMALS),
  };
}

/**
 * Canonicalizes an exact, whole-satoshi mainnet invoice for direct payment.
 * The Lightning wallet remains responsible for full BOLT 11 validation.
 * @param {string} value
 */
export function prepareLightningSend(value) {
  const invoice = normalizeBolt11(value);
  if (!hasMainnetBolt11Shape(invoice)) {
    throw new Error("Enter a mainnet BOLT 11 invoice beginning with lnbc.");
  }

  const amountSats = parseBolt11AmountSats(invoice);
  if (!amountSats) throw new Error("Amountless Lightning invoices are not supported.");
  if (!Number.isSafeInteger(amountSats)) {
    throw new Error("The invoice must encode a whole-satoshi amount within the supported range.");
  }

  return { invoice, amountSats };
}
