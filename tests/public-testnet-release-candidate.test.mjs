import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import { createVerifiedQualificationReviewFixture } from "./fixtures/verified-qualification-review.mjs";
import { createVerifiedSolverCapabilityFixture } from "./fixtures/verified-solver-capability.mjs";
import {
  SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
  solverDaemonEvidencePolicyDigest,
} from "../lib/solver-daemon-evidence.mjs";
import {
  solverLightningNodePubkeyDigest,
  verifiedSolverCapacityRecord,
  verifiedSolverQuoteBinding,
  verifiedSolverRecoveryAuthority,
} from "../lib/solver-capability.mjs";
import {
  bindActiveSolverSettlementExecutionPolicy,
  createActiveSolverDaemonExecutionFence,
  createRecoverySolverDaemonExecutionFence,
  deactivateActiveSolverDaemonExecutionFence,
  deactivateRecoverySolverDaemonExecutionFence,
  executeActiveSolverDaemonStep,
  executeRecoverySolverDaemonStep,
} from "../lib/active-solver-daemon-runtime.mjs";
import { createCoordinatorRecoveryActionLoop } from "../lib/coordinator-recovery-action-loop.mjs";
import {
  createCoordinatorActiveExecutionLifecycle,
} from "../lib/coordinator-active-execution-lifecycle.mjs";
import {
  prepareCoordinatorActiveExecutionPolicySet,
} from "../lib/coordinator-active-execution-policy.mjs";
import {
  createCoordinatorRecoveryExecutionBootstrap,
} from "../lib/coordinator-recovery-execution-service.mjs";
import {
  createCoordinatorRecoveryExecutionSupervisor,
} from "../lib/coordinator-recovery-execution-supervisor.mjs";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  acquireCoordinatorServiceLease,
  normalizeCoordinatorServiceConfig,
} from "../lib/coordinator-service-state.mjs";
import { verifyPublicTestnetBootstrapEvidence } from "../lib/public-testnet-bootstrap-evidence.mjs";
import { verifyIndependentReviewEvidence } from "../lib/independent-review-evidence.mjs";
import { verifyOperationalReadinessEvidence } from "../lib/operational-readiness-evidence.mjs";
import { buildAdoptionPolicyEvidence } from "../lib/adoption-policy.mjs";
import { safetyMonitorPolicyDigest } from "../lib/safety-observation-attestation.mjs";
import {
  buildPublicTestnetReleaseApproval,
  buildPublicTestnetReleaseCandidateSummary,
  preparePublicTestnetBootstrapReleaseCandidate,
  preparePublicTestnetReleaseCandidate,
  verifiedPublicTestnetReleaseCandidateRuntimeBinding,
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
  activatePublicTestnetRecovery,
  activatePublicTestnetRelease,
  authorizeSolverFunding,
  buildPublicTestnetRuntimeReconciliationApproval,
  createActiveSolverDaemonContext,
  createRecoverySolverDaemonContext,
  deactivatePublicTestnetRecovery,
  deactivatePublicTestnetRelease,
  isPublicTestnetRecoveryActive,
  isPublicTestnetReleaseActive,
  publicTestnetReleaseOpenRiskDigest,
  verifiedActiveSolverDaemonContext,
  verifiedRecoverySolverDaemonContext,
} from "../lib/capabilities.mjs";
import {
  activatePublicTestnetRecoveryFromManifest,
  activatePublicTestnetReleaseFromManifest,
  buildPublicTestnetRecoveryActivationSummary,
  buildPublicTestnetReleaseActivationPreflightSummary,
} from "../lib/public-testnet-release-activation.mjs";
import { createCoordinatorRecoveryVerificationSupervisor } from "../lib/coordinator-recovery-supervisor.mjs";
import { createCoordinatorReleaseVerificationSupervisor } from "../lib/coordinator-release-supervisor.mjs";
import {
  assessRetainedReleaseRotation,
  buildRetainedReleaseRecoveryDrillApproval,
  inspectRetainedReleaseCustody,
  prepareRetainedReleaseRecoveryJobSet,
  verifyRetainedReleaseRecoveryDrill,
  verifyRetainedReleaseRecoveryReadiness,
} from "../lib/release-retention-custody.mjs";

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

function releaseEvidenceValues({ campaign, deployment, operations, qualification, review }) {
  return {
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
    operationsSafetyMonitorPolicy: operations.candidate.safetyMonitorPolicy,
    adoptionPolicy: operations.candidate.adoptionPolicy,
    isolationRecord: operations.serviceIsolation.candidate.record,
    isolationPolicy: operations.serviceIsolation.candidate.policy,
    isolationAttestations: operations.serviceIsolation.candidate.attestations,
    qualificationArtifact: qualification.qualificationFileBytes,
    qualificationReview: qualification.review,
    qualificationPolicy: qualification.policy,
    qualificationAttestation: qualification.attestation,
  };
}

function bootstrapReleaseEvidenceValues({ bootstrap, deployment, operations, qualification, review }) {
  return {
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
    operationsSafetyMonitorPolicy: operations.candidate.safetyMonitorPolicy,
    adoptionPolicy: operations.candidate.adoptionPolicy,
    isolationRecord: operations.serviceIsolation.candidate.record,
    isolationPolicy: operations.serviceIsolation.candidate.policy,
    isolationAttestations: operations.serviceIsolation.candidate.attestations,
    qualificationArtifact: qualification.qualificationFileBytes,
    qualificationReview: qualification.review,
    qualificationPolicy: qualification.policy,
    qualificationAttestation: qualification.attestation,
  };
}

async function writeReleaseEvidenceFiles(directory, evidence) {
  const paths = {};
  for (const [name, value] of Object.entries(evidence)) {
    paths[name] = join(directory, `${name}.json`);
    await writeFile(
      paths[name],
      name === "qualificationArtifact" ? value : `${JSON.stringify(value)}\n`,
    );
  }
  return paths;
}

async function retainedFileReference(path, root) {
  await chmod(path, 0o600);
  const bytes = await readFile(path);
  return {
    path: path.slice(root.length + 1),
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    sizeBytes: (await stat(path)).size,
  };
}

async function retainedCandidateEvidenceReferences(paths, root) {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([field, path]) => [
    field,
    await retainedFileReference(path, root),
  ])));
}

