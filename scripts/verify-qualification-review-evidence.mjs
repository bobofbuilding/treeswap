#!/usr/bin/env node

import {
  readBoundedFile,
  readBoundedJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildQualificationReviewSummary,
  verifyQualificationReviewEvidence,
} from "../lib/qualification-review-evidence.mjs";

const FLAGS = Object.freeze(["--artifact", "--attestation", "--policy", "--review"]);
const USAGE = "Usage: verify-qualification-review-evidence --artifact qualification.json --review review.json --policy policy.json --attestation attestation.json";

function argumentsFromCommandLine(values) {
  if (values.length !== FLAGS.length * 2) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!FLAGS.includes(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  return result;
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const [qualificationFileBytes, review, policy, attestation] = await Promise.all([
  readBoundedFile(args["--artifact"], "qualification artifact"),
  readBoundedJson(args["--review"], "qualification review"),
  readBoundedJson(args["--policy"], "qualification review policy"),
  readBoundedJson(args["--attestation"], "qualification review attestation"),
]);
const verification = verifyQualificationReviewEvidence({
  qualificationFileBytes,
  review,
  policy,
  attestation,
});
process.stdout.write(`${JSON.stringify(buildQualificationReviewSummary(verification), null, 2)}\n`);
