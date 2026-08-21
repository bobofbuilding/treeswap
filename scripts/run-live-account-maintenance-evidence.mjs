import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLiveAccountMaintenanceEvidence,
  liveAccountMaintenanceEvidencePolicy,
} from "../lib/live-account-maintenance-evidence.mjs";
import { runLiveAccountMaintenanceLifecycle } from "../lib/live-account-maintenance-lifecycle.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = liveAccountMaintenanceEvidencePolicy.origin;
process.chdir(repository);

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error("source provenance check failed");
  return result.stdout.trim();
}

function outputName() {
  if (process.argv.length === 2) return `live-account-maintenance-${new Date().toISOString().replaceAll(":", "-")}.json`;
  if (process.argv.length !== 4 || process.argv[2] !== "--out-name") {
    throw new Error("Usage: node scripts/run-live-account-maintenance-evidence.mjs [--out-name evidence.json]");
  }
  const name = process.argv[3];
  if (basename(name) !== name || !/^[a-z0-9][a-z0-9._-]{0,100}\.json$/.test(name)) {
    throw new Error("evidence output name must be one safe JSON filename");
  }
  return name;
}

const requestedOutputName = outputName();
const authorization = String(process.env.TREESWAP_ACCOUNT_BYPASS_TOKEN ?? "");
const deploymentVersion = String(process.env.TREESWAP_ACCOUNT_DEPLOYMENT_VERSION ?? "");
if (authorization.length < 20 || authorization.length > 4_096 || /[\r\n]/.test(authorization)) {
  throw new Error("a valid owner-only Sites authorization token is required");
}
if (!/^[1-9][0-9]*$/.test(deploymentVersion)) throw new Error("the exact Sites deployment version is required");
delete process.env.TREESWAP_ACCOUNT_BYPASS_TOKEN;

const sourceStatus = capture("git", ["status", "--porcelain", "--untracked-files=all"]);
const branch = capture("git", ["branch", "--show-current"]);
const sourceCommit = capture("git", ["rev-parse", "HEAD"]);
const publishedCommit = capture("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"]).split(/\s+/, 1)[0];
if (sourceStatus || branch !== "main" || sourceCommit !== publishedCommit || !/^[0-9a-f]{40}$/.test(publishedCommit)) {
  throw new Error("live account maintenance evidence requires the exact clean published main commit");
}

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
    throw new Error("the owner-only account maintenance endpoint could not be reached");
  }
  if (response.status >= 300 && response.status < 400) throw new Error("the account maintenance endpoint returned an unexpected redirect");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("the account maintenance endpoint returned a non-JSON response");
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error("the account maintenance endpoint returned malformed JSON");
  }
  return Object.freeze({ status: response.status, json, setCookie: response.headers.get("set-cookie") });
}

const startedAt = new Date().toISOString();
const checks = await runLiveAccountMaintenanceLifecycle({
  request,
  wait: async (milliseconds) => {
    const bounded = Math.min(30_000, Math.max(0, milliseconds));
    if (bounded > 0) await new Promise((resolve) => setTimeout(resolve, bounded));
    process.stdout.write(`${JSON.stringify({ status: "waiting-for-expired-nonce", observedAt: new Date().toISOString() })}\n`);
  },
});
const evidence = buildLiveAccountMaintenanceEvidence({
  source: { branch: "main", commit: sourceCommit, clean: true, published: true },
  deployment: { origin, platform: "OpenAI Sites", access: "owner-only", version: deploymentVersion },
  startedAt,
  finishedAt: new Date().toISOString(),
  checks,
});

await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({
  status: "passed",
  evidenceDigest: evidence.evidenceDigest,
  output: relative(repository, outputPath),
})}\n`);
