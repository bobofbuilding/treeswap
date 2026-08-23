import { execFileSync, spawnSync } from "node:child_process";
import {
  constants,
  lstat,
  open,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  assertTreeSwapCanonicalOrigin,
  parsePublishedMainReference,
  validatePublishedMainSource,
} from "./published-source.mjs";

const ARTIFACT_PATHS = Object.freeze({
  gate: "contracts/out/TreeSwapOpenGate.sol/TreeSwapOpenGate.json",
  paymentHashRegistry: "contracts/out/TreeSwapPaymentHashRegistry.sol/TreeSwapPaymentHashRegistry.json",
  userEscrow: "contracts/out/TreeSwapUserEscrow.sol/TreeSwapUserEscrow.json",
  vault: "contracts/out/TreeSwapBitVault.sol/TreeSwapBitVault.json",
});
const COMMIT = /^[0-9a-f]{40}$/;
const SOURCE_PATH = /^contracts\/src\/[A-Za-z0-9._/-]+\.sol$/;

export async function readBoundedFile(path, name, { maximumBytes = 1_000_000 } = {}) {
  const target = resolve(path);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0 || before.size > maximumBytes) {
      throw new Error(`${name} must be a non-symlink JSON file no larger than ${maximumBytes} bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength > maximumBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`${name} changed while it was being read`);
    }
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`${name} must be a non-symlink JSON file no larger than ${maximumBytes} bytes`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readBoundedJson(path, name, options = {}) {
  const bytes = await readBoundedFile(path, name, options);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

export async function writeExclusiveJson(path, value) {
  const target = resolve(path);
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("output parent must be a real directory");
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directoryHandle = await open(dirname(target), constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return target;
}

export async function loadClosedTestnetDeploymentArtifacts(repository) {
  const entries = await Promise.all(Object.entries(ARTIFACT_PATHS).map(async ([name, path]) => [
    name,
    await readBoundedJson(join(repository, path), `${name} artifact`),
  ]));
  return Object.freeze(Object.fromEntries(entries));
}

function git(repository, arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 2_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function currentPublishedMain(repository) {
  const originUrl = git(repository, ["remote", "get-url", "origin"]).trim();
  assertTreeSwapCanonicalOrigin(originUrl);
  const published = parsePublishedMainReference(
    git(repository, ["ls-remote", "--exit-code", "origin", "refs/heads/main"]).trim(),
  );
  return Object.freeze({ originUrl, published });
}

export async function rebuildReviewedClosedTestnetDeploymentArtifacts({ repository, reviewedBuildCommit }) {
  if (!COMMIT.test(String(reviewedBuildCommit ?? ""))) throw new TypeError("reviewed build commit is invalid");
  const head = git(repository, ["rev-parse", "HEAD"]).trim();
  const status = git(repository, ["status", "--porcelain", "--untracked-files=all"]);
  const branch = git(repository, ["branch", "--show-current"]).trim();
  const { originUrl, published } = currentPublishedMain(repository);
  let sourceCommit;
  try {
    sourceCommit = validatePublishedMainSource({ branch, head, originUrl, published, status });
  } catch {
    throw new Error("artifact rebuild requires the exact clean reviewed commit published on origin/main");
  }
  if (sourceCommit !== reviewedBuildCommit) {
    throw new Error("artifact rebuild requires the exact clean reviewed commit published on origin/main");
  }
  const build = spawnSync("forge", ["build", "--force", "--quiet", "--offline"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 2_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (build.error || build.status !== 0) {
    throw new Error("offline reviewed-contract rebuild failed; install the pinned compiler before the ceremony");
  }
  const headAfterBuild = git(repository, ["rev-parse", "HEAD"]).trim();
  const statusAfterBuild = git(repository, ["status", "--porcelain", "--untracked-files=all"]);
  const branchAfterBuild = git(repository, ["branch", "--show-current"]).trim();
  const currentAfterBuild = currentPublishedMain(repository);
  try {
    validatePublishedMainSource({
      branch: branchAfterBuild,
      head: headAfterBuild,
      originUrl: currentAfterBuild.originUrl,
      published: currentAfterBuild.published,
      status: statusAfterBuild,
    });
  } catch {
    throw new Error("reviewed checkout changed during the offline artifact rebuild");
  }
  if (headAfterBuild !== reviewedBuildCommit) throw new Error("reviewed checkout changed during the offline artifact rebuild");
  const artifacts = await loadClosedTestnetDeploymentArtifacts(repository);
  const sourceVerification = verifyPublishedArtifactSources({ artifacts, repository, reviewedBuildCommit });
  return Object.freeze({ artifacts, sourceVerification });
}

export function verifyPublishedArtifactSources({ artifacts, repository, reviewedBuildCommit }) {
  if (!COMMIT.test(String(reviewedBuildCommit ?? ""))) throw new TypeError("reviewed build commit is invalid");
  const objectCheck = spawnSync("git", ["cat-file", "-e", `${reviewedBuildCommit}^{commit}`], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (objectCheck.status !== 0) throw new Error("reviewed build commit is not available locally");
  const { published } = currentPublishedMain(repository);
  const ancestorCheck = spawnSync("git", ["merge-base", "--is-ancestor", reviewedBuildCommit, published], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (ancestorCheck.status !== 0) throw new Error("reviewed build commit is not published on current remote main");

  const commitments = new Map();
  for (const artifact of Object.values(artifacts)) {
    for (const [path, source] of Object.entries(artifact?.metadata?.sources ?? {})) {
      const expected = String(source?.keccak256 ?? "").toLowerCase();
      if (!SOURCE_PATH.test(path) || !/^0x[0-9a-f]{64}$/.test(expected)) {
        throw new Error("artifact contains an invalid source commitment");
      }
      if (commitments.has(path) && commitments.get(path) !== expected) {
        throw new Error(`artifacts disagree about the ${path} source commitment`);
      }
      commitments.set(path, expected);
    }
  }
  if (commitments.size === 0) throw new Error("artifact source commitments are missing");
  for (const [path, expected] of commitments) {
    let source;
    try {
      source = git(repository, ["show", `${reviewedBuildCommit}:${path}`]);
    } catch {
      throw new Error(`reviewed commit does not contain ${path}`);
    }
    const observed = keccak256(toUtf8Bytes(source)).toLowerCase();
    if (observed !== expected) throw new Error(`${path} does not match the reviewed commit`);
  }
  return Object.freeze({
    status: "published-artifact-sources-verified",
    reviewedBuildCommit,
    sourceFilesVerified: commitments.size,
  });
}

export function repositoryFromModule(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}
