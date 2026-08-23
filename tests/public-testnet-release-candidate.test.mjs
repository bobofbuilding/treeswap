import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface, Wallet, hexlify, id, toUtf8Bytes } from "ethers";
import {
  createVerifiedDeploymentPromotionFixture,
  NOW as PROMOTION_NOW,
} from "./fixtures/verified-deployment-promotion.mjs";
import {
  createVerifiedPublicTestnetCampaignFixture,
} from "./fixtures/verified-public-testnet-campaign.mjs";
import {
  createVerifiedPublicTestnetBootstrapFixture,
  fixture as bootstrapFixture,
  sign as signBootstrapFixture,
} from "./fixtures/verified-public-testnet-bootstrap.mjs";
import {
  createVerifiedIndependentReviewFixture,
  fixture as reviewFixture,
  sign as signReviewFixture,
} from "./fixtures/verified-independent-review.mjs";
import {
  createVerifiedOperationalReadinessFixture,
  fixture as operationsFixture,
  sign as signOperationsFixture,
} from "./fixtures/verified-operational-readiness.mjs";
import { createVerifiedServiceIsolationFixture } from "./fixtures/verified-service-isolation.mjs";
import { createVerifiedSolverCapabilityFixture } from "./fixtures/verified-solver-capability.mjs";
import { verifyPublicTestnetBootstrapEvidence } from "../lib/public-testnet-bootstrap-evidence.mjs";
import { verifyIndependentReviewEvidence } from "../lib/independent-review-evidence.mjs";
import { verifyOperationalReadinessEvidence } from "../lib/operational-readiness-evidence.mjs";
import { buildAdoptionPolicyEvidence } from "../lib/adoption-policy.mjs";
import {
  buildPublicTestnetReleaseApproval,
  buildPublicTestnetReleaseCandidateSummary,
  preparePublicTestnetBootstrapReleaseCandidate,
  preparePublicTestnetReleaseCandidate,
} from "../lib/public-testnet-release-candidate.mjs";
import {
  buildReleaseApprovalMessage,
  erc1271ProviderSetDigest,
} from "../lib/release-authorization.mjs";
import {
  createPublicTestnetReleaseApprovalProviderSet,
  inspectPreparedPublicTestnetReleaseCandidate,
} from "../lib/public-testnet-release-approval.mjs";
import {
  activatePublicTestnetRelease,
  authorizeSolverFunding,
  buildPublicTestnetRuntimeReconciliationApproval,
  publicTestnetReleaseOpenRiskDigest,
} from "../lib/capabilities.mjs";

