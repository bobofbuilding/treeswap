import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Transaction, Wallet, id, keccak256, sha256 } from "ethers";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  dispatchEvmClaimAction,
  evmClaimActionCommitment,
  prepareEvmClaimAction,
  reconcileEvmClaimAction,
} from "../lib/evm-action-runner.mjs";

const NOW = 2_000_000_000;
const CHAIN_ID = 31_337n;
const CONTRACT = "0x4444444444444444444444444444444444444444";
const CONTRACT_CODE = "0x60006000";
const CONTRACT_CODE_HASH = keccak256(CONTRACT_CODE).toLowerCase();
const MAXIMUM_GAS_COST_WEI = 1_000_000_000_000_000n;
const signer = new Wallet(`0x${"11".repeat(32)}`);
const PREIMAGE = `0x${"22".repeat(32)}`;
const PAYMENT_HASH = sha256(PREIMAGE).toLowerCase();
const QUOTE_ID = id("evm-runner:quote").toLowerCase();
const CLAIMED_TOPIC = id("Claimed(bytes32,address,uint256,uint256)").toLowerCase();

function hash(label) {
  return id(label).toLowerCase();
}

function settlement(label = "evm") {
  return {
    settlementId: hash(`${label}:settlement`),
    pricingId: hash(`${label}:pricing`),
    direction: "lightning-to-bit",
    nonceAuthorityDigest: hash(`${label}:nonce-authority`),
    intentNonce: "7",
    intentDigest: hash(`${label}:intent`),
    paymentHash: PAYMENT_HASH,
    invoiceDigest: hash(`${label}:invoice`),
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
    reservationId: QUOTE_ID,
    reservationTxHash: hash(`${value.settlementId}:reservation-transaction`),
    reservationBlockNumber: 100,
    reservationBlockHash: hash(`${value.settlementId}:reservation-block`),
    reservationIntentDigest: value.intentDigest,
    observedAt: NOW + 1,
  };
}

function operation(overrides = {}) {
  return {
    chainId: CHAIN_ID,
    contract: CONTRACT,
    contractCodeHash: CONTRACT_CODE_HASH,
    nonce: 3n,
    gasLimit: 150_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    value: 0n,
    quoteId: QUOTE_ID,
    preimage: PREIMAGE,
    ...overrides,
  };
}

