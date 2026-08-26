import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import {
  buildWalletSessionRouteDeploymentLiveReviewEvidence,
} from "./wallet-session-route-deployment-postflight.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const MINIMUM_MONITORING_WINDOW_SECONDS = 24 * 60 * 60;
const MAXIMUM_REVIEW_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAXIMUM_REVIEW_LIFETIME_SECONDS = 24 * 60 * 60;
const MAXIMUM_CLOCK_SKEW_SECONDS = 120;

export const WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES = Object.freeze([
  "platform-control-live-reviewer",
  "wallet-security-live-reviewer",
  "privacy-operations-live-reviewer",
]);

export const WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_CONTROLS = Object.freeze({
  "platform-control-live-reviewer": Object.freeze([
    "direct-platform-api-query-confirms-exact-reviewed-source-and-deployment-identity",
    "direct-access-policy-query-confirms-owner-only-private-access-with-no-bypass",
    "direct-binding-query-confirms-only-the-approved-non-production-d1-copy",
    "direct-runtime-query-confirms-four-distinct-planned-key-identities",
    "direct-version-query-confirms-no-retiring-initial-key-and-old-version-retirement",
    "direct-cache-and-routing-checks-confirm-private-version-pinning",
    "retained-platform-artifacts-and-custody-records-are-inspected",
  ]),
  "wallet-security-live-reviewer": Object.freeze([
    "fixed-edge-tls-and-private-route-identity-are-reproduced-directly",
    "active-and-inactive-session-reads-are-reproduced-with-exact-signature-binding",
    "forged-unknown-stale-mutated-and-replayed-material-fails-closed",
    "d1-outage-latency-clock-and-route-failure-close-wallet-admission",
    "current-retiring-and-expired-key-rotation-is-reproduced",
    "reader-performs-no-retry-wallet-lightning-settlement-or-funding-action",
    "browser-bundle-exclusion-and-single-edge-ownership-are-reproduced",
  ]),
  "privacy-operations-live-reviewer": Object.freeze([
    "request-and-response-body-suppression-is-verified-at-every-retention-layer",
    "retained-telemetry-excludes-wallet-session-key-and-token-identifiers",
    "d1-access-least-privilege-backup-restore-and-purge-evidence-is-inspected",
    "observer-operator-and-reviewer-real-world-independence-evidence-is-inspected",
    "continuous-private-monitoring-window-meets-the-required-duration",
    "monitor-outage-version-retirement-key-compromise-and-d1-outage-drills-are-inspected",
    "all-retained-artifacts-custody-records-and-findings-dispositions-are-inspected",
  ]),
});

