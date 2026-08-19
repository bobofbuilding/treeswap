import { createHash, createPrivateKey, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  dispatchLightningAction,
  lightningActionCommitment,
  reconcileLightningAction,
} from "../../lib/coordinator-action-runner.mjs";
import { CoordinatorStore, coordinatorCommitmentDigest } from "../../lib/coordinator-store.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function randomHash() {
  return `0x${randomBytes(32).toString("hex")}`;
}

function exactInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("smoke input must be an object");
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== "amountSats" || keys[1] !== "invoiceDigest" || keys[2] !== "preimage") {
    throw new TypeError("smoke input fields are not exact");
  }
  const amountSats = String(value.amountSats);
  const invoiceDigest = String(value.invoiceDigest).toLowerCase();
  const preimage = String(value.preimage).toLowerCase();
  if (!/^[1-9][0-9]*$/.test(amountSats)) throw new TypeError("smoke amount is invalid");
  if (!BYTES32.test(invoiceDigest)) throw new TypeError("smoke invoice digest is invalid");
  if (!BYTES32.test(preimage)) throw new TypeError("smoke preimage is invalid");
  return { amountSats, invoiceDigest, preimage };
}

function paymentHashFor(preimage) {
  return `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
}

async function databaseContainsPreimage(databasePath, preimage) {
  const ascii = Buffer.from(preimage);
  const raw = Buffer.from(preimage.slice(2), "hex");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const bytes = await readFile(`${databasePath}${suffix}`);
      if (bytes.includes(ascii) || bytes.includes(raw)) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 8_192) throw new Error("smoke input exceeded its limit");
}
const input = exactInput(JSON.parse(raw));
const paymentHash = required("PAYMENT_HASH").toLowerCase();
if (!BYTES32.test(paymentHash) || paymentHashFor(input.preimage) !== paymentHash) {
  throw new TypeError("PAYMENT_HASH does not match the exact preimage");
}

const health = await fetch("http://invoice-adapter:3000/healthz");
if (!health.ok) throw new Error("invoice adapter is unavailable");
const privateKey = createPrivateKey(await readFile(required("COORDINATOR_PRIVATE_KEY_PATH")));
const now = Math.floor(Date.now() / 1_000);
const settlement = {
  settlementId: randomHash(),
  pricingId: randomHash(),
  direction: "lightning-to-bit",
  nonceAuthorityDigest: randomHash(),
  intentNonce: BigInt(`0x${randomBytes(16).toString("hex")}`).toString(),
  intentDigest: randomHash(),
  paymentHash,
  invoiceDigest: input.invoiceDigest,
  amountSats: input.amountSats,
  quoteReceiptDigest: randomHash(),
  selectedSetDigest: randomHash(),
  selectedOfferId: randomHash(),
  capacityEpoch: 1,
  createdAt: now,
};
const operation = { preimage: input.preimage };
const actionDraft = {
  actionId: randomHash(),
  settlementId: settlement.settlementId,
  method: "/invoicesrpc.Invoices/SettleInvoice",
  requestId: randomHash(),
  payloadDigest: randomHash(),
  intentDigest: settlement.intentDigest,
  paymentHash: settlement.paymentHash,
  invoiceDigest: settlement.invoiceDigest,
  amountSats: settlement.amountSats,
  capacityEpoch: settlement.capacityEpoch,
  plannedAt: now + 1,
};
const action = { ...actionDraft, payloadDigest: lightningActionCommitment(actionDraft, operation) };
const databasePath = required("COORDINATOR_DATABASE_PATH");
let store = await CoordinatorStore.open(databasePath);
store.acceptSettlement(settlement);
store.recordReservation({
  settlementId: settlement.settlementId,
  reservationId: randomHash(),
  reservationTxHash: randomHash(),
  reservationBlockNumber: 1,
  reservationBlockHash: randomHash(),
  reservationIntentDigest: settlement.intentDigest,
  observedAt: now + 1,
});
store.planAction(action);

let responseWasLost = false;
try {
  await dispatchLightningAction({
    store,
    actionId: action.actionId,
    operation,
    privateKey,
    keyId: required("COORDINATOR_KEY_ID"),
    adapterUrl: "http://invoice-adapter:3000",
    nowSeconds: () => Math.floor(Date.now() / 1_000),
    requestImpl: async (url, options) => {
      const response = await fetch(url, options);
      const body = await response.clone().json();
      if (response.ok && body?.result?.state === "SETTLED") {
        responseWasLost = true;
        throw new Error("simulated loss after successful invoice settlement");
      }
      return response;
    },
  });
} catch (error) {
  if (!responseWasLost || error?.ambiguous !== true) throw error;
}
if (store.getAction(action.actionId)?.state !== "UNKNOWN") {
  throw new Error("lost invoice response did not enter UNKNOWN");
}
store.close();

store = await CoordinatorStore.open(databasePath);
if (store.recoverInterruptedActions(Math.floor(Date.now() / 1_000)) !== 0) {
  throw new Error("UNKNOWN invoice action was incorrectly treated as a fresh dispatch");
}
const reconciled = await reconcileLightningAction({
  store,
  actionId: action.actionId,
  reconciliationRequestId: randomHash(),
  privateKey,
  keyId: required("COORDINATOR_KEY_ID"),
  adapterUrl: "http://invoice-adapter:3000",
  nowSeconds: () => Math.floor(Date.now() / 1_000),
});
if (reconciled.disposition !== "confirmed" || reconciled.action.dispatchCount !== 1) {
  throw new Error(
    `invoice reconciliation failed: disposition=${reconciled.disposition}, actionState=${reconciled.action.state}, dispatchCount=${reconciled.action.dispatchCount}`,
  );
}
store.close();
if (await databaseContainsPreimage(databasePath, input.preimage)) {
  throw new Error("coordinator persisted the raw invoice preimage");
}

const evidence = {
  schema: "treeswap.coordinator-invoice-regtest-smoke.v1",
  status: "passed",
  amountSats: input.amountSats,
  simulatedBoundary: "finalized-reservation-observation",
  lostResponseState: "UNKNOWN",
  reconciliationState: "CONFIRMED",
  invoiceState: "SETTLED",
  dispatchCount: 1,
  rawPreimagePersisted: false,
};
process.stdout.write(`${JSON.stringify({
  ...evidence,
  evidenceDigest: coordinatorCommitmentDigest(evidence),
})}\n`);
