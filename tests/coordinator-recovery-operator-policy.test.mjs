import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  createCoordinatorEvmActionConfig,
  createCoordinatorLightningActionConfig,
  createSolverCapabilityClient,
  createTestSolverCapabilityClient,
  solverCapabilityClientTransportMode,
} from "../lib/coordinator-active-operator-policy.mjs";
import {
  createCoordinatorRecoveryOperatorPolicyPreparer,
  createCoordinatorRecoveryOperatorRuntime,
  isCoordinatorRecoveryOperatorPolicyPreparer,
  isCoordinatorRecoveryOperatorRuntime,
  startCoordinatorRecoveryOperatorService,
} from "../lib/coordinator-recovery-operator-policy.mjs";
import {
  acquireCoordinatorServiceLease,
  normalizeCoordinatorServiceConfig,
} from "../lib/coordinator-service-state.mjs";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  buildLightningCapacityObservation,
  createAuthenticatedLightningCapacityReader,
  createFinalizedBitVaultInventoryReader,
  signLightningCapacityObservation,
  verifyLightningCapacityRequest,
} from "../lib/solver-capacity-readers.mjs";
import {
  createSolverDaemonEvidenceControls,
  createSolverDaemonRecoveryEvidenceControls,
  isSolverDaemonEvidenceControls,
  isSolverDaemonRecoveryEvidenceControls,
  solverDaemonRecoveryEvidenceControlsPolicyDigest,
} from "../lib/solver-daemon-evidence-client.mjs";
import {
  SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
  solverDaemonEvidencePolicyDigest,
} from "../lib/solver-daemon-evidence.mjs";
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
const BIT_IMPLEMENTATION = "0x3333333333333333333333333333333333333333";
const LIGHTNING_TO_BIT_CODE_HASH = id("recovery operator vault runtime").toLowerCase();
const BIT_TO_LIGHTNING_CODE_HASH = id("recovery operator user escrow runtime").toLowerCase();
const BIT_PROXY_CODE_HASH = id("recovery operator BIT proxy runtime").toLowerCase();
const BIT_IMPLEMENTATION_CODE_HASH = id("recovery operator BIT implementation runtime").toLowerCase();
const RELEASE_RECORD_DIGEST = id("recovery operator release record").toLowerCase();
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
const lightningResponseKeys = generateKeyPairSync("ed25519");
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
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
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

function recoveryControls(policy, requestImpl = undefined) {
  const input = {
    policy,
    routes: {
      lightningOperator: "https://lightning-operator.internal",
      securityReviewer: "https://security-reviewer.internal",
    },
    requesterPrivateKey: evidenceRequesterKeys.privateKey,
    requesterKeyId: "coordinator-recovery-evidence-one",
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 0x81),
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
  };
  if (requestImpl !== undefined) input.requestImpl = requestImpl;
  return createSolverDaemonRecoveryEvidenceControls(input);
}

function activeControls(policy) {
  return createSolverDaemonEvidenceControls({
    policy,
    routes: {
      lightningOperator: "https://lightning-operator.internal",
      securityReviewer: "https://security-reviewer.internal",
    },
    requesterPrivateKey: evidenceRequesterKeys.privateKey,
    requesterKeyId: "coordinator-active-evidence-one",
    requestImpl: async () => { throw new Error("evidence route must not run during composition"); },
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 0x82),
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
  });
}

