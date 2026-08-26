import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import {
  buildWalletSessionRouteDeploymentPostflightEvidence,
} from "./wallet-session-route-deployment-preflight.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const MAXIMUM_CLOCK_SKEW_SECONDS = 120;
const MAXIMUM_OBSERVATION_AGE_SECONDS = 10 * 60;
const MAXIMUM_REPORT_LIFETIME_SECONDS = 15 * 60;
const MAXIMUM_OBSERVATION_SPREAD_SECONDS = 120;

export const WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES = Object.freeze([
  "sites-platform-observer",
  "wallet-edge-observer",
  "privacy-data-observer",
]);

export const WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_CONTROLS = Object.freeze({
  "sites-platform-observer": Object.freeze([
    "exact-reviewed-source-and-planned-deployment-identity-are-live",
    "owner-only-private-access-has-no-anonymous-group-external-or-public-bypass",
    "existing-non-production-d1-copy-is-the-only-binding-with-no-migration-or-r2",
    "sites-runtime-values-match-four-distinct-non-secret-key-identities",
    "initial-version-has-no-retiring-credential-slot",
    "exact-version-cutover-and-prior-version-retirement-evidence-is-retained",
  ]),
  "wallet-edge-observer": Object.freeze([
    "fixed-wallet-edge-reaches-only-the-exact-private-route-over-verified-tls",
    "active-and-inactive-responses-bind-one-signed-session-read",
    "forged-unknown-stale-mutated-and-replayed-material-fails-closed",
    "d1-outage-latency-clock-and-route-failure-close-wallet-admission",
    "reader-performs-no-automatic-retry-wallet-lightning-or-settlement-action",
    "route-error-monitoring-closes-admission-and-pages-the-incident-path",
  ]),
  "privacy-data-observer": Object.freeze([
    "request-and-response-bodies-are-disabled-in-logs-traces-analytics-and-errors",
    "token-hashes-wallets-session-times-and-key-identities-are-absent-from-retained-telemetry",
    "cdn-and-application-caching-indexing-and-traffic-capture-are-disabled",
    "d1-access-is-least-privilege-and-separated-from-wallet-and-coordinator-services",
    "non-production-backup-restore-and-bounded-purge-evidence-is-retained",
    "incident-drills-cover-key-compromise-version-retirement-and-d1-outage",
  ]),
});

const EVIDENCE_FIELDS = Object.freeze([
  "configuration",
  "deployedAt",
  "environment",
  "observers",
  "planDigest",
  "preflightEvidenceDigest",
  "reports",
  "schema",
  "scope",
  "sourceBranch",
  "sourceCommit",
  "status",
]);
const OBSERVER_FIELDS = Object.freeze([
  "identityEvidenceDigest",
  "observerId",
  "organizationId",
  "role",
  "signer",
]);
const REPORT_FIELDS = Object.freeze([
  "collectionMethodDigest",
  "controlSetDigest",
  "evidenceArtifactDigest",
  "evidenceCustodyDigest",
  "findingCounts",
  "findingsDispositionDigest",
  "observedAt",
  "role",
  "schema",
  "status",
  "validUntil",
]);
const FINDING_FIELDS = Object.freeze([
  "critical",
  "high",
  "informational",
  "low",
  "medium",
  "open",
]);
const ATTESTATION_FIELDS = Object.freeze(["attestedAt", "observerId", "role", "signature", "signer"]);
const verifiedPostflights = new WeakSet();

