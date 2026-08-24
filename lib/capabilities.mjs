import {
  Interface,
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
} from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "./bit-deployment-observer.mjs";
import {
  inspectPreparedPublicTestnetReleaseCandidate,
  verifiedPublicTestnetReleaseApprovalProviderSet,
  verifiedPublicTestnetReleaseApprovalVerification,
  verifyPublicTestnetReleaseApprovals,
} from "./public-testnet-release-approval.mjs";
import {
  verifiedPublicTestnetReleaseCandidateRuntimeBinding,
} from "./public-testnet-release-candidate.mjs";
import {
  activateReleaseCapabilities,
  verifiedReleaseCapabilityBinding,
} from "./release-authorization.mjs";
import {
  verifiedSolverCapacityRecord,
  verifiedSolverQuoteBinding,
} from "./solver-capability.mjs";
import { solverDaemonEvidencePolicyDigest } from "./solver-daemon-evidence.mjs";

export const V1_CAPABILITIES = Object.freeze({
  publicLpDeposits: false,
  lpShares: false,
  promisedYield: false,
  publicOrderBook: false,
  makerRewards: false,
  partialFills: false,
  openCryptographicSolverAdmission: true,
  publicPermissionlessExecution: false,
  webSolverFunding: false,
  solverInventoryPlanner: true,
});

const BYTES32 = /^0x[0-9a-f]{64}$/;
const NONZERO_BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const UINT256_MAX = (1n << 256n) - 1n;
const RUNTIME_RECONCILIATION_FIELDS = Object.freeze([
  "coordinatorStateDigest",
  "dailyLightningSats",
  "epochVolumeSats",
  "inFlightDigest",
  "lightningAvailableSats",
  "lightningInFlightSats",
  "lightningInventoryDigest",
  "observedAt",
  "releaseId",
  "releasePolicyDigest",
  "releaseRecordDigest",
  "schema",
  "unreconciledLiabilities",
  "validUntil",
]);
const RUNTIME_APPROVAL_FIELDS = Object.freeze(["role", "signature", "signer"]);
const RUNTIME_APPROVAL_ROLES = Object.freeze(["lightningOperator", "securityReviewer"]);
const verifiedRuntimeSnapshots = new WeakMap();
const activePublicTestnetReleaseActivations = new WeakMap();
const activeSolverDaemonContexts = new WeakMap();
const verifiedRecoveryRuntimeSnapshots = new WeakMap();
const activePublicTestnetRecoveryActivations = new WeakMap();
const recoverySolverDaemonContexts = new WeakMap();

