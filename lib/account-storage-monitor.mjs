import { createHash } from "node:crypto";
import { ACCOUNT_SCHEMA_PROBE } from "./account-capability.mjs";
import { ACCOUNT_MAINTENANCE_BATCH_LIMIT } from "./account-maintenance.mjs";

export const ACCOUNT_STORAGE_MONITOR_SCHEMA = "treeswap.account-storage-monitor-evidence.v1";
export const ACCOUNT_STORAGE_MONITOR_PRIVACY = "aggregate-only-no-account-or-payment-identifiers";
export const ACCOUNT_STORAGE_BACKLOG_PROBE_LIMIT = ACCOUNT_MAINTENANCE_BATCH_LIMIT + 1;
export const ACCOUNT_STORAGE_REQUIRED_ALERT_ROUTES = 2;

export const DEFAULT_ACCOUNT_STORAGE_MONITOR_POLICY = Object.freeze({
  maximumDatabaseLatencyMilliseconds: 1_000,
  maximumMaintenanceAgeSeconds: 1_800,
  maximumObservationAgeSeconds: 120,
  minimumAccessCoverageSeconds: 300,
  maximumExpiredRecordsPerTable: ACCOUNT_MAINTENANCE_BATCH_LIMIT,
});

export const ACCOUNT_STORAGE_MONITOR_SQL = Object.freeze({
  schema: ACCOUNT_SCHEMA_PROBE,
  nonces: `SELECT COUNT(*) AS count FROM (
  SELECT 1 FROM siwe_nonces
  WHERE expires_at <= ?
  ORDER BY expires_at ASC
  LIMIT ?
)`,
  sessions: `SELECT COUNT(*) AS count FROM (
  SELECT 1 FROM auth_sessions
  WHERE expires_at <= ?
  ORDER BY expires_at ASC
  LIMIT ?
)`,
  notifications: `SELECT COUNT(*) AS count FROM (
  SELECT 1 FROM notification_preferences
  WHERE retention_expires_at <= ?
  ORDER BY retention_expires_at ASC
  LIMIT ?
)`,
});

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const observations = new WeakSet();

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

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function digestValue(value) {
  const canonical = (entry) => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonical(entry[key])]));
    }
    return entry;
  };
  return `0x${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function exactDigest(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value) || value === ZERO_DIGEST) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return value;
}

function exactPolicy(raw = DEFAULT_ACCOUNT_STORAGE_MONITOR_POLICY) {
  const value = exactRecord(raw, Object.keys(DEFAULT_ACCOUNT_STORAGE_MONITOR_POLICY), "account storage monitor policy");
  const policy = Object.freeze({
    maximumDatabaseLatencyMilliseconds: integer(
      value.maximumDatabaseLatencyMilliseconds,
      "maximum database latency milliseconds",
      1,
      60_000,
    ),
    maximumMaintenanceAgeSeconds: integer(
      value.maximumMaintenanceAgeSeconds,
      "maximum maintenance age seconds",
      60,
      86_400,
    ),
    maximumObservationAgeSeconds: integer(
      value.maximumObservationAgeSeconds,
      "maximum observation age seconds",
      1,
      3_600,
    ),
    minimumAccessCoverageSeconds: integer(
      value.minimumAccessCoverageSeconds,
      "minimum access coverage seconds",
      60,
      86_400,
    ),
    maximumExpiredRecordsPerTable: integer(
      value.maximumExpiredRecordsPerTable,
      "maximum expired records per table",
      0,
      ACCOUNT_STORAGE_BACKLOG_PROBE_LIMIT - 1,
    ),
  });
  return Object.freeze({
    policy,
    policyDigest: digestValue({ schema: "treeswap.account-storage-monitor-policy.v1", ...policy }),
  });
}

function exactCountResult(value, name) {
  if (!value || typeof value !== "object" || value.success !== true || !Array.isArray(value.results)
      || value.results.length !== 1) {
    throw new Error(`${name} backlog result is malformed`);
  }
  const row = value.results[0];
  if (!row || typeof row !== "object" || Array.isArray(row) || Reflect.ownKeys(row).length !== 1
      || !Object.hasOwn(row, "count")) {
    throw new Error(`${name} backlog row is malformed`);
  }
  return integer(row.count, `${name} backlog count`, 0, ACCOUNT_STORAGE_BACKLOG_PROBE_LIMIT);
}

function branded(body) {
  const evidence = Object.freeze({ ...body, evidenceDigest: digestValue(body) });
  observations.add(evidence);
  return evidence;
}

function emptyDatabaseBody(observedAt, latencyMilliseconds, reason) {
  return {
    schema: "treeswap.account-storage-database-observation.v1",
    status: "unsafe",
    observedAt,
    storageAvailable: false,
    schemaValid: false,
    latencyMilliseconds,
    expired: Object.freeze({ nonces: 0, sessions: 0, notifications: 0 }),
    backlogProbeSaturated: false,
    collectionFailure: reason,
    privacy: ACCOUNT_STORAGE_MONITOR_PRIVACY,
  };
}

async function collectAccountStorageDatabaseObservationWithClock({
  binding,
  observedAt: rawObservedAt,
  monotonicMilliseconds,
}) {
  const observedAt = integer(rawObservedAt, "database observation time", 1);
  if (typeof monotonicMilliseconds !== "function") {
    throw new TypeError("database observation requires a monotonic millisecond clock");
  }
  let startedAt;
  try {
    startedAt = integer(monotonicMilliseconds(), "database observation start time");
  } catch {
    return branded(emptyDatabaseBody(observedAt, 0, "CLOCK_INVALID"));
  }
  let latencyMilliseconds = 0;
  let results;
  try {
    if (!binding || typeof binding.prepare !== "function" || typeof binding.batch !== "function") {
      throw new Error("storage unavailable");
    }
    const statements = Object.entries(ACCOUNT_STORAGE_MONITOR_SQL).map(([name, sql]) => {
      const statement = binding.prepare(sql);
      if (!statement) throw new Error("statement unavailable");
      if (name === "schema") return statement;
      if (typeof statement.bind !== "function") throw new Error("binding unavailable");
      return statement.bind(
        new Date(observedAt * 1_000).toISOString(),
        ACCOUNT_STORAGE_BACKLOG_PROBE_LIMIT,
      );
    });
    results = await binding.batch(statements);
    const finishedAt = integer(monotonicMilliseconds(), "database observation finish time");
    if (finishedAt < startedAt) throw new Error("clock rollback");
    latencyMilliseconds = finishedAt - startedAt;
  } catch {
    try {
      const finishedAt = integer(monotonicMilliseconds(), "database observation failure time");
      latencyMilliseconds = Math.max(finishedAt - startedAt, 0);
    } catch {}
    return branded(emptyDatabaseBody(observedAt, latencyMilliseconds, "DATABASE_PROBE_FAILED"));
  }

  try {
    if (!Array.isArray(results) || results.length !== 4
        || !results[0] || results[0].success !== true || !Array.isArray(results[0].results)) {
      throw new Error("schema result malformed");
    }
    const expired = Object.freeze({
      nonces: exactCountResult(results[1], "nonce"),
      sessions: exactCountResult(results[2], "session"),
      notifications: exactCountResult(results[3], "notification"),
    });
    const backlogProbeSaturated = Object.values(expired)
      .some((count) => count === ACCOUNT_STORAGE_BACKLOG_PROBE_LIMIT);
    return branded({
      schema: "treeswap.account-storage-database-observation.v1",
      status: backlogProbeSaturated ? "unsafe" : "healthy",
      observedAt,
      storageAvailable: true,
      schemaValid: true,
      latencyMilliseconds,
      expired,
      backlogProbeSaturated,
      collectionFailure: null,
      privacy: ACCOUNT_STORAGE_MONITOR_PRIVACY,
    });
  } catch {
    return branded(emptyDatabaseBody(observedAt, latencyMilliseconds, "DATABASE_RESPONSE_INVALID"));
  }
}

export async function collectAccountStorageDatabaseObservation(input) {
  const { binding } = exactRecord(input, ["binding"], "account storage database collector input");
  return collectAccountStorageDatabaseObservationWithClock({
    binding,
    observedAt: Math.floor(Date.now() / 1_000),
    monotonicMilliseconds: () => performance.now(),
  });
}

export async function collectAccountStorageDatabaseObservationForTests(input) {
  return collectAccountStorageDatabaseObservationWithClock(input);
}

export function buildAccountStorageAccessObservation(input) {
  const value = exactRecord(input, [
    "auditCoverageComplete",
    "evidenceDigest",
    "observedAt",
    "observedFrom",
    "privilegeChangeEvents",
    "unauthorizedReadAttempts",
    "unauthorizedWriteAttempts",
  ], "account storage access observation");
  const observedFrom = integer(value.observedFrom, "access observation start", 1);
  const observedAt = integer(value.observedAt, "access observation finish", 1);
  if (observedAt < observedFrom) throw new RangeError("access observation interval is reversed");
  return branded({
    schema: "treeswap.account-storage-access-observation.v1",
    status: value.auditCoverageComplete === true
      && value.unauthorizedReadAttempts === 0
      && value.unauthorizedWriteAttempts === 0
      && value.privilegeChangeEvents === 0
      ? "healthy"
      : "unsafe",
    observedFrom,
    observedAt,
    auditCoverageComplete: value.auditCoverageComplete === true,
    unauthorizedReadAttempts: integer(value.unauthorizedReadAttempts, "unauthorized read attempts"),
    unauthorizedWriteAttempts: integer(value.unauthorizedWriteAttempts, "unauthorized write attempts"),
    privilegeChangeEvents: integer(value.privilegeChangeEvents, "privilege change events"),
    retainedEvidenceDigest: exactDigest(value.evidenceDigest, "access evidence digest"),
    privacy: ACCOUNT_STORAGE_MONITOR_PRIVACY,
  });
}

export function buildAccountStorageMaintenanceObservation(input) {
  const value = exactRecord(input, [
    "evidenceDigest",
    "lastCompletedAt",
    "moreWorkPossible",
    "observedAt",
    "status",
  ], "account storage maintenance observation");
  const lastCompletedAt = integer(value.lastCompletedAt, "last completed maintenance time", 1);
  const observedAt = integer(value.observedAt, "maintenance observation time", 1);
  if (lastCompletedAt > observedAt) throw new RangeError("maintenance completion is in the future");
  if (value.status !== "completed" && value.status !== "failed") {
    throw new TypeError("maintenance observation status is invalid");
  }
  if (typeof value.moreWorkPossible !== "boolean") {
    throw new TypeError("maintenance more-work flag must be boolean");
  }
  return branded({
    schema: "treeswap.account-storage-maintenance-observation.v1",
    status: value.status,
    observedAt,
    lastCompletedAt,
    moreWorkPossible: value.moreWorkPossible,
    retainedEvidenceDigest: exactDigest(value.evidenceDigest, "maintenance evidence digest"),
    privacy: ACCOUNT_STORAGE_MONITOR_PRIVACY,
  });
}

function acceptedObservation(value, schema) {
  return observations.has(value) && value.schema === schema ? value : null;
}

function safeAge(now, observedAt, prefix, reasons) {
  if (observedAt > now) {
    reasons.add(`${prefix}_FUTURE`);
    return null;
  }
  return now - observedAt;
}

export function evaluateAccountStorageMonitor({
  accessObservation: rawAccess,
  databaseObservation: rawDatabase,
  maintenanceObservation: rawMaintenance,
  now: rawNow,
  policy: rawPolicy = DEFAULT_ACCOUNT_STORAGE_MONITOR_POLICY,
}) {
  const now = integer(rawNow, "account storage monitor time", 1);
  const { policy, policyDigest } = exactPolicy(rawPolicy);
  const reasons = new Set();
  const database = acceptedObservation(rawDatabase, "treeswap.account-storage-database-observation.v1");
  const access = acceptedObservation(rawAccess, "treeswap.account-storage-access-observation.v1");
  const maintenance = acceptedObservation(rawMaintenance, "treeswap.account-storage-maintenance-observation.v1");

  if (!database) reasons.add("DATABASE_OBSERVATION_INVALID");
  else {
    const age = safeAge(now, database.observedAt, "DATABASE_OBSERVATION", reasons);
    if (age !== null && age > policy.maximumObservationAgeSeconds) reasons.add("DATABASE_OBSERVATION_STALE");
    if (!database.storageAvailable) reasons.add("DATABASE_UNAVAILABLE");
    if (!database.schemaValid) reasons.add("DATABASE_SCHEMA_INVALID");
    if (database.collectionFailure !== null) reasons.add(database.collectionFailure);
    if (database.latencyMilliseconds > policy.maximumDatabaseLatencyMilliseconds) reasons.add("DATABASE_LATENCY_EXCEEDED");
    if (database.backlogProbeSaturated) reasons.add("PURGE_BACKLOG_PROBE_SATURATED");
    const backlogCodes = Object.freeze({
      nonces: "CHALLENGE_PURGE_BACKLOG_EXCEEDED",
      sessions: "SESSION_PURGE_BACKLOG_EXCEEDED",
      notifications: "NOTIFICATION_PURGE_BACKLOG_EXCEEDED",
    });
    for (const [kind, count] of Object.entries(database.expired)) {
      if (count > policy.maximumExpiredRecordsPerTable) {
        reasons.add(backlogCodes[kind]);
      }
    }
  }

  if (!access) reasons.add("ACCESS_OBSERVATION_INVALID");
  else {
    const age = safeAge(now, access.observedAt, "ACCESS_OBSERVATION", reasons);
    if (age !== null && age > policy.maximumObservationAgeSeconds) reasons.add("ACCESS_OBSERVATION_STALE");
    if (!access.auditCoverageComplete) reasons.add("ACCESS_AUDIT_COVERAGE_INCOMPLETE");
    if (access.observedAt - access.observedFrom < policy.minimumAccessCoverageSeconds) {
      reasons.add("ACCESS_AUDIT_WINDOW_TOO_SHORT");
    }
    if (access.unauthorizedReadAttempts > 0) reasons.add("UNAUTHORIZED_READ_OBSERVED");
    if (access.unauthorizedWriteAttempts > 0) reasons.add("UNAUTHORIZED_WRITE_OBSERVED");
    if (access.privilegeChangeEvents > 0) reasons.add("ACCESS_PRIVILEGE_CHANGE_OBSERVED");
  }

  if (!maintenance) reasons.add("MAINTENANCE_OBSERVATION_INVALID");
  else {
    const age = safeAge(now, maintenance.observedAt, "MAINTENANCE_OBSERVATION", reasons);
    if (age !== null && age > policy.maximumObservationAgeSeconds) reasons.add("MAINTENANCE_OBSERVATION_STALE");
    if (maintenance.status !== "completed") reasons.add("MAINTENANCE_FAILED");
    if (maintenance.moreWorkPossible) reasons.add("PURGE_BACKLOG_REMAINS");
    if (maintenance.lastCompletedAt > now) reasons.add("MAINTENANCE_COMPLETION_FUTURE");
    else if (now - maintenance.lastCompletedAt > policy.maximumMaintenanceAgeSeconds) {
      reasons.add("MAINTENANCE_STALE");
    }
  }

  const reasonCodes = Object.freeze([...reasons].sort());
  const body = Object.freeze({
    schema: ACCOUNT_STORAGE_MONITOR_SCHEMA,
    status: reasonCodes.length === 0 ? "healthy" : "unsafe",
    observedAt: now,
    policyDigest,
    databaseEvidenceDigest: database?.evidenceDigest ?? ZERO_DIGEST,
    accessEvidenceDigest: access?.evidenceDigest ?? ZERO_DIGEST,
    maintenanceEvidenceDigest: maintenance?.evidenceDigest ?? ZERO_DIGEST,
    reasonCodes,
    privacy: ACCOUNT_STORAGE_MONITOR_PRIVACY,
    externalInputAuthenticationVerified: false,
    continuousDeploymentVerified: false,
    retainedMonitoringWindowVerified: false,
    pagingProviderIndependenceVerified: false,
    accountDisableAuthority: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    settlementAuthority: false,
    fundingAuthorization: false,
    releaseActivationAuthority: false,
  });
  const evidence = Object.freeze({ ...body, evidenceDigest: digestValue(body) });
  const serialized = JSON.stringify(evidence);
  if (/(wallet.?address|token.?hash|session.?cookie|email|invoice|payment.?hash|preimage|nonce)/i.test(serialized)) {
    throw new Error("account storage monitor evidence contains account or payment material");
  }
  return evidence;
}

function exactDelivery(value) {
  try {
    const result = exactRecord(value, ["delivered"], "account storage alert result");
    return result.delivered === true;
  } catch {
    return false;
  }
}

async function boundedAlert(callback, alert, timeoutMilliseconds) {
  if (typeof callback !== "function") return false;
  const controller = new AbortController();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => callback(alert, Object.freeze({ signal: controller.signal }))),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMilliseconds);
      }),
    ]);
    return exactDelivery(result);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runAccountStorageMonitorCycleWithClock({
  accessObservation,
  alertRoutes,
  databaseObservation,
  maintenanceObservation,
  nowSeconds,
  policy = DEFAULT_ACCOUNT_STORAGE_MONITOR_POLICY,
  alertTimeoutMilliseconds = 30_000,
}) {
  if (typeof nowSeconds !== "function") throw new TypeError("account storage monitor clock is required");
  const now = integer(nowSeconds(), "account storage monitor time", 1);
  const timeoutMilliseconds = integer(
    alertTimeoutMilliseconds,
    "account storage alert timeout milliseconds",
    1,
    300_000,
  );
  const evidence = evaluateAccountStorageMonitor({
    accessObservation,
    databaseObservation,
    maintenanceObservation,
    now,
    policy,
  });
  if (evidence.status === "healthy") {
    return Object.freeze({
      schema: "treeswap.account-storage-monitor-cycle.v1",
      outcome: "HEALTHY",
      evidenceDigest: evidence.evidenceDigest,
      alertRoutesAttempted: 0,
      alertRoutesDelivered: 0,
      alertDeliveryDegraded: false,
      productionReadiness: false,
      accountDisableAuthority: false,
      fundingAuthorization: false,
    });
  }
  const routeKeys = Array.isArray(alertRoutes) ? Reflect.ownKeys(alertRoutes) : [];
  const routes = Array.isArray(alertRoutes)
    && alertRoutes.length === ACCOUNT_STORAGE_REQUIRED_ALERT_ROUTES
    && routeKeys.length === ACCOUNT_STORAGE_REQUIRED_ALERT_ROUTES + 1
    && routeKeys.every((key) => key === "length" || key === "0" || key === "1")
    ? [...alertRoutes]
    : [];
  const alert = Object.freeze({
    schema: "treeswap.account-storage-monitor-alert.v1",
    triggeredAt: now,
    reasonCodes: evidence.reasonCodes,
    policyDigest: evidence.policyDigest,
    evidenceDigest: evidence.evidenceDigest,
  });
  const delivered = await Promise.all(routes.map((route) => boundedAlert(route, alert, timeoutMilliseconds)));
  const deliveredCount = delivered.filter(Boolean).length;
  return Object.freeze({
    schema: "treeswap.account-storage-monitor-cycle.v1",
    outcome: deliveredCount > 0 ? "ESCALATED" : "ESCALATION_INCOMPLETE",
    evidenceDigest: evidence.evidenceDigest,
    alertRoutesAttempted: routes.length,
    alertRoutesDelivered: deliveredCount,
    alertDeliveryDegraded: deliveredCount !== ACCOUNT_STORAGE_REQUIRED_ALERT_ROUTES,
    productionReadiness: false,
    accountDisableAuthority: false,
    fundingAuthorization: false,
  });
}

export async function runAccountStorageMonitorCycle(input) {
  const value = exactRecord(input, [
    "accessObservation",
    "alertRoutes",
    "databaseObservation",
    "maintenanceObservation",
  ], "account storage monitor cycle input");
  return runAccountStorageMonitorCycleWithClock({
    ...value,
    nowSeconds: () => Math.floor(Date.now() / 1_000),
  });
}

export async function runAccountStorageMonitorCycleForTests(input) {
  return runAccountStorageMonitorCycleWithClock(input);
}

export const accountStorageMonitorPolicy = Object.freeze({
  ...DEFAULT_ACCOUNT_STORAGE_MONITOR_POLICY,
  backlogProbeLimitPerTable: ACCOUNT_STORAGE_BACKLOG_PROBE_LIMIT,
  requiredAlertRoutes: ACCOUNT_STORAGE_REQUIRED_ALERT_ROUTES,
  privacy: ACCOUNT_STORAGE_MONITOR_PRIVACY,
});
