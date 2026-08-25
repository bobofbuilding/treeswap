import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  createCoordinatorActiveOperatorPolicyPreparer,
  createCoordinatorActiveOperatorRuntime,
  createCoordinatorEvmActionConfig,
  createCoordinatorLightningActionConfig,
  createSolverCapabilityClient,
  isCoordinatorActiveOperatorPolicyPreparer,
  startCoordinatorActiveOperatorService,
} from "../lib/coordinator-active-operator-policy.mjs";
import {
  buildLightningCapacityObservation,
  createAuthenticatedLightningCapacityReader,
  createFinalizedBitVaultInventoryReader,
  signLightningCapacityObservation,
  verifyLightningCapacityRequest,
} from "../lib/solver-capacity-readers.mjs";
import {
  SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
} from "../lib/solver-daemon-evidence.mjs";
import { createSolverDaemonEvidenceControls } from "../lib/solver-daemon-evidence-client.mjs";
import {
  authenticatedPrivatePacketClientTransportMode,
  createAuthenticatedPrivatePacketClient,
} from "../lib/solver-daemon-runtime.mjs";
import {
  SOLVER_CAPABILITY_TYPES,
  solverCapabilityClaimsDigest,
  solverCapabilityDomain,
  solverCapabilityProofMessage,
  solverEndpointOriginDigest,
  solverEndpointPublicKeyDigest,
  solverLightningNodePubkeyDigest,
} from "../lib/solver-capability.mjs";
import { buildSignedSolverCapabilityResponse } from "../lib/solver-endpoint-transport.mjs";

const NOW = 2_000_000_000;
const CHAIN_ID = "31337";
const LIGHTNING_TO_BIT = "0x1111111111111111111111111111111111111111";
const BIT_TO_LIGHTNING = "0x2222222222222222222222222222222222222222";
const LIGHTNING_TO_BIT_CODE_HASH = id("operator lightning-to-bit runtime").toLowerCase();
const BIT_TO_LIGHTNING_CODE_HASH = id("operator bit-to-lightning runtime").toLowerCase();
const BIT_PROXY_CODE_HASH = id("operator BIT proxy runtime").toLowerCase();
const BIT_IMPLEMENTATION = "0x3333333333333333333333333333333333333333";
const BIT_IMPLEMENTATION_CODE_HASH = id("operator BIT implementation runtime").toLowerCase();
const NODE_PUBKEY = `02${"44".repeat(32)}`;
const SOLVER = new Wallet(`0x${"55".repeat(32)}`);
const EVM_RELAYER = new Wallet(`0x${"66".repeat(32)}`);
const LIGHTNING_OPERATOR = new Wallet(`0x${"77".repeat(32)}`);
const SECURITY_REVIEWER = new Wallet(`0x${"88".repeat(32)}`);
const endpointKeys = generateKeyPairSync("ed25519");
const observerKeys = generateKeyPairSync("ed25519");
const capacityRequesterKeys = generateKeyPairSync("ed25519");
const packetRequesterKeys = generateKeyPairSync("ed25519");
const packetProviderKeys = generateKeyPairSync("ed25519");
const evidenceRequesterKeys = generateKeyPairSync("ed25519");
const lightningActionKeys = generateKeyPairSync("ed25519");
const ENDPOINT_ORIGIN = "https://solver.example";
const endpointPublicKey = endpointKeys.publicKey.export({ format: "pem", type: "spki" }).toString();

const capabilityPolicy = Object.freeze({
  chainId: CHAIN_ID,
  lightningToBitContract: LIGHTNING_TO_BIT,
  lightningToBitContractCodeHash: LIGHTNING_TO_BIT_CODE_HASH,
  bitToLightningContract: BIT_TO_LIGHTNING,
  bitToLightningContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
  maxCapabilityTtlSeconds: 120,
  maxCapacityObservationAgeSeconds: 30,
  maxClockSkewSeconds: 5,
});

