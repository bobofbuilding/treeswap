import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Interface,
  Wallet,
  getAddress,
  id,
  parseEther,
} from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "../lib/bit-deployment-observer.mjs";
import { buildClosedTestnetDeploymentPlan } from "../lib/closed-testnet-deployment-plan.mjs";
import {
  buildClosedTestnetDeploymentPreflightApprovalMessage,
  buildClosedTestnetDeploymentPreflightRecord,
  closedTestnetDeploymentPreflightValueDigest,
} from "../lib/closed-testnet-deployment-preflight.mjs";
import {
  assertClosedTestnetDeploymentPostflightIsSecretFree,
  buildClosedTestnetDeploymentPostflightApprovalMessage,
  buildClosedTestnetDeploymentPostflightRecord,
  buildClosedTestnetDeploymentPostflightSummary,
  closedTestnetDeploymentPostflightValueDigest,
  normalizeClosedTestnetDeploymentPostflightContext,
  verifyClosedTestnetDeploymentPostflight,
} from "../lib/closed-testnet-deployment-postflight.mjs";
import { observeClosedTestnetDeploymentPostflight } from "../lib/closed-testnet-deployment-postflight-observer.mjs";
import { closedTestnetArtifactFixtures } from "./fixtures/closed-testnet-artifacts.mjs";

const NOW = Math.floor(Date.now() / 1_000) - 200;
const PREFLIGHT_BLOCK = 1_000;
const FINALIZED_BLOCK = 1_020;
const COMMIT = "1".repeat(40);
const CONTRACT_CODE_HASH = id("postflight reviewed contract runtime").toLowerCase();

function address(index) {
  return getAddress(`0x${index.toString(16).padStart(40, "0")}`);
}

function role(wallet, owners) {
  return {
    address: address(wallet),
    ownerAddresses: owners.map(address),
    threshold: 2,
    runtimeCodeHash: id(`postflight role ${wallet} runtime`).toLowerCase(),
  };
}

function risk() {
  return {
    maxFeeBps: "100",
    maxPriceDeviationBps: "1000",
    referenceSatsPerBit: "100",
    epochDurationSeconds: "86400",
    minSettlementWindowSeconds: "1800",
    minClaimBufferSeconds: "900",
    maxLockDurationSeconds: "172800",
    maxSwapAmountWei: parseEther("10").toString(),
    maxEpochVolumeWei: parseEther("100").toString(),
  };
}

function input() {
  return {
    schema: "treeswap.closed-testnet-deployment-input.v1",
    environment: "public-testnet",
    chainId: "11155111",
    reviewedBuildCommit: COMMIT,
    independentReviewDigest: id("postflight independent review").toLowerCase(),
    deployer: address(1),
    startingNonce: "7",
    roles: {
      controller: role(2, [10, 11, 12]),
      feeCollector: role(3, [13, 14, 15]),
      guardian: role(4, [16, 17, 18]),
    },
    bit: {
      tokenBoundary: "reviewed-public-testnet-bit-proxy",
      proxyAddress: address(5),
      implementationAddress: address(6),
      proxyCodeHash: id("postflight BIT proxy").toLowerCase(),
      implementationCodeHash: id("postflight BIT implementation").toLowerCase(),
      symbol: "BIT",
      decimals: 18,
      paused: false,
    },
    gate: { resumeDelaySeconds: 86_400, maxOpenDurationSeconds: 172_800 },
    vaultRisk: risk(),
    userEscrowRisk: risk(),
  };
}

function manifestRole(value) {
  return {
    address: value.address,
    isContract: true,
    owners: value.ownerAddresses.length,
    threshold: value.threshold,
    codeHash: value.runtimeCodeHash,
    ownerAddresses: [...value.ownerAddresses],
  };
}

