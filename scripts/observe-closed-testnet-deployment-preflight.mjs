#!/usr/bin/env node

import { createJsonRpcClient } from "../lib/bit-deployment-observer.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import { observeClosedTestnetDeploymentPreflight } from "../lib/closed-testnet-deployment-preflight-observer.mjs";
import { closedTestnetDeploymentPreflightValueDigest } from "../lib/closed-testnet-deployment-preflight.mjs";

const USAGE = "Usage: observe-closed-testnet-deployment-preflight --plan unsigned-plan.json --out observation.json [--block number]";

function argumentsFrom(values) {
  if (![4, 6].includes(values.length)) throw new Error(USAGE);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (!["--block", "--out", "--plan"].includes(flag) || options[flag] || !values[index + 1]) throw new Error(USAGE);
    options[flag] = values[index + 1];
  }
  if (!options["--plan"] || !options["--out"]) throw new Error(USAGE);
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
const plan = await readBoundedJson(options["--plan"], "deployment plan");
const observation = await observeClosedTestnetDeploymentPreflight({
  rpcCall: createJsonRpcClient(rpcUrl),
  plan,
  providerLabel,
  providerIdentity,
  targetBlockNumber: options["--block"] ? Number(options["--block"]) : null,
});
const output = await writeExclusiveJson(options["--out"], observation);
process.stdout.write(`${JSON.stringify({
  status: "captured-unreviewed-live-deployment-preflight-observation",
  scope: "observation-only-no-signing-broadcast-gate-opening-or-funding-authorization",
  providerIdentity: observation.providerIdentity,
  anchorBlock: observation.anchorBlock,
  observationDigest: closedTestnetDeploymentPreflightValueDigest(observation),
  output,
  signingAuthorization: false,
  broadcastAuthorization: false,
  gateOpeningAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
