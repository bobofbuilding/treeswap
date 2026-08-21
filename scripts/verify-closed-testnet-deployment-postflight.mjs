#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildClosedTestnetDeploymentPostflightSummary,
  verifyClosedTestnetDeploymentPostflight,
} from "../lib/closed-testnet-deployment-postflight.mjs";

const FLAGS = Object.freeze([
  "--attestations", "--deployment-policy", "--observations", "--plan", "--policy", "--record",
  "--preflight-attestations", "--preflight-observations", "--preflight-policy", "--preflight-record",
]);
const USAGE = "Usage: verify-closed-testnet-deployment-postflight --plan plan.json --preflight-policy preflight-policy.json --preflight-record preflight-record.json --preflight-observations preflight-observations.json --preflight-attestations preflight-attestations.json --deployment-policy deployment-policy.json --policy postflight-policy.json --record postflight-record.json --observations postflight-observations.json --attestations postflight-attestations.json";

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
  deploymentPolicy, policy, record, observations, attestations] = await Promise.all([
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
]);
const verification = verifyClosedTestnetDeploymentPostflight({
  preflight: { plan, policy: preflightPolicy, record: preflightRecord, observations: preflightObservations,
    attestations: preflightAttestations },
  deploymentPolicy,
  policy,
  record,
  observations,
  attestations,
});
process.stdout.write(`${JSON.stringify({
  status: verification.status,
  scope: verification.scope,
  recordDigest: verification.recordDigest,
  policyDigest: verification.policyDigest,
  summary: buildClosedTestnetDeploymentPostflightSummary(verification),
}, null, 2)}\n`);
