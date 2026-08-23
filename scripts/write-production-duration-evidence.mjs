#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { buildProductionDurationEvidence } from "../lib/production-duration-evidence.mjs";

const FLAG_NAMES = Object.freeze([
  "--finished-at-epoch-seconds",
  "--maximum-observation-gap-seconds",
  "--monotonic-elapsed-seconds",
  "--observation-count",
  "--output",
  "--restart-elapsed-seconds",
  "--source-commit",
  "--started-at-epoch-seconds",
]);

function parseArguments(argv) {
  if (argv.length !== FLAG_NAMES.length * 2) {
    throw new Error(`Usage: node scripts/write-production-duration-evidence.mjs ${FLAG_NAMES.map((name) => `${name} <value>`).join(" ")}`);
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAG_NAMES.includes(flag) || Object.hasOwn(values, flag) || value === undefined || value.length === 0) {
      throw new Error("production-duration evidence arguments are invalid, duplicated, or incomplete");
    }
    values[flag] = value;
  }
  return values;
}

function integer(value, name) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new TypeError(`${name} must be a canonical integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new TypeError(`${name} must be a safe integer`);
  return result;
}

async function assertSafeOutputPath(outputPath) {
  if (!isAbsolute(outputPath)
    || !/^production-duration-[0-9a-f]{32}\.json$/.test(basename(outputPath))) {
    throw new Error("production-duration output must be an absolute path with a generated safe filename");
  }
  const directory = dirname(outputPath);
  const directoryState = await lstat(directory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
    throw new Error("production-duration output parent must be a real directory");
  }
  if ((directoryState.mode & 0o077) !== 0) {
    throw new Error("production-duration output parent must not be group- or world-accessible");
  }
}

const values = parseArguments(process.argv.slice(2));
const outputPath = values["--output"];
await assertSafeOutputPath(outputPath);

const evidence = buildProductionDurationEvidence({
  sourceCommit: values["--source-commit"],
  startedAtEpochSeconds: integer(values["--started-at-epoch-seconds"], "startedAtEpochSeconds"),
  finishedAtEpochSeconds: integer(values["--finished-at-epoch-seconds"], "finishedAtEpochSeconds"),
  maximumObservationGapSeconds: integer(
    values["--maximum-observation-gap-seconds"],
    "maximumObservationGapSeconds",
  ),
  monotonicElapsedSeconds: integer(values["--monotonic-elapsed-seconds"], "monotonicElapsedSeconds"),
  observationCount: integer(values["--observation-count"], "observationCount"),
  restartElapsedSeconds: integer(values["--restart-elapsed-seconds"], "restartElapsedSeconds"),
});

let file;
let created = false;
try {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0);
  file = await open(outputPath, flags, 0o600);
  created = true;
  await file.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await file.chmod(0o600);
  await file.sync();
  await file.close();
  file = undefined;

  const directory = await open(dirname(outputPath), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
} catch (error) {
  if (file) await file.close().catch(() => {});
  if (created) await unlink(outputPath).catch(() => {});
  throw error;
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  evidenceDigest: evidence.evidenceDigest,
  output: basename(outputPath),
})}\n`);
