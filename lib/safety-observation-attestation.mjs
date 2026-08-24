import {
  getAddress,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";

export const REQUIRED_SAFETY_CHECKS = Object.freeze([
  "asset-reconciliation",
  "audit-pipeline",
  "bit-contract",
  "ethereum-finality",
  "evm-provider-quorum",
  "lightning-node",
  "price-quorum",
  "solver-capacity",
]);

export const SAFETY_MONITOR_POLICY_SCHEMA = "treeswap.safety-monitor-policy.v2";
export const SAFETY_OBSERVATION_SCHEMA = "treeswap.safety-observation-attestation.v2";
export const REQUIRED_SAFETY_COLLECTORS_PER_DOMAIN = 2;
export const MAXIMUM_SAFETY_MONITOR_POLICY_LIFETIME_SECONDS = 604_800;
export const MAXIMUM_SAFETY_OBSERVATION_AGE_SECONDS = 300;

const BYTES32 = /^0x[0-9a-f]{64}$/;
const DECIMAL_CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const verifiedObservations = new WeakMap();

export const SAFETY_OBSERVATION_TYPES = Object.freeze({
  SafetyObservation: Object.freeze([
    Object.freeze({ name: "releaseRecordDigest", type: "bytes32" }),
    Object.freeze({ name: "monitorPolicyDigest", type: "bytes32" }),
    Object.freeze({ name: "collectorId", type: "bytes32" }),
    Object.freeze({ name: "kind", type: "string" }),
    Object.freeze({ name: "status", type: "string" }),
    Object.freeze({ name: "observedAt", type: "uint64" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
    Object.freeze({ name: "evidenceDigest", type: "bytes32" }),
  ]),
});

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function digest(value, name) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || normalized === ZERO_DIGEST) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return normalized;
}

function address(value, name) {
  try {
    const normalized = getAddress(value);
    if (BigInt(normalized) === 0n) throw new TypeError();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe-integer timestamp`);
  }
  return value;
}

function duration(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer at or below ${maximum}`);
  }
  return value;
}

function normalizePolicy(raw) {
  exactKeys(raw, [
    "chainId",
    "collectors",
    "maximumObservationAgeSeconds",
    "releaseRecordDigest",
    "schema",
    "validFrom",
    "validUntil",
    "verifyingContract",
  ], "safety monitor policy");
  if (raw.schema !== SAFETY_MONITOR_POLICY_SCHEMA) throw new TypeError("safety monitor policy schema is invalid");
  const chainId = String(raw.chainId ?? "");
  if (!DECIMAL_CHAIN_ID.test(chainId) || BigInt(chainId) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("safety monitor policy chainId is invalid");
  }
  const validFrom = timestamp(raw.validFrom, "safety monitor policy validFrom");
  const validUntil = timestamp(raw.validUntil, "safety monitor policy validUntil");
  if (validUntil <= validFrom
      || validUntil - validFrom > MAXIMUM_SAFETY_MONITOR_POLICY_LIFETIME_SECONDS) {
    throw new RangeError("safety monitor policy lifetime is invalid");
  }
  const maximumObservationAgeSeconds = duration(
    raw.maximumObservationAgeSeconds,
    "safety monitor maximum observation age",
    MAXIMUM_SAFETY_OBSERVATION_AGE_SECONDS,
  );
  if (!Array.isArray(raw.collectors)
      || raw.collectors.length !== REQUIRED_SAFETY_CHECKS.length * REQUIRED_SAFETY_COLLECTORS_PER_DOMAIN) {
    throw new TypeError("safety monitor policy requires exactly two collectors per safety domain");
  }
  const collectors = raw.collectors.map((collector, index) => {
    exactKeys(collector, ["collectorId", "kind", "operatorId", "signer"], `safety monitor collector ${index}`);
    if (!REQUIRED_SAFETY_CHECKS.includes(collector.kind)) throw new TypeError("safety monitor collector kind is invalid");
    return Object.freeze({
      kind: collector.kind,
      collectorId: digest(collector.collectorId, `collector ${collector.kind} id`),
      operatorId: digest(collector.operatorId, `collector ${collector.kind} operator id`),
      signer: address(collector.signer, `collector ${collector.kind} signer`),
    });
  });
  const canonicalCollectors = [...collectors].sort((left, right) => {
    const kindDifference = REQUIRED_SAFETY_CHECKS.indexOf(left.kind) - REQUIRED_SAFETY_CHECKS.indexOf(right.kind);
    if (kindDifference) return kindDifference;
    if (left.collectorId === right.collectorId) return 0;
    return left.collectorId < right.collectorId ? -1 : 1;
  });
  if (collectors.some((collector, index) => collector !== canonicalCollectors[index])) {
    throw new Error("safety monitor collectors must be complete and canonically ordered by kind and collector id");
  }
  if (new Set(collectors.map((collector) => collector.collectorId)).size !== collectors.length
      || new Set(collectors.map((collector) => collector.signer.toLowerCase())).size !== collectors.length) {
    throw new Error("safety monitor collector identities and signers must be distinct");
  }
  for (const kind of REQUIRED_SAFETY_CHECKS) {
    const domainCollectors = collectors.filter((collector) => collector.kind === kind);
    if (domainCollectors.length !== REQUIRED_SAFETY_COLLECTORS_PER_DOMAIN) {
      throw new Error("safety monitor policy must bind exactly two collectors to every safety domain");
    }
    if (new Set(domainCollectors.map((collector) => collector.operatorId)).size
        !== REQUIRED_SAFETY_COLLECTORS_PER_DOMAIN) {
      throw new Error("safety monitor collectors for each domain must have distinct operator commitments");
    }
  }
  return Object.freeze({
    schema: SAFETY_MONITOR_POLICY_SCHEMA,
    chainId,
    verifyingContract: address(raw.verifyingContract, "safety monitor verifying contract"),
    releaseRecordDigest: digest(raw.releaseRecordDigest, "safety monitor release record digest"),
    validFrom,
    validUntil,
    maximumObservationAgeSeconds,
    collectors: Object.freeze(collectors),
  });
}

