#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJsonRpcClient,
  observeBitDeployment,
} from "../lib/bit-deployment-observer.mjs";
import { currentPublishedBitSource, revalidatePublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: ETHEREUM_RPC_URL=<secret> ETHEREUM_RPC_PROVIDER_LABEL=<label> ETHEREUM_RPC_PROVIDER_IDENTITY=<bytes32> npm run observe:bit -- [--block number] [--out evidence.json]";

function parseArguments(values) {
  const parsed = { out: null, block: null };
  if (values.length === 1 && values[0] === "--help") return { ...parsed, help: true };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--out" && values[index + 1]
        && !values[index + 1].startsWith("--") && parsed.out === null) {
      parsed.out = resolve(values[++index]);
    } else if (values[index] === "--block" && values[index + 1]
        && !values[index + 1].startsWith("--") && parsed.block === null) {
      parsed.block = values[++index];
    } else {
      throw new TypeError(USAGE);
    }
  }
  return parsed;
}

function currentPublishedCommit() {
  return currentPublishedBitSource(repository).sourceCommit;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  const providerLabel = process.env.ETHEREUM_RPC_PROVIDER_LABEL;
  const providerIdentity = process.env.ETHEREUM_RPC_PROVIDER_IDENTITY;
  if (!rpcUrl || !providerLabel || !providerIdentity) {
    throw new TypeError("ETHEREUM_RPC_URL, ETHEREUM_RPC_PROVIDER_LABEL, and ETHEREUM_RPC_PROVIDER_IDENTITY are required");
  }
  const sourceCommit = currentPublishedCommit();
  delete process.env.ETHEREUM_RPC_URL;
  const observation = await observeBitDeployment({
    rpcCall: createJsonRpcClient(rpcUrl),
    providerLabel,
    providerIdentity,
    sourceCommit,
    targetBlockNumber: options.block,
  });
  revalidatePublishedBitSource(repository, sourceCommit);
  const serialized = `${JSON.stringify(observation, null, 2)}\n`;

  if (options.out) {
    await writeExclusiveJson(options.out, observation);
    process.stdout.write(`${options.out}\n`);
  } else {
    process.stdout.write(serialized);
  }
  if (!observation.safety.eligible) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT observation failed"}\n`);
  process.exitCode = 1;
});