function deploymentManifest(plan) {
  const [gate, registry, vault, userEscrow] = plan.deploymentTransactions.map((value) => value.expectedContractAddress);
  const escrow = (escrowAddress, settings) => ({
    address: escrowAddress,
    immutable: true,
    proxy: false,
    codeHash: CONTRACT_CODE_HASH,
    bit: plan.bit.proxyAddress,
    feeCollector: plan.roles.feeCollector.address,
    maxFeeBps: Number(settings.maxFeeBps),
    maxPriceDeviationBps: Number(settings.maxPriceDeviationBps),
    referenceSatsPerBit: Number(settings.referenceSatsPerBit),
    openGate: gate,
    paymentHashRegistry: registry,
    epochDurationSeconds: Number(settings.epochDurationSeconds),
    minSettlementWindowSeconds: Number(settings.minSettlementWindowSeconds),
    minClaimBufferSeconds: Number(settings.minClaimBufferSeconds),
    maxLockDurationSeconds: Number(settings.maxLockDurationSeconds),
    maxSwapAmountWei: settings.maxSwapAmountWei,
    maxEpochVolumeWei: settings.maxEpochVolumeWei,
  });
  return {
    chainId: Number(plan.network.chainId),
    reviewedBuildCommit: plan.source.reviewedBuildCommit,
    independentReviewDigest: plan.source.independentReviewDigest,
    controller: manifestRole(plan.roles.controller),
    guardian: manifestRole(plan.roles.guardian),
    feeCollector: manifestRole(plan.roles.feeCollector),
    gate: {
      address: gate,
      controller: plan.roles.controller.address,
      guardian: plan.roles.guardian.address,
      defaultClosed: true,
      resumeDelaySeconds: plan.gate.resumeDelaySeconds,
      maxOpenDurationSeconds: plan.gate.maxOpenDurationSeconds,
      codeHash: CONTRACT_CODE_HASH,
    },
    vault: escrow(vault, plan.vaultRisk),
    userEscrow: escrow(userEscrow, plan.userEscrowRisk),
    paymentHashRegistry: {
      address: registry,
      sealed: true,
      escrowCount: 2,
      codeHash: CONTRACT_CODE_HASH,
      approvedEscrows: [vault, userEscrow],
    },
    bit: {
      proxyAddress: plan.bit.proxyAddress,
      implementationAddress: plan.bit.implementationAddress,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      implementationSlotMatches: true,
      proxyCodeHash: plan.bit.proxyCodeHash,
      implementationCodeHash: plan.bit.implementationCodeHash,
      paused: false,
      decimals: 18,
      symbol: "BIT",
    },
    accounting: {
      vaultTotalAvailableWei: "0",
      vaultTotalLockedWei: "0",
      vaultAccountedBalanceWei: "0",
      vaultBitBalanceWei: "0",
      userEscrowTotalLockedWei: "0",
      userEscrowBitBalanceWei: "0",
    },
  };
}

function deploymentPolicy(plan) {
  return {
    chainId: Number(plan.network.chainId),
    reviewedBuildCommit: plan.source.reviewedBuildCommit,
    independentReviewDigest: plan.source.independentReviewDigest,
    minResumeDelaySeconds: 86_400,
    maxOpenDurationSeconds: 604_800,
    absoluteMaxFeeBps: 500,
    absoluteMaxPriceDeviationBps: 2_500,
    referenceSatsPerBit: 100,
    bitProxyAddress: plan.bit.proxyAddress,
    bitImplementationAddress: plan.bit.implementationAddress,
    codeHashes: {
      controller: plan.roles.controller.runtimeCodeHash,
      guardian: plan.roles.guardian.runtimeCodeHash,
      feeCollector: plan.roles.feeCollector.runtimeCodeHash,
      gate: CONTRACT_CODE_HASH,
      vault: CONTRACT_CODE_HASH,
      userEscrow: CONTRACT_CODE_HASH,
      paymentHashRegistry: CONTRACT_CODE_HASH,
      bitProxy: plan.bit.proxyCodeHash,
      bitImplementation: plan.bit.implementationCodeHash,
    },
  };
}

