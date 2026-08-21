import assert from "node:assert/strict";
import test from "node:test";
import { id, Interface, keccak256, recoverAddress, TypedDataEncoder, Wallet } from "ethers";
import { authorizeSolverFunding } from "../lib/capabilities.mjs";
import {
  activateReleaseCapabilities,
  buildReleaseApprovalMessage,
  createErc1271QuorumVerifier,
  erc1271ProviderSetDigest,
  RELEASE_APPROVAL_TYPES,
  releaseAuthorizationDomain,
  verifyReleaseAuthorization,
} from "../lib/release-authorization.mjs";

const NOW = 2_100_000_000;
const ZERO = `0x${"00".repeat(32)}`;
const CONTROLLER = "0x1111111111111111111111111111111111111111";
const GUARDIAN = "0x2222222222222222222222222222222222222222";
const GATE = "0x3333333333333333333333333333333333333333";
const BLOCK_HASH = id("release approval finalized block").toLowerCase();
const CONTRACT_CODE = "0x60006000";
const CONTRACT_CODE_HASH = keccak256(CONTRACT_CODE).toLowerCase();
const PROVIDER_ONE = id("release provider one").toLowerCase();
const PROVIDER_TWO = id("release provider two").toLowerCase();
const PROVIDER_SET_DIGEST = erc1271ProviderSetDigest([PROVIDER_ONE, PROVIDER_TWO]);
const ERC1271 = new Interface([
  "function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)",
]);
const controllerOwner = new Wallet(`0x${"04".padStart(64, "0")}`);
const guardianOwner = new Wallet(`0x${"05".padStart(64, "0")}`);
const lightningOperator = new Wallet(`0x${"01".padStart(64, "0")}`);
const securityReviewer = new Wallet(`0x${"02".padStart(64, "0")}`);
const incidentCommander = new Wallet(`0x${"03".padStart(64, "0")}`);

function digests(fields, prefix, zero = false) {
  return Object.fromEntries(fields.map((field) => [field, zero ? ZERO : id(`${prefix}:${field}`).toLowerCase()]));
}

const evidenceFields = [
  "admissionPolicy",
  "backupRestore",
  "deploymentManifest",
  "deploymentPostflight",
  "deploymentPromotion",
  "feeSchedule",
  "findingsDisposition",
  "incidentDrills",
  "lossAllocation",
  "monitoring",
  "providerQuorum",
  "publicTestnet",
  "riskPolicy",
  "solverOperations",
  "supportPolicy",
  "testQualification",
];
const reviewFields = ["contracts", "coordinator", "identityPrivacy", "lightning", "operations"];

function record(overrides = {}) {
  const base = {
    schema: "treeswap.release-record.v2",
    releaseId: id("treeswap public testnet release 1").toLowerCase(),
    protocolVersion: "1.0.0-testnet.1",
    environment: "public-testnet",
    fundingMode: "operator-testnet",
    chainId: "11155111",
    verifyingContract: GATE,
    approvalBlockNumber: "100",
    approvalBlockHash: BLOCK_HASH,
    approvalBlockTimestamp: NOW,
    approvalProviderSetDigest: PROVIDER_SET_DIGEST,
    reviewedBuildCommit: "a".repeat(40),
    priorReleaseDigest: ZERO,
    evidenceDigests: digests(evidenceFields, "release evidence"),
    reviewDigests: digests(reviewFields, "release review"),
    counts: {
      alertChannels: 2,
      independentEvmProviders: 2,
      independentLightningObservers: 2,
      independentMonitors: 2,
      independentRelays: 2,
      independentSolvers: 2,
      multisigOwnerCount: 3,
      multisigThreshold: 2,
    },
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
    validFrom: NOW - 60,
    validUntil: NOW + 3_600,
  };
  return { ...base, ...overrides };
}

