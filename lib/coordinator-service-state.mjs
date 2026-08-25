import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const COORDINATOR_SERVICE_STATUS_SCHEMA = "treeswap.coordinator-service-status.v1";
export const COORDINATOR_RELEASE_SERVICE_STATUS_SCHEMA =
  "treeswap.coordinator-release-verification-service-status.v1";
export const COORDINATOR_ACTIVE_EXECUTION_BOOTSTRAP_STATUS_SCHEMA =
  "treeswap.coordinator-active-execution-bootstrap-status.v1";
export const COORDINATOR_ACTIVE_EXECUTION_SERVICE_STATUS_SCHEMA =
  "treeswap.coordinator-active-execution-service-status.v1";
export const COORDINATOR_RECOVERY_SERVICE_STATUS_SCHEMA =
  "treeswap.coordinator-recovery-verification-service-status.v1";
export const COORDINATOR_RECOVERY_EXECUTION_BOOTSTRAP_STATUS_SCHEMA =
  "treeswap.coordinator-recovery-execution-bootstrap-status.v1";
export const COORDINATOR_RECOVERY_EXECUTION_SERVICE_STATUS_SCHEMA =
  "treeswap.coordinator-recovery-execution-service-status.v1";
const LEASE_SCHEMA = "treeswap.coordinator-service-lease.v1";
const LEASE_DIRECTORY_NAME = "coordinator.lease";
const OWNER_FILE_NAME = "owner.json";
const HEARTBEAT_FILE_NAME = "heartbeat.json";
const STATUS_FILE_NAME = "status.json";
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 65_536;
const COMMON_STATUS_KEYS = Object.freeze([
  "admissionMetrics",
  "database",
  "dispatchAuthorization",
  "fundingAuthorization",
  "heartbeatAt",
  "leaseId",
  "metrics",
  "mode",
  "networkListener",
  "recoveredInterruptedActions",
  "schema",
  "serviceStartedAt",
]);
const CLOSED_STATUS_KEYS = COMMON_STATUS_KEYS;
const RELEASE_STATUS_KEYS = Object.freeze([...COMMON_STATUS_KEYS, "releaseVerification"]);
const ACTIVE_EXECUTION_BOOTSTRAP_STATUS_KEYS = Object.freeze([
  "admissionMetrics",
  "database",
  "expectedReplicas",
  "fundingAuthorization",
  "heartbeatAt",
  "leaseId",
  "lightningDispatchAuthorization",
  "metrics",
  "mode",
  "networkListener",
  "newExposureAuthorization",
  "phase",
  "recoveredInterruptedActions",
  "releaseVerification",
  "replicaPolicy",
  "schema",
  "serviceStartedAt",
]);
const ACTIVE_EXECUTION_STATUS_KEYS = Object.freeze([
  "activeExecution",
  "admissionMetrics",
  "database",
  "expectedReplicas",
  "fundingAuthorization",
  "heartbeatAt",
  "leaseId",
  "lightningDispatchAuthorization",
  "metrics",
  "mode",
  "networkListener",
  "newExposureAuthorization",
  "recoveredInterruptedActions",
  "releaseVerification",
  "replicaPolicy",
  "schema",
  "serviceStartedAt",
]);
const RECOVERY_STATUS_KEYS = Object.freeze([...COMMON_STATUS_KEYS, "recoveryVerification"]);
const RECOVERY_EXECUTION_BOOTSTRAP_STATUS_KEYS = Object.freeze([
  "admissionMetrics",
  "boundedExistingLiabilityEvmClaimRecovery",
  "database",
  "fundingAuthorization",
  "heartbeatAt",
  "leaseId",
  "lightningDispatchAuthorization",
  "metrics",
  "mode",
  "networkListener",
  "newExposureAuthorization",
  "phase",
  "recoveredInterruptedActions",
  "recoveryVerification",
  "schema",
  "serviceStartedAt",
]);
const RECOVERY_EXECUTION_STATUS_KEYS = Object.freeze([
  "admissionMetrics",
  "boundedExistingLiabilityEvmClaimRecovery",
  "database",
  "fundingAuthorization",
  "heartbeatAt",
  "leaseId",
  "lightningDispatchAuthorization",
  "metrics",
  "mode",
  "networkListener",
  "newExposureAuthorization",
  "recoveredInterruptedActions",
  "recoveryAction",
  "recoveryVerification",
  "schema",
  "serviceStartedAt",
]);
const RELEASE_VERIFICATION_KEYS = Object.freeze([
  "approvalBundleDigest",
  "authorizations",
  "consecutiveFailures",
  "fundingMode",
  "inputManifestDigest",
  "lastAttemptAt",
  "lastSuccessAt",
  "policyDigest",
  "providerConsensusDigest",
  "reconciliationDigest",
  "recordDigest",
  "releaseId",
  "runtimeBlockHash",
  "runtimeBlockNumber",
  "schema",
  "scope",
  "state",
  "validUntil",
]);
const RELEASE_AUTHORIZATION_KEYS = Object.freeze([
  "broadcast",
  "dispatch",
  "funding",
  "gateOpening",
  "signing",
]);
const ACTIVE_EXECUTION_KEYS = Object.freeze([
  "authorizations",
  "consecutiveFailures",
  "counts",
  "cursorDigest",
  "cycleDigest",
  "lastAttemptAt",
  "lastSuccessAt",
  "networkListener",
  "policyCount",
  "policySetDigest",
  "releaseRecordDigest",
  "schema",
  "scope",
  "startedAt",
  "state",
  "workSource",
]);
const ACTIVE_EXECUTION_AUTHORIZATION_KEYS = Object.freeze([
  "funding",
  "lightningDispatch",
  "newExposure",
]);
const ACTIVE_EXECUTION_COUNT_KEYS = Object.freeze([
  "advanced",
  "attempted",
  "backlog",
  "discovered",
  "done",
  "eligible",
  "gateClosed",
  "halted",
  "waiting",
]);
const ACTIVE_REPLICA_POLICY = "single-host-one-process-filesystem-lease";
const RECOVERY_VERIFICATION_KEYS = Object.freeze([
  "approvalBundleDigest",
  "authorizations",
  "balancesReconciled",
  "bitPaused",
  "consecutiveFailures",
  "emergencyHalted",
  "gateOpen",
  "inputManifestDigest",
  "lastAttemptAt",
  "lastSuccessAt",
  "policyDigest",
  "providerConsensusDigest",
  "recordDigest",
  "releaseId",
  "runtimeBlockHash",
  "runtimeBlockNumber",
  "schema",
  "scope",
  "state",
  "validUntil",
]);
const RECOVERY_AUTHORIZATION_KEYS = Object.freeze([
  "broadcast",
  "funding",
  "gateOpening",
  "lightningDispatch",
  "newExposure",
  "signing",
]);
const RECOVERY_ACTION_KEYS = Object.freeze([
  "authorizations",
  "consecutiveFailures",
  "counts",
  "cycleDigest",
  "jobSetDigest",
  "jobCount",
  "lastAttemptAt",
  "lastSuccessAt",
  "releaseId",
  "releaseRecordDigest",
  "schema",
  "scope",
  "startedAt",
  "state",
]);
const RECOVERY_ACTION_AUTHORIZATION_KEYS = Object.freeze([
  "funding",
  "lightningDispatch",
  "newExposure",
]);
const RECOVERY_ACTION_COUNT_KEYS = Object.freeze([
  "advanced",
  "attempted",
  "done",
  "gateClosed",
  "halted",
  "waiting",
]);
const NONZERO_BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const COORDINATOR_SERVICE_LEASES = new WeakMap();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function exactIsoSecond(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) {
    throw new TypeError(`${name} must be a whole-second UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${name} is invalid`);
  }
  return milliseconds;
}

function positiveInteger(raw, fallback, name, { minimum, maximum }) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum || String(value) !== String(raw ?? fallback)) {
    throw new TypeError(`${name} is outside policy`);
  }
  return value;
}

function canonicalAbsolutePath(value, name) {
  const path = String(value ?? "");
  if (!isAbsolute(path) || resolve(path) !== path) throw new TypeError(`${name} must be a canonical absolute path`);
  return path;
}

