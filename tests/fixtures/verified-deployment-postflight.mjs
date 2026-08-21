import {
  Wallet,
  getAddress,
  id,
  keccak256,
  parseEther,
  toUtf8Bytes,
} from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "../../lib/bit-deployment-observer.mjs";
import { buildClosedTestnetDeploymentPlan } from "../../lib/closed-testnet-deployment-plan.mjs";
import {
  buildClosedTestnetDeploymentPreflightApprovalMessage,
  buildClosedTestnetDeploymentPreflightRecord,
} from "../../lib/closed-testnet-deployment-preflight.mjs";
import {
  buildClosedTestnetDeploymentPostflightApprovalMessage,
  buildClosedTestnetDeploymentPostflightRecord,
  closedTestnetDeploymentPostflightValueDigest,
  normalizeClosedTestnetDeploymentPostflightContext,
  verifyClosedTestnetDeploymentPostflight,
} from "../../lib/closed-testnet-deployment-postflight.mjs";
import { closedTestnetArtifactFixtures } from "./closed-testnet-artifacts.mjs";

export const POSTFLIGHT_NOW = Math.floor(Date.now() / 1_000) - 300;
const PREFLIGHT_BLOCK = 1_000;
const FINALIZED_BLOCK = 1_020;
const COMMIT = "a".repeat(40);
const CONTRACT_CODE_HASH = id("shared postflight reviewed contract runtime").toLowerCase();

