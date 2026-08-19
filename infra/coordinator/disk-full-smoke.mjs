import assert from "node:assert/strict";
import { id } from "ethers";
import { CoordinatorStore } from "../../lib/coordinator-store.mjs";

const path = process.env.COORDINATOR_DISK_FULL_PATH ?? "/data/coordinator-disk-full.sqlite";
const now = 2_000_000_000;

function hash(label) {
  return id(label).toLowerCase();
}

function settlement(index) {
  return {
    settlementId: hash(`disk-full:${index}:settlement`),
    pricingId: hash(`disk-full:${index}:pricing`),
    direction: "bit-to-lightning",
    nonceAuthorityDigest: hash("disk-full:nonce-authority"),
    intentNonce: String(index),
    intentDigest: hash(`disk-full:${index}:intent`),
    paymentHash: hash(`disk-full:${index}:payment`),
    invoiceDigest: hash(`disk-full:${index}:invoice`),
    amountSats: "10000",
    quoteReceiptDigest: hash(`disk-full:${index}:quote-receipt`),
    selectedSetDigest: hash(`disk-full:${index}:selected-set`),
    selectedOfferId: hash(`disk-full:${index}:selected-offer`),
    capacityEpoch: 1,
    createdAt: now + index,
  };
}

let store = await CoordinatorStore.open(path);
let accepted = 0;
let rejectedForDiskFull = false;
try {
  for (let index = 0; index < 100_000; index += 1) {
    try {
      store.acceptSettlement(settlement(index));
      accepted += 1;
    } catch (error) {
      if (!/database or disk is full|SQLITE_FULL/i.test(String(error?.message))) throw error;
      rejectedForDiskFull = true;
      break;
    }
  }
  assert.equal(rejectedForDiskFull, true, "bounded filesystem did not reach SQLITE_FULL");
  assert.ok(accepted > 0, "disk-full campaign did not commit a baseline record");
  assert.deepEqual(store.metrics().settlementStates, { INTENT_ACCEPTED: accepted });
  assert.equal(store.integrityCheck({ full: true }).status, "ok");
} finally {
  store.close();
}

store = await CoordinatorStore.open(path);
try {
  assert.deepEqual(store.metrics().settlementStates, { INTENT_ACCEPTED: accepted });
  assert.equal(store.integrityCheck({ full: true }).status, "ok");
} finally {
  store.close();
}

console.log(JSON.stringify({ acceptedBeforeFailClosed: accepted, status: "passed" }));
