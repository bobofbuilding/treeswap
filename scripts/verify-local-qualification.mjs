#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedFile } from "../lib/closed-testnet-deployment-files.mjs";
import {
  RELEASE_QUALIFICATION_CONFIGURATION_FILES,
  hashQualificationFile,
} from "../lib/qualification-evidence.mjs";
import {
  readPrivateQualificationArtifact,
  verifyCurrentReleaseQualification,
} from "../lib/local-qualification-verification.mjs";
import {
  assertTreeSwapCanonicalOrigin,
  parsePublishedMainReference,
  validatePublishedMainSource,
} from "../lib/published-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: verify-local-qualification --artifact qualification.json";

function artifactPath(values) {
  if (values.length !== 2 || values[0] !== "--artifact" || !values[1]) throw new Error(USAGE);
  return values[1];
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
    throw new Error("published source provenance check failed");
  }
}

function currentPublishedCommit() {
  const originUrl = git(["remote", "get-url", "origin"]);
  assertTreeSwapCanonicalOrigin(originUrl);
  const published = parsePublishedMainReference(
    git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]),
  );
  return validatePublishedMainSource({
    branch: git(["branch", "--show-current"]),
    head: git(["rev-parse", "HEAD"]),
    originUrl,
    published,
    status: git(["status", "--porcelain", "--untracked-files=all"]),
  });
}

async function currentConfigurationHashes() {
  const entries = await Promise.all(RELEASE_QUALIFICATION_CONFIGURATION_FILES.map(async (name) => [
    name,
    hashQualificationFile(await readBoundedFile(
      join(repository, name),
      `qualification configuration ${name}`,
      { maximumBytes: 5_000_000 },
    )),
  ]));
  return Object.freeze(Object.fromEntries(entries));
}

async function main() {
  const path = artifactPath(process.argv.slice(2));
  const sourceCommit = currentPublishedCommit();
  const [qualificationFileBytes, configurationHashes] = await Promise.all([
    readPrivateQualificationArtifact(path),
    currentConfigurationHashes(),
  ]);
  const receipt = verifyCurrentReleaseQualification({
    qualificationFileBytes,
    publishedSourceCommit: sourceCommit,
    currentConfigurationHashes: configurationHashes,
  });
  if (currentPublishedCommit() !== sourceCommit) {
    throw new Error("published qualification source changed during verification");
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "qualification verification failed"}\n`);
  process.exitCode = 1;
}