function containsPath(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function leaseId(token) {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function randomHex(randomBytesImpl, size, name) {
  const value = randomBytesImpl(size);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error(`${name} randomness is invalid`);
  const bytes = Buffer.from(value);
  if (bytes.length !== size) throw new Error(`${name} randomness has the wrong size`);
  return bytes.toString("hex");
}

export function normalizeCoordinatorServiceConfig(environment = process.env) {
  const databasePath = canonicalAbsolutePath(environment.COORDINATOR_DATABASE_PATH, "coordinator database path");
  const runtimeDirectory = canonicalAbsolutePath(environment.COORDINATOR_RUNTIME_DIRECTORY, "coordinator runtime directory");
  if (runtimeDirectory === "/" || dirname(databasePath) === "/") {
    throw new Error("coordinator paths must use dedicated non-root directories");
  }
  const mode = environment.COORDINATOR_MODE ?? "closed";
  if (![
    "closed",
    "release-verification-only",
    "active-execution-only",
    "recovery-verification-only",
    "recovery-execution-only",
  ].includes(mode)) {
    throw new Error("the packaged coordinator mode is not supported");
  }
  if (environment.TREESWAP_FUNDING_ENABLED !== undefined && environment.TREESWAP_FUNDING_ENABLED !== "false") {
    throw new Error("the packaged coordinator cannot enable funding by configuration");
  }
  if (containsPath(runtimeDirectory, databasePath) || containsPath(dirname(databasePath), runtimeDirectory)) {
    throw new Error("coordinator runtime state and durable database must use separate directories");
  }
  const heartbeatSeconds = positiveInteger(
    environment.COORDINATOR_HEARTBEAT_SECONDS,
    10,
    "coordinator heartbeat interval",
    { minimum: 5, maximum: 30 },
  );
  const leaseStaleSeconds = positiveInteger(
    environment.COORDINATOR_LEASE_STALE_SECONDS,
    90,
    "coordinator lease stale interval",
    { minimum: 30, maximum: 300 },
  );
  if (leaseStaleSeconds < heartbeatSeconds * 3) {
    throw new Error("coordinator lease stale interval must cover at least three heartbeats");
  }
  const integritySeconds = positiveInteger(
    environment.COORDINATOR_INTEGRITY_SECONDS,
    30,
    "coordinator integrity interval",
    { minimum: 10, maximum: 300 },
  );
  if (integritySeconds < heartbeatSeconds) {
    throw new Error("coordinator integrity interval cannot be shorter than its heartbeat");
  }
  let releaseActivationManifestPath = null;
  let releaseRefreshSeconds = null;
  let releaseProviderTimeoutMs = null;
  let activeExecutionIntervalSeconds = null;
  let activeMaxSettlementsPerCycle = null;
  let activePreparationTimeoutSeconds = null;
  let activeReplicaMode = null;
  let activeExpectedReplicas = null;
  let activeFailureWindowSeconds = null;
  let activeMaximumFailures = null;
  let recoveryActivationManifestPath = null;
  let recoveryRefreshSeconds = null;
  let recoveryProviderTimeoutMs = null;
  let recoveryActionIntervalSeconds = null;
  let recoveryPreparationTimeoutSeconds = null;
  const hasReleaseInputs = environment.COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH !== undefined
    || environment.COORDINATOR_RELEASE_REFRESH_SECONDS !== undefined
    || environment.COORDINATOR_RELEASE_PROVIDER_TIMEOUT_MS !== undefined;
  const hasActiveExecutionInputs = environment.COORDINATOR_ACTIVE_EXECUTION_INTERVAL_SECONDS !== undefined
    || environment.COORDINATOR_ACTIVE_MAX_SETTLEMENTS_PER_CYCLE !== undefined
    || environment.COORDINATOR_ACTIVE_PREPARATION_TIMEOUT_SECONDS !== undefined
    || environment.COORDINATOR_ACTIVE_REPLICA_MODE !== undefined
    || environment.COORDINATOR_ACTIVE_EXPECTED_REPLICAS !== undefined
    || environment.COORDINATOR_ACTIVE_FAILURE_WINDOW_SECONDS !== undefined
    || environment.COORDINATOR_ACTIVE_MAXIMUM_FAILURES !== undefined;
  const hasRecoveryVerificationInputs = environment.COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH !== undefined
    || environment.COORDINATOR_RECOVERY_REFRESH_SECONDS !== undefined
    || environment.COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS !== undefined;
  const hasRecoveryActionInput = environment.COORDINATOR_RECOVERY_ACTION_INTERVAL_SECONDS !== undefined
    || environment.COORDINATOR_RECOVERY_PREPARATION_TIMEOUT_SECONDS !== undefined;
  const hasRecoveryInputs = hasRecoveryVerificationInputs || hasRecoveryActionInput;
  if (["release-verification-only", "active-execution-only"].includes(mode)) {
    if (hasRecoveryInputs) {
      throw new Error("release coordinator mode cannot accept recovery verification inputs");
    }
    if (mode === "release-verification-only" && hasActiveExecutionInputs) {
      throw new Error("release-verification coordinator mode cannot accept active execution inputs");
    }
    releaseActivationManifestPath = canonicalAbsolutePath(
      environment.COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH,
      "coordinator release activation manifest path",
    );
    if (releaseActivationManifestPath === "/"
        || containsPath(runtimeDirectory, releaseActivationManifestPath)
        || containsPath(dirname(databasePath), releaseActivationManifestPath)) {
      throw new Error("coordinator release inputs must use a separate read-only directory");
    }
    releaseRefreshSeconds = positiveInteger(
      environment.COORDINATOR_RELEASE_REFRESH_SECONDS,
      10,
      "coordinator release refresh interval",
      { minimum: 5, maximum: 30 },
    );
    releaseProviderTimeoutMs = positiveInteger(
      environment.COORDINATOR_RELEASE_PROVIDER_TIMEOUT_MS,
      10_000,
      "coordinator release provider timeout",
      { minimum: 1_000, maximum: 30_000 },
    );
    const maximumVerificationSeconds = 10 + 2 * Math.ceil(releaseProviderTimeoutMs / 1_000);
    if (leaseStaleSeconds < heartbeatSeconds * 3 + maximumVerificationSeconds) {
      throw new Error("coordinator release lease stale interval does not cover verification work and heartbeats");
    }
    if (mode === "active-execution-only") {
      activeExecutionIntervalSeconds = positiveInteger(
        environment.COORDINATOR_ACTIVE_EXECUTION_INTERVAL_SECONDS,
        10,
        "coordinator active execution interval",
        { minimum: 5, maximum: 30 },
      );
      if (activeExecutionIntervalSeconds > releaseRefreshSeconds) {
        throw new Error("coordinator active execution interval cannot exceed its release refresh interval");
      }
      activeMaxSettlementsPerCycle = positiveInteger(
        environment.COORDINATOR_ACTIVE_MAX_SETTLEMENTS_PER_CYCLE,
        16,
        "coordinator active maximum settlements per cycle",
        { minimum: 1, maximum: 64 },
      );
      activePreparationTimeoutSeconds = positiveInteger(
        environment.COORDINATOR_ACTIVE_PREPARATION_TIMEOUT_SECONDS,
        60,
        "coordinator active preparation timeout",
        { minimum: 10, maximum: 300 },
      );
      activeReplicaMode = environment.COORDINATOR_ACTIVE_REPLICA_MODE ?? "";
      if (activeReplicaMode !== "single-host") {
        throw new Error("coordinator active execution requires explicit single-host replica mode");
      }
      activeExpectedReplicas = positiveInteger(
        environment.COORDINATOR_ACTIVE_EXPECTED_REPLICAS,
        null,
        "coordinator active expected replica count",
        { minimum: 1, maximum: 1 },
      );
      activeFailureWindowSeconds = positiveInteger(
        environment.COORDINATOR_ACTIVE_FAILURE_WINDOW_SECONDS,
        300,
        "coordinator active failure window",
        { minimum: 60, maximum: 3_600 },
      );
      activeMaximumFailures = positiveInteger(
        environment.COORDINATOR_ACTIVE_MAXIMUM_FAILURES,
        3,
        "coordinator active maximum failures",
        { minimum: 1, maximum: 10 },
      );
    }
  } else if (["recovery-verification-only", "recovery-execution-only"].includes(mode)) {
    if (hasReleaseInputs || hasActiveExecutionInputs) {
      throw new Error("recovery coordinator mode cannot accept release or active execution inputs");
    }
    if (mode === "recovery-verification-only" && hasRecoveryActionInput) {
      throw new Error("recovery-verification coordinator mode cannot accept recovery action inputs");
    }
    recoveryActivationManifestPath = canonicalAbsolutePath(
      environment.COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH,
      "coordinator recovery activation manifest path",
    );
    if (recoveryActivationManifestPath === "/"
        || containsPath(runtimeDirectory, recoveryActivationManifestPath)
        || containsPath(dirname(databasePath), recoveryActivationManifestPath)) {
      throw new Error("coordinator recovery inputs must use a separate read-only directory");
    }
    recoveryRefreshSeconds = positiveInteger(
      environment.COORDINATOR_RECOVERY_REFRESH_SECONDS,
      10,
      "coordinator recovery refresh interval",
      { minimum: 5, maximum: 30 },
    );
    recoveryProviderTimeoutMs = positiveInteger(
      environment.COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS,
      10_000,
      "coordinator recovery provider timeout",
      { minimum: 1_000, maximum: 30_000 },
    );
    const maximumVerificationSeconds = 10 + 2 * Math.ceil(recoveryProviderTimeoutMs / 1_000);
    if (leaseStaleSeconds < heartbeatSeconds * 3 + maximumVerificationSeconds) {
      throw new Error("coordinator recovery lease stale interval does not cover verification work and heartbeats");
    }
    if (mode === "recovery-execution-only") {
      recoveryActionIntervalSeconds = positiveInteger(
        environment.COORDINATOR_RECOVERY_ACTION_INTERVAL_SECONDS,
        10,
        "coordinator recovery action interval",
        { minimum: 5, maximum: 30 },
      );
      recoveryPreparationTimeoutSeconds = positiveInteger(
        environment.COORDINATOR_RECOVERY_PREPARATION_TIMEOUT_SECONDS,
        60,
        "coordinator recovery preparation timeout",
        { minimum: 10, maximum: 300 },
      );
    }
  } else if (hasReleaseInputs || hasActiveExecutionInputs || hasRecoveryInputs) {
    throw new Error("closed coordinator mode cannot accept release, active, or recovery verification inputs");
  }
  return Object.freeze({
    activeExecutionIntervalSeconds,
    activeExpectedReplicas,
    activeFailureWindowSeconds,
    activeMaxSettlementsPerCycle,
    activeMaximumFailures,
    activePreparationTimeoutSeconds,
    activeReplicaMode,
    databasePath,
    heartbeatSeconds,
    integritySeconds,
    leaseStaleSeconds,
    mode,
    recoveryActionIntervalSeconds,
    recoveryActivationManifestPath,
    recoveryPreparationTimeoutSeconds,
    recoveryProviderTimeoutMs,
    recoveryRefreshSeconds,
    releaseActivationManifestPath,
    releaseProviderTimeoutMs,
    releaseRefreshSeconds,
    runtimeDirectory,
  });
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error("coordinator runtime path must be a real directory");
  await chmod(path, 0o700);
  if (await realpath(path) !== path) throw new Error("coordinator runtime path must not traverse symbolic links");
}

async function readPrivateJson(path, name) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error(`${name} must be one bounded private regular file`);
  }
  try {
    const state = await handle.stat();
    if (!state.isFile() || (state.mode & 0o077) !== 0 || state.size > MAX_FILE_BYTES) {
      throw new Error(`${name} must be one bounded private regular file`);
    }
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_FILE_BYTES) throw new Error(`${name} must be one bounded private regular file`);
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } catch (error) {
    if (/bounded private regular file/.test(error?.message ?? "")) throw error;
    throw new Error(`${name} must contain valid JSON`);
  } finally {
    await handle.close();
  }
}

