import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { buildWalletSessionRouteReviewDeploymentEvidence } from "./wallet-session-route-review.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const MAXIMUM_PLAN_LIFETIME_SECONDS = 60 * 60;
const MAXIMUM_CLOCK_SKEW_SECONDS = 120;

export const WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES = Object.freeze([
  "sites-deployment-owner",
  "wallet-edge-operations-owner",
]);

const PLAN_FIELDS = Object.freeze([
  "access",
  "bindings",
  "controlCommitments",
  "dataHandling",
  "environment",
  "participants",
  "preparedAt",
  "routePath",
  "runtime",
  "schema",
  "scope",
  "sourceBranch",
  "sourceCommit",
  "status",
  "validUntil",
]);
const ACCESS_FIELDS = Object.freeze([
  "accessClass",
  "anonymousAccess",
  "externalVisitorCount",
  "ownerCount",
  "publicBypass",
  "workspaceGroupCount",
]);
const BINDING_FIELDS = Object.freeze([
  "d1Binding",
  "d1DataClass",
  "d1MigrationRequired",
  "r2Binding",
  "schemaChangeRequired",
]);
const RUNTIME_FIELDS = Object.freeze([
  "apiOriginDigest",
  "currentRequesterKeyId",
  "currentResponseKeyId",
  "deploymentIdDigest",
  "gatewayRequesterKeyId",
  "gatewayResponseKeyId",
  "processEnvironmentFallbackAllowed",
  "retiringCredentialSlotConfigured",
  "routeMode",
  "runtimeValuesSource",
]);
const DATA_HANDLING_FIELDS = Object.freeze([
  "analyticsBodyCapture",
  "cdnCaching",
  "errorBodyRetention",
  "requestBodyLogging",
  "requestBodyPersistence",
  "responseBodyLogging",
  "responseBodyPersistence",
  "tracingBodyCapture",
  "trafficCapture",
]);
const CONTROL_FIELDS = Object.freeze([
  "accessPolicyDigest",
  "bodyHandlingPolicyDigest",
  "d1AccessPolicyDigest",
  "d1BackupRestorePolicyDigest",
  "d1PurgePolicyDigest",
  "incidentDrillPolicyDigest",
  "keyCustodyPolicyDigest",
  "monitoringPolicyDigest",
  "versionRetirementPolicyDigest",
]);
const PARTICIPANT_FIELDS = Object.freeze([
  "identityEvidenceDigest",
  "organizationId",
  "participantId",
  "role",
  "signer",
]);
const ATTESTATION_FIELDS = Object.freeze(["attestedAt", "participantId", "role", "signature", "signer"]);
const verifiedPreflights = new WeakMap();

