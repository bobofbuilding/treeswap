import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";

export const D1_ACCESS_REVIEW_ROLES = Object.freeze([
  "cloudflare-access-security-reviewer",
  "data-privacy-least-privilege-reviewer",
]);

export const D1_ACCESS_PRINCIPAL_PROFILES = Object.freeze([
  Object.freeze({
    role: "account-web-runtime",
    credentialClass: "worker-d1-binding",
    effectiveCapability: "d1-read-write",
    standing: true,
    interactive: false,
    databaseBound: true,
    twoPartyApprovalRequired: false,
    maximumCredentialLifetimeSeconds: 0,
  }),
  Object.freeze({
    role: "wallet-session-provider-runtime",
    credentialClass: "isolated-worker-d1-binding",
    effectiveCapability: "d1-read-write-technically-read-only-by-reviewed-source",
    standing: true,
    interactive: false,
    databaseBound: true,
    twoPartyApprovalRequired: false,
    maximumCredentialLifetimeSeconds: 0,
  }),
  Object.freeze({
    role: "account-maintenance-scheduler",
    credentialClass: "scheduled-worker-d1-and-r2-bindings",
    effectiveCapability: "d1-read-write-and-r2-evidence-write",
    standing: true,
    interactive: false,
    databaseBound: true,
    twoPartyApprovalRequired: false,
    maximumCredentialLifetimeSeconds: 0,
  }),
  Object.freeze({
    role: "account-storage-monitor",
    credentialClass: "isolated-worker-d1-binding",
    effectiveCapability: "d1-read-write-technically-read-only-by-reviewed-source",
    standing: true,
    interactive: false,
    databaseBound: true,
    twoPartyApprovalRequired: false,
    maximumCredentialLifetimeSeconds: 0,
  }),
  Object.freeze({
    role: "backup-export-operator",
    credentialClass: "on-demand-account-owned-api-token",
    effectiveCapability: "account-scoped-d1-read",
    standing: false,
    interactive: false,
    databaseBound: false,
    twoPartyApprovalRequired: true,
    maximumCredentialLifetimeSeconds: 3_600,
  }),
  Object.freeze({
    role: "deployment-operator",
    credentialClass: "phishing-resistant-account-member-session",
    effectiveCapability: "worker-deployment-control-with-transitive-d1-access",
    standing: true,
    interactive: true,
    databaseBound: false,
    twoPartyApprovalRequired: true,
    maximumCredentialLifetimeSeconds: 43_200,
  }),
  Object.freeze({
    role: "access-audit-observer",
    credentialClass: "account-owned-read-api-token",
    effectiveCapability: "permission-policy-membership-token-inventory-and-audit-read",
    standing: true,
    interactive: false,
    databaseBound: false,
    twoPartyApprovalRequired: false,
    maximumCredentialLifetimeSeconds: 86_400,
  }),
  Object.freeze({
    role: "break-glass-recovery-operator",
    credentialClass: "dormant-phishing-resistant-account-member",
    effectiveCapability: "no-standing-d1-capability",
    standing: false,
    interactive: true,
    databaseBound: false,
    twoPartyApprovalRequired: true,
    maximumCredentialLifetimeSeconds: 3_600,
  }),
]);

export const D1_ACCESS_REVIEW_TYPES = Object.freeze({
  D1AccessPolicyReview: Object.freeze([
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "sourceCommit", type: "bytes20" }),
    Object.freeze({ name: "cloudflareAccountDigest", type: "bytes32" }),
    Object.freeze({ name: "databaseDigest", type: "bytes32" }),
    Object.freeze({ name: "principalSetDigest", type: "bytes32" }),
    Object.freeze({ name: "reviewerSetDigest", type: "bytes32" }),
    Object.freeze({ name: "role", type: "bytes32" }),
    Object.freeze({ name: "reviewerId", type: "bytes32" }),
    Object.freeze({ name: "reviewCompletedAt", type: "uint64" }),
    Object.freeze({ name: "attestedAt", type: "uint64" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
  ]),
});

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/;
const VERSION = /^[1-9][0-9]*$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const MAXIMUM_REVIEW_SECONDS = 6 * 60 * 60;
const MAXIMUM_ATTESTATION_LIFETIME_SECONDS = 24 * 60 * 60;

