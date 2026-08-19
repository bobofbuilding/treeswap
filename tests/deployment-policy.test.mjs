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
const H = id("pinned bytecode");
const role = (address) => ({ address, isContract: true, owners: 3, threshold: 2, codeHash: H });
const policy = { chainId: 1, minResumeDelaySeconds: 86_400, maxOpenDurationSeconds: 604_800, absoluteMaxFeeBps: 500 };
const manifest = {
  chainId: 1,
  reviewedBuildCommit: "a".repeat(40),
  independentReviewDigest: id("review"),
  controller: role(A),
  guardian: role(B),
  feeCollector: role(C),
  gate: { address: D, controller: A, guardian: B, defaultClosed: true, resumeDelaySeconds: 86_400, maxOpenDurationSeconds: 172_800, codeHash: H },
  vault: { address: E, immutable: true, proxy: false, codeHash: H, feeCollector: C, maxFeeBps: 100, openGate: D },
  userEscrow: { address: F, immutable: true, proxy: false, codeHash: H, feeCollector: C, maxFeeBps: 100, openGate: D },
  paymentHashRegistry: { sealed: true, codeHash: H, approvedEscrows: [E, F] },
  bit: { proxyCodeHash: H, implementationCodeHash: H, paused: false, decimals: 18 },
};

test("approves only a pinned, reviewed, immutable, role-separated deployment", () => {
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
  for (const expected of ["separate wallets", "too short", "immutable", "fee cap", "not irreversibly sealed", "not exact", "review digest"]) {
    assert.match(result.reasons.join("; "), new RegExp(expected));
  }
});

test("requires contract multisigs with independently pinned code", () => {
  const broken = { ...manifest, controller: { ...manifest.controller, isContract: false, owners: 1, threshold: 1, codeHash: "0x0" } };
  const result = validateDeploymentManifest(broken, policy);
  assert.equal(result.approved, false);
  assert.match(result.reasons.join("; "), /deployed contract wallet|three owners|at least two|code hash/);
});
