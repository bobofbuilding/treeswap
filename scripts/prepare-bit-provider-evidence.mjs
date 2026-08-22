#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBitProviderEvidenceCandidate } from "../lib/bit-provider-evidence.mjs";
import { currentPublishedBitSource, revalidatePublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run prepare:bit-provider-evidence -- --policy policy.json first-observation.json second-observation.json [--out candidate.json]";

function parseArguments(values) {
  const result = { inputs: [], out: null, policy: null };
  if (values.length === 1 && values[0] === "--help") return { ...result, help: true };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--policy" && values[index + 1]
        && !values[index + 1].startsWith("--") && result.policy === null) {
      result.policy = resolve(values[++index]);
    } else if (value === "--out" && values[index + 1]
        && !values[index + 1].startsWith("--") && result.out === null) {
      result.out = resolve(values[++index]);
    } else if (value.startsWith("--")) throw new Error(USAGE);
    else result.inputs.push(resolve(value));
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!options.policy || options.inputs.length !== 2) throw new Error(USAGE);
  const source = currentPublishedBitSource(repository);
  const [policy, ...observations] = await Promise.all([
    readBoundedJson(options.policy, "BIT provider evidence policy", { maximumBytes: 65_536 }),
    ...options.inputs.map((path) => readBoundedJson(path, "BIT observation", { maximumBytes: 65_536 })),
  ]);
  const candidate = prepareBitProviderEvidenceCandidate({ observations, policy, preparedAt: new Date() });
  if (candidate.record.sourceCommit !== source.sourceCommit) {
    throw new Error("BIT provider evidence does not match the exact clean commit published on origin/main");
  }
  revalidatePublishedBitSource(repository, source.sourceCommit);
  if (options.out) {
    await writeExclusiveJson(options.out, candidate);
    process.stdout.write(`${options.out}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT provider evidence preparation failed"}\n`);
  process.exitCode = 1;
});
