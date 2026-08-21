import { coordinatorCommitmentDigest } from "./coordinator-store.mjs";

const EVIDENCE_SCHEMA = "treeswap.live-account-evidence.v1";
const SCOPE = "owner-only-live-d1-siwe-no-funding-authorization";
const ORIGIN = "https://treeswap-lightning-bit.bobofbuilding.chatgpt.site";
const CHECK_KEYS = Object.freeze([
  "accountCapabilityEnabled",
  "concurrentSessionRotationSerialized",
  "crossOriginSignoutRejected",
  "durableStorageEnabled",
  "emailDeliveryDisabled",
  "noNotificationRecordCreated",
  "nonceIssued",
  "nonceSingleUseEnforced",
  "priorSessionInvalidated",
  "serverSideSignoutEnforced",
  "sessionCookieHardened",
  "sessionPersisted",
  "siweOriginBound",
]);

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return value;
}

function exactSource(source) {
  exactObject(source, ["branch", "clean", "commit", "published"], "source");
  const commit = String(source.commit ?? "").toLowerCase();
  if (source.branch !== "main" || source.clean !== true || source.published !== true || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("live account evidence requires clean published main");
  }
  return Object.freeze({ branch: "main", commit, clean: true, published: true });
}

function exactDeployment(deployment) {
  exactObject(deployment, ["access", "origin", "platform", "version"], "deployment");
  const version = String(deployment.version ?? "");
  if (
    deployment.origin !== ORIGIN
    || deployment.platform !== "OpenAI Sites"
    || deployment.access !== "owner-only"
    || !/^[1-9][0-9]*$/.test(version)
  ) {
    throw new Error("live account evidence deployment is outside the owner-only production boundary");
  }
  return Object.freeze({ origin: ORIGIN, platform: "OpenAI Sites", access: "owner-only", version });
}

function exactTimestamp(value, name) {
  const normalized = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new TypeError(`${name} must be a millisecond UTC timestamp`);
  }
  return normalized;
}

function exactChecks(checks) {
  exactObject(checks, CHECK_KEYS, "checks");
  for (const key of CHECK_KEYS) {
    if (checks[key] !== true) throw new Error(`live account check did not pass: ${key}`);
  }
  return Object.freeze(Object.fromEntries(CHECK_KEYS.map((key) => [key, true])));
}

export function buildLiveAccountEvidence(input) {
  exactObject(input, ["checks", "deployment", "finishedAt", "source", "startedAt"], "input");
  const source = exactSource(input.source);
  const deployment = exactDeployment(input.deployment);
  const startedAt = exactTimestamp(input.startedAt, "startedAt");
  const finishedAt = exactTimestamp(input.finishedAt, "finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error("live account evidence finished before it started");

  const evidence = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    scope: SCOPE,
    source,
    deployment,
    startedAt,
    finishedAt,
    checks: exactChecks(input.checks),
    limitations: Object.freeze({
      independentAccessPolicyAttestationIncluded: false,
      backupRestoreIncluded: false,
      continuousMonitoringIncluded: false,
      expiredRecordPurgeIncluded: false,
      emailDeliveryIncluded: false,
      fundingAuthorization: false,
    }),
  });

  return Object.freeze({
    ...evidence,
    evidenceDigest: coordinatorCommitmentDigest(evidence),
  });
}

export const liveAccountEvidencePolicy = Object.freeze({
  origin: ORIGIN,
  schema: EVIDENCE_SCHEMA,
  scope: SCOPE,
  checkKeys: CHECK_KEYS,
});
