import {
  buildAccountStorageAccessObservation,
  buildAccountStorageMaintenanceObservation,
  collectAccountStorageDatabaseObservation,
  runAccountStorageMonitorCycle,
  runAccountStorageMonitorCycleForTests,
} from "./account-storage-monitor.mjs";

export const SCHEDULED_ACCOUNT_STORAGE_MONITOR_CRON = "* * * * *";
export const SCHEDULED_ACCOUNT_STORAGE_MONITOR_EVIDENCE_PREFIX = "account-storage-monitor/v1/";

const OBSERVATION_REQUEST_SCHEMA = "treeswap.account-storage-observation-request.v1";
const ACCESS_RESPONSE_SCHEMA = "treeswap.account-storage-access-observer-response.v1";
const MAINTENANCE_RESPONSE_SCHEMA = "treeswap.account-storage-maintenance-observer-response.v1";
const EVIDENCE_SCHEMA = "treeswap.scheduled-account-storage-monitor-evidence.v1";
const RECEIPT_SCHEMA = "treeswap.scheduled-account-storage-monitor-receipt.v1";
const FAILURE_MESSAGE = "scheduled account storage monitor failed closed";
const MAXIMUM_START_DELAY_MS = 60_000;
const MAXIMUM_COMPLETION_DELAY_MS = 2 * 60_000;
const OBSERVER_REQUEST_LIFETIME_SECONDS = 30;
const OBSERVER_TIMEOUT_MS = 15_000;
const MAXIMUM_RESPONSE_BYTES = 16_384;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^[1-9][0-9]*$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;

const REQUEST_FIELDS = Object.freeze([
  "databaseDigest",
  "deploymentVersion",
  "expiresAt",
  "kind",
  "requestId",
  "requestedAt",
  "schema",
  "sourceCommit",
]);
const ACCESS_SIGNED_FIELDS = Object.freeze([
  "auditCoverageComplete",
  "evidenceDigest",
  "kind",
  "observedAt",
  "observedFrom",
  "privilegeChangeEvents",
  "requestDigest",
  "schema",
  "signerKeyId",
  "unauthorizedReadAttempts",
  "unauthorizedWriteAttempts",
  "validUntil",
]);
const MAINTENANCE_SIGNED_FIELDS = Object.freeze([
  "evidenceDigest",
  "kind",
  "lastCompletedAt",
  "moreWorkPossible",
  "observedAt",
  "requestDigest",
  "schema",
  "signerKeyId",
  "status",
  "validUntil",
]);
const TEST_INPUT_FIELDS = Object.freeze([
  "clock",
  "collectDatabase",
  "controller",
  "env",
  "log",
  "randomBytes",
]);

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

function digest(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value) || value === ZERO_DIGEST) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return value;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("scheduled monitor value contains an unsafe number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("scheduled monitor value contains a non-plain object");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("scheduled monitor value contains symbols");
    }
    return `{${keys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new TypeError("scheduled monitor value contains non-data fields");
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value)}`;
    }).join(",")}}`;
  }
  throw new TypeError("scheduled monitor value contains unsupported data");
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({ bytes: result, digest: `0x${bytesToHex(result)}` });
}

function decodeBase64Url(value, bytes, name) {
  const pattern = bytes === 32 ? BASE64URL_32 : BASE64URL_64;
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${name} is invalid`);
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
  let decoded;
  try {
    const binary = atob(padded);
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  if (decoded.byteLength !== bytes) throw new TypeError(`${name} is invalid`);
  return decoded;
}

function requestId(value) {
  return digest(value, "scheduled monitor observer request ID");
}

function snapshotController(controller) {
  if (!controller || typeof controller !== "object") throw new TypeError("scheduled monitor controller is unavailable");
  const cron = controller.cron;
  const scheduledTime = integer(controller.scheduledTime, "scheduled monitor time", 1);
  if (cron !== SCHEDULED_ACCOUNT_STORAGE_MONITOR_CRON) {
    throw new Error("scheduled monitor cron is not the reviewed cadence");
  }
  if (scheduledTime % 60_000 !== 0) throw new Error("scheduled monitor time is not minute-aligned");
  return Object.freeze({ cron, scheduledTime });
}

