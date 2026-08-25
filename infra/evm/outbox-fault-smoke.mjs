import assert from "node:assert/strict";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  id,
  keccak256,
  sha256,
} from "ethers";
import { CoordinatorStore, coordinatorCommitmentDigest } from "../../lib/coordinator-store.mjs";
import {
  dispatchEvmClaimAction,
  EvmProviderQuorumError,
  evmClaimActionCommitment,
  prepareEvmClaimAction,
  reconcileEvmClaimActionWithQuorum,
} from "../../lib/evm-action-runner.mjs";

const PRIMARY_RPC_URL = process.env.EVM_OUTBOX_PRIMARY_RPC_URL;
const SECONDARY_RPC_URL = process.env.EVM_OUTBOX_SECONDARY_RPC_URL;
const MNEMONIC = process.env.EVM_OUTBOX_MNEMONIC;
const PROXY_PORT = Number(process.env.EVM_OUTBOX_PROXY_PORT);
const ANVIL_VERSION = String(process.env.EVM_OUTBOX_ANVIL_VERSION ?? "");
const CHAIN_ID = 31_337n;
const MAXIMUM_GAS_COST_WEI = 2_000_000_000_000_000n;
const NOW = 2_100_000_000;

if (!PRIMARY_RPC_URL || !SECONDARY_RPC_URL || !MNEMONIC) {
  throw new Error("EVM outbox fault smoke requires two ephemeral RPC URLs and a mnemonic");
}
if (!Number.isSafeInteger(PROXY_PORT) || PROXY_PORT < 1_024 || PROXY_PORT > 65_535) {
  throw new Error("EVM outbox proxy port is invalid");
}
if (!/^anvil Version: [0-9.]+/.test(ANVIL_VERSION)) throw new Error("Anvil version is not pinned in evidence");

function digest(label) {
  return id(`treeswap-evm-outbox:${label}`).toLowerCase();
}

function quantity(value) {
  return BigInt(value);
}

async function waitForReceipt(provider, transactionHash, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await provider.send("eth_getTransactionReceipt", [transactionHash]);
    if (receipt) return receipt;
    await delay(250);
  }
  throw new Error("timed out waiting for an EVM receipt");
}

async function waitForFinality(provider, blockNumber, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const finalized = await provider.send("eth_getBlockByNumber", ["finalized", false]);
    if (finalized && quantity(finalized.number) >= quantity(blockNumber)) return finalized;
    await delay(250);
  }
  throw new Error("timed out waiting for genuine Anvil finality");
}

async function startLoopbackProxy(targetUrl, port) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/") {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128 * 1024) throw new Error("proxy request exceeded its local evidence bound");
        chunks.push(chunk);
      }
      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.concat(chunks),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await upstream.text();
      if (Buffer.byteLength(body) > 128 * 1024) throw new Error("proxy response exceeded its local evidence bound");
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(body);
    } catch {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "local evidence proxy failed" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const artifactUrl = new URL("../../contracts/out/CoordinatorClaimProbe.sol/CoordinatorClaimProbe.json", import.meta.url);
const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));
const primary = new JsonRpcProvider(PRIMARY_RPC_URL, CHAIN_ID, { staticNetwork: true });
const secondary = new JsonRpcProvider(SECONDARY_RPC_URL, CHAIN_ID, { staticNetwork: true });
const relayerA = HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/0").connect(primary);
const relayerB = HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/1").connect(primary);
const directory = await mkdtemp(join(tmpdir(), "treeswap-evm-outbox-"));
const databasePath = join(directory, "coordinator.sqlite");
const proxyUrl = `http://127.0.0.1:${PROXY_PORT}/`;
const preimages = [];
let sequence = 0;
let store;
let proxy;

async function pendingNonce(signer) {
  return quantity(await primary.send("eth_getTransactionCount", [signer.address, "pending"]));
}

