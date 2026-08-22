import {
  Interface,
  getAddress,
  isHexString,
  keccak256,
} from "ethers";
import {
  BIT_MAINNET_CONTRACT,
  compareBitDeploymentObservations,
  observeBitDeployment,
} from "./bit-deployment-observer.mjs";

const BIT_VAULT_INTERFACE = new Interface([
  "function BIT() view returns (address)",
  "function availableBalance(address solver) view returns (uint256)",
  "function totalAvailable() view returns (uint256)",
  "function totalLocked() view returns (uint256)",
  "function accountedBalance() view returns (uint256)",
]);
const BIT_INTERFACE = new Interface(["function balanceOf(address account) view returns (uint256)"]);
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function uint(value, name, maximum) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > maximum || String(value) !== parsed.toString()) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function address(value, name) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function direction(value) {
  const raw = String(value ?? "");
  if (!DIRECTIONS.has(raw)) throw new RangeError("capacity direction is unsupported");
  return raw;
}

function decodeCall(iface, functionName, value) {
  if (!isHexString(value)) throw new TypeError(`${functionName} returned malformed data`);
  try {
    return iface.decodeFunctionResult(functionName, value)[0];
  } catch {
    throw new TypeError(`${functionName} returned undecodable data`);
  }
}

function finalizedNumber(block) {
  if (!block || !HEX_QUANTITY.test(String(block.number ?? ""))) {
    throw new TypeError("RPC did not return a canonical finalized block number");
  }
  const parsed = BigInt(block.number);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("finalized block number exceeds the safe range");
  return Number(parsed);
}

