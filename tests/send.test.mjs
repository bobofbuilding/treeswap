import assert from "node:assert/strict";
import test from "node:test";

import { BIT_DECIMALS, prepareBitSend, prepareLightningSend } from "../lib/send.mjs";

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
