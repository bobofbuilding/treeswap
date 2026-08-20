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

function pinnedHash(reasons, name, actual, expected) {
  const actualValid = BYTES32.test(String(actual ?? ""));
  const expectedValid = BYTES32.test(String(expected ?? ""));
  add(reasons, !actualValid, `${name} code hash is not pinned`);
  add(reasons, !expectedValid, `${name} reviewed code hash is missing from policy`);
  add(
    reasons,
    actualValid && expectedValid && String(actual).toLowerCase() !== String(expected).toLowerCase(),
    `${name} code hash does not match reviewed policy`,
  );
}

function role(reasons, name, value, expectedCodeHash) {
  const roleAddress = address(value?.address, `${name}.address`, reasons);
  add(reasons, value?.isContract !== true, `${name} must be a deployed contract wallet`);
  add(reasons, !Number.isSafeInteger(value?.owners) || value.owners < 3, `${name} must have at least three owners`);
  add(reasons, !Number.isSafeInteger(value?.threshold) || value.threshold < 2, `${name} must require at least two owners`);
  add(reasons, value?.threshold > value?.owners, `${name} threshold exceeds its owner count`);
  pinnedHash(reasons, name, value?.codeHash, expectedCodeHash);

  const ownerAddresses = [];
  if (!Array.isArray(value?.ownerAddresses)) {
    reasons.push(`${name} owner addresses are missing`);
  } else {
    for (const [index, raw] of value.ownerAddresses.entries()) {
      const owner = address(raw, `${name}.ownerAddresses[${index}]`, reasons);
      if (owner) ownerAddresses.push(owner);
    }
    add(reasons, ownerAddresses.length !== value.owners, `${name} owner count does not match its owner addresses`);
    add(reasons, new Set(ownerAddresses).size !== ownerAddresses.length, `${name} owners must be unique`);
  }
  return Object.freeze({ address: roleAddress, ownerAddresses: new Set(ownerAddresses), threshold: value?.threshold });
}

