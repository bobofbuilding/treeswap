#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJsonRpcClient,
  observeBitDeployment,
  validateBitObservationSourceProvenance,
} from "../lib/bit-deployment-observer.mjs";
import { writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function git(arguments_) {
  try {
    return execFileSync("git", arguments_, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("BIT observation source provenance check failed");
  }
}

function currentPublishedCommit() {
  const remote = git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]).split(/\s+/, 1)[0];
  return validateBitObservationSourceProvenance({
    branch: git(["branch", "--show-current"]),
    head: git(["rev-parse", "HEAD"]),
    originUrl: git(["remote", "get-url", "origin"]),
    published: remote,
    status: git(["status", "--porcelain", "--untracked-files=all"]),
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: ETHEREUM_RPC_URL=<secret> ETHEREUM_RPC_PROVIDER_LABEL=<label> ETHEREUM_RPC_PROVIDER_IDENTITY=<bytes32> npm run observe:bit -- [--block number] [--out evidence.json]\n");
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
