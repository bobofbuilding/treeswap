import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { buildAdoptionPolicyEvidence } from "./adoption-policy.mjs";
import { buildServiceIsolationReleaseEvidence } from "./service-isolation-evidence.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL_CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const UINT64_MAX = (1n << 64n) - 1n;

export const OPERATIONAL_READINESS_ROLES = Object.freeze([
  "backup-operator",
  "incident-commander",
  "lightning-operator",
  "monitoring-operator",
  "support-owner",
]);

export const REQUIRED_OPERATIONAL_DRILLS = Object.freeze([
  "alert-delivery-and-escalation",
  "backup-restore",
  "bit-implementation-change",
  "bit-pause",
  "credential-compromise",
  "evm-finality-rollback",
  "evm-provider-disagreement",
  "evm-provider-outage",
  "gate-halt-preserves-exits",
  "inventory-mismatch",
  "lnd-outage",
  "monitor-outage",
  "preimage-leak-response",
  "price-source-disagreement",
]);

const FUNDING_MODES = Object.freeze([
  "operator-testnet",
  "operator-testnet-bootstrap",
]);

const ARTIFACT_FIELDS = Object.freeze([
  "alertDelivery",
  "backupRestore",
  "incidentDrills",
  "lossAllocation",
  "monitoring",
  "privacyRetention",
  "providerQuorum",
  "reconciliation",
  "serviceIsolation",
  "solverOperations",
  "supportPolicy",
  "testQualification",
]);

const DRILL_FIELDS = Object.freeze([
  "evidenceDigest",
  "finishedAt",
  "name",
  "observerOperatorIds",
  "primaryOperatorId",
  "startedAt",
  "status",
]);

const PARTICIPANT_FIELDS = Object.freeze([
  "evidenceDigest",
  "operatorId",
  "organizationId",
  "role",
  "signer",
]);

const POLICY_FIELDS = Object.freeze([
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "fundingMode",
  "maximumDrillAgeSeconds",
  "maximumDrillDurationSeconds",
  "maximumEvidenceAgeSeconds",
  "maximumEvidenceLifetimeSeconds",
  "minimumAlertChannels",
  "minimumOrganizations",
  "protocolVersion",
  "requiredDrills",
  "reviewedBuildCommit",
  "schema",
  "verifyingContract",
]);

const RECORD_FIELDS = Object.freeze([
  "alertChannelEvidenceDigests",
  "artifacts",
  "chainId",
  "deploymentManifestDigest",
  "drills",
  "environment",
  "fundingMode",
  "operationsId",
  "participants",
  "preparedAt",
  "protocolVersion",
  "reviewedBuildCommit",
  "schema",
  "validUntil",
  "verifyingContract",
]);

const verifiedOperationalReadiness = new WeakSet();