function policy(release = record(), overrides = {}) {
  const base = {
    schema: "treeswap.release-policy.v2",
    environment: release.environment,
    chainId: release.chainId,
    verifyingContract: release.verifyingContract,
    reviewedBuildCommit: release.reviewedBuildCommit,
    deploymentManifestDigest: release.evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: release.evidenceDigests.deploymentPostflight,
    deploymentPromotionDigest: release.evidenceDigests.deploymentPromotion,
    admissionPolicyDigest: release.evidenceDigests.admissionPolicy,
    riskPolicyDigest: release.evidenceDigests.riskPolicy,
    feeScheduleDigest: release.evidenceDigests.feeSchedule,
    maximumReleaseLifetimeSeconds: 86_400,
    maximumRuntimeObservationAgeSeconds: 15,
    minimumCounts: {
      alertChannels: 2,
      independentEvmProviders: 2,
      independentLightningObservers: 2,
      independentMonitors: 2,
      independentRelays: 2,
      independentSolvers: 2,
      multisigOwnerCount: 3,
      multisigThreshold: 2,
    },
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
      controller: { address: CONTROLLER, codeHash: CONTRACT_CODE_HASH, signatureKind: "erc1271" },
      guardian: { address: GUARDIAN, codeHash: CONTRACT_CODE_HASH, signatureKind: "erc1271" },
      lightningOperator: { address: lightningOperator.address, codeHash: ZERO, signatureKind: "eip712" },
      securityReviewer: { address: securityReviewer.address, codeHash: ZERO, signatureKind: "eip712" },
      incidentCommander: { address: incidentCommander.address, codeHash: ZERO, signatureKind: "eip712" },
    },
  };
  return { ...base, ...overrides };
}

async function approvals(release, releasePolicy = policy(release)) {
  const domain = releaseAuthorizationDomain(release);
  const message = buildReleaseApprovalMessage(release, releasePolicy);
  const typedDigest = TypedDataEncoder.hash(domain, RELEASE_APPROVAL_TYPES, message);
  return [
    {
      role: "controller",
      signer: CONTROLLER,
      signatureKind: "erc1271",
      signature: controllerOwner.signingKey.sign(typedDigest).serialized,
    },
    {
      role: "guardian",
      signer: GUARDIAN,
      signatureKind: "erc1271",
      signature: guardianOwner.signingKey.sign(typedDigest).serialized,
    },
    {
      role: "lightningOperator",
      signer: lightningOperator.address,
      signatureKind: "eip712",
      signature: await lightningOperator.signTypedData(domain, RELEASE_APPROVAL_TYPES, message),
    },
    {
      role: "securityReviewer",
      signer: securityReviewer.address,
      signatureKind: "eip712",
      signature: await securityReviewer.signTypedData(domain, RELEASE_APPROVAL_TYPES, message),
    },
    {
      role: "incidentCommander",
      signer: incidentCommander.address,
      signatureKind: "eip712",
      signature: await incidentCommander.signTypedData(domain, RELEASE_APPROVAL_TYPES, message),
    },
  ];
}

async function verify(release = record(), releasePolicy = policy(release), approvalSet = null, now = NOW) {
  const expectedOwners = {
    [CONTROLLER.toLowerCase()]: controllerOwner.address,
    [GUARDIAN.toLowerCase()]: guardianOwner.address,
  };
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getBlockByNumber") {
      return {
        number: "0x64",
        hash: BLOCK_HASH,
        timestamp: `0x${release.approvalBlockTimestamp.toString(16)}`,
      };
    }
    if (method === "eth_getCode") return CONTRACT_CODE;
    if (method === "eth_call") {
      const [signedDigest, signature] = ERC1271.decodeFunctionData("isValidSignature", params[0].data);
      const expected = expectedOwners[String(params[0].to).toLowerCase()];
      let valid = false;
      try { valid = recoverAddress(signedDigest, signature) === expected; } catch {}
      return ERC1271.encodeFunctionResult("isValidSignature", [
        valid ? "0x1626ba7e" : "0xffffffff",
      ]);
    }
    throw new Error(`unexpected mock RPC method: ${method}`);
  };
  const verifyContractSignature = createErc1271QuorumVerifier({
    providers: [
      { identity: PROVIDER_ONE, rpcCall },
      { identity: PROVIDER_TWO, rpcCall },
    ],
    chainId: release.chainId,
    anchor: { number: 100, hash: BLOCK_HASH, timestamp: release.approvalBlockTimestamp },
    expectedContracts: [
      { address: CONTROLLER, codeHash: CONTRACT_CODE_HASH },
      { address: GUARDIAN, codeHash: CONTRACT_CODE_HASH },
    ],
  });
  return verifyReleaseAuthorization({
    record: release,
    policy: releasePolicy,
    approvals: approvalSet ?? await approvals(release, releasePolicy),
    now,
    verifyContractSignature,
  });
}