export const RUNTIME_RECONCILIATION_TYPES = Object.freeze({
  RuntimeReconciliation: Object.freeze([
    Object.freeze({ name: "releaseId", type: "bytes32" }),
    Object.freeze({ name: "releaseRecordDigest", type: "bytes32" }),
    Object.freeze({ name: "releasePolicyDigest", type: "bytes32" }),
    Object.freeze({ name: "observedAt", type: "uint64" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
    Object.freeze({ name: "lightningAvailableSats", type: "uint256" }),
    Object.freeze({ name: "lightningInFlightSats", type: "uint256" }),
    Object.freeze({ name: "epochVolumeSats", type: "uint256" }),
    Object.freeze({ name: "dailyLightningSats", type: "uint256" }),
    Object.freeze({ name: "unreconciledLiabilities", type: "uint256" }),
    Object.freeze({ name: "lightningInventoryDigest", type: "bytes32" }),
    Object.freeze({ name: "coordinatorStateDigest", type: "bytes32" }),
    Object.freeze({ name: "inFlightDigest", type: "bytes32" }),
  ]),
});

const GATE_INTERFACE = new Interface([
  "function isOpen() view returns (bool)",
  "function emergencyHalted() view returns (bool)",
  "function openUntil() view returns (uint64)",
  "function activeRiskDigest() view returns (bytes32)",
]);
const WALLET_INTERFACE = new Interface([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const REGISTRY_INTERFACE = new Interface([
  "function isSealed() view returns (bool)",
  "function escrowCount() view returns (uint8)",
  "function approvedEscrow(address escrow) view returns (bool)",
]);
const VAULT_INTERFACE = new Interface([
  "function totalAvailable() view returns (uint256)",
  "function totalLocked() view returns (uint256)",
  "function accountedBalance() view returns (uint256)",
]);
const USER_ESCROW_INTERFACE = new Interface([
  "function totalLocked() view returns (uint256)",
]);
const BIT_INTERFACE = new Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function paused() view returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

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

function digest(value, name, { allowZero = false } = {}) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || (!allowZero && normalized === ZERO_BYTES32)) {
    throw new TypeError(`${name} must be a ${allowZero ? "" : "nonzero "}bytes32 digest`);
  }
  return normalized;
}

function decimal(value, name) {
  const normalized = String(value ?? "");
  if (!DECIMAL.test(normalized)) throw new TypeError(`${name} must be a canonical uint256 decimal string`);
  if (BigInt(normalized) > UINT256_MAX) throw new RangeError(`${name} exceeds uint256`);
  return normalized;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function safeNumber(value, name) {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} exceeds the safe integer range`);
  }
  return Number(parsed);
}

function address(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function runtimeReconciliationDomain(candidate) {
  return Object.freeze({
    name: "TreeSwap Runtime Reconciliation",
    version: "1",
    chainId: BigInt(candidate.record.chainId),
    verifyingContract: address(candidate.record.verifyingContract, "runtime reconciliation gate"),
  });
}

function normalizeRuntimeReconciliation(input, inspected) {
  exactKeys(input, RUNTIME_RECONCILIATION_FIELDS, "runtime reconciliation");
  if (input.schema !== "treeswap.runtime-reconciliation.v1") {
    throw new TypeError("runtime reconciliation schema is invalid");
  }
  const record = Object.freeze({
    schema: input.schema,
    releaseId: digest(input.releaseId, "runtime reconciliation releaseId"),
    releaseRecordDigest: digest(input.releaseRecordDigest, "runtime reconciliation releaseRecordDigest"),
    releasePolicyDigest: digest(input.releasePolicyDigest, "runtime reconciliation releasePolicyDigest"),
    observedAt: timestamp(input.observedAt, "runtime reconciliation observedAt"),
    validUntil: timestamp(input.validUntil, "runtime reconciliation validUntil"),
    lightningAvailableSats: decimal(input.lightningAvailableSats, "runtime reconciliation lightningAvailableSats"),
    lightningInFlightSats: decimal(input.lightningInFlightSats, "runtime reconciliation lightningInFlightSats"),
    epochVolumeSats: decimal(input.epochVolumeSats, "runtime reconciliation epochVolumeSats"),
    dailyLightningSats: decimal(input.dailyLightningSats, "runtime reconciliation dailyLightningSats"),
    unreconciledLiabilities: decimal(input.unreconciledLiabilities, "runtime reconciliation unreconciledLiabilities"),
    lightningInventoryDigest: digest(input.lightningInventoryDigest, "runtime reconciliation lightningInventoryDigest"),
    coordinatorStateDigest: digest(input.coordinatorStateDigest, "runtime reconciliation coordinatorStateDigest"),
    inFlightDigest: digest(input.inFlightDigest, "runtime reconciliation inFlightDigest"),
  });
  if (record.releaseId !== inspected.candidate.record.releaseId
      || record.releaseRecordDigest !== inspected.recordDigest
      || record.releasePolicyDigest !== inspected.policyDigest) {
    throw new Error("runtime reconciliation is not bound to the release candidate");
  }
  if (record.validUntil <= record.observedAt
      || record.validUntil - record.observedAt
        > inspected.candidate.policy.maximumRuntimeObservationAgeSeconds
      || record.validUntil > inspected.candidate.record.validUntil) {
    throw new Error("runtime reconciliation validity interval is outside release policy");
  }
  if (record.unreconciledLiabilities !== "0") {
    throw new Error("runtime reconciliation contains unexplained liabilities");
  }
  const limits = inspected.candidate.record.limits;
  if (BigInt(record.lightningAvailableSats) < BigInt(limits.minLightningReserveSats)) {
    throw new Error("runtime Lightning reserve is below the release minimum");
  }
  if (BigInt(record.lightningInFlightSats) > BigInt(limits.maxInFlightSats)) {
    throw new Error("runtime Lightning in-flight amount exceeds the release cap");
  }
  if (BigInt(record.epochVolumeSats) > BigInt(limits.maxEpochSats)) {
    throw new Error("runtime epoch volume exceeds the release cap");
  }
  if (BigInt(record.dailyLightningSats) > BigInt(limits.maxDailyLightningSats)) {
    throw new Error("runtime daily Lightning volume exceeds the release cap");
  }
  return record;
}

function runtimeReconciliationMessage(record) {
  return Object.freeze(Object.fromEntries(
    RUNTIME_RECONCILIATION_TYPES.RuntimeReconciliation.map(({ name }) => [name, record[name]]),
  ));
}

export function buildPublicTestnetRuntimeReconciliationApproval({ candidate, reconciliation }) {
  const inspected = inspectPreparedPublicTestnetReleaseCandidate(candidate);
  const record = normalizeRuntimeReconciliation(reconciliation, inspected);
  const domain = runtimeReconciliationDomain(inspected.candidate);
  const value = runtimeReconciliationMessage(record);
  return Object.freeze({
    primaryType: "RuntimeReconciliation",
    domain: Object.freeze({ ...domain, chainId: domain.chainId.toString() }),
    types: RUNTIME_RECONCILIATION_TYPES,
    value,
    typedDigest: TypedDataEncoder.hash(domain, RUNTIME_RECONCILIATION_TYPES, value).toLowerCase(),
  });
}

export function publicTestnetReleaseOpenRiskDigest(candidate) {
  const inspected = inspectPreparedPublicTestnetReleaseCandidate(candidate);
  return hash(Object.freeze({
    schema: "treeswap.release-open-risk.v1",
    releaseId: inspected.candidate.record.releaseId,
    releaseRecordDigest: inspected.recordDigest,
    releasePolicyDigest: inspected.policyDigest,
    deploymentManifestDigest: inspected.candidate.record.evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: inspected.candidate.record.evidenceDigests.deploymentPostflight,
    deploymentPromotionDigest: inspected.candidate.record.evidenceDigests.deploymentPromotion,
    validUntil: inspected.candidate.record.validUntil,
  }));
}

function verifyRuntimeReconciliationApprovals({ inspected, record, approvals }) {
  if (!Array.isArray(approvals) || approvals.length !== RUNTIME_APPROVAL_ROLES.length) {
    throw new Error("runtime reconciliation requires exactly two approvals");
  }
  const normalized = new Map();
  for (const raw of approvals) {
    exactKeys(raw, RUNTIME_APPROVAL_FIELDS, "runtime reconciliation approval");
    if (!RUNTIME_APPROVAL_ROLES.includes(raw.role)) throw new TypeError("runtime reconciliation role is invalid");
    if (normalized.has(raw.role)) throw new Error(`duplicate ${raw.role} runtime reconciliation approval`);
    const signer = address(raw.signer, `${raw.role} runtime reconciliation signer`);
    if (!isHexString(raw.signature, 65)) throw new TypeError("runtime reconciliation signature must be 65 bytes");
    normalized.set(raw.role, Object.freeze({ role: raw.role, signer, signature: raw.signature }));
  }
  const domain = runtimeReconciliationDomain(inspected.candidate);
  const value = runtimeReconciliationMessage(record);
  for (const role of RUNTIME_APPROVAL_ROLES) {
    const expected = inspected.candidate.policy.approvers[role];
    const approval = normalized.get(role);
    if (expected.signatureKind !== "eip712" || approval.signer !== expected.address) {
      throw new Error(`${role} runtime reconciliation identity does not match release policy`);
    }
    let recovered;
    try {
      recovered = getAddress(verifyTypedData(domain, RUNTIME_RECONCILIATION_TYPES, value, approval.signature));
    } catch {
      throw new Error(`${role} runtime reconciliation signature is invalid`);
    }
    if (recovered !== expected.address) throw new Error(`${role} runtime reconciliation signature is invalid`);
  }
  return TypedDataEncoder.hash(domain, RUNTIME_RECONCILIATION_TYPES, value).toLowerCase();
}

function hexQuantity(value, name) {
  if (!HEX_QUANTITY.test(String(value ?? ""))) throw new TypeError(`${name} is not a canonical hex quantity`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe integer range`);
  return Number(parsed);
}

function rpcBlock(value, name) {
  if (!value || !BYTES32.test(String(value.hash ?? ""))
      || !HEX_QUANTITY.test(String(value.number ?? ""))
      || !HEX_QUANTITY.test(String(value.timestamp ?? ""))) {
    throw new TypeError(`${name} block is malformed`);
  }
  return Object.freeze({
    number: hexQuantity(value.number, `${name} block number`),
    hash: String(value.hash).toLowerCase(),
    timestamp: hexQuantity(value.timestamp, `${name} block timestamp`),
  });
}

function blockTag(value) {
  return `0x${value.toString(16)}`;
}

async function bounded(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("release runtime provider timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function call(rpcCall, contractInterface, target, method, args, anchor) {
  const response = await rpcCall("eth_call", [{
    to: target,
    data: contractInterface.encodeFunctionData(method, args),
  }, anchor]);
  if (!isHexString(response)) throw new TypeError(`${method} returned malformed data`);
  try {
    return contractInterface.decodeFunctionResult(method, response);
  } catch {
    throw new TypeError(`${method} returned malformed data`);
  }
}

function implementationAddress(word) {
  if (!isHexString(word, 32)) throw new TypeError("BIT implementation slot is malformed");
  return address(`0x${word.slice(-40)}`, "BIT implementation");
}

function codeHash(code, name) {
  if (!isHexString(code) || code === "0x") throw new TypeError(`${name} runtime is missing or malformed`);
  return keccak256(code).toLowerCase();
}

async function observeReleaseRuntimeHead({ provider, candidate, now, timeoutMs }) {
  return bounded(async () => {
    const chainId = await provider.rpcCall("eth_chainId", []);
    if (BigInt(chainId) !== BigInt(candidate.record.chainId)) {
      throw new Error("release runtime provider returned the wrong chain");
    }
    const head = rpcBlock(await provider.rpcCall("eth_getBlockByNumber", ["latest", false]), "release runtime head");
    if (head.timestamp > now
        || now - head.timestamp > candidate.policy.maximumRuntimeObservationAgeSeconds) {
      throw new Error("release runtime provider head is stale or from the future");
    }
    if (head.number < Number(candidate.record.approvalBlockNumber)) {
      throw new Error("release runtime provider head predates the approval anchor");
    }
    return head;
  }, timeoutMs);
}

async function observeReleaseRuntimeProvider({
  provider,
  candidate,
  manifest,
  expectedRiskDigest,
  mode,
  now,
  targetBlockNumber,
  timeoutMs,
}) {
  return bounded(async () => {
    const head = rpcBlock(
      await provider.rpcCall("eth_getBlockByNumber", [blockTag(targetBlockNumber), false]),
      "release runtime target",
    );
    if (head.number !== targetBlockNumber) throw new Error("release runtime provider returned the wrong target block");
    const maximumAge = candidate.policy.maximumRuntimeObservationAgeSeconds;
    if (head.timestamp > now || now - head.timestamp > maximumAge) {
      throw new Error("release runtime provider head is stale or from the future");
    }
    if (head.number < Number(candidate.record.approvalBlockNumber)) {
      throw new Error("release runtime provider head predates the approval anchor");
    }
    const anchor = Object.freeze({ blockHash: head.hash, requireCanonical: true });
    const gate = address(manifest.gate.address, "runtime gate");
    const registry = address(manifest.paymentHashRegistry.address, "runtime registry");
    const vault = address(manifest.vault.address, "runtime vault");
    const userEscrow = address(manifest.userEscrow.address, "runtime user escrow");
    const bitProxy = address(manifest.bit.proxyAddress, "runtime BIT proxy");
    const controller = address(manifest.controller.address, "runtime controller");
    const guardian = address(manifest.guardian.address, "runtime guardian");
    const feeCollector = address(manifest.feeCollector.address, "runtime fee collector");
    const expectedImplementation = address(manifest.bit.implementationAddress, "reviewed BIT implementation");
    const [controllerCode, guardianCode, feeCollectorCode, gateCode, registryCode, vaultCode, userEscrowCode,
      bitProxyCode, implementationWord, controllerOwnersResult, controllerThresholdResult,
      guardianOwnersResult, guardianThresholdResult, feeCollectorOwnersResult, feeCollectorThresholdResult,
      isOpenResult, emergencyResult, openUntilResult, activeRiskResult, sealedResult, escrowCountResult,
      vaultApprovedResult, userEscrowApprovedResult, vaultAvailableResult, vaultLockedResult,
      vaultAccountedResult, userEscrowLockedResult, vaultBitBalanceResult, userEscrowBitBalanceResult,
      pausedResult, decimalsResult, symbolResult] = await Promise.all([
      provider.rpcCall("eth_getCode", [controller, anchor]),
      provider.rpcCall("eth_getCode", [guardian, anchor]),
      provider.rpcCall("eth_getCode", [feeCollector, anchor]),
      provider.rpcCall("eth_getCode", [gate, anchor]),
      provider.rpcCall("eth_getCode", [registry, anchor]),
      provider.rpcCall("eth_getCode", [vault, anchor]),
      provider.rpcCall("eth_getCode", [userEscrow, anchor]),
      provider.rpcCall("eth_getCode", [bitProxy, anchor]),
      provider.rpcCall("eth_getStorageAt", [bitProxy, EIP1967_IMPLEMENTATION_SLOT, anchor]),
      call(provider.rpcCall, WALLET_INTERFACE, controller, "getOwners", [], anchor),
      call(provider.rpcCall, WALLET_INTERFACE, controller, "getThreshold", [], anchor),
      call(provider.rpcCall, WALLET_INTERFACE, guardian, "getOwners", [], anchor),
      call(provider.rpcCall, WALLET_INTERFACE, guardian, "getThreshold", [], anchor),
      call(provider.rpcCall, WALLET_INTERFACE, feeCollector, "getOwners", [], anchor),
      call(provider.rpcCall, WALLET_INTERFACE, feeCollector, "getThreshold", [], anchor),
      call(provider.rpcCall, GATE_INTERFACE, gate, "isOpen", [], anchor),
      call(provider.rpcCall, GATE_INTERFACE, gate, "emergencyHalted", [], anchor),
      call(provider.rpcCall, GATE_INTERFACE, gate, "openUntil", [], anchor),
      call(provider.rpcCall, GATE_INTERFACE, gate, "activeRiskDigest", [], anchor),
      call(provider.rpcCall, REGISTRY_INTERFACE, registry, "isSealed", [], anchor),
      call(provider.rpcCall, REGISTRY_INTERFACE, registry, "escrowCount", [], anchor),
      call(provider.rpcCall, REGISTRY_INTERFACE, registry, "approvedEscrow", [vault], anchor),
      call(provider.rpcCall, REGISTRY_INTERFACE, registry, "approvedEscrow", [userEscrow], anchor),
      call(provider.rpcCall, VAULT_INTERFACE, vault, "totalAvailable", [], anchor),
      call(provider.rpcCall, VAULT_INTERFACE, vault, "totalLocked", [], anchor),
      call(provider.rpcCall, VAULT_INTERFACE, vault, "accountedBalance", [], anchor),
      call(provider.rpcCall, USER_ESCROW_INTERFACE, userEscrow, "totalLocked", [], anchor),
      call(provider.rpcCall, BIT_INTERFACE, bitProxy, "balanceOf", [vault], anchor),
      call(provider.rpcCall, BIT_INTERFACE, bitProxy, "balanceOf", [userEscrow], anchor),
      call(provider.rpcCall, BIT_INTERFACE, bitProxy, "paused", [], anchor),
      call(provider.rpcCall, BIT_INTERFACE, bitProxy, "decimals", [], anchor),
      call(provider.rpcCall, BIT_INTERFACE, bitProxy, "symbol", [], anchor),
    ]);
    const implementation = implementationAddress(implementationWord);
    if (implementation !== expectedImplementation) throw new Error("BIT implementation changed after release review");
    const implementationCode = await provider.rpcCall("eth_getCode", [implementation, anchor]);
    for (const [actual, expected, name] of [
      [codeHash(controllerCode, "controller"), manifest.controller.codeHash, "controller"],
      [codeHash(guardianCode, "guardian"), manifest.guardian.codeHash, "guardian"],
      [codeHash(feeCollectorCode, "fee collector"), manifest.feeCollector.codeHash, "fee collector"],
      [codeHash(gateCode, "gate"), manifest.gate.codeHash, "gate"],
      [codeHash(registryCode, "registry"), manifest.paymentHashRegistry.codeHash, "registry"],
      [codeHash(vaultCode, "vault"), manifest.vault.codeHash, "vault"],
      [codeHash(userEscrowCode, "user escrow"), manifest.userEscrow.codeHash, "user escrow"],
      [codeHash(bitProxyCode, "BIT proxy"), manifest.bit.proxyCodeHash, "BIT proxy"],
      [codeHash(implementationCode, "BIT implementation"), manifest.bit.implementationCodeHash, "BIT implementation"],
    ]) {
      if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
        throw new Error(`${name} runtime changed after release review`);
      }
    }
    for (const [name, ownersResult, thresholdResult, reviewed] of [
      ["controller", controllerOwnersResult, controllerThresholdResult, manifest.controller],
      ["guardian", guardianOwnersResult, guardianThresholdResult, manifest.guardian],
      ["fee collector", feeCollectorOwnersResult, feeCollectorThresholdResult, manifest.feeCollector],
    ]) {
      const owners = [...ownersResult[0]].map((value) => address(value, `${name} owner`)).sort();
      const expectedOwners = [...reviewed.ownerAddresses].map((value) => address(value, `${name} reviewed owner`)).sort();
      if (JSON.stringify(owners) !== JSON.stringify(expectedOwners)
          || safeNumber(thresholdResult[0], `${name} threshold`) !== reviewed.threshold) {
        throw new Error(`${name} ownership changed after release review`);
      }
    }
    const observation = Object.freeze({
      chainId: candidate.record.chainId,
      blockNumber: head.number,
      blockHash: head.hash,
      blockTimestamp: head.timestamp,
      gateOpen: Boolean(isOpenResult[0]),
      emergencyHalted: Boolean(emergencyResult[0]),
      openUntil: safeNumber(openUntilResult[0], "runtime gate open-until"),
      activeRiskDigest: String(activeRiskResult[0]).toLowerCase(),
      registrySealed: Boolean(sealedResult[0]),
      registryEscrowCount: safeNumber(escrowCountResult[0], "runtime registry escrow count"),
      vaultApproved: Boolean(vaultApprovedResult[0]),
      userEscrowApproved: Boolean(userEscrowApprovedResult[0]),
      vaultTotalAvailableWei: BigInt(vaultAvailableResult[0]).toString(),
      vaultTotalLockedWei: BigInt(vaultLockedResult[0]).toString(),
      vaultAccountedBalanceWei: BigInt(vaultAccountedResult[0]).toString(),
      vaultBitBalanceWei: BigInt(vaultBitBalanceResult[0]).toString(),
      userEscrowTotalLockedWei: BigInt(userEscrowLockedResult[0]).toString(),
      userEscrowBitBalanceWei: BigInt(userEscrowBitBalanceResult[0]).toString(),
      bitPaused: Boolean(pausedResult[0]),
      bitDecimals: safeNumber(decimalsResult[0], "runtime BIT decimals"),
      bitSymbol: String(symbolResult[0]),
      implementation,
    });
    if (mode === "funding") {
      if (!observation.gateOpen || observation.emergencyHalted
          || observation.openUntil <= now || observation.openUntil > candidate.record.validUntil
          || observation.activeRiskDigest !== expectedRiskDigest) {
        throw new Error("release-bound open gate is not active within the signed release window");
      }
    } else if (mode === "recovery") {
      if (observation.gateOpen && (
        observation.emergencyHalted
          || observation.openUntil <= now
          || observation.activeRiskDigest !== expectedRiskDigest
      )) {
        throw new Error("an open recovery gate is not bound to the reviewed release");
      }
    } else {
      throw new Error("release runtime observation mode is invalid");
    }
    if (!observation.registrySealed || observation.registryEscrowCount !== 2
        || !observation.vaultApproved || !observation.userEscrowApproved) {
      throw new Error("payment-hash registry is not sealed to both reviewed escrows");
    }
    if ((mode === "funding" && observation.bitPaused)
        || observation.bitDecimals !== manifest.bit.decimals
        || observation.bitSymbol !== manifest.bit.symbol) {
      throw new Error("BIT token state changed after release review");
    }
    const available = BigInt(observation.vaultTotalAvailableWei);
    const vaultLocked = BigInt(observation.vaultTotalLockedWei);
    const accounted = BigInt(observation.vaultAccountedBalanceWei);
    const vaultBalance = BigInt(observation.vaultBitBalanceWei);
    const userLocked = BigInt(observation.userEscrowTotalLockedWei);
    const userBalance = BigInt(observation.userEscrowBitBalanceWei);
    if (available + vaultLocked !== accounted || accounted !== vaultBalance || userLocked !== userBalance) {
      throw new Error("live BIT balances do not reconcile to contract accounting");
    }
    if (mode === "funding") {
      if (available < BigInt(candidate.record.limits.minBitReserveWei)) {
        throw new Error("live BIT reserve is below the signed release minimum");
      }
      const maximumLockedWei = BigInt(candidate.record.limits.maxInFlightSats) * 10n ** 18n / 100n;
      if (vaultLocked + userLocked > maximumLockedWei) {
        throw new Error("live BIT in-flight inventory exceeds the signed release cap");
      }
    }
    return observation;
  }, timeoutMs);
}

async function observeReleaseRuntime({
  providerSet,
  candidate,
  manifest,
  expectedRiskDigest,
  mode = "funding",
  now,
  timeoutMs,
}) {
  const heads = await Promise.all(providerSet.providers.map((provider) => observeReleaseRuntimeHead({
    provider,
    candidate,
    now,
    timeoutMs,
  })));
  const targetBlockNumber = Math.min(...heads.map((head) => head.number));
  const observations = await Promise.all(providerSet.providers.map((provider) => observeReleaseRuntimeProvider({
    provider,
    candidate,
    manifest,
    expectedRiskDigest,
    mode,
    now,
    targetBlockNumber,
    timeoutMs,
  })));
  const expected = JSON.stringify(canonical(observations[0]));
  if (observations.some((observation) => JSON.stringify(canonical(observation)) !== expected)) {
    throw new Error("release runtime providers disagree");
  }
  return Object.freeze({ observation: observations[0], consensusDigest: hash(observations) });
}

function exactRuntimeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join("|");
  return keys === [
    "balancesReconciled",
    "deploymentManifestDigest",
    "deploymentPostflightDigest",
    "deploymentPromotionDigest",
    "gateOpen",
    "observedAt",
    "openGateRiskDigest",
    "reconciliationDigest",
    "releasePolicyDigest",
    "releaseRecordDigest",
  ].sort().join("|");
}

