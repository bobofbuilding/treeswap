import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { id, keccak256, toUtf8Bytes, Wallet } from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "../lib/bit-deployment-observer.mjs";
import {
  buildDeploymentPromotionApprovalMessage,
  buildDeploymentPromotionReleaseEvidence,
  buildDeploymentPromotionSummary,
  verifyDeploymentManifestPromotion,
} from "../lib/deployment-manifest-promotion.mjs";

const NOW = Math.floor(Date.now() / 1_000);
const COMMIT = "a".repeat(40);
const CHAIN_ID = "11155111";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const GATE = "0x4444444444444444444444444444444444444444";
const VAULT = "0x5555555555555555555555555555555555555555";
const USER_ESCROW = "0x6666666666666666666666666666666666666666";
const REGISTRY = "0x7777777777777777777777777777777777777777";
const BIT_PROXY = "0x8888888888888888888888888888888888888888";
const BIT_IMPLEMENTATION = "0x9999999999999999999999999999999999999999";
const CODE_HASH = id("reviewed deployment code").toLowerCase();
const FINALIZED_HASH = id("deployment promotion finalized block").toLowerCase();
const PROVIDER_HEAD_HASH = id("deployment promotion provider head").toLowerCase();
const providerWalletOne = new Wallet(`0x${"01".padStart(64, "0")}`);
const providerWalletTwo = new Wallet(`0x${"02".padStart(64, "0")}`);
const contractReviewer = new Wallet(`0x${"03".padStart(64, "0")}`);
const operationsReviewer = new Wallet(`0x${"04".padStart(64, "0")}`);

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

const owner = (value) => `0x${value.toString(16).padStart(40, "0")}`;
const role = (address, ownerAddresses) => ({
  address,
  isContract: true,
  owners: ownerAddresses.length,
  threshold: 2,
  codeHash: CODE_HASH,
  ownerAddresses,
});

function reviewArtifacts() {
  return {
    compilerInputs: id("promotion compiler inputs").toLowerCase(),
    findingsDisposition: id("promotion findings disposition").toLowerCase(),
    providerIndependence: id("promotion provider independence").toLowerCase(),
    rolesAndStorage: id("promotion roles and storage review").toLowerCase(),
    sourceBundles: id("promotion matched source bundles").toLowerCase(),
    upgradeBehavior: id("promotion upgrade behavior review").toLowerCase(),
  };
}

