#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBitDeploymentComparisonReport,
  validateBitComparisonSourceProvenance,
  validateBitObservationSourceProvenance,
} from "../lib/bit-deployment-observer.mjs";
import { currentPublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run compare:bit -- first.json second.json [--out comparison.json]";

function parseArguments(values) {
  const parsed = { inputs: [], out: null };
  if (values.length === 1 && values[0] === "--help") return { ...parsed, help: true };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--out" && values[index + 1]
        && !values[index + 1].startsWith("--") && parsed.out === null) {
      parsed.out = resolve(values[++index]);
    } else if (values[index].startsWith("--")) {
      throw new TypeError(USAGE);
    } else {
      parsed.inputs.push(resolve(values[index]));
    }
  }
  return parsed;
}

async function readObservation(path) {
  try {
    return await readBoundedJson(path, "BIT observation", { maximumBytes: 65_536 });
  } catch {
    throw new TypeError("could not read one bounded non-symlink BIT observation");
  }
}

function currentPublishedSource() {
  return currentPublishedBitSource(repository).provenance;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (options.inputs.length !== 2) throw new TypeError(USAGE);

  const sourceBefore = currentPublishedSource();
  validateBitObservationSourceProvenance(sourceBefore);
  const [left, right] = await Promise.all(options.inputs.map(readObservation));
  const report = buildBitDeploymentComparisonReport(left, right);
  validateBitComparisonSourceProvenance(report, sourceBefore);
  const sourceAfter = currentPublishedSource();
  validateBitComparisonSourceProvenance(report, sourceAfter);
  if (sourceAfter.head !== sourceBefore.head || sourceAfter.published !== sourceBefore.published) {
    throw new Error("BIT comparison source changed during provider comparison");
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (options.out) {
    await writeExclusiveJson(options.out, report);
    process.stdout.write(`${options.out}\n`);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.eligible) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT observation comparison failed"}\n`);
  process.exitCode = 1;
});
