import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open as openFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  getAddress,
  verifyTypedData,
} from "ethers";
import {
  verifiedPublicTestnetRecoveryActivation,
} from "./capabilities.mjs";
import {
  CoordinatorStore,
  coordinatorCommitmentDigest,
  isVerifiedCoordinatorStore,
} from "./coordinator-store.mjs";
import {
  normalizeCoordinatorRecoveryJobs,
  snapshotCoordinatorRecoveryEvidencePolicy,
  snapshotCoordinatorRecoveryRuntime,
} from "./coordinator-recovery-job.mjs";
import {
  PUBLIC_TESTNET_BOOTSTRAP_RELEASE_EVIDENCE_PATH_FIELDS,
  PUBLIC_TESTNET_RELEASE_EVIDENCE_PATH_FIELDS,
  rebuildPublicTestnetBootstrapReleaseCandidateFromFiles,
  rebuildPublicTestnetReleaseCandidateFromFiles,
} from "./public-testnet-release-files.mjs";
import {
  createPublicTestnetReleaseApprovalProviderSet,
  inspectPreparedPublicTestnetReleaseCandidate,
  inspectPublicTestnetReleaseApprovalBundle,
} from "./public-testnet-release-approval.mjs";
import {
  solverDaemonEvidencePolicyDigest,
} from "./solver-daemon-evidence.mjs";
import {
  solverLightningNodePubkeyDigest,
  verifiedSolverRecoveryAuthority,
} from "./solver-capability.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const RELATIVE_PATH = /^[0-9A-Za-z][0-9A-Za-z._/-]{0,1023}$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const OPERATING_SET_ROLES = new Set(["old", "new"]);
const CHANGE_KINDS = new Set([
  "provider",
  "service-runtime",
  "solver-key",
  "storage-schema",
  "wallet-owner",
]);
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_BACKUP_BYTES = 16 * 1024 * 1024 * 1024;
const ZERO_AUTHORIZATIONS = Object.freeze({
  funding: false,
  lightningDispatch: false,
  newExposure: false,
});

export const RETAINED_RELEASE_CUSTODY_SCHEMA =
  "treeswap.retained-release-custody.v1";
export const RETAINED_RELEASE_CUSTODY_SUMMARY_SCHEMA =
  "treeswap.retained-release-custody-summary.v1";
export const RETAINED_RELEASE_RECOVERY_READINESS_SCHEMA =
  "treeswap.retained-release-recovery-readiness.v1";
export const RETAINED_RELEASE_RECOVERY_JOB_SET_SCHEMA =
  "treeswap.retained-release-recovery-job-set.v1";
export const RETAINED_RELEASE_RECOVERY_DRILL_SCHEMA =
  "treeswap.retained-release-recovery-drill.v1";
export const RETAINED_RELEASE_ROTATION_DECISION_SCHEMA =
  "treeswap.retained-release-rotation-decision.v1";

export const RETAINED_RELEASE_RECOVERY_DRILL_TYPES = Object.freeze({
  RetainedReleaseRecoveryDrill: Object.freeze([
    Object.freeze({ name: "drillId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "releaseRecordDigest", type: "bytes32" }),
    Object.freeze({ name: "custodyPackageDigest", type: "bytes32" }),
    Object.freeze({ name: "liabilitySnapshotDigest", type: "bytes32" }),
    Object.freeze({ name: "operatingSetDigest", type: "bytes32" }),
    Object.freeze({ name: "operatingSetRole", type: "string" }),
    Object.freeze({ name: "recoveryEvidenceDigest", type: "bytes32" }),
    Object.freeze({ name: "postconditionDigest", type: "bytes32" }),
    Object.freeze({ name: "recoveredActionCount", type: "uint64" }),
    Object.freeze({ name: "startedAt", type: "uint64" }),
    Object.freeze({ name: "finishedAt", type: "uint64" }),
  ]),
});

const verifiedCustodies = new WeakMap();
const verifiedReadiness = new WeakMap();
const verifiedRecoveryJobSets = new WeakMap();
const consumedRecoveryJobSets = new WeakSet();
const activeRecoveryJobSets = new WeakMap();
const verifiedRecoveryJobSetLeases = new WeakMap();
const preparedDrills = new WeakMap();
const verifiedDrills = new WeakMap();
const originalReleaseLiabilitySnapshot = CoordinatorStore.prototype.releaseLiabilitySnapshot;
const originalListNonterminalSettlements = CoordinatorStore.prototype.listNonterminalSettlements;
const originalInspectVerifiedBackupReleaseLiabilities =
  CoordinatorStore.inspectVerifiedBackupReleaseLiabilities;

function originalStoreLiabilities(store, name) {
  if (!isVerifiedCoordinatorStore(store) || store.releaseLiabilitySnapshot !== originalReleaseLiabilitySnapshot) {
    throw new TypeError(`${name} requires an original coordinator store with unmodified liability inspection`);
  }
  return originalReleaseLiabilitySnapshot.call(store);
}

function originalNonterminalSettlements(store, name) {
  if (!isVerifiedCoordinatorStore(store)
      || store.listNonterminalSettlements !== originalListNonterminalSettlements) {
    throw new TypeError(`${name} requires an original coordinator store with unmodified settlement inspection`);
  }
  return originalListNonterminalSettlements.call(store);
}

function recoverySettlementSetDigest(releaseRecordDigest, settlements) {
  return coordinatorCommitmentDigest({
    schema: "treeswap.retained-release-recovery-job-set-commitment.v1",
    releaseRecordDigest,
    settlements,
  });
}

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

function bytes32(value, name) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || normalized === `0x${"0".repeat(64)}`) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return normalized;
}