async function writePrivateExclusive(path, value) {
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replacePrivateJson(directory, name, value, token) {
  const destination = join(directory, name);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("coordinator lease output is not a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.${name}.${token}.${randomBytes(8).toString("hex")}.partial`);
  let created = false;
  try {
    await writePrivateExclusive(temporary, value);
    created = true;
    await rename(temporary, destination);
    created = false;
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => {});
  }
}

function normalizeLeaseRecord(value, name, timestampField) {
  exactKeys(value, ["schema", "token", timestampField], name);
  if (value.schema !== LEASE_SCHEMA || !TOKEN.test(String(value.token ?? ""))) {
    throw new Error(`${name} identity is invalid`);
  }
  exactIsoSecond(value[timestampField], `${name}.${timestampField}`);
  return value;
}

async function inspectExistingLease(leaseDirectory, nowMilliseconds, staleSeconds) {
  const state = await lstat(leaseDirectory);
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error("coordinator lease path is not a real directory");
  const owner = normalizeLeaseRecord(
    await readPrivateJson(join(leaseDirectory, OWNER_FILE_NAME), "coordinator lease owner"),
    "coordinator lease owner",
    "startedAt",
  );
  const heartbeat = normalizeLeaseRecord(
    await readPrivateJson(join(leaseDirectory, HEARTBEAT_FILE_NAME), "coordinator lease heartbeat"),
    "coordinator lease heartbeat",
    "heartbeatAt",
  );
  if (owner.token !== heartbeat.token) throw new Error("coordinator lease identity changed");
  const heartbeatMilliseconds = exactIsoSecond(heartbeat.heartbeatAt, "coordinator lease heartbeat.heartbeatAt");
  if (heartbeatMilliseconds < exactIsoSecond(owner.startedAt, "coordinator lease owner.startedAt")) {
    throw new Error("coordinator lease heartbeat predates its owner");
  }
  if (heartbeatMilliseconds > nowMilliseconds + 5_000) throw new Error("coordinator lease heartbeat is in the future");
  return Object.freeze({ owner, heartbeat, stale: nowMilliseconds - heartbeatMilliseconds > staleSeconds * 1_000 });
}

function validateAggregateObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 16_384) throw new Error(`${name} is too large`);
  if (/(address|email|endpoint|invoice|macaroon|preimage|private.?key|rpc.?url|wallet)/i.test(serialized)) {
    throw new Error(`${name} contains a forbidden cross-network or secret field`);
  }
  return value;
}

export function validateCoordinatorClosedStatus(value, { expectedToken = null } = {}) {
  exactKeys(value, CLOSED_STATUS_KEYS, "coordinator service status");
  if (value.schema !== COORDINATOR_SERVICE_STATUS_SCHEMA || value.mode !== "closed") {
    throw new Error("coordinator service status is not closed mode");
  }
  if (value.fundingAuthorization !== false || value.dispatchAuthorization !== false || value.networkListener !== false) {
    throw new Error("coordinator service status claims unavailable authority");
  }
  const startedMilliseconds = exactIsoSecond(value.serviceStartedAt, "coordinator service start");
  const heartbeatMilliseconds = exactIsoSecond(value.heartbeatAt, "coordinator service heartbeat");
  if (heartbeatMilliseconds < startedMilliseconds) throw new Error("coordinator service heartbeat predates its start");
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.leaseId ?? ""))) {
    throw new Error("coordinator service lease identifier is invalid");
  }
  if (!Number.isSafeInteger(value.recoveredInterruptedActions) || value.recoveredInterruptedActions < 0) {
    throw new TypeError("coordinator recovered-action count is invalid");
  }
  exactKeys(value.database, ["check", "schema", "status"], "coordinator database status");
  if (value.database.check !== "quick_check" || value.database.schema !== "treeswap.coordinator.v7" || value.database.status !== "ok") {
    throw new Error("coordinator database status is not healthy");
  }
  validateAggregateObject(value.metrics, "coordinator metrics");
  validateAggregateObject(value.admissionMetrics, "coordinator admission metrics");
  if (expectedToken !== null) {
    if (!TOKEN.test(expectedToken)) throw new Error("expected coordinator lease token is invalid");
    if (value.leaseId !== leaseId(expectedToken)) throw new Error("coordinator service status is bound to another lease");
  }
  return Object.freeze(value);
}

function nullableIsoSecond(value, name) {
  if (value === null) return null;
  exactIsoSecond(value, name);
  return value;
}

function validateReleaseVerification(value) {
  exactKeys(value, RELEASE_VERIFICATION_KEYS, "coordinator release verification");
  exactKeys(value.authorizations, RELEASE_AUTHORIZATION_KEYS, "coordinator release verification authorizations");
  if (value.schema !== "treeswap.coordinator-release-verification.v1"
      || value.scope !== "verification-only-no-listener-solver-context-dispatch-or-funding-authority"
      || !["active", "inactive"].includes(value.state)
      || Object.values(value.authorizations).some((authorization) => authorization !== false)) {
    throw new Error("coordinator release verification identity or authority is invalid");
  }
  const lastAttemptAt = nullableIsoSecond(value.lastAttemptAt, "coordinator release verification last attempt");
  const lastSuccessAt = nullableIsoSecond(value.lastSuccessAt, "coordinator release verification last success");
  if (!Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) {
    throw new TypeError("coordinator release verification failure count is invalid");
  }
  if (lastSuccessAt !== null && (lastAttemptAt === null || Date.parse(lastSuccessAt) > Date.parse(lastAttemptAt))) {
    throw new Error("coordinator release verification success time exceeds its latest attempt");
  }
  const releaseFields = [
    "approvalBundleDigest",
    "inputManifestDigest",
    "policyDigest",
    "providerConsensusDigest",
    "reconciliationDigest",
    "recordDigest",
    "releaseId",
    "runtimeBlockHash",
  ];
  if (value.state === "inactive") {
    if (releaseFields.some((field) => value[field] !== null)
        || value.fundingMode !== null
        || value.validUntil !== null
        || value.runtimeBlockNumber !== null) {
      throw new Error("inactive coordinator release verification retains active release fields");
    }
    return Object.freeze(value);
  }
  if (lastAttemptAt === null || lastSuccessAt === null || value.consecutiveFailures !== 0) {
    throw new Error("active coordinator release verification lacks a successful current attempt");
  }
  if (releaseFields.some((field) => !NONZERO_BYTES32.test(String(value[field] ?? "")))) {
    throw new TypeError("active coordinator release verification digest is invalid");
  }
  if (!["operator-testnet-bootstrap", "operator-testnet"].includes(value.fundingMode)) {
    throw new Error("active coordinator release verification funding mode is invalid");
  }
  if (!Number.isSafeInteger(value.validUntil) || value.validUntil <= 0
      || !Number.isSafeInteger(value.runtimeBlockNumber) || value.runtimeBlockNumber < 0) {
    throw new TypeError("active coordinator release verification time or block is invalid");
  }
  if (value.validUntil * 1_000 < Date.parse(lastSuccessAt)) {
    throw new Error("active coordinator release verification is already expired at its successful attempt");
  }
  return Object.freeze(value);
}

