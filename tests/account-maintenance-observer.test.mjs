import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { handleAccountMaintenanceObservationForTests } from "../lib/account-maintenance-observer.mjs";
import { runScheduledAccountMaintenanceTestOnly } from "../lib/scheduled-account-maintenance.mjs";
import { serializeScheduledAccountStorageObserverPayload } from "../lib/scheduled-account-storage-monitor.mjs";

const SLOT = Date.parse("2026-09-09T12:00:00.000Z");
const SOURCE = "b".repeat(40);
const MONITOR_SOURCE = "a".repeat(40);
const KEYS = generateKeyPairSync("ed25519");
const hash = (value) => `0x${createHash("sha256").update(value).digest("hex")}`;
const canonical = (value) => value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

async function fixture({ scheduledTime = SLOT, now = SLOT + 60_000, count = 1 } = {}) {
  const objects = new Map();
  const reads = [];
  const bucket = {
    async put(key, body, options) {
      const stored = { key, text: body, size: Buffer.byteLength(body), ...options,
        etag: "retained", version: "version" };
      objects.set(key, stored);
      return stored;
    },
    async list({ prefix, limit }) {
      const selected = [...objects.values()].filter((object) => object.key.startsWith(prefix));
      return { objects: selected.slice(0, limit), truncated: selected.length > limit };
    },
    async get(key) {
      reads.push(key);
      const object = objects.get(key);
      return object ? { ...object, body: new Response(object.text).body } : null;
    },
  };
  let clockCalls = 0;
  const maintenanceEnv = {
    DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => Array.from({ length: 3 }, () => ({
      success: true, results: Array.from({ length: count }, () => ({ nonce: "private-never-exported" })),
    })) },
    ACCOUNT_MAINTENANCE_EVIDENCE: bucket,
    ACCOUNT_MAINTENANCE_MODE: "private-scheduled-only",
    ACCOUNT_MAINTENANCE_SOURCE_COMMIT: SOURCE,
    ACCOUNT_MAINTENANCE_DEPLOYMENT_VERSION: "13",
    ACCOUNT_MAINTENANCE_SOURCE_DATABASE_DIGEST: hash("database"),
    ACCOUNT_MAINTENANCE_EVIDENCE_BUCKET_DIGEST: hash("bucket"),
  };
  try {
    await runScheduledAccountMaintenanceTestOnly({
      controller: { cron: "*/15 * * * *", scheduledTime }, env: maintenanceEnv,
      clock: () => scheduledTime + (++clockCalls) * 1000, log: () => {},
    });
  } catch (error) {
    if (count !== 100) throw error;
  }
  const env = {
    ...maintenanceEnv,
    ACCOUNT_MAINTENANCE_OBSERVER_MODE: "private-service-binding-only",
    ACCOUNT_MONITOR_SOURCE_COMMIT: MONITOR_SOURCE,
    ACCOUNT_MONITOR_DEPLOYMENT_VERSION: "15",
    ACCOUNT_MAINTENANCE_OBSERVER_PUBLIC_KEY: KEYS.publicKey.export({ format: "jwk" }).x,
    ACCOUNT_MAINTENANCE_OBSERVER_PRIVATE_KEY: KEYS.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  };
  delete env.DB;
  const input = {
    schema: "treeswap.account-storage-observation-request.v1", kind: "maintenance",
    sourceCommit: MONITOR_SOURCE, deploymentVersion: "15", databaseDigest: hash("database"),
    requestId: hash("fresh request"), requestedAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 30,
  };
  return { env, input, objects, reads, now };
}

function request(input, overrides = {}) {
  return new Request(overrides.url ?? "https://account-maintenance-observer.internal/v1/observe", {
    method: "POST", body: JSON.stringify(input),
    headers: { "content-type": "application/json", "cache-control": "no-store", ...overrides.headers },
  });
}

function run(f, overrides = {}) {
  return handleAccountMaintenanceObservationForTests({
    request: overrides.request ?? request(f.input), env: f.env, clock: overrides.clock ?? (() => f.now),
  });
}

function rewrite(f, transform) {
  const original = [...f.objects.values()][0];
  const record = JSON.parse(original.text);
  transform(record);
  const text = `${JSON.stringify(canonical(record))}\n`;
  const evidenceDigest = hash(text);
  const key = original.key.slice(0, -69) + `${evidenceDigest.slice(2)}.json`;
  f.objects.clear();
  f.objects.set(key, { ...original, key, text, size: Buffer.byteLength(text),
    customMetadata: { ...original.customMetadata, evidenceDigest } });
}

test("signs only checksum-verified real scheduler evidence and binds the complete monitor request", async () => {
  const f = await fixture();
  const response = await run(f);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { signature, ...payload } = await response.json();
  assert.equal(payload.requestDigest, hash(JSON.stringify(canonical(f.input))));
  assert.equal(payload.evidenceDigest, hash([...f.objects.values()][0].text));
  assert.equal(payload.lastCompletedAt, (SLOT + 2000) / 1000);
  assert.equal(payload.validUntil, f.input.expiresAt);
  assert.equal(verify(null, serializeScheduledAccountStorageObserverPayload(payload), KEYS.publicKey,
    Buffer.from(signature, "base64url")), true);
  assert.equal(JSON.stringify(payload).includes("private-never-exported"), false);
  assert.equal(f.reads.length, 1);
});

