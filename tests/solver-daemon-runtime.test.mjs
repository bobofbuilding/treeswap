import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Transaction, Wallet, id, keccak256, sha256 } from "ethers";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import { evmClaimActionCommitment } from "../lib/evm-action-runner.mjs";
import { invoiceDigest } from "../lib/lnd-rest-client.mjs";
import {
  SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
  SOLVER_DAEMON_EVIDENCE_SCHEMA,
  SOLVER_DAEMON_ZERO_BYTES32,
  buildSolverDaemonEvidenceApproval,
  solverDaemonEvidencePolicyDigest,
  verifySolverDaemonEvidence,
} from "../lib/solver-daemon-evidence.mjs";
import {
  authenticatedPrivatePacketClientTransportMode,
  createAuthenticatedPrivatePacketClient,
  executeSolverDaemonStep,
} from "../lib/solver-daemon-runtime.mjs";
import { nextSolverDaemonStep } from "../lib/solver-daemon-planner.mjs";
import { buildSignedPrivatePacketResponse } from "../lib/solver-private-packet.mjs";

const NOW = 2_000_000_000;
const SEND_PAYMENT = "/routerrpc.Router/SendPaymentV2";
const SETTLE_INVOICE = "/invoicesrpc.Invoices/SettleInvoice";
const CHAIN_ID = 31_337n;
const CONTRACT = "0x4444444444444444444444444444444444444444";
const CONTRACT_CODE = "0x60006000";
const CONTRACT_CODE_HASH = keccak256(CONTRACT_CODE).toLowerCase();
const MAXIMUM_GAS_COST_WEI = 1_000_000_000_000_000n;
const signer = new Wallet(`0x${"11".repeat(32)}`);
const PREIMAGE = `0x${"22".repeat(32)}`;
const PAYMENT_HASH = sha256(PREIMAGE).toLowerCase();
const PAYMENT_REQUEST = "lnbcrt100u1solverdaemonruntime";
const CLAIMED_TOPIC = id("Claimed(bytes32,address,uint256,uint256)").toLowerCase();
const lightningKeys = generateKeyPairSync("ed25519");
const packetRequesterKeys = generateKeyPairSync("ed25519");
const packetProviderKeys = generateKeyPairSync("ed25519");
const evidenceLightningOperator = new Wallet(`0x${"31".repeat(32)}`);
const evidenceSecurityReviewer = new Wallet(`0x${"32".repeat(32)}`);

function hash(label) {
  return id(label).toLowerCase();
}

function settlement(label, direction) {
  return {
    settlementId: hash(`${label}:settlement`),
    pricingId: hash(`${label}:pricing`),
    direction,
    nonceAuthorityDigest: hash(`${label}:nonce-authority`),
    intentNonce: "7",
    intentDigest: hash(`${label}:intent`),
    paymentHash: PAYMENT_HASH,
    invoiceDigest: invoiceDigest(PAYMENT_REQUEST),
    amountSats: "10000",
    quoteReceiptDigest: hash(`${label}:quote-receipt`),
    selectedSetDigest: hash(`${label}:selected-set`),
    selectedOfferId: hash(`${label}:selected-offer`),
    capacityEpoch: 9,
    createdAt: NOW,
  };
}

function reservation(value) {
  return {
    settlementId: value.settlementId,
    reservationId: hash(`${value.settlementId}:reservation`),
    reservationTxHash: hash(`${value.settlementId}:reservation-transaction`),
    reservationBlockNumber: 100,
    reservationBlockHash: hash(`${value.settlementId}:reservation-block`),
    reservationIntentDigest: value.intentDigest,
    observedAt: NOW + 1,
  };
}

async function openStore(label, direction, { path = ":memory:" } = {}) {
  const store = await CoordinatorStore.open(path, { allowMemory: path === ":memory:" });
  const value = settlement(label, direction);
  store.acceptSettlement(value);
  store.recordReservation(reservation(value));
  return { store, value };
}

function claimTemplate(value) {
  return {
    chainId: CHAIN_ID.toString(),
    contract: CONTRACT,
    contractCodeHash: CONTRACT_CODE_HASH,
    nonce: "3",
    gasLimit: "150000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "100000000",
    value: "0",
    quoteId: reservation(value).reservationId,
  };
}

