import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";

export const ACCOUNT_BACKUP_RESTORE_ROLES = Object.freeze([
  "account-data-custodian",
  "independent-restore-witness",
]);

export const ACCOUNT_BACKUP_RESTORE_TYPES = Object.freeze({
  AccountBackupRestoreEvidence: Object.freeze([
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "sourceCommit", type: "bytes20" }),
    Object.freeze({ name: "sourceDatabaseDigest", type: "bytes32" }),
    Object.freeze({ name: "targetDatabaseDigest", type: "bytes32" }),
    Object.freeze({ name: "sourceBookmarkDigest", type: "bytes32" }),
    Object.freeze({ name: "encryptedExportDigest", type: "bytes32" }),
    Object.freeze({ name: "contentCommitment", type: "bytes32" }),
    Object.freeze({ name: "approverSetDigest", type: "bytes32" }),
    Object.freeze({ name: "role", type: "bytes32" }),
    Object.freeze({ name: "participantId", type: "bytes32" }),
    Object.freeze({ name: "targetDestroyedAt", type: "uint64" }),
    Object.freeze({ name: "attestedAt", type: "uint64" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
  ]),
});

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/;
const VERSION = /^[1-9][0-9]*$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const MAXIMUM_CEREMONY_SECONDS = 6 * 60 * 60;
const MAXIMUM_ATTESTATION_LIFETIME_SECONDS = 24 * 60 * 60;

const POLICY_FIELDS = Object.freeze([
  "approvers",
  "deploymentVersion",
  "maximumAttestationLifetimeSeconds",
  "maximumCeremonySeconds",
  "schema",
  "sourceBranch",
  "sourceCommit",
  "sourceDatabaseDigest",
]);
const APPROVER_FIELDS = Object.freeze([
  "ceremonyEvidenceDigest",
  "identityEvidenceDigest",
  "organizationId",
  "participantId",
  "role",
  "signer",
]);
const RECORD_FIELDS = Object.freeze([
  "encryptedAt",
  "encryptedExportDigest",
  "encryptedExportRetained",
  "encryptionKeyCustodyDigest",
  "encryptionKeySeparated",
  "exactExpectedTableSet",
  "exportPlaintextRetained",
  "exportStartedAt",
  "fundingAuthorization",
  "importedAt",
  "integrityStatus",
  "outboundNotificationDeliveryEnabled",
  "productionAuthorityAttachedToTarget",
  "productionTrafficObservedOnTarget",
  "restoreContentCommitment",
  "restoreSchemaDigest",
  "restoreTableCounts",
  "schema",
  "scope",
  "sourceBookmarkDigest",
  "sourceContentCommitment",
  "sourceDatabaseRestoredInPlace",
  "sourceMutationObserved",
  "sourceSchemaDigest",
  "sourceTableCounts",
  "status",
  "targetAccessIsolationDigest",
  "targetDatabaseDigest",
  "targetDestroyedAt",
  "targetEmptyBeforeImport",
  "verifiedAt",
  "verificationKeyDestroyed",
  "verificationMethod",
  "witnessReportDigest",
]);
const COUNT_FIELDS = Object.freeze(["challenges", "notifications", "sessions"]);
const ATTESTATION_FIELDS = Object.freeze([
  "attestedAt",
  "participantId",
  "role",
  "signature",
  "signer",
]);
const verifiedEvidence = new WeakMap();

