import assert from "node:assert/strict";
import test from "node:test";

import {
  BIT_DECIMALS,
  BIT_MAINNET_CONTRACT,
  classifyWebLnPaymentResponse,
  createBitSendAuthorization,
  prepareBitSend,
  prepareLightningSend,
  validateBitSendDispatch,
  validateBitTransactionResponse,
} from "../lib/send.mjs";

test("prepares an exact BIT transfer without approvals or floating-point math", () => {
  const transfer = prepareBitSend(
    "0x1111111111111111111111111111111111111111",
    "1.000000000000000001",
  );

  assert.equal(BIT_DECIMALS, 18);
  assert.equal(transfer.recipient, "0x1111111111111111111111111111111111111111");
  assert.equal(transfer.amountWei, 1_000_000_000_000_000_001n);
  assert.equal(transfer.displayAmount, "1.000000000000000001");
});

test("rejects unsafe BIT destinations and amounts before a wallet request", () => {
  assert.throws(
    () => prepareBitSend("0x0000000000000000000000000000000000000000", "1"),
    /zero address/i,
  );
  assert.throws(() => prepareBitSend("not-an-address", "1"), /valid Ethereum address/i);
  assert.throws(
    () => prepareBitSend("0x1111111111111111111111111111111111111111", "0"),
    /greater than zero/i,
  );
  assert.throws(
    () => prepareBitSend("0x1111111111111111111111111111111111111111", "1.0000000000000000001"),
    /18 decimal places/i,
  );
});

test("prepares only exact, whole-satoshi mainnet Lightning invoices", () => {
  const payment = prepareLightningSend("LIGHTNING: LNBC2500U1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L");
  assert.equal(payment.invoice, "lnbc2500u1qpzry9x8gf2tvdw0s3jn54khce6mua7l");
  assert.equal(payment.amountSats, 250_000);

  assert.throws(() => prepareLightningSend("lntb2500u1testnetrequestdemo"), /mainnet BOLT 11/i);
  assert.throws(() => prepareLightningSend("lnbc1qpzry9x8gf2tvdw0s3jn54khce6mua7l"), /Amountless/i);
  assert.throws(() => prepareLightningSend("lnbc10p1qpzry9x8gf2tvdw0s3jn54khce6mua7l"), /whole-satoshi/i);
});

test("freezes chain, token code, sender, recipient, and amount for one BIT review", () => {
  const authorization = createBitSendAuthorization({
    chainId: 1,
    tokenAddress: BIT_MAINNET_CONTRACT,
    contractCode: "0x60006000",
    sender: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: 2n,
  });
  const snapshot = {
    chainId: 1,
    tokenAddress: BIT_MAINNET_CONTRACT,
    contractCode: "0x60006000",
    sender: authorization.sender,
    symbol: "BIT",
    decimals: 18,
    paused: false,
    balance: 2n,
  };
  assert.deepEqual(validateBitSendDispatch({ authorization, snapshot }), { valid: true, reasons: [] });
  for (const mutation of [
    { chainId: 10 },
    { contractCode: "0x60016000" },
    { sender: "0x3333333333333333333333333333333333333333" },
    { symbol: "FAKE" },
    { decimals: 6 },
    { paused: true },
    { balance: 1n },
  ]) {
    assert.equal(validateBitSendDispatch({ authorization, snapshot: { ...snapshot, ...mutation } }).valid, false);
  }
});

test("accepts only the exact zero-ETH BIT transfer response", () => {
  const authorization = createBitSendAuthorization({
    chainId: 1,
    tokenAddress: BIT_MAINNET_CONTRACT,
    contractCode: "0x60006000",
    sender: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: 2n,
  });
  const data = "0xa9059cbb";
  const transaction = { hash: `0x${"ab".repeat(32)}`, to: authorization.token, from: authorization.sender, data, value: 0n };
  assert.deepEqual(validateBitTransactionResponse(transaction, authorization, data), { valid: true, reasons: [] });
  assert.equal(validateBitTransactionResponse({ ...transaction, hash: "javascript:alert(1)" }, authorization, data).valid, false);
  assert.equal(validateBitTransactionResponse({ ...transaction, to: authorization.recipient }, authorization, data).valid, false);
  assert.equal(validateBitTransactionResponse({ ...transaction, data: "0xdeadbeef" }, authorization, data).valid, false);
  assert.equal(validateBitTransactionResponse({ ...transaction, value: 1n }, authorization, data).valid, false);
});

test("never stores a WebLN preimage or turns a malformed response into proof", () => {
  assert.deepEqual(classifyWebLnPaymentResponse({ preimage: "ab".repeat(32) }), { status: "reported", preimageStored: false });
  assert.deepEqual(classifyWebLnPaymentResponse({}), { status: "unknown", preimageStored: false });
});
