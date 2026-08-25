import { getAddress } from "ethers";
import { startCoordinatorActiveExecutionService } from "./coordinator-active-execution-service.mjs";
import { prepareCoordinatorActiveExecutionPolicySet } from "./coordinator-active-execution-policy.mjs";
import { isPrivateLndHostname } from "./lnd-rest-client.mjs";
import {
  isAuthenticatedLightningCapacityReader,
  isFinalizedBitVaultInventoryReader,
} from "./solver-capacity-readers.mjs";
import {
  isSolverDaemonEvidenceControls,
  solverDaemonEvidenceControlsPolicyDigest,
  solverDaemonEvidenceControlsTransportMode,
} from "./solver-daemon-evidence-client.mjs";
import { solverDaemonEvidencePolicyDigest } from "./solver-daemon-evidence.mjs";
import {
  authenticatedPrivatePacketClientTransportMode,
  isAuthenticatedPrivatePacketClient,
} from "./solver-daemon-runtime.mjs";
import {
  publicSolverEndpointOrigin,
  queryVerifiedSolverCapability,
} from "./solver-endpoint-transport.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CAPABILITY_CLIENT_KEYS = Object.freeze([
  "direction",
  "endpointOrigin",
  "maximumResponseBytes",
  "nowSeconds",
  "policy",
  "randomBytesImpl",
  "readVerifiedBitInventory",
  "readVerifiedLightningCapacity",
  "requestImpl",
  "requestTtlSeconds",
  "solverId",
  "timeoutMs",
  "verifyLightningNodeSignature",
]);
const LIGHTNING_CONFIG_KEYS = Object.freeze([
  "adapterUrl",
  "authorizationLifetimeSeconds",
  "dispatchTimeoutMs",
  "keyId",
  "privateKey",
  "requestImpl",
  "requestTimeoutMs",
]);
const EVM_CONFIG_KEYS = Object.freeze([
  "expectedChainId",
  "expectedContract",
  "expectedContractCodeHash",
  "maximumGasCostWei",
  "reconciliationProviders",
  "requestTimeoutMs",
  "rpcRequestImpl",
  "rpcUrl",
  "signer",
]);
const RUNTIME_KEYS = Object.freeze(["controls", "evm", "lightning", "packetClient"]);
const POLICY_KEYS = Object.freeze(["capabilityClient", "evidencePolicy", "runtime"]);
const PREPARATION_KEYS = Object.freeze(["abortSignal", "releaseSupervisor", "serviceLease", "store"]);
const SERVICE_KEYS = Object.freeze(["environment", "fetchImpl", "policyPreparer", "signal"]);
const capabilityClients = new WeakMap();
const lightningConfigs = new WeakSet();
const evmConfigs = new WeakSet();
const operatorRuntimes = new WeakSet();
const policyPreparers = new WeakSet();

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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside policy`);
  }
  return value;
}

function address(value, name) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function uint(value, name, { nonzero = false } = {}) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${name} must be an unsigned integer`);
  }
  if (parsed < 0n || parsed >= (1n << 256n) || (nonzero && parsed === 0n)) {
    throw new RangeError(`${name} is outside policy`);
  }
  return parsed.toString();
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function abortSignal(value) {
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean"
      || typeof value.addEventListener !== "function" || typeof value.removeEventListener !== "function") {
    throw new TypeError("operator policy preparation abort signal is invalid");
  }
  return value;
}

function privateAdapterOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Lightning adapter URL is invalid");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "") || !isPrivateLndHostname(url.hostname)) {
    throw new TypeError("Lightning adapter URL must be one credential-free private HTTP origin");
  }
  return url.origin;
}

function rpcUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.username || url.password || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new TypeError(`${name} must use HTTPS except on loopback and contain no URL credentials or fragment`);
  }
  return url.toString();
}

