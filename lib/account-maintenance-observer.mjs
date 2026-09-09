import {
  normalizeScheduledAccountStorageObserverRequest,
  serializeScheduledAccountStorageObserverPayload,
} from "./scheduled-account-storage-monitor.mjs";

const PREFIX = "account-maintenance/v1/";
const SCHEMA = "treeswap.scheduled-account-maintenance-evidence.v1";
const MAX_BYTES = 16_384;
const DEADLINE_MS = 10_000;
const AUTHORITY = ["accountEnablement", "outboundDelivery", "walletDispatch", "lightningDispatch",
  "settlement", "funding", "releaseActivation"];
const RECORD_FIELDS = ["schema", "status", "scope", "sourceCommit", "deploymentVersion",
  "sourceDatabaseDigest", "evidenceBucketDigest", "cron", "scheduledAt", "startedAt",
  "completedAt", "maintenance", "authorizations"];

function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("invalid record");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw new Error("invalid fields");
  const snapshot = Object.create(null);
  for (const field of fields) {
    const entry = Object.getOwnPropertyDescriptor(value, field);
    if (!entry || !Object.hasOwn(entry, "value") || !entry.enumerable) throw new Error("invalid data");
    snapshot[field] = entry.value;
  }
  return Object.freeze(snapshot);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hash(bytes) {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256",
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes));
  return `0x${Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function b64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value, length) {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid key");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  if (bytes.length !== length || b64(bytes) !== value) throw new Error("invalid key encoding");
  return bytes;
}

function checked(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("invalid configuration");
  return value;
}

function digest(value) {
  checked(value, /^0x[0-9a-f]{64}$/);
  if (value === `0x${"0".repeat(64)}`) throw new Error("empty commitment");
  return value;
}

function configuration(env) {
  if (env?.ACCOUNT_MAINTENANCE_OBSERVER_MODE !== "private-service-binding-only") throw new Error("invalid mode");
  const bucket = env.ACCOUNT_MAINTENANCE_EVIDENCE;
  if (!bucket || typeof bucket.list !== "function" || typeof bucket.get !== "function") throw new Error("missing evidence");
  const result = {
    bucket,
    monitorSource: checked(env.ACCOUNT_MONITOR_SOURCE_COMMIT, /^[0-9a-f]{40}$/),
    monitorVersion: checked(env.ACCOUNT_MONITOR_DEPLOYMENT_VERSION, /^[1-9][0-9]*$/),
    source: checked(env.ACCOUNT_MAINTENANCE_SOURCE_COMMIT, /^[0-9a-f]{40}$/),
    version: checked(env.ACCOUNT_MAINTENANCE_DEPLOYMENT_VERSION, /^[1-9][0-9]*$/),
    database: digest(env.ACCOUNT_MAINTENANCE_SOURCE_DATABASE_DIGEST),
    evidenceBucket: digest(env.ACCOUNT_MAINTENANCE_EVIDENCE_BUCKET_DIGEST),
    publicBytes: decode(env.ACCOUNT_MAINTENANCE_OBSERVER_PUBLIC_KEY, 32),
    privateBytes: decode(env.ACCOUNT_MAINTENANCE_OBSERVER_PRIVATE_KEY, 48),
  };
  if (result.database === result.evidenceBucket) throw new Error("reused commitment");
  return Object.freeze(result);
}

function cancel(stream) {
  try { void Promise.resolve(stream?.cancel?.()).catch(() => {}); } catch {}
}

async function boundedBody(stream, size, signal) {
  if (!stream || typeof stream.getReader !== "function") throw new Error("missing body");
  const reader = stream.getReader();
  const abort = () => cancel(reader);
  signal.addEventListener("abort", abort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("expired read");
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new Error("invalid body");
      total += part.value.length;
      if (total > MAX_BYTES) throw new Error("oversized body");
      chunks.push(part.value);
    }
    if (size !== null && total !== size) throw new Error("changed size");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    abort();
    throw new Error("invalid body");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function timestamp(value) {
  if (typeof value !== "string") throw new Error("invalid time");
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms < 1 || new Date(ms).toISOString() !== value) throw new Error("invalid time");
  return ms;
}

function verifyRecord(raw, config, slot, now) {
  const value = exact(raw, RECORD_FIELDS);
  const maintenance = exact(value.maintenance, ["schema", "status", "observedAt", "batchLimit", "deleted", "moreWorkPossible"]);
  const counts = exact(maintenance.deleted, ["nonces", "sessions", "notifications"]);
  const authorizations = exact(value.authorizations, AUTHORITY);
  if (value.schema !== SCHEMA || value.status !== "completed-drained"
      || value.scope !== "bounded-expired-account-record-maintenance-no-account-payment-or-funding-authority"
      || value.sourceCommit !== config.source || value.deploymentVersion !== config.version
      || value.sourceDatabaseDigest !== config.database || value.evidenceBucketDigest !== config.evidenceBucket
      || value.cron !== "*/15 * * * *" || timestamp(value.scheduledAt) !== slot * 1000
      || maintenance.schema !== "treeswap.account-maintenance.v1" || maintenance.status !== "completed"
      || maintenance.observedAt !== value.scheduledAt || maintenance.batchLimit !== 100
      || maintenance.moreWorkPossible !== false
      || Object.values(counts).some((n) => !Number.isSafeInteger(n) || n < 0 || n >= 100)
      || Object.values(authorizations).some((flag) => flag !== false)) throw new Error("unsafe evidence");
  const started = timestamp(value.startedAt);
  const completed = timestamp(value.completedAt);
  if (started < slot * 1000 || completed < started || completed > (slot + 600) * 1000
      || completed > now || now - completed > 1800_000) throw new Error("stale evidence");
  return Math.floor(completed / 1000);
}

async function retainedObservation(config, now, signal) {
  let slot = Math.floor(now / 900_000) * 900;
  let listing;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prefix = `${PREFIX}${slot}-${config.source}-`;
    listing = await config.bucket.list({ prefix, limit: 2 });
    if (!listing || listing.truncated !== false || !Array.isArray(listing.objects)
        || listing.objects.length > 1) throw new Error("ambiguous evidence");
    if (listing.objects.length === 1) break;
    // Only the current slot's ten-minute execution window can use the preceding slot.
    if (attempt !== 0 || now >= (slot + 600) * 1000) throw new Error("missing due evidence");
    slot -= 900;
  }
  const key = listing.objects[0]?.key;
  const prefix = `${PREFIX}${slot}-${config.source}-`;
  if (typeof key !== "string" || !key.startsWith(prefix)
      || !/^[0-9a-f]{64}\.json$/.test(key.slice(prefix.length))) throw new Error("invalid evidence key");
  const object = await config.bucket.get(key);
  if (!object || object.key !== key || !Number.isSafeInteger(object.size)
      || object.size < 1 || object.size > MAX_BYTES
      || object.httpMetadata?.contentType !== "application/json"
      || object.httpMetadata?.cacheControl !== "no-store"
      || object.httpMetadata?.contentEncoding) throw new Error("invalid stored object");
  const metadata = exact(object.customMetadata, ["schema", "sourceCommit", "evidenceDigest"]);
  const text = await boundedBody(object.body, object.size, signal);
  const evidenceDigest = await hash(text);
  if (metadata.schema !== SCHEMA || metadata.sourceCommit !== config.source
      || metadata.evidenceDigest !== evidenceDigest
      || key !== `${prefix}${evidenceDigest.slice(2)}.json`) throw new Error("evidence checksum mismatch");
  const record = JSON.parse(text);
  // Canonical bytes reject duplicate JSON fields and alternate encodings.
  if (`${canonical(record)}\n` !== text) throw new Error("noncanonical evidence");
  const lastCompletedAt = verifyRecord(record, config, slot, now);
  return { lastCompletedAt, evidenceDigest };
}

async function execute(request, env, clock, signal) {
  const config = configuration(env);
  let previous = 0;
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 1 || value < previous || signal.aborted) throw new Error("invalid clock");
    previous = value;
    return value;
  };
  const started = now();
  if (!(request instanceof Request) || request.method !== "POST"
      || request.url !== "https://account-maintenance-observer.internal/v1/observe"
      || request.headers.get("content-type") !== "application/json"
      || request.headers.get("cache-control") !== "no-store"
      || request.headers.has("content-encoding") || request.headers.has("cookie")
      || request.headers.has("authorization")) throw new Error("invalid request");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^[1-9][0-9]*$/.test(length) || Number(length) > MAX_BYTES)) throw new Error("invalid length");
  const raw = JSON.parse(await boundedBody(request.body, length === null ? null : Number(length), signal));
  const input = normalizeScheduledAccountStorageObserverRequest(raw);
  if (input.kind !== "maintenance" || input.sourceCommit !== config.monitorSource
      || input.deploymentVersion !== config.monitorVersion || input.databaseDigest !== config.database
      || input.requestedAt > Math.floor(started / 1000) || started >= input.expiresAt * 1000
      || started - input.requestedAt * 1000 > 5000) throw new Error("unbound request");
  const observation = await retainedObservation(config, now(), signal);
  const privateKey = await crypto.subtle.importKey("pkcs8", config.privateBytes, { name: "Ed25519" }, false, ["sign"]);
  const publicKey = await crypto.subtle.importKey("raw", config.publicBytes, { name: "Ed25519" }, false, ["verify"]);
  const payload = {
    schema: "treeswap.account-storage-maintenance-observer-response.v1",
    kind: "maintenance", requestDigest: await hash(canonical(input)),
    signerKeyId: await hash(config.publicBytes), observedAt: Math.floor(now() / 1000),
    validUntil: input.expiresAt, ...observation, status: "completed", moreWorkPossible: false,
  };
  const bytes = serializeScheduledAccountStorageObserverPayload(payload);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, bytes));
  if (!await crypto.subtle.verify("Ed25519", publicKey, signature, bytes)
      || now() >= input.expiresAt * 1000) throw new Error("invalid signing state");
  return new Response(`${canonical({ ...payload, signature: b64(signature) })}\n`, {
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

async function handle(request, env, clock) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      execute(request, env, clock, controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("observer timeout")); }, DEADLINE_MS);
      }),
    ]);
  } catch {
    return new Response(null, { status: 503, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function handleAccountMaintenanceObservation(request, env) {
  return handle(request, env, () => Date.now());
}

export function handleAccountMaintenanceObservationForTests(input) {
  const { request, env, clock } = exact(input, ["request", "env", "clock"]);
  if (typeof clock !== "function") throw new Error("invalid test clock");
  return handle(request, env, clock);
}
