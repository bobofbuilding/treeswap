import { createActiveSolverDaemonContext, verifiedActiveSolverDaemonContext } from "./capabilities.mjs";
import { assertCoordinatorServiceLeaseOwnership } from "./coordinator-service-state.mjs";
import { CoordinatorStore, coordinatorCommitmentDigest, isVerifiedCoordinatorStore } from "./coordinator-store.mjs";
import { isCoordinatorReleaseVerificationSupervisor } from "./coordinator-release-supervisor.mjs";
import { isSolverDaemonEvidenceControls } from "./solver-daemon-evidence-client.mjs";
import {
  snapshotCoordinatorActiveRuntime,
  snapshotCoordinatorActiveEvidencePolicy,
} from "./coordinator-recovery-job.mjs";

export const COORDINATOR_ACTIVE_EXECUTION_POLICY_SET_SCHEMA =
  "treeswap.coordinator-active-execution-policy-set.v2";

const POLICY_KEYS = Object.freeze([
  "evidencePolicy",
  "runtime",
  "solverCapabilityVerification",
]);
const PREPARATION_KEYS = Object.freeze([
  "executionPolicies",
  "releaseSupervisor",
  "serviceLease",
  "store",
]);
const ORIGINAL_STORE_METHODS = Object.freeze({
  getFirmOffer: CoordinatorStore.prototype.getFirmOffer,
  getSettlement: CoordinatorStore.prototype.getSettlement,
  listNonterminalSettlements: CoordinatorStore.prototype.listNonterminalSettlements,
});
const preparedPolicySets = new WeakMap();
const claimedReleaseSupervisors = new WeakMap();

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

function originalStore(store) {
  if (!isVerifiedCoordinatorStore(store)) {
    throw new TypeError("active execution policy preparation requires an original coordinator store");
  }
  for (const [name, method] of Object.entries(ORIGINAL_STORE_METHODS)) {
    if (store[name] !== method) {
      throw new TypeError("active execution policy preparation requires unmodified store discovery methods");
    }
  }
  return store;
}

function releaseSupervisor(value) {
  if (!isCoordinatorReleaseVerificationSupervisor(value)) {
    throw new TypeError("active execution requires an original same-process release supervisor");
  }
  return value;
}

function wholeSecondIso(seconds) {
  return new Date(seconds * 1_000).toISOString();
}

function policyDescriptor(binding) {
  return Object.freeze({
    capacityEpoch: binding.capacityEpoch,
    direction: binding.direction,
    evidencePolicyDigest: binding.evidencePolicyDigest,
    releaseRecordDigest: binding.releaseRecordDigest,
    riskPolicyDigest: binding.riskPolicyDigest,
    solverCapabilityDigest: binding.solverCapabilityDigest,
    solverId: binding.solverId,
  });
}

