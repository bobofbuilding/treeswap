import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet, id } from "ethers";
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
import { verifyPublicTestnetBootstrapEvidence } from "../lib/public-testnet-bootstrap-evidence.mjs";
import { verifyIndependentReviewEvidence } from "../lib/independent-review-evidence.mjs";
import { verifyOperationalReadinessEvidence } from "../lib/operational-readiness-evidence.mjs";
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
import { inspectPreparedPublicTestnetReleaseCandidate } from "../lib/public-testnet-release-approval.mjs";

const ZERO = `0x${"00".repeat(32)}`;
const LIGHTNING_OPERATOR = new Wallet(`0x${"55".repeat(32)}`);
const SECURITY_REVIEWER = new Wallet(`0x${"66".repeat(32)}`);
const INCIDENT_COMMANDER = new Wallet(`0x${"77".repeat(32)}`);

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
    "treeswap.prepared-public-testnet-bootstrap-release-candidate.v3",
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
    /testnet-bootstrap maximum/,
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
    fundingMode: "operator-testnet",
    preparedAt: PROMOTION_NOW + 30,
    lightningOperatorWallet: LIGHTNING_OPERATOR,
    incidentCommanderWallet: INCIDENT_COMMANDER,
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
    monitoringOperatorWallet: Wallet.createRandom(),
  });
  assert.throws(() => preparePublicTestnetReleaseCandidate({
    ...base,
    operationalReadinessVerification: wrongMonitor.verification,
  }), /not an exact signed upstream monitor/);

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
