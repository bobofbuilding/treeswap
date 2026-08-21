import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  NonceManager,
  id,
  keccak256,
  parseEther,
} from "ethers";
import { BIT_MAINNET_CONTRACT, createJsonRpcClient } from "../../lib/bit-deployment-observer.mjs";
import { buildClosedTestnetDeploymentPlan } from "../../lib/closed-testnet-deployment-plan.mjs";
import { observeClosedTestnetDeploymentPreflight } from "../../lib/closed-testnet-deployment-preflight-observer.mjs";
import {
  buildClosedTestnetDeploymentPreflightApprovalMessage,
  buildClosedTestnetDeploymentPreflightRecord,
  verifyClosedTestnetDeploymentPreflight,
} from "../../lib/closed-testnet-deployment-preflight.mjs";
import { observeClosedTestnetDeploymentPostflight } from "../../lib/closed-testnet-deployment-postflight-observer.mjs";
import {
  buildClosedTestnetDeploymentPostflightApprovalMessage,
  buildClosedTestnetDeploymentPostflightRecord,
  closedTestnetDeploymentPostflightValueDigest,
  normalizeClosedTestnetDeploymentPostflightContext,
  verifyClosedTestnetDeploymentPostflight,
} from "../../lib/closed-testnet-deployment-postflight.mjs";
import { coordinatorCommitmentDigest } from "../../lib/coordinator-store.mjs";
import {
  compareDeploymentObservations,
  observeDeploymentManifest,
} from "../../lib/deployment-observer.mjs";
import { validateDeploymentManifest } from "../../lib/deployment-policy.mjs";

const RPC_URL = process.env.DEPLOYMENT_REHEARSAL_RPC_URL;
const MNEMONIC = process.env.DEPLOYMENT_REHEARSAL_MNEMONIC;
const SOURCE_COMMIT = String(process.env.DEPLOYMENT_REHEARSAL_SOURCE_COMMIT ?? "");
const PROXY_PORT = Number(process.env.DEPLOYMENT_REHEARSAL_PROXY_PORT);
const ANVIL_VERSION = String(process.env.DEPLOYMENT_REHEARSAL_ANVIL_VERSION ?? "");
const CHAIN_ID = 11_155_111n;
const NO_REVIEW_DIGEST = id("treeswap-deployment-rehearsal:no-independent-review").toLowerCase();
const MAINNET_BIT_IMPLEMENTATION = "0xa27b118c0770939295f052aE1b003366E5eF806F";

if (!RPC_URL || !MNEMONIC) throw new Error("deployment rehearsal requires an ephemeral RPC URL and mnemonic");
if (!/^[0-9a-f]{40}$/.test(SOURCE_COMMIT)) throw new Error("deployment rehearsal source commit is invalid");
if (!Number.isSafeInteger(PROXY_PORT) || PROXY_PORT < 1_024 || PROXY_PORT > 65_535) {
  throw new Error("deployment rehearsal proxy port is invalid");
}
if (!/^anvil Version: [0-9.]+/.test(ANVIL_VERSION)) throw new Error("Anvil version is not pinned in evidence");