async function signPreflight(plan, providerEntries, operations) {
  const approvers = [
    { role: "operations-reviewer", approverId: operations.id, wallet: operations.wallet },
    ...providerEntries.map((value) => ({ role: "provider", approverId: value.id, wallet: value.wallet })),
  ].sort((left, right) => `${left.role}:${left.approverId}`.localeCompare(`${right.role}:${right.approverId}`));
  const policy = {
    schema: "treeswap.closed-testnet-deployment-preflight-policy.v1",
    environment: "public-testnet",
    chainId: plan.network.chainId,
    verifyingContract: plan.deploymentTransactions[0].expectedContractAddress,
    reviewedBuildCommit: plan.source.reviewedBuildCommit,
    independentReviewDigest: plan.source.independentReviewDigest,
    inputDigest: plan.inputDigest,
    planDigest: plan.planDigest,
    minimumProviderCount: 2,
    maximumObservationAgeSeconds: 300,
    maximumBlockAgeSeconds: 300,
    maximumPreflightLifetimeSeconds: 600,
    approvers: approvers.map((value) => ({
      role: value.role,
      approverId: value.approverId,
      signer: value.wallet.address,
    })),
  };
  const anchorHash = id("postflight preflight block").toLowerCase();
  const observations = providerEntries.map((provider, index) => ({
    schema: "treeswap.closed-testnet-deployment-preflight-observation.v1",
    evidenceStatus: "unreviewed-live-preflight-observation",
    observedAt: new Date((NOW - 5 + index) * 1_000).toISOString(),
    providerLabel: provider.label,
    providerIdentity: provider.id,
    sourceCommit: plan.source.reviewedBuildCommit,
    chainId: plan.network.chainId,
    planDigest: plan.planDigest,
    inputDigest: plan.inputDigest,
    anchorBlock: { number: String(PREFLIGHT_BLOCK), hash: anchorHash, timestamp: NOW - 30 },
    stateAnchor: { blockHash: anchorHash, requireCanonical: true },
    deployer: {
      address: plan.deployer.address,
      codeEmpty: true,
      anchoredNonce: plan.deployer.startingNonce,
      pendingNonceBefore: plan.deployer.startingNonce,
      pendingNonceAfter: plan.deployer.startingNonce,
    },
    deploymentTargets: plan.deploymentTransactions.map((transaction) => ({
      name: transaction.name,
      address: transaction.expectedContractAddress,
      codeEmpty: true,
    })),
    roles: structuredClone(plan.roles),
    bit: {
      proxyAddress: plan.bit.proxyAddress,
      implementationAddress: plan.bit.implementationAddress,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      proxyCodeHash: plan.bit.proxyCodeHash,
      implementationCodeHash: plan.bit.implementationCodeHash,
      symbol: "BIT",
      decimals: 18,
      paused: false,
    },
  }));
  const record = buildClosedTestnetDeploymentPreflightRecord({
    plan,
    policy,
    observations,
    preflightId: id("postflight bound preflight").toLowerCase(),
    preparedAt: NOW,
  });
  const attestations = [];
  for (const approver of approvers) {
    const approval = buildClosedTestnetDeploymentPreflightApprovalMessage({
      plan, policy, record, observations, role: approver.role, approverId: approver.approverId,
    });
    attestations.push({
      role: approver.role,
      approverId: approver.approverId,
      signer: approver.wallet.address,
      signature: await approver.wallet.signTypedData(approval.domain, approval.types, approval.value),
    });
  }
  return { plan, policy, record, observations, attestations };
}

function postflightObservation(plan, preflight, candidatePolicy, provider, index) {
  const deploymentPolicyDigest = closedTestnetDeploymentPostflightValueDigest(candidatePolicy);
  const context = normalizeClosedTestnetDeploymentPostflightContext({ preflight, deploymentPolicy: candidatePolicy });
  const manifest = deploymentManifest(plan);
  const receipt = (name, offset) => ({
    blockNumber: String(PREFLIGHT_BLOCK + offset),
    blockHash: id(`postflight receipt block ${offset}`).toLowerCase(),
    blockTimestamp: NOW + offset,
    transactionIndex: "0",
    status: "1",
  });
  return {
    schema: "treeswap.closed-testnet-deployment-postflight-observation.v1",
    evidenceStatus: "unreviewed-finalized-deployment-execution",
    observedAt: new Date((NOW + 110 + index) * 1_000).toISOString(),
    providerLabel: `postflight-${provider.label}`,
    providerIdentity: provider.id,
    reviewedBuildCommit: plan.source.reviewedBuildCommit,
    independentReviewDigest: plan.source.independentReviewDigest,
    chainId: plan.network.chainId,
    inputDigest: plan.inputDigest,
    planDigest: plan.planDigest,
    preflightPolicyDigest: context.preflight.summary.policyDigest,
    preflightRecordDigest: context.preflight.summary.recordDigest,
    deploymentPolicyDigest,
    preflightAnchor: {
      number: String(preflight.record.anchorBlockNumber),
      hash: preflight.record.anchorBlockHash,
      timestamp: preflight.observations[0].anchorBlock.timestamp,
    },
    providerFinalizedHead: { number: String(FINALIZED_BLOCK + 1), hash: id("postflight head").toLowerCase() },
    finalizedBlock: {
      number: String(FINALIZED_BLOCK),
      hash: id("postflight finalized block").toLowerCase(),
      timestamp: NOW + 100,
    },
    stateAnchor: { blockHash: id("postflight finalized block").toLowerCase(), requireCanonical: true },
    deployer: {
      address: plan.deployer.address,
      codeEmpty: true,
      anchoredNonce: "11",
      pendingNonceBefore: "11",
      pendingNonceAfter: "11",
    },
    deployments: plan.deploymentTransactions.map((value, deploymentIndex) => ({
      kind: value.kind,
      name: value.name,
      transactionHash: id(`deployment transaction ${deploymentIndex}`).toLowerCase(),
      from: value.from,
      to: null,
      nonce: value.nonce,
      valueWei: "0",
      dataHash: value.initCodeHash,
      expectedContractAddress: value.expectedContractAddress,
      receipt: receipt(value.name, deploymentIndex + 1),
    })),
    controllerActions: plan.controllerSafeActions.map((value, actionIndex) => ({
      name: value.name,
      transactionHash: id(`controller transaction ${actionIndex}`).toLowerCase(),
      safeAddress: value.safeAddress,
      to: value.to,
      valueWei: "0",
      operation: "CALL",
      dataHash: value.dataHash,
      actionDigest: value.actionDigest,
      safeExecutionSuccess: true,
      receipt: receipt(value.name, actionIndex + 5),
    })),
    manifest,
    manifestDigest: closedTestnetDeploymentPostflightValueDigest(manifest),
  };
}

