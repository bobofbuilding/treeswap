import { isAbsolute, resolve } from "node:path";
import { getAddress } from "ethers";
import {
  isCoordinatorEvmActionConfig,
  isCoordinatorLightningActionConfig,
  isProductionSolverCapabilityClient,
} from "./coordinator-active-operator-policy.mjs";
import { startCoordinatorRecoveryExecutionService } from "./coordinator-recovery-execution-service.mjs";
import { assertCoordinatorServiceLeaseOwnership } from "./coordinator-service-state.mjs";
import {
  inspectRetainedReleaseCustody,
  prepareRetainedReleaseRecoveryJobSet,
  verifyRetainedReleaseRecoveryReadiness,
} from "./release-retention-custody.mjs";
import {
  isSolverDaemonRecoveryEvidenceControls,
  solverDaemonRecoveryEvidenceControlsPolicyDigest,
  solverDaemonEvidenceControlsTransportMode,
} from "./solver-daemon-evidence-client.mjs";
import { solverDaemonEvidencePolicyDigest } from "./solver-daemon-evidence.mjs";
import {
  authenticatedPrivatePacketClientTransportMode,
  isAuthenticatedPrivatePacketClient,
} from "./solver-daemon-runtime.mjs";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const RUNTIME_KEYS = Object.freeze(["controls", "evm", "lightning", "packetClient"]);
const POLICY_KEYS = Object.freeze(["capabilityClient", "evidencePolicy", "runtime"]);
const PREPARER_KEYS = Object.freeze([
  "custodyManifestPath",
  "policies",
  "releaseRecordDigest",
  "restoredHostInstanceId",
  "restoredProcessInstanceId",
]);
const PREPARATION_KEYS = Object.freeze([
  "abortSignal",
  "recoverySupervisor",
  "serviceLease",
  "store",
]);
const SERVICE_KEYS = Object.freeze(["environment", "fetchImpl", "policyPreparer", "signal"]);
const recoveryRuntimes = new WeakSet();
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
  const result = {};
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

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  return raw;
}

function address(value, name) {
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function privateManifestPath(value) {
  const raw = String(value ?? "");
  if (!isAbsolute(raw) || raw.includes("\0") || raw.length > 4_096) {
    throw new TypeError("recovery operator custody manifest path must be a bounded absolute path");
  }
  return resolve(raw);
}

function abortSignal(value) {
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean"
      || typeof value.addEventListener !== "function"
      || typeof value.removeEventListener !== "function") {
    throw new TypeError("recovery operator preparation abort signal is invalid");
  }
  return value;
}

function assertPolicyBinding(policy, runtime, verification) {
  const binding = verification?.binding;
  if (!binding
      || String(binding.chainId) !== String(policy.chainId)
      || String(binding.direction) !== String(policy.direction)
      || address(binding.solverId, "recovery capability solver")
        !== address(policy.solver, "recovery evidence solver")
      || address(binding.settlementContract, "recovery capability settlement contract")
        !== address(policy.settlementContract, "recovery evidence settlement contract")
      || binding.settlementContractCodeHash !== policy.settlementContractCodeHash
      || runtime.evm.expectedChainId !== String(binding.chainId)
      || runtime.evm.expectedContract
        !== address(binding.settlementContract, "recovery capability settlement contract")
      || runtime.evm.expectedContractCodeHash !== binding.settlementContractCodeHash) {
    throw new Error("recovery operator policy, runtime, and fresh solver capability differ");
  }
}

export function createCoordinatorRecoveryOperatorRuntime(input) {
  const source = exactDataRecord(input, RUNTIME_KEYS, "coordinator recovery operator runtime");
  if (!isAuthenticatedPrivatePacketClient(source.packetClient)) {
    throw new TypeError("recovery operator runtime requires the concrete authenticated private-packet client");
  }
  if (authenticatedPrivatePacketClientTransportMode(source.packetClient) !== "fixed-node-https") {
    throw new TypeError("recovery operator runtime requires the fixed Node HTTPS private-packet transport");
  }
  if (!isSolverDaemonRecoveryEvidenceControls(source.controls)) {
    throw new TypeError("recovery operator runtime requires recovery-only dual-route evidence controls");
  }
  if (solverDaemonEvidenceControlsTransportMode(source.controls) !== "fixed-node-https") {
    throw new TypeError("recovery operator runtime requires the fixed Node HTTPS evidence transport");
  }
  if (!isCoordinatorLightningActionConfig(source.lightning)) {
    throw new TypeError("recovery operator runtime requires the concrete Lightning action configuration");
  }
  if (!isCoordinatorEvmActionConfig(source.evm)) {
    throw new TypeError("recovery operator runtime requires the concrete EVM action configuration");
  }
  const runtime = Object.freeze({ ...source });
  recoveryRuntimes.add(runtime);
  return runtime;
}

export function isCoordinatorRecoveryOperatorRuntime(value) {
  return Boolean(value && recoveryRuntimes.has(value));
}

