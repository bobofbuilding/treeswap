import {
  Interface,
  ZeroAddress,
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "./bit-deployment-observer.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

const WALLET_INTERFACE = new Interface([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const GATE_INTERFACE = new Interface([
  "function controller() view returns (address)",
  "function guardian() view returns (address)",
  "function resumeDelay() view returns (uint32)",
  "function maxOpenDuration() view returns (uint32)",
  "function isOpen() view returns (bool)",
  "function emergencyHalted() view returns (bool)",
  "function openUntil() view returns (uint64)",
  "function pendingOpen() view returns (bytes32 riskDigest,uint64 executeAfter,uint64 validUntil)",
]);
const REGISTRY_INTERFACE = new Interface([
  "function isSealed() view returns (bool)",
  "function escrowCount() view returns (uint8)",
  "function approvedEscrow(address escrow) view returns (bool)",
]);
const ESCROW_INTERFACE = new Interface([
  "function BIT() view returns (address)",
  "function openGate() view returns (address)",
  "function paymentHashRegistry() view returns (address)",
  "function feeCollector() view returns (address)",
  "function maxFeeBps() view returns (uint16)",
  "function maxPriceDeviationBps() view returns (uint16)",
  "function referenceSatsPerBit() view returns (uint32)",
  "function epochDuration() view returns (uint32)",
  "function minSettlementWindow() view returns (uint32)",
  "function minClaimBuffer() view returns (uint32)",
  "function maxLockDuration() view returns (uint32)",
  "function maxSwapAmount() view returns (uint96)",
  "function maxEpochVolume() view returns (uint96)",
]);
const VAULT_ACCOUNTING_INTERFACE = new Interface([
  "function totalAvailable() view returns (uint256)",
  "function totalLocked() view returns (uint256)",
  "function accountedBalance() view returns (uint256)",
]);
const USER_ESCROW_ACCOUNTING_INTERFACE = new Interface([
  "function totalLocked() view returns (uint256)",
]);
const BIT_INTERFACE = new Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

export function deploymentObservationValueDigest(value) {
  return digest(value);
}

export function assertDeploymentObservationIsSecretFree(value) {
  const forbiddenKey = /(email|invoice|macaroon|mnemonic|password|preimage|private.?key|rpc.?url|seed|signature)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string"
          && (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(entry)
            || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)
            || /https?:\/\//i.test(entry)
            || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry))) {
        throw new Error("deployment observation contains secret or endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`deployment observation contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function address(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function hexQuantity(value, name) {
  if (!HEX_QUANTITY.test(String(value))) throw new TypeError(`${name} is not a canonical hex quantity`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe integer range`);
  return Number(parsed);
}

function safeNumber(value, name) {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe range`);
  return Number(parsed);
}

function block(value, name) {
  if (!value || !BYTES32.test(String(value.hash ?? "").toLowerCase())) {
    throw new TypeError(`${name} block is malformed`);
  }
  return Object.freeze({
    number: hexQuantity(value.number, `${name} block number`),
    hash: String(value.hash).toLowerCase(),
    timestamp: hexQuantity(value.timestamp, `${name} block timestamp`),
  });
}

function blockTag(number) {
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("target block number is invalid");
  return `0x${number.toString(16)}`;
}

function code(value, name) {
  if (!isHexString(value) || value === "0x") throw new TypeError(`${name} has no deployed bytecode`);
  return value.toLowerCase();
}

function decode(iface, functionName, value) {
  if (!isHexString(value)) throw new TypeError(`${functionName} returned malformed data`);
  try {
    return iface.decodeFunctionResult(functionName, value);
  } catch {
    throw new TypeError(`${functionName} returned undecodable data`);
  }
}

async function call(rpcCall, iface, target, functionName, args, anchor) {
  const value = await rpcCall("eth_call", [{
    to: target,
    data: iface.encodeFunctionData(functionName, args),
  }, anchor]);
  return decode(iface, functionName, value);
}

async function runtime(rpcCall, target, name, anchor) {
  const bytecode = code(await rpcCall("eth_getCode", [target, anchor]), name);
  return Object.freeze({ bytecode, codeHash: keccak256(bytecode).toLowerCase() });
}

function implementationAddress(word) {
  if (!isHexString(word, 32)) throw new TypeError("BIT implementation slot is malformed");
  const implementation = address(`0x${word.slice(-40)}`, "BIT implementation slot");
  if (implementation === ZeroAddress) throw new TypeError("BIT implementation slot is empty");
  return implementation;
}

async function observeRole(rpcCall, target, name, anchor) {
  const [runtimeValue, ownersResult, thresholdResult] = await Promise.all([
    runtime(rpcCall, target, `${name} wallet`, anchor),
    call(rpcCall, WALLET_INTERFACE, target, "getOwners", [], anchor),
    call(rpcCall, WALLET_INTERFACE, target, "getThreshold", [], anchor),
  ]);
  const ownerAddresses = ownersResult[0].map((item, index) => address(item, `${name} owner ${index}`));
  return Object.freeze({
    address: target,
    isContract: true,
    owners: ownerAddresses.length,
    threshold: safeNumber(thresholdResult[0], `${name} threshold`),
    codeHash: runtimeValue.codeHash,
    ownerAddresses: Object.freeze(ownerAddresses),
  });
}

async function observeEscrow(rpcCall, target, name, anchor) {
  const functionNames = [
    "BIT",
    "openGate",
    "paymentHashRegistry",
    "feeCollector",
    "maxFeeBps",
    "maxPriceDeviationBps",
    "referenceSatsPerBit",
    "epochDuration",
    "minSettlementWindow",
    "minClaimBuffer",
    "maxLockDuration",
    "maxSwapAmount",
    "maxEpochVolume",
  ];
  const [runtimeValue, implementationWord, ...results] = await Promise.all([
    runtime(rpcCall, target, name, anchor),
    rpcCall("eth_getStorageAt", [target, EIP1967_IMPLEMENTATION_SLOT, anchor]),
    ...functionNames.map((functionName) => call(rpcCall, ESCROW_INTERFACE, target, functionName, [], anchor)),
  ]);
  if (!isHexString(implementationWord, 32)) throw new TypeError(`${name} implementation slot is malformed`);
  const value = Object.fromEntries(functionNames.map((functionName, index) => [functionName, results[index][0]]));
  const eip1967Empty = implementationWord.toLowerCase() === ZERO_BYTES32;
  return Object.freeze({
    address: target,
    immutable: eip1967Empty,
    proxy: !eip1967Empty,
    codeHash: runtimeValue.codeHash,
    bit: address(value.BIT, `${name} BIT`),
    openGate: address(value.openGate, `${name} gate`),
    paymentHashRegistry: address(value.paymentHashRegistry, `${name} registry`),
    feeCollector: address(value.feeCollector, `${name} fee collector`),
    maxFeeBps: safeNumber(value.maxFeeBps, `${name} max fee`),
    maxPriceDeviationBps: safeNumber(value.maxPriceDeviationBps, `${name} max price deviation`),
    referenceSatsPerBit: safeNumber(value.referenceSatsPerBit, `${name} reference price`),
    epochDurationSeconds: safeNumber(value.epochDuration, `${name} epoch duration`),
    minSettlementWindowSeconds: safeNumber(value.minSettlementWindow, `${name} minimum settlement window`),
    minClaimBufferSeconds: safeNumber(value.minClaimBuffer, `${name} minimum claim buffer`),
    maxLockDurationSeconds: safeNumber(value.maxLockDuration, `${name} maximum lock duration`),
    maxSwapAmountWei: BigInt(value.maxSwapAmount).toString(),
    maxEpochVolumeWei: BigInt(value.maxEpochVolume).toString(),
  });
}

export async function observeDeploymentManifest({
  rpcCall,
  providerLabel,
  providerIdentity,
  addresses,
  reviewedBuildCommit,
  independentReviewDigest,
  targetBlockNumber = null,
  observedAt = new Date(),
}) {
  if (typeof rpcCall !== "function") throw new TypeError("rpcCall is required");
  const label = String(providerLabel ?? "");
  if (label.length === 0 || label.length > 80) throw new TypeError("provider label is invalid");
  const identity = bytes32(providerIdentity, "provider identity");
  if (!COMMIT.test(String(reviewedBuildCommit ?? ""))) throw new TypeError("reviewed build commit is invalid");
  const reviewDigest = bytes32(independentReviewDigest, "independent review digest");
  exactKeys(addresses, [
    "bitProxy",
    "controller",
    "feeCollector",
    "gate",
    "guardian",
    "paymentHashRegistry",
    "userEscrow",
    "vault",
  ], "deployment addresses");
  const normalized = Object.fromEntries(Object.entries(addresses).map(([key, value]) => [key, address(value, key)]));

  const timestamp = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("observedAt is invalid");
  const chainId = hexQuantity(await rpcCall("eth_chainId", []), "chain ID");
  const finalizedHead = block(await rpcCall("eth_getBlockByNumber", ["finalized", false]), "finalized");
  const target = targetBlockNumber === null ? finalizedHead.number : targetBlockNumber;
  if (!Number.isSafeInteger(target) || target < 0 || target > finalizedHead.number) {
    throw new RangeError("target block is not finalized");
  }
  const targetBlock = block(await rpcCall("eth_getBlockByNumber", [blockTag(target), false]), "target");
  if (targetBlock.number !== target) throw new TypeError("RPC returned the wrong target block");
  if (target === finalizedHead.number && targetBlock.hash !== finalizedHead.hash) {
    throw new TypeError("finalized head changed while observing deployment");
  }
  const anchor = Object.freeze({ blockHash: targetBlock.hash, requireCanonical: true });

  const [controller, guardian, feeCollector, gateRuntime, registryRuntime, vault, userEscrow,
    bitProxyRuntime, implementationWord, gateControllerResult, gateGuardianResult, resumeResult,
    maxOpenResult, isOpenResult, emergencyResult, openUntilResult, pendingResult, sealedResult,
    escrowCountResult, vaultApprovedResult, userEscrowApprovedResult, decimalsResult, pausedResult,
    symbolResult, vaultTotalAvailableResult, vaultTotalLockedResult, vaultAccountedBalanceResult,
    vaultBitBalanceResult, userEscrowTotalLockedResult, userEscrowBitBalanceResult] = await Promise.all([
    observeRole(rpcCall, normalized.controller, "controller", anchor),
    observeRole(rpcCall, normalized.guardian, "guardian", anchor),
    observeRole(rpcCall, normalized.feeCollector, "feeCollector", anchor),
    runtime(rpcCall, normalized.gate, "open gate", anchor),
    runtime(rpcCall, normalized.paymentHashRegistry, "payment-hash registry", anchor),
    observeEscrow(rpcCall, normalized.vault, "vault", anchor),
    observeEscrow(rpcCall, normalized.userEscrow, "user escrow", anchor),
    runtime(rpcCall, normalized.bitProxy, "BIT proxy", anchor),
    rpcCall("eth_getStorageAt", [normalized.bitProxy, EIP1967_IMPLEMENTATION_SLOT, anchor]),
    call(rpcCall, GATE_INTERFACE, normalized.gate, "controller", [], anchor),
    call(rpcCall, GATE_INTERFACE, normalized.gate, "guardian", [], anchor),
    call(rpcCall, GATE_INTERFACE, normalized.gate, "resumeDelay", [], anchor),
    call(rpcCall, GATE_INTERFACE, normalized.gate, "maxOpenDuration", [], anchor),
    call(rpcCall, GATE_INTERFACE, normalized.gate, "isOpen", [], anchor),
    call(rpcCall, GATE_INTERFACE, normalized.gate, "emergencyHalted", [], anchor),
    call(rpcCall, GATE_INTERFACE, normalized.gate, "openUntil", [], anchor),
    call(rpcCall, GATE_INTERFACE, normalized.gate, "pendingOpen", [], anchor),
    call(rpcCall, REGISTRY_INTERFACE, normalized.paymentHashRegistry, "isSealed", [], anchor),
    call(rpcCall, REGISTRY_INTERFACE, normalized.paymentHashRegistry, "escrowCount", [], anchor),
    call(rpcCall, REGISTRY_INTERFACE, normalized.paymentHashRegistry, "approvedEscrow", [normalized.vault], anchor),
    call(
      rpcCall,
      REGISTRY_INTERFACE,
      normalized.paymentHashRegistry,
      "approvedEscrow",
      [normalized.userEscrow],
      anchor,
    ),
    call(rpcCall, BIT_INTERFACE, normalized.bitProxy, "decimals", [], anchor),
    call(rpcCall, BIT_INTERFACE, normalized.bitProxy, "paused", [], anchor),
    call(rpcCall, BIT_INTERFACE, normalized.bitProxy, "symbol", [], anchor),
    call(rpcCall, VAULT_ACCOUNTING_INTERFACE, normalized.vault, "totalAvailable", [], anchor),
    call(rpcCall, VAULT_ACCOUNTING_INTERFACE, normalized.vault, "totalLocked", [], anchor),
    call(rpcCall, VAULT_ACCOUNTING_INTERFACE, normalized.vault, "accountedBalance", [], anchor),
    call(rpcCall, BIT_INTERFACE, normalized.bitProxy, "balanceOf", [normalized.vault], anchor),
    call(rpcCall, USER_ESCROW_ACCOUNTING_INTERFACE, normalized.userEscrow, "totalLocked", [], anchor),
    call(rpcCall, BIT_INTERFACE, normalized.bitProxy, "balanceOf", [normalized.userEscrow], anchor),
  ]);

  const implementation = implementationAddress(implementationWord);
  const implementationRuntime = await runtime(rpcCall, implementation, "BIT implementation", anchor);
  const pendingRiskDigest = String(pendingResult[0]).toLowerCase();
  const pendingExecuteAfter = safeNumber(pendingResult[1], "pending execute-after");
  const pendingValidUntil = safeNumber(pendingResult[2], "pending valid-until");
  const isOpen = Boolean(isOpenResult[0]);
  const emergencyHalted = Boolean(emergencyResult[0]);
  const openUntil = safeNumber(openUntilResult[0], "gate open-until");
  const defaultClosed = !isOpen && emergencyHalted && openUntil === 0
    && pendingRiskDigest === ZERO_BYTES32 && pendingExecuteAfter === 0 && pendingValidUntil === 0;
  const approvedEscrows = [];
  if (Boolean(vaultApprovedResult[0])) approvedEscrows.push(normalized.vault);
  if (Boolean(userEscrowApprovedResult[0])) approvedEscrows.push(normalized.userEscrow);

  const manifest = Object.freeze({
    chainId,
    reviewedBuildCommit,
    independentReviewDigest: reviewDigest,
    controller,
    guardian,
    feeCollector,
    gate: Object.freeze({
      address: normalized.gate,
      controller: address(gateControllerResult[0], "gate controller"),
      guardian: address(gateGuardianResult[0], "gate guardian"),
      defaultClosed,
      resumeDelaySeconds: safeNumber(resumeResult[0], "gate resume delay"),
      maxOpenDurationSeconds: safeNumber(maxOpenResult[0], "gate maximum open duration"),
      codeHash: gateRuntime.codeHash,
    }),
    vault,
    userEscrow,
    paymentHashRegistry: Object.freeze({
      address: normalized.paymentHashRegistry,
      sealed: Boolean(sealedResult[0]),
      escrowCount: safeNumber(escrowCountResult[0], "registry escrow count"),
      codeHash: registryRuntime.codeHash,
      approvedEscrows: Object.freeze(approvedEscrows),
    }),
    bit: Object.freeze({
      proxyAddress: normalized.bitProxy,
      implementationAddress: implementation,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      implementationSlotMatches: true,
      proxyCodeHash: bitProxyRuntime.codeHash,
      implementationCodeHash: implementationRuntime.codeHash,
      paused: Boolean(pausedResult[0]),
      decimals: safeNumber(decimalsResult[0], "BIT decimals"),
      symbol: String(symbolResult[0]),
    }),
    accounting: Object.freeze({
      vaultTotalAvailableWei: BigInt(vaultTotalAvailableResult[0]).toString(),
      vaultTotalLockedWei: BigInt(vaultTotalLockedResult[0]).toString(),
      vaultAccountedBalanceWei: BigInt(vaultAccountedBalanceResult[0]).toString(),
      vaultBitBalanceWei: BigInt(vaultBitBalanceResult[0]).toString(),
      userEscrowTotalLockedWei: BigInt(userEscrowTotalLockedResult[0]).toString(),
      userEscrowBitBalanceWei: BigInt(userEscrowBitBalanceResult[0]).toString(),
    }),
  });
  const manifestDigest = digest(manifest);
  const observation = Object.freeze({
    schema: "treeswap.deployment-observation.v2",
    evidenceStatus: "unreviewed-rpc-observation",
    observedAt: timestamp.toISOString(),
    providerLabel: label,
    providerIdentity: identity,
    sourceCommit: reviewedBuildCommit,
    chainId,
    providerFinalizedHead: Object.freeze({ number: finalizedHead.number, hash: finalizedHead.hash }),
    finalizedBlock: Object.freeze({ number: targetBlock.number, hash: targetBlock.hash }),
    stateAnchor: anchor,
    manifest,
    manifestDigest,
  });
  assertDeploymentObservationIsSecretFree(observation);
  return observation;
}

export function compareDeploymentObservations(left, right) {
  const reasons = [];
  const add = (condition, reason) => { if (condition) reasons.push(reason); };
  add(!left || !right, "two deployment observations are required");
  if (reasons.length === 0) {
    add(left.schema !== "treeswap.deployment-observation.v2", "first deployment observation schema is unsupported");
    add(right.schema !== "treeswap.deployment-observation.v2", "second deployment observation schema is unsupported");
    add(left.evidenceStatus !== "unreviewed-rpc-observation", "first deployment observation status is invalid");
    add(right.evidenceStatus !== "unreviewed-rpc-observation", "second deployment observation status is invalid");
    add(!BYTES32.test(String(left.providerIdentity ?? "")), "first provider identity is invalid");
    add(!BYTES32.test(String(right.providerIdentity ?? "")), "second provider identity is invalid");
    add(left.providerIdentity === right.providerIdentity, "deployment providers must have distinct identities");
    add(left.providerLabel === right.providerLabel, "deployment provider labels must be distinct");
    for (const field of ["sourceCommit", "chainId", "manifestDigest"]) {
      add(left[field] !== right[field], `${field} differs between deployment providers`);
    }
    for (const field of ["number", "hash"]) {
      add(left.finalizedBlock?.[field] !== right.finalizedBlock?.[field], `finalizedBlock.${field} differs between providers`);
    }
    add(
      JSON.stringify(canonical(left.manifest)) !== JSON.stringify(canonical(right.manifest)),
      "deployment manifests differ between providers",
    );
    for (const [position, observation] of [["first", left], ["second", right]]) {
      add(
        observation.stateAnchor?.blockHash !== observation.finalizedBlock?.hash
          || observation.stateAnchor?.requireCanonical !== true,
        `${position} deployment observation is not canonically anchored`,
      );
      add(
        !Number.isSafeInteger(observation.providerFinalizedHead?.number)
          || observation.providerFinalizedHead.number < observation.finalizedBlock?.number,
        `${position} provider did not prove the deployment block finalized`,
      );
      add(digest(observation.manifest) !== observation.manifestDigest, `${position} manifest digest is invalid`);
    }
  }
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}
