#!/usr/bin/env node

import { createJsonRpcClient } from "../lib/bit-deployment-observer.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  deploymentObservationValueDigest,
  observeDeploymentManifest,
} from "../lib/deployment-observer.mjs";

const USAGE = "Usage: observe-deployment-manifest --input observation-input.json --out observation.json [--block number]";
const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_FIELDS = Object.freeze([
  "bitProxy",
  "controller",
  "feeCollector",
  "gate",
  "guardian",
  "paymentHashRegistry",
  "userEscrow",
  "vault",
]);

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function argumentsFrom(values) {
  if (![4, 6].includes(values.length)) throw new Error(USAGE);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (!["--block", "--input", "--out"].includes(flag) || options[flag] || !values[index + 1]) throw new Error(USAGE);
    options[flag] = values[index + 1];
  }
  if (!options["--input"] || !options["--out"]) throw new Error(USAGE);
  if (options["--block"] && !/^(?:0|[1-9][0-9]*)$/.test(options["--block"])) throw new Error(USAGE);
  return options;
}

function normalizeInput(value) {
  exactKeys(value, ["addresses", "independentReviewDigest", "reviewedBuildCommit", "schema"], "observation input");
  if (value.schema !== "treeswap.deployment-observation-input.v1") throw new TypeError("observation input schema is invalid");
  if (!COMMIT.test(String(value.reviewedBuildCommit ?? ""))) throw new TypeError("reviewed build commit is invalid");
  if (!BYTES32.test(String(value.independentReviewDigest ?? ""))) throw new TypeError("independent review digest is invalid");
  exactKeys(value.addresses, ADDRESS_FIELDS, "deployment addresses");
  for (const [name, address] of Object.entries(value.addresses)) {
    if (!ADDRESS.test(String(address ?? ""))) throw new TypeError(`${name} address is invalid`);
  }
  return value;
}

const options = argumentsFrom(process.argv.slice(2));
const rpcUrl = process.env.ETHEREUM_RPC_URL;
const providerLabel = process.env.ETHEREUM_RPC_PROVIDER_LABEL;
const providerIdentity = process.env.ETHEREUM_RPC_PROVIDER_IDENTITY;
if (!rpcUrl || !providerLabel || !providerIdentity) {
  throw new Error("ETHEREUM_RPC_URL, ETHEREUM_RPC_PROVIDER_LABEL, and ETHEREUM_RPC_PROVIDER_IDENTITY are required");
}
const input = normalizeInput(await readBoundedJson(options["--input"], "deployment observation input"));
const observation = await observeDeploymentManifest({
  rpcCall: createJsonRpcClient(rpcUrl),
  providerLabel,
  providerIdentity,
  addresses: input.addresses,
  reviewedBuildCommit: input.reviewedBuildCommit,
  independentReviewDigest: input.independentReviewDigest,
  targetBlockNumber: options["--block"] ? Number(options["--block"]) : null,
});
const output = await writeExclusiveJson(options["--out"], observation);
process.stdout.write(`${JSON.stringify({
  status: "captured-unreviewed-finalized-deployment-observation",
  scope: "observation-only-no-signing-gate-opening-or-funding-authorization",
  providerIdentity: observation.providerIdentity,
  finalizedBlock: observation.finalizedBlock,
  manifestDigest: observation.manifestDigest,
  observationDigest: deploymentObservationValueDigest(observation),
  output,
  signingAuthorization: false,
  gateOpeningAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