export async function activatePublicTestnetRelease({
  candidate,
  approvalBundle,
  providerSet: providerSetInput,
  reconciliation: reconciliationInput,
  reconciliationApprovals,
  now = Math.floor(Date.now() / 1_000),
  timeoutMs = 10_000,
}) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError("release activation time is invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new RangeError("release activation provider timeout is outside policy");
  }
  const runtimeBinding = verifiedPublicTestnetReleaseCandidateRuntimeBinding(candidate);
  const inspected = inspectPreparedPublicTestnetReleaseCandidate(candidate);
  const providerSet = verifiedPublicTestnetReleaseApprovalProviderSet(providerSetInput);
  if (providerSet.providerCount !== inspected.candidate.record.counts.independentEvmProviders
      || providerSet.providerSetDigest !== inspected.candidate.record.approvalProviderSetDigest) {
    throw new Error("release activation provider set does not match the evidence-backed candidate");
  }
  const receipt = await verifyPublicTestnetReleaseApprovals({
    candidate,
    approvalBundle,
    providers: providerSet.providers,
    now,
  });
  const verification = verifiedPublicTestnetReleaseApprovalVerification(receipt);
  const capabilities = activateReleaseCapabilities({ verification, now });
  const reconciliation = normalizeRuntimeReconciliation(reconciliationInput, inspected);
  if (now < reconciliation.observedAt || now > reconciliation.validUntil) {
    throw new Error("runtime reconciliation is not currently active");
  }
  const reconciliationDigest = verifyRuntimeReconciliationApprovals({
    inspected,
    record: reconciliation,
    approvals: reconciliationApprovals,
  });
  const expectedRiskDigest = publicTestnetReleaseOpenRiskDigest(candidate);
  const runtime = await observeReleaseRuntime({
    providerSet,
    candidate: inspected.candidate,
    manifest: runtimeBinding.manifest,
    expectedRiskDigest,
    now,
    timeoutMs,
  });
  const snapshot = Object.freeze({
    releaseRecordDigest: inspected.recordDigest,
    releasePolicyDigest: inspected.policyDigest,
    deploymentManifestDigest: runtimeBinding.deploymentManifestDigest,
    deploymentPostflightDigest: runtimeBinding.deploymentPostflightDigest,
    deploymentPromotionDigest: runtimeBinding.deploymentPromotionDigest,
    gateOpen: true,
    openGateRiskDigest: expectedRiskDigest,
    balancesReconciled: true,
    reconciliationDigest,
    observedAt: now,
  });
  const activationValidUntil = Math.min(inspected.candidate.record.validUntil, reconciliation.validUntil);
  const liveness = { active: true };
  verifiedRuntimeSnapshots.set(snapshot, Object.freeze({
    capabilities,
    liveness,
    validUntil: activationValidUntil,
    chainId: inspected.candidate.record.chainId,
    daemonEvidenceApprovers: Object.freeze(Object.fromEntries(
      RUNTIME_APPROVAL_ROLES.map((role) => [role, inspected.candidate.policy.approvers[role].address.toLowerCase()]),
    )),
    solverContracts: Object.freeze({
      "lightning-to-bit": Object.freeze({
        address: address(runtimeBinding.manifest.vault.address, "runtime Lightning-to-BIT escrow").toLowerCase(),
        codeHash: digest(runtimeBinding.manifest.vault.codeHash, "runtime Lightning-to-BIT escrow code hash"),
      }),
      "bit-to-lightning": Object.freeze({
        address: address(runtimeBinding.manifest.userEscrow.address, "runtime BIT-to-Lightning escrow").toLowerCase(),
        codeHash: digest(runtimeBinding.manifest.userEscrow.codeHash, "runtime BIT-to-Lightning escrow code hash"),
      }),
    }),
  }));
  const activation = Object.freeze({
    schema: "treeswap.active-public-testnet-release.v1",
    status: "same-process-release-and-runtime-verification-active",
    releaseId: inspected.candidate.record.releaseId,
    fundingMode: inspected.candidate.record.fundingMode,
    validUntil: activationValidUntil,
    runtimeBlockNumber: runtime.observation.blockNumber,
    runtimeBlockHash: runtime.observation.blockHash,
    providerConsensusDigest: runtime.consensusDigest,
    receipt,
    capabilities,
    deployment: snapshot,
  });
  activePublicTestnetReleaseActivations.set(activation, liveness);
  return activation;
}