async function prepareClaim({ label, signer, nonce = null }) {
  sequence += 1;
  const preimage = digest(`${label}:preimage`);
  preimages.push(preimage);
  const paymentHash = sha256(preimage).toLowerCase();
  const quoteId = digest(`${label}:quote`);
  const settlement = {
    settlementId: digest(`${label}:settlement`),
    pricingId: digest(`${label}:pricing`),
    direction: "lightning-to-bit",
    nonceAuthorityDigest: digest(`${label}:nonce-authority`),
    intentNonce: String(sequence),
    intentDigest: digest(`${label}:intent`),
    paymentHash,
    invoiceDigest: digest(`${label}:invoice`),
    amountSats: "10000",
    quoteReceiptDigest: digest(`${label}:quote-receipt`),
    selectedSetDigest: digest(`${label}:selected-set`),
    selectedOfferId: digest(`${label}:selected-offer`),
    capacityEpoch: sequence,
    createdAt: NOW + sequence * 20,
  };
  const operation = {
    chainId: CHAIN_ID,
    contract,
    contractCodeHash,
    nonce: nonce ?? await pendingNonce(signer),
    gasLimit: 150_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    value: 0n,
    quoteId,
    preimage,
  };
  const action = {
    actionId: digest(`${label}:action`),
    settlementId: settlement.settlementId,
    method: "evm:claim",
    requestId: digest(`${label}:request`),
    payloadDigest: digest(`${label}:placeholder`),
    intentDigest: settlement.intentDigest,
    paymentHash,
    invoiceDigest: settlement.invoiceDigest,
    amountSats: settlement.amountSats,
    capacityEpoch: settlement.capacityEpoch,
    plannedAt: settlement.createdAt + 2,
  };
  action.payloadDigest = evmClaimActionCommitment(action, operation, signer.address);
  store.acceptSettlement(settlement);
  store.recordReservation({
    settlementId: settlement.settlementId,
    reservationId: quoteId,
    reservationTxHash: digest(`${label}:reservation-transaction`),
    reservationBlockNumber: 1,
    reservationBlockHash: digest(`${label}:reservation-block`),
    reservationIntentDigest: settlement.intentDigest,
    observedAt: settlement.createdAt + 1,
  });
  await prepareEvmClaimAction({
    store,
    action,
    operation,
    signer,
    expectedChainId: CHAIN_ID,
    expectedContract: contract,
    expectedContractCodeHash: contractCodeHash,
    maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
    boundAt: settlement.createdAt + 3,
  });
  return Object.freeze({ action, operation, preimage, quoteId, settlement });
}

async function dispatchClaim(claim, signer, observedOffset) {
  return dispatchEvmClaimAction({
    store,
    actionId: claim.action.actionId,
    operation: claim.operation,
    signer,
    expectedChainId: CHAIN_ID,
    expectedContract: contract,
    expectedContractCodeHash: contractCodeHash,
    maximumGasCostWei: MAXIMUM_GAS_COST_WEI,
    rpcUrl: PRIMARY_RPC_URL,
    nowSeconds: () => NOW + observedOffset,
  });
}

function sameBackendQuorum(claim, observedOffset) {
  return reconcileEvmClaimActionWithQuorum({
    store,
    actionId: claim.action.actionId,
    expectedContractCodeHash: contractCodeHash,
    providers: [
      { label: "primary-direct", rpcUrl: PRIMARY_RPC_URL },
      { label: "primary-proxy", rpcUrl: proxyUrl },
    ],
    nowSeconds: () => NOW + observedOffset,
  });
}

let contract;
let contractCodeHash;