export const POSTFLIGHT_REVIEW_ARTIFACTS = Object.freeze({
  compilerInputs: id("shared postflight compiler inputs").toLowerCase(),
  findingsDisposition: id("shared postflight findings disposition").toLowerCase(),
  providerIndependence: id("shared postflight provider independence").toLowerCase(),
  rolesAndStorage: id("shared postflight roles and storage review").toLowerCase(),
  sourceBundles: id("shared postflight matched source bundles").toLowerCase(),
  upgradeBehavior: id("shared postflight upgrade behavior review").toLowerCase(),
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function address(index) {
  return getAddress(`0x${index.toString(16).padStart(40, "0")}`);
}

function role(wallet, owners) {
  return {
    address: address(wallet),
    ownerAddresses: owners.map(address),
    threshold: 2,
    runtimeCodeHash: id(`shared postflight role ${wallet} runtime`).toLowerCase(),
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

function deploymentInput() {
  return {
    schema: "treeswap.closed-testnet-deployment-input.v1",
    environment: "public-testnet",
    chainId: "11155111",
    reviewedBuildCommit: COMMIT,
    independentReviewDigest: hash(POSTFLIGHT_REVIEW_ARTIFACTS),
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
      proxyCodeHash: id("shared postflight BIT proxy").toLowerCase(),
      implementationCodeHash: id("shared postflight BIT implementation").toLowerCase(),
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

async function buildPreflight(plan, providers, operations) {
  const approvers = [
    { role: "operations-reviewer", approverId: operations.id, wallet: operations.wallet },
    ...providers.map((value) => ({ role: "provider", approverId: value.id, wallet: value.wallet })),
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
  const anchorHash = id("shared postflight preflight block").toLowerCase();
  const observations = providers.map((provider, index) => ({
    schema: "treeswap.closed-testnet-deployment-preflight-observation.v1",
    evidenceStatus: "unreviewed-live-preflight-observation",
    observedAt: new Date((POSTFLIGHT_NOW - 5 + index) * 1_000).toISOString(),
    providerLabel: provider.label,
    providerIdentity: provider.id,
    sourceCommit: plan.source.reviewedBuildCommit,
    chainId: plan.network.chainId,
    planDigest: plan.planDigest,
    inputDigest: plan.inputDigest,
    anchorBlock: { number: String(PREFLIGHT_BLOCK), hash: anchorHash, timestamp: POSTFLIGHT_NOW - 30 },
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
    preflightId: id("shared postflight bound preflight").toLowerCase(),
    preparedAt: POSTFLIGHT_NOW,
  });
  const attestations = [];
  for (const approver of approvers) {
    const approval = buildClosedTestnetDeploymentPreflightApprovalMessage({
      plan,
      policy,
      record,
      observations,
      role: approver.role,
      approverId: approver.approverId,
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
  const context = normalizeClosedTestnetDeploymentPostflightContext({
    preflight,
    deploymentPolicy: candidatePolicy,
  });
  const manifest = deploymentManifest(plan);
  const receipt = (offset) => ({
    blockNumber: String(PREFLIGHT_BLOCK + offset),
    blockHash: id(`shared postflight receipt block ${offset}`).toLowerCase(),
    blockTimestamp: POSTFLIGHT_NOW + offset,
    transactionIndex: "0",
    status: "1",
  });
  return {
    schema: "treeswap.closed-testnet-deployment-postflight-observation.v1",
    evidenceStatus: "unreviewed-finalized-deployment-execution",
    observedAt: new Date((POSTFLIGHT_NOW + 110 + index) * 1_000).toISOString(),
    providerLabel: `postflight-${provider.label}`,
    providerIdentity: provider.id,
    reviewedBuildCommit: plan.source.reviewedBuildCommit,
    independentReviewDigest: plan.source.independentReviewDigest,
    chainId: plan.network.chainId,
    inputDigest: plan.inputDigest,
    planDigest: plan.planDigest,
    preflightPolicyDigest: context.preflight.summary.policyDigest,
    preflightRecordDigest: context.preflight.summary.recordDigest,
    deploymentPolicyDigest: context.deploymentPolicyDigest,
    preflightAnchor: {
      number: String(preflight.record.anchorBlockNumber),
      hash: preflight.record.anchorBlockHash,
      timestamp: preflight.observations[0].anchorBlock.timestamp,
    },
    providerFinalizedHead: {
      number: String(FINALIZED_BLOCK + 1),
      hash: id("shared postflight head").toLowerCase(),
    },
    finalizedBlock: {
      number: String(FINALIZED_BLOCK),
      hash: id("shared postflight finalized block").toLowerCase(),
      timestamp: POSTFLIGHT_NOW + 100,
    },
    stateAnchor: {
      blockHash: id("shared postflight finalized block").toLowerCase(),
      requireCanonical: true,
    },
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
      transactionHash: id(`shared deployment transaction ${deploymentIndex}`).toLowerCase(),
      from: value.from,
      to: null,
      nonce: value.nonce,
      valueWei: "0",
      dataHash: value.initCodeHash,
      expectedContractAddress: value.expectedContractAddress,
      receipt: receipt(deploymentIndex + 1),
    })),
    controllerActions: plan.controllerSafeActions.map((value, actionIndex) => ({
      name: value.name,
      transactionHash: id(`shared controller transaction ${actionIndex}`).toLowerCase(),
      safeAddress: value.safeAddress,
      to: value.to,
      valueWei: "0",
      operation: "CALL",
      dataHash: value.dataHash,
      actionDigest: value.actionDigest,
      safeExecutionSuccess: true,
      receipt: receipt(actionIndex + 5),
    })),
    manifest,
    manifestDigest: closedTestnetDeploymentPostflightValueDigest(manifest),
  };
}

export async function createVerifiedDeploymentPostflightFixture() {
  const plan = await buildClosedTestnetDeploymentPlan({
    input: deploymentInput(),
    artifacts: closedTestnetArtifactFixtures(),
  });
  const providers = [
    {
      id: id("shared postflight provider alpha").toLowerCase(),
      label: "provider-alpha",
      wallet: new Wallet(`0x${"22".repeat(32)}`),
    },
    {
      id: id("shared postflight provider beta").toLowerCase(),
      label: "provider-beta",
      wallet: new Wallet(`0x${"33".repeat(32)}`),
    },
  ].sort((left, right) => left.id.localeCompare(right.id));
  const operations = {
    id: id("shared postflight operations reviewer").toLowerCase(),
    wallet: new Wallet(`0x${"11".repeat(32)}`),
  };
  const contract = {
    id: id("shared postflight contract reviewer").toLowerCase(),
    wallet: new Wallet(`0x${"44".repeat(32)}`),
  };
  const preflight = await buildPreflight(plan, providers, operations);
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
    postflightId: id("shared postflight record").toLowerCase(),
    preparedAt: POSTFLIGHT_NOW + 120,
  });
  const candidate = {
    preflight,
    deploymentPolicy: candidateDeploymentPolicy,
    policy,
    record,
    observations,
    approvers,
  };
  const attestations = [];
  for (const approver of approvers) {
    const approval = buildClosedTestnetDeploymentPostflightApprovalMessage({
      ...candidate,
      role: approver.role,
      approverId: approver.approverId,
    });
    attestations.push({
      role: approver.role,
      approverId: approver.approverId,
      signer: approver.wallet.address,
      signature: await approver.wallet.signTypedData(approval.domain, approval.types, approval.value),
    });
  }
  const verification = verifyClosedTestnetDeploymentPostflight({
    ...candidate,
    attestations,
    now: POSTFLIGHT_NOW + 120,
  });
  return Object.freeze({ candidate, attestations, verification });
}
