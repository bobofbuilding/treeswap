import { createHash } from "node:crypto";

const EVIDENCE_SCHEMA = "treeswap.production-duration-evidence.v1";
const EVIDENCE_SCOPE = "local-lnd-regtest-no-funding-authorization";

const POLICY = Object.freeze({
  durationSeconds: 3600,
  minimumElapsedSeconds: 3601,
  maximumElapsedSeconds: 3720,
  observationIntervalSeconds: 30,
  maximumObservationGapSeconds: 45,
  minimumObservations: 110,
  maximumObservations: 130,
  restartNotBeforeSeconds: 1800,
  restartNotAfterSeconds: 1860,
  maximumClockDifferenceSeconds: 5,
});

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function safeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function sourceCommit(value) {
  const commit = String(value ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new TypeError("source commit is invalid");
  return commit;
}

function isoFromEpochSeconds(value, name) {
  const seconds = safeInteger(value, name);
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} is outside the supported timestamp range`);
  return date.toISOString();
}

export function buildProductionDurationEvidence(input) {
  exactKeys(input, [
    "finishedAtEpochSeconds",
    "maximumObservationGapSeconds",
    "monotonicElapsedSeconds",
    "observationCount",
    "restartElapsedSeconds",
    "sourceCommit",
    "startedAtEpochSeconds",
  ], "production-duration evidence input");

  const commit = sourceCommit(input.sourceCommit);
  const startedAtEpochSeconds = safeInteger(input.startedAtEpochSeconds, "startedAtEpochSeconds");
  const finishedAtEpochSeconds = safeInteger(input.finishedAtEpochSeconds, "finishedAtEpochSeconds");
  const monotonicElapsedSeconds = safeInteger(input.monotonicElapsedSeconds, "monotonicElapsedSeconds");
  const maximumObservationGapSeconds = safeInteger(
    input.maximumObservationGapSeconds,
    "maximumObservationGapSeconds",
  );
  const observationCount = safeInteger(input.observationCount, "observationCount");
  const restartElapsedSeconds = safeInteger(input.restartElapsedSeconds, "restartElapsedSeconds");
  const wallElapsedSeconds = finishedAtEpochSeconds - startedAtEpochSeconds;

  if (wallElapsedSeconds < POLICY.minimumElapsedSeconds
    || wallElapsedSeconds > POLICY.maximumElapsedSeconds
    || monotonicElapsedSeconds < POLICY.minimumElapsedSeconds
    || monotonicElapsedSeconds > POLICY.maximumElapsedSeconds) {
    throw new RangeError("production-duration evidence did not cover the required uncompressed interval");
  }
  if (Math.abs(wallElapsedSeconds - monotonicElapsedSeconds) > POLICY.maximumClockDifferenceSeconds) {
    throw new RangeError("production-duration wall and monotonic clocks diverged");
  }
  if (observationCount < POLICY.minimumObservations || observationCount > POLICY.maximumObservations) {
    throw new RangeError("production-duration observation count is outside the safe range");
  }
  if (maximumObservationGapSeconds < 1
    || maximumObservationGapSeconds > POLICY.maximumObservationGapSeconds) {
    throw new RangeError("production-duration observation cadence was interrupted");
  }
  if (restartElapsedSeconds < POLICY.restartNotBeforeSeconds
    || restartElapsedSeconds > POLICY.restartNotAfterSeconds
    || restartElapsedSeconds >= monotonicElapsedSeconds) {
    throw new RangeError("production-duration restart timing is outside the safe midpoint window");
  }

  const evidence = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    scope: EVIDENCE_SCOPE,
    source: Object.freeze({ branch: "main", commit, clean: true, published: true }),
    policy: POLICY,
    startedAt: isoFromEpochSeconds(startedAtEpochSeconds, "startedAtEpochSeconds"),
    finishedAt: isoFromEpochSeconds(finishedAtEpochSeconds, "finishedAtEpochSeconds"),
    measurements: Object.freeze({
      wallElapsedSeconds,
      monotonicElapsedSeconds,
      observationCount,
      maximumObservationGapSeconds,
      restartElapsedSeconds,
    }),
    controls: Object.freeze({
      adapterRestartPersisted: true,
      deterministicNoProgressRejection: true,
      guardIntervalBlockAdvances: 0,
      targetPaymentDispatches: 0,
    }),
    limitations: Object.freeze({
      independentReviewIncluded: false,
      productionInfrastructureIncluded: false,
      publicTestnetIncluded: false,
      localRegtestOnly: true,
      fundingAuthorization: false,
    }),
  });
  return Object.freeze({ ...evidence, evidenceDigest: digest(evidence) });
}

export function verifyProductionDurationEvidence(value, { expectedSourceCommit } = {}) {
  exactKeys(value, [
    "controls",
    "evidenceDigest",
    "finishedAt",
    "limitations",
    "measurements",
    "policy",
    "schema",
    "scope",
    "source",
    "startedAt",
    "status",
  ], "production-duration evidence");
  exactKeys(value.source, ["branch", "clean", "commit", "published"], "production-duration source");
  exactKeys(value.policy, Object.keys(POLICY), "production-duration policy");
  exactKeys(value.measurements, [
    "monotonicElapsedSeconds",
    "maximumObservationGapSeconds",
    "observationCount",
    "restartElapsedSeconds",
    "wallElapsedSeconds",
  ], "production-duration measurements");
  exactKeys(value.controls, [
    "adapterRestartPersisted",
    "deterministicNoProgressRejection",
    "guardIntervalBlockAdvances",
    "targetPaymentDispatches",
  ], "production-duration controls");
  exactKeys(value.limitations, [
    "fundingAuthorization",
    "independentReviewIncluded",
    "localRegtestOnly",
    "productionInfrastructureIncluded",
    "publicTestnetIncluded",
  ], "production-duration limitations");

  const commit = sourceCommit(value.source.commit);
  if (expectedSourceCommit !== undefined && commit !== sourceCommit(expectedSourceCommit)) {
    throw new Error("production-duration evidence source does not match the qualification source");
  }
  if (value.schema !== EVIDENCE_SCHEMA || value.status !== "passed" || value.scope !== EVIDENCE_SCOPE
    || value.source.branch !== "main" || value.source.clean !== true || value.source.published !== true) {
    throw new Error("production-duration evidence identity is invalid");
  }
  for (const [key, required] of Object.entries(POLICY)) {
    if (value.policy[key] !== required) throw new Error(`production-duration policy.${key} is invalid`);
  }
  if (value.controls.adapterRestartPersisted !== true
    || value.controls.deterministicNoProgressRejection !== true
    || value.controls.guardIntervalBlockAdvances !== 0
    || value.controls.targetPaymentDispatches !== 0) {
    throw new Error("production-duration controls did not fail closed");
  }
  const requiredLimitations = {
    independentReviewIncluded: false,
    productionInfrastructureIncluded: false,
    publicTestnetIncluded: false,
    localRegtestOnly: true,
    fundingAuthorization: false,
  };
  for (const [key, required] of Object.entries(requiredLimitations)) {
    if (value.limitations[key] !== required) throw new Error(`production-duration limitations.${key} is invalid`);
  }

  const startedAtEpochSeconds = Date.parse(value.startedAt) / 1000;
  const finishedAtEpochSeconds = Date.parse(value.finishedAt) / 1000;
  if (!Number.isSafeInteger(startedAtEpochSeconds) || !Number.isSafeInteger(finishedAtEpochSeconds)
    || new Date(startedAtEpochSeconds * 1000).toISOString() !== value.startedAt
    || new Date(finishedAtEpochSeconds * 1000).toISOString() !== value.finishedAt) {
    throw new TypeError("production-duration timestamps are not canonical whole-second ISO-8601 values");
  }
  const rebuilt = buildProductionDurationEvidence({
    sourceCommit: commit,
    startedAtEpochSeconds,
    finishedAtEpochSeconds,
    monotonicElapsedSeconds: value.measurements.monotonicElapsedSeconds,
    maximumObservationGapSeconds: value.measurements.maximumObservationGapSeconds,
    observationCount: value.measurements.observationCount,
    restartElapsedSeconds: value.measurements.restartElapsedSeconds,
  });
  if (JSON.stringify(canonical(rebuilt)) !== JSON.stringify(canonical(value))) {
    throw new Error("production-duration evidence digest or content is invalid");
  }
  return rebuilt;
}

export const productionDurationEvidencePolicy = POLICY;
export const productionDurationEvidenceSchemas = Object.freeze({
  evidence: EVIDENCE_SCHEMA,
  scope: EVIDENCE_SCOPE,
});