function withDeadline(operation, timeoutMs, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

function normalizeProvider(value, position) {
  exactKeys(value, ["identity", "label", "rpcCall"], `${position} BIT RPC provider`);
  const label = String(value.label ?? "");
  if (label.length === 0 || label.length > 80) throw new TypeError(`${position} BIT RPC provider label is invalid`);
  const identity = bytes32(value.identity, `${position} BIT RPC provider identity`);
  if (identity === `0x${"00".repeat(32)}`) throw new TypeError(`${position} BIT RPC provider identity must be nonzero`);
  if (typeof value.rpcCall !== "function") throw new TypeError(`${position} BIT RPC provider call is invalid`);
  return Object.freeze({ identity, label, rpcCall: value.rpcCall });
}

function normalizeBitReaderRequest(raw) {
  exactKeys(raw, ["capabilityDigest", "direction", "solverId", "verifyingContract"], "BIT inventory request");
  return Object.freeze({
    capabilityDigest: bytes32(raw.capabilityDigest, "BIT capability digest"),
    direction: direction(raw.direction),
    solverId: address(raw.solverId, "BIT solver"),
    verifyingContract: address(raw.verifyingContract, "BIT verifying contract"),
  });
}

async function observeVaultProvider({ provider, targetBlockNumber, expectedVault, expectedVaultCodeHash, solverId,
  sourceCommit, observedAt, expectedBitProxyCodeHash, expectedBitImplementationAddress,
  expectedBitImplementationCodeHash }) {
  const deployment = await observeBitDeployment({
    rpcCall: provider.rpcCall,
    providerLabel: provider.label,
    providerIdentity: provider.identity,
    sourceCommit,
    targetBlockNumber,
    observedAt,
  });
  const anchor = deployment.stateAnchor;
  if (deployment.proxy.codeHash !== expectedBitProxyCodeHash
      || deployment.implementation.address.toLowerCase() !== expectedBitImplementationAddress
      || deployment.implementation.codeHash !== expectedBitImplementationCodeHash) {
    throw new Error("BIT proxy or implementation is not the reviewed deployment");
  }
  const [vaultCode, bitResult, availableResult, totalAvailableResult, totalLockedResult, accountedResult,
    tokenBalanceResult] = await Promise.all([
    provider.rpcCall("eth_getCode", [expectedVault, anchor]),
    provider.rpcCall("eth_call", [{
      to: expectedVault,
      data: BIT_VAULT_INTERFACE.encodeFunctionData("BIT"),
    }, anchor]),
    provider.rpcCall("eth_call", [{
      to: expectedVault,
      data: BIT_VAULT_INTERFACE.encodeFunctionData("availableBalance", [solverId]),
    }, anchor]),
    provider.rpcCall("eth_call", [{
      to: expectedVault,
      data: BIT_VAULT_INTERFACE.encodeFunctionData("totalAvailable"),
    }, anchor]),
    provider.rpcCall("eth_call", [{
      to: expectedVault,
      data: BIT_VAULT_INTERFACE.encodeFunctionData("totalLocked"),
    }, anchor]),
    provider.rpcCall("eth_call", [{
      to: expectedVault,
      data: BIT_VAULT_INTERFACE.encodeFunctionData("accountedBalance"),
    }, anchor]),
    provider.rpcCall("eth_call", [{
      to: BIT_MAINNET_CONTRACT,
      data: BIT_INTERFACE.encodeFunctionData("balanceOf", [expectedVault]),
    }, anchor]),
  ]);
  if (!isHexString(vaultCode) || vaultCode === "0x" || keccak256(vaultCode) !== expectedVaultCodeHash) {
    throw new Error("BIT vault runtime code is not the reviewed deployment");
  }
  const bit = address(decodeCall(BIT_VAULT_INTERFACE, "BIT", bitResult), "vault BIT token");
  if (bit !== BIT_MAINNET_CONTRACT.toLowerCase()) throw new Error("BIT vault token is not the reviewed BIT proxy");
  const available = decodeCall(BIT_VAULT_INTERFACE, "availableBalance", availableResult);
  const totalAvailable = decodeCall(BIT_VAULT_INTERFACE, "totalAvailable", totalAvailableResult);
  const totalLocked = decodeCall(BIT_VAULT_INTERFACE, "totalLocked", totalLockedResult);
  const accounted = decodeCall(BIT_VAULT_INTERFACE, "accountedBalance", accountedResult);
  const tokenBalance = decodeCall(BIT_INTERFACE, "balanceOf", tokenBalanceResult);
  if (accounted !== totalAvailable + totalLocked || tokenBalance < accounted || available > totalAvailable) {
    throw new Error("BIT vault accounting or solvency check failed");
  }
  return Object.freeze({
    deployment,
    vaultCodeHash: expectedVaultCodeHash,
    available: available.toString(),
    totalAvailable: totalAvailable.toString(),
    totalLocked: totalLocked.toString(),
    accounted: accounted.toString(),
    tokenBalance: tokenBalance.toString(),
  });
}

export function createFinalizedBitVaultInventoryReader({
  primaryProvider,
  secondaryProvider,
  expectedVaultAddress,
  expectedBitToLightningContract,
  expectedVaultCodeHash,
  expectedBitProxyCodeHash,
  expectedBitImplementationAddress,
  expectedBitImplementationCodeHash,
  sourceCommit,
  minimumReserveWei,
  maximumAdvertisedWei,
  timeoutMs = 10_000,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
}) {
  const primary = normalizeProvider(primaryProvider, "primary");
  const secondary = normalizeProvider(secondaryProvider, "secondary");
  if (primary.identity === secondary.identity
      || primary.label.toLowerCase() === secondary.label.toLowerCase()
      || primary.rpcCall === secondary.rpcCall) {
    throw new Error("BIT inventory requires two distinctly identified RPC providers");
  }
  const expectedVault = address(expectedVaultAddress, "expected BIT vault");
  const expectedUserEscrow = address(expectedBitToLightningContract, "expected BIT-to-Lightning escrow");
  const codeHash = bytes32(expectedVaultCodeHash, "expected BIT vault code hash");
  const bitProxyCodeHash = bytes32(expectedBitProxyCodeHash, "expected BIT proxy code hash");
  const bitImplementation = address(expectedBitImplementationAddress, "expected BIT implementation");
  const bitImplementationCodeHash = bytes32(
    expectedBitImplementationCodeHash,
    "expected BIT implementation code hash",
  );
  if (!GIT_COMMIT.test(String(sourceCommit ?? ""))) throw new TypeError("BIT reader source commit must be full lowercase hex");
  const reserve = uint(minimumReserveWei, "minimum BIT reserve", UINT256_MAX);
  const maximum = uint(maximumAdvertisedWei, "maximum advertised BIT", UINT256_MAX);
  const deadlineMs = integer(timeoutMs, "BIT reader timeout", 30_000);
  if (deadlineMs === 0) throw new RangeError("BIT reader timeout must be positive");
  if (typeof nowSeconds !== "function") throw new TypeError("BIT reader clock is required");

  return async function readVerifiedBitInventory(rawRequest) {
    const request = normalizeBitReaderRequest(rawRequest);
    const observedAt = integer(nowSeconds(), "BIT observation timestamp");
    if (request.direction === "bit-to-lightning") {
      if (request.verifyingContract !== expectedUserEscrow) throw new Error("BIT-to-Lightning escrow changed");
      return Object.freeze({ availableBitWei: "0", observedAt, solverId: request.solverId });
    }
    if (request.verifyingContract !== expectedVault) throw new Error("Lightning-to-BIT vault changed");

    return withDeadline((async () => {
      const [primaryHead, secondaryHead] = await Promise.all([
        primary.rpcCall("eth_getBlockByNumber", ["finalized", false]),
        secondary.rpcCall("eth_getBlockByNumber", ["finalized", false]),
      ]);
      const targetBlockNumber = Math.min(finalizedNumber(primaryHead), finalizedNumber(secondaryHead));
      const observationTime = new Date(observedAt * 1_000);
      const [left, right] = await Promise.all([
        observeVaultProvider({
          provider: primary,
          targetBlockNumber,
          expectedVault,
          expectedVaultCodeHash: codeHash,
          solverId: request.solverId,
          sourceCommit,
          observedAt: observationTime,
          expectedBitProxyCodeHash: bitProxyCodeHash,
          expectedBitImplementationAddress: bitImplementation,
          expectedBitImplementationCodeHash: bitImplementationCodeHash,
        }),
        observeVaultProvider({
          provider: secondary,
          targetBlockNumber,
          expectedVault,
          expectedVaultCodeHash: codeHash,
          solverId: request.solverId,
          sourceCommit,
          observedAt: observationTime,
          expectedBitProxyCodeHash: bitProxyCodeHash,
          expectedBitImplementationAddress: bitImplementation,
          expectedBitImplementationCodeHash: bitImplementationCodeHash,
        }),
      ]);
      const deploymentComparison = compareBitDeploymentObservations(left.deployment, right.deployment, {
        comparedAt: observationTime,
      });
      if (!deploymentComparison.eligible) throw new Error("BIT deployment providers disagree");
      for (const field of ["vaultCodeHash", "available", "totalAvailable", "totalLocked", "accounted", "tokenBalance"]) {
        if (left[field] !== right[field]) throw new Error(`BIT vault ${field} differs between providers`);
      }
      const available = BigInt(left.available);
      const afterReserve = available > reserve ? available - reserve : 0n;
      const admitted = afterReserve < maximum ? afterReserve : maximum;
      return Object.freeze({
        availableBitWei: admitted.toString(),
        observedAt,
        solverId: request.solverId,
      });
    })(), deadlineMs, "BIT inventory observation timed out");
  };
}

export {
  LIGHTNING_CAPACITY_OBSERVATION_SCHEMA,
  LIGHTNING_CAPACITY_REQUEST_SCHEMA,
  buildLightningCapacityObservation,
  createAuthenticatedLightningCapacityReader,
  lightningCapacityObservationDigest,
  lightningCapacityRequestDigest,
  signLightningCapacityObservation,
  signLightningCapacityRequest,
  verifyLightningCapacityRequest,
} from "./lightning-capacity-protocol.mjs";