function exactRecord(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...fields].sort();
  if (keys.some((key) => typeof key !== "string") || keys.length !== expected.length
      || [...keys].sort().some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function exactArray(value, length, name) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${name} must contain exactly ${length} entries`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = ["length", ...Array.from({ length }, (_, index) => String(index))];
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string")
      || [...keys].sort().some((key, index) => key !== [...expected].sort()[index])) {
    throw new TypeError(`${name} must be a dense undecorated array`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function valueDigest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function digest(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value) || value === ZERO_DIGEST) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return value;
}

function safeInteger(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  let normalized;
  try { normalized = getAddress(value); } catch { throw new TypeError(`${name} must be an Ethereum address`); }
  if (normalized === ZERO_ADDRESS || normalized !== value) {
    throw new TypeError(`${name} must be a nonzero canonical Ethereum address`);
  }
  return normalized;
}

function sourceBranch(value) {
  if (typeof value !== "string" || !BRANCH.test(value) || value.includes("..") || value.includes("//")
      || value.startsWith("-") || value.endsWith(".") || value.endsWith("/")) {
    throw new TypeError("account backup source branch is invalid");
  }
  return value;
}

function sourceCommit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new TypeError("account backup source commit must be full lowercase Git commit");
  }
  return value;
}

function requireDistinct(values, name) {
  if (new Set(values).size !== values.length) throw new Error(`${name} must be distinct`);
}

function normalizeApprover(raw, index) {
  const value = exactRecord(raw, APPROVER_FIELDS, `account backup approvers[${index}]`);
  if (value.role !== ACCOUNT_BACKUP_RESTORE_ROLES[index]) {
    throw new Error("account backup approvers must use exact canonical roles");
  }
  return Object.freeze({
    role: value.role,
    participantId: digest(value.participantId, `account backup approvers[${index}].participantId`),
    organizationId: digest(value.organizationId, `account backup approvers[${index}].organizationId`),
    identityEvidenceDigest: digest(
      value.identityEvidenceDigest,
      `account backup approvers[${index}].identityEvidenceDigest`,
    ),
    ceremonyEvidenceDigest: digest(
      value.ceremonyEvidenceDigest,
      `account backup approvers[${index}].ceremonyEvidenceDigest`,
    ),
    signer: address(value.signer, `account backup approvers[${index}].signer`),
  });
}

function normalizePolicy(raw) {
  const value = exactRecord(raw, POLICY_FIELDS, "account backup policy");
  if (value.schema !== "treeswap.account-backup-restore-policy.v1") {
    throw new TypeError("account backup policy schema is invalid");
  }
  if (typeof value.deploymentVersion !== "string" || !VERSION.test(value.deploymentVersion)) {
    throw new TypeError("account backup deployment version is invalid");
  }
  const approvers = exactArray(value.approvers, ACCOUNT_BACKUP_RESTORE_ROLES.length, "account backup approvers")
    .map(normalizeApprover);
  requireDistinct(approvers.map((entry) => entry.participantId), "account backup participant identities");
  requireDistinct(approvers.map((entry) => entry.organizationId), "account backup participant organizations");
  requireDistinct(approvers.map((entry) => entry.signer.toLowerCase()), "account backup participant signers");
  const commitments = approvers.flatMap((entry) => [
    entry.participantId,
    entry.organizationId,
    entry.identityEvidenceDigest,
    entry.ceremonyEvidenceDigest,
  ]);
  requireDistinct(commitments, "account backup participant and evidence commitments");
  return Object.freeze({
    schema: value.schema,
    sourceBranch: sourceBranch(value.sourceBranch),
    sourceCommit: sourceCommit(value.sourceCommit),
    deploymentVersion: value.deploymentVersion,
    sourceDatabaseDigest: digest(value.sourceDatabaseDigest, "account backup source database digest"),
    maximumCeremonySeconds: safeInteger(
      value.maximumCeremonySeconds,
      "account backup maximum ceremony seconds",
      60,
      MAXIMUM_CEREMONY_SECONDS,
    ),
    maximumAttestationLifetimeSeconds: safeInteger(
      value.maximumAttestationLifetimeSeconds,
      "account backup maximum attestation lifetime seconds",
      60,
      MAXIMUM_ATTESTATION_LIFETIME_SECONDS,
    ),
    approvers: Object.freeze(approvers),
  });
}

function normalizeCounts(raw, name) {
  const value = exactRecord(raw, COUNT_FIELDS, name);
  return Object.freeze({
    challenges: safeInteger(value.challenges, `${name}.challenges`),
    notifications: safeInteger(value.notifications, `${name}.notifications`),
    sessions: safeInteger(value.sessions, `${name}.sessions`),
  });
}

function requireFalse(value, name) {
  if (value !== false) throw new Error(`${name} must remain false`);
  return false;
}

function requireTrue(value, name) {
  if (value !== true) throw new Error(`${name} must be true`);
  return true;
}

function normalizeRecord(raw, policy, observedAt) {
  const value = exactRecord(raw, RECORD_FIELDS, "account backup record");
  if (value.schema !== "treeswap.account-backup-restore-record.v1"
      || value.status !== "encrypted-export-restored-and-witnessed-in-isolated-database"
      || value.scope !== "account-data-recovery-evidence-only-no-production-restore-or-operational-authority") {
    throw new Error("account backup record identity is invalid");
  }
  const times = {
    exportStartedAt: safeInteger(value.exportStartedAt, "account backup export start", 1),
    encryptedAt: safeInteger(value.encryptedAt, "account backup encryption time", 1),
    importedAt: safeInteger(value.importedAt, "account backup import time", 1),
    verifiedAt: safeInteger(value.verifiedAt, "account backup verification time", 1),
    targetDestroyedAt: safeInteger(value.targetDestroyedAt, "account backup target destruction time", 1),
  };
  if (!(times.exportStartedAt <= times.encryptedAt
      && times.encryptedAt <= times.importedAt
      && times.importedAt <= times.verifiedAt
      && times.verifiedAt <= times.targetDestroyedAt)) {
    throw new Error("account backup ceremony times are not causally ordered");
  }
  if (times.targetDestroyedAt - times.exportStartedAt > policy.maximumCeremonySeconds) {
    throw new Error("account backup ceremony exceeded its policy duration");
  }
  if (times.targetDestroyedAt > observedAt) throw new Error("account backup ceremony is future-dated");

  const sourceCounts = normalizeCounts(value.sourceTableCounts, "account backup source counts");
  const restoreCounts = normalizeCounts(value.restoreTableCounts, "account backup restore counts");
  if (JSON.stringify(sourceCounts) !== JSON.stringify(restoreCounts)) {
    throw new Error("account backup restored table counts do not match source counts");
  }
  const sourceSchemaDigest = digest(value.sourceSchemaDigest, "account backup source schema digest");
  const restoreSchemaDigest = digest(value.restoreSchemaDigest, "account backup restored schema digest");
  if (sourceSchemaDigest !== restoreSchemaDigest) {
    throw new Error("account backup restored schema does not match source schema");
  }
  const sourceContentCommitment = digest(
    value.sourceContentCommitment,
    "account backup source content commitment",
  );
  const restoreContentCommitment = digest(
    value.restoreContentCommitment,
    "account backup restored content commitment",
  );
  if (sourceContentCommitment !== restoreContentCommitment) {
    throw new Error("account backup restored content does not match source content");
  }
  const targetDatabaseDigest = digest(value.targetDatabaseDigest, "account backup target database digest");
  if (targetDatabaseDigest === policy.sourceDatabaseDigest) {
    throw new Error("account backup restore target must be isolated from the source database");
  }
  if (value.verificationMethod !== "hmac-sha256-canonical-table-export-ephemeral-key-destroyed"
      || value.integrityStatus !== "ok") {
    throw new Error("account backup verification method or integrity result is invalid");
  }

  const record = Object.freeze({
    schema: value.schema,
    status: value.status,
    scope: value.scope,
    sourceBookmarkDigest: digest(value.sourceBookmarkDigest, "account backup source bookmark digest"),
    targetDatabaseDigest,
    encryptedExportDigest: digest(value.encryptedExportDigest, "account backup encrypted export digest"),
    encryptionKeyCustodyDigest: digest(
      value.encryptionKeyCustodyDigest,
      "account backup encryption-key custody digest",
    ),
    targetAccessIsolationDigest: digest(
      value.targetAccessIsolationDigest,
      "account backup target access-isolation digest",
    ),
    witnessReportDigest: digest(value.witnessReportDigest, "account backup witness report digest"),
    sourceSchemaDigest,
    restoreSchemaDigest,
    sourceContentCommitment,
    restoreContentCommitment,
    sourceTableCounts: sourceCounts,
    restoreTableCounts: restoreCounts,
    verificationMethod: value.verificationMethod,
    integrityStatus: value.integrityStatus,
    ...times,
    encryptedExportRetained: requireTrue(value.encryptedExportRetained, "encrypted export retention"),
    exportPlaintextRetained: requireFalse(value.exportPlaintextRetained, "plaintext export retention"),
    encryptionKeySeparated: requireTrue(value.encryptionKeySeparated, "encryption-key separation"),
    verificationKeyDestroyed: requireTrue(value.verificationKeyDestroyed, "verification-key destruction"),
    exactExpectedTableSet: requireTrue(value.exactExpectedTableSet, "exact expected table set"),
    targetEmptyBeforeImport: requireTrue(value.targetEmptyBeforeImport, "empty restore target"),
    sourceMutationObserved: requireFalse(value.sourceMutationObserved, "source mutation"),
    sourceDatabaseRestoredInPlace: requireFalse(
      value.sourceDatabaseRestoredInPlace,
      "in-place source restore",
    ),
    productionAuthorityAttachedToTarget: requireFalse(
      value.productionAuthorityAttachedToTarget,
      "production authority on restore target",
    ),
    productionTrafficObservedOnTarget: requireFalse(
      value.productionTrafficObservedOnTarget,
      "production traffic on restore target",
    ),
    outboundNotificationDeliveryEnabled: requireFalse(
      value.outboundNotificationDeliveryEnabled,
      "outbound notification delivery",
    ),
    fundingAuthorization: requireFalse(value.fundingAuthorization, "account backup funding authorization"),
  });
  const evidenceCommitments = [
    policy.sourceDatabaseDigest,
    record.sourceBookmarkDigest,
    record.targetDatabaseDigest,
    record.encryptedExportDigest,
    record.encryptionKeyCustodyDigest,
    record.targetAccessIsolationDigest,
    record.witnessReportDigest,
    record.sourceSchemaDigest,
    record.sourceContentCommitment,
  ];
  const participantCommitments = policy.approvers.flatMap((approver) => [
    approver.participantId,
    approver.organizationId,
    approver.identityEvidenceDigest,
    approver.ceremonyEvidenceDigest,
  ]);
  requireDistinct(
    [...evidenceCommitments, ...participantCommitments],
    "account backup database, artifact, participant, and control commitments",
  );
  return record;
}

export function assertAccountBackupRestoreEvidenceIsSecretFree(value) {
  const forbiddenKey = /(?:authorization(?!s)|cookie|email|endpoint|invoice|macaroon|mnemonic|password|preimage|private.?key|public.?key|rpc.?url|secret|session.?token|token.?hash|wallet.?address)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of exactArray(entry, entry.length, "account backup evidence array")) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string" && (/(?:https?|wss?):\/\//i.test(entry)
          || /-----BEGIN [A-Z ]*KEY-----/.test(entry)
          || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry))) {
        throw new Error("account backup evidence contains endpoint or account material");
      }
      return;
    }
    const prototype = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null)
        || keys.some((key) => typeof key !== "string")) {
      throw new Error("account backup evidence contains non-data material");
    }
    for (const key of keys) {
      if (key !== "fundingAuthorization" && forbiddenKey.test(key)) {
        throw new Error(`account backup evidence contains forbidden field ${key}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new Error("account backup evidence contains non-data material");
      }
      visit(descriptor.value);
    }
  };
  visit(value);
  return true;
}