function recoveryRuntime(policy = evidencePolicy(), { evidenceRequestImpl, packetRequestImpl } = {}) {
  const packetClientInput = {
    providerOrigin: "https://packet-provider.internal",
    requesterPrivateKey: packetRequesterKeys.privateKey,
    requesterKeyId: "coordinator-recovery-packet-one",
    providerPublicKey: packetProviderKeys.publicKey,
    providerKeyId: "packet-provider-one",
    minimumEvmSafetySeconds: 600,
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 0x83),
  };
  if (packetRequestImpl !== undefined) packetClientInput.requestImpl = packetRequestImpl;
  const packetClient = createAuthenticatedPrivatePacketClient(packetClientInput);
  const lightning = createCoordinatorLightningActionConfig({
    privateKey: lightningActionKeys.privateKey,
    keyId: "coordinator-recovery-action-one",
    adapterUrl: "https://payer-adapter.internal",
    responsePublicKey: lightningResponseKeys.publicKey,
    responseKeyId: "payer-response-recovery-one",
    authorizationLifetimeSeconds: 15,
    dispatchTimeoutMs: 30_000,
    requestTimeoutMs: 5_000,
  });
  const evm = createCoordinatorEvmActionConfig({
    signer: EVM_RELAYER,
    expectedChainId: CHAIN_ID,
    expectedContract: BIT_TO_LIGHTNING,
    expectedContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
    maximumGasCostWei: "1000000000000000",
    rpcUrl: "https://broadcast.example/rpc",
    reconciliationProviders: [
      { label: "provider-one", rpcUrl: "https://provider-one.example/rpc" },
      { label: "provider-two", rpcUrl: "https://provider-two.example/rpc" },
    ],
    requestTimeoutMs: 5_000,
  });
  return createCoordinatorRecoveryOperatorRuntime({
    packetClient,
    controls: recoveryControls(policy, evidenceRequestImpl),
    lightning,
    evm,
  });
}

