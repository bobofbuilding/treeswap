import assert from "node:assert/strict";
import test from "node:test";
import { Interface, getAddress, keccak256 } from "ethers";
import {
  BIT_MAINNET_CONTRACT,
  EIP1967_IMPLEMENTATION_SLOT,
  assessBitDeploymentObservation,
  createJsonRpcClient,
  observeBitDeployment,
} from "../lib/bit-deployment-observer.mjs";

const TOKEN_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
]);
const IMPLEMENTATION = getAddress("0x1111111111111111111111111111111111111111");
const FINALIZED_BLOCK = {
  number: "0x1234",
  hash: `0x${"ab".repeat(32)}`,
  timestamp: "0x65a00000",
};
const PROXY_CODE = "0x6001600055";
const IMPLEMENTATION_CODE = "0x6002600055";

function fixtureRpc({ chainId = "0x1", paused = false, decimals = 18, symbol = "BIT" } = {}) {
  const calls = [];
  const rpcCall = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_chainId") return chainId;
    if (method === "eth_getBlockByNumber") return FINALIZED_BLOCK;
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2).toLowerCase()}`;
    if (method === "eth_getCode") return getAddress(params[0]) === BIT_MAINNET_CONTRACT ? PROXY_CODE : IMPLEMENTATION_CODE;
    if (method === "eth_call") {
      const selector = params[0].data;
      if (selector === TOKEN_INTERFACE.encodeFunctionData("decimals")) {
        return TOKEN_INTERFACE.encodeFunctionResult("decimals", [decimals]);
      }
      if (selector === TOKEN_INTERFACE.encodeFunctionData("paused")) {
        return TOKEN_INTERFACE.encodeFunctionResult("paused", [paused]);
      }
      if (selector === TOKEN_INTERFACE.encodeFunctionData("symbol")) {
        return TOKEN_INTERFACE.encodeFunctionResult("symbol", [symbol]);
      }
    }
    throw new Error(`unexpected RPC method: ${method}`);
  };
  return { rpcCall, calls };
}

test("records one internally consistent finalized BIT deployment observation", async () => {
  const { rpcCall, calls } = fixtureRpc();
  const observation = await observeBitDeployment({
    rpcCall,
    providerLabel: "test-provider",
    sourceCommit: "a".repeat(40),
    observedAt: new Date("2026-08-19T12:00:00.000Z"),
  });

  assert.equal(observation.chainId, 1);
  assert.equal(observation.finalizedBlock.number, 0x1234);
  assert.equal(observation.proxy.address, BIT_MAINNET_CONTRACT);
  assert.equal(observation.proxy.codeHash, keccak256(PROXY_CODE));
  assert.equal(observation.proxy.implementationSlot, EIP1967_IMPLEMENTATION_SLOT);
  assert.equal(observation.implementation.address, IMPLEMENTATION);
  assert.equal(observation.implementation.codeHash, keccak256(IMPLEMENTATION_CODE));
  assert.deepEqual(observation.token, { symbol: "BIT", decimals: 18, paused: false });
  assert.deepEqual(observation.safety, { eligible: true, reasons: [] });

  for (const call of calls.filter(({ method }) => ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method))) {
    assert.equal(call.params.at(-1), FINALIZED_BLOCK.number);
  }
});

test("rejects the wrong chain, missing code, empty implementation, and malformed finality", async () => {
  await assert.rejects(() => observeBitDeployment({ rpcCall: fixtureRpc({ chainId: "0xaa36a7" }).rpcCall }), /mainnet/);

  const noCode = fixtureRpc().rpcCall;
  await assert.rejects(
    () => observeBitDeployment({ rpcCall: async (method, params) => method === "eth_getCode" ? "0x" : noCode(method, params) }),
    /no deployed bytecode/,
  );

  const emptySlot = fixtureRpc().rpcCall;
  await assert.rejects(
    () => observeBitDeployment({ rpcCall: async (method, params) => method === "eth_getStorageAt" ? `0x${"0".repeat(64)}` : emptySlot(method, params) }),
    /slot is empty/,
  );

  const noFinality = fixtureRpc().rpcCall;
  await assert.rejects(
    () => observeBitDeployment({ rpcCall: async (method, params) => method === "eth_getBlockByNumber" ? null : noFinality(method, params) }),
    /finalized block hash/,
  );
});

test("marks an unsafe token state without discarding the evidence", async () => {
  const observation = await observeBitDeployment({ rpcCall: fixtureRpc({ paused: true, decimals: 8, symbol: "CHANGED" }).rpcCall });
  assert.equal(observation.safety.eligible, false);
  assert.match(observation.safety.reasons.join("; "), /symbol changed|decimals changed|paused/);
  assert.deepEqual(assessBitDeploymentObservation(observation), observation.safety);
});

test("JSON-RPC client does not place its credential-bearing URL in errors", async () => {
  const secretUrl = "https://rpc.example/secret-key";
  const rpcCall = createJsonRpcClient(secretUrl, async () => ({ ok: false, status: 401 }));
  await assert.rejects(
    () => rpcCall("eth_chainId", []),
    (error) => error.message === "Ethereum RPC returned HTTP 401 for eth_chainId" && !error.message.includes(secretUrl),
  );
});

test("JSON-RPC client permits plaintext only for a local fork", () => {
  assert.throws(() => createJsonRpcClient("http://rpc.example/secret"), /must use HTTPS/);
  assert.equal(typeof createJsonRpcClient("http://127.0.0.1:8545"), "function");
});
