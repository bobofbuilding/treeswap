import { execFileSync, spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { assertTreeSwapCanonicalOrigin } from "./published-source.mjs";
import {
  WALLET_SESSION_ROUTE_REVIEW_FILES,
  buildWalletSessionRouteReviewArtifact,
  serializeWalletSessionRouteReviewArtifact,
} from "./wallet-session-route-review.mjs";

const BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/;
const COMMIT = /^[0-9a-f]{40}$/;

function capture(repository, arguments_, { binary = false } = {}) {
  return execFileSync("git", arguments_, {
    cwd: repository,
    encoding: binary ? null : "utf8",
    maxBuffer: 2_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function branch(value) {
  const normalized = String(value ?? "");
  if (!BRANCH.test(normalized) || normalized.includes("..") || normalized.includes("//")
      || normalized.startsWith("-") || normalized.endsWith(".") || normalized.endsWith("/")) {
    throw new TypeError("wallet session route review source branch is invalid");
  }
  return normalized;
}

function commit(value) {
  const normalized = String(value ?? "");
  if (!COMMIT.test(normalized)) throw new TypeError("wallet session route review source commit is invalid");
  return normalized;
}

function remoteCommit(repository, sourceBranch) {
  const output = capture(repository, [
    "ls-remote",
    "--exit-code",
    "origin",
    `refs/heads/${sourceBranch}`,
  ]).trim();
  const match = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(output);
  if (!match || match[2] !== sourceBranch) {
    throw new Error("wallet session route review source branch is not published on origin");
  }
  return match[1];
}

function assertCanonicalOrigin(repository) {
  assertTreeSwapCanonicalOrigin(capture(repository, ["remote", "get-url", "origin"]).trim());
}

function loadFilesAtCommit(repository, sourceCommit) {
  const files = {};
  for (const path of WALLET_SESSION_ROUTE_REVIEW_FILES) {
    try {
      files[path] = capture(repository, ["show", `${sourceCommit}:${path}`], { binary: true });
    } catch {
      throw new Error(`published wallet session route review source is missing ${path}`);
    }
  }
  return Object.freeze(files);
}

export function currentPublishedWalletSessionRouteReviewSource(repository) {
  assertCanonicalOrigin(repository);
  const sourceBranch = branch(capture(repository, ["branch", "--show-current"]).trim());
  const sourceCommit = commit(capture(repository, ["rev-parse", "HEAD"]).trim());
  if (capture(repository, ["status", "--porcelain", "--untracked-files=all"]).length !== 0) {
    throw new Error("wallet session route review preparation requires a clean checkout");
  }
  if (remoteCommit(repository, sourceBranch) !== sourceCommit) {
    throw new Error("wallet session route review preparation requires the exact current branch published on origin");
  }
  return Object.freeze({ sourceBranch, sourceCommit });
}

export function revalidatePublishedWalletSessionRouteReviewSource(repository, source) {
  assertCanonicalOrigin(repository);
  const sourceBranch = branch(source?.sourceBranch);
  const sourceCommit = commit(source?.sourceCommit);
  if (remoteCommit(repository, sourceBranch) !== sourceCommit) {
    throw new Error("published wallet session route review source changed during verification");
  }
  return Object.freeze({ sourceBranch, sourceCommit });
}

export function buildPublishedWalletSessionRouteReviewArtifact(repository, source) {
  const verifiedSource = revalidatePublishedWalletSessionRouteReviewSource(repository, source);
  const artifact = buildWalletSessionRouteReviewArtifact({
    ...verifiedSource,
    sourceFiles: loadFilesAtCommit(repository, verifiedSource.sourceCommit),
  });
  revalidatePublishedWalletSessionRouteReviewSource(repository, verifiedSource);
  return artifact;
}

export function verifyPublishedWalletSessionRouteReviewArtifact({
  repository,
  artifactFileBytes,
  artifact,
}) {
  const source = revalidatePublishedWalletSessionRouteReviewSource(repository, artifact);
  const objectCheck = spawnSync("git", ["cat-file", "-e", `${source.sourceCommit}^{commit}`], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (objectCheck.status !== 0) {
    throw new Error("published wallet session route review commit is unavailable locally");
  }
  const rebuilt = buildWalletSessionRouteReviewArtifact({
    ...source,
    sourceFiles: loadFilesAtCommit(repository, source.sourceCommit),
  });
  const observed = Buffer.isBuffer(artifactFileBytes)
    ? artifactFileBytes
    : Buffer.from(artifactFileBytes ?? []);
  const expected = serializeWalletSessionRouteReviewArtifact(rebuilt);
  if (observed.byteLength !== expected.byteLength || !timingSafeEqual(observed, expected)) {
    throw new Error("wallet session route review artifact does not match the exact published source bytes");
  }
  revalidatePublishedWalletSessionRouteReviewSource(repository, source);
  return Object.freeze({
    status: "exact-published-wallet-session-route-source-verified",
    sourceBranch: source.sourceBranch,
    sourceCommit: source.sourceCommit,
    sourceFileCount: WALLET_SESSION_ROUTE_REVIEW_FILES.length,
  });
}