export function prepareAccountBackupRestoreEvidence(rawInput) {
  const input = exactRecord(
    rawInput,
    Object.hasOwn(rawInput ?? {}, "observedAt")
      ? ["observedAt", "policy", "record"]
      : ["policy", "record"],
    "account backup preparation input",
  );
  const rawPolicy = input.policy;
  const rawRecord = input.record;
  const observedAt = Object.hasOwn(input, "observedAt")
    ? input.observedAt
    : Math.floor(Date.now() / 1_000);
  const now = safeInteger(observedAt, "account backup observation time", 1);
  const policy = normalizePolicy(rawPolicy);
  const record = normalizeRecord(rawRecord, policy, now);
  const validUntil = record.targetDestroyedAt + policy.maximumAttestationLifetimeSeconds;
  if (now > validUntil) throw new Error("account backup evidence is expired");
  const candidate = Object.freeze({
    schema: "treeswap.prepared-account-backup-restore-evidence.v1",
    status: "backup-restore-ceremony-reconstructed-awaiting-two-attestations",
    scope: "signed-account-recovery-claims-only-no-platform-query-export-import-restore-deletion-or-funding-authority",
    recordDigest: valueDigest(record),
    policyDigest: valueDigest(policy),
    approverSetDigest: valueDigest(policy.approvers),
    validUntil,
    record,
    policy,
  });
  assertAccountBackupRestoreEvidenceIsSecretFree(candidate);
  return candidate;
}

