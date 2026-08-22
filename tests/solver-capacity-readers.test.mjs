import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { Interface, Wallet, getAddress, id, keccak256 } from "ethers";
import { createFinalizedBitVaultInventoryReader } from "../lib/solver-capacity-readers.mjs";
import {
  LIGHTNING_CAPACITY_OBSERVATION_SCHEMA,
  buildLightningCapacityObservation,
  createAuthenticatedLightningCapacityReader,
  signLightningCapacityObservation,
  verifyLightningCapacityRequest,
} from "../lib/lightning-capacity-protocol.mjs";
import { BIT_MAINNET_CONTRACT, EIP1967_IMPLEMENTATION_SLOT } from "../lib/bit-deployment-observer.mjs";

const NOW = 2_000_000_000;
const SOLVER = new Wallet(`0x${"55".repeat(32)}`).address;
const VAULT = getAddress("0x1111111111111111111111111111111111111111");
const USER_ESCROW = getAddress("0x2222222222222222222222222222222222222222");
const IMPLEMENTATION = getAddress("0x3333333333333333333333333333333333333333");
const NODE_PUBKEY = `02${"44".repeat(32)}`;
const CAPABILITY_DIGEST = id("capacity-reader-capability").toLowerCase();
const PROVIDER_A = id("capacity-provider-a").toLowerCase();
const PROVIDER_B = id("capacity-provider-b").toLowerCase();
const FINALIZED_BLOCK = {
  number: "0x1234",
  hash: `0x${"ab".repeat(32)}`,
  timestamp: "0x65a00000",
};
const PROXY_CODE = "0x6001600055";
const IMPLEMENTATION_CODE = "0x6002600055";
const VAULT_CODE = "0x6003600055";
const VAULT_CODE_HASH = keccak256(VAULT_CODE);
const TOKEN_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
]);
const VAULT_INTERFACE = new Interface([
  "function BIT() view returns (address)",
  "function availableBalance(address solver) view returns (uint256)",
  "function totalAvailable() view returns (uint256)",
  "function totalLocked() view returns (uint256)",
  "function accountedBalance() view returns (uint256)",
]);

function rpcFixture({
  available = 1_000n,
  totalAvailable = 1_200n,
  totalLocked = 300n,
  tokenBalance = 1_500n,
  vaultCode = VAULT_CODE,
  finalizedBlock = FINALIZED_BLOCK,
  delay = null,
} = {}) {
  const calls = [];
  const rpcCall = async (method, params) => {
    calls.push({ method, params });
    if (delay) return delay;
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return finalizedBlock;
    if (method === "eth_getStorageAt") {
      assert.equal(params[1], EIP1967_IMPLEMENTATION_SLOT);
      return `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2).toLowerCase()}`;
    }
    if (method === "eth_getCode") {
      const target = getAddress(params[0]);
      if (target === BIT_MAINNET_CONTRACT) return PROXY_CODE;
      if (target === IMPLEMENTATION) return IMPLEMENTATION_CODE;
      if (target === VAULT) return vaultCode;
    }
    if (method === "eth_call") {
      const target = getAddress(params[0].to);
      const selector = params[0].data.slice(0, 10);
      if (target === BIT_MAINNET_CONTRACT) {
        if (selector === TOKEN_INTERFACE.getFunction("decimals").selector) {
          return TOKEN_INTERFACE.encodeFunctionResult("decimals", [18]);
        }
        if (selector === TOKEN_INTERFACE.getFunction("paused").selector) {
          return TOKEN_INTERFACE.encodeFunctionResult("paused", [false]);
        }
        if (selector === TOKEN_INTERFACE.getFunction("symbol").selector) {
          return TOKEN_INTERFACE.encodeFunctionResult("symbol", ["BIT"]);
        }
        if (selector === TOKEN_INTERFACE.getFunction("balanceOf").selector) {
          return TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [tokenBalance]);
        }
      }
      if (target === VAULT) {
        if (selector === VAULT_INTERFACE.getFunction("BIT").selector) {
          return VAULT_INTERFACE.encodeFunctionResult("BIT", [BIT_MAINNET_CONTRACT]);
        }
        if (selector === VAULT_INTERFACE.getFunction("availableBalance").selector) {
          return VAULT_INTERFACE.encodeFunctionResult("availableBalance", [available]);
        }
        if (selector === VAULT_INTERFACE.getFunction("totalAvailable").selector) {
          return VAULT_INTERFACE.encodeFunctionResult("totalAvailable", [totalAvailable]);
        }
        if (selector === VAULT_INTERFACE.getFunction("totalLocked").selector) {
          return VAULT_INTERFACE.encodeFunctionResult("totalLocked", [totalLocked]);
        }
        if (selector === VAULT_INTERFACE.getFunction("accountedBalance").selector) {
          return VAULT_INTERFACE.encodeFunctionResult("accountedBalance", [totalAvailable + totalLocked]);
        }
      }
    }
    throw new Error(`unexpected RPC call ${method}`);
  };
  return { calls, rpcCall };
}