export const WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_TYPES = Object.freeze({
  WalletSessionRouteDeploymentPostflight: Object.freeze([
    Object.freeze({ name: "preflightEvidenceDigest", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "configurationDigest", type: "bytes32" }),
    Object.freeze({ name: "observerSetDigest", type: "bytes32" }),
    Object.freeze({ name: "reportSetDigest", type: "bytes32" }),
    Object.freeze({ name: "sourceCommit", type: "bytes20" }),
    Object.freeze({ name: "observerRole", type: "bytes32" }),
    Object.freeze({ name: "observerId", type: "bytes32" }),
    Object.freeze({ name: "deployedAt", type: "uint64" }),
    Object.freeze({ name: "attestedAt", type: "uint64" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
  ]),
});

function exactRecord(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
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

function exactArray(value, expectedLength, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length !== expectedLength) {
    throw new TypeError(`${name} must be one exact dense array of length ${expectedLength}`);
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = [...Array.from({ length: expectedLength }, (_, index) => String(index)), "length"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError(`${name} must be one exact dense array of length ${expectedLength}`);
  }
  const result = [];
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function valueDigest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function digest(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.toLowerCase();
  if (!BYTES32.test(normalized) || normalized === ZERO_BYTES32) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return normalized;
}

function sourceCommit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new TypeError("wallet session route postflight source commit is invalid");
  }
  return value;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function safeInteger(value, name, { positive = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function snapshotExactMatch(raw, expected, name) {
  if (Array.isArray(expected)) {
    const values = exactArray(raw, expected.length, name);
    return Object.freeze(values.map((value, index) => (
      snapshotExactMatch(value, expected[index], `${name}[${index}]`)
    )));
  }
  if (expected && typeof expected === "object") {
    const fields = Object.keys(expected);
    const source = exactRecord(raw, fields, name);
    return Object.freeze(Object.fromEntries(fields.map((field) => [
      field,
      snapshotExactMatch(source[field], expected[field], `${name}.${field}`),
    ])));
  }
  if (raw !== expected) throw new Error(`${name} does not match the signed deployment plan`);
  return raw;
}

function requireDistinct(values, name) {
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
    throw new Error(`${name} must be globally distinct`);
  }
}

function controlSetDigest(role) {
  return valueDigest(WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_CONTROLS[role]);
}

export function walletSessionRouteDeploymentPostflightControlSetDigest(role) {
  if (!WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.includes(role)) {
    throw new TypeError("wallet session route postflight role is invalid");
  }
  return controlSetDigest(role);
}

function normalizeObservers(raw, preflight) {
  const source = exactArray(
    raw,
    WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.length,
    "wallet session route postflight observers",
  );
  const observers = source.map((rawObserver, index) => {
    const observer = exactRecord(rawObserver, OBSERVER_FIELDS, `postflight observer ${index}`);
    return Object.freeze({
      role: typeof observer.role === "string" ? observer.role : "",
      observerId: digest(observer.observerId, `observers[${index}].observerId`),
      organizationId: digest(observer.organizationId, `observers[${index}].organizationId`),
      identityEvidenceDigest: digest(
        observer.identityEvidenceDigest,
        `observers[${index}].identityEvidenceDigest`,
      ),
      signer: address(observer.signer, `observers[${index}].signer`),
    });
  });
  if (observers.some((observer, index) => (
    observer.role !== WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES[index]
  ))) {
    throw new Error("wallet session route postflight observers must use exact canonical roles");
  }
  const observerCommitments = observers.flatMap((observer) => [
    observer.observerId,
    observer.organizationId,
    observer.identityEvidenceDigest,
  ]);
  requireDistinct(observerCommitments, "wallet session route postflight observer commitments");
  requireDistinct(observers.map((observer) => observer.signer), "wallet session route postflight observer signers");
  const priorCommitments = [...preflight.reviewers, ...preflight.operators].flatMap((participant) => [
    participant.reviewerId ?? participant.participantId,
    participant.organizationId,
    participant.identityEvidenceDigest,
  ]);
  const priorSigners = new Set(
    [...preflight.reviewers, ...preflight.operators].map((participant) => participant.signer.toLowerCase()),
  );
  if (observerCommitments.some((value) => priorCommitments.includes(value))) {
    throw new Error("wallet session route postflight observers may not reuse reviewer or operator commitments");
  }
  if (observers.some((observer) => priorSigners.has(observer.signer.toLowerCase()))) {
    throw new Error("wallet session route postflight observers may not reuse reviewer or operator signers");
  }
  return Object.freeze(observers);
}

function normalizeFindingCounts(raw, index) {
  const source = exactRecord(raw, FINDING_FIELDS, `postflight reports[${index}].findingCounts`);
  const counts = Object.freeze(Object.fromEntries(FINDING_FIELDS.map((field) => [
    field,
    safeInteger(source[field], `reports[${index}].findingCounts.${field}`, { maximum: 100 }),
  ])));
  if (counts.critical !== 0 || counts.high !== 0 || counts.medium !== 0 || counts.open !== 0) {
    throw new Error("wallet session route postflight reports require zero critical, high, medium, and open findings");
  }
  return counts;
}

function normalizeReports(raw, preflight, observers, deployedAt, observedAt) {
  const source = exactArray(
    raw,
    WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.length,
    "wallet session route postflight reports",
  );
  const reports = source.map((rawReport, index) => {
    const report = exactRecord(rawReport, REPORT_FIELDS, `postflight report ${index}`);
    const role = typeof report.role === "string" ? report.role : "";
    if (role !== WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES[index]
        || report.schema !== "treeswap.wallet-session-route-deployment-postflight-report.v1"
        || report.status !== "live-private-deployment-controls-passed-no-open-findings"
        || digest(report.controlSetDigest, `reports[${index}].controlSetDigest`) !== controlSetDigest(role)) {
      throw new Error("wallet session route postflight report identity or control set is invalid");
    }
    const reportObservedAt = safeInteger(report.observedAt, `reports[${index}].observedAt`, { positive: true });
    const validUntil = safeInteger(report.validUntil, `reports[${index}].validUntil`, { positive: true });
    if (reportObservedAt < deployedAt
        || reportObservedAt < observedAt - MAXIMUM_OBSERVATION_AGE_SECONDS
        || reportObservedAt > observedAt + MAXIMUM_CLOCK_SKEW_SECONDS
        || validUntil <= reportObservedAt
        || validUntil - reportObservedAt > MAXIMUM_REPORT_LIFETIME_SECONDS
        || validUntil > preflight.validUntil) {
      throw new Error("wallet session route postflight report timing is invalid");
    }
    return Object.freeze({
      schema: report.schema,
      status: report.status,
      role,
      controlSetDigest: controlSetDigest(role),
      observedAt: reportObservedAt,
      validUntil,
      collectionMethodDigest: digest(
        report.collectionMethodDigest,
        `reports[${index}].collectionMethodDigest`,
      ),
      evidenceArtifactDigest: digest(
        report.evidenceArtifactDigest,
        `reports[${index}].evidenceArtifactDigest`,
      ),
      evidenceCustodyDigest: digest(
        report.evidenceCustodyDigest,
        `reports[${index}].evidenceCustodyDigest`,
      ),
      findingsDispositionDigest: digest(
        report.findingsDispositionDigest,
        `reports[${index}].findingsDispositionDigest`,
      ),
      findingCounts: normalizeFindingCounts(report.findingCounts, index),
    });
  });
  if (reports.some((report, index) => report.role !== observers[index].role)) {
    throw new Error("wallet session route postflight reports do not match their observers");
  }
  const times = reports.map((report) => report.observedAt);
  if (Math.max(...times) - Math.min(...times) > MAXIMUM_OBSERVATION_SPREAD_SECONDS) {
    throw new Error("wallet session route postflight observations are too widely separated");
  }
  const evidenceCommitments = reports.flatMap((report) => [
    report.collectionMethodDigest,
    report.evidenceArtifactDigest,
    report.evidenceCustodyDigest,
    report.findingsDispositionDigest,
  ]);
  const observerCommitments = observers.flatMap((observer) => [
    observer.observerId,
    observer.organizationId,
    observer.identityEvidenceDigest,
  ]);
  requireDistinct(
    [
      preflight.evidenceDigest,
      preflight.recordDigest,
      preflight.planDigest,
      preflight.reviewEvidenceDigest,
      preflight.configurationDigest,
      ...observerCommitments,
      ...reports.map((report) => report.controlSetDigest),
      ...evidenceCommitments,
    ],
    "wallet session route postflight upstream, observer, and evidence commitments",
  );
  return Object.freeze(reports);
}

function normalizeEvidence(raw, preflight, observedAt) {
  const source = exactRecord(raw, EVIDENCE_FIELDS, "wallet session route postflight evidence");
  if (source.schema !== "treeswap.wallet-session-route-deployment-postflight-evidence.v1"
      || source.status !== "live-private-deployment-observed-independent-review-required"
      || source.scope !== "attestation-only-no-platform-proof-deployment-dispatch-settlement-or-funding-authorization"
      || source.environment !== "closed-test"
      || source.sourceBranch !== preflight.sourceBranch
      || sourceCommit(source.sourceCommit) !== preflight.sourceCommit
      || digest(source.preflightEvidenceDigest, "postflight preflightEvidenceDigest") !== preflight.evidenceDigest
      || digest(source.planDigest, "postflight planDigest") !== preflight.planDigest) {
    throw new Error("wallet session route postflight evidence identity is invalid");
  }
  const deployedAt = safeInteger(source.deployedAt, "wallet session route postflight deployedAt", {
    positive: true,
  });
  if (deployedAt < preflight.attestedThrough || deployedAt > observedAt + MAXIMUM_CLOCK_SKEW_SECONDS
      || deployedAt > preflight.validUntil) {
    throw new Error("wallet session route postflight deployment time is outside its signed preflight");
  }
  const configuration = snapshotExactMatch(
    source.configuration,
    preflight.configuration,
    "wallet session route postflight configuration",
  );
  if (valueDigest(configuration) !== preflight.configurationDigest) {
    throw new Error("wallet session route postflight configuration digest is invalid");
  }
  const observers = normalizeObservers(source.observers, preflight);
  const reports = normalizeReports(
    source.reports,
    preflight,
    observers,
    deployedAt,
    observedAt,
  );
  return Object.freeze({
    schema: source.schema,
    status: source.status,
    scope: source.scope,
    environment: source.environment,
    sourceBranch: preflight.sourceBranch,
    sourceCommit: preflight.sourceCommit,
    preflightEvidenceDigest: preflight.evidenceDigest,
    planDigest: preflight.planDigest,
    deployedAt,
    configuration,
    observers,
    reports,
  });
}

export function assertWalletSessionRouteDeploymentPostflightIsSecretFree(value) {
  const forbiddenKey = /(?:authorization(?!s)|cookie|email|invoice|macaroon|mnemonic|password|preimage|private.?key|public.?key|rpc.?url|secret|session.?token|token.?hash|wallet.?address)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      const values = exactArray(entry, entry.length, "wallet session route postflight array");
      for (const item of values) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string"
          && (/-----BEGIN [A-Z ]*KEY-----/.test(entry)
            || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)
            || /(?:https?|wss?):\/\//i.test(entry))) {
        throw new Error("wallet session route postflight contains secret or endpoint material");
      }
      return;
    }
    const prototype = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null)
        || keys.some((key) => typeof key !== "string")) {
      throw new Error("wallet session route postflight contains non-data material");
    }
    for (const key of keys) {
      if (forbiddenKey.test(key)) {
        throw new Error(`wallet session route postflight contains forbidden field ${key}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new Error("wallet session route postflight contains non-data material");
      }
      visit(descriptor.value);
    }
  };
  visit(value);
  return true;
}

export function prepareWalletSessionRouteDeploymentPostflight({
  deploymentPreflightVerification,
  evidence,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const preflight = buildWalletSessionRouteDeploymentPostflightEvidence(deploymentPreflightVerification);
  const now = safeInteger(observedAt, "wallet session route postflight observation time", { positive: true });
  if (now > preflight.validUntil) throw new Error("wallet session route deployment preflight expired");
  if (Object.values(preflight.externalEvidence).some((value) => value !== false)
      || Object.values(preflight.authorizations).some((value) => value !== false)) {
    throw new Error("wallet session route deployment preflight supplied unexpected live authority");
  }
  const normalizedEvidence = normalizeEvidence(evidence, preflight, now);
  const observerSetDigest = valueDigest(normalizedEvidence.observers);
  const reportSetDigest = valueDigest(normalizedEvidence.reports);
  const observedFrom = Math.min(...normalizedEvidence.reports.map((report) => report.observedAt));
  const observedThrough = Math.max(...normalizedEvidence.reports.map((report) => report.observedAt));
  const validUntil = Math.min(...normalizedEvidence.reports.map((report) => report.validUntil));
  const record = Object.freeze({
    schema: "treeswap.wallet-session-route-deployment-postflight-record.v1",
    status: "three-observer-live-claims-prepared-awaiting-attestations",
    scope: "attestation-only-live-artifact-content-and-platform-api-not-verified",
    environment: "closed-test",
    sourceBranch: preflight.sourceBranch,
    sourceCommit: preflight.sourceCommit,
    preflightEvidenceDigest: preflight.evidenceDigest,
    preflightRecordDigest: preflight.recordDigest,
    planDigest: preflight.planDigest,
    configurationDigest: preflight.configurationDigest,
    observerSetDigest,
    reportSetDigest,
    deployedAt: normalizedEvidence.deployedAt,
    observedFrom,
    observedThrough,
    validUntil,
  });
  const candidate = Object.freeze({
    schema: "treeswap.prepared-wallet-session-route-deployment-postflight.v1",
    status: "live-claims-reconstructed-awaiting-three-observer-attestations",
    scope: "no-platform-query-signing-deployment-dispatch-settlement-gate-opening-or-funding-authorization",
    recordDigest: valueDigest(record),
    record,
    evidence: normalizedEvidence,
    preflight,
  });
  assertWalletSessionRouteDeploymentPostflightIsSecretFree(candidate);
  return candidate;
}

export function walletSessionRouteDeploymentPostflightDomain(candidate) {
  return Object.freeze({
    name: "TreeSwap Wallet Session Route Deployment Postflight",
    version: "1",
    salt: candidate.record.preflightEvidenceDigest,
  });
}

export function buildWalletSessionRouteDeploymentPostflightMessage({
  deploymentPreflightVerification,
  evidence,
  role,
  attestedAt,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const candidate = prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification,
    evidence,
    observedAt,
  });
  const observerIndex = candidate.evidence.observers.findIndex((value) => value.role === role);
  const observer = candidate.evidence.observers[observerIndex];
  if (!observer) throw new Error("wallet session route postflight role is not in the observer set");
  const signedAt = safeInteger(
    attestedAt ?? observedAt,
    "wallet session route postflight attestation time",
    { positive: true },
  );
  if (signedAt < candidate.record.deployedAt
      || signedAt < candidate.evidence.reports[observerIndex].observedAt
      || signedAt > observedAt
      || signedAt > candidate.record.validUntil) {
    throw new Error("wallet session route postflight attestation time is invalid");
  }
  return Object.freeze({
    domain: walletSessionRouteDeploymentPostflightDomain(candidate),
    types: WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_TYPES,
    value: Object.freeze({
      preflightEvidenceDigest: candidate.record.preflightEvidenceDigest,
      recordDigest: candidate.recordDigest,
      configurationDigest: candidate.record.configurationDigest,
      observerSetDigest: candidate.record.observerSetDigest,
      reportSetDigest: candidate.record.reportSetDigest,
      sourceCommit: `0x${candidate.record.sourceCommit}`,
      observerRole: keccak256(toUtf8Bytes(role)).toLowerCase(),
      observerId: observer.observerId,
      deployedAt: candidate.record.deployedAt,
      attestedAt: signedAt,
      validUntil: candidate.record.validUntil,
    }),
  });
}

function normalizeAttestations(raw) {
  const source = exactArray(
    raw,
    WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES.length,
    "wallet session route postflight attestations",
  );
  const attestations = source.map((rawAttestation, index) => {
    const attestation = exactRecord(rawAttestation, ATTESTATION_FIELDS, `postflight attestation ${index}`);
    if (typeof attestation.signature !== "string" || !isHexString(attestation.signature)
        || ![64, 65].includes((attestation.signature.length - 2) / 2)) {
      throw new TypeError(`wallet session route postflight attestation ${index} signature is invalid`);
    }
    return Object.freeze({
      role: typeof attestation.role === "string" ? attestation.role : "",
      observerId: digest(attestation.observerId, `attestations[${index}].observerId`),
      signer: address(attestation.signer, `attestations[${index}].signer`),
      attestedAt: safeInteger(
        attestation.attestedAt,
        `attestations[${index}].attestedAt`,
        { positive: true },
      ),
      signature: attestation.signature.toLowerCase(),
    });
  });
  if (attestations.some((attestation, index) => (
    attestation.role !== WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT_ROLES[index]
  ))) {
    throw new Error("wallet session route postflight attestations must use exact canonical roles");
  }
  requireDistinct(attestations.map((value) => value.observerId), "postflight attestation identities");
  requireDistinct(attestations.map((value) => value.signer), "postflight attestation signers");
  return Object.freeze(attestations);
}

export function verifyWalletSessionRouteDeploymentPostflight({
  deploymentPreflightVerification,
  evidence,
  attestations,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const now = safeInteger(observedAt, "wallet session route postflight observation time", { positive: true });
  const candidate = prepareWalletSessionRouteDeploymentPostflight({
    deploymentPreflightVerification,
    evidence,
    observedAt: now,
  });
  if (now < candidate.record.observedThrough) throw new Error("wallet session route postflight is from the future");
  if (now > candidate.record.validUntil) throw new Error("wallet session route postflight is expired");
  const normalizedAttestations = normalizeAttestations(attestations);
  for (let index = 0; index < normalizedAttestations.length; index += 1) {
    const attestation = normalizedAttestations[index];
    const observer = candidate.evidence.observers[index];
    if (attestation.role !== observer.role || attestation.observerId !== observer.observerId
        || attestation.signer !== observer.signer) {
      throw new Error("wallet session route postflight attestation does not match its observer");
    }
    if (attestation.attestedAt < candidate.record.deployedAt
        || attestation.attestedAt < candidate.evidence.reports[index].observedAt
        || attestation.attestedAt > now
        || attestation.attestedAt > candidate.record.validUntil) {
      throw new Error("wallet session route postflight attestation time is invalid");
    }
    const typed = buildWalletSessionRouteDeploymentPostflightMessage({
      deploymentPreflightVerification,
      evidence,
      role: observer.role,
      attestedAt: attestation.attestedAt,
      observedAt: now,
    });
    let recovered;
    try {
      recovered = getAddress(verifyTypedData(typed.domain, typed.types, typed.value, attestation.signature));
    } catch {
      throw new Error("wallet session route postflight attestation signature is invalid");
    }
    if (recovered !== observer.signer) {
      throw new Error("wallet session route postflight attestation signature is invalid");
    }
  }
  const attestationDigest = valueDigest(normalizedAttestations.map((attestation) => ({
    role: attestation.role,
    observerId: attestation.observerId,
    signer: attestation.signer,
    attestedAt: attestation.attestedAt,
    signatureDigest: valueDigest(attestation.signature),
  })));
  const attestedFrom = Math.min(...normalizedAttestations.map((attestation) => attestation.attestedAt));
  const attestedThrough = Math.max(...normalizedAttestations.map((attestation) => attestation.attestedAt));
  const verification = Object.freeze({
    schema: "treeswap.verified-wallet-session-route-deployment-postflight.v1",
    status: "three-observer-live-deployment-claims-verified-independent-live-review-still-required",
    scope: "attestation-only-no-platform-proof-deployment-dispatch-settlement-gate-opening-or-funding-authorization",
    evidenceDigest: valueDigest({
      schema: "treeswap.wallet-session-route-deployment-postflight-binding.v1",
      recordDigest: candidate.recordDigest,
      attestationDigest,
    }),
    recordDigest: candidate.recordDigest,
    attestationDigest,
    record: candidate.record,
    observerCount: candidate.evidence.observers.length,
    verifiedAt: now,
    attestedFrom,
    attestedThrough,
    attestedClaims: Object.freeze({
      exactReviewedRouteDeployed: true,
      ownerOnlyPrivateAccess: true,
      nonProductionD1Only: true,
      fourWayKeySeparation: true,
      sensitiveBodyCaptureDisabled: true,
      exactVersionRetirementClaimed: true,
      monitoringAndIncidentDrillsClaimed: true,
    }),
    externalVerification: Object.freeze({
      platformApiQueriedByVerifier: false,
      retainedArtifactContentsInspectedByVerifier: false,
      observerIndependenceExternallyEstablished: false,
      continuousMonitoringWindowComplete: false,
      independentLiveReviewComplete: false,
      broaderReleaseReadiness: false,
    }),
    authorizations: Object.freeze({
      deployment: false,
      signing: false,
      dispatch: false,
      settlement: false,
      gateOpening: false,
      funding: false,
    }),
  });
  assertWalletSessionRouteDeploymentPostflightIsSecretFree(verification);
  verifiedPostflights.add(verification);
  return verification;
}

export function buildWalletSessionRouteDeploymentPostflightSummary(verification) {
  if (!verifiedPostflights.has(verification)) {
    throw new Error("wallet session route postflight provenance is invalid");
  }
  return Object.freeze({
    schema: "treeswap.wallet-session-route-deployment-postflight-summary.v1",
    status: verification.status,
    scope: verification.scope,
    evidenceDigest: verification.evidenceDigest,
    recordDigest: verification.recordDigest,
    attestationDigest: verification.attestationDigest,
    sourceBranch: verification.record.sourceBranch,
    sourceCommit: verification.record.sourceCommit,
    preflightEvidenceDigest: verification.record.preflightEvidenceDigest,
    planDigest: verification.record.planDigest,
    configurationDigest: verification.record.configurationDigest,
    observerSetDigest: verification.record.observerSetDigest,
    reportSetDigest: verification.record.reportSetDigest,
    observerCount: verification.observerCount,
    deployedAt: verification.record.deployedAt,
    observedFrom: verification.record.observedFrom,
    observedThrough: verification.record.observedThrough,
    attestedFrom: verification.attestedFrom,
    attestedThrough: verification.attestedThrough,
    validUntil: verification.record.validUntil,
    verifiedAt: verification.verifiedAt,
    attestedClaims: verification.attestedClaims,
    externalVerification: verification.externalVerification,
    authorizations: verification.authorizations,
  });
}