async function fixture() {
  const plan = await buildClosedTestnetDeploymentPlan({ input: input(), artifacts: closedTestnetArtifactFixtures() });
  const providers = [
    { id: id("postflight provider alpha").toLowerCase(), label: "provider-alpha", wallet: new Wallet(`0x${"22".repeat(32)}`) },
    { id: id("postflight provider beta").toLowerCase(), label: "provider-beta", wallet: new Wallet(`0x${"33".repeat(32)}`) },
  ].sort((left, right) => left.id.localeCompare(right.id));
  const operations = {
    id: id("postflight operations reviewer").toLowerCase(),
    wallet: new Wallet(`0x${"11".repeat(32)}`),
  };
  const contract = {
    id: id("postflight contract reviewer").toLowerCase(),
    wallet: new Wallet(`0x${"44".repeat(32)}`),
  };
  const preflight = await signPreflight(plan, providers, operations);
  const candidateDeploymentPolicy = deploymentPolicy(plan);
  const context = normalizeClosedTestnetDeploymentPostflightContext({
    preflight,
    deploymentPolicy: candidateDeploymentPolicy,
  });
  const approvers = [
    { role: "contract-reviewer", approverId: contract.id, wallet: contract.wallet },
    { role: "operations-reviewer", approverId: operations.id, wallet: operations.wallet },
    ...providers.map((provider) => ({ role: "provider", approverId: provider.id, wallet: provider.wallet })),
  ].sort((left, right) => `${left.role}:${left.approverId}`.localeCompare(`${right.role}:${right.approverId}`));
  const policy = {
    schema: "treeswap.closed-testnet-deployment-postflight-policy.v1",
    environment: "public-testnet",
    chainId: plan.network.chainId,
    verifyingContract: plan.deploymentTransactions[0].expectedContractAddress,
    reviewedBuildCommit: plan.source.reviewedBuildCommit,
    independentReviewDigest: plan.source.independentReviewDigest,
    inputDigest: plan.inputDigest,
    planDigest: plan.planDigest,
    preflightPolicyDigest: context.preflight.summary.policyDigest,
    preflightRecordDigest: context.preflight.summary.recordDigest,
    deploymentPolicyDigest: context.deploymentPolicyDigest,
    minimumProviderCount: 2,
    maximumObservationAgeSeconds: 3_600,
    maximumPostflightLifetimeSeconds: 3_600,
    approvers: approvers.map((value) => ({
      role: value.role,
      approverId: value.approverId,
      signer: value.wallet.address,
    })),
  };
  const observations = providers.map((provider, index) => (
    postflightObservation(plan, preflight, candidateDeploymentPolicy, provider, index)
  ));
  const record = buildClosedTestnetDeploymentPostflightRecord({
    preflight,
    deploymentPolicy: candidateDeploymentPolicy,
    policy,
    observations,
    postflightId: id("postflight record").toLowerCase(),
    preparedAt: NOW + 120,
  });
  return { preflight, deploymentPolicy: candidateDeploymentPolicy, policy, record, observations, approvers };
}

