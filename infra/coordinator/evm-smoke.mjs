import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractFactory, HDNodeWallet, JsonRpcProvider, id, keccak256, sha256 } from "ethers";
import { CoordinatorStore, coordinatorCommitmentDigest } from "../../lib/coordinator-store.mjs";
import {
  dispatchEvmClaimAction,
  evmClaimActionCommitment,
  prepareEvmClaimAction,
  reconcileEvmClaimAction,
} from "../../lib/evm-action-runner.mjs";

const RPC_URL = process.env.EVM_SMOKE_RPC_URL;
const MNEMONIC = process.env.EVM_SMOKE_MNEMONIC;
if (!RPC_URL || !MNEMONIC) throw new Error("EVM smoke requires an ephemeral RPC URL and mnemonic");

function digest(label) {
  return id(`treeswap-evm-smoke:${label}`).toLowerCase();
}

const artifactUrl = new URL("../../contracts/out/CoordinatorClaimProbe.sol/CoordinatorClaimProbe.json", import.meta.url);
const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));
const provider = new JsonRpcProvider(RPC_URL, 31_337, { staticNetwork: true });
const signer = HDNodeWallet.fromPhrase(MNEMONIC).connect(provider);
const directory = await mkdtemp(join(tmpdir(), "treeswap-evm-smoke-"));
const databasePath = join(directory, "coordinator.sqlite");
let store;

async function isolatedLoopbackRpcRequest({ url, method, params, signal }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:"
      || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost" && endpoint.hostname !== "::1")) {
    throw new Error("local EVM evidence client accepts loopback HTTP only");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error("local EVM evidence response is too large");
  const body = JSON.parse(text);
  if (!response.ok || body?.jsonrpc !== "2.0" || body?.id !== 1 || body.error || !("result" in body)) {
    throw new Error("local EVM evidence RPC failed");
  }
  return body.result;
}

