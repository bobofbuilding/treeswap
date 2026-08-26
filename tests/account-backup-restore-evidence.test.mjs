import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  ACCOUNT_BACKUP_RESTORE_ROLES,
  buildAccountBackupRestoreApprovalMessage,
  buildAccountBackupRestoreSummary,
  prepareAccountBackupRestoreEvidence,
  verifyAccountBackupRestoreEvidence,
} from "../lib/account-backup-restore-evidence.mjs";

const NOW = 2_100_000_000;
const SOURCE_COMMIT = "a".repeat(40);
const CUSTODIAN = new Wallet(id("TreeSwap account data custodian"));
const WITNESS = new Wallet(id("TreeSwap independent restore witness"));
const WALLETS = [CUSTODIAN, WITNESS];

function policy() {
  return {
    schema: "treeswap.account-backup-restore-policy.v1",
    sourceBranch: "main",
    sourceCommit: SOURCE_COMMIT,
    deploymentVersion: "12",
    sourceDatabaseDigest: id("TreeSwap source D1 database").toLowerCase(),
    maximumCeremonySeconds: 7_200,
    maximumAttestationLifetimeSeconds: 3_600,
    approvers: ACCOUNT_BACKUP_RESTORE_ROLES.map((role, index) => ({
      role,
      participantId: id(`account backup participant ${index}`).toLowerCase(),
      organizationId: id(`account backup organization ${index}`).toLowerCase(),
      identityEvidenceDigest: id(`account backup identity evidence ${index}`).toLowerCase(),
      ceremonyEvidenceDigest: id(`account backup ceremony evidence ${index}`).toLowerCase(),
      signer: WALLETS[index].address,
    })),
  };
}

function record() {
  const contentCommitment = id("ephemeral-keyed canonical account table content").toLowerCase();
  const schemaDigest = id("exact restored TreeSwap account schema").toLowerCase();
  return {
    schema: "treeswap.account-backup-restore-record.v1",
    status: "encrypted-export-restored-and-witnessed-in-isolated-database",
    scope: "account-data-recovery-evidence-only-no-production-restore-or-operational-authority",
    sourceBookmarkDigest: id("source D1 time-travel bookmark").toLowerCase(),
    targetDatabaseDigest: id("fresh isolated restore D1 database").toLowerCase(),
    encryptedExportDigest: id("encrypted retained D1 export").toLowerCase(),
    encryptionKeyCustodyDigest: id("separate backup key custody evidence").toLowerCase(),
    targetAccessIsolationDigest: id("restore target access isolation evidence").toLowerCase(),
    witnessReportDigest: id("independent restore witness report").toLowerCase(),
    sourceSchemaDigest: schemaDigest,
    restoreSchemaDigest: schemaDigest,
    sourceContentCommitment: contentCommitment,
    restoreContentCommitment: contentCommitment,
    sourceTableCounts: { challenges: 5, notifications: 2, sessions: 3 },
    restoreTableCounts: { challenges: 5, notifications: 2, sessions: 3 },
    verificationMethod: "hmac-sha256-canonical-table-export-ephemeral-key-destroyed",
    integrityStatus: "ok",
    exportStartedAt: NOW - 300,
    encryptedAt: NOW - 240,
    importedAt: NOW - 180,
    verifiedAt: NOW - 120,
    targetDestroyedAt: NOW - 60,
    encryptedExportRetained: true,
    exportPlaintextRetained: false,
    encryptionKeySeparated: true,
    verificationKeyDestroyed: true,
    exactExpectedTableSet: true,
    targetEmptyBeforeImport: true,
    sourceMutationObserved: false,
    sourceDatabaseRestoredInPlace: false,
    productionAuthorityAttachedToTarget: false,
    productionTrafficObservedOnTarget: false,
    outboundNotificationDeliveryEnabled: false,
    fundingAuthorization: false,
  };
}

