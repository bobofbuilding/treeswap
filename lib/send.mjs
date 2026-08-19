import { MaxUint256, ZeroAddress, formatUnits, getAddress, keccak256, parseUnits, solidityPackedKeccak256 } from "ethers";
import {
  hasMainnetBolt11Shape,
  normalizeBolt11,
  parseBolt11AmountSats,
} from "./product.mjs";

export const BIT_DECIMALS = 18;
export const BIT_MAINNET_CONTRACT = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";

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

export function createBitSendAuthorization({ chainId, tokenAddress, contractCode, sender, recipient, amountWei }) {
  if (Number(chainId) !== 1) throw new Error("BIT direct sends require Ethereum mainnet.");
  const token = getAddress(tokenAddress);
  if (token !== getAddress(BIT_MAINNET_CONTRACT)) throw new Error("Unexpected BIT token address.");
  const from = getAddress(sender);
  const to = getAddress(recipient);
  const amount = BigInt(amountWei);
  if (from === to || to === ZeroAddress || amount <= 0n || amount > MaxUint256) throw new Error("Invalid frozen BIT transfer.");
  const code = String(contractCode ?? "").toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})+$/.test(code)) throw new Error("BIT runtime code is unavailable.");
  const contractCodeHash = keccak256(code);
  const digest = solidityPackedKeccak256(
    ["string", "uint256", "address", "bytes32", "address", "address", "uint256"],
    ["TreeSwap direct BIT send v1", 1, token, contractCodeHash, from, to, amount],
  );
  return Object.freeze({ chainId: 1, token, contractCodeHash, sender: from, recipient: to, amountWei: amount, digest });
}

export function validateBitSendDispatch({ authorization, snapshot }) {
  const reasons = [];
  let current;
  try {
    current = createBitSendAuthorization({
      chainId: snapshot.chainId,
      tokenAddress: snapshot.tokenAddress,
      contractCode: snapshot.contractCode,
      sender: snapshot.sender,
      recipient: authorization.recipient,
      amountWei: authorization.amountWei,
    });
  } catch (error) {
    reasons.push(error.message);
  }
  if (!current || current.digest !== authorization.digest) reasons.push("frozen BIT transfer context changed");
  if (snapshot.symbol !== "BIT" || Number(snapshot.decimals) !== BIT_DECIMALS) reasons.push("BIT token settings changed");
  if (snapshot.paused !== false) reasons.push("BIT is paused");
  try {
    if (BigInt(snapshot.balance) < authorization.amountWei) reasons.push("BIT balance is too low");
  } catch {
    reasons.push("BIT balance is unavailable");
  }
  return Object.freeze({ valid: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function validateBitTransactionResponse(transaction, authorization, expectedData) {
  const reasons = [];
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(transaction?.hash ?? ""))) reasons.push("wallet returned an invalid transaction hash");
  try {
    if (getAddress(transaction?.to) !== authorization.token) reasons.push("wallet transaction target changed");
    if (getAddress(transaction?.from) !== authorization.sender) reasons.push("wallet transaction sender changed");
  } catch {
    reasons.push("wallet transaction addresses are invalid");
  }
  if (String(transaction?.data ?? "").toLowerCase() !== String(expectedData).toLowerCase()) reasons.push("wallet transaction call data changed");
  try {
    if (BigInt(transaction?.value ?? 0) !== 0n) reasons.push("wallet transaction unexpectedly transfers ETH");
  } catch {
    reasons.push("wallet transaction value is invalid");
  }
  return Object.freeze({ valid: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function classifyWebLnPaymentResponse(response) {
  const preimage = String(response?.preimage ?? "");
  return Object.freeze({
    status: /^(?:0x)?[0-9a-fA-F]{64}$/.test(preimage) ? "reported" : "unknown",
    preimageStored: false,
  });
}