export function accountBackupRestoreDomain(candidate) {
  return Object.freeze({
    name: "TreeSwap Account Backup Restore Evidence",
    version: "1",
    salt: candidate.policy.sourceDatabaseDigest,
  });
}

export function buildAccountBackupRestoreApprovalMessage(rawInput) {
  const input = exactRecord(
    rawInput,
    Object.hasOwn(rawInput ?? {}, "observedAt")
      ? ["attestedAt", "observedAt", "policy", "record", "role"]
      : ["attestedAt", "policy", "record", "role"],
    "account backup approval input",
  );
  const { policy, record, role, attestedAt } = input;
  const observedAt = Object.hasOwn(input, "observedAt")
    ? input.observedAt
    : Math.floor(Date.now() / 1_000);
  const candidate = prepareAccountBackupRestoreEvidence({ policy, record, observedAt });
  const index = ACCOUNT_BACKUP_RESTORE_ROLES.indexOf(role);
  if (index < 0) throw new Error("account backup approval role is invalid");
  const approver = candidate.policy.approvers[index];
  const signedAt = safeInteger(attestedAt, "account backup attestation time", 1);
  if (signedAt < candidate.record.targetDestroyedAt || signedAt > observedAt
      || signedAt > candidate.validUntil) {
    throw new Error("account backup attestation time is invalid");
  }
  return Object.freeze({
    domain: accountBackupRestoreDomain(candidate),
    types: ACCOUNT_BACKUP_RESTORE_TYPES,
    value: Object.freeze({
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      sourceCommit: `0x${candidate.policy.sourceCommit}`,
      sourceDatabaseDigest: candidate.policy.sourceDatabaseDigest,
      targetDatabaseDigest: candidate.record.targetDatabaseDigest,
      sourceBookmarkDigest: candidate.record.sourceBookmarkDigest,
      encryptedExportDigest: candidate.record.encryptedExportDigest,
      contentCommitment: candidate.record.sourceContentCommitment,
      approverSetDigest: candidate.approverSetDigest,
      role: keccak256(toUtf8Bytes(role)).toLowerCase(),
      participantId: approver.participantId,
      targetDestroyedAt: candidate.record.targetDestroyedAt,
      attestedAt: signedAt,
      validUntil: candidate.validUntil,
    }),
  });
}