async function endpointEnvelope() {
  const claims = {
    capabilityId: id("recovery operator solver capability").toLowerCase(),
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
  return Object.freeze({
    declaration,
    endpointOrigin: ENDPOINT_ORIGIN,
    endpointPublicKey,
    endpointSignature: sign(
      null,
      solverCapabilityProofMessage(declaration.proofChallenge),
      endpointKeys.privateKey,
    ).toString("base64"),
    evmSignature: await SOLVER.signTypedData(
      solverCapabilityDomain({ chainId: CHAIN_ID, verifyingContract: BIT_TO_LIGHTNING }),
      SOLVER_CAPABILITY_TYPES,
      declaration,
    ),
    lightningNodePubkey: NODE_PUBKEY,
    lightningSignature: "y".repeat(104),
  });
}

async function capabilityClient({ injected = false } = {}) {
  const readVerifiedBitInventory = createFinalizedBitVaultInventoryReader({
    primaryProvider: {
      identity: id("recovery primary BIT provider").toLowerCase(),
      label: "primary-bit-provider",
      rpcCall: async () => { throw new Error("BIT RPC must not run in the user-funded direction"); },
    },
    secondaryProvider: {
      identity: id("recovery secondary BIT provider").toLowerCase(),
      label: "secondary-bit-provider",
      rpcCall: async () => { throw new Error("BIT RPC must not run in the user-funded direction"); },
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
    observerKeyId: "recovery-capacity-observer",
    requesterPrivateKey: capacityRequesterKeys.privateKey,
    requesterKeyId: "coordinator-recovery-capacity",
    fetchObservation: async (requestEnvelope) => {
      const request = verifyLightningCapacityRequest({
        envelope: requestEnvelope,
        publicKey: capacityRequesterKeys.publicKey,
        expectedKeyId: "coordinator-recovery-capacity",
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
        observerKeyId: "recovery-capacity-observer",
        expiresAt: NOW + 10,
      }), observerKeys.privateKey);
    },
    maxObservationAgeSeconds: 30,
    maxClockSkewSeconds: 5,
    maxObservationTtlSeconds: 30,
    timeoutMs: 1_000,
    randomBytesImpl: () => Buffer.alloc(32, 0x84),
    nowSeconds: () => NOW,
  });
  const source = {
    endpointOrigin: ENDPOINT_ORIGIN,
    solverId: SOLVER.address,
    direction: "bit-to-lightning",
    policy: capabilityPolicy,
    readVerifiedBitInventory,
    readVerifiedLightningCapacity,
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
    maximumResponseBytes: 65_536,
  };
  if (!injected) return createSolverCapabilityClient(source);
  const envelope = await endpointEnvelope();
  return createTestSolverCapabilityClient({
    ...source,
    verifyLightningNodeSignature: async () => ({ valid: true, pubkey: NODE_PUBKEY }),
    requestImpl: async (_url, options) => new Response(JSON.stringify(buildSignedSolverCapabilityResponse({
      request: JSON.parse(options.body),
      capabilityEnvelope: envelope,
      servedAt: NOW,
      expiresAt: NOW + 10,
      endpointPrivateKey: endpointKeys.privateKey,
    })), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 0x85),
  });
}

async function retainedFileReference(path, root) {
  const bytes = await readFile(path);
  return Object.freeze({
    path: path.slice(root.length + 1),
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    sizeBytes: (await stat(path)).size,
  });
}

test("exposes only provenance-bound recovery evidence controls", () => {
  const policy = evidencePolicy();
  const controls = recoveryControls(policy);
  assert.deepEqual(Object.keys(controls).sort(), ["authorizeEvmClaim", "observeReservation", "verifyAssets"]);
  assert.equal(Object.hasOwn(controls, "authorizeLightning"), false);
  assert.equal(isSolverDaemonRecoveryEvidenceControls(controls), true);
  assert.equal(isSolverDaemonEvidenceControls(controls), false);
  assert.equal(
    solverDaemonRecoveryEvidenceControlsPolicyDigest(controls),
    solverDaemonEvidencePolicyDigest(policy),
  );
  assert.equal(isSolverDaemonRecoveryEvidenceControls({ ...controls }), false);
});

test("accepts only a complete recovery-only runtime and an exact reviewed policy", async () => {
  const policy = evidencePolicy();
  const runtime = recoveryRuntime(policy);
  assert.equal(isCoordinatorRecoveryOperatorRuntime(runtime), true);
  assert.equal(isCoordinatorRecoveryOperatorRuntime({ ...runtime }), false);
  assert.equal(
    authenticatedPrivatePacketClientTransportMode(runtime.packetClient),
    "fixed-node-https",
  );
  assert.throws(() => createCoordinatorRecoveryOperatorRuntime({
    ...runtime,
    controls: activeControls(policy),
  }), /recovery-only dual-route evidence controls/);
  assert.throws(() => createCoordinatorRecoveryOperatorRuntime({
    ...runtime,
    packetClient: { read: runtime.packetClient.read },
  }), /authenticated private-packet client/);
  assert.throws(() => recoveryRuntime(policy, {
    evidenceRequestImpl: async () => { throw new Error("injected evidence transport"); },
  }), /fixed Node HTTPS evidence transport/);
  assert.throws(() => recoveryRuntime(policy, {
    packetRequestImpl: async () => { throw new Error("injected private-packet transport"); },
  }), /fixed Node HTTPS private-packet transport/);

  const client = await capabilityClient();
  assert.equal(solverCapabilityClientTransportMode(client), "fixed-node-https");
  const injectedClient = await capabilityClient({ injected: true });
  assert.equal(solverCapabilityClientTransportMode(injectedClient), "injected-test");
  assert.throws(() => createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: "/private/treeswap/recovery-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("injected recovery host").toLowerCase(),
    restoredProcessInstanceId: id("injected recovery process").toLowerCase(),
    policies: [{ capabilityClient: injectedClient, evidencePolicy: policy, runtime }],
  }), /fixed Node HTTPS solver capability client/);
  const preparer = createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: "/private/treeswap/recovery-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("recovery restored host").toLowerCase(),
    restoredProcessInstanceId: id("recovery restored process").toLowerCase(),
    policies: [{ capabilityClient: client, evidencePolicy: policy, runtime }],
  });
  assert.equal(isCoordinatorRecoveryOperatorPolicyPreparer(preparer), true);
  assert.equal(isCoordinatorRecoveryOperatorPolicyPreparer(async () => {}), false);
  assert.throws(() => createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: "relative-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("relative host").toLowerCase(),
    restoredProcessInstanceId: id("relative process").toLowerCase(),
    policies: [{ capabilityClient: client, evidencePolicy: policy, runtime }],
  }), /bounded absolute path/);
  assert.throws(() => createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: "/private/treeswap/recovery-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("wrong release host").toLowerCase(),
    restoredProcessInstanceId: id("wrong release process").toLowerCase(),
    policies: [{
      capabilityClient: client,
      evidencePolicy: evidencePolicy({ releaseRecordDigest: id("another release").toLowerCase() }),
      runtime,
    }],
  }), /another release|another evidence policy/);
  const accessorInput = {
    custodyManifestPath: "/private/treeswap/recovery-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("accessor host").toLowerCase(),
    restoredProcessInstanceId: id("accessor process").toLowerCase(),
  };
  Object.defineProperty(accessorInput, "policies", {
    enumerable: true,
    get: () => [{ capabilityClient: client, evidencePolicy: policy, runtime }],
  });
  assert.throws(
    () => createCoordinatorRecoveryOperatorPolicyPreparer(accessorInput),
    /enumerable data properties/,
  );
  const accessorPolicy = { ...policy };
  Object.defineProperty(accessorPolicy, "solver", {
    enumerable: true,
    get: () => SOLVER.address,
  });
  assert.throws(() => createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: "/private/treeswap/recovery-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("nested accessor host").toLowerCase(),
    restoredProcessInstanceId: id("nested accessor process").toLowerCase(),
    policies: [{ capabilityClient: client, evidencePolicy: accessorPolicy, runtime }],
  }), /enumerable data property/);
  const prototypePolicy = { ...policy };
  Object.defineProperty(prototypePolicy, "__proto__", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { solver: Wallet.createRandom().address },
  });
  assert.throws(() => createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: "/private/treeswap/recovery-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("prototype host").toLowerCase(),
    restoredProcessInstanceId: id("prototype process").toLowerCase(),
    policies: [{ capabilityClient: client, evidencePolicy: prototypePolicy, runtime }],
  }), /fields are not exact/);
  assert.equal(Object.prototype.solver, undefined);
  assert.throws(() => createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: "/private/treeswap/recovery-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("duplicate host").toLowerCase(),
    restoredProcessInstanceId: id("duplicate process").toLowerCase(),
    policies: [
      { capabilityClient: client, evidencePolicy: policy, runtime },
      { capabilityClient: client, evidencePolicy: policy, runtime },
    ],
  }), /duplicated/);
});