export async function activatePublicTestnetRecovery({
  candidate,
  approvalBundle,
  providerSet: providerSetInput,
  now = Math.floor(Date.now() / 1_000),
  timeoutMs = 10_000,
}) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError("recovery activation time is invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new RangeError("recovery activation provider timeout is outside policy");
  }
  const runtimeBinding = verifiedPublicTestnetReleaseCandidateRuntimeBinding(candidate);
  const inspected = inspectPreparedPublicTestnetReleaseCandidate(candidate);
  if (now < inspected.candidate.record.approvalBlockTimestamp) {
    throw new Error("recovery activation predates the reviewed release approval anchor");
  }
  const providerSet = verifiedPublicTestnetReleaseApprovalProviderSet(providerSetInput);
  if (providerSet.providerCount !== inspected.candidate.record.counts.independentEvmProviders
      || providerSet.providerSetDigest !== inspected.candidate.record.approvalProviderSetDigest) {
    throw new Error("recovery activation provider set does not match the evidence-backed candidate");
  }
  const approvalVerificationAt = Math.min(now, inspected.candidate.record.validUntil);
  const receipt = await verifyPublicTestnetReleaseApprovals({
    candidate,
    approvalBundle,
    providers: providerSet.providers,
    now: approvalVerificationAt,
  });
  verifiedPublicTestnetReleaseApprovalVerification(receipt);
  const expectedRiskDigest = publicTestnetReleaseOpenRiskDigest(candidate);
  const runtime = await observeReleaseRuntime({
    providerSet,
    candidate: inspected.candidate,
    manifest: runtimeBinding.manifest,
    expectedRiskDigest,
    mode: "recovery",
    now,
    timeoutMs,
  });
  const validUntil = runtime.observation.blockTimestamp
    + inspected.candidate.policy.maximumRuntimeObservationAgeSeconds;
  if (validUntil < now) throw new Error("recovery runtime observation is already stale");
  const snapshot = Object.freeze({
    schema: "treeswap.public-testnet-recovery-runtime.v1",
    releaseRecordDigest: inspected.recordDigest,
    releasePolicyDigest: inspected.policyDigest,
    deploymentManifestDigest: runtimeBinding.deploymentManifestDigest,
    deploymentPostflightDigest: runtimeBinding.deploymentPostflightDigest,
    deploymentPromotionDigest: runtimeBinding.deploymentPromotionDigest,
    gateOpen: runtime.observation.gateOpen,
    emergencyHalted: runtime.observation.emergencyHalted,
    bitPaused: runtime.observation.bitPaused,
    balancesReconciled: true,
    observedAt: now,
    validUntil,
  });
  const liveness = { active: true };
  verifiedRecoveryRuntimeSnapshots.set(snapshot, Object.freeze({
    liveness,
    validUntil,
    maximumRuntimeObservationAgeSeconds: inspected.candidate.policy.maximumRuntimeObservationAgeSeconds,
    chainId: inspected.candidate.record.chainId,
    daemonEvidenceApprovers: Object.freeze(Object.fromEntries(
      RUNTIME_APPROVAL_ROLES.map((role) => [role, inspected.candidate.policy.approvers[role].address.toLowerCase()]),
    )),
    solverContracts: Object.freeze({
      "lightning-to-bit": Object.freeze({
        address: address(runtimeBinding.manifest.vault.address, "recovery Lightning-to-BIT escrow").toLowerCase(),
        codeHash: digest(runtimeBinding.manifest.vault.codeHash, "recovery Lightning-to-BIT escrow code hash"),
      }),
      "bit-to-lightning": Object.freeze({
        address: address(runtimeBinding.manifest.userEscrow.address, "recovery BIT-to-Lightning escrow").toLowerCase(),
        codeHash: digest(runtimeBinding.manifest.userEscrow.codeHash, "recovery BIT-to-Lightning escrow code hash"),
      }),
    }),
  }));
  const activation = Object.freeze({
    schema: "treeswap.active-public-testnet-recovery.v1",
    status: "same-process-recovery-only-runtime-verification-active",
    scope: "existing-settlement-recovery-only-no-lightning-dispatch-new-exposure-or-funding-authority",
    releaseId: inspected.candidate.record.releaseId,
    validUntil,
    runtimeBlockNumber: runtime.observation.blockNumber,
    runtimeBlockHash: runtime.observation.blockHash,
    providerConsensusDigest: runtime.consensusDigest,
    receipt,
    deployment: snapshot,
    authorizations: Object.freeze({
      funding: false,
      newExposure: false,
      lightningDispatch: false,
    }),
  });
  activePublicTestnetRecoveryActivations.set(activation, liveness);
  return activation;
}