function binding(value, method, name) {
  if (!value || typeof value[method] !== "function") throw new Error(`${name} binding is unavailable`);
  return value;
}

async function observerKey(value, name) {
  const raw = decodeBase64Url(value, 32, `${name} public key`);
  let key;
  try {
    key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new TypeError(`${name} public key is invalid`);
  }
  const keyId = (await sha256(raw)).digest;
  return Object.freeze({ raw, key, keyId });
}

async function snapshotEnvironment(env) {
  if (!env || typeof env !== "object") throw new TypeError("scheduled monitor environment is unavailable");
  const database = binding(env.DB, "prepare", "scheduled monitor database");
  if (typeof database.batch !== "function") throw new Error("scheduled monitor database binding is unavailable");
  const accessObserver = binding(env.ACCOUNT_ACCESS_OBSERVER, "fetch", "access observer");
  const maintenanceObserver = binding(env.ACCOUNT_MAINTENANCE_OBSERVER, "fetch", "maintenance observer");
  const primaryAlert = binding(env.ACCOUNT_ALERT_PRIMARY, "fetch", "primary alert");
  const secondaryAlert = binding(env.ACCOUNT_ALERT_SECONDARY, "fetch", "secondary alert");
  const evidence = binding(env.ACCOUNT_MONITOR_EVIDENCE, "put", "monitor evidence");
  const bindings = [database, accessObserver, maintenanceObserver, primaryAlert, secondaryAlert, evidence];
  if (new Set(bindings).size !== bindings.length) {
    throw new Error("scheduled monitor bindings must be pairwise separate");
  }
  if (env.ACCOUNT_MONITOR_MODE !== "private-scheduled-monitor-only") {
    throw new Error("scheduled monitor mode is not private scheduled-monitor-only");
  }
  const sourceCommit = env.ACCOUNT_MONITOR_SOURCE_COMMIT;
  if (typeof sourceCommit !== "string" || !COMMIT.test(sourceCommit)) {
    throw new Error("scheduled monitor source commit is invalid");
  }
  const deploymentVersion = env.ACCOUNT_MONITOR_DEPLOYMENT_VERSION;
  if (typeof deploymentVersion !== "string" || !VERSION.test(deploymentVersion)) {
    throw new Error("scheduled monitor deployment version is invalid");
  }
  const databaseDigest = digest(env.ACCOUNT_MONITOR_DATABASE_DIGEST, "scheduled monitor database digest");
  const evidenceBucketDigest = digest(
    env.ACCOUNT_MONITOR_EVIDENCE_BUCKET_DIGEST,
    "scheduled monitor evidence bucket digest",
  );
  const primaryAlertRouteDigest = digest(
    env.ACCOUNT_ALERT_PRIMARY_ROUTE_DIGEST,
    "primary alert route digest",
  );
  const secondaryAlertRouteDigest = digest(
    env.ACCOUNT_ALERT_SECONDARY_ROUTE_DIGEST,
    "secondary alert route digest",
  );
  const [accessKey, maintenanceKey] = await Promise.all([
    observerKey(env.ACCOUNT_ACCESS_OBSERVER_PUBLIC_KEY, "access observer"),
    observerKey(env.ACCOUNT_MAINTENANCE_OBSERVER_PUBLIC_KEY, "maintenance observer"),
  ]);
  const commitments = [
    databaseDigest,
    evidenceBucketDigest,
    primaryAlertRouteDigest,
    secondaryAlertRouteDigest,
    accessKey.keyId,
    maintenanceKey.keyId,
  ];
  if (new Set(commitments).size !== commitments.length) {
    throw new Error("scheduled monitor database, evidence, observer, and alert commitments must be distinct");
  }
  return Object.freeze({
    database,
    accessObserver,
    maintenanceObserver,
    primaryAlert,
    secondaryAlert,
    evidence,
    sourceCommit,
    deploymentVersion,
    databaseDigest,
    evidenceBucketDigest,
    primaryAlertRouteDigest,
    secondaryAlertRouteDigest,
    accessKey,
    maintenanceKey,
  });
}

