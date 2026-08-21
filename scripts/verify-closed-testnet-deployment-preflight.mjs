#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildClosedTestnetDeploymentPreflightSummary,
  verifyClosedTestnetDeploymentPreflight,
} from "../lib/closed-testnet-deployment-preflight.mjs";

const FLAGS = Object.freeze(["--attestations", "--observations", "--plan", "--policy", "--record"]);
const USAGE = "Usage: verify-closed-testnet-deployment-preflight --plan unsigned-plan.json --record record.json --policy policy.json --observations observations.json --attestations attestations.json";

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
const [plan, record, policy, observations, attestations] = await Promise.all([
  readBoundedJson(options["--plan"], "deployment plan"),
  readBoundedJson(options["--record"], "preflight record"),
  readBoundedJson(options["--policy"], "preflight policy"),
  readBoundedJson(options["--observations"], "preflight observations"),
  readBoundedJson(options["--attestations"], "preflight attestations"),
]);
const verification = verifyClosedTestnetDeploymentPreflight({ plan, record, policy, observations, attestations });
process.stdout.write(`${JSON.stringify({
  status: verification.status,
  scope: verification.scope,
  recordDigest: verification.recordDigest,
  policyDigest: verification.policyDigest,
  summary: buildClosedTestnetDeploymentPreflightSummary(verification),
}, null, 2)}\n`);