export function deactivatePublicTestnetRelease(activation) {
  const liveness = activePublicTestnetReleaseActivations.get(activation);
  if (!liveness) {
    throw new TypeError("public-testnet release activation is not backed by this process");
  }
  if (liveness.active !== true) return false;
  liveness.active = false;
  return true;
}

export function isPublicTestnetReleaseActive(activation) {
  return activePublicTestnetReleaseActivations.get(activation)?.active === true;
}

export function deactivatePublicTestnetRecovery(activation) {
  const liveness = activePublicTestnetRecoveryActivations.get(activation);
  if (!liveness) {
    throw new TypeError("public-testnet recovery activation is not backed by this process");
  }
  if (liveness.active !== true) return false;
  liveness.active = false;
  return true;
}

export function isPublicTestnetRecoveryActive(activation) {
  return activePublicTestnetRecoveryActivations.get(activation)?.active === true;
}

export function authorizeSolverFunding({
  solverCapabilityVerification,
  deployment,
  capabilities = V1_CAPABILITIES,
  now = Math.floor(Date.now() / 1_000),
}) {
  const reasons = [];
  let release = null;
  let solver = null;
  let solverCapacity = null;
  if (capabilities === V1_CAPABILITIES) {
    reasons.push("web solver funding is disabled");
  } else {
    try {
      release = verifiedReleaseCapabilityBinding(capabilities);
    } catch {
      reasons.push("a cryptographically verified release capability is required");
    }
  }
  try {
    solver = verifiedSolverQuoteBinding(solverCapabilityVerification);
    solverCapacity = verifiedSolverCapacityRecord(solverCapabilityVerification);
  } catch {
    reasons.push("a locally verified solver capability is required");
  }
  if (!Number.isSafeInteger(now) || now <= 0) reasons.push("authorization time is invalid");
  if (solver && Number.isSafeInteger(now) && now >= solver.expiresAt) {
    reasons.push("solver capability is expired");
  }
  if (!release) {
    reasons.push("reviewed deployment evidence is required");
  } else {
    if (now < release.validFrom || now > release.validUntil) reasons.push("release authorization is not active");
    if (!exactRuntimeSnapshot(deployment)) {
      reasons.push("an exact runtime deployment snapshot is required");
    } else {
      const runtimeActivation = verifiedRuntimeSnapshots.get(deployment);
      if (runtimeActivation?.capabilities !== capabilities) {
        reasons.push("a same-process live runtime activation snapshot is required");
      } else if (runtimeActivation.liveness?.active !== true) {
        reasons.push("same-process live release activation is inactive");
      } else if (now > runtimeActivation.validUntil) {
        reasons.push("runtime reconciliation is expired");
      }
      if (deployment.releaseRecordDigest !== release.releaseRecordDigest
          || deployment.releasePolicyDigest !== release.releasePolicyDigest
          || deployment.deploymentManifestDigest !== release.deploymentManifestDigest
          || deployment.deploymentPostflightDigest !== release.deploymentPostflightDigest
          || deployment.deploymentPromotionDigest !== release.deploymentPromotionDigest) {
        reasons.push("runtime deployment is not bound to the authorized release");
      }
      if (!Number.isSafeInteger(deployment.observedAt) || deployment.observedAt > now
          || now - deployment.observedAt > release.maximumRuntimeObservationAgeSeconds) {
        reasons.push("runtime deployment observation is stale or invalid");
      }
      if (deployment.gateOpen !== true || deployment.balancesReconciled !== true
          || !NONZERO_BYTES32.test(String(deployment.openGateRiskDigest ?? ""))
          || !NONZERO_BYTES32.test(String(deployment.reconciliationDigest ?? ""))) {
        reasons.push("risk gate and reconciled balances are required");
      }
      if (solver && runtimeActivation) {
        const expectedContract = runtimeActivation.solverContracts[solver.direction];
        if (!expectedContract
            || solver.chainId !== runtimeActivation.chainId
            || solver.settlementContract !== expectedContract.address
            || solver.settlementContractCodeHash !== expectedContract.codeHash) {
          reasons.push("solver capability is not bound to the active release escrow");
        }
        if (!solverCapacity
            || solverCapacity.capabilityDigest !== solver.capabilityDigest
            || solverCapacity.solverId !== solver.solverId
            || solverCapacity.capabilityExpiresAt !== solver.expiresAt
            || solverCapacity.capacityEpoch !== solver.capacityEpoch
            || solverCapacity.availableBitWei !== solver.availableBitWei
            || solverCapacity.availableLightningSats !== solver.availableLightningSats
            || solverCapacity.observedAt > now
            || now - solverCapacity.observedAt > release.maximumRuntimeObservationAgeSeconds) {
          reasons.push("solver capacity observation is stale or invalid");
        }
      }
    }
  }
  return Object.freeze({ allowed: reasons.length === 0, reasons });
}