function bitRequest(overrides = {}) {
  return {
    capabilityDigest: CAPABILITY_DIGEST,
    direction: "lightning-to-bit",
    solverId: SOLVER,
    verifyingContract: VAULT,
    ...overrides,
  };
}

function bitReader(primaryFixture = rpcFixture(), secondaryFixture = rpcFixture(), overrides = {}) {
  return createFinalizedBitVaultInventoryReader({
    primaryProvider: { identity: PROVIDER_A, label: "provider-a", rpcCall: primaryFixture.rpcCall },
    secondaryProvider: { identity: PROVIDER_B, label: "provider-b", rpcCall: secondaryFixture.rpcCall },
    expectedVaultAddress: VAULT,
    expectedBitToLightningContract: USER_ESCROW,
    expectedVaultCodeHash: VAULT_CODE_HASH,
    expectedBitProxyCodeHash: keccak256(PROXY_CODE),
    expectedBitImplementationAddress: IMPLEMENTATION,
    expectedBitImplementationCodeHash: keccak256(IMPLEMENTATION_CODE),
    sourceCommit: "a".repeat(40),
    minimumReserveWei: "100",
    maximumAdvertisedWei: "800",
    timeoutMs: 1_000,
    nowSeconds: () => NOW,
    ...overrides,
  });
}

test("reads only segregated, solvent BIT vault inventory at one two-provider finalized state", async () => {
  const left = rpcFixture();
  const right = rpcFixture();
  const observation = await bitReader(left, right)(bitRequest());
  assert.deepEqual(observation, {
    availableBitWei: "800",
    observedAt: NOW,
    solverId: SOLVER.toLowerCase(),
  });
  for (const fixture of [left, right]) {
    const stateCalls = fixture.calls.filter(({ method }) => ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method));
    assert.ok(stateCalls.length > 0);
    for (const call of stateCalls) {
      assert.deepEqual(call.params.at(-1), { blockHash: FINALIZED_BLOCK.hash, requireCanonical: true });
    }
    const availableCall = fixture.calls.find(({ method, params }) => method === "eth_call"
      && params[0].data.startsWith(VAULT_INTERFACE.getFunction("availableBalance").selector));
    assert.ok(availableCall, "solver-specific availableBalance was not read");
  }
});

test("requires distinct provider identity commitments before inventory observation", () => {
  const left = rpcFixture();
  const right = rpcFixture();
  assert.throws(() => bitReader(left, right, {
    secondaryProvider: { identity: PROVIDER_A, label: "provider-b", rpcCall: right.rpcCall },
  }), /distinctly identified/);
});

test("requires zero solver BIT inventory in the user-funded direction", async () => {
  const left = rpcFixture();
  const right = rpcFixture();
  const read = bitReader(left, right);
  assert.deepEqual(await read(bitRequest({
    direction: "bit-to-lightning",
    verifyingContract: USER_ESCROW,
  })), {
    availableBitWei: "0",
    observedAt: NOW,
    solverId: SOLVER.toLowerCase(),
  });
  assert.equal(left.calls.length + right.calls.length, 0);
  await assert.rejects(() => read(bitRequest({ direction: "bit-to-lightning" })), /escrow changed/);
});

test("fails closed on provider disagreement, unreviewed code, insolvency, or an observation timeout", async (t) => {
  await t.test("provider disagreement", async () => {
    await assert.rejects(() => bitReader(rpcFixture(), rpcFixture({ available: 999n }))(bitRequest()), /differs/);
  });
  await t.test("unreviewed vault code", async () => {
    await assert.rejects(() => bitReader(rpcFixture({ vaultCode: "0x6004" }), rpcFixture({ vaultCode: "0x6004" }))(bitRequest()), /runtime code/);
  });
  await t.test("unreviewed BIT implementation", async () => {
    await assert.rejects(() => bitReader(rpcFixture(), rpcFixture(), {
      expectedBitImplementationCodeHash: `0x${"99".repeat(32)}`,
    })(bitRequest()), /not the reviewed deployment/);
  });
  await t.test("insolvent vault", async () => {
    await assert.rejects(() => bitReader(
      rpcFixture({ tokenBalance: 1_499n }),
      rpcFixture({ tokenBalance: 1_499n }),
    )(bitRequest()), /solvency/);
  });
  await t.test("timeout", async () => {
    const never = new Promise(() => {});
    await assert.rejects(() => bitReader(
      rpcFixture({ delay: never }),
      rpcFixture({ delay: never }),
      { timeoutMs: 10 },
    )(bitRequest()), /timed out/);
  });
});

const observerKeys = generateKeyPairSync("ed25519");
const endpointKeys = generateKeyPairSync("ed25519");
const requesterKeys = generateKeyPairSync("ed25519");

function lightningObservation(overrides = {}) {
  return {
    schema: LIGHTNING_CAPACITY_OBSERVATION_SCHEMA,
    requestId: `0x${"66".repeat(32)}`,
    capabilityDigest: CAPABILITY_DIGEST,
    direction: "lightning-to-bit",
    solverId: SOLVER,
    nodePubkey: NODE_PUBKEY,
    capacityEpoch: "7",
    grossLightningSats: "500000",
    inFlightSats: "50000",
    reserveSats: "100000",
    budgetSats: "300000",
    availableLightningSats: "300000",
    observedAt: NOW,
    expiresAt: NOW + 20,
    observerKeyId: "observer-one",
    ...overrides,
  };
}