function sha256Digest(value, name) {
  const normalized = String(value ?? "").toLowerCase();
  if (!SHA256.test(normalized) || normalized === `sha256:${"0".repeat(64)}`) {
    throw new TypeError(`${name} must be a nonzero lowercase SHA-256 digest`);
  }
  return normalized;
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

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer at or below ${maximum}`);
  }
  return value;
}

function canonicalOrder(values, selector, name) {
  for (let index = 1; index < values.length; index += 1) {
    if (selector(values[index - 1]).localeCompare(selector(values[index])) >= 0) {
      throw new Error(`${name} must be strictly canonically ordered`);
    }
  }
}

function canonicalRelativePath(value, name) {
  const path = String(value ?? "");
  if (!RELATIVE_PATH.test(path) || path.includes("//") || path.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError(`${name} must be a canonical bounded relative path`);
  }
  return path;
}

function normalizeFileReference(raw, name, maximumBytes) {
  exactKeys(raw, ["path", "sha256", "sizeBytes"], name);
  return Object.freeze({
    path: canonicalRelativePath(raw.path, `${name}.path`),
    sha256: sha256Digest(raw.sha256, `${name}.sha256`),
    sizeBytes: positiveInteger(raw.sizeBytes, `${name}.sizeBytes`, maximumBytes),
  });
}

async function privateCanonicalDirectory(path, name) {
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") {
    throw new TypeError(`${name} must be a canonical absolute directory path`);
  }
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isDirectory() || (state.mode & 0o077) !== 0) {
    throw new Error(`${name} must be a private non-symlink directory`);
  }
  if (await realpath(path) !== path) throw new Error(`${name} must not traverse a symlink`);
  return path;
}

async function readAndVerifyFile(root, reference, name, { retainBytes = false } = {}) {
  const path = resolve(root, reference.path);
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`${name} escapes the custody root`);
  const resolvedPath = await realpath(path);
  if (resolvedPath !== path || !resolvedPath.startsWith(`${root}${sep}`)) {
    throw new Error(`${name} must not traverse a symlink`);
  }
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile() || state.nlink !== 1 || (state.mode & 0o077) !== 0) {
    throw new Error(`${name} must be one private regular file with no hard links`);
  }
  if (state.size !== reference.sizeBytes) throw new Error(`${name} size does not match its custody commitment`);
  const handle = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.dev !== state.dev || before.ino !== state.ino || before.size !== state.size) {
      throw new Error(`${name} changed before custody verification`);
    }
    const hash = createHash("sha256");
    const chunks = [];
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of stream) {
      hash.update(chunk);
      if (retainBytes) chunks.push(chunk);
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`${name} changed during custody verification`);
    }
    const observed = `sha256:${hash.digest("hex")}`;
    if (observed !== reference.sha256) throw new Error(`${name} digest does not match its custody commitment`);
    return Object.freeze({
      path,
      sha256: observed,
      sizeBytes: before.size,
      bytes: retainBytes ? Buffer.concat(chunks) : null,
    });
  } finally {
    await handle.close();
  }
}

function parseJson(bytes, name) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${name} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must contain a JSON object`);
  }
  return value;
}

