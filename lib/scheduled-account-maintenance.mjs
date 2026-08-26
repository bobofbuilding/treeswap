import { purgeExpiredAccountRecords } from "./account-maintenance.mjs";

export const SCHEDULED_ACCOUNT_MAINTENANCE_CRON = "*/15 * * * *";
export const SCHEDULED_ACCOUNT_MAINTENANCE_EVIDENCE_PREFIX = "account-maintenance/v1/";
export const SCHEDULED_ACCOUNT_MAINTENANCE_MAXIMUM_START_DELAY_MS = 10 * 60 * 1_000;

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^[1-9][0-9]*$/;
const EVIDENCE_SCHEMA = "treeswap.scheduled-account-maintenance-evidence.v1";
const RECEIPT_SCHEMA = "treeswap.scheduled-account-maintenance-receipt.v1";
const FAILURE_MESSAGE = "scheduled account maintenance failed closed";

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

function safeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value) || value === `0x${"00".repeat(32)}`) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return value;
}

function snapshotController(controller) {
  if (!controller || typeof controller !== "object") throw new TypeError("scheduled controller is unavailable");
  const cron = controller.cron;
  const scheduledTime = controller.scheduledTime;
  if (cron !== SCHEDULED_ACCOUNT_MAINTENANCE_CRON) {
    throw new Error("scheduled account maintenance cron is not the reviewed cadence");
  }
  safeInteger(scheduledTime, "scheduled account maintenance time");
  if (scheduledTime % 60_000 !== 0) throw new Error("scheduled account maintenance time is not minute-aligned");
  return Object.freeze({ cron, scheduledTime });
}

function snapshotEnvironment(env) {
  if (!env || typeof env !== "object") throw new TypeError("scheduled account maintenance environment is unavailable");
  const database = env.DB;
  const evidence = env.ACCOUNT_MAINTENANCE_EVIDENCE;
  const mode = env.ACCOUNT_MAINTENANCE_MODE;
  const sourceCommit = env.ACCOUNT_MAINTENANCE_SOURCE_COMMIT;
  const deploymentVersion = env.ACCOUNT_MAINTENANCE_DEPLOYMENT_VERSION;
  const sourceDatabaseDigest = digest(
    env.ACCOUNT_MAINTENANCE_SOURCE_DATABASE_DIGEST,
    "scheduled account maintenance source database digest",
  );
  const evidenceBucketDigest = digest(
    env.ACCOUNT_MAINTENANCE_EVIDENCE_BUCKET_DIGEST,
    "scheduled account maintenance evidence bucket digest",
  );
  if (!database || typeof database.prepare !== "function" || typeof database.batch !== "function") {
    throw new Error("scheduled account maintenance database binding is unavailable");
  }
  if (!evidence || typeof evidence.put !== "function") {
    throw new Error("scheduled account maintenance evidence binding is unavailable");
  }
  if (database === evidence) throw new Error("scheduled account maintenance bindings must be separate");
  if (mode !== "private-scheduled-only") {
    throw new Error("scheduled account maintenance mode is not private scheduled-only");
  }
  if (typeof sourceCommit !== "string" || !COMMIT.test(sourceCommit)) {
    throw new Error("scheduled account maintenance source commit is invalid");
  }
  if (typeof deploymentVersion !== "string" || !VERSION.test(deploymentVersion)) {
    throw new Error("scheduled account maintenance deployment version is invalid");
  }
  if (sourceDatabaseDigest === evidenceBucketDigest) {
    throw new Error("scheduled account maintenance database and evidence bucket identities must differ");
  }
  return Object.freeze({
    database,
    evidence,
    sourceCommit,
    deploymentVersion,
    sourceDatabaseDigest,
    evidenceBucketDigest,
  });
}

function timestamp(milliseconds, name) {
  const value = safeInteger(milliseconds, name);
  const result = new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${name} is invalid`);
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function toHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  return Object.freeze({ bytes: new Uint8Array(buffer), digest: `0x${toHex(new Uint8Array(buffer))}` });
}

function assertSecretFree(value) {
  const forbiddenKey = /(?:authorization(?!s)|cookie|email|endpoint|invoice|macaroon|mnemonic|password|preimage|private.?key|public.?key|rpc.?url|secret|session.?token|token.?hash|wallet.?address)/i;
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string" && (/(?:https?|wss?):\/\//i.test(entry)
          || /-----BEGIN [A-Z ]*KEY-----/.test(entry)
          || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry))) {
        throw new Error("scheduled account maintenance evidence contains endpoint or account material");
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    const prototype = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null)
        || keys.some((key) => typeof key !== "string")) {
      throw new Error("scheduled account maintenance evidence contains non-data material");
    }
    for (const key of keys) {
      if (forbiddenKey.test(key)) {
        throw new Error(`scheduled account maintenance evidence contains forbidden field ${key}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new Error("scheduled account maintenance evidence contains non-data material");
      }
      visit(descriptor.value);
    }
  };
  visit(value);
}