function lightningRequest(overrides = {}) {
  return {
    capabilityDigest: CAPABILITY_DIGEST,
    capacityEpoch: "7",
    direction: "lightning-to-bit",
    endpointOrigin: "https://solver.example",
    endpointPublicKey: endpointKeys.publicKey,
    lightningNodePubkey: NODE_PUBKEY,
    solverId: SOLVER,
    ...overrides,
  };
}

function lightningReader(fetchObservation, overrides = {}) {
  return createAuthenticatedLightningCapacityReader({
    observerPublicKey: observerKeys.publicKey,
    observerKeyId: "observer-one",
    requesterPrivateKey: requesterKeys.privateKey,
    requesterKeyId: "coordinator-one",
    fetchObservation,
    maxObservationAgeSeconds: 30,
    maxClockSkewSeconds: 5,
    maxObservationTtlSeconds: 30,
    timeoutMs: 1_000,
    nowSeconds: () => NOW + 1,
    ...overrides,
  });
}

test("accepts only a fresh independently keyed aggregate Lightning observation", async () => {
  const requested = [];
  const read = lightningReader(async (envelope) => {
    const request = verifyLightningCapacityRequest({
      envelope,
      publicKey: requesterKeys.publicKey,
      expectedKeyId: "coordinator-one",
      now: NOW + 1,
      maxLifetimeSeconds: 30,
      maxClockSkewSeconds: 5,
    });
    requested.push(request);
    const aggregate = {
      nodePubkey: NODE_PUBKEY,
      capacityEpoch: "7",
      grossLightningSats: "500000",
      inFlightSats: "50000",
      reserveSats: "100000",
      budgetSats: "300000",
      availableLightningSats: "300000",
      observedAt: NOW,
    };
    return signLightningCapacityObservation(buildLightningCapacityObservation({
      request,
      aggregate,
      observerKeyId: "observer-one",
      expiresAt: NOW + 20,
    }), observerKeys.privateKey);
  });
  assert.deepEqual(await read(lightningRequest()), {
    availableLightningSats: "300000",
    capacityEpoch: "7",
    nodePubkey: NODE_PUBKEY,
    observedAt: NOW,
  });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].capabilityDigest, CAPABILITY_DIGEST);
  assert.equal(requested[0].capacityEpoch, "7");
  assert.equal(requested[0].direction, "lightning-to-bit");
  assert.equal(requested[0].lightningNodePubkey, NODE_PUBKEY);
  assert.equal(requested[0].solverId, SOLVER.toLowerCase());
  assert.match(requested[0].requestId, /^0x[0-9a-f]{64}$/);
});

test("rejects mutation, replay across bindings, stale data, inconsistent deductions, and key reuse", async (t) => {
  await t.test("signed mutation", async () => {
    await assert.rejects(() => lightningReader(async (requestEnvelope) => {
      const envelope = signLightningCapacityObservation(lightningObservation({
        requestId: requestEnvelope.payload.requestId,
      }), observerKeys.privateKey);
      return { ...envelope, observation: { ...envelope.observation, availableLightningSats: "1" } };
    })(lightningRequest()), /deductions|signature/);
  });
  await t.test("binding replay", async () => {
    await assert.rejects(() => lightningReader(async (requestEnvelope) => signLightningCapacityObservation(
      lightningObservation({ requestId: requestEnvelope.payload.requestId }),
      observerKeys.privateKey,
    ))(lightningRequest({
      capabilityDigest: id("another-capability").toLowerCase(),
    })), /binding changed/);
  });
  await t.test("prior request replay", async () => {
    let cached;
    const read = lightningReader(async (requestEnvelope) => {
      if (cached) return cached;
      cached = signLightningCapacityObservation(lightningObservation({
        requestId: requestEnvelope.payload.requestId,
      }), observerKeys.privateKey);
      return cached;
    });
    await read(lightningRequest());
    await assert.rejects(() => read(lightningRequest()), /binding changed/);
  });
  await t.test("stale observation", async () => {
    await assert.rejects(() => lightningReader(async (requestEnvelope) => signLightningCapacityObservation(
      lightningObservation({
        requestId: requestEnvelope.payload.requestId,
        observedAt: NOW - 31,
        expiresAt: NOW + 2,
      }),
      observerKeys.privateKey,
    ))(lightningRequest()), /time window/);
  });
  await t.test("inconsistent deductions", () => {
    assert.throws(() => signLightningCapacityObservation(
      lightningObservation({ availableLightningSats: "300001" }),
      observerKeys.privateKey,
    ), /deductions/);
  });
  await t.test("endpoint and observer key reuse", async () => {
    await assert.rejects(() => lightningReader(async () => null)(lightningRequest({
      endpointPublicKey: observerKeys.publicKey,
    })), /independent/);
  });
});