function manifest(reviews = reviewArtifacts()) {
  const escrow = (address) => ({
    address,
    immutable: true,
    proxy: false,
    codeHash: CODE_HASH,
    bit: BIT_PROXY,
    feeCollector: C,
    maxFeeBps: 100,
    maxPriceDeviationBps: 1_000,
    referenceSatsPerBit: 100,
    openGate: GATE,
    paymentHashRegistry: REGISTRY,
    epochDurationSeconds: 86_400,
    minSettlementWindowSeconds: 1_800,
    minClaimBufferSeconds: 900,
    maxLockDurationSeconds: 172_800,
    maxSwapAmountWei: "10000000000000000000",
    maxEpochVolumeWei: "100000000000000000000",
  });
  return {
    chainId: Number(CHAIN_ID),
    reviewedBuildCommit: COMMIT,
    independentReviewDigest: hash(reviews),
    controller: role(A, [owner(101), owner(102), owner(103)]),
    guardian: role(B, [owner(201), owner(202), owner(203)]),
    feeCollector: role(C, [owner(301), owner(302), owner(303)]),
    gate: {
      address: GATE,
      controller: A,
      guardian: B,
      defaultClosed: true,
      resumeDelaySeconds: 86_400,
      maxOpenDurationSeconds: 172_800,
      codeHash: CODE_HASH,
    },
    vault: escrow(VAULT),
    userEscrow: escrow(USER_ESCROW),
    paymentHashRegistry: {
      address: REGISTRY,
      sealed: true,
      escrowCount: 2,
      codeHash: CODE_HASH,
      approvedEscrows: [VAULT, USER_ESCROW],
    },
    bit: {
      proxyAddress: BIT_PROXY,
      implementationAddress: BIT_IMPLEMENTATION,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      implementationSlotMatches: true,
      proxyCodeHash: CODE_HASH,
      implementationCodeHash: CODE_HASH,
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

function deploymentPolicy(value = manifest()) {
  return {
    chainId: Number(CHAIN_ID),
    reviewedBuildCommit: COMMIT,
    independentReviewDigest: value.independentReviewDigest,
    minResumeDelaySeconds: 86_400,
    maxOpenDurationSeconds: 604_800,
    absoluteMaxFeeBps: 500,
    absoluteMaxPriceDeviationBps: 2_500,
    referenceSatsPerBit: 100,
    bitProxyAddress: BIT_PROXY,
    bitImplementationAddress: BIT_IMPLEMENTATION,
    codeHashes: {
      controller: CODE_HASH,
      guardian: CODE_HASH,
      feeCollector: CODE_HASH,
      gate: CODE_HASH,
      vault: CODE_HASH,
      userEscrow: CODE_HASH,
      paymentHashRegistry: CODE_HASH,
      bitProxy: CODE_HASH,
      bitImplementation: CODE_HASH,
    },
  };
}

function observation(providerLabel, providerIdentity, value = manifest(), observedAt = NOW - 120) {
  return {
    schema: "treeswap.deployment-observation.v2",
    evidenceStatus: "unreviewed-rpc-observation",
    observedAt: new Date(observedAt * 1_000).toISOString(),
    providerLabel,
    providerIdentity,
    sourceCommit: COMMIT,
    chainId: Number(CHAIN_ID),
    providerFinalizedHead: { number: 101, hash: PROVIDER_HEAD_HASH },
    finalizedBlock: { number: 100, hash: FINALIZED_HASH },
    stateAnchor: { blockHash: FINALIZED_HASH, requireCanonical: true },
    manifest: value,
    manifestDigest: hash(value),
  };
}

function fixture() {
  const reviews = reviewArtifacts();
  const deploymentManifest = manifest(reviews);
  const providerEntries = [
    {
      id: id("deployment promotion provider one").toLowerCase(),
      label: "provider-one",
      wallet: providerWalletOne,
    },
    {
      id: id("deployment promotion provider two").toLowerCase(),
      label: "provider-two",
      wallet: providerWalletTwo,
    },
  ].sort((left, right) => left.id.localeCompare(right.id));
  const observations = providerEntries.map((provider) => (
    observation(provider.label, provider.id, structuredClone(deploymentManifest))
  ));
  const providerObservations = observations.map((value) => ({
    providerIdentity: value.providerIdentity,
    observationDigest: hash(value),
  }));
  const candidateDeploymentPolicy = deploymentPolicy(deploymentManifest);
  const record = {
    schema: "treeswap.deployment-promotion-record.v1",
    promotionId: id("deployment promotion one").toLowerCase(),
    environment: "public-testnet",
    chainId: CHAIN_ID,
    verifyingContract: GATE,
    reviewedBuildCommit: COMMIT,
    deploymentPolicyDigest: hash(candidateDeploymentPolicy),
    manifestDigest: hash(deploymentManifest),
    finalizedBlockNumber: "100",
    finalizedBlockHash: FINALIZED_HASH,
    providerObservations,
    reviewArtifacts: reviews,
    promotedAt: NOW,
    validUntil: NOW + 3_600,
  };
  const approvers = [
    {
      role: "contract-reviewer",
      approverId: id("deployment contract reviewer").toLowerCase(),
      signer: contractReviewer.address,
      wallet: contractReviewer,
    },
    {
      role: "operations-reviewer",
      approverId: id("deployment operations reviewer").toLowerCase(),
      signer: operationsReviewer.address,
      wallet: operationsReviewer,
    },
    ...providerEntries.map((provider) => ({
      role: "provider",
      approverId: provider.id,
      signer: provider.wallet.address,
      wallet: provider.wallet,
    })),
  ].sort((left, right) => `${left.role}:${left.approverId}`.localeCompare(`${right.role}:${right.approverId}`));
  const policy = {
    schema: "treeswap.deployment-promotion-policy.v1",
    environment: record.environment,
    chainId: record.chainId,
    verifyingContract: record.verifyingContract,
    reviewedBuildCommit: record.reviewedBuildCommit,
    deploymentPolicyDigest: record.deploymentPolicyDigest,
    manifestDigest: record.manifestDigest,
    minimumProviderCount: 2,
    maximumObservationAgeSeconds: 3_600,
    maximumPromotionLifetimeSeconds: 86_400,
    approvers: approvers.map((value) => ({
      role: value.role,
      approverId: value.approverId,
      signer: value.signer,
    })),
  };
  return { record, policy, deploymentPolicy: candidateDeploymentPolicy, observations, approvers };
}

async function attestations(candidate = fixture()) {
  const values = [];
  for (const approver of candidate.approvers) {
    const typed = buildDeploymentPromotionApprovalMessage({
      record: candidate.record,
      policy: candidate.policy,
      deploymentPolicy: candidate.deploymentPolicy,
      observations: candidate.observations,
      role: approver.role,
      approverId: approver.approverId,
    });
    values.push({
      role: approver.role,
      approverId: approver.approverId,
      signer: approver.signer,
      signature: await approver.wallet.signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return values;
}

async function verify(candidate = fixture(), attestationSet = null, now = NOW) {
  return verifyDeploymentManifestPromotion({
    ...candidate,
    attestations: attestationSet ?? await attestations(candidate),
    now,
  });
}

test("promotes one exact finalized manifest only after provider and reviewer attestations", async () => {
  const candidate = fixture();
  const result = await verify(candidate);
  assert.equal(result.status, "cryptographically-verified-deployment-promotion");
  assert.equal(result.scope, "candidate-deployment-evidence-no-funding-authorization");
  const releaseEvidence = buildDeploymentPromotionReleaseEvidence(result);
  assert.equal(releaseEvidence.deploymentManifest, candidate.record.manifestDigest);
  assert.equal(releaseEvidence.findingsDisposition, candidate.record.reviewArtifacts.findingsDisposition);
  assert.equal(releaseEvidence.scope, "candidate-release-evidence-no-funding-authorization");
  const summary = buildDeploymentPromotionSummary(result);
  assert.equal(summary.providerCount, 2);
  assert.equal(summary.finalizedBlockNumber, "100");
  assert.equal(JSON.stringify(summary).includes(providerWalletOne.address), false);
});

test("release mapping and summary require module-private verification provenance", async () => {
  const result = await verify();
  const clone = structuredClone(result);
  assert.throws(() => buildDeploymentPromotionReleaseEvidence(clone), /provenance/);
  assert.throws(() => buildDeploymentPromotionSummary(clone), /provenance/);
});

test("review bundle, deployment policy, implementation slot, topology, and code are exact", async () => {
  for (const mutate of [
    (candidate) => { candidate.record.reviewArtifacts.compilerInputs = id("changed compiler inputs").toLowerCase(); },
    (candidate) => { candidate.deploymentPolicy.absoluteMaxFeeBps = 50; },
    (candidate) => { candidate.observations[0].manifest.bit.implementationSlot = id("wrong slot").toLowerCase(); },
    (candidate) => { candidate.observations[0].manifest.paymentHashRegistry.sealed = false; },
    (candidate) => { candidate.observations[0].manifest.gate.codeHash = id("wrong code").toLowerCase(); },
    (candidate) => { candidate.observations[0].manifest.accounting.vaultBitBalanceWei = "1"; },
  ]) {
    const candidate = fixture();
    mutate(candidate);
    await assert.rejects(() => attestations(candidate), /review|policy digest|implementation slot|disagree|manifest digest|approved/);
  }
});

test("promotion rejects nonzero, missing, malformed, or provider-disputed accounting", async () => {
  for (const mutate of [
    (candidate) => {
      candidate.observations[0].manifest.accounting.vaultTotalAvailableWei = "1";
      candidate.observations[0].manifest.accounting.vaultAccountedBalanceWei = "1";
      candidate.observations[0].manifest.accounting.vaultBitBalanceWei = "1";
    },
    (candidate) => { delete candidate.observations[0].manifest.accounting.vaultBitBalanceWei; },
    (candidate) => { candidate.observations[0].manifest.accounting.userEscrowTotalLockedWei = "01"; },
    (candidate) => { candidate.observations[1].manifest.accounting.userEscrowBitBalanceWei = "1"; },
  ]) {
    const candidate = fixture();
    mutate(candidate);
    await assert.rejects(
      () => attestations(candidate),
      /accounting|inventory|liabilities|disagree|manifest digest|fields are not exact|canonical uint256/,
    );
  }
});

test("provider observations must be fresh, canonical, finalized, ordered, distinct, and identical", async () => {
  const mutations = [
    (candidate) => { candidate.observations[0].observedAt = new Date((NOW - 3_601) * 1_000).toISOString(); },
    (candidate) => { candidate.observations[0].stateAnchor.requireCanonical = false; },
    (candidate) => { candidate.observations[0].providerFinalizedHead.number = 99; },
    (candidate) => { candidate.observations.reverse(); },
    (candidate) => { candidate.observations[1].providerIdentity = candidate.observations[0].providerIdentity; },
    (candidate) => { candidate.observations[1].manifest.gate.defaultClosed = false; },
  ];
  for (const mutate of mutations) {
    const candidate = fixture();
    mutate(candidate);
    await assert.rejects(() => attestations(candidate), /stale|canonical|finalized|ordered|match|disagree|manifest digest/);
  }
});

test("policy cannot weaken provider count, freshness, lifetime, reviewer roles, or signer separation", async () => {
  for (const mutate of [
    (candidate) => { candidate.policy.minimumProviderCount = 1; },
    (candidate) => { candidate.policy.maximumObservationAgeSeconds = 3_601; },
    (candidate) => { candidate.policy.maximumPromotionLifetimeSeconds = 86_401; },
    (candidate) => { candidate.policy.approvers = candidate.policy.approvers.filter((value) => value.role !== "contract-reviewer"); },
    (candidate) => { candidate.policy.approvers[1].signer = candidate.policy.approvers[0].signer; },
  ]) {
    const candidate = fixture();
    mutate(candidate);
    await assert.rejects(() => attestations(candidate), /two to five|one hour|one day|reviewer|distinct/);
  }
});

test("missing, duplicate, wrong-role, replayed, and tampered attestations fail closed", async () => {
  const candidate = fixture();
  const signed = await attestations(candidate);
  await assert.rejects(() => verify(candidate, signed.slice(1)), /every promotion approver/);
  await assert.rejects(() => verify(candidate, [...signed.slice(0, -1), signed[0]]), /ordered|duplicated|every promotion/);
  const wrongRole = structuredClone(signed);
  wrongRole[0].role = "provider";
  await assert.rejects(() => verify(candidate, wrongRole), /ordered|does not match|signature/);
  const replay = structuredClone(signed);
  replay[0].approverId = candidate.policy.approvers[1].approverId;
  await assert.rejects(() => verify(candidate, replay), /ordered|does not match|signature/);
  const changed = fixture();
  changed.record.validUntil += 1;
  await assert.rejects(() => verify(changed, signed), /signature/);
});

test("future, expired, unknown-field, and secret-bearing promotions fail closed", async () => {
  const future = fixture();
  const futureAttestations = await attestations(future);
  await assert.rejects(() => verify(future, futureAttestations, NOW - 1), /future-dated/);
  const expired = fixture();
  const expiredAttestations = await attestations(expired);
  await assert.rejects(() => verify(expired, expiredAttestations, NOW + 3_601), /expired/);
  const unknown = fixture();
  unknown.record.approved = true;
  await assert.rejects(() => attestations(unknown), /fields are not exact/);
  const unknownPolicy = fixture();
  unknownPolicy.policy.assumeIndependent = true;
  await assert.rejects(() => attestations(unknownPolicy), /fields are not exact/);
  const unknownObservation = fixture();
  unknownObservation.observations[0].rpcHealthy = true;
  await assert.rejects(() => attestations(unknownObservation), /fields are not exact/);
  const secret = fixture();
  secret.observations[0].providerLabel = "https://private-rpc.example";
  secret.record.providerObservations[0].observationDigest = hash(secret.observations[0]);
  await assert.rejects(() => attestations(secret), /secret|endpoint/);
});

test("prepare and verify CLIs emit typed data and evidence without signing or funding", async () => {
  const candidate = fixture();
  const signed = await attestations(candidate);
  const directory = await mkdtemp(join(tmpdir(), "treeswap-deployment-promotion-"));
  try {
    const paths = Object.fromEntries([
      ["record", candidate.record],
      ["policy", candidate.policy],
      ["deployment-policy", candidate.deploymentPolicy],
      ["observations", candidate.observations],
      ["attestations", signed],
    ].map(([name]) => [name, join(directory, `${name}.json`)]));
    await Promise.all(Object.entries(paths).map(([name, path]) => writeFile(
      path,
      `${JSON.stringify(name === "deployment-policy" ? candidate.deploymentPolicy : name === "attestations" ? signed : candidate[name])}\n`,
      { mode: 0o600 },
    )));
    const approver = candidate.approvers[0];
    const prepared = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-deployment-promotion-approval.mjs",
      "--record", paths.record,
      "--policy", paths.policy,
      "--deployment-policy", paths["deployment-policy"],
      "--observations", paths.observations,
      "--role", approver.role,
      "--approver-id", approver.approverId,
    ], { encoding: "utf8" }));
    assert.equal(prepared.primaryType, "ManifestPromotionApproval");
    assert.match(prepared.scope, /no-funding-authorization/);
    assert.equal(JSON.stringify(prepared).includes("privateKey"), false);

    const verified = JSON.parse(execFileSync(process.execPath, [
      "scripts/verify-deployment-promotion.mjs",
      "--record", paths.record,
      "--policy", paths.policy,
      "--deployment-policy", paths["deployment-policy"],
      "--observations", paths.observations,
      "--attestations", paths.attestations,
    ], { encoding: "utf8" }));
    assert.equal(verified.status, "cryptographically-verified-deployment-promotion");
    assert.match(verified.scope, /no-funding-authorization/);
    assert.match(verified.releaseEvidence.scope, /no-funding-authorization/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