const POLICY_FIELDS = Object.freeze([
  "cloudflareAccountDigest",
  "databaseDigest",
  "dedicatedCloudflareAccount",
  "deploymentVersion",
  "maximumAttestationLifetimeSeconds",
  "maximumReviewSeconds",
  "principals",
  "reviewers",
  "schema",
  "sourceBranch",
  "sourceCommit",
]);
const PRINCIPAL_FIELDS = Object.freeze([
  "credentialClass",
  "credentialCustodyDigest",
  "databaseBound",
  "effectiveCapability",
  "interactive",
  "maximumCredentialLifetimeSeconds",
  "principalId",
  "resourceScopeDigest",
  "role",
  "standing",
  "twoPartyApprovalRequired",
]);
const REVIEWER_FIELDS = Object.freeze([
  "identityEvidenceDigest",
  "organizationId",
  "reviewerId",
  "role",
  "signer",
]);
const RECORD_FIELDS = Object.freeze([
  "accountMemberPoliciesSnapshotDigest",
  "accountOwnedCredentialInventoryDigest",
  "applicationQueryAuditCoverageDigest",
  "controlResults",
  "d1AuditLogCoverageDigest",
  "inheritedPolicyUnionDigest",
  "negativeAuthorityTestsDigest",
  "permissionGroupsSnapshotDigest",
  "principalObservationDigest",
  "reviewCompletedAt",
  "reviewerReports",
  "reviewStartedAt",
  "revocationRotationEvidenceDigest",
  "schema",
  "scope",
  "status",
  "userGroupMembershipSnapshotDigest",
  "workerD1BindingSnapshotDigest",
]);
const CONTROL_FIELDS = Object.freeze([
  "accessAuditCredentialD1QueryDenied",
  "accountOwnedCredentialsEnumerated",
  "applicationQueryAuditCompensationReviewed",
  "backupCredentialWriteDenied",
  "browserD1CredentialsAbsent",
  "deprecatedRolesApiUnused",
  "deploymentCredentialDirectD1QueryDenied",
  "directMemberPoliciesEnumerated",
  "effectivePolicyUnionsReconstructed",
  "globalApiKeysAbsent",
  "inheritedGroupPoliciesEnumerated",
  "maintenanceSchedulerHttpSurfaceAbsent",
  "onDemandCredentialExpiryAndRevocationObserved",
  "permissionGroupsApiUsed",
  "queryLevelD1AuditCoverageClaimed",
  "revokedCredentialDenied",
  "routineStandingHumanDirectD1CredentialsAbsent",
  "runtimeBindingsMatchPolicy",
  "twoPartyActivationEvidenceReviewed",
  "unlistedD1PrincipalsAbsent",
  "userGroupMembershipsEnumerated",
  "userOwnedApiTokensAbsent",
]);
const FINDING_FIELDS = Object.freeze([
  "critical",
  "high",
  "informational",
  "low",
  "medium",
  "open",
]);
const REVIEW_REPORT_FIELDS = Object.freeze([
  "directInspectionEvidenceDigest",
  "findingCounts",
  "findingsDispositionDigest",
  "reportDigest",
  "reviewerId",
  "role",
]);
const ATTESTATION_FIELDS = Object.freeze([
  "attestedAt",
  "reviewerId",
  "role",
  "signature",
  "signer",
]);
const verifiedReviews = new WeakSet();

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