try {
  assert.equal((await primary.getNetwork()).chainId, CHAIN_ID);
  assert.equal((await secondary.getNetwork()).chainId, CHAIN_ID);
  proxy = await startLoopbackProxy(PRIMARY_RPC_URL, PROXY_PORT);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, relayerA);
  const probe = await factory.deploy();
  await probe.waitForDeployment();
  contract = (await probe.getAddress()).toLowerCase();
  const runtimeCode = await primary.getCode(contract);
  assert.notEqual(runtimeCode, "0x");
  contractCodeHash = keccak256(runtimeCode).toLowerCase();
  store = await CoordinatorStore.open(databasePath);

  const finalizedClaim = await prepareClaim({ label: "finalized", signer: relayerA });
  await dispatchClaim(finalizedClaim, relayerA, 100);
  const finalizedTransaction = store.getEvmTransaction(finalizedClaim.action.actionId);
  const finalizedReceipt = await waitForReceipt(primary, finalizedTransaction.transactionHash);
  const finalizedHead = await waitForFinality(primary, finalizedReceipt.blockNumber);
  const finalizedResult = await sameBackendQuorum(finalizedClaim, 101);
  assert.equal(finalizedResult.disposition, "confirmed");
  assert.equal(finalizedResult.action.state, "CONFIRMED");
  assert.equal(await probe.claimed(finalizedClaim.quoteId), true);

  const disagreementClaim = await prepareClaim({ label: "provider-disagreement", signer: relayerA });
  await dispatchClaim(disagreementClaim, relayerA, 200);
  const disagreementTransaction = store.getEvmTransaction(disagreementClaim.action.actionId);
  const disagreementReceipt = await waitForReceipt(primary, disagreementTransaction.transactionHash);
  await waitForFinality(primary, disagreementReceipt.blockNumber);
  await assert.rejects(
    reconcileEvmClaimActionWithQuorum({
      store,
      actionId: disagreementClaim.action.actionId,
      expectedContractCodeHash: contractCodeHash,
      providers: [
        { label: "primary-chain", rpcUrl: PRIMARY_RPC_URL },
        { label: "divergent-chain", rpcUrl: SECONDARY_RPC_URL },
      ],
      nowSeconds: () => NOW + 201,
    }),
    (error) => error instanceof EvmProviderQuorumError && error.code === "PROVIDER_DISAGREEMENT",
  );
  assert.equal(store.getAction(disagreementClaim.action.actionId).state, "UNKNOWN");
  assert.equal(store.getEvmTransaction(disagreementClaim.action.actionId).inclusionBlockHash, null);
  const recoveredDisagreement = await sameBackendQuorum(disagreementClaim, 202);
  assert.equal(recoveredDisagreement.disposition, "confirmed");

  const contentionClaim = await prepareClaim({ label: "nonce-contention", signer: relayerA });
  await primary.send("evm_setIntervalMining", [0]);
  await dispatchClaim(contentionClaim, relayerA, 300);
  const replacementRaw = await relayerA.signTransaction({
    type: 2,
    chainId: CHAIN_ID,
    to: relayerA.address,
    nonce: Number(contentionClaim.operation.nonce),
    gasLimit: 21_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    value: 0n,
  });
  const replacementHash = String(await primary.send("eth_sendRawTransaction", [replacementRaw])).toLowerCase();
  await primary.send("evm_mine", []);
  await primary.send("evm_setIntervalMining", [1]);
  await waitForReceipt(primary, replacementHash);
  const contentionResult = await sameBackendQuorum(contentionClaim, 301);
  assert.equal(contentionResult.disposition, "unresolved");
  assert.equal(contentionResult.action.resultCode, "NOT_FOUND");
  assert.equal(await probe.claimed(contentionClaim.quoteId), false);
  const rebroadcast = await dispatchClaim(contentionClaim, relayerA, 302);
  assert.equal(rebroadcast.broadcastAccepted, false);
  assert.equal(rebroadcast.transaction.broadcastCount, 2);

  const oldRelayerClaim = await prepareClaim({ label: "old-relayer", signer: relayerA });
  await assert.rejects(
    dispatchClaim(oldRelayerClaim, relayerB, 400),
    /does not match the durable commitment/,
  );
  assert.equal(store.getAction(oldRelayerClaim.action.actionId).state, "PENDING");
  assert.equal(store.getEvmTransaction(oldRelayerClaim.action.actionId).broadcastCount, 0);

  const rotatedRelayerClaim = await prepareClaim({ label: "rotated-relayer", signer: relayerB });
  await dispatchClaim(rotatedRelayerClaim, relayerB, 500);
  const rotatedTransaction = store.getEvmTransaction(rotatedRelayerClaim.action.actionId);
  const rotatedReceipt = await waitForReceipt(primary, rotatedTransaction.transactionHash);
  for (let block = 0; block < 8; block += 1) await primary.send("evm_mine", []);
  await waitForFinality(primary, rotatedReceipt.blockNumber);
  const rotatedResult = await sameBackendQuorum(rotatedRelayerClaim, 501);
  assert.equal(rotatedResult.disposition, "confirmed");
  assert.equal(rotatedTransaction.fromAddress, relayerB.address.toLowerCase());
  assert.equal(await probe.claimed(rotatedRelayerClaim.quoteId), true);

  store.close();
  store = null;
  const persisted = [];
  for (const filename of await readdir(directory)) persisted.push(await readFile(join(directory, filename)));
  const persistedText = Buffer.concat(persisted).toString("utf8");
  for (const preimage of preimages) assert.equal(persistedText.includes(preimage.slice(2)), false);

  const evidence = Object.freeze({
    schema: "treeswap.evm-outbox-fault-smoke.v1",
    chainId: String(CHAIN_ID),
    executionClient: ANVIL_VERSION,
    contractCodeHash,
    finalizedSuccess: Object.freeze({
      genuineFinalizedTag: true,
      claimConfirmed: true,
      finalizedBlockNumber: String(quantity(finalizedHead.number)),
      providerOrigins: 2,
      independentProviderBackends: false,
    }),
    providerDisagreement: Object.freeze({
      divergentLocalChains: true,
      durableMutationBeforeAgreement: false,
      recoveredAfterAgreement: true,
    }),
    nonceContention: Object.freeze({
      higherFeeReplacementMined: true,
      boundClaimObservedState: "NOT_FOUND",
      boundClaimExecuted: false,
      onlyByteIdenticalRebroadcastAttempted: true,
      broadcastCount: 2,
    }),
    relayerRotation: Object.freeze({
      oldActionSignerSubstitutionRejectedBeforeBroadcast: true,
      newActionBoundToRotatedSigner: true,
      rotatedSignerClaimFinalized: true,
    }),
    rawPreimagePersisted: false,
    publicTestnetIncluded: false,
    independentProviderIncluded: false,
    fundingAuthorization: false,
  });
  process.stdout.write(`${JSON.stringify({ ...evidence, evidenceDigest: coordinatorCommitmentDigest(evidence) })}\n`);
} finally {
  try { store?.close(); } catch {}
  await closeServer(proxy);
  await primary.destroy();
  await secondary.destroy();
  await rm(directory, { recursive: true, force: true });
}