function packetClient(value) {
  let reads = 0;
  const authenticated = createAuthenticatedPrivatePacketClient({
    providerOrigin: "https://packet-provider.internal",
    requesterPrivateKey: packetRequesterKeys.privateKey,
    requesterKeyId: "daemon-requester-test",
    providerPublicKey: packetProviderKeys.publicKey,
    providerKeyId: "packet-provider-test",
    minimumEvmSafetySeconds: 600,
    requestTtlSeconds: 15,
    nowSeconds: () => NOW + 10,
    randomBytesImpl: randomSource(),
    async requestImpl(_url, options) {
      const request = JSON.parse(options.body);
      const binding = request.payload;
      const operation = binding.purpose === "SEND_PAYMENT"
        ? { paymentRequest: PAYMENT_REQUEST, timeoutSeconds: 30, feeLimitSats: "5" }
        : binding.purpose === "SETTLE_INVOICE"
          ? { preimage: PREIMAGE }
          : claimTemplate(value);
      const privatePacket = {
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
        quoteExpiresAt: NOW + 1_500,
        lightningActionDeadline: NOW + 1_000,
        evmRefundAt: NOW + 2_000,
        operation,
      };
      const signed = buildSignedPrivatePacketResponse({
        requestEnvelope: request,
        requesterPublicKey: packetRequesterKeys.publicKey,
        expectedRequesterKeyId: "daemon-requester-test",
        packet: privatePacket,
        providerKeyId: "packet-provider-test",
        providerPrivateKey: packetProviderKeys.privateKey,
        servedAt: NOW + 10,
        expiresAt: NOW + 20,
        minimumEvmSafetySeconds: 600,
      });
      return new Response(JSON.stringify(signed), {
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      });
    },
  });
  return {
    get reads() { return reads; },
    async read(input) {
      reads += 1;
      assert.equal(input.settlement.settlementId, value.settlementId);
      return authenticated.read(input);
    },
  };
}