export function validateCoordinatorReleaseVerificationStatus(value, { expectedToken = null } = {}) {
  exactKeys(value, RELEASE_STATUS_KEYS, "coordinator release verification service status");
  if (value.schema !== COORDINATOR_RELEASE_SERVICE_STATUS_SCHEMA || value.mode !== "release-verification-only") {
    throw new Error("coordinator release verification service status identity is invalid");
  }
  if (value.fundingAuthorization !== false || value.dispatchAuthorization !== false || value.networkListener !== false) {
    throw new Error("coordinator release verification service status claims unavailable authority");
  }
  const startedMilliseconds = exactIsoSecond(value.serviceStartedAt, "coordinator service start");
  const heartbeatMilliseconds = exactIsoSecond(value.heartbeatAt, "coordinator service heartbeat");
  if (heartbeatMilliseconds < startedMilliseconds) throw new Error("coordinator service heartbeat predates its start");
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.leaseId ?? ""))) {
    throw new Error("coordinator service lease identifier is invalid");
  }
  if (!Number.isSafeInteger(value.recoveredInterruptedActions) || value.recoveredInterruptedActions < 0) {
    throw new TypeError("coordinator recovered-action count is invalid");
  }
  exactKeys(value.database, ["check", "schema", "status"], "coordinator database status");
  if (value.database.check !== "quick_check" || value.database.schema !== "treeswap.coordinator.v7"
      || value.database.status !== "ok") {
    throw new Error("coordinator database status is not healthy");
  }
  validateAggregateObject(value.metrics, "coordinator metrics");
  validateAggregateObject(value.admissionMetrics, "coordinator admission metrics");
  const verification = validateReleaseVerification(value.releaseVerification);
  if (verification.lastAttemptAt !== null && Date.parse(verification.lastAttemptAt) > heartbeatMilliseconds) {
    throw new Error("coordinator release verification attempt exceeds the service heartbeat");
  }
  if (expectedToken !== null) {
    if (!TOKEN.test(expectedToken)) throw new Error("expected coordinator lease token is invalid");
    if (value.leaseId !== leaseId(expectedToken)) throw new Error("coordinator service status is bound to another lease");
  }
  return Object.freeze(value);
}

function validateActiveReplicaPolicy(value) {
  if (value.replicaPolicy !== ACTIVE_REPLICA_POLICY || value.expectedReplicas !== 1) {
    throw new Error("coordinator active execution is not bound to one local replica");
  }
}

function validateActiveExecution(value) {
  exactKeys(value, ACTIVE_EXECUTION_KEYS, "coordinator active execution lifecycle");
  exactKeys(
    value.authorizations,
    ACTIVE_EXECUTION_AUTHORIZATION_KEYS,
    "coordinator active execution authorizations",
  );
  exactKeys(value.counts, ACTIVE_EXECUTION_COUNT_KEYS, "coordinator active execution counts");
  if (value.schema !== "treeswap.coordinator-active-execution-lifecycle.v1"
      || value.scope !== "database-derived-lightning-bit-settlements-only-no-network-job-intake"
      || value.workSource !== "original-coordinator-store-nonterminal-settlements"
      || value.networkListener !== false
      || !["idle", "running", "degraded", "inactive", "active", "stopped"].includes(value.state)) {
    throw new Error("coordinator active execution identity is invalid");
  }
  const expectedAuthorization = value.state === "active";
  if (Object.values(value.authorizations).some((authorization) => authorization !== expectedAuthorization)) {
    throw new Error("coordinator active execution authority is not derived from active state");
  }
  const startedAt = exactIsoSecond(value.startedAt, "coordinator active execution start");
  const lastAttemptAt = nullableIsoSecond(
    value.lastAttemptAt,
    "coordinator active execution last attempt",
  );
  const lastSuccessAt = nullableIsoSecond(
    value.lastSuccessAt,
    "coordinator active execution last success",
  );
  if (lastAttemptAt !== null && Date.parse(lastAttemptAt) < startedAt) {
    throw new Error("coordinator active execution attempt predates its start");
  }
  if (lastSuccessAt !== null
      && (lastAttemptAt === null || Date.parse(lastSuccessAt) > Date.parse(lastAttemptAt))) {
    throw new Error("coordinator active execution success exceeds its latest attempt");
  }
  if (!Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) {
    throw new TypeError("coordinator active execution failure count is invalid");
  }
  if (!Number.isSafeInteger(value.policyCount) || value.policyCount < 1 || value.policyCount > 32
      || !NONZERO_BYTES32.test(String(value.releaseRecordDigest ?? ""))
      || !NONZERO_BYTES32.test(String(value.policySetDigest ?? ""))) {
    throw new TypeError("coordinator active execution release or policy set is invalid");
  }
  for (const count of Object.values(value.counts)) {
    if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
      throw new TypeError("coordinator active execution aggregate count is invalid");
    }
  }
  if (value.counts.eligible > value.counts.discovered
      || value.counts.attempted > value.counts.eligible
      || value.counts.attempted > 64
      || value.counts.backlog !== value.counts.eligible - value.counts.attempted) {
    throw new Error("coordinator active execution aggregate counts are inconsistent");
  }
  const unmatched = value.counts.discovered - value.counts.eligible;
  if (value.counts.gateClosed < unmatched
      || value.counts.advanced + value.counts.waiting + value.counts.done
        + value.counts.halted + value.counts.gateClosed - unmatched !== value.counts.attempted) {
    throw new Error("coordinator active execution aggregate outcomes do not reconcile");
  }
  if (value.cycleDigest !== null && !NONZERO_BYTES32.test(String(value.cycleDigest ?? ""))) {
    throw new TypeError("coordinator active execution cycle digest is invalid");
  }
  if (value.cursorDigest !== null && !NONZERO_BYTES32.test(String(value.cursorDigest ?? ""))) {
    throw new TypeError("coordinator active execution cursor digest is invalid");
  }
  const emptyCycle = Object.values(value.counts).every((count) => count === 0)
    && value.cycleDigest === null;
  if (value.state === "idle") {
    if (lastAttemptAt !== null || lastSuccessAt !== null || value.consecutiveFailures !== 0
        || !emptyCycle || value.cursorDigest !== null) {
      throw new Error("idle coordinator active execution retains runtime state");
    }
  } else if (value.state === "running") {
    if (lastAttemptAt === null || value.consecutiveFailures !== 0 || !emptyCycle) {
      throw new Error("running coordinator active execution contains a completed cycle");
    }
  } else if (["active", "degraded"].includes(value.state)) {
    if (lastAttemptAt === null || value.consecutiveFailures !== 0 || value.cycleDigest === null) {
      throw new Error("completed coordinator active execution lacks a current cycle");
    }
    if (value.state === "active"
        && (lastSuccessAt !== lastAttemptAt || value.counts.gateClosed !== 0)) {
      throw new Error("active coordinator execution is not a successful open cycle");
    }
    if (value.state === "degraded" && value.counts.gateClosed < 1) {
      throw new Error("degraded coordinator execution lacks a closed work item");
    }
  } else if (value.state === "inactive") {
    if (lastAttemptAt === null || value.consecutiveFailures < 1 || !emptyCycle) {
      throw new Error("inactive coordinator active execution lacks a failed current cycle");
    }
  } else if (!emptyCycle) {
    throw new Error("stopped coordinator active execution retains a current cycle");
  }
  return Object.freeze(value);
}

export function validateCoordinatorActiveExecutionBootstrapStatus(
  value,
  { expectedToken = null } = {},
) {
  exactKeys(
    value,
    ACTIVE_EXECUTION_BOOTSTRAP_STATUS_KEYS,
    "coordinator active execution bootstrap status",
  );
  if (value.schema !== COORDINATOR_ACTIVE_EXECUTION_BOOTSTRAP_STATUS_SCHEMA
      || value.mode !== "active-execution-only"
      || value.phase !== "preparing-active-execution-policy-set") {
    throw new Error("coordinator active execution bootstrap identity is invalid");
  }
  validateActiveReplicaPolicy(value);
  if (value.fundingAuthorization !== false
      || value.lightningDispatchAuthorization !== false
      || value.newExposureAuthorization !== false
      || value.networkListener !== false) {
    throw new Error("coordinator active execution bootstrap claims unavailable authority");
  }
  const startedMilliseconds = exactIsoSecond(value.serviceStartedAt, "coordinator service start");
  const heartbeatMilliseconds = exactIsoSecond(value.heartbeatAt, "coordinator service heartbeat");
  if (heartbeatMilliseconds < startedMilliseconds) {
    throw new Error("coordinator service heartbeat predates its start");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.leaseId ?? ""))) {
    throw new Error("coordinator service lease identifier is invalid");
  }
  if (!Number.isSafeInteger(value.recoveredInterruptedActions)
      || value.recoveredInterruptedActions < 0) {
    throw new TypeError("coordinator recovered-action count is invalid");
  }
  exactKeys(value.database, ["check", "schema", "status"], "coordinator database status");
  if (value.database.check !== "quick_check" || value.database.schema !== "treeswap.coordinator.v7"
      || value.database.status !== "ok") {
    throw new Error("coordinator database status is not healthy");
  }
  validateAggregateObject(value.metrics, "coordinator metrics");
  validateAggregateObject(value.admissionMetrics, "coordinator admission metrics");
  const verification = validateReleaseVerification(value.releaseVerification);
  if (verification.state !== "active") {
    throw new Error("coordinator active execution bootstrap verification is inactive");
  }
  if (verification.lastAttemptAt !== null
      && Date.parse(verification.lastAttemptAt) > heartbeatMilliseconds) {
    throw new Error("coordinator release verification attempt exceeds the service heartbeat");
  }
  if (expectedToken !== null) {
    if (!TOKEN.test(expectedToken)) throw new Error("expected coordinator lease token is invalid");
    if (value.leaseId !== leaseId(expectedToken)) {
      throw new Error("coordinator service status is bound to another lease");
    }
  }
  return Object.freeze(value);
}

