#!/usr/bin/env node

import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import { verifyDeploymentManifestPromotion } from "../lib/deployment-manifest-promotion.mjs";
import { verifyDeploymentPromotionPostflightBundle } from "../lib/deployment-promotion-postflight-bundle.mjs";
import { verifyPublicTestnetCampaign } from "../lib/public-testnet-evidence.mjs";
import {
  buildPublicTestnetReleaseCandidateSummary,
  preparePublicTestnetReleaseCandidate,
} from "../lib/public-testnet-release-candidate.mjs";

const FLAGS = Object.freeze([
  "--campaign-attestations",
  "--campaign-policy",
  "--campaign-record",
  "--deployment-policy",
  "--out",
  "--policy-template",
  "--postflight-bundle",
  "--promotion-attestations",
  "--promotion-observations",
  "--promotion-policy",
  "--promotion-record",
  "--record-template",
]);
const USAGE = "Usage: prepare-public-testnet-release-candidate --record-template record-template.json --policy-template policy-template.json --promotion-record promotion-record.json --promotion-policy promotion-policy.json --deployment-policy deployment-policy.json --promotion-observations promotion-observations.json --promotion-attestations promotion-attestations.json --postflight-bundle postflight-bundle.json --campaign-record campaign-record.json --campaign-policy campaign-policy.json --campaign-attestations campaign-attestations.json --out release-candidate.json";

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
const [recordTemplate, policyTemplate, promotionRecord, promotionPolicy, deploymentPolicy,
  promotionObservations, promotionAttestations, postflightBundle, campaignRecord, campaignPolicy,
  campaignAttestations] = await Promise.all([
  readBoundedJson(args["--record-template"], "release record template"),
  readBoundedJson(args["--policy-template"], "release policy template"),
  readBoundedJson(args["--promotion-record"], "deployment promotion record"),
  readBoundedJson(args["--promotion-policy"], "deployment promotion policy"),
  readBoundedJson(args["--deployment-policy"], "deployment policy"),
  readBoundedJson(args["--promotion-observations"], "deployment promotion observations"),
  readBoundedJson(args["--promotion-attestations"], "deployment promotion attestations"),
  readBoundedJson(args["--postflight-bundle"], "deployment postflight bundle"),
  readBoundedJson(args["--campaign-record"], "public-testnet campaign record"),
  readBoundedJson(args["--campaign-policy"], "public-testnet campaign policy"),
  readBoundedJson(args["--campaign-attestations"], "public-testnet campaign attestations"),
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
const candidate = preparePublicTestnetReleaseCandidate({
  recordTemplate,
  policyTemplate,
  deploymentPromotionVerification,
  publicTestnetVerification,
});
if (Buffer.byteLength(JSON.stringify(candidate)) > 1_000_000) {
  throw new Error("public-testnet release candidate exceeds 1 MB");
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