function evidencePolicy(overrides = {}) {
  return {
    schema: SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
    releaseRecordDigest: id("operator release record").toLowerCase(),
    chainId: CHAIN_ID,
    settlementContract: BIT_TO_LIGHTNING,
    settlementContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
    solver: SOLVER.address,
    direction: "bit-to-lightning",
    approvers: {
      lightningOperator: LIGHTNING_OPERATOR.address,
      securityReviewer: SECURITY_REVIEWER.address,
    },
    maxEvidenceAgeSeconds: 30,
    maxEvidenceLifetimeSeconds: 30,
    maxClockSkewSeconds: 2,
    ...overrides,
  };
}

function concreteReaders() {
  const readVerifiedBitInventory = createFinalizedBitVaultInventoryReader({
    primaryProvider: {
      identity: id("operator primary BIT provider").toLowerCase(),
      label: "primary-bit-provider",
      rpcCall: async () => { throw new Error("BIT RPC must not be used in the user-funded direction"); },
    },
    secondaryProvider: {
      identity: id("operator secondary BIT provider").toLowerCase(),
      label: "secondary-bit-provider",
      rpcCall: async () => { throw new Error("BIT RPC must not be used in the user-funded direction"); },
    },
    expectedVaultAddress: LIGHTNING_TO_BIT,
    expectedBitToLightningContract: BIT_TO_LIGHTNING,
    expectedVaultCodeHash: LIGHTNING_TO_BIT_CODE_HASH,
    expectedBitProxyCodeHash: BIT_PROXY_CODE_HASH,
    expectedBitImplementationAddress: BIT_IMPLEMENTATION,
    expectedBitImplementationCodeHash: BIT_IMPLEMENTATION_CODE_HASH,
    sourceCommit: "a".repeat(40),
    minimumReserveWei: "1",
    maximumAdvertisedWei: "100000000000000000000",
    timeoutMs: 1_000,
    nowSeconds: () => NOW,
  });
  const readVerifiedLightningCapacity = createAuthenticatedLightningCapacityReader({
    observerPublicKey: observerKeys.publicKey,
    observerKeyId: "capacity-observer-one",
    requesterPrivateKey: capacityRequesterKeys.privateKey,
    requesterKeyId: "coordinator-capacity-one",
    fetchObservation: async (requestEnvelope) => {
      const request = verifyLightningCapacityRequest({
        envelope: requestEnvelope,
        publicKey: capacityRequesterKeys.publicKey,
        expectedKeyId: "coordinator-capacity-one",
        now: NOW,
        maxLifetimeSeconds: 30,
        maxClockSkewSeconds: 5,
      });
      return signLightningCapacityObservation(buildLightningCapacityObservation({
        request,
        aggregate: {
          nodePubkey: NODE_PUBKEY,
          capacityEpoch: "7",
          grossLightningSats: "500000",
          inFlightSats: "50000",
          reserveSats: "100000",
          budgetSats: "300000",
          availableLightningSats: "300000",
          observedAt: NOW,
        },
        observerKeyId: "capacity-observer-one",
        expiresAt: NOW + 10,
      }), observerKeys.privateKey);
    },
    maxObservationAgeSeconds: 30,
    maxClockSkewSeconds: 5,
    maxObservationTtlSeconds: 30,
    timeoutMs: 1_000,
    randomBytesImpl: () => Buffer.alloc(32, 0x91),
    nowSeconds: () => NOW,
  });
  return Object.freeze({ readVerifiedBitInventory, readVerifiedLightningCapacity });
}

