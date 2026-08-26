import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  collectAccountStorageDatabaseObservationForTests,
} from "../lib/account-storage-monitor.mjs";
import {
  SCHEDULED_ACCOUNT_STORAGE_MONITOR_CRON,
  runScheduledAccountStorageMonitorTestOnly,
  serializeScheduledAccountStorageObserverPayload,
} from "../lib/scheduled-account-storage-monitor.mjs";

const NOW = 2_100_000_000;
const SCHEDULED_TIME = NOW * 1_000;
const SOURCE_COMMIT = "a".repeat(40);
const ACCESS_KEYS = generateKeyPairSync("ed25519");
const MAINTENANCE_KEYS = generateKeyPairSync("ed25519");

function digest(label) {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function valueDigest(value) {
  return `0x${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function publicKeyBase64Url(keys) {
  return keys.publicKey.export({ format: "jwk" }).x;
}

function observerKeyId(keys) {
  return `0x${createHash("sha256").update(Buffer.from(publicKeyBase64Url(keys), "base64url")).digest("hex")}`;
}

function databaseBinding(counts = [0, 0, 0], options = {}) {
  return {
    prepare(sql) {
      if (options.prepareThrows) throw new Error("private D1 failure");
      return {
        bind(...values) { return { sql, values }; },
      };
    },
    async batch() {
      if (options.batchThrows) throw new Error("private D1 failure");
      return [
        { success: true, results: [] },
        ...counts.map((count) => ({ success: true, results: [{ count }] })),
      ];
    },
  };
}

function observerService(kind, keys, overrides = {}) {
  const requests = [];
  const inputs = [];
  return {
    requests,
    inputs,
    async fetch(request) {
      requests.push(request);
      const input = await request.json();
      inputs.push(input);
      const requestDigest = overrides.requestDigest ?? valueDigest(input);
      const common = {
        schema: kind === "access"
          ? "treeswap.account-storage-access-observer-response.v1"
          : "treeswap.account-storage-maintenance-observer-response.v1",
        kind,
        requestDigest,
        signerKeyId: overrides.signerKeyId ?? observerKeyId(keys),
        observedAt: overrides.observedAt ?? input.requestedAt,
        validUntil: overrides.validUntil ?? input.expiresAt,
        evidenceDigest: overrides.evidenceDigest ?? digest(`${kind} retained private evidence`),
      };
      const payload = kind === "access" ? {
        ...common,
        observedFrom: overrides.observedFrom ?? input.requestedAt - 300,
        auditCoverageComplete: overrides.auditCoverageComplete ?? true,
        unauthorizedReadAttempts: overrides.unauthorizedReadAttempts ?? 0,
        unauthorizedWriteAttempts: overrides.unauthorizedWriteAttempts ?? 0,
        privilegeChangeEvents: overrides.privilegeChangeEvents ?? 0,
      } : {
        ...common,
        lastCompletedAt: overrides.lastCompletedAt ?? input.requestedAt - 60,
        status: overrides.status ?? "completed",
        moreWorkPossible: overrides.moreWorkPossible ?? false,
      };
      let signature = sign(
        null,
        Buffer.from(serializeScheduledAccountStorageObserverPayload(payload)),
        keys.privateKey,
      ).toString("base64url");
      if (overrides.invalidSignature) signature = `${"A".repeat(85)}B`;
      const body = JSON.stringify({ ...payload, signature, ...(overrides.extraField ? { extra: true } : {}) });
      return new Response(body, {
        status: overrides.httpStatus ?? 200,
        headers: {
          "content-type": overrides.contentType ?? "application/json",
          "cache-control": overrides.cacheControl ?? "no-store",
          ...(overrides.contentEncoding ? { "content-encoding": overrides.contentEncoding } : {}),
          ...(overrides.setCookie ? { "set-cookie": "private=value" } : {}),
        },
      });
    },
  };
}

function alertService(overrides = {}) {
  const requests = [];
  return {
    requests,
    async fetch(request) {
      requests.push(request);
      const requestDigest = request.headers.get("x-treeswap-alert-request-digest");
      const routeDigest = request.headers.get("x-treeswap-alert-route-digest");
      if (overrides.throw) throw new Error("paging provider private failure");
      if (overrides.badAck) {
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "x-treeswap-alert-request-digest": digest("wrong alert"),
            "x-treeswap-alert-route-digest": routeDigest,
          },
        });
      }
      return new Response(null, {
        status: 204,
        headers: {
          "cache-control": "no-store",
          "x-treeswap-alert-request-digest": requestDigest,
          "x-treeswap-alert-route-digest": routeDigest,
        },
      });
    },
  };
}

function evidenceBucket(overrides = {}) {
  const puts = [];
  return {
    puts,
    async put(key, body, options) {
      puts.push({ key, body, options });
      if (overrides.throw) throw new Error("private evidence store failure");
      return {
        key,
        size: new TextEncoder().encode(body).byteLength,
        etag: "retained-etag",
        version: "retained-version",
      };
    },
  };
}

function fixtures(overrides = {}) {
  const access = overrides.access ?? observerService("access", ACCESS_KEYS, overrides.accessOptions);
  const maintenance = overrides.maintenance
    ?? observerService("maintenance", MAINTENANCE_KEYS, overrides.maintenanceOptions);
  const primaryAlert = overrides.primaryAlert ?? alertService(overrides.primaryAlertOptions);
  const secondaryAlert = overrides.secondaryAlert ?? alertService(overrides.secondaryAlertOptions);
  const evidence = overrides.evidence ?? evidenceBucket(overrides.evidenceOptions);
  const database = overrides.database ?? databaseBinding(overrides.counts, overrides.databaseOptions);
  return {
    access,
    maintenance,
    primaryAlert,
    secondaryAlert,
    evidence,
    database,
    env: {
      DB: database,
      ACCOUNT_ACCESS_OBSERVER: access,
      ACCOUNT_MAINTENANCE_OBSERVER: maintenance,
      ACCOUNT_ALERT_PRIMARY: primaryAlert,
      ACCOUNT_ALERT_SECONDARY: secondaryAlert,
      ACCOUNT_MONITOR_EVIDENCE: evidence,
      ACCOUNT_MONITOR_MODE: "private-scheduled-monitor-only",
      ACCOUNT_MONITOR_SOURCE_COMMIT: SOURCE_COMMIT,
      ACCOUNT_MONITOR_DEPLOYMENT_VERSION: "15",
      ACCOUNT_MONITOR_DATABASE_DIGEST: digest("scheduled monitor D1 database"),
      ACCOUNT_MONITOR_EVIDENCE_BUCKET_DIGEST: digest("scheduled monitor R2 evidence bucket"),
      ACCOUNT_ACCESS_OBSERVER_PUBLIC_KEY: publicKeyBase64Url(ACCESS_KEYS),
      ACCOUNT_MAINTENANCE_OBSERVER_PUBLIC_KEY: publicKeyBase64Url(MAINTENANCE_KEYS),
      ACCOUNT_ALERT_PRIMARY_ROUTE_DIGEST: digest("scheduled monitor primary paging route"),
      ACCOUNT_ALERT_SECONDARY_ROUTE_DIGEST: digest("scheduled monitor secondary paging route"),
    },
  };
}

function deterministicRandom() {
  let value = 0;
  return (length) => new Uint8Array(length).fill(++value);
}

async function databaseObservation(database) {
  return collectAccountStorageDatabaseObservationForTests({
    binding: database,
    observedAt: NOW,
    monotonicMilliseconds: (() => {
      const values = [1_000, 1_025];
      let index = 0;
      return () => values[Math.min(index++, values.length - 1)];
    })(),
  });
}

async function run(fixture, overrides = {}) {
  const logs = [];
  const result = await runScheduledAccountStorageMonitorTestOnly({
    controller: overrides.controller ?? {
      cron: SCHEDULED_ACCOUNT_STORAGE_MONITOR_CRON,
      scheduledTime: SCHEDULED_TIME,
    },
    env: fixture.env,
    clock: overrides.clock ?? (() => SCHEDULED_TIME + 500),
    randomBytes: overrides.randomBytes ?? deterministicRandom(),
    collectDatabase: overrides.collectDatabase ?? databaseObservation,
    log: (entry) => logs.push(entry),
  });
  return { result, logs };
}

test("runs one private one-minute monitor cycle and retains a healthy aggregate record", async () => {
  const fixture = fixtures();
  const { result, logs } = await run(fixture);

  assert.equal(result.status, "healthy");
  assert.equal(result.outcome, "HEALTHY");
  assert.equal(result.alertRoutesAttempted, 0);
  assert.equal(result.alertRoutesDelivered, 0);
  assert.equal(result.retained, true);
  assert.equal(fixture.access.requests.length, 1);
  assert.equal(fixture.maintenance.requests.length, 1);
  assert.notEqual(
    fixture.access.inputs[0].requestId,
    fixture.maintenance.inputs[0].requestId,
  );
  assert.equal(fixture.primaryAlert.requests.length, 0);
  assert.equal(fixture.secondaryAlert.requests.length, 0);
  assert.equal(fixture.evidence.puts.length, 1);
  assert.match(fixture.evidence.puts[0].key, /^account-storage-monitor\/v1\/2100000000-a{40}\.json$/);
  assert.equal(fixture.evidence.puts[0].options.httpMetadata.cacheControl, "no-store");
  assert.equal(fixture.evidence.puts[0].options.onlyIf.get("if-none-match"), "*");
  const record = JSON.parse(fixture.evidence.puts[0].body);
  assert.equal(record.status, "healthy");
  assert.deepEqual(record.reasonCodes, []);
  assert.deepEqual(record.authorizations, {
    accountDisable: false,
    accountEnablement: false,
    funding: false,
    lightningDispatch: false,
    outboundDelivery: false,
    releaseActivation: false,
    settlement: false,
    walletDispatch: false,
  });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify({ result, record }), /(cookie|email|invoice|password|preimage|private.?key|wallet.?address)/i);
});

test("an authenticated access anomaly pages both routes, retains unsafe evidence, and fails the invocation", async () => {
  const fixture = fixtures({ accessOptions: { unauthorizedReadAttempts: 1 } });
  await assert.rejects(() => run(fixture), /scheduled account storage monitor failed closed/);
  assert.equal(fixture.primaryAlert.requests.length, 1);
  assert.equal(fixture.secondaryAlert.requests.length, 1);
  assert.equal(fixture.evidence.puts.length, 1);
  const record = JSON.parse(fixture.evidence.puts[0].body);
  assert.equal(record.status, "unsafe");
  assert.equal(record.outcome, "ESCALATED");
  assert.equal(record.alertRoutesDelivered, 2);
  assert.ok(record.reasonCodes.includes("UNAUTHORIZED_READ_OBSERVED"));
  const alert = (await fixture.primaryAlert.requests[0].clone().json()).alert;
  assert.ok(alert.reasonCodes.includes("UNAUTHORIZED_READ_OBSERVED"));
});

test("missing or forged observer authority becomes unsafe and can never become a healthy cycle", async () => {
  for (const accessOptions of [
    { invalidSignature: true },
    { requestDigest: digest("replayed observer request") },
    { signerKeyId: observerKeyId(MAINTENANCE_KEYS) },
    { extraField: true },
    { cacheControl: "public" },
    { setCookie: true },
    { contentEncoding: "gzip" },
  ]) {
    const fixture = fixtures({ accessOptions });
    await assert.rejects(() => run(fixture), /scheduled account storage monitor failed closed/);
    assert.equal(fixture.evidence.puts.length, 1);
    const record = JSON.parse(fixture.evidence.puts[0].body);
    assert.equal(record.status, "unsafe");
    assert.ok(record.reasonCodes.includes("ACCESS_OBSERVATION_INVALID"));
    assert.equal(fixture.primaryAlert.requests.length, 1);
    assert.equal(fixture.secondaryAlert.requests.length, 1);
  }
});

test("maintenance failure, D1 failure, and paging degradation all fail closed with retained evidence", async () => {
  const maintenanceFailure = fixtures({ maintenanceOptions: { status: "failed" } });
  await assert.rejects(() => run(maintenanceFailure), /failed closed/);
  assert.ok(JSON.parse(maintenanceFailure.evidence.puts[0].body).reasonCodes.includes("MAINTENANCE_FAILED"));

  const databaseFailure = fixtures({ databaseOptions: { batchThrows: true } });
  await assert.rejects(() => run(databaseFailure), /failed closed/);
  assert.ok(JSON.parse(databaseFailure.evidence.puts[0].body).reasonCodes.includes("DATABASE_PROBE_FAILED"));

  const degraded = fixtures({
    accessOptions: { unauthorizedWriteAttempts: 1 },
    secondaryAlertOptions: { badAck: true },
  });
  await assert.rejects(() => run(degraded), /failed closed/);
  const degradedRecord = JSON.parse(degraded.evidence.puts[0].body);
  assert.equal(degradedRecord.alertRoutesDelivered, 1);
  assert.equal(degradedRecord.alertDeliveryDegraded, true);
});

test("evidence retention failure pages both routes and cannot emit a positive receipt", async () => {
  const fixture = fixtures({ evidenceOptions: { throw: true } });
  await assert.rejects(() => run(fixture), /scheduled account storage monitor failed closed/);
  assert.equal(fixture.primaryAlert.requests.length, 1);
  assert.equal(fixture.secondaryAlert.requests.length, 1);
  const primary = (await fixture.primaryAlert.requests[0].clone().json()).alert;
  assert.deepEqual(primary.reasonCodes, ["MONITOR_EVIDENCE_RETENTION_FAILED"]);
});

test("requires the exact cadence, causal window, private mode, source, and separate bindings", async () => {
  const wrongCron = fixtures();
  await assert.rejects(() => run(wrongCron, {
    controller: { cron: "*/5 * * * *", scheduledTime: SCHEDULED_TIME },
  }), /reviewed cadence/);

  const delayed = fixtures();
  await assert.rejects(() => run(delayed, {
    clock: () => SCHEDULED_TIME + 60_001,
  }), /start is outside/);

  const wrongMode = fixtures();
  wrongMode.env.ACCOUNT_MONITOR_MODE = "public";
  await assert.rejects(() => run(wrongMode), /mode is not private/);

  const wrongSource = fixtures();
  wrongSource.env.ACCOUNT_MONITOR_SOURCE_COMMIT = SOURCE_COMMIT.toUpperCase();
  await assert.rejects(() => run(wrongSource), /source commit is invalid/);

  const sharedBinding = fixtures();
  sharedBinding.env.ACCOUNT_ALERT_SECONDARY = sharedBinding.env.ACCOUNT_ALERT_PRIMARY;
  await assert.rejects(() => run(sharedBinding), /pairwise separate/);

  const sharedRoute = fixtures();
  sharedRoute.env.ACCOUNT_ALERT_SECONDARY_ROUTE_DIGEST = sharedRoute.env.ACCOUNT_ALERT_PRIMARY_ROUTE_DIGEST;
  await assert.rejects(() => run(sharedRoute), /commitments must be distinct/);

  const sharedObserverKey = fixtures();
  sharedObserverKey.env.ACCOUNT_MAINTENANCE_OBSERVER_PUBLIC_KEY = publicKeyBase64Url(ACCESS_KEYS);
  await assert.rejects(() => run(sharedObserverKey), /commitments must be distinct/);
});

test("rejects repeated challenges, invalid database collectors, and unsafe signed payloads", async () => {
  const repeated = fixtures();
  await assert.rejects(() => run(repeated, {
    randomBytes: (length) => new Uint8Array(length).fill(7),
  }), /challenges must be distinct/);

  const invalidDatabase = fixtures();
  await assert.rejects(() => run(invalidDatabase, {
    collectDatabase: async () => { throw new Error("private collector failure"); },
  }), /failed closed/);
  assert.ok(JSON.parse(invalidDatabase.evidence.puts[0].body).reasonCodes.includes("DATABASE_OBSERVATION_INVALID"));

  const payload = {
    schema: "treeswap.account-storage-access-observer-response.v1",
    kind: "access",
    requestDigest: digest("request"),
    signerKeyId: observerKeyId(ACCESS_KEYS),
    observedAt: NOW,
    validUntil: NOW + 30,
    evidenceDigest: digest("evidence"),
    observedFrom: NOW - 300,
    auditCoverageComplete: true,
    unauthorizedReadAttempts: 0,
    unauthorizedWriteAttempts: 0,
    privilegeChangeEvents: 0,
  };
  assert.ok(serializeScheduledAccountStorageObserverPayload(payload) instanceof Uint8Array);
  assert.throws(() => serializeScheduledAccountStorageObserverPayload({ ...payload, extra: true }), /fields are not exact/);
  assert.throws(() => serializeScheduledAccountStorageObserverPayload({
    ...payload,
    observedAt: { valueOf: () => NOW },
  }), /safe integer/);
  let getterCalls = 0;
  const accessor = { ...payload };
  Object.defineProperty(accessor, "evidenceDigest", {
    enumerable: true,
    get() { getterCalls += 1; return digest("evidence"); },
  });
  assert.throws(() => serializeScheduledAccountStorageObserverPayload(accessor), /enumerable data properties/);
  assert.equal(getterCalls, 0);
});

test("production Worker exposes only scheduled monitoring with no HTTP, mutation, or funding surface", async () => {
  const worker = await import("../infra/account-storage-monitor/worker.mjs");
  assert.equal(typeof worker.default.scheduled, "function");
  assert.equal(Object.hasOwn(worker.default, "fetch"), false);
  assert.deepEqual(Object.keys(worker.default), ["scheduled"]);

  const workerSource = await readFile(
    new URL("../infra/account-storage-monitor/worker.mjs", import.meta.url),
    "utf8",
  );
  const runtimeSource = await readFile(
    new URL("../lib/scheduled-account-storage-monitor.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workerSource, /\bfetch\s*\(/);
  assert.doesNotMatch(runtimeSource, /\b(?:sendPayment|settleInvoice|openGate|fundPool)\s*\(/i);
  assert.match(runtimeSource, /private-scheduled-monitor-only/);
  assert.match(runtimeSource, /Ed25519/);
});