function exactArray(value, length, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length !== length) {
    throw new TypeError(`${name} must contain exactly ${length} entries`);
  }
  const expected = new Set([...Array.from({ length }, (_, index) => String(index)), "length"]);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size
      || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError(`${name} must be a dense undecorated array`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
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
  if (typeof value !== "string" || !BYTES32.test(value) || value === ZERO_DIGEST) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return value;
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  let normalized;
  try { normalized = getAddress(value); } catch { throw new TypeError(`${name} must be an Ethereum address`); }
  if (normalized === ZERO_ADDRESS || normalized !== value) {
    throw new TypeError(`${name} must be a nonzero canonical Ethereum address`);
  }
  return normalized;
}

function branch(value) {
  if (typeof value !== "string" || !BRANCH.test(value) || value.includes("..") || value.includes("//")
      || value.startsWith("-") || value.endsWith(".") || value.endsWith("/")) {
    throw new TypeError("D1 access review source branch is invalid");
  }
  return value;
}

function commit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new TypeError("D1 access review source commit must be a full lowercase Git commit");
  }
  return value;
}

function distinct(values, name) {
  if (new Set(values).size !== values.length) throw new Error(`${name} must be distinct`);
}

function normalizePrincipal(raw, index) {
  const value = exactRecord(raw, PRINCIPAL_FIELDS, `D1 access principals[${index}]`);
  const expected = D1_ACCESS_PRINCIPAL_PROFILES[index];
  for (const field of [
    "role",
    "credentialClass",
    "effectiveCapability",
    "standing",
    "interactive",
    "databaseBound",
    "twoPartyApprovalRequired",
    "maximumCredentialLifetimeSeconds",
  ]) {
    if (value[field] !== expected[field]) {
      throw new Error(`D1 access principal ${expected.role} does not match the exact risk profile`);
    }
  }
  return Object.freeze({
    role: value.role,
    principalId: digest(value.principalId, `D1 access principals[${index}].principalId`),
    credentialClass: value.credentialClass,
    effectiveCapability: value.effectiveCapability,
    standing: value.standing,
    interactive: value.interactive,
    databaseBound: value.databaseBound,
    twoPartyApprovalRequired: value.twoPartyApprovalRequired,
    maximumCredentialLifetimeSeconds: value.maximumCredentialLifetimeSeconds,
    resourceScopeDigest: digest(value.resourceScopeDigest, `D1 access principals[${index}].resourceScopeDigest`),
    credentialCustodyDigest: digest(
      value.credentialCustodyDigest,
      `D1 access principals[${index}].credentialCustodyDigest`,
    ),
  });
}

function normalizeReviewer(raw, index) {
  const value = exactRecord(raw, REVIEWER_FIELDS, `D1 access reviewers[${index}]`);
  if (value.role !== D1_ACCESS_REVIEW_ROLES[index]) {
    throw new Error("D1 access reviewers must use exact canonical roles");
  }
  return Object.freeze({
    role: value.role,
    reviewerId: digest(value.reviewerId, `D1 access reviewers[${index}].reviewerId`),
    organizationId: digest(value.organizationId, `D1 access reviewers[${index}].organizationId`),
    identityEvidenceDigest: digest(
      value.identityEvidenceDigest,
      `D1 access reviewers[${index}].identityEvidenceDigest`,
    ),
    signer: address(value.signer, `D1 access reviewers[${index}].signer`),
  });
}

