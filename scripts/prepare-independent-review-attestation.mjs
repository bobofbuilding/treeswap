#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import { buildIndependentReviewAttestationMessage } from "../lib/independent-review-evidence.mjs";

const USAGE = "Usage: prepare-independent-review-attestation --record record.json --policy policy.json --role role --reviewer-id 0x...";

function argumentsFromCommandLine(values) {
  const allowed = new Set(["--policy", "--record", "--reviewer-id", "--role"]);
  if (values.length !== 8) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!allowed.has(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  return result;
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const [record, policy] = await Promise.all([
  readBoundedJson(args["--record"], "independent review record"),
  readBoundedJson(args["--policy"], "independent review policy"),
]);
const typed = buildIndependentReviewAttestationMessage({
  record,
  policy,
  role: args["--role"],
  reviewerId: args["--reviewer-id"],
});
process.stdout.write(`${JSON.stringify({
  scope: "independent-review-attestation-only-no-signing-or-funding-authorization",
  primaryType: "IndependentReviewAttestation",
  domain: Object.freeze({ ...typed.domain, chainId: typed.domain.chainId.toString() }),
  types: typed.types,
  message: typed.value,
}, null, 2)}\n`);
