#!/usr/bin/env node

import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildClosedTestnetDeploymentPreflightRecord,
  closedTestnetDeploymentPreflightValueDigest,
} from "../lib/closed-testnet-deployment-preflight.mjs";

const FLAGS = Object.freeze(["--observations", "--out", "--plan", "--policy", "--preflight-id"]);
const USAGE = "Usage: prepare-closed-testnet-deployment-preflight-record --plan unsigned-plan.json --policy policy.json --observations observations.json --preflight-id 0x... --out record.json";

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
const [plan, policy, observations] = await Promise.all([
  readBoundedJson(options["--plan"], "deployment plan"),
  readBoundedJson(options["--policy"], "preflight policy"),
  readBoundedJson(options["--observations"], "preflight observations"),
]);
const record = buildClosedTestnetDeploymentPreflightRecord({
  plan,
  policy,
  observations,
  preflightId: options["--preflight-id"],
});
const output = await writeExclusiveJson(options["--out"], record);
process.stdout.write(`${JSON.stringify({
  status: "prepared-fresh-closed-testnet-deployment-preflight-record",
  scope: "record-only-no-signing-broadcast-gate-opening-or-funding-authorization",
  recordDigest: closedTestnetDeploymentPreflightValueDigest(record),
  planDigest: record.planDigest,
  preparedAt: record.preparedAt,
  validUntil: record.validUntil,
  output,
  signingAuthorization: false,
  broadcastAuthorization: false,
  gateOpeningAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