export function createCoordinatorRecoveryOperatorPolicyPreparer(input) {
  const source = exactDataRecord(input, PREPARER_KEYS, "coordinator recovery operator policy preparer");
  const custodyManifestPath = privateManifestPath(source.custodyManifestPath);
  const releaseRecordDigest = bytes32(source.releaseRecordDigest, "recovery operator release record digest");
  const restoredHostInstanceId = bytes32(
    source.restoredHostInstanceId,
    "recovery operator restored host instance",
  );
  const restoredProcessInstanceId = bytes32(
    source.restoredProcessInstanceId,
    "recovery operator restored process instance",
  );
  if (restoredHostInstanceId === restoredProcessInstanceId) {
    throw new Error("recovery operator restored host and process commitments must be distinct");
  }
  const policies = Object.freeze(exactArray(source.policies, "recovery operator policies").map((entry, index) => {
    const policySource = exactDataRecord(entry, POLICY_KEYS, `recovery operator policies[${index}]`);
    if (!isProductionSolverCapabilityClient(policySource.capabilityClient)) {
      throw new TypeError("recovery operator policy requires the fixed Node HTTPS solver capability client");
    }
    if (!isCoordinatorRecoveryOperatorRuntime(policySource.runtime)) {
      throw new TypeError("recovery operator policy requires the concrete recovery-only runtime");
    }
    const evidencePolicy = snapshotPlainData(
      policySource.evidencePolicy,
      `recovery operator policies[${index}].evidencePolicy`,
    );
    const evidencePolicyDigest = solverDaemonEvidencePolicyDigest(evidencePolicy);
    if (evidencePolicy.releaseRecordDigest !== releaseRecordDigest) {
      throw new Error("recovery operator evidence policy belongs to another release");
    }
    if (solverDaemonRecoveryEvidenceControlsPolicyDigest(policySource.runtime.controls)
        !== evidencePolicyDigest) {
      throw new Error("recovery operator controls are bound to another evidence policy");
    }
    if (policySource.runtime.evm.expectedChainId !== String(evidencePolicy.chainId)
        || policySource.runtime.evm.expectedContract
          !== address(evidencePolicy.settlementContract, "recovery evidence settlement contract")
        || policySource.runtime.evm.expectedContractCodeHash !== evidencePolicy.settlementContractCodeHash) {
      throw new Error("recovery operator runtime differs from its evidence policy");
    }
    return Object.freeze({
      capabilityClient: policySource.capabilityClient,
      evidencePolicy,
      evidencePolicyDigest,
      runtime: policySource.runtime,
    });
  }));
  const policyKeys = policies.map((entry) => `${entry.evidencePolicy.direction}:${entry.evidencePolicyDigest}`);
  if (new Set(policyKeys).size !== policyKeys.length) {
    throw new Error("recovery operator policies are duplicated");
  }

  let started = false;
  const prepare = async (preparationInput) => {
    const preparation = exactDataRecord(
      preparationInput,
      PREPARATION_KEYS,
      "coordinator recovery operator preparation",
    );
    if (started) throw new Error("coordinator recovery operator policy preparation is one-use");
    started = true;
    const externalSignal = abortSignal(preparation.abortSignal);
    if (externalSignal.aborted) throw new Error("coordinator recovery operator preparation was aborted");
    const controller = new AbortController();
    const signal = AbortSignal.any([externalSignal, controller.signal]);
    try {
      await assertCoordinatorServiceLeaseOwnership(preparation.serviceLease);
      const custodyVerification = await inspectRetainedReleaseCustody({ manifestPath: custodyManifestPath });
      if (signal.aborted) throw new Error("coordinator recovery operator preparation was aborted");
      await assertCoordinatorServiceLeaseOwnership(preparation.serviceLease);
      const executionPolicies = await Promise.all(policies.map(async (policy) => {
        const solverCapabilityVerification = await policy.capabilityClient.read({ signal });
        if (signal.aborted) throw new Error("coordinator recovery operator preparation was aborted");
        assertPolicyBinding(policy.evidencePolicy, policy.runtime, solverCapabilityVerification);
        return Object.freeze({
          evidencePolicy: policy.evidencePolicy,
          runtime: policy.runtime,
          solverCapabilityVerification,
        });
      }));
      if (signal.aborted) throw new Error("coordinator recovery operator preparation was aborted");
      await assertCoordinatorServiceLeaseOwnership(preparation.serviceLease);
      const now = Math.floor(Date.now() / 1_000);
      const readinessVerification = preparation.recoverySupervisor.useActiveActivation(
        ({ activation }) => verifyRetainedReleaseRecoveryReadiness({
          custodyVerification,
          releaseRecordDigest,
          recoveryActivation: activation,
          restoredStore: preparation.store,
          solverCapabilityVerifications: executionPolicies.map((entry) => (
            entry.solverCapabilityVerification
          )),
          restoredHostInstanceId,
          restoredProcessInstanceId,
          now,
        }),
        { now },
      );
      if (signal.aborted) throw new Error("coordinator recovery operator preparation was aborted");
      await assertCoordinatorServiceLeaseOwnership(preparation.serviceLease);
      const jobSetVerification = prepareRetainedReleaseRecoveryJobSet({
        readinessVerification,
        restoredStore: preparation.store,
        executionPolicies,
        now: Math.floor(Date.now() / 1_000),
      });
      if (signal.aborted) throw new Error("coordinator recovery operator preparation was aborted");
      await assertCoordinatorServiceLeaseOwnership(preparation.serviceLease);
      return jobSetVerification;
    } finally {
      controller.abort();
    }
  };
  policyPreparers.add(prepare);
  return prepare;
}

export function isCoordinatorRecoveryOperatorPolicyPreparer(value) {
  return Boolean(value && policyPreparers.has(value));
}

export function startCoordinatorRecoveryOperatorService(input) {
  const source = exactDataRecord(input, SERVICE_KEYS, "coordinator recovery operator service");
  if (!isCoordinatorRecoveryOperatorPolicyPreparer(source.policyPreparer)) {
    throw new TypeError("recovery operator service requires original same-process policy preparation");
  }
  return startCoordinatorRecoveryExecutionService({
    environment: source.environment,
    fetchImpl: source.fetchImpl,
    prepareJobSetVerification: source.policyPreparer,
    signal: source.signal,
  });
}
