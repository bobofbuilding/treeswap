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
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

function requireHexQuantity(value, label) {
  if (!HEX_QUANTITY.test(String(value))) throw new TypeError(`${label} is not a canonical hex quantity`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} exceeds the safe integer range`);
  return Number(parsed);
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

export async function observeBitDeployment({
  rpcCall,
  proxyAddress = BIT_MAINNET_CONTRACT,
  providerLabel = "operator-supplied",
  observedAt = new Date(),
  sourceCommit = null,
} = {}) {
  if (typeof rpcCall !== "function") throw new TypeError("rpcCall is required");
  const proxy = getAddress(proxyAddress);
  if (proxy !== BIT_MAINNET_CONTRACT) throw new TypeError("unexpected BIT proxy address");

  const chainId = requireHexQuantity(await rpcCall("eth_chainId", []), "chain ID");
  if (chainId !== 1) throw new TypeError("BIT observation must use Ethereum mainnet");

  const block = await rpcCall("eth_getBlockByNumber", ["finalized", false]);
  if (!block || !BYTES32.test(String(block.hash ?? ""))) {
    throw new TypeError("RPC did not return a finalized block hash");
  }
  const blockNumber = requireHexQuantity(block.number, "finalized block number");
  const blockTimestamp = requireHexQuantity(block.timestamp, "finalized block timestamp");
  const blockTag = block.number;

  const [proxyCodeValue, implementationWord, decimalsValue, pausedValue, symbolValue] = await Promise.all([
    rpcCall("eth_getCode", [proxy, blockTag]),
    rpcCall("eth_getStorageAt", [proxy, EIP1967_IMPLEMENTATION_SLOT, blockTag]),
    rpcCall("eth_call", [{ to: proxy, data: BIT_INTERFACE.encodeFunctionData("decimals") }, blockTag]),
    rpcCall("eth_call", [{ to: proxy, data: BIT_INTERFACE.encodeFunctionData("paused") }, blockTag]),
    rpcCall("eth_call", [{ to: proxy, data: BIT_INTERFACE.encodeFunctionData("symbol") }, blockTag]),
  ]);

  const implementationAddress = implementationFromSlot(implementationWord);
  const implementationCodeValue = await rpcCall("eth_getCode", [implementationAddress, blockTag]);
  const proxyCode = requireCode(proxyCodeValue, "BIT proxy");
  const implementationCode = requireCode(implementationCodeValue, "BIT implementation");
  const symbol = String(decodeCall("symbol", symbolValue));
  if (symbol.length > 32) throw new TypeError("BIT symbol is unexpectedly long");

  const timestamp = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("observedAt is invalid");

  const observation = {
    schema: "treeswap.bit-deployment-observation.v1",
    evidenceStatus: "unreviewed-live-observation",
    observedAt: timestamp.toISOString(),
    providerLabel: String(providerLabel).slice(0, 80),
    sourceCommit,
    chainId,
    finalizedBlock: {
      number: blockNumber,
      hash: block.hash.toLowerCase(),
      timestamp: new Date(blockTimestamp * 1_000).toISOString(),
    },
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

export function createJsonRpcClient(rpcUrl, fetchImpl = globalThis.fetch) {
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

  let requestId = 0;
  return async function rpcCall(method, params) {
    const id = ++requestId;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
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
