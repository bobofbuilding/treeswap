import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import { buildDeploymentPromotionApprovalMessage } from "../lib/deployment-manifest-promotion.mjs";
import { verifyDeploymentPromotionPostflightBundle } from "../lib/deployment-promotion-postflight-bundle.mjs";

const FLAGS = Object.freeze([
  "--approver-id",
  "--deployment-policy",
  "--observations",
  "--postflight-bundle",
  "--policy",
  "--record",
  "--role",
]);
const USAGE = "Usage: prepare-deployment-promotion-approval --record record.json --policy policy.json --deployment-policy deployment-policy.json --observations observations.json --postflight-bundle postflight-bundle.json --role role --approver-id 0x...";

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
const [record, policy, deploymentPolicy, observations, postflightBundle] = await Promise.all([
  readBoundedJson(args["--record"], "record"),
  readBoundedJson(args["--policy"], "policy"),
  readBoundedJson(args["--deployment-policy"], "deployment policy"),
  readBoundedJson(args["--observations"], "observations"),
  readBoundedJson(args["--postflight-bundle"], "postflight bundle"),
]);
const postflightVerification = verifyDeploymentPromotionPostflightBundle({
  bundle: postflightBundle,
  deploymentPolicy,
  promotedAt: record.promotedAt,
});
const approval = buildDeploymentPromotionApprovalMessage({
  record,
  policy,
  deploymentPolicy,
  observations,
  postflightVerification,
  role: args["--role"],
  approverId: args["--approver-id"],
});
process.stdout.write(`${JSON.stringify({
  scope: "deployment-promotion-approval-only-no-funding-authorization",
  primaryType: "ManifestPromotionApproval",
  domain: { ...approval.domain, chainId: approval.domain.chainId.toString() },
  types: approval.types,
  message: approval.value,
}, null, 2)}\n`);