function normalizePolicy(raw) {
  const value = exactRecord(raw, POLICY_FIELDS, "D1 access review policy");
  if (value.schema !== "treeswap.d1-access-least-privilege-policy.v1"
      || value.dedicatedCloudflareAccount !== true) {
    throw new Error("D1 access review policy identity or account isolation is invalid");
  }
  if (typeof value.deploymentVersion !== "string" || !VERSION.test(value.deploymentVersion)) {
    throw new TypeError("D1 access deployment version is invalid");
  }
  const principals = exactArray(
    value.principals,
    D1_ACCESS_PRINCIPAL_PROFILES.length,
    "D1 access principals",
  ).map(normalizePrincipal);
  const reviewers = exactArray(value.reviewers, D1_ACCESS_REVIEW_ROLES.length, "D1 access reviewers")
    .map(normalizeReviewer);
  distinct(principals.map((entry) => entry.principalId), "D1 access principal identities");
  distinct(principals.map((entry) => entry.resourceScopeDigest), "D1 access principal resource scopes");
  distinct(principals.map((entry) => entry.credentialCustodyDigest), "D1 access credential custody commitments");
  distinct(reviewers.map((entry) => entry.reviewerId), "D1 access reviewer identities");
  distinct(reviewers.map((entry) => entry.organizationId), "D1 access reviewer organizations");
  distinct(reviewers.map((entry) => entry.identityEvidenceDigest), "D1 access reviewer identity evidence");
  distinct(reviewers.map((entry) => entry.signer.toLowerCase()), "D1 access reviewer signers");
  const policy = Object.freeze({
    schema: value.schema,
    sourceBranch: branch(value.sourceBranch),
    sourceCommit: commit(value.sourceCommit),
    deploymentVersion: value.deploymentVersion,
    cloudflareAccountDigest: digest(value.cloudflareAccountDigest, "Cloudflare account digest"),
    databaseDigest: digest(value.databaseDigest, "D1 database digest"),
    dedicatedCloudflareAccount: true,
    maximumReviewSeconds: integer(value.maximumReviewSeconds, "D1 access maximum review seconds", 60, MAXIMUM_REVIEW_SECONDS),
    maximumAttestationLifetimeSeconds: integer(
      value.maximumAttestationLifetimeSeconds,
      "D1 access maximum attestation lifetime seconds",
      60,
      MAXIMUM_ATTESTATION_LIFETIME_SECONDS,
    ),
    principals: Object.freeze(principals),
    reviewers: Object.freeze(reviewers),
  });
  const commitments = [
    policy.cloudflareAccountDigest,
    policy.databaseDigest,
    ...principals.flatMap((entry) => [
      entry.principalId,
      entry.resourceScopeDigest,
      entry.credentialCustodyDigest,
    ]),
    ...reviewers.flatMap((entry) => [
      entry.reviewerId,
      entry.organizationId,
      entry.identityEvidenceDigest,
    ]),
  ];
  distinct(commitments, "D1 access account, database, principal, custody, and reviewer commitments");
  return policy;
}

function normalizeFindingCounts(raw, name = "D1 access finding counts") {
  const value = exactRecord(raw, FINDING_FIELDS, name);
  const counts = Object.freeze(Object.fromEntries(FINDING_FIELDS.map((field) => [
    field,
    integer(value[field], `${name}.${field}`, 0, 10_000),
  ])));
  if (counts.critical !== 0 || counts.high !== 0 || counts.medium !== 0
      || counts.low !== 0 || counts.open !== 0) {
    throw new Error("D1 access review cannot accept unresolved or risk findings");
  }
  return counts;
}

function normalizeReviewerReports(raw, policy) {
  const reports = exactArray(raw, D1_ACCESS_REVIEW_ROLES.length, "D1 access reviewer reports")
    .map((rawReport, index) => {
      const value = exactRecord(rawReport, REVIEW_REPORT_FIELDS, `D1 access reviewerReports[${index}]`);
      const reviewer = policy.reviewers[index];
      if (value.role !== reviewer.role || value.reviewerId !== reviewer.reviewerId) {
        throw new Error("D1 access reviewer reports must match the exact canonical reviewers");
      }
      return Object.freeze({
        role: value.role,
        reviewerId: digest(value.reviewerId, `D1 access reviewerReports[${index}].reviewerId`),
        directInspectionEvidenceDigest: digest(
          value.directInspectionEvidenceDigest,
          `D1 access reviewerReports[${index}].directInspectionEvidenceDigest`,
        ),
        reportDigest: digest(value.reportDigest, `D1 access reviewerReports[${index}].reportDigest`),
        findingsDispositionDigest: digest(
          value.findingsDispositionDigest,
          `D1 access reviewerReports[${index}].findingsDispositionDigest`,
        ),
        findingCounts: normalizeFindingCounts(
          value.findingCounts,
          `D1 access reviewerReports[${index}].findingCounts`,
        ),
      });
    });
  distinct(
    reports.flatMap((entry) => [
      entry.directInspectionEvidenceDigest,
      entry.reportDigest,
      entry.findingsDispositionDigest,
    ]),
    "D1 access reviewer report and inspection commitments",
  );
  return Object.freeze(reports);
}

