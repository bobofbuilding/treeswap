#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import { buildPublicTestnetReleaseRoleApprovalPayload } from "../lib/public-testnet-release-approval.mjs";

const FLAGS = Object.freeze(["--candidate", "--role"]);
const USAGE = "Usage: prepare-public-testnet-release-approval --candidate release-candidate.json --role controller|guardian|lightningOperator|securityReviewer|incidentCommander";

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
const candidate = await readBoundedJson(args["--candidate"], "prepared public-testnet release candidate");
const payload = buildPublicTestnetReleaseRoleApprovalPayload({ candidate, role: args["--role"] });
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