test("allows preceding slot only during the current execution grace window", async () => {
  assert.equal((await run(await fixture({ scheduledTime: SLOT - 900_000 }))).status, 200);
  const overdue = await fixture({ scheduledTime: SLOT - 900_000, now: SLOT + 600_000 });
  assert.equal((await run(overdue)).status, 503);
  assert.equal(overdue.reads.length, 0);
});

test("rejects missing, ambiguous, truncated, changed, or oversized R2 evidence", async () => {
  for (const change of [
    (f) => f.objects.clear(),
    (f) => { f.env.ACCOUNT_MAINTENANCE_EVIDENCE.list = async () => ({ objects: [], truncated: true }); },
    (f) => { const o = [...f.objects.values()][0]; f.objects.set(`${o.key}extra`, { ...o, key: `${o.key}extra` }); },
    (f) => { [...f.objects.values()][0].text += " "; },
    (f) => { [...f.objects.values()][0].size = 16_385; },
    (f) => { [...f.objects.values()][0].customMetadata.evidenceDigest = hash("substitution"); },
    (f) => { f.env.ACCOUNT_MAINTENANCE_EVIDENCE.get = async () => null; },
  ]) {
    const f = await fixture(); change(f);
    const response = await run(f);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "");
  }
});

test("recomputing a checksum cannot authorize wrong bindings, time, schema, counts, or authority", async () => {
  for (const change of [
    (r) => { r.sourceCommit = MONITOR_SOURCE; },
    (r) => { r.deploymentVersion = "99"; },
    (r) => { r.sourceDatabaseDigest = hash("wrong database"); },
    (r) => { r.evidenceBucketDigest = hash("wrong bucket"); },
    (r) => { r.schema = "unknown"; },
    (r) => { r.completedAt = new Date(SLOT + 700_000).toISOString(); },
    (r) => { r.startedAt = new Date(SLOT - 1000).toISOString(); },
    (r) => { r.maintenance.observedAt = new Date(SLOT - 1000).toISOString(); },
    (r) => { r.maintenance.deleted.sessions = 100; },
    (r) => { r.maintenance.deleted.nonces = -1; },
    (r) => { r.maintenance.deleted.notifications = "1"; },
    (r) => { r.maintenance.moreWorkPossible = true; },
    (r) => { r.authorizations.funding = true; },
    (r) => { r.extra = "private-never-exported"; },
  ]) {
    const f = await fixture(); rewrite(f, change);
    assert.equal((await run(f)).status, 503);
  }
  assert.equal((await run(await fixture({ count: 100 }))).status, 503);
});

test("rejects wrong monitor identity, stale requests, extra fields, routes, and sensitive headers before R2", async () => {
  for (const change of [
    (f) => { f.input.kind = "access"; },
    (f) => { f.input.sourceCommit = SOURCE; },
    (f) => { f.input.deploymentVersion = "14"; },
    (f) => { f.input.databaseDigest = hash("other database"); },
    (f) => { f.input.requestedAt -= 6; f.input.expiresAt -= 6; },
    (f) => { f.input.requestedAt++; f.input.expiresAt++; },
    (f) => { f.input.extra = true; },
  ]) {
    const f = await fixture(); change(f);
    assert.equal((await run(f)).status, 503);
    assert.equal(f.reads.length, 0);
  }
  for (const overrides of [
    { url: "https://public.example/v1/observe" }, { headers: { cookie: "private" } },
    { headers: { authorization: "private" } }, { headers: { "content-encoding": "gzip" } },
    { headers: { "content-length": "999999" } },
  ]) {
    const f = await fixture();
    assert.equal((await run(f, { request: request(f.input, overrides) })).status, 503);
    assert.equal(f.reads.length, 0);
  }
});

test("rejects key mismatch, noncanonical key encoding, and clock rollback without a signed response", async () => {
  const f = await fixture();
  f.env.ACCOUNT_MAINTENANCE_OBSERVER_PUBLIC_KEY = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x;
  assert.equal((await run(f)).status, 503);
  const badKey = await fixture();
  badKey.env.ACCOUNT_MAINTENANCE_OBSERVER_PRIVATE_KEY += "=";
  assert.equal((await run(badKey)).status, 503);
  const rollback = await fixture();
  let calls = 0;
  assert.equal((await run(rollback, { clock: () => rollback.now - calls++ })).status, 503);
});

test("stalled R2 returns a bounded generic failure with no late signed response", async () => {
  const f = await fixture();
  f.env.ACCOUNT_MAINTENANCE_EVIDENCE.list = () => new Promise(() => {});
  const started = Date.now();
  assert.equal((await run(f)).status, 503);
  assert.ok(Date.now() - started < 12_000);
  assert.equal(f.reads.length, 0);
});
