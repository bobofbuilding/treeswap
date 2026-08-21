import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL_CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const UINT64_MAX = (1n << 64n) - 1n;

export const PUBLIC_TESTNET_BOOTSTRAP_ROLES = Object.freeze([
  "evm-provider",
  "lightning-observer",
  "monitor",
  "relay",
  "solver",
]);

const ROLE_TO_COUNT = Object.freeze({
  "evm-provider": "evmProviders",
  "lightning-observer": "lightningObservers",
  monitor: "monitors",
  relay: "relays",
  solver: "solvers",
});

const COUNT_FIELDS = Object.freeze([
  "alertChannels",
  "evmProviders",
  "lightningObservers",
  "monitors",
  "relays",
  "solvers",
]);

const ARTIFACT_FIELDS = Object.freeze([
  "admissionPolicy",
  "backupRestore",
  "feeSchedule",
  "findingsDisposition",
  "incidentDrills",
  "monitoring",
  "providerQuorum",
  "riskPolicy",
  "solverOperations",
  "testQualification",
]);

const FEATURE_FIELDS = Object.freeze([
  "lpShares",
  "mainnetAssets",
  "makerRewards",
  "operatorOwnedTestInventory",
  "partialFills",
  "publicLpDeposits",
  "promisedYield",
  "rewards",
]);

const POLICY_FIELDS = Object.freeze([
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "maximumEvidenceAgeSeconds",
  "maximumEvidenceLifetimeSeconds",
  "minimumCounts",
  "reviewedBuildCommit",
  "schema",
  "verifyingContract",
]);

const RECORD_FIELDS = Object.freeze([
  "alertChannelEvidenceDigests",
  "artifacts",
  "bootstrapId",
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "features",
  "participants",
  "preparedAt",
  "reviewedBuildCommit",
  "schema",
  "validUntil",
  "verifyingContract",
]);

const verifiedBootstrapEvidence = new WeakSet();

