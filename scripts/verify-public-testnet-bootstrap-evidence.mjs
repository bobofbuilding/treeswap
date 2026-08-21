#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildPublicTestnetBootstrapEvidenceSummary,
  verifyPublicTestnetBootstrapEvidence,
} from "../lib/public-testnet-bootstrap-evidence.mjs";

const USAGE = "Usage: verify-public-testnet-bootstrap-evidence --record record.json --policy policy.json --attestations attestations.json";

function argumentsFromCommandLine(values) {
  const allowed = new Set(["--attestations", "--policy", "--record"]);
  if (values.length !== 6) throw new Error(USAGE);
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
const [record, policy, attestations] = await Promise.all([
  readBoundedJson(args["--record"], "bootstrap evidence record"),
  readBoundedJson(args["--policy"], "bootstrap evidence policy"),
  readBoundedJson(args["--attestations"], "bootstrap evidence attestations"),
]);
const verification = verifyPublicTestnetBootstrapEvidence({ record, policy, attestations });
process.stdout.write(`${JSON.stringify(buildPublicTestnetBootstrapEvidenceSummary(verification), null, 2)}\n`);
