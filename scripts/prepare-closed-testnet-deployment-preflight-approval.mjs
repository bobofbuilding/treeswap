#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import { buildClosedTestnetDeploymentPreflightApprovalMessage } from "../lib/closed-testnet-deployment-preflight.mjs";

const FLAGS = Object.freeze(["--approver-id", "--observations", "--plan", "--policy", "--record", "--role"]);
const USAGE = "Usage: prepare-closed-testnet-deployment-preflight-approval --plan unsigned-plan.json --record record.json --policy policy.json --observations observations.json --role role --approver-id 0x...";

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
const [plan, record, policy, observations] = await Promise.all([
  readBoundedJson(options["--plan"], "deployment plan"),
  readBoundedJson(options["--record"], "preflight record"),
  readBoundedJson(options["--policy"], "preflight policy"),
  readBoundedJson(options["--observations"], "preflight observations"),
]);
const approval = buildClosedTestnetDeploymentPreflightApprovalMessage({
  plan,
  record,
  policy,
  observations,
  role: options["--role"],
  approverId: options["--approver-id"],
});
process.stdout.write(`${JSON.stringify({
  scope: "preflight-approval-only-no-signing-broadcast-gate-opening-or-funding-authorization",
  primaryType: "ClosedTestnetDeploymentPreflightApproval",
  domain: { ...approval.domain, chainId: approval.domain.chainId.toString() },
  types: approval.types,
  message: approval.value,
}, null, 2)}\n`);