test("activates operator funding only from one exact five-role signed release record", async () => {
  const release = record();
  const verification = await verify(release);
  assert.equal(verification.valid, true);
  const capabilities = activateReleaseCapabilities({ verification, now: NOW });
  const deployment = {
    releaseRecordDigest: verification.recordDigest,
    releasePolicyDigest: verification.policyDigest,
    deploymentManifestDigest: release.evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: release.evidenceDigests.deploymentPostflight,
    deploymentPromotionDigest: release.evidenceDigests.deploymentPromotion,
    gateOpen: true,
    openGateRiskDigest: id("active risk attestation").toLowerCase(),
    balancesReconciled: true,
    reconciliationDigest: id("current asset reconciliation").toLowerCase(),
    observedAt: NOW - 2,
  };
  const decision = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", capabilityVerified: true },
    deployment,
    capabilities,
    now: NOW,
  });
  assert.deepEqual(decision, { allowed: true, reasons: [] });
});

test("rejects missing, duplicated, wrong-role, and record-replayed approvals", async () => {
  const release = record();
  const signed = await approvals(release);
  const missing = await verify(release, policy(release), signed.slice(1));
  assert.equal(missing.valid, false);
  assert.match(missing.reasons.join("; "), /controller approval is missing/);

  const duplicated = await verify(release, policy(release), [...signed, signed[0]]);
  assert.equal(duplicated.valid, false);
  assert.match(duplicated.reasons.join("; "), /duplicate controller approval/);

  const invalidContract = structuredClone(signed);
  invalidContract[0].signature = "0x9999";
  const invalidContractResult = await verify(release, policy(release), invalidContract);
  assert.equal(invalidContractResult.valid, false);
  assert.match(invalidContractResult.reasons.join("; "), /controller ERC-1271 signature is invalid/);

  const wrongRole = structuredClone(signed);
  wrongRole[2].signer = incidentCommander.address;
  const wrong = await verify(release, policy(release), wrongRole);
  assert.equal(wrong.valid, false);
  assert.match(wrong.reasons.join("; "), /identity does not match policy/);

  const mutated = structuredClone(release);
  mutated.evidenceDigests.monitoring = id("mutated monitoring evidence").toLowerCase();
  const replayed = await verify(mutated, policy(mutated), signed);
  assert.equal(replayed.valid, false);
  assert.match(replayed.reasons.join("; "), /EIP-712 signature is invalid/);

  const changedPolicy = {
    ...policy(release),
    maximumRuntimeObservationAgeSeconds: 30,
  };
  const policyReplay = await verify(release, changedPolicy, signed);
  assert.equal(policyReplay.valid, false);
  assert.match(policyReplay.reasons.join("; "), /signature is invalid/);

  const unbrandedVerifier = await verifyReleaseAuthorization({
    record: release,
    policy: policy(release),
    approvals: signed,
    now: NOW,
    verifyContractSignature: async () => "0x1626ba7e",
  });
  assert.equal(unbrandedVerifier.valid, false);
  assert.match(unbrandedVerifier.reasons.join("; "), /quorum verifier does not match release policy/);

  const duplicateIdentity = id("duplicate release provider").toLowerCase();
  assert.throws(() => createErc1271QuorumVerifier({
    providers: [
      { identity: duplicateIdentity, rpcCall: async () => null },
      { identity: duplicateIdentity, rpcCall: async () => null },
    ],
    chainId: release.chainId,
    anchor: { number: 100, hash: BLOCK_HASH, timestamp: NOW },
    expectedContracts: [{ address: CONTROLLER, codeHash: CONTRACT_CODE_HASH }],
  }), /distinct identities/);

  const substitutedAnchor = record({
    approvalBlockHash: id("substituted approval block").toLowerCase(),
  });
  const anchorResult = await verify(substitutedAnchor, policy(substitutedAnchor));
  assert.equal(anchorResult.valid, false);
  assert.match(anchorResult.reasons.join("; "), /quorum verifier does not match release policy/);

  const substitutedProviders = record({
    approvalProviderSetDigest: id("substituted provider set").toLowerCase(),
  });
  const providerResult = await verify(substitutedProviders, policy(substitutedProviders));
  assert.equal(providerResult.valid, false);
  assert.match(providerResult.reasons.join("; "), /quorum verifier does not match release policy/);
});