test("preparation is one-use and cancellation-aware, and the launcher rejects injected callbacks", async () => {
  const policy = evidencePolicy();
  const preparer = createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: "/private/treeswap/recovery-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("cancelled recovery host").toLowerCase(),
    restoredProcessInstanceId: id("cancelled recovery process").toLowerCase(),
    policies: [{ capabilityClient: await capabilityClient(), evidencePolicy: policy, runtime: recoveryRuntime(policy) }],
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(preparer({
    abortSignal: controller.signal,
    recoverySupervisor: {},
    serviceLease: {},
    store: {},
  }), /was aborted/);
  await assert.rejects(preparer({
    abortSignal: new AbortController().signal,
    recoverySupervisor: {},
    serviceLease: {},
    store: {},
  }), /one-use/);

  assert.throws(() => startCoordinatorRecoveryOperatorService({
    environment: {},
    fetchImpl: fetch,
    policyPreparer: async () => {},
    signal: null,
  }), /original same-process policy preparation/);
  const accepted = createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: "/private/treeswap/recovery-custody.json",
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("accepted recovery host").toLowerCase(),
    restoredProcessInstanceId: id("accepted recovery process").toLowerCase(),
    policies: [{
      capabilityClient: await capabilityClient(),
      evidencePolicy: policy,
      runtime: recoveryRuntime(policy),
    }],
  });
  await assert.rejects(startCoordinatorRecoveryOperatorService({
    environment: {},
    fetchImpl: fetch,
    policyPreparer: accepted,
    signal: null,
  }), /database path/);
});