export function validateCoordinatorActiveExecutionStatus(value, { expectedToken = null } = {}) {
  exactKeys(value, ACTIVE_EXECUTION_STATUS_KEYS, "coordinator active execution service status");
  if (value.schema !== COORDINATOR_ACTIVE_EXECUTION_SERVICE_STATUS_SCHEMA
      || value.mode !== "active-execution-only" || value.networkListener !== false) {
    throw new Error("coordinator active execution service identity is invalid");
  }
  validateActiveReplicaPolicy(value);
  const startedMilliseconds = exactIsoSecond(value.serviceStartedAt, "coordinator service start");
  const heartbeatMilliseconds = exactIsoSecond(value.heartbeatAt, "coordinator service heartbeat");
  if (heartbeatMilliseconds < startedMilliseconds) {
    throw new Error("coordinator service heartbeat predates its start");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.leaseId ?? ""))) {
    throw new Error("coordinator service lease identifier is invalid");
  }
  if (!Number.isSafeInteger(value.recoveredInterruptedActions)
      || value.recoveredInterruptedActions < 0) {
    throw new TypeError("coordinator recovered-action count is invalid");
  }
  exactKeys(value.database, ["check", "schema", "status"], "coordinator database status");
  if (value.database.check !== "quick_check" || value.database.schema !== "treeswap.coordinator.v7"
      || value.database.status !== "ok") {
    throw new Error("coordinator database status is not healthy");
  }
  validateAggregateObject(value.metrics, "coordinator metrics");
  validateAggregateObject(value.admissionMetrics, "coordinator admission metrics");
  const verification = validateReleaseVerification(value.releaseVerification);
  const activeExecution = validateActiveExecution(value.activeExecution);
  if (activeExecution.releaseRecordDigest !== verification.recordDigest) {
    throw new Error("coordinator active execution is bound to another verified release");
  }
  if (verification.lastAttemptAt !== null
      && Date.parse(verification.lastAttemptAt) > heartbeatMilliseconds) {
    throw new Error("coordinator release verification attempt exceeds the service heartbeat");
  }
  if (Date.parse(activeExecution.startedAt) > heartbeatMilliseconds
      || Date.parse(activeExecution.startedAt) < startedMilliseconds
      || (activeExecution.lastAttemptAt !== null
        && Date.parse(activeExecution.lastAttemptAt) > heartbeatMilliseconds)) {
    throw new Error("coordinator active execution time exceeds the service heartbeat");
  }
  const authorityExpected = verification.state === "active" && activeExecution.state === "active";
  if (value.fundingAuthorization !== authorityExpected
      || value.lightningDispatchAuthorization !== authorityExpected
      || value.newExposureAuthorization !== authorityExpected) {
    throw new Error("coordinator active service authority is not derived from live state");
  }
  if (expectedToken !== null) {
    if (!TOKEN.test(expectedToken)) throw new Error("expected coordinator lease token is invalid");
    if (value.leaseId !== leaseId(expectedToken)) {
      throw new Error("coordinator service status is bound to another lease");
    }
  }
  return Object.freeze(value);
}

function validateRecoveryVerification(value) {
  exactKeys(value, RECOVERY_VERIFICATION_KEYS, "coordinator recovery verification");
  exactKeys(value.authorizations, RECOVERY_AUTHORIZATION_KEYS, "coordinator recovery verification authorizations");
  if (value.schema !== "treeswap.coordinator-recovery-verification.v1"
      || value.scope !== "verification-only-no-recovery-context-action-dispatch-new-exposure-or-funding-authority"
      || !["active", "inactive"].includes(value.state)
      || Object.values(value.authorizations).some((authorization) => authorization !== false)) {
    throw new Error("coordinator recovery verification identity or authority is invalid");
  }
  const lastAttemptAt = nullableIsoSecond(value.lastAttemptAt, "coordinator recovery verification last attempt");
  const lastSuccessAt = nullableIsoSecond(value.lastSuccessAt, "coordinator recovery verification last success");
  if (!Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) {
    throw new TypeError("coordinator recovery verification failure count is invalid");
  }
  if (lastSuccessAt !== null && (lastAttemptAt === null || Date.parse(lastSuccessAt) > Date.parse(lastAttemptAt))) {
    throw new Error("coordinator recovery verification success time exceeds its latest attempt");
  }
  const releaseFields = [
    "approvalBundleDigest",
    "inputManifestDigest",
    "policyDigest",
    "providerConsensusDigest",
    "recordDigest",
    "releaseId",
    "runtimeBlockHash",
  ];
  const runtimeFields = ["gateOpen", "emergencyHalted", "bitPaused", "balancesReconciled"];
  if (value.state === "inactive") {
    if (releaseFields.some((field) => value[field] !== null)
        || runtimeFields.some((field) => value[field] !== null)
        || value.validUntil !== null
        || value.runtimeBlockNumber !== null) {
      throw new Error("inactive coordinator recovery verification retains active recovery fields");
    }
    return Object.freeze(value);
  }
  if (lastAttemptAt === null || lastSuccessAt === null || value.consecutiveFailures !== 0) {
    throw new Error("active coordinator recovery verification lacks a successful current attempt");
  }
  if (releaseFields.some((field) => !NONZERO_BYTES32.test(String(value[field] ?? "")))) {
    throw new TypeError("active coordinator recovery verification digest is invalid");
  }
  if (!Number.isSafeInteger(value.validUntil) || value.validUntil <= 0
      || !Number.isSafeInteger(value.runtimeBlockNumber) || value.runtimeBlockNumber < 0) {
    throw new TypeError("active coordinator recovery verification time or block is invalid");
  }
  if (value.validUntil * 1_000 < Date.parse(lastSuccessAt)) {
    throw new Error("active coordinator recovery verification is already expired at its successful attempt");
  }
  if (typeof value.gateOpen !== "boolean" || typeof value.emergencyHalted !== "boolean"
      || typeof value.bitPaused !== "boolean" || value.balancesReconciled !== true) {
    throw new Error("active coordinator recovery runtime state is invalid or unreconciled");
  }
  if (value.gateOpen && value.emergencyHalted) {
    throw new Error("active coordinator recovery runtime cannot be open and emergency halted");
  }
  return Object.freeze(value);
}

export function validateCoordinatorRecoveryVerificationStatus(value, { expectedToken = null } = {}) {
  exactKeys(value, RECOVERY_STATUS_KEYS, "coordinator recovery verification service status");
  if (value.schema !== COORDINATOR_RECOVERY_SERVICE_STATUS_SCHEMA || value.mode !== "recovery-verification-only") {
    throw new Error("coordinator recovery verification service status identity is invalid");
  }
  if (value.fundingAuthorization !== false || value.dispatchAuthorization !== false || value.networkListener !== false) {
    throw new Error("coordinator recovery verification service status claims unavailable authority");
  }
  const startedMilliseconds = exactIsoSecond(value.serviceStartedAt, "coordinator service start");
  const heartbeatMilliseconds = exactIsoSecond(value.heartbeatAt, "coordinator service heartbeat");
  if (heartbeatMilliseconds < startedMilliseconds) throw new Error("coordinator service heartbeat predates its start");
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.leaseId ?? ""))) {
    throw new Error("coordinator service lease identifier is invalid");
  }
  if (!Number.isSafeInteger(value.recoveredInterruptedActions) || value.recoveredInterruptedActions < 0) {
    throw new TypeError("coordinator recovered-action count is invalid");
  }
  exactKeys(value.database, ["check", "schema", "status"], "coordinator database status");
  if (value.database.check !== "quick_check" || value.database.schema !== "treeswap.coordinator.v7"
      || value.database.status !== "ok") {
    throw new Error("coordinator database status is not healthy");
  }
  validateAggregateObject(value.metrics, "coordinator metrics");
  validateAggregateObject(value.admissionMetrics, "coordinator admission metrics");
  const verification = validateRecoveryVerification(value.recoveryVerification);
  if (verification.lastAttemptAt !== null && Date.parse(verification.lastAttemptAt) > heartbeatMilliseconds) {
    throw new Error("coordinator recovery verification attempt exceeds the service heartbeat");
  }
  if (expectedToken !== null) {
    if (!TOKEN.test(expectedToken)) throw new Error("expected coordinator lease token is invalid");
    if (value.leaseId !== leaseId(expectedToken)) throw new Error("coordinator service status is bound to another lease");
  }
  return Object.freeze(value);
}