function normalizeRequest(raw) {
  const value = exactRecord(raw, REQUEST_FIELDS, "scheduled monitor observer request");
  if (value.schema !== OBSERVATION_REQUEST_SCHEMA || !["access", "maintenance"].includes(value.kind)) {
    throw new Error("scheduled monitor observer request identity is invalid");
  }
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)) {
    throw new Error("scheduled monitor observer request source commit is invalid");
  }
  if (typeof value.deploymentVersion !== "string" || !VERSION.test(value.deploymentVersion)) {
    throw new Error("scheduled monitor observer request deployment version is invalid");
  }
  const requestedAt = integer(value.requestedAt, "scheduled monitor observer request time", 1);
  const expiresAt = integer(value.expiresAt, "scheduled monitor observer request expiry", 1);
  if (expiresAt !== requestedAt + OBSERVER_REQUEST_LIFETIME_SECONDS) {
    throw new Error("scheduled monitor observer request lifetime is invalid");
  }
  return Object.freeze({
    schema: value.schema,
    kind: value.kind,
    sourceCommit: value.sourceCommit,
    deploymentVersion: value.deploymentVersion,
    databaseDigest: digest(value.databaseDigest, "scheduled monitor observer database digest"),
    requestId: requestId(value.requestId),
    requestedAt,
    expiresAt,
  });
}

async function buildObserverRequest({ runtime, kind, requestedAt, randomBytes }) {
  const random = randomBytes(32);
  if (!(random instanceof Uint8Array) || random.byteLength !== 32) {
    throw new TypeError("scheduled monitor random source is invalid");
  }
  const request = normalizeRequest({
    schema: OBSERVATION_REQUEST_SCHEMA,
    kind,
    sourceCommit: runtime.sourceCommit,
    deploymentVersion: runtime.deploymentVersion,
    databaseDigest: runtime.databaseDigest,
    requestId: `0x${bytesToHex(random)}`,
    requestedAt,
    expiresAt: requestedAt + OBSERVER_REQUEST_LIFETIME_SECONDS,
  });
  return Object.freeze({ request, requestDigest: (await sha256(canonicalize(request))).digest });
}

function normalizeSignedPayload(raw, kind) {
  const fields = kind === "access" ? ACCESS_SIGNED_FIELDS : MAINTENANCE_SIGNED_FIELDS;
  const value = exactRecord(raw, fields, `scheduled monitor ${kind} signed payload`);
  const expectedSchema = kind === "access" ? ACCESS_RESPONSE_SCHEMA : MAINTENANCE_RESPONSE_SCHEMA;
  if (value.schema !== expectedSchema || value.kind !== kind) {
    throw new Error(`scheduled monitor ${kind} response identity is invalid`);
  }
  const common = {
    schema: value.schema,
    kind: value.kind,
    requestDigest: digest(value.requestDigest, `${kind} observer request digest`),
    signerKeyId: digest(value.signerKeyId, `${kind} observer signer key ID`),
    observedAt: integer(value.observedAt, `${kind} observer observation time`, 1),
    validUntil: integer(value.validUntil, `${kind} observer validity`, 1),
    evidenceDigest: digest(value.evidenceDigest, `${kind} observer evidence digest`),
  };
  if (kind === "access") {
    return Object.freeze({
      ...common,
      observedFrom: integer(value.observedFrom, "access observer window start", 1),
      auditCoverageComplete: value.auditCoverageComplete === true,
      unauthorizedReadAttempts: integer(value.unauthorizedReadAttempts, "access unauthorized reads"),
      unauthorizedWriteAttempts: integer(value.unauthorizedWriteAttempts, "access unauthorized writes"),
      privilegeChangeEvents: integer(value.privilegeChangeEvents, "access privilege changes"),
    });
  }
  if (!["completed", "failed"].includes(value.status) || typeof value.moreWorkPossible !== "boolean") {
    throw new Error("scheduled monitor maintenance response state is invalid");
  }
  return Object.freeze({
    ...common,
    lastCompletedAt: integer(value.lastCompletedAt, "maintenance observer completion time", 1),
    status: value.status,
    moreWorkPossible: value.moreWorkPossible,
  });
}

export function serializeScheduledAccountStorageObserverPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("scheduled monitor observer payload must be an object");
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(raw, "kind");
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, "value") || kindDescriptor.enumerable !== true) {
    throw new TypeError("scheduled monitor observer payload kind must be a data property");
  }
  const payload = normalizeSignedPayload(raw, kindDescriptor.value);
  return new TextEncoder().encode(canonicalize(payload));
}

async function readBoundedJsonResponse(response, label, signal) {
  if (!response || response.status !== 200) throw new Error(`${label} response is unavailable`);
  const type = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(type.trim())) {
    throw new Error(`${label} response framing is invalid`);
  }
  const cache = String(response.headers?.get?.("cache-control") ?? "").toLowerCase();
  if (!cache.split(",").some((entry) => entry.trim() === "no-store")
      || response.headers?.get?.("set-cookie") !== null
      || ![null, "identity"].includes(response.headers?.get?.("content-encoding"))) {
    throw new Error(`${label} response framing is invalid`);
  }
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared)
      || BigInt(declared) > BigInt(MAXIMUM_RESPONSE_BYTES))) {
    throw new Error(`${label} response framing is invalid`);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error(`${label} response body is unavailable`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error(`${label} response timed out`);
      const frame = await reader.read();
      if (frame.done) break;
      if (!(frame.value instanceof Uint8Array)) throw new Error(`${label} response framing is invalid`);
      received += frame.value.byteLength;
      if (received > MAXIMUM_RESPONSE_BYTES) throw new Error(`${label} response is too large`);
      chunks.push(frame.value);
    }
  } catch {
    try { await reader.cancel(); } catch {}
    throw new Error(`${label} response is invalid`);
  }
  if (declared !== null && received !== Number(declared)) throw new Error(`${label} response length changed`);
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw new Error(`${label} response is invalid`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`${label} response is invalid`); }
}