async function fixture() {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const qualification = await createVerifiedQualificationReviewFixture({
    deployment,
    fundingMode: "operator-testnet",
    reviewedAt: PROMOTION_NOW - 200,
    now: PROMOTION_NOW + 60,
  });
  const campaign = await createVerifiedPublicTestnetCampaignFixture({
    finishedAt: PROMOTION_NOW - 100,
    chainId: deployment.verification.record.chainId,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    verifyingContract: deployment.verification.record.verifyingContract,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    testQualification: qualification.verification.evidenceDigest,
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
    qualificationReviewVerification: qualification.verification,
  });
  return { campaign, candidate, deployment, operations, qualification, review };
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
  assert.equal(candidate.evidence.safetyMonitorPolicyDigest, operations.verification.safetyMonitorPolicyDigest);
  assert.equal(
    candidate.evidence.safetyMonitorUpstreamRecordDigest,
    operations.verification.safetyMonitor.safetyMonitorReleaseRecordDigest,
  );
  assert.equal(candidate.evidence.gateConfirmerBindingDigest, operations.verification.gateConfirmerBindingDigest);
  const runtimeBinding = verifiedPublicTestnetReleaseCandidateRuntimeBinding(candidate);
  assert.equal(runtimeBinding.operationalSafetyMonitorPolicyDigest, candidate.evidence.safetyMonitorPolicyDigest);
  assert.equal(
    runtimeBinding.operationalSafetyMonitorUpstreamRecordDigest,
    candidate.evidence.safetyMonitorUpstreamRecordDigest,
  );
  assert.equal(runtimeBinding.safetyMonitorPolicy.releaseRecordDigest, candidate.recordDigest);
  assert.equal(runtimeBinding.safetyMonitorPolicy.validFrom <= candidate.record.validFrom, true);
  assert.equal(runtimeBinding.safetyMonitorPolicy.validUntil >= candidate.record.validUntil, true);
  assert.equal(runtimeBinding.safetyMonitorPolicyDigest, safetyMonitorPolicyDigest(runtimeBinding.safetyMonitorPolicy));
  assert.notEqual(runtimeBinding.safetyMonitorPolicyDigest, runtimeBinding.operationalSafetyMonitorPolicyDigest);
  assert.throws(
    () => verifiedPublicTestnetReleaseCandidateRuntimeBinding(structuredClone(candidate)),
    /provenance/,
  );
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

test("activates funding only after same-process evidence, approvals, reconciliation, and live RPC quorum checks", async (t) => {
  const { campaign, candidate, deployment, operations, qualification, review } = await fixture();
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
  const recoveryActivation = await activatePublicTestnetRecovery({
    candidate,
    approvalBundle,
    providerSet,
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
  const rotatedRecoverySolverCapability = await createVerifiedSolverCapabilityFixture({
    now,
    chainId: candidate.record.chainId,
    lightningToBitContract: deployment.verification.manifest.vault.address,
    lightningToBitContractCodeHash: deployment.verification.manifest.vault.codeHash,
    bitToLightningContract: deployment.verification.manifest.userEscrow.address,
    bitToLightningContractCodeHash: deployment.verification.manifest.userEscrow.codeHash,
    capacityEpoch: "8",
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
  const solverBinding = verifiedSolverQuoteBinding(solverCapability.verification);
  const rotatedRecoveryBinding = verifiedSolverQuoteBinding(rotatedRecoverySolverCapability.verification);
  const evidencePolicy = {
    schema: SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
    releaseRecordDigest: candidate.recordDigest,
    chainId: candidate.record.chainId,
    settlementContract: solverBinding.settlementContract,
    settlementContractCodeHash: solverBinding.settlementContractCodeHash,
    solver: solverBinding.solverId,
    direction: solverBinding.direction,
    approvers: {
      lightningOperator: candidate.policy.approvers.lightningOperator.address,
      securityReviewer: candidate.policy.approvers.securityReviewer.address,
    },
    maxEvidenceAgeSeconds: 15,
    maxEvidenceLifetimeSeconds: 15,
    maxClockSkewSeconds: 2,
  };
  const executionContext = createActiveSolverDaemonContext({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    evidencePolicy,
    now,
  });
  const recoveryContext = createRecoverySolverDaemonContext({
    solverCapabilityVerification: rotatedRecoverySolverCapability.verification,
    deployment: recoveryActivation.deployment,
    evidencePolicy,
    now,
  });
  assert.deepEqual(verifiedActiveSolverDaemonContext(executionContext, { now }), {
    capacityEpoch: solverBinding.capacityEpoch,
    direction: solverBinding.direction,
    evidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
    releaseRecordDigest: candidate.recordDigest,
    solverCapabilityDigest: solverBinding.capabilityDigest,
    solverId: solverBinding.solverId,
  });
  assert.equal(JSON.stringify(executionContext).match(/signature|private|endpoint|invoice|preimage/i), null);
  assert.deepEqual(verifiedRecoverySolverDaemonContext(recoveryContext, { now }), {
    capacityEpoch: rotatedRecoveryBinding.capacityEpoch,
    direction: rotatedRecoveryBinding.direction,
    evidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
    evmClaimWorkAllowed: true,
    releaseRecordDigest: candidate.recordDigest,
    solverCapabilityDigest: rotatedRecoveryBinding.capabilityDigest,
    solverId: rotatedRecoveryBinding.solverId,
  });
  assert.equal(JSON.stringify(recoveryContext).match(/signature|private|endpoint|invoice|preimage/i), null);
  assert.equal(recoveryContext.authorizations.funding, false);
  assert.equal(recoveryContext.authorizations.lightningDispatch, false);
  assert.throws(
    () => verifiedRecoverySolverDaemonContext(structuredClone(recoveryContext), { now }),
    /same-process recovery activation/,
  );
  assert.throws(
    () => verifiedRecoverySolverDaemonContext(executionContext, { now }),
    /same-process recovery activation/,
  );
  assert.throws(
    () => verifiedActiveSolverDaemonContext(structuredClone(executionContext), { now }),
    /same-process release activation/,
  );
  assert.throws(() => createActiveSolverDaemonContext({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    evidencePolicy: { ...evidencePolicy, releaseRecordDigest: id("another release").toLowerCase() },
    now,
  }), /not bound to the active release and solver/);
  assert.throws(() => createActiveSolverDaemonContext({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    evidencePolicy: {
      ...evidencePolicy,
      approvers: {
        ...evidencePolicy.approvers,
        securityReviewer: INCIDENT_COMMANDER.address,
      },
    },
    now,
  }), /approvers do not match/);
  assert.throws(() => createActiveSolverDaemonContext({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    evidencePolicy: { ...evidencePolicy, maxEvidenceAgeSeconds: 31 },
    now,
  }), /freshness exceeds/);
  assert.throws(() => createActiveSolverDaemonContext({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    evidencePolicy: { ...evidencePolicy, maxClockSkewSeconds: 31 },
    now,
  }), /clock skew|freshness exceeds/);
  let releaseDigestReads = 0;
  const changingPolicy = { ...evidencePolicy };
  Object.defineProperty(changingPolicy, "releaseRecordDigest", {
    enumerable: true,
    get: () => {
      releaseDigestReads += 1;
      return releaseDigestReads === 1 ? id("getter-substituted release").toLowerCase() : candidate.recordDigest;
    },
  });
  assert.throws(() => createActiveSolverDaemonContext({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    evidencePolicy: changingPolicy,
    now,
  }), /not bound to the active release and solver/);
  assert.equal(releaseDigestReads, 1);
  assert.throws(
    () => verifiedActiveSolverDaemonContext(executionContext, {
      now: solverBinding.expiresAt,
      requireFundingAuthorization: true,
    }),
    /funding authorization is inactive/,
  );
  assert.deepEqual(verifiedActiveSolverDaemonContext(executionContext, {
    now: solverBinding.expiresAt,
    requireFundingAuthorization: false,
  }), {
    capacityEpoch: solverBinding.capacityEpoch,
    direction: solverBinding.direction,
    evidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
    releaseRecordDigest: candidate.recordDigest,
    solverCapabilityDigest: solverBinding.capabilityDigest,
    solverId: solverBinding.solverId,
  });
  const wrapperSettlementId = id("active wrapper settlement").toLowerCase();
  const waitingSettlement = {
    settlementId: wrapperSettlementId,
    pricingId: id("active wrapper RFQ").toLowerCase(),
    direction: solverBinding.direction,
    nonceAuthorityDigest: id("active wrapper nonce authority").toLowerCase(),
    intentNonce: "1",
    intentDigest: id("active wrapper intent").toLowerCase(),
    paymentHash: id("active wrapper payment hash").toLowerCase(),
    invoiceDigest: id("active wrapper invoice").toLowerCase(),
    amountSats: "10000",
    quoteReceiptDigest: id("active wrapper quote receipt").toLowerCase(),
    selectedSetDigest: id("active wrapper selected set").toLowerCase(),
    selectedOfferId: id("active wrapper offer").toLowerCase(),
    capacityEpoch: solverBinding.capacityEpoch,
    createdAt: now + 2,
  };
  const admissionPolicy = {
    minimumNotionalSats: "1000",
    maxRfqTtlSeconds: 120,
    maxActiveRequestsPerIdentity: 10,
    maxRequestsPerWindow: 10,
    maxCancellationsPerWindow: 10,
    quotaWindowSeconds: 60,
    maxFirmQuoteTtlSeconds: 120,
    maxCapacityAgeSeconds: 30,
    maxActiveFirmQuotesPerSolver: 4,
    maxConsecutiveFailures: 2,
    minimumReliabilitySample: "4",
    minimumReliabilityBps: "9000",
    minimumCompletedFillsForEstablished: "3",
    unknownSolverMaxBitToLightningSats: "5000",
    establishedSolverMaxBitToLightningSats: "100000",
    maxGlobalBitToLightningInFlightSats: "500000",
  };
  const serviceRoot = await realpath(await mkdtemp(join(tmpdir(), "treeswap-active-daemon-service-")));
  t.after(() => rm(serviceRoot, { recursive: true, force: true }));
  const waitingStore = await CoordinatorStore.open(join(serviceRoot, "settlements", "coordinator.sqlite"));
  waitingStore.admitRfq({
    identity: {
      authenticated: true,
      commitment: id("active wrapper identity").toLowerCase(),
      key: "active-wrapper-user",
    },
    request: {
      requestId: waitingSettlement.pricingId,
      user: "active-wrapper-user",
      direction: waitingSettlement.direction,
      notionalSats: waitingSettlement.amountSats,
      nonce: "1",
      expiresAt: now + 30,
    },
    policy: admissionPolicy,
    now,
  });
  waitingStore.recordSolverCapacity(verifiedSolverCapacityRecord(solverCapability.verification));
  const firm = waitingStore.reserveVerifiedFirmOffer({
    offerId: waitingSettlement.selectedOfferId,
    offerDigest: id("active wrapper blind offer").toLowerCase(),
    selectionAuthorizationDigest: id("active wrapper selection authorization").toLowerCase(),
    selectionAuthorizationExpiresAt: now + 25,
    requestId: waitingSettlement.pricingId,
    solverId: solverBinding.solverId,
    offer: {
      direction: waitingSettlement.direction,
      capabilityDigest: solverBinding.capabilityDigest,
      bitAmountWei: String(10n ** 18n),
      lightningAmountSats: waitingSettlement.amountSats,
      maxRoutingFeeSats: "0",
      capacityEpoch: waitingSettlement.capacityEpoch,
      expiresAt: now + 25,
      signatureVerified: true,
    },
    policy: admissionPolicy,
    now,
  });
  const bound = waitingStore.bindFirmOfferExecution({
    offerId: firm.offerId,
    privateRequestDigest: id("active wrapper private request").toLowerCase(),
    executableOfferDigest: id("active wrapper executable offer").toLowerCase(),
    finalizedAt: now + 1,
  });
  waitingStore.bindFirmOfferUserAuthorization({
    offerId: firm.offerId,
    executionBindingDigest: bound.executionBindingDigest,
    executionAuthorizationDigest: id("active wrapper user authorization").toLowerCase(),
    authorizationExpiresAt: now + 20,
    authorizedAt: now + 2,
  });
  waitingStore.acceptSettlement(waitingSettlement);
  let serviceNow = (now + 3) * 1_000;
  const serviceLease = await acquireCoordinatorServiceLease(normalizeCoordinatorServiceConfig({
    COORDINATOR_DATABASE_PATH: join(serviceRoot, "data", "coordinator.sqlite"),
    COORDINATOR_RUNTIME_DIRECTORY: join(serviceRoot, "run"),
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "30",
  }), { now: () => serviceNow });
  const recoveryExecutionFence = createRecoverySolverDaemonExecutionFence();
  const activeExecutionFence = createActiveSolverDaemonExecutionFence();
  t.after(() => {
    try { deactivateActiveSolverDaemonExecutionFence(activeExecutionFence); } catch {}
  });
  const originalDateNow = Date.now;
  try {
    Date.now = () => serviceNow;
    await assert.rejects(executeActiveSolverDaemonStep({
      executionContext,
      executionFence: activeExecutionFence,
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), /not bound to the authorized solver offer and capacity epoch/);
    await assert.rejects(bindActiveSolverSettlementExecutionPolicy({
      executionContext: structuredClone(executionContext),
      executionFence: activeExecutionFence,
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), /same-process release activation/);
    const executionPolicyBinding = await bindActiveSolverSettlementExecutionPolicy({
      executionContext,
      executionFence: activeExecutionFence,
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    });
    assert.equal(executionPolicyBinding.releaseRecordDigest, candidate.recordDigest);
    assert.equal(executionPolicyBinding.evidencePolicyDigest, solverDaemonEvidencePolicyDigest(evidencePolicy));
    assert.equal(executionPolicyBinding.solverCapabilityDigest, solverBinding.capabilityDigest);
    assert.equal(executionPolicyBinding.executionPolicyBoundAt, now + 3);
    assert.equal(
      (await bindActiveSolverSettlementExecutionPolicy({
        executionContext,
        executionFence: activeExecutionFence,
        serviceLease,
        store: waitingStore,
        settlementId: wrapperSettlementId,
      })).executionPolicyBindingDigest,
      executionPolicyBinding.executionPolicyBindingDigest,
    );

    const candidateEvidencePaths = await writeReleaseEvidenceFiles(
      serviceRoot,
      releaseEvidenceValues({ campaign, deployment, operations, qualification, review }),
    );
    const retainedCandidateEvidence = await retainedCandidateEvidenceReferences(
      candidateEvidencePaths,
      serviceRoot,
    );
    const approvalBundlePath = join(serviceRoot, "retained-approval-bundle.json");
    await writeFile(approvalBundlePath, `${JSON.stringify(approvalBundle)}\n`, { mode: 0o600 });
    const providerIdentities = campaign.candidate.record.participants
      .filter((value) => value.role === "evm-provider")
      .map((value) => value.operatorId);
    const providerConfigurationPath = join(serviceRoot, "retained-provider-configuration.json");
    await writeFile(providerConfigurationPath, `${JSON.stringify({
      schema: "treeswap.public-testnet-release-approval-providers.v1",
      providers: [
        { identity: providerIdentities[0], urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_ONE_URL" },
        { identity: providerIdentities[1], urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_TWO_URL" },
      ],
    })}\n`, { mode: 0o600 });
    const daemonPolicyPath = join(serviceRoot, "retained-daemon-policy.json");
    await writeFile(daemonPolicyPath, `${JSON.stringify(evidencePolicy)}\n`, { mode: 0o600 });
    const runtimeArchivePath = join(serviceRoot, "retained-coordinator-runtime.tar");
    await writeFile(runtimeArchivePath, "pinned coordinator runtime fixture", { mode: 0o600 });
    const backupPath = join(serviceRoot, "retained-coordinator-backup.sqlite");
    await waitingStore.createVerifiedBackup(backupPath);
    const originalRecoveryAuthority = verifiedSolverRecoveryAuthority(solverCapability.verification);
    const rotatedRecoveryAuthority = verifiedSolverRecoveryAuthority(rotatedRecoverySolverCapability.verification);
    const custodyManifest = {
      schema: "treeswap.retained-release-custody.v1",
      coordinatorSchema: "treeswap.coordinator.v7",
      createdAt: now + 3,
      sealedHostInstanceId: id("retained original host").toLowerCase(),
      sealedProcessInstanceId: id("retained original process").toLowerCase(),
      coordinatorBackup: await retainedFileReference(backupPath, serviceRoot),
      witnessPolicy: {
        maximumDrillAgeSeconds: 86_400,
        maximumDrillDurationSeconds: 3_600,
        minimumWitnesses: 2,
        witnesses: [
          {
            operatorId: id("retained witness one").toLowerCase(),
            organizationId: id("retained witness organization one").toLowerCase(),
            signer: LIGHTNING_OPERATOR.address,
          },
          {
            operatorId: id("retained witness two").toLowerCase(),
            organizationId: id("retained witness organization two").toLowerCase(),
            signer: SECURITY_REVIEWER.address,
          },
        ].sort((left, right) => left.operatorId.localeCompare(right.operatorId)),
      },
      releases: [{
        releaseId: candidate.record.releaseId,
        releaseRecordDigest: candidate.recordDigest,
        releasePolicyDigest: candidate.policyDigest,
        candidateKind: "campaign-qualified",
        candidateEvidence: retainedCandidateEvidence,
        approvalBundle: await retainedFileReference(approvalBundlePath, serviceRoot),
        providerConfiguration: await retainedFileReference(providerConfigurationPath, serviceRoot),
        daemonEvidencePolicies: [{
          direction: evidencePolicy.direction,
          evidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
          file: await retainedFileReference(daemonPolicyPath, serviceRoot),
        }],
        solverRecoveryAuthorities: [{
          evidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
          direction: evidencePolicy.direction,
          solver: originalRecoveryAuthority.solverId,
          endpointPublicKeyDigest: originalRecoveryAuthority.endpointPublicKeyDigest,
          lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(
            originalRecoveryAuthority.lightningNodePubkey,
          ),
          custodianId: id("retained solver key custodian").toLowerCase(),
          organizationId: id("retained solver organization").toLowerCase(),
          custodyEvidenceDigest: id("retained solver key custody evidence").toLowerCase(),
        }],
        runtime: {
          sourceCommit: candidate.record.reviewedBuildCommit,
          coordinatorSchema: "treeswap.coordinator.v7",
          nodeVersion: process.version,
          archive: await retainedFileReference(runtimeArchivePath, serviceRoot),
        },
      }],
    };
    const oldCustodyManifestPath = join(serviceRoot, "retained-release-custody-old.json");
    await writeFile(oldCustodyManifestPath, `${JSON.stringify(custodyManifest, null, 2)}\n`, { mode: 0o600 });
    const oldCustody = await inspectRetainedReleaseCustody({ manifestPath: oldCustodyManifestPath });
    const newCustodyManifest = structuredClone(custodyManifest);
    newCustodyManifest.sealedHostInstanceId = id("retained replacement sealing host").toLowerCase();
    newCustodyManifest.sealedProcessInstanceId = id("retained replacement sealing process").toLowerCase();
    newCustodyManifest.releases[0].solverRecoveryAuthorities[0] = {
      ...newCustodyManifest.releases[0].solverRecoveryAuthorities[0],
      solver: rotatedRecoveryAuthority.solverId,
      endpointPublicKeyDigest: rotatedRecoveryAuthority.endpointPublicKeyDigest,
      lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(rotatedRecoveryAuthority.lightningNodePubkey),
      custodyEvidenceDigest: id("replacement solver key custody evidence").toLowerCase(),
    };
    const newCustodyManifestPath = join(serviceRoot, "retained-release-custody-new.json");
    await writeFile(newCustodyManifestPath, `${JSON.stringify(newCustodyManifest, null, 2)}\n`, { mode: 0o600 });
    const newCustody = await inspectRetainedReleaseCustody({ manifestPath: newCustodyManifestPath });
    assert.equal(oldCustody.totalNonterminalSettlementCount, 1);
    assert.equal(oldCustody.releaseCount, 1);
    assert.equal(oldCustody.authorizations.funding, false);
    assert.notEqual(oldCustody.packageDigest, newCustody.packageDigest);
    const retentionRecoveryActivation = await activatePublicTestnetRecovery({
      candidate,
      approvalBundle,
      providerSet: providerSetFor({
        candidate,
        campaign,
        deployment,
        now,
        overrides: { gateOpen: false, emergencyHalted: true },
      }),
      now,
    });
    t.after(() => {
      if (isPublicTestnetRecoveryActive(retentionRecoveryActivation)) {
        deactivatePublicTestnetRecovery(retentionRecoveryActivation);
      }
    });
    const restoredPath = join(serviceRoot, "restored", "coordinator.sqlite");
    await CoordinatorStore.restoreVerifiedBackup(backupPath, restoredPath);
    const restoredStore = await CoordinatorStore.open(restoredPath);
    try {
      const oldReadiness = verifyRetainedReleaseRecoveryReadiness({
        custodyVerification: oldCustody,
        releaseRecordDigest: candidate.recordDigest,
        recoveryActivation: retentionRecoveryActivation,
        restoredStore,
        solverCapabilityVerifications: [solverCapability.verification],
        restoredHostInstanceId: id("retained restored old host").toLowerCase(),
        restoredProcessInstanceId: id("retained restored old process").toLowerCase(),
        now: now + 3,
      });
      const newReadiness = verifyRetainedReleaseRecoveryReadiness({
        custodyVerification: newCustody,
        releaseRecordDigest: candidate.recordDigest,
        recoveryActivation: retentionRecoveryActivation,
        restoredStore,
        solverCapabilityVerifications: [rotatedRecoverySolverCapability.verification],
        restoredHostInstanceId: id("retained restored new host").toLowerCase(),
        restoredProcessInstanceId: id("retained restored new process").toLowerCase(),
        now: now + 3,
      });
      assert.throws(() => verifyRetainedReleaseRecoveryReadiness({
        custodyVerification: newCustody,
        releaseRecordDigest: candidate.recordDigest,
        recoveryActivation: structuredClone(retentionRecoveryActivation),
        restoredStore,
        solverCapabilityVerifications: [rotatedRecoverySolverCapability.verification],
        restoredHostInstanceId: id("copied activation host").toLowerCase(),
        restoredProcessInstanceId: id("copied activation process").toLowerCase(),
        now: now + 3,
      }), /not backed by this process/);
      assert.throws(() => verifyRetainedReleaseRecoveryReadiness({
        custodyVerification: newCustody,
        releaseRecordDigest: candidate.recordDigest,
        recoveryActivation: retentionRecoveryActivation,
        restoredStore,
        solverCapabilityVerifications: [solverCapability.verification],
        restoredHostInstanceId: id("wrong recovery key host").toLowerCase(),
        restoredProcessInstanceId: id("wrong recovery key process").toLowerCase(),
        now: now + 3,
      }), /does not prove the retained recovery authority/);
      assert.notEqual(oldReadiness.operatingSetDigest, newReadiness.operatingSetDigest);
      assert.equal(oldReadiness.authorizations.lightningDispatch, false);

      async function witnessedDrill(readinessVerification, role, label) {
        const approval = buildRetainedReleaseRecoveryDrillApproval({
          readinessVerification,
          drillId: id(`retained ${label} drill`).toLowerCase(),
          operatingSetRole: role,
          recoveryEvidenceDigest: id(`retained ${label} recovery evidence`).toLowerCase(),
          postconditionDigest: id(`retained ${label} postcondition`).toLowerCase(),
          recoveredActionCount: 1,
          startedAt: now + 1,
          finishedAt: now + 2,
        });
        const wallets = new Map([
          [LIGHTNING_OPERATOR.address.toLowerCase(), LIGHTNING_OPERATOR],
          [SECURITY_REVIEWER.address.toLowerCase(), SECURITY_REVIEWER],
        ]);
        const attestations = await Promise.all(custodyManifest.witnessPolicy.witnesses.map(async (witness) => ({
          operatorId: witness.operatorId,
          signer: witness.signer,
          signature: await wallets.get(witness.signer.toLowerCase()).signTypedData(
            { ...approval.domain, chainId: BigInt(approval.domain.chainId) },
            approval.types,
            approval.message,
          ),
        })));
        return verifyRetainedReleaseRecoveryDrill({ approval, attestations, now: now + 3 });
      }

      const oldDrill = await witnessedDrill(oldReadiness, "old", "old set");
      const newDrill = await witnessedDrill(newReadiness, "new", "new set");
      const rotation = assessRetainedReleaseRotation({
        oldCustodyVerification: oldCustody,
        newCustodyVerification: newCustody,
        liveStore: waitingStore,
        changeKind: "solver-key",
        oldDrills: [oldDrill],
        newDrills: [newDrill],
        now: now + 3,
      });
      assert.equal(rotation.rotationPermitted, true);
      assert.equal(rotation.nonterminalSettlementCount, 1);
      assert.equal(rotation.authorizations.funding, false);
      assert.throws(() => assessRetainedReleaseRotation({
        oldCustodyVerification: oldCustody,
        newCustodyVerification: newCustody,
        liveStore: waitingStore,
        changeKind: "solver-key",
        oldDrills: [oldDrill],
        newDrills: [oldDrill],
        now: now + 3,
      }), /operating-set role/);
      assert.throws(() => assessRetainedReleaseRotation({
        oldCustodyVerification: oldCustody,
        newCustodyVerification: oldCustody,
        liveStore: waitingStore,
        changeKind: "solver-key",
        oldDrills: [oldDrill],
        newDrills: [newDrill],
        now: now + 3,
      }), /packages must be distinct/);

      const loopSupervisor = Object.freeze({
        status: () => Object.freeze({ state: "active" }),
        useActiveActivation: (callback) => callback(Object.freeze({
          activation: retentionRecoveryActivation,
        })),
      });
      const prepareJobSet = (runtime) => prepareRetainedReleaseRecoveryJobSet({
        readinessVerification: newReadiness,
        restoredStore,
        executionPolicies: [{
          evidencePolicy,
          solverCapabilityVerification: rotatedRecoverySolverCapability.verification,
          runtime,
        }],
        now: now + 3,
      });
      assert.throws(() => prepareRetainedReleaseRecoveryJobSet({
        readinessVerification: newReadiness,
        restoredStore,
        executionPolicies: [],
        now: now + 3,
      }), /every and only retained execution policy/);
      assert.throws(() => prepareRetainedReleaseRecoveryJobSet({
        readinessVerification: newReadiness,
        restoredStore,
        executionPolicies: [{
          evidencePolicy,
          solverCapabilityVerification: structuredClone(rotatedRecoverySolverCapability.verification),
          runtime: { packetClient: null, controls: {}, lightning: null, evm: null },
        }],
        now: now + 3,
      }), /same-process authority/);
      assert.throws(() => prepareRetainedReleaseRecoveryJobSet({
        readinessVerification: newReadiness,
        restoredStore: waitingStore,
        executionPolicies: [{
          evidencePolicy,
          solverCapabilityVerification: rotatedRecoverySolverCapability.verification,
          runtime: { packetClient: null, controls: {}, lightning: null, evm: null },
        }],
        now: now + 3,
      }), /exact restored coordinator store/);

      const inactiveJobSet = prepareJobSet({
        packetClient: null,
        controls: {},
        lightning: null,
        evm: null,
      });
      assert.equal(inactiveJobSet.jobCount, 1);
      assert.equal(inactiveJobSet.authorizations.lightningDispatch, false);
      assert.equal(JSON.stringify(inactiveJobSet).includes(wrapperSettlementId), false);
      assert.throws(() => createCoordinatorRecoveryActionLoop({
        recoverySupervisor: loopSupervisor,
        serviceLease,
        store: restoredStore,
        intervalSeconds: 5,
        jobSetVerification: structuredClone(inactiveJobSet),
      }), /job-set provenance/);
      restoredStore.listNonterminalSettlements = () => [];
      assert.throws(() => createCoordinatorRecoveryActionLoop({
        recoverySupervisor: loopSupervisor,
        serviceLease,
        store: restoredStore,
        intervalSeconds: 5,
        jobSetVerification: inactiveJobSet,
      }), /unmodified settlement inspection/);
      delete restoredStore.listNonterminalSettlements;
      const inactiveLoop = createCoordinatorRecoveryActionLoop({
        recoverySupervisor: {
          status: () => ({ state: "inactive", providerSecret: "must-not-escape" }),
          useActiveActivation: () => { throw new Error("inactive supervisor exposed activation"); },
        },
        serviceLease,
        store: restoredStore,
        intervalSeconds: 5,
        jobSetVerification: inactiveJobSet,
      });
      const inactiveCycle = await inactiveLoop.runCycle();
      assert.equal(inactiveCycle.state, "inactive");
      assert.equal(inactiveCycle.counts.attempted, 0);
      assert.equal(JSON.stringify(inactiveCycle).includes("must-not-escape"), false);
      assert.throws(() => createCoordinatorRecoveryActionLoop({
        recoverySupervisor: loopSupervisor,
        serviceLease,
        store: restoredStore,
        intervalSeconds: 5,
        jobSetVerification: inactiveJobSet,
      }), /already consumed/);
      assert.equal(inactiveLoop.stop(), true);
      assert.deepEqual(await inactiveLoop.waitUntilStopped(), { released: true });

      let releaseLateObservation;
      let markObservationStarted;
      const observationStarted = new Promise((resolve) => { markObservationStarted = resolve; });
      const lateObservation = new Promise((resolve) => { releaseLateObservation = resolve; });
      const mutableControls = {
        observeReservation: async () => {
          markObservationStarted();
          return lateObservation;
        },
      };
      const cancellingJobSet = prepareJobSet({
        packetClient: null,
        controls: mutableControls,
        lightning: null,
        evm: null,
      });
      mutableControls.observeReservation = async () => {
        throw new Error("post-verification runtime mutation must not run");
      };
      const cancellingLoop = createCoordinatorRecoveryActionLoop({
        recoverySupervisor: loopSupervisor,
        serviceLease,
        store: restoredStore,
        intervalSeconds: 5,
        jobSetVerification: cancellingJobSet,
      });
      const whileStoppingJobSet = prepareJobSet({
        packetClient: null,
        controls: {},
        lightning: null,
        evm: null,
      });
      const cancelledCycle = cancellingLoop.runCycle();
      await observationStarted;
      assert.equal(cancellingLoop.status().state, "running");
      assert.equal(cancellingLoop.status().cycleDigest, null);
      assert.equal(cancellingLoop.stop(), true);
      assert.throws(() => createCoordinatorRecoveryActionLoop({
        recoverySupervisor: loopSupervisor,
        serviceLease,
        store: restoredStore,
        intervalSeconds: 5,
        jobSetVerification: whileStoppingJobSet,
      }), /already has an active recovery action loop/);
      releaseLateObservation(Object.freeze({ untrustedLateEvidence: true }));
      assert.equal((await cancelledCycle).state, "stopped");
      assert.deepEqual(await cancellingLoop.waitUntilStopped(), { released: true });
      assert.equal(restoredStore.getSettlement(wrapperSettlementId).reservationId, null);

      let executionVerifierActive = true;
      let executionVerifierRefreshes = 0;
      let executionVerifierStops = 0;
      const executionVerificationStatus = () => {
        const attemptAt = new Date(Math.floor(serviceNow / 1_000) * 1_000).toISOString();
        const authorizations = {
          signing: false,
          broadcast: false,
          gateOpening: false,
          lightningDispatch: false,
          newExposure: false,
          funding: false,
        };
        if (!executionVerifierActive) {
          return Object.freeze({
            schema: "treeswap.coordinator-recovery-verification.v1",
            state: "inactive",
            scope: "verification-only-no-recovery-context-action-dispatch-new-exposure-or-funding-authority",
            lastAttemptAt: attemptAt,
            lastSuccessAt: null,
            consecutiveFailures: 1,
            releaseId: null,
            validUntil: null,
            recordDigest: null,
            policyDigest: null,
            inputManifestDigest: null,
            approvalBundleDigest: null,
            providerConsensusDigest: null,
            runtimeBlockNumber: null,
            runtimeBlockHash: null,
            gateOpen: null,
            emergencyHalted: null,
            bitPaused: null,
            balancesReconciled: null,
            authorizations: Object.freeze(authorizations),
          });
        }
        return Object.freeze({
          schema: "treeswap.coordinator-recovery-verification.v1",
          state: "active",
          scope: "verification-only-no-recovery-context-action-dispatch-new-exposure-or-funding-authority",
          lastAttemptAt: attemptAt,
          lastSuccessAt: attemptAt,
          consecutiveFailures: 0,
          releaseId: candidate.record.releaseId,
          validUntil: now + 60,
          recordDigest: candidate.recordDigest,
          policyDigest: candidate.policyDigest,
          inputManifestDigest: id("supervised recovery input manifest").toLowerCase(),
          approvalBundleDigest: id("supervised recovery approval bundle").toLowerCase(),
          providerConsensusDigest: id("supervised recovery provider consensus").toLowerCase(),
          runtimeBlockNumber: 100,
          runtimeBlockHash: id("supervised recovery runtime block").toLowerCase(),
          gateOpen: false,
          emergencyHalted: true,
          bitPaused: false,
          balancesReconciled: true,
          authorizations: Object.freeze(authorizations),
        });
      };
      const executionRecoverySupervisor = Object.freeze({
        refresh: async () => {
          executionVerifierRefreshes += 1;
          return executionVerificationStatus();
        },
        status: () => executionVerificationStatus(),
        stop: () => {
          if (!executionVerifierActive) return false;
          executionVerifierActive = false;
          executionVerifierStops += 1;
          return true;
        },
        useActiveActivation: (callback) => {
          if (!executionVerifierActive) throw new Error("supervised recovery verification is inactive");
          return callback(Object.freeze({ activation: retentionRecoveryActivation }));
        },
      });
      const supervisedJobSet = prepareJobSet({
        packetClient: null,
        controls: {},
        lightning: null,
        evm: null,
      });
      let resolvePreparationStarted;
      const preparationStarted = new Promise((resolve) => {
        resolvePreparationStarted = resolve;
      });
      let resolvePreparedJobSet;
      const preparedJobSet = new Promise((resolve) => {
        resolvePreparedJobSet = resolve;
      });
      const executionBootstrap = createCoordinatorRecoveryExecutionBootstrap({
        heartbeatSeconds: 5,
        intervalSeconds: 5,
        preparationTimeoutSeconds: 10,
        prepareJobSetVerification: ({ abortSignal, recoverySupervisor, serviceLease: receivedLease,
          store: receivedStore }) => {
          assert.equal(abortSignal.aborted, false);
          assert.equal(recoverySupervisor, executionRecoverySupervisor);
          assert.equal(receivedLease, serviceLease);
          assert.equal(receivedStore, restoredStore);
          resolvePreparationStarted();
          return preparedJobSet;
        },
        recoveredInterruptedActions: 0,
        recoveryRefreshSeconds: 5,
        recoverySupervisor: executionRecoverySupervisor,
        serviceLease,
        signal: null,
        store: restoredStore,
      });
      const executionStarting = executionBootstrap.start();
      await preparationStarted;
      const bootstrapStatus = executionBootstrap.status();
      assert.equal(
        bootstrapStatus.schema,
        "treeswap.coordinator-recovery-execution-bootstrap-status.v1",
      );
      assert.equal(bootstrapStatus.phase, "preparing-custody-job-set");
      assert.equal(bootstrapStatus.boundedExistingLiabilityEvmClaimRecovery, false);
      assert.equal(bootstrapStatus.lightningDispatchAuthorization, false);
      assert.equal(bootstrapStatus.newExposureAuthorization, false);
      assert.equal(bootstrapStatus.fundingAuthorization, false);
      assert.equal(Object.hasOwn(bootstrapStatus, "recoveryAction"), false);
      resolvePreparedJobSet(supervisedJobSet);
      assert.equal(await executionStarting, true);
      assert.equal(await executionBootstrap.start(), false);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        await executionBootstrap.publishStatus();
        if (executionBootstrap.status().recoveryAction.state === "active") break;
      }
      const supervisedStatus = executionBootstrap.status();
      assert.equal(supervisedStatus.mode, "recovery-execution-only");
      assert.equal(supervisedStatus.recoveryAction.state, "active");
      assert.equal(supervisedStatus.recoveryAction.counts.waiting, 1);
      assert.equal(supervisedStatus.boundedExistingLiabilityEvmClaimRecovery, true);
      assert.equal(supervisedStatus.lightningDispatchAuthorization, false);
      assert.equal(supervisedStatus.newExposureAuthorization, false);
      assert.equal(supervisedStatus.fundingAuthorization, false);
      assert.equal(JSON.stringify(supervisedStatus).includes(wrapperSettlementId), false);
      serviceNow = (now + 9) * 1_000;
      await executionBootstrap.publishStatus();
      assert.equal(executionVerifierRefreshes, 1);
      const supervisedShutdown = executionBootstrap.stop();
      assert.equal(executionVerifierActive, false);
      assert.equal(executionVerifierStops, 1);
      assert.deepEqual(await supervisedShutdown, { reason: "requested" });
      assert.deepEqual(await executionBootstrap.waitUntilStopped(), { reason: "requested" });
      await assert.rejects(executionBootstrap.publishStatus(), /is stopped/);
      await assert.rejects(executionBootstrap.start(), /cannot be restarted/);

      executionVerifierActive = true;
      let failingVerifierStopCalls = 0;
      const failingRecoverySupervisor = Object.freeze({
        refresh: async () => {
          executionVerifierActive = false;
          return executionVerificationStatus();
        },
        status: () => executionVerificationStatus(),
        stop: () => {
          failingVerifierStopCalls += 1;
          if (!executionVerifierActive) return false;
          executionVerifierActive = false;
          return true;
        },
        useActiveActivation: (callback) => {
          if (!executionVerifierActive) throw new Error("failing recovery verification is inactive");
          return callback(Object.freeze({ activation: retentionRecoveryActivation }));
        },
      });
      const failingJobSet = prepareJobSet({
        packetClient: null,
        controls: {},
        lightning: null,
        evm: null,
      });
      const failingExecutionSupervisor = createCoordinatorRecoveryExecutionSupervisor({
        heartbeatSeconds: 5,
        intervalSeconds: 5,
        jobSetVerification: failingJobSet,
        recoveredInterruptedActions: 0,
        recoveryRefreshSeconds: 5,
        recoverySupervisor: failingRecoverySupervisor,
        serviceLease,
        store: restoredStore,
      });
      await failingExecutionSupervisor.start();
      await new Promise((resolve) => setImmediate(resolve));
      await failingExecutionSupervisor.publishStatus();
      serviceNow = (now + 15) * 1_000;
      await assert.rejects(
        failingExecutionSupervisor.publishStatus(),
        /verification refresh is inactive/,
      );
      assert.deepEqual(
        await failingExecutionSupervisor.waitUntilStopped(),
        { reason: "background-failure" },
      );
      assert.equal(failingVerifierStopCalls, 1);

      const activeJobSet = prepareJobSet({
        packetClient: null,
        controls: {},
        lightning: null,
        evm: null,
      });
      const staleAfterProgressJobSet = prepareJobSet({
        packetClient: null,
        controls: {},
        lightning: null,
        evm: null,
      });
      const concurrentJobSet = prepareJobSet({
        packetClient: null,
        controls: {},
        lightning: null,
        evm: null,
      });
      const recoveryActionLoop = createCoordinatorRecoveryActionLoop({
        recoverySupervisor: loopSupervisor,
        serviceLease,
        store: restoredStore,
        intervalSeconds: 5,
        jobSetVerification: activeJobSet,
      });
      assert.throws(() => createCoordinatorRecoveryActionLoop({
        recoverySupervisor: loopSupervisor,
        serviceLease,
        store: restoredStore,
        intervalSeconds: 5,
        jobSetVerification: concurrentJobSet,
      }), /already has an active recovery action loop/);
      const waitingCycle = await recoveryActionLoop.runCycle();
      assert.equal(waitingCycle.state, "active");
      assert.deepEqual(waitingCycle.counts, {
        attempted: 1,
        advanced: 0,
        waiting: 1,
        gateClosed: 0,
        done: 0,
        halted: 0,
      });
      assert.equal(JSON.stringify(waitingCycle).includes(wrapperSettlementId), false);
      restoredStore.recordReservation({
        settlementId: wrapperSettlementId,
        reservationId: id("restored wrapper reservation").toLowerCase(),
        reservationTxHash: id("restored wrapper reservation transaction").toLowerCase(),
        reservationBlockNumber: 100,
        reservationBlockHash: id("restored wrapper reservation block").toLowerCase(),
        reservationIntentDigest: waitingSettlement.intentDigest,
        observedAt: now + 3,
      });
      assert.throws(() => createCoordinatorRecoveryActionLoop({
        recoverySupervisor: loopSupervisor,
        serviceLease,
        store: restoredStore,
        intervalSeconds: 5,
        jobSetVerification: staleAfterProgressJobSet,
      }), /liabilities changed/);
      const unplannedCycle = await recoveryActionLoop.runCycle();
      assert.equal(unplannedCycle.state, "active");
      assert.equal(unplannedCycle.counts.gateClosed, 1);
      assert.equal(unplannedCycle.counts.advanced, 0);
      restoredStore.planAction({
        actionId: id("restored wrapper pending Lightning action").toLowerCase(),
        settlementId: wrapperSettlementId,
        method: "/invoicesrpc.Invoices/SettleInvoice",
        requestId: id("restored wrapper action request").toLowerCase(),
        payloadDigest: id("restored wrapper action payload").toLowerCase(),
        intentDigest: waitingSettlement.intentDigest,
        paymentHash: waitingSettlement.paymentHash,
        invoiceDigest: waitingSettlement.invoiceDigest,
        amountSats: waitingSettlement.amountSats,
        capacityEpoch: waitingSettlement.capacityEpoch,
        plannedAt: now + 3,
      });
      const pendingCycle = await recoveryActionLoop.runCycle();
      assert.equal(pendingCycle.counts.gateClosed, 1);
      assert.deepEqual(pendingCycle.authorizations, {
        funding: false,
        lightningDispatch: false,
        newExposure: false,
      });
      assert.equal(recoveryActionLoop.stop(), true);
      assert.equal(recoveryActionLoop.stop(), false);
      assert.deepEqual(await recoveryActionLoop.waitUntilStopped(), { released: true });
      assert.equal(recoveryActionLoop.status().state, "stopped");
      await assert.rejects(recoveryActionLoop.runCycle(), /is stopped/);
    } finally {
      restoredStore.close();
    }

    const originalGetSettlement = waitingStore.getSettlement;
    waitingStore.getSettlement = () => executionPolicyBinding;
    await assert.rejects(executeActiveSolverDaemonStep({
      executionContext,
      executionFence: activeExecutionFence,
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), /unmodified original coordinator store methods/);
    delete waitingStore.getSettlement;
    assert.equal(waitingStore.getSettlement, originalGetSettlement);
    await assert.rejects(executeActiveSolverDaemonStep({
      executionContext,
      executionFence: activeExecutionFence,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), /original same-process service lease/);
    await assert.rejects(executeActiveSolverDaemonStep({
      executionContext,
      executionFence: activeExecutionFence,
      serviceLease: JSON.parse(JSON.stringify(serviceLease)),
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), /original same-process service lease/);
    assert.deepEqual(await executeActiveSolverDaemonStep({
      executionContext,
      executionFence: activeExecutionFence,
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), {
      settlementId: wrapperSettlementId,
      stepKind: "WAIT_FOR_RESERVATION",
      outcome: "WAITING",
    });
    await assert.rejects(executeActiveSolverDaemonStep({
      executionContext,
      executionFence: structuredClone(activeExecutionFence),
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), /original same-process execution fence/);
    const lifecycleActivation = await activatePublicTestnetRelease({
      candidate,
      approvalBundle,
      providerSet,
      reconciliation: reconciliation.reconciliation,
      reconciliationApprovals: reconciliation.approvals,
      now,
    });
    const lifecycleReleaseSupervisor = createCoordinatorReleaseVerificationSupervisor({
      manifestPath: "/injected-active-execution-manifest.json",
      activate: async () => ({
        manifestDigest: id("active execution manifest").toLowerCase(),
        candidate,
        activation: lifecycleActivation,
      }),
    });
    assert.equal((await lifecycleReleaseSupervisor.refresh({ now: now + 3 })).state, "active");
    const mutableActiveControls = {};
    const activePolicyPreparation = await prepareCoordinatorActiveExecutionPolicySet({
      executionPolicies: [{
        solverCapabilityVerification: solverCapability.verification,
        evidencePolicy,
        runtime: {
          packetClient: null,
          controls: mutableActiveControls,
          lightning: null,
          evm: null,
        },
      }],
      releaseSupervisor: lifecycleReleaseSupervisor,
      serviceLease,
      store: waitingStore,
    });
    assert.equal(activePolicyPreparation.policyCount, 1);
    assert.deepEqual(activePolicyPreparation.authorizations, {
      funding: false,
      lightningDispatch: false,
      newExposure: false,
    });
    mutableActiveControls.authorizeLightning = async () => {
      throw new Error("caller mutation must not enter the prepared runtime");
    };
    assert.throws(() => createCoordinatorActiveExecutionLifecycle({
      intervalSeconds: 5,
      maxSettlementsPerCycle: 16,
      policyPreparation: structuredClone(activePolicyPreparation),
      releaseRefreshSeconds: 10,
      releaseSupervisor: lifecycleReleaseSupervisor,
      serviceLease,
      store: waitingStore,
    }), /same-process preparation provenance/);
    await assert.rejects(prepareCoordinatorActiveExecutionPolicySet({
      executionPolicies: [],
      releaseSupervisor: {
        refresh: lifecycleReleaseSupervisor.refresh,
        status: lifecycleReleaseSupervisor.status,
        stop: lifecycleReleaseSupervisor.stop,
        useActiveActivation: lifecycleReleaseSupervisor.useActiveActivation,
      },
      serviceLease,
      store: waitingStore,
    }), /original same-process release supervisor/);
    const activeExecutionLifecycle = createCoordinatorActiveExecutionLifecycle({
      intervalSeconds: 5,
      maxSettlementsPerCycle: 16,
      policyPreparation: activePolicyPreparation,
      releaseRefreshSeconds: 10,
      releaseSupervisor: lifecycleReleaseSupervisor,
      serviceLease,
      store: waitingStore,
    });
    assert.throws(() => createCoordinatorActiveExecutionLifecycle({
      intervalSeconds: 5,
      maxSettlementsPerCycle: 16,
      policyPreparation: activePolicyPreparation,
      releaseRefreshSeconds: 10,
      releaseSupervisor: lifecycleReleaseSupervisor,
      serviceLease,
      store: waitingStore,
    }), /already has an active execution lifecycle/);
    const activeCycle = await activeExecutionLifecycle.runCycle();
    assert.equal(activeCycle.state, "active");
    assert.deepEqual(activeCycle.counts, {
      discovered: 1,
      eligible: 1,
      attempted: 1,
      advanced: 0,
      waiting: 1,
      gateClosed: 0,
      done: 0,
      halted: 0,
      backlog: 0,
    });
    assert.deepEqual(activeCycle.authorizations, {
      funding: true,
      lightningDispatch: true,
      newExposure: true,
    });
    assert.equal(activeCycle.networkListener, false);
    assert.equal(JSON.stringify(activeCycle).includes(wrapperSettlementId), false);
    assert.deepEqual(await activeExecutionLifecycle.stop(), { reason: "requested" });
    assert.deepEqual(await activeExecutionLifecycle.waitUntilStopped(), { reason: "requested" });
    assert.equal(activeExecutionLifecycle.status().state, "stopped");
    assert.deepEqual(activeExecutionLifecycle.status().authorizations, {
      funding: false,
      lightningDispatch: false,
      newExposure: false,
    });
    assert.equal(isPublicTestnetReleaseActive(lifecycleActivation), false);
    assert.equal(isPublicTestnetReleaseActive(activation), true);
    await assert.rejects(activeExecutionLifecycle.runCycle(), /is stopped/);
    const refreshFailureActivation = await activatePublicTestnetRelease({
      candidate,
      approvalBundle,
      providerSet,
      reconciliation: reconciliation.reconciliation,
      reconciliationApprovals: reconciliation.approvals,
      now,
    });
    let refreshAttempts = 0;
    const refreshFailureSupervisor = createCoordinatorReleaseVerificationSupervisor({
      manifestPath: "/injected-refresh-failure-manifest.json",
      activate: async () => {
        refreshAttempts += 1;
        if (refreshAttempts > 1) throw new Error("injected provider quorum failure");
        return {
          manifestDigest: id("refresh failure manifest").toLowerCase(),
          candidate,
          activation: refreshFailureActivation,
        };
      },
    });
    assert.equal((await refreshFailureSupervisor.refresh({ now: now + 3 })).state, "active");
    const refreshFailurePreparation = await prepareCoordinatorActiveExecutionPolicySet({
      executionPolicies: [{
        solverCapabilityVerification: solverCapability.verification,
        evidencePolicy,
        runtime: { packetClient: null, controls: {}, lightning: null, evm: null },
      }],
      releaseSupervisor: refreshFailureSupervisor,
      serviceLease,
      store: waitingStore,
    });
    const refreshFailureLifecycle = createCoordinatorActiveExecutionLifecycle({
      intervalSeconds: 5,
      maxSettlementsPerCycle: 16,
      policyPreparation: refreshFailurePreparation,
      releaseRefreshSeconds: 5,
      releaseSupervisor: refreshFailureSupervisor,
      serviceLease,
      store: waitingStore,
    });
    serviceNow = (now + 20) * 1_000;
    const inactiveCycle = await refreshFailureLifecycle.runCycle();
    assert.equal(inactiveCycle.state, "inactive");
    assert.deepEqual(inactiveCycle.authorizations, {
      funding: false,
      lightningDispatch: false,
      newExposure: false,
    });
    assert.deepEqual({
      refreshAttempts,
      verificationState: refreshFailureSupervisor.status({ now: now + 20 }).state,
      activationActive: isPublicTestnetReleaseActive(refreshFailureActivation),
    }, {
      refreshAttempts: 2,
      verificationState: "inactive",
      activationActive: false,
    });
    await assert.rejects(refreshFailureLifecycle.runCycle(), /is inactive/);
    await refreshFailureLifecycle.stop();
    serviceNow = (now + 15) * 1_000;
    const unmatchedSolverCapability = await createVerifiedSolverCapabilityFixture({
      now,
      chainId: candidate.record.chainId,
      lightningToBitContract: deployment.verification.manifest.vault.address,
      lightningToBitContractCodeHash: deployment.verification.manifest.vault.codeHash,
      bitToLightningContract: deployment.verification.manifest.userEscrow.address,
      bitToLightningContractCodeHash: deployment.verification.manifest.userEscrow.codeHash,
      endpointOrigin: "https://unmatched-solver.example",
      solverPrivateKey: `0x${"94".repeat(32)}`,
    });
    const unmatchedBinding = verifiedSolverQuoteBinding(unmatchedSolverCapability.verification);
    const unmatchedRequestId = id("unmatched active lifecycle RFQ").toLowerCase();
    const unmatchedOfferId = id("unmatched active lifecycle offer").toLowerCase();
    const unmatchedSettlementId = id("unmatched active lifecycle settlement").toLowerCase();
    waitingStore.admitRfq({
      identity: {
        authenticated: true,
        commitment: id("unmatched active lifecycle identity").toLowerCase(),
        key: "unmatched-active-lifecycle-user",
      },
      request: {
        requestId: unmatchedRequestId,
        user: "unmatched-active-lifecycle-user",
        direction: unmatchedBinding.direction,
        notionalSats: "4000",
        nonce: "1",
        expiresAt: now + 30,
      },
      policy: admissionPolicy,
      now: now + 15,
    });
    waitingStore.recordSolverCapacity(verifiedSolverCapacityRecord(unmatchedSolverCapability.verification));
    const unmatchedOffer = waitingStore.reserveVerifiedFirmOffer({
      offerId: unmatchedOfferId,
      offerDigest: id("unmatched active lifecycle blind offer").toLowerCase(),
      selectionAuthorizationDigest: id("unmatched active lifecycle selection").toLowerCase(),
      selectionAuthorizationExpiresAt: now + 25,
      requestId: unmatchedRequestId,
      solverId: unmatchedBinding.solverId,
      offer: {
        direction: unmatchedBinding.direction,
        capabilityDigest: unmatchedBinding.capabilityDigest,
        bitAmountWei: "1",
        lightningAmountSats: "4000",
        maxRoutingFeeSats: "0",
        capacityEpoch: unmatchedBinding.capacityEpoch,
        expiresAt: now + 25,
        signatureVerified: true,
      },
      policy: admissionPolicy,
      now: now + 15,
    });
    const unmatchedExecutable = waitingStore.bindFirmOfferExecution({
      offerId: unmatchedOffer.offerId,
      privateRequestDigest: id("unmatched active lifecycle private request").toLowerCase(),
      executableOfferDigest: id("unmatched active lifecycle executable offer").toLowerCase(),
      finalizedAt: now + 15,
    });
    waitingStore.bindFirmOfferUserAuthorization({
      offerId: unmatchedOffer.offerId,
      executionBindingDigest: unmatchedExecutable.executionBindingDigest,
      executionAuthorizationDigest: id("unmatched active lifecycle authorization").toLowerCase(),
      authorizationExpiresAt: now + 25,
      authorizedAt: now + 15,
    });
    waitingStore.acceptSettlement({
      settlementId: unmatchedSettlementId,
      pricingId: unmatchedRequestId,
      direction: unmatchedBinding.direction,
      nonceAuthorityDigest: id("unmatched active lifecycle nonce authority").toLowerCase(),
      intentNonce: "1",
      intentDigest: id("unmatched active lifecycle intent").toLowerCase(),
      paymentHash: id("unmatched active lifecycle payment hash").toLowerCase(),
      invoiceDigest: id("unmatched active lifecycle invoice").toLowerCase(),
      amountSats: "4000",
      quoteReceiptDigest: id("unmatched active lifecycle quote receipt").toLowerCase(),
      selectedSetDigest: id("unmatched active lifecycle selected set").toLowerCase(),
      selectedOfferId: unmatchedOfferId,
      capacityEpoch: unmatchedBinding.capacityEpoch,
      createdAt: now + 15,
    });
    const unmatchedActivation = await activatePublicTestnetRelease({
      candidate,
      approvalBundle,
      providerSet,
      reconciliation: reconciliation.reconciliation,
      reconciliationApprovals: reconciliation.approvals,
      now,
    });
    const unmatchedSupervisor = createCoordinatorReleaseVerificationSupervisor({
      manifestPath: "/injected-unmatched-settlement-manifest.json",
      activate: async () => ({
        manifestDigest: id("unmatched settlement manifest").toLowerCase(),
        candidate,
        activation: unmatchedActivation,
      }),
    });
    assert.equal((await unmatchedSupervisor.refresh({ now: now + 15 })).state, "active");
    const unmatchedPreparation = await prepareCoordinatorActiveExecutionPolicySet({
      executionPolicies: [{
        solverCapabilityVerification: solverCapability.verification,
        evidencePolicy,
        runtime: { packetClient: null, controls: {}, lightning: null, evm: null },
      }],
      releaseSupervisor: unmatchedSupervisor,
      serviceLease,
      store: waitingStore,
    });
    const unmatchedLifecycle = createCoordinatorActiveExecutionLifecycle({
      intervalSeconds: 5,
      maxSettlementsPerCycle: 16,
      policyPreparation: unmatchedPreparation,
      releaseRefreshSeconds: 10,
      releaseSupervisor: unmatchedSupervisor,
      serviceLease,
      store: waitingStore,
    });
    const unmatchedCycle = await unmatchedLifecycle.runCycle();
    assert.equal(unmatchedCycle.state, "degraded");
    assert.equal(unmatchedCycle.counts.discovered, 2);
    assert.equal(unmatchedCycle.counts.eligible, 1);
    assert.equal(unmatchedCycle.counts.attempted, 0);
    assert.equal(unmatchedCycle.counts.gateClosed, 1);
    assert.deepEqual(unmatchedCycle.authorizations, {
      funding: false,
      lightningDispatch: false,
      newExposure: false,
    });
    assert.equal(waitingStore.listSettlementActions(wrapperSettlementId).length, 0);
    assert.equal(JSON.stringify(unmatchedCycle).includes(unmatchedSettlementId), false);
    await unmatchedLifecycle.stop();
    assert.deepEqual(await executeRecoverySolverDaemonStep({
      executionContext: recoveryContext,
      executionFence: recoveryExecutionFence,
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), {
      settlementId: wrapperSettlementId,
      stepKind: "WAIT_FOR_RESERVATION",
      outcome: "WAITING",
    });
    await assert.rejects(executeRecoverySolverDaemonStep({
      executionContext: recoveryContext,
      executionFence: structuredClone(recoveryExecutionFence),
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), /original same-process execution fence/);
    waitingStore.recordReservation({
      settlementId: wrapperSettlementId,
      reservationId: id("active wrapper reservation").toLowerCase(),
      reservationTxHash: id("active wrapper reservation transaction").toLowerCase(),
      reservationBlockNumber: 100,
      reservationBlockHash: id("active wrapper reservation block").toLowerCase(),
      reservationIntentDigest: waitingSettlement.intentDigest,
      observedAt: now + 3,
    });
    waitingStore.planAction({
      actionId: id("active wrapper pending Lightning action").toLowerCase(),
      settlementId: wrapperSettlementId,
      method: "/invoicesrpc.Invoices/SettleInvoice",
      requestId: id("active wrapper action request").toLowerCase(),
      payloadDigest: id("active wrapper action payload").toLowerCase(),
      intentDigest: waitingSettlement.intentDigest,
      paymentHash: waitingSettlement.paymentHash,
      invoiceDigest: waitingSettlement.invoiceDigest,
      amountSats: waitingSettlement.amountSats,
      capacityEpoch: waitingSettlement.capacityEpoch,
      plannedAt: now + 3,
    });
    assert.deepEqual(await executeRecoverySolverDaemonStep({
      executionContext: recoveryContext,
      executionFence: recoveryExecutionFence,
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    }), {
      settlementId: wrapperSettlementId,
      stepKind: "AUTHORIZE_AND_DISPATCH_LIGHTNING",
      outcome: "GATE_CLOSED",
      reason: "recovery-only daemon context cannot plan or dispatch a Lightning action or open new exposure",
    });
    Date.now = () => solverBinding.expiresAt * 1_000;
    const closed = await executeActiveSolverDaemonStep({
      executionContext,
      executionFence: activeExecutionFence,
      serviceLease,
      store: waitingStore,
      settlementId: wrapperSettlementId,
    });
    assert.equal(closed.outcome, "GATE_CLOSED");
    assert.equal(closed.stepKind, "AUTHORIZE_AND_DISPATCH_LIGHTNING");
    assert.match(closed.reason, /funding authorization is inactive/);
    await assert.rejects(executeActiveSolverDaemonStep({
      executionContext,
      executionFence: activeExecutionFence,
      serviceLease,
      store: {
        getSettlement: () => waitingSettlement,
        getFirmOffer: () => waitingStore.getFirmOffer(waitingSettlement.selectedOfferId),
      },
      settlementId: wrapperSettlementId,
    }), /original coordinator store/);
    const prototypeSpoof = Object.create(CoordinatorStore.prototype);
    prototypeSpoof.getSettlement = () => waitingSettlement;
    prototypeSpoof.getFirmOffer = () => waitingStore.getFirmOffer(waitingSettlement.selectedOfferId);
    prototypeSpoof.listSettlementActions = () => [];
    await assert.rejects(executeActiveSolverDaemonStep({
      executionContext,
      executionFence: activeExecutionFence,
      serviceLease,
      store: prototypeSpoof,
      settlementId: wrapperSettlementId,
    }), /original coordinator store/);
  } finally {
    Date.now = originalDateNow;
    deactivateRecoverySolverDaemonExecutionFence(recoveryExecutionFence);
    waitingStore.close();
    await serviceLease.release();
  }
  await assert.rejects(executeActiveSolverDaemonStep({
    executionContext: structuredClone(executionContext),
    executionFence: activeExecutionFence,
    store: null,
    settlementId: ZERO,
  }), /same-process release activation/);
  await assert.rejects(executeActiveSolverDaemonStep({
    executionContext,
    executionFence: activeExecutionFence,
    store: null,
    settlementId: ZERO,
    expectedEvidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
  }), /cannot be supplied by its caller/);
  await assert.rejects(executeActiveSolverDaemonStep({
    executionContext,
    executionFence: activeExecutionFence,
    store: null,
    settlementId: ZERO,
    nowSeconds: () => now,
  }), /execution time cannot be supplied/);
  await assert.rejects(executeActiveSolverDaemonStep({
    executionContext,
    executionFence: activeExecutionFence,
    store: null,
    settlementId: ZERO,
    beforeSideEffect: async () => {},
  }), /leadership guard cannot be supplied/);
  assert.equal(deactivateActiveSolverDaemonExecutionFence(activeExecutionFence), true);
  assert.equal(deactivateActiveSolverDaemonExecutionFence(activeExecutionFence), false);
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
  assert.throws(
    () => deactivatePublicTestnetRelease(structuredClone(activation)),
    /not backed by this process/,
  );
  assert.equal(deactivatePublicTestnetRelease(activation), true);
  assert.equal(isPublicTestnetReleaseActive(activation), false);
  assert.equal(deactivatePublicTestnetRelease(activation), false);
  const deactivated = authorizeSolverFunding({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    capabilities: activation.capabilities,
    now,
  });
  assert.equal(deactivated.allowed, false);
  assert.match(deactivated.reasons.join("; "), /live release activation is inactive/);
  assert.throws(
    () => verifiedActiveSolverDaemonContext(executionContext, { now, requireFundingAuthorization: true }),
    /live release activation is inactive/,
  );
  assert.equal(
    verifiedActiveSolverDaemonContext(executionContext, { now, requireFundingAuthorization: false }).solverId,
    solverBinding.solverId,
  );
  assert.equal(isPublicTestnetRecoveryActive(recoveryActivation), true);
  assert.equal(deactivatePublicTestnetRecovery(recoveryActivation), true);
  assert.equal(isPublicTestnetRecoveryActive(recoveryActivation), false);
  assert.equal(deactivatePublicTestnetRecovery(recoveryActivation), false);
  assert.throws(
    () => verifiedRecoverySolverDaemonContext(recoveryContext, { now, requireActive: true }),
    /inactive or stale/,
  );
});

test("recovery activation survives release expiry and closed incident state without authorizing new exposure", async () => {
  const { campaign, candidate, deployment } = await fixture();
  const now = candidate.record.validUntil + 120;
  const approvalBundle = await releaseApprovalBundle(candidate);
  const incidentOverrides = {
    gateOpen: false,
    emergencyHalted: true,
    bitPaused: true,
    vaultAvailableWei: "0",
    vaultLockedWei: candidate.record.limits.minBitReserveWei,
    vaultAccountedBalanceWei: candidate.record.limits.minBitReserveWei,
    vaultBitBalanceWei: candidate.record.limits.minBitReserveWei,
  };
  const providerSet = providerSetFor({ candidate, campaign, deployment, now, overrides: incidentOverrides });
  const activation = await activatePublicTestnetRecovery({
    candidate,
    approvalBundle,
    providerSet,
    now,
  });
  assert.equal(activation.status, "same-process-recovery-only-runtime-verification-active");
  assert.equal(activation.scope.includes("recovery-only"), true);
  assert.equal(activation.authorizations.funding, false);
  assert.equal(activation.authorizations.newExposure, false);
  assert.equal(activation.authorizations.lightningDispatch, false);
  assert.equal(activation.deployment.gateOpen, false);
  assert.equal(activation.deployment.emergencyHalted, true);
  assert.equal(activation.deployment.bitPaused, true);
  assert.equal(activation.deployment.balancesReconciled, true);
  assert.equal(isPublicTestnetRecoveryActive(activation), true);
  const solverCapability = await createVerifiedSolverCapabilityFixture({
    now,
    chainId: candidate.record.chainId,
    lightningToBitContract: deployment.verification.manifest.vault.address,
    lightningToBitContractCodeHash: deployment.verification.manifest.vault.codeHash,
    bitToLightningContract: deployment.verification.manifest.userEscrow.address,
    bitToLightningContractCodeHash: deployment.verification.manifest.userEscrow.codeHash,
  });
  const solverBinding = verifiedSolverQuoteBinding(solverCapability.verification);
  const recoveryContext = createRecoverySolverDaemonContext({
    solverCapabilityVerification: solverCapability.verification,
    deployment: activation.deployment,
    evidencePolicy: {
      schema: SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
      releaseRecordDigest: candidate.recordDigest,
      chainId: candidate.record.chainId,
      settlementContract: solverBinding.settlementContract,
      settlementContractCodeHash: solverBinding.settlementContractCodeHash,
      solver: solverBinding.solverId,
      direction: solverBinding.direction,
      approvers: {
        lightningOperator: candidate.policy.approvers.lightningOperator.address,
        securityReviewer: candidate.policy.approvers.securityReviewer.address,
      },
      maxEvidenceAgeSeconds: 15,
      maxEvidenceLifetimeSeconds: 15,
      maxClockSkewSeconds: 2,
    },
    now,
  });
  assert.equal(
    verifiedRecoverySolverDaemonContext(recoveryContext, { now }).evmClaimWorkAllowed,
    false,
  );

  await assert.rejects(activatePublicTestnetRelease({
    candidate,
    approvalBundle,
    providerSet,
    reconciliation: (await runtimeReconciliation(candidate, candidate.record.validUntil - 20)).reconciliation,
    reconciliationApprovals: (await runtimeReconciliation(candidate, candidate.record.validUntil - 20)).approvals,
    now,
  }), /release approvals are invalid:.*expired/);

  await assert.rejects(activatePublicTestnetRecovery({
    candidate,
    approvalBundle,
    providerSet: providerSetFor({
      candidate,
      campaign,
      deployment,
      now,
      overrides: { ...incidentOverrides, providerDisagreement: true },
    }),
    now,
  }), /providers disagree/);
  await assert.rejects(activatePublicTestnetRecovery({
    candidate,
    approvalBundle,
    providerSet: providerSetFor({
      candidate,
      campaign,
      deployment,
      now,
      overrides: { ...incidentOverrides, implementationAddress: "0x1111111111111111111111111111111111111111" },
    }),
    now,
  }), /implementation changed/);
  await assert.rejects(activatePublicTestnetRecovery({
    candidate,
    approvalBundle,
    providerSet: providerSetFor({
      candidate,
      campaign,
      deployment,
      now,
      overrides: { ...incidentOverrides, vaultBitBalanceWei: "1" },
    }),
    now,
  }), /balances do not reconcile/);
  assert.throws(
    () => deactivatePublicTestnetRecovery(structuredClone(activation)),
    /not backed by this process/,
  );
  assert.equal(deactivatePublicTestnetRecovery(activation), true);
});

test("activation manifest rebuilds every raw input and retains authority only in the verifying process", async (t) => {
  const { campaign, candidate, deployment, operations, qualification, review } = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "treeswap-release-activation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidateEvidence = await writeReleaseEvidenceFiles(
    directory,
    releaseEvidenceValues({ campaign, deployment, operations, qualification, review }),
  );
  const now = candidate.record.approvalBlockTimestamp + 120;
  const approvalBundle = await releaseApprovalBundle(candidate);
  const reconciliation = await runtimeReconciliation(candidate, now);
  const providerIdentities = campaign.candidate.record.participants
    .filter((value) => value.role === "evm-provider")
    .map((value) => value.operatorId);
  const extraInputs = {
    approvalBundle,
    providerConfiguration: {
      schema: "treeswap.public-testnet-release-approval-providers.v1",
      providers: [
        { identity: providerIdentities[0], urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_ONE_URL" },
        { identity: providerIdentities[1], urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_TWO_URL" },
      ],
    },
    reconciliation: reconciliation.reconciliation,
    reconciliationApprovals: reconciliation.approvals,
  };
  const extraPaths = {};
  for (const [name, value] of Object.entries(extraInputs)) {
    extraPaths[name] = join(directory, `${name}.json`);
    await writeFile(extraPaths[name], `${JSON.stringify(value)}\n`);
  }
  const manifest = {
    schema: "treeswap.public-testnet-release-activation-inputs.v1",
    candidateEvidence,
    ...extraPaths,
  };
  const manifestPath = join(directory, "activation-inputs.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const result = await activatePublicTestnetReleaseFromManifest({
    manifestPath,
    environment: {
      TREESWAP_RELEASE_RPC_ONE_URL: "https://one.example/rpc/private-token",
      TREESWAP_RELEASE_RPC_TWO_URL: "https://two.example/rpc/private-token",
    },
    fetchImpl: releaseRpcFetch({ candidate, deployment, now }),
    now,
  });
  const summary = buildPublicTestnetReleaseActivationPreflightSummary(result);
  assert.equal(summary.status, "same-process-release-activation-preflight-passed");
  assert.equal(summary.recordDigest, candidate.recordDigest);
  assert.equal(summary.runtimeBlockNumber, 1_200);
  assert.deepEqual(summary.authorizations, {
    signing: false,
    broadcast: false,
    gateOpening: false,
    dispatch: false,
    funding: false,
  });
  assert.equal(/private-token|capabilities|signature/i.test(JSON.stringify(summary)), false);

  const solverCapability = await createVerifiedSolverCapabilityFixture({
    now,
    chainId: candidate.record.chainId,
    lightningToBitContract: deployment.verification.manifest.vault.address,
    lightningToBitContractCodeHash: deployment.verification.manifest.vault.codeHash,
    bitToLightningContract: deployment.verification.manifest.userEscrow.address,
    bitToLightningContractCodeHash: deployment.verification.manifest.userEscrow.codeHash,
  });
  assert.deepEqual(authorizeSolverFunding({
    solverCapabilityVerification: solverCapability.verification,
    deployment: result.activation.deployment,
    capabilities: result.activation.capabilities,
    now,
  }), { allowed: true, reasons: [] });
  assert.equal(authorizeSolverFunding({
    solverCapabilityVerification: solverCapability.verification,
    deployment: structuredClone(result.activation.deployment),
    capabilities: result.activation.capabilities,
    now,
  }).allowed, false);

  const recoveryApprovalBundlePath = join(directory, "recovery-approval-bundle.json");
  await writeFile(recoveryApprovalBundlePath, `${JSON.stringify(approvalBundle)}\n`);
  const recoveryManifest = {
    schema: "treeswap.public-testnet-recovery-activation-inputs.v1",
    candidateEvidence,
    approvalBundle: recoveryApprovalBundlePath,
    providerConfiguration: extraPaths.providerConfiguration,
  };
  const recoveryManifestPath = join(directory, "recovery-activation-inputs.json");
  await writeFile(recoveryManifestPath, `${JSON.stringify(recoveryManifest)}\n`);
  const recoveryResult = await activatePublicTestnetRecoveryFromManifest({
    manifestPath: recoveryManifestPath,
    environment: {
      TREESWAP_RELEASE_RPC_ONE_URL: "https://one.example/rpc/private-token",
      TREESWAP_RELEASE_RPC_TWO_URL: "https://two.example/rpc/private-token",
    },
    fetchImpl: releaseRpcFetch({
      candidate,
      deployment,
      now,
      overrides: { gateOpen: false, emergencyHalted: true, bitPaused: true },
    }),
    now,
  });
  const recoverySummary = buildPublicTestnetRecoveryActivationSummary(recoveryResult);
  assert.equal(recoverySummary.status, "same-process-recovery-only-activation-passed");
  assert.equal(recoverySummary.recordDigest, candidate.recordDigest);
  assert.deepEqual(recoverySummary.runtime, {
    gateOpen: false,
    emergencyHalted: true,
    bitPaused: true,
    balancesReconciled: true,
  });
  assert.deepEqual(recoverySummary.authorizations, {
    funding: false,
    lightningDispatch: false,
    newExposure: false,
  });
  assert.equal(/private-token|capabilities|signature/i.test(JSON.stringify(recoverySummary)), false);
  assert.equal(deactivatePublicTestnetRecovery(recoveryResult.activation), true);

  const recoverySupervisor = createCoordinatorRecoveryVerificationSupervisor({
    manifestPath: recoveryManifestPath,
    environment: {
      TREESWAP_RELEASE_RPC_ONE_URL: "https://one.example/rpc/private-token",
      TREESWAP_RELEASE_RPC_TWO_URL: "https://two.example/rpc/private-token",
    },
    fetchImpl: releaseRpcFetch({
      candidate,
      deployment,
      now,
      overrides: { gateOpen: false, emergencyHalted: true, bitPaused: true },
    }),
  });
  const recoveryStatus = await recoverySupervisor.refresh({ now });
  assert.equal(recoveryStatus.state, "active");
  assert.equal(recoveryStatus.gateOpen, false);
  assert.equal(recoveryStatus.emergencyHalted, true);
  assert.equal(recoveryStatus.bitPaused, true);
  const supervisedRecovery = recoverySupervisor.useActiveActivation((active) => active, { now });
  assert.equal(isPublicTestnetRecoveryActive(supervisedRecovery.activation), true);
  assert.equal(/private-token|signature/i.test(JSON.stringify(recoveryStatus)), false);
  await writeFile(recoveryApprovalBundlePath, "[]\n");
  assert.equal((await recoverySupervisor.refresh({ now: now + 1 })).state, "inactive");
  assert.equal(isPublicTestnetRecoveryActive(supervisedRecovery.activation), false);
  recoverySupervisor.stop();

  const supervisor = createCoordinatorReleaseVerificationSupervisor({
    manifestPath,
    environment: {
      TREESWAP_RELEASE_RPC_ONE_URL: "https://one.example/rpc/private-token",
      TREESWAP_RELEASE_RPC_TWO_URL: "https://two.example/rpc/private-token",
    },
    fetchImpl: releaseRpcFetch({ candidate, deployment, now }),
  });
  assert.equal((await supervisor.refresh({ now })).state, "active");
  const supervisedResult = supervisor.useActiveActivation((active) => active, { now });
  assert.deepEqual(authorizeSolverFunding({
    solverCapabilityVerification: solverCapability.verification,
    deployment: supervisedResult.activation.deployment,
    capabilities: supervisedResult.activation.capabilities,
    now,
  }), { allowed: true, reasons: [] });
  await writeFile(extraPaths.reconciliationApprovals, "[]\n");
  const failedRefresh = await supervisor.refresh({ now: now + 1 });
  assert.equal(failedRefresh.state, "inactive");
  const revoked = authorizeSolverFunding({
    solverCapabilityVerification: solverCapability.verification,
    deployment: supervisedResult.activation.deployment,
    capabilities: supervisedResult.activation.capabilities,
    now: now + 1,
  });
  assert.equal(revoked.allowed, false);
  assert.match(revoked.reasons.join("; "), /live release activation is inactive/);
  supervisor.stop();

  const malformedManifestPath = join(directory, "activation-inputs-malformed.json");
  await writeFile(malformedManifestPath, `${JSON.stringify({
    ...manifest,
    candidateEvidence: { ...candidateEvidence, preparedCandidate: extraPaths.approvalBundle },
  })}\n`);
  await assert.rejects(activatePublicTestnetReleaseFromManifest({
    manifestPath: malformedManifestPath,
    environment: {},
    fetchImpl: releaseRpcFetch({ candidate, deployment, now }),
    now,
  }), /candidate evidence fields are not exact/);

  const duplicateManifestPath = join(directory, "activation-inputs-duplicate.json");
  await writeFile(duplicateManifestPath, `${JSON.stringify({
    ...manifest,
    reconciliationApprovals: extraPaths.reconciliation,
  })}\n`);
  await assert.rejects(activatePublicTestnetReleaseFromManifest({
    manifestPath: duplicateManifestPath,
    environment: {},
    fetchImpl: releaseRpcFetch({ candidate, deployment, now }),
    now,
  }), /must use distinct files/);

  const recoveryExtraFieldPath = join(directory, "recovery-activation-inputs-extra.json");
  await writeFile(recoveryExtraFieldPath, `${JSON.stringify({
    ...recoveryManifest,
    reconciliation: extraPaths.reconciliation,
  })}\n`);
  await assert.rejects(activatePublicTestnetRecoveryFromManifest({
    manifestPath: recoveryExtraFieldPath,
    environment: {},
    fetchImpl: releaseRpcFetch({ candidate, deployment, now }),
    now,
  }), /fields are not exact/);
});

test("activation manifest supports only the exact tiny bootstrap evidence shape before a campaign", async (t) => {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const qualification = await createVerifiedQualificationReviewFixture({
    deployment,
    fundingMode: "operator-testnet-bootstrap",
    reviewedAt: PROMOTION_NOW - 100,
    now: PROMOTION_NOW + 60,
  });
  const bootstrap = await createVerifiedPublicTestnetBootstrapFixture({
    deployment,
    preparedAt: PROMOTION_NOW,
    testQualification: qualification.verification.evidenceDigest,
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
    qualificationReviewVerification: qualification.verification,
  });
  const directory = await mkdtemp(join(tmpdir(), "treeswap-bootstrap-release-activation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidateEvidence = await writeReleaseEvidenceFiles(
    directory,
    bootstrapReleaseEvidenceValues({ bootstrap, deployment, operations, qualification, review }),
  );
  const now = candidate.record.approvalBlockTimestamp + 120;
  const approvalBundle = await releaseApprovalBundle(candidate);
  const reconciliation = await runtimeReconciliation(candidate, now);
  const providerIdentities = bootstrap.candidate.record.participants
    .filter((value) => value.role === "evm-provider")
    .map((value) => value.operatorId);
  const values = {
    approvalBundle,
    providerConfiguration: {
      schema: "treeswap.public-testnet-release-approval-providers.v1",
      providers: [
        { identity: providerIdentities[0], urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_ONE_URL" },
        { identity: providerIdentities[1], urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_TWO_URL" },
      ],
    },
    reconciliation: reconciliation.reconciliation,
    reconciliationApprovals: reconciliation.approvals,
  };
  const paths = {};
  for (const [name, value] of Object.entries(values)) {
    paths[name] = join(directory, `${name}.json`);
    await writeFile(paths[name], `${JSON.stringify(value)}\n`);
  }
  const manifestPath = join(directory, "bootstrap-activation-inputs.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "treeswap.public-testnet-release-activation-inputs.v1",
    candidateEvidence,
    ...paths,
  })}\n`);
  const result = await activatePublicTestnetReleaseFromManifest({
    manifestPath,
    environment: {
      TREESWAP_RELEASE_RPC_ONE_URL: "https://one.example/rpc/private-token",
      TREESWAP_RELEASE_RPC_TWO_URL: "https://two.example/rpc/private-token",
    },
    fetchImpl: releaseRpcFetch({ candidate, deployment, now }),
    now,
  });
  const summary = buildPublicTestnetReleaseActivationPreflightSummary(result);
  assert.equal(summary.fundingMode, "operator-testnet-bootstrap");
  assert.equal(summary.recordDigest, candidate.recordDigest);
  assert.equal(summary.authorizations.funding, false);
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
  const qualification = await createVerifiedQualificationReviewFixture({
    deployment,
    fundingMode: "operator-testnet-bootstrap",
    reviewedAt: PROMOTION_NOW - 100,
    now: PROMOTION_NOW + 60,
  });
  const bootstrap = await createVerifiedPublicTestnetBootstrapFixture({
    deployment,
    preparedAt: PROMOTION_NOW,
    testQualification: qualification.verification.evidenceDigest,
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
    qualificationReviewVerification: qualification.verification,
  });
  assert.equal(candidate.record.fundingMode, "operator-testnet-bootstrap");
  assert.equal(candidate.record.evidenceDigests.publicTestnet, ZERO);
  assert.equal(candidate.record.limits.maxSwapSats, "500");
  assert.equal(candidate.record.counts.independentMonitors, 2);
  assert.notEqual(candidate.evidence.bootstrapEvidenceDigest, bootstrap.verification.recordDigest);
  assert.equal(candidate.evidence.adoptionPolicyDigest, operations.verification.adoptionPolicyDigest);
  assert.equal(candidate.evidence.safetyMonitorUpstreamRecordDigest, bootstrap.verification.recordDigest);
  assert.equal(
    verifiedPublicTestnetReleaseCandidateRuntimeBinding(candidate).safetyMonitorPolicy.releaseRecordDigest,
    candidate.recordDigest,
  );
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
    "treeswap.prepared-public-testnet-bootstrap-release-candidate.v6",
  );

  assert.throws(() => preparePublicTestnetBootstrapReleaseCandidate({
    recordTemplate: bootstrapRecordTemplate(),
    policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
    bootstrapEvidenceVerification: structuredClone(bootstrap.verification),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
    qualificationReviewVerification: qualification.verification,
  }), /bootstrap evidence provenance/);

  const substitutedInput = bootstrapFixture({
    deployment,
    preparedAt: PROMOTION_NOW,
    testQualification: qualification.verification.evidenceDigest,
  });
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
    qualificationReviewVerification: qualification.verification,
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
    qualificationReviewVerification: qualification.verification,
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
      qualificationReviewVerification: qualification.verification,
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
      qualificationReviewVerification: qualification.verification,
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
      qualificationReviewVerification: qualification.verification,
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
      qualificationReviewVerification: qualification.verification,
    }),
    /reviewer signer overlaps/,
  );
});

test("requires live provenance and rejects copied or mismatched upstream evidence", async () => {
  const { campaign, deployment, operations, qualification, review } = await fixture();
  const input = {
    recordTemplate: recordTemplate(),
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
    publicTestnetVerification: campaign.verification,
    qualificationReviewVerification: qualification.verification,
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
    () => preparePublicTestnetReleaseCandidate({
      ...input,
      qualificationReviewVerification: structuredClone(qualification.verification),
    }),
    /qualification review evidence provenance/,
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

test("qualification reviewer cannot overlap an operational or release authority", async () => {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const qualification = await createVerifiedQualificationReviewFixture({
    deployment,
    fundingMode: "operator-testnet",
    reviewerWallet: LIGHTNING_OPERATOR,
    reviewedAt: PROMOTION_NOW - 200,
    now: PROMOTION_NOW + 60,
  });
  const campaign = await createVerifiedPublicTestnetCampaignFixture({
    finishedAt: PROMOTION_NOW - 100,
    chainId: deployment.verification.record.chainId,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    verifyingContract: deployment.verification.record.verifyingContract,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    testQualification: qualification.verification.evidenceDigest,
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
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    recordTemplate: recordTemplate(),
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
    publicTestnetVerification: campaign.verification,
    qualificationReviewVerification: qualification.verification,
  }), /qualification reviewer overlaps/);
});

test("requires exact operational roles, alert channels, drills, artifacts, and release bindings", async () => {
  const { campaign, deployment, operations, qualification, review } = await fixture();
  const monitor = campaign.candidate.record.participants.find((value) => value.role === "monitor");
  const base = {
    recordTemplate: recordTemplate(),
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
    publicTestnetVerification: campaign.verification,
    qualificationReviewVerification: qualification.verification,
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

  const wrongMonitorUpstream = rawOperations();
  wrongMonitorUpstream.safetyMonitorPolicy.releaseRecordDigest = id("substituted monitor upstream record").toLowerCase();
  const wrongMonitorPolicyDigest = safetyMonitorPolicyDigest(wrongMonitorUpstream.safetyMonitorPolicy);
  wrongMonitorUpstream.record.safetyMonitorPolicyDigest = wrongMonitorPolicyDigest;
  wrongMonitorUpstream.policy.safetyMonitorPolicyDigest = wrongMonitorPolicyDigest;
  for (const drill of wrongMonitorUpstream.record.drills) {
    if (drill.safetyControls) drill.safetyControls.safetyMonitorPolicyDigest = wrongMonitorPolicyDigest;
  }
  const wrongMonitorUpstreamVerification = await verifyOperations(wrongMonitorUpstream);
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: wrongMonitorUpstreamVerification,
  }), /operational safety monitor upstream record/);

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
  const { campaign, deployment, operations, qualification, review } = await fixture();
  const base = {
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
    independentReviewVerification: review.verification,
    operationalReadinessVerification: operations.verification,
    publicTestnetVerification: campaign.verification,
    qualificationReviewVerification: qualification.verification,
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
  const { campaign, deployment, operations, qualification, review } = await fixture();
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
      operationsSafetyMonitorPolicy: operations.candidate.safetyMonitorPolicy,
      adoptionPolicy: operations.candidate.adoptionPolicy,
      isolationRecord: operations.serviceIsolation.candidate.record,
      isolationPolicy: operations.serviceIsolation.candidate.policy,
      isolationAttestations: operations.serviceIsolation.candidate.attestations,
      qualificationArtifact: JSON.parse(qualification.qualificationFileBytes.toString("utf8")),
      qualificationReview: qualification.review,
      qualificationPolicy: qualification.policy,
      qualificationAttestation: qualification.attestation,
    };
    const paths = {};
    for (const [name, value] of Object.entries(values)) {
      paths[name] = join(directory, `${name}.json`);
      await writeFile(
        paths[name],
        name === "qualificationArtifact" ? qualification.qualificationFileBytes : `${JSON.stringify(value)}\n`,
      );
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
      "--operations-safety-monitor-policy", paths.operationsSafetyMonitorPolicy,
      "--adoption-policy", paths.adoptionPolicy,
      "--isolation-record", paths.isolationRecord,
      "--isolation-policy", paths.isolationPolicy,
      "--isolation-attestations", paths.isolationAttestations,
      "--qualification-artifact", paths.qualificationArtifact,
      "--qualification-review", paths.qualificationReview,
      "--qualification-policy", paths.qualificationPolicy,
      "--qualification-attestation", paths.qualificationAttestation,
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
  const qualification = await createVerifiedQualificationReviewFixture({
    deployment,
    fundingMode: "operator-testnet-bootstrap",
    reviewedAt: PROMOTION_NOW - 100,
    now: PROMOTION_NOW + 60,
  });
  const bootstrap = await createVerifiedPublicTestnetBootstrapFixture({
    deployment,
    preparedAt: PROMOTION_NOW,
    testQualification: qualification.verification.evidenceDigest,
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
      operationsSafetyMonitorPolicy: operations.candidate.safetyMonitorPolicy,
      adoptionPolicy: operations.candidate.adoptionPolicy,
      isolationRecord: operations.serviceIsolation.candidate.record,
      isolationPolicy: operations.serviceIsolation.candidate.policy,
      isolationAttestations: operations.serviceIsolation.candidate.attestations,
      qualificationArtifact: JSON.parse(qualification.qualificationFileBytes.toString("utf8")),
      qualificationReview: qualification.review,
      qualificationPolicy: qualification.policy,
      qualificationAttestation: qualification.attestation,
    };
    const paths = {};
    for (const [name, value] of Object.entries(values)) {
      paths[name] = join(directory, `${name}.json`);
      await writeFile(
        paths[name],
        name === "qualificationArtifact" ? qualification.qualificationFileBytes : `${JSON.stringify(value)}\n`,
      );
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
      "--operations-safety-monitor-policy", paths.operationsSafetyMonitorPolicy,
      "--adoption-policy", paths.adoptionPolicy,
      "--isolation-record", paths.isolationRecord,
      "--isolation-policy", paths.isolationPolicy,
      "--isolation-attestations", paths.isolationAttestations,
      "--qualification-artifact", paths.qualificationArtifact,
      "--qualification-review", paths.qualificationReview,
      "--qualification-policy", paths.qualificationPolicy,
      "--qualification-attestation", paths.qualificationAttestation,
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
