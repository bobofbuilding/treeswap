import { createPublicKey } from "node:crypto";
import { getAddress } from "ethers";
import {
  fixedLightningAdapterHttpsRequest,
  privateLightningAdapterOrigin,
} from "./coordinator-action-runner.mjs";
import {
  fixedEvmRpcHttpsRequest,
  productionEvmRpcUrl,
} from "./evm-action-runner.mjs";
import { startCoordinatorActiveExecutionService } from "./coordinator-active-execution-service.mjs";
import { prepareCoordinatorActiveExecutionPolicySet } from "./coordinator-active-execution-policy.mjs";
import {
  isAuthenticatedLightningCapacityReader,
  isFinalizedBitVaultInventoryReader,
  isProductionAuthenticatedLightningCapacityReader,
} from "./solver-capacity-readers.mjs";
import {
  isProductionSolverDaemonEvidenceControls,
  isSolverDaemonEvidenceControls,
  solverDaemonEvidenceControlsPolicyDigest,
  solverDaemonEvidenceControlsTransportMode,
} from "./solver-daemon-evidence-client.mjs";
import { solverDaemonEvidencePolicyDigest } from "./solver-daemon-evidence.mjs";
import {
  authenticatedPrivatePacketClientTransportMode,
  isAuthenticatedPrivatePacketClient,
  isProductionAuthenticatedPrivatePacketClient,
} from "./solver-daemon-runtime.mjs";
import {
  publicSolverEndpointOrigin,
  queryVerifiedSolverCapability,
} from "./solver-endpoint-transport.mjs";
import { verifyLndNodeSignature } from "./lnd-node-signature.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CAPABILITY_CLIENT_KEYS = Object.freeze([
  "direction",
  "endpointOrigin",
  "maximumResponseBytes",
  "policy",
  "readVerifiedBitInventory",
  "readVerifiedLightningCapacity",
  "requestTtlSeconds",
  "solverId",
  "timeoutMs",
]);
const TEST_CAPABILITY_CLIENT_KEYS = Object.freeze([
  ...CAPABILITY_CLIENT_KEYS,
  "nowSeconds",
  "randomBytesImpl",
  "requestImpl",
  "verifyLightningNodeSignature",
]);
const CAPABILITY_POLICY_KEYS = Object.freeze([
  "bitToLightningContract",
  "bitToLightningContractCodeHash",
  "chainId",
  "lightningToBitContract",
  "lightningToBitContractCodeHash",
  "maxCapabilityTtlSeconds",
  "maxCapacityObservationAgeSeconds",
  "maxClockSkewSeconds",
]);
const LIGHTNING_CONFIG_KEYS = Object.freeze([
  "adapterUrl",
  "authorizationLifetimeSeconds",
  "dispatchTimeoutMs",
  "keyId",
  "privateKey",
  "requestTimeoutMs",
  "responseKeyId",
  "responsePublicKey",
]);
const EVM_CONFIG_KEYS = Object.freeze([
  "expectedChainId",
  "expectedContract",
  "expectedContractCodeHash",
  "maximumGasCostWei",
  "reconciliationProviders",
  "requestTimeoutMs",
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

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Reflect.ownKeys(value);
  const wanted = [...expected].sort();
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const actual = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotPlainData(value, name, state = { depth: 0, counter: { value: 0 } }) {
  state.counter.value += 1;
  if (state.counter.value > 512 || state.depth > 16) {
    throw new RangeError(`${name} is outside the bounded data policy`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== "object") {
    throw new TypeError(`${name} contains an unsupported value`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
      throw new TypeError(`${name} contains an unsupported array`);
    }
    const ownKeys = Reflect.ownKeys(value);
    const expectedKeys = [...Array(value.length).keys()].map(String).concat("length");
    if (ownKeys.length !== expectedKeys.length
        || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
      throw new TypeError(`${name} array fields are not exact`);
    }
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${name}[${index}] must be an enumerable data property`);
      }
      result.push(snapshotPlainData(descriptor.value, `${name}[${index}]`, {
        depth: state.depth + 1,
        counter: state.counter,
      }));
    }
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} contains an unsupported object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} object fields are outside policy`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name}.${key} must be an enumerable data property`);
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: snapshotPlainData(descriptor.value, `${name}.${key}`, {
        depth: state.depth + 1,
        counter: state.counter,
      }),
    });
  }
  return Object.freeze(result);
}

function exactArray(value, name, minimum = 1, maximum = 32) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < minimum || value.length > maximum) {
    throw new RangeError(`${name} must contain between ${minimum} and ${maximum} entries`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = [...Array(value.length).keys()].map(String).concat("length");
  if (ownKeys.length !== expectedKeys.length
      || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return Object.freeze([...Array(value.length).keys()].map((index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name}[${index}] must be an enumerable data property`);
    }
    return descriptor.value;
  }));
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

