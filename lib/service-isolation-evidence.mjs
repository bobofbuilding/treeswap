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
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;

export const SERVICE_ISOLATION_ATTESTATION_ROLES = Object.freeze([
  "infrastructure-operator",
  "lightning-operator",
  "security-reviewer",
]);

export const REQUIRED_ISOLATED_SERVICES = Object.freeze([
  "asset-verifier",
  "backup-store",
  "browser-client",
  "coordinator",
  "evm-finality-authorizer",
  "evm-relayer",
  "guardian-broadcaster",
  "lightning-invoice-adapter",
  "lightning-payer-adapter",
  "quote-relay",
  "safety-monitor",
  "web-server",
]);

export const SERVICE_ISOLATION_REQUIREMENTS = Object.freeze({
  "asset-verifier": Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "private-evm",
    publicIngress: false,
    credentialClasses: Object.freeze(["evm-read-provider-credential"]),
  }),
  "backup-store": Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "offline-backup",
    publicIngress: false,
    credentialClasses: Object.freeze(["backup-encryption-key"]),
  }),
  "browser-client": Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "public-client",
    publicIngress: false,
    credentialClasses: Object.freeze([]),
  }),
  coordinator: Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "private-control",
    publicIngress: false,
    credentialClasses: Object.freeze(["coordinator-database-credential"]),
  }),
  "evm-finality-authorizer": Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "private-evm",
    publicIngress: false,
    credentialClasses: Object.freeze(["evm-read-provider-credential"]),
  }),
  "evm-relayer": Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "private-evm",
    publicIngress: false,
    credentialClasses: Object.freeze(["evm-transaction-signer"]),
  }),
  "guardian-broadcaster": Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "private-governance",
    publicIngress: false,
    credentialClasses: Object.freeze(["guardian-transaction-signer"]),
  }),
  "lightning-invoice-adapter": Object.freeze({
    operatorRole: "lightning-operator",
    networkZone: "private-lightning",
    publicIngress: false,
    credentialClasses: Object.freeze(["lnd-invoice-macaroon", "lnd-tls-pinned-identity"]),
  }),
  "lightning-payer-adapter": Object.freeze({
    operatorRole: "lightning-operator",
    networkZone: "private-lightning",
    publicIngress: false,
    credentialClasses: Object.freeze(["lnd-payer-macaroon", "lnd-tls-pinned-identity"]),
  }),
  "quote-relay": Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "public-edge",
    publicIngress: true,
    credentialClasses: Object.freeze([]),
  }),
  "safety-monitor": Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "private-monitoring",
    publicIngress: false,
    credentialClasses: Object.freeze(["evm-read-provider-credential"]),
  }),
  "web-server": Object.freeze({
    operatorRole: "infrastructure-operator",
    networkZone: "public-edge",
    publicIngress: true,
    credentialClasses: Object.freeze(["account-storage-capability"]),
  }),
});

const PARTICIPANT_FIELDS = Object.freeze([
  "evidenceDigest",
  "operatorId",
  "organizationId",
  "role",
  "signer",
]);
const SERVICE_FIELDS = Object.freeze([
  "credentialClasses",
  "credentialExpiresAt",
  "credentialReviewedAt",
  "credentialSetDigest",
  "deploymentEvidenceDigest",
  "encryptedTransport",
  "networkPolicyDigest",
  "networkZone",
  "operatorId",
  "publicIngress",
  "role",
  "serviceId",
  "trustDomainId",
]);
const POLICY_FIELDS = Object.freeze([
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "maximumCredentialLifetimeSeconds",
  "maximumEvidenceAgeSeconds",
  "maximumEvidenceLifetimeSeconds",
  "minimumOrganizations",
  "protocolVersion",
  "requiredServices",
  "reviewedBuildCommit",
  "schema",
  "verifyingContract",
]);
const RECORD_FIELDS = Object.freeze([
  "chainId",
  "deploymentManifestDigest",
  "environment",
  "isolationId",
  "participants",
  "preparedAt",
  "protocolVersion",
  "reviewedBuildCommit",
  "schema",
  "services",
  "validUntil",
  "verifyingContract",
]);

const verifiedServiceIsolation = new WeakSet();