function reconciliationProvider(value, index) {
  exactKeys(value, ["label", "rpcRequestImpl", "rpcUrl"], `EVM reconciliation providers[${index}]`);
  const label = String(value.label ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(label)) {
    throw new TypeError(`EVM reconciliation providers[${index}] label is invalid`);
  }
  if (typeof value.rpcRequestImpl !== "function") {
    throw new TypeError(`EVM reconciliation providers[${index}] request implementation is invalid`);
  }
  return Object.freeze({
    label,
    rpcUrl: rpcUrl(value.rpcUrl, `EVM reconciliation providers[${index}] URL`),
    rpcRequestImpl: value.rpcRequestImpl,
  });
}

export function createCoordinatorLightningActionConfig(input) {
  exactKeys(input, LIGHTNING_CONFIG_KEYS, "coordinator Lightning action configuration");
  if (input.privateKey?.type !== "private" || input.privateKey?.asymmetricKeyType !== "ed25519") {
    throw new TypeError("coordinator Lightning action key must be a private Ed25519 key handle");
  }
  const keyId = String(input.keyId ?? "");
  if (!KEY_ID.test(keyId)) throw new TypeError("coordinator Lightning action key identifier is invalid");
  if (typeof input.requestImpl !== "function") {
    throw new TypeError("coordinator Lightning adapter request implementation is required");
  }
  const config = Object.freeze({
    privateKey: input.privateKey,
    keyId,
    adapterUrl: privateAdapterOrigin(input.adapterUrl),
    authorizationLifetimeSeconds: boundedInteger(
      input.authorizationLifetimeSeconds,
      1,
      30,
      "coordinator Lightning authorization lifetime",
    ),
    requestImpl: input.requestImpl,
    dispatchTimeoutMs: boundedInteger(
      input.dispatchTimeoutMs,
      1_000,
      120_000,
      "coordinator Lightning dispatch timeout",
    ),
    requestTimeoutMs: boundedInteger(
      input.requestTimeoutMs,
      1_000,
      30_000,
      "coordinator Lightning reconciliation timeout",
    ),
  });
  lightningConfigs.add(config);
  return config;
}

export function isCoordinatorLightningActionConfig(value) {
  return Boolean(value && lightningConfigs.has(value));
}

export function createCoordinatorEvmActionConfig(input) {
  exactKeys(input, EVM_CONFIG_KEYS, "coordinator EVM action configuration");
  if (!input.signer || typeof input.signer !== "object"
      || typeof input.signer.getAddress !== "function" || typeof input.signer.signTransaction !== "function") {
    throw new TypeError("coordinator EVM claim signer is invalid");
  }
  if (typeof input.rpcRequestImpl !== "function") {
    throw new TypeError("coordinator EVM broadcast request implementation is required");
  }
  if (!Array.isArray(input.reconciliationProviders) || input.reconciliationProviders.length !== 2) {
    throw new TypeError("coordinator EVM action configuration requires exactly two reconciliation providers");
  }
  const providers = Object.freeze(input.reconciliationProviders.map(reconciliationProvider));
  if (providers[0].label === providers[1].label
      || new URL(providers[0].rpcUrl).origin === new URL(providers[1].rpcUrl).origin
      || providers[0].rpcRequestImpl === providers[1].rpcRequestImpl) {
    throw new Error("coordinator EVM reconciliation providers must have distinct labels, origins, and clients");
  }
  const config = Object.freeze({
    signer: input.signer,
    expectedChainId: uint(input.expectedChainId, "coordinator EVM expected chain", { nonzero: true }),
    expectedContract: address(input.expectedContract, "coordinator EVM expected contract"),
    expectedContractCodeHash: bytes32(
      input.expectedContractCodeHash,
      "coordinator EVM expected contract code hash",
    ),
    maximumGasCostWei: uint(input.maximumGasCostWei, "coordinator EVM maximum gas cost", { nonzero: true }),
    rpcUrl: rpcUrl(input.rpcUrl, "coordinator EVM broadcast URL"),
    rpcRequestImpl: input.rpcRequestImpl,
    reconciliationProviders: providers,
    requestTimeoutMs: boundedInteger(
      input.requestTimeoutMs,
      1_000,
      30_000,
      "coordinator EVM request timeout",
    ),
  });
  evmConfigs.add(config);
  return config;
}

