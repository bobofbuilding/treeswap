import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import {
  buildDeploymentPromotionReleaseEvidence,
  buildDeploymentPromotionSummary,
} from "./deployment-manifest-promotion.mjs";
import {
  buildPublicTestnetAdoptionSummary,
  buildPublicTestnetReleaseEvidence,
} from "./public-testnet-evidence.mjs";
import { buildPublicTestnetBootstrapReleaseEvidence } from "./public-testnet-bootstrap-evidence.mjs";
import { buildIndependentReviewReleaseEvidence } from "./independent-review-evidence.mjs";
import { buildOperationalReadinessReleaseEvidence } from "./operational-readiness-evidence.mjs";
import { buildQualificationReviewReleaseEvidence } from "./qualification-review-evidence.mjs";
import { ADOPTION_LIMIT_FIELDS } from "./adoption-policy.mjs";
import { safetyMonitorPolicyDigest } from "./safety-observation-attestation.mjs";
import {
  RELEASE_APPROVAL_TYPES,
  buildReleaseApprovalMessage,
  erc1271ProviderSetDigest,
  releaseAuthorizationDomain,
} from "./release-authorization.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;
const RECORD_TEMPLATE_FIELDS = Object.freeze([
  "approvalBlockHash",
  "approvalBlockNumber",
  "approvalBlockTimestamp",
  "features",
  "limits",
  "multisig",
  "priorReleaseDigest",
  "protocolVersion",
  "releaseId",
  "schema",
  "validFrom",
  "validUntil",
]);
const POLICY_TEMPLATE_FIELDS = Object.freeze([
  "approvers",
  "limitPolicy",
  "maximumReleaseLifetimeSeconds",
  "maximumRuntimeObservationAgeSeconds",
  "schema",
]);
const MULTISIG_FIELDS = Object.freeze(["ownerCount", "threshold"]);
const RELEASE_CANDIDATE_INPUT_FIELDS = Object.freeze([
  "deploymentPromotionVerification",
  "independentReviewVerification",
  "operationalReadinessVerification",
  "policyTemplate",
  "publicTestnetVerification",
  "qualificationReviewVerification",
  "recordTemplate",
]);
const BOOTSTRAP_RELEASE_CANDIDATE_INPUT_FIELDS = Object.freeze([
  "bootstrapEvidenceVerification",
  "deploymentPromotionVerification",
  "independentReviewVerification",
  "operationalReadinessVerification",
  "policyTemplate",
  "qualificationReviewVerification",
  "recordTemplate",
]);
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const verifiedCandidates = new WeakSet();
const candidateRuntimeBindings = new WeakMap();

function rememberCandidateRuntimeBinding(candidate, manifest, operations) {
  const operationalSafetyMonitorPolicy = snapshotPlainData(
    operations.safetyMonitorPolicy,
    "operational safety monitor policy",
  );
  const operationalSafetyMonitorPolicyDigest = safetyMonitorPolicyDigest(operationalSafetyMonitorPolicy);
  if (operationalSafetyMonitorPolicyDigest !== candidate.evidence.safetyMonitorPolicyDigest) {
    throw new Error("operational safety monitor policy does not match the release candidate");
  }
  const safetyMonitorPolicy = deepFreeze({
    ...operationalSafetyMonitorPolicy,
    releaseRecordDigest: candidate.recordDigest,
  });
  candidateRuntimeBindings.set(candidate, Object.freeze({
    manifest: snapshotPlainData(manifest, "release deployment manifest"),
    deploymentManifestDigest: candidate.record.evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: candidate.record.evidenceDigests.deploymentPostflight,
    deploymentPromotionDigest: candidate.record.evidenceDigests.deploymentPromotion,
    operationalSafetyMonitorPolicy,
    operationalSafetyMonitorPolicyDigest,
    operationalSafetyMonitorUpstreamRecordDigest: operationalSafetyMonitorPolicy.releaseRecordDigest,
    safetyMonitorPolicy,
    safetyMonitorPolicyDigest: safetyMonitorPolicyDigest(safetyMonitorPolicy),
  }));
}

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const actual = [...keys].sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
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

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.freeze(value);
}

function snapshotPlainData(value, name, state = {
  depth: 0,
  counter: { value: 0 },
  ancestors: new WeakSet(),
}) {
  state.counter.value += 1;
  if (state.counter.value > 4_096 || state.depth > 32) {
    throw new RangeError(`${name} is outside the bounded data policy`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== "object") {
    throw new TypeError(`${name} contains an unsupported value`);
  }
  if (state.ancestors.has(value)) throw new TypeError(`${name} contains a cycle`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 128) {
        throw new TypeError(`${name} contains an unsupported array`);
      }
      const keys = Reflect.ownKeys(value);
      const expected = [...Array(value.length).keys()].map(String).concat("length");
      if (keys.length !== expected.length
          || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
        throw new TypeError(`${name} array fields are not exact`);
      }
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw new TypeError(`${name}[${index}] must be an enumerable data property`);
        }
        result.push(snapshotPlainData(descriptor.value, `${name}[${index}]`, {
          depth: state.depth + 1,
          counter: state.counter,
          ancestors: state.ancestors,
        }));
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${name} contains an unsupported object`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 128 || keys.some((key) => typeof key !== "string")) {
      throw new TypeError(`${name} object fields are outside policy`);
    }
    if (keys.some((key) => PROTOTYPE_KEYS.has(key))) {
      throw new TypeError(`${name} contains a prototype-named field`);
    }
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${name}.${key} must be an enumerable data property`);
      }
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: snapshotPlainData(descriptor.value, `${name}.${key}`, {
          depth: state.depth + 1,
          counter: state.counter,
          ancestors: state.ancestors,
        }),
      });
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