async function attestations(candidate) {
  const values = [];
  for (const approver of candidate.approvers) {
    const approval = buildClosedTestnetDeploymentPostflightApprovalMessage({
      preflight: candidate.preflight,
      deploymentPolicy: candidate.deploymentPolicy,
      policy: candidate.policy,
      record: candidate.record,
      observations: candidate.observations,
      role: approver.role,
      approverId: approver.approverId,
    });
    values.push({
      role: approver.role,
      approverId: approver.approverId,
      signer: approver.wallet.address,
      signature: await approver.wallet.signTypedData(approval.domain, approval.types, approval.value),
    });
  }
  return values;
}

test("verifies exact finalized deployment and Safe receipts without granting operational authority", async () => {
  const candidate = await fixture();
  const signed = await attestations(candidate);
  const result = verifyClosedTestnetDeploymentPostflight({ ...candidate, attestations: signed, now: NOW + 120 });
  assert.equal(result.status, "cryptographically-verified-finalized-deployment-execution");
  assert.equal(result.deploymentTransactionCount, 4);
  assert.equal(result.controllerActionCount, 3);
  assert.equal(result.fundingAuthorization, false);
  assert.equal(result.gateOpeningAuthorization, false);
  const summary = buildClosedTestnetDeploymentPostflightSummary(result);
  assert.equal(summary.providerCount, 2);
  assert.equal(summary.fundingAuthorization, false);
  assert.throws(() => buildClosedTestnetDeploymentPostflightSummary(structuredClone(result)), /provenance/);
  assertClosedTestnetDeploymentPostflightIsSecretFree({ ...candidate, attestations: signed });
});

test("receipt, preflight window, Safe action, nonce, manifest, and provider mutations fail closed", async () => {
  const cases = [
    [(value) => { value.observations[0].deployments[0].dataHash = id("wrong creation input").toLowerCase(); }, /deployment receipt/],
    [(value) => { value.observations[0].deployments[1].receipt.status = "0"; }, /did not succeed/],
    [(value) => { value.observations[0].deployments[2].transactionHash = value.observations[0].deployments[1].transactionHash; }, /duplicated/],
    [(value) => { value.observations[0].controllerActions[0].to = address(900); }, /controller receipt/],
    [(value) => { value.observations[0].controllerActions[1].safeExecutionSuccess = false; }, /did not succeed/],
    [(value) => { value.observations[0].controllerActions[2].receipt.blockTimestamp = NOW + 601; }, /outside/],
    [(value) => { value.observations[0].deployer.pendingNonceAfter = "12"; }, /deployer state/],
    [(value) => { value.observations[0].manifest.accounting.vaultBitBalanceWei = "1"; }, /approved|inventory|balance/],
    [(value) => { value.observations[0].manifest.bit.implementationSlot = id("wrong slot").toLowerCase(); }, /implementation slot/],
    [(value) => { value.observations[1].providerLabel = value.observations[0].providerLabel; }, /labels must be distinct/],
    [(value) => { value.observations[1].finalizedBlock.hash = id("provider disagreement").toLowerCase(); }, /canonical|record|disagree/],
  ];
  for (const [mutate, pattern] of cases) {
    const candidate = await fixture();
    candidate.preflight = structuredClone(candidate.preflight);
    mutate(candidate);
    await assert.rejects(() => attestations(candidate), pattern);
  }
});

test("postflight cannot replace preflight reviewers, weaken quorum, reuse signers, or extend lifetime", async () => {
  const cases = [
    [(value) => { value.policy.minimumProviderCount = 1; }, /two to five/],
    [(value) => { value.policy.maximumObservationAgeSeconds = 3_601; }, /one hour/],
    [(value) => { value.policy.maximumPostflightLifetimeSeconds = 86_401; }, /one day/],
    [(value) => { value.policy.approvers[1].signer = value.policy.approvers[0].signer; }, /globally distinct/],
    [(value) => { value.policy.approvers.find((item) => item.role === "provider").approverId = id("replacement").toLowerCase(); }, /retain the exact/],
    [(value) => { value.preflight.record.planDigest = id("rewritten preflight").toLowerCase(); }, /preflight|plan/],
  ];
  for (const [mutate, pattern] of cases) {
    const candidate = await fixture();
    candidate.preflight = structuredClone(candidate.preflight);
    mutate(candidate);
    await assert.rejects(() => attestations(candidate), pattern);
  }
});

