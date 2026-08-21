import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import {
  buildDeploymentPromotionReleaseEvidence,
  buildDeploymentPromotionSummary,
} from "./deployment-manifest-promotion.mjs";
import {
  buildPublicTestnetAdoptionSummary,
  buildPublicTestnetReleaseEvidence,
} from "./public-testnet-evidence.mjs";
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
  "externalEvidenceDigests",
  "features",
  "limits",
  "multisig",
  "priorReleaseDigest",
  "protocolVersion",
  "releaseId",
  "reviewDigests",
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
const EXTERNAL_EVIDENCE_FIELDS = Object.freeze(["lossAllocation", "supportPolicy"]);
const REVIEW_FIELDS = Object.freeze(["contracts", "coordinator", "identityPrivacy", "lightning", "operations"]);
const MULTISIG_FIELDS = Object.freeze(["ownerCount", "threshold"]);
const BOOTSTRAP_EVIDENCE_FIELDS = Object.freeze([
  "admissionPolicy",
  "backupRestore",
  "counts",
  "feeSchedule",
  "findingsDisposition",
  "incidentDrills",
  "monitoring",
  "providerQuorum",
  "riskPolicy",
  "schema",
  "solverOperations",
  "testQualification",
]);
const BOOTSTRAP_COUNT_FIELDS = Object.freeze([
  "alertChannels",
  "independentEvmProviders",
  "independentLightningObservers",
  "independentMonitors",
  "independentRelays",
  "independentSolvers",
]);
const BOOTSTRAP_DIGEST_FIELDS = Object.freeze([
  "admissionPolicy",
  "backupRestore",
  "feeSchedule",
  "findingsDisposition",
  "incidentDrills",
  "monitoring",
  "providerQuorum",
  "riskPolicy",
  "solverOperations",
  "testQualification",
]);
const verifiedCandidates = new WeakSet();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
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

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.freeze(value);
}

function frozenClone(value) {
  return deepFreeze(structuredClone(value));
}

function hash(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function digest(value, name, { allowZero = false } = {}) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || (!allowZero && normalized === `0x${"00".repeat(32)}`)) {
    throw new TypeError(`${name} must be a ${allowZero ? "" : "nonzero "}lowercase bytes32 digest`);
  }
  return normalized;
}