function rolesShareQuorum(left, right) {
  if (!Number.isSafeInteger(left.threshold) || !Number.isSafeInteger(right.threshold)) return false;
  let shared = 0;
  for (const owner of left.ownerAddresses) if (right.ownerAddresses.has(owner)) shared += 1;
  return shared >= Math.min(left.threshold, right.threshold);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateDeploymentManifest(manifest, policy) {
  const reasons = [];
  add(reasons, !safeInteger(policy?.chainId) || policy.chainId === 0, "deployment-chain policy is invalid");
  add(
    reasons,
    !safeInteger(policy?.minResumeDelaySeconds) || policy.minResumeDelaySeconds === 0,
    "minimum resume-delay policy is invalid",
  );
  add(
    reasons,
    !safeInteger(policy?.maxOpenDurationSeconds) || policy.maxOpenDurationSeconds === 0,
    "maximum open-duration policy is invalid",
  );
  add(
    reasons,
    !safeInteger(policy?.absoluteMaxFeeBps) || policy.absoluteMaxFeeBps > 10_000,
    "absolute fee-cap policy is invalid",
  );
  add(
    reasons,
    !safeInteger(policy?.absoluteMaxPriceDeviationBps) || policy.absoluteMaxPriceDeviationBps > 10_000,
    "absolute price-deviation policy is invalid",
  );
  add(
    reasons,
    !safeInteger(policy?.referenceSatsPerBit) || policy.referenceSatsPerBit === 0,
    "reference-price policy is invalid",
  );
  add(
    reasons,
    !safeInteger(manifest?.chainId) || manifest.chainId === 0 || manifest.chainId !== policy?.chainId,
    "wrong deployment chain",
  );
  add(reasons, !COMMIT.test(String(manifest?.reviewedBuildCommit ?? "")), "reviewed build commit is not pinned");
  add(
    reasons,
    COMMIT.test(String(manifest?.reviewedBuildCommit ?? ""))
      && manifest.reviewedBuildCommit !== policy?.reviewedBuildCommit,
    "reviewed build commit does not match policy",
  );
  add(reasons, !BYTES32.test(String(manifest?.independentReviewDigest ?? "")), "independent review digest is missing");
  add(
    reasons,
    BYTES32.test(String(manifest?.independentReviewDigest ?? ""))
      && String(manifest.independentReviewDigest).toLowerCase() !== String(policy?.independentReviewDigest ?? "").toLowerCase(),
    "independent review digest does not match policy",
  );

  const hashes = policy?.codeHashes ?? {};
  const controller = role(reasons, "controller", manifest?.controller, hashes.controller);
  const guardian = role(reasons, "guardian", manifest?.guardian, hashes.guardian);
  const collector = role(reasons, "feeCollector", manifest?.feeCollector, hashes.feeCollector);
  add(
    reasons,
    controller.address && guardian.address && controller.address === guardian.address,
    "controller and guardian must be separate wallets",
  );
  add(
    reasons,
    collector.address && (collector.address === controller.address || collector.address === guardian.address),
    "fee collector must be separate from safety roles",
  );
  add(reasons, rolesShareQuorum(controller, guardian), "controller and guardian must not share an owner quorum");
  add(reasons, rolesShareQuorum(controller, collector), "controller and fee collector must not share an owner quorum");
  add(reasons, rolesShareQuorum(guardian, collector), "guardian and fee collector must not share an owner quorum");

  const gate = manifest?.gate ?? {};
  const gateAddress = address(gate.address, "gate.address", reasons);
  const gateController = address(gate.controller, "gate.controller", reasons);
  const gateGuardian = address(gate.guardian, "gate.guardian", reasons);
  add(reasons, gateController !== controller.address, "gate controller does not match the reviewed wallet");
  add(reasons, gateGuardian !== guardian.address, "gate guardian does not match the reviewed wallet");
  add(reasons, gate.defaultClosed !== true, "gate must deploy closed");
  add(
    reasons,
    !safeInteger(gate.resumeDelaySeconds) || gate.resumeDelaySeconds < policy?.minResumeDelaySeconds,
    "gate resume delay is too short",
  );
  add(
    reasons,
    !safeInteger(gate.maxOpenDurationSeconds)
      || gate.maxOpenDurationSeconds === 0
      || gate.maxOpenDurationSeconds > policy?.maxOpenDurationSeconds,
    "gate open duration is too long",
  );
  pinnedHash(reasons, "gate", gate.codeHash, hashes.gate);

  const registry = manifest?.paymentHashRegistry ?? {};
  const registryAddress = address(registry.address, "paymentHashRegistry.address", reasons);
  add(reasons, registry.sealed !== true, "payment-hash registry is not irreversibly sealed");
  add(reasons, registry.escrowCount !== 2, "payment-hash registry escrow count is not exact");
  pinnedHash(reasons, "payment-hash registry", registry.codeHash, hashes.paymentHashRegistry);

  const bit = manifest?.bit ?? {};
  const bitProxy = address(bit.proxyAddress, "bit.proxyAddress", reasons);
  const bitImplementation = address(bit.implementationAddress, "bit.implementationAddress", reasons);
  const expectedBitProxy = address(policy?.bitProxyAddress, "policy.bitProxyAddress", reasons);
  const expectedBitImplementation = address(policy?.bitImplementationAddress, "policy.bitImplementationAddress", reasons);
  add(reasons, bitProxy !== expectedBitProxy, "BIT proxy address does not match policy");
  add(reasons, bitImplementation !== expectedBitImplementation, "BIT implementation address does not match policy");
  add(reasons, bit.implementationSlotMatches !== true, "BIT implementation slot does not match the manifest");
  pinnedHash(reasons, "BIT proxy", bit.proxyCodeHash, hashes.bitProxy);
  pinnedHash(reasons, "BIT implementation", bit.implementationCodeHash, hashes.bitImplementation);
  add(
    reasons,
    bit.paused !== false || !safeInteger(bit.decimals) || bit.decimals !== 18 || bit.symbol !== "BIT",
    "BIT configuration is unsafe",
  );

  const vault = manifest?.vault ?? {};
  const userEscrow = manifest?.userEscrow ?? {};
  const vaultAddress = address(vault.address, "vault.address", reasons);
  const userEscrowAddress = address(userEscrow.address, "userEscrow.address", reasons);
  const approvedEscrows = Array.isArray(registry.approvedEscrows) ? registry.approvedEscrows : [];
  add(reasons, !Array.isArray(registry.approvedEscrows), "registry escrow set is not an array");
  const approved = new Set(approvedEscrows.map((item, index) => (
    address(item, `paymentHashRegistry.approvedEscrows[${index}]`, reasons)
  )).filter(Boolean));
  add(
    reasons,
    approved.size !== 2 || !approved.has(vaultAddress) || !approved.has(userEscrowAddress),
    "registry escrow set is not exact",
  );

  for (const [name, contract, expectedCodeHash] of [
    ["vault", vault, hashes.vault],
    ["userEscrow", userEscrow, hashes.userEscrow],
  ]) {
    add(reasons, contract.immutable !== true || contract.proxy === true, `${name} must be immutable and non-proxy`);
    pinnedHash(reasons, name, contract.codeHash, expectedCodeHash);
    add(reasons, address(contract.bit, `${name}.bit`, reasons) !== bitProxy, `${name} BIT token does not match`);
    add(
      reasons,
      address(contract.feeCollector, `${name}.feeCollector`, reasons) !== collector.address,
      `${name} fee collector does not match`,
    );
    add(reasons, address(contract.openGate, `${name}.openGate`, reasons) !== gateAddress, `${name} open gate does not match`);
    add(
      reasons,
      address(contract.paymentHashRegistry, `${name}.paymentHashRegistry`, reasons) !== registryAddress,
      `${name} payment-hash registry does not match`,
    );
    add(
      reasons,
      !safeInteger(contract.maxFeeBps) || contract.maxFeeBps > policy?.absoluteMaxFeeBps,
      `${name} fee cap exceeds policy`,
    );
    add(
      reasons,
      !safeInteger(contract.maxPriceDeviationBps)
        || contract.maxPriceDeviationBps > policy?.absoluteMaxPriceDeviationBps,
      `${name} price-deviation cap exceeds policy`,
    );
    add(
      reasons,
      contract.referenceSatsPerBit !== policy?.referenceSatsPerBit,
      `${name} reference price does not match policy`,
    );
  }

  return Object.freeze({ approved: reasons.length === 0, reasons: Object.freeze(reasons) });
}