function normalizeControlResults(raw) {
  const value = exactRecord(raw, CONTROL_FIELDS, "D1 access control results");
  const result = Object.freeze(Object.fromEntries(CONTROL_FIELDS.map((field) => [
    field,
    boolean(value[field], `D1 access controlResults.${field}`),
  ])));
  const falseControls = [
    "queryLevelD1AuditCoverageClaimed",
  ];
  const requiredTrue = CONTROL_FIELDS.filter((field) => !falseControls.includes(field));
  if (requiredTrue.some((field) => result[field] !== true)
      || falseControls.some((field) => result[field] !== false)) {
    throw new Error("D1 access review controls do not satisfy the exact fail-closed policy");
  }
  return result;
}

function normalizeRecord(raw, policy, observedAt) {
  const value = exactRecord(raw, RECORD_FIELDS, "D1 access review record");
  if (value.schema !== "treeswap.d1-access-least-privilege-review-record.v1"
      || value.status !== "exact-cloudflare-access-state-independently-reviewed"
      || value.scope !== "d1-access-review-only-no-platform-mutation-account-enablement-deployment-or-funding-authority") {
    throw new Error("D1 access review record identity is invalid");
  }
  const reviewStartedAt = integer(value.reviewStartedAt, "D1 access review start", 1);
  const reviewCompletedAt = integer(value.reviewCompletedAt, "D1 access review completion", 1);
  if (reviewCompletedAt < reviewStartedAt
      || reviewCompletedAt - reviewStartedAt > policy.maximumReviewSeconds) {
    throw new Error("D1 access review times are not causal or exceed policy");
  }
  if (reviewCompletedAt > observedAt) throw new Error("D1 access review is future-dated");
  const reviewerReports = normalizeReviewerReports(value.reviewerReports, policy);
  const record = Object.freeze({
    schema: value.schema,
    status: value.status,
    scope: value.scope,
    reviewStartedAt,
    reviewCompletedAt,
    permissionGroupsSnapshotDigest: digest(
      value.permissionGroupsSnapshotDigest,
      "D1 access Permission Groups snapshot digest",
    ),
    accountMemberPoliciesSnapshotDigest: digest(
      value.accountMemberPoliciesSnapshotDigest,
      "D1 access member policies snapshot digest",
    ),
    userGroupMembershipSnapshotDigest: digest(
      value.userGroupMembershipSnapshotDigest,
      "D1 access user-group membership snapshot digest",
    ),
    inheritedPolicyUnionDigest: digest(
      value.inheritedPolicyUnionDigest,
      "D1 access inherited-policy union digest",
    ),
    accountOwnedCredentialInventoryDigest: digest(
      value.accountOwnedCredentialInventoryDigest,
      "D1 access account-owned credential inventory digest",
    ),
    workerD1BindingSnapshotDigest: digest(
      value.workerD1BindingSnapshotDigest,
      "D1 access Worker binding snapshot digest",
    ),
    d1AuditLogCoverageDigest: digest(value.d1AuditLogCoverageDigest, "D1 audit-log coverage digest"),
    applicationQueryAuditCoverageDigest: digest(
      value.applicationQueryAuditCoverageDigest,
      "D1 application query-audit coverage digest",
    ),
    principalObservationDigest: digest(
      value.principalObservationDigest,
      "D1 principal observation digest",
    ),
    negativeAuthorityTestsDigest: digest(
      value.negativeAuthorityTestsDigest,
      "D1 negative-authority tests digest",
    ),
    revocationRotationEvidenceDigest: digest(
      value.revocationRotationEvidenceDigest,
      "D1 revocation and rotation evidence digest",
    ),
    reviewerReports,
    controlResults: normalizeControlResults(value.controlResults),
  });
  const recordCommitments = [
    record.permissionGroupsSnapshotDigest,
    record.accountMemberPoliciesSnapshotDigest,
    record.userGroupMembershipSnapshotDigest,
    record.inheritedPolicyUnionDigest,
    record.accountOwnedCredentialInventoryDigest,
    record.workerD1BindingSnapshotDigest,
    record.d1AuditLogCoverageDigest,
    record.applicationQueryAuditCoverageDigest,
    record.principalObservationDigest,
    record.negativeAuthorityTestsDigest,
    record.revocationRotationEvidenceDigest,
    ...record.reviewerReports.flatMap((entry) => [
      entry.directInspectionEvidenceDigest,
      entry.reportDigest,
      entry.findingsDispositionDigest,
    ]),
  ];
  const policyCommitments = [
    policy.cloudflareAccountDigest,
    policy.databaseDigest,
    ...policy.principals.flatMap((entry) => [
      entry.principalId,
      entry.resourceScopeDigest,
      entry.credentialCustodyDigest,
    ]),
    ...policy.reviewers.flatMap((entry) => [
      entry.reviewerId,
      entry.organizationId,
      entry.identityEvidenceDigest,
    ]),
  ];
  distinct([...recordCommitments, ...policyCommitments], "D1 access evidence and participant commitments");
  return record;
}

