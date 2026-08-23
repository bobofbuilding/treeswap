import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const COORDINATOR_SERVICE_STATUS_SCHEMA = "treeswap.coordinator-service-status.v1";
const LEASE_SCHEMA = "treeswap.coordinator-service-lease.v1";
const LEASE_DIRECTORY_NAME = "coordinator.lease";
const OWNER_FILE_NAME = "owner.json";
const HEARTBEAT_FILE_NAME = "heartbeat.json";
const STATUS_FILE_NAME = "status.json";
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 65_536;
const ALLOWED_STATUS_KEYS = Object.freeze([
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
  if (environment.COORDINATOR_MODE !== undefined && environment.COORDINATOR_MODE !== "closed") {
    throw new Error("the packaged coordinator supports closed mode only");
  }
  if (environment.TREESWAP_FUNDING_ENABLED !== undefined && environment.TREESWAP_FUNDING_ENABLED !== "false") {
    throw new Error("the closed coordinator cannot enable funding");
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
  return Object.freeze({
    databasePath,
    heartbeatSeconds,
    integritySeconds,
    leaseStaleSeconds,
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
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile() || (state.mode & 0o077) !== 0 || state.size > MAX_FILE_BYTES) {
    throw new Error(`${name} must be one bounded private regular file`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${name} must contain valid JSON`);
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
  exactKeys(value, ALLOWED_STATUS_KEYS, "coordinator service status");
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
  if (value.database.check !== "quick_check" || value.database.schema !== "treeswap.coordinator.v6" || value.database.status !== "ok") {
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
    const owner = normalizeLeaseRecord(
      await readPrivateJson(join(leaseDirectory, OWNER_FILE_NAME), "coordinator lease owner"),
      "coordinator lease owner",
      "startedAt",
    );
    if (owner.token !== token) throw new Error("coordinator supervisor no longer owns its lease");
  }

  return Object.freeze({
    leaseDirectory,
    leaseId: leaseId(token),
    startedAt,
    token,
    async publish(status) {
      await requireOwnership();
      const validated = validateCoordinatorClosedStatus(status, { expectedToken: token });
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
        if (error?.code === "ENOENT" || /no longer owns/.test(error?.message ?? "")) return false;
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
}

export async function readCoordinatorServiceHealth(config, { now = () => Date.now() } = {}) {
  const leaseDirectory = join(config.runtimeDirectory, LEASE_DIRECTORY_NAME);
  const observed = await inspectExistingLease(leaseDirectory, now(), config.leaseStaleSeconds);
  if (observed.stale) throw new Error("coordinator supervisor heartbeat is stale");
  const status = validateCoordinatorClosedStatus(
    await readPrivateJson(join(leaseDirectory, STATUS_FILE_NAME), "coordinator service status"),
    { expectedToken: observed.owner.token },
  );
  if (status.serviceStartedAt !== observed.owner.startedAt || status.heartbeatAt !== observed.heartbeat.heartbeatAt) {
    throw new Error("coordinator service status does not match its lease");
  }
  return Object.freeze({
    schema: status.schema,
    mode: status.mode,
    heartbeatAt: status.heartbeatAt,
    databaseStatus: status.database.status,
    fundingAuthorization: false,
  });
}