async function endpointEnvelope() {
  const claims = {
    capabilityId: id("operator solver capability").toLowerCase(),
    direction: id("bit-to-lightning").toLowerCase(),
    solver: SOLVER.address,
    lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(NODE_PUBKEY),
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    endpointOriginDigest: solverEndpointOriginDigest(ENDPOINT_ORIGIN),
    availableBitWei: "0",
    availableLightningSats: "250000",
    capacityEpoch: "7",
    issuedAt: NOW,
    expiresAt: NOW + 60,
  };
  const declaration = {
    ...claims,
    proofChallenge: solverCapabilityClaimsDigest(claims, {
      chainId: CHAIN_ID,
      verifyingContract: BIT_TO_LIGHTNING,
    }),
  };
  const proofMessage = solverCapabilityProofMessage(declaration.proofChallenge);
  return Object.freeze({
    declaration,
    endpointOrigin: ENDPOINT_ORIGIN,
    endpointPublicKey,
    endpointSignature: sign(null, proofMessage, endpointKeys.privateKey).toString("base64"),
    evmSignature: await SOLVER.signTypedData(
      solverCapabilityDomain({ chainId: CHAIN_ID, verifyingContract: BIT_TO_LIGHTNING }),
      SOLVER_CAPABILITY_TYPES,
      declaration,
    ),
    lightningNodePubkey: NODE_PUBKEY,
    lightningSignature: "y".repeat(104),
  });
}

async function capabilityClient({ requestImpl: requestOverride = null } = {}) {
  const envelope = await endpointEnvelope();
  const readers = concreteReaders();
  return createSolverCapabilityClient({
    endpointOrigin: ENDPOINT_ORIGIN,
    solverId: SOLVER.address,
    direction: "bit-to-lightning",
    policy: capabilityPolicy,
    verifyLightningNodeSignature: async () => ({ valid: true, pubkey: NODE_PUBKEY }),
    readVerifiedBitInventory: readers.readVerifiedBitInventory,
    readVerifiedLightningCapacity: readers.readVerifiedLightningCapacity,
    requestImpl: requestOverride ?? (async (_url, options) => {
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify(buildSignedSolverCapabilityResponse({
        request,
        capabilityEnvelope: envelope,
        servedAt: NOW,
        expiresAt: NOW + 10,
        endpointPrivateKey: endpointKeys.privateKey,
      })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 0x92),
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
    maximumResponseBytes: 65_536,
  });
}

function runtime(policy = evidencePolicy(), { evidenceRequestImpl, packetRequestImpl } = {}) {
  const packetClientInput = {
    providerOrigin: "https://packet-provider.internal",
    requesterPrivateKey: packetRequesterKeys.privateKey,
    requesterKeyId: "coordinator-packet-one",
    providerPublicKey: packetProviderKeys.publicKey,
    providerKeyId: "packet-provider-one",
    minimumEvmSafetySeconds: 600,
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 0x93),
  };
  if (packetRequestImpl !== undefined) packetClientInput.requestImpl = packetRequestImpl;
  const packetClient = createAuthenticatedPrivatePacketClient(packetClientInput);
  const controlsInput = {
    policy,
    routes: {
      lightningOperator: "https://lightning-operator.internal",
      securityReviewer: "https://security-reviewer.internal",
    },
    requesterPrivateKey: evidenceRequesterKeys.privateKey,
    requesterKeyId: "coordinator-evidence-one",
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 0x94),
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
  };
  if (evidenceRequestImpl !== undefined) controlsInput.requestImpl = evidenceRequestImpl;
  const controls = createSolverDaemonEvidenceControls(controlsInput);
  const lightning = createCoordinatorLightningActionConfig({
    privateKey: lightningActionKeys.privateKey,
    keyId: "coordinator-action-one",
    adapterUrl: "http://payer-adapter",
    authorizationLifetimeSeconds: 15,
    requestImpl: async () => { throw new Error("Lightning adapter must not run during composition"); },
    dispatchTimeoutMs: 30_000,
    requestTimeoutMs: 5_000,
  });
  const broadcastRpc = async () => { throw new Error("EVM broadcast must not run during composition"); };
  const primaryRpc = async () => { throw new Error("primary EVM observer must not run during composition"); };
  const secondaryRpc = async () => { throw new Error("secondary EVM observer must not run during composition"); };
  const evm = createCoordinatorEvmActionConfig({
    signer: EVM_RELAYER,
    expectedChainId: CHAIN_ID,
    expectedContract: BIT_TO_LIGHTNING,
    expectedContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
    maximumGasCostWei: "1000000000000000",
    rpcUrl: "https://broadcast.example/rpc",
    rpcRequestImpl: broadcastRpc,
    reconciliationProviders: [
      { label: "provider-one", rpcUrl: "https://provider-one.example/rpc", rpcRequestImpl: primaryRpc },
      { label: "provider-two", rpcUrl: "https://provider-two.example/rpc", rpcRequestImpl: secondaryRpc },
    ],
    requestTimeoutMs: 5_000,
  });
  return createCoordinatorActiveOperatorRuntime({ packetClient, controls, lightning, evm });
}