async function readPrivateManifest(manifestPath) {
  if (!isAbsolute(manifestPath) || resolve(manifestPath) !== manifestPath || manifestPath === "/") {
    throw new TypeError("retained-release custody manifest path must be canonical and absolute");
  }
  const root = await privateCanonicalDirectory(dirname(manifestPath), "retained-release custody root");
  const state = await lstat(manifestPath);
  if (state.isSymbolicLink() || !state.isFile() || state.nlink !== 1 || (state.mode & 0o077) !== 0
      || state.size <= 0 || state.size > 2 * 1024 * 1024) {
    throw new Error("retained-release custody manifest must be one bounded private regular file");
  }
  const handle = await openFile(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let manifestBytes;
  try {
    manifestBytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const reference = Object.freeze({
    path: manifestPath.slice(root.length + 1),
    sizeBytes: state.size,
    sha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
  });
  const verified = await readAndVerifyFile(root, reference, "retained-release custody manifest", { retainBytes: true });
  return Object.freeze({ root, manifest: parseJson(verified.bytes, "retained-release custody manifest") });
}

async function inspectStableBackupLiabilities(reference, verifiedBackup) {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "treeswap-retained-backup-")));
  await chmod(temporaryRoot, 0o700);
  const temporaryPath = join(temporaryRoot, "coordinator.sqlite");
  try {
    await copyFile(verifiedBackup.path, temporaryPath, fsConstants.COPYFILE_EXCL);
    await chmod(temporaryPath, 0o600);
    const temporaryReference = Object.freeze({
      path: "coordinator.sqlite",
      sha256: reference.sha256,
      sizeBytes: reference.sizeBytes,
    });
    await readAndVerifyFile(
      temporaryRoot,
      temporaryReference,
      "retained-release coordinator backup working copy",
    );
    const liabilitySnapshot = await originalInspectVerifiedBackupReleaseLiabilities.call(
      CoordinatorStore,
      temporaryPath,
    );
    await readAndVerifyFile(
      temporaryRoot,
      temporaryReference,
      "retained-release coordinator backup working copy",
    );
    return liabilitySnapshot;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function normalizeWitnessPolicy(raw) {
  exactKeys(raw, [
    "maximumDrillAgeSeconds",
    "maximumDrillDurationSeconds",
    "minimumWitnesses",
    "witnesses",
  ], "retained-release recovery witness policy");
  const maximumDrillAgeSeconds = positiveInteger(raw.maximumDrillAgeSeconds, "maximumDrillAgeSeconds", 7_776_000);
  const maximumDrillDurationSeconds = positiveInteger(
    raw.maximumDrillDurationSeconds,
    "maximumDrillDurationSeconds",
    86_400,
  );
  const minimumWitnesses = positiveInteger(raw.minimumWitnesses, "minimumWitnesses", 5);
  if (!Array.isArray(raw.witnesses) || raw.witnesses.length < 2 || raw.witnesses.length > 5
      || minimumWitnesses < 2 || minimumWitnesses > raw.witnesses.length) {
    throw new RangeError("retained-release recovery requires two to five configured witnesses and a two-witness minimum");
  }
  const witnesses = raw.witnesses.map((entry, index) => {
    exactKeys(entry, ["operatorId", "organizationId", "signer"], `witnesses[${index}]`);
    return Object.freeze({
      operatorId: bytes32(entry.operatorId, `witnesses[${index}].operatorId`),
      organizationId: bytes32(entry.organizationId, `witnesses[${index}].organizationId`),
      signer: address(entry.signer, `witnesses[${index}].signer`),
    });
  });
  canonicalOrder(witnesses, (entry) => entry.operatorId, "retained-release recovery witnesses");
  if (new Set(witnesses.map(({ signer }) => signer)).size !== witnesses.length
      || new Set(witnesses.map(({ organizationId }) => organizationId)).size !== witnesses.length) {
    throw new Error("retained-release recovery witnesses must have distinct signers and organization commitments");
  }
  return Object.freeze({
    maximumDrillAgeSeconds,
    maximumDrillDurationSeconds,
    minimumWitnesses,
    witnesses: Object.freeze(witnesses),
  });
}

function normalizeAuthority(raw, index) {
  exactKeys(raw, [
    "custodianId",
    "custodyEvidenceDigest",
    "direction",
    "endpointPublicKeyDigest",
    "evidencePolicyDigest",
    "lightningNodePubkeyDigest",
    "organizationId",
    "solver",
  ], `solverRecoveryAuthorities[${index}]`);
  if (!DIRECTIONS.has(raw.direction)) throw new TypeError(`solverRecoveryAuthorities[${index}].direction is invalid`);
  return Object.freeze({
    evidencePolicyDigest: bytes32(raw.evidencePolicyDigest, `solverRecoveryAuthorities[${index}].evidencePolicyDigest`),
    direction: raw.direction,
    solver: address(raw.solver, `solverRecoveryAuthorities[${index}].solver`),
    endpointPublicKeyDigest: bytes32(
      raw.endpointPublicKeyDigest,
      `solverRecoveryAuthorities[${index}].endpointPublicKeyDigest`,
    ),
    lightningNodePubkeyDigest: bytes32(
      raw.lightningNodePubkeyDigest,
      `solverRecoveryAuthorities[${index}].lightningNodePubkeyDigest`,
    ),
    custodianId: bytes32(raw.custodianId, `solverRecoveryAuthorities[${index}].custodianId`),
    organizationId: bytes32(raw.organizationId, `solverRecoveryAuthorities[${index}].organizationId`),
    custodyEvidenceDigest: bytes32(
      raw.custodyEvidenceDigest,
      `solverRecoveryAuthorities[${index}].custodyEvidenceDigest`,
    ),
  });
}

async function inspectRelease(root, raw, index, usedPaths) {
  exactKeys(raw, [
    "approvalBundle",
    "candidateEvidence",
    "candidateKind",
    "daemonEvidencePolicies",
    "providerConfiguration",
    "releaseId",
    "releasePolicyDigest",
    "releaseRecordDigest",
    "runtime",
    "solverRecoveryAuthorities",
  ], `releases[${index}]`);
  const candidateFields = raw.candidateKind === "campaign-qualified"
    ? PUBLIC_TESTNET_RELEASE_EVIDENCE_PATH_FIELDS
    : raw.candidateKind === "bootstrap"
      ? PUBLIC_TESTNET_BOOTSTRAP_RELEASE_EVIDENCE_PATH_FIELDS
      : null;
  if (!candidateFields) throw new TypeError(`releases[${index}].candidateKind is invalid`);
  exactKeys(raw.candidateEvidence, candidateFields, `releases[${index}].candidateEvidence`);

  async function inspectReference(reference, name, maximumBytes = MAX_JSON_BYTES, retainBytes = true) {
    const normalized = normalizeFileReference(reference, name, maximumBytes);
    if (usedPaths.has(normalized.path)) throw new Error("retained-release custody file paths must be globally unique");
    usedPaths.add(normalized.path);
    return readAndVerifyFile(root, normalized, name, { retainBytes });
  }

  const candidateFiles = Object.create(null);
  for (const field of candidateFields) {
    candidateFiles[field] = await inspectReference(
      raw.candidateEvidence[field],
      `releases[${index}].candidateEvidence.${field}`,
    );
  }
  const approvalBundle = await inspectReference(raw.approvalBundle, `releases[${index}].approvalBundle`);
  const providerConfiguration = await inspectReference(
    raw.providerConfiguration,
    `releases[${index}].providerConfiguration`,
  );
  const retainedApprovalBundle = parseJson(approvalBundle.bytes, `releases[${index}].approvalBundle`);
  const retainedProviderConfiguration = parseJson(
    providerConfiguration.bytes,
    `releases[${index}].providerConfiguration`,
  );

  const candidatePaths = Object.fromEntries(candidateFields.map((field) => [field, candidateFiles[field].path]));
  const rebuiltCandidate = raw.candidateKind === "campaign-qualified"
    ? await rebuildPublicTestnetReleaseCandidateFromFiles(candidatePaths)
    : await rebuildPublicTestnetBootstrapReleaseCandidateFromFiles(candidatePaths);
  const inspectedCandidate = inspectPreparedPublicTestnetReleaseCandidate(rebuiltCandidate);
  const record = inspectedCandidate.candidate.record;
  inspectPublicTestnetReleaseApprovalBundle({
    candidate: rebuiltCandidate,
    approvalBundle: retainedApprovalBundle,
  });
  const syntheticProviderEnvironment = Object.fromEntries(
    (retainedProviderConfiguration.providers ?? []).map((provider, providerIndex) => [
      provider.urlEnvironmentVariable,
      `https://retained-provider-${providerIndex}.invalid/rpc`,
    ]),
  );
  createPublicTestnetReleaseApprovalProviderSet({
    configuration: retainedProviderConfiguration,
    environment: syntheticProviderEnvironment,
    fetchImpl: async () => {
      throw new Error("retained provider configuration inspection must not perform an RPC request");
    },
    expectedProviderCount: record.counts.independentEvmProviders,
    expectedProviderSetDigest: record.approvalProviderSetDigest,
  });
  const releaseId = bytes32(raw.releaseId, `releases[${index}].releaseId`);
  const releaseRecordDigest = bytes32(raw.releaseRecordDigest, `releases[${index}].releaseRecordDigest`);
  const releasePolicyDigest = bytes32(raw.releasePolicyDigest, `releases[${index}].releasePolicyDigest`);
  if (record.releaseId !== releaseId || inspectedCandidate.recordDigest !== releaseRecordDigest
      || inspectedCandidate.policyDigest !== releasePolicyDigest) {
    throw new Error(`releases[${index}] does not match its retained release record and policy`);
  }

  if (!Array.isArray(raw.daemonEvidencePolicies) || raw.daemonEvidencePolicies.length === 0) {
    throw new TypeError(`releases[${index}].daemonEvidencePolicies are required`);
  }
  const daemonEvidencePolicies = [];
  for (let policyIndex = 0; policyIndex < raw.daemonEvidencePolicies.length; policyIndex += 1) {
    const entry = raw.daemonEvidencePolicies[policyIndex];
    exactKeys(entry, ["direction", "evidencePolicyDigest", "file"], `daemonEvidencePolicies[${policyIndex}]`);
    if (!DIRECTIONS.has(entry.direction)) throw new TypeError(`daemonEvidencePolicies[${policyIndex}].direction is invalid`);
    const file = await inspectReference(
      entry.file,
      `releases[${index}].daemonEvidencePolicies[${policyIndex}].file`,
    );
    const parsed = parseJson(file.bytes, `releases[${index}].daemonEvidencePolicies[${policyIndex}]`);
    const evidencePolicyDigest = bytes32(
      entry.evidencePolicyDigest,
      `daemonEvidencePolicies[${policyIndex}].evidencePolicyDigest`,
    );
    if (solverDaemonEvidencePolicyDigest(parsed) !== evidencePolicyDigest
        || parsed.releaseRecordDigest !== releaseRecordDigest || parsed.direction !== entry.direction) {
      throw new Error(`releases[${index}] retained a mismatched daemon evidence policy`);
    }
    daemonEvidencePolicies.push(Object.freeze({
      direction: entry.direction,
      evidencePolicyDigest,
      solver: address(parsed.solver, `daemonEvidencePolicies[${policyIndex}].solver`),
      settlementContract: address(
        parsed.settlementContract,
        `daemonEvidencePolicies[${policyIndex}].settlementContract`,
      ),
      settlementContractCodeHash: bytes32(
        parsed.settlementContractCodeHash,
        `daemonEvidencePolicies[${policyIndex}].settlementContractCodeHash`,
      ),
      file,
    }));
  }
  canonicalOrder(
    daemonEvidencePolicies,
    (entry) => `${entry.direction}:${entry.evidencePolicyDigest}`,
    `releases[${index}].daemonEvidencePolicies`,
  );

  if (!Array.isArray(raw.solverRecoveryAuthorities)
      || raw.solverRecoveryAuthorities.length !== daemonEvidencePolicies.length) {
    throw new Error(`releases[${index}] must retain one recovery authority per daemon evidence policy`);
  }
  const solverRecoveryAuthorities = raw.solverRecoveryAuthorities.map(normalizeAuthority);
  canonicalOrder(
    solverRecoveryAuthorities,
    (entry) => `${entry.direction}:${entry.evidencePolicyDigest}`,
    `releases[${index}].solverRecoveryAuthorities`,
  );
  for (const daemonPolicy of daemonEvidencePolicies) {
    const authority = solverRecoveryAuthorities.find((entry) => (
      entry.direction === daemonPolicy.direction
        && entry.evidencePolicyDigest === daemonPolicy.evidencePolicyDigest
    ));
    if (!authority || authority.solver !== daemonPolicy.solver) {
      throw new Error(`releases[${index}] recovery authority does not match its daemon policy`);
    }
  }

  exactKeys(raw.runtime, [
    "archive",
    "coordinatorSchema",
    "nodeVersion",
    "sourceCommit",
  ], `releases[${index}].runtime`);
  const sourceCommit = String(raw.runtime.sourceCommit ?? "");
  if (!COMMIT.test(sourceCommit) || sourceCommit !== record.reviewedBuildCommit) {
    throw new Error(`releases[${index}] runtime source commit does not match the reviewed release`);
  }
  if (raw.runtime.coordinatorSchema !== "treeswap.coordinator.v7") {
    throw new Error(`releases[${index}] runtime coordinator schema is unsupported`);
  }
  if (!VERSION.test(String(raw.runtime.nodeVersion ?? ""))) {
    throw new TypeError(`releases[${index}] runtime Node version is invalid`);
  }
  const runtimeArchive = await inspectReference(
    raw.runtime.archive,
    `releases[${index}].runtime.archive`,
    MAX_ARCHIVE_BYTES,
    false,
  );
  const runtime = Object.freeze({
    sourceCommit,
    coordinatorSchema: raw.runtime.coordinatorSchema,
    nodeVersion: raw.runtime.nodeVersion,
    archive: runtimeArchive,
  });

  return Object.freeze({
    releaseId,
    releaseRecordDigest,
    releasePolicyDigest,
    candidateKind: raw.candidateKind,
    candidateFiles: Object.freeze(candidateFiles),
    approvalBundle,
    providerConfiguration,
    daemonEvidencePolicies: Object.freeze(daemonEvidencePolicies),
    solverRecoveryAuthorities: Object.freeze(solverRecoveryAuthorities),
    runtime,
    chainId: String(record.chainId),
    verifyingContract: address(record.verifyingContract, `releases[${index}].verifyingContract`),
  });
}

export async function inspectRetainedReleaseCustody({ manifestPath }) {
  const { root, manifest } = await readPrivateManifest(manifestPath);
  exactKeys(manifest, [
    "coordinatorBackup",
    "coordinatorSchema",
    "createdAt",
    "releases",
    "schema",
    "sealedHostInstanceId",
    "sealedProcessInstanceId",
    "witnessPolicy",
  ], "retained-release custody manifest");
  if (manifest.schema !== RETAINED_RELEASE_CUSTODY_SCHEMA
      || manifest.coordinatorSchema !== "treeswap.coordinator.v7") {
    throw new TypeError("retained-release custody schema is unsupported");
  }
  const createdAt = positiveInteger(manifest.createdAt, "retained-release custody createdAt");
  const sealedHostInstanceId = bytes32(manifest.sealedHostInstanceId, "sealedHostInstanceId");
  const sealedProcessInstanceId = bytes32(manifest.sealedProcessInstanceId, "sealedProcessInstanceId");
  const witnessPolicy = normalizeWitnessPolicy(manifest.witnessPolicy);
  const usedPaths = new Set();
  const backupReference = normalizeFileReference(
    manifest.coordinatorBackup,
    "retained-release coordinator backup",
    MAX_BACKUP_BYTES,
  );
  usedPaths.add(backupReference.path);
  const coordinatorBackup = await readAndVerifyFile(
    root,
    backupReference,
    "retained-release coordinator backup",
  );
  const liabilitySnapshot = await inspectStableBackupLiabilities(backupReference, coordinatorBackup);
  const backupAfter = await readAndVerifyFile(
    root,
    backupReference,
    "retained-release coordinator backup",
  );
  if (backupAfter.sha256 !== coordinatorBackup.sha256) {
    throw new Error("retained-release coordinator backup changed during liability inspection");
  }
  if (liabilitySnapshot.unboundNonterminalSettlementCount !== 0) {
    throw new Error("retained-release custody cannot cover unbound nonterminal settlements");
  }
  if (liabilitySnapshot.unboundActiveFirmOfferCount !== 0) {
    throw new Error("retained-release custody cannot cover active firm offers without a bound settlement");
  }
  if (!Array.isArray(manifest.releases)) throw new TypeError("retained-release custody releases must be an array");
  const releases = [];
  for (let index = 0; index < manifest.releases.length; index += 1) {
    releases.push(await inspectRelease(root, manifest.releases[index], index, usedPaths));
  }
  canonicalOrder(releases, (entry) => entry.releaseRecordDigest, "retained-release custody releases");
  if (releases.length !== liabilitySnapshot.releases.length) {
    throw new Error("retained-release custody must cover every and only nonterminal release");
  }
  for (const liability of liabilitySnapshot.releases) {
    const release = releases.find((entry) => entry.releaseRecordDigest === liability.releaseRecordDigest);
    if (!release) throw new Error("retained-release custody is missing a nonterminal release");
    if (release.daemonEvidencePolicies.length !== liability.executionPolicies.length) {
      throw new Error("retained-release custody must cover every and only active execution policy");
    }
    for (const executionPolicy of liability.executionPolicies) {
      if (!release.daemonEvidencePolicies.some((entry) => (
        entry.direction === executionPolicy.direction
          && entry.evidencePolicyDigest === executionPolicy.evidencePolicyDigest
      ))) {
        throw new Error("retained-release custody is missing a nonterminal execution policy");
      }
    }
  }
  const packageDigest = coordinatorCommitmentDigest(manifest);
  const summary = Object.freeze({
    schema: RETAINED_RELEASE_CUSTODY_SUMMARY_SCHEMA,
    status: "all-nonterminal-release-recovery-inputs-retained",
    scope: "custody-inspection-only-no-activation-dispatch-new-exposure-funding-or-rotation-authority",
    createdAt,
    packageDigest,
    coordinatorBackupSha256: coordinatorBackup.sha256,
    liabilitySnapshotDigest: liabilitySnapshot.snapshotDigest,
    totalNonterminalSettlementCount: liabilitySnapshot.totalNonterminalSettlementCount,
    releaseCount: releases.length,
    authorizations: ZERO_AUTHORIZATIONS,
  });
  verifiedCustodies.set(summary, Object.freeze({
    root,
    manifest,
    createdAt,
    sealedHostInstanceId,
    sealedProcessInstanceId,
    witnessPolicy,
    coordinatorBackup,
    liabilitySnapshot,
    releases: Object.freeze(releases),
    packageDigest,
  }));
  return summary;
}

export function verifyRetainedReleaseRecoveryReadiness({
  custodyVerification,
  releaseRecordDigest: requestedReleaseRecordDigest,
  recoveryActivation,
  restoredStore,
  solverCapabilityVerifications,
  restoredHostInstanceId,
  restoredProcessInstanceId,
  now = Math.floor(Date.now() / 1_000),
}) {
  const custody = verifiedCustodies.get(custodyVerification);
  if (!custody) throw new TypeError("retained-release custody verification provenance is required");
  const releaseRecordDigest = bytes32(requestedReleaseRecordDigest, "recovery release record digest");
  const release = custody.releases.find((entry) => entry.releaseRecordDigest === releaseRecordDigest);
  const liability = custody.liabilitySnapshot.releases.find((entry) => entry.releaseRecordDigest === releaseRecordDigest);
  if (!release || !liability || liability.nonterminalSettlementCount === 0) {
    throw new Error("retained-release recovery readiness requires a covered nonterminal release");
  }
  const hostInstanceId = bytes32(restoredHostInstanceId, "restoredHostInstanceId");
  const processInstanceId = bytes32(restoredProcessInstanceId, "restoredProcessInstanceId");
  if (hostInstanceId === custody.sealedHostInstanceId || processInstanceId === custody.sealedProcessInstanceId) {
    throw new Error("retained-release readiness requires a distinct restored host and process instance");
  }
  const restoredLiabilities = originalStoreLiabilities(restoredStore, "retained-release readiness");
  if (restoredLiabilities.snapshotDigest !== custody.liabilitySnapshot.snapshotDigest) {
    throw new Error("restored coordinator liabilities do not match the retained backup");
  }
  const activation = verifiedPublicTestnetRecoveryActivation(recoveryActivation, { now });
  if (activation.releaseId !== release.releaseId
      || activation.releaseRecordDigest !== release.releaseRecordDigest
      || activation.releasePolicyDigest !== release.releasePolicyDigest) {
    throw new Error("recovery activation does not match the retained release");
  }
  if (!Array.isArray(solverCapabilityVerifications)
      || solverCapabilityVerifications.length !== release.daemonEvidencePolicies.length) {
    throw new Error("recovery readiness requires one fresh solver capability per retained execution policy");
  }
  const capabilities = solverCapabilityVerifications.map((verification) => (
    verifiedSolverRecoveryAuthority(verification)
  ));
  if (new Set(capabilities.map(({ capabilityDigest }) => capabilityDigest)).size !== capabilities.length) {
    throw new Error("recovery readiness solver capabilities must be distinct");
  }
  for (const daemonPolicy of release.daemonEvidencePolicies) {
    const authority = release.solverRecoveryAuthorities.find((entry) => (
      entry.direction === daemonPolicy.direction
        && entry.evidencePolicyDigest === daemonPolicy.evidencePolicyDigest
    ));
    const capability = capabilities.find((entry) => (
      entry.direction === daemonPolicy.direction
        && entry.solverId === daemonPolicy.solver
        && entry.settlementContract === daemonPolicy.settlementContract
        && entry.settlementContractCodeHash === daemonPolicy.settlementContractCodeHash
    ));
    if (!authority || !capability
        || capability.endpointPublicKeyDigest !== authority.endpointPublicKeyDigest
        || solverLightningNodePubkeyDigest(capability.lightningNodePubkey) !== authority.lightningNodePubkeyDigest
        || capability.expiresAt <= now
        || capability.capacityObservedAt > now
        || now - capability.capacityObservedAt > activation.maximumRuntimeObservationAgeSeconds) {
      throw new Error("fresh solver capability does not prove the retained recovery authority");
    }
  }
  const operatingSetDigest = coordinatorCommitmentDigest({
    schema: "treeswap.retained-release-operating-set.v1",
    releaseRecordDigest,
    custodyPackageDigest: custody.packageDigest,
    coordinatorBackupSha256: custody.coordinatorBackup.sha256,
    runtimeArchiveSha256: release.runtime.archive.sha256,
    providerConfigurationSha256: release.providerConfiguration.sha256,
    solverCapabilityDigests: capabilities.map(({ capabilityDigest }) => capabilityDigest).sort(),
    restoredHostInstanceId: hostInstanceId,
    restoredProcessInstanceId: processInstanceId,
  });
  const summary = Object.freeze({
    schema: RETAINED_RELEASE_RECOVERY_READINESS_SCHEMA,
    status: "old-release-restored-and-recovery-only-authorities-live",
    scope: "readiness-only-no-claim-of-recovered-action-rotation-dispatch-new-exposure-or-funding-authority",
    releaseId: release.releaseId,
    releaseRecordDigest,
    custodyPackageDigest: custody.packageDigest,
    liabilitySnapshotDigest: custody.liabilitySnapshot.snapshotDigest,
    releaseLiabilitySetDigest: liability.liabilitySetDigest,
    nonterminalSettlementCount: liability.nonterminalSettlementCount,
    operatingSetDigest,
    providerConsensusDigest: activation.providerConsensusDigest,
    runtimeBlockNumber: activation.runtimeBlockNumber,
    runtimeBlockHash: activation.runtimeBlockHash,
    validUntil: Math.min(activation.validUntil, ...capabilities.map(({ expiresAt }) => expiresAt)),
    authorizations: ZERO_AUTHORIZATIONS,
  });
  verifiedReadiness.set(summary, Object.freeze({
    custody,
    release,
    liability,
    activation,
    capabilities: Object.freeze(capabilities),
    solverCapabilityVerifications: Object.freeze([...solverCapabilityVerifications]),
    restoredStore,
    hostInstanceId,
    processInstanceId,
    operatingSetDigest,
    now,
  }));
  return summary;
}

export function prepareRetainedReleaseRecoveryJobSet({
  readinessVerification,
  restoredStore,
  executionPolicies,
  now = Math.floor(Date.now() / 1_000),
}) {
  const readiness = verifiedReadiness.get(readinessVerification);
  if (!readiness) throw new TypeError("retained-release recovery readiness provenance is required");
  const observedAt = positiveInteger(now, "recovery job-set preparation time");
  if (restoredStore !== readiness.restoredStore) {
    throw new TypeError("recovery job set requires the exact restored coordinator store used for readiness");
  }
  if (observedAt < readiness.now || observedAt > readiness.activation.validUntil) {
    throw new Error("recovery job-set preparation is before readiness or after recovery activation expiry");
  }
  const liabilities = originalStoreLiabilities(restoredStore, "recovery job set");
  if (liabilities.snapshotDigest !== readiness.custody.liabilitySnapshot.snapshotDigest
      || liabilities.snapshotDigest !== readinessVerification.liabilitySnapshotDigest) {
    throw new Error("recovery job-set liabilities changed after retained readiness verification");
  }
  if (!Array.isArray(executionPolicies)
      || executionPolicies.length !== readiness.liability.executionPolicies.length) {
    throw new Error("recovery job set requires every and only retained execution policy");
  }
  const policies = executionPolicies.map((entry, index) => {
    exactKeys(
      entry,
      ["evidencePolicy", "runtime", "solverCapabilityVerification"],
      `recovery executionPolicies[${index}]`,
    );
    const evidencePolicy = snapshotCoordinatorRecoveryEvidencePolicy(entry.evidencePolicy);
    const runtime = snapshotCoordinatorRecoveryRuntime(entry.runtime);
    const evidencePolicyDigest = solverDaemonEvidencePolicyDigest(evidencePolicy);
    const retainedPolicy = readiness.release.daemonEvidencePolicies.find((candidate) => (
      candidate.evidencePolicyDigest === evidencePolicyDigest
        && candidate.direction === evidencePolicy.direction
    ));
    const verificationIndex = readiness.solverCapabilityVerifications.indexOf(
      entry.solverCapabilityVerification,
    );
    if (!retainedPolicy || verificationIndex === -1) {
      throw new Error("recovery execution policy lacks retained same-process authority");
    }
    const capability = verifiedSolverRecoveryAuthority(entry.solverCapabilityVerification);
    if (capability.direction !== retainedPolicy.direction
        || capability.solverId !== retainedPolicy.solver
        || capability.settlementContract !== retainedPolicy.settlementContract
        || capability.settlementContractCodeHash !== retainedPolicy.settlementContractCodeHash
        || capability.expiresAt <= observedAt
        || capability.capacityObservedAt > observedAt
        || observedAt - capability.capacityObservedAt
          > readiness.activation.maximumRuntimeObservationAgeSeconds) {
      throw new Error("recovery execution policy does not match fresh retained solver authority");
    }
    return Object.freeze({
      direction: retainedPolicy.direction,
      evidencePolicyDigest,
      evidencePolicy,
      solverCapabilityVerification: entry.solverCapabilityVerification,
      runtime,
      validUntil: capability.expiresAt,
    });
  });
  canonicalOrder(
    policies,
    (entry) => `${entry.direction}:${entry.evidencePolicyDigest}`,
    "recovery execution policies",
  );
  if (new Set(policies.map(({ evidencePolicyDigest }) => evidencePolicyDigest)).size !== policies.length) {
    throw new Error("recovery execution policies are duplicated");
  }
  for (const liabilityPolicy of readiness.liability.executionPolicies) {
    if (!policies.some((entry) => (
      entry.direction === liabilityPolicy.direction
        && entry.evidencePolicyDigest === liabilityPolicy.evidencePolicyDigest
    ))) {
      throw new Error("recovery job set is missing a retained execution policy");
    }
  }
  const allNonterminal = originalNonterminalSettlements(restoredStore, "recovery job set");
  const settlements = allNonterminal.filter((entry) => (
    entry.releaseRecordDigest === readiness.release.releaseRecordDigest
  ));
  if (settlements.length !== readiness.liability.nonterminalSettlementCount
      || settlements.length === 0 || settlements.length > 64) {
    throw new Error("recovery job set must contain between 1 and 64 exact release liabilities");
  }
  const jobs = normalizeCoordinatorRecoveryJobs(settlements.map((settlement) => {
    if (!settlement.releaseRecordDigest || !settlement.evidencePolicyDigest
        || !settlement.solverCapabilityDigest || !settlement.executionPolicyBindingDigest
        || settlement.terminalState) {
      throw new Error("recovery job set contains an unbound or terminal settlement");
    }
    const policy = policies.find((entry) => (
      entry.direction === settlement.direction
        && entry.evidencePolicyDigest === settlement.evidencePolicyDigest
    ));
    if (!policy) throw new Error("recovery settlement has no exact retained execution policy");
    return Object.freeze({
      settlementId: settlement.settlementId,
      solverCapabilityVerification: policy.solverCapabilityVerification,
      evidencePolicy: policy.evidencePolicy,
      runtime: policy.runtime,
    });
  }));
  const jobSetDigest = recoverySettlementSetDigest(
    readiness.release.releaseRecordDigest,
    settlements,
  );
  const validUntil = Math.min(
    readiness.activation.validUntil,
    ...policies.map((entry) => entry.validUntil),
  );
  const summary = Object.freeze({
    schema: RETAINED_RELEASE_RECOVERY_JOB_SET_SCHEMA,
    status: "exact-restored-liability-set-bound-for-recovery",
    scope: "fixed-startup-recovery-only-no-dynamic-intake-lightning-dispatch-new-exposure-or-funding-authority",
    releaseId: readiness.release.releaseId,
    releaseRecordDigest: readiness.release.releaseRecordDigest,
    custodyPackageDigest: readiness.custody.packageDigest,
    liabilitySnapshotDigest: liabilities.snapshotDigest,
    releaseLiabilitySetDigest: readiness.liability.liabilitySetDigest,
    operatingSetDigest: readiness.operatingSetDigest,
    jobSetDigest,
    jobCount: jobs.length,
    preparedAt: observedAt,
    validUntil,
    authorizations: ZERO_AUTHORIZATIONS,
  });
  verifiedRecoveryJobSets.set(summary, Object.freeze({
    restoredStore,
    releaseRecordDigest: readiness.release.releaseRecordDigest,
    liabilitySnapshotDigest: liabilities.snapshotDigest,
    jobSetDigest,
    jobs,
    validUntil,
  }));
  return summary;
}

export function verifiedRetainedReleaseRecoveryJobs({
  jobSetVerification,
  restoredStore,
  now = Math.floor(Date.now() / 1_000),
}) {
  const jobSet = verifiedRecoveryJobSets.get(jobSetVerification);
  if (!jobSet) throw new TypeError("retained-release recovery job-set provenance is required");
  const observedAt = positiveInteger(now, "recovery job-set use time");
  if (restoredStore !== jobSet.restoredStore) {
    throw new TypeError("recovery job set requires its original restored coordinator store");
  }
  if (observedAt < jobSetVerification.preparedAt || observedAt > jobSet.validUntil) {
    throw new Error("recovery job set is not yet valid or has expired");
  }
  const liabilities = originalStoreLiabilities(restoredStore, "recovery job-set use");
  if (liabilities.snapshotDigest !== jobSet.liabilitySnapshotDigest) {
    throw new Error("recovery liabilities changed before fixed job-set activation");
  }
  const settlements = originalNonterminalSettlements(restoredStore, "recovery job-set use")
    .filter((entry) => entry.releaseRecordDigest === jobSet.releaseRecordDigest);
  if (recoverySettlementSetDigest(jobSet.releaseRecordDigest, settlements) !== jobSet.jobSetDigest) {
    throw new Error("recovery settlement records changed before fixed job-set activation");
  }
  if (consumedRecoveryJobSets.has(jobSetVerification)) {
    throw new Error("recovery job set was already consumed by an action loop");
  }
  let activeForStore = activeRecoveryJobSets.get(restoredStore);
  if (activeForStore?.has(jobSet.releaseRecordDigest)) {
    throw new Error("restored release already has an active recovery action loop");
  }
  if (!activeForStore) {
    activeForStore = new Map();
    activeRecoveryJobSets.set(restoredStore, activeForStore);
  }
  const lease = Object.freeze({
    schema: "treeswap.retained-release-recovery-job-set-lease.v1",
  });
  consumedRecoveryJobSets.add(jobSetVerification);
  activeForStore.set(jobSet.releaseRecordDigest, lease);
  verifiedRecoveryJobSetLeases.set(lease, Object.freeze({
    restoredStore,
    releaseRecordDigest: jobSet.releaseRecordDigest,
  }));
  return Object.freeze({ jobs: jobSet.jobs, lease });
}

export function releaseRetainedReleaseRecoveryJobSetLease(lease) {
  const verifiedLease = verifiedRecoveryJobSetLeases.get(lease);
  if (!verifiedLease) {
    throw new TypeError("original same-process recovery job-set lease is required");
  }
  const activeForStore = activeRecoveryJobSets.get(verifiedLease.restoredStore);
  if (activeForStore?.get(verifiedLease.releaseRecordDigest) !== lease) return false;
  activeForStore.delete(verifiedLease.releaseRecordDigest);
  if (activeForStore.size === 0) activeRecoveryJobSets.delete(verifiedLease.restoredStore);
  return true;
}

function drillDomain(readiness) {
  return Object.freeze({
    name: "TreeSwap Retained Release Recovery",
    version: "1",
    chainId: BigInt(readiness.release.chainId),
    verifyingContract: readiness.release.verifyingContract,
  });
}

function drillMessage(record) {
  return Object.freeze({
    drillId: record.drillId,
    recordDigest: record.recordDigest,
    releaseRecordDigest: record.releaseRecordDigest,
    custodyPackageDigest: record.custodyPackageDigest,
    liabilitySnapshotDigest: record.liabilitySnapshotDigest,
    operatingSetDigest: record.operatingSetDigest,
    operatingSetRole: record.operatingSetRole,
    recoveryEvidenceDigest: record.recoveryEvidenceDigest,
    postconditionDigest: record.postconditionDigest,
    recoveredActionCount: record.recoveredActionCount,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  });
}

export function buildRetainedReleaseRecoveryDrillApproval({
  readinessVerification,
  drillId,
  operatingSetRole,
  recoveryEvidenceDigest,
  postconditionDigest,
  recoveredActionCount,
  startedAt,
  finishedAt,
}) {
  const readiness = verifiedReadiness.get(readinessVerification);
  if (!readiness) throw new TypeError("retained-release recovery readiness provenance is required");
  if (!OPERATING_SET_ROLES.has(operatingSetRole)) throw new TypeError("recovery drill operating-set role is invalid");
  const started = positiveInteger(startedAt, "recovery drill startedAt");
  const finished = positiveInteger(finishedAt, "recovery drill finishedAt");
  if (finished < started || finished - started > readiness.custody.witnessPolicy.maximumDrillDurationSeconds
      || finished > readiness.now) {
    throw new RangeError("recovery drill time range is invalid or outside policy");
  }
  const recovered = positiveInteger(recoveredActionCount, "recoveredActionCount");
  const core = Object.freeze({
    schema: RETAINED_RELEASE_RECOVERY_DRILL_SCHEMA,
    status: "witnessed-recovery-action-passed",
    scope: "existing-settlement-recovery-only-zero-lightning-dispatch-new-exposure-and-funding-actions",
    drillId: bytes32(drillId, "recovery drill identifier"),
    releaseRecordDigest: readiness.release.releaseRecordDigest,
    custodyPackageDigest: readiness.custody.packageDigest,
    liabilitySnapshotDigest: readiness.custody.liabilitySnapshot.snapshotDigest,
    operatingSetDigest: readiness.operatingSetDigest,
    operatingSetRole,
    restoredHostInstanceId: readiness.hostInstanceId,
    restoredProcessInstanceId: readiness.processInstanceId,
    recoveryEvidenceDigest: bytes32(recoveryEvidenceDigest, "recovery evidence digest"),
    postconditionDigest: bytes32(postconditionDigest, "recovery postcondition digest"),
    recoveredActionCount: recovered,
    lightningDispatchCount: 0,
    newExposureCount: 0,
    fundingActionCount: 0,
    startedAt: started,
    finishedAt: finished,
    authorizations: ZERO_AUTHORIZATIONS,
  });
  const record = Object.freeze({ ...core, recordDigest: coordinatorCommitmentDigest(core) });
  const approval = Object.freeze({
    primaryType: "RetainedReleaseRecoveryDrill",
    domain: Object.freeze({ ...drillDomain(readiness), chainId: readiness.release.chainId }),
    types: RETAINED_RELEASE_RECOVERY_DRILL_TYPES,
    message: drillMessage(record),
    record,
  });
  preparedDrills.set(approval, Object.freeze({ readiness, record }));
  return approval;
}

export function verifyRetainedReleaseRecoveryDrill({
  approval,
  attestations,
  now = Math.floor(Date.now() / 1_000),
}) {
  const prepared = preparedDrills.get(approval);
  if (!prepared) throw new TypeError("prepared retained-release recovery drill provenance is required");
  const observedAt = positiveInteger(now, "recovery drill verification time");
  const { readiness, record } = prepared;
  const policy = readiness.custody.witnessPolicy;
  if (record.finishedAt > observedAt
      || observedAt - record.finishedAt > policy.maximumDrillAgeSeconds
      || observedAt > readiness.activation.validUntil) {
    throw new Error("retained-release recovery drill is future-dated, stale, or outlived its recovery activation");
  }
  if (!Array.isArray(attestations) || attestations.length < policy.minimumWitnesses
      || attestations.length > policy.witnesses.length) {
    throw new Error("retained-release recovery drill witness count is outside policy");
  }
  const seenOperators = new Set();
  const seenOrganizations = new Set();
  const seenSigners = new Set();
  for (let index = 0; index < attestations.length; index += 1) {
    const attestation = attestations[index];
    exactKeys(attestation, ["operatorId", "signature", "signer"], `recovery drill attestations[${index}]`);
    const operatorId = bytes32(attestation.operatorId, `recovery drill attestations[${index}].operatorId`);
    const signer = address(attestation.signer, `recovery drill attestations[${index}].signer`);
    const witness = policy.witnesses.find((entry) => entry.operatorId === operatorId && entry.signer === signer);
    if (!witness || seenOperators.has(operatorId) || seenOrganizations.has(witness.organizationId)
        || seenSigners.has(signer)) {
      throw new Error("retained-release recovery drill witness is unknown, duplicated, or organization-overlapping");
    }
    let recovered;
    try {
      recovered = verifyTypedData(
        drillDomain(readiness),
        RETAINED_RELEASE_RECOVERY_DRILL_TYPES,
        drillMessage(record),
        attestation.signature,
      ).toLowerCase();
    } catch {
      throw new Error("retained-release recovery drill witness signature is invalid");
    }
    if (recovered !== signer) throw new Error("retained-release recovery drill witness signature is invalid");
    seenOperators.add(operatorId);
    seenOrganizations.add(witness.organizationId);
    seenSigners.add(signer);
  }
  const result = Object.freeze({
    ...record,
    status: "independently-witnessed-recovery-action-passed",
    witnessCount: attestations.length,
    witnessSetDigest: coordinatorCommitmentDigest([...seenOperators].sort()),
  });
  verifiedDrills.set(result, Object.freeze({
    readiness,
    record,
    verifiedAt: observedAt,
  }));
  return result;
}

export function assessRetainedReleaseRotation({
  oldCustodyVerification,
  newCustodyVerification = null,
  liveStore,
  changeKind,
  oldDrills = [],
  newDrills = [],
  now = Math.floor(Date.now() / 1_000),
}) {
  const oldCustody = verifiedCustodies.get(oldCustodyVerification);
  if (!oldCustody) throw new TypeError("old retained-release custody verification provenance is required");
  if (!CHANGE_KINDS.has(changeKind)) throw new TypeError("retained-release rotation change kind is invalid");
  const observedAt = positiveInteger(now, "retained-release rotation assessment time");
  const liveLiabilities = originalStoreLiabilities(liveStore, "retained-release rotation");
  if (liveLiabilities.snapshotDigest !== oldCustody.liabilitySnapshot.snapshotDigest) {
    throw new Error("live coordinator liabilities changed after the retained backup was sealed");
  }
  if (liveLiabilities.unboundNonterminalSettlementCount !== 0
      || liveLiabilities.unboundActiveFirmOfferCount !== 0) {
    throw new Error("retained-release rotation cannot strand unbound settlements or firm offers");
  }
  if (oldCustody.liabilitySnapshot.totalNonterminalSettlementCount === 0) {
    return Object.freeze({
      schema: RETAINED_RELEASE_ROTATION_DECISION_SCHEMA,
      status: "rotation-permitted-zero-nonterminal-liabilities",
      scope: "rotation-only-no-dispatch-new-exposure-or-funding-authority",
      changeKind,
      assessedAt: observedAt,
      liabilitySnapshotDigest: oldCustody.liabilitySnapshot.snapshotDigest,
      nonterminalSettlementCount: 0,
      rotationPermitted: true,
      authorizations: ZERO_AUTHORIZATIONS,
    });
  }
  const newCustody = verifiedCustodies.get(newCustodyVerification);
  if (!newCustody) {
    throw new TypeError("new retained-release custody verification provenance is required with liabilities");
  }
  if (newCustody.packageDigest === oldCustody.packageDigest
      || newCustody.liabilitySnapshot.snapshotDigest !== oldCustody.liabilitySnapshot.snapshotDigest
      || newCustody.releases.length !== oldCustody.releases.length
      || newCustody.releases.some((release, index) => (
        release.releaseRecordDigest !== oldCustody.releases[index].releaseRecordDigest
      ))) {
    throw new Error("old and new custody packages must be distinct and cover the exact same liabilities and releases");
  }
  if (["storage-schema", "wallet-owner"].includes(changeKind)) {
    throw new Error(`${changeKind} rotation with nonterminal liabilities is unsupported and must wait for zero liabilities`);
  }
  const changedOperatingMaterial = oldCustody.releases.some((oldRelease, index) => {
    const newRelease = newCustody.releases[index];
    if (changeKind === "provider") {
      return oldRelease.providerConfiguration.sha256 !== newRelease.providerConfiguration.sha256;
    }
    if (changeKind === "service-runtime") {
      return oldRelease.runtime.archive.sha256 !== newRelease.runtime.archive.sha256;
    }
    if (changeKind === "solver-key") {
      const authorityDigest = (release) => coordinatorCommitmentDigest(
        release.solverRecoveryAuthorities.map((authority) => ({
          evidencePolicyDigest: authority.evidencePolicyDigest,
          direction: authority.direction,
          solver: authority.solver,
          endpointPublicKeyDigest: authority.endpointPublicKeyDigest,
          lightningNodePubkeyDigest: authority.lightningNodePubkeyDigest,
          custodyEvidenceDigest: authority.custodyEvidenceDigest,
        })),
      );
      return authorityDigest(oldRelease) !== authorityDigest(newRelease);
    }
    return false;
  });
  if (!changedOperatingMaterial) {
    throw new Error(`old and new custody packages do not prove the requested ${changeKind} change`);
  }
  if (!Array.isArray(oldDrills) || !Array.isArray(newDrills)
      || oldDrills.length !== oldCustody.releases.length || newDrills.length !== oldCustody.releases.length) {
    throw new Error("nonterminal rotation requires one old-set and one new-set drill for every retained release");
  }
  const pairs = [];
  for (const release of oldCustody.releases) {
    const old = oldDrills.map((entry) => [entry, verifiedDrills.get(entry)])
      .find(([, value]) => value?.readiness.release.releaseRecordDigest === release.releaseRecordDigest);
    const next = newDrills.map((entry) => [entry, verifiedDrills.get(entry)])
      .find(([, value]) => value?.readiness.release.releaseRecordDigest === release.releaseRecordDigest);
    if (!old || !next || old[1].record.operatingSetRole !== "old" || next[1].record.operatingSetRole !== "new") {
      throw new Error("retained-release rotation drill provenance or operating-set role is invalid");
    }
    if (old[1].readiness.custody !== oldCustody || next[1].readiness.custody !== newCustody
        || old[1].record.liabilitySnapshotDigest !== oldCustody.liabilitySnapshot.snapshotDigest
        || next[1].record.liabilitySnapshotDigest !== oldCustody.liabilitySnapshot.snapshotDigest
        || old[1].readiness.activation.gateOpen !== false
        || next[1].readiness.activation.gateOpen !== false
        || old[1].record.operatingSetDigest === next[1].record.operatingSetDigest
        || observedAt - old[1].record.finishedAt > oldCustody.witnessPolicy.maximumDrillAgeSeconds
        || observedAt - next[1].record.finishedAt > newCustody.witnessPolicy.maximumDrillAgeSeconds) {
      throw new Error("old/new retained-release drills do not prove the exact current liabilities and distinct operating sets");
    }
    pairs.push(Object.freeze({
      releaseRecordDigest: release.releaseRecordDigest,
      oldDrillRecordDigest: old[1].record.recordDigest,
      newDrillRecordDigest: next[1].record.recordDigest,
    }));
  }
  return Object.freeze({
    schema: RETAINED_RELEASE_ROTATION_DECISION_SCHEMA,
    status: "rotation-permitted-after-old-and-new-operating-set-recovery-drills",
    scope: "rotation-only-no-dispatch-new-exposure-or-funding-authority",
    changeKind,
    assessedAt: observedAt,
    oldCustodyPackageDigest: oldCustody.packageDigest,
    newCustodyPackageDigest: newCustody.packageDigest,
    liabilitySnapshotDigest: oldCustody.liabilitySnapshot.snapshotDigest,
    nonterminalSettlementCount: oldCustody.liabilitySnapshot.totalNonterminalSettlementCount,
    releaseDrills: Object.freeze(pairs),
    rotationPermitted: true,
    authorizations: ZERO_AUTHORIZATIONS,
  });
}
