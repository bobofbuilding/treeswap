import { readBoundedFile, readBoundedJson } from "./closed-testnet-deployment-files.mjs";
import { verifyDeploymentManifestPromotion } from "./deployment-manifest-promotion.mjs";
import { verifyDeploymentPromotionPostflightBundle } from "./deployment-promotion-postflight-bundle.mjs";
import { verifyPublicTestnetCampaign } from "./public-testnet-evidence.mjs";
import { verifyPublicTestnetBootstrapEvidence } from "./public-testnet-bootstrap-evidence.mjs";
import { verifyIndependentReviewEvidence } from "./independent-review-evidence.mjs";
import { verifyOperationalReadinessEvidence } from "./operational-readiness-evidence.mjs";
import { verifyServiceIsolationEvidence } from "./service-isolation-evidence.mjs";
import { verifyQualificationReviewEvidence } from "./qualification-review-evidence.mjs";
import {
  preparePublicTestnetBootstrapReleaseCandidate,
  preparePublicTestnetReleaseCandidate,
} from "./public-testnet-release-candidate.mjs";

export const PUBLIC_TESTNET_RELEASE_EVIDENCE_PATH_FIELDS = Object.freeze([
  "adoptionPolicy",
  "campaignAttestations",
  "campaignPolicy",
  "campaignRecord",
  "deploymentPolicy",
  "isolationAttestations",
  "isolationPolicy",
  "isolationRecord",
  "operationsAttestations",
  "operationsPolicy",
  "operationsRecord",
  "operationsSafetyMonitorPolicy",
  "policyTemplate",
  "postflightBundle",
  "promotionAttestations",
  "promotionObservations",
  "promotionPolicy",
  "promotionRecord",
  "qualificationArtifact",
  "qualificationAttestation",
  "qualificationPolicy",
  "qualificationReview",
  "recordTemplate",
  "reviewAttestations",
  "reviewPolicy",
  "reviewRecord",
]);

export const PUBLIC_TESTNET_BOOTSTRAP_RELEASE_EVIDENCE_PATH_FIELDS = Object.freeze([
  "adoptionPolicy",
  "bootstrapAttestations",
  "bootstrapPolicy",
  "bootstrapRecord",
  "deploymentPolicy",
  "isolationAttestations",
  "isolationPolicy",
  "isolationRecord",
  "operationsAttestations",
  "operationsPolicy",
  "operationsRecord",
  "operationsSafetyMonitorPolicy",
  "policyTemplate",
  "postflightBundle",
  "promotionAttestations",
  "promotionObservations",
  "promotionPolicy",
  "promotionRecord",
  "qualificationArtifact",
  "qualificationAttestation",
  "qualificationPolicy",
  "qualificationReview",
  "recordTemplate",
  "reviewAttestations",
  "reviewPolicy",
  "reviewRecord",
]);

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

