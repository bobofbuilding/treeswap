#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBitProviderEvidenceSummary,
  verifyBitProviderEvidence,
} from "../lib/bit-provider-evidence.mjs";
import { currentPublishedBitSource, revalidatePublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run verify:bit-provider-evidence -- --candidate candidate.json --attestations attestations.json [--out summary.json]";

function parseArguments(values) {
  const allowed = new Set(["--attestations", "--candidate", "--out"]);
  if (![4, 6].includes(values.length)) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!allowed.has(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  if (!result["--candidate"] || !result["--attestations"]) throw new Error(USAGE);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = currentPublishedBitSource(repository);
  const [candidate, attestations] = await Promise.all([
    readBoundedJson(resolve(options["--candidate"]), "BIT provider evidence candidate", { maximumBytes: 262_144 }),
    readBoundedJson(resolve(options["--attestations"]), "BIT provider attestations", { maximumBytes: 65_536 }),
  ]);
  if (candidate.record?.sourceCommit !== source.sourceCommit) {
    throw new Error("BIT provider evidence does not match the exact clean commit published on origin/main");
  }
  const verification = verifyBitProviderEvidence({ candidate, attestations, observedAt: new Date() });
  const summary = buildBitProviderEvidenceSummary(verification);
  revalidatePublishedBitSource(repository, source.sourceCommit);
  if (options["--out"]) {
    const output = resolve(options["--out"]);
    await writeExclusiveJson(output, summary);
    process.stdout.write(`${output}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT provider evidence verification failed"}\n`);
  process.exitCode = 1;
});
