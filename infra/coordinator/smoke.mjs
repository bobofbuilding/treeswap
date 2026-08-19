import { createPrivateKey, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  dispatchLightningAction,
  lightningActionCommitment,
  reconcileLightningAction,
} from "../../lib/coordinator-action-runner.mjs";
import { CoordinatorStore, coordinatorCommitmentDigest } from "../../lib/coordinator-store.mjs";
import { invoiceDigest } from "../../lib/lnd-rest-client.mjs";

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
  if (keys.length !== 2 || keys[0] !== "amountSats" || keys[1] !== "paymentRequest") {
    throw new TypeError("smoke input fields are not exact");
  }
  if (!/^[1-9][0-9]*$/.test(String(value.amountSats))) throw new TypeError("smoke amount is invalid");
  if (typeof value.paymentRequest !== "string" || value.paymentRequest.length > 20_000) {
    throw new TypeError("smoke invoice is invalid");
  }
  return { amountSats: String(value.amountSats), paymentRequest: value.paymentRequest };
}

let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 32_768) throw new Error("smoke input exceeded its limit");
}
const input = exactInput(JSON.parse(raw));
const decoded = await fetch("http://payer-adapter:3000/healthz");
if (!decoded.ok) throw new Error("payer adapter is unavailable");

const privateKey = createPrivateKey(await readFile(required("COORDINATOR_PRIVATE_KEY_PATH")));
const paymentHash = required("PAYMENT_HASH").toLowerCase();
if (!BYTES32.test(paymentHash)) throw new TypeError("PAYMENT_HASH is invalid");
const now = Math.floor(Date.now() / 1_000);
const settlement = {
  settlementId: randomHash(),
  pricingId: randomHash(),
  direction: "bit-to-lightning",
  nonceAuthorityDigest: randomHash(),
  intentNonce: BigInt(`0x${randomBytes(16).toString("hex")}`).toString(),
  intentDigest: randomHash(),
  paymentHash,
  invoiceDigest: invoiceDigest(input.paymentRequest),
  amountSats: input.amountSats,
  quoteReceiptDigest: randomHash(),
  selectedSetDigest: randomHash(),
  selectedOfferId: randomHash(),
  capacityEpoch: 1,
  createdAt: now,
};
const operation = {
  paymentRequest: input.paymentRequest,
  timeoutSeconds: 30,
  feeLimitSats: "10",
};
const actionDraft = {
  actionId: randomHash(),
  settlementId: settlement.settlementId,
  method: "/routerrpc.Router/SendPaymentV2",
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
    adapterUrl: "http://payer-adapter:3000",
    nowSeconds: () => Math.floor(Date.now() / 1_000),
    requestImpl: async (url, options) => {
      const response = await fetch(url, options);
      const body = await response.clone().json();
      if (response.ok && body?.result?.status === "SUCCEEDED") {
        responseWasLost = true;
        throw new Error("simulated loss after successful adapter response");
      }
      return response;
    },
  });
} catch (error) {
  if (!responseWasLost || error?.ambiguous !== true) throw error;
}
if (store.getAction(action.actionId)?.state !== "UNKNOWN") throw new Error("lost response did not enter UNKNOWN");
store.close();

store = await CoordinatorStore.open(databasePath);
if (store.recoverInterruptedActions(Math.floor(Date.now() / 1_000)) !== 0) {
  throw new Error("UNKNOWN action was incorrectly treated as a fresh dispatch");
}
let reconciled;
for (let attempt = 0; attempt < 40; attempt += 1) {
  reconciled = await reconcileLightningAction({
    store,
    actionId: action.actionId,
    reconciliationRequestId: randomHash(),
    privateKey,
    keyId: required("COORDINATOR_KEY_ID"),
    adapterUrl: "http://payer-adapter:3000",
    nowSeconds: () => Math.floor(Date.now() / 1_000),
  });
  if (reconciled.disposition !== "unresolved") break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (reconciled.disposition !== "confirmed" || reconciled.action.dispatchCount !== 1) {
  throw new Error(
    `read-only reconciliation did not confirm exactly one dispatch: disposition=${reconciled.disposition}, actionState=${reconciled.action.state}, dispatchCount=${reconciled.action.dispatchCount}`,
  );
}
const storedBytes = await readFile(databasePath);
if (storedBytes.includes(Buffer.from(input.paymentRequest))) throw new Error("coordinator persisted the raw invoice");
store.close();

const evidence = {
  schema: "treeswap.coordinator-regtest-smoke.v1",
  status: "passed",
  amountSats: input.amountSats,
  simulatedBoundary: "finalized-reservation-observation",
  lostResponseState: "UNKNOWN",
  reconciliationState: "CONFIRMED",
  dispatchCount: 1,
  rawInvoicePersisted: false,
  evidenceDigest: coordinatorCommitmentDigest({
    schema: "treeswap.coordinator-regtest-smoke.v1",
    status: "passed",
    amountSats: input.amountSats,
    dispatchCount: 1,
    rawInvoicePersisted: false,
  }),
};
process.stdout.write(`${JSON.stringify(evidence)}\n`);