async function artifact(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

async function deploy(signer, artifactValue, args = []) {
  const factory = new ContractFactory(artifactValue.abi, artifactValue.bytecode.object, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function waitForFinality(provider, blockNumber, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const finalized = await provider.send("eth_getBlockByNumber", ["finalized", false]);
    if (finalized && BigInt(finalized.number) >= BigInt(blockNumber)) return finalized;
    await delay(250);
  }
  throw new Error("timed out waiting for deployment rehearsal finality");
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
        if (size > 128 * 1024) throw new Error("request exceeded local evidence bound");
        chunks.push(chunk);
      }
      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.concat(chunks),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await upstream.text();
      if (Buffer.byteLength(body) > 128 * 1024) throw new Error("response exceeded local evidence bound");
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

const [walletArtifact, bitImplementationArtifact, bitProxyArtifact, gateArtifact, registryArtifact,
  vaultArtifact, userEscrowArtifact] = await Promise.all([
  artifact("../../contracts/out/DeploymentManifestProbe.sol/DeploymentManifestWalletProbe.json"),
  artifact("../../contracts/out/DeploymentManifestProbe.sol/DeploymentManifestBitImplementation.json"),
  artifact("../../contracts/out/DeploymentManifestProbe.sol/DeploymentManifestBitProxy.json"),
  artifact("../../contracts/out/TreeSwapOpenGate.sol/TreeSwapOpenGate.json"),
  artifact("../../contracts/out/TreeSwapPaymentHashRegistry.sol/TreeSwapPaymentHashRegistry.json"),
  artifact("../../contracts/out/TreeSwapBitVault.sol/TreeSwapBitVault.json"),
  artifact("../../contracts/out/TreeSwapUserEscrow.sol/TreeSwapUserEscrow.json"),
]);

const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const wallets = Array.from({ length: 13 }, (_, index) => (
  HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider)
));
const deployer = new NonceManager(wallets[0]);
let proxy;

try {
  assert.equal((await provider.getNetwork()).chainId, CHAIN_ID);
  const bitImplementation = await deploy(deployer, bitImplementationArtifact);
  const bitProxy = await deploy(deployer, bitProxyArtifact, [await bitImplementation.getAddress()]);
  const controller = await deploy(deployer, walletArtifact, [wallets.slice(0, 3).map((item) => item.address), 2]);
  const guardian = await deploy(deployer, walletArtifact, [wallets.slice(3, 6).map((item) => item.address), 2]);
  const feeCollector = await deploy(deployer, walletArtifact, [wallets.slice(6, 9).map((item) => item.address), 2]);
  const runtimeCodeHash = async (contract) => keccak256(await provider.getCode(await contract.getAddress())).toLowerCase();
  const roleInput = async (contract, ownerAddresses) => ({
    address: await contract.getAddress(),
    ownerAddresses,
    threshold: 2,
    runtimeCodeHash: await runtimeCodeHash(contract),
  });
  const risk = Object.freeze({
    maxFeeBps: "100",
    maxPriceDeviationBps: "1000",
    referenceSatsPerBit: "100",
    epochDurationSeconds: "86400",
    minSettlementWindowSeconds: "1800",
    minClaimBufferSeconds: "900",
    maxLockDurationSeconds: "172800",
    maxSwapAmountWei: parseEther("10").toString(),
    maxEpochVolumeWei: parseEther("100").toString(),
  });
  const startingNonce = await provider.getTransactionCount(wallets[0].address, "pending");
  const deploymentInput = {
    schema: "treeswap.closed-testnet-deployment-input.v1",
    environment: "public-testnet",
    chainId: String(CHAIN_ID),
    reviewedBuildCommit: SOURCE_COMMIT,
    independentReviewDigest: NO_REVIEW_DIGEST,
    deployer: wallets[0].address,
    startingNonce: String(startingNonce),
    roles: {
      controller: await roleInput(controller, wallets.slice(0, 3).map((item) => item.address)),
      guardian: await roleInput(guardian, wallets.slice(3, 6).map((item) => item.address)),
      feeCollector: await roleInput(feeCollector, wallets.slice(6, 9).map((item) => item.address)),
    },
    bit: {
      tokenBoundary: "reviewed-public-testnet-bit-proxy",
      proxyAddress: await bitProxy.getAddress(),
      implementationAddress: await bitImplementation.getAddress(),
      proxyCodeHash: await runtimeCodeHash(bitProxy),
      implementationCodeHash: await runtimeCodeHash(bitImplementation),
      symbol: "BIT",
      decimals: 18,
      paused: false,
    },
    gate: { resumeDelaySeconds: 86_400, maxOpenDurationSeconds: 172_800 },
    vaultRisk: risk,
    userEscrowRisk: risk,
  };
  const deploymentPlan = await buildClosedTestnetDeploymentPlan({
    input: deploymentInput,
    artifacts: {
      gate: gateArtifact,
      paymentHashRegistry: registryArtifact,
      userEscrow: userEscrowArtifact,
      vault: vaultArtifact,
    },
  });
  assert.equal(deploymentPlan.deploymentTransactions.length, 4);

  const proxyUrl = `http://127.0.0.1:${PROXY_PORT}/`;
  proxy = await startLoopbackProxy(RPC_URL, PROXY_PORT);
  const providerEntries = [
    {
      id: id("treeswap-deployment-rehearsal:primary").toLowerCase(),
      label: "local-anvil-primary",
      rpcUrl: RPC_URL,
      wallet: wallets[10],
    },
    {
      id: id("treeswap-deployment-rehearsal:proxy").toLowerCase(),
      label: "local-anvil-proxy",
      rpcUrl: proxyUrl,
      wallet: wallets[11],
    },
  ].sort((left, right) => left.id.localeCompare(right.id));
  const operationsApprover = {
    id: id("treeswap-deployment-rehearsal:operations-reviewer").toLowerCase(),
    wallet: wallets[9],
  };
  const preflightApprovers = [
    { role: "operations-reviewer", approverId: operationsApprover.id, wallet: operationsApprover.wallet },
    ...providerEntries.map((entry) => ({ role: "provider", approverId: entry.id, wallet: entry.wallet })),
  ].sort((left, right) => `${left.role}:${left.approverId}`.localeCompare(`${right.role}:${right.approverId}`));
  const preflightPolicy = {
    schema: "treeswap.closed-testnet-deployment-preflight-policy.v1",
    environment: "public-testnet",
    chainId: deploymentPlan.network.chainId,
    verifyingContract: deploymentPlan.deploymentTransactions[0].expectedContractAddress,
    reviewedBuildCommit: deploymentPlan.source.reviewedBuildCommit,
    independentReviewDigest: deploymentPlan.source.independentReviewDigest,
    inputDigest: deploymentPlan.inputDigest,
    planDigest: deploymentPlan.planDigest,
    minimumProviderCount: 2,
    maximumObservationAgeSeconds: 300,
    maximumBlockAgeSeconds: 300,
    maximumPreflightLifetimeSeconds: 600,
    approvers: preflightApprovers.map((entry) => ({
      role: entry.role,
      approverId: entry.approverId,
      signer: entry.wallet.address,
    })),
  };
  const preflightObservations = [];
  for (const [index, entry] of providerEntries.entries()) {
    preflightObservations.push(await observeClosedTestnetDeploymentPreflight({
      rpcCall: createJsonRpcClient(entry.rpcUrl),
      plan: deploymentPlan,
      providerIdentity: entry.id,
      providerLabel: entry.label,
      targetBlockNumber: index === 0 ? null : Number(preflightObservations[0].anchorBlock.number),
    }));
  }
  const preflightPreparedAt = Math.floor(Date.now() / 1_000);
  const preflightRecord = buildClosedTestnetDeploymentPreflightRecord({
    plan: deploymentPlan,
    policy: preflightPolicy,
    observations: preflightObservations,
    preflightId: id(`treeswap-deployment-rehearsal:preflight:${preflightPreparedAt}`).toLowerCase(),
    preparedAt: preflightPreparedAt,
  });
  const preflightAttestations = [];
  for (const approver of preflightApprovers) {
    const approval = buildClosedTestnetDeploymentPreflightApprovalMessage({
      plan: deploymentPlan,
      policy: preflightPolicy,
      record: preflightRecord,
      observations: preflightObservations,
      role: approver.role,
      approverId: approver.approverId,
    });
    preflightAttestations.push({
      role: approver.role,
      approverId: approver.approverId,
      signer: approver.wallet.address,
      signature: await approver.wallet.signTypedData(approval.domain, approval.types, approval.value),
    });
  }
  const preflight = {
    plan: deploymentPlan,
    policy: preflightPolicy,
    record: preflightRecord,
    observations: preflightObservations,
    attestations: preflightAttestations,
  };
  const preflightVerification = verifyClosedTestnetDeploymentPreflight({
    ...preflight,
    now: preflightPreparedAt,
  });
  assert.equal(preflightVerification.fundingAuthorization, false);

  const receipts = [];
  for (const transaction of deploymentPlan.deploymentTransactions) {
    const response = await wallets[0].sendTransaction({
      chainId: CHAIN_ID,
      data: transaction.data,
      nonce: Number(transaction.nonce),
      value: transaction.valueWei,
    });
    const receipt = await response.wait();
    assert.equal(receipt.contractAddress, transaction.expectedContractAddress);
    receipts.push(receipt);
  }
  const expected = Object.fromEntries(deploymentPlan.deploymentTransactions.map((transaction) => [
    transaction.name,
    transaction.expectedContractAddress,
  ]));
  const gate = new Contract(expected.gate, gateArtifact.abi, provider);
  const registry = new Contract(expected.paymentHashRegistry, registryArtifact.abi, provider);
  const vault = new Contract(expected.vault, vaultArtifact.abi, provider);
  const userEscrow = new Contract(expected.userEscrow, userEscrowArtifact.abi, provider);
  const controllerControl = new Contract(await controller.getAddress(), walletArtifact.abi, wallets[1]);
  const controllerReceipts = [];
  let sealReceipt;
  for (const action of deploymentPlan.controllerSafeActions) {
    const receipt = await (await controllerControl.execTransaction(
      action.to,
      0,
      action.data,
      0,
      0,
      0,
      0,
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      "0x",
    )).wait();
    controllerReceipts.push(receipt);
    if (action.name === "seal-registry") sealReceipt = receipt;
  }
  assert.ok(sealReceipt);
  await waitForFinality(provider, sealReceipt.blockNumber);

  const addresses = {
    bitProxy: await bitProxy.getAddress(),
    controller: await controller.getAddress(),
    feeCollector: await feeCollector.getAddress(),
    gate: await gate.getAddress(),
    guardian: await guardian.getAddress(),
    paymentHashRegistry: await registry.getAddress(),
    userEscrow: await userEscrow.getAddress(),
    vault: await vault.getAddress(),
  };
  const observationInput = {
    addresses,
    reviewedBuildCommit: SOURCE_COMMIT,
    independentReviewDigest: NO_REVIEW_DIGEST,
    targetBlockNumber: sealReceipt.blockNumber,
    observedAt: new Date("2026-08-20T09:00:00.000Z"),
  };
  const [primaryObservation, proxyObservation] = await Promise.all([
    observeDeploymentManifest({
      ...observationInput,
      rpcCall: createJsonRpcClient(RPC_URL),
      providerLabel: "local-anvil-primary",
      providerIdentity: id("treeswap-deployment-rehearsal:primary").toLowerCase(),
    }),
    observeDeploymentManifest({
      ...observationInput,
      rpcCall: createJsonRpcClient(proxyUrl),
      providerLabel: "local-anvil-proxy",
      providerIdentity: id("treeswap-deployment-rehearsal:proxy").toLowerCase(),
    }),
  ]);
  assert.deepEqual(compareDeploymentObservations(primaryObservation, proxyObservation), {
    eligible: true,
    reasons: [],
  });

  const manifest = primaryObservation.manifest;
  const localPolicy = {
    chainId: Number(CHAIN_ID),
    reviewedBuildCommit: SOURCE_COMMIT,
    independentReviewDigest: NO_REVIEW_DIGEST,
    minResumeDelaySeconds: 86_400,
    maxOpenDurationSeconds: 604_800,
    absoluteMaxFeeBps: 500,
    absoluteMaxPriceDeviationBps: 2_500,
    referenceSatsPerBit: 100,
    bitProxyAddress: manifest.bit.proxyAddress,
    bitImplementationAddress: manifest.bit.implementationAddress,
    codeHashes: {
      controller: manifest.controller.codeHash,
      guardian: manifest.guardian.codeHash,
      feeCollector: manifest.feeCollector.codeHash,
      gate: manifest.gate.codeHash,
      vault: manifest.vault.codeHash,
      userEscrow: manifest.userEscrow.codeHash,
      paymentHashRegistry: manifest.paymentHashRegistry.codeHash,
      bitProxy: manifest.bit.proxyCodeHash,
      bitImplementation: manifest.bit.implementationCodeHash,
    },
  };
  assert.deepEqual(validateDeploymentManifest(manifest, localPolicy), { approved: true, reasons: [] });

  const executionTransactions = {
    schema: "treeswap.closed-testnet-deployment-execution-transactions.v1",
    deployments: deploymentPlan.deploymentTransactions.map((transaction, index) => ({
      name: transaction.name,
      transactionHash: receipts[index].hash.toLowerCase(),
    })),
    controllerActions: deploymentPlan.controllerSafeActions.map((action, index) => ({
      name: action.name,
      transactionHash: controllerReceipts[index].hash.toLowerCase(),
    })),
  };
  const postflightObservations = await Promise.all(providerEntries.map((entry) => (
    observeClosedTestnetDeploymentPostflight({
      rpcCall: createJsonRpcClient(entry.rpcUrl),
      preflight,
      deploymentPolicy: localPolicy,
      transactions: executionTransactions,
      providerIdentity: entry.id,
      providerLabel: entry.label,
      targetBlockNumber: sealReceipt.blockNumber,
    })
  )));
  const postflightContext = normalizeClosedTestnetDeploymentPostflightContext({
    preflight,
    deploymentPolicy: localPolicy,
  });
  const contractApprover = {
    id: id("treeswap-deployment-rehearsal:contract-reviewer").toLowerCase(),
    wallet: wallets[12],
  };
  const postflightApprovers = [
    { role: "contract-reviewer", approverId: contractApprover.id, wallet: contractApprover.wallet },
    { role: "operations-reviewer", approverId: operationsApprover.id, wallet: operationsApprover.wallet },
    ...providerEntries.map((entry) => ({ role: "provider", approverId: entry.id, wallet: entry.wallet })),
  ].sort((left, right) => `${left.role}:${left.approverId}`.localeCompare(`${right.role}:${right.approverId}`));
  const postflightPolicy = {
    schema: "treeswap.closed-testnet-deployment-postflight-policy.v1",
    environment: "public-testnet",
    chainId: deploymentPlan.network.chainId,
    verifyingContract: deploymentPlan.deploymentTransactions[0].expectedContractAddress,
    reviewedBuildCommit: deploymentPlan.source.reviewedBuildCommit,
    independentReviewDigest: deploymentPlan.source.independentReviewDigest,
    inputDigest: deploymentPlan.inputDigest,
    planDigest: deploymentPlan.planDigest,
    preflightPolicyDigest: postflightContext.preflight.summary.policyDigest,
    preflightRecordDigest: postflightContext.preflight.summary.recordDigest,
    deploymentPolicyDigest: closedTestnetDeploymentPostflightValueDigest(localPolicy),
    minimumProviderCount: 2,
    maximumObservationAgeSeconds: 3_600,
    maximumPostflightLifetimeSeconds: 3_600,
    approvers: postflightApprovers.map((entry) => ({
      role: entry.role,
      approverId: entry.approverId,
      signer: entry.wallet.address,
    })),
  };
  const postflightPreparedAt = Math.floor(Date.now() / 1_000);
  const postflightRecord = buildClosedTestnetDeploymentPostflightRecord({
    preflight,
    deploymentPolicy: localPolicy,
    policy: postflightPolicy,
    observations: postflightObservations,
    postflightId: id(`treeswap-deployment-rehearsal:postflight:${postflightPreparedAt}`).toLowerCase(),
    preparedAt: postflightPreparedAt,
  });
  const postflightAttestations = [];
  for (const approver of postflightApprovers) {
    const approval = buildClosedTestnetDeploymentPostflightApprovalMessage({
      preflight,
      deploymentPolicy: localPolicy,
      policy: postflightPolicy,
      record: postflightRecord,
      observations: postflightObservations,
      role: approver.role,
      approverId: approver.approverId,
    });
    postflightAttestations.push({
      role: approver.role,
      approverId: approver.approverId,
      signer: approver.wallet.address,
      signature: await approver.wallet.signTypedData(approval.domain, approval.types, approval.value),
    });
  }
  const postflightVerification = verifyClosedTestnetDeploymentPostflight({
    preflight,
    deploymentPolicy: localPolicy,
    policy: postflightPolicy,
    record: postflightRecord,
    observations: postflightObservations,
    attestations: postflightAttestations,
    now: postflightPreparedAt,
  });
  assert.equal(postflightVerification.status, "cryptographically-verified-finalized-deployment-execution");
  assert.equal(postflightVerification.fundingAuthorization, false);

  const captured = structuredClone(manifest);
  captured.guardian.ownerAddresses = [...captured.controller.ownerAddresses];
  const capturedResult = validateDeploymentManifest(captured, localPolicy);
  assert.equal(capturedResult.approved, false);
  assert.match(capturedResult.reasons.join("; "), /share an owner quorum/);

  const productionPolicy = {
    ...localPolicy,
    chainId: 1,
    independentReviewDigest: id("required independent production review").toLowerCase(),
    bitProxyAddress: BIT_MAINNET_CONTRACT,
    bitImplementationAddress: MAINNET_BIT_IMPLEMENTATION,
  };
  const productionResult = validateDeploymentManifest(manifest, productionPolicy);
  assert.equal(productionResult.approved, false);
  assert.match(productionResult.reasons.join("; "), /wrong deployment chain|review digest|BIT proxy|BIT implementation/);
  assert.equal(await gate.isOpen(), false);
  assert.equal(await registry.isSealed(), true);
  assert.equal(await vault.totalAvailable(), 0n);
  assert.equal(await vault.totalLocked(), 0n);
  assert.equal(await userEscrow.totalLocked(), 0n);
  assert.deepEqual(manifest.accounting, {
    vaultTotalAvailableWei: "0",
    vaultTotalLockedWei: "0",
    vaultAccountedBalanceWei: "0",
    vaultBitBalanceWei: "0",
    userEscrowTotalLockedWei: "0",
    userEscrowBitBalanceWei: "0",
  });

  const bitControl = new Contract(await bitProxy.getAddress(), bitImplementationArtifact.abi, wallets[0]);
  const unexpectedInventoryReceipt = await (await bitControl.setBalanceForTest(await vault.getAddress(), 1n)).wait();
  await waitForFinality(provider, unexpectedInventoryReceipt.blockNumber);
  const unexpectedInventoryObservation = await observeDeploymentManifest({
    ...observationInput,
    rpcCall: createJsonRpcClient(RPC_URL),
    providerLabel: "local-anvil-primary",
    providerIdentity: id("treeswap-deployment-rehearsal:primary").toLowerCase(),
    targetBlockNumber: unexpectedInventoryReceipt.blockNumber,
    observedAt: new Date("2026-08-20T09:01:00.000Z"),
  });
  const unexpectedInventoryResult = validateDeploymentManifest(unexpectedInventoryObservation.manifest, localPolicy);
  assert.equal(unexpectedInventoryResult.approved, false);
  assert.match(
    unexpectedInventoryResult.reasons.join("; "),
    /vault BIT balance does not match accounted inventory|zero BIT inventory and liabilities/,
  );
  const restoredReceipt = await (await bitControl.setBalanceForTest(await vault.getAddress(), 0n)).wait();
  await waitForFinality(provider, restoredReceipt.blockNumber);
  const restoredObservation = await observeDeploymentManifest({
    ...observationInput,
    rpcCall: createJsonRpcClient(RPC_URL),
    providerLabel: "local-anvil-primary",
    providerIdentity: id("treeswap-deployment-rehearsal:primary").toLowerCase(),
    targetBlockNumber: restoredReceipt.blockNumber,
    observedAt: new Date("2026-08-20T09:02:00.000Z"),
  });
  assert.deepEqual(validateDeploymentManifest(restoredObservation.manifest, localPolicy), {
    approved: true,
    reasons: [],
  });

  const evidence = Object.freeze({
    schema: "treeswap.deployment-rehearsal-smoke.v3",
    chainId: String(CHAIN_ID),
    executionClient: ANVIL_VERSION,
    actualTreeSwapGateRegistryAndEscrows: true,
    generatedPlanExecuted: true,
    generatedDeploymentTransactions: receipts.length,
    generatedControllerSafeActions: deploymentPlan.controllerSafeActions.length,
    signedPreflightVerified: preflightVerification.status
      === "cryptographically-verified-closed-testnet-deployment-preflight",
    preflightProviderSignatures: 2,
    standardSafeCompatibleReceipts: controllerReceipts.length,
    signedFinalizedPostflightVerified: postflightVerification.status
      === "cryptographically-verified-finalized-deployment-execution",
    postflightProviderSignatures: 2,
    postflightReviewerSignatures: 2,
    exactCreationAndSafeReceiptsReconstructed: true,
    deploymentPlanDigest: deploymentPlan.planDigest,
    finalizedCanonicalRpcObservation: true,
    comparedProviderIdentities: 2,
    independentProviderBackends: false,
    testOnlyRoleWallets: true,
    disjointThreeOwnerTwoThresholdRoleSets: true,
    gateDeployedClosed: manifest.gate.defaultClosed,
    registrySealedToExactEscrows: manifest.paymentHashRegistry.approvedEscrows.length === 2,
    exactEscrowTopologyObserved: true,
    localRehearsalPolicyMatched: true,
    capturedQuorumRejected: !capturedResult.approved,
    productionPolicyApproved: productionResult.approved,
    independentReviewIncluded: false,
    productionMultisigsIncluded: false,
    publicTestnetIncluded: false,
    tokenBoundary: "test-only-eip1967-bit-probe",
    solverInventoryWei: "0",
    userLiabilitiesWei: "0",
    finalizedZeroBalanceManifest: true,
    unexpectedFinalizedInventoryRejected: true,
    finalizedZeroBalanceRestored: true,
    fundingAuthorization: false,
  });
  process.stdout.write(`${JSON.stringify({ ...evidence, evidenceDigest: coordinatorCommitmentDigest(evidence) })}\n`);
} finally {
  await closeServer(proxy);
  await provider.destroy();
}