function normalizeAttestations(raw) {
  return exactArray(raw, ACCOUNT_BACKUP_RESTORE_ROLES.length, "account backup attestations")
    .map((rawAttestation, index) => {
      const value = exactRecord(rawAttestation, ATTESTATION_FIELDS, `account backup attestations[${index}]`);
      if (value.role !== ACCOUNT_BACKUP_RESTORE_ROLES[index]) {
        throw new Error("account backup attestations must use exact canonical roles");
      }
      if (typeof value.signature !== "string" || !isHexString(value.signature, 65)
          || value.signature !== value.signature.toLowerCase()) {
        throw new TypeError(`account backup attestations[${index}].signature is invalid`);
      }
      return Object.freeze({
        role: value.role,
        participantId: digest(value.participantId, `account backup attestations[${index}].participantId`),
        signer: address(value.signer, `account backup attestations[${index}].signer`),
        attestedAt: safeInteger(value.attestedAt, `account backup attestations[${index}].attestedAt`, 1),
        signature: value.signature,
      });
    });
}

export function verifyAccountBackupRestoreEvidence(rawInput) {
  const input = exactRecord(
    rawInput,
    Object.hasOwn(rawInput ?? {}, "observedAt")
      ? ["attestations", "observedAt", "policy", "record"]
      : ["attestations", "policy", "record"],
    "account backup verification input",
  );
  const { policy, record, attestations } = input;
  const observedAt = Object.hasOwn(input, "observedAt")
    ? input.observedAt
    : Math.floor(Date.now() / 1_000);
  const now = safeInteger(observedAt, "account backup verification time", 1);
  const candidate = prepareAccountBackupRestoreEvidence({ policy, record, observedAt: now });
  const normalizedAttestations = normalizeAttestations(attestations);
  for (let index = 0; index < normalizedAttestations.length; index += 1) {
    const attestation = normalizedAttestations[index];
    const approver = candidate.policy.approvers[index];
    if (attestation.role !== approver.role || attestation.participantId !== approver.participantId
        || attestation.signer !== approver.signer) {
      throw new Error("account backup attestation does not match its approver");
    }
    const typed = buildAccountBackupRestoreApprovalMessage({
      policy,
      record,
      role: approver.role,
      attestedAt: attestation.attestedAt,
      observedAt: now,
    });
    let recovered;
    try {
      recovered = getAddress(verifyTypedData(typed.domain, typed.types, typed.value, attestation.signature));
    } catch {
      throw new Error("account backup attestation signature is invalid");
    }
    if (recovered !== approver.signer) throw new Error("account backup attestation signature is invalid");
  }
  requireDistinct(normalizedAttestations.map((entry) => entry.participantId), "account backup attestation identities");
  requireDistinct(normalizedAttestations.map((entry) => entry.signer.toLowerCase()), "account backup attestation signers");
  const attestationDigest = valueDigest(normalizedAttestations.map((entry) => ({
    role: entry.role,
    participantId: entry.participantId,
    signer: entry.signer,
    attestedAt: entry.attestedAt,
    signatureDigest: valueDigest(entry.signature),
  })));
  const verification = Object.freeze({
    schema: "treeswap.verified-account-backup-restore-evidence.v1",
    status: "two-account-backup-restore-attestations-verified-external-artifacts-still-require-review",
    scope: "signed-ceremony-claims-only-no-platform-query-export-import-restore-deletion-or-funding-authority",
    evidenceDigest: valueDigest({
      schema: "treeswap.account-backup-restore-evidence-binding.v1",
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      attestationDigest,
    }),
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    attestationDigest,
    sourceBranch: candidate.policy.sourceBranch,
    sourceCommit: candidate.policy.sourceCommit,
    deploymentVersion: candidate.policy.deploymentVersion,
    sourceDatabaseDigest: candidate.policy.sourceDatabaseDigest,
    targetDatabaseDigest: candidate.record.targetDatabaseDigest,
    sourceBookmarkDigest: candidate.record.sourceBookmarkDigest,
    encryptedExportDigest: candidate.record.encryptedExportDigest,
    participantCount: candidate.policy.approvers.length,
    attestedAt: Math.max(...normalizedAttestations.map((entry) => entry.attestedAt)),
    verifiedAt: now,
    attestedClaims: Object.freeze({
      encryptedBackupRetainedWithoutPlaintext: true,
      freshIsolatedTargetRestoredAndDestroyed: true,
      exactSchemaCountsAndKeyedContentCommitmentMatched: true,
      productionAuthorityAndTrafficExcluded: true,
    }),
    verifierLimitations: Object.freeze({
      platformApiQueriedByVerifier: false,
      exportOrImportPerformedByVerifier: false,
      encryptedArtifactInspectedByVerifier: false,
      externalIdentityOrIndependenceEstablishedByVerifier: false,
      productionRecoveryReadiness: false,
    }),
    authorizations: Object.freeze({
      platformMutation: false,
      productionRestore: false,
      accountEnablement: false,
      walletDispatch: false,
      lightningDispatch: false,
      settlement: false,
      funding: false,
      releaseActivation: false,
    }),
  });
  assertAccountBackupRestoreEvidenceIsSecretFree(verification);
  verifiedEvidence.set(verification, candidate);
  return verification;
}

export function buildAccountBackupRestoreSummary(verification) {
  if (!verifiedEvidence.has(verification)) throw new Error("account backup verification provenance is invalid");
  return Object.freeze({ ...verification });
}