function decimal(value, name, { positive = false } = {}) {
  const normalized = String(value ?? "");
  if (!DECIMAL.test(normalized)) throw new TypeError(`${name} must be a canonical uint256 decimal string`);
  const parsed = BigInt(normalized);
  if (parsed > UINT256_MAX || (positive && parsed === 0n)) throw new RangeError(`${name} is outside uint256`);
  return normalized;
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function normalizeDigestMap(value, fields, name, options) {
  exactKeys(value, fields, name);
  return Object.freeze(Object.fromEntries(fields.map((field) => [
    field,
    digest(value[field], `${name}.${field}`, options),
  ])));
}

function normalizeRecordTemplate(raw) {
  exactKeys(raw, RECORD_TEMPLATE_FIELDS, "public-testnet release record template");
  if (raw.schema !== "treeswap.public-testnet-release-record-template.v1") {
    throw new TypeError("public-testnet release record template schema is invalid");
  }
  exactKeys(raw.multisig, MULTISIG_FIELDS, "recordTemplate.multisig");
  const ownerCount = count(raw.multisig.ownerCount, "recordTemplate.multisig.ownerCount");
  const threshold = count(raw.multisig.threshold, "recordTemplate.multisig.threshold");
  if (threshold > ownerCount) throw new RangeError("recordTemplate multisig threshold exceeds owner count");
  return Object.freeze({
    schema: raw.schema,
    releaseId: digest(raw.releaseId, "recordTemplate.releaseId"),
    protocolVersion: String(raw.protocolVersion ?? ""),
    approvalBlockNumber: decimal(raw.approvalBlockNumber, "recordTemplate.approvalBlockNumber", { positive: true }),
    approvalBlockHash: digest(raw.approvalBlockHash, "recordTemplate.approvalBlockHash"),
    approvalBlockTimestamp: timestamp(raw.approvalBlockTimestamp, "recordTemplate.approvalBlockTimestamp"),
    priorReleaseDigest: digest(raw.priorReleaseDigest, "recordTemplate.priorReleaseDigest", { allowZero: true }),
    externalEvidenceDigests: normalizeDigestMap(
      raw.externalEvidenceDigests,
      EXTERNAL_EVIDENCE_FIELDS,
      "recordTemplate.externalEvidenceDigests",
    ),
    reviewDigests: normalizeDigestMap(raw.reviewDigests, REVIEW_FIELDS, "recordTemplate.reviewDigests"),
    multisig: Object.freeze({ ownerCount, threshold }),
    limits: frozenClone(raw.limits),
    features: frozenClone(raw.features),
    validFrom: timestamp(raw.validFrom, "recordTemplate.validFrom"),
    validUntil: timestamp(raw.validUntil, "recordTemplate.validUntil"),
  });
}

function normalizePolicyTemplate(raw) {
  exactKeys(raw, POLICY_TEMPLATE_FIELDS, "public-testnet release policy template");
  if (raw.schema !== "treeswap.public-testnet-release-policy-template.v1") {
    throw new TypeError("public-testnet release policy template schema is invalid");
  }
  return Object.freeze({
    schema: raw.schema,
    maximumReleaseLifetimeSeconds: raw.maximumReleaseLifetimeSeconds,
    maximumRuntimeObservationAgeSeconds: raw.maximumRuntimeObservationAgeSeconds,
    limitPolicy: frozenClone(raw.limitPolicy),
    approvers: frozenClone(raw.approvers),
  });
}

function normalizeBootstrapEvidence(raw) {
  exactKeys(raw, BOOTSTRAP_EVIDENCE_FIELDS, "public-testnet bootstrap evidence");
  if (raw.schema !== "treeswap.public-testnet-bootstrap-evidence.v1") {
    throw new TypeError("public-testnet bootstrap evidence schema is invalid");
  }
  exactKeys(raw.counts, BOOTSTRAP_COUNT_FIELDS, "bootstrapEvidence.counts");
  const counts = Object.freeze(Object.fromEntries(BOOTSTRAP_COUNT_FIELDS.map((field) => {
    const value = count(raw.counts[field], `bootstrapEvidence.counts.${field}`);
    if (value < 2 || value > 20) throw new RangeError(`bootstrapEvidence.counts.${field} is outside two to twenty`);
    return [field, value];
  })));
  const digestValues = Object.fromEntries(BOOTSTRAP_DIGEST_FIELDS.map((field) => [field, raw[field]]));
  return Object.freeze({
    schema: raw.schema,
    ...normalizeDigestMap(digestValues, BOOTSTRAP_DIGEST_FIELDS, "bootstrapEvidence"),
    counts,
  });
}

function composite(schema, fields) {
  return hash(Object.freeze({ schema, ...fields }));
}

function requireEqual(name, left, right) {
  if (left !== right) throw new Error(`${name} does not match across verified deployment and campaign evidence`);
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
  }
}

export function preparePublicTestnetReleaseCandidate({
  recordTemplate: rawRecordTemplate,
  policyTemplate: rawPolicyTemplate,
  deploymentPromotionVerification,
  publicTestnetVerification,
}) {
  const recordTemplate = normalizeRecordTemplate(rawRecordTemplate);
  const policyTemplate = normalizePolicyTemplate(rawPolicyTemplate);
  const deployment = buildDeploymentPromotionReleaseEvidence(deploymentPromotionVerification);
  const deploymentSummary = buildDeploymentPromotionSummary(deploymentPromotionVerification);
  const campaign = buildPublicTestnetReleaseEvidence(publicTestnetVerification);
  const campaignSummary = buildPublicTestnetAdoptionSummary(publicTestnetVerification);

  requireEqual("deployment manifest", deployment.deploymentManifest, campaign.deploymentManifest);
  requireEqual("source commit", deploymentSummary.sourceCommit, campaignSummary.sourceCommit);
  requireEqual("chain", deploymentSummary.chainId, campaignSummary.chainId);
  requireEqual("gate", deploymentSummary.gate, publicTestnetVerification.record.verifyingContract);
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
  requireUniformMultisig(
    deploymentPromotionVerification.manifest,
    recordTemplate.multisig.ownerCount,
    recordTemplate.multisig.threshold,
  );
  requireBoundReleaseWallets(policyTemplate, deploymentPromotionVerification.manifest);

  const evidenceDigests = Object.freeze({
    admissionPolicy: campaign.admissionPolicy,
    backupRestore: campaign.backupRestore,
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
    }),
    incidentDrills: campaign.incidentDrills,
    lossAllocation: recordTemplate.externalEvidenceDigests.lossAllocation,
    monitoring: campaign.monitoring,
    providerQuorum: composite("treeswap.release-provider-quorum-evidence.v1", {
      campaign: campaign.providerQuorum,
      deployment: deployment.providerQuorum,
    }),
    publicTestnet: composite("treeswap.release-public-testnet-evidence.v1", {
      recordDigest: campaign.publicTestnet,
      policyDigest: publicTestnetVerification.policyDigest,
    }),
    riskPolicy: campaign.riskPolicy,
    solverOperations: campaign.solverOperations,
    supportPolicy: recordTemplate.externalEvidenceDigests.supportPolicy,
    testQualification: campaign.testQualification,
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
    reviewDigests: recordTemplate.reviewDigests,
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
    schema: "treeswap.prepared-public-testnet-release-candidate.v1",
    status: "upstream-evidence-verified-awaiting-five-role-release-approvals",
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
      publicTestnetRecordDigest: campaign.publicTestnet,
      publicTestnetPolicyDigest: publicTestnetVerification.policyDigest,
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
  return result;
}