test("refreshes a capability through the concrete finalized and authenticated readers", async () => {
  const client = await capabilityClient();
  const verification = await client.read({ signal: new AbortController().signal });
  assert.equal(verification.valid, true);
  assert.equal(verification.binding.direction, "bit-to-lightning");
  assert.equal(verification.binding.solverId, SOLVER.address.toLowerCase());
  assert.equal(verification.capacitySnapshot.availableBitWei, "0");
  assert.equal(verification.capacitySnapshot.availableLightningSats, "250000");

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(client.read({ signal: aborted.signal }), (error) => error.code === "TRANSPORT_FAILED");

  let transportAborted = false;
  const pendingClient = await capabilityClient({
    requestImpl: async (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => {
        transportAborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    }),
  });
  const duringRequest = new AbortController();
  const pendingRead = pendingClient.read({ signal: duringRequest.signal });
  duringRequest.abort();
  await assert.rejects(pendingRead, (error) => error.code === "TRANSPORT_FAILED");
  assert.equal(transportAborted, true);
});

test("accepts only the complete original operator runtime and matching evidence policy", async () => {
  const policy = evidencePolicy();
  const client = await capabilityClient();
  const activeRuntime = runtime(policy);
  assert.equal(
    authenticatedPrivatePacketClientTransportMode(activeRuntime.packetClient),
    "fixed-node-https",
  );
  assert.throws(
    () => authenticatedPrivatePacketClientTransportMode({ ...activeRuntime.packetClient }),
    /factory provenance/,
  );
  const preparer = createCoordinatorActiveOperatorPolicyPreparer({
    policies: [{ capabilityClient: client, evidencePolicy: policy, runtime: activeRuntime }],
  });
  assert.equal(isCoordinatorActiveOperatorPolicyPreparer(preparer), true);
  assert.equal(isCoordinatorActiveOperatorPolicyPreparer(async () => {}), false);
  assert.throws(() => createCoordinatorActiveOperatorPolicyPreparer({
    policies: [{ capabilityClient: { read: client.read }, evidencePolicy: policy, runtime: activeRuntime }],
  }), /concrete solver capability client/);
  assert.throws(() => createCoordinatorActiveOperatorPolicyPreparer({
    policies: [{ capabilityClient: client, evidencePolicy: policy, runtime: { ...activeRuntime } }],
  }), /concrete complete action runtime/);
  assert.throws(() => createCoordinatorActiveOperatorPolicyPreparer({
    policies: [{
      capabilityClient: client,
      evidencePolicy: evidencePolicy({ releaseRecordDigest: id("another release").toLowerCase() }),
      runtime: activeRuntime,
    }],
  }), /another evidence policy/);
  await assert.rejects(preparer({
    abortSignal: new AbortController().signal,
    releaseSupervisor: {},
    serviceLease: {},
    store: {},
  }), /original coordinator store/);
});