function snapshotMaintenance(result) {
  const value = exactRecord(
    result,
    ["batchLimit", "deleted", "moreWorkPossible", "observedAt", "schema", "status"],
    "scheduled account maintenance result",
  );
  const deleted = exactRecord(value.deleted, ["nonces", "notifications", "sessions"], "deletion counts");
  if (value.schema !== "treeswap.account-maintenance.v1" || value.status !== "completed"
      || value.batchLimit !== 100 || typeof value.moreWorkPossible !== "boolean") {
    throw new Error("scheduled account maintenance result is outside policy");
  }
  for (const count of Object.values(deleted)) {
    if (!Number.isSafeInteger(count) || count < 0 || count > value.batchLimit) {
      throw new Error("scheduled account maintenance deletion count is invalid");
    }
  }
  const expectedMoreWork = Object.values(deleted).some((count) => count === value.batchLimit);
  if (value.moreWorkPossible !== expectedMoreWork) {
    throw new Error("scheduled account maintenance continuation signal is inconsistent");
  }
  return Object.freeze({
    schema: value.schema,
    status: value.status,
    observedAt: value.observedAt,
    batchLimit: value.batchLimit,
    deleted: Object.freeze({
      nonces: deleted.nonces,
      sessions: deleted.sessions,
      notifications: deleted.notifications,
    }),
    moreWorkPossible: value.moreWorkPossible,
  });
}

async function executeScheduledAccountMaintenance({ controller, env, clock, log }) {
  const schedule = snapshotController(controller);
  const runtime = snapshotEnvironment(env);
  const startedAtMs = safeInteger(clock(), "scheduled account maintenance start time");
  if (startedAtMs < schedule.scheduledTime
      || startedAtMs - schedule.scheduledTime > SCHEDULED_ACCOUNT_MAINTENANCE_MAXIMUM_START_DELAY_MS) {
    throw new Error("scheduled account maintenance start is outside the reviewed delay window");
  }
  const scheduledAt = timestamp(schedule.scheduledTime, "scheduled account maintenance scheduled time");
  let rawMaintenance;
  try {
    rawMaintenance = await purgeExpiredAccountRecords(runtime.database, scheduledAt);
  } catch {
    throw new Error(FAILURE_MESSAGE);
  }
  const maintenance = snapshotMaintenance(rawMaintenance);
  if (maintenance.observedAt !== scheduledAt) {
    throw new Error("scheduled account maintenance cutoff changed during execution");
  }
  const completedAtMs = safeInteger(clock(), "scheduled account maintenance completion time");
  if (completedAtMs < startedAtMs
      || completedAtMs - schedule.scheduledTime > SCHEDULED_ACCOUNT_MAINTENANCE_MAXIMUM_START_DELAY_MS) {
    throw new Error("scheduled account maintenance completion is outside the reviewed delay window");
  }
  const record = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: maintenance.moreWorkPossible ? "completed-backlog-remains" : "completed-drained",
    scope: "bounded-expired-account-record-maintenance-no-account-payment-or-funding-authority",
    sourceCommit: runtime.sourceCommit,
    deploymentVersion: runtime.deploymentVersion,
    sourceDatabaseDigest: runtime.sourceDatabaseDigest,
    evidenceBucketDigest: runtime.evidenceBucketDigest,
    cron: schedule.cron,
    scheduledAt,
    startedAt: timestamp(startedAtMs, "scheduled account maintenance start time"),
    completedAt: timestamp(completedAtMs, "scheduled account maintenance completion time"),
    maintenance,
    authorizations: Object.freeze({
      accountEnablement: false,
      outboundDelivery: false,
      walletDispatch: false,
      lightningDispatch: false,
      settlement: false,
      funding: false,
      releaseActivation: false,
    }),
  });
  assertSecretFree(record);
  const serialized = `${JSON.stringify(canonical(record))}\n`;
  const body = new TextEncoder().encode(serialized);
  const content = await sha256(body);
  const scheduledSecond = Math.floor(schedule.scheduledTime / 1_000);
  const objectKey = `${SCHEDULED_ACCOUNT_MAINTENANCE_EVIDENCE_PREFIX}${scheduledSecond}-${runtime.sourceCommit}-${content.digest.slice(2)}.json`;
  let stored;
  try {
    stored = await runtime.evidence.put(objectKey, serialized, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
      customMetadata: {
        schema: EVIDENCE_SCHEMA,
        sourceCommit: runtime.sourceCommit,
        evidenceDigest: content.digest,
      },
      sha256: content.bytes.buffer,
    });
  } catch {
    throw new Error(FAILURE_MESSAGE);
  }
  if (!stored || stored.key !== objectKey || stored.size !== body.byteLength
      || typeof stored.etag !== "string" || stored.etag.length < 1
      || typeof stored.version !== "string" || stored.version.length < 1) {
    throw new Error(FAILURE_MESSAGE);
  }
  const objectKeyCommitment = await sha256(objectKey);
  const receipt = Object.freeze({
    schema: RECEIPT_SCHEMA,
    status: record.status,
    sourceCommit: record.sourceCommit,
    deploymentVersion: record.deploymentVersion,
    scheduledAt: record.scheduledAt,
    completedAt: record.completedAt,
    deleted: record.maintenance.deleted,
    moreWorkPossible: record.maintenance.moreWorkPossible,
    evidenceDigest: content.digest,
    objectKeyCommitment: objectKeyCommitment.digest,
    retained: true,
    authorizations: record.authorizations,
  });
  assertSecretFree(receipt);
  log(JSON.stringify(receipt));
  if (maintenance.moreWorkPossible) {
    throw new Error("scheduled account maintenance retained evidence but backlog remains");
  }
  return receipt;
}

export async function runScheduledAccountMaintenance(controller, env) {
  return executeScheduledAccountMaintenance({
    controller,
    env,
    clock: () => Date.now(),
    log: (value) => console.info(value),
  });
}

export async function runScheduledAccountMaintenanceTestOnly(rawInput) {
  const input = exactRecord(
    rawInput,
    ["clock", "controller", "env", "log"],
    "scheduled account maintenance test input",
  );
  if (typeof input.clock !== "function" || typeof input.log !== "function") {
    throw new TypeError("scheduled account maintenance test clock and log must be functions");
  }
  return executeScheduledAccountMaintenance(input);
}