test("release and runtime funding require the exact promotion and postflight digests", async () => {
  const legacy = record({ schema: "treeswap.release-record.v1" });
  const legacyResult = await verifyReleaseAuthorization({
    record: legacy,
    policy: policy(record()),
    approvals: [],
    now: NOW,
  });
  assert.equal(legacyResult.valid, false);
  assert.match(legacyResult.reasons.join("; "), /schema is invalid/);

  const missingPostflight = record({
    evidenceDigests: { ...record().evidenceDigests, deploymentPostflight: ZERO },
  });
  const missingResult = await verifyReleaseAuthorization({
    record: missingPostflight,
    policy: policy(record()),
    approvals: [],
    now: NOW,
  });
  assert.equal(missingResult.valid, false);
  assert.match(missingResult.reasons.join("; "), /deploymentPostflight evidence is required/);

  const substitutedPromotion = record({
    evidenceDigests: {
      ...record().evidenceDigests,
      deploymentPromotion: id("substituted deployment promotion").toLowerCase(),
    },
  });
  const substitutedResult = await verifyReleaseAuthorization({
    record: substitutedPromotion,
    policy: policy(record()),
    approvals: [],
    now: NOW,
  });
  assert.equal(substitutedResult.valid, false);
  assert.match(substitutedResult.reasons.join("; "), /deploymentPromotion digest does not match release policy/);

  const release = record();
  const verification = await verify(release);
  const capabilities = activateReleaseCapabilities({ verification, now: NOW });
  const runtime = {
    releaseRecordDigest: verification.recordDigest,
    releasePolicyDigest: verification.policyDigest,
    deploymentManifestDigest: release.evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: id("wrong runtime postflight").toLowerCase(),
    deploymentPromotionDigest: release.evidenceDigests.deploymentPromotion,
    gateOpen: true,
    openGateRiskDigest: id("runtime risk").toLowerCase(),
    balancesReconciled: true,
    reconciliationDigest: id("runtime reconciliation").toLowerCase(),
    observedAt: NOW,
  };
  const decision = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", capabilityVerified: true },
    deployment: runtime,
    capabilities,
    now: NOW,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reasons.join("; "), /not bound to the authorized release/);
});