function hash(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function digest(value, name, { allowZero = false } = {}) {
  if (typeof value !== "string" || value !== value.toLowerCase()
      || !BYTES32.test(value) || (!allowZero && value === `0x${"00".repeat(32)}`)) {
    throw new TypeError(`${name} must be a ${allowZero ? "" : "nonzero "}lowercase bytes32 digest`);
  }
  return value;
}

function decimal(value, name, { positive = false } = {}) {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new TypeError(`${name} must be a canonical uint256 decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX || (positive && parsed === 0n)) throw new RangeError(`${name} is outside uint256`);
  return value;
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function normalizeRecordTemplate(raw) {
  const source = exactDataRecord(raw, RECORD_TEMPLATE_FIELDS, "public-testnet release record template");
  if (source.schema !== "treeswap.public-testnet-release-record-template.v3") {
    throw new TypeError("public-testnet release record template schema is invalid");
  }
  const multisig = exactDataRecord(source.multisig, MULTISIG_FIELDS, "recordTemplate.multisig");
  const ownerCount = count(multisig.ownerCount, "recordTemplate.multisig.ownerCount");
  const threshold = count(multisig.threshold, "recordTemplate.multisig.threshold");
  if (threshold > ownerCount) throw new RangeError("recordTemplate multisig threshold exceeds owner count");
  if (typeof source.protocolVersion !== "string" || source.protocolVersion.length === 0
      || source.protocolVersion.length > 64) {
    throw new TypeError("recordTemplate.protocolVersion must be a non-empty bounded string");
  }
  return Object.freeze({
    schema: source.schema,
    releaseId: digest(source.releaseId, "recordTemplate.releaseId"),
    protocolVersion: source.protocolVersion,
    approvalBlockNumber: decimal(source.approvalBlockNumber, "recordTemplate.approvalBlockNumber", { positive: true }),
    approvalBlockHash: digest(source.approvalBlockHash, "recordTemplate.approvalBlockHash"),
    approvalBlockTimestamp: timestamp(source.approvalBlockTimestamp, "recordTemplate.approvalBlockTimestamp"),
    priorReleaseDigest: digest(source.priorReleaseDigest, "recordTemplate.priorReleaseDigest", { allowZero: true }),
    multisig: Object.freeze({ ownerCount, threshold }),
    limits: snapshotPlainData(source.limits, "recordTemplate.limits"),
    features: snapshotPlainData(source.features, "recordTemplate.features"),
    validFrom: timestamp(source.validFrom, "recordTemplate.validFrom"),
    validUntil: timestamp(source.validUntil, "recordTemplate.validUntil"),
  });
}

function normalizePolicyTemplate(raw) {
  const source = exactDataRecord(raw, POLICY_TEMPLATE_FIELDS, "public-testnet release policy template");
  if (source.schema !== "treeswap.public-testnet-release-policy-template.v1") {
    throw new TypeError("public-testnet release policy template schema is invalid");
  }
  return Object.freeze({
    schema: source.schema,
    maximumReleaseLifetimeSeconds: count(
      source.maximumReleaseLifetimeSeconds,
      "policyTemplate.maximumReleaseLifetimeSeconds",
    ),
    maximumRuntimeObservationAgeSeconds: count(
      source.maximumRuntimeObservationAgeSeconds,
      "policyTemplate.maximumRuntimeObservationAgeSeconds",
    ),
    limitPolicy: snapshotPlainData(source.limitPolicy, "policyTemplate.limitPolicy"),
    approvers: snapshotPlainData(source.approvers, "policyTemplate.approvers"),
  });
}

function composite(schema, fields) {
  return hash(Object.freeze({ schema, ...fields }));
}

function requireEqual(name, left, right) {
  if (left !== right) throw new Error(`${name} does not match across verified upstream evidence`);
}

function requireUniformMultisig(manifest, ownerCount, threshold) {
  for (const role of ["controller", "guardian", "feeCollector"]) {
    if (manifest?.[role]?.owners !== ownerCount || manifest?.[role]?.threshold !== threshold) {
      throw new Error(`release multisig counts do not exactly match the verified ${role} wallet`);
    }
  }
}

function requireBoundReleaseWallets(policy, manifest) {
  for (const role of ["controller", "guardian"]) {
    const approver = policy?.approvers?.[role];
    let address;
    try {
      address = getAddress(approver?.address);
    } catch {
      throw new TypeError(`release ${role} approver address is invalid`);
    }
    if (address !== manifest?.[role]?.address
        || String(approver?.codeHash ?? "").toLowerCase() !== manifest?.[role]?.codeHash
        || approver?.signatureKind !== "erc1271") {
      throw new Error(`release ${role} approver does not exactly match the verified deployment wallet`);
    }
  }
  const walletOwners = new Set(
    ["controller", "guardian", "feeCollector"]
      .flatMap((role) => manifest?.[role]?.ownerAddresses ?? [])
      .map((value) => value.toLowerCase()),
  );
  for (const role of ["lightningOperator", "securityReviewer", "incidentCommander"]) {
    let address;
    try {
      address = getAddress(policy?.approvers?.[role]?.address);
    } catch {
      throw new TypeError(`release ${role} approver address is invalid`);
    }
    if (walletOwners.has(address.toLowerCase())) {
      throw new Error(`release ${role} approver must be independent of every deployment-wallet owner`);
    }
    if (policy?.approvers?.[role]?.signatureKind !== "eip712") {
      throw new Error(`release ${role} approver must use its policy-pinned EIP-712 identity`);
    }
  }
}

function requireIndependentReviewers(review, policy, manifest, upstreamSigners) {
  const forbidden = new Set([
    ...["controller", "guardian", "feeCollector"].flatMap((role) => [
      manifest?.[role]?.address,
      ...(manifest?.[role]?.ownerAddresses ?? []),
    ]),
    ...Object.values(policy?.approvers ?? {}).map((value) => value?.address),
    ...upstreamSigners,
  ].filter(Boolean).map((value) => value.toLowerCase()));
  for (const reviewer of review.reviewers) {
    if (forbidden.has(reviewer.signer.toLowerCase())) {
      throw new Error("independent reviewer signer overlaps a deployment or release authority");
    }
  }
}

function requireOperationalReadiness({
  operations,
  expectedFundingMode,
  upstreamRecordDigest,
  recordTemplate,
  policyTemplate,
  deploymentSummary,
  deploymentManifest,
  deploymentSigners,
  upstreamParticipants,
  upstreamAlertChannels,
  upstreamArtifacts,
  upstreamScenarios,
  review,
}) {
  requireEqual("operational readiness funding mode", expectedFundingMode, operations.fundingMode);
  requireEqual("operational readiness source commit", deploymentSummary.sourceCommit, operations.reviewedBuildCommit);
  requireEqual("operational readiness protocol version", recordTemplate.protocolVersion, operations.protocolVersion);
  requireEqual("operational readiness chain", deploymentSummary.chainId, operations.chainId);
  requireEqual("operational readiness gate", deploymentSummary.gate, operations.verifyingContract);
  requireEqual(
    "operational readiness deployment manifest",
    deploymentSummary.manifestDigest,
    operations.deploymentManifestDigest,
  );
  requireEqual(
    "operational safety monitor upstream record",
    upstreamRecordDigest,
    operations.safetyMonitorReleaseRecordDigest,
  );
  if (recordTemplate.approvalBlockTimestamp < operations.preparedAt
      || recordTemplate.approvalBlockTimestamp > operations.validUntil) {
    throw new Error("release approval block is outside the signed operational-readiness interval");
  }
  if (recordTemplate.validFrom < operations.preparedAt || recordTemplate.validUntil > operations.validUntil) {
    throw new Error("release validity is outside the signed operational-readiness interval");
  }
  const byRole = new Map(operations.participants.map((participant) => [participant.role, participant]));
  if (byRole.get("lightning-operator")?.signer !== policyTemplate.approvers.lightningOperator.address) {
    throw new Error("operational lightning operator does not match the release policy");
  }
  if (byRole.get("incident-commander")?.signer !== policyTemplate.approvers.incidentCommander.address) {
    throw new Error("operational incident commander does not match the release policy");
  }
  const isolationByRole = new Map(
    operations.serviceIsolationParticipants.map((participant) => [participant.role, participant]),
  );
  if (isolationByRole.get("lightning-operator")?.signer !== byRole.get("lightning-operator")?.signer) {
    throw new Error("service-isolation Lightning operator does not match operational readiness");
  }
  if (isolationByRole.get("security-reviewer")?.signer !== policyTemplate.approvers.securityReviewer.address) {
    throw new Error("service-isolation security reviewer does not match the release policy");
  }
  const monitoringParticipant = byRole.get("monitoring-operator");
  if (!upstreamParticipants.some((participant) => (
    participant.role === "monitor"
    && participant.signer === monitoringParticipant?.signer
    && participant.operatorId === monitoringParticipant?.operatorId
  ))) {
    throw new Error("operational monitoring identity is not an exact signed upstream monitor operator");
  }
  const upstreamSigners = new Set(upstreamParticipants.map((participant) => participant.signer.toLowerCase()));
  for (const participant of operations.participants) {
    if (participant.role !== "monitoring-operator" && upstreamSigners.has(participant.signer.toLowerCase())) {
      throw new Error("a non-monitor operational signer overlaps an upstream infrastructure operator");
    }
  }
  const forbidden = new Set([
    ...["controller", "guardian", "feeCollector"].flatMap((role) => [
      deploymentManifest?.[role]?.address,
      ...(deploymentManifest?.[role]?.ownerAddresses ?? []),
    ]),
    ...deploymentSigners,
    ...review.reviewers.map((reviewer) => reviewer.signer),
  ].filter(Boolean).map((value) => value.toLowerCase()));
  for (const participant of operations.participants) {
    if (forbidden.has(participant.signer.toLowerCase())) {
      throw new Error("operational signer overlaps a deployment or independent-review authority");
    }
  }
  const operationalSigners = new Set(operations.participants.map((value) => value.signer.toLowerCase()));
  const releaseApprovers = new Set(
    Object.values(policyTemplate.approvers).map((value) => value.address.toLowerCase()),
  );
  for (const participant of operations.serviceIsolationParticipants) {
    const signer = participant.signer.toLowerCase();
    if (forbidden.has(signer)) {
      throw new Error("service-isolation signer overlaps a deployment or independent-review authority");
    }
    if (participant.role !== "lightning-operator" && operationalSigners.has(signer)) {
      throw new Error("service-isolation signer improperly overlaps an operational role");
    }
    if (participant.role === "infrastructure-operator" && releaseApprovers.has(signer)) {
      throw new Error("service-isolation infrastructure operator overlaps a release authority");
    }
  }
  if (operations.alertChannelEvidenceDigests.length !== upstreamAlertChannels.length
      || operations.alertChannelEvidenceDigests.some((value, index) => value !== upstreamAlertChannels[index])) {
    throw new Error("operational alert channels do not exactly match signed upstream evidence");
  }
  for (const field of [
    "backupRestore",
    "incidentDrills",
    "monitoring",
    "providerQuorum",
    "solverOperations",
    "testQualification",
  ]) {
    requireEqual(`operational ${field} artifact`, upstreamArtifacts[field], operations.artifacts[field]);
  }
  if (upstreamArtifacts.reconciliation) {
    requireEqual(
      "operational reconciliation artifact",
      upstreamArtifacts.reconciliation,
      operations.artifacts.reconciliation,
    );
  }
  if (upstreamScenarios) {
    const scenarios = new Map(upstreamScenarios.map((scenario) => [scenario.name, scenario.evidenceDigest]));
    for (const drill of operations.drills) {
      requireEqual(`operational ${drill.name} drill`, scenarios.get(drill.name), drill.evidenceDigest);
    }
  }
}

function requireAdoptionPolicy({
  operations,
  expectedFundingMode,
  recordTemplate,
  deploymentManifest,
  admissionPolicyDigest,
  riskPolicyDigest,
  feeScheduleDigest,
}) {
  const adoption = operations.adoptionPolicy;
  if (!adoption) throw new Error("exact adoption policy is required");
  requireEqual("adoption funding mode", expectedFundingMode, adoption.fundingMode);
  requireEqual("adoption admission policy", admissionPolicyDigest, adoption.admissionPolicyDigest);
  requireEqual("adoption risk policy", riskPolicyDigest, adoption.riskPolicyDigest);
  requireEqual("adoption fee schedule", feeScheduleDigest, adoption.feeScheduleDigest);
  for (const field of ADOPTION_LIMIT_FIELDS) {
    requireEqual(`adoption ${field}`, recordTemplate.limits[field], adoption.limits[field]);
  }
  const deployedMaxFeeBps = Math.min(
    Number(deploymentManifest?.vault?.maxFeeBps ?? -1),
    Number(deploymentManifest?.userEscrow?.maxFeeBps ?? -1),
  );
  if (!Number.isSafeInteger(deployedMaxFeeBps) || deployedMaxFeeBps <= 0
      || adoption.fees.maxFeeBps > deployedMaxFeeBps
      || adoption.fees.baseBitToLightningBps > deployedMaxFeeBps
      || adoption.fees.baseLightningToBitBps > deployedMaxFeeBps) {
    throw new Error("adoption fee schedule exceeds the deployed immutable fee ceiling");
  }
  if (recordTemplate.features.partialFills !== adoption.liveness.partialFillsAllowed) {
    throw new Error("adoption partial-fill policy does not match the release feature set");
  }
  if (expectedFundingMode === "operator-testnet-bootstrap"
      && recordTemplate.features.publicPermissionlessExecution !== false) {
    throw new Error("testnet bootstrap must keep public permissionless execution disabled");
  }
}

function requireQualificationReview({
  qualification,
  expectedFundingMode,
  recordTemplate,
  deploymentSummary,
  upstreamArtifact,
  upstreamParticipants,
  deploymentSigners,
  deploymentParticipantIds,
  deploymentManifest,
  review,
  operations,
  policyTemplate,
}) {
  for (const [name, expected, observed] of [
    ["environment", "public-testnet", qualification.environment],
    ["funding mode", expectedFundingMode, qualification.fundingMode],
    ["source commit", deploymentSummary.sourceCommit, qualification.reviewedBuildCommit],
    ["protocol version", recordTemplate.protocolVersion, qualification.protocolVersion],
    ["chain", deploymentSummary.chainId, qualification.chainId],
    ["gate", deploymentSummary.gate, qualification.verifyingContract],
    ["deployment manifest", deploymentSummary.manifestDigest, qualification.deploymentManifestDigest],
    ["signed upstream qualification artifact", qualification.evidenceDigest, upstreamArtifact],
    ["operational qualification artifact", qualification.evidenceDigest, operations.artifacts.testQualification],
  ]) {
    requireEqual(`qualification review ${name}`, expected, observed);
  }
  if (recordTemplate.approvalBlockTimestamp < qualification.reviewedAt
      || recordTemplate.approvalBlockTimestamp > qualification.validUntil) {
    throw new Error("release approval block is outside the qualification review interval");
  }
  if (recordTemplate.validFrom < qualification.reviewedAt
      || recordTemplate.validUntil > qualification.validUntil) {
    throw new Error("release validity is outside the qualification review interval");
  }
  const forbiddenSigners = new Set([
    ...deploymentSigners,
    ...["controller", "guardian", "feeCollector"].flatMap((role) => [
      deploymentManifest?.[role]?.address,
      ...(deploymentManifest?.[role]?.ownerAddresses ?? []),
    ]),
    ...review.reviewers.map((participant) => participant.signer),
    ...operations.participants.map((participant) => participant.signer),
    ...operations.serviceIsolationParticipants.map((participant) => participant.signer),
    ...upstreamParticipants.map((participant) => participant.signer),
    ...Object.values(policyTemplate.approvers).map((approver) => approver.address),
  ].filter(Boolean).map((value) => value.toLowerCase()));
  if (forbiddenSigners.has(qualification.reviewer.toLowerCase())) {
    throw new Error("qualification reviewer overlaps a deployment, infrastructure, review, operations, or release authority");
  }
  const forbiddenReviewerIds = new Set([
    ...deploymentParticipantIds,
    ...review.reviewers.map((participant) => participant.reviewerId),
    ...operations.participants.map((participant) => participant.operatorId),
    ...operations.serviceIsolationParticipants.map((participant) => participant.operatorId),
    ...upstreamParticipants.map((participant) => participant.operatorId),
  ]);
  if (forbiddenReviewerIds.has(qualification.reviewerId)) {
    throw new Error("qualification reviewer identity overlaps another release participant");
  }
  const forbiddenOrganizations = new Set([
    ...review.reviewers.map((participant) => participant.organizationId),
    ...operations.participants.map((participant) => participant.organizationId),
    ...operations.serviceIsolationParticipants.map((participant) => participant.organizationId),
  ].filter(Boolean));
  if (forbiddenOrganizations.has(qualification.reviewerOrganizationId)) {
    throw new Error("qualification reviewer organization overlaps another review or operations authority");
  }
}

export function preparePublicTestnetReleaseCandidate(input) {
  const source = exactDataRecord(input, RELEASE_CANDIDATE_INPUT_FIELDS, "public-testnet release candidate input");
  const rawRecordTemplate = source.recordTemplate;
  const rawPolicyTemplate = source.policyTemplate;
  const deploymentPromotionVerification = source.deploymentPromotionVerification;
  const independentReviewVerification = source.independentReviewVerification;
  const operationalReadinessVerification = source.operationalReadinessVerification;
  const publicTestnetVerification = source.publicTestnetVerification;
  const qualificationReviewVerification = source.qualificationReviewVerification;
  const recordTemplate = normalizeRecordTemplate(rawRecordTemplate);
  const policyTemplate = normalizePolicyTemplate(rawPolicyTemplate);
  const deployment = buildDeploymentPromotionReleaseEvidence(deploymentPromotionVerification);
  const deploymentSummary = buildDeploymentPromotionSummary(deploymentPromotionVerification);
  const review = buildIndependentReviewReleaseEvidence(independentReviewVerification);
  const operations = buildOperationalReadinessReleaseEvidence(operationalReadinessVerification);
  const campaign = buildPublicTestnetReleaseEvidence(publicTestnetVerification);
  const campaignSummary = buildPublicTestnetAdoptionSummary(publicTestnetVerification);
  const qualification = buildQualificationReviewReleaseEvidence(qualificationReviewVerification);

  requireEqual("deployment manifest", deployment.deploymentManifest, campaign.deploymentManifest);
  requireEqual("source commit", deploymentSummary.sourceCommit, campaignSummary.sourceCommit);
  requireEqual("chain", deploymentSummary.chainId, campaignSummary.chainId);
  requireEqual("gate", deploymentSummary.gate, publicTestnetVerification.record.verifyingContract);
  requireEqual("independent review source commit", deploymentSummary.sourceCommit, review.reviewedBuildCommit);
  requireEqual("independent review protocol version", recordTemplate.protocolVersion, review.protocolVersion);
  requireEqual("independent review chain", deploymentSummary.chainId, review.chainId);
  requireEqual("independent review gate", deploymentSummary.gate, review.verifyingContract);
  requireEqual("independent review deployment manifest", deploymentSummary.manifestDigest, review.deploymentManifestDigest);
  if (deploymentSummary.providerCount !== campaign.counts.independentEvmProviders) {
    throw new Error("deployment and campaign EVM provider counts do not match");
  }
  if (recordTemplate.approvalBlockTimestamp < publicTestnetVerification.record.finishedAt) {
    throw new Error("release approval block predates the verified public-testnet campaign finish");
  }
  if (recordTemplate.validFrom < publicTestnetVerification.record.finishedAt
      || recordTemplate.validFrom < deploymentPromotionVerification.record.promotedAt) {
    throw new Error("release validity begins before the verified campaign and deployment promotion");
  }
  if (recordTemplate.approvalBlockTimestamp > deploymentSummary.validUntil) {
    throw new Error("verified deployment promotion expired before the release approval block");
  }
  if (recordTemplate.approvalBlockTimestamp < review.finishedAt
      || recordTemplate.approvalBlockTimestamp > review.validUntil) {
    throw new Error("release approval block is outside the signed independent-review interval");
  }
  if (recordTemplate.validFrom < review.finishedAt || recordTemplate.validUntil > review.validUntil) {
    throw new Error("release validity is outside the signed independent-review interval");
  }
  requireUniformMultisig(
    deploymentPromotionVerification.manifest,
    recordTemplate.multisig.ownerCount,
    recordTemplate.multisig.threshold,
  );
  requireBoundReleaseWallets(policyTemplate, deploymentPromotionVerification.manifest);
  requireIndependentReviewers(
    review,
    policyTemplate,
    deploymentPromotionVerification.manifest,
    [
      ...deploymentPromotionVerification.policy.approvers.map((value) => value.signer),
      ...publicTestnetVerification.record.participants.map((value) => value.signer),
      ...operations.participants.map((value) => value.signer),
      ...operations.serviceIsolationParticipants.map((value) => value.signer),
    ],
  );
  requireOperationalReadiness({
    operations,
    expectedFundingMode: "operator-testnet",
    upstreamRecordDigest: publicTestnetVerification.recordDigest,
    recordTemplate,
    policyTemplate,
    deploymentSummary,
    deploymentManifest: deploymentPromotionVerification.manifest,
    deploymentSigners: deploymentPromotionVerification.policy.approvers.map((value) => value.signer),
    upstreamParticipants: publicTestnetVerification.record.participants,
    upstreamAlertChannels: publicTestnetVerification.record.alertChannelEvidenceDigests,
    upstreamArtifacts: {
      ...publicTestnetVerification.record.artifacts,
      reconciliation: publicTestnetVerification.record.reconciliation.reconciliationDigest,
    },
    upstreamScenarios: publicTestnetVerification.record.scenarios,
    review,
  });
  requireQualificationReview({
    qualification,
    expectedFundingMode: "operator-testnet",
    recordTemplate,
    deploymentSummary,
    upstreamArtifact: publicTestnetVerification.record.artifacts.testQualification,
    upstreamParticipants: publicTestnetVerification.record.participants,
    deploymentSigners: deploymentPromotionVerification.policy.approvers.map((value) => value.signer),
    deploymentParticipantIds: deploymentPromotionVerification.policy.approvers.map((value) => value.approverId),
    deploymentManifest: deploymentPromotionVerification.manifest,
    review,
    operations,
    policyTemplate,
  });
  requireAdoptionPolicy({
    operations,
    expectedFundingMode: "operator-testnet",
    recordTemplate,
    deploymentManifest: deploymentPromotionVerification.manifest,
    admissionPolicyDigest: campaign.admissionPolicy,
    riskPolicyDigest: campaign.riskPolicy,
    feeScheduleDigest: campaign.feeSchedule,
  });

  const operationsBinding = Object.freeze({
    recordDigest: operations.recordDigest,
    policyDigest: operations.policyDigest,
    attestationSetDigest: operations.attestationSetDigest,
    participantSetDigest: operations.participantSetDigest,
    drillSetDigest: operations.drillSetDigest,
    alertChannelSetDigest: operations.alertChannelSetDigest,
    adoptionPolicyDigest: operations.adoptionPolicyDigest,
    safetyMonitorPolicyDigest: operations.safetyMonitorPolicyDigest,
    safetyMonitorUpstreamRecordDigest: operations.safetyMonitorReleaseRecordDigest,
    gateConfirmerBindingDigest: operations.gateConfirmerBindingDigest,
    serviceIsolationEvidenceDigest: operations.serviceIsolationEvidenceDigest,
    serviceIsolationParticipantSetDigest: operations.serviceIsolationParticipantSetDigest,
  });

  const evidenceDigests = Object.freeze({
    admissionPolicy: campaign.admissionPolicy,
    backupRestore: composite("treeswap.release-operational-backup-evidence.v1", {
      artifact: campaign.backupRestore,
      operations: operationsBinding,
    }),
    deploymentManifest: deployment.deploymentManifest,
    deploymentPostflight: composite("treeswap.release-postflight-evidence.v1", {
      recordDigest: deployment.deploymentPostflight,
      policyDigest: deploymentSummary.postflightPolicyDigest,
    }),
    deploymentPromotion: composite("treeswap.release-promotion-evidence.v1", {
      recordDigest: deployment.deploymentPromotion,
      policyDigest: deploymentSummary.policyDigest,
    }),
    feeSchedule: campaign.feeSchedule,
    findingsDisposition: composite("treeswap.release-findings-evidence.v1", {
      campaign: campaign.findingsDisposition,
      deployment: deployment.findingsDisposition,
      deploymentReviewBundle: deployment.reviewBundle,
      independentReviewAttestations: review.attestationSetDigest,
      independentReviewFindings: review.findingsDispositionDigest,
      independentReviewPolicy: review.policyDigest,
      independentReviewRecord: review.recordDigest,
    }),
    incidentDrills: composite("treeswap.release-operational-incident-evidence.v1", {
      artifact: campaign.incidentDrills,
      operations: operationsBinding,
    }),
    lossAllocation: composite("treeswap.release-operational-loss-allocation-evidence.v1", {
      artifact: operations.artifacts.lossAllocation,
      operations: operationsBinding,
    }),
    monitoring: composite("treeswap.release-operational-monitoring-evidence.v1", {
      artifact: campaign.monitoring,
      operations: operationsBinding,
    }),
    providerQuorum: composite("treeswap.release-provider-quorum-evidence.v1", {
      campaign: campaign.providerQuorum,
      deployment: deployment.providerQuorum,
      operations: operationsBinding,
    }),
    publicTestnet: composite("treeswap.release-public-testnet-evidence.v1", {
      recordDigest: campaign.publicTestnet,
      policyDigest: publicTestnetVerification.policyDigest,
    }),
    riskPolicy: campaign.riskPolicy,
    solverOperations: composite("treeswap.release-operational-solver-evidence.v1", {
      artifact: campaign.solverOperations,
      operations: operationsBinding,
    }),
    supportPolicy: composite("treeswap.release-operational-support-evidence.v1", {
      artifact: operations.artifacts.supportPolicy,
      operations: operationsBinding,
    }),
    testQualification: composite("treeswap.release-operational-qualification-evidence.v1", {
      artifact: campaign.testQualification,
      operations: operationsBinding,
      qualificationReview: qualification.evidenceDigest,
    }),
  });
  const counts = Object.freeze({
    alertChannels: campaign.counts.alertChannels,
    independentEvmProviders: campaign.counts.independentEvmProviders,
    independentLightningObservers: campaign.counts.independentLightningObservers,
    independentMonitors: campaign.counts.independentMonitors,
    independentRelays: campaign.counts.independentRelays,
    independentSolvers: campaign.counts.independentSolvers,
    multisigOwnerCount: recordTemplate.multisig.ownerCount,
    multisigThreshold: recordTemplate.multisig.threshold,
  });
  const record = Object.freeze({
    schema: "treeswap.release-record.v2",
    releaseId: recordTemplate.releaseId,
    protocolVersion: recordTemplate.protocolVersion,
    environment: "public-testnet",
    fundingMode: "operator-testnet",
    chainId: deploymentSummary.chainId,
    verifyingContract: deploymentSummary.gate,
    approvalBlockNumber: recordTemplate.approvalBlockNumber,
    approvalBlockHash: recordTemplate.approvalBlockHash,
    approvalBlockTimestamp: recordTemplate.approvalBlockTimestamp,
    approvalProviderSetDigest: erc1271ProviderSetDigest(
      publicTestnetVerification.record.participants
        .filter((value) => value.role === "evm-provider")
        .map((value) => value.operatorId),
    ),
    reviewedBuildCommit: deploymentSummary.sourceCommit,
    priorReleaseDigest: recordTemplate.priorReleaseDigest,
    evidenceDigests,
    reviewDigests: review.reviewDigests,
    counts,
    limits: recordTemplate.limits,
    features: recordTemplate.features,
    validFrom: recordTemplate.validFrom,
    validUntil: recordTemplate.validUntil,
  });
  const policy = Object.freeze({
    schema: "treeswap.release-policy.v2",
    environment: record.environment,
    chainId: record.chainId,
    verifyingContract: record.verifyingContract,
    reviewedBuildCommit: record.reviewedBuildCommit,
    deploymentManifestDigest: evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: evidenceDigests.deploymentPostflight,
    deploymentPromotionDigest: evidenceDigests.deploymentPromotion,
    admissionPolicyDigest: evidenceDigests.admissionPolicy,
    riskPolicyDigest: evidenceDigests.riskPolicy,
    feeScheduleDigest: evidenceDigests.feeSchedule,
    maximumReleaseLifetimeSeconds: policyTemplate.maximumReleaseLifetimeSeconds,
    maximumRuntimeObservationAgeSeconds: policyTemplate.maximumRuntimeObservationAgeSeconds,
    minimumCounts: counts,
    limitPolicy: policyTemplate.limitPolicy,
    approvers: policyTemplate.approvers,
  });
  const message = buildReleaseApprovalMessage(record, policy);
  const approvalDomain = releaseAuthorizationDomain(record);
  const result = Object.freeze({
    schema: "treeswap.prepared-public-testnet-release-candidate.v6",
    status: "deployment-campaign-review-and-operations-evidence-verified-awaiting-five-role-release-approvals",
    scope: "release-preparation-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    authorizations: Object.freeze({
      signing: false,
      broadcast: false,
      gateOpening: false,
      funding: false,
    }),
    recordDigest: message.recordDigest,
    policyDigest: message.policyDigest,
    record,
    policy,
    evidence: Object.freeze({
      deploymentPromotionRecordDigest: deployment.deploymentPromotion,
      deploymentPromotionPolicyDigest: deploymentSummary.policyDigest,
      deploymentPostflightRecordDigest: deployment.deploymentPostflight,
      deploymentPostflightPolicyDigest: deploymentSummary.postflightPolicyDigest,
      independentReviewAttestationSetDigest: review.attestationSetDigest,
      independentReviewPolicyDigest: review.policyDigest,
      independentReviewRecordDigest: review.recordDigest,
      operationalReadinessAttestationSetDigest: operations.attestationSetDigest,
      adoptionPolicyDigest: operations.adoptionPolicyDigest,
      operationalReadinessPolicyDigest: operations.policyDigest,
      operationalReadinessRecordDigest: operations.recordDigest,
      safetyMonitorPolicyDigest: operations.safetyMonitorPolicyDigest,
      safetyMonitorUpstreamRecordDigest: operations.safetyMonitorReleaseRecordDigest,
      gateConfirmerBindingDigest: operations.gateConfirmerBindingDigest,
      publicTestnetRecordDigest: campaign.publicTestnet,
      publicTestnetPolicyDigest: publicTestnetVerification.policyDigest,
      qualificationReviewEvidenceDigest: qualification.evidenceDigest,
      qualificationReviewRecordDigest: qualification.recordDigest,
      qualificationReviewPolicyDigest: qualification.policyDigest,
      qualificationReviewAttestationDigest: qualification.attestationDigest,
      qualificationArtifactEvidenceDigest: composite("treeswap.release-qualification-artifact-evidence-digest.v1", {
        digest: qualification.qualificationEvidenceDigest,
      }),
      qualificationArtifactFileDigest: composite("treeswap.release-qualification-artifact-file-digest.v1", {
        digest: qualification.qualificationFileDigest,
      }),
    }),
    adoptionSummary: campaignSummary,
    approval: Object.freeze({
      primaryType: "ReleaseApproval",
      domain: Object.freeze({ ...approvalDomain, chainId: approvalDomain.chainId.toString() }),
      types: RELEASE_APPROVAL_TYPES,
      message,
    }),
  });
  verifiedCandidates.add(result);
  rememberCandidateRuntimeBinding(result, deploymentPromotionVerification.manifest, operations);
  return result;
}

export function preparePublicTestnetBootstrapReleaseCandidate(input) {
  const source = exactDataRecord(
    input,
    BOOTSTRAP_RELEASE_CANDIDATE_INPUT_FIELDS,
    "public-testnet bootstrap release candidate input",
  );
  const rawRecordTemplate = source.recordTemplate;
  const rawPolicyTemplate = source.policyTemplate;
  const bootstrapEvidenceVerification = source.bootstrapEvidenceVerification;
  const deploymentPromotionVerification = source.deploymentPromotionVerification;
  const independentReviewVerification = source.independentReviewVerification;
  const operationalReadinessVerification = source.operationalReadinessVerification;
  const qualificationReviewVerification = source.qualificationReviewVerification;
  const recordTemplate = normalizeRecordTemplate(rawRecordTemplate);
  const policyTemplate = normalizePolicyTemplate(rawPolicyTemplate);
  const bootstrap = buildPublicTestnetBootstrapReleaseEvidence(bootstrapEvidenceVerification);
  const deployment = buildDeploymentPromotionReleaseEvidence(deploymentPromotionVerification);
  const deploymentSummary = buildDeploymentPromotionSummary(deploymentPromotionVerification);
  const review = buildIndependentReviewReleaseEvidence(independentReviewVerification);
  const operations = buildOperationalReadinessReleaseEvidence(operationalReadinessVerification);
  const qualification = buildQualificationReviewReleaseEvidence(qualificationReviewVerification);
  requireEqual("bootstrap source commit", deploymentSummary.sourceCommit, bootstrap.reviewedBuildCommit);
  requireEqual("bootstrap chain", deploymentSummary.chainId, bootstrap.chainId);
  requireEqual("bootstrap gate", deploymentSummary.gate, bootstrap.verifyingContract);
  requireEqual("bootstrap deployment manifest", deploymentSummary.manifestDigest, bootstrap.deploymentManifestDigest);
  requireEqual("independent review source commit", deploymentSummary.sourceCommit, review.reviewedBuildCommit);
  requireEqual("independent review protocol version", recordTemplate.protocolVersion, review.protocolVersion);
  requireEqual("independent review chain", deploymentSummary.chainId, review.chainId);
  requireEqual("independent review gate", deploymentSummary.gate, review.verifyingContract);
  requireEqual("independent review deployment manifest", deploymentSummary.manifestDigest, review.deploymentManifestDigest);
  if (deploymentSummary.providerCount !== bootstrap.counts.independentEvmProviders) {
    throw new Error("deployment and bootstrap EVM provider counts do not match");
  }
  const promotedProviders = deploymentPromotionVerification.policy.approvers
    .filter((value) => value.role === "provider")
    .map((value) => ({ operatorId: value.approverId, signer: value.signer }));
  if (promotedProviders.length !== bootstrap.evmProviders.length
      || promotedProviders.some((value, index) => (
        value.operatorId !== bootstrap.evmProviders[index].operatorId
        || value.signer !== bootstrap.evmProviders[index].signer
      ))) {
    throw new Error("bootstrap EVM providers do not exactly match the signed deployment promotion");
  }
  if (recordTemplate.approvalBlockTimestamp < deploymentPromotionVerification.record.promotedAt) {
    throw new Error("bootstrap release approval block predates the verified deployment promotion");
  }
  if (recordTemplate.approvalBlockTimestamp > deploymentSummary.validUntil) {
    throw new Error("verified deployment promotion expired before the bootstrap release approval block");
  }
  if (recordTemplate.validFrom < deploymentPromotionVerification.record.promotedAt) {
    throw new Error("bootstrap release validity begins before the verified deployment promotion");
  }
  if (recordTemplate.approvalBlockTimestamp < bootstrap.preparedAt
      || recordTemplate.approvalBlockTimestamp > bootstrap.validUntil) {
    throw new Error("bootstrap release approval block is outside the signed operator-evidence interval");
  }
  if (recordTemplate.validFrom < bootstrap.preparedAt || recordTemplate.validUntil > bootstrap.validUntil) {
    throw new Error("bootstrap release validity is outside the signed operator-evidence interval");
  }
  if (recordTemplate.approvalBlockTimestamp < review.finishedAt
      || recordTemplate.approvalBlockTimestamp > review.validUntil) {
    throw new Error("bootstrap release approval block is outside the signed independent-review interval");
  }
  if (recordTemplate.validFrom < review.finishedAt || recordTemplate.validUntil > review.validUntil) {
    throw new Error("bootstrap release validity is outside the signed independent-review interval");
  }
  requireUniformMultisig(
    deploymentPromotionVerification.manifest,
    recordTemplate.multisig.ownerCount,
    recordTemplate.multisig.threshold,
  );
  requireBoundReleaseWallets(policyTemplate, deploymentPromotionVerification.manifest);
  requireIndependentReviewers(
    review,
    policyTemplate,
    deploymentPromotionVerification.manifest,
    [
      ...deploymentPromotionVerification.policy.approvers.map((value) => value.signer),
      ...bootstrapEvidenceVerification.record.participants.map((value) => value.signer),
      ...operations.participants.map((value) => value.signer),
      ...operations.serviceIsolationParticipants.map((value) => value.signer),
    ],
  );
  requireOperationalReadiness({
    operations,
    expectedFundingMode: "operator-testnet-bootstrap",
    upstreamRecordDigest: bootstrapEvidenceVerification.recordDigest,
    recordTemplate,
    policyTemplate,
    deploymentSummary,
    deploymentManifest: deploymentPromotionVerification.manifest,
    deploymentSigners: deploymentPromotionVerification.policy.approvers.map((value) => value.signer),
    upstreamParticipants: bootstrapEvidenceVerification.record.participants,
    upstreamAlertChannels: bootstrapEvidenceVerification.record.alertChannelEvidenceDigests,
    upstreamArtifacts: bootstrapEvidenceVerification.record.artifacts,
    review,
  });
  requireQualificationReview({
    qualification,
    expectedFundingMode: "operator-testnet-bootstrap",
    recordTemplate,
    deploymentSummary,
    upstreamArtifact: bootstrapEvidenceVerification.record.artifacts.testQualification,
    upstreamParticipants: bootstrapEvidenceVerification.record.participants,
    deploymentSigners: deploymentPromotionVerification.policy.approvers.map((value) => value.signer),
    deploymentParticipantIds: deploymentPromotionVerification.policy.approvers.map((value) => value.approverId),
    deploymentManifest: deploymentPromotionVerification.manifest,
    review,
    operations,
    policyTemplate,
  });
  requireAdoptionPolicy({
    operations,
    expectedFundingMode: "operator-testnet-bootstrap",
    recordTemplate,
    deploymentManifest: deploymentPromotionVerification.manifest,
    admissionPolicyDigest: bootstrap.artifacts.admissionPolicy,
    riskPolicyDigest: bootstrap.artifacts.riskPolicy,
    feeScheduleDigest: bootstrap.artifacts.feeSchedule,
  });
  const bootstrapBinding = Object.freeze({
    recordDigest: bootstrap.recordDigest,
    policyDigest: bootstrap.policyDigest,
    attestationSetDigest: bootstrap.attestationSetDigest,
    participantSetDigest: bootstrap.participantSetDigest,
  });
  const operationsBinding = Object.freeze({
    recordDigest: operations.recordDigest,
    policyDigest: operations.policyDigest,
    attestationSetDigest: operations.attestationSetDigest,
    participantSetDigest: operations.participantSetDigest,
    drillSetDigest: operations.drillSetDigest,
    alertChannelSetDigest: operations.alertChannelSetDigest,
    adoptionPolicyDigest: operations.adoptionPolicyDigest,
    safetyMonitorPolicyDigest: operations.safetyMonitorPolicyDigest,
    safetyMonitorUpstreamRecordDigest: operations.safetyMonitorReleaseRecordDigest,
    gateConfirmerBindingDigest: operations.gateConfirmerBindingDigest,
    serviceIsolationEvidenceDigest: operations.serviceIsolationEvidenceDigest,
    serviceIsolationParticipantSetDigest: operations.serviceIsolationParticipantSetDigest,
  });
  const evidenceDigests = Object.freeze({
    admissionPolicy: bootstrap.artifacts.admissionPolicy,
    backupRestore: composite("treeswap.release-bootstrap-backup-evidence.v2", {
      artifact: bootstrap.artifacts.backupRestore,
      bootstrap: bootstrapBinding,
      operations: operationsBinding,
    }),
    deploymentManifest: deployment.deploymentManifest,
    deploymentPostflight: composite("treeswap.release-postflight-evidence.v1", {
      recordDigest: deployment.deploymentPostflight,
      policyDigest: deploymentSummary.postflightPolicyDigest,
    }),
    deploymentPromotion: composite("treeswap.release-promotion-evidence.v1", {
      recordDigest: deployment.deploymentPromotion,
      policyDigest: deploymentSummary.policyDigest,
    }),
    feeSchedule: bootstrap.artifacts.feeSchedule,
    findingsDisposition: composite("treeswap.release-bootstrap-findings-evidence.v1", {
      bootstrap: bootstrap.artifacts.findingsDisposition,
      operatorEvidence: bootstrapBinding,
      deployment: deployment.findingsDisposition,
      deploymentReviewBundle: deployment.reviewBundle,
      independentReviewAttestations: review.attestationSetDigest,
      independentReviewFindings: review.findingsDispositionDigest,
      independentReviewPolicy: review.policyDigest,
      independentReviewRecord: review.recordDigest,
    }),
    incidentDrills: composite("treeswap.release-bootstrap-incident-evidence.v2", {
      artifact: bootstrap.artifacts.incidentDrills,
      bootstrap: bootstrapBinding,
      operations: operationsBinding,
    }),
    lossAllocation: composite("treeswap.release-bootstrap-loss-allocation-evidence.v1", {
      artifact: operations.artifacts.lossAllocation,
      operations: operationsBinding,
    }),
    monitoring: composite("treeswap.release-bootstrap-monitoring-evidence.v2", {
      artifact: bootstrap.artifacts.monitoring,
      bootstrap: bootstrapBinding,
      operations: operationsBinding,
    }),
    providerQuorum: composite("treeswap.release-bootstrap-provider-quorum-evidence.v1", {
      bootstrap: bootstrap.artifacts.providerQuorum,
      operatorEvidence: bootstrapBinding,
      deployment: deployment.providerQuorum,
      operations: operationsBinding,
    }),
    publicTestnet: `0x${"00".repeat(32)}`,
    riskPolicy: bootstrap.artifacts.riskPolicy,
    solverOperations: composite("treeswap.release-bootstrap-solver-operations-evidence.v2", {
      artifact: bootstrap.artifacts.solverOperations,
      bootstrap: bootstrapBinding,
      operations: operationsBinding,
    }),
    supportPolicy: composite("treeswap.release-bootstrap-support-evidence.v1", {
      artifact: operations.artifacts.supportPolicy,
      operations: operationsBinding,
    }),
    testQualification: composite("treeswap.release-bootstrap-qualification-evidence.v2", {
      artifact: bootstrap.artifacts.testQualification,
      bootstrap: bootstrapBinding,
      operations: operationsBinding,
      qualificationReview: qualification.evidenceDigest,
    }),
  });
  const counts = Object.freeze({
    ...bootstrap.counts,
    multisigOwnerCount: recordTemplate.multisig.ownerCount,
    multisigThreshold: recordTemplate.multisig.threshold,
  });
  const record = Object.freeze({
    schema: "treeswap.release-record.v2",
    releaseId: recordTemplate.releaseId,
    protocolVersion: recordTemplate.protocolVersion,
    environment: "public-testnet",
    fundingMode: "operator-testnet-bootstrap",
    chainId: deploymentSummary.chainId,
    verifyingContract: deploymentSummary.gate,
    approvalBlockNumber: recordTemplate.approvalBlockNumber,
    approvalBlockHash: recordTemplate.approvalBlockHash,
    approvalBlockTimestamp: recordTemplate.approvalBlockTimestamp,
    approvalProviderSetDigest: erc1271ProviderSetDigest(
      deploymentPromotionVerification.record.providerObservations.map((value) => value.providerIdentity),
    ),
    reviewedBuildCommit: deploymentSummary.sourceCommit,
    priorReleaseDigest: recordTemplate.priorReleaseDigest,
    evidenceDigests,
    reviewDigests: review.reviewDigests,
    counts,
    limits: recordTemplate.limits,
    features: recordTemplate.features,
    validFrom: recordTemplate.validFrom,
    validUntil: recordTemplate.validUntil,
  });
  const policy = Object.freeze({
    schema: "treeswap.release-policy.v2",
    environment: record.environment,
    chainId: record.chainId,
    verifyingContract: record.verifyingContract,
    reviewedBuildCommit: record.reviewedBuildCommit,
    deploymentManifestDigest: evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: evidenceDigests.deploymentPostflight,
    deploymentPromotionDigest: evidenceDigests.deploymentPromotion,
    admissionPolicyDigest: evidenceDigests.admissionPolicy,
    riskPolicyDigest: evidenceDigests.riskPolicy,
    feeScheduleDigest: evidenceDigests.feeSchedule,
    maximumReleaseLifetimeSeconds: policyTemplate.maximumReleaseLifetimeSeconds,
    maximumRuntimeObservationAgeSeconds: policyTemplate.maximumRuntimeObservationAgeSeconds,
    minimumCounts: counts,
    limitPolicy: policyTemplate.limitPolicy,
    approvers: policyTemplate.approvers,
  });
  const message = buildReleaseApprovalMessage(record, policy);
  const approvalDomain = releaseAuthorizationDomain(record);
  const result = Object.freeze({
    schema: "treeswap.prepared-public-testnet-bootstrap-release-candidate.v6",
    status: "deployment-bootstrap-review-and-operations-evidence-verified-awaiting-five-role-release-approvals",
    scope: "tiny-limit-bootstrap-release-preparation-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    authorizations: Object.freeze({ signing: false, broadcast: false, gateOpening: false, funding: false }),
    recordDigest: message.recordDigest,
    policyDigest: message.policyDigest,
    record,
    policy,
    evidence: Object.freeze({
      deploymentPromotionRecordDigest: deployment.deploymentPromotion,
      deploymentPromotionPolicyDigest: deploymentSummary.policyDigest,
      deploymentPostflightRecordDigest: deployment.deploymentPostflight,
      deploymentPostflightPolicyDigest: deploymentSummary.postflightPolicyDigest,
      independentReviewAttestationSetDigest: review.attestationSetDigest,
      independentReviewPolicyDigest: review.policyDigest,
      independentReviewRecordDigest: review.recordDigest,
      operationalReadinessAttestationSetDigest: operations.attestationSetDigest,
      adoptionPolicyDigest: operations.adoptionPolicyDigest,
      operationalReadinessPolicyDigest: operations.policyDigest,
      operationalReadinessRecordDigest: operations.recordDigest,
      safetyMonitorPolicyDigest: operations.safetyMonitorPolicyDigest,
      safetyMonitorUpstreamRecordDigest: operations.safetyMonitorReleaseRecordDigest,
      gateConfirmerBindingDigest: operations.gateConfirmerBindingDigest,
      bootstrapEvidenceDigest: composite("treeswap.release-bootstrap-operator-evidence.v2", bootstrapBinding),
      qualificationReviewEvidenceDigest: qualification.evidenceDigest,
      qualificationReviewRecordDigest: qualification.recordDigest,
      qualificationReviewPolicyDigest: qualification.policyDigest,
      qualificationReviewAttestationDigest: qualification.attestationDigest,
      qualificationArtifactEvidenceDigest: composite("treeswap.release-qualification-artifact-evidence-digest.v1", {
        digest: qualification.qualificationEvidenceDigest,
      }),
      qualificationArtifactFileDigest: composite("treeswap.release-qualification-artifact-file-digest.v1", {
        digest: qualification.qualificationFileDigest,
      }),
    }),
    approval: Object.freeze({
      primaryType: "ReleaseApproval",
      domain: Object.freeze({ ...approvalDomain, chainId: approvalDomain.chainId.toString() }),
      types: RELEASE_APPROVAL_TYPES,
      message,
    }),
  });
  verifiedCandidates.add(result);
  rememberCandidateRuntimeBinding(result, deploymentPromotionVerification.manifest, operations);
  return result;
}

export function verifiedPublicTestnetReleaseCandidateRuntimeBinding(candidate) {
  if (!verifiedCandidates.has(candidate)) throw new Error("public-testnet release candidate provenance is invalid");
  const binding = candidateRuntimeBindings.get(candidate);
  if (!binding) throw new Error("public-testnet release candidate runtime binding is unavailable");
  return binding;
}

export function buildPublicTestnetReleaseApproval(candidate) {
  if (!verifiedCandidates.has(candidate)) throw new Error("public-testnet release candidate provenance is invalid");
  const message = buildReleaseApprovalMessage(candidate.record, candidate.policy);
  return Object.freeze({
    domain: releaseAuthorizationDomain(candidate.record),
    types: RELEASE_APPROVAL_TYPES,
    value: message,
  });
}

export function buildPublicTestnetReleaseCandidateSummary(candidate) {
  if (!verifiedCandidates.has(candidate)) throw new Error("public-testnet release candidate provenance is invalid");
  return Object.freeze({
    schema: "treeswap.public-testnet-release-candidate-summary.v3",
    status: candidate.status,
    scope: candidate.scope,
    releaseId: candidate.record.releaseId,
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    adoptionPolicyDigest: candidate.evidence.adoptionPolicyDigest,
    chainId: candidate.record.chainId,
    gate: candidate.record.verifyingContract,
    reviewedBuildCommit: candidate.record.reviewedBuildCommit,
    approvalBlockNumber: candidate.record.approvalBlockNumber,
    approvalBlockHash: candidate.record.approvalBlockHash,
    validFrom: candidate.record.validFrom,
    validUntil: candidate.record.validUntil,
    counts: candidate.record.counts,
    fundingAuthorization: false,
  });
}
