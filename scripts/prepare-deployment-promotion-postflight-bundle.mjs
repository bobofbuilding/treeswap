#!/usr/bin/env node

import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import { verifyDeploymentPromotionPostflightBundle } from "../lib/deployment-promotion-postflight-bundle.mjs";

const FLAGS = Object.freeze([
  "--attestations",
  "--deployment-policy",
  "--observations",
  "--out",
  "--plan",
  "--policy",
  "--preflight-attestations",
  "--preflight-observations",
  "--preflight-policy",
  "--preflight-record",
  "--promotion-record",
  "--record",
]);
const USAGE = "Usage: prepare-deployment-promotion-postflight-bundle --plan plan.json --preflight-policy preflight-policy.json --preflight-record preflight-record.json --preflight-observations preflight-observations.json --preflight-attestations preflight-attestations.json --deployment-policy deployment-policy.json --policy postflight-policy.json --record postflight-record.json --observations postflight-observations.json --attestations postflight-attestations.json --promotion-record promotion-record.json --out postflight-bundle.json";

function argumentsFrom(values) {
  if (values.length !== FLAGS.length * 2) throw new Error(USAGE);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (!FLAGS.includes(flag) || options[flag] || !values[index + 1]) throw new Error(USAGE);
    options[flag] = values[index + 1];
  }
  return options;
}

const options = argumentsFrom(process.argv.slice(2));
const [plan, preflightPolicy, preflightRecord, preflightObservations, preflightAttestations,
  deploymentPolicy, policy, record, observations, attestations, promotionRecord] = await Promise.all([
  readBoundedJson(options["--plan"], "deployment plan"),
  readBoundedJson(options["--preflight-policy"], "deployment preflight policy"),
  readBoundedJson(options["--preflight-record"], "deployment preflight record"),
  readBoundedJson(options["--preflight-observations"], "deployment preflight observations"),
  readBoundedJson(options["--preflight-attestations"], "deployment preflight attestations"),
  readBoundedJson(options["--deployment-policy"], "deployment policy"),
  readBoundedJson(options["--policy"], "deployment postflight policy"),
  readBoundedJson(options["--record"], "deployment postflight record"),
  readBoundedJson(options["--observations"], "deployment postflight observations"),
  readBoundedJson(options["--attestations"], "deployment postflight attestations"),
  readBoundedJson(options["--promotion-record"], "deployment promotion record"),
]);
const bundle = {
  schema: "treeswap.deployment-promotion-postflight-bundle.v1",
  plan,
  preflightPolicy,
  preflightRecord,
  preflightObservations,
  preflightAttestations,
  policy,
  record,
  observations,
  attestations,
};
if (Buffer.byteLength(JSON.stringify(bundle)) > 1_000_000) {
  throw new Error("deployment promotion postflight bundle exceeds 1 MB");
}
const verification = verifyDeploymentPromotionPostflightBundle({
  bundle,
  deploymentPolicy,
  promotedAt: promotionRecord.promotedAt,
});
if (promotionRecord.postflightRecordDigest !== verification.recordDigest
    || promotionRecord.postflightPolicyDigest !== verification.policyDigest) {
  throw new Error("deployment promotion record does not bind the verified postflight bundle");
}
const output = await writeExclusiveJson(options["--out"], bundle);
process.stdout.write(`${JSON.stringify({
  status: "prepared-verified-deployment-promotion-postflight-bundle",
  scope: "bundle-only-no-signing-broadcast-gate-opening-or-funding-authorization",
  postflightRecordDigest: verification.recordDigest,
  postflightPolicyDigest: verification.policyDigest,
  output,
  signingAuthorization: false,
  broadcastAuthorization: false,
  gateOpeningAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
