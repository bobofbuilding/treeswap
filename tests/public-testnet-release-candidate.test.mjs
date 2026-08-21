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
  buildPublicTestnetReleaseApproval,
  buildPublicTestnetReleaseCandidateSummary,
  preparePublicTestnetBootstrapReleaseCandidate,
  preparePublicTestnetReleaseCandidate,
} from "../lib/public-testnet-release-candidate.mjs";
import {
  buildReleaseApprovalMessage,
  erc1271ProviderSetDigest,
} from "../lib/release-authorization.mjs";

const ZERO = `0x${"00".repeat(32)}`;

function recordTemplate(approvalBlockTimestamp = PROMOTION_NOW + 60) {
  return {
    schema: "treeswap.public-testnet-release-record-template.v1",
    releaseId: id("evidence-bound public testnet release").toLowerCase(),
    protocolVersion: "1.0.0-testnet.1",
    approvalBlockNumber: "1100",
    approvalBlockHash: id("release approval block").toLowerCase(),
    approvalBlockTimestamp,
    priorReleaseDigest: ZERO,
    externalEvidenceDigests: {
      lossAllocation: id("reviewed loss allocation").toLowerCase(),
      supportPolicy: id("reviewed support policy").toLowerCase(),
    },
    reviewDigests: {
      contracts: id("independent contract review").toLowerCase(),
      coordinator: id("independent coordinator review").toLowerCase(),
      identityPrivacy: id("independent identity privacy review").toLowerCase(),
      lightning: id("independent lightning review").toLowerCase(),
      operations: id("independent operations review").toLowerCase(),
    },
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
  const lightningOperator = new Wallet(`0x${"55".repeat(32)}`);
  const securityReviewer = new Wallet(`0x${"66".repeat(32)}`);
  const incidentCommander = new Wallet(`0x${"77".repeat(32)}`);
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
      lightningOperator: { address: lightningOperator.address, codeHash: ZERO, signatureKind: "eip712" },
      securityReviewer: { address: securityReviewer.address, codeHash: ZERO, signatureKind: "eip712" },
      incidentCommander: { address: incidentCommander.address, codeHash: ZERO, signatureKind: "eip712" },
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

function bootstrapEvidence() {
  return {
    schema: "treeswap.public-testnet-bootstrap-evidence.v1",
    admissionPolicy: id("bootstrap admission policy").toLowerCase(),
    backupRestore: id("bootstrap backup restore drill").toLowerCase(),
    feeSchedule: id("bootstrap fee schedule").toLowerCase(),
    findingsDisposition: id("bootstrap findings disposition").toLowerCase(),
    incidentDrills: id("bootstrap incident drills").toLowerCase(),
    monitoring: id("bootstrap monitoring evidence").toLowerCase(),
    providerQuorum: id("bootstrap provider quorum evidence").toLowerCase(),
    riskPolicy: id("bootstrap risk policy").toLowerCase(),
    solverOperations: id("bootstrap solver operations").toLowerCase(),
    testQualification: id("bootstrap qualification evidence").toLowerCase(),
    counts: {
      alertChannels: 2,
      independentEvmProviders: 2,
      independentLightningObservers: 2,
      independentMonitors: 2,
      independentRelays: 2,
      independentSolvers: 2,
    },
  };
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
  const candidate = preparePublicTestnetReleaseCandidate({
    recordTemplate: recordTemplate(),
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
    publicTestnetVerification: campaign.verification,
  });
  return { campaign, candidate, deployment };
}

test("derives one exact release candidate from verified deployment and campaign evidence", async () => {
  const { candidate } = await fixture();
  assert.equal(candidate.status, "upstream-evidence-verified-awaiting-five-role-release-approvals");
  assert.equal(candidate.scope.includes("no-signing"), true);
  assert.equal(candidate.record.counts.independentMonitors, 2);
  assert.equal(candidate.record.counts.multisigOwnerCount, 3);
  assert.equal(candidate.record.counts.multisigThreshold, 2);
  assert.notEqual(candidate.record.evidenceDigests.deploymentPromotion, candidate.evidence.deploymentPromotionRecordDigest);
  assert.notEqual(candidate.record.evidenceDigests.publicTestnet, candidate.evidence.publicTestnetRecordDigest);
  assert.notEqual(candidate.record.evidenceDigests.providerQuorum, ZERO);
  assert.notEqual(candidate.record.evidenceDigests.findingsDisposition, ZERO);
  assert.deepEqual(buildReleaseApprovalMessage(candidate.record, candidate.policy), candidate.approval.message);
  assert.equal(buildPublicTestnetReleaseApproval(candidate).value.recordDigest, candidate.recordDigest);
  assert.throws(() => { candidate.record.limits.maxSwapSats = "999999"; }, /read only|Cannot assign/);
  assert.equal(candidate.record.limits.maxSwapSats, "5000");
  const summary = buildPublicTestnetReleaseCandidateSummary(candidate);
  assert.equal(summary.fundingAuthorization, false);
  assert.equal(summary.recordDigest, candidate.recordDigest);
});

test("derives a distinct tiny-limit bootstrap candidate before campaign evidence exists", async () => {
  const deployment = await createVerifiedDeploymentPromotionFixture();
  const candidate = preparePublicTestnetBootstrapReleaseCandidate({
    recordTemplate: bootstrapRecordTemplate(),
    policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
    bootstrapEvidence: bootstrapEvidence(),
    deploymentPromotionVerification: deployment.verification,
  });
  assert.equal(candidate.record.fundingMode, "operator-testnet-bootstrap");
  assert.equal(candidate.record.evidenceDigests.publicTestnet, ZERO);
  assert.equal(candidate.record.limits.maxSwapSats, "500");
  assert.equal(candidate.record.counts.independentMonitors, 2);
  assert.equal(
    candidate.record.approvalProviderSetDigest,
    erc1271ProviderSetDigest(
      deployment.verification.record.providerObservations.map((value) => value.providerIdentity),
    ),
  );
  assert.equal(candidate.authorizations.funding, false);
  assert.equal(buildPublicTestnetReleaseApproval(candidate).value.recordDigest, candidate.recordDigest);

  assert.throws(
    () => preparePublicTestnetBootstrapReleaseCandidate({
      recordTemplate: bootstrapRecordTemplate(),
      policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
      bootstrapEvidence: {
        ...bootstrapEvidence(),
        evmProviderIdentities: [id("attacker provider 1"), id("attacker provider 2")].sort(),
      },
      deploymentPromotionVerification: deployment.verification,
    }),
    /fields are not exact/,
  );

  const excessive = recordTemplate();
  assert.throws(
    () => preparePublicTestnetBootstrapReleaseCandidate({
      recordTemplate: excessive,
      policyTemplate: policyTemplate(deployment.verification.manifest),
      bootstrapEvidence: bootstrapEvidence(),
      deploymentPromotionVerification: deployment.verification,
    }),
    /testnet-bootstrap maximum/,
  );
  const copied = structuredClone(deployment.verification);
  assert.throws(
    () => preparePublicTestnetBootstrapReleaseCandidate({
      recordTemplate: bootstrapRecordTemplate(),
      policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
      bootstrapEvidence: bootstrapEvidence(),
      deploymentPromotionVerification: copied,
    }),
    /provenance/,
  );
});

test("requires live provenance and rejects copied or mismatched upstream evidence", async () => {
  const { campaign, deployment } = await fixture();
  const input = {
    recordTemplate: recordTemplate(),
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
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

test("rejects stale ordering, incomplete external review, and deployment-wallet substitution", async () => {
  const { campaign, deployment } = await fixture();
  const base = {
    policyTemplate: policyTemplate(deployment.verification.manifest),
    deploymentPromotionVerification: deployment.verification,
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
  const weakReview = recordTemplate();
  weakReview.reviewDigests.operations = ZERO;
  assert.throws(
    () => preparePublicTestnetReleaseCandidate({ ...base, recordTemplate: weakReview }),
    /reviewDigests.operations.*nonzero/,
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
});

test("operator CLI writes a private non-overwriting candidate without authority", async () => {
  const { campaign, deployment } = await fixture();
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
  const directory = await mkdtemp(join(tmpdir(), "treeswap-bootstrap-release-candidate-"));
  try {
    const values = {
      recordTemplate: bootstrapRecordTemplate(),
      policyTemplate: bootstrapPolicyTemplate(deployment.verification.manifest),
      bootstrapEvidence: bootstrapEvidence(),
      promotionRecord: deployment.candidate.record,
      promotionPolicy: deployment.candidate.policy,
      deploymentPolicy: deployment.candidate.deploymentPolicy,
      promotionObservations: deployment.candidate.observations,
      promotionAttestations: deployment.attestations,
      postflightBundle: postflightBundle(deployment),
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
      "--bootstrap-evidence", paths.bootstrapEvidence,
      "--promotion-record", paths.promotionRecord,
      "--promotion-policy", paths.promotionPolicy,
      "--deployment-policy", paths.deploymentPolicy,
      "--promotion-observations", paths.promotionObservations,
      "--promotion-attestations", paths.promotionAttestations,
      "--postflight-bundle", paths.postflightBundle,
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
