#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildOperationalReadinessEvidenceSummary,
  verifyOperationalReadinessEvidence,
} from "../lib/operational-readiness-evidence.mjs";

const USAGE = "Usage: verify-operational-readiness-evidence --record record.json --policy policy.json --attestations attestations.json";

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
  readBoundedJson(args["--record"], "operational readiness record"),
  readBoundedJson(args["--policy"], "operational readiness policy"),
  readBoundedJson(args["--attestations"], "operational readiness attestations"),
]);
const verification = verifyOperationalReadinessEvidence({ record, policy, attestations });
process.stdout.write(`${JSON.stringify(buildOperationalReadinessEvidenceSummary(verification), null, 2)}\n`);