export function validateCoordinatorRecoveryExecutionBootstrapStatus(
  value,
  { expectedToken = null } = {},
) {
  exactKeys(
    value,
    RECOVERY_EXECUTION_BOOTSTRAP_STATUS_KEYS,
    "coordinator recovery execution bootstrap status",
  );
  if (value.schema !== COORDINATOR_RECOVERY_EXECUTION_BOOTSTRAP_STATUS_SCHEMA
      || value.mode !== "recovery-execution-only"
      || value.phase !== "preparing-custody-job-set") {
    throw new Error("coordinator recovery execution bootstrap identity is invalid");
  }
  if (value.boundedExistingLiabilityEvmClaimRecovery !== false
      || value.fundingAuthorization !== false
      || value.lightningDispatchAuthorization !== false
      || value.newExposureAuthorization !== false
      || value.networkListener !== false) {
    throw new Error("coordinator recovery execution bootstrap claims unavailable authority");
  }
  const startedMilliseconds = exactIsoSecond(value.serviceStartedAt, "coordinator service start");
  const heartbeatMilliseconds = exactIsoSecond(value.heartbeatAt, "coordinator service heartbeat");
  if (heartbeatMilliseconds < startedMilliseconds) {
    throw new Error("coordinator service heartbeat predates its start");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.leaseId ?? ""))) {
    throw new Error("coordinator service lease identifier is invalid");
  }
  if (!Number.isSafeInteger(value.recoveredInterruptedActions)
      || value.recoveredInterruptedActions < 0) {
    throw new TypeError("coordinator recovered-action count is invalid");
  }
  exactKeys(value.database, ["check", "schema", "status"], "coordinator database status");
  if (value.database.check !== "quick_check" || value.database.schema !== "treeswap.coordinator.v7"
      || value.database.status !== "ok") {
    throw new Error("coordinator database status is not healthy");
  }
  validateAggregateObject(value.metrics, "coordinator metrics");
  validateAggregateObject(value.admissionMetrics, "coordinator admission metrics");
  const verification = validateRecoveryVerification(value.recoveryVerification);
  if (verification.state !== "active") {
    throw new Error("coordinator recovery execution bootstrap verification is inactive");
  }
  if (verification.lastAttemptAt !== null
      && Date.parse(verification.lastAttemptAt) > heartbeatMilliseconds) {
    throw new Error("coordinator recovery verification attempt exceeds the service heartbeat");
  }
  if (expectedToken !== null) {
    if (!TOKEN.test(expectedToken)) throw new Error("expected coordinator lease token is invalid");
    if (value.leaseId !== leaseId(expectedToken)) {
      throw new Error("coordinator service status is bound to another lease");
    }
  }
  return Object.freeze(value);
}

function validateRecoveryAction(value) {
  exactKeys(value, RECOVERY_ACTION_KEYS, "coordinator recovery action loop");
  exactKeys(
    value.authorizations,
    RECOVERY_ACTION_AUTHORIZATION_KEYS,
    "coordinator recovery action authorizations",
  );
  exactKeys(value.counts, RECOVERY_ACTION_COUNT_KEYS, "coordinator recovery action counts");
  if (value.schema !== "treeswap.coordinator-recovery-action-loop.v2"
      || value.scope
        !== "already-bound-settlement-recovery-only-no-lightning-planning-dispatch-new-exposure-or-funding-authority"
      || !["idle", "running", "inactive", "active", "stopped"].includes(value.state)
      || Object.values(value.authorizations).some((authorization) => authorization !== false)) {
    throw new Error("coordinator recovery action identity or authority is invalid");
  }
  const startedAt = exactIsoSecond(value.startedAt, "coordinator recovery action start");
  const lastAttemptAt = nullableIsoSecond(
    value.lastAttemptAt,
    "coordinator recovery action last attempt",
  );
  const lastSuccessAt = nullableIsoSecond(
    value.lastSuccessAt,
    "coordinator recovery action last success",
  );
  if (lastAttemptAt !== null && Date.parse(lastAttemptAt) < startedAt) {
    throw new Error("coordinator recovery action attempt predates its start");
  }
  if (lastSuccessAt !== null
      && (lastAttemptAt === null || Date.parse(lastSuccessAt) > Date.parse(lastAttemptAt))) {
    throw new Error("coordinator recovery action success exceeds its latest attempt");
  }
  if (!Number.isSafeInteger(value.jobCount) || value.jobCount < 1 || value.jobCount > 64) {
    throw new RangeError("coordinator recovery action job count is outside policy");
  }
  if (![value.releaseId, value.releaseRecordDigest, value.jobSetDigest]
    .every((digest) => NONZERO_BYTES32.test(String(digest ?? "")))) {
    throw new TypeError("coordinator recovery action release or job-set digest is invalid");
  }
  if (!Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) {
    throw new TypeError("coordinator recovery action failure count is invalid");
  }
  for (const count of Object.values(value.counts)) {
    if (!Number.isSafeInteger(count) || count < 0 || count > value.jobCount) {
      throw new TypeError("coordinator recovery action aggregate count is invalid");
    }
  }
  if (value.counts.advanced + value.counts.waiting + value.counts.gateClosed
      + value.counts.done + value.counts.halted !== value.counts.attempted) {
    throw new Error("coordinator recovery action aggregate counts do not reconcile");
  }
  if (value.cycleDigest !== null && !NONZERO_BYTES32.test(String(value.cycleDigest ?? ""))) {
    throw new TypeError("coordinator recovery action cycle digest is invalid");
  }
  if (value.state === "idle") {
    if (lastAttemptAt !== null || lastSuccessAt !== null || value.consecutiveFailures !== 0
        || Object.values(value.counts).some((count) => count !== 0) || value.cycleDigest !== null) {
      throw new Error("idle coordinator recovery action retains execution state");
    }
  } else if (value.state === "running") {
    if (lastAttemptAt === null || Object.values(value.counts).some((count) => count !== 0)
        || value.cycleDigest !== null) {
      throw new Error("running coordinator recovery action contains a completed cycle");
    }
  } else if (value.state === "active") {
    if (lastAttemptAt === null || lastSuccessAt === null || lastSuccessAt !== lastAttemptAt
        || value.consecutiveFailures !== 0 || value.counts.attempted !== value.jobCount
        || value.cycleDigest === null) {
      throw new Error("active coordinator recovery action lacks a successful current cycle");
    }
  } else if (value.state === "inactive") {
    if (lastAttemptAt === null || value.consecutiveFailures < 1) {
      throw new Error("inactive coordinator recovery action lacks a failed current cycle");
    }
  } else if (Object.values(value.counts).some((count) => count !== 0)
      || value.cycleDigest !== null) {
    throw new Error("stopped coordinator recovery action retains a current cycle");
  }
  return Object.freeze(value);
}

export function validateCoordinatorRecoveryExecutionStatus(value, { expectedToken = null } = {}) {
  exactKeys(value, RECOVERY_EXECUTION_STATUS_KEYS, "coordinator recovery execution service status");
  if (value.schema !== COORDINATOR_RECOVERY_EXECUTION_SERVICE_STATUS_SCHEMA
      || value.mode !== "recovery-execution-only") {
    throw new Error("coordinator recovery execution service status identity is invalid");
  }
  if (value.fundingAuthorization !== false
      || value.lightningDispatchAuthorization !== false
      || value.newExposureAuthorization !== false
      || value.networkListener !== false) {
    throw new Error("coordinator recovery execution service status claims unavailable authority");
  }
  const startedMilliseconds = exactIsoSecond(value.serviceStartedAt, "coordinator service start");
  const heartbeatMilliseconds = exactIsoSecond(value.heartbeatAt, "coordinator service heartbeat");
  if (heartbeatMilliseconds < startedMilliseconds) {
    throw new Error("coordinator service heartbeat predates its start");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.leaseId ?? ""))) {
    throw new Error("coordinator service lease identifier is invalid");
  }
  if (!Number.isSafeInteger(value.recoveredInterruptedActions)
      || value.recoveredInterruptedActions < 0) {
    throw new TypeError("coordinator recovered-action count is invalid");
  }
  exactKeys(value.database, ["check", "schema", "status"], "coordinator database status");
  if (value.database.check !== "quick_check" || value.database.schema !== "treeswap.coordinator.v7"
      || value.database.status !== "ok") {
    throw new Error("coordinator database status is not healthy");
  }
  validateAggregateObject(value.metrics, "coordinator metrics");
  validateAggregateObject(value.admissionMetrics, "coordinator admission metrics");
  const verification = validateRecoveryVerification(value.recoveryVerification);
  const action = validateRecoveryAction(value.recoveryAction);
  if (action.releaseId !== verification.releaseId
      || action.releaseRecordDigest !== verification.recordDigest) {
    throw new Error("coordinator recovery action is bound to another verified release");
  }
  if (verification.lastAttemptAt !== null
      && Date.parse(verification.lastAttemptAt) > heartbeatMilliseconds) {
    throw new Error("coordinator recovery verification attempt exceeds the service heartbeat");
  }
  if (Date.parse(action.startedAt) > heartbeatMilliseconds
      || Date.parse(action.startedAt) < startedMilliseconds
      || (action.lastAttemptAt !== null && Date.parse(action.lastAttemptAt) > heartbeatMilliseconds)) {
    throw new Error("coordinator recovery action time exceeds the service heartbeat");
  }
  const boundedClaimExpected = verification.state === "active"
    && action.state === "active"
    && verification.bitPaused === false;
  if (value.boundedExistingLiabilityEvmClaimRecovery !== boundedClaimExpected) {
    throw new Error("coordinator recovery execution claim availability is not derived from live state");
  }
  if (expectedToken !== null) {
    if (!TOKEN.test(expectedToken)) throw new Error("expected coordinator lease token is invalid");
    if (value.leaseId !== leaseId(expectedToken)) {
      throw new Error("coordinator service status is bound to another lease");
    }
  }
  return Object.freeze(value);
}