async function collectSignedObservation({ service, key, request, requestDigest, nowSeconds }) {
  const controller = new AbortController();
  let timeoutReject;
  const timeout = new Promise((_, reject) => { timeoutReject = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    timeoutReject(new Error(`${request.kind} observer timed out`));
  }, OBSERVER_TIMEOUT_MS);
  let response;
  try {
    response = await Promise.race([
      service.fetch(new Request(`https://account-${request.kind}-observer.internal/v1/observe`, {
        method: "POST",
        headers: new Headers({
          "cache-control": "no-store",
          "content-type": "application/json",
        }),
        body: `${canonicalize(request)}\n`,
        redirect: "error",
        signal: controller.signal,
      })),
      timeout,
    ]);
    const raw = await Promise.race([
      readBoundedJsonResponse(response, `${request.kind} observer`, controller.signal),
      timeout,
    ]);
    const responseFields = request.kind === "access" ? ACCESS_SIGNED_FIELDS : MAINTENANCE_SIGNED_FIELDS;
    const envelope = exactRecord(
      raw,
      [...responseFields, "signature"],
      `scheduled monitor ${request.kind} response`,
    );
    const payload = normalizeSignedPayload(
      Object.fromEntries(responseFields.map((field) => [field, envelope[field]])),
      request.kind,
    );
    const now = integer(nowSeconds(), `${request.kind} observer response time`, 1);
    if (payload.requestDigest !== requestDigest || payload.signerKeyId !== key.keyId
        || payload.validUntil !== request.expiresAt || now > payload.validUntil
        || payload.observedAt > now || payload.observedAt < request.requestedAt - 60) {
      throw new Error(`${request.kind} observer response binding is invalid`);
    }
    const signature = decodeBase64Url(envelope.signature, 64, `${request.kind} observer signature`);
    const verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      key.key,
      signature,
      new TextEncoder().encode(canonicalize(payload)),
    );
    if (!verified) throw new Error(`${request.kind} observer signature is invalid`);
    if (request.kind === "access") {
      return buildAccountStorageAccessObservation({
        auditCoverageComplete: payload.auditCoverageComplete,
        evidenceDigest: payload.evidenceDigest,
        observedAt: payload.observedAt,
        observedFrom: payload.observedFrom,
        privilegeChangeEvents: payload.privilegeChangeEvents,
        unauthorizedReadAttempts: payload.unauthorizedReadAttempts,
        unauthorizedWriteAttempts: payload.unauthorizedWriteAttempts,
      });
    }
    return buildAccountStorageMaintenanceObservation({
      evidenceDigest: payload.evidenceDigest,
      lastCompletedAt: payload.lastCompletedAt,
      moreWorkPossible: payload.moreWorkPossible,
      observedAt: payload.observedAt,
      status: payload.status,
    });
  } catch {
    try { await response?.body?.cancel?.(); } catch {}
    throw new Error(`${request.kind} observer failed closed`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function alertRequestDigest(alert, routeDigest) {
  return (await sha256(canonicalize({
    schema: "treeswap.scheduled-account-storage-alert-request.v1",
    routeDigest,
    alert,
  }))).digest;
}

async function deliverAlert(service, routeDigest, alert, { signal }) {
  let response;
  try {
    const requestDigestValue = await alertRequestDigest(alert, routeDigest);
    response = await service.fetch(new Request("https://account-alert.internal/v1/notify", {
      method: "POST",
      headers: new Headers({
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-treeswap-alert-request-digest": requestDigestValue,
        "x-treeswap-alert-route-digest": routeDigest,
      }),
      body: `${canonicalize({
        schema: "treeswap.scheduled-account-storage-alert-request.v1",
        routeDigest,
        alert,
      })}\n`,
      redirect: "error",
      signal,
    }));
    const acknowledged = response?.status === 204
      && response.headers?.get?.("cache-control")?.toLowerCase().split(",")
        .some((entry) => entry.trim() === "no-store")
      && response.headers?.get?.("x-treeswap-alert-request-digest") === requestDigestValue
      && response.headers?.get?.("x-treeswap-alert-route-digest") === routeDigest
      && response.headers?.get?.("set-cookie") === null
      && response.headers?.get?.("content-encoding") === null
      && [null, "0"].includes(response.headers?.get?.("content-length"))
      && response.body === null;
    return Object.freeze({ delivered: acknowledged });
  } catch {
    try { await response?.body?.cancel?.(); } catch {}
    return Object.freeze({ delivered: false });
  }
}

function assertSecretFree(value) {
  const forbiddenKey = /(?:authorization(?!s)|cookie|email|endpoint|invoice|macaroon|mnemonic|password|preimage|private.?key|rpc.?url|secret|session.?token|token.?hash|wallet.?address)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string" && (/(?:https?|wss?):\/\//i.test(entry)
          || /-----BEGIN [A-Z ]*KEY-----/.test(entry)
          || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry))) {
        throw new Error("scheduled monitor evidence contains endpoint or account material");
      }
      return;
    }
    const prototype = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null)
        || keys.some((key) => typeof key !== "string")) {
      throw new Error("scheduled monitor evidence contains non-data material");
    }
    for (const key of keys) {
      if (forbiddenKey.test(key)) throw new Error(`scheduled monitor evidence contains forbidden field ${key}`);
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new Error("scheduled monitor evidence contains non-data material");
      }
      visit(descriptor.value);
    }
  };
  visit(value);
}