async function attestations(candidatePolicy = policy(), candidateRecord = record(), wallets = WALLETS) {
  const result = [];
  for (let index = 0; index < ACCOUNT_BACKUP_RESTORE_ROLES.length; index += 1) {
    const role = ACCOUNT_BACKUP_RESTORE_ROLES[index];
    const attestedAt = NOW - 30 + index;
    const typed = buildAccountBackupRestoreApprovalMessage({
      policy: candidatePolicy,
      record: candidateRecord,
      role,
      attestedAt,
      observedAt: NOW,
    });
    result.push({
      role,
      participantId: candidatePolicy.approvers[index].participantId,
      signer: candidatePolicy.approvers[index].signer,
      attestedAt,
      signature: await wallets[index].signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return result;
}

test("verifies one encrypted export and isolated witnessed restore without operational authority", async () => {
  const candidatePolicy = policy();
  const candidateRecord = record();
  const verification = verifyAccountBackupRestoreEvidence({
    policy: candidatePolicy,
    record: candidateRecord,
    attestations: await attestations(candidatePolicy, candidateRecord),
    observedAt: NOW,
  });
  const summary = buildAccountBackupRestoreSummary(verification);

  assert.equal(summary.participantCount, 2);
  assert.equal(summary.attestedClaims.encryptedBackupRetainedWithoutPlaintext, true);
  assert.equal(summary.attestedClaims.freshIsolatedTargetRestoredAndDestroyed, true);
  assert.equal(summary.verifierLimitations.platformApiQueriedByVerifier, false);
  assert.equal(summary.verifierLimitations.productionRecoveryReadiness, false);
  assert.deepEqual(summary.authorizations, {
    platformMutation: false,
    productionRestore: false,
    accountEnablement: false,
    walletDispatch: false,
    lightningDispatch: false,
    settlement: false,
    funding: false,
    releaseActivation: false,
  });
  assert.match(summary.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(summary), /(signature|cookie|email|invoice|wallet.?address|token.?hash|private.?key|endpoint)/i);
  assert.throws(() => buildAccountBackupRestoreSummary(structuredClone(verification)), /provenance is invalid/);
});

test("binds exact source, destination, artifact, schema, content, counts, and causal times", () => {
  const mutations = [
    [(value) => { value.targetDatabaseDigest = policy().sourceDatabaseDigest; }, /isolated from the source/],
    [(value) => { value.restoreSchemaDigest = id("wrong schema").toLowerCase(); }, /schema does not match/],
    [(value) => { value.restoreContentCommitment = id("wrong content").toLowerCase(); }, /content does not match/],
    [(value) => { value.restoreTableCounts.sessions += 1; }, /counts do not match/],
    [(value) => { value.importedAt = value.encryptedAt - 1; }, /causally ordered/],
    [(value) => { value.targetDestroyedAt = value.exportStartedAt + 7_201; }, /policy duration/],
    [(value) => { value.targetDestroyedAt = NOW + 1; }, /future-dated/],
    [(value) => { value.verificationMethod = "sha256"; }, /method or integrity/],
    [(value) => { value.integrityStatus = "unknown"; }, /method or integrity/],
  ];
  for (const [mutate, expected] of mutations) {
    const candidateRecord = record();
    mutate(candidateRecord);
    assert.throws(() => prepareAccountBackupRestoreEvidence({
      policy: policy(),
      record: candidateRecord,
      observedAt: NOW,
    }), expected);
  }
});

test("rejects retained plaintext, in-place restore, production attachment, mutation, or enabled delivery", () => {
  for (const field of [
    "exportPlaintextRetained",
    "sourceMutationObserved",
    "sourceDatabaseRestoredInPlace",
    "productionAuthorityAttachedToTarget",
    "productionTrafficObservedOnTarget",
    "outboundNotificationDeliveryEnabled",
    "fundingAuthorization",
  ]) {
    const candidateRecord = record();
    candidateRecord[field] = true;
    assert.throws(() => prepareAccountBackupRestoreEvidence({
      policy: policy(),
      record: candidateRecord,
      observedAt: NOW,
    }), /must remain false/);
  }
  for (const field of [
    "encryptedExportRetained",
    "encryptionKeySeparated",
    "verificationKeyDestroyed",
    "exactExpectedTableSet",
    "targetEmptyBeforeImport",
  ]) {
    const candidateRecord = record();
    candidateRecord[field] = false;
    assert.throws(() => prepareAccountBackupRestoreEvidence({
      policy: policy(),
      record: candidateRecord,
      observedAt: NOW,
    }), /must be true/);
  }
});

test("requires distinct custodian and witness authority and evidence", () => {
  const mutations = [
    [(value) => { value.approvers.reverse(); }, /canonical roles/],
    [(value) => { value.approvers[1].participantId = value.approvers[0].participantId; }, /identities must be distinct/],
    [(value) => { value.approvers[1].organizationId = value.approvers[0].organizationId; }, /organizations must be distinct/],
    [(value) => { value.approvers[1].signer = value.approvers[0].signer; }, /signers must be distinct/],
    [(value) => { value.approvers[1].ceremonyEvidenceDigest = value.approvers[0].identityEvidenceDigest; }, /commitments must be distinct/],
    [(value) => { value.maximumCeremonySeconds = 21_601; }, /safe integer/],
    [(value) => { value.maximumAttestationLifetimeSeconds = 86_401; }, /safe integer/],
  ];
  for (const [mutate, expected] of mutations) {
    const candidatePolicy = policy();
    mutate(candidatePolicy);
    assert.throws(() => prepareAccountBackupRestoreEvidence({
      policy: candidatePolicy,
      record: record(),
      observedAt: NOW,
    }), expected);
  }
});

test("artifact commitments cannot be reused as identity or control evidence", () => {
  const candidatePolicy = policy();
  const candidateRecord = record();
  candidatePolicy.approvers[0].ceremonyEvidenceDigest = candidateRecord.encryptedExportDigest;
  assert.throws(() => prepareAccountBackupRestoreEvidence({
    policy: candidatePolicy,
    record: candidateRecord,
    observedAt: NOW,
  }), /database, artifact, participant, and control commitments must be distinct/);

  const databaseAsParticipant = policy();
  databaseAsParticipant.approvers[0].participantId = databaseAsParticipant.sourceDatabaseDigest;
  assert.throws(() => prepareAccountBackupRestoreEvidence({
    policy: databaseAsParticipant,
    record: record(),
    observedAt: NOW,
  }), /database, artifact, participant, and control commitments must be distinct/);

  const databaseAsArtifact = record();
  databaseAsArtifact.encryptedExportDigest = policy().sourceDatabaseDigest;
  assert.throws(() => prepareAccountBackupRestoreEvidence({
    policy: policy(),
    record: databaseAsArtifact,
    observedAt: NOW,
  }), /database, artifact, participant, and control commitments must be distinct/);
});

test("rejects missing, reordered, copied, stale, future, and substituted attestations", async () => {
  const candidatePolicy = policy();
  const candidateRecord = record();
  const signed = await attestations(candidatePolicy, candidateRecord);
  const verify = (candidateAttestations, observedAt = NOW) => verifyAccountBackupRestoreEvidence({
    policy: candidatePolicy,
    record: candidateRecord,
    attestations: candidateAttestations,
    observedAt,
  });
  assert.throws(() => verify(signed.slice(0, 1)), /exactly 2/);
  assert.throws(() => verify([...signed].reverse()), /canonical roles/);
  const substituted = structuredClone(signed);
  substituted[0].participantId = substituted[1].participantId;
  assert.throws(() => verify(substituted), /does not match/);
  const wrongSignatures = await attestations(candidatePolicy, candidateRecord, [WITNESS, CUSTODIAN]);
  assert.throws(() => verify(wrongSignatures), /signature is invalid/);
  assert.throws(() => verify(signed, candidateRecord.targetDestroyedAt + 3_601), /expired/);

  const future = structuredClone(signed);
  future[0].attestedAt = NOW + 1;
  assert.throws(() => verify(future), /attestation time is invalid/);
  const early = structuredClone(signed);
  early[0].attestedAt = candidateRecord.targetDestroyedAt - 1;
  assert.throws(() => verify(early), /attestation time is invalid/);
});

test("rejects mutation, extra fields, accessors, coercion, decorated arrays, and secret-bearing data", () => {
  let getterCalls = 0;
  const accessorPolicy = policy();
  Object.defineProperty(accessorPolicy, "sourceCommit", {
    enumerable: true,
    get() { getterCalls += 1; return SOURCE_COMMIT; },
  });
  assert.throws(() => prepareAccountBackupRestoreEvidence({
    policy: accessorPolicy,
    record: record(),
    observedAt: NOW,
  }), /data properties/);
  assert.equal(getterCalls, 0);

  let inputGetterCalls = 0;
  const accessorInput = { record: record(), observedAt: NOW };
  Object.defineProperty(accessorInput, "policy", {
    enumerable: true,
    get() { inputGetterCalls += 1; return policy(); },
  });
  assert.throws(() => prepareAccountBackupRestoreEvidence(accessorInput), /data properties/);
  assert.equal(inputGetterCalls, 0);

  assert.throws(() => prepareAccountBackupRestoreEvidence({
    policy: policy(), record: record(), observedAt: NOW, extra: true,
  }), /fields are not exact/);

  const extra = record();
  extra.rawExport = "sensitive";
  assert.throws(() => prepareAccountBackupRestoreEvidence({
    policy: policy(), record: extra, observedAt: NOW,
  }), /fields are not exact/);

  const coercible = record();
  coercible.sourceTableCounts.sessions = { valueOf: () => 3 };
  assert.throws(() => prepareAccountBackupRestoreEvidence({
    policy: policy(), record: coercible, observedAt: NOW,
  }), /safe integer/);

  const decorated = policy();
  decorated.approvers.extra = true;
  assert.throws(() => prepareAccountBackupRestoreEvidence({
    policy: decorated, record: record(), observedAt: NOW,
  }), /dense undecorated array/);

  const secret = record();
  secret.scope = "https://private-d1.example";
  assert.throws(() => prepareAccountBackupRestoreEvidence({
    policy: policy(), record: secret, observedAt: NOW,
  }), /identity is invalid/);
});

test("typed approvals bind both roles to the same non-authorizing ceremony", () => {
  const candidatePolicy = policy();
  const candidateRecord = record();
  const custodian = buildAccountBackupRestoreApprovalMessage({
    policy: candidatePolicy,
    record: candidateRecord,
    role: ACCOUNT_BACKUP_RESTORE_ROLES[0],
    attestedAt: NOW - 30,
    observedAt: NOW,
  });
  const witness = buildAccountBackupRestoreApprovalMessage({
    policy: candidatePolicy,
    record: candidateRecord,
    role: ACCOUNT_BACKUP_RESTORE_ROLES[1],
    attestedAt: NOW - 29,
    observedAt: NOW,
  });
  assert.equal(custodian.domain.name, "TreeSwap Account Backup Restore Evidence");
  assert.equal(custodian.value.recordDigest, witness.value.recordDigest);
  assert.equal(custodian.value.policyDigest, witness.value.policyDigest);
  assert.notEqual(custodian.value.role, witness.value.role);
  assert.notEqual(custodian.value.participantId, witness.value.participantId);
});

test("operator CLIs verify exact published source and expose no key, export, import, or restore action", async () => {
  const prepare = await readFile(
    new URL("../scripts/prepare-account-backup-restore-attestation.mjs", import.meta.url),
    "utf8",
  );
  const verify = await readFile(
    new URL("../scripts/verify-account-backup-restore-evidence.mjs", import.meta.url),
    "utf8",
  );
  for (const source of [prepare, verify]) {
    assert.match(source, /currentPublishedWalletSessionRouteReviewSource/);
    assert.match(source, /revalidatePublishedWalletSessionRouteReviewSource/);
    assert.doesNotMatch(source, /signTypedData|privateKey|wrangler\s+d1\s+(?:export|execute|time-travel)/);
    assert.doesNotMatch(source, /fetch\(|spawn|execFile|execSync/);
  }
  assert.doesNotMatch(prepare, /writeExclusiveJson/);
  assert.match(verify, /writeExclusiveJson/);
});