function validateCoordinatorServiceStatus(value, options = {}) {
  if (value?.schema === COORDINATOR_SERVICE_STATUS_SCHEMA) {
    return validateCoordinatorClosedStatus(value, options);
  }
  if (value?.schema === COORDINATOR_RELEASE_SERVICE_STATUS_SCHEMA) {
    return validateCoordinatorReleaseVerificationStatus(value, options);
  }
  if (value?.schema === COORDINATOR_ACTIVE_EXECUTION_BOOTSTRAP_STATUS_SCHEMA) {
    return validateCoordinatorActiveExecutionBootstrapStatus(value, options);
  }
  if (value?.schema === COORDINATOR_ACTIVE_EXECUTION_SERVICE_STATUS_SCHEMA) {
    return validateCoordinatorActiveExecutionStatus(value, options);
  }
  if (value?.schema === COORDINATOR_RECOVERY_SERVICE_STATUS_SCHEMA) {
    return validateCoordinatorRecoveryVerificationStatus(value, options);
  }
  if (value?.schema === COORDINATOR_RECOVERY_EXECUTION_BOOTSTRAP_STATUS_SCHEMA) {
    return validateCoordinatorRecoveryExecutionBootstrapStatus(value, options);
  }
  if (value?.schema === COORDINATOR_RECOVERY_EXECUTION_SERVICE_STATUS_SCHEMA) {
    return validateCoordinatorRecoveryExecutionStatus(value, options);
  }
  throw new Error("coordinator service status schema is unsupported");
}

export function buildCoordinatorClosedStatus({ store, serviceStartedAt, heartbeatAt, leaseIdentifier, recoveredInterruptedActions }) {
  return validateCoordinatorClosedStatus({
    schema: COORDINATOR_SERVICE_STATUS_SCHEMA,
    mode: "closed",
    serviceStartedAt,
    heartbeatAt,
    leaseId: leaseIdentifier,
    database: store.integrityCheck({ full: false }),
    recoveredInterruptedActions,
    metrics: store.metrics(),
    admissionMetrics: store.admissionMetrics(),
    networkListener: false,
    dispatchAuthorization: false,
    fundingAuthorization: false,
  });
}

export function buildCoordinatorReleaseVerificationStatus({
  store,
  serviceStartedAt,
  heartbeatAt,
  leaseIdentifier,
  recoveredInterruptedActions,
  releaseVerification,
}) {
  return validateCoordinatorReleaseVerificationStatus({
    schema: COORDINATOR_RELEASE_SERVICE_STATUS_SCHEMA,
    mode: "release-verification-only",
    serviceStartedAt,
    heartbeatAt,
    leaseId: leaseIdentifier,
    database: store.integrityCheck({ full: false }),
    recoveredInterruptedActions,
    metrics: store.metrics(),
    admissionMetrics: store.admissionMetrics(),
    networkListener: false,
    dispatchAuthorization: false,
    fundingAuthorization: false,
    releaseVerification,
  });
}

export function buildCoordinatorActiveExecutionBootstrapStatus({
  store,
  serviceStartedAt,
  heartbeatAt,
  leaseIdentifier,
  recoveredInterruptedActions,
  releaseVerification,
}) {
  return validateCoordinatorActiveExecutionBootstrapStatus({
    schema: COORDINATOR_ACTIVE_EXECUTION_BOOTSTRAP_STATUS_SCHEMA,
    mode: "active-execution-only",
    phase: "preparing-active-execution-policy-set",
    replicaPolicy: ACTIVE_REPLICA_POLICY,
    expectedReplicas: 1,
    serviceStartedAt,
    heartbeatAt,
    leaseId: leaseIdentifier,
    database: store.integrityCheck({ full: false }),
    recoveredInterruptedActions,
    metrics: store.metrics(),
    admissionMetrics: store.admissionMetrics(),
    networkListener: false,
    lightningDispatchAuthorization: false,
    newExposureAuthorization: false,
    fundingAuthorization: false,
    releaseVerification,
  });
}

export function buildCoordinatorActiveExecutionStatus({
  store,
  serviceStartedAt,
  heartbeatAt,
  leaseIdentifier,
  recoveredInterruptedActions,
  releaseVerification,
  activeExecution,
}) {
  const authority = releaseVerification.state === "active" && activeExecution.state === "active";
  return validateCoordinatorActiveExecutionStatus({
    schema: COORDINATOR_ACTIVE_EXECUTION_SERVICE_STATUS_SCHEMA,
    mode: "active-execution-only",
    replicaPolicy: ACTIVE_REPLICA_POLICY,
    expectedReplicas: 1,
    serviceStartedAt,
    heartbeatAt,
    leaseId: leaseIdentifier,
    database: store.integrityCheck({ full: false }),
    recoveredInterruptedActions,
    metrics: store.metrics(),
    admissionMetrics: store.admissionMetrics(),
    networkListener: false,
    lightningDispatchAuthorization: authority,
    newExposureAuthorization: authority,
    fundingAuthorization: authority,
    releaseVerification,
    activeExecution,
  });
}

export function buildCoordinatorRecoveryVerificationStatus({
  store,
  serviceStartedAt,
  heartbeatAt,
  leaseIdentifier,
  recoveredInterruptedActions,
  recoveryVerification,
}) {
  return validateCoordinatorRecoveryVerificationStatus({
    schema: COORDINATOR_RECOVERY_SERVICE_STATUS_SCHEMA,
    mode: "recovery-verification-only",
    serviceStartedAt,
    heartbeatAt,
    leaseId: leaseIdentifier,
    database: store.integrityCheck({ full: false }),
    recoveredInterruptedActions,
    metrics: store.metrics(),
    admissionMetrics: store.admissionMetrics(),
    networkListener: false,
    dispatchAuthorization: false,
    fundingAuthorization: false,
    recoveryVerification,
  });
}

export function buildCoordinatorRecoveryExecutionBootstrapStatus({
  store,
  serviceStartedAt,
  heartbeatAt,
  leaseIdentifier,
  recoveredInterruptedActions,
  recoveryVerification,
}) {
  return validateCoordinatorRecoveryExecutionBootstrapStatus({
    schema: COORDINATOR_RECOVERY_EXECUTION_BOOTSTRAP_STATUS_SCHEMA,
    mode: "recovery-execution-only",
    phase: "preparing-custody-job-set",
    serviceStartedAt,
    heartbeatAt,
    leaseId: leaseIdentifier,
    database: store.integrityCheck({ full: false }),
    recoveredInterruptedActions,
    metrics: store.metrics(),
    admissionMetrics: store.admissionMetrics(),
    networkListener: false,
    lightningDispatchAuthorization: false,
    newExposureAuthorization: false,
    fundingAuthorization: false,
    boundedExistingLiabilityEvmClaimRecovery: false,
    recoveryVerification,
  });
}

export function buildCoordinatorRecoveryExecutionStatus({
  store,
  serviceStartedAt,
  heartbeatAt,
  leaseIdentifier,
  recoveredInterruptedActions,
  recoveryVerification,
  recoveryAction,
}) {
  return validateCoordinatorRecoveryExecutionStatus({
    schema: COORDINATOR_RECOVERY_EXECUTION_SERVICE_STATUS_SCHEMA,
    mode: "recovery-execution-only",
    serviceStartedAt,
    heartbeatAt,
    leaseId: leaseIdentifier,
    database: store.integrityCheck({ full: false }),
    recoveredInterruptedActions,
    metrics: store.metrics(),
    admissionMetrics: store.admissionMetrics(),
    networkListener: false,
    lightningDispatchAuthorization: false,
    newExposureAuthorization: false,
    fundingAuthorization: false,
    boundedExistingLiabilityEvmClaimRecovery: recoveryVerification.state === "active"
      && recoveryAction.state === "active"
      && recoveryVerification.bitPaused === false,
    recoveryVerification,
    recoveryAction,
  });
}

