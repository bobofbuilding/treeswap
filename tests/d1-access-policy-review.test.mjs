import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  D1_ACCESS_PRINCIPAL_PROFILES,
  D1_ACCESS_REVIEW_ROLES,
  assertD1AccessReviewIsSecretFree,
  buildD1AccessPolicyReviewSummary,
  buildD1AccessReviewApprovalMessage,
  prepareD1AccessPolicyReview,
  verifyD1AccessPolicyReview,
} from "../lib/d1-access-policy-review.mjs";

const NOW = 2_100_000_000;
const SOURCE_COMMIT = "a".repeat(40);
const SECURITY_REVIEWER = new Wallet(id("TreeSwap Cloudflare access security reviewer"));
const PRIVACY_REVIEWER = new Wallet(id("TreeSwap D1 privacy least privilege reviewer"));
const WALLETS = [SECURITY_REVIEWER, PRIVACY_REVIEWER];

function policy() {
  return {
    schema: "treeswap.d1-access-least-privilege-policy.v1",
    sourceBranch: "main",
    sourceCommit: SOURCE_COMMIT,
    deploymentVersion: "14",
    cloudflareAccountDigest: id("dedicated TreeSwap Cloudflare account").toLowerCase(),
    databaseDigest: id("TreeSwap authoritative account D1 database").toLowerCase(),
    dedicatedCloudflareAccount: true,
    maximumReviewSeconds: 7_200,
    maximumAttestationLifetimeSeconds: 3_600,
    principals: D1_ACCESS_PRINCIPAL_PROFILES.map((profile, index) => ({
      ...profile,
      principalId: id(`D1 access principal ${index}`).toLowerCase(),
      resourceScopeDigest: id(`D1 access resource scope ${index}`).toLowerCase(),
      credentialCustodyDigest: id(`D1 access credential custody ${index}`).toLowerCase(),
    })),
    reviewers: D1_ACCESS_REVIEW_ROLES.map((role, index) => ({
      role,
      reviewerId: id(`D1 access reviewer ${index}`).toLowerCase(),
      organizationId: id(`D1 access reviewer organization ${index}`).toLowerCase(),
      identityEvidenceDigest: id(`D1 access reviewer identity evidence ${index}`).toLowerCase(),
      signer: WALLETS[index].address,
    })),
  };
}

function record() {
  return {
    schema: "treeswap.d1-access-least-privilege-review-record.v1",
    status: "exact-cloudflare-access-state-independently-reviewed",
    scope: "d1-access-review-only-no-platform-mutation-account-enablement-deployment-or-funding-authority",
    reviewStartedAt: NOW - 600,
    reviewCompletedAt: NOW - 300,
    permissionGroupsSnapshotDigest: id("permission groups API snapshot").toLowerCase(),
    accountMemberPoliciesSnapshotDigest: id("account member policy snapshot").toLowerCase(),
    userGroupMembershipSnapshotDigest: id("user group membership snapshot").toLowerCase(),
    inheritedPolicyUnionDigest: id("reconstructed inherited policy union").toLowerCase(),
    accountOwnedCredentialInventoryDigest: id("account-owned credential inventory").toLowerCase(),
    workerD1BindingSnapshotDigest: id("exact Worker D1 binding snapshot").toLowerCase(),
    d1AuditLogCoverageDigest: id("documented D1 audit log coverage").toLowerCase(),
    applicationQueryAuditCoverageDigest: id("application query audit compensation").toLowerCase(),
    principalObservationDigest: id("exact observed D1 principals").toLowerCase(),
    negativeAuthorityTestsDigest: id("D1 negative authority tests").toLowerCase(),
    revocationRotationEvidenceDigest: id("D1 credential revocation and rotation evidence").toLowerCase(),
    reviewerReports: D1_ACCESS_REVIEW_ROLES.map((role, index) => ({
      role,
      reviewerId: policy().reviewers[index].reviewerId,
      directInspectionEvidenceDigest: id(`D1 direct platform inspection evidence ${index}`).toLowerCase(),
      reportDigest: id(`D1 access independent review report ${index}`).toLowerCase(),
      findingsDispositionDigest: id(`D1 access findings disposition ${index}`).toLowerCase(),
      findingCounts: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        informational: index + 1,
        open: 0,
      },
    })),
    controlResults: {
      accessAuditCredentialD1QueryDenied: true,
      permissionGroupsApiUsed: true,
      deprecatedRolesApiUnused: true,
      deploymentCredentialDirectD1QueryDenied: true,
      directMemberPoliciesEnumerated: true,
      userGroupMembershipsEnumerated: true,
      inheritedGroupPoliciesEnumerated: true,
      effectivePolicyUnionsReconstructed: true,
      accountOwnedCredentialsEnumerated: true,
      userOwnedApiTokensAbsent: true,
      globalApiKeysAbsent: true,
      unlistedD1PrincipalsAbsent: true,
      browserD1CredentialsAbsent: true,
      maintenanceSchedulerHttpSurfaceAbsent: true,
      onDemandCredentialExpiryAndRevocationObserved: true,
      runtimeBindingsMatchPolicy: true,
      revokedCredentialDenied: true,
      backupCredentialWriteDenied: true,
      routineStandingHumanDirectD1CredentialsAbsent: true,
      twoPartyActivationEvidenceReviewed: true,
      queryLevelD1AuditCoverageClaimed: false,
      applicationQueryAuditCompensationReviewed: true,
    },
  };
}

