import { execFileSync } from "node:child_process";
import { validateBitObservationSourceProvenance } from "./bit-deployment-observer.mjs";
import {
  assertTreeSwapCanonicalOrigin,
  parsePublishedMainReference,
} from "./published-source.mjs";

function git(repository, arguments_) {
  try {
    return execFileSync("git", arguments_, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("BIT evidence source provenance check failed");
  }
}

export function currentPublishedBitSource(repository) {
  const originUrl = git(repository, ["remote", "get-url", "origin"]);
  assertTreeSwapCanonicalOrigin(originUrl);
  const provenance = Object.freeze({
    branch: git(repository, ["branch", "--show-current"]),
    head: git(repository, ["rev-parse", "HEAD"]),
    originUrl,
    published: parsePublishedMainReference(
      git(repository, ["ls-remote", "--exit-code", "origin", "refs/heads/main"]),
    ),
    status: git(repository, ["status", "--porcelain", "--untracked-files=all"]),
  });
  return Object.freeze({
    provenance,
    sourceCommit: validateBitObservationSourceProvenance(provenance),
  });
}

export function revalidatePublishedBitSource(repository, expectedCommit) {
  const current = currentPublishedBitSource(repository);
  if (current.sourceCommit !== expectedCommit) {
    throw new Error("BIT evidence source changed during the guarded operation");
  }
  return current;
}