test("operator funding requires every campaign, operations, support, and review commitment", async () => {
  for (const field of ["findingsDisposition", "lossAllocation", "publicTestnet", "supportPolicy"]) {
    const base = record();
    const missing = record({ evidenceDigests: { ...base.evidenceDigests, [field]: ZERO } });
    const result = await verifyReleaseAuthorization({
      record: missing,
      policy: policy(base),
      approvals: [],
      now: NOW,
    });
    assert.equal(result.valid, false);
    assert.match(result.reasons.join("; "), new RegExp(`${field} evidence is required`));
  }
  for (const field of reviewFields) {
    const base = record();
    const missing = record({ reviewDigests: { ...base.reviewDigests, [field]: ZERO } });
    const result = await verifyReleaseAuthorization({
      record: missing,
      policy: policy(base),
      approvals: [],
      now: NOW,
    });
    assert.equal(result.valid, false);
    assert.match(result.reasons.join("; "), new RegExp(`${field} review evidence is required`));
  }
  const insufficientMonitors = record({
    counts: { ...record().counts, independentMonitors: 1 },
  });
  const monitorResult = await verifyReleaseAuthorization({
    record: insufficientMonitors,
    policy: policy(record()),
    approvals: [],
    now: NOW,
  });
  assert.equal(monitorResult.valid, false);
  assert.match(monitorResult.reasons.join("; "), /independentMonitors/);
});

test("a separate bootstrap mode may precede the campaign only under absolute tiny limits", async () => {
  const base = record();
  const bootstrap = record({
    fundingMode: "operator-testnet-bootstrap",
    evidenceDigests: { ...base.evidenceDigests, publicTestnet: ZERO },
    limits: {
      ...base.limits,
      maxDailyLightningSats: "10000",
      maxEpochSats: "5000",
      maxInFlightSats: "1000",
      maxPriceBandBps: "250",
      maxRoutingFeeSats: "50",
      maxSwapSats: "500",
    },
  });
  const bootstrapPolicy = policy(bootstrap, {
    limitPolicy: {
      maximums: {
        maxDailyLightningSats: "10000",
        maxEpochSats: "5000",
        maxInFlightSats: "1000",
        maxPriceBandBps: "250",
        maxRoutingFeeSats: "50",
        maxSwapSats: "500",
      },
      minimumReserves: {
        minBitReserveWei: bootstrap.limits.minBitReserveWei,
        minLightningReserveSats: bootstrap.limits.minLightningReserveSats,
      },
    },
  });
  const accepted = await verify(bootstrap, bootstrapPolicy);
  assert.equal(accepted.valid, true);

  const excessive = record({
    ...bootstrap,
    limits: { ...bootstrap.limits, maxSwapSats: "501" },
  });
  const rejected = await verifyReleaseAuthorization({
    record: excessive,
    policy: policy(excessive),
    approvals: [],
    now: NOW,
  });
  assert.equal(rejected.valid, false);
  assert.match(rejected.reasons.join("; "), /maxSwapSats exceeds the absolute testnet-bootstrap maximum/);
});

test("enforces independent-operator counts, caps, reserves, lifetime, and current runtime state", async () => {
  const underCount = record({
    counts: { ...record().counts, independentSolvers: 1 },
  });
  const countVerification = await verify(underCount, policy(record()), []);
  assert.equal(countVerification.valid, false);
  assert.match(countVerification.reasons.join("; "), /independentSolvers/);

  for (const [release, expected] of [
    [record({ limits: { ...record().limits, maxSwapSats: "5001" } }), "maxSwapSats"],
    [record({ limits: { ...record().limits, minLightningReserveSats: "24999" } }), "minLightningReserveSats"],
    [record({ validUntil: NOW + 90_000 }), "validity exceeds"],
  ]) {
    const verification = await verify(release, policy(record()), []);
    assert.equal(verification.valid, false);
    assert.match(verification.reasons.join("; "), new RegExp(expected));
  }

  const good = await verify();
  const capabilities = activateReleaseCapabilities({ verification: good, now: NOW });
  const nominal = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", capabilityVerified: true },
    deployment: { audited: true, testnetCampaignPassed: true, openGateHealthy: true, balancesReconciled: true },
    capabilities,
    now: NOW,
  });
  assert.equal(nominal.allowed, false);
  assert.match(nominal.reasons.join("; "), /exact runtime deployment snapshot/);

  const downgradedPolicy = policy(record(), {
    minimumCounts: {
      ...policy(record()).minimumCounts,
      independentEvmProviders: 0,
      independentMonitors: 0,
      independentSolvers: 0,
      multisigThreshold: 0,
    },
  });
  const downgraded = await verify(record(), downgradedPolicy, []);
  assert.equal(downgraded.valid, false);
  assert.match(downgraded.reasons.join("; "), /absolute funding minimum/);
});