export async function acquireCoordinatorServiceLease(config, {
  now = () => Date.now(),
  randomBytesImpl = randomBytes,
} = {}) {
  await privateDirectory(config.runtimeDirectory);
  const leaseDirectory = join(config.runtimeDirectory, LEASE_DIRECTORY_NAME);
  let acquired = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(leaseDirectory, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const observed = await inspectExistingLease(leaseDirectory, now(), config.leaseStaleSeconds);
      if (!observed.stale) throw new Error("another coordinator supervisor holds a fresh lease");
      const quarantine = join(
        config.runtimeDirectory,
        `.coordinator.lease.stale.${randomHex(randomBytesImpl, 12, "coordinator lease quarantine")}`,
      );
      try {
        await rename(leaseDirectory, quarantine);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      await rm(quarantine, { recursive: true, force: true });
    }
  }
  if (!acquired) throw new Error("coordinator lease could not be acquired");
  let state;
  try {
    state = await lstat(leaseDirectory);
  } catch {
    throw new Error("coordinator lease could not be acquired");
  }
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error("coordinator lease is not a real directory");
  await chmod(leaseDirectory, 0o700);
  const token = randomHex(randomBytesImpl, 32, "coordinator lease");
  const startedAt = new Date(Math.floor(now() / 1_000) * 1_000).toISOString();
  try {
    await writePrivateExclusive(join(leaseDirectory, OWNER_FILE_NAME), { schema: LEASE_SCHEMA, token, startedAt });
    await writePrivateExclusive(join(leaseDirectory, HEARTBEAT_FILE_NAME), {
      schema: LEASE_SCHEMA,
      token,
      heartbeatAt: startedAt,
    });
  } catch (error) {
    await rm(leaseDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  async function requireOwnership() {
    const observed = await inspectExistingLease(leaseDirectory, now(), config.leaseStaleSeconds);
    if (observed.owner.token !== token) throw new Error("coordinator supervisor no longer owns its lease");
    if (observed.stale) throw new Error("coordinator supervisor lease is stale");
  }

  const lease = Object.freeze({
    leaseDirectory,
    leaseId: leaseId(token),
    startedAt,
    async publish(status) {
      await requireOwnership();
      const validated = validateCoordinatorServiceStatus(status, { expectedToken: token });
      await replacePrivateJson(leaseDirectory, STATUS_FILE_NAME, validated, token);
      await replacePrivateJson(leaseDirectory, HEARTBEAT_FILE_NAME, {
        schema: LEASE_SCHEMA,
        token,
        heartbeatAt: validated.heartbeatAt,
      }, token);
    },
    async release() {
      try {
        await requireOwnership();
      } catch (error) {
        if (error?.code === "ENOENT" || /no longer owns|lease is stale/.test(error?.message ?? "")) return false;
        throw error;
      }
      const released = join(config.runtimeDirectory, `.coordinator.lease.released.${token}`);
      try {
        await rename(leaseDirectory, released);
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
      await rm(released, { recursive: true, force: true });
      return true;
    },
  });
  COORDINATOR_SERVICE_LEASES.set(lease, Object.freeze({
    leaseId: lease.leaseId,
    mode: config.mode,
    requireOwnership,
    startedAt,
  }));
  return lease;
}

export async function assertCoordinatorServiceLeaseOwnership(lease) {
  const provenance = lease && typeof lease === "object"
    ? COORDINATOR_SERVICE_LEASES.get(lease)
    : null;
  if (!provenance) {
    throw new TypeError("coordinator work requires the original same-process service lease");
  }
  await provenance.requireOwnership();
  return Object.freeze({
    leaseId: provenance.leaseId,
    startedAt: provenance.startedAt,
  });
}

export async function assertCoordinatorServiceLeaseMode(lease, expectedMode) {
  const provenance = lease && typeof lease === "object"
    ? COORDINATOR_SERVICE_LEASES.get(lease)
    : null;
  if (!provenance) {
    throw new TypeError("coordinator service mode requires the original same-process service lease");
  }
  if (typeof expectedMode !== "string" || provenance.mode !== expectedMode) {
    throw new Error("coordinator service lease was acquired for another mode");
  }
  await provenance.requireOwnership();
  return Object.freeze({
    leaseId: provenance.leaseId,
    mode: provenance.mode,
    startedAt: provenance.startedAt,
  });
}

export async function readCoordinatorServiceHealth(config, { now = () => Date.now() } = {}) {
  const leaseDirectory = join(config.runtimeDirectory, LEASE_DIRECTORY_NAME);
  const observed = await inspectExistingLease(leaseDirectory, now(), config.leaseStaleSeconds);
  if (observed.stale) throw new Error("coordinator supervisor heartbeat is stale");
  const status = validateCoordinatorServiceStatus(
    await readPrivateJson(join(leaseDirectory, STATUS_FILE_NAME), "coordinator service status"),
    { expectedToken: observed.owner.token },
  );
  if (status.mode !== config.mode) {
    throw new Error("coordinator service status mode does not match its configured mode");
  }
  if (status.serviceStartedAt !== observed.owner.startedAt || status.heartbeatAt !== observed.heartbeat.heartbeatAt) {
    throw new Error("coordinator service status does not match its lease");
  }
  const health = {
    schema: status.schema,
    mode: status.mode,
    heartbeatAt: status.heartbeatAt,
    databaseStatus: status.database.status,
    fundingAuthorization: false,
  };
  if (status.mode === "release-verification-only") {
    if (status.releaseVerification.state !== "active") {
      throw new Error("coordinator release verification is inactive");
    }
    const nowSeconds = Math.floor(now() / 1_000);
    if (nowSeconds > status.releaseVerification.validUntil) {
      throw new Error("coordinator release verification is expired");
    }
    health.releaseVerification = "active";
    health.releaseValidUntil = status.releaseVerification.validUntil;
  }
  if (status.mode === "active-execution-only") {
    if (status.schema === COORDINATOR_ACTIVE_EXECUTION_BOOTSTRAP_STATUS_SCHEMA) {
      throw new Error("coordinator active execution bootstrap is incomplete");
    }
    if (status.releaseVerification.state !== "active") {
      throw new Error("coordinator active execution release verification is inactive");
    }
    const nowSeconds = Math.floor(now() / 1_000);
    if (nowSeconds > status.releaseVerification.validUntil) {
      throw new Error("coordinator active execution release verification is expired");
    }
    if (status.activeExecution.state !== "active") {
      throw new Error("coordinator active execution lifecycle is not active");
    }
    if (status.fundingAuthorization !== true
        || status.lightningDispatchAuthorization !== true
        || status.newExposureAuthorization !== true) {
      throw new Error("coordinator active execution authority is closed");
    }
    health.releaseVerification = "active";
    health.releaseValidUntil = status.releaseVerification.validUntil;
    health.activeExecution = "active";
    health.activePolicyCount = status.activeExecution.policyCount;
    health.activeCycleDigest = status.activeExecution.cycleDigest;
    health.replicaPolicy = status.replicaPolicy;
    health.expectedReplicas = status.expectedReplicas;
    health.fundingAuthorization = true;
    health.lightningDispatchAuthorization = true;
    health.newExposureAuthorization = true;
  }
  if (status.mode === "recovery-verification-only") {
    if (status.recoveryVerification.state !== "active") {
      throw new Error("coordinator recovery verification is inactive");
    }
    const nowSeconds = Math.floor(now() / 1_000);
    if (nowSeconds > status.recoveryVerification.validUntil) {
      throw new Error("coordinator recovery verification is expired");
    }
    health.recoveryVerification = "active";
    health.recoveryValidUntil = status.recoveryVerification.validUntil;
    health.gateOpen = status.recoveryVerification.gateOpen;
    health.emergencyHalted = status.recoveryVerification.emergencyHalted;
    health.bitPaused = status.recoveryVerification.bitPaused;
  }
  if (status.mode === "recovery-execution-only") {
    if (status.schema === COORDINATOR_RECOVERY_EXECUTION_BOOTSTRAP_STATUS_SCHEMA) {
      throw new Error("coordinator recovery execution bootstrap is incomplete");
    }
    if (status.recoveryVerification.state !== "active") {
      throw new Error("coordinator recovery execution verification is inactive");
    }
    const nowSeconds = Math.floor(now() / 1_000);
    if (nowSeconds > status.recoveryVerification.validUntil) {
      throw new Error("coordinator recovery execution verification is expired");
    }
    if (status.recoveryAction.state !== "active") {
      throw new Error("coordinator recovery action loop is not active");
    }
    health.recoveryVerification = "active";
    health.recoveryValidUntil = status.recoveryVerification.validUntil;
    health.recoveryAction = "active";
    health.recoveryJobCount = status.recoveryAction.jobCount;
    health.boundedExistingLiabilityEvmClaimRecovery =
      status.boundedExistingLiabilityEvmClaimRecovery;
    health.lightningDispatchAuthorization = false;
    health.newExposureAuthorization = false;
    health.gateOpen = status.recoveryVerification.gateOpen;
    health.emergencyHalted = status.recoveryVerification.emergencyHalted;
    health.bitPaused = status.recoveryVerification.bitPaused;
  }
  return Object.freeze(health);
}
