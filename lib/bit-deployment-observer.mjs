import { Interface, ZeroAddress, getAddress, isHexString, keccak256 } from "ethers";

export const BIT_MAINNET_CONTRACT = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const BIT_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
]);
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const DECIMAL_QUANTITY = /^(?:0|[1-9][0-9]*)$/;

function requireHexQuantity(value, label) {
  if (!HEX_QUANTITY.test(String(value))) throw new TypeError(`${label} is not a canonical hex quantity`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} exceeds the safe integer range`);
  return Number(parsed);
}

function requireBlockNumber(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
    return value;
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} exceeds the safe integer range`);
    return Number(value);
  }
  if (DECIMAL_QUANTITY.test(String(value))) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} exceeds the safe integer range`);
    return parsed;
  }
  if (HEX_QUANTITY.test(String(value))) return requireHexQuantity(value, label);
  throw new TypeError(`${label} must be a canonical block number`);
}

function blockTag(number) {
  return `0x${number.toString(16)}`;
}

function requireBlock(value, label) {
  if (!value || !BYTES32.test(String(value.hash ?? ""))) {
    throw new TypeError(`RPC did not return a ${label} block hash`);
  }
  return {
    number: requireHexQuantity(value.number, `${label} block number`),
    hash: value.hash.toLowerCase(),
    timestamp: requireHexQuantity(value.timestamp, `${label} block timestamp`),
  };
}

function requireCode(value, label) {
  if (!isHexString(value) || value === "0x") throw new TypeError(`${label} has no deployed bytecode`);
  return value.toLowerCase();
}

function implementationFromSlot(value) {
  if (!isHexString(value, 32)) throw new TypeError("BIT implementation slot is not bytes32");
  const implementation = getAddress(`0x${value.slice(-40)}`);
  if (implementation === ZeroAddress) throw new TypeError("BIT implementation slot is empty");
  return implementation;
}

function decodeCall(functionName, encoded) {
  if (!isHexString(encoded)) throw new TypeError(`${functionName} returned malformed data`);
  try {
    return BIT_INTERFACE.decodeFunctionResult(functionName, encoded)[0];
  } catch {
    throw new TypeError(`${functionName} returned undecodable data`);
  }
}

export function assessBitDeploymentObservation(observation) {
  const reasons = [];
  if (observation.chainId !== 1) reasons.push("BIT observation is not from Ethereum mainnet");
  if (observation.proxy.address !== BIT_MAINNET_CONTRACT) reasons.push("BIT proxy address is not the reviewed contract");
  if (observation.token.symbol !== "BIT") reasons.push("BIT symbol changed");
  if (observation.token.decimals !== 18) reasons.push("BIT decimals changed");
  if (observation.token.paused !== false) reasons.push("BIT is paused");
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function compareBitDeploymentObservations(left, right) {
  const reasons = [];
  const add = (condition, reason) => {
    if (condition) reasons.push(reason);
  };
  const field = (value, path) => path.split(".").reduce((current, part) => current?.[part], value);
  const comparedFields = [
    "schema",
    "sourceCommit",
    "chainId",
    "finalizedBlock.number",
    "finalizedBlock.hash",
    "finalizedBlock.timestamp",
    "stateAnchor.blockHash",
    "stateAnchor.requireCanonical",
    "proxy.address",
    "proxy.codeHash",
    "proxy.implementationSlot",
    "implementation.address",
    "implementation.codeHash",
    "token.symbol",
    "token.decimals",
    "token.paused",
  ];

  add(!left || !right, "two observations are required");
  if (reasons.length === 0) {
    add(left.schema !== "treeswap.bit-deployment-observation.v2", "first observation schema is unsupported");
    add(right.schema !== "treeswap.bit-deployment-observation.v2", "second observation schema is unsupported");
    add(left.evidenceStatus !== "unreviewed-live-observation", "first observation has an unexpected evidence status");
    add(right.evidenceStatus !== "unreviewed-live-observation", "second observation has an unexpected evidence status");
    add(!GIT_COMMIT.test(String(left.sourceCommit ?? "")), "first observation is not bound to a full source commit");
    add(!GIT_COMMIT.test(String(right.sourceCommit ?? "")), "second observation is not bound to a full source commit");
    add(!left.safety?.eligible, "first observation is not safety eligible");
    add(!right.safety?.eligible, "second observation is not safety eligible");
    add(!left.providerLabel || !right.providerLabel, "both provider labels are required");
    add(left.providerLabel === right.providerLabel, "providers must be independently labelled");
    for (const path of comparedFields) {
      add(field(left, path) !== field(right, path), `${path} differs between providers`);
    }
    for (const [position, observation] of [["first", left], ["second", right]]) {
      add(
        observation.stateAnchor?.blockHash !== observation.finalizedBlock?.hash
          || observation.stateAnchor?.requireCanonical !== true,
        `${position} observation is not canonically anchored to its recorded block`,
      );
      add(
        !Number.isSafeInteger(observation.providerFinalizedHead?.number)
          || observation.providerFinalizedHead.number < observation.finalizedBlock?.number,
        `${position} provider did not prove the observed block finalized`,
      );
    }
  }

  return Object.freeze({
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
    comparedFields: Object.freeze(comparedFields),
  });
}

export async function observeBitDeployment({
  rpcCall,
  proxyAddress = BIT_MAINNET_CONTRACT,
  providerLabel = "operator-supplied",
  observedAt = new Date(),
  sourceCommit = null,
  targetBlockNumber = null,
} = {}) {
  if (typeof rpcCall !== "function") throw new TypeError("rpcCall is required");
  const proxy = getAddress(proxyAddress);
  if (proxy !== BIT_MAINNET_CONTRACT) throw new TypeError("unexpected BIT proxy address");

  const chainId = requireHexQuantity(await rpcCall("eth_chainId", []), "chain ID");
  if (chainId !== 1) throw new TypeError("BIT observation must use Ethereum mainnet");

  const finalizedHead = requireBlock(
    await rpcCall("eth_getBlockByNumber", ["finalized", false]),
    "finalized",
  );
  const requestedBlockNumber = targetBlockNumber === null
    ? finalizedHead.number
    : requireBlockNumber(targetBlockNumber, "target block number");
  if (requestedBlockNumber > finalizedHead.number) {
    throw new RangeError("target block is newer than the provider's finalized head");
  }
  const exactBlockTag = blockTag(requestedBlockNumber);
  const observedBlock = requireBlock(
    await rpcCall("eth_getBlockByNumber", [exactBlockTag, false]),
    "target",
  );
  if (observedBlock.number !== requestedBlockNumber) throw new TypeError("RPC returned the wrong target block number");
  if (observedBlock.number === finalizedHead.number && observedBlock.hash !== finalizedHead.hash) {
    throw new TypeError("RPC finalized head changed while pinning the target block");
  }
  const stateAnchor = Object.freeze({ blockHash: observedBlock.hash, requireCanonical: true });

  const [proxyCodeValue, implementationWord, decimalsValue, pausedValue, symbolValue] = await Promise.all([
    rpcCall("eth_getCode", [proxy, stateAnchor]),
    rpcCall("eth_getStorageAt", [proxy, EIP1967_IMPLEMENTATION_SLOT, stateAnchor]),
    rpcCall("eth_call", [{ to: proxy, data: BIT_INTERFACE.encodeFunctionData("decimals") }, stateAnchor]),
    rpcCall("eth_call", [{ to: proxy, data: BIT_INTERFACE.encodeFunctionData("paused") }, stateAnchor]),
    rpcCall("eth_call", [{ to: proxy, data: BIT_INTERFACE.encodeFunctionData("symbol") }, stateAnchor]),
  ]);

  const implementationAddress = implementationFromSlot(implementationWord);
  const implementationCodeValue = await rpcCall("eth_getCode", [implementationAddress, stateAnchor]);
  const proxyCode = requireCode(proxyCodeValue, "BIT proxy");
  const implementationCode = requireCode(implementationCodeValue, "BIT implementation");
  const symbol = String(decodeCall("symbol", symbolValue));
  if (symbol.length > 32) throw new TypeError("BIT symbol is unexpectedly long");

  const timestamp = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("observedAt is invalid");

  const observation = {
    schema: "treeswap.bit-deployment-observation.v2",
    evidenceStatus: "unreviewed-live-observation",
    observedAt: timestamp.toISOString(),
    providerLabel: String(providerLabel).slice(0, 80),
    sourceCommit,
    chainId,
    providerFinalizedHead: {
      number: finalizedHead.number,
      hash: finalizedHead.hash,
      timestamp: new Date(finalizedHead.timestamp * 1_000).toISOString(),
    },
    finalizedBlock: {
      number: observedBlock.number,
      hash: observedBlock.hash,
      timestamp: new Date(observedBlock.timestamp * 1_000).toISOString(),
    },
    stateAnchor,
    proxy: {
      address: proxy,
      codeHash: keccak256(proxyCode),
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
    },
    implementation: {
      address: implementationAddress,
      codeHash: keccak256(implementationCode),
    },
    token: {
      symbol,
      decimals: Number(decodeCall("decimals", decimalsValue)),
      paused: Boolean(decodeCall("paused", pausedValue)),
    },
  };

  return Object.freeze({ ...observation, safety: assessBitDeploymentObservation(observation) });
}

export function createJsonRpcClient(rpcUrl, fetchImpl = globalThis.fetch, { timeoutMs = 10_000 } = {}) {
  let url;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new TypeError("ETHEREUM_RPC_URL must be a valid URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new TypeError("ETHEREUM_RPC_URL must use HTTP or HTTPS");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new TypeError("remote ETHEREUM_RPC_URL must use HTTPS");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new RangeError("Ethereum RPC timeout is outside policy");
  }

  let requestId = 0;
  return async function rpcCall(method, params) {
    const id = ++requestId;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(`Ethereum RPC transport failed for ${method}`);
    }
    if (!response.ok) throw new Error(`Ethereum RPC returned HTTP ${response.status} for ${method}`);

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Ethereum RPC returned invalid JSON for ${method}`);
    }
    if (payload?.id !== id || payload?.jsonrpc !== "2.0") throw new Error(`Ethereum RPC response mismatch for ${method}`);
    if (payload.error) throw new Error(`Ethereum RPC rejected ${method} with code ${payload.error.code ?? "unknown"}`);
    if (!("result" in payload)) throw new Error(`Ethereum RPC omitted the result for ${method}`);
    return payload.result;
  };
}