export function isCoordinatorEvmActionConfig(value) {
  return Boolean(value && evmConfigs.has(value));
}

export function createCoordinatorActiveOperatorRuntime(input) {
  exactKeys(input, RUNTIME_KEYS, "coordinator active operator runtime");
  if (!isAuthenticatedPrivatePacketClient(input.packetClient)) {
    throw new TypeError("active operator runtime requires the concrete authenticated private-packet client");
  }
  if (authenticatedPrivatePacketClientTransportMode(input.packetClient) !== "fixed-node-https") {
    throw new TypeError("active operator runtime requires the fixed Node HTTPS private-packet transport");
  }
  if (!isSolverDaemonEvidenceControls(input.controls)) {
    throw new TypeError("active operator runtime requires the concrete dual-route evidence controls");
  }
  if (solverDaemonEvidenceControlsTransportMode(input.controls) !== "fixed-node-https") {
    throw new TypeError("active operator runtime requires the fixed Node HTTPS evidence transport");
  }
  if (!lightningConfigs.has(input.lightning)) {
    throw new TypeError("active operator runtime requires the concrete Lightning action configuration");
  }
  if (!evmConfigs.has(input.evm)) {
    throw new TypeError("active operator runtime requires the concrete EVM action configuration");
  }
  const runtime = Object.freeze({
    packetClient: input.packetClient,
    controls: input.controls,
    lightning: input.lightning,
    evm: input.evm,
  });
  operatorRuntimes.add(runtime);
  return runtime;
}

export function createSolverCapabilityClient(input) {
  exactKeys(input, CAPABILITY_CLIENT_KEYS, "solver capability client");
  const direction = String(input.direction ?? "");
  if (!DIRECTIONS.has(direction)) throw new RangeError("solver capability client direction is unsupported");
  if (!isFinalizedBitVaultInventoryReader(input.readVerifiedBitInventory)) {
    throw new TypeError("solver capability client requires the concrete finalized BIT inventory reader");
  }
  if (!isAuthenticatedLightningCapacityReader(input.readVerifiedLightningCapacity)) {
    throw new TypeError("solver capability client requires the concrete authenticated Lightning capacity reader");
  }
  if (typeof input.verifyLightningNodeSignature !== "function") {
    throw new TypeError("solver capability client Lightning node verifier is required");
  }
  if (input.requestImpl !== null && typeof input.requestImpl !== "function") {
    throw new TypeError("solver capability client request implementation is invalid");
  }
  if (typeof input.nowSeconds !== "function" || typeof input.randomBytesImpl !== "function") {
    throw new TypeError("solver capability client clock and entropy source are required");
  }
  const descriptor = Object.freeze({
    endpointOrigin: publicSolverEndpointOrigin(input.endpointOrigin),
    solverId: address(input.solverId, "solver capability client solver"),
    direction,
    policy: deepFreeze(structuredClone(input.policy)),
    verifyLightningNodeSignature: input.verifyLightningNodeSignature,
    readVerifiedBitInventory: input.readVerifiedBitInventory,
    readVerifiedLightningCapacity: input.readVerifiedLightningCapacity,
    requestImpl: input.requestImpl,
    nowSeconds: input.nowSeconds,
    randomBytesImpl: input.randomBytesImpl,
    requestTtlSeconds: boundedInteger(
      input.requestTtlSeconds,
      1,
      30,
      "solver capability client request lifetime",
    ),
    timeoutMs: boundedInteger(input.timeoutMs, 1, 30_000, "solver capability client timeout"),
    maximumResponseBytes: boundedInteger(
      input.maximumResponseBytes,
      1_024,
      262_144,
      "solver capability client response limit",
    ),
  });
  const client = Object.freeze({
    read: ({ signal }) => queryVerifiedSolverCapability({
      ...descriptor,
      signal,
    }),
  });
  capabilityClients.set(client, descriptor);
  return client;
}

export function isSolverCapabilityClient(value) {
  return Boolean(value && capabilityClients.has(value));
}