export const SERVICE_ISOLATION_ATTESTATION_TYPES = Object.freeze({
  ServiceIsolationAttestation: Object.freeze([
    Object.freeze({ name: "isolationId", type: "bytes32" }),
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

function digest(value, name, { allowZero = false } = {}) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || (!allowZero && normalized === ZERO_DIGEST)) {
    throw new TypeError(`${name} must be a ${allowZero ? "" : "nonzero "}lowercase bytes32 digest`);
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

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function timestamp(value, name, { allowZero = false } = {}) {
  if (allowZero && value === 0) return 0;
  return positiveInteger(value, name);
}

function requireCanonicalOrder(values, selector, name) {
  for (let index = 1; index < values.length; index += 1) {
    if (selector(values[index - 1]).localeCompare(selector(values[index])) >= 0) {
      throw new Error(`${name} must be strictly canonically ordered`);
    }
  }
}

function normalizePolicy(raw) {
  exactKeys(raw, POLICY_FIELDS, "service isolation policy");
  if (raw.schema !== "treeswap.service-isolation-evidence-policy.v1") {
    throw new TypeError("service isolation policy schema is invalid");
  }
  if (raw.environment !== "public-testnet") {
    throw new TypeError("service isolation environment must be public-testnet");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) {
    throw new TypeError("service isolation build commit is invalid");
  }
  if (!VERSION.test(String(raw.protocolVersion ?? ""))) {
    throw new TypeError("service isolation protocol version is invalid");
  }
  if (!Array.isArray(raw.requiredServices)
      || raw.requiredServices.length !== REQUIRED_ISOLATED_SERVICES.length
      || raw.requiredServices.some((role, index) => role !== REQUIRED_ISOLATED_SERVICES[index])) {
    throw new Error("service isolation policy must require the complete exact service set");
  }
  const maximumEvidenceAgeSeconds = positiveInteger(raw.maximumEvidenceAgeSeconds, "maximumEvidenceAgeSeconds");
  const maximumEvidenceLifetimeSeconds = positiveInteger(
    raw.maximumEvidenceLifetimeSeconds,
    "maximumEvidenceLifetimeSeconds",
  );
  const maximumCredentialLifetimeSeconds = positiveInteger(
    raw.maximumCredentialLifetimeSeconds,
    "maximumCredentialLifetimeSeconds",
  );
  const minimumOrganizations = positiveInteger(raw.minimumOrganizations, "minimumOrganizations");
  if (maximumEvidenceAgeSeconds > 2_592_000) {
    throw new RangeError("service isolation freshness may not exceed thirty days");
  }
  if (maximumEvidenceLifetimeSeconds > 7_776_000 || maximumCredentialLifetimeSeconds > 7_776_000) {
    throw new RangeError("service isolation evidence and credentials may not exceed ninety days");
  }
  if (minimumOrganizations < 2 || minimumOrganizations > SERVICE_ISOLATION_ATTESTATION_ROLES.length) {
    throw new RangeError("service isolation requires two or three organization commitments");
  }
  return Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    chainId: canonicalChainId(raw.chainId, "policy.chainId"),
    verifyingContract: address(raw.verifyingContract, "policy.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    protocolVersion: raw.protocolVersion,
    deploymentManifestDigest: digest(raw.deploymentManifestDigest, "policy.deploymentManifestDigest"),
    maximumEvidenceAgeSeconds,
    maximumEvidenceLifetimeSeconds,
    maximumCredentialLifetimeSeconds,
    minimumOrganizations,
    requiredServices: REQUIRED_ISOLATED_SERVICES,
  });
}

function normalizeParticipant(raw, index) {
  exactKeys(raw, PARTICIPANT_FIELDS, `participants[${index}]`);
  if (!SERVICE_ISOLATION_ATTESTATION_ROLES.includes(raw.role)) {
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

function normalizeService(raw, index, participantByRole, policy, preparedAt, validUntil) {
  exactKeys(raw, SERVICE_FIELDS, `services[${index}]`);
  const requirement = SERVICE_ISOLATION_REQUIREMENTS[raw.role];
  if (!requirement) throw new TypeError(`services[${index}].role is invalid`);
  if (raw.networkZone !== requirement.networkZone || raw.publicIngress !== requirement.publicIngress) {
    throw new Error(`services[${index}] network placement does not match policy`);
  }
  if (raw.encryptedTransport !== true) {
    throw new Error(`services[${index}] must require encrypted transport`);
  }
  if (!Array.isArray(raw.credentialClasses)
      || raw.credentialClasses.length !== requirement.credentialClasses.length
      || raw.credentialClasses.some((value, credentialIndex) => (
        value !== requirement.credentialClasses[credentialIndex]
      ))) {
    throw new Error(`services[${index}] credential classes do not match least-privilege policy`);
  }
  const participant = participantByRole.get(requirement.operatorRole);
  const operatorId = digest(raw.operatorId, `services[${index}].operatorId`);
  if (operatorId !== participant?.operatorId) {
    throw new Error(`services[${index}] operator does not match its required role`);
  }
  const hasCredentials = requirement.credentialClasses.length > 0;
  const credentialSetDigest = digest(
    raw.credentialSetDigest,
    `services[${index}].credentialSetDigest`,
    { allowZero: !hasCredentials },
  );
  const credentialReviewedAt = timestamp(
    raw.credentialReviewedAt,
    `services[${index}].credentialReviewedAt`,
    { allowZero: !hasCredentials },
  );
  const credentialExpiresAt = timestamp(
    raw.credentialExpiresAt,
    `services[${index}].credentialExpiresAt`,
    { allowZero: !hasCredentials },
  );
  if (!hasCredentials) {
    if (credentialSetDigest !== ZERO_DIGEST || credentialReviewedAt !== 0 || credentialExpiresAt !== 0) {
      throw new Error(`services[${index}] credential-free role must use exact zero credential fields`);
    }
  } else {
    if (credentialReviewedAt > preparedAt || credentialExpiresAt < validUntil) {
      throw new Error(`services[${index}] credential review or expiry does not cover the evidence interval`);
    }
    if (credentialExpiresAt - credentialReviewedAt > policy.maximumCredentialLifetimeSeconds) {
      throw new Error(`services[${index}] credential lifetime exceeds policy`);
    }
  }
  return Object.freeze({
    role: raw.role,
    serviceId: digest(raw.serviceId, `services[${index}].serviceId`),
    trustDomainId: digest(raw.trustDomainId, `services[${index}].trustDomainId`),
    operatorId,
    networkZone: raw.networkZone,
    publicIngress: raw.publicIngress,
    encryptedTransport: true,
    credentialClasses: requirement.credentialClasses,
    credentialSetDigest,
    networkPolicyDigest: digest(raw.networkPolicyDigest, `services[${index}].networkPolicyDigest`),
    deploymentEvidenceDigest: digest(raw.deploymentEvidenceDigest, `services[${index}].deploymentEvidenceDigest`),
    credentialReviewedAt,
    credentialExpiresAt,
  });
}

function normalizeRecord(raw, policy) {
  exactKeys(raw, RECORD_FIELDS, "service isolation record");
  if (raw.schema !== "treeswap.service-isolation-evidence.v1") {
    throw new TypeError("service isolation record schema is invalid");
  }
  if (raw.environment !== "public-testnet") {
    throw new TypeError("service isolation environment must be public-testnet");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) {
    throw new TypeError("service isolation build commit is invalid");
  }
  if (!VERSION.test(String(raw.protocolVersion ?? ""))) {
    throw new TypeError("service isolation protocol version is invalid");
  }
  const preparedAt = timestamp(raw.preparedAt, "preparedAt");
  const validUntil = timestamp(raw.validUntil, "validUntil");
  if (validUntil <= preparedAt || validUntil - preparedAt > policy.maximumEvidenceLifetimeSeconds) {
    throw new RangeError("service isolation validity is empty, reversed, or exceeds policy");
  }
  const base = Object.freeze({
    schema: raw.schema,
    isolationId: digest(raw.isolationId, "isolationId"),
    environment: raw.environment,
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
    "chainId",
    "verifyingContract",
    "reviewedBuildCommit",
    "protocolVersion",
    "deploymentManifestDigest",
  ]) {
    if (base[field] !== policy[field]) throw new Error(`service isolation record ${field} does not match policy`);
  }
  if (!Array.isArray(raw.participants)
      || raw.participants.length !== SERVICE_ISOLATION_ATTESTATION_ROLES.length) {
    throw new Error("service isolation requires exactly one participant for every attestation role");
  }
  const participants = raw.participants.map(normalizeParticipant);
  requireCanonicalOrder(participants, (value) => value.role, "service isolation participants");
  const roles = new Set();
  const operatorIds = new Set();
  const organizations = new Set();
  const signers = new Set();
  const evidenceDigests = new Set();
  for (const participant of participants) {
    const signer = participant.signer.toLowerCase();
    if (roles.has(participant.role) || operatorIds.has(participant.operatorId) || signers.has(signer)) {
      throw new Error("service isolation roles, operator identities, and signers must be distinct");
    }
    if (evidenceDigests.has(participant.evidenceDigest)) {
      throw new Error("service isolation participants must retain distinct identity evidence");
    }
    roles.add(participant.role);
    operatorIds.add(participant.operatorId);
    organizations.add(participant.organizationId);
    signers.add(signer);
    evidenceDigests.add(participant.evidenceDigest);
  }
  if (organizations.size < policy.minimumOrganizations) {
    throw new Error("service isolation organization commitments are below policy");
  }
  const participantByRole = new Map(participants.map((value) => [value.role, value]));
  if (!Array.isArray(raw.services) || raw.services.length !== REQUIRED_ISOLATED_SERVICES.length) {
    throw new Error("service isolation requires the complete exact service set");
  }
  const services = raw.services.map((service, index) => (
    normalizeService(service, index, participantByRole, policy, preparedAt, validUntil)
  ));
  requireCanonicalOrder(services, (value) => value.role, "service isolation services");
  if (services.some((service, index) => service.role !== REQUIRED_ISOLATED_SERVICES[index])) {
    throw new Error("service isolation services do not match the required set");
  }
  for (const [selector, name] of [
    [(value) => value.serviceId, "service identities"],
    [(value) => value.trustDomainId, "trust domains"],
    [(value) => value.networkPolicyDigest, "network-policy evidence"],
    [(value) => value.deploymentEvidenceDigest, "deployment evidence"],
  ]) {
    if (new Set(services.map(selector)).size !== services.length) {
      throw new Error(`service isolation ${name} must be unique per service`);
    }
  }
  const credentialSets = services
    .filter((service) => service.credentialSetDigest !== ZERO_DIGEST)
    .map((service) => service.credentialSetDigest);
  if (new Set(credentialSets).size !== credentialSets.length) {
    throw new Error("service isolation credential sets must be unique per credential-bearing service");
  }
  return Object.freeze({
    ...base,
    participants: Object.freeze(participants),
    services: Object.freeze(services),
  });
}

function normalizeAttestation(raw, index) {
  exactKeys(raw, ["operatorId", "role", "signature", "signer"], `attestations[${index}]`);
  if (!SERVICE_ISOLATION_ATTESTATION_ROLES.includes(raw.role)) {
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

export function serviceIsolationEvidenceDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Service Isolation Evidence",
    version: "1",
    chainId: BigInt(canonicalChainId(chainId, "domain.chainId")),
    verifyingContract: address(verifyingContract, "domain.verifyingContract"),
  });
}

export function assertServiceIsolationEvidenceIsSecretFree(value) {
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
        throw new Error("service isolation evidence contains secret or unrestricted endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key) && key !== "verifyingContract") {
        throw new Error(`service isolation evidence contains forbidden field ${key}`);
      }
      visit(item);
    }
  };
  visit(value);
  return true;
}

export function prepareServiceIsolationEvidenceCandidate({ record, policy }) {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedRecord = normalizeRecord(record, normalizedPolicy);
  assertServiceIsolationEvidenceIsSecretFree({ record: normalizedRecord, policy: normalizedPolicy });
  return Object.freeze({
    schema: "treeswap.prepared-service-isolation-evidence.v1",
    status: "validated-awaiting-three-role-service-isolation-attestations",
    scope: "service-isolation-evidence-only-no-secrets-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: hash(normalizedRecord),
    policyDigest: hash(normalizedPolicy),
    record: normalizedRecord,
    policy: normalizedPolicy,
  });
}

export function buildServiceIsolationAttestationMessage({ record, policy, role, operatorId }) {
  const candidate = prepareServiceIsolationEvidenceCandidate({ record, policy });
  if (!SERVICE_ISOLATION_ATTESTATION_ROLES.includes(role)) {
    throw new TypeError("service isolation attestation role is invalid");
  }
  const normalizedOperatorId = digest(operatorId, "service isolation attestation operatorId");
  const participant = candidate.record.participants.find((value) => (
    value.role === role && value.operatorId === normalizedOperatorId
  ));
  if (!participant) throw new Error("service isolation attestation identity is not a participant");
  return Object.freeze({
    domain: serviceIsolationEvidenceDomain(candidate.record),
    types: SERVICE_ISOLATION_ATTESTATION_TYPES,
    value: Object.freeze({
      isolationId: candidate.record.isolationId,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      role,
      operatorId: normalizedOperatorId,
      preparedAt: candidate.record.preparedAt,
      validUntil: candidate.record.validUntil,
    }),
  });
}

export function verifyServiceIsolationEvidence({
  record,
  policy,
  attestations,
  now = Math.floor(Date.now() / 1_000),
}) {
  const candidate = prepareServiceIsolationEvidenceCandidate({ record, policy });
  const observedAt = timestamp(now, "now");
  if (observedAt < candidate.record.preparedAt) throw new Error("service isolation evidence is from the future");
  if (observedAt > candidate.record.validUntil) throw new Error("service isolation evidence is expired");
  if (observedAt - candidate.record.preparedAt > candidate.policy.maximumEvidenceAgeSeconds) {
    throw new Error("service isolation evidence is stale");
  }
  if (!Array.isArray(attestations) || attestations.length !== candidate.record.participants.length) {
    throw new Error("service isolation requires one attestation from every participant");
  }
  const normalizedAttestations = attestations.map(normalizeAttestation);
  requireCanonicalOrder(normalizedAttestations, (value) => value.role, "service isolation attestations");
  const domain = serviceIsolationEvidenceDomain(candidate.record);
  for (let index = 0; index < candidate.record.participants.length; index += 1) {
    const participant = candidate.record.participants[index];
    const attestation = normalizedAttestations[index];
    if (attestation.role !== participant.role
        || attestation.operatorId !== participant.operatorId
        || attestation.signer !== participant.signer) {
      throw new Error("service isolation attestation does not exactly match its participant");
    }
    const recovered = verifyTypedData(domain, SERVICE_ISOLATION_ATTESTATION_TYPES, {
      isolationId: candidate.record.isolationId,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      role: participant.role,
      operatorId: participant.operatorId,
      preparedAt: candidate.record.preparedAt,
      validUntil: candidate.record.validUntil,
    }, attestation.signature);
    if (getAddress(recovered) !== participant.signer) {
      throw new Error("service isolation signature is invalid");
    }
  }
  const result = Object.freeze({
    schema: "treeswap.verified-service-isolation-evidence.v1",
    status: "three-role-service-isolation-attestations-cryptographically-verified",
    scope: "service-isolation-release-evidence-no-secrets-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    attestationSetDigest: hash(normalizedAttestations),
    record: candidate.record,
    policy: candidate.policy,
    authorizations: Object.freeze({ signing: false, broadcast: false, gateOpening: false, funding: false }),
  });
  assertServiceIsolationEvidenceIsSecretFree(result);
  verifiedServiceIsolation.add(result);
  return result;
}

export function buildServiceIsolationReleaseEvidence(verification) {
  if (!verifiedServiceIsolation.has(verification)) {
    throw new Error("service isolation evidence provenance is invalid");
  }
  const serviceSetDigest = hash(verification.record.services);
  const participantSetDigest = hash(verification.record.participants);
  return Object.freeze({
    schema: "treeswap.service-isolation-release-evidence.v1",
    evidenceDigest: hash(Object.freeze({
      schema: "treeswap.service-isolation-release-binding.v1",
      recordDigest: verification.recordDigest,
      policyDigest: verification.policyDigest,
      attestationSetDigest: verification.attestationSetDigest,
      serviceSetDigest,
      participantSetDigest,
    })),
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    attestationSetDigest: verification.attestationSetDigest,
    serviceSetDigest,
    participantSetDigest,
    environment: verification.record.environment,
    chainId: verification.record.chainId,
    verifyingContract: verification.record.verifyingContract,
    reviewedBuildCommit: verification.record.reviewedBuildCommit,
    protocolVersion: verification.record.protocolVersion,
    deploymentManifestDigest: verification.record.deploymentManifestDigest,
    preparedAt: verification.record.preparedAt,
    validUntil: verification.record.validUntil,
    serviceCount: verification.record.services.length,
    participantCount: verification.record.participants.length,
    participants: Object.freeze(verification.record.participants.map((participant) => Object.freeze({
      role: participant.role,
      operatorId: participant.operatorId,
      organizationId: participant.organizationId,
      signer: participant.signer,
    }))),
  });
}

export function buildServiceIsolationEvidenceSummary(verification) {
  const evidence = buildServiceIsolationReleaseEvidence(verification);
  return Object.freeze({
    ...evidence,
    schema: "treeswap.service-isolation-evidence-summary.v1",
    status: verification.status,
    scope: verification.scope,
    authorizations: verification.authorizations,
  });
}