export async function rebuildPublicTestnetReleaseCandidateFromFiles(paths) {
  exactKeys(paths, PUBLIC_TESTNET_RELEASE_EVIDENCE_PATH_FIELDS, "public-testnet release evidence paths");
  for (const field of PUBLIC_TESTNET_RELEASE_EVIDENCE_PATH_FIELDS) {
    if (typeof paths[field] !== "string" || paths[field].length === 0 || paths[field].length > 4_096) {
      throw new TypeError(`public-testnet release evidence path ${field} is invalid`);
    }
  }

  const [recordTemplate, policyTemplate, adoptionPolicy, promotionRecord, promotionPolicy, deploymentPolicy,
    promotionObservations, promotionAttestations, postflightBundle, campaignRecord, campaignPolicy,
    campaignAttestations, reviewRecord, reviewPolicy, reviewAttestations, operationsRecord,
    operationsPolicy, operationsAttestations, operationsSafetyMonitorPolicy, isolationRecord, isolationPolicy,
    isolationAttestations, qualificationFileBytes, qualificationReview, qualificationPolicy,
    qualificationAttestation] = await Promise.all([
    readBoundedJson(paths.recordTemplate, "release record template"),
    readBoundedJson(paths.policyTemplate, "release policy template"),
    readBoundedJson(paths.adoptionPolicy, "adoption policy"),
    readBoundedJson(paths.promotionRecord, "deployment promotion record"),
    readBoundedJson(paths.promotionPolicy, "deployment promotion policy"),
    readBoundedJson(paths.deploymentPolicy, "deployment policy"),
    readBoundedJson(paths.promotionObservations, "deployment promotion observations"),
    readBoundedJson(paths.promotionAttestations, "deployment promotion attestations"),
    readBoundedJson(paths.postflightBundle, "deployment postflight bundle"),
    readBoundedJson(paths.campaignRecord, "public-testnet campaign record"),
    readBoundedJson(paths.campaignPolicy, "public-testnet campaign policy"),
    readBoundedJson(paths.campaignAttestations, "public-testnet campaign attestations"),
    readBoundedJson(paths.reviewRecord, "independent review record"),
    readBoundedJson(paths.reviewPolicy, "independent review policy"),
    readBoundedJson(paths.reviewAttestations, "independent review attestations"),
    readBoundedJson(paths.operationsRecord, "operational readiness record"),
    readBoundedJson(paths.operationsPolicy, "operational readiness policy"),
    readBoundedJson(paths.operationsAttestations, "operational readiness attestations"),
    readBoundedJson(paths.operationsSafetyMonitorPolicy, "operational safety monitor policy"),
    readBoundedJson(paths.isolationRecord, "service isolation record"),
    readBoundedJson(paths.isolationPolicy, "service isolation policy"),
    readBoundedJson(paths.isolationAttestations, "service isolation attestations"),
    readBoundedFile(paths.qualificationArtifact, "qualification artifact"),
    readBoundedJson(paths.qualificationReview, "qualification review"),
    readBoundedJson(paths.qualificationPolicy, "qualification review policy"),
    readBoundedJson(paths.qualificationAttestation, "qualification review attestation"),
  ]);
  const verificationTime = recordTemplate.approvalBlockTimestamp;
  const postflightVerification = verifyDeploymentPromotionPostflightBundle({
    bundle: postflightBundle,
    deploymentPolicy,
    promotedAt: promotionRecord.promotedAt,
  });
  const deploymentPromotionVerification = verifyDeploymentManifestPromotion({
    record: promotionRecord,
    policy: promotionPolicy,
    deploymentPolicy,
    observations: promotionObservations,
    postflightVerification,
    attestations: promotionAttestations,
    now: verificationTime,
  });
  const publicTestnetVerification = verifyPublicTestnetCampaign({
    record: campaignRecord,
    policy: campaignPolicy,
    attestations: campaignAttestations,
    now: verificationTime,
  });
  const independentReviewVerification = verifyIndependentReviewEvidence({
    record: reviewRecord,
    policy: reviewPolicy,
    attestations: reviewAttestations,
    now: verificationTime,
  });
  const serviceIsolationVerification = verifyServiceIsolationEvidence({
    record: isolationRecord,
    policy: isolationPolicy,
    attestations: isolationAttestations,
    now: verificationTime,
  });
  const operationalReadinessVerification = verifyOperationalReadinessEvidence({
    adoptionPolicy,
    record: operationsRecord,
    policy: operationsPolicy,
    safetyMonitorPolicy: operationsSafetyMonitorPolicy,
    attestations: operationsAttestations,
    serviceIsolationVerification,
    now: verificationTime,
  });
  const qualificationReviewVerification = verifyQualificationReviewEvidence({
    qualificationFileBytes,
    review: qualificationReview,
    policy: qualificationPolicy,
    attestation: qualificationAttestation,
    now: verificationTime,
  });
  return preparePublicTestnetReleaseCandidate({
    recordTemplate,
    policyTemplate,
    deploymentPromotionVerification,
    independentReviewVerification,
    operationalReadinessVerification,
    publicTestnetVerification,
    qualificationReviewVerification,
  });
}