export function preparePublicTestnetBootstrapReleaseCandidate({
  recordTemplate: rawRecordTemplate,
  policyTemplate: rawPolicyTemplate,
  bootstrapEvidence: rawBootstrapEvidence,
  deploymentPromotionVerification,
}) {
  const recordTemplate = normalizeRecordTemplate(rawRecordTemplate);
  const policyTemplate = normalizePolicyTemplate(rawPolicyTemplate);
  const bootstrap = normalizeBootstrapEvidence(rawBootstrapEvidence);
  const deployment = buildDeploymentPromotionReleaseEvidence(deploymentPromotionVerification);
  const deploymentSummary = buildDeploymentPromotionSummary(deploymentPromotionVerification);
  if (deploymentSummary.providerCount !== bootstrap.counts.independentEvmProviders) {
    throw new Error("deployment and bootstrap EVM provider counts do not match");
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
  requireUniformMultisig(
    deploymentPromotionVerification.manifest,
    recordTemplate.multisig.ownerCount,
    recordTemplate.multisig.threshold,
  );
  requireBoundReleaseWallets(policyTemplate, deploymentPromotionVerification.manifest);
  const evidenceDigests = Object.freeze({
    admissionPolicy: bootstrap.admissionPolicy,
    backupRestore: bootstrap.backupRestore,
    deploymentManifest: deployment.deploymentManifest,
    deploymentPostflight: composite("treeswap.release-postflight-evidence.v1", {
      recordDigest: deployment.deploymentPostflight,
      policyDigest: deploymentSummary.postflightPolicyDigest,
    }),
    deploymentPromotion: composite("treeswap.release-promotion-evidence.v1", {
      recordDigest: deployment.deploymentPromotion,
      policyDigest: deploymentSummary.policyDigest,
    }),
    feeSchedule: bootstrap.feeSchedule,
    findingsDisposition: composite("treeswap.release-bootstrap-findings-evidence.v1", {
      bootstrap: bootstrap.findingsDisposition,
      deployment: deployment.findingsDisposition,
      deploymentReviewBundle: deployment.reviewBundle,
    }),
    incidentDrills: bootstrap.incidentDrills,
    lossAllocation: recordTemplate.externalEvidenceDigests.lossAllocation,
    monitoring: bootstrap.monitoring,
    providerQuorum: composite("treeswap.release-bootstrap-provider-quorum-evidence.v1", {
      bootstrap: bootstrap.providerQuorum,
      deployment: deployment.providerQuorum,
    }),
    publicTestnet: `0x${"00".repeat(32)}`,
    riskPolicy: bootstrap.riskPolicy,
    solverOperations: bootstrap.solverOperations,
    supportPolicy: recordTemplate.externalEvidenceDigests.supportPolicy,
    testQualification: bootstrap.testQualification,
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
    reviewDigests: recordTemplate.reviewDigests,
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
    schema: "treeswap.prepared-public-testnet-bootstrap-release-candidate.v1",
    status: "deployment-and-bootstrap-evidence-verified-awaiting-five-role-release-approvals",
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
      bootstrapEvidenceDigest: hash(bootstrap),
    }),
    approval: Object.freeze({
      primaryType: "ReleaseApproval",
      domain: Object.freeze({ ...approvalDomain, chainId: approvalDomain.chainId.toString() }),
      types: RELEASE_APPROVAL_TYPES,
      message,
    }),
  });
  verifiedCandidates.add(result);
  return result;
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
    schema: "treeswap.public-testnet-release-candidate-summary.v1",
    status: candidate.status,
    scope: candidate.scope,
    releaseId: candidate.record.releaseId,
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
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