async function attestations(candidatePolicy = policy(), candidateRecord = record(), wallets = WALLETS) {
  const result = [];
  for (let index = 0; index < D1_ACCESS_REVIEW_ROLES.length; index += 1) {
    const role = D1_ACCESS_REVIEW_ROLES[index];
    const attestedAt = NOW - 120 + index;
    const typed = buildD1AccessReviewApprovalMessage({
      policy: candidatePolicy,
      record: candidateRecord,
      role,
      attestedAt,
      observedAt: NOW,
    });
    result.push({
      role,
      reviewerId: candidatePolicy.reviewers[index].reviewerId,
      signer: candidatePolicy.reviewers[index].signer,
      attestedAt,
      signature: await wallets[index].signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return result;
}

test("verifies the exact D1 least-privilege state without granting operational authority", async () => {
  const candidatePolicy = policy();
  const candidateRecord = record();
  const verification = verifyD1AccessPolicyReview({
    policy: candidatePolicy,
    record: candidateRecord,
    attestations: await attestations(candidatePolicy, candidateRecord),
    observedAt: NOW,
  });
  const summary = buildD1AccessPolicyReviewSummary(verification);

  assert.equal(summary.principalCount, 8);
  assert.equal(summary.reviewerCount, 2);
  assert.equal(summary.attestedClaims.runtimeBindingAndTransitiveDeploymentAuthorityReviewed, true);
  assert.equal(summary.attestedClaims.queryLevelAuditGapCompensatedOutsideD1AuditLogs, true);
  assert.equal(summary.verifierLimitations.platformApiQueriedByVerifier, false);
  assert.deepEqual(summary.authorizations, {
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
  });
  assert.match(summary.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(summary), /(cookie|email|invoice|password|preimage|private.?key|token.?value|wallet.?address)/i);
  assert.throws(() => buildD1AccessPolicyReviewSummary(structuredClone(verification)), /provenance is invalid/);
});

test("requires the exact eight-role risk profile and exposes technically writable D1 bindings", () => {
  const candidate = prepareD1AccessPolicyReview({ policy: policy(), record: record(), observedAt: NOW });
  assert.deepEqual(
    candidate.policy.principals.filter((entry) => entry.credentialClass.includes("d1-binding"))
      .map((entry) => entry.effectiveCapability),
    [
      "d1-read-write",
      "d1-read-write-technically-read-only-by-reviewed-source",
      "d1-read-write-technically-read-only-by-reviewed-source",
    ],
  );
  for (const [field, value] of [
    ["credentialClass", "read-only-worker-binding"],
    ["effectiveCapability", "d1-read"],
    ["standing", false],
    ["interactive", true],
    ["databaseBound", false],
    ["twoPartyApprovalRequired", true],
    ["maximumCredentialLifetimeSeconds", 1],
  ]) {
    const candidatePolicy = policy();
    candidatePolicy.principals[0][field] = value;
    assert.throws(() => prepareD1AccessPolicyReview({
      policy: candidatePolicy,
      record: record(),
      observedAt: NOW,
    }), /exact risk profile/);
  }
});

test("requires a dedicated account and current Permission Groups model", () => {
  const candidatePolicy = policy();
  candidatePolicy.dedicatedCloudflareAccount = false;
  assert.throws(() => prepareD1AccessPolicyReview({
    policy: candidatePolicy,
    record: record(),
    observedAt: NOW,
  }), /account isolation is invalid/);

  for (const field of [
    "permissionGroupsApiUsed",
    "deprecatedRolesApiUnused",
    "directMemberPoliciesEnumerated",
    "userGroupMembershipsEnumerated",
    "inheritedGroupPoliciesEnumerated",
    "effectivePolicyUnionsReconstructed",
  ]) {
    const candidateRecord = record();
    candidateRecord.controlResults[field] = false;
    assert.throws(() => prepareD1AccessPolicyReview({
      policy: policy(),
      record: candidateRecord,
      observedAt: NOW,
    }), /fail-closed policy/);
  }
});

test("rejects unlisted, browser, user-owned, global, standing-human, or insufficiently tested access", () => {
  for (const field of [
    "accountOwnedCredentialsEnumerated",
    "accessAuditCredentialD1QueryDenied",
    "userOwnedApiTokensAbsent",
    "globalApiKeysAbsent",
    "unlistedD1PrincipalsAbsent",
    "browserD1CredentialsAbsent",
    "deploymentCredentialDirectD1QueryDenied",
    "maintenanceSchedulerHttpSurfaceAbsent",
    "onDemandCredentialExpiryAndRevocationObserved",
    "runtimeBindingsMatchPolicy",
    "revokedCredentialDenied",
    "backupCredentialWriteDenied",
    "routineStandingHumanDirectD1CredentialsAbsent",
    "twoPartyActivationEvidenceReviewed",
    "applicationQueryAuditCompensationReviewed",
  ]) {
    const candidateRecord = record();
    candidateRecord.controlResults[field] = false;
    assert.throws(() => prepareD1AccessPolicyReview({
      policy: policy(),
      record: candidateRecord,
      observedAt: NOW,
    }), /fail-closed policy/);
  }
  const overclaim = record();
  overclaim.controlResults.queryLevelD1AuditCoverageClaimed = true;
  assert.throws(() => prepareD1AccessPolicyReview({
    policy: policy(),
    record: overclaim,
    observedAt: NOW,
  }), /fail-closed policy/);
});

test("rejects unresolved findings and non-causal, stale, or future reviews", () => {
  for (const field of ["critical", "high", "medium", "low", "open"]) {
    const candidateRecord = record();
    candidateRecord.reviewerReports[0].findingCounts[field] = 1;
    assert.throws(() => prepareD1AccessPolicyReview({
      policy: policy(),
      record: candidateRecord,
      observedAt: NOW,
    }), /cannot accept unresolved or risk findings/);
  }
  const reversed = record();
  reversed.reviewCompletedAt = reversed.reviewStartedAt - 1;
  assert.throws(() => prepareD1AccessPolicyReview({ policy: policy(), record: reversed, observedAt: NOW }), /not causal/);
  const future = record();
  future.reviewCompletedAt = NOW + 1;
  assert.throws(() => prepareD1AccessPolicyReview({ policy: policy(), record: future, observedAt: NOW }), /future-dated/);
  assert.throws(() => prepareD1AccessPolicyReview({
    policy: policy(),
    record: record(),
    observedAt: record().reviewCompletedAt + 3_601,
  }), /expired/);
});

test("requires globally distinct account, database, principal, custody, evidence, and reviewer commitments", () => {
  const mutations = [
    [(candidatePolicy) => { candidatePolicy.databaseDigest = candidatePolicy.cloudflareAccountDigest; }],
    [(candidatePolicy) => { candidatePolicy.principals[1].principalId = candidatePolicy.principals[0].principalId; }],
    [(candidatePolicy) => { candidatePolicy.principals[1].resourceScopeDigest = candidatePolicy.principals[0].resourceScopeDigest; }],
    [(candidatePolicy) => { candidatePolicy.principals[1].credentialCustodyDigest = candidatePolicy.principals[0].credentialCustodyDigest; }],
    [(candidatePolicy) => { candidatePolicy.reviewers[1].organizationId = candidatePolicy.reviewers[0].organizationId; }],
  ];
  for (const [mutate] of mutations) {
    const candidatePolicy = policy();
    mutate(candidatePolicy);
    assert.throws(() => prepareD1AccessPolicyReview({
      policy: candidatePolicy,
      record: record(),
      observedAt: NOW,
    }), /must be distinct/);
  }
  const candidateRecord = record();
  candidateRecord.reviewerReports[0].reportDigest = policy().databaseDigest;
  assert.throws(() => prepareD1AccessPolicyReview({
    policy: policy(),
    record: candidateRecord,
    observedAt: NOW,
  }), /evidence and participant commitments must be distinct/);

  const sharedReport = record();
  sharedReport.reviewerReports[1].reportDigest = sharedReport.reviewerReports[0].reportDigest;
  assert.throws(() => prepareD1AccessPolicyReview({
    policy: policy(),
    record: sharedReport,
    observedAt: NOW,
  }), /report and inspection commitments must be distinct/);
});

test("rejects missing, reordered, copied, substituted, stale, future, and invalid attestations", async () => {
  const candidatePolicy = policy();
  const candidateRecord = record();
  const signed = await attestations(candidatePolicy, candidateRecord);
  const verify = (candidateAttestations, observedAt = NOW) => verifyD1AccessPolicyReview({
    policy: candidatePolicy,
    record: candidateRecord,
    attestations: candidateAttestations,
    observedAt,
  });
  assert.throws(() => verify(signed.slice(0, 1)), /exactly 2/);
  assert.throws(() => verify([...signed].reverse()), /canonical roles/);
  const copied = structuredClone(signed);
  copied[1].signature = copied[0].signature;
  assert.throws(() => verify(copied), /signature is invalid/);
  const substituted = structuredClone(signed);
  substituted[0].reviewerId = substituted[1].reviewerId;
  assert.throws(() => verify(substituted), /does not match/);
  const wrongWallets = await attestations(candidatePolicy, candidateRecord, [PRIVACY_REVIEWER, SECURITY_REVIEWER]);
  assert.throws(() => verify(wrongWallets), /signature is invalid/);
  assert.throws(() => verify(signed, candidateRecord.reviewCompletedAt + 3_601), /expired/);
  const future = structuredClone(signed);
  future[0].attestedAt = NOW + 1;
  assert.throws(() => verify(future), /attestation time is invalid/);
});

test("binds every material policy and record field into reviewer signatures", async () => {
  const candidatePolicy = policy();
  const candidateRecord = record();
  const signed = await attestations(candidatePolicy, candidateRecord);

  const changedPolicy = structuredClone(candidatePolicy);
  changedPolicy.principals[0].principalId = id("substituted principal").toLowerCase();
  assert.throws(() => verifyD1AccessPolicyReview({
    policy: changedPolicy,
    record: candidateRecord,
    attestations: signed,
    observedAt: NOW,
  }), /signature is invalid/);

  const changedRecord = structuredClone(candidateRecord);
  changedRecord.workerD1BindingSnapshotDigest = id("substituted binding snapshot").toLowerCase();
  assert.throws(() => verifyD1AccessPolicyReview({
    policy: candidatePolicy,
    record: changedRecord,
    attestations: signed,
    observedAt: NOW,
  }), /signature is invalid/);
});

test("rejects extra fields, sparse arrays, accessors, coercion, and secret material", () => {
  const extra = policy();
  extra.unreviewed = true;
  assert.throws(() => prepareD1AccessPolicyReview({ policy: extra, record: record(), observedAt: NOW }), /fields are not exact/);

  const sparse = policy();
  delete sparse.principals[2];
  assert.throws(() => prepareD1AccessPolicyReview({ policy: sparse, record: record(), observedAt: NOW }), /dense undecorated array/);

  const accessor = record();
  Object.defineProperty(accessor.controlResults, "globalApiKeysAbsent", {
    enumerable: true,
    get() { throw new Error("must not execute"); },
  });
  assert.throws(() => prepareD1AccessPolicyReview({ policy: policy(), record: accessor, observedAt: NOW }), /enumerable data properties/);

  const coercible = policy();
  coercible.maximumReviewSeconds = { valueOf: () => 7_200 };
  assert.throws(() => prepareD1AccessPolicyReview({ policy: coercible, record: record(), observedAt: NOW }), /safe integer/);

  assert.throws(() => assertD1AccessReviewIsSecretFree({ password: "not-retained" }), /forbidden field/);
  assert.throws(() => assertD1AccessReviewIsSecretFree({ note: "https://private.example" }), /endpoint or account material/);
});

test("EIP-712 domain is account-bound and approvals are role-specific", () => {
  const candidatePolicy = policy();
  const candidateRecord = record();
  const first = buildD1AccessReviewApprovalMessage({
    policy: candidatePolicy,
    record: candidateRecord,
    role: D1_ACCESS_REVIEW_ROLES[0],
    attestedAt: NOW - 10,
    observedAt: NOW,
  });
  const second = buildD1AccessReviewApprovalMessage({
    policy: candidatePolicy,
    record: candidateRecord,
    role: D1_ACCESS_REVIEW_ROLES[1],
    attestedAt: NOW - 10,
    observedAt: NOW,
  });
  assert.equal(first.domain.salt, candidatePolicy.cloudflareAccountDigest);
  assert.notEqual(first.value.role, second.value.role);
  assert.notEqual(first.value.reviewerId, second.value.reviewerId);
  assert.equal(first.value.principalSetDigest, second.value.principalSetDigest);
});

test("operator CLIs bind exact published source and expose no platform, credential, or signing action", async () => {
  const prepare = await readFile(
    new URL("../scripts/prepare-d1-access-policy-review-attestation.mjs", import.meta.url),
    "utf8",
  );
  const verify = await readFile(
    new URL("../scripts/verify-d1-access-policy-review.mjs", import.meta.url),
    "utf8",
  );
  for (const source of [prepare, verify]) {
    assert.match(source, /currentPublishedWalletSessionRouteReviewSource/);
    assert.match(source, /revalidatePublishedWalletSessionRouteReviewSource/);
    assert.doesNotMatch(source, /signTypedData|privateKey|globalApiKey|wrangler|fetch\(|spawn|execFile|execSync/);
  }
  assert.doesNotMatch(prepare, /writeExclusiveJson/);
  assert.match(verify, /writeExclusiveJson/);
});
