import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import { buildAdoptionPolicyEvidence, normalizeAdoptionPolicy } from "../lib/adoption-policy.mjs";

const NOW = 1_900_000_000;

function policy(overrides = {}) {
  const value = {
    schema: "treeswap.adoption-policy.v1",
    environment: "public-testnet",
    fundingMode: "operator-testnet-bootstrap",
    chainId: "11155111",
    verifyingContract: "0x1000000000000000000000000000000000000001",
    reviewedBuildCommit: "1".repeat(40),
    protocolVersion: "1.0.0-testnet.1",
    deploymentManifestDigest: id("deployment manifest").toLowerCase(),
    admissionPolicyDigest: id("admission policy").toLowerCase(),
    riskPolicyDigest: id("risk policy").toLowerCase(),
    feeScheduleDigest: id("fee schedule").toLowerCase(),
    preparedAt: NOW,
    validUntil: NOW + 3_600,
    supportOwnerId: id("support owner").toLowerCase(),
    incidentCommanderId: id("incident commander").toLowerCase(),
    limits: {
      maxDailyLightningSats: "10000",
      maxEpochSats: "5000",
      maxInFlightSats: "1000",
      maxPriceBandBps: "250",
      maxRoutingFeeSats: "50",
      maxSwapSats: "500",
      minBitReserveWei: "1000000000000000000",
      minLightningReserveSats: "25000",
    },
    fees: {
      baseBitToLightningBps: 72,
      baseLightningToBitBps: 18,
      maxFeeBps: 100,
      reserveFloorBps: 2_000,
      scarcityStartsBps: 6_000,
    },
    liveness: {
      bondPolicy: "no-bond-objective-history-only",
      establishedSolverMaxBitToLightningSats: "500",
      lastLookAllowed: false,
      maxActiveFirmQuotesPerSolver: 2,
      maxCapacityAgeSeconds: 30,
      maxConsecutiveFailures: 2,
      maxFirmQuoteTtlSeconds: 30,
      maxGlobalBitToLightningInFlightSats: "1000",
      minimumCompletedFillsForEstablished: 20,
      minimumReliabilityBps: 9_000,
      minimumReliabilitySample: 20,
      partialFillsAllowed: false,
      unknownSolverMaxBitToLightningSats: "100",
    },
    lossAllocation: {
      automaticReimbursement: false,
      inventoryOwnerBearsCustodyRisk: true,
      protocolInsuranceFund: false,
      solverBearsLightningDeliveryFailure: true,
      solverPaysLightningRoutingFees: true,
      unresolvedIncidentAction: "halt-and-case-review",
      userBearsOwnWalletAndNetworkFees: true,
    },
    privacy: {
      emailDeliveryEnabled: false,
      onchainLinkageDisclosed: true,
      preimageLoggingAllowed: false,
      pricingRequestRetentionSeconds: 600,
      rawInvoiceLoggingAllowed: false,
      rawTerminalPacketRetentionSeconds: 3_600,
      receiptRetentionSeconds: 2_592_000,
      selectedSolverMayLinkBothLegs: true,
    },
    support: {
      maxIncidentAcknowledgementSeconds: 900,
      maxUserResponseSeconds: 172_800,
      publicIncidentUpdates: true,
      securityUri: "https://github.com/bobofbuilding/treeswap/security/policy",
      statusUri: "https://github.com/bobofbuilding/treeswap/actions",
      supportUri: "https://github.com/bobofbuilding/treeswap/issues",
    },
    upgrades: {
      activeLiabilityMigrationAllowed: false,
      bitImplementationChangeAction: "halt-review-new-observation",
      bitPauseAction: "halt-until-unpaused-and-reviewed",
      emergencyAuthorityMayIncreaseRisk: false,
      treeswapContractChangeAction: "deploy-new-immutable-release",
    },
  };
  return Object.assign(value, overrides);
}

test("normalizes one exact public policy and derives distinct release commitments", () => {
  const evidence = buildAdoptionPolicyEvidence(policy());
  assert.equal(evidence.policy.fees.baseBitToLightningBps, 72);
  assert.equal(evidence.policy.fees.baseLightningToBitBps, 18);
  assert.match(evidence.policyDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(new Set([
    evidence.policyDigest,
    evidence.lossAllocationDigest,
    evidence.privacyRetentionDigest,
    evidence.supportPolicyDigest,
  ]).size, 4);
  assert.deepEqual(evidence.authorizations, {
    signing: false,
    broadcast: false,
    gateOpening: false,
    funding: false,
  });
});

test("requires BIT to Lightning to have the higher base fee", () => {
  for (const fees of [
    { ...policy().fees, baseBitToLightningBps: 18 },
    { ...policy().fees, baseBitToLightningBps: 17 },
    { ...policy().fees, maxFeeBps: 501 },
    { ...policy().fees, reserveFloorBps: 6_000 },
  ]) {
    assert.throws(() => normalizeAdoptionPolicy(policy({ fees })), /higher|ceiling|threshold/);
  }
});

test("rejects caps above the funding mode and unsafe solver promotion", () => {
  const excessive = policy();
  excessive.limits.maxSwapSats = "501";
  assert.throws(() => normalizeAdoptionPolicy(excessive), /ceiling/);

  const weakHistory = policy();
  weakHistory.liveness.minimumCompletedFillsForEstablished = 19;
  assert.throws(() => normalizeAdoptionPolicy(weakHistory), /too weak/);

  const overexposed = policy();
  overexposed.liveness.unknownSolverMaxBitToLightningSats = "501";
  assert.throws(() => normalizeAdoptionPolicy(overexposed), /exposure/);
});

test("rejects hidden insurance, last-look, logging, mutable upgrades, and weak support", () => {
  const mutations = [
    [(value) => { value.lossAllocation.protocolInsuranceFund = true; }, /protocolInsuranceFund/],
    [(value) => { value.liveness.lastLookAllowed = true; }, /lastLookAllowed/],
    [(value) => { value.privacy.rawInvoiceLoggingAllowed = true; }, /rawInvoiceLoggingAllowed/],
    [(value) => { value.upgrades.activeLiabilityMigrationAllowed = true; }, /activeLiabilityMigrationAllowed/],
    [(value) => { value.support.maxIncidentAcknowledgementSeconds = 901; }, /response objective/],
  ];
  for (const [mutate, pattern] of mutations) {
    const changed = policy();
    mutate(changed);
    assert.throws(() => normalizeAdoptionPolicy(changed), pattern);
  }
});

test("accepts only bounded public HTTPS support paths and rejects secret-like material", () => {
  for (const supportUri of [
    "http://github.com/bobofbuilding/treeswap/issues",
    "https://user:secret@example.com/support",
    "https://example.com/support?token=secret",
    "https://localhost/support",
    "https://127.0.0.1/support",
    "https://support.internal/report",
    "https://example.com/%6c%6e%62%63-secret",
  ]) {
    const changed = policy();
    changed.support.supportUri = supportUri;
    assert.throws(() => buildAdoptionPolicyEvidence(changed), /public HTTPS URI/);
  }
  const extra = policy();
  extra.support.email = "operator@example.com";
  assert.throws(() => buildAdoptionPolicyEvidence(extra), /fields are not exact/);
});
