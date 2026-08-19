import { getAddress } from "ethers";

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function add(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

function address(value, name, reasons) {
  try {
    return getAddress(value);
  } catch {
    reasons.push(`${name} is not a canonical address`);
    return null;
  }
}

function role(reasons, name, value) {
  const roleAddress = address(value?.address, `${name}.address`, reasons);
  add(reasons, value?.isContract !== true, `${name} must be a deployed contract wallet`);
  add(reasons, !Number.isSafeInteger(value?.owners) || value.owners < 3, `${name} must have at least three owners`);
  add(reasons, !Number.isSafeInteger(value?.threshold) || value.threshold < 2, `${name} must require at least two owners`);
  add(reasons, value?.threshold > value?.owners, `${name} threshold exceeds its owner count`);
  add(reasons, !BYTES32.test(String(value?.codeHash ?? "")), `${name} code hash is not pinned`);
  return roleAddress;
}

export function validateDeploymentManifest(manifest, policy) {
  const reasons = [];
  add(reasons, Number(manifest.chainId) !== Number(policy.chainId), "wrong deployment chain");
  add(reasons, !COMMIT.test(String(manifest.reviewedBuildCommit ?? "")), "reviewed build commit is not pinned");
  add(reasons, !BYTES32.test(String(manifest.independentReviewDigest ?? "")), "independent review digest is missing");

  const controller = role(reasons, "controller", manifest.controller);
  const guardian = role(reasons, "guardian", manifest.guardian);
  const collector = role(reasons, "feeCollector", manifest.feeCollector);
  add(reasons, controller && guardian && controller === guardian, "controller and guardian must be separate wallets");
  add(reasons, collector && (collector === controller || collector === guardian), "fee collector must be separate from safety roles");

  const gate = manifest.gate ?? {};
  add(reasons, gate.controller !== controller, "gate controller does not match the reviewed wallet");
  add(reasons, gate.guardian !== guardian, "gate guardian does not match the reviewed wallet");
  add(reasons, gate.defaultClosed !== true, "gate must deploy closed");
  add(reasons, gate.resumeDelaySeconds < policy.minResumeDelaySeconds, "gate resume delay is too short");
  add(reasons, gate.maxOpenDurationSeconds > policy.maxOpenDurationSeconds, "gate open duration is too long");
  add(reasons, !BYTES32.test(String(gate.codeHash ?? "")), "gate code hash is not pinned");

  const vault = manifest.vault ?? {};
  const userEscrow = manifest.userEscrow ?? {};
  const vaultAddress = address(vault.address, "vault.address", reasons);
  const userEscrowAddress = address(userEscrow.address, "userEscrow.address", reasons);
  for (const [name, contract] of [["vault", vault], ["userEscrow", userEscrow]]) {
    add(reasons, contract.immutable !== true || contract.proxy === true, `${name} must be immutable and non-proxy`);
    add(reasons, !BYTES32.test(String(contract.codeHash ?? "")), `${name} code hash is not pinned`);
    add(reasons, contract.feeCollector !== collector, `${name} fee collector does not match`);
    add(reasons, Number(contract.maxFeeBps) > Number(policy.absoluteMaxFeeBps), `${name} fee cap exceeds policy`);
    add(reasons, contract.openGate !== gate.address, `${name} open gate does not match`);
  }

  const registry = manifest.paymentHashRegistry ?? {};
  add(reasons, registry.sealed !== true, "payment-hash registry is not irreversibly sealed");
  add(reasons, !BYTES32.test(String(registry.codeHash ?? "")), "payment-hash registry code hash is not pinned");
  const approved = new Set((registry.approvedEscrows ?? []).map((item) => {
    try { return getAddress(item); } catch { return null; }
  }));
  add(reasons, approved.size !== 2 || !approved.has(vaultAddress) || !approved.has(userEscrowAddress), "registry escrow set is not exact");

  const bit = manifest.bit ?? {};
  add(reasons, !BYTES32.test(String(bit.proxyCodeHash ?? "")), "BIT proxy code hash is not pinned");
  add(reasons, !BYTES32.test(String(bit.implementationCodeHash ?? "")), "BIT implementation code hash is not pinned");
  add(reasons, bit.paused !== false || Number(bit.decimals) !== 18, "BIT configuration is unsafe");

  return Object.freeze({ approved: reasons.length === 0, reasons: Object.freeze(reasons) });
}
