import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildDeploymentPromotionReleaseEvidence,
  buildDeploymentPromotionSummary,
  verifyDeploymentManifestPromotion,
} from "../lib/deployment-manifest-promotion.mjs";
import { verifyDeploymentPromotionPostflightBundle } from "../lib/deployment-promotion-postflight-bundle.mjs";

const FLAGS = Object.freeze([
  "--attestations",
  "--deployment-policy",
  "--observations",
  "--postflight-bundle",
  "--policy",
  "--record",
]);
const USAGE = "Usage: verify-deployment-promotion --record record.json --policy policy.json --deployment-policy deployment-policy.json --observations observations.json --attestations attestations.json --postflight-bundle postflight-bundle.json";

function argumentsFromCommandLine(values) {
  const result = {};
  if (values.length !== FLAGS.length * 2) throw new Error(USAGE);
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || !FLAGS.includes(flag) || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  return result;
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const [record, policy, deploymentPolicy, observations, attestations, postflightBundle] = await Promise.all([
  readBoundedJson(args["--record"], "record"),
  readBoundedJson(args["--policy"], "policy"),
  readBoundedJson(args["--deployment-policy"], "deployment policy"),
  readBoundedJson(args["--observations"], "observations"),
  readBoundedJson(args["--attestations"], "attestations"),
  readBoundedJson(args["--postflight-bundle"], "postflight bundle"),
]);
const postflightVerification = verifyDeploymentPromotionPostflightBundle({
  bundle: postflightBundle,
  deploymentPolicy,
  promotedAt: record.promotedAt,
});
const verification = verifyDeploymentManifestPromotion({
  record,
  policy,
  deploymentPolicy,
  observations,
  postflightVerification,
  attestations,
});
process.stdout.write(`${JSON.stringify({
  status: verification.status,
  scope: verification.scope,
  recordDigest: verification.recordDigest,
  policyDigest: verification.policyDigest,
  releaseEvidence: buildDeploymentPromotionReleaseEvidence(verification),
  summary: buildDeploymentPromotionSummary(verification),
}, null, 2)}\n`);
