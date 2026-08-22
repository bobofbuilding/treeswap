#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTreeSwapCanonicalOrigin,
  parsePublishedMainReference,
  validatePublishedMainSource,
} from "../lib/published-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function main() {
  if (process.argv.length !== 2) throw new TypeError("published source verifier accepts no arguments");
  const originUrl = git(["remote", "get-url", "origin"]);
  assertTreeSwapCanonicalOrigin(originUrl);
  const published = parsePublishedMainReference(
    git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]),
  );
  const commit = validatePublishedMainSource({
    branch: git(["branch", "--show-current"]),
    head: git(["rev-parse", "HEAD"]),
    originUrl,
    published,
    status: git(["status", "--porcelain", "--untracked-files=all"]),
  });
  process.stdout.write(`${commit}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "published source provenance check failed"}\n`);
  process.exitCode = 1;
}
