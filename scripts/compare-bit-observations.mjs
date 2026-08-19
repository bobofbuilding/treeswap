#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareBitDeploymentObservations } from "../lib/bit-deployment-observer.mjs";

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
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new TypeError(`could not read a valid observation from ${path}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: npm run compare:bit -- first.json second.json [--out comparison.json]\n");
    return;
  }
  if (options.inputs.length !== 2) throw new TypeError("exactly two observation files are required");

  const [left, right] = await Promise.all(options.inputs.map(readObservation));
  const comparison = compareBitDeploymentObservations(left, right);
  const report = {
    schema: "treeswap.bit-deployment-comparison.v1",
    evidenceStatus: "unreviewed-provider-comparison",
    comparedAt: new Date().toISOString(),
    providers: [left.providerLabel, right.providerLabel],
    finalizedBlock: left.finalizedBlock,
    sourceCommit: left.sourceCommit,
    ...comparison,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (options.out) {
    await writeFile(options.out, serialized, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${options.out}\n`);
  } else {
    process.stdout.write(serialized);
  }
  if (!comparison.eligible) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT observation comparison failed"}\n`);
  process.exitCode = 1;
});
