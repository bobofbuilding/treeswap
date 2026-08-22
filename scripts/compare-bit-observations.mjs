#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBitDeploymentComparisonReport,
  validateBitComparisonSourceProvenance,
  validateBitObservationSourceProvenance,
} from "../lib/bit-deployment-observer.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  assertTreeSwapCanonicalOrigin,
  parsePublishedMainReference,
} from "../lib/published-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(values) {
  const parsed = { inputs: [], out: null };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--out" && values[index + 1]) {
      parsed.out = resolve(values[++index]);
    } else if (values[index] === "--help") {
      parsed.help = true;
    } else if (values[index].startsWith("--")) {
      throw new TypeError(`unknown argument: ${values[index]}`);
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

function git(arguments_) {
  try {
    return execFileSync("git", arguments_, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("BIT comparison source provenance check failed");
  }
}

function currentPublishedSource() {
  const originUrl = git(["remote", "get-url", "origin"]);
  assertTreeSwapCanonicalOrigin(originUrl);
  return {
    branch: git(["branch", "--show-current"]),
    head: git(["rev-parse", "HEAD"]),
    originUrl,
    published: parsePublishedMainReference(
      git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]),
    ),
    status: git(["status", "--porcelain", "--untracked-files=all"]),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: npm run compare:bit -- first.json second.json [--out comparison.json]\n");
    return;
  }
  if (options.inputs.length !== 2) throw new TypeError("exactly two observation files are required");

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
