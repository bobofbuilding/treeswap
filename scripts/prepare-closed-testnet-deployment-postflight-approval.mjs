#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import { buildClosedTestnetDeploymentPostflightApprovalMessage } from "../lib/closed-testnet-deployment-postflight.mjs";

const FLAGS = Object.freeze([
  "--approver-id", "--deployment-policy", "--observations", "--plan", "--policy", "--record", "--role",
  "--preflight-attestations", "--preflight-observations", "--preflight-policy", "--preflight-record",
]);
const USAGE = "Usage: prepare-closed-testnet-deployment-postflight-approval --plan plan.json --preflight-policy preflight-policy.json --preflight-record preflight-record.json --preflight-observations preflight-observations.json --preflight-attestations preflight-attestations.json --deployment-policy deployment-policy.json --policy postflight-policy.json --record postflight-record.json --observations postflight-observations.json --role role --approver-id 0x...";

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
  deploymentPolicy, policy, record, observations] = await Promise.all([
  readBoundedJson(options["--plan"], "deployment plan"),
  readBoundedJson(options["--preflight-policy"], "deployment preflight policy"),
  readBoundedJson(options["--preflight-record"], "deployment preflight record"),
  readBoundedJson(options["--preflight-observations"], "deployment preflight observations"),
  readBoundedJson(options["--preflight-attestations"], "deployment preflight attestations"),
  readBoundedJson(options["--deployment-policy"], "deployment policy"),
  readBoundedJson(options["--policy"], "deployment postflight policy"),
  readBoundedJson(options["--record"], "deployment postflight record"),
  readBoundedJson(options["--observations"], "deployment postflight observations"),
]);
const approval = buildClosedTestnetDeploymentPostflightApprovalMessage({
  preflight: { plan, policy: preflightPolicy, record: preflightRecord, observations: preflightObservations,
    attestations: preflightAttestations },
  deploymentPolicy,
  policy,
  record,
  observations,
  role: options["--role"],
  approverId: options["--approver-id"],
});
process.stdout.write(`${JSON.stringify({
  scope: "postflight-approval-only-no-signing-broadcast-gate-opening-or-funding-authorization",
  primaryType: "DeploymentPostflightApproval",
  domain: { ...approval.domain, chainId: approval.domain.chainId.toString() },
  types: approval.types,
  message: { ...approval.value, finalizedBlockNumber: approval.value.finalizedBlockNumber.toString() },
}, null, 2)}\n`);