function lightningAdapter() {
  let calls = 0;
  const config = {
    privateKey: lightningKeys.privateKey,
    keyId: "coordinator-daemon-test",
    adapterUrl: "http://lightning-adapter.internal:3000",
    nowSeconds: () => NOW + 10,
    async requestImpl(_url, options) {
      calls += 1;
      const method = JSON.parse(options.body).payload.method;
      if (method === SEND_PAYMENT || method === "/routerrpc.Router/TrackPaymentV2") {
        return new Response(JSON.stringify({
          result: {
            status: "SUCCEEDED",
            paymentHash: PAYMENT_HASH,
            amountSats: "10000",
            feeSats: "2",
            preimage: PREIMAGE,
          },
          audit: { decision: "allow" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === SETTLE_INVOICE) {
        return new Response(JSON.stringify({ result: { state: "SETTLED" }, audit: { decision: "allow" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { config, get calls() { return calls; } };
}

function evidencePolicy(direction) {
  return {
    schema: SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
    releaseRecordDigest: hash("solver daemon test release"),
    chainId: CHAIN_ID.toString(),
    settlementContract: CONTRACT,
    settlementContractCodeHash: CONTRACT_CODE_HASH,
    solver: signer.address,
    direction,
    approvers: {
      lightningOperator: evidenceLightningOperator.address,
      securityReviewer: evidenceSecurityReviewer.address,
    },
    maxEvidenceAgeSeconds: 120,
    maxEvidenceLifetimeSeconds: 120,
    maxClockSkewSeconds: 2,
  };
}

async function verifiedEvidence(value, evidencePolicyValue, { verifyAt = NOW + 10 } = {}) {
  const payload = buildSolverDaemonEvidenceApproval({ record: value, policy: evidencePolicyValue });
  const approvals = await Promise.all([
    ["lightningOperator", evidenceLightningOperator],
    ["securityReviewer", evidenceSecurityReviewer],
  ].map(async ([role, wallet]) => ({
    role,
    signer: wallet.address,
    signature: await wallet.signTypedData(payload.domain, payload.types, payload.message),
  })));
  return verifySolverDaemonEvidence({ record: value, policy: evidencePolicyValue, approvals, now: verifyAt });
}

function baseEvidence(kind, settlementValue, overrides = {}) {
  const policy = evidencePolicy(settlementValue.direction);
  const dispatch = kind === "LIGHTNING_DISPATCH" || kind === "EVM_CLAIM_DISPATCH";
  return {
    policy,
    record: {
      schema: SOLVER_DAEMON_EVIDENCE_SCHEMA,
      kind,
      releaseRecordDigest: policy.releaseRecordDigest,
      evidencePolicyDigest: solverDaemonEvidencePolicyDigest(policy),
      chainId: policy.chainId,
      settlementContract: policy.settlementContract,
      settlementContractCodeHash: policy.settlementContractCodeHash,
      solver: policy.solver,
      direction: settlementValue.direction,
      settlementId: settlementValue.settlementId,
      reservationId: settlementValue.reservationId,
      reservationTxHash: settlementValue.reservationTxHash,
      reservationBlockNumber: settlementValue.reservationBlockNumber,
      reservationBlockHash: settlementValue.reservationBlockHash,
      actionId: dispatch ? hash(`${settlementValue.settlementId}:placeholder-action`) : SOLVER_DAEMON_ZERO_BYTES32,
      intentDigest: settlementValue.intentDigest,
      packetResponseDigest: dispatch ? hash(`${settlementValue.settlementId}:placeholder-packet`) : SOLVER_DAEMON_ZERO_BYTES32,
      quoteExpiresAt: dispatch ? NOW + 1_500 : 0,
      lightningActionDeadline: dispatch ? NOW + 1_000 : 0,
      evmRefundAt: dispatch ? NOW + 2_000 : 0,
      terminalState: kind === "TERMINAL_COMPLETED" ? "COMPLETED"
        : kind === "TERMINAL_REFUNDED" ? "REFUNDED" : "NONE",
      proofDigest: hash(`${settlementValue.settlementId}:${kind}:evidence`),
      observedAt: NOW + 9,
      expiresAt: NOW + 100,
      ...overrides,
    },
  };
}

async function authorization(
  action,
  settlementValue,
  packetResponseDigest,
  packet,
  overrides = {},
  evidenceKind = "LIGHTNING_DISPATCH",
) {
  const evidence = baseEvidence(evidenceKind, settlementValue, {
    actionId: action.actionId,
    intentDigest: action.intentDigest,
    packetResponseDigest,
    quoteExpiresAt: packet.quoteExpiresAt,
    lightningActionDeadline: packet.lightningActionDeadline,
    evmRefundAt: packet.evmRefundAt,
    ...overrides,
  });
  return verifiedEvidence(evidence.record, evidence.policy);
}

async function terminalEvidence(settlementValue, terminalState, overrides = {}) {
  const kind = terminalState === "COMPLETED" ? "TERMINAL_COMPLETED" : "TERMINAL_REFUNDED";
  const evidence = baseEvidence(kind, settlementValue, overrides);
  return verifiedEvidence(evidence.record, evidence.policy);
}

function randomSource() {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Buffer.alloc(size, counter);
  };
}

function runtimeArgs(fixture, extras = {}) {
  return {
    store: fixture.store,
    settlementId: fixture.value.settlementId,
    expectedEvidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy(fixture.value.direction)),
    nowSeconds: () => NOW + 10,
    randomBytesImpl: randomSource(),
    ...extras,
  };
}

test("brands fixed and injected private-packet transports without transferable provenance", () => {
  const input = {
    providerOrigin: "https://packet-provider.internal",
    requesterPrivateKey: packetRequesterKeys.privateKey,
    requesterKeyId: "daemon-transport-test",
    providerPublicKey: packetProviderKeys.publicKey,
    providerKeyId: "packet-provider-transport-test",
    minimumEvmSafetySeconds: 600,
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
    nowSeconds: () => NOW,
    randomBytesImpl: randomSource(),
  };
  const fixed = createAuthenticatedPrivatePacketClient(input);
  assert.equal(authenticatedPrivatePacketClientTransportMode(fixed), "fixed-node-https");
  assert.throws(
    () => authenticatedPrivatePacketClientTransportMode({ ...fixed }),
    /factory provenance/,
  );

  const injected = createAuthenticatedPrivatePacketClient({
    ...input,
    requestImpl: async () => { throw new Error("test-only transport"); },
  });
  assert.equal(authenticatedPrivatePacketClientTransportMode(injected), "injected-test");
});

function hexQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function rpcTransaction(raw) {
  const parsed = Transaction.from(raw);
  return {
    type: "0x2",
    hash: parsed.hash.toLowerCase(),
    from: parsed.from,
    to: parsed.to,
    nonce: hexQuantity(parsed.nonce),
    gas: hexQuantity(parsed.gasLimit),
    maxFeePerGas: hexQuantity(parsed.maxFeePerGas),
    maxPriorityFeePerGas: hexQuantity(parsed.maxPriorityFeePerGas),
    value: "0x0",
    chainId: hexQuantity(parsed.chainId),
    input: parsed.data,
  };
}

function evmHarness(value) {
  let rawTransaction = null;
  const blockHash = hash(`${value.settlementId}:claim-block`);
  const rpcRequestImpl = async ({ method, params }) => {
    if (method === "eth_chainId") return hexQuantity(CHAIN_ID);
    if (method === "eth_getCode") return CONTRACT_CODE;
    if (method === "eth_sendRawTransaction") {
      rawTransaction = params[0];
      return Transaction.from(rawTransaction).hash.toLowerCase();
    }
    if (method === "eth_getTransactionByHash") return rawTransaction ? rpcTransaction(rawTransaction) : null;
    if (method === "eth_getTransactionReceipt") {
      if (!rawTransaction) return null;
      const parsed = Transaction.from(rawTransaction);
      return {
        transactionHash: parsed.hash.toLowerCase(),
        blockHash,
        blockNumber: "0x78",
        status: "0x1",
        logs: [{
          address: CONTRACT,
          transactionHash: parsed.hash.toLowerCase(),
          blockHash,
          topics: [
            CLAIMED_TOPIC,
            reservation(value).reservationId,
            `0x${"00".repeat(12)}${signer.address.slice(2).toLowerCase()}`,
          ],
          data: `0x${"00".repeat(64)}`,
        }],
      };
    }
    if (method === "eth_getBlockByNumber" && params[0] === "0x78") return { number: "0x78", hash: blockHash };
    if (method === "eth_getBlockByNumber" && params[0] === "finalized") return { number: "0x78", hash: blockHash };
    throw new Error(`unexpected RPC method ${method}`);
  };
  const config = {
    signer,
    expectedChainId: CHAIN_ID,
    expectedContract: CONTRACT,
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
    rpcUrl: "http://127.0.0.1:8545",
    rpcRequestImpl,
    reconciliationProviders: [
      { label: "provider-a", rpcUrl: "http://127.0.0.1:8545", rpcRequestImpl },
      { label: "provider-b", rpcUrl: "http://127.0.0.1:8546", rpcRequestImpl },
    ],
  };
  return { config, get rawTransaction() { return rawTransaction; } };
}

test("rechecks leadership after private evidence reads and before durable state changes", async (t) => {
  const fixture = await openStore("leadership-loss", "lightning-to-bit");
  t.after(() => fixture.store.close());
  const packets = packetClient(fixture.value);
  let guardedBoundary = null;
  await assert.rejects(executeSolverDaemonStep(runtimeArgs(fixture, {
    packetClient: packets,
    beforeSideEffect: async (boundary) => {
      guardedBoundary = boundary;
      throw new Error("coordinator supervisor no longer owns its lease");
    },
  })), /no longer owns its lease/);
  assert.equal(packets.reads, 1);
  assert.equal(guardedBoundary, "lightning-action-plan");
  assert.deepEqual(fixture.store.listSettlementActions(fixture.value.settlementId), []);
  assert.equal(nextSolverDaemonStep({ store: fixture.store, settlementId: fixture.value.settlementId }).kind,
    "PLAN_LIGHTNING_ACTION");
});

test("leadership loss after dispatch approval cannot claim or contact Lightning", async (t) => {
  const fixture = await openStore("dispatch-leadership-loss", "lightning-to-bit");
  t.after(() => fixture.store.close());
  const packets = packetClient(fixture.value);
  const adapter = lightningAdapter();
  const controls = {
    authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => authorization(
      action, current, packetResponseDigest, packet,
    ),
  };
  const planned = await executeSolverDaemonStep(runtimeArgs(fixture, {
    packetClient: packets,
    lightning: adapter.config,
    controls,
  }));
  let guardedBoundary = null;
  await assert.rejects(executeSolverDaemonStep(runtimeArgs(fixture, {
    packetClient: packets,
    lightning: adapter.config,
    controls,
    beforeSideEffect: async (boundary) => {
      guardedBoundary = boundary;
      throw new Error("coordinator supervisor no longer owns its lease");
    },
  })), /no longer owns its lease/);
  assert.equal(guardedBoundary, "lightning-dispatch-claim");
  assert.equal(adapter.calls, 0);
  assert.equal(fixture.store.getAction(planned.actionId).state, "PENDING");
  assert.equal(fixture.store.getAction(planned.actionId).dispatchCount, 0);
});

test("leadership loss after a durable claim cannot contact Lightning and recovers as unknown", async (t) => {
  const fixture = await openStore("claimed-dispatch-leadership-loss", "lightning-to-bit");
  t.after(() => fixture.store.close());
  const packets = packetClient(fixture.value);
  const adapter = lightningAdapter();
  const controls = {
    authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => authorization(
      action, current, packetResponseDigest, packet,
    ),
  };
  const planned = await executeSolverDaemonStep(runtimeArgs(fixture, {
    packetClient: packets,
    lightning: adapter.config,
    controls,
  }));
  const guardedBoundaries = [];
  await assert.rejects(executeSolverDaemonStep(runtimeArgs(fixture, {
    packetClient: packets,
    lightning: adapter.config,
    controls,
    beforeSideEffect: async (boundary) => {
      guardedBoundaries.push(boundary);
      if (boundary === "lightning-dispatch-send") {
        throw new Error("coordinator supervisor no longer owns its lease");
      }
    },
  })), /no longer owns its lease/);
  assert.deepEqual(guardedBoundaries, ["lightning-dispatch-claim", "lightning-dispatch-send"]);
  assert.equal(adapter.calls, 0);
  assert.equal(fixture.store.getAction(planned.actionId).state, "DISPATCHING");
  assert.equal(fixture.store.getAction(planned.actionId).dispatchCount, 1);
  assert.equal(nextSolverDaemonStep({ store: fixture.store, settlementId: fixture.value.settlementId }).kind,
    "RECOVER_INTERRUPTED_ACTION");
});

test("packet expiry during asynchronous dispatch approval halts before Lightning", async (t) => {
  const fixture = await openStore("dispatch-expiry-race", "lightning-to-bit");
  t.after(() => fixture.store.close());
  const packets = packetClient(fixture.value);
  const adapter = lightningAdapter();
  const controls = {
    authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => authorization(
      action, current, packetResponseDigest, packet,
    ),
  };
  const planned = await executeSolverDaemonStep(runtimeArgs(fixture, {
    packetClient: packets,
    lightning: adapter.config,
    controls,
  }));
  let clockReads = 0;
  const halted = await executeSolverDaemonStep(runtimeArgs(fixture, {
    packetClient: packets,
    lightning: adapter.config,
    controls,
    nowSeconds: () => (clockReads++ === 0 ? NOW + 10 : NOW + 20),
  }));
  assert.equal(halted.outcome, "HALTED");
  assert.equal(halted.haltCode, "DAEMON_AUTH_MISMATCH");
  assert.equal(adapter.calls, 0);
  assert.equal(fixture.store.getAction(planned.actionId).state, "PENDING");
});

test("runs Lightning-to-BIT through exact packet dispatch and terminal asset proof without persisting the preimage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-daemon-invoice-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await openStore("invoice-flow", "lightning-to-bit", { path: join(directory, "coordinator.sqlite") });
  t.after(() => { try { fixture.store.close(); } catch {} });
  const packets = packetClient(fixture.value);
  const adapter = lightningAdapter();
  const controls = {
    authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => authorization(
      action, current, packetResponseDigest, packet,
    ),
    verifyAssets: async ({ settlement: current }) => terminalEvidence(current, "COMPLETED", {
      proofDigest: hash("invoice:complete"),
    }),
  };

  const planned = await executeSolverDaemonStep(runtimeArgs(fixture, { packetClient: packets, lightning: adapter.config, controls }));
  assert.equal(planned.outcome, "ACTION_PLANNED");
  const dispatched = await executeSolverDaemonStep(runtimeArgs(fixture, { packetClient: packets, lightning: adapter.config, controls }));
  assert.equal(dispatched.outcome, "DISPATCH_CONFIRMED");
  assert.equal(fixture.store.getAction(planned.actionId).dispatchCount, 1);
  const completed = await executeSolverDaemonStep(runtimeArgs(fixture, { packetClient: packets, lightning: adapter.config, controls }));
  assert.equal(completed.terminalState, "COMPLETED");
  assert.equal(fixture.store.getSettlement(fixture.value.settlementId).terminalState, "COMPLETED");
  assert.equal(Object.hasOwn(dispatched, "preimage"), false);

  fixture.store.close();
  const bytes = [];
  for (const file of await readdir(directory)) bytes.push(await readFile(join(directory, file)));
  const storage = Buffer.concat(bytes).toString("utf8");
  assert.equal(storage.includes(PREIMAGE.slice(2)), false);
  assert.equal(storage.includes(PAYMENT_REQUEST), false);
});

test("recovers an unbound EVM action, broadcasts exact bytes, reconciles finality, and completes", async (t) => {
  const fixture = await openStore("payment-flow", "bit-to-lightning");
  t.after(() => fixture.store.close());
  const packets = packetClient(fixture.value);
  const adapter = lightningAdapter();
  const evm = evmHarness(fixture.value);
  const controls = {
    authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => authorization(
      action, current, packetResponseDigest, packet,
    ),
    authorizeEvmClaim: async ({ action, settlement: current, packet, packetResponseDigest }) => authorization(
      action, current, packetResponseDigest, packet, {}, "EVM_CLAIM_DISPATCH",
    ),
    verifyAssets: async ({ settlement: current }) => terminalEvidence(current, "COMPLETED", {
      proofDigest: hash("payment:complete"),
    }),
  };
  const common = { packetClient: packets, lightning: adapter.config, evm: evm.config, controls };

  const plannedPayment = await executeSolverDaemonStep(runtimeArgs(fixture, common));
  await executeSolverDaemonStep(runtimeArgs(fixture, common));
  assert.equal(fixture.store.getAction(plannedPayment.actionId).state, "CONFIRMED");

  const operation = { ...claimTemplate(fixture.value), preimage: PREIMAGE };
  const claim = {
    actionId: hash("payment-flow:claim-action"),
    settlementId: fixture.value.settlementId,
    method: "evm:claim",
    requestId: hash("payment-flow:claim-request"),
    payloadDigest: hash("placeholder"),
    intentDigest: fixture.value.intentDigest,
    paymentHash: fixture.value.paymentHash,
    invoiceDigest: fixture.value.invoiceDigest,
    amountSats: fixture.value.amountSats,
    capacityEpoch: fixture.value.capacityEpoch,
    plannedAt: NOW + 5,
  };
  claim.payloadDigest = evmClaimActionCommitment(claim, operation, signer.address);
  fixture.store.planAction(claim);
  assert.equal(nextSolverDaemonStep({ store: fixture.store, settlementId: fixture.value.settlementId }).kind, "PREPARE_EVM_CLAIM_TRANSACTION");

  const recovered = await executeSolverDaemonStep(runtimeArgs(fixture, common));
  assert.equal(recovered.outcome, "EVM_CLAIM_PREPARED");
  assert.ok(fixture.store.getEvmTransaction(claim.actionId));
  assert.equal(nextSolverDaemonStep({ store: fixture.store, settlementId: fixture.value.settlementId }).kind, "DISPATCH_EVM_CLAIM");

  const broadcast = await executeSolverDaemonStep(runtimeArgs(fixture, common));
  assert.equal(broadcast.outcome, "EVM_BROADCAST_UNPROVEN");
  assert.equal(broadcast.actionState, "UNKNOWN");
  assert.ok(evm.rawTransaction);

  const reconciled = await executeSolverDaemonStep(runtimeArgs(fixture, common));
  assert.equal(reconciled.disposition, "confirmed");
  assert.equal(reconciled.actionState, "CONFIRMED");
  assert.match(reconciled.providerConsensusDigest, /^0x[0-9a-f]{64}$/);
  const completed = await executeSolverDaemonStep(runtimeArgs(fixture, common));
  assert.equal(completed.terminalState, "COMPLETED");
  assert.equal(Object.hasOwn(broadcast, "preimage"), false);
});

test("halts before dispatch when an authorization changes the action binding", async (t) => {
  const fixture = await openStore("authorization-mismatch", "lightning-to-bit");
  t.after(() => fixture.store.close());
  const packets = packetClient(fixture.value);
  const adapter = lightningAdapter();
  const controls = {
    authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => authorization(
      action,
      current,
      packetResponseDigest,
      packet,
      { actionId: hash("wrong-action") },
    ),
  };
  const common = { packetClient: packets, lightning: adapter.config, controls };
  await executeSolverDaemonStep(runtimeArgs(fixture, common));
  const halted = await executeSolverDaemonStep(runtimeArgs(fixture, common));
  assert.equal(halted.outcome, "HALTED");
  assert.equal(halted.haltCode, "DAEMON_AUTH_MISMATCH");
  assert.equal(adapter.calls, 0);
  assert.equal(fixture.store.getSettlement(fixture.value.settlementId).haltCode, "DAEMON_AUTH_MISMATCH");
});

test("rejects nominal, copied, and exactly expired dispatch evidence before any adapter call", async (t) => {
  for (const mode of ["nominal", "copied", "expired", "wrong-policy"]) {
    const fixture = await openStore(`dispatch-provenance-${mode}`, "lightning-to-bit");
    t.after(() => fixture.store.close());
    const packets = packetClient(fixture.value);
    const adapter = lightningAdapter();
    await executeSolverDaemonStep(runtimeArgs(fixture, { packetClient: packets, lightning: adapter.config }));
    const controls = {
      authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => {
        const evidence = baseEvidence("LIGHTNING_DISPATCH", current, {
          actionId: action.actionId,
          intentDigest: action.intentDigest,
          packetResponseDigest,
          quoteExpiresAt: packet.quoteExpiresAt,
          lightningActionDeadline: packet.lightningActionDeadline,
          evmRefundAt: packet.evmRefundAt,
          ...(mode === "expired" ? { observedAt: NOW + 8, expiresAt: NOW + 10 } : {}),
        });
        if (mode === "nominal") return evidence.record;
        if (mode === "wrong-policy") {
          const wrongPolicy = {
            ...evidence.policy,
            releaseRecordDigest: hash("wrong active daemon release"),
          };
          const wrongRecord = {
            ...evidence.record,
            releaseRecordDigest: wrongPolicy.releaseRecordDigest,
            evidencePolicyDigest: solverDaemonEvidencePolicyDigest(wrongPolicy),
          };
          return verifiedEvidence(wrongRecord, wrongPolicy);
        }
        const verified = await verifiedEvidence(evidence.record, evidence.policy, {
          verifyAt: mode === "expired" ? NOW + 9 : NOW + 10,
        });
        return mode === "copied" ? { ...verified } : verified;
      },
    };
    const halted = await executeSolverDaemonStep(runtimeArgs(fixture, {
      packetClient: packets,
      lightning: adapter.config,
      controls,
    }));
    assert.equal(halted.outcome, "HALTED");
    assert.equal(halted.haltCode, "DAEMON_AUTH_MISMATCH");
    assert.equal(adapter.calls, 0);
  }
});

test("records only original dual-signed reservation evidence and rejects a nominal copy", async (t) => {
  for (const valid of [true, false]) {
    const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
    t.after(() => store.close());
    const value = settlement(`reservation-evidence-${valid}`, "lightning-to-bit");
    store.acceptSettlement(value);
    const observed = reservation(value);
    const bound = { ...value, ...observed };
    const controls = {
      observeReservation: async () => {
        const evidence = baseEvidence("RESERVATION", bound, { proofDigest: hash(`reservation-proof-${valid}`) });
        return valid ? verifiedEvidence(evidence.record, evidence.policy) : evidence.record;
      },
    };
    const result = await executeSolverDaemonStep({
      store,
      settlementId: value.settlementId,
      controls,
      expectedEvidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy(value.direction)),
      nowSeconds: () => NOW + 10,
    });
    if (valid) {
      assert.equal(result.outcome, "RESERVATION_RECORDED");
      assert.equal(store.getSettlement(value.settlementId).reservationId, observed.reservationId);
    } else {
      assert.equal(result.outcome, "HALTED");
      assert.equal(result.haltCode, "DAEMON_RESERVATION_EVIDENCE");
      assert.equal(store.getSettlement(value.settlementId).reservationId, null);
    }
  }
});

test("rejects nominal both-assets completion evidence and does not create completed history", async (t) => {
  const fixture = await openStore("nominal-terminal-proof", "lightning-to-bit");
  t.after(() => fixture.store.close());
  const packets = packetClient(fixture.value);
  const adapter = lightningAdapter();
  const controls = {
    authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => authorization(
      action, current, packetResponseDigest, packet,
    ),
    verifyAssets: async ({ settlement: current }) => baseEvidence("TERMINAL_COMPLETED", current).record,
  };
  await executeSolverDaemonStep(runtimeArgs(fixture, { packetClient: packets, lightning: adapter.config, controls }));
  await executeSolverDaemonStep(runtimeArgs(fixture, { packetClient: packets, lightning: adapter.config, controls }));
  const halted = await executeSolverDaemonStep(runtimeArgs(fixture, { packetClient: packets, lightning: adapter.config, controls }));
  assert.equal(halted.outcome, "HALTED");
  assert.equal(halted.haltCode, "DAEMON_ASSET_MISMATCH");
  assert.equal(fixture.store.getSettlement(fixture.value.settlementId).terminalState, null);
});

test("rejects an unverified packet result before planning any action", async (t) => {
  const fixture = await openStore("unverified-packet", "lightning-to-bit");
  t.after(() => fixture.store.close());
  await assert.rejects(
    executeSolverDaemonStep(runtimeArgs(fixture, {
      packetClient: {
        async read() {
          return {
            responseDigest: hash("forged-response"),
            packet: { operation: { preimage: PREIMAGE } },
          };
        },
      },
    })),
    /not authenticated/,
  );
  assert.deepEqual(fixture.store.listSettlementActions(fixture.value.settlementId), []);
});

test("turns a lost dispatch response into one read-only reconciliation with no redispatch", async (t) => {
  const fixture = await openStore("ambiguous-payment", "bit-to-lightning");
  t.after(() => fixture.store.close());
  const packets = packetClient(fixture.value);
  const adapter = lightningAdapter();
  const normalRequest = adapter.config.requestImpl;
  let lost = false;
  adapter.config.requestImpl = async (url, options) => {
    const method = JSON.parse(options.body).payload.method;
    if (method === SEND_PAYMENT && !lost) {
      lost = true;
      throw new Error("response lost after dispatch");
    }
    return normalRequest(url, options);
  };
  const controls = {
    authorizeLightning: async ({ action, settlement: current, packet, packetResponseDigest }) => authorization(
      action, current, packetResponseDigest, packet,
    ),
  };
  const common = { packetClient: packets, lightning: adapter.config, controls };
  const planned = await executeSolverDaemonStep(runtimeArgs(fixture, common));
  const ambiguous = await executeSolverDaemonStep(runtimeArgs(fixture, common));
  assert.equal(ambiguous.outcome, "DISPATCH_AMBIGUOUS");
  assert.equal(fixture.store.getAction(planned.actionId).dispatchCount, 1);
  assert.equal(packets.reads, 2);

  const reconciled = await executeSolverDaemonStep(runtimeArgs(fixture, common));
  assert.equal(reconciled.actionState, "CONFIRMED");
  assert.equal(fixture.store.getAction(planned.actionId).dispatchCount, 1);
  assert.equal(packets.reads, 2);
});

test("recovers only the interrupted action owned by the selected settlement", async (t) => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  t.after(() => store.close());
  const first = settlement("scoped-first", "lightning-to-bit");
  const second = settlement("scoped-second", "lightning-to-bit");
  second.paymentHash = hash("scoped-second:unique-payment-hash");
  for (const value of [first, second]) {
    store.acceptSettlement(value);
    store.recordReservation(reservation(value));
    const operation = { preimage: PREIMAGE };
    const action = {
      actionId: hash(`${value.settlementId}:settle-action`),
      settlementId: value.settlementId,
      method: SETTLE_INVOICE,
      requestId: hash(`${value.settlementId}:request`),
      payloadDigest: hash(`${value.settlementId}:payload`),
      intentDigest: value.intentDigest,
      paymentHash: value.paymentHash,
      invoiceDigest: value.invoiceDigest,
      amountSats: value.amountSats,
      capacityEpoch: value.capacityEpoch,
      plannedAt: NOW + 2,
    };
    void operation;
    store.planAction(action);
    store.claimAction(action.actionId, NOW + 3);
  }
  const firstAction = store.listSettlementActions(first.settlementId)[0];
  const secondAction = store.listSettlementActions(second.settlementId)[0];
  const recovered = await executeSolverDaemonStep({
    store,
    settlementId: first.settlementId,
    nowSeconds: () => NOW + 4,
  });
  assert.equal(recovered.actionId, firstAction.actionId);
  assert.equal(store.getAction(firstAction.actionId).state, "UNKNOWN");
  assert.equal(store.getAction(secondAction.actionId).state, "DISPATCHING");
});
