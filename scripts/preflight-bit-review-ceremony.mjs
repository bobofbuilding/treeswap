#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightBitReviewCeremony } from "../lib/bit-independent-review.mjs";
import { currentPublishedBitSource, revalidatePublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run preflight:bit-review-ceremony -- --provider-policy provider-policy.json --review-policy review-policy.json --artifacts review-artifacts.json --findings finding-counts.json [--out preflight.json]";
const REQUIRED = Object.freeze([
  "--artifacts",
  "--findings",
  "--provider-policy",
  "--review-policy",
]);
const ALLOWED = new Set([...REQUIRED, "--out"]);

function parseArguments(values) {
  if (values.length === 1 && values[0] === "--help") return { help: true };
  if (values.length !== REQUIRED.length * 2 && values.length !== (REQUIRED.length + 1) * 2) {
    throw new Error(USAGE);
  }
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!ALLOWED.has(flag) || !value || value.startsWith("--") || result[flag]) throw new Error(USAGE);
    result[flag] = resolve(value);
  }
  if (REQUIRED.some((flag) => !result[flag])) throw new Error(USAGE);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const source = currentPublishedBitSource(repository);
  const [providerPolicy, reviewPolicy, artifacts, findingCounts] = await Promise.all([
    readBoundedJson(options["--provider-policy"], "BIT provider evidence policy", {
      maximumBytes: 65_536,
    }),
    readBoundedJson(options["--review-policy"], "BIT independent review policy", {
      maximumBytes: 65_536,
    }),
    readBoundedJson(options["--artifacts"], "BIT independent review artifacts", {
      maximumBytes: 65_536,
    }),
    readBoundedJson(options["--findings"], "BIT independent review finding counts", {
      maximumBytes: 4_096,
    }),
  ]);
  const preflight = preflightBitReviewCeremony({
    providerPolicy,
    reviewPolicy,
    artifacts,
    findingCounts,
  });
  if (preflight.sourceCommit !== source.sourceCommit) {
    throw new Error("BIT review ceremony preflight does not match the exact clean commit published on origin/main");
  }
  revalidatePublishedBitSource(repository, source.sourceCommit);
  if (options["--out"]) {
    await writeExclusiveJson(options["--out"], preflight);
    process.stdout.write(`${options["--out"]}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT review ceremony preflight failed"}\n`);
  process.exitCode = 1;
});