export function assertD1AccessReviewIsSecretFree(value) {
  const forbiddenKey = /(?:authorization(?!s)|cookie|email|invoice|macaroon|mnemonic|password|preimage|private.?key|public.?key|rpc.?url|secret|session.?token|token.?value|wallet.?address)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of exactArray(entry, entry.length, "D1 access evidence array")) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string" && (/(?:https?|wss?):\/\//i.test(entry)
          || /-----BEGIN [A-Z ]*KEY-----/.test(entry)
          || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry))) {
        throw new Error("D1 access evidence contains endpoint or account material");
      }
      return;
    }
    const prototype = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null)
        || keys.some((key) => typeof key !== "string")) {
      throw new Error("D1 access evidence contains non-data material");
    }
    for (const key of keys) {
      if (forbiddenKey.test(key)) throw new Error(`D1 access evidence contains forbidden field ${key}`);
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new Error("D1 access evidence contains non-data material");
      }
      visit(descriptor.value);
    }
  };
  visit(value);
  return true;
}

export function prepareD1AccessPolicyReview(rawInput) {
  const fields = Object.hasOwn(rawInput ?? {}, "observedAt")
    ? ["observedAt", "policy", "record"]
    : ["policy", "record"];
  const input = exactRecord(rawInput, fields, "D1 access review preparation input");
  const observedAt = Object.hasOwn(input, "observedAt")
    ? input.observedAt
    : Math.floor(Date.now() / 1_000);
  const now = integer(observedAt, "D1 access review observation time", 1);
  const policy = normalizePolicy(input.policy);
  const record = normalizeRecord(input.record, policy, now);
  const validUntil = record.reviewCompletedAt + policy.maximumAttestationLifetimeSeconds;
  if (now > validUntil) throw new Error("D1 access review is expired");
  const candidate = Object.freeze({
    schema: "treeswap.prepared-d1-access-least-privilege-review.v1",
    status: "exact-access-state-reconstructed-awaiting-two-independent-attestations",
    scope: "signed-review-claims-only-no-platform-query-mutation-account-enablement-deployment-or-funding-authority",
    recordDigest: valueDigest(record),
    policyDigest: valueDigest(policy),
    principalSetDigest: valueDigest(policy.principals),
    reviewerSetDigest: valueDigest(policy.reviewers),
    validUntil,
    record,
    policy,
  });
  assertD1AccessReviewIsSecretFree(candidate);
  return candidate;
}