export async function rebuildPublicTestnetBootstrapReleaseCandidateFromFiles(paths) {
  exactKeys(
    paths,
    PUBLIC_TESTNET_BOOTSTRAP_RELEASE_EVIDENCE_PATH_FIELDS,
    "public-testnet bootstrap release evidence paths",
  );
  for (const field of PUBLIC_TESTNET_BOOTSTRAP_RELEASE_EVIDENCE_PATH_FIELDS) {
    if (typeof paths[field] !== "string" || paths[field].length === 0 || paths[field].length > 4_096) {
      throw new TypeError(`public-testnet bootstrap release evidence path ${field} is invalid`);
    }
  }

  const [recordTemplate, policyTemplate, adoptionPolicy, bootstrapRecord, bootstrapPolicy,
    bootstrapAttestations, promotionRecord, promotionPolicy, deploymentPolicy, promotionObservations,
    promotionAttestations, postflightBundle, reviewRecord, reviewPolicy, reviewAttestations,
    operationsRecord, operationsPolicy, operationsAttestations, operationsSafetyMonitorPolicy,
    isolationRecord, isolationPolicy,
    isolationAttestations, qualificationFileBytes, qualificationReview, qualificationPolicy,
    qualificationAttestation] = await Promise.all([
    readBoundedJson(paths.recordTemplate, "bootstrap release record template"),
    readBoundedJson(paths.policyTemplate, "bootstrap release policy template"),
    readBoundedJson(paths.adoptionPolicy, "adoption policy"),
    readBoundedJson(paths.bootstrapRecord, "bootstrap evidence record"),
    readBoundedJson(paths.bootstrapPolicy, "bootstrap evidence policy"),
    readBoundedJson(paths.bootstrapAttestations, "bootstrap evidence attestations"),
    readBoundedJson(paths.promotionRecord, "deployment promotion record"),
    readBoundedJson(paths.promotionPolicy, "deployment promotion policy"),
    readBoundedJson(paths.deploymentPolicy, "deployment policy"),
    readBoundedJson(paths.promotionObservations, "deployment promotion observations"),
    readBoundedJson(paths.promotionAttestations, "deployment promotion attestations"),
    readBoundedJson(paths.postflightBundle, "deployment postflight bundle"),
    readBoundedJson(paths.reviewRecord, "independent review record"),
    readBoundedJson(paths.reviewPolicy, "independent review policy"),
    readBoundedJson(paths.reviewAttestations, "independent review attestations"),
    readBoundedJson(paths.operationsRecord, "operational readiness record"),
    readBoundedJson(paths.operationsPolicy, "operational readiness policy"),
    readBoundedJson(paths.operationsAttestations, "operational readiness attestations"),
    readBoundedJson(paths.operationsSafetyMonitorPolicy, "operational safety monitor policy"),
    readBoundedJson(paths.isolationRecord, "service isolation record"),
    readBoundedJson(paths.isolationPolicy, "service isolation policy"),
    readBoundedJson(paths.isolationAttestations, "service isolation attestations"),
    readBoundedFile(paths.qualificationArtifact, "qualification artifact"),
    readBoundedJson(paths.qualificationReview, "qualification review"),
    readBoundedJson(paths.qualificationPolicy, "qualification review policy"),
    readBoundedJson(paths.qualificationAttestation, "qualification review attestation"),
  ]);
  const verificationTime = recordTemplate.approvalBlockTimestamp;
  const postflightVerification = verifyDeploymentPromotionPostflightBundle({
    bundle: postflightBundle,
    deploymentPolicy,
    promotedAt: promotionRecord.promotedAt,
  });
  const deploymentPromotionVerification = verifyDeploymentManifestPromotion({
    record: promotionRecord,
    policy: promotionPolicy,
    deploymentPolicy,
    observations: promotionObservations,
    postflightVerification,
    attestations: promotionAttestations,
    now: verificationTime,
  });
  const bootstrapEvidenceVerification = verifyPublicTestnetBootstrapEvidence({
    record: bootstrapRecord,
    policy: bootstrapPolicy,
    attestations: bootstrapAttestations,
    now: verificationTime,
  });
  const independentReviewVerification = verifyIndependentReviewEvidence({
    record: reviewRecord,
    policy: reviewPolicy,
    attestations: reviewAttestations,
    now: verificationTime,
  });
  const serviceIsolationVerification = verifyServiceIsolationEvidence({
    record: isolationRecord,
    policy: isolationPolicy,
    attestations: isolationAttestations,
    now: verificationTime,
  });
  const operationalReadinessVerification = verifyOperationalReadinessEvidence({
    adoptionPolicy,
    record: operationsRecord,
    policy: operationsPolicy,
    safetyMonitorPolicy: operationsSafetyMonitorPolicy,
    attestations: operationsAttestations,
    serviceIsolationVerification,
    now: verificationTime,
  });
  const qualificationReviewVerification = verifyQualificationReviewEvidence({
    qualificationFileBytes,
    review: qualificationReview,
    policy: qualificationPolicy,
    attestation: qualificationAttestation,
    now: verificationTime,
  });
  return preparePublicTestnetBootstrapReleaseCandidate({
    recordTemplate,
    policyTemplate,
    bootstrapEvidenceVerification,
    deploymentPromotionVerification,
    independentReviewVerification,
    operationalReadinessVerification,
    qualificationReviewVerification,
  });
}