function timestamp(milliseconds, name) {
  const value = integer(milliseconds, name, 1);
  const result = new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${name} is invalid`);
  return result;
}

async function retainEvidence(runtime, schedule, startedAtMs, completedAtMs, cycle) {
  const record = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: cycle.outcome === "HEALTHY" ? "healthy" : "unsafe",
    scope: "aggregate-account-storage-monitoring-no-account-payment-deployment-or-funding-authority",
    sourceCommit: runtime.sourceCommit,
    deploymentVersion: runtime.deploymentVersion,
    databaseDigest: runtime.databaseDigest,
    evidenceBucketDigest: runtime.evidenceBucketDigest,
    accessObserverKeyId: runtime.accessKey.keyId,
    maintenanceObserverKeyId: runtime.maintenanceKey.keyId,
    primaryAlertRouteDigest: runtime.primaryAlertRouteDigest,
    secondaryAlertRouteDigest: runtime.secondaryAlertRouteDigest,
    cron: schedule.cron,
    scheduledAt: timestamp(schedule.scheduledTime, "scheduled monitor scheduled time"),
    startedAt: timestamp(startedAtMs, "scheduled monitor start time"),
    completedAt: timestamp(completedAtMs, "scheduled monitor completion time"),
    observedAt: cycle.observedAt,
    policyDigest: cycle.policyDigest,
    evidenceDigest: cycle.evidenceDigest,
    reasonCodes: cycle.reasonCodes,
    outcome: cycle.outcome,
    alertRoutesAttempted: cycle.alertRoutesAttempted,
    alertRoutesDelivered: cycle.alertRoutesDelivered,
    alertDeliveryDegraded: cycle.alertDeliveryDegraded,
    authorizations: Object.freeze({
      accountEnablement: false,
      accountDisable: false,
      outboundDelivery: false,
      walletDispatch: false,
      lightningDispatch: false,
      settlement: false,
      funding: false,
      releaseActivation: false,
    }),
  });
  assertSecretFree(record);
  const serialized = `${canonicalize(record)}\n`;
  const body = new TextEncoder().encode(serialized);
  const content = await sha256(body);
  const scheduledSecond = Math.floor(schedule.scheduledTime / 1_000);
  const objectKey = `${SCHEDULED_ACCOUNT_STORAGE_MONITOR_EVIDENCE_PREFIX}${scheduledSecond}-${runtime.sourceCommit}.json`;
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
    throw new Error("monitor evidence retention failed");
  }
  if (!stored || stored.key !== objectKey || stored.size !== body.byteLength
      || typeof stored.etag !== "string" || stored.etag.length < 1
      || typeof stored.version !== "string" || stored.version.length < 1) {
    throw new Error("monitor evidence retention failed");
  }
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    status: record.status,
    sourceCommit: record.sourceCommit,
    deploymentVersion: record.deploymentVersion,
    scheduledAt: record.scheduledAt,
    completedAt: record.completedAt,
    policyDigest: record.policyDigest,
    evidenceDigest: record.evidenceDigest,
    retainedRecordDigest: content.digest,
    outcome: record.outcome,
    alertRoutesAttempted: record.alertRoutesAttempted,
    alertRoutesDelivered: record.alertRoutesDelivered,
    alertDeliveryDegraded: record.alertDeliveryDegraded,
    retained: true,
    authorizations: record.authorizations,
  });
}

async function executeScheduledMonitor({ controller, env, clock, randomBytes, collectDatabase, runCycle, log }) {
  const schedule = snapshotController(controller);
  const runtime = await snapshotEnvironment(env);
  const startedAtMs = integer(clock(), "scheduled monitor start time", 1);
  if (startedAtMs < schedule.scheduledTime
      || startedAtMs - schedule.scheduledTime > MAXIMUM_START_DELAY_MS) {
    throw new Error("scheduled monitor start is outside the reviewed delay window");
  }
  const requestedAt = Math.floor(startedAtMs / 1_000);
  const [accessRequest, maintenanceRequest] = await Promise.all([
    buildObserverRequest({ runtime, kind: "access", requestedAt, randomBytes }),
    buildObserverRequest({ runtime, kind: "maintenance", requestedAt, randomBytes }),
  ]);
  if (accessRequest.request.requestId === maintenanceRequest.request.requestId) {
    throw new Error("scheduled monitor observer challenges must be distinct");
  }
  const [databaseResult, accessResult, maintenanceResult] = await Promise.allSettled([
    collectDatabase(runtime.database),
    collectSignedObservation({
      service: runtime.accessObserver,
      key: runtime.accessKey,
      request: accessRequest.request,
      requestDigest: accessRequest.requestDigest,
      nowSeconds: () => Math.floor(clock() / 1_000),
    }),
    collectSignedObservation({
      service: runtime.maintenanceObserver,
      key: runtime.maintenanceKey,
      request: maintenanceRequest.request,
      requestDigest: maintenanceRequest.requestDigest,
      nowSeconds: () => Math.floor(clock() / 1_000),
    }),
  ]);
  const alertRoutes = Object.freeze([
    (alert, context) => deliverAlert(
      runtime.primaryAlert,
      runtime.primaryAlertRouteDigest,
      alert,
      context,
    ),
    (alert, context) => deliverAlert(
      runtime.secondaryAlert,
      runtime.secondaryAlertRouteDigest,
      alert,
      context,
    ),
  ]);
  const cycle = await runCycle({
    accessObservation: accessResult.status === "fulfilled" ? accessResult.value : null,
    alertRoutes,
    databaseObservation: databaseResult.status === "fulfilled" ? databaseResult.value : null,
    maintenanceObservation: maintenanceResult.status === "fulfilled" ? maintenanceResult.value : null,
  });
  const completedAtMs = integer(clock(), "scheduled monitor completion time", 1);
  if (completedAtMs < startedAtMs
      || completedAtMs - schedule.scheduledTime > MAXIMUM_COMPLETION_DELAY_MS) {
    throw new Error("scheduled monitor completion is outside the reviewed delay window");
  }
  let receipt;
  try {
    receipt = await retainEvidence(runtime, schedule, startedAtMs, completedAtMs, cycle);
  } catch {
    const retentionAlert = Object.freeze({
      schema: "treeswap.account-storage-monitor-alert.v1",
      triggeredAt: Math.floor(completedAtMs / 1_000),
      reasonCodes: Object.freeze(["MONITOR_EVIDENCE_RETENTION_FAILED"]),
      policyDigest: cycle.policyDigest,
      evidenceDigest: cycle.evidenceDigest,
    });
    await Promise.all(alertRoutes.map(async (route) => {
      const controller = new AbortController();
      let resolveTimeout;
      const timeout = new Promise((resolve) => { resolveTimeout = resolve; });
      const timer = setTimeout(() => {
        controller.abort();
        resolveTimeout(null);
      }, OBSERVER_TIMEOUT_MS);
      try {
        await Promise.race([
          route(retentionAlert, Object.freeze({ signal: controller.signal })),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }));
    throw new Error(FAILURE_MESSAGE);
  }
  assertSecretFree(receipt);
  log(JSON.stringify(receipt));
  if (cycle.outcome !== "HEALTHY" || cycle.alertDeliveryDegraded) {
    throw new Error(FAILURE_MESSAGE);
  }
  return receipt;
}

export async function runScheduledAccountStorageMonitor(controller, env) {
  return executeScheduledMonitor({
    controller,
    env,
    clock: () => Date.now(),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    collectDatabase: (database) => collectAccountStorageDatabaseObservation({ binding: database }),
    runCycle: (input) => runAccountStorageMonitorCycle(input),
    log: (value) => console.info(value),
  });
}

export async function runScheduledAccountStorageMonitorTestOnly(rawInput) {
  const input = exactRecord(rawInput, TEST_INPUT_FIELDS, "scheduled monitor test input");
  if (typeof input.clock !== "function" || typeof input.randomBytes !== "function"
      || typeof input.collectDatabase !== "function" || typeof input.log !== "function") {
    throw new TypeError("scheduled monitor test dependencies must be functions");
  }
  return executeScheduledMonitor({
    ...input,
    runCycle: (cycleInput) => runAccountStorageMonitorCycleForTests({
      ...cycleInput,
      nowSeconds: () => Math.floor(input.clock() / 1_000),
      alertTimeoutMilliseconds: 100,
    }),
  });
}