export const PUBLIC_TESTNET_BOOTSTRAP_ATTESTATION_TYPES = Object.freeze({
  BootstrapOperatorAttestation: Object.freeze([
    Object.freeze({ name: "bootstrapId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
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

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function requireCanonicalOrder(values, selector, name) {
  for (let index = 1; index < values.length; index += 1) {
    if (selector(values[index - 1]).localeCompare(selector(values[index])) >= 0) {
      throw new Error(`${name} must be strictly canonically ordered`);
    }
  }
}

function normalizeCounts(value) {
  exactKeys(value, COUNT_FIELDS, "minimumCounts");
  return Object.freeze(Object.fromEntries(COUNT_FIELDS.map((field) => {
    const count = safeInteger(value[field], `minimumCounts.${field}`, { positive: true });
    if (count < 2 || count > 20) throw new RangeError(`minimumCounts.${field} is outside two to twenty`);
    return [field, count];
  })));
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "public-testnet bootstrap evidence policy");
  if (raw.schema !== "treeswap.public-testnet-bootstrap-evidence-policy.v2") {
    throw new TypeError("bootstrap evidence policy schema is invalid");
  }
  if (raw.environment !== "public-testnet") throw new TypeError("bootstrap evidence environment must be public-testnet");
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("bootstrap build commit is invalid");
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
  if (maximumEvidenceAgeSeconds > 3_600) throw new Error("bootstrap evidence freshness may not exceed one hour");
  if (maximumEvidenceLifetimeSeconds > 86_400) throw new Error("bootstrap evidence lifetime may not exceed one day");
  return Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    chainId: canonicalChainId(raw.chainId, "policy.chainId"),
    verifyingContract: address(raw.verifyingContract, "policy.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "policy.deploymentManifestDigest"),
    maximumEvidenceAgeSeconds,
    maximumEvidenceLifetimeSeconds,
    minimumCounts: normalizeCounts(raw.minimumCounts),
  });
}

function normalizeParticipant(raw, index) {
  exactKeys(raw, ["evidenceDigest", "operatorId", "role", "signer"], `participants[${index}]`);
  if (!PUBLIC_TESTNET_BOOTSTRAP_ROLES.includes(raw.role)) {
    throw new TypeError(`participants[${index}].role is invalid`);
  }
  return Object.freeze({
    role: raw.role,
    operatorId: digest(raw.operatorId, `participants[${index}].operatorId`),
    signer: address(raw.signer, `participants[${index}].signer`),
    evidenceDigest: digest(raw.evidenceDigest, `participants[${index}].evidenceDigest`),
  });
}

function normalizeRecord(raw, policy) {
  exactKeys(raw, RECORD_FIELDS, "public-testnet bootstrap evidence record");
  if (raw.schema !== "treeswap.public-testnet-bootstrap-evidence.v2") {
    throw new TypeError("bootstrap evidence record schema is invalid");
  }
  if (raw.environment !== "public-testnet") throw new TypeError("bootstrap evidence environment must be public-testnet");
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("bootstrap build commit is invalid");
  const preparedAt = timestamp(raw.preparedAt, "preparedAt");
  const validUntil = timestamp(raw.validUntil, "validUntil");
  if (validUntil <= preparedAt) throw new RangeError("bootstrap evidence interval is reversed or empty");
  if (validUntil - preparedAt > policy.maximumEvidenceLifetimeSeconds) {
    throw new RangeError("bootstrap evidence interval exceeds policy");
  }
  const base = {
    schema: raw.schema,
    bootstrapId: digest(raw.bootstrapId, "bootstrapId"),
    environment: raw.environment,
    chainId: canonicalChainId(raw.chainId, "record.chainId"),
    verifyingContract: address(raw.verifyingContract, "record.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "record.deploymentManifestDigest"),
    preparedAt,
    validUntil,
  };
  if (base.chainId !== policy.chainId
      || base.verifyingContract !== policy.verifyingContract
      || base.reviewedBuildCommit !== policy.reviewedBuildCommit
      || base.deploymentManifestDigest !== policy.deploymentManifestDigest) {
    throw new Error("bootstrap evidence record does not match its policy");
  }

  if (!Array.isArray(raw.participants)) throw new TypeError("participants must be an array");
  if (raw.participants.length > 100) throw new Error("bootstrap participant set exceeds the bounded maximum");
  const participants = raw.participants.map(normalizeParticipant);
  requireCanonicalOrder(participants, (value) => `${value.role}:${value.operatorId}`, "bootstrap participants");
  const operatorIds = new Set();
  const signers = new Set();
  const evidenceDigests = new Set();
  const roleCounts = new Map(PUBLIC_TESTNET_BOOTSTRAP_ROLES.map((role) => [role, 0]));
  for (const participant of participants) {
    const signer = participant.signer.toLowerCase();
    if (operatorIds.has(participant.operatorId)) {
      throw new Error("bootstrap operator identity cannot count in more than one role");
    }
    if (signers.has(signer)) throw new Error("bootstrap signer cannot count in more than one role");
    if (evidenceDigests.has(participant.evidenceDigest)) {
      throw new Error("bootstrap participants must retain distinct evidence");
    }
    operatorIds.add(participant.operatorId);
    signers.add(signer);
    evidenceDigests.add(participant.evidenceDigest);
    roleCounts.set(participant.role, roleCounts.get(participant.role) + 1);
  }
  for (const role of PUBLIC_TESTNET_BOOTSTRAP_ROLES) {
    const count = roleCounts.get(role);
    if (count < policy.minimumCounts[ROLE_TO_COUNT[role]]) throw new Error(`${role} participant count is below policy`);
    if (count > 20) throw new Error(`${role} participant count exceeds the bounded maximum`);
  }

  if (!Array.isArray(raw.alertChannelEvidenceDigests)) {
    throw new TypeError("alertChannelEvidenceDigests must be an array");
  }
  const alertChannelEvidenceDigests = raw.alertChannelEvidenceDigests.map((value, index) => (
    digest(value, `alertChannelEvidenceDigests[${index}]`)
  ));
  requireCanonicalOrder(alertChannelEvidenceDigests, (value) => value, "alert channel evidence digests");
  if (alertChannelEvidenceDigests.length < policy.minimumCounts.alertChannels
      || alertChannelEvidenceDigests.length > 20
      || new Set(alertChannelEvidenceDigests).size !== alertChannelEvidenceDigests.length) {
    throw new Error("alert channel evidence is below policy, duplicated, or unbounded");
  }

  exactKeys(raw.artifacts, ARTIFACT_FIELDS, "bootstrap artifacts");
  const artifacts = Object.freeze(Object.fromEntries(ARTIFACT_FIELDS.map((field) => [
    field,
    digest(raw.artifacts[field], `artifacts.${field}`),
  ])));
  exactKeys(raw.features, FEATURE_FIELDS, "bootstrap features");
  const features = Object.freeze(Object.fromEntries(FEATURE_FIELDS.map((field) => [
    field,
    boolean(raw.features[field], `features.${field}`),
  ])));
  if (features.mainnetAssets || features.lpShares || features.makerRewards || features.partialFills
      || features.promisedYield || features.publicLpDeposits || features.rewards
      || !features.operatorOwnedTestInventory) {
    throw new Error("bootstrap features exceed the operator-owned public-testnet boundary");
  }

  return Object.freeze({
    ...base,
    participants: Object.freeze(participants),
    alertChannelEvidenceDigests: Object.freeze(alertChannelEvidenceDigests),
    artifacts,
    features,
  });
}

function normalizeAttestation(raw, index) {
  exactKeys(raw, ["operatorId", "role", "signature", "signer"], `attestations[${index}]`);
  if (!PUBLIC_TESTNET_BOOTSTRAP_ROLES.includes(raw.role)) {
    throw new TypeError(`attestations[${index}].role is invalid`);
  }
  if (!isHexString(raw.signature) || ![64, 65].includes((raw.signature.length - 2) / 2)) {
    throw new TypeError(`attestations[${index}].signature is invalid`);
  }
  return Object.freeze({
    role: raw.role,
    operatorId: digest(raw.operatorId, `attestations[${index}].operatorId`),
    signer: address(raw.signer, `attestations[${index}].signer`),
    signature: raw.signature,
  });
}

export function publicTestnetBootstrapEvidenceDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Public Testnet Bootstrap Evidence",
    version: "2",
    chainId: BigInt(canonicalChainId(chainId, "domain.chainId")),
    verifyingContract: address(verifyingContract, "domain.verifyingContract"),
  });
}

export function assertPublicTestnetBootstrapEvidenceIsSecretFree(value) {
  const forbiddenKey = /(email|endpoint|invoice|macaroon|mnemonic|password|preimage|private.?key|rpc.?url|seed)/i;
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
        throw new Error("bootstrap evidence contains secret or unrestricted endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`bootstrap evidence contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

export function preparePublicTestnetBootstrapEvidenceCandidate({ record, policy }) {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedRecord = normalizeRecord(record, normalizedPolicy);
  assertPublicTestnetBootstrapEvidenceIsSecretFree({ record: normalizedRecord, policy: normalizedPolicy });
  return Object.freeze({
    schema: "treeswap.prepared-public-testnet-bootstrap-evidence.v2",
    status: "validated-awaiting-independent-operator-attestations",
    scope: "bootstrap-evidence-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: hash(normalizedRecord),
    policyDigest: hash(normalizedPolicy),
    record: normalizedRecord,
    policy: normalizedPolicy,
  });
}

export function buildPublicTestnetBootstrapAttestationMessage({ record, policy, role, operatorId }) {
  const candidate = preparePublicTestnetBootstrapEvidenceCandidate({ record, policy });
  if (!PUBLIC_TESTNET_BOOTSTRAP_ROLES.includes(role)) throw new TypeError("bootstrap attestation role is invalid");
  const normalizedOperatorId = digest(operatorId, "bootstrap attestation operatorId");
  const participant = candidate.record.participants.find((value) => (
    value.role === role && value.operatorId === normalizedOperatorId
  ));
  if (!participant) throw new Error("bootstrap attestation identity is not a participant");
  return Object.freeze({
    domain: publicTestnetBootstrapEvidenceDomain(candidate.record),
    types: PUBLIC_TESTNET_BOOTSTRAP_ATTESTATION_TYPES,
    value: Object.freeze({
      bootstrapId: candidate.record.bootstrapId,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      role,
      operatorId: normalizedOperatorId,
      preparedAt: candidate.record.preparedAt,
      validUntil: candidate.record.validUntil,
    }),
  });
}

export function verifyPublicTestnetBootstrapEvidence({
  record,
  policy,
  attestations,
  now = Math.floor(Date.now() / 1_000),
}) {
  const candidate = preparePublicTestnetBootstrapEvidenceCandidate({ record, policy });
  const observedAt = timestamp(now, "now");
  if (observedAt < candidate.record.preparedAt) throw new Error("bootstrap evidence is from the future");
  if (observedAt > candidate.record.validUntil) throw new Error("bootstrap evidence is expired");
  if (observedAt - candidate.record.preparedAt > candidate.policy.maximumEvidenceAgeSeconds) {
    throw new Error("bootstrap evidence is stale");
  }
  if (!Array.isArray(attestations)) throw new TypeError("bootstrap attestations must be an array");
  if (attestations.length !== candidate.record.participants.length) {
    throw new Error("bootstrap evidence requires one attestation from every participant");
  }
  const normalizedAttestations = attestations.map(normalizeAttestation);
  requireCanonicalOrder(normalizedAttestations, (value) => `${value.role}:${value.operatorId}`, "bootstrap attestations");
  const domain = publicTestnetBootstrapEvidenceDomain(candidate.record);
  for (let index = 0; index < candidate.record.participants.length; index += 1) {
    const participant = candidate.record.participants[index];
    const attestation = normalizedAttestations[index];
    if (attestation.role !== participant.role
        || attestation.operatorId !== participant.operatorId
        || attestation.signer !== participant.signer) {
      throw new Error("bootstrap attestation does not exactly match its participant");
    }
    const recovered = verifyTypedData(domain, PUBLIC_TESTNET_BOOTSTRAP_ATTESTATION_TYPES, {
      bootstrapId: candidate.record.bootstrapId,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      role: participant.role,
      operatorId: participant.operatorId,
      preparedAt: candidate.record.preparedAt,
      validUntil: candidate.record.validUntil,
    }, attestation.signature);
    if (getAddress(recovered) !== participant.signer) throw new Error("bootstrap operator signature is invalid");
  }
  const result = Object.freeze({
    schema: "treeswap.verified-public-testnet-bootstrap-evidence.v2",
    status: "cryptographically-verified-bootstrap-operator-attestations",
    scope: "bootstrap-release-evidence-no-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    attestationSetDigest: hash(normalizedAttestations),
    record: candidate.record,
    policy: candidate.policy,
    authorizations: Object.freeze({ signing: false, broadcast: false, gateOpening: false, funding: false }),
  });
  assertPublicTestnetBootstrapEvidenceIsSecretFree(result);
  verifiedBootstrapEvidence.add(result);
  return result;
}

export function buildPublicTestnetBootstrapReleaseEvidence(verification) {
  if (!verifiedBootstrapEvidence.has(verification)) throw new Error("bootstrap evidence provenance is invalid");
  const roleCounts = Object.fromEntries(PUBLIC_TESTNET_BOOTSTRAP_ROLES.map((role) => [
    `independent${ROLE_TO_COUNT[role][0].toUpperCase()}${ROLE_TO_COUNT[role].slice(1)}`,
    verification.record.participants.filter((participant) => participant.role === role).length,
  ]));
  return Object.freeze({
    schema: "treeswap.public-testnet-bootstrap-release-evidence.v2",
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    attestationSetDigest: verification.attestationSetDigest,
    participantSetDigest: hash(verification.record.participants),
    reviewedBuildCommit: verification.record.reviewedBuildCommit,
    chainId: verification.record.chainId,
    verifyingContract: verification.record.verifyingContract,
    deploymentManifestDigest: verification.record.deploymentManifestDigest,
    preparedAt: verification.record.preparedAt,
    validUntil: verification.record.validUntil,
    artifacts: verification.record.artifacts,
    counts: Object.freeze({
      alertChannels: verification.record.alertChannelEvidenceDigests.length,
      ...roleCounts,
    }),
    evmProviders: Object.freeze(verification.record.participants
      .filter((participant) => participant.role === "evm-provider")
      .map((participant) => Object.freeze({
        operatorId: participant.operatorId,
        signer: participant.signer,
      }))),
  });
}

export function buildPublicTestnetBootstrapEvidenceSummary(verification) {
  const evidence = buildPublicTestnetBootstrapReleaseEvidence(verification);
  return Object.freeze({
    schema: "treeswap.public-testnet-bootstrap-evidence-summary.v2",
    status: verification.status,
    scope: verification.scope,
    recordDigest: evidence.recordDigest,
    policyDigest: evidence.policyDigest,
    attestationSetDigest: evidence.attestationSetDigest,
    participantSetDigest: evidence.participantSetDigest,
    reviewedBuildCommit: evidence.reviewedBuildCommit,
    chainId: evidence.chainId,
    verifyingContract: evidence.verifyingContract,
    deploymentManifestDigest: evidence.deploymentManifestDigest,
    preparedAt: evidence.preparedAt,
    validUntil: evidence.validUntil,
    counts: evidence.counts,
    authorizations: verification.authorizations,
  });
}