function normalizeObservation(raw, policy, policyDigest) {
  exactKeys(raw, [
    "collectorId",
    "evidenceDigest",
    "kind",
    "monitorPolicyDigest",
    "observedAt",
    "releaseRecordDigest",
    "schema",
    "status",
    "validUntil",
  ], "safety observation");
  if (raw.schema !== SAFETY_OBSERVATION_SCHEMA) throw new TypeError("safety observation schema is invalid");
  if (!REQUIRED_SAFETY_CHECKS.includes(raw.kind)) throw new TypeError("safety observation kind is invalid");
  if (raw.status !== "healthy" && raw.status !== "unsafe") throw new TypeError("safety observation status is invalid");
  const observedAt = timestamp(raw.observedAt, "safety observation observedAt");
  const validUntil = timestamp(raw.validUntil, "safety observation validUntil");
  if (validUntil <= observedAt
      || validUntil - observedAt > policy.maximumObservationAgeSeconds
      || observedAt < policy.validFrom
      || validUntil > policy.validUntil) {
    throw new RangeError("safety observation validity is outside policy");
  }
  const collectorId = digest(raw.collectorId, "safety observation collector id");
  const collector = policy.collectors.find((candidate) => candidate.collectorId === collectorId);
  if (!collector || collector.kind !== raw.kind) {
    throw new Error("safety observation collector is not configured for the claimed domain");
  }
  const normalized = Object.freeze({
    schema: SAFETY_OBSERVATION_SCHEMA,
    releaseRecordDigest: digest(raw.releaseRecordDigest, "safety observation release record digest"),
    monitorPolicyDigest: digest(raw.monitorPolicyDigest, "safety observation policy digest"),
    collectorId,
    kind: raw.kind,
    status: raw.status,
    observedAt,
    validUntil,
    evidenceDigest: digest(raw.evidenceDigest, "safety observation evidence digest"),
  });
  if (normalized.releaseRecordDigest !== policy.releaseRecordDigest
      || normalized.monitorPolicyDigest !== policyDigest
      || normalized.collectorId !== collector.collectorId) {
    throw new Error("safety observation is not bound to the configured policy and collector");
  }
  return { normalized, collector };
}

export function safetyMonitorPolicyDigest(policy) {
  return hash(normalizePolicy(policy));
}

