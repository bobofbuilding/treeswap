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
import { createAuthenticatedPrivatePacketClient, executeSolverDaemonStep } from "../lib/solver-daemon-runtime.mjs";
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

function authorization(action, settlementValue, packetResponseDigest, packet, overrides = {}) {
  return {
    authorized: true,
    settlementId: settlementValue.settlementId,
    reservationId: settlementValue.reservationId,
    reservationBlockHash: settlementValue.reservationBlockHash,
    actionId: action.actionId,
    intentDigest: action.intentDigest,
    packetResponseDigest,
    quoteExpiresAt: packet.quoteExpiresAt,
    lightningActionDeadline: packet.lightningActionDeadline,
    evmRefundAt: packet.evmRefundAt,
    expiresAt: NOW + 100,
    evidenceDigest: hash(`${action.actionId}:authorization`),
    ...overrides,
  };
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
    nowSeconds: () => NOW + 10,
    randomBytesImpl: randomSource(),
    ...extras,
  };
}

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
    verifyAssets: async () => ({ assetsReconciled: true, terminalState: "COMPLETED", proofDigest: hash("invoice:complete") }),
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
      action, current, packetResponseDigest, packet,
    ),
    verifyAssets: async () => ({ assetsReconciled: true, terminalState: "COMPLETED", proofDigest: hash("payment:complete") }),
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