const ZERO = `0x${"00".repeat(32)}`;
const LIGHTNING_OPERATOR = new Wallet(`0x${"55".repeat(32)}`);
const SECURITY_REVIEWER = new Wallet(`0x${"66".repeat(32)}`);
const INCIDENT_COMMANDER = new Wallet(`0x${"77".repeat(32)}`);
const ERC1271 = new Interface([
  "function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)",
]);
const GATE = new Interface([
  "function isOpen() view returns (bool)",
  "function emergencyHalted() view returns (bool)",
  "function openUntil() view returns (uint64)",
  "function activeRiskDigest() view returns (bytes32)",
]);
const WALLET = new Interface([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const REGISTRY = new Interface([
  "function isSealed() view returns (bool)",
  "function escrowCount() view returns (uint8)",
  "function approvedEscrow(address escrow) view returns (bool)",
]);
const VAULT = new Interface([
  "function totalAvailable() view returns (uint256)",
  "function totalLocked() view returns (uint256)",
  "function accountedBalance() view returns (uint256)",
]);
const USER_ESCROW = new Interface(["function totalLocked() view returns (uint256)"]);
const BIT = new Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function paused() view returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const REVIEWED_CONTRACT_CODE = hexlify(toUtf8Bytes("shared postflight reviewed contract runtime"));
const CONTROLLER_CODE = hexlify(toUtf8Bytes("shared postflight role 2 runtime"));
const FEE_COLLECTOR_CODE = hexlify(toUtf8Bytes("shared postflight role 3 runtime"));
const GUARDIAN_CODE = hexlify(toUtf8Bytes("shared postflight role 4 runtime"));
const BIT_PROXY_CODE = hexlify(toUtf8Bytes("shared postflight BIT proxy"));
const BIT_IMPLEMENTATION_CODE = hexlify(toUtf8Bytes("shared postflight BIT implementation"));

function encodedCallResult(data, values) {
  for (const [contractInterface, functionName, result] of values) {
    if (data.startsWith(contractInterface.getFunction(functionName).selector)) {
      return contractInterface.encodeFunctionResult(functionName, result);
    }
  }
  throw new Error(`unexpected runtime call selector ${data.slice(0, 10)}`);
}

function releaseRpcFetch({ candidate, deployment, now, overrides = {} }) {
  const manifest = deployment.verification.manifest;
  const headHash = id("same-process release activation head").toLowerCase();
  const riskDigest = overrides.riskDigest ?? publicTestnetReleaseOpenRiskDigest(candidate);
  const available = BigInt(overrides.vaultAvailableWei ?? candidate.record.limits.minBitReserveWei);
  const vaultLocked = BigInt(overrides.vaultLockedWei ?? "0");
  const userLocked = BigInt(overrides.userEscrowLockedWei ?? "0");
  const accounted = BigInt(overrides.vaultAccountedBalanceWei ?? available + vaultLocked);
  const vaultBalance = BigInt(overrides.vaultBitBalanceWei ?? accounted);
  const userBalance = BigInt(overrides.userEscrowBitBalanceWei ?? userLocked);
  return async (url, options) => {
    const payload = JSON.parse(options.body);
    const providerTwo = new URL(url).hostname.startsWith("two");
    let result;
    if (payload.method === "eth_chainId") {
      result = "0xaa36a7";
    } else if (payload.method === "eth_getBlockByNumber") {
      const tag = payload.params[0];
      if (tag === `0x${Number(candidate.record.approvalBlockNumber).toString(16)}`) {
        result = {
          number: tag,
          hash: candidate.record.approvalBlockHash,
          timestamp: `0x${candidate.record.approvalBlockTimestamp.toString(16)}`,
        };
      } else {
        result = {
          number: "0x4b0",
          hash: providerTwo && overrides.providerDisagreement
            ? id("disagreeing release activation head").toLowerCase()
            : headHash,
          timestamp: `0x${now.toString(16)}`,
        };
      }
    } else if (payload.method === "eth_getStorageAt") {
      const implementation = overrides.implementationAddress ?? manifest.bit.implementationAddress;
      result = `0x${implementation.slice(2).padStart(64, "0")}`;
    } else if (payload.method === "eth_getCode") {
      const target = String(payload.params[0]).toLowerCase();
      const codes = new Map([
        [manifest.controller.address.toLowerCase(), CONTROLLER_CODE],
        [manifest.feeCollector.address.toLowerCase(), FEE_COLLECTOR_CODE],
        [manifest.guardian.address.toLowerCase(), GUARDIAN_CODE],
        [manifest.gate.address.toLowerCase(), REVIEWED_CONTRACT_CODE],
        [manifest.paymentHashRegistry.address.toLowerCase(), REVIEWED_CONTRACT_CODE],
        [manifest.vault.address.toLowerCase(), REVIEWED_CONTRACT_CODE],
        [manifest.userEscrow.address.toLowerCase(), REVIEWED_CONTRACT_CODE],
        [manifest.bit.proxyAddress.toLowerCase(), BIT_PROXY_CODE],
        [manifest.bit.implementationAddress.toLowerCase(), BIT_IMPLEMENTATION_CODE],
      ]);
      result = codes.get(target) ?? REVIEWED_CONTRACT_CODE;
    } else if (payload.method === "eth_call") {
      const target = String(payload.params[0].to).toLowerCase();
      const data = payload.params[0].data;
      if ([manifest.controller.address, manifest.guardian.address, manifest.feeCollector.address]
        .map((value) => value.toLowerCase()).includes(target)) {
        const role = [manifest.controller, manifest.guardian, manifest.feeCollector]
          .find((value) => value.address.toLowerCase() === target);
        if (data.startsWith(ERC1271.getFunction("isValidSignature").selector)) {
          result = ERC1271.encodeFunctionResult("isValidSignature", ["0x1626ba7e"]);
        } else {
          const owners = role === manifest.controller && overrides.controllerOwners
            ? overrides.controllerOwners
            : role.ownerAddresses;
          result = encodedCallResult(data, [
            [WALLET, "getOwners", [owners]],
            [WALLET, "getThreshold", [role.threshold]],
          ]);
        }
      } else if (target === manifest.gate.address.toLowerCase()) {
        result = encodedCallResult(data, [
          [GATE, "isOpen", [overrides.gateOpen ?? true]],
          [GATE, "emergencyHalted", [overrides.emergencyHalted ?? false]],
          [GATE, "openUntil", [overrides.openUntil ?? candidate.record.validUntil]],
          [GATE, "activeRiskDigest", [riskDigest]],
        ]);
      } else if (target === manifest.paymentHashRegistry.address.toLowerCase()) {
        result = encodedCallResult(data, [
          [REGISTRY, "isSealed", [overrides.registrySealed ?? true]],
          [REGISTRY, "escrowCount", [2]],
          [REGISTRY, "approvedEscrow", [true]],
        ]);
      } else if (target === manifest.vault.address.toLowerCase()) {
        result = encodedCallResult(data, [
          [VAULT, "totalAvailable", [available]],
          [VAULT, "totalLocked", [vaultLocked]],
          [VAULT, "accountedBalance", [accounted]],
        ]);
      } else if (target === manifest.userEscrow.address.toLowerCase()) {
        result = USER_ESCROW.encodeFunctionResult("totalLocked", [userLocked]);
      } else if (target === manifest.bit.proxyAddress.toLowerCase()) {
        if (data.startsWith(BIT.getFunction("paused").selector)) {
          result = BIT.encodeFunctionResult("paused", [overrides.bitPaused ?? false]);
        } else if (data.startsWith(BIT.getFunction("decimals").selector)) {
          result = BIT.encodeFunctionResult("decimals", [overrides.bitDecimals ?? manifest.bit.decimals]);
        } else if (data.startsWith(BIT.getFunction("symbol").selector)) {
          result = BIT.encodeFunctionResult("symbol", [manifest.bit.symbol]);
        } else {
          const account = BIT.decodeFunctionData("balanceOf", data)[0];
          result = BIT.encodeFunctionResult("balanceOf", [
            account.toLowerCase() === manifest.vault.address.toLowerCase() ? vaultBalance : userBalance,
          ]);
        }
      } else {
        throw new Error(`unexpected runtime target ${target}`);
      }
    } else {
      throw new Error(`unexpected release activation RPC ${payload.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function providerSetFor({ candidate, campaign, deployment, now, overrides = {} }) {
  const providerIdentities = campaign.candidate.record.participants
    .filter((value) => value.role === "evm-provider")
    .map((value) => value.operatorId);
  return createPublicTestnetReleaseApprovalProviderSet({
    configuration: {
      schema: "treeswap.public-testnet-release-approval-providers.v1",
      providers: [
        { identity: providerIdentities[0], urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_ONE_URL" },
        { identity: providerIdentities[1], urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_TWO_URL" },
      ],
    },
    environment: {
      TREESWAP_RELEASE_RPC_ONE_URL: "https://one.example/rpc/private-token",
      TREESWAP_RELEASE_RPC_TWO_URL: "https://two.example/rpc/private-token",
    },
    fetchImpl: releaseRpcFetch({ candidate, deployment, now, overrides }),
    expectedProviderCount: 2,
    expectedProviderSetDigest: candidate.record.approvalProviderSetDigest,
  });
}

async function releaseApprovalBundle(candidate) {
  const approvals = [];
  for (const role of ["controller", "guardian"]) {
    approvals.push({ role, signer: candidate.policy.approvers[role].address, signatureKind: "erc1271", signature: "0x1234" });
  }
  for (const [role, wallet] of [
    ["lightningOperator", LIGHTNING_OPERATOR],
    ["securityReviewer", SECURITY_REVIEWER],
    ["incidentCommander", INCIDENT_COMMANDER],
  ]) {
    approvals.push({
      role,
      signer: wallet.address,
      signatureKind: "eip712",
      signature: await wallet.signTypedData(
        { ...candidate.approval.domain, chainId: BigInt(candidate.approval.domain.chainId) },
        candidate.approval.types,
        candidate.approval.message,
      ),
    });
  }
  return {
    schema: "treeswap.public-testnet-release-approvals.v1",
    releaseId: candidate.record.releaseId,
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    approvals,
  };
}

async function runtimeReconciliation(candidate, now, overrides = {}) {
  const reconciliation = {
    schema: "treeswap.runtime-reconciliation.v1",
    releaseId: candidate.record.releaseId,
    releaseRecordDigest: candidate.recordDigest,
    releasePolicyDigest: candidate.policyDigest,
    observedAt: now,
    validUntil: now + 20,
    lightningAvailableSats: candidate.record.limits.minLightningReserveSats,
    lightningInFlightSats: "0",
    epochVolumeSats: "0",
    dailyLightningSats: "0",
    unreconciledLiabilities: "0",
    lightningInventoryDigest: id("live Lightning inventory").toLowerCase(),
    coordinatorStateDigest: id("live coordinator state").toLowerCase(),
    inFlightDigest: id("live in-flight state").toLowerCase(),
    ...overrides,
  };
  const payload = buildPublicTestnetRuntimeReconciliationApproval({ candidate, reconciliation });
  const approvals = [];
  for (const [role, wallet] of [
    ["lightningOperator", LIGHTNING_OPERATOR],
    ["securityReviewer", SECURITY_REVIEWER],
  ]) {
    approvals.push({
      role,
      signer: wallet.address,
      signature: await wallet.signTypedData(
        { ...payload.domain, chainId: BigInt(payload.domain.chainId) },
        payload.types,
        payload.value,
      ),
    });
  }
  return { approvals, reconciliation };
}

function recordTemplate(approvalBlockTimestamp = PROMOTION_NOW + 60) {
  return {
    schema: "treeswap.public-testnet-release-record-template.v3",
    releaseId: id("evidence-bound public testnet release").toLowerCase(),
    protocolVersion: "1.0.0-testnet.1",
    approvalBlockNumber: "1100",
    approvalBlockHash: id("release approval block").toLowerCase(),
    approvalBlockTimestamp,
    priorReleaseDigest: ZERO,
    multisig: { ownerCount: 3, threshold: 2 },
    limits: {
      maxDailyLightningSats: "100000",
      maxEpochSats: "50000",
      maxInFlightSats: "10000",
      maxPriceBandBps: "500",
      maxRoutingFeeSats: "100",
      maxSwapSats: "5000",
      minBitReserveWei: "1000000000000000000",
      minLightningReserveSats: "25000",
    },
    features: {
      lpShares: false,
      makerRewards: false,
      partialFills: false,
      promisedYield: false,
      publicLpDeposits: false,
      publicPermissionlessExecution: true,
      webSolverFunding: true,
    },
    validFrom: approvalBlockTimestamp - 10,
    validUntil: approvalBlockTimestamp + 3_000,
  };
}

function policyTemplate(manifest) {
  return {
    schema: "treeswap.public-testnet-release-policy-template.v1",
    maximumReleaseLifetimeSeconds: 3_600,
    maximumRuntimeObservationAgeSeconds: 30,
    limitPolicy: {
      maximums: {
        maxDailyLightningSats: "100000",
        maxEpochSats: "50000",
        maxInFlightSats: "10000",
        maxPriceBandBps: "500",
        maxRoutingFeeSats: "100",
        maxSwapSats: "5000",
      },
      minimumReserves: {
        minBitReserveWei: "1000000000000000000",
        minLightningReserveSats: "25000",
      },
    },
    approvers: {
      controller: {
        address: manifest.controller.address,
        codeHash: manifest.controller.codeHash,
        signatureKind: "erc1271",
      },
      guardian: {
        address: manifest.guardian.address,
        codeHash: manifest.guardian.codeHash,
        signatureKind: "erc1271",
      },
      lightningOperator: { address: LIGHTNING_OPERATOR.address, codeHash: ZERO, signatureKind: "eip712" },
      securityReviewer: { address: SECURITY_REVIEWER.address, codeHash: ZERO, signatureKind: "eip712" },
      incidentCommander: { address: INCIDENT_COMMANDER.address, codeHash: ZERO, signatureKind: "eip712" },
    },
  };
}

function bootstrapRecordTemplate() {
  const value = recordTemplate();
  value.limits = {
    ...value.limits,
    maxDailyLightningSats: "10000",
    maxEpochSats: "5000",
    maxInFlightSats: "1000",
    maxPriceBandBps: "250",
    maxRoutingFeeSats: "50",
    maxSwapSats: "500",
  };
  value.features.publicPermissionlessExecution = false;
  return value;
}

function bootstrapPolicyTemplate(manifest) {
  const value = policyTemplate(manifest);
  value.limitPolicy.maximums = {
    maxDailyLightningSats: "10000",
    maxEpochSats: "5000",
    maxInFlightSats: "1000",
    maxPriceBandBps: "250",
    maxRoutingFeeSats: "50",
    maxSwapSats: "500",
  };
  return value;
}

function postflightBundle(deployment) {
  return {
    schema: "treeswap.deployment-promotion-postflight-bundle.v1",
    plan: deployment.candidate.postflight.preflight.plan,
    preflightPolicy: deployment.candidate.postflight.preflight.policy,
    preflightRecord: deployment.candidate.postflight.preflight.record,
    preflightObservations: deployment.candidate.postflight.preflight.observations,
    preflightAttestations: deployment.candidate.postflight.preflight.attestations,
    policy: deployment.candidate.postflight.policy,
    record: deployment.candidate.postflight.record,
    observations: deployment.candidate.postflight.observations,
    attestations: deployment.candidate.postflightAttestations,
  };
}

async function fixture() {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const campaign = await createVerifiedPublicTestnetCampaignFixture({
    finishedAt: PROMOTION_NOW - 100,
    chainId: deployment.verification.record.chainId,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    verifyingContract: deployment.verification.record.verifyingContract,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    now: PROMOTION_NOW + 60,
  });
  const review = await createVerifiedIndependentReviewFixture({
    deployment,
    finishedAt: PROMOTION_NOW + 20,
    now: PROMOTION_NOW + 60,
  });
  const monitor = campaign.candidate.record.participants.find((value) => value.role === "monitor");
  const operations = await createVerifiedOperationalReadinessFixture({
    deployment,
    upstream: campaign,
    fundingMode: "operator-testnet",
    preparedAt: PROMOTION_NOW + 30,
    now: PROMOTION_NOW + 60,
    lightningOperatorWallet: LIGHTNING_OPERATOR,
    incidentCommanderWallet: INCIDENT_COMMANDER,
    securityReviewerWallet: SECURITY_REVIEWER,
    monitoringOperatorWallet: campaign.candidate.wallets.get(monitor.signer),
  });
  const candidate = preparePublicTestnetReleaseCandidate({
    recordTemplate: recordTemplate(),
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
    publicTestnetVerification: campaign.verification,
  });
  return { campaign, candidate, deployment, operations, review };
}

test("derives one exact release candidate from verified deployment, campaign, and independent-review evidence", async () => {
  const { candidate, operations, review } = await fixture();
  assert.equal(candidate.status, "deployment-campaign-review-and-operations-evidence-verified-awaiting-five-role-release-approvals");
  assert.equal(candidate.scope.includes("no-signing"), true);
  assert.equal(candidate.record.counts.independentMonitors, 2);
  assert.equal(candidate.record.counts.multisigOwnerCount, 3);
  assert.equal(candidate.record.counts.multisigThreshold, 2);
  assert.notEqual(candidate.record.evidenceDigests.deploymentPromotion, candidate.evidence.deploymentPromotionRecordDigest);
  assert.notEqual(candidate.record.evidenceDigests.publicTestnet, candidate.evidence.publicTestnetRecordDigest);
  assert.notEqual(candidate.record.evidenceDigests.providerQuorum, ZERO);
  assert.notEqual(candidate.record.evidenceDigests.findingsDisposition, ZERO);
  assert.deepEqual(candidate.record.reviewDigests, review.verification.record.reports
    && Object.fromEntries(Object.entries(review.verification.record.reports).map(([field, value]) => [
      field,
      value.reportDigest,
    ])));
  assert.equal(candidate.evidence.independentReviewRecordDigest, review.verification.recordDigest);
  assert.equal(candidate.evidence.operationalReadinessRecordDigest, operations.verification.recordDigest);
  assert.equal(candidate.evidence.adoptionPolicyDigest, operations.verification.adoptionPolicyDigest);
  assert.deepEqual(buildReleaseApprovalMessage(candidate.record, candidate.policy), candidate.approval.message);
  assert.equal(buildPublicTestnetReleaseApproval(candidate).value.recordDigest, candidate.recordDigest);
  assert.equal(
    inspectPreparedPublicTestnetReleaseCandidate(structuredClone(candidate)).recordDigest,
    candidate.recordDigest,
  );
  assert.throws(() => { candidate.record.limits.maxSwapSats = "999999"; }, /read only|Cannot assign/);
  assert.equal(candidate.record.limits.maxSwapSats, "5000");
  const summary = buildPublicTestnetReleaseCandidateSummary(candidate);
  assert.equal(summary.fundingAuthorization, false);
  assert.equal(summary.recordDigest, candidate.recordDigest);
});

test("activates funding only after same-process evidence, approvals, reconciliation, and live RPC quorum checks", async () => {
  const { campaign, candidate, deployment } = await fixture();
  const now = candidate.record.approvalBlockTimestamp + 120;
  const approvalBundle = await releaseApprovalBundle(candidate);
  const providerSet = providerSetFor({ candidate, campaign, deployment, now });
  const reconciliation = await runtimeReconciliation(candidate, now);
  const activation = await activatePublicTestnetRelease({
    candidate,
    approvalBundle,
    providerSet,
    reconciliation: reconciliation.reconciliation,
    reconciliationApprovals: reconciliation.approvals,
    now,
  });
  const solverCapability = await createVerifiedSolverCapabilityFixture({
    now,
    chainId: candidate.record.chainId,
    lightningToBitContract: deployment.verification.manifest.vault.address,
    lightningToBitContractCodeHash: deployment.verification.manifest.vault.codeHash,
    bitToLightningContract: deployment.verification.manifest.userEscrow.address,
    bitToLightningContractCodeHash: deployment.verification.manifest.userEscrow.codeHash,
  });
  const inverseSolverCapability = await createVerifiedSolverCapabilityFixture({
    now,
    chainId: candidate.record.chainId,
    lightningToBitContract: deployment.verification.manifest.vault.address,
    lightningToBitContractCodeHash: deployment.verification.manifest.vault.codeHash,
    bitToLightningContract: deployment.verification.manifest.userEscrow.address,
    bitToLightningContractCodeHash: deployment.verification.manifest.userEscrow.codeHash,
    direction: "bit-to-lightning",
    endpointOrigin: "https://inverse-solver.example",
    solverPrivateKey: `0x${"93".repeat(32)}`,
  });
  assert.equal(activation.status, "same-process-release-and-runtime-verification-active");
  assert.equal(activation.receipt.authorizations.funding, false);
  assert.equal(activation.runtimeBlockNumber, 1_200);
  const decision = authorizeSolverFunding({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now,
  });
  assert.deepEqual(decision, { allowed: true, reasons: [] });
  assert.deepEqual(authorizeSolverFunding({
    solverCapabilityVerification: inverseSolverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now,
  }), { allowed: true, reasons: [] });
  const expiredReconciliation = authorizeSolverFunding({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now: activation.validUntil + 1,
  });
  assert.equal(expiredReconciliation.allowed, false);
  assert.match(expiredReconciliation.reasons.join("; "), /runtime reconciliation is expired/);

  const copiedSnapshot = authorizeSolverFunding({
    solverCapabilityVerification: solverCapability.verification,
    deployment: structuredClone(activation.deployment),
    capabilities: activation.capabilities,
    now,
  });
  assert.equal(copiedSnapshot.allowed, false);
  assert.match(copiedSnapshot.reasons.join("; "), /same-process live runtime activation/);
  const copiedCapability = authorizeSolverFunding({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: { ...activation.capabilities },
    now,
  });
  assert.equal(copiedCapability.allowed, false);
  assert.match(copiedCapability.reasons.join("; "), /cryptographically verified release capability/);
});

test("funding authorization rejects nominal flags, copied proofs, expiry, stale capacity, and wrong release bindings", async () => {
  const { campaign, candidate, deployment } = await fixture();
  const now = candidate.record.approvalBlockTimestamp + 120;
  const approvalBundle = await releaseApprovalBundle(candidate);
  const providerSet = providerSetFor({ candidate, campaign, deployment, now });
  const reconciliation = await runtimeReconciliation(candidate, now);
  const activation = await activatePublicTestnetRelease({
    candidate,
    approvalBundle,
    providerSet,
    reconciliation: reconciliation.reconciliation,
    reconciliationApprovals: reconciliation.approvals,
    now,
  });
  const manifest = deployment.verification.manifest;
  const capabilityInput = {
    now,
    chainId: candidate.record.chainId,
    lightningToBitContract: manifest.vault.address,
    lightningToBitContractCodeHash: manifest.vault.codeHash,
    bitToLightningContract: manifest.userEscrow.address,
    bitToLightningContractCodeHash: manifest.userEscrow.codeHash,
  };
  const nominal = await createVerifiedSolverCapabilityFixture(capabilityInput);

  const callerFlags = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", capabilityVerified: true },
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now,
  });
  assert.equal(callerFlags.allowed, false);
  assert.match(callerFlags.reasons.join("; "), /locally verified solver capability/);

  const copied = authorizeSolverFunding({
    solverCapabilityVerification: { ...nominal.verification },
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now,
  });
  assert.equal(copied.allowed, false);
  assert.match(copied.reasons.join("; "), /locally verified solver capability/);

  const expiring = await createVerifiedSolverCapabilityFixture({ ...capabilityInput, expiresAt: now + 1 });
  const expired = authorizeSolverFunding({
    solverCapabilityVerification: expiring.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now: now + 1,
  });
  assert.equal(expired.allowed, false);
  assert.match(expired.reasons.join("; "), /solver capability is expired/);

  const wrongChain = await createVerifiedSolverCapabilityFixture({ ...capabilityInput, chainId: "1" });
  const wrongChainDecision = authorizeSolverFunding({
    solverCapabilityVerification: wrongChain.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now,
  });
  assert.equal(wrongChainDecision.allowed, false);
  assert.match(wrongChainDecision.reasons.join("; "), /not bound to the active release escrow/);

  const wrongContract = await createVerifiedSolverCapabilityFixture({
    ...capabilityInput,
    lightningToBitContract: "0x9999999999999999999999999999999999999999",
    lightningToBitContractCodeHash: id("wrong release escrow runtime").toLowerCase(),
  });
  const wrongContractDecision = authorizeSolverFunding({
    solverCapabilityVerification: wrongContract.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now,
  });
  assert.equal(wrongContractDecision.allowed, false);
  assert.match(wrongContractDecision.reasons.join("; "), /not bound to the active release escrow/);

  const wrongRuntime = await createVerifiedSolverCapabilityFixture({
    ...capabilityInput,
    lightningToBitContractCodeHash: id("wrong code at the reviewed escrow").toLowerCase(),
  });
  const wrongRuntimeDecision = authorizeSolverFunding({
    solverCapabilityVerification: wrongRuntime.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now,
  });
  assert.equal(wrongRuntimeDecision.allowed, false);
  assert.match(wrongRuntimeDecision.reasons.join("; "), /not bound to the active release escrow/);

  const freshnessSeconds = candidate.policy.maximumRuntimeObservationAgeSeconds;
  const longLived = await createVerifiedSolverCapabilityFixture({
    ...capabilityInput,
    expiresAt: now + freshnessSeconds + 30,
    maxCapabilityTtlSeconds: freshnessSeconds + 60,
  });
  const staleCapacity = authorizeSolverFunding({
    solverCapabilityVerification: longLived.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now: now + freshnessSeconds + 1,
  });
  assert.equal(staleCapacity.allowed, false);
  assert.match(staleCapacity.reasons.join("; "), /solver capacity observation is stale or invalid/);
});

test("release activation rejects copied provenance, stale or bad signatures, provider disagreement, and unsafe live state", async () => {
  const { campaign, candidate, deployment } = await fixture();
  const now = candidate.record.approvalBlockTimestamp + 120;
  const approvalBundle = await releaseApprovalBundle(candidate);
  const reconciliation = await runtimeReconciliation(candidate, now);
  const nominalProviderSet = providerSetFor({ candidate, campaign, deployment, now });

  await assert.rejects(activatePublicTestnetRelease({
    candidate: structuredClone(candidate),
    approvalBundle,
    providerSet: nominalProviderSet,
    reconciliation: reconciliation.reconciliation,
    reconciliationApprovals: reconciliation.approvals,
    now,
  }), /candidate provenance/);
  await assert.rejects(activatePublicTestnetRelease({
    candidate,
    approvalBundle,
    providerSet: { ...nominalProviderSet },
    reconciliation: reconciliation.reconciliation,
    reconciliationApprovals: reconciliation.approvals,
    now,
  }), /provider set was not configured by this process/);

  const badApprovals = structuredClone(reconciliation.approvals);
  badApprovals[0].signature = badApprovals[1].signature;
  await assert.rejects(activatePublicTestnetRelease({
    candidate,
    approvalBundle,
    providerSet: nominalProviderSet,
    reconciliation: reconciliation.reconciliation,
    reconciliationApprovals: badApprovals,
    now,
  }), /runtime reconciliation signature is invalid/);

  const stale = await runtimeReconciliation(candidate, now, {
    observedAt: now - 30,
    validUntil: now - 10,
  });
  await assert.rejects(activatePublicTestnetRelease({
    candidate,
    approvalBundle,
    providerSet: nominalProviderSet,
    reconciliation: stale.reconciliation,
    reconciliationApprovals: stale.approvals,
    now,
  }), /not currently active/);

  for (const [overrides, expected] of [
    [{ providerDisagreement: true }, /providers disagree/],
    [{ riskDigest: id("substituted release risk").toLowerCase() }, /release-bound open gate/],
    [{ vaultBitBalanceWei: "0" }, /balances do not reconcile/],
    [{ vaultAvailableWei: "0", vaultAccountedBalanceWei: "0", vaultBitBalanceWei: "0" }, /reserve is below/],
    [{ bitPaused: true }, /BIT token state changed/],
    [{ bitDecimals: 17 }, /BIT token state changed/],
    [{ controllerOwners: ["0x9999999999999999999999999999999999999999"] }, /ownership changed/],
    [{ implementationAddress: "0x9999999999999999999999999999999999999999" }, /implementation changed/],
  ]) {
    const providerSet = providerSetFor({ candidate, campaign, deployment, now, overrides });
    await assert.rejects(activatePublicTestnetRelease({
      candidate,
      approvalBundle,
      providerSet,
      reconciliation: reconciliation.reconciliation,
      reconciliationApprovals: reconciliation.approvals,
      now,
    }), expected);
  }
});

test("derives a distinct tiny-limit bootstrap candidate before campaign evidence exists", async () => {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const bootstrap = await createVerifiedPublicTestnetBootstrapFixture({
    deployment,
    preparedAt: PROMOTION_NOW,
    now: PROMOTION_NOW + 60,
  });
  const review = await createVerifiedIndependentReviewFixture({
    deployment,
    finishedAt: PROMOTION_NOW + 20,
    now: PROMOTION_NOW + 60,
  });
  const monitor = bootstrap.candidate.record.participants.find((value) => value.role === "monitor");
  const operations = await createVerifiedOperationalReadinessFixture({
    deployment,
    upstream: bootstrap,
    fundingMode: "operator-testnet-bootstrap",
    preparedAt: PROMOTION_NOW + 30,
    now: PROMOTION_NOW + 60,
    lightningOperatorWallet: LIGHTNING_OPERATOR,
    incidentCommanderWallet: INCIDENT_COMMANDER,
    securityReviewerWallet: SECURITY_REVIEWER,
    monitoringOperatorWallet: bootstrap.candidate.wallets.get(monitor.signer),
  });
  const candidate = preparePublicTestnetBootstrapReleaseCandidate({
    recordTemplate: bootstrapRecordTemplate(),
    policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
    bootstrapEvidenceVerification: bootstrap.verification,
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
  });
  assert.equal(candidate.record.fundingMode, "operator-testnet-bootstrap");
  assert.equal(candidate.record.evidenceDigests.publicTestnet, ZERO);
  assert.equal(candidate.record.limits.maxSwapSats, "500");
  assert.equal(candidate.record.counts.independentMonitors, 2);
  assert.notEqual(candidate.evidence.bootstrapEvidenceDigest, bootstrap.verification.recordDigest);
  assert.equal(candidate.evidence.adoptionPolicyDigest, operations.verification.adoptionPolicyDigest);
  assert.notEqual(candidate.record.evidenceDigests.solverOperations, bootstrap.candidate.record.artifacts.solverOperations);
  assert.equal(
    candidate.record.approvalProviderSetDigest,
    erc1271ProviderSetDigest(
      deployment.verification.record.providerObservations.map((value) => value.providerIdentity),
    ),
  );
  assert.equal(candidate.authorizations.funding, false);
  assert.equal(buildPublicTestnetReleaseApproval(candidate).value.recordDigest, candidate.recordDigest);
  assert.equal(
    inspectPreparedPublicTestnetReleaseCandidate(structuredClone(candidate)).candidateSchema,
    "treeswap.prepared-public-testnet-bootstrap-release-candidate.v4",
  );

  assert.throws(() => preparePublicTestnetBootstrapReleaseCandidate({
    recordTemplate: bootstrapRecordTemplate(),
    policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
    bootstrapEvidenceVerification: structuredClone(bootstrap.verification),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
  }), /bootstrap evidence provenance/);

  const substitutedInput = bootstrapFixture({ deployment, preparedAt: PROMOTION_NOW });
  const firstProvider = substitutedInput.record.participants.find((value) => value.role === "evm-provider");
  const oldSigner = firstProvider.signer;
  const attacker = Wallet.createRandom();
  firstProvider.operatorId = id("attacker provider identity").toLowerCase();
  firstProvider.signer = attacker.address;
  substitutedInput.wallets.delete(oldSigner);
  substitutedInput.wallets.set(attacker.address, attacker);
  substitutedInput.record.participants.sort((left, right) => (
    `${left.role}:${left.operatorId}`.localeCompare(`${right.role}:${right.operatorId}`)
  ));
  await signBootstrapFixture(substitutedInput);
  const substitutedBootstrap = verifyPublicTestnetBootstrapEvidence({
    ...substitutedInput,
    now: PROMOTION_NOW + 60,
  });
  assert.throws(() => preparePublicTestnetBootstrapReleaseCandidate({
    recordTemplate: bootstrapRecordTemplate(),
    policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
    bootstrapEvidenceVerification: substitutedBootstrap,
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
  }), /EVM providers do not exactly match/);

  const outsideEvidenceWindow = bootstrapRecordTemplate();
  outsideEvidenceWindow.validUntil = bootstrap.verification.record.validUntil + 1;
  assert.throws(() => preparePublicTestnetBootstrapReleaseCandidate({
    recordTemplate: outsideEvidenceWindow,
    policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
    bootstrapEvidenceVerification: bootstrap.verification,
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
  }), /validity is outside the signed operator-evidence interval/);

  const excessive = recordTemplate();
  assert.throws(
    () => preparePublicTestnetBootstrapReleaseCandidate({
      recordTemplate: excessive,
      policyTemplate: policyTemplate(deployment.verification.manifest),
      bootstrapEvidenceVerification: bootstrap.verification,
      deploymentPromotionVerification: deployment.verification,
      independentReviewVerification: review.verification,
      operationalReadinessVerification: operations.verification,
    }),
    /adoption maxDailyLightningSats does not match/,
  );
  const permissionlessBootstrap = bootstrapRecordTemplate();
  permissionlessBootstrap.features.publicPermissionlessExecution = true;
  assert.throws(
    () => preparePublicTestnetBootstrapReleaseCandidate({
      recordTemplate: permissionlessBootstrap,
      policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
      bootstrapEvidenceVerification: bootstrap.verification,
      deploymentPromotionVerification: deployment.verification,
      independentReviewVerification: review.verification,
      operationalReadinessVerification: operations.verification,
    }),
    /must keep public permissionless execution disabled/,
  );
  const copied = structuredClone(deployment.verification);
  assert.throws(
    () => preparePublicTestnetBootstrapReleaseCandidate({
      recordTemplate: bootstrapRecordTemplate(),
      policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
      bootstrapEvidenceVerification: bootstrap.verification,
      deploymentPromotionVerification: copied,
      independentReviewVerification: review.verification,
      operationalReadinessVerification: operations.verification,
    }),
    /provenance/,
  );

  const capturedReviewInput = reviewFixture({ deployment, finishedAt: PROMOTION_NOW + 20 });
  const capturedReviewer = capturedReviewInput.record.participants[0];
  const bootstrapOperator = bootstrap.candidate.record.participants.find(
    (value) => value.role === "lightning-observer",
  );
  capturedReviewInput.wallets.delete(capturedReviewer.signer);
  capturedReviewer.signer = bootstrapOperator.signer;
  capturedReviewInput.wallets.set(
    bootstrapOperator.signer,
    bootstrap.candidate.wallets.get(bootstrapOperator.signer),
  );
  await signReviewFixture(capturedReviewInput);
  const capturedReviewVerification = verifyIndependentReviewEvidence({
    ...capturedReviewInput,
    now: PROMOTION_NOW + 60,
  });
  assert.throws(
    () => preparePublicTestnetBootstrapReleaseCandidate({
      recordTemplate: bootstrapRecordTemplate(),
      policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
      bootstrapEvidenceVerification: bootstrap.verification,
      deploymentPromotionVerification: deployment.verification,
      independentReviewVerification: capturedReviewVerification,
      operationalReadinessVerification: operations.verification,
    }),
    /reviewer signer overlaps/,
  );
});

test("requires live provenance and rejects copied or mismatched upstream evidence", async () => {
  const { campaign, deployment, operations, review } = await fixture();
  const input = {
    recordTemplate: recordTemplate(),
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
    publicTestnetVerification: campaign.verification,
  };
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...input,
      deploymentPromotionVerification: structuredClone(deployment.verification),
    }),
    /provenance/,
  );
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...input,
      independentReviewVerification: structuredClone(review.verification),
    }),
    /provenance/,
  );
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...input,
      operationalReadinessVerification: structuredClone(operations.verification),
    }),
    /provenance/,
  );
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...input,
      publicTestnetVerification: structuredClone(campaign.verification),
    }),
    /provenance/,
  );
  assert.throws(
    () => buildPublicTestnetReleaseApproval(structuredClone((preparePublicTestnetReleaseCandidate(input)))),
    /provenance/,
  );

  const wrongManifestCampaign = await createVerifiedPublicTestnetCampaignFixture({
    finishedAt: PROMOTION_NOW - 100,
    chainId: deployment.verification.record.chainId,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    verifyingContract: deployment.verification.record.verifyingContract,
    deploymentManifestDigest: id("substituted manifest").toLowerCase(),
    now: PROMOTION_NOW + 60,
  });
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({ ...input, publicTestnetVerification: wrongManifestCampaign.verification }),
    /deployment manifest/,
  );
});

test("requires exact operational roles, alert channels, drills, artifacts, and release bindings", async () => {
  const { campaign, deployment, operations, review } = await fixture();
  const monitor = campaign.candidate.record.participants.find((value) => value.role === "monitor");
  const base = {
    recordTemplate: recordTemplate(),
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
    publicTestnetVerification: campaign.verification,
  };
  const rawOperations = (overrides = {}) => operationsFixture({
    deployment,
    upstream: campaign,
    serviceIsolation: operations.serviceIsolation,
    fundingMode: "operator-testnet",
    preparedAt: PROMOTION_NOW + 30,
    lightningOperatorWallet: LIGHTNING_OPERATOR,
    incidentCommanderWallet: INCIDENT_COMMANDER,
    securityReviewerWallet: SECURITY_REVIEWER,
    monitoringOperatorWallet: campaign.candidate.wallets.get(monitor.signer),
    ...overrides,
  });
  const verifyOperations = async (input) => {
    await signOperationsFixture(input);
    return verifyOperationalReadinessEvidence({ ...input, now: PROMOTION_NOW + 60 });
  };

  const wrongArtifact = rawOperations();
  wrongArtifact.record.artifacts.monitoring = id("substituted monitoring evidence").toLowerCase();
  const wrongArtifactVerification = await verifyOperations(wrongArtifact);
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: wrongArtifactVerification,
  }), /operational monitoring artifact/);

  const mismatchedAdoptionLimit = rawOperations();
  mismatchedAdoptionLimit.adoptionPolicy.limits.maxSwapSats = "4000";
  mismatchedAdoptionLimit.adoptionPolicy.liveness.establishedSolverMaxBitToLightningSats = "4000";
  const mismatchedAdoptionEvidence = buildAdoptionPolicyEvidence(mismatchedAdoptionLimit.adoptionPolicy);
  mismatchedAdoptionLimit.record.artifacts.lossAllocation = mismatchedAdoptionEvidence.lossAllocationDigest;
  mismatchedAdoptionLimit.record.artifacts.privacyRetention = mismatchedAdoptionEvidence.privacyRetentionDigest;
  mismatchedAdoptionLimit.record.artifacts.supportPolicy = mismatchedAdoptionEvidence.supportPolicyDigest;
  const mismatchedAdoptionLimitVerification = await verifyOperations(mismatchedAdoptionLimit);
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: mismatchedAdoptionLimitVerification,
  }), /adoption maxSwapSats does not match/);

  const wrongAlert = rawOperations();
  wrongAlert.record.alertChannelEvidenceDigests[0] = id("substituted alert channel").toLowerCase();
  wrongAlert.record.alertChannelEvidenceDigests.sort();
  const wrongAlertVerification = await verifyOperations(wrongAlert);
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: wrongAlertVerification,
  }), /operational alert channels/);

  const wrongDrill = rawOperations();
  wrongDrill.record.drills[0].evidenceDigest = id("substituted operational drill").toLowerCase();
  const wrongDrillVerification = await verifyOperations(wrongDrill);
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: wrongDrillVerification,
  }), /operational alert-delivery-and-escalation drill/);

  const wrongMonitor = await createVerifiedOperationalReadinessFixture({
    deployment,
    upstream: campaign,
    fundingMode: "operator-testnet",
    preparedAt: PROMOTION_NOW + 30,
    now: PROMOTION_NOW + 60,
    lightningOperatorWallet: LIGHTNING_OPERATOR,
    incidentCommanderWallet: INCIDENT_COMMANDER,
    securityReviewerWallet: SECURITY_REVIEWER,
    monitoringOperatorWallet: Wallet.createRandom(),
  });
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: wrongMonitor.verification,
  }), /not an exact signed upstream monitor/);

  const wrongIsolationReviewer = await createVerifiedOperationalReadinessFixture({
    deployment,
    upstream: campaign,
    fundingMode: "operator-testnet",
    preparedAt: PROMOTION_NOW + 30,
    now: PROMOTION_NOW + 60,
    lightningOperatorWallet: LIGHTNING_OPERATOR,
    incidentCommanderWallet: INCIDENT_COMMANDER,
    monitoringOperatorWallet: campaign.candidate.wallets.get(monitor.signer),
    securityReviewerWallet: Wallet.createRandom(),
  });
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: wrongIsolationReviewer.verification,
  }), /service-isolation security reviewer/);

  const wrongIsolationLightning = await createVerifiedServiceIsolationFixture({
    deployment,
    preparedAt: PROMOTION_NOW + 30,
    now: PROMOTION_NOW + 60,
    lightningOperatorWallet: Wallet.createRandom(),
    securityReviewerWallet: SECURITY_REVIEWER,
  });
  const wrongIsolationLightningOperations = await createVerifiedOperationalReadinessFixture({
    deployment,
    upstream: campaign,
    serviceIsolation: wrongIsolationLightning,
    fundingMode: "operator-testnet",
    preparedAt: PROMOTION_NOW + 30,
    now: PROMOTION_NOW + 60,
    lightningOperatorWallet: LIGHTNING_OPERATOR,
    incidentCommanderWallet: INCIDENT_COMMANDER,
    monitoringOperatorWallet: campaign.candidate.wallets.get(monitor.signer),
  });
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: wrongIsolationLightningOperations.verification,
  }), /service-isolation Lightning operator/);

  const capturedInfrastructure = rawOperations();
  const backupOperator = capturedInfrastructure.record.participants.find(
    (participant) => participant.role === "backup-operator",
  );
  const solver = campaign.candidate.record.participants.find((participant) => participant.role === "solver");
  capturedInfrastructure.wallets.delete(backupOperator.signer);
  backupOperator.signer = solver.signer;
  capturedInfrastructure.wallets.set(solver.signer, campaign.candidate.wallets.get(solver.signer));
  const capturedInfrastructureVerification = await verifyOperations(capturedInfrastructure);
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: capturedInfrastructureVerification,
  }), /non-monitor operational signer overlaps/);

  const wrongPolicy = policyTemplate(deployment.verification.manifest);
  wrongPolicy.approvers.incidentCommander = {
    ...wrongPolicy.approvers.incidentCommander,
    address: Wallet.createRandom().address,
  };
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    policyTemplate: wrongPolicy,
  }), /operational incident commander/);

  const legacyTemplate = recordTemplate();
  legacyTemplate.schema = "treeswap.public-testnet-release-record-template.v2";
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    recordTemplate: legacyTemplate,
  }), /record template schema is invalid/);
});

test("rejects stale ordering, unsigned review templates, reviewer capture, and deployment-wallet substitution", async () => {
  const { campaign, deployment, operations, review } = await fixture();
  const base = {
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
    publicTestnetVerification: campaign.verification,
  };
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...base,
      recordTemplate: recordTemplate(campaign.verification.record.finishedAt - 1),
    }),
    /predates.*campaign finish/,
  );
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...base,
      recordTemplate: recordTemplate(deployment.verification.record.validUntil + 1),
    }),
    /promotion expired/,
  );
  const unsignedReview = recordTemplate();
  unsignedReview.schema = "treeswap.public-testnet-release-record-template.v1";
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({ ...base, recordTemplate: unsignedReview }),
    /record template schema is invalid/,
  );
  const wrongMultisig = recordTemplate();
  wrongMultisig.multisig = { ownerCount: 4, threshold: 3 };
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({ ...base, recordTemplate: wrongMultisig }),
    /verified controller wallet/,
  );
  const wrongController = policyTemplate(deployment.verification.manifest);
  wrongController.approvers.controller = {
    ...wrongController.approvers.controller,
    address: Wallet.createRandom().address,
  };
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...base,
      recordTemplate: recordTemplate(),
      policyTemplate: wrongController,
    }),
    /controller approver does not exactly match/,
  );
  const wrongGuardianCode = policyTemplate(deployment.verification.manifest);
  wrongGuardianCode.approvers.guardian = {
    ...wrongGuardianCode.approvers.guardian,
    codeHash: id("substituted guardian code").toLowerCase(),
  };
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...base,
      recordTemplate: recordTemplate(),
      policyTemplate: wrongGuardianCode,
    }),
    /guardian approver does not exactly match/,
  );
  const capturedOperator = policyTemplate(deployment.verification.manifest);
  capturedOperator.approvers.lightningOperator = {
    ...capturedOperator.approvers.lightningOperator,
    address: deployment.verification.manifest.controller.ownerAddresses[0],
  };
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...base,
      recordTemplate: recordTemplate(),
      policyTemplate: capturedOperator,
    }),
    /independent of every deployment-wallet owner/,
  );
  const contractOperator = policyTemplate(deployment.verification.manifest);
  contractOperator.approvers.lightningOperator = {
    address: Wallet.createRandom().address,
    codeHash: id("unreviewed lightning operator contract").toLowerCase(),
    signatureKind: "erc1271",
  };
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...base,
      recordTemplate: recordTemplate(),
      policyTemplate: contractOperator,
    }),
    /lightningOperator approver must use.*EIP-712/,
  );

  const capturedReviewInput = reviewFixture({ deployment, finishedAt: PROMOTION_NOW + 20 });
  const capturedReviewer = capturedReviewInput.record.participants[0];
  capturedReviewInput.wallets.delete(capturedReviewer.signer);
  const capturedWallet = new Wallet(`0x${"55".repeat(32)}`);
  capturedReviewer.signer = capturedWallet.address;
  capturedReviewInput.wallets.set(capturedWallet.address, capturedWallet);
  await signReviewFixture(capturedReviewInput);
  const capturedReviewVerification = verifyIndependentReviewEvidence({
    ...capturedReviewInput,
    now: PROMOTION_NOW + 60,
  });
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...base,
      recordTemplate: recordTemplate(),
      independentReviewVerification: capturedReviewVerification,
    }),
    /reviewer signer overlaps/,
  );

  const capturedCampaignReviewInput = reviewFixture({ deployment, finishedAt: PROMOTION_NOW + 20 });
  const capturedCampaignReviewer = capturedCampaignReviewInput.record.participants[0];
  const campaignParticipant = campaign.candidate.record.participants[0];
  capturedCampaignReviewInput.wallets.delete(capturedCampaignReviewer.signer);
  capturedCampaignReviewer.signer = campaignParticipant.signer;
  capturedCampaignReviewInput.wallets.set(
    campaignParticipant.signer,
    campaign.candidate.wallets.get(campaignParticipant.signer),
  );
  await signReviewFixture(capturedCampaignReviewInput);
  const capturedCampaignReviewVerification = verifyIndependentReviewEvidence({
    ...capturedCampaignReviewInput,
    now: PROMOTION_NOW + 60,
  });
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...base,
      recordTemplate: recordTemplate(),
      independentReviewVerification: capturedCampaignReviewVerification,
    }),
    /reviewer signer overlaps/,
  );

  const capturedDeploymentReviewInput = reviewFixture({ deployment, finishedAt: PROMOTION_NOW + 20 });
  const capturedDeploymentReviewer = capturedDeploymentReviewInput.record.participants[0];
  const deploymentApprover = deployment.candidate.approvers[0];
  capturedDeploymentReviewInput.wallets.delete(capturedDeploymentReviewer.signer);
  capturedDeploymentReviewer.signer = deploymentApprover.signer;
  capturedDeploymentReviewInput.wallets.set(deploymentApprover.signer, deploymentApprover.wallet);
  await signReviewFixture(capturedDeploymentReviewInput);
  const capturedDeploymentReviewVerification = verifyIndependentReviewEvidence({
    ...capturedDeploymentReviewInput,
    now: PROMOTION_NOW + 60,
  });
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({
      ...base,
      recordTemplate: recordTemplate(),
      independentReviewVerification: capturedDeploymentReviewVerification,
    }),
    /reviewer signer overlaps/,
  );
});

test("operator CLI writes a private non-overwriting candidate without authority", async () => {
  const { campaign, deployment, operations, review } = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "treeswap-release-candidate-"));
  try {
    const values = {
      recordTemplate: recordTemplate(),
      policyTemplate: policyTemplate(deployment.verification.manifest),
      promotionRecord: deployment.candidate.record,
      promotionPolicy: deployment.candidate.policy,
      deploymentPolicy: deployment.candidate.deploymentPolicy,
      promotionObservations: deployment.candidate.observations,
      promotionAttestations: deployment.attestations,
      postflightBundle: postflightBundle(deployment),
      campaignRecord: campaign.candidate.record,
      campaignPolicy: campaign.candidate.policy,
      campaignAttestations: campaign.candidate.attestations,
      reviewRecord: review.candidate.record,
      reviewPolicy: review.candidate.policy,
      reviewAttestations: review.candidate.attestations,
      operationsRecord: operations.candidate.record,
      operationsPolicy: operations.candidate.policy,
      operationsAttestations: operations.candidate.attestations,
      adoptionPolicy: operations.candidate.adoptionPolicy,
      isolationRecord: operations.serviceIsolation.candidate.record,
      isolationPolicy: operations.serviceIsolation.candidate.policy,
      isolationAttestations: operations.serviceIsolation.candidate.attestations,
    };
    const paths = {};
    for (const [name, value] of Object.entries(values)) {
      paths[name] = join(directory, `${name}.json`);
      await writeFile(paths[name], `${JSON.stringify(value)}\n`);
    }
    const output = join(directory, "release-candidate.json");
    const arguments_ = [
      "scripts/prepare-public-testnet-release-candidate.mjs",
      "--record-template", paths.recordTemplate,
      "--policy-template", paths.policyTemplate,
      "--promotion-record", paths.promotionRecord,
      "--promotion-policy", paths.promotionPolicy,
      "--deployment-policy", paths.deploymentPolicy,
      "--promotion-observations", paths.promotionObservations,
      "--promotion-attestations", paths.promotionAttestations,
      "--postflight-bundle", paths.postflightBundle,
      "--campaign-record", paths.campaignRecord,
      "--campaign-policy", paths.campaignPolicy,
      "--campaign-attestations", paths.campaignAttestations,
      "--review-record", paths.reviewRecord,
      "--review-policy", paths.reviewPolicy,
      "--review-attestations", paths.reviewAttestations,
      "--operations-record", paths.operationsRecord,
      "--operations-policy", paths.operationsPolicy,
      "--operations-attestations", paths.operationsAttestations,
      "--adoption-policy", paths.adoptionPolicy,
      "--isolation-record", paths.isolationRecord,
      "--isolation-policy", paths.isolationPolicy,
      "--isolation-attestations", paths.isolationAttestations,
      "--out", output,
    ];
    const result = JSON.parse(execFileSync(process.execPath, arguments_, { encoding: "utf8" }));
    assert.equal(result.fundingAuthorization, false);
    assert.equal(result.signingAuthorization, false);
    assert.equal(result.output, output);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const written = JSON.parse(await readFile(output, "utf8"));
    assert.equal(written.recordDigest, result.recordDigest);
    assert.equal(written.approval.primaryType, "ReleaseApproval");
    assert.throws(
      () => execFileSync(process.execPath, arguments_, { encoding: "utf8", stdio: "pipe" }),
      /EEXIST|exist/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap operator CLI also writes only a private non-authorizing candidate", async () => {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const bootstrap = await createVerifiedPublicTestnetBootstrapFixture({
    deployment,
    preparedAt: PROMOTION_NOW,
    now: PROMOTION_NOW + 60,
  });
  const review = await createVerifiedIndependentReviewFixture({
    deployment,
    finishedAt: PROMOTION_NOW + 20,
    now: PROMOTION_NOW + 60,
  });
  const monitor = bootstrap.candidate.record.participants.find((value) => value.role === "monitor");
  const operations = await createVerifiedOperationalReadinessFixture({
    deployment,
    upstream: bootstrap,
    fundingMode: "operator-testnet-bootstrap",
    preparedAt: PROMOTION_NOW + 30,
    now: PROMOTION_NOW + 60,
    lightningOperatorWallet: LIGHTNING_OPERATOR,
    incidentCommanderWallet: INCIDENT_COMMANDER,
    securityReviewerWallet: SECURITY_REVIEWER,
    monitoringOperatorWallet: bootstrap.candidate.wallets.get(monitor.signer),
  });
  const directory = await mkdtemp(join(tmpdir(), "treeswap-bootstrap-release-candidate-"));
  try {
    const values = {
      recordTemplate: bootstrapRecordTemplate(),
      policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
      bootstrapRecord: bootstrap.candidate.record,
      bootstrapPolicy: bootstrap.candidate.policy,
      bootstrapAttestations: bootstrap.candidate.attestations,
      promotionRecord: deployment.candidate.record,
      promotionPolicy: deployment.candidate.policy,
      deploymentPolicy: deployment.candidate.deploymentPolicy,
      promotionObservations: deployment.candidate.observations,
      promotionAttestations: deployment.attestations,
      postflightBundle: postflightBundle(deployment),
      reviewRecord: review.candidate.record,
      reviewPolicy: review.candidate.policy,
      reviewAttestations: review.candidate.attestations,
      operationsRecord: operations.candidate.record,
      operationsPolicy: operations.candidate.policy,
      operationsAttestations: operations.candidate.attestations,
      adoptionPolicy: operations.candidate.adoptionPolicy,
      isolationRecord: operations.serviceIsolation.candidate.record,
      isolationPolicy: operations.serviceIsolation.candidate.policy,
      isolationAttestations: operations.serviceIsolation.candidate.attestations,
    };
    const paths = {};
    for (const [name, value] of Object.entries(values)) {
      paths[name] = join(directory, `${name}.json`);
      await writeFile(paths[name], `${JSON.stringify(value)}\n`);
    }
    const output = join(directory, "bootstrap-release-candidate.json");
    const result = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-public-testnet-bootstrap-release-candidate.mjs",
      "--record-template", paths.recordTemplate,
      "--policy-template", paths.policyTemplate,
      "--bootstrap-record", paths.bootstrapRecord,
      "--bootstrap-policy", paths.bootstrapPolicy,
      "--bootstrap-attestations", paths.bootstrapAttestations,
      "--promotion-record", paths.promotionRecord,
      "--promotion-policy", paths.promotionPolicy,
      "--deployment-policy", paths.deploymentPolicy,
      "--promotion-observations", paths.promotionObservations,
      "--promotion-attestations", paths.promotionAttestations,
      "--postflight-bundle", paths.postflightBundle,
      "--review-record", paths.reviewRecord,
      "--review-policy", paths.reviewPolicy,
      "--review-attestations", paths.reviewAttestations,
      "--operations-record", paths.operationsRecord,
      "--operations-policy", paths.operationsPolicy,
      "--operations-attestations", paths.operationsAttestations,
      "--adoption-policy", paths.adoptionPolicy,
      "--isolation-record", paths.isolationRecord,
      "--isolation-policy", paths.isolationPolicy,
      "--isolation-attestations", paths.isolationAttestations,
      "--out", output,
    ], { encoding: "utf8" }));
    assert.equal(result.fundingAuthorization, false);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const written = JSON.parse(await readFile(output, "utf8"));
    assert.equal(written.record.fundingMode, "operator-testnet-bootstrap");
    assert.equal(written.record.evidenceDigests.publicTestnet, ZERO);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