function normalizeSolverDaemonPolicyBinding(input) {
  const snapshot = structuredClone(input);
  const policyDigest = solverDaemonEvidencePolicyDigest(snapshot);
  return Object.freeze({
    policyDigest,
    releaseRecordDigest: digest(snapshot.releaseRecordDigest, "solver daemon release record digest"),
    chainId: decimal(snapshot.chainId, "solver daemon chainId"),
    settlementContract: address(snapshot.settlementContract, "solver daemon settlement contract").toLowerCase(),
    settlementContractCodeHash: digest(
      snapshot.settlementContractCodeHash,
      "solver daemon settlement contract code hash",
    ),
    solver: address(snapshot.solver, "solver daemon solver").toLowerCase(),
    direction: String(snapshot.direction ?? ""),
    approvers: Object.freeze(Object.fromEntries(RUNTIME_APPROVAL_ROLES.map((role) => [
      role,
      address(snapshot.approvers?.[role], `solver daemon ${role}`).toLowerCase(),
    ]))),
    maxClockSkewSeconds: snapshot.maxClockSkewSeconds,
    maxEvidenceAgeSeconds: snapshot.maxEvidenceAgeSeconds,
    maxEvidenceLifetimeSeconds: snapshot.maxEvidenceLifetimeSeconds,
  });
}