export function d1AccessReviewDomain(candidate) {
  return Object.freeze({
    name: "TreeSwap D1 Access Policy Review",
    version: "1",
    salt: candidate.policy.cloudflareAccountDigest,
  });
}

export function buildD1AccessReviewApprovalMessage(rawInput) {
  const fields = Object.hasOwn(rawInput ?? {}, "observedAt")
    ? ["attestedAt", "observedAt", "policy", "record", "role"]
    : ["attestedAt", "policy", "record", "role"];
  const input = exactRecord(rawInput, fields, "D1 access approval input");
  const observedAt = Object.hasOwn(input, "observedAt")
    ? input.observedAt
    : Math.floor(Date.now() / 1_000);
  const candidate = prepareD1AccessPolicyReview({
    policy: input.policy,
    record: input.record,
    observedAt,
  });
  const index = D1_ACCESS_REVIEW_ROLES.indexOf(input.role);
  if (index < 0) throw new Error("D1 access approval role is invalid");
  const reviewer = candidate.policy.reviewers[index];
  const attestedAt = integer(input.attestedAt, "D1 access attestation time", 1);
  if (attestedAt < candidate.record.reviewCompletedAt || attestedAt > observedAt
      || attestedAt > candidate.validUntil) {
    throw new Error("D1 access attestation time is invalid");
  }
  return Object.freeze({
    domain: d1AccessReviewDomain(candidate),
    types: D1_ACCESS_REVIEW_TYPES,
    value: Object.freeze({
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      sourceCommit: `0x${candidate.policy.sourceCommit}`,
      cloudflareAccountDigest: candidate.policy.cloudflareAccountDigest,
      databaseDigest: candidate.policy.databaseDigest,
      principalSetDigest: candidate.principalSetDigest,
      reviewerSetDigest: candidate.reviewerSetDigest,
      role: keccak256(toUtf8Bytes(input.role)).toLowerCase(),
      reviewerId: reviewer.reviewerId,
      reviewCompletedAt: candidate.record.reviewCompletedAt,
      attestedAt,
      validUntil: candidate.validUntil,
    }),
  });
}

function normalizeAttestations(raw) {
  return exactArray(raw, D1_ACCESS_REVIEW_ROLES.length, "D1 access attestations")
    .map((rawAttestation, index) => {
      const value = exactRecord(rawAttestation, ATTESTATION_FIELDS, `D1 access attestations[${index}]`);
      if (value.role !== D1_ACCESS_REVIEW_ROLES[index]) {
        throw new Error("D1 access attestations must use exact canonical roles");
      }
      if (typeof value.signature !== "string" || !isHexString(value.signature, 65)
          || value.signature !== value.signature.toLowerCase()) {
        throw new TypeError(`D1 access attestations[${index}].signature is invalid`);
      }
      return Object.freeze({
        role: value.role,
        reviewerId: digest(value.reviewerId, `D1 access attestations[${index}].reviewerId`),
        signer: address(value.signer, `D1 access attestations[${index}].signer`),
        attestedAt: integer(value.attestedAt, `D1 access attestations[${index}].attestedAt`, 1),
        signature: value.signature,
      });
    });
}