test("copied verification objects, copied capabilities, stale observations, and arbitrary feature toggles cannot authorize", async () => {
  const verification = await verify();
  assert.throws(
    () => activateReleaseCapabilities({ verification: { ...verification }, now: NOW }),
    /not verified by this process/,
  );
  const capabilities = activateReleaseCapabilities({ verification, now: NOW });
  const snapshot = {
    releaseRecordDigest: verification.recordDigest,
    releasePolicyDigest: verification.policyDigest,
    deploymentManifestDigest: verification.record.evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: verification.record.evidenceDigests.deploymentPostflight,
    deploymentPromotionDigest: verification.record.evidenceDigests.deploymentPromotion,
    gateOpen: true,
    openGateRiskDigest: id("risk").toLowerCase(),
    balancesReconciled: true,
    reconciliationDigest: id("reconciliation").toLowerCase(),
    observedAt: NOW - 16,
  };
  const copied = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", capabilityVerified: true },
    deployment: { ...snapshot, observedAt: NOW },
    capabilities: { ...capabilities },
    now: NOW,
  });
  assert.equal(copied.allowed, false);
  assert.match(copied.reasons.join("; "), /cryptographically verified release capability/);

  const stale = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", capabilityVerified: true },
    deployment: snapshot,
    capabilities,
    now: NOW,
  });
  assert.equal(stale.allowed, false);
  assert.match(stale.reasons.join("; "), /stale or invalid/);

  const zeroDigests = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", capabilityVerified: true },
    deployment: {
      ...snapshot,
      observedAt: NOW,
      openGateRiskDigest: ZERO,
      reconciliationDigest: ZERO,
    },
    capabilities,
    now: NOW,
  });
  assert.equal(zeroDigests.allowed, false);
  assert.match(zeroDigests.reasons.join("; "), /risk gate and reconciled balances/);

  const arbitrary = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", capabilityVerified: true },
    deployment: { ...snapshot, observedAt: NOW },
    capabilities: { webSolverFunding: true },
    now: NOW,
  });
  assert.equal(arbitrary.allowed, false);
  assert.match(arbitrary.reasons.join("; "), /cryptographically verified/);
});

test("release v2 cannot authorize mainnet before an equivalent mainnet postflight exists", async () => {
  const base = record();
  const mainnet = record({
    environment: "capped-mainnet-beta",
    fundingMode: "operator-mainnet-beta",
    chainId: "1",
    priorReleaseDigest: ZERO,
    evidenceDigests: {
      ...base.evidenceDigests,
      publicTestnet: ZERO,
      findingsDisposition: ZERO,
    },
    reviewDigests: digests(reviewFields, "mainnet reviews", true),
  });
  const result = await verifyReleaseAuthorization({
    record: mainnet,
    policy: policy(mainnet, { environment: "capped-mainnet-beta", chainId: "1" }),
    approvals: [],
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.match(result.reasons.join("; "), /only the closed public-testnet/);
});

test("expired signed records and closed records cannot produce active funding capabilities", async () => {
  const expired = record({
    validFrom: NOW - 120,
    validUntil: NOW - 1,
    approvalBlockTimestamp: NOW - 60,
  });
  const expiredResult = await verify(expired, policy(expired), await approvals(expired), NOW);
  assert.equal(expiredResult.valid, false);
  assert.match(expiredResult.reasons.join("; "), /expired/);

  const base = record();
  const closed = record({
    fundingMode: "closed",
    features: { ...base.features, webSolverFunding: false },
  });
  const closedVerification = await verify(closed, policy(closed));
  assert.equal(closedVerification.valid, true);
  assert.throws(
    () => activateReleaseCapabilities({ verification: closedVerification, now: NOW }),
    /does not enable operator funding/,
  );
});