test("preparation is cancellation-aware and one-use, and the operator launcher rejects injected callbacks", async () => {
  const policy = evidencePolicy();
  const preparer = createCoordinatorActiveOperatorPolicyPreparer({
    policies: [{ capabilityClient: await capabilityClient(), evidencePolicy: policy, runtime: runtime(policy) }],
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(preparer({
    abortSignal: controller.signal,
    releaseSupervisor: {},
    serviceLease: {},
    store: {},
  }), /was aborted/);
  await assert.rejects(preparer({
    abortSignal: new AbortController().signal,
    releaseSupervisor: {},
    serviceLease: {},
    store: {},
  }), /one-use/);

  assert.throws(() => startCoordinatorActiveOperatorService({
    environment: {},
    fetchImpl: fetch,
    policyPreparer: async () => {},
    signal: null,
  }), /original same-process policy preparation/);

  const accepted = createCoordinatorActiveOperatorPolicyPreparer({
    policies: [{ capabilityClient: await capabilityClient(), evidencePolicy: policy, runtime: runtime(policy) }],
  });
  await assert.rejects(startCoordinatorActiveOperatorService({
    environment: {},
    fetchImpl: fetch,
    policyPreparer: accepted,
    signal: null,
  }), /database path/);
});

test("rejects lookalike readers, packet clients, action configs, and non-independent EVM providers", async () => {
  const readers = concreteReaders();
  const source = {
    endpointOrigin: ENDPOINT_ORIGIN,
    solverId: SOLVER.address,
    direction: "bit-to-lightning",
    policy: capabilityPolicy,
    verifyLightningNodeSignature: async () => ({ valid: true, pubkey: NODE_PUBKEY }),
    readVerifiedBitInventory: readers.readVerifiedBitInventory,
    readVerifiedLightningCapacity: readers.readVerifiedLightningCapacity,
    requestImpl: async () => { throw new Error("unused"); },
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32),
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
    maximumResponseBytes: 65_536,
  };
  assert.throws(() => createSolverCapabilityClient({
    ...source,
    readVerifiedBitInventory: async () => ({ availableBitWei: "0", observedAt: NOW, solverId: SOLVER.address }),
  }), /concrete finalized BIT inventory reader/);
  assert.throws(() => createSolverCapabilityClient({
    ...source,
    readVerifiedLightningCapacity: async () => ({
      availableLightningSats: "1", capacityEpoch: "7", nodePubkey: NODE_PUBKEY, observedAt: NOW,
    }),
  }), /concrete authenticated Lightning capacity reader/);
  assert.throws(() => createCoordinatorActiveOperatorRuntime({
    packetClient: { read: async () => {} },
    controls: {},
    lightning: {},
    evm: {},
  }), /concrete authenticated private-packet client/);
  assert.throws(() => runtime(evidencePolicy(), {
    evidenceRequestImpl: async () => { throw new Error("injected evidence transport"); },
  }), /fixed Node HTTPS evidence transport/);
  assert.throws(() => runtime(evidencePolicy(), {
    packetRequestImpl: async () => { throw new Error("injected private-packet transport"); },
  }), /fixed Node HTTPS private-packet transport/);

  const sameRpc = async () => {};
  assert.throws(() => createCoordinatorEvmActionConfig({
    signer: EVM_RELAYER,
    expectedChainId: CHAIN_ID,
    expectedContract: BIT_TO_LIGHTNING,
    expectedContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
    maximumGasCostWei: "1",
    rpcUrl: "https://broadcast.example/rpc",
    rpcRequestImpl: async () => {},
    reconciliationProviders: [
      { label: "provider-one", rpcUrl: "https://provider.example/a", rpcRequestImpl: sameRpc },
      { label: "provider-two", rpcUrl: "https://provider.example/b", rpcRequestImpl: sameRpc },
    ],
    requestTimeoutMs: 5_000,
  }), /distinct labels, origins, and clients/);
});
