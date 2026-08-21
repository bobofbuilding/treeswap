import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import { validateDeploymentManifest } from "../lib/deployment-policy.mjs";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";
const E = "0x5555555555555555555555555555555555555555";
const F = "0x6666666666666666666666666666666666666666";
const G = "0x7777777777777777777777777777777777777777";
const BIT_PROXY = "0x8888888888888888888888888888888888888888";
const BIT_IMPLEMENTATION = "0x9999999999999999999999999999999999999999";
const HASH = id("pinned bytecode");
const REVIEW = id("independent review");
const COMMIT = "a".repeat(40);
const owner = (value) => `0x${value.toString(16).padStart(40, "0")}`;
const role = (address, ownerAddresses) => ({
  address,
  isContract: true,
  owners: ownerAddresses.length,
  threshold: 2,
  codeHash: HASH,
  ownerAddresses,
});
const policy = {
  chainId: 1,
  reviewedBuildCommit: COMMIT,
  independentReviewDigest: REVIEW,
  minResumeDelaySeconds: 86_400,
  maxOpenDurationSeconds: 604_800,
  absoluteMaxFeeBps: 500,
  absoluteMaxPriceDeviationBps: 2_500,
  referenceSatsPerBit: 100,
  bitProxyAddress: BIT_PROXY,
  bitImplementationAddress: BIT_IMPLEMENTATION,
  codeHashes: {
    controller: HASH,
    guardian: HASH,
    feeCollector: HASH,
    gate: HASH,
    vault: HASH,
    userEscrow: HASH,
    paymentHashRegistry: HASH,
    bitProxy: HASH,
    bitImplementation: HASH,
  },
};
const manifest = {
  chainId: 1,
  reviewedBuildCommit: COMMIT,
  independentReviewDigest: REVIEW,
  controller: role(A, [owner(101), owner(102), owner(103)]),
  guardian: role(B, [owner(201), owner(202), owner(203)]),
  feeCollector: role(C, [owner(301), owner(302), owner(303)]),
  gate: {
    address: D,
    controller: A,
    guardian: B,
    defaultClosed: true,
    resumeDelaySeconds: 86_400,
    maxOpenDurationSeconds: 172_800,
    codeHash: HASH,
  },
  vault: {
    address: E,
    immutable: true,
    proxy: false,
    codeHash: HASH,
    bit: BIT_PROXY,
    feeCollector: C,
    maxFeeBps: 100,
    maxPriceDeviationBps: 1_000,
    referenceSatsPerBit: 100,
    openGate: D,
    paymentHashRegistry: G,
  },
  userEscrow: {
    address: F,
    immutable: true,
    proxy: false,
    codeHash: HASH,
    bit: BIT_PROXY,
    feeCollector: C,
    maxFeeBps: 100,
    maxPriceDeviationBps: 1_000,
    referenceSatsPerBit: 100,
    openGate: D,
    paymentHashRegistry: G,
  },
  paymentHashRegistry: {
    address: G,
    sealed: true,
    escrowCount: 2,
    codeHash: HASH,
    approvedEscrows: [E, F],
  },
  bit: {
    proxyAddress: BIT_PROXY,
    implementationAddress: BIT_IMPLEMENTATION,
    implementationSlotMatches: true,
    proxyCodeHash: HASH,
    implementationCodeHash: HASH,
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

test("approves only a reviewed, pinned, immutable, role-separated deployment", () => {
  assert.deepEqual(validateDeploymentManifest(manifest, policy), { approved: true, reasons: [] });
});

test("fails closed on captured roles, mutable escrow, registry drift, or unsafe timing", () => {
  const broken = structuredClone(manifest);
  broken.guardian = { ...broken.controller };
  broken.gate.guardian = A;
  broken.gate.resumeDelaySeconds = 60;
  broken.vault.proxy = true;
  broken.vault.maxFeeBps = 501;
  broken.paymentHashRegistry.sealed = false;
  broken.paymentHashRegistry.approvedEscrows = [E];
  broken.independentReviewDigest = "missing";
  const result = validateDeploymentManifest(broken, policy);
  assert.equal(result.approved, false);
  for (const expected of [
    "separate wallets",
    "share an owner quorum",
    "too short",
    "immutable",
    "fee cap",
    "not irreversibly sealed",
    "not exact",
    "review digest",
  ]) {
    assert.match(result.reasons.join("; "), new RegExp(expected));
  }
});

test("requires observable contract wallets with exact unique owners", () => {
  const broken = structuredClone(manifest);
  broken.controller = {
    ...broken.controller,
    isContract: false,
    owners: 3,
    threshold: 1,
    codeHash: "0x0",
    ownerAddresses: [owner(101), owner(101)],
  };
  const result = validateDeploymentManifest(broken, policy);
  assert.equal(result.approved, false);
  assert.match(
    result.reasons.join("; "),
    /deployed contract wallet|at least two|code hash|owner count|owners must be unique/,
  );
});

test("rejects self-asserted source, review, code, BIT, and escrow topology", () => {
  const broken = structuredClone(manifest);
  broken.reviewedBuildCommit = "b".repeat(40);
  broken.independentReviewDigest = id("different review");
  broken.gate.codeHash = id("different gate code");
  broken.bit.implementationAddress = G;
  broken.bit.implementationSlotMatches = false;
  broken.userEscrow.paymentHashRegistry = D;
  const result = validateDeploymentManifest(broken, policy);
  assert.equal(result.approved, false);
  for (const expected of ["build commit", "review digest", "reviewed policy", "implementation", "registry does not match"]) {
    assert.match(result.reasons.join("; "), new RegExp(expected));
  }

  const incompletePolicy = { ...policy, absoluteMaxFeeBps: undefined };
  const incompleteResult = validateDeploymentManifest(manifest, incompletePolicy);
  assert.equal(incompleteResult.approved, false);
  assert.match(incompleteResult.reasons.join("; "), /fee-cap policy is invalid/);
});

test("rejects coercible or malformed numeric and escrow-set fields without throwing", () => {
  const broken = structuredClone(manifest);
  broken.chainId = "1";
  broken.gate.resumeDelaySeconds = "86400";
  broken.gate.maxOpenDurationSeconds = undefined;
  broken.bit.decimals = "18";
  broken.paymentHashRegistry.approvedEscrows = "not-an-array";
  const result = validateDeploymentManifest(broken, policy);
  assert.equal(result.approved, false);
  assert.match(
    result.reasons.join("; "),
    /wrong deployment chain|resume delay|open duration|BIT configuration|not an array|not exact/,
  );

  const invalidPolicy = {
    ...policy,
    chainId: "1",
    absoluteMaxFeeBps: 10_001,
    absoluteMaxPriceDeviationBps: 10_001,
  };
  const policyResult = validateDeploymentManifest(manifest, invalidPolicy);
  assert.equal(policyResult.approved, false);
  assert.match(
    policyResult.reasons.join("; "),
    /deployment-chain policy|fee-cap policy|price-deviation policy/,
  );
});

test("rejects pre-funded deployments, hidden liabilities, and accounting divergence", () => {
  for (const [mutate, expected] of [
    [(value) => { value.accounting.vaultTotalAvailableWei = "1"; }, /reconcile|zero BIT inventory/],
    [(value) => {
      value.accounting.vaultTotalAvailableWei = "1";
      value.accounting.vaultAccountedBalanceWei = "1";
      value.accounting.vaultBitBalanceWei = "1";
    }, /zero BIT inventory/],
    [(value) => {
      value.accounting.userEscrowTotalLockedWei = "1";
      value.accounting.userEscrowBitBalanceWei = "1";
    }, /zero BIT inventory/],
    [(value) => { value.accounting.vaultBitBalanceWei = "1"; }, /does not match accounted inventory|zero BIT inventory/],
    [(value) => { value.accounting.userEscrowBitBalanceWei = "1"; }, /does not match locked liabilities|zero BIT inventory/],
    [(value) => { value.accounting.vaultTotalLockedWei = "01"; }, /canonical uint256/],
  ]) {
    const broken = structuredClone(manifest);
    mutate(broken);
    const result = validateDeploymentManifest(broken, policy);
    assert.equal(result.approved, false);
    assert.match(result.reasons.join("; "), expected);
  }
});