test("a real service lease cannot bypass missing retained custody", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-recovery-operator-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lease = await acquireCoordinatorServiceLease(normalizeCoordinatorServiceConfig({
    COORDINATOR_DATABASE_PATH: join(root, "data", "coordinator.sqlite"),
    COORDINATOR_RUNTIME_DIRECTORY: join(root, "run"),
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "30",
  }));
  t.after(() => lease.release());
  const policy = evidencePolicy();
  const preparer = createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: join(root, "missing-custody.json"),
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("missing custody host").toLowerCase(),
    restoredProcessInstanceId: id("missing custody process").toLowerCase(),
    policies: [{ capabilityClient: await capabilityClient(), evidencePolicy: policy, runtime: recoveryRuntime(policy) }],
  });
  await assert.rejects(preparer({
    abortSignal: new AbortController().signal,
    recoverySupervisor: {},
    serviceLease: lease,
    store: {},
  }), /ENOENT|no such file/i);
});

test("inspects custody and then requires the fixed public capability endpoint before deriving jobs", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-recovery-composition-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sealedStore = await CoordinatorStore.open(join(root, "sealed.sqlite"));
  const backupPath = join(root, "sealed.backup.sqlite");
  await sealedStore.createVerifiedBackup(backupPath);
  sealedStore.close();
  const manifestPath = join(root, "custody.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "treeswap.retained-release-custody.v1",
    coordinatorSchema: "treeswap.coordinator.v9",
    createdAt: NOW,
    sealedHostInstanceId: id("composition sealed host").toLowerCase(),
    sealedProcessInstanceId: id("composition sealed process").toLowerCase(),
    coordinatorBackup: await retainedFileReference(backupPath, root),
    witnessPolicy: {
      maximumDrillAgeSeconds: 86_400,
      maximumDrillDurationSeconds: 3_600,
      minimumWitnesses: 2,
      witnesses: [
        {
          operatorId: id("composition witness one").toLowerCase(),
          organizationId: id("composition organization one").toLowerCase(),
          signer: LIGHTNING_OPERATOR.address,
        },
        {
          operatorId: id("composition witness two").toLowerCase(),
          organizationId: id("composition organization two").toLowerCase(),
          signer: SECURITY_REVIEWER.address,
        },
      ].sort((left, right) => left.operatorId.localeCompare(right.operatorId)),
    },
    releases: [],
  }, null, 2)}\n`, { mode: 0o600 });
  const lease = await acquireCoordinatorServiceLease(normalizeCoordinatorServiceConfig({
    COORDINATOR_DATABASE_PATH: join(root, "service", "coordinator.sqlite"),
    COORDINATOR_RUNTIME_DIRECTORY: join(root, "run"),
    COORDINATOR_HEARTBEAT_SECONDS: "5",
    COORDINATOR_INTEGRITY_SECONDS: "10",
    COORDINATOR_LEASE_STALE_SECONDS: "30",
  }));
  t.after(() => lease.release());
  const restoredStore = await CoordinatorStore.open(join(root, "restored.sqlite"));
  t.after(() => restoredStore.close());
  const policy = evidencePolicy();
  const preparer = createCoordinatorRecoveryOperatorPolicyPreparer({
    custodyManifestPath: manifestPath,
    releaseRecordDigest: RELEASE_RECORD_DIGEST,
    restoredHostInstanceId: id("composition restored host").toLowerCase(),
    restoredProcessInstanceId: id("composition restored process").toLowerCase(),
    policies: [{ capabilityClient: await capabilityClient(), evidencePolicy: policy, runtime: recoveryRuntime(policy) }],
  });
  await assert.rejects(preparer({
    abortSignal: new AbortController().signal,
    recoverySupervisor: {
      useActiveActivation: (callback) => callback({ activation: Object.freeze({ copied: true }) }),
    },
    serviceLease: lease,
    store: restoredStore,
  }), (error) => error?.code === "TRANSPORT_FAILED");
});