const POLICY_FIELDS = Object.freeze([
  "configurationDigest",
  "environment",
  "monitoringWindowEndedAt",
  "monitoringWindowStartedAt",
  "postflightEvidenceDigest",
  "postflightRecordDigest",
  "preparedAt",
  "reviewApprovers",
  "schema",
  "scope",
  "sourceBranch",
  "sourceCommit",
  "status",
  "validUntil",
]);
const REVIEWER_FIELDS = Object.freeze([
  "identityEvidenceDigest",
  "organizationId",
  "reviewerId",
  "role",
  "signer",
]);
const REPORT_FIELDS = Object.freeze([
  "controlSetDigest",
  "directPlatformQueryDigest",
  "directReproductionDigest",
  "findingCounts",
  "findingsDispositionDigest",
  "independenceEvidenceDigest",
  "monitoringEvidenceDigest",
  "reportDigest",
  "retainedArtifactInspectionDigest",
  "reviewId",
  "reviewedAt",
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
const ATTESTATION_FIELDS = Object.freeze([
  "attestedAt",
  "reviewerId",
  "role",
  "signature",
  "signer",
]);
const verifiedLiveReviews = new WeakMap();

export const WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_TYPES = Object.freeze({
  WalletSessionRouteDeploymentLiveReview: Object.freeze([
    Object.freeze({ name: "postflightEvidenceDigest", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "configurationDigest", type: "bytes32" }),
    Object.freeze({ name: "reviewerSetDigest", type: "bytes32" }),
    Object.freeze({ name: "reportSetDigest", type: "bytes32" }),
    Object.freeze({ name: "sourceCommit", type: "bytes20" }),
    Object.freeze({ name: "reviewerRole", type: "bytes32" }),
    Object.freeze({ name: "reviewerId", type: "bytes32" }),
    Object.freeze({ name: "reviewedAt", type: "uint64" }),
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
    throw new TypeError("wallet session route live review source commit is invalid");
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

function requireDistinct(values, name) {
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
    throw new Error(`${name} must be globally distinct`);
  }
}

function controlSetDigest(role) {
  return valueDigest(WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_CONTROLS[role]);
}

export function walletSessionRouteDeploymentLiveReviewControlSetDigest(role) {
  if (!WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES.includes(role)) {
    throw new TypeError("wallet session route live review role is invalid");
  }
  return controlSetDigest(role);
}

function normalizeReviewers(raw, postflight) {
  const source = exactArray(
    raw,
    WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES.length,
    "wallet session route live reviewers",
  );
  const reviewers = source.map((rawReviewer, index) => {
    const reviewer = exactRecord(rawReviewer, REVIEWER_FIELDS, `live reviewer ${index}`);
    return Object.freeze({
      role: typeof reviewer.role === "string" ? reviewer.role : "",
      reviewerId: digest(reviewer.reviewerId, `reviewApprovers[${index}].reviewerId`),
      organizationId: digest(reviewer.organizationId, `reviewApprovers[${index}].organizationId`),
      identityEvidenceDigest: digest(
        reviewer.identityEvidenceDigest,
        `reviewApprovers[${index}].identityEvidenceDigest`,
      ),
      signer: address(reviewer.signer, `reviewApprovers[${index}].signer`),
    });
  });
  if (reviewers.some((reviewer, index) => (
    reviewer.role !== WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES[index]
  ))) {
    throw new Error("wallet session route live reviewers must use exact canonical roles");
  }
  const commitments = reviewers.flatMap((reviewer) => [
    reviewer.reviewerId,
    reviewer.organizationId,
    reviewer.identityEvidenceDigest,
  ]);
  requireDistinct(commitments, "wallet session route live reviewer commitments");
  requireDistinct(reviewers.map((reviewer) => reviewer.signer), "wallet session route live reviewer signers");
  const upstreamParticipants = [
    ...postflight.reviewers,
    ...postflight.operators,
    ...postflight.observers,
  ];
  const upstreamCommitments = upstreamParticipants.flatMap((participant) => [
    participant.reviewerId ?? participant.participantId ?? participant.observerId,
    participant.organizationId,
    participant.identityEvidenceDigest,
  ]);
  const upstreamSigners = new Set(upstreamParticipants.map((participant) => participant.signer.toLowerCase()));
  if (commitments.some((value) => upstreamCommitments.includes(value))) {
    throw new Error("wallet session route live reviewers may not reuse upstream participant commitments");
  }
  if (reviewers.some((reviewer) => upstreamSigners.has(reviewer.signer.toLowerCase()))) {
    throw new Error("wallet session route live reviewers may not reuse upstream participant signers");
  }
  return Object.freeze(reviewers);
}

function normalizePolicy(raw, postflight, observedAt) {
  const source = exactRecord(raw, POLICY_FIELDS, "wallet session route live review policy");
  if (source.schema !== "treeswap.wallet-session-route-deployment-live-review-policy.v1"
      || source.status !== "independent-live-review-planned-no-activation-authority"
      || source.scope !== "live-review-only-no-deployment-dispatch-settlement-gate-opening-or-funding-authorization"
      || source.environment !== "closed-test"
      || source.sourceBranch !== postflight.sourceBranch
      || sourceCommit(source.sourceCommit) !== postflight.sourceCommit
      || digest(source.postflightEvidenceDigest, "live review postflightEvidenceDigest")
        !== postflight.evidenceDigest
      || digest(source.postflightRecordDigest, "live review postflightRecordDigest")
        !== postflight.recordDigest
      || digest(source.configurationDigest, "live review configurationDigest")
        !== postflight.configurationDigest) {
    throw new Error("wallet session route live review policy identity is invalid");
  }
  const monitoringWindowStartedAt = safeInteger(
    source.monitoringWindowStartedAt,
    "live review monitoringWindowStartedAt",
    { positive: true },
  );
  const monitoringWindowEndedAt = safeInteger(
    source.monitoringWindowEndedAt,
    "live review monitoringWindowEndedAt",
    { positive: true },
  );
  const preparedAt = safeInteger(source.preparedAt, "live review preparedAt", { positive: true });
  const validUntil = safeInteger(source.validUntil, "live review validUntil", { positive: true });
  if (monitoringWindowStartedAt < postflight.deployedAt
      || monitoringWindowEndedAt - monitoringWindowStartedAt < MINIMUM_MONITORING_WINDOW_SECONDS
      || monitoringWindowEndedAt < postflight.attestedThrough
      || monitoringWindowEndedAt > postflight.attestedThrough + MAXIMUM_REVIEW_DELAY_SECONDS
      || preparedAt < monitoringWindowEndedAt
      || preparedAt > postflight.attestedThrough + MAXIMUM_REVIEW_DELAY_SECONDS
      || preparedAt > observedAt + MAXIMUM_CLOCK_SKEW_SECONDS
      || validUntil <= preparedAt
      || validUntil - preparedAt > MAXIMUM_REVIEW_LIFETIME_SECONDS) {
    throw new Error("wallet session route live review timing is invalid");
  }
  const reviewers = normalizeReviewers(source.reviewApprovers, postflight);
  return Object.freeze({
    schema: source.schema,
    status: source.status,
    scope: source.scope,
    environment: source.environment,
    sourceBranch: postflight.sourceBranch,
    sourceCommit: postflight.sourceCommit,
    postflightEvidenceDigest: postflight.evidenceDigest,
    postflightRecordDigest: postflight.recordDigest,
    configurationDigest: postflight.configurationDigest,
    monitoringWindowStartedAt,
    monitoringWindowEndedAt,
    preparedAt,
    validUntil,
    reviewApprovers: reviewers,
  });
}

function normalizeFindingCounts(raw, index) {
  const source = exactRecord(raw, FINDING_FIELDS, `live reports[${index}].findingCounts`);
  const counts = Object.freeze(Object.fromEntries(FINDING_FIELDS.map((field) => [
    field,
    safeInteger(source[field], `live reports[${index}].findingCounts.${field}`, { maximum: 100 }),
  ])));
  if (counts.critical !== 0 || counts.high !== 0 || counts.medium !== 0 || counts.open !== 0) {
    throw new Error("wallet session route live review requires zero critical, high, medium, and open findings");
  }
  return counts;
}

function normalizeReports(raw, policy, postflight, observedAt) {
  const source = exactArray(
    raw,
    WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES.length,
    "wallet session route live review reports",
  );
  const reports = source.map((rawReport, index) => {
    const report = exactRecord(rawReport, REPORT_FIELDS, `live report ${index}`);
    const role = typeof report.role === "string" ? report.role : "";
    if (role !== WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES[index]
        || report.schema !== "treeswap.wallet-session-route-deployment-live-review-report.v1"
        || report.status !== "independent-live-controls-passed-no-open-findings"
        || digest(report.controlSetDigest, `live reports[${index}].controlSetDigest`)
          !== controlSetDigest(role)) {
      throw new Error("wallet session route live review report identity or control set is invalid");
    }
    const reviewedAt = safeInteger(report.reviewedAt, `live reports[${index}].reviewedAt`, {
      positive: true,
    });
    const validUntil = safeInteger(report.validUntil, `live reports[${index}].validUntil`, {
      positive: true,
    });
    if (reviewedAt < policy.preparedAt
        || reviewedAt > observedAt + MAXIMUM_CLOCK_SKEW_SECONDS
        || validUntil <= reviewedAt
        || validUntil - reviewedAt > MAXIMUM_REVIEW_LIFETIME_SECONDS
        || validUntil > policy.validUntil) {
      throw new Error("wallet session route live review report timing is invalid");
    }
    return Object.freeze({
      schema: report.schema,
      status: report.status,
      role,
      reviewId: digest(report.reviewId, `live reports[${index}].reviewId`),
      reportDigest: digest(report.reportDigest, `live reports[${index}].reportDigest`),
      controlSetDigest: controlSetDigest(role),
      directPlatformQueryDigest: digest(
        report.directPlatformQueryDigest,
        `live reports[${index}].directPlatformQueryDigest`,
      ),
      retainedArtifactInspectionDigest: digest(
        report.retainedArtifactInspectionDigest,
        `live reports[${index}].retainedArtifactInspectionDigest`,
      ),
      independenceEvidenceDigest: digest(
        report.independenceEvidenceDigest,
        `live reports[${index}].independenceEvidenceDigest`,
      ),
      directReproductionDigest: digest(
        report.directReproductionDigest,
        `live reports[${index}].directReproductionDigest`,
      ),
      monitoringEvidenceDigest: digest(
        report.monitoringEvidenceDigest,
        `live reports[${index}].monitoringEvidenceDigest`,
      ),
      findingsDispositionDigest: digest(
        report.findingsDispositionDigest,
        `live reports[${index}].findingsDispositionDigest`,
      ),
      findingCounts: normalizeFindingCounts(report.findingCounts, index),
      reviewedAt,
      validUntil,
    });
  });
  const evidenceCommitments = reports.flatMap((report) => [
    report.reviewId,
    report.reportDigest,
    report.controlSetDigest,
    report.directPlatformQueryDigest,
    report.retainedArtifactInspectionDigest,
    report.independenceEvidenceDigest,
    report.directReproductionDigest,
    report.monitoringEvidenceDigest,
    report.findingsDispositionDigest,
  ]);
  const upstreamCommitments = [
    postflight.evidenceDigest,
    postflight.recordDigest,
    postflight.attestationDigest,
    postflight.preflightEvidenceDigest,
    postflight.planDigest,
    postflight.configurationDigest,
    ...postflight.reviewers.flatMap((participant) => [
      participant.reviewerId,
      participant.organizationId,
      participant.identityEvidenceDigest,
    ]),
    ...postflight.operators.flatMap((participant) => [
      participant.participantId,
      participant.organizationId,
      participant.identityEvidenceDigest,
    ]),
    ...postflight.observers.flatMap((participant) => [
      participant.observerId,
      participant.organizationId,
      participant.identityEvidenceDigest,
    ]),
    ...postflight.reports.flatMap((report) => [
      report.controlSetDigest,
      report.collectionMethodDigest,
      report.evidenceArtifactDigest,
      report.evidenceCustodyDigest,
      report.findingsDispositionDigest,
    ]),
    ...policy.reviewApprovers.flatMap((reviewer) => [
      reviewer.reviewerId,
      reviewer.organizationId,
      reviewer.identityEvidenceDigest,
    ]),
  ];
  requireDistinct(
    [...upstreamCommitments, ...evidenceCommitments],
    "wallet session route live review upstream and evidence commitments",
  );
  return Object.freeze(reports);
}

export function assertWalletSessionRouteDeploymentLiveReviewIsSecretFree(value) {
  const forbiddenKey = /(?:authorization(?!s)|cookie|email|invoice|macaroon|mnemonic|password|preimage|private.?key|public.?key|rpc.?url|secret|session.?token|token.?hash|wallet.?address)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      const values = exactArray(entry, entry.length, "wallet session route live review array");
      for (const item of values) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string"
          && (/-----BEGIN [A-Z ]*KEY-----/.test(entry)
            || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)
            || /(?:https?|wss?):\/\//i.test(entry))) {
        throw new Error("wallet session route live review contains secret or endpoint material");
      }
      return;
    }
    const prototype = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null)
        || keys.some((key) => typeof key !== "string")) {
      throw new Error("wallet session route live review contains non-data material");
    }
    for (const key of keys) {
      if (forbiddenKey.test(key)) {
        throw new Error(`wallet session route live review contains forbidden field ${key}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new Error("wallet session route live review contains non-data material");
      }
      visit(descriptor.value);
    }
  };
  visit(value);
  return true;
}

export function prepareWalletSessionRouteDeploymentLiveReview({
  deploymentPostflightVerification,
  policy,
  reports,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const postflight = buildWalletSessionRouteDeploymentLiveReviewEvidence(
    deploymentPostflightVerification,
  );
  const now = safeInteger(observedAt, "wallet session route live review observation time", {
    positive: true,
  });
  if (Object.values(postflight.externalVerification).some((value) => value !== false)
      || Object.values(postflight.authorizations).some((value) => value !== false)) {
    throw new Error("wallet session route postflight supplied unexpected external proof or authority");
  }
  const normalizedPolicy = normalizePolicy(policy, postflight, now);
  const normalizedReports = normalizeReports(reports, normalizedPolicy, postflight, now);
  const reviewedFrom = Math.min(...normalizedReports.map((report) => report.reviewedAt));
  const reviewedThrough = Math.max(...normalizedReports.map((report) => report.reviewedAt));
  const validUntil = Math.min(...normalizedReports.map((report) => report.validUntil));
  const record = Object.freeze({
    schema: "treeswap.wallet-session-route-deployment-live-review-record.v1",
    status: "three-independent-live-reports-prepared-awaiting-attestations",
    scope: "signed-review-claims-only-verifier-does-not-query-platform-or-inspect-artifacts",
    environment: "closed-test",
    sourceBranch: postflight.sourceBranch,
    sourceCommit: postflight.sourceCommit,
    postflightEvidenceDigest: postflight.evidenceDigest,
    postflightRecordDigest: postflight.recordDigest,
    postflightAttestationDigest: postflight.attestationDigest,
    configurationDigest: postflight.configurationDigest,
    reviewerSetDigest: valueDigest(normalizedPolicy.reviewApprovers),
    reportSetDigest: valueDigest(normalizedReports),
    monitoringWindowStartedAt: normalizedPolicy.monitoringWindowStartedAt,
    monitoringWindowEndedAt: normalizedPolicy.monitoringWindowEndedAt,
    reviewedFrom,
    reviewedThrough,
    validUntil,
  });
  const candidate = Object.freeze({
    schema: "treeswap.prepared-wallet-session-route-deployment-live-review.v1",
    status: "live-review-claims-reconstructed-awaiting-three-reviewer-attestations",
    scope: "no-platform-query-signing-deployment-dispatch-settlement-gate-opening-or-funding-authorization",
    recordDigest: valueDigest(record),
    policyDigest: valueDigest(normalizedPolicy),
    record,
    policy: normalizedPolicy,
    reports: normalizedReports,
    postflight,
  });
  assertWalletSessionRouteDeploymentLiveReviewIsSecretFree(candidate);
  return candidate;
}

export function walletSessionRouteDeploymentLiveReviewDomain(candidate) {
  return Object.freeze({
    name: "TreeSwap Wallet Session Route Deployment Live Review",
    version: "1",
    salt: candidate.record.postflightEvidenceDigest,
  });
}

export function buildWalletSessionRouteDeploymentLiveReviewMessage({
  deploymentPostflightVerification,
  policy,
  reports,
  role,
  attestedAt,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const candidate = prepareWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification,
    policy,
    reports,
    observedAt,
  });
  const reviewerIndex = candidate.policy.reviewApprovers.findIndex((value) => value.role === role);
  const reviewer = candidate.policy.reviewApprovers[reviewerIndex];
  if (!reviewer) throw new Error("wallet session route live review role is not in the reviewer set");
  const signedAt = safeInteger(
    attestedAt ?? observedAt,
    "wallet session route live review attestation time",
    { positive: true },
  );
  if (signedAt < candidate.reports[reviewerIndex].reviewedAt
      || signedAt > observedAt
      || signedAt > candidate.record.validUntil) {
    throw new Error("wallet session route live review attestation time is invalid");
  }
  return Object.freeze({
    domain: walletSessionRouteDeploymentLiveReviewDomain(candidate),
    types: WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_TYPES,
    value: Object.freeze({
      postflightEvidenceDigest: candidate.record.postflightEvidenceDigest,
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      configurationDigest: candidate.record.configurationDigest,
      reviewerSetDigest: candidate.record.reviewerSetDigest,
      reportSetDigest: candidate.record.reportSetDigest,
      sourceCommit: `0x${candidate.record.sourceCommit}`,
      reviewerRole: keccak256(toUtf8Bytes(role)).toLowerCase(),
      reviewerId: reviewer.reviewerId,
      reviewedAt: candidate.reports[reviewerIndex].reviewedAt,
      attestedAt: signedAt,
      validUntil: candidate.record.validUntil,
    }),
  });
}

function normalizeAttestations(raw) {
  const source = exactArray(
    raw,
    WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES.length,
    "wallet session route live review attestations",
  );
  const attestations = source.map((rawAttestation, index) => {
    const attestation = exactRecord(rawAttestation, ATTESTATION_FIELDS, `live attestation ${index}`);
    if (typeof attestation.signature !== "string" || !isHexString(attestation.signature)
        || ![64, 65].includes((attestation.signature.length - 2) / 2)) {
      throw new TypeError(`wallet session route live review attestation ${index} signature is invalid`);
    }
    return Object.freeze({
      role: typeof attestation.role === "string" ? attestation.role : "",
      reviewerId: digest(attestation.reviewerId, `live attestations[${index}].reviewerId`),
      signer: address(attestation.signer, `live attestations[${index}].signer`),
      attestedAt: safeInteger(
        attestation.attestedAt,
        `live attestations[${index}].attestedAt`,
        { positive: true },
      ),
      signature: attestation.signature.toLowerCase(),
    });
  });
  if (attestations.some((attestation, index) => (
    attestation.role !== WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW_ROLES[index]
  ))) {
    throw new Error("wallet session route live review attestations must use exact canonical roles");
  }
  requireDistinct(attestations.map((value) => value.reviewerId), "live review attestation identities");
  requireDistinct(attestations.map((value) => value.signer), "live review attestation signers");
  return Object.freeze(attestations);
}

export function verifyWalletSessionRouteDeploymentLiveReview({
  deploymentPostflightVerification,
  policy,
  reports,
  attestations,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const now = safeInteger(observedAt, "wallet session route live review observation time", {
    positive: true,
  });
  const candidate = prepareWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification,
    policy,
    reports,
    observedAt: now,
  });
  if (now < candidate.record.reviewedThrough) throw new Error("wallet session route live review is from the future");
  if (now > candidate.record.validUntil) throw new Error("wallet session route live review is expired");
  const normalizedAttestations = normalizeAttestations(attestations);
  for (let index = 0; index < normalizedAttestations.length; index += 1) {
    const attestation = normalizedAttestations[index];
    const reviewer = candidate.policy.reviewApprovers[index];
    if (attestation.role !== reviewer.role || attestation.reviewerId !== reviewer.reviewerId
        || attestation.signer !== reviewer.signer) {
      throw new Error("wallet session route live review attestation does not match its reviewer");
    }
    if (attestation.attestedAt < candidate.reports[index].reviewedAt
        || attestation.attestedAt > now
        || attestation.attestedAt > candidate.record.validUntil) {
      throw new Error("wallet session route live review attestation time is invalid");
    }
    const typed = buildWalletSessionRouteDeploymentLiveReviewMessage({
      deploymentPostflightVerification,
      policy,
      reports,
      role: reviewer.role,
      attestedAt: attestation.attestedAt,
      observedAt: now,
    });
    let recovered;
    try {
      recovered = getAddress(verifyTypedData(typed.domain, typed.types, typed.value, attestation.signature));
    } catch {
      throw new Error("wallet session route live review attestation signature is invalid");
    }
    if (recovered !== reviewer.signer) {
      throw new Error("wallet session route live review attestation signature is invalid");
    }
  }
  const attestationDigest = valueDigest(normalizedAttestations.map((attestation) => ({
    role: attestation.role,
    reviewerId: attestation.reviewerId,
    signer: attestation.signer,
    attestedAt: attestation.attestedAt,
    signatureDigest: valueDigest(attestation.signature),
  })));
  const verification = Object.freeze({
    schema: "treeswap.verified-wallet-session-route-deployment-live-review.v1",
    status: "three-live-review-attestations-verified-broader-release-readiness-still-required",
    scope: "signed-review-claims-only-no-platform-query-deployment-dispatch-settlement-gate-opening-or-funding-authorization",
    evidenceDigest: valueDigest({
      schema: "treeswap.wallet-session-route-deployment-live-review-binding.v1",
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      attestationDigest,
    }),
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    attestationDigest,
    record: candidate.record,
    reviewerCount: candidate.policy.reviewApprovers.length,
    attestedFrom: Math.min(...normalizedAttestations.map((value) => value.attestedAt)),
    attestedThrough: Math.max(...normalizedAttestations.map((value) => value.attestedAt)),
    verifiedAt: now,
    attestedReviewConclusions: Object.freeze({
      exactPlatformSourceAndConfigurationDirectlyChecked: true,
      retainedArtifactContentsAndCustodyInspected: true,
      observerOperatorAndReviewerIndependenceExamined: true,
      continuousMonitoringWindowExamined: true,
      failureRotationPrivacyAndIncidentControlsReproduced: true,
      zeroCriticalHighMediumOrOpenFindings: true,
    }),
    verifierLimitations: Object.freeze({
      platformApiQueriedByVerifier: false,
      retainedArtifactContentsInspectedByVerifier: false,
      realWorldIndependenceEstablishedByVerifier: false,
      monitoringWindowObservedByVerifier: false,
      reviewerCompetenceEstablishedByVerifier: false,
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
  assertWalletSessionRouteDeploymentLiveReviewIsSecretFree(verification);
  verifiedLiveReviews.set(verification, candidate);
  return verification;
}

export function buildWalletSessionRouteDeploymentLiveReviewSummary(verification) {
  if (!verifiedLiveReviews.has(verification)) {
    throw new Error("wallet session route deployment live review provenance is invalid");
  }
  return Object.freeze({
    schema: "treeswap.wallet-session-route-deployment-live-review-summary.v1",
    status: verification.status,
    scope: verification.scope,
    evidenceDigest: verification.evidenceDigest,
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    attestationDigest: verification.attestationDigest,
    sourceBranch: verification.record.sourceBranch,
    sourceCommit: verification.record.sourceCommit,
    postflightEvidenceDigest: verification.record.postflightEvidenceDigest,
    postflightRecordDigest: verification.record.postflightRecordDigest,
    postflightAttestationDigest: verification.record.postflightAttestationDigest,
    configurationDigest: verification.record.configurationDigest,
    reviewerSetDigest: verification.record.reviewerSetDigest,
    reportSetDigest: verification.record.reportSetDigest,
    reviewerCount: verification.reviewerCount,
    monitoringWindowStartedAt: verification.record.monitoringWindowStartedAt,
    monitoringWindowEndedAt: verification.record.monitoringWindowEndedAt,
    reviewedFrom: verification.record.reviewedFrom,
    reviewedThrough: verification.record.reviewedThrough,
    attestedFrom: verification.attestedFrom,
    attestedThrough: verification.attestedThrough,
    validUntil: verification.record.validUntil,
    verifiedAt: verification.verifiedAt,
    attestedReviewConclusions: verification.attestedReviewConclusions,
    verifierLimitations: verification.verifierLimitations,
    authorizations: verification.authorizations,
  });
}
