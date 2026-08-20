import { lstat, readFile } from "node:fs/promises";
import {
  buildDeploymentPromotionReleaseEvidence,
  buildDeploymentPromotionSummary,
  verifyDeploymentManifestPromotion,
} from "../lib/deployment-manifest-promotion.mjs";

const FLAGS = Object.freeze([
  "--attestations",
  "--deployment-policy",
  "--observations",
  "--policy",
  "--record",
]);
const USAGE = "Usage: verify-deployment-promotion --record record.json --policy policy.json --deployment-policy deployment-policy.json --observations observations.json --attestations attestations.json";

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

async function boundedJson(path, name) {
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink() || state.size === 0 || state.size > 1_000_000) {
    throw new Error(`${name} must be a non-symlink JSON file no larger than 1 MB`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const [record, policy, deploymentPolicy, observations, attestations] = await Promise.all([
  boundedJson(args["--record"], "record"),
  boundedJson(args["--policy"], "policy"),
  boundedJson(args["--deployment-policy"], "deployment policy"),
  boundedJson(args["--observations"], "observations"),
  boundedJson(args["--attestations"], "attestations"),
]);
const verification = verifyDeploymentManifestPromotion({
  record,
  policy,
  deploymentPolicy,
  observations,
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