export const OPERATIONAL_READINESS_ATTESTATION_TYPES = Object.freeze({
  OperationalReadinessAttestation: Object.freeze([
    Object.freeze({ name: "operationsId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "adoptionPolicyDigest", type: "bytes32" }),
    Object.freeze({ name: "role", type: "string" }),
    Object.freeze({ name: "operatorId", type: "bytes32" }),
    Object.freeze({ name: "preparedAt", type: "uint64" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
  ]),
});

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
  if (!BYTES32.test(normalized) || normalized === `0x${"00".repeat(32)}`) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return normalized;
}

function address(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function canonicalChainId(value, name) {
  const normalized = String(value ?? "");
  if (!DECIMAL_CHAIN_ID.test(normalized)) throw new TypeError(`${name} must be a canonical positive decimal string`);
  if (BigInt(normalized) > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe integer range`);
  return normalized;
}

function safeInteger(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(`${name} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  if (BigInt(value) > UINT64_MAX) throw new RangeError(`${name} exceeds uint64`);
  return value;
}

function timestamp(value, name) {
  return safeInteger(value, name, { positive: true });
}

function requireCanonicalOrder(values, selector, name) {
  for (let index = 1; index < values.length; index += 1) {
    if (selector(values[index - 1]).localeCompare(selector(values[index])) >= 0) {
      throw new Error(`${name} must be strictly canonically ordered`);
    }
  }
}

function fundingMode(value, name) {
  if (!FUNDING_MODES.includes(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "operational readiness policy");
  if (raw.schema !== "treeswap.operational-readiness-evidence-policy.v3") {
    throw new TypeError("operational readiness policy schema is invalid");
  }
  if (raw.environment !== "public-testnet") {
    throw new TypeError("operational readiness environment must be public-testnet");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) {
    throw new TypeError("operational readiness build commit is invalid");
  }
  if (!VERSION.test(String(raw.protocolVersion ?? ""))) {
    throw new TypeError("operational readiness protocol version is invalid");
  }
  const maximumEvidenceAgeSeconds = safeInteger(
    raw.maximumEvidenceAgeSeconds,
    "maximumEvidenceAgeSeconds",
    { positive: true },
  );
  const maximumEvidenceLifetimeSeconds = safeInteger(
    raw.maximumEvidenceLifetimeSeconds,
    "maximumEvidenceLifetimeSeconds",
    { positive: true },
  );
  const maximumDrillAgeSeconds = safeInteger(
    raw.maximumDrillAgeSeconds,
    "maximumDrillAgeSeconds",
    { positive: true },
  );
  const maximumDrillDurationSeconds = safeInteger(
    raw.maximumDrillDurationSeconds,
    "maximumDrillDurationSeconds",
    { positive: true },
  );
  const minimumAlertChannels = safeInteger(raw.minimumAlertChannels, "minimumAlertChannels", { positive: true });
  const minimumOrganizations = safeInteger(raw.minimumOrganizations, "minimumOrganizations", { positive: true });
  if (maximumEvidenceAgeSeconds > 2_592_000) {
    throw new RangeError("operational readiness freshness may not exceed thirty days");
  }
  if (maximumEvidenceLifetimeSeconds > 7_776_000 || maximumDrillAgeSeconds > 7_776_000) {
    throw new RangeError("operational readiness evidence and drills may not exceed ninety days");
  }
  if (maximumDrillDurationSeconds > 86_400) {
    throw new RangeError("an operational drill may not exceed twenty-four hours");
  }
  if (minimumAlertChannels < 2 || minimumAlertChannels > 20) {
    throw new RangeError("operational readiness requires two to twenty alert channels");
  }
  if (minimumOrganizations < 2 || minimumOrganizations > OPERATIONAL_READINESS_ROLES.length) {
    throw new RangeError("operational readiness requires at least two bounded organization commitments");
  }
  if (!Array.isArray(raw.requiredDrills)
      || raw.requiredDrills.length !== REQUIRED_OPERATIONAL_DRILLS.length
      || raw.requiredDrills.some((name, index) => name !== REQUIRED_OPERATIONAL_DRILLS[index])) {
    throw new Error("operational readiness policy must require the complete exact drill set");
  }
  return Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    fundingMode: fundingMode(raw.fundingMode, "policy.fundingMode"),
    chainId: canonicalChainId(raw.chainId, "policy.chainId"),
    verifyingContract: address(raw.verifyingContract, "policy.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    protocolVersion: raw.protocolVersion,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "policy.deploymentManifestDigest"),
    maximumEvidenceAgeSeconds,
    maximumEvidenceLifetimeSeconds,
    maximumDrillAgeSeconds,
    maximumDrillDurationSeconds,
    minimumAlertChannels,
    minimumOrganizations,
    requiredDrills: REQUIRED_OPERATIONAL_DRILLS,
  });
}

function normalizeParticipant(raw, index) {
  exactKeys(raw, PARTICIPANT_FIELDS, `participants[${index}]`);
  if (!OPERATIONAL_READINESS_ROLES.includes(raw.role)) {
    throw new TypeError(`participants[${index}].role is invalid`);
  }
  return Object.freeze({
    role: raw.role,
    operatorId: digest(raw.operatorId, `participants[${index}].operatorId`),
    organizationId: digest(raw.organizationId, `participants[${index}].organizationId`),
    signer: address(raw.signer, `participants[${index}].signer`),
    evidenceDigest: digest(raw.evidenceDigest, `participants[${index}].evidenceDigest`),
  });
}

function normalizeDrill(raw, index, participants, policy, preparedAt) {
  exactKeys(raw, DRILL_FIELDS, `drills[${index}]`);
  if (!REQUIRED_OPERATIONAL_DRILLS.includes(raw.name)) {
    throw new TypeError(`drills[${index}].name is invalid`);
  }
  if (raw.status !== "passed") throw new Error(`drills[${index}] did not pass`);
  const startedAt = timestamp(raw.startedAt, `drills[${index}].startedAt`);
  const finishedAt = timestamp(raw.finishedAt, `drills[${index}].finishedAt`);
  if (finishedAt < startedAt || finishedAt > preparedAt) {
    throw new RangeError(`drills[${index}] timestamps are reversed or future-dated`);
  }
  if (finishedAt - startedAt > policy.maximumDrillDurationSeconds) {
    throw new RangeError(`drills[${index}] duration exceeds policy`);
  }
  if (preparedAt - finishedAt > policy.maximumDrillAgeSeconds) {
    throw new Error(`drills[${index}] evidence is stale`);
  }
  const primaryOperatorId = digest(raw.primaryOperatorId, `drills[${index}].primaryOperatorId`);
  const knownOperatorIds = new Set(participants.map((participant) => participant.operatorId));
  if (!knownOperatorIds.has(primaryOperatorId)) {
    throw new Error(`drills[${index}] primary operator is not a participant`);
  }
  if (!Array.isArray(raw.observerOperatorIds) || raw.observerOperatorIds.length < 2
      || raw.observerOperatorIds.length > participants.length - 1) {
    throw new Error(`drills[${index}] requires two to four retained observers`);
  }
  const observerOperatorIds = raw.observerOperatorIds.map((value, observerIndex) => (
    digest(value, `drills[${index}].observerOperatorIds[${observerIndex}]`)
  ));
  requireCanonicalOrder(observerOperatorIds, (value) => value, `drills[${index}] observers`);
  if (observerOperatorIds.includes(primaryOperatorId)
      || observerOperatorIds.some((operatorId) => !knownOperatorIds.has(operatorId))) {
    throw new Error(`drills[${index}] observers must be distinct non-primary participants`);
  }
  return Object.freeze({
    name: raw.name,
    status: "passed",
    startedAt,
    finishedAt,
    primaryOperatorId,
    observerOperatorIds: Object.freeze(observerOperatorIds),
    evidenceDigest: digest(raw.evidenceDigest, `drills[${index}].evidenceDigest`),
  });
}

function normalizeRecord(raw, policy) {
  exactKeys(raw, RECORD_FIELDS, "operational readiness record");
  if (raw.schema !== "treeswap.operational-readiness-evidence.v3") {
    throw new TypeError("operational readiness record schema is invalid");
  }
  if (raw.environment !== "public-testnet") {
    throw new TypeError("operational readiness environment must be public-testnet");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) {
    throw new TypeError("operational readiness build commit is invalid");
  }
  if (!VERSION.test(String(raw.protocolVersion ?? ""))) {
    throw new TypeError("operational readiness protocol version is invalid");
  }
  const preparedAt = timestamp(raw.preparedAt, "preparedAt");
  const validUntil = timestamp(raw.validUntil, "validUntil");
  if (validUntil <= preparedAt) throw new RangeError("operational readiness validity interval is empty or reversed");
  if (validUntil - preparedAt > policy.maximumEvidenceLifetimeSeconds) {
    throw new RangeError("operational readiness validity exceeds policy");
  }
  const base = Object.freeze({
    schema: raw.schema,
    operationsId: digest(raw.operationsId, "operationsId"),
    environment: raw.environment,
    fundingMode: fundingMode(raw.fundingMode, "record.fundingMode"),
    chainId: canonicalChainId(raw.chainId, "record.chainId"),
    verifyingContract: address(raw.verifyingContract, "record.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    protocolVersion: raw.protocolVersion,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "record.deploymentManifestDigest"),
    preparedAt,
    validUntil,
  });
  for (const field of [
    "environment",
    "fundingMode",
    "chainId",
    "verifyingContract",
    "reviewedBuildCommit",
    "protocolVersion",
    "deploymentManifestDigest",
  ]) {
    if (base[field] !== policy[field]) throw new Error(`operational readiness record ${field} does not match policy`);
  }
  if (!Array.isArray(raw.participants) || raw.participants.length !== OPERATIONAL_READINESS_ROLES.length) {
    throw new Error("operational readiness requires exactly one participant for every operations role");
  }
  const participants = raw.participants.map(normalizeParticipant);
  requireCanonicalOrder(participants, (value) => value.role, "operational readiness participants");
  const roles = new Set();
  const operatorIds = new Set();
  const organizations = new Set();
  const signers = new Set();
  const identityEvidence = new Set();
  for (const participant of participants) {
    const signer = participant.signer.toLowerCase();
    if (roles.has(participant.role)) throw new Error("operational readiness roles must be unique");
    if (operatorIds.has(participant.operatorId)) throw new Error("operational readiness operator identities must be distinct");
    if (signers.has(signer)) throw new Error("operational readiness roles must use distinct signers");
    if (identityEvidence.has(participant.evidenceDigest)) {
      throw new Error("operational readiness participants must retain distinct identity evidence");
    }
    roles.add(participant.role);
    operatorIds.add(participant.operatorId);
    organizations.add(participant.organizationId);
    signers.add(signer);
    identityEvidence.add(participant.evidenceDigest);
  }
  for (const role of OPERATIONAL_READINESS_ROLES) {
    if (!roles.has(role)) throw new Error(`operational readiness is missing the ${role} role`);
  }
  if (organizations.size < policy.minimumOrganizations) {
    throw new Error("operational readiness organization commitments are below policy");
  }
  if (!Array.isArray(raw.alertChannelEvidenceDigests)
      || raw.alertChannelEvidenceDigests.length < policy.minimumAlertChannels
      || raw.alertChannelEvidenceDigests.length > 20) {
    throw new Error("operational readiness alert channels are below policy or unbounded");
  }
  const alertChannelEvidenceDigests = raw.alertChannelEvidenceDigests.map((value, index) => (
    digest(value, `alertChannelEvidenceDigests[${index}]`)
  ));
  requireCanonicalOrder(alertChannelEvidenceDigests, (value) => value, "operational readiness alert channels");
  exactKeys(raw.artifacts, ARTIFACT_FIELDS, "operational readiness artifacts");
  const artifacts = Object.freeze(Object.fromEntries(ARTIFACT_FIELDS.map((field) => [
    field,
    digest(raw.artifacts[field], `artifacts.${field}`),
  ])));
  if (new Set(Object.values(artifacts)).size !== ARTIFACT_FIELDS.length) {
    throw new Error("operational readiness artifacts must use distinct evidence digests");
  }
  if (!Array.isArray(raw.drills) || raw.drills.length !== REQUIRED_OPERATIONAL_DRILLS.length) {
    throw new Error("operational readiness requires the complete exact drill set");
  }
  const drills = raw.drills.map((drill, index) => normalizeDrill(drill, index, participants, policy, preparedAt));
  requireCanonicalOrder(drills, (value) => value.name, "operational readiness drills");
  if (drills.some((drill, index) => drill.name !== REQUIRED_OPERATIONAL_DRILLS[index])) {
    throw new Error("operational readiness drills do not match the required set");
  }
  if (new Set(drills.map((drill) => drill.evidenceDigest)).size !== drills.length) {
    throw new Error("operational readiness drills must use distinct evidence digests");
  }
  return Object.freeze({
    ...base,
    participants: Object.freeze(participants),
    alertChannelEvidenceDigests: Object.freeze(alertChannelEvidenceDigests),
    artifacts,
    drills: Object.freeze(drills),
  });
}

function normalizeAttestation(raw, index) {
  exactKeys(raw, ["operatorId", "role", "signature", "signer"], `attestations[${index}]`);
  if (!OPERATIONAL_READINESS_ROLES.includes(raw.role)) {
    throw new TypeError(`attestations[${index}].role is invalid`);
  }
  if (!isHexString(raw.signature) || ![64, 65].includes((raw.signature.length - 2) / 2)) {
    throw new TypeError(`attestations[${index}].signature is invalid`);
  }
  return Object.freeze({
    role: raw.role,
    operatorId: digest(raw.operatorId, `attestations[${index}].operatorId`),
    signer: address(raw.signer, `attestations[${index}].signer`),
    signature: raw.signature.toLowerCase(),
  });
}

export function operationalReadinessEvidenceDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Operational Readiness Evidence",
    version: "2",
    chainId: BigInt(canonicalChainId(chainId, "domain.chainId")),
    verifyingContract: address(verifyingContract, "domain.verifyingContract"),
  });
}

export function assertOperationalReadinessEvidenceIsSecretFree(value) {
  const forbiddenKey = /(address|email|endpoint|invoice|macaroon|memo|mnemonic|password|preimage|private.?key|rpc.?url|seed|wallet.?link)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string"
          && (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(entry)
            || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)
            || /https?:\/\//i.test(entry))) {
        throw new Error("operational readiness evidence contains secret or unrestricted endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key) && key !== "verifyingContract") {
        throw new Error(`operational readiness evidence contains forbidden field ${key}`);
      }
      visit(item);
    }
  };
  visit(value);
  return true;
}

function requireServiceIsolationBinding(record, verification) {
  const evidence = buildServiceIsolationReleaseEvidence(verification);
  for (const field of [
    "environment",
    "chainId",
    "verifyingContract",
    "reviewedBuildCommit",
    "protocolVersion",
    "deploymentManifestDigest",
  ]) {
    if (record[field] !== evidence[field]) {
      throw new Error(`operational readiness ${field} does not match verified service isolation evidence`);
    }
  }
  if (record.preparedAt < evidence.preparedAt || record.validUntil > evidence.validUntil) {
    throw new Error("operational readiness validity is outside the verified service isolation interval");
  }
  if (record.artifacts.serviceIsolation !== evidence.evidenceDigest) {
    throw new Error("operational readiness service isolation artifact does not match verified provenance");
  }
  return evidence;
}

function requireAdoptionPolicyBinding(record, rawPolicy) {
  const evidence = buildAdoptionPolicyEvidence(rawPolicy);
  for (const field of [
    "environment",
    "fundingMode",
    "chainId",
    "verifyingContract",
    "reviewedBuildCommit",
    "protocolVersion",
    "deploymentManifestDigest",
  ]) {
    if (record[field] !== evidence.policy[field]) {
      throw new Error(`operational readiness ${field} does not match the exact adoption policy`);
    }
  }
  if (record.preparedAt < evidence.policy.preparedAt || record.validUntil > evidence.policy.validUntil) {
    throw new Error("operational readiness validity is outside the exact adoption policy interval");
  }
  const supportOwner = record.participants.find((participant) => participant.role === "support-owner");
  const incidentCommander = record.participants.find((participant) => participant.role === "incident-commander");
  if (supportOwner?.operatorId !== evidence.policy.supportOwnerId
      || incidentCommander?.operatorId !== evidence.policy.incidentCommanderId) {
    throw new Error("operational readiness support and incident owners do not match the exact adoption policy");
  }
  for (const [artifact, expected] of [
    ["lossAllocation", evidence.lossAllocationDigest],
    ["privacyRetention", evidence.privacyRetentionDigest],
    ["supportPolicy", evidence.supportPolicyDigest],
  ]) {
    if (record.artifacts[artifact] !== expected) {
      throw new Error(`operational readiness ${artifact} does not match the exact adoption policy`);
    }
  }
  return evidence;
}

export function prepareOperationalReadinessEvidenceCandidate({
  adoptionPolicy,
  record,
  policy,
  serviceIsolationVerification,
}) {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedRecord = normalizeRecord(record, normalizedPolicy);
  const serviceIsolation = requireServiceIsolationBinding(
    normalizedRecord,
    serviceIsolationVerification,
  );
  const adoption = requireAdoptionPolicyBinding(normalizedRecord, adoptionPolicy);
  assertOperationalReadinessEvidenceIsSecretFree({ record: normalizedRecord, policy: normalizedPolicy });
  return Object.freeze({
    schema: "treeswap.prepared-operational-readiness-evidence.v3",
    status: "validated-awaiting-five-operational-role-attestations",
    scope: "operations-evidence-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: hash(normalizedRecord),
    policyDigest: hash(normalizedPolicy),
    record: normalizedRecord,
    policy: normalizedPolicy,
    adoptionPolicyDigest: adoption.policyDigest,
    adoptionPolicy: adoption,
    serviceIsolationEvidenceDigest: serviceIsolation.evidenceDigest,
    serviceIsolation,
  });
}

export function buildOperationalReadinessAttestationMessage({
  adoptionPolicy,
  record,
  policy,
  serviceIsolationVerification,
  role,
  operatorId,
}) {
  const candidate = prepareOperationalReadinessEvidenceCandidate({
    adoptionPolicy,
    record,
    policy,
    serviceIsolationVerification,
  });
  if (!OPERATIONAL_READINESS_ROLES.includes(role)) {
    throw new TypeError("operational readiness attestation role is invalid");
  }
  const normalizedOperatorId = digest(operatorId, "operational readiness attestation operatorId");
  const participant = candidate.record.participants.find((value) => (
    value.role === role && value.operatorId === normalizedOperatorId
  ));
  if (!participant) throw new Error("operational readiness attestation identity is not a participant");
  return Object.freeze({
    domain: operationalReadinessEvidenceDomain(candidate.record),
    types: OPERATIONAL_READINESS_ATTESTATION_TYPES,
    value: Object.freeze({
      operationsId: candidate.record.operationsId,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      adoptionPolicyDigest: candidate.adoptionPolicyDigest,
      role,
      operatorId: normalizedOperatorId,
      preparedAt: candidate.record.preparedAt,
      validUntil: candidate.record.validUntil,
    }),
  });
}

export function verifyOperationalReadinessEvidence({
  adoptionPolicy,
  record,
  policy,
  serviceIsolationVerification,
  attestations,
  now = Math.floor(Date.now() / 1_000),
}) {
  const candidate = prepareOperationalReadinessEvidenceCandidate({
    adoptionPolicy,
    record,
    policy,
    serviceIsolationVerification,
  });
  const observedAt = timestamp(now, "now");
  if (observedAt < candidate.record.preparedAt) throw new Error("operational readiness evidence is from the future");
  if (observedAt > candidate.record.validUntil) throw new Error("operational readiness evidence is expired");
  if (observedAt - candidate.record.preparedAt > candidate.policy.maximumEvidenceAgeSeconds) {
    throw new Error("operational readiness evidence is stale");
  }
  if (!Array.isArray(attestations) || attestations.length !== candidate.record.participants.length) {
    throw new Error("operational readiness requires one attestation from every participant");
  }
  const normalizedAttestations = attestations.map(normalizeAttestation);
  requireCanonicalOrder(normalizedAttestations, (value) => value.role, "operational readiness attestations");
  const domain = operationalReadinessEvidenceDomain(candidate.record);
  for (let index = 0; index < candidate.record.participants.length; index += 1) {
    const participant = candidate.record.participants[index];
    const attestation = normalizedAttestations[index];
    if (attestation.role !== participant.role
        || attestation.operatorId !== participant.operatorId
        || attestation.signer !== participant.signer) {
      throw new Error("operational readiness attestation does not exactly match its participant");
    }
    const recovered = verifyTypedData(domain, OPERATIONAL_READINESS_ATTESTATION_TYPES, {
      operationsId: candidate.record.operationsId,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      adoptionPolicyDigest: candidate.adoptionPolicyDigest,
      role: participant.role,
      operatorId: participant.operatorId,
      preparedAt: candidate.record.preparedAt,
      validUntil: candidate.record.validUntil,
    }, attestation.signature);
    if (getAddress(recovered) !== participant.signer) {
      throw new Error("operational readiness signature is invalid");
    }
  }
  const result = Object.freeze({
    schema: "treeswap.verified-operational-readiness-evidence.v3",
    status: "five-operational-role-attestations-cryptographically-verified",
    scope: "operations-release-evidence-no-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    attestationSetDigest: hash(normalizedAttestations),
    adoptionPolicyDigest: candidate.adoptionPolicyDigest,
    adoptionPolicy: candidate.adoptionPolicy,
    serviceIsolationEvidenceDigest: candidate.serviceIsolationEvidenceDigest,
    serviceIsolation: candidate.serviceIsolation,
    record: candidate.record,
    policy: candidate.policy,
    authorizations: Object.freeze({ signing: false, broadcast: false, gateOpening: false, funding: false }),
  });
  assertOperationalReadinessEvidenceIsSecretFree({
    ...result,
    adoptionPolicy: candidate.adoptionPolicyDigest,
  });
  verifiedOperationalReadiness.add(result);
  return result;
}

export function buildOperationalReadinessReleaseEvidence(verification) {
  if (!verifiedOperationalReadiness.has(verification)) {
    throw new Error("operational readiness evidence provenance is invalid");
  }
  return Object.freeze({
    schema: "treeswap.operational-readiness-release-evidence.v3",
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    attestationSetDigest: verification.attestationSetDigest,
    participantSetDigest: hash(verification.record.participants),
    drillSetDigest: hash(verification.record.drills),
    alertChannelSetDigest: hash(verification.record.alertChannelEvidenceDigests),
    adoptionPolicyDigest: verification.adoptionPolicyDigest,
    adoptionPolicy: verification.adoptionPolicy.policy,
    serviceIsolationEvidenceDigest: verification.serviceIsolationEvidenceDigest,
    serviceIsolationParticipantSetDigest: verification.serviceIsolation.participantSetDigest,
    serviceIsolationParticipants: verification.serviceIsolation.participants,
    fundingMode: verification.record.fundingMode,
    reviewedBuildCommit: verification.record.reviewedBuildCommit,
    protocolVersion: verification.record.protocolVersion,
    chainId: verification.record.chainId,
    verifyingContract: verification.record.verifyingContract,
    deploymentManifestDigest: verification.record.deploymentManifestDigest,
    preparedAt: verification.record.preparedAt,
    validUntil: verification.record.validUntil,
    artifacts: verification.record.artifacts,
    drills: verification.record.drills,
    alertChannelEvidenceDigests: verification.record.alertChannelEvidenceDigests,
    participants: Object.freeze(verification.record.participants.map((participant) => Object.freeze({
      role: participant.role,
      operatorId: participant.operatorId,
      organizationId: participant.organizationId,
      signer: participant.signer,
    }))),
  });
}

export function buildOperationalReadinessEvidenceSummary(verification) {
  const evidence = buildOperationalReadinessReleaseEvidence(verification);
  return Object.freeze({
    schema: "treeswap.operational-readiness-evidence-summary.v3",
    status: verification.status,
    scope: verification.scope,
    recordDigest: evidence.recordDigest,
    policyDigest: evidence.policyDigest,
    attestationSetDigest: evidence.attestationSetDigest,
    participantSetDigest: evidence.participantSetDigest,
    drillSetDigest: evidence.drillSetDigest,
    alertChannelSetDigest: evidence.alertChannelSetDigest,
    adoptionPolicyDigest: evidence.adoptionPolicyDigest,
    serviceIsolationEvidenceDigest: evidence.serviceIsolationEvidenceDigest,
    serviceIsolationParticipantSetDigest: evidence.serviceIsolationParticipantSetDigest,
    fundingMode: evidence.fundingMode,
    reviewedBuildCommit: evidence.reviewedBuildCommit,
    protocolVersion: evidence.protocolVersion,
    chainId: evidence.chainId,
    verifyingContract: evidence.verifyingContract,
    deploymentManifestDigest: evidence.deploymentManifestDigest,
    preparedAt: evidence.preparedAt,
    validUntil: evidence.validUntil,
    participantCount: evidence.participants.length,
    serviceIsolationParticipantCount: evidence.serviceIsolationParticipants.length,
    drillCount: evidence.drills.length,
    alertChannelCount: evidence.alertChannelEvidenceDigests.length,
    authorizations: verification.authorizations,
  });
}
