#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJsonRpcClient, observeBitDeployment } from "../lib/bit-deployment-observer.mjs";

function parseArguments(values) {
  const parsed = { out: null, block: null };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--out" && values[index + 1]) {
      parsed.out = resolve(values[++index]);
    } else if (values[index] === "--block" && values[index + 1]) {
      parsed.block = values[++index];
    } else if (values[index] === "--help") {
      parsed.help = true;
    } else {
      throw new TypeError(`unknown argument: ${values[index]}`);
    }
  }
  return parsed;
}

function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: ETHEREUM_RPC_URL=<secret> npm run observe:bit -- [--block number] [--out evidence.json]\n");
    return;
  }

  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) throw new TypeError("ETHEREUM_RPC_URL is required");
  const observation = await observeBitDeployment({
    rpcCall: createJsonRpcClient(rpcUrl),
    providerLabel: process.env.ETHEREUM_RPC_PROVIDER_LABEL ?? "operator-supplied",
    sourceCommit: currentCommit(),
    targetBlockNumber: options.block,
  });
  const serialized = `${JSON.stringify(observation, null, 2)}\n`;

  if (options.out) {
    await writeFile(options.out, serialized, { flag: "wx", mode: 0o600 });
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
