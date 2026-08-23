#!/usr/bin/env node

import {
  readBoundedFile,
  readBoundedJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import { buildQualificationReviewAttestationMessage } from "../lib/qualification-review-evidence.mjs";

const FLAGS = Object.freeze(["--artifact", "--policy", "--review"]);
const USAGE = "Usage: prepare-qualification-review-attestation --artifact qualification.json --review review.json --policy policy.json";

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
const [qualificationFileBytes, review, policy] = await Promise.all([
  readBoundedFile(args["--artifact"], "qualification artifact"),
  readBoundedJson(args["--review"], "qualification review"),
  readBoundedJson(args["--policy"], "qualification review policy"),
]);
const typed = buildQualificationReviewAttestationMessage({ qualificationFileBytes, review, policy });
process.stdout.write(`${JSON.stringify({
  scope: "qualification-review-attestation-only-no-signing-or-funding-authorization",
  primaryType: "QualificationReviewAttestation",
  domain: Object.freeze({ ...typed.domain, chainId: typed.domain.chainId.toString() }),
  types: typed.types,
  message: typed.value,
}, null, 2)}\n`);