function action(value, op = operation()) {
  const pending = {
    actionId: hash(`${value.settlementId}:claim-action`),
    settlementId: value.settlementId,
    method: "evm:claim",
    requestId: hash(`${value.settlementId}:claim-request`),
    payloadDigest: hash("placeholder"),
    intentDigest: value.intentDigest,
    paymentHash: value.paymentHash,
    invoiceDigest: value.invoiceDigest,
    amountSats: value.amountSats,
    capacityEpoch: value.capacityEpoch,
    plannedAt: NOW + 2,
  };
  pending.payloadDigest = evmClaimActionCommitment(pending, op, signer.address);
  return pending;
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

function successfulReceipt(raw, blockHash = hash("claim-block"), blockNumber = 120) {
  const parsed = Transaction.from(raw);
  return {
    transactionHash: parsed.hash.toLowerCase(),
    blockHash,
    blockNumber: hexQuantity(blockNumber),
    status: "0x1",
    logs: [{
      address: CONTRACT,
      transactionHash: parsed.hash.toLowerCase(),
      blockHash,
      topics: [CLAIMED_TOPIC, QUOTE_ID, `0x${"00".repeat(12)}${signer.address.slice(2).toLowerCase()}`],
      data: `0x${"00".repeat(64)}`,
    }],
  };
}

async function preparedStore(t, label = "evm") {
  const directory = await mkdtemp(join(tmpdir(), `treeswap-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "coordinator.sqlite");
  const store = await CoordinatorStore.open(path);
  t.after(() => { try { store.close(); } catch {} });
  const value = settlement(label);
  const op = operation();
  const planned = action(value, op);
  store.acceptSettlement(value);
  store.recordReservation(reservation(value));
  await prepareEvmClaimAction({
    store,
    action: planned,
    operation: op,
    signer,
    expectedChainId: CHAIN_ID,
    expectedContract: CONTRACT,
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
    boundAt: NOW + 3,
  });
  return { directory, path, store, value, op, planned };
}

test("binds a signed EVM claim without persisting its preimage", async (t) => {
  const fixture = await preparedStore(t, "private-evm");
  const bound = fixture.store.getEvmTransaction(fixture.planned.actionId);
  assert.equal(bound.state, "PREPARED");
  assert.equal(bound.broadcastCount, 0);
  assert.equal(bound.fromAddress, signer.address.toLowerCase());
  fixture.store.close();

  const files = await readdir(fixture.directory);
  const bytes = [];
  for (const filename of files) bytes.push(await readFile(join(fixture.directory, filename)));
  assert.equal(Buffer.concat(bytes).toString("utf8").includes(PREIMAGE.slice(2)), false);
});

test("broadcasts once, stays UNKNOWN, and permits only the identical signed transaction to be rebroadcast", async (t) => {
  const fixture = await preparedStore(t, "rebroadcast");
  const rawTransactions = [];
  const first = await dispatchEvmClaimAction({
    store: fixture.store,
    actionId: fixture.planned.actionId,
    operation: fixture.op,
    signer,
    expectedChainId: CHAIN_ID,
    expectedContract: CONTRACT,
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
    rpcUrl: "http://127.0.0.1:8545",
    rpcRequestImpl: async ({ method, params }) => {
      if (method === "eth_chainId") return hexQuantity(CHAIN_ID);
      if (method === "eth_getCode") return CONTRACT_CODE;
      assert.equal(method, "eth_sendRawTransaction");
      rawTransactions.push(params[0]);
      return Transaction.from(params[0]).hash;
    },
    nowSeconds: () => NOW + 4,
  });
  assert.equal(first.action.state, "UNKNOWN");
  assert.equal(first.broadcastAccepted, true);
  assert.equal(first.transaction.broadcastCount, 1);

  const second = await dispatchEvmClaimAction({
    store: fixture.store,
    actionId: fixture.planned.actionId,
    operation: fixture.op,
    signer,
    expectedChainId: CHAIN_ID,
    expectedContract: CONTRACT,
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
    rpcUrl: "http://127.0.0.1:8545",
    rpcRequestImpl: async ({ method, params }) => {
      if (method === "eth_chainId") return hexQuantity(CHAIN_ID);
      if (method === "eth_getCode") return CONTRACT_CODE;
      rawTransactions.push(params[0]);
      throw new Error("lost response");
    },
    nowSeconds: () => NOW + 5,
  });
  assert.equal(second.action.state, "UNKNOWN");
  assert.equal(second.transaction.broadcastCount, 2);
  assert.equal(rawTransactions[0], rawTransactions[1]);
  assert.equal(Transaction.from(rawTransactions[0]).hash.toLowerCase(), second.transaction.transactionHash);
  await assert.rejects(
    dispatchEvmClaimAction({
      store: fixture.store,
      actionId: fixture.planned.actionId,
      operation: operation({ maxFeePerGas: 2_000_000_001n }),
      signer,
      expectedChainId: CHAIN_ID,
      expectedContract: CONTRACT,
      expectedContractCodeHash: CONTRACT_CODE_HASH,
      maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
      rpcUrl: "http://127.0.0.1:8545",
      rpcRequestImpl: async () => { throw new Error("must not run"); },
    }),
    /does not match the durable commitment/,
  );
});

test("rejects excessive gas cost or changed escrow code before durable broadcast", async (t) => {
  const fixture = await preparedStore(t, "preflight");
  await assert.rejects(
    dispatchEvmClaimAction({
      store: fixture.store,
      actionId: fixture.planned.actionId,
      operation: fixture.op,
      signer,
      expectedChainId: CHAIN_ID,
      expectedContract: CONTRACT,
      expectedContractCodeHash: CONTRACT_CODE_HASH,
      maximumGasCostWei: 1n,
      rpcUrl: "http://127.0.0.1:8545",
      rpcRequestImpl: async () => { throw new Error("must not run"); },
    }),
    /gas cost exceeds policy/,
  );
  let sent = false;
  await assert.rejects(
    dispatchEvmClaimAction({
      store: fixture.store,
      actionId: fixture.planned.actionId,
      operation: fixture.op,
      signer,
      expectedChainId: CHAIN_ID,
      expectedContract: CONTRACT,
      expectedContractCodeHash: CONTRACT_CODE_HASH,
      maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
      rpcUrl: "http://127.0.0.1:8545",
      rpcRequestImpl: async ({ method }) => {
        if (method === "eth_chainId") return hexQuantity(CHAIN_ID);
        if (method === "eth_getCode") return "0x6001";
        sent = true;
        throw new Error("must not send");
      },
    }),
    /contract code changed before broadcast/,
  );
  assert.equal(sent, false);
  assert.equal(fixture.store.getAction(fixture.planned.actionId).state, "PENDING");
  assert.equal(fixture.store.getEvmTransaction(fixture.planned.actionId).broadcastCount, 0);
});

test("requires a canonical finalized successful receipt and exact Claimed event", async (t) => {
  const fixture = await preparedStore(t, "finality");
  let raw;
  await dispatchEvmClaimAction({
    store: fixture.store,
    actionId: fixture.planned.actionId,
    operation: fixture.op,
    signer,
    expectedChainId: CHAIN_ID,
    expectedContract: CONTRACT,
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
    rpcUrl: "http://127.0.0.1:8545",
    rpcRequestImpl: async ({ method, params }) => {
      if (method === "eth_chainId") return hexQuantity(CHAIN_ID);
      if (method === "eth_getCode") return CONTRACT_CODE;
      [raw] = params;
      return Transaction.from(raw).hash;
    },
    nowSeconds: () => NOW + 4,
  });
  const blockHash = hash("claim-block");
  const receipt = successfulReceipt(raw, blockHash, 120);
  let finalizedNumber = 119;
  const rpcRequestImpl = async ({ method, params }) => {
    if (method === "eth_getTransactionByHash") return rpcTransaction(raw);
    if (method === "eth_getTransactionReceipt") return receipt;
    if (method === "eth_getCode") return CONTRACT_CODE;
    if (method === "eth_getBlockByNumber" && params[0] === "finalized") {
      return { number: hexQuantity(finalizedNumber), hash: hash(`finalized-${finalizedNumber}`) };
    }
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: blockHash };
    throw new Error(`unexpected method ${method}`);
  };
  const included = await reconcileEvmClaimAction({
    store: fixture.store,
    actionId: fixture.planned.actionId,
    rpcUrl: "http://127.0.0.1:8545",
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    rpcRequestImpl,
    nowSeconds: () => NOW + 5,
  });
  assert.equal(included.disposition, "unresolved");
  assert.equal(fixture.store.getAction(fixture.planned.actionId).state, "UNKNOWN");
  assert.equal(fixture.store.getEvmTransaction(fixture.planned.actionId).state, "INCLUDED");

  finalizedNumber = 120;
  const finalized = await reconcileEvmClaimAction({
    store: fixture.store,
    actionId: fixture.planned.actionId,
    rpcUrl: "http://127.0.0.1:8545",
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    rpcRequestImpl,
    nowSeconds: () => NOW + 6,
  });
  assert.equal(finalized.disposition, "confirmed");
  assert.equal(finalized.action.state, "CONFIRMED");
  assert.equal(fixture.store.getEvmTransaction(fixture.planned.actionId).state, "FINALIZED");
});

test("halts when a previously observed EVM inclusion disappears", async (t) => {
  const fixture = await preparedStore(t, "reorg");
  let raw;
  await dispatchEvmClaimAction({
    store: fixture.store,
    actionId: fixture.planned.actionId,
    operation: fixture.op,
    signer,
    expectedChainId: CHAIN_ID,
    expectedContract: CONTRACT,
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
    rpcUrl: "http://127.0.0.1:8545",
    rpcRequestImpl: async ({ method, params }) => {
      if (method === "eth_chainId") return hexQuantity(CHAIN_ID);
      if (method === "eth_getCode") return CONTRACT_CODE;
      [raw] = params;
      return Transaction.from(raw).hash;
    },
    nowSeconds: () => NOW + 4,
  });
  const blockHash = hash("reorg-block");
  const firstRpc = async ({ method, params }) => {
    if (method === "eth_getTransactionByHash") return rpcTransaction(raw);
    if (method === "eth_getTransactionReceipt") return successfulReceipt(raw, blockHash, 120);
    if (method === "eth_getCode") return CONTRACT_CODE;
    if (method === "eth_getBlockByNumber" && params[0] === "finalized") {
      return { number: "0x77", hash: hash("finalized-119") };
    }
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: blockHash };
    throw new Error("unexpected RPC");
  };
  await reconcileEvmClaimAction({
    store: fixture.store,
    actionId: fixture.planned.actionId,
    rpcUrl: "http://127.0.0.1:8545",
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    rpcRequestImpl: firstRpc,
    nowSeconds: () => NOW + 5,
  });
  const reorged = await reconcileEvmClaimAction({
    store: fixture.store,
    actionId: fixture.planned.actionId,
    rpcUrl: "http://127.0.0.1:8545",
    expectedContractCodeHash: CONTRACT_CODE_HASH,
    rpcRequestImpl: async ({ method }) => {
      if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") return null;
      throw new Error("unexpected RPC");
    },
    nowSeconds: () => NOW + 6,
  });
  assert.equal(reorged.disposition, "mismatch");
  assert.equal(reorged.settlement.state, "HALTED");
  assert.equal(fixture.store.getEvmTransaction(fixture.planned.actionId).state, "REORGED");
});
