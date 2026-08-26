import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readConfirmedLightningPaymentProof } from "../../lib/coordinator-action-runner.mjs";
import { CoordinatorStore, coordinatorCommitmentDigest } from "../../lib/coordinator-store.mjs";
import { bindSmokeContractIntent } from "./contract-intent-smoke-fixture.mjs";
import { invoiceDigest } from "../../lib/lnd-rest-client.mjs";
import {
  SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
  SOLVER_DAEMON_EVIDENCE_SCHEMA,
  buildSolverDaemonEvidenceApproval,
  solverDaemonEvidencePolicyDigest,
  verifySolverDaemonEvidence,
} from "../../lib/solver-daemon-evidence.mjs";
import {
  createTestAuthenticatedPrivatePacketClient,
  executeSolverDaemonStep,
} from "../../lib/solver-daemon-runtime.mjs";
import { buildSignedPrivatePacketResponse } from "../../lib/solver-private-packet.mjs";
import { Wallet, id } from "ethers";

const BYTES32 = /^0x[0-9a-f]{64}$/;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function randomHash() {
  return `0x${randomBytes(32).toString("hex")}`;
}

function paymentHashFor(preimage) {
  return `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
}

async function databaseContains(databasePath, needles) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const bytes = await readFile(`${databasePath}${suffix}`);
      if (needles.some((needle) => bytes.includes(needle))) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
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
const responsePublicKey = createPublicKey(await readFile(required("PAYER_ADAPTER_RESPONSE_PUBLIC_KEY_PATH")));
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
const databasePath = required("COORDINATOR_DATABASE_PATH");
let store = await CoordinatorStore.open(databasePath);
store.acceptSettlement(settlement);
const quoteId = randomHash();
const boundSettlement = await bindSmokeContractIntent({ store, settlement, quoteId });
const observedReservation = {
  settlementId: settlement.settlementId,
  reservationId: quoteId,
  reservationTxHash: randomHash(),
  reservationBlockNumber: 1,
  reservationBlockHash: randomHash(),
  reservationIntentDigest: boundSettlement.contractIntentDigest,
  observedAt: now + 1,
};
store.recordReservation(observedReservation);

const packetRequesterKeys = generateKeyPairSync("ed25519");
const packetProviderKeys = generateKeyPairSync("ed25519");
const evidenceLightningOperator = Wallet.createRandom();
const evidenceSecurityReviewer = Wallet.createRandom();
const evidencePolicy = {
  schema: SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
  releaseRecordDigest: randomHash(),
  chainId: "31337",
  settlementContract: "0x1111111111111111111111111111111111111111",
  settlementContractCodeHash: randomHash(),
  solver: Wallet.createRandom().address,
  direction: settlement.direction,
  approvers: {
    lightningOperator: evidenceLightningOperator.address,
    securityReviewer: evidenceSecurityReviewer.address,
  },
  maxEvidenceAgeSeconds: 30,
  maxEvidenceLifetimeSeconds: 30,
  maxClockSkewSeconds: 2,
};
const consumedPacketRequests = new Set();
const packetClient = createTestAuthenticatedPrivatePacketClient({
  providerOrigin: "https://private-packet-provider.internal",
  requesterPrivateKey: packetRequesterKeys.privateKey,
  requesterKeyId: "coordinator-regtest",
  providerPublicKey: packetProviderKeys.publicKey,
  providerKeyId: "packet-provider-regtest",
  minimumEvmSafetySeconds: 600,
  requestTtlSeconds: 15,
  nowSeconds: () => Math.floor(Date.now() / 1_000),
  randomBytesImpl: randomBytes,
  requestImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    const servedAt = Math.floor(Date.now() / 1_000);
    const binding = request.payload;
    const packet = {
      settlementId: binding.settlementId,
      reservationId: binding.reservationId,
      actionId: binding.actionId,
      payloadDigest: binding.payloadDigest,
      purpose: binding.purpose,
      direction: binding.direction,
      intentDigest: binding.intentDigest,
      paymentHash: binding.paymentHash,
      invoiceDigest: binding.invoiceDigest,
      quoteReceiptDigest: binding.quoteReceiptDigest,
      selectedSetDigest: binding.selectedSetDigest,
      selectedOfferId: binding.selectedOfferId,
      capacityEpoch: binding.capacityEpoch,
      quoteExpiresAt: servedAt + 60,
      lightningActionDeadline: servedAt + 120,
      evmRefundAt: servedAt + 720,
      operation: {
        paymentRequest: input.paymentRequest,
        timeoutSeconds: 30,
        feeLimitSats: "10",
      },
    };
    const signed = await buildSignedPrivatePacketResponse({
      requestEnvelope: request,
      requesterPublicKey: packetRequesterKeys.publicKey,
      expectedRequesterKeyId: "coordinator-regtest",
      packet,
      providerKeyId: "packet-provider-regtest",
      providerPrivateKey: packetProviderKeys.privateKey,
      consumeRequest: async ({ requestId }) => {
        if (consumedPacketRequests.has(requestId)) return false;
        consumedPacketRequests.add(requestId);
        return true;
      },
      servedAt,
      expiresAt: servedAt + 10,
      minimumEvmSafetySeconds: 600,
    });
    return new Response(JSON.stringify(signed), {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  },
});

const controls = {
  authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => {
    const observedAt = Math.floor(Date.now() / 1_000);
    const record = {
      schema: SOLVER_DAEMON_EVIDENCE_SCHEMA,
      kind: "LIGHTNING_DISPATCH",
      releaseRecordDigest: evidencePolicy.releaseRecordDigest,
      evidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
      chainId: evidencePolicy.chainId,
      settlementContract: evidencePolicy.settlementContract,
      settlementContractCodeHash: evidencePolicy.settlementContractCodeHash,
      solver: evidencePolicy.solver,
      direction: current.direction,
      settlementId: current.settlementId,
      reservationId: current.reservationId,
      reservationTxHash: current.reservationTxHash,
      reservationBlockNumber: current.reservationBlockNumber,
      reservationBlockHash: current.reservationBlockHash,
      actionId: action.actionId,
      intentDigest: action.intentDigest,
      packetResponseDigest,
      quoteExpiresAt: packet.quoteExpiresAt,
      lightningActionDeadline: packet.lightningActionDeadline,
      evmRefundAt: packet.evmRefundAt,
      terminalState: "NONE",
      proofDigest: id(JSON.stringify({
        settlementId: current.settlementId,
        reservationBlockHash: current.reservationBlockHash,
        actionId: action.actionId,
        packetResponseDigest,
      })).toLowerCase(),
      observedAt,
      expiresAt: observedAt + 10,
    };
    const payload = buildSolverDaemonEvidenceApproval({ record, policy: evidencePolicy });
    const approvals = await Promise.all([
      ["lightningOperator", evidenceLightningOperator],
      ["securityReviewer", evidenceSecurityReviewer],
    ].map(async ([role, wallet]) => ({
      role,
      signer: wallet.address,
      signature: await wallet.signTypedData(payload.domain, payload.types, payload.message),
    })));
    return verifySolverDaemonEvidence({ record, policy: evidencePolicy, approvals, now: observedAt });
  },
};

let responseWasLost = false;
let lastAdapterObservation = null;
const lightning = {
    privateKey,
    keyId: required("COORDINATOR_KEY_ID"),
    adapterUrl: "http://payer-adapter:3000",
    responsePublicKey,
    responseKeyId: required("PAYER_ADAPTER_RESPONSE_KEY_ID"),
    nowSeconds: () => Math.floor(Date.now() / 1_000),
    requestImpl: async (url, options) => {
      const response = await fetch(url, options);
      const body = await response.clone().json();
      const method = JSON.parse(options.body).payload.method;
      lastAdapterObservation = {
        status: response.status,
        schema: String(body?.payload?.schema ?? "none"),
        responseKeyId: String(body?.payload?.keyId ?? "none"),
        resultStatus: String(body?.payload?.body?.result?.status ?? "none"),
        errorCode: String(body?.payload?.body?.errorCode ?? "none"),
        error: String(body?.payload?.body?.error ?? "none").slice(0, 120),
        ambiguous: body?.payload?.body?.ambiguous === true,
      };
      if (method === "/routerrpc.Router/SendPaymentV2"
          && response.ok && body?.payload?.body?.result?.status === "SUCCEEDED") {
        responseWasLost = true;
        throw new Error("simulated loss after successful adapter response");
      }
      return response;
    },
};

const planned = await executeSolverDaemonStep({
  store,
  settlementId: settlement.settlementId,
  expectedEvidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
  packetClient,
  controls,
  lightning,
});
if (planned.outcome !== "ACTION_PLANNED") throw new Error("daemon did not plan the live payment action");
const action = store.getAction(planned.actionId);
const ambiguous = await executeSolverDaemonStep({
  store,
  settlementId: settlement.settlementId,
  expectedEvidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
  packetClient,
  controls,
  lightning,
});
if (!responseWasLost || ambiguous.outcome !== "DISPATCH_AMBIGUOUS") {
  throw new Error(
    `daemon did not preserve the lost payment response as ambiguous: responseWasLost=${responseWasLost}, outcome=${ambiguous.outcome}, actionState=${store.getAction(action.actionId)?.state}, adapter=${JSON.stringify(lastAdapterObservation)}`,
  );
}
if (store.getAction(action.actionId)?.state !== "UNKNOWN") throw new Error("lost response did not enter UNKNOWN");
store.close();

store = await CoordinatorStore.open(databasePath);
if (store.recoverInterruptedActions(Math.floor(Date.now() / 1_000)) !== 0) {
  throw new Error("UNKNOWN action was incorrectly treated as a fresh dispatch");
}
let reconciled;
for (let attempt = 0; attempt < 40; attempt += 1) {
  reconciled = await executeSolverDaemonStep({
    store,
    settlementId: settlement.settlementId,
    expectedEvidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
    packetClient,
    controls,
    lightning,
  });
  if (reconciled.disposition !== "unresolved") break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const reconciledAction = store.getAction(action.actionId);
if (reconciled.disposition !== "confirmed" || reconciledAction.dispatchCount !== 1) {
  throw new Error(
    `read-only reconciliation did not confirm exactly one dispatch: disposition=${reconciled.disposition}, actionState=${reconciledAction.state}, dispatchCount=${reconciledAction.dispatchCount}`,
  );
}
store.close();
store = await CoordinatorStore.open(databasePath);
const restartedProof = await readConfirmedLightningPaymentProof({
  store,
  actionId: action.actionId,
  requestId: randomHash(),
  privateKey,
  keyId: required("COORDINATOR_KEY_ID"),
  adapterUrl: "http://payer-adapter:3000",
  responsePublicKey,
  responseKeyId: required("PAYER_ADAPTER_RESPONSE_KEY_ID"),
  nowSeconds: () => Math.floor(Date.now() / 1_000),
  requestImpl: fetch,
});
const recoveredPreimage = restartedProof.preimage;
if (!BYTES32.test(String(recoveredPreimage)) || paymentHashFor(recoveredPreimage) !== paymentHash) {
  throw new Error("confirmed payment proof did not match after coordinator restart");
}
store.close();
if (await databaseContains(databasePath, [
  Buffer.from(input.paymentRequest),
  Buffer.from(recoveredPreimage),
  Buffer.from(recoveredPreimage.slice(2), "hex"),
])) {
  throw new Error("coordinator persisted the raw invoice or payment preimage");
}

const evidence = {
  schema: "treeswap.coordinator-regtest-smoke.v1",
  status: "passed",
  amountSats: input.amountSats,
  simulatedBoundary: "finalized-reservation-observation",
  lostResponseState: "UNKNOWN",
  reconciliationState: "CONFIRMED",
  dispatchCount: 1,
  daemonRuntime: true,
  dualSignedDaemonEvidence: true,
  authenticatedPrivatePacket: true,
  rawInvoicePersisted: false,
  rawPreimagePersisted: false,
  evidenceDigest: coordinatorCommitmentDigest({
    schema: "treeswap.coordinator-regtest-smoke.v1",
    status: "passed",
    amountSats: input.amountSats,
    dispatchCount: 1,
    daemonRuntime: true,
    dualSignedDaemonEvidence: true,
    authenticatedPrivatePacket: true,
    rawInvoicePersisted: false,
    rawPreimagePersisted: false,
  }),
};
process.stdout.write(`${JSON.stringify(evidence)}\n`);