function assertRuntimeBinding(runtime, verification) {
  const binding = verification?.binding;
  if (!binding || runtime.evm.expectedChainId !== String(binding.chainId)
      || runtime.evm.expectedContract !== String(binding.settlementContract).toLowerCase()
      || runtime.evm.expectedContractCodeHash !== binding.settlementContractCodeHash) {
    throw new Error("active operator runtime EVM binding differs from the fresh solver capability");
  }
}

export function createCoordinatorActiveOperatorPolicyPreparer(input) {
  exactKeys(input, ["policies"], "coordinator active operator policy preparer");
  if (!Array.isArray(input.policies) || input.policies.length < 1 || input.policies.length > 32) {
    throw new RangeError("active operator preparation requires between 1 and 32 solver policies");
  }
  const policies = Object.freeze(input.policies.map((entry, index) => {
    exactKeys(entry, POLICY_KEYS, `active operator policies[${index}]`);
    const descriptor = capabilityClients.get(entry.capabilityClient);
    if (!descriptor) throw new TypeError("active operator policy requires the concrete solver capability client");
    if (!operatorRuntimes.has(entry.runtime)) {
      throw new TypeError("active operator policy requires the concrete complete action runtime");
    }
    const evidencePolicy = deepFreeze(structuredClone(entry.evidencePolicy));
    const evidencePolicyDigest = solverDaemonEvidencePolicyDigest(evidencePolicy);
    if (solverDaemonEvidenceControlsPolicyDigest(entry.runtime.controls) !== evidencePolicyDigest) {
      throw new Error("active operator evidence controls are bound to another evidence policy");
    }
    if (address(evidencePolicy.solver, "active operator evidence solver") !== descriptor.solverId
        || evidencePolicy.direction !== descriptor.direction) {
      throw new Error("active operator evidence policy differs from its solver capability client");
    }
    return Object.freeze({
      capabilityClient: entry.capabilityClient,
      evidencePolicy,
      runtime: entry.runtime,
    });
  }));
  let started = false;
  const prepare = async (preparationInput) => {
    exactKeys(preparationInput, PREPARATION_KEYS, "coordinator active operator preparation");
    if (started) throw new Error("coordinator active operator policy preparation is one-use");
    started = true;
    const externalSignal = abortSignal(preparationInput.abortSignal);
    if (externalSignal.aborted) throw new Error("coordinator active operator policy preparation was aborted");
    const controller = new AbortController();
    const signal = AbortSignal.any([externalSignal, controller.signal]);
    try {
      const executionPolicies = await Promise.all(policies.map(async (policy) => {
        const solverCapabilityVerification = await policy.capabilityClient.read({ signal });
        if (signal.aborted) throw new Error("coordinator active operator policy preparation was aborted");
        assertRuntimeBinding(policy.runtime, solverCapabilityVerification);
        return Object.freeze({
          solverCapabilityVerification,
          evidencePolicy: policy.evidencePolicy,
          runtime: policy.runtime,
        });
      }));
      if (signal.aborted) throw new Error("coordinator active operator policy preparation was aborted");
      const prepared = await prepareCoordinatorActiveExecutionPolicySet({
        executionPolicies,
        releaseSupervisor: preparationInput.releaseSupervisor,
        serviceLease: preparationInput.serviceLease,
        store: preparationInput.store,
      });
      if (signal.aborted) throw new Error("coordinator active operator policy preparation was aborted");
      return prepared;
    } finally {
      controller.abort();
    }
  };
  policyPreparers.add(prepare);
  return prepare;
}

export function isCoordinatorActiveOperatorPolicyPreparer(value) {
  return Boolean(value && policyPreparers.has(value));
}

export function startCoordinatorActiveOperatorService(input) {
  exactKeys(input, SERVICE_KEYS, "coordinator active operator service");
  if (!isCoordinatorActiveOperatorPolicyPreparer(input.policyPreparer)) {
    throw new TypeError("active operator service requires original same-process policy preparation");
  }
  return startCoordinatorActiveExecutionService({
    environment: input.environment,
    fetchImpl: input.fetchImpl,
    prepareExecutionPolicySet: input.policyPreparer,
    signal: input.signal,
  });
}
