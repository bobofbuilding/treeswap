#!/usr/bin/env node

import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import { verifyDeploymentManifestPromotion } from "../lib/deployment-manifest-promotion.mjs";
import { verifyDeploymentPromotionPostflightBundle } from "../lib/deployment-promotion-postflight-bundle.mjs";
import { verifyPublicTestnetBootstrapEvidence } from "../lib/public-testnet-bootstrap-evidence.mjs";
import { verifyIndependentReviewEvidence } from "../lib/independent-review-evidence.mjs";
import { verifyOperationalReadinessEvidence } from "../lib/operational-readiness-evidence.mjs";
import {
  buildPublicTestnetReleaseCandidateSummary,
  preparePublicTestnetBootstrapReleaseCandidate,
} from "../lib/public-testnet-release-candidate.mjs";

const FLAGS = Object.freeze([
  "--bootstrap-attestations",
  "--bootstrap-policy",
  "--bootstrap-record",
  "--deployment-policy",
  "--out",
  "--operations-attestations",
  "--operations-policy",
  "--operations-record",
  "--policy-template",
  "--postflight-bundle",
  "--promotion-attestations",
  "--promotion-observations",
  "--promotion-policy",
  "--promotion-record",
  "--record-template",
  "--review-attestations",
  "--review-policy",
  "--review-record",
]);
const USAGE = "Usage: prepare-public-testnet-bootstrap-release-candidate --record-template record-template.json --policy-template policy-template.json --bootstrap-record bootstrap-record.json --bootstrap-policy bootstrap-policy.json --bootstrap-attestations bootstrap-attestations.json --promotion-record promotion-record.json --promotion-policy promotion-policy.json --deployment-policy deployment-policy.json --promotion-observations promotion-observations.json --promotion-attestations promotion-attestations.json --postflight-bundle postflight-bundle.json --review-record review-record.json --review-policy review-policy.json --review-attestations review-attestations.json --operations-record operations-record.json --operations-policy operations-policy.json --operations-attestations operations-attestations.json --out bootstrap-release-candidate.json";

function argumentsFromCommandLine(values) {
  if (values.length !== FLAGS.length * 2) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || !FLAGS.includes(flag) || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  return result;
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const [recordTemplate, policyTemplate, bootstrapRecord, bootstrapPolicy, bootstrapAttestations,
  promotionRecord, promotionPolicy, deploymentPolicy, promotionObservations, promotionAttestations,
  postflightBundle, reviewRecord, reviewPolicy, reviewAttestations, operationsRecord,
  operationsPolicy, operationsAttestations] = await Promise.all([
  readBoundedJson(args["--record-template"], "bootstrap release record template"),
  readBoundedJson(args["--policy-template"], "bootstrap release policy template"),
  readBoundedJson(args["--bootstrap-record"], "bootstrap evidence record"),
  readBoundedJson(args["--bootstrap-policy"], "bootstrap evidence policy"),
  readBoundedJson(args["--bootstrap-attestations"], "bootstrap evidence attestations"),
  readBoundedJson(args["--promotion-record"], "deployment promotion record"),
  readBoundedJson(args["--promotion-policy"], "deployment promotion policy"),
  readBoundedJson(args["--deployment-policy"], "deployment policy"),
  readBoundedJson(args["--promotion-observations"], "deployment promotion observations"),
  readBoundedJson(args["--promotion-attestations"], "deployment promotion attestations"),
  readBoundedJson(args["--postflight-bundle"], "deployment postflight bundle"),
  readBoundedJson(args["--review-record"], "independent review record"),
  readBoundedJson(args["--review-policy"], "independent review policy"),
  readBoundedJson(args["--review-attestations"], "independent review attestations"),
  readBoundedJson(args["--operations-record"], "operational readiness record"),
  readBoundedJson(args["--operations-policy"], "operational readiness policy"),
  readBoundedJson(args["--operations-attestations"], "operational readiness attestations"),
]);
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
  now: recordTemplate.approvalBlockTimestamp,
});
const bootstrapEvidenceVerification = verifyPublicTestnetBootstrapEvidence({
  record: bootstrapRecord,
  policy: bootstrapPolicy,
  attestations: bootstrapAttestations,
  now: recordTemplate.approvalBlockTimestamp,
});
const independentReviewVerification = verifyIndependentReviewEvidence({
  record: reviewRecord,
  policy: reviewPolicy,
  attestations: reviewAttestations,
  now: recordTemplate.approvalBlockTimestamp,
});
const operationalReadinessVerification = verifyOperationalReadinessEvidence({
  record: operationsRecord,
  policy: operationsPolicy,
  attestations: operationsAttestations,
  now: recordTemplate.approvalBlockTimestamp,
});
const candidate = preparePublicTestnetBootstrapReleaseCandidate({
  recordTemplate,
  policyTemplate,
  bootstrapEvidenceVerification,
  deploymentPromotionVerification,
  independentReviewVerification,
  operationalReadinessVerification,
});
if (Buffer.byteLength(JSON.stringify(candidate)) > 1_000_000) {
  throw new Error("public-testnet bootstrap release candidate exceeds 1 MB");
}
const output = await writeExclusiveJson(args["--out"], candidate);
process.stdout.write(`${JSON.stringify({
  ...buildPublicTestnetReleaseCandidateSummary(candidate),
  output,
  signingAuthorization: false,
  broadcastAuthorization: false,
  gateOpeningAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