export function createActiveSolverDaemonContext({
  solverCapabilityVerification,
  deployment,
  capabilities,
  evidencePolicy,
  now = Math.floor(Date.now() / 1_000),
}) {
  const decision = authorizeSolverFunding({
    solverCapabilityVerification,
    deployment,
    capabilities,
    now,
  });
  if (!decision.allowed) {
    throw new Error(`active solver daemon context is not authorized: ${decision.reasons.join("; ")}`);
  }
  const release = verifiedReleaseCapabilityBinding(capabilities);
  const solver = verifiedSolverQuoteBinding(solverCapabilityVerification);
  const runtime = verifiedRuntimeSnapshots.get(deployment);
  const policy = normalizeSolverDaemonPolicyBinding(evidencePolicy);
  const expectedContract = runtime?.solverContracts?.[solver.direction];
  if (!runtime || runtime.capabilities !== capabilities || !expectedContract) {
    throw new Error("active solver daemon context is missing same-process runtime provenance");
  }
  if (policy.releaseRecordDigest !== release.releaseRecordDigest
      || policy.chainId !== runtime.chainId
      || policy.settlementContract !== expectedContract.address
      || policy.settlementContractCodeHash !== expectedContract.codeHash
      || policy.settlementContract !== solver.settlementContract
      || policy.settlementContractCodeHash !== solver.settlementContractCodeHash
      || policy.solver !== solver.solverId
      || policy.direction !== solver.direction) {
    throw new Error("solver daemon evidence policy is not bound to the active release and solver");
  }
  for (const role of RUNTIME_APPROVAL_ROLES) {
    if (policy.approvers[role] !== runtime.daemonEvidenceApprovers[role]) {
      throw new Error("solver daemon evidence approvers do not match the active release policy");
    }
  }
  if (policy.maxClockSkewSeconds > release.maximumRuntimeObservationAgeSeconds
      || policy.maxEvidenceAgeSeconds > release.maximumRuntimeObservationAgeSeconds
      || policy.maxEvidenceLifetimeSeconds > release.maximumRuntimeObservationAgeSeconds) {
    throw new Error("solver daemon evidence freshness exceeds the active release policy");
  }
  const context = Object.freeze({
    schema: "treeswap.active-solver-daemon-context.v1",
    status: "same-process-release-solver-and-evidence-policy-bound",
    releaseRecordDigest: release.releaseRecordDigest,
    solverCapabilityDigest: solver.capabilityDigest,
    evidencePolicyDigest: policy.policyDigest,
    direction: solver.direction,
    settlementContract: expectedContract.address,
    createdAt: now,
  });
  activeSolverDaemonContexts.set(context, Object.freeze({
    boundAt: now,
    capacityEpoch: solver.capacityEpoch,
    capabilities,
    deployment,
    direction: solver.direction,
    evidencePolicyDigest: policy.policyDigest,
    releaseRecordDigest: release.releaseRecordDigest,
    solverCapabilityDigest: solver.capabilityDigest,
    solverCapabilityVerification,
    solverId: solver.solverId,
  }));
  return context;
}