async function reconcileUntilIncluded({ actionId, contractCodeHash, now }) {
  const maximumAttempts = 40;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const result = await reconcileEvmClaimAction({
      store,
      actionId,
      rpcUrl: RPC_URL,
      rpcRequestImpl: isolatedLoopbackRpcRequest,
      expectedContractCodeHash: contractCodeHash,
      nowSeconds: () => now + attempt,
    });
    assert.equal(result.disposition, "unresolved");
    const transactionState = store.getEvmTransaction(actionId).state;
    if (transactionState === "INCLUDED") return result;
    assert.equal(transactionState, "UNKNOWN");
    if (attempt + 1 < maximumAttempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error("EVM smoke transaction was not included within the bounded reconciliation window");
}

try {
  const network = await provider.getNetwork();
  assert.equal(network.chainId, 31_337n);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const probe = await factory.deploy();
  await probe.waitForDeployment();
  const contract = (await probe.getAddress()).toLowerCase();
  const runtimeCode = await provider.getCode(contract);
  assert.notEqual(runtimeCode, "0x");
  const contractCodeHash = keccak256(runtimeCode).toLowerCase();
  const snapshotId = await provider.send("evm_snapshot", []);

  const preimage = `0x${"42".repeat(32)}`;
  const paymentHash = sha256(preimage).toLowerCase();
  const quoteId = digest("quote");
  const now = 2_000_000_000;
  const settlement = {
    settlementId: digest("settlement"),
    pricingId: digest("pricing"),
    direction: "lightning-to-bit",
    nonceAuthorityDigest: digest("nonce-authority"),
    intentNonce: "1",
    intentDigest: digest("intent"),
    paymentHash,
    invoiceDigest: digest("invoice"),
    amountSats: "10000",
    quoteReceiptDigest: digest("quote-receipt"),
    selectedSetDigest: digest("selected-set"),
    selectedOfferId: digest("selected-offer"),
    capacityEpoch: 1,
    createdAt: now,
  };
  const operation = {
    chainId: 31_337n,
    contract,
    contractCodeHash,
    nonce: await provider.getTransactionCount(signer.address),
    gasLimit: 150_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    value: 0n,
    quoteId,
    preimage,
  };
  const action = {
    actionId: digest("claim-action"),
    settlementId: settlement.settlementId,
    method: "evm:claim",
    requestId: digest("claim-request"),
    payloadDigest: digest("placeholder"),
    intentDigest: settlement.intentDigest,
    paymentHash,
    invoiceDigest: settlement.invoiceDigest,
    amountSats: settlement.amountSats,
    capacityEpoch: settlement.capacityEpoch,
    plannedAt: now + 2,
  };
  action.payloadDigest = evmClaimActionCommitment(action, operation, signer.address);

  store = await CoordinatorStore.open(databasePath);
  store.acceptSettlement(settlement);
  store.recordReservation({
    settlementId: settlement.settlementId,
    reservationId: quoteId,
    reservationTxHash: digest("reservation-transaction"),
    reservationBlockNumber: 1,
    reservationBlockHash: digest("reservation-block"),
    reservationIntentDigest: settlement.intentDigest,
    observedAt: now + 1,
  });
  await prepareEvmClaimAction({
    store,
    action,
    operation,
    signer,
    expectedChainId: 31_337n,
    expectedContract: contract,
    expectedContractCodeHash: contractCodeHash,
    maximumGasCostWei: 1_000_000_000_000_000n,
    boundAt: now + 3,
  });
  const dispatched = await dispatchEvmClaimAction({
    store,
    actionId: action.actionId,
    operation,
    signer,
    expectedChainId: 31_337n,
    expectedContract: contract,
    expectedContractCodeHash: contractCodeHash,
    maximumGasCostWei: 1_000_000_000_000_000n,
    rpcUrl: RPC_URL,
    rpcRequestImpl: isolatedLoopbackRpcRequest,
    nowSeconds: () => now + 4,
  });
  assert.equal(dispatched.action.state, "UNKNOWN");
  assert.equal(dispatched.transaction.broadcastCount, 1);

  const included = await reconcileUntilIncluded({
    actionId: action.actionId,
    contractCodeHash,
    now: now + 5,
  });
  assert.equal(included.disposition, "unresolved");
  assert.equal(store.getEvmTransaction(action.actionId).state, "INCLUDED");

  assert.equal(await provider.send("evm_revert", [snapshotId]), true);
  const reorged = await reconcileEvmClaimAction({
    store,
    actionId: action.actionId,
    rpcUrl: RPC_URL,
    rpcRequestImpl: isolatedLoopbackRpcRequest,
    expectedContractCodeHash: contractCodeHash,
    nowSeconds: () => now + 6,
  });
  assert.equal(reorged.disposition, "mismatch");
  assert.equal(reorged.settlement.state, "HALTED");
  assert.equal(store.getEvmTransaction(action.actionId).state, "REORGED");
  const transactionHash = store.getEvmTransaction(action.actionId).transactionHash;
  store.close();
  store = null;

  const persisted = [];
  for (const filename of await readdir(directory)) persisted.push(await readFile(join(directory, filename)));
  assert.equal(Buffer.concat(persisted).toString("utf8").includes(preimage.slice(2)), false);
  const evidenceDigest = coordinatorCommitmentDigest({
    schema: "treeswap.evm-coordinator-smoke.v1",
    chainId: "31337",
    contractCodeHash,
    transactionHash,
    initialState: "INCLUDED",
    reorgState: "REORGED",
    settlementState: "HALTED",
    rawPreimagePersisted: false,
  });
  process.stdout.write(`${JSON.stringify({
    schema: "treeswap.evm-coordinator-smoke.v1",
    chainId: 31_337,
    contractCodeHash,
    transactionHash,
    initialState: "INCLUDED",
    reorgState: "REORGED",
    settlementState: "HALTED",
    rawPreimagePersisted: false,
    evidenceDigest,
  })}\n`);
} finally {
  try { store?.close(); } catch {}
  await provider.destroy();
  await rm(directory, { recursive: true, force: true });
}
