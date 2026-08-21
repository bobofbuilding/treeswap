import {
  Interface,
  ZeroAddress,
  getAddress,
  isHexString,
  keccak256,
} from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "./bit-deployment-observer.mjs";
import {
  assertClosedTestnetDeploymentPreflightIsSecretFree,
  closedTestnetDeploymentPreflightValueDigest,
} from "./closed-testnet-deployment-preflight.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

const WALLET_INTERFACE = new Interface([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const BIT_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
]);

function address(value, name) {
  try {
    return getAddress(String(value ?? ""));
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function quantity(value, name) {
  if (!HEX_QUANTITY.test(String(value ?? ""))) throw new TypeError(`${name} is not a canonical hex quantity`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe integer range`);
  return Number(parsed);
}

function block(value, name) {
  if (!value || !BYTES32.test(String(value.hash ?? "").toLowerCase())) throw new TypeError(`${name} block is malformed`);
  return Object.freeze({
    number: quantity(value.number, `${name} block number`),
    hash: String(value.hash).toLowerCase(),
    timestamp: quantity(value.timestamp, `${name} block timestamp`),
  });
}

function blockTag(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("target block number is invalid");
  return `0x${value.toString(16)}`;
}

function runtime(value, name) {
  if (!isHexString(value) || value === "0x") throw new TypeError(`${name} has no runtime bytecode`);
  return keccak256(value.toLowerCase()).toLowerCase();
}

function decode(iface, functionName, value) {
  if (!isHexString(value)) throw new TypeError(`${functionName} returned malformed data`);
  try {
    return iface.decodeFunctionResult(functionName, value);
  } catch {
    throw new TypeError(`${functionName} returned undecodable data`);
  }
}

async function call(rpcCall, iface, target, functionName, anchor) {
  const result = await rpcCall("eth_call", [{
    to: target,
    data: iface.encodeFunctionData(functionName),
  }, anchor]);
  return decode(iface, functionName, result)[0];
}

async function observeRole(rpcCall, expected, name, anchor) {
  const [code, owners, threshold] = await Promise.all([
    rpcCall("eth_getCode", [expected.address, anchor]),
    call(rpcCall, WALLET_INTERFACE, expected.address, "getOwners", anchor),
    call(rpcCall, WALLET_INTERFACE, expected.address, "getThreshold", anchor),
  ]);
  const ownerAddresses = owners.map((value, index) => address(value, `${name} owner ${index}`))
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  const observed = Object.freeze({
    address: address(expected.address, `${name} address`),
    ownerAddresses: Object.freeze(ownerAddresses),
    threshold: quantity(`0x${BigInt(threshold).toString(16)}`, `${name} threshold`),
    runtimeCodeHash: runtime(code, `${name} wallet`),
  });
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(`${name} wallet does not match the plan`);
  return observed;
}

function implementationAddress(value) {
  if (!isHexString(value, 32)) throw new TypeError("BIT implementation slot is malformed");
  const result = address(`0x${value.slice(-40)}`, "BIT implementation");
  if (result === ZeroAddress) throw new TypeError("BIT implementation slot is empty");
  return result;
}

function validatePlan(plan) {
  if (!plan || plan.schema !== "treeswap.closed-testnet-deployment-plan.v1"
      || plan.scope !== "unsigned-public-testnet-plan-no-signing-broadcast-or-funding-authorization"
      || plan.environment !== "public-testnet" || plan.network?.chainId !== "11155111"
      || plan.network?.name !== "sepolia" || plan.network?.mainnetAssets !== false) {
    throw new TypeError("observer requires an unsigned Sepolia deployment plan");
  }
  if (Object.values(plan.permissions ?? {}).some((value) => value !== false)) {
    throw new Error("deployment plan grants an operational authorization");
  }
  const { planDigest, ...body } = plan;
  if (closedTestnetDeploymentPreflightValueDigest(body) !== String(planDigest ?? "").toLowerCase()) {
    throw new Error("deployment plan digest is invalid");
  }
  if (!COMMIT.test(String(plan.source?.reviewedBuildCommit ?? ""))) throw new TypeError("reviewed build commit is invalid");
  assertClosedTestnetDeploymentPreflightIsSecretFree(plan);
  return Object.freeze({
    planDigest: String(planDigest).toLowerCase(),
    inputDigest: String(plan.inputDigest).toLowerCase(),
    sourceCommit: plan.source.reviewedBuildCommit,
    chainId: plan.network.chainId,
    deployer: Object.freeze({
      address: address(plan.deployer?.address, "deployer"),
      startingNonce: String(plan.deployer?.startingNonce ?? ""),
    }),
    deploymentTargets: Object.freeze(plan.deploymentTransactions.map((transaction) => Object.freeze({
      name: String(transaction.name),
      address: address(transaction.expectedContractAddress, `${transaction.name} expected address`),
      codeEmpty: true,
    }))),
    roles: plan.roles,
    bit: plan.bit,
  });
}

export async function observeClosedTestnetDeploymentPreflight({
  rpcCall,
  plan: rawPlan,
  providerIdentity,
  providerLabel,
  targetBlockNumber = null,
  observedAt = new Date(),
}) {
  if (typeof rpcCall !== "function") throw new TypeError("rpcCall is required");
  const plan = validatePlan(rawPlan);
  const identity = String(providerIdentity ?? "").toLowerCase();
  if (!BYTES32.test(identity) || identity === `0x${"00".repeat(32)}`) throw new TypeError("provider identity is invalid");
  const label = String(providerLabel ?? "");
  if (label.length === 0 || label.length > 80) throw new TypeError("provider label is invalid");
  const timestamp = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("observedAt is invalid");

  const chainId = quantity(await rpcCall("eth_chainId", []), "chain ID");
  if (String(chainId) !== plan.chainId) throw new Error("provider is not connected to the plan chain");
  const selected = targetBlockNumber === null
    ? block(await rpcCall("eth_getBlockByNumber", ["latest", false]), "latest")
    : block(await rpcCall("eth_getBlockByNumber", [blockTag(targetBlockNumber), false]), "target");
  if (targetBlockNumber !== null && selected.number !== targetBlockNumber) throw new Error("provider returned the wrong block");
  const anchor = Object.freeze({ blockHash: selected.hash, requireCanonical: true });
  const pendingNonceBefore = quantity(
    await rpcCall("eth_getTransactionCount", [plan.deployer.address, "pending"]),
    "pending deployer nonce before observation",
  );
  const [anchoredNonce, deployerCode, targetCodes, controller, feeCollector, guardian, proxyCode, implementationWord,
    decimalsResult, pausedResult, symbolResult] = await Promise.all([
    rpcCall("eth_getTransactionCount", [plan.deployer.address, anchor]).then((value) => quantity(value, "anchored deployer nonce")),
    rpcCall("eth_getCode", [plan.deployer.address, anchor]),
    Promise.all(plan.deploymentTargets.map((target) => rpcCall("eth_getCode", [target.address, anchor]))),
    observeRole(rpcCall, plan.roles.controller, "controller", anchor),
    observeRole(rpcCall, plan.roles.feeCollector, "fee collector", anchor),
    observeRole(rpcCall, plan.roles.guardian, "guardian", anchor),
    rpcCall("eth_getCode", [plan.bit.proxyAddress, anchor]),
    rpcCall("eth_getStorageAt", [plan.bit.proxyAddress, EIP1967_IMPLEMENTATION_SLOT, anchor]),
    call(rpcCall, BIT_INTERFACE, plan.bit.proxyAddress, "decimals", anchor),
    call(rpcCall, BIT_INTERFACE, plan.bit.proxyAddress, "paused", anchor),
    call(rpcCall, BIT_INTERFACE, plan.bit.proxyAddress, "symbol", anchor),
  ]);
  const observedImplementation = implementationAddress(implementationWord);
  const implementationCode = await rpcCall("eth_getCode", [observedImplementation, anchor]);
  const [pendingNonceAfter, selectedAfter] = await Promise.all([
    rpcCall("eth_getTransactionCount", [plan.deployer.address, "pending"])
      .then((value) => quantity(value, "pending deployer nonce after observation")),
    rpcCall("eth_getBlockByNumber", [blockTag(selected.number), false]).then((value) => block(value, "rechecked target")),
  ]);
  const expectedNonce = BigInt(plan.deployer.startingNonce);
  if (BigInt(anchoredNonce) !== expectedNonce
      || BigInt(pendingNonceBefore) !== expectedNonce
      || BigInt(pendingNonceAfter) !== expectedNonce) {
    throw new Error("deployer nonce changed or does not match the unsigned plan");
  }
  if (deployerCode !== "0x") throw new Error("deployment plan deployer unexpectedly has runtime code");
  if (targetCodes.some((value) => value !== "0x")) {
    throw new Error("a predicted deployment target is already occupied");
  }
  if (selectedAfter.hash !== selected.hash || selectedAfter.timestamp !== selected.timestamp) {
    throw new Error("deployment preflight block changed while it was observed");
  }
  const bit = Object.freeze({
    proxyAddress: address(plan.bit.proxyAddress, "BIT proxy"),
    implementationAddress: observedImplementation,
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
    proxyCodeHash: runtime(proxyCode, "BIT proxy"),
    implementationCodeHash: runtime(implementationCode, "BIT implementation"),
    symbol: String(symbolResult),
    decimals: Number(decimalsResult),
    paused: Boolean(pausedResult),
  });
  const expectedBit = {
    proxyAddress: address(plan.bit.proxyAddress, "expected BIT proxy"),
    implementationAddress: address(plan.bit.implementationAddress, "expected BIT implementation"),
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
    proxyCodeHash: String(plan.bit.proxyCodeHash).toLowerCase(),
    implementationCodeHash: String(plan.bit.implementationCodeHash).toLowerCase(),
    symbol: "BIT",
    decimals: 18,
    paused: false,
  };
  if (JSON.stringify(bit) !== JSON.stringify(expectedBit)) throw new Error("live BIT state does not match the plan");

  const observation = Object.freeze({
    schema: "treeswap.closed-testnet-deployment-preflight-observation.v1",
    evidenceStatus: "unreviewed-live-preflight-observation",
    observedAt: timestamp.toISOString(),
    providerLabel: label,
    providerIdentity: identity,
    sourceCommit: plan.sourceCommit,
    chainId: plan.chainId,
    planDigest: plan.planDigest,
    inputDigest: plan.inputDigest,
    anchorBlock: Object.freeze({
      number: String(selected.number),
      hash: selected.hash,
      timestamp: selected.timestamp,
    }),
    stateAnchor: anchor,
    deployer: Object.freeze({
      address: plan.deployer.address,
      codeEmpty: true,
      anchoredNonce: String(anchoredNonce),
      pendingNonceBefore: String(pendingNonceBefore),
      pendingNonceAfter: String(pendingNonceAfter),
    }),
    deploymentTargets: plan.deploymentTargets,
    roles: Object.freeze({ controller, feeCollector, guardian }),
    bit,
  });
  assertClosedTestnetDeploymentPreflightIsSecretFree(observation);
  return observation;
}