test("missing, forged, replayed, expired, and secret-bearing approvals fail closed", async () => {
  const candidate = await fixture();
  const signed = await attestations(candidate);
  assert.throws(
    () => verifyClosedTestnetDeploymentPostflight({ ...candidate, attestations: signed.slice(1), now: NOW + 120 }),
    /every postflight approver/,
  );
  const forged = structuredClone(signed);
  forged[0].signature = forged[1].signature;
  assert.throws(
    () => verifyClosedTestnetDeploymentPostflight({ ...candidate, attestations: forged, now: NOW + 120 }),
    /signature is invalid/,
  );
  assert.throws(
    () => verifyClosedTestnetDeploymentPostflight({ ...candidate, attestations: signed, now: candidate.record.validUntil + 1 }),
    /expired/,
  );
  const replay = await fixture();
  replay.record = structuredClone(replay.record);
  replay.record.postflightId = id("different postflight").toLowerCase();
  assert.throws(
    () => verifyClosedTestnetDeploymentPostflight({ ...replay, attestations: signed, now: NOW + 120 }),
    /signature is invalid/,
  );
  assert.throws(
    () => assertClosedTestnetDeploymentPostflightIsSecretFree({ rpcUrl: "https://private.invalid" }),
    /forbidden field|endpoint/,
  );
});

test("postflight digests are deterministic and every observation is bound into the signed record", async () => {
  const candidate = await fixture();
  assert.equal(
    closedTestnetDeploymentPostflightValueDigest(candidate.record),
    closedTestnetDeploymentPostflightValueDigest(structuredClone(candidate.record)),
  );
  assert.equal(candidate.record.providerObservations.length, 2);
  for (const [index, reference] of candidate.record.providerObservations.entries()) {
    assert.equal(reference.observationDigest, closedTestnetDeploymentPostflightValueDigest(candidate.observations[index]));
  }
  assert.match(closedTestnetDeploymentPreflightValueDigest(candidate.preflight.record), /^0x[0-9a-f]{64}$/);
});