export async function prepareCoordinatorActiveExecutionPolicySet(input) {
  const source = exactDataRecord(input, PREPARATION_KEYS, "active execution policy preparation");
  const store = originalStore(source.store);
  const supervisor = releaseSupervisor(source.releaseSupervisor);
  const executionPolicies = exactArray(source.executionPolicies, "active execution policies");
  const now = Math.floor(Date.now() / 1_000);
  const verification = supervisor.status({ now });
  if (!verification || verification.state !== "active") {
    throw new Error("active execution policy preparation requires a current verified release");
  }
  await assertCoordinatorServiceLeaseOwnership(source.serviceLease);
  originalStore(store);

  const policies = executionPolicies.map((entry, index) => {
    const policySource = exactDataRecord(entry, POLICY_KEYS, `active execution policies[${index}]`);
    if (!policySource.solverCapabilityVerification
        || typeof policySource.solverCapabilityVerification !== "object") {
      throw new TypeError("active execution solver capability verification is required");
    }
    if (policySource.runtime?.controls && Object.keys(policySource.runtime.controls).length > 0
        && !isSolverDaemonEvidenceControls(policySource.runtime.controls)) {
      throw new TypeError("active execution evidence controls require the concrete dual-route client");
    }
    const evidencePolicy = snapshotCoordinatorActiveEvidencePolicy(policySource.evidencePolicy);
    const runtime = snapshotCoordinatorActiveRuntime(policySource.runtime);
    const executionContext = supervisor.useActiveActivation(({ activation }) => (
      createActiveSolverDaemonContext({
        solverCapabilityVerification: policySource.solverCapabilityVerification,
        deployment: activation.deployment,
        capabilities: activation.capabilities,
        evidencePolicy,
        now,
      })
    ), { now });
    const binding = verifiedActiveSolverDaemonContext(executionContext, {
      now,
      requireFundingAuthorization: true,
    });
    return Object.freeze({
      descriptor: policyDescriptor(binding),
      evidencePolicy,
      runtime,
      solverCapabilityVerification: policySource.solverCapabilityVerification,
    });
  }).sort((left, right) => (
    `${left.descriptor.direction}:${left.descriptor.solverId}:${left.descriptor.solverCapabilityDigest}`
      .localeCompare(`${right.descriptor.direction}:${right.descriptor.solverId}:${right.descriptor.solverCapabilityDigest}`)
  ));
  const identities = policies.map(({ descriptor }) => (
    `${descriptor.direction}:${descriptor.solverId}:${descriptor.solverCapabilityDigest}`
  ));
  if (new Set(identities).size !== identities.length) {
    throw new Error("active execution solver policies are duplicated");
  }
  if (policies.some(({ descriptor }) => descriptor.releaseRecordDigest !== verification.recordDigest)) {
    throw new Error("active execution solver policy is bound to another release");
  }
  const descriptors = Object.freeze(policies.map(({ descriptor }) => descriptor));
  const policySetDigest = coordinatorCommitmentDigest({
    schema: COORDINATOR_ACTIVE_EXECUTION_POLICY_SET_SCHEMA,
    releaseRecordDigest: verification.recordDigest,
    policies: descriptors,
  });
  const summary = Object.freeze({
    schema: COORDINATOR_ACTIVE_EXECUTION_POLICY_SET_SCHEMA,
    status: "same-process-release-solver-and-runtime-bound",
    scope: "database-derived-lightning-bit-settlements-only-no-network-job-intake",
    preparedAt: wholeSecondIso(now),
    releaseRecordDigest: verification.recordDigest,
    policySetDigest,
    policyCount: policies.length,
    authorizations: Object.freeze({
      funding: false,
      lightningDispatch: false,
      newExposure: false,
    }),
  });
  preparedPolicySets.set(summary, {
    claimed: false,
    policies: Object.freeze(policies),
    releaseSupervisor: supervisor,
    serviceLease: source.serviceLease,
    store,
  });
  return summary;
}

export function claimPreparedCoordinatorActiveExecutionPolicySet(
  preparation,
  { releaseSupervisor: expectedSupervisor, serviceLease: expectedLease, store: expectedStore },
  callback,
) {
  const prepared = preparedPolicySets.get(preparation);
  if (!prepared) throw new TypeError("active execution policy set lacks same-process preparation provenance");
  if (prepared.releaseSupervisor !== expectedSupervisor
      || prepared.serviceLease !== expectedLease || prepared.store !== expectedStore) {
    throw new TypeError("active execution policy set is bound to another supervisor, lease, or store");
  }
  if (typeof callback !== "function") throw new TypeError("active execution policy callback is required");
  originalStore(expectedStore);
  if (prepared.claimed || claimedReleaseSupervisors.has(expectedSupervisor)) {
    throw new Error("release supervisor already has an active execution lifecycle");
  }
  prepared.claimed = true;
  claimedReleaseSupervisors.set(expectedSupervisor, preparation);
  return callback(prepared.policies);
}