function rpcUrl(value, name) {
  try {
    return productionEvmRpcUrl(value);
  } catch {
    throw new TypeError(`${name} must use certificate-verified HTTPS on port 443 without URL credentials or a fragment`);
  }
}

function reconciliationProvider(value, index) {
  const source = exactDataRecord(
    value,
    ["label", "rpcUrl"],
    `EVM reconciliation providers[${index}]`,
  );
  const label = String(source.label ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(label)) {
    throw new TypeError(`EVM reconciliation providers[${index}] label is invalid`);
  }
  return Object.freeze({
    label,
    rpcUrl: rpcUrl(source.rpcUrl, `EVM reconciliation providers[${index}] URL`),
    rpcRequestImpl: fixedEvmRpcHttpsRequest,
  });
}

export function createCoordinatorLightningActionConfig(input) {
  const source = exactDataRecord(
    input,
    LIGHTNING_CONFIG_KEYS,
    "coordinator Lightning action configuration",
  );
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Lightning adapter TLS certificate verification is disabled");
  }
  if (source.privateKey?.type !== "private" || source.privateKey?.asymmetricKeyType !== "ed25519") {
    throw new TypeError("coordinator Lightning action key must be a private Ed25519 key handle");
  }
  const keyId = String(source.keyId ?? "");
  if (!KEY_ID.test(keyId)) throw new TypeError("coordinator Lightning action key identifier is invalid");
  if (source.responsePublicKey?.type !== "public"
      || source.responsePublicKey?.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Lightning adapter response key must be a public Ed25519 key handle");
  }
  const responseKeyId = String(source.responseKeyId ?? "");
  if (!KEY_ID.test(responseKeyId)) throw new TypeError("Lightning adapter response key identifier is invalid");
  const requestKeyDer = createPublicKey(source.privateKey).export({ format: "der", type: "spki" });
  const responseKeyDer = source.responsePublicKey.export({ format: "der", type: "spki" });
  if (requestKeyDer.equals(responseKeyDer)) {
    throw new Error("Lightning request and adapter response keys must be separate");
  }
  const config = Object.freeze({
    privateKey: source.privateKey,
    keyId,
    responsePublicKey: source.responsePublicKey,
    responseKeyId,
    adapterUrl: privateLightningAdapterOrigin(source.adapterUrl),
    authorizationLifetimeSeconds: boundedInteger(
      source.authorizationLifetimeSeconds,
      1,
      30,
      "coordinator Lightning authorization lifetime",
    ),
    requestImpl: fixedLightningAdapterHttpsRequest,
    dispatchTimeoutMs: boundedInteger(
      source.dispatchTimeoutMs,
      1_000,
      120_000,
      "coordinator Lightning dispatch timeout",
    ),
    requestTimeoutMs: boundedInteger(
      source.requestTimeoutMs,
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
  const source = exactDataRecord(input, EVM_CONFIG_KEYS, "coordinator EVM action configuration");
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("EVM RPC TLS certificate verification is disabled");
  }
  if (!source.signer || typeof source.signer !== "object"
      || typeof source.signer.getAddress !== "function" || typeof source.signer.signTransaction !== "function") {
    throw new TypeError("coordinator EVM claim signer is invalid");
  }
  const providers = Object.freeze(exactArray(
    source.reconciliationProviders,
    "coordinator EVM reconciliation providers",
    2,
    2,
  ).map(reconciliationProvider));
  if (providers[0].label === providers[1].label
      || new URL(providers[0].rpcUrl).origin === new URL(providers[1].rpcUrl).origin) {
    throw new Error("coordinator EVM reconciliation providers must have distinct labels and origins");
  }
  const config = Object.freeze({
    signer: source.signer,
    expectedChainId: uint(source.expectedChainId, "coordinator EVM expected chain", { nonzero: true }),
    expectedContract: address(source.expectedContract, "coordinator EVM expected contract"),
    expectedContractCodeHash: bytes32(
      source.expectedContractCodeHash,
      "coordinator EVM expected contract code hash",
    ),
    maximumGasCostWei: uint(source.maximumGasCostWei, "coordinator EVM maximum gas cost", { nonzero: true }),
    rpcUrl: rpcUrl(source.rpcUrl, "coordinator EVM broadcast URL"),
    rpcRequestImpl: fixedEvmRpcHttpsRequest,
    reconciliationProviders: providers,
    requestTimeoutMs: boundedInteger(
      source.requestTimeoutMs,
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
  const source = exactDataRecord(input, RUNTIME_KEYS, "coordinator active operator runtime");
  if (!isAuthenticatedPrivatePacketClient(source.packetClient)) {
    throw new TypeError("active operator runtime requires the concrete authenticated private-packet client");
  }
  if (authenticatedPrivatePacketClientTransportMode(source.packetClient) !== "fixed-node-https"
      || !isProductionAuthenticatedPrivatePacketClient(source.packetClient)) {
    throw new TypeError("active operator runtime requires the fixed Node HTTPS private-packet transport");
  }
  if (!isSolverDaemonEvidenceControls(source.controls)) {
    throw new TypeError("active operator runtime requires the concrete dual-route evidence controls");
  }
  if (solverDaemonEvidenceControlsTransportMode(source.controls) !== "fixed-node-https"
      || !isProductionSolverDaemonEvidenceControls(source.controls)) {
    throw new TypeError("active operator runtime requires the fixed Node HTTPS evidence transport");
  }
  if (!lightningConfigs.has(source.lightning)) {
    throw new TypeError("active operator runtime requires the concrete Lightning action configuration");
  }
  if (!evmConfigs.has(source.evm)) {
    throw new TypeError("active operator runtime requires the concrete EVM action configuration");
  }
  const runtime = Object.freeze({
    packetClient: source.packetClient,
    controls: source.controls,
    lightning: source.lightning,
    evm: source.evm,
  });
  operatorRuntimes.add(runtime);
  return runtime;
}

function createCapabilityClient(source, transportMode) {
  const policy = exactDataRecord(
    snapshotPlainData(source.policy, "solver capability client policy"),
    CAPABILITY_POLICY_KEYS,
    "solver capability client policy",
  );
  const direction = String(source.direction ?? "");
  if (!DIRECTIONS.has(direction)) throw new RangeError("solver capability client direction is unsupported");
  if (!isFinalizedBitVaultInventoryReader(source.readVerifiedBitInventory)) {
    throw new TypeError("solver capability client requires the concrete finalized BIT inventory reader");
  }
  if (!isAuthenticatedLightningCapacityReader(source.readVerifiedLightningCapacity)) {
    throw new TypeError("solver capability client requires the concrete authenticated Lightning capacity reader");
  }
  if (transportMode === "fixed-node-https"
      && !isProductionAuthenticatedLightningCapacityReader(source.readVerifiedLightningCapacity)) {
    throw new TypeError("production solver capability client requires the fixed Node HTTPS Lightning capacity reader");
  }
  const descriptor = Object.freeze({
    endpointOrigin: publicSolverEndpointOrigin(source.endpointOrigin),
    solverId: address(source.solverId, "solver capability client solver"),
    direction,
    policy,
    readVerifiedBitInventory: source.readVerifiedBitInventory,
    readVerifiedLightningCapacity: source.readVerifiedLightningCapacity,
    requestTtlSeconds: boundedInteger(
      source.requestTtlSeconds,
      1,
      30,
      "solver capability client request lifetime",
    ),
    timeoutMs: boundedInteger(source.timeoutMs, 1, 30_000, "solver capability client timeout"),
    maximumResponseBytes: boundedInteger(
      source.maximumResponseBytes,
      1_024,
      262_144,
      "solver capability client response limit",
    ),
    transportMode,
  });
  const client = Object.freeze({
    read: ({ signal }) => {
      const query = {
        direction: descriptor.direction,
        endpointOrigin: descriptor.endpointOrigin,
        maximumResponseBytes: descriptor.maximumResponseBytes,
        policy: descriptor.policy,
        readVerifiedBitInventory: descriptor.readVerifiedBitInventory,
        readVerifiedLightningCapacity: descriptor.readVerifiedLightningCapacity,
        requestTtlSeconds: descriptor.requestTtlSeconds,
        signal,
        solverId: descriptor.solverId,
        timeoutMs: descriptor.timeoutMs,
      };
      if (transportMode === "fixed-node-https") {
        return queryVerifiedSolverCapability({
          ...query,
          verifyLightningNodeSignature: verifyLndNodeSignature,
        });
      }
      return queryVerifiedSolverCapability({
        ...query,
        nowSeconds: source.nowSeconds,
        randomBytesImpl: source.randomBytesImpl,
        requestImpl: source.requestImpl,
        verifyLightningNodeSignature: source.verifyLightningNodeSignature,
      });
    },
  });
  capabilityClients.set(client, descriptor);
  return client;
}

export function createSolverCapabilityClient(input) {
  const source = exactDataRecord(input, CAPABILITY_CLIENT_KEYS, "solver capability client");
  return createCapabilityClient(source, "fixed-node-https");
}

export function createTestSolverCapabilityClient(input) {
  const source = exactDataRecord(input, TEST_CAPABILITY_CLIENT_KEYS, "test solver capability client");
  if (typeof source.verifyLightningNodeSignature !== "function") {
    throw new TypeError("test solver capability client Lightning node verifier is required");
  }
  if (source.requestImpl !== null && typeof source.requestImpl !== "function") {
    throw new TypeError("test solver capability client request implementation is invalid");
  }
  if (typeof source.nowSeconds !== "function" || typeof source.randomBytesImpl !== "function") {
    throw new TypeError("test solver capability client clock and entropy source are required");
  }
  return createCapabilityClient(source, "injected-test");
}

export function isSolverCapabilityClient(value) {
  return Boolean(value && capabilityClients.has(value));
}

export function isProductionSolverCapabilityClient(value) {
  return capabilityClients.get(value)?.transportMode === "fixed-node-https";
}

export function solverCapabilityClientTransportMode(value) {
  const mode = capabilityClients.get(value)?.transportMode;
  if (!mode) throw new TypeError("solver capability client lacks factory provenance");
  return mode;
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
  const source = exactDataRecord(input, ["policies"], "coordinator active operator policy preparer");
  const policies = Object.freeze(exactArray(source.policies, "active operator policies").map((entry, index) => {
    const policySource = exactDataRecord(entry, POLICY_KEYS, `active operator policies[${index}]`);
    const descriptor = capabilityClients.get(policySource.capabilityClient);
    if (!descriptor) throw new TypeError("active operator policy requires the concrete solver capability client");
    if (descriptor.transportMode !== "fixed-node-https") {
      throw new TypeError("active operator policy requires the fixed Node HTTPS solver capability client");
    }
    if (!operatorRuntimes.has(policySource.runtime)) {
      throw new TypeError("active operator policy requires the concrete complete action runtime");
    }
    const evidencePolicy = snapshotPlainData(
      policySource.evidencePolicy,
      `active operator policies[${index}].evidencePolicy`,
    );
    const evidencePolicyDigest = solverDaemonEvidencePolicyDigest(evidencePolicy);
    if (solverDaemonEvidenceControlsPolicyDigest(policySource.runtime.controls) !== evidencePolicyDigest) {
      throw new Error("active operator evidence controls are bound to another evidence policy");
    }
    if (address(evidencePolicy.solver, "active operator evidence solver") !== descriptor.solverId
        || evidencePolicy.direction !== descriptor.direction) {
      throw new Error("active operator evidence policy differs from its solver capability client");
    }
    return Object.freeze({
      capabilityClient: policySource.capabilityClient,
      evidencePolicy,
      runtime: policySource.runtime,
    });
  }));
  let started = false;
  const prepare = async (preparationInput) => {
    const preparation = exactDataRecord(
      preparationInput,
      PREPARATION_KEYS,
      "coordinator active operator preparation",
    );
    if (started) throw new Error("coordinator active operator policy preparation is one-use");
    started = true;
    const externalSignal = abortSignal(preparation.abortSignal);
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
        releaseSupervisor: preparation.releaseSupervisor,
        serviceLease: preparation.serviceLease,
        store: preparation.store,
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
  const source = exactDataRecord(input, SERVICE_KEYS, "coordinator active operator service");
  if (!isCoordinatorActiveOperatorPolicyPreparer(source.policyPreparer)) {
    throw new TypeError("active operator service requires original same-process policy preparation");
  }
  return startCoordinatorActiveExecutionService({
    environment: source.environment,
    fetchImpl: source.fetchImpl,
    prepareExecutionPolicySet: source.policyPreparer,
    signal: source.signal,
  });
}