export function prepareSafetyObservation({
  policy: rawPolicy,
  expectedPolicyDigest,
  collectorId,
  kind,
  status,
  observedAt,
  validUntil,
  evidenceDigest,
}) {
  const policy = normalizePolicy(rawPolicy);
  const policyDigest = safetyMonitorPolicyDigest(policy);
  if (policyDigest !== digest(expectedPolicyDigest, "expected safety monitor policy digest")) {
    throw new Error("safety monitor policy digest does not match the release-bound configuration");
  }
  const normalizedCollectorId = digest(collectorId, "safety observation collector id");
  const collector = policy.collectors.find((candidate) => candidate.collectorId === normalizedCollectorId);
  if (!collector || collector.kind !== kind) {
    throw new TypeError("safety observation collector is not configured for the requested domain");
  }
  const { normalized } = normalizeObservation({
    schema: SAFETY_OBSERVATION_SCHEMA,
    releaseRecordDigest: policy.releaseRecordDigest,
    monitorPolicyDigest: policyDigest,
    collectorId: collector.collectorId,
    kind,
    status,
    observedAt,
    validUntil,
    evidenceDigest,
  }, policy, policyDigest);
  return Object.freeze({
    domain: Object.freeze({
      name: "TreeSwap Safety Observation",
      version: "2",
      chainId: BigInt(policy.chainId),
      verifyingContract: policy.verifyingContract,
    }),
    types: SAFETY_OBSERVATION_TYPES,
    primaryType: "SafetyObservation",
    message: normalized,
    expectedSigner: collector.signer,
  });
}

export function verifySafetyObservationAttestation({
  policy: rawPolicy,
  expectedPolicyDigest,
  attestation,
  now,
  maximumClockSkewSeconds = 0,
}) {
  exactKeys(attestation, [
    "collectorId",
    "evidenceDigest",
    "kind",
    "monitorPolicyDigest",
    "observedAt",
    "releaseRecordDigest",
    "schema",
    "signature",
    "status",
    "validUntil",
  ], "signed safety observation");
  const policy = normalizePolicy(rawPolicy);
  const policyDigest = safetyMonitorPolicyDigest(policy);
  if (policyDigest !== digest(expectedPolicyDigest, "expected safety monitor policy digest")) {
    throw new Error("safety monitor policy digest does not match the release-bound configuration");
  }
  const verifiedAt = timestamp(now, "safety observation verification time");
  if (!Number.isSafeInteger(maximumClockSkewSeconds)
      || maximumClockSkewSeconds < 0
      || maximumClockSkewSeconds > policy.maximumObservationAgeSeconds) {
    throw new RangeError("safety observation clock skew is invalid");
  }
  if (verifiedAt < policy.validFrom || verifiedAt >= policy.validUntil) {
    throw new Error("safety monitor policy is not active at verification time");
  }
  const { signature, ...rawObservation } = attestation;
  const { normalized, collector } = normalizeObservation(rawObservation, policy, policyDigest);
  if (normalized.observedAt > verifiedAt + maximumClockSkewSeconds) {
    throw new Error("safety observation is from the future");
  }
  if (normalized.validUntil <= verifiedAt) throw new Error("safety observation is expired");
  let signer;
  try {
    signer = verifyTypedData({
      name: "TreeSwap Safety Observation",
      version: "2",
      chainId: BigInt(policy.chainId),
      verifyingContract: policy.verifyingContract,
    }, SAFETY_OBSERVATION_TYPES, normalized, signature);
  } catch {
    throw new TypeError("safety observation signature is invalid");
  }
  if (signer !== collector.signer) throw new Error("safety observation signer is not the configured collector");
  const observation = Object.freeze({
    collectorId: normalized.collectorId,
    kind: normalized.kind,
    status: normalized.status,
    observedAt: normalized.observedAt,
    evidenceDigest: normalized.evidenceDigest,
  });
  verifiedObservations.set(observation, Object.freeze({
    policyDigest,
    releaseRecordDigest: policy.releaseRecordDigest,
    validUntil: normalized.validUntil,
    maximumObservationAgeSeconds: policy.maximumObservationAgeSeconds,
    collectorId: collector.collectorId,
    operatorId: collector.operatorId,
    signer: collector.signer,
  }));
  return observation;
}

export function verifiedSafetyObservationBinding(observation) {
  const binding = verifiedObservations.get(observation);
  if (!binding) throw new TypeError("safety observation lacks same-process signature provenance");
  return binding;
}
