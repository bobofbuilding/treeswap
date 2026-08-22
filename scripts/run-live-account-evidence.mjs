import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLiveAccountEvidence, liveAccountEvidencePolicy } from "../lib/live-account-evidence.mjs";
import { runLiveAccountLifecycle } from "../lib/live-account-lifecycle.mjs";
import {
  assertTreeSwapCanonicalOrigin,
  parsePublishedMainReference,
  validatePublishedMainSource,
} from "../lib/published-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = liveAccountEvidencePolicy.origin;
process.chdir(repository);

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error("source provenance check failed");
  return result.stdout.trim();
}

function outputName() {
  if (process.argv.length === 2) return `live-account-${new Date().toISOString().replaceAll(":", "-")}.json`;
  if (process.argv.length !== 4 || process.argv[2] !== "--out-name") {
    throw new Error("Usage: node scripts/run-live-account-evidence.mjs [--out-name evidence.json]");
  }
  const name = process.argv[3];
  if (basename(name) !== name || !/^[a-z0-9][a-z0-9._-]{0,100}\.json$/.test(name)) {
    throw new Error("evidence output name must be one safe JSON filename");
  }
  return name;
}

function currentPublishedCommit() {
  const sourceStatus = capture("git", ["status", "--porcelain", "--untracked-files=all"]);
  const branch = capture("git", ["branch", "--show-current"]);
  const head = capture("git", ["rev-parse", "HEAD"]);
  const originUrl = capture("git", ["remote", "get-url", "origin"]);
  try {
    assertTreeSwapCanonicalOrigin(originUrl);
    const published = parsePublishedMainReference(
      capture("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"]),
    );
    return validatePublishedMainSource({ branch, head, originUrl, published, status: sourceStatus });
  } catch {
    throw new Error("live account evidence requires the exact clean published main commit");
  }
}

const requestedOutputName = outputName();
const authorization = String(process.env.TREESWAP_ACCOUNT_BYPASS_TOKEN ?? "");
const deploymentVersion = String(process.env.TREESWAP_ACCOUNT_DEPLOYMENT_VERSION ?? "");
if (authorization.length < 20 || authorization.length > 4_096 || /[\r\n]/.test(authorization)) {
  throw new Error("a valid owner-only Sites authorization token is required");
}
if (!/^[1-9][0-9]*$/.test(deploymentVersion)) throw new Error("the exact Sites deployment version is required");
delete process.env.TREESWAP_ACCOUNT_BYPASS_TOKEN;

const sourceCommit = currentPublishedCommit();

const outputDirectory = join(repository, "outputs");
try {
  const state = await lstat(outputDirectory);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("outputs must be a real directory");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await mkdir(outputDirectory, { mode: 0o700 });
}
await chmod(outputDirectory, 0o700);
const outputPath = join(outputDirectory, requestedOutputName);
try {
  await lstat(outputPath);
  throw new Error("evidence output already exists");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

async function request({ path, method = "GET", originHeader, cookie, body }) {
  const headers = new Headers({
    Accept: "application/json",
    "OAI-Sites-Authorization": `Bearer ${authorization}`,
  });
  if (originHeader) headers.set("Origin", originHeader);
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");

  let response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("the owner-only account endpoint could not be reached");
  }
  if (response.status >= 300 && response.status < 400) throw new Error("the account endpoint returned an unexpected redirect");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("the account endpoint returned a non-JSON response");
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error("the account endpoint returned malformed JSON");
  }
  return Object.freeze({ status: response.status, json, setCookie: response.headers.get("set-cookie") });
}

const startedAt = new Date().toISOString();
const checks = await runLiveAccountLifecycle({ request });
const evidence = buildLiveAccountEvidence({
  source: { branch: "main", commit: sourceCommit, clean: true, published: true },
  deployment: { origin, platform: "OpenAI Sites", access: "owner-only", version: deploymentVersion },
  startedAt,
  finishedAt: new Date().toISOString(),
  checks,
});

if (currentPublishedCommit() !== sourceCommit) throw new Error("live account evidence source changed during capture");
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({
  status: "passed",
  evidenceDigest: evidence.evidenceDigest,
  output: relative(repository, outputPath),
})}\n`);