export const WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_TYPES = Object.freeze({
  WalletSessionRouteDeploymentPreflight: Object.freeze([
    Object.freeze({ name: "reviewEvidenceDigest", type: "bytes32" }),
    Object.freeze({ name: "reviewAttestedThrough", type: "uint64" }),
    Object.freeze({ name: "planDigest", type: "bytes32" }),
    Object.freeze({ name: "configurationDigest", type: "bytes32" }),
    Object.freeze({ name: "participantSetDigest", type: "bytes32" }),
    Object.freeze({ name: "sourceCommit", type: "bytes20" }),
    Object.freeze({ name: "participantRole", type: "bytes32" }),
    Object.freeze({ name: "participantId", type: "bytes32" }),
    Object.freeze({ name: "attestedAt", type: "uint64" }),
    Object.freeze({ name: "preparedAt", type: "uint64" }),
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

function keyId(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.toLowerCase();
  if (!SHA256.test(normalized) || normalized === `sha256:${"00".repeat(32)}`) {
    throw new TypeError(`${name} must be a nonzero lowercase SHA-256 key ID`);
  }
  return normalized;
}

function sourceCommit(value) {
  if (typeof value !== "string") throw new TypeError("wallet session deployment source commit is invalid");
  const normalized = value;
  if (!COMMIT.test(normalized)) throw new TypeError("wallet session deployment source commit is invalid");
  return normalized;
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

function exactFalseRecord(raw, fields, name) {
  const source = exactRecord(raw, fields, name);
  for (const field of fields) {
    if (source[field] !== false) throw new Error(`${name} must keep ${field} disabled`);
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, false])));
}

function requireDistinct(values, name) {
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
    throw new Error(`${name} must be globally distinct`);
  }
}

function normalizeParticipants(raw) {
  const source = exactArray(
    raw,
    WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES.length,
    "wallet session deployment participants",
  );
  const participants = source.map((rawParticipant, index) => {
    const participant = exactRecord(
      rawParticipant,
      PARTICIPANT_FIELDS,
      `wallet session deployment participant ${index}`,
    );
    return Object.freeze({
      role: typeof participant.role === "string" ? participant.role : "",
      participantId: digest(participant.participantId, `participants[${index}].participantId`),
      organizationId: digest(participant.organizationId, `participants[${index}].organizationId`),
      identityEvidenceDigest: digest(
        participant.identityEvidenceDigest,
        `participants[${index}].identityEvidenceDigest`,
      ),
      signer: address(participant.signer, `participants[${index}].signer`),
    });
  });
  if (participants.some((participant, index) => (
    participant.role !== WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES[index]
  ))) {
    throw new Error("wallet session deployment participants must use both exact roles in canonical order");
  }
  requireDistinct(participants.map((value) => value.signer), "wallet session deployment participant signers");
  requireDistinct(participants.flatMap((value) => [
    value.participantId,
    value.organizationId,
    value.identityEvidenceDigest,
  ]), "wallet session deployment participant commitments");
  return Object.freeze(participants);
}

function normalizePlan(raw, review, observedAt) {
  const source = exactRecord(raw, PLAN_FIELDS, "wallet session route deployment plan");
  if (source.schema !== "treeswap.wallet-session-route-deployment-plan.v1"
      || source.status !== "private-closed-test-deployment-planned-live-evidence-required"
      || source.scope !== "preflight-only-no-deployment-dispatch-settlement-or-funding-authorization"
      || source.environment !== "closed-test"
      || source.routePath !== "/api/internal/wallet-session-read") {
    throw new Error("wallet session route deployment plan identity is invalid");
  }
  if (source.sourceBranch !== review.sourceBranch
      || sourceCommit(source.sourceCommit) !== review.sourceCommit) {
    throw new Error("wallet session route deployment plan does not match the reviewed source");
  }
  const preparedAt = safeInteger(source.preparedAt, "deployment plan preparedAt", { positive: true });
  const validUntil = safeInteger(source.validUntil, "deployment plan validUntil", { positive: true });
  if (preparedAt < review.reviewedAt || preparedAt > observedAt + MAXIMUM_CLOCK_SKEW_SECONDS) {
    throw new Error("wallet session route deployment plan is stale relative to review or future-dated");
  }
  if (validUntil <= preparedAt || validUntil - preparedAt > MAXIMUM_PLAN_LIFETIME_SECONDS
      || validUntil > review.validUntil) {
    throw new Error("wallet session route deployment plan validity exceeds its review boundary");
  }

  const accessSource = exactRecord(source.access, ACCESS_FIELDS, "wallet session deployment access policy");
  if (accessSource.accessClass !== "owner-only-private"
      || accessSource.anonymousAccess !== false
      || accessSource.publicBypass !== false
      || accessSource.externalVisitorCount !== 0
      || accessSource.workspaceGroupCount !== 0
      || accessSource.ownerCount !== WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES.length) {
    throw new Error("wallet session deployment access must be exact owner-only private access");
  }
  const access = Object.freeze({
    accessClass: accessSource.accessClass,
    anonymousAccess: false,
    publicBypass: false,
    externalVisitorCount: 0,
    workspaceGroupCount: 0,
    ownerCount: WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES.length,
  });

  const bindingSource = exactRecord(source.bindings, BINDING_FIELDS, "wallet session deployment bindings");
  if (bindingSource.d1Binding !== "DB"
      || bindingSource.d1DataClass !== "non-production-copy"
      || bindingSource.d1MigrationRequired !== false
      || bindingSource.r2Binding !== null
      || bindingSource.schemaChangeRequired !== false) {
    throw new Error("wallet session deployment bindings must use the existing non-production D1 copy only");
  }
  const bindings = Object.freeze({
    d1Binding: bindingSource.d1Binding,
    d1DataClass: bindingSource.d1DataClass,
    d1MigrationRequired: false,
    r2Binding: null,
    schemaChangeRequired: false,
  });

  const runtimeSource = exactRecord(source.runtime, RUNTIME_FIELDS, "wallet session deployment runtime");
  if (runtimeSource.routeMode !== "closed-test"
      || runtimeSource.runtimeValuesSource !== "sites-runtime-values"
      || runtimeSource.processEnvironmentFallbackAllowed !== false
      || runtimeSource.retiringCredentialSlotConfigured !== false) {
    throw new Error("wallet session deployment runtime must be a fresh closed-test Sites rollout");
  }
  const runtime = Object.freeze({
    routeMode: runtimeSource.routeMode,
    runtimeValuesSource: runtimeSource.runtimeValuesSource,
    processEnvironmentFallbackAllowed: false,
    retiringCredentialSlotConfigured: false,
    apiOriginDigest: digest(runtimeSource.apiOriginDigest, "runtime.apiOriginDigest"),
    deploymentIdDigest: digest(runtimeSource.deploymentIdDigest, "runtime.deploymentIdDigest"),
    currentRequesterKeyId: keyId(runtimeSource.currentRequesterKeyId, "runtime.currentRequesterKeyId"),
    currentResponseKeyId: keyId(runtimeSource.currentResponseKeyId, "runtime.currentResponseKeyId"),
    gatewayRequesterKeyId: keyId(runtimeSource.gatewayRequesterKeyId, "runtime.gatewayRequesterKeyId"),
    gatewayResponseKeyId: keyId(runtimeSource.gatewayResponseKeyId, "runtime.gatewayResponseKeyId"),
  });
  requireDistinct([
    runtime.currentRequesterKeyId,
    runtime.currentResponseKeyId,
    runtime.gatewayRequesterKeyId,
    runtime.gatewayResponseKeyId,
  ], "wallet session and gateway key identities");

  const dataHandling = exactFalseRecord(
    source.dataHandling,
    DATA_HANDLING_FIELDS,
    "wallet session deployment data handling",
  );
  const controlSource = exactRecord(
    source.controlCommitments,
    CONTROL_FIELDS,
    "wallet session deployment control commitments",
  );
  const controlCommitments = Object.freeze(Object.fromEntries(CONTROL_FIELDS.map((field) => [
    field,
    digest(controlSource[field], `controlCommitments.${field}`),
  ])));
  const participants = normalizeParticipants(source.participants);
  const reviewCommitments = review.reviewers.flatMap((reviewer) => [
    reviewer.reviewerId,
    reviewer.organizationId,
    reviewer.identityEvidenceDigest,
  ]);
  const participantCommitments = participants.flatMap((participant) => [
    participant.participantId,
    participant.organizationId,
    participant.identityEvidenceDigest,
  ]);
  const planCommitments = [
    runtime.apiOriginDigest,
    runtime.deploymentIdDigest,
    ...Object.values(controlCommitments),
    ...participantCommitments,
  ];
  requireDistinct(planCommitments, "wallet session deployment plan commitments");
  if (planCommitments.some((value) => reviewCommitments.includes(value))) {
    throw new Error("wallet session deployment commitments may not reuse reviewer commitments");
  }
  const reviewerSigners = new Set(review.reviewers.map((reviewer) => reviewer.signer.toLowerCase()));
  if (participants.some((participant) => reviewerSigners.has(participant.signer.toLowerCase()))) {
    throw new Error("wallet session deployment participants may not reuse reviewer signers");
  }

  return Object.freeze({
    schema: source.schema,
    status: source.status,
    scope: source.scope,
    environment: source.environment,
    sourceBranch: review.sourceBranch,
    sourceCommit: review.sourceCommit,
    routePath: source.routePath,
    preparedAt,
    validUntil,
    access,
    bindings,
    runtime,
    dataHandling,
    controlCommitments,
    participants,
  });
}

export function assertWalletSessionRouteDeploymentPreflightIsSecretFree(value) {
  const forbiddenKey = /(?:authorization(?!s)|cookie|email|invoice|macaroon|mnemonic|password|preimage|private.?key|public.?key|rpc.?url|secret|session.?token|token.?hash|wallet.?address)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      const values = exactArray(
        entry,
        entry.length,
        "wallet session deployment preflight array",
      );
      for (const item of values) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string"
          && (/-----BEGIN [A-Z ]*KEY-----/.test(entry)
            || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)
            || /(?:https?|wss?):\/\//i.test(entry))) {
        throw new Error("wallet session deployment preflight contains secret or endpoint material");
      }
      return;
    }
    const prototype = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null)
        || keys.some((key) => typeof key !== "string")) {
      throw new Error("wallet session deployment preflight contains non-data material");
    }
    for (const key of keys) {
      if (forbiddenKey.test(key)) {
        throw new Error(`wallet session deployment preflight contains forbidden field ${key}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new Error("wallet session deployment preflight contains non-data material");
      }
      visit(descriptor.value);
    }
  };
  visit(value);
  return true;
}

export function prepareWalletSessionRouteDeploymentPreflight({
  routeReviewVerification,
  plan,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const review = buildWalletSessionRouteReviewDeploymentEvidence(routeReviewVerification);
  const now = safeInteger(observedAt, "deployment preflight observation time", { positive: true });
  if (now > review.validUntil) throw new Error("wallet session route review expired before deployment preflight");
  if (Object.values(review.externalEvidence).some((value) => value !== false)
      || Object.values(review.authorizations).some((value) => value !== false)) {
    throw new Error("wallet session route review supplied unexpected deployment authority");
  }
  const normalizedPlan = normalizePlan(plan, review, now);
  const configuration = Object.freeze({
    routePath: normalizedPlan.routePath,
    access: normalizedPlan.access,
    bindings: normalizedPlan.bindings,
    runtime: normalizedPlan.runtime,
    dataHandling: normalizedPlan.dataHandling,
    controlCommitments: normalizedPlan.controlCommitments,
  });
  const record = Object.freeze({
    schema: "treeswap.wallet-session-route-deployment-preflight-record.v1",
    status: "reviewed-private-closed-test-plan-awaiting-two-operator-attestations",
    scope: "preflight-only-live-platform-evidence-and-deployment-still-required",
    environment: normalizedPlan.environment,
    sourceBranch: normalizedPlan.sourceBranch,
    sourceCommit: normalizedPlan.sourceCommit,
    reviewEvidenceDigest: review.evidenceDigest,
    reviewRecordDigest: review.recordDigest,
    reviewPolicyDigest: review.policyDigest,
    reviewAttestedThrough: review.attestedThrough,
    configurationDigest: valueDigest(configuration),
    participantSetDigest: valueDigest(normalizedPlan.participants),
    preparedAt: normalizedPlan.preparedAt,
    validUntil: normalizedPlan.validUntil,
  });
  const candidate = Object.freeze({
    schema: "treeswap.prepared-wallet-session-route-deployment-preflight.v1",
    status: "reviewed-plan-reconstructed-awaiting-two-operator-attestations",
    scope: "preflight-only-no-deployment-signing-dispatch-settlement-gate-opening-or-funding-authorization",
    planDigest: valueDigest(normalizedPlan),
    recordDigest: valueDigest(record),
    record,
    plan: normalizedPlan,
    review,
  });
  assertWalletSessionRouteDeploymentPreflightIsSecretFree(candidate);
  return candidate;
}

export function walletSessionRouteDeploymentPreflightDomain(candidate) {
  return Object.freeze({
    name: "TreeSwap Wallet Session Route Deployment Preflight",
    version: "1",
    salt: candidate.record.reviewEvidenceDigest,
  });
}

export function buildWalletSessionRouteDeploymentPreflightMessage({
  routeReviewVerification,
  plan,
  role,
  attestedAt,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const candidate = prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification,
    plan,
    observedAt,
  });
  const participant = candidate.plan.participants.find((value) => value.role === role);
  if (!participant) throw new Error("wallet session deployment participant role is not in the exact plan");
  const attestationTime = safeInteger(
    attestedAt ?? observedAt,
    "deployment preflight attestedAt",
    { positive: true },
  );
  if (attestationTime < candidate.record.reviewAttestedThrough
      || attestationTime < candidate.record.preparedAt
      || attestationTime >= candidate.record.validUntil
      || attestationTime > observedAt) {
    throw new Error("wallet session deployment attestation time is outside the signed plan window");
  }
  return Object.freeze({
    domain: walletSessionRouteDeploymentPreflightDomain(candidate),
    types: WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_TYPES,
    value: Object.freeze({
      reviewEvidenceDigest: candidate.record.reviewEvidenceDigest,
      reviewAttestedThrough: candidate.record.reviewAttestedThrough,
      planDigest: candidate.planDigest,
      configurationDigest: candidate.record.configurationDigest,
      participantSetDigest: candidate.record.participantSetDigest,
      sourceCommit: `0x${candidate.record.sourceCommit}`,
      participantRole: keccak256(toUtf8Bytes(role)).toLowerCase(),
      participantId: participant.participantId,
      attestedAt: attestationTime,
      preparedAt: candidate.record.preparedAt,
      validUntil: candidate.record.validUntil,
    }),
  });
}

function normalizeAttestationRecords(raw) {
  const source = exactArray(
    raw,
    WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES.length,
    "wallet session deployment preflight attestations",
  );
  const attestations = source.map((rawAttestation, index) => {
    const attestation = exactRecord(
      rawAttestation,
      ATTESTATION_FIELDS,
      `wallet session deployment attestation ${index}`,
    );
    if (typeof attestation.signature !== "string" || !isHexString(attestation.signature)
        || ![64, 65].includes((attestation.signature.length - 2) / 2)) {
      throw new TypeError(`wallet session deployment attestation ${index} signature is invalid`);
    }
    return Object.freeze({
      role: typeof attestation.role === "string" ? attestation.role : "",
      participantId: digest(attestation.participantId, `attestations[${index}].participantId`),
      signer: address(attestation.signer, `attestations[${index}].signer`),
      attestedAt: safeInteger(attestation.attestedAt, `attestations[${index}].attestedAt`, {
        positive: true,
      }),
      signature: attestation.signature.toLowerCase(),
    });
  });
  if (attestations.some((attestation, index) => (
    attestation.role !== WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT_ROLES[index]
  ))) {
    throw new Error("wallet session deployment attestations must use both exact roles in canonical order");
  }
  requireDistinct(attestations.map((value) => value.participantId), "deployment attestation identities");
  requireDistinct(attestations.map((value) => value.signer), "deployment attestation signers");
  return Object.freeze(attestations);
}

function normalizeAttestations(raw, candidate, observedAt) {
  const attestations = normalizeAttestationRecords(raw);
  if (attestations.some((attestation) => (
    attestation.attestedAt < candidate.record.reviewAttestedThrough
      || attestation.attestedAt < candidate.record.preparedAt
      || attestation.attestedAt >= candidate.record.validUntil
      || attestation.attestedAt > observedAt
  ))) {
    throw new Error("wallet session deployment attestation time is outside the signed plan window");
  }
  return attestations;
}

export function verifyWalletSessionRouteDeploymentPreflight({
  routeReviewVerification,
  plan,
  attestations,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const now = safeInteger(observedAt, "deployment preflight observation time", { positive: true });
  const candidate = prepareWalletSessionRouteDeploymentPreflight({
    routeReviewVerification,
    plan,
    observedAt: now,
  });
  if (now < candidate.record.preparedAt) throw new Error("wallet session deployment preflight is from the future");
  if (now > candidate.record.validUntil) throw new Error("wallet session deployment preflight is expired");
  const normalizedAttestations = normalizeAttestations(attestations, candidate, now);
  for (let index = 0; index < normalizedAttestations.length; index += 1) {
    const attestation = normalizedAttestations[index];
    const participant = candidate.plan.participants[index];
    if (attestation.role !== participant.role
        || attestation.participantId !== participant.participantId
        || attestation.signer !== participant.signer) {
      throw new Error("wallet session deployment attestation does not match its plan-pinned participant");
    }
    const typed = buildWalletSessionRouteDeploymentPreflightMessage({
      routeReviewVerification,
      plan,
      role: participant.role,
      attestedAt: attestation.attestedAt,
      observedAt: now,
    });
    let recovered;
    try {
      recovered = getAddress(verifyTypedData(typed.domain, typed.types, typed.value, attestation.signature));
    } catch {
      throw new Error("wallet session deployment preflight attestation signature is invalid");
    }
    if (recovered !== participant.signer) {
      throw new Error("wallet session deployment preflight attestation signature is invalid");
    }
  }
  const attestationDigest = valueDigest(normalizedAttestations.map((value) => ({
    role: value.role,
    participantId: value.participantId,
    signer: value.signer,
    attestedAt: value.attestedAt,
    signatureDigest: valueDigest(value.signature),
  })));
  const attestedFrom = Math.min(...normalizedAttestations.map((value) => value.attestedAt));
  const attestedThrough = Math.max(...normalizedAttestations.map((value) => value.attestedAt));
  const verification = Object.freeze({
    schema: "treeswap.verified-wallet-session-route-deployment-preflight.v1",
    status: "two-operator-private-deployment-preflight-verified-live-platform-evidence-still-required",
    scope: "preflight-only-no-deployment-signing-dispatch-settlement-gate-opening-or-funding-authorization",
    evidenceDigest: valueDigest({
      schema: "treeswap.wallet-session-route-deployment-preflight-binding.v1",
      recordDigest: candidate.recordDigest,
      planDigest: candidate.planDigest,
      attestationDigest,
    }),
    recordDigest: candidate.recordDigest,
    planDigest: candidate.planDigest,
    attestationDigest,
    record: candidate.record,
    plan: candidate.plan,
    participantCount: candidate.plan.participants.length,
    attestedFrom,
    attestedThrough,
    verifiedAt: now,
    externalEvidence: Object.freeze({
      deployedRoute: false,
      liveD1Binding: false,
      liveAccessPolicy: false,
      liveRuntimeValues: false,
      bodyLoggingDisabled: false,
      exactVersionRetirement: false,
      monitoringAndIncidentDrills: false,
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
  assertWalletSessionRouteDeploymentPreflightIsSecretFree(verification);
  verifiedPreflights.set(verification, candidate);
  return verification;
}

export function verifyWalletSessionRouteDeploymentPreflightAtSignedBoundary({
  routeReviewVerification,
  plan,
  attestations,
}) {
  const normalizedAttestations = normalizeAttestationRecords(attestations);
  const signedBoundary = Math.max(...normalizedAttestations.map((attestation) => attestation.attestedAt));
  return verifyWalletSessionRouteDeploymentPreflight({
    routeReviewVerification,
    plan,
    attestations,
    observedAt: signedBoundary,
  });
}

export function buildWalletSessionRouteDeploymentPreflightSummary(verification) {
  if (!verifiedPreflights.has(verification)) {
    throw new Error("wallet session route deployment preflight provenance is invalid");
  }
  return Object.freeze({
    schema: "treeswap.wallet-session-route-deployment-preflight-summary.v1",
    status: verification.status,
    scope: verification.scope,
    evidenceDigest: verification.evidenceDigest,
    recordDigest: verification.recordDigest,
    planDigest: verification.planDigest,
    attestationDigest: verification.attestationDigest,
    sourceBranch: verification.record.sourceBranch,
    sourceCommit: verification.record.sourceCommit,
    reviewEvidenceDigest: verification.record.reviewEvidenceDigest,
    reviewAttestedThrough: verification.record.reviewAttestedThrough,
    configurationDigest: verification.record.configurationDigest,
    participantSetDigest: verification.record.participantSetDigest,
    participantCount: verification.participantCount,
    attestedFrom: verification.attestedFrom,
    attestedThrough: verification.attestedThrough,
    preparedAt: verification.record.preparedAt,
    validUntil: verification.record.validUntil,
    verifiedAt: verification.verifiedAt,
    externalEvidence: verification.externalEvidence,
    authorizations: verification.authorizations,
  });
}

export function buildWalletSessionRouteDeploymentPostflightEvidence(verification) {
  const candidate = verifiedPreflights.get(verification);
  if (!candidate) {
    throw new Error("wallet session route deployment preflight provenance is invalid");
  }
  return Object.freeze({
    schema: "treeswap.wallet-session-route-deployment-postflight-input.v1",
    status: verification.status,
    scope: "verified-private-deployment-plan-input-only-live-observation-and-review-still-required",
    evidenceDigest: verification.evidenceDigest,
    recordDigest: verification.recordDigest,
    planDigest: verification.planDigest,
    reviewEvidenceDigest: verification.record.reviewEvidenceDigest,
    reviewAttestedThrough: verification.record.reviewAttestedThrough,
    sourceBranch: verification.record.sourceBranch,
    sourceCommit: verification.record.sourceCommit,
    configurationDigest: verification.record.configurationDigest,
    preparedAt: verification.record.preparedAt,
    validUntil: verification.record.validUntil,
    attestedFrom: verification.attestedFrom,
    attestedThrough: verification.attestedThrough,
    configuration: Object.freeze({
      routePath: verification.plan.routePath,
      access: verification.plan.access,
      bindings: verification.plan.bindings,
      runtime: verification.plan.runtime,
      dataHandling: verification.plan.dataHandling,
      controlCommitments: verification.plan.controlCommitments,
    }),
    reviewers: candidate.review.reviewers,
    operators: verification.plan.participants,
    externalEvidence: verification.externalEvidence,
    authorizations: verification.authorizations,
  });
}