const SAFE_INTERFACE = new Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)",
  "event ExecutionSuccess(bytes32 txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 txHash,uint256 payment)",
]);
const REGISTRY_INTERFACE = new Interface([
  "event EscrowRegistered(address indexed escrow)",
  "event RegistrySealedEvent()",
]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function log({ iface, event, args, target, transactionHash, blockNumber, blockHash }) {
  const encoded = iface.encodeEventLog(iface.getEvent(event), args);
  return {
    address: target,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockNumber: hex(blockNumber),
    blockHash,
    transactionIndex: "0x0",
  };
}

function executionRpc(candidate, {
  reorgPreflight = false,
  reorgReceipt = false,
  failedSafe = false,
  wrongInnerData = false,
} = {}) {
  const plan = candidate.preflight.plan;
  const transactions = {
    schema: "treeswap.closed-testnet-deployment-execution-transactions.v1",
    deployments: plan.deploymentTransactions.map((value, index) => ({
      name: value.name,
      transactionHash: id(`observed deployment ${index}`).toLowerCase(),
    })),
    controllerActions: plan.controllerSafeActions.map((value, index) => ({
      name: value.name,
      transactionHash: id(`observed controller ${index}`).toLowerCase(),
    })),
  };
  const values = new Map();
  const blocks = new Map();
  const receiptBlockCalls = new Map();
  blocks.set(PREFLIGHT_BLOCK, {
    number: hex(PREFLIGHT_BLOCK),
    hash: candidate.preflight.record.anchorBlockHash,
    timestamp: hex(candidate.preflight.observations[0].anchorBlock.timestamp),
  });
  for (const [index, value] of plan.deploymentTransactions.entries()) {
    const reference = transactions.deployments[index];
    const blockNumber = PREFLIGHT_BLOCK + index + 1;
    const blockHash = id(`observer block ${blockNumber}`).toLowerCase();
    blocks.set(blockNumber, { number: hex(blockNumber), hash: blockHash, timestamp: hex(NOW + index + 1) });
    values.set(reference.transactionHash, {
      transaction: {
        hash: reference.transactionHash,
        from: value.from,
        to: null,
        nonce: hex(value.nonce),
        value: "0x0",
        input: value.data,
        blockNumber: hex(blockNumber),
        blockHash,
        transactionIndex: "0x0",
      },
      receipt: {
        transactionHash: reference.transactionHash,
        blockNumber: hex(blockNumber),
        blockHash,
        transactionIndex: "0x0",
        status: "0x1",
        contractAddress: value.expectedContractAddress,
        logs: [],
      },
    });
  }
  for (const [index, value] of plan.controllerSafeActions.entries()) {
    const reference = transactions.controllerActions[index];
    const blockNumber = PREFLIGHT_BLOCK + index + 5;
    const blockHash = id(`observer block ${blockNumber}`).toLowerCase();
    blocks.set(blockNumber, { number: hex(blockNumber), hash: blockHash, timestamp: hex(NOW + index + 5) });
    const innerData = wrongInnerData && index === 0 ? plan.controllerSafeActions[1].data : value.data;
    const outerData = SAFE_INTERFACE.encodeFunctionData("execTransaction", [
      value.to, 0, innerData, 0, 0, 0, 0, ZERO_ADDRESS, ZERO_ADDRESS, "0x",
    ]);
    const safeEvent = failedSafe && index === 0 ? "ExecutionFailure" : "ExecutionSuccess";
    const expectedEscrow = index === 0
      ? plan.deploymentTransactions[2].expectedContractAddress
      : plan.deploymentTransactions[3].expectedContractAddress;
    const registryEvent = index < 2
      ? log({ iface: REGISTRY_INTERFACE, event: "EscrowRegistered", args: [expectedEscrow], target: value.to,
        transactionHash: reference.transactionHash, blockNumber, blockHash })
      : log({ iface: REGISTRY_INTERFACE, event: "RegistrySealedEvent", args: [], target: value.to,
        transactionHash: reference.transactionHash, blockNumber, blockHash });
    values.set(reference.transactionHash, {
      transaction: {
        hash: reference.transactionHash,
        from: address(999),
        to: value.safeAddress,
        nonce: hex(index),
        value: "0x0",
        input: outerData,
        blockNumber: hex(blockNumber),
        blockHash,
        transactionIndex: "0x0",
      },
      receipt: {
        transactionHash: reference.transactionHash,
        blockNumber: hex(blockNumber),
        blockHash,
        transactionIndex: "0x0",
        status: "0x1",
        contractAddress: null,
        logs: [
          log({ iface: SAFE_INTERFACE, event: safeEvent, args: [id(`safe execution ${index}`), 0],
            target: value.safeAddress, transactionHash: reference.transactionHash, blockNumber, blockHash }),
          registryEvent,
        ],
      },
    });
  }
  const finalizedHash = id("observer finalized block").toLowerCase();
  blocks.set(FINALIZED_BLOCK, {
    number: hex(FINALIZED_BLOCK),
    hash: finalizedHash,
    timestamp: hex(NOW + 100),
  });
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getTransactionCount") return "0xb";
    if (method === "eth_getCode") return "0x";
    if (method === "eth_getTransactionByHash") return values.get(params[0])?.transaction ?? null;
    if (method === "eth_getTransactionReceipt") return values.get(params[0])?.receipt ?? null;
    if (method === "eth_getBlockByNumber") {
      const number = Number(BigInt(params[0]));
      const value = blocks.get(number);
      if (!value) throw new Error(`unexpected block ${number}`);
      const reads = (receiptBlockCalls.get(number) ?? 0) + 1;
      receiptBlockCalls.set(number, reads);
      if (reorgPreflight && number === PREFLIGHT_BLOCK) {
        return { ...value, hash: id("reorged preflight anchor").toLowerCase() };
      }
      if (reorgReceipt && number === PREFLIGHT_BLOCK + 1 && reads > 1) {
        return { ...value, hash: id("reorged observer receipt").toLowerCase() };
      }
      return value;
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  const observeManifest = async ({ providerLabel, providerIdentity }) => ({
    providerLabel,
    providerIdentity,
    providerFinalizedHead: { number: FINALIZED_BLOCK + 1, hash: id("observer finalized head").toLowerCase() },
    finalizedBlock: { number: FINALIZED_BLOCK, hash: finalizedHash },
    manifest: structuredClone(candidate.observations[0].manifest),
  });
  return { transactions, rpcCall, observeManifest };
}

test("live postflight observer reconstructs creation and Safe receipts and detects failure or reorg", async () => {
  const candidate = await fixture();
  const provider = candidate.observations[0];
  const healthy = executionRpc(candidate);
  const observation = await observeClosedTestnetDeploymentPostflight({
    rpcCall: healthy.rpcCall,
    observeManifest: healthy.observeManifest,
    preflight: candidate.preflight,
    deploymentPolicy: candidate.deploymentPolicy,
    transactions: healthy.transactions,
    providerIdentity: provider.providerIdentity,
    providerLabel: "receipt-provider",
    targetBlockNumber: FINALIZED_BLOCK,
    observedAt: new Date((NOW + 110) * 1_000),
  });
  assert.equal(observation.deployments.length, 4);
  assert.equal(observation.controllerActions.length, 3);
  assert.equal(observation.deployer.anchoredNonce, "11");
  assert.equal(observation.finalizedBlock.number, String(FINALIZED_BLOCK));

  for (const [options, pattern] of [
    [{ failedSafe: true }, /ExecutionSuccess/],
    [{ wrongInnerData: true }, /inner Safe call/],
    [{ reorgPreflight: true }, /preflight anchor is no longer canonical/],
    [{ reorgReceipt: true }, /block changed/],
  ]) {
    const broken = executionRpc(candidate, options);
    await assert.rejects(observeClosedTestnetDeploymentPostflight({
      rpcCall: broken.rpcCall,
      observeManifest: broken.observeManifest,
      preflight: candidate.preflight,
      deploymentPolicy: candidate.deploymentPolicy,
      transactions: broken.transactions,
      providerIdentity: provider.providerIdentity,
      providerLabel: "receipt-provider",
      targetBlockNumber: FINALIZED_BLOCK,
      observedAt: new Date((NOW + 110) * 1_000),
    }), pattern);
  }
});

test("postflight CLIs prepare a signer payload, rebuild a fresh record, and verify a no-authority summary", async () => {
  const candidate = await fixture();
  const signed = await attestations(candidate);
  const directory = await mkdtemp(join(tmpdir(), "treeswap-deployment-postflight-"));
  try {
    const values = {
      plan: candidate.preflight.plan,
      preflightPolicy: candidate.preflight.policy,
      preflightRecord: candidate.preflight.record,
      preflightObservations: candidate.preflight.observations,
      preflightAttestations: candidate.preflight.attestations,
      deploymentPolicy: candidate.deploymentPolicy,
      policy: candidate.policy,
      record: candidate.record,
      observations: candidate.observations,
      attestations: signed,
    };
    const paths = Object.fromEntries(Object.keys(values).map((name) => [name, join(directory, `${name}.json`)]));
    await Promise.all(Object.entries(values).map(([name, value]) => writeFile(
      paths[name], `${JSON.stringify(value)}\n`, { mode: 0o600 },
    )));
    const common = [
      "--plan", paths.plan,
      "--preflight-policy", paths.preflightPolicy,
      "--preflight-record", paths.preflightRecord,
      "--preflight-observations", paths.preflightObservations,
      "--preflight-attestations", paths.preflightAttestations,
      "--deployment-policy", paths.deploymentPolicy,
      "--policy", paths.policy,
      "--observations", paths.observations,
    ];
    const approver = candidate.approvers[0];
    const prepared = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-closed-testnet-deployment-postflight-approval.mjs",
      ...common,
      "--record", paths.record,
      "--role", approver.role,
      "--approver-id", approver.approverId,
    ], { cwd: resolve(new URL("..", import.meta.url).pathname), encoding: "utf8" }));
    assert.equal(prepared.primaryType, "DeploymentPostflightApproval");
    assert.match(prepared.scope, /no-signing-broadcast-gate-opening-or-funding-authorization/);

    const rebuiltPath = join(directory, "rebuilt-record.json");
    const rebuilt = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-closed-testnet-deployment-postflight-record.mjs",
      ...common,
      "--postflight-id", id("cli rebuilt postflight").toLowerCase(),
      "--out", rebuiltPath,
    ], { cwd: resolve(new URL("..", import.meta.url).pathname), encoding: "utf8" }));
    assert.equal(rebuilt.fundingAuthorization, false);
    assert.equal((await readFile(rebuiltPath, "utf8")).includes("rpc"), false);

    const verified = JSON.parse(execFileSync(process.execPath, [
      "scripts/verify-closed-testnet-deployment-postflight.mjs",
      ...common,
      "--record", paths.record,
      "--attestations", paths.attestations,
    ], { cwd: resolve(new URL("..", import.meta.url).pathname), encoding: "utf8" }));
    assert.equal(verified.status, "cryptographically-verified-finalized-deployment-execution");
    assert.equal(verified.summary.fundingAuthorization, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
