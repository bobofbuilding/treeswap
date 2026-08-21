#!/usr/bin/env node

import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildClosedTestnetDeploymentPostflightRecord,
  closedTestnetDeploymentPostflightValueDigest,
} from "../lib/closed-testnet-deployment-postflight.mjs";

const FLAGS = Object.freeze([
  "--deployment-policy", "--observations", "--out", "--plan", "--policy", "--postflight-id",
  "--preflight-attestations", "--preflight-observations", "--preflight-policy", "--preflight-record",
]);
const USAGE = "Usage: prepare-closed-testnet-deployment-postflight-record --plan plan.json --preflight-policy preflight-policy.json --preflight-record preflight-record.json --preflight-observations preflight-observations.json --preflight-attestations preflight-attestations.json --deployment-policy deployment-policy.json --policy postflight-policy.json --observations postflight-observations.json --postflight-id 0x... --out record.json";

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

async function inputs(options) {
  const [plan, preflightPolicy, preflightRecord, preflightObservations, preflightAttestations,
    deploymentPolicy, policy, observations] = await Promise.all([
    readBoundedJson(options["--plan"], "deployment plan"),
    readBoundedJson(options["--preflight-policy"], "deployment preflight policy"),
    readBoundedJson(options["--preflight-record"], "deployment preflight record"),
    readBoundedJson(options["--preflight-observations"], "deployment preflight observations"),
    readBoundedJson(options["--preflight-attestations"], "deployment preflight attestations"),
    readBoundedJson(options["--deployment-policy"], "deployment policy"),
    readBoundedJson(options["--policy"], "deployment postflight policy"),
    readBoundedJson(options["--observations"], "deployment postflight observations"),
  ]);
  return {
    preflight: { plan, policy: preflightPolicy, record: preflightRecord, observations: preflightObservations,
      attestations: preflightAttestations },
    deploymentPolicy,
    policy,
    observations,
  };
}

const options = argumentsFrom(process.argv.slice(2));
const values = await inputs(options);
const record = buildClosedTestnetDeploymentPostflightRecord({
  ...values,
  postflightId: options["--postflight-id"],
});
const output = await writeExclusiveJson(options["--out"], record);
process.stdout.write(`${JSON.stringify({
  status: "prepared-fresh-closed-testnet-deployment-postflight-record",
  scope: "record-only-no-signing-broadcast-gate-opening-or-funding-authorization",
  recordDigest: closedTestnetDeploymentPostflightValueDigest(record),
  planDigest: record.planDigest,
  finalizedBlockNumber: record.finalizedBlockNumber,
  preparedAt: record.preparedAt,
  validUntil: record.validUntil,
  output,
  signingAuthorization: false,
  broadcastAuthorization: false,
  gateOpeningAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