export function createRecoverySolverDaemonContext({
  solverCapabilityVerification,
  deployment,
  evidencePolicy,
  now = Math.floor(Date.now() / 1_000),
}) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError("recovery daemon context time is invalid");
  const runtime = verifiedRecoveryRuntimeSnapshots.get(deployment);
  if (!runtime || runtime.liveness.active !== true || now > runtime.validUntil) {
    throw new Error("recovery daemon context requires a fresh same-process recovery activation");
  }
  const solver = verifiedSolverQuoteBinding(solverCapabilityVerification);
  const capacity = verifiedSolverCapacityRecord(solverCapabilityVerification);
  if (now >= solver.expiresAt
      || capacity.observedAt > now
      || now - capacity.observedAt > runtime.maximumRuntimeObservationAgeSeconds) {
    throw new Error("recovery daemon solver identity proof is stale or expired");
  }
  const policy = normalizeSolverDaemonPolicyBinding(evidencePolicy);
  const expectedContract = runtime.solverContracts[solver.direction];
  if (!expectedContract
      || solver.chainId !== runtime.chainId
      || solver.settlementContract !== expectedContract.address
      || solver.settlementContractCodeHash !== expectedContract.codeHash
      || policy.releaseRecordDigest !== deployment.releaseRecordDigest
      || policy.chainId !== runtime.chainId
      || policy.settlementContract !== expectedContract.address
      || policy.settlementContractCodeHash !== expectedContract.codeHash
      || policy.solver !== solver.solverId
      || policy.direction !== solver.direction) {
    throw new Error("recovery daemon evidence policy and solver are not bound to the reviewed release escrow");
  }
  for (const role of RUNTIME_APPROVAL_ROLES) {
    if (policy.approvers[role] !== runtime.daemonEvidenceApprovers[role]) {
      throw new Error("recovery daemon evidence approvers do not match the reviewed release policy");
    }
  }
  if (policy.maxClockSkewSeconds > runtime.maximumRuntimeObservationAgeSeconds
      || policy.maxEvidenceAgeSeconds > runtime.maximumRuntimeObservationAgeSeconds
      || policy.maxEvidenceLifetimeSeconds > runtime.maximumRuntimeObservationAgeSeconds) {
    throw new Error("recovery daemon evidence freshness exceeds the reviewed release policy");
  }
  const context = Object.freeze({
    schema: "treeswap.recovery-solver-daemon-context.v1",
    status: "same-process-recovery-only-solver-and-evidence-policy-bound",
    scope: "existing-settlement-recovery-only-no-lightning-dispatch-new-exposure-or-funding-authority",
    releaseRecordDigest: deployment.releaseRecordDigest,
    solverCapabilityDigest: solver.capabilityDigest,
    evidencePolicyDigest: policy.policyDigest,
    direction: solver.direction,
    settlementContract: expectedContract.address,
    createdAt: now,
    authorizations: Object.freeze({ funding: false, lightningDispatch: false, newExposure: false }),
  });
  recoverySolverDaemonContexts.set(context, Object.freeze({
    boundAt: now,
    capacityEpoch: solver.capacityEpoch,
    direction: solver.direction,
    evidencePolicyDigest: policy.policyDigest,
    evmClaimWorkAllowed: deployment.bitPaused === false,
    releaseRecordDigest: deployment.releaseRecordDigest,
    runtime,
    solverCapabilityDigest: solver.capabilityDigest,
    solverId: solver.solverId,
  }));
  return context;
}

export function verifiedActiveSolverDaemonContext(context, {
  now = Math.floor(Date.now() / 1_000),
  requireFundingAuthorization = true,
} = {}) {
  const binding = activeSolverDaemonContexts.get(context);
  if (!binding) throw new TypeError("solver daemon context is not backed by same-process release activation");
  if (!Number.isSafeInteger(now) || now <= 0 || now < binding.boundAt) {
    throw new TypeError("solver daemon context use time is invalid");
  }
  if (requireFundingAuthorization) {
    const decision = authorizeSolverFunding({
      solverCapabilityVerification: binding.solverCapabilityVerification,
      deployment: binding.deployment,
      capabilities: binding.capabilities,
      now,
    });
    if (!decision.allowed) {
      throw new Error(`solver daemon funding authorization is inactive: ${decision.reasons.join("; ")}`);
    }
  }
  return Object.freeze({
    capacityEpoch: binding.capacityEpoch,
    direction: binding.direction,
    evidencePolicyDigest: binding.evidencePolicyDigest,
    releaseRecordDigest: binding.releaseRecordDigest,
    solverCapabilityDigest: binding.solverCapabilityDigest,
    solverId: binding.solverId,
  });
}

export function verifiedRecoverySolverDaemonContext(context, {
  now = Math.floor(Date.now() / 1_000),
  requireActive = true,
} = {}) {
  const binding = recoverySolverDaemonContexts.get(context);
  if (!binding) throw new TypeError("recovery daemon context is not backed by same-process recovery activation");
  if (!Number.isSafeInteger(now) || now <= 0 || now < binding.boundAt) {
    throw new TypeError("recovery daemon context use time is invalid");
  }
  if (requireActive && (binding.runtime.liveness.active !== true || now > binding.runtime.validUntil)) {
    throw new Error("recovery daemon authorization is inactive or stale");
  }
  return Object.freeze({
    capacityEpoch: binding.capacityEpoch,
    direction: binding.direction,
    evidencePolicyDigest: binding.evidencePolicyDigest,
    evmClaimWorkAllowed: binding.evmClaimWorkAllowed,
    releaseRecordDigest: binding.releaseRecordDigest,
    solverCapabilityDigest: binding.solverCapabilityDigest,
    solverId: binding.solverId,
  });
}
