#!/usr/bin/env node

import { createJsonRpcClient } from "../lib/bit-deployment-observer.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import { observeClosedTestnetDeploymentPostflight } from "../lib/closed-testnet-deployment-postflight-observer.mjs";
import { closedTestnetDeploymentPostflightValueDigest } from "../lib/closed-testnet-deployment-postflight.mjs";

const REQUIRED = Object.freeze([
  "--deployment-policy", "--out", "--plan", "--preflight-attestations", "--preflight-observations",
  "--preflight-policy", "--preflight-record", "--transactions",
]);
const USAGE = "Usage: observe-closed-testnet-deployment-postflight --plan plan.json --preflight-policy preflight-policy.json --preflight-record preflight-record.json --preflight-observations preflight-observations.json --preflight-attestations preflight-attestations.json --deployment-policy deployment-policy.json --transactions transactions.json --out observation.json [--block number]";

function argumentsFrom(values) {
  if (![REQUIRED.length * 2, (REQUIRED.length + 1) * 2].includes(values.length)) throw new Error(USAGE);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (![...REQUIRED, "--block"].includes(flag) || options[flag] || !values[index + 1]) throw new Error(USAGE);
    options[flag] = values[index + 1];
  }
  if (REQUIRED.some((flag) => !options[flag])) throw new Error(USAGE);
  if (options["--block"] && !/^(?:0|[1-9][0-9]*)$/.test(options["--block"])) throw new Error(USAGE);
  return options;
}

const options = argumentsFrom(process.argv.slice(2));
const rpcUrl = process.env.ETHEREUM_RPC_URL;
const providerLabel = process.env.ETHEREUM_RPC_PROVIDER_LABEL;
const providerIdentity = process.env.ETHEREUM_RPC_PROVIDER_IDENTITY;
if (!rpcUrl || !providerLabel || !providerIdentity) {
  throw new Error("ETHEREUM_RPC_URL, ETHEREUM_RPC_PROVIDER_LABEL, and ETHEREUM_RPC_PROVIDER_IDENTITY are required");
}
const [plan, preflightPolicy, preflightRecord, preflightObservations, preflightAttestations,
  deploymentPolicy, transactions] = await Promise.all([
  readBoundedJson(options["--plan"], "deployment plan"),
  readBoundedJson(options["--preflight-policy"], "deployment preflight policy"),
  readBoundedJson(options["--preflight-record"], "deployment preflight record"),
  readBoundedJson(options["--preflight-observations"], "deployment preflight observations"),
  readBoundedJson(options["--preflight-attestations"], "deployment preflight attestations"),
  readBoundedJson(options["--deployment-policy"], "deployment policy"),
  readBoundedJson(options["--transactions"], "deployment execution transactions"),
]);
const observation = await observeClosedTestnetDeploymentPostflight({
  rpcCall: createJsonRpcClient(rpcUrl),
  preflight: {
    plan,
    policy: preflightPolicy,
    record: preflightRecord,
    observations: preflightObservations,
    attestations: preflightAttestations,
  },
  deploymentPolicy,
  transactions,
  providerLabel,
  providerIdentity,
  targetBlockNumber: options["--block"] ? Number(options["--block"]) : null,
});
const output = await writeExclusiveJson(options["--out"], observation);
process.stdout.write(`${JSON.stringify({
  status: "captured-unreviewed-finalized-deployment-execution",
  scope: "observation-only-no-signing-broadcast-gate-opening-or-funding-authorization",
  providerIdentity: observation.providerIdentity,
  finalizedBlock: observation.finalizedBlock,
  observationDigest: closedTestnetDeploymentPostflightValueDigest(observation),
  output,
  signingAuthorization: false,
  broadcastAuthorization: false,
  gateOpeningAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