export function verifyD1AccessPolicyReview(rawInput) {
  const fields = Object.hasOwn(rawInput ?? {}, "observedAt")
    ? ["attestations", "observedAt", "policy", "record"]
    : ["attestations", "policy", "record"];
  const input = exactRecord(rawInput, fields, "D1 access review verification input");
  const observedAt = Object.hasOwn(input, "observedAt")
    ? input.observedAt
    : Math.floor(Date.now() / 1_000);
  const now = integer(observedAt, "D1 access review verification time", 1);
  const candidate = prepareD1AccessPolicyReview({
    policy: input.policy,
    record: input.record,
    observedAt: now,
  });
  const attestations = normalizeAttestations(input.attestations);
  for (let index = 0; index < attestations.length; index += 1) {
    const attestation = attestations[index];
    const reviewer = candidate.policy.reviewers[index];
    if (attestation.role !== reviewer.role || attestation.reviewerId !== reviewer.reviewerId
        || attestation.signer !== reviewer.signer) {
      throw new Error("D1 access attestation does not match its reviewer");
    }
    const typed = buildD1AccessReviewApprovalMessage({
      policy: input.policy,
      record: input.record,
      role: reviewer.role,
      attestedAt: attestation.attestedAt,
      observedAt: now,
    });
    let recovered;
    try {
      recovered = getAddress(verifyTypedData(typed.domain, typed.types, typed.value, attestation.signature));
    } catch {
      throw new Error("D1 access attestation signature is invalid");
    }
    if (recovered !== reviewer.signer) throw new Error("D1 access attestation signature is invalid");
  }
  distinct(attestations.map((entry) => entry.reviewerId), "D1 access attestation reviewer identities");
  distinct(attestations.map((entry) => entry.signer.toLowerCase()), "D1 access attestation signers");
  const attestationDigest = valueDigest(attestations.map((entry) => ({
    role: entry.role,
    reviewerId: entry.reviewerId,
    signer: entry.signer,
    attestedAt: entry.attestedAt,
    signatureDigest: valueDigest(entry.signature),
  })));
  const result = Object.freeze({
    schema: "treeswap.verified-d1-access-least-privilege-review.v1",
    status: "two-independent-d1-access-attestations-verified-live-controls-remain-external",
    scope: "signed-review-claims-only-no-platform-query-mutation-account-enablement-deployment-or-funding-authority",
    evidenceDigest: valueDigest({
      schema: "treeswap.d1-access-least-privilege-evidence-binding.v1",
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      attestationDigest,
    }),
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    principalSetDigest: candidate.principalSetDigest,
    reviewerSetDigest: candidate.reviewerSetDigest,
    attestationDigest,
    sourceBranch: candidate.policy.sourceBranch,
    sourceCommit: candidate.policy.sourceCommit,
    deploymentVersion: candidate.policy.deploymentVersion,
    cloudflareAccountDigest: candidate.policy.cloudflareAccountDigest,
    databaseDigest: candidate.policy.databaseDigest,
    principalCount: candidate.policy.principals.length,
    reviewerCount: candidate.policy.reviewers.length,
    reviewCompletedAt: candidate.record.reviewCompletedAt,
    attestedAt: Math.max(...attestations.map((entry) => entry.attestedAt)),
    validUntil: candidate.validUntil,
    verifiedAt: now,
    attestedClaims: Object.freeze({
      dedicatedAccountAndExactPrincipalSetReviewed: true,
      directGroupAndInheritedPermissionUnionReviewed: true,
      runtimeBindingAndTransitiveDeploymentAuthorityReviewed: true,
      negativeRevocationAndScopeTestsReviewed: true,
      queryLevelAuditGapCompensatedOutsideD1AuditLogs: true,
      zeroOpenRiskFindings: true,
    }),
    verifierLimitations: Object.freeze({
      platformApiQueriedByVerifier: false,
      privateEvidenceInspectedByVerifier: false,
      credentialScopeExercisedByVerifier: false,
      reviewerIdentityOrIndependenceEstablishedByVerifier: false,
      continuousAccessMonitoringEstablishedByVerifier: false,
    }),
    authorizations: Object.freeze({
      platformMutation: false,
      credentialCreation: false,
      credentialRevocation: false,
      deployment: false,
      accountEnablement: false,
      walletDispatch: false,
      lightningDispatch: false,
      settlement: false,
      funding: false,
      releaseActivation: false,
    }),
  });
  assertD1AccessReviewIsSecretFree(result);
  verifiedReviews.add(result);
  return result;
}

export function buildD1AccessPolicyReviewSummary(verification) {
  if (!verifiedReviews.has(verification)) throw new Error("D1 access review verification provenance is invalid");
  return Object.freeze({ ...verification });
}
