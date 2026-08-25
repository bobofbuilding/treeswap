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
export const COORDINATOR_RECOVERY_SERVICE_STATUS_SCHEMA =
  "treeswap.coordinator-recovery-verification-service-status.v1";
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
const RECOVERY_STATUS_KEYS = Object.freeze([...COMMON_STATUS_KEYS, "recoveryVerification"]);
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
  if (!["closed", "release-verification-only", "recovery-verification-only"].includes(mode)) {
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
  let recoveryActivationManifestPath = null;
  let recoveryRefreshSeconds = null;
  let recoveryProviderTimeoutMs = null;
  const hasReleaseInputs = environment.COORDINATOR_RELEASE_ACTIVATION_MANIFEST_PATH !== undefined
    || environment.COORDINATOR_RELEASE_REFRESH_SECONDS !== undefined
    || environment.COORDINATOR_RELEASE_PROVIDER_TIMEOUT_MS !== undefined;
  const hasRecoveryInputs = environment.COORDINATOR_RECOVERY_ACTIVATION_MANIFEST_PATH !== undefined
    || environment.COORDINATOR_RECOVERY_REFRESH_SECONDS !== undefined
    || environment.COORDINATOR_RECOVERY_PROVIDER_TIMEOUT_MS !== undefined;
  if (mode === "release-verification-only") {
    if (hasRecoveryInputs) {
      throw new Error("release-verification coordinator mode cannot accept recovery verification inputs");
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
  } else if (mode === "recovery-verification-only") {
    if (hasReleaseInputs) {
      throw new Error("recovery-verification coordinator mode cannot accept release verification inputs");
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
  } else if (hasReleaseInputs || hasRecoveryInputs) {
    throw new Error("closed coordinator mode cannot accept release or recovery verification inputs");
  }
  return Object.freeze({
    databasePath,
    heartbeatSeconds,
    integritySeconds,
    leaseStaleSeconds,
    mode,
    recoveryActivationManifestPath,
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

function validateCoordinatorServiceStatus(value, options = {}) {
  if (value?.schema === COORDINATOR_SERVICE_STATUS_SCHEMA) {
    return validateCoordinatorClosedStatus(value, options);
  }
  if (value?.schema === COORDINATOR_RELEASE_SERVICE_STATUS_SCHEMA) {
    return validateCoordinatorReleaseVerificationStatus(value, options);
  }
  if (value?.schema === COORDINATOR_RECOVERY_SERVICE_STATUS_SCHEMA) {
    return validateCoordinatorRecoveryVerificationStatus(value, options);
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

export async function readCoordinatorServiceHealth(config, { now = () => Date.now() } = {}) {
  const leaseDirectory = join(config.runtimeDirectory, LEASE_DIRECTORY_NAME);
  const observed = await inspectExistingLease(leaseDirectory, now(), config.leaseStaleSeconds);
  if (observed.stale) throw new Error("coordinator supervisor heartbeat is stale");
  const status = validateCoordinatorServiceStatus(
    await readPrivateJson(join(leaseDirectory, STATUS_FILE_NAME), "coordinator service status"),
    { expectedToken: observed.owner.token },
  );
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
  return Object.freeze(health);
}
