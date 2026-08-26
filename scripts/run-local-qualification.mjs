import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_QUALIFICATION_CAMPAIGN_NAMES,
  RELEASE_QUALIFICATION_CONFIGURATION_FILES,
  buildQualificationEvidence,
  hashQualificationFile,
} from "../lib/qualification-evidence.mjs";
import { verifyProductionDurationEvidence } from "../lib/production-duration-evidence.mjs";
import {
  assertTreeSwapCanonicalOrigin,
  parsePublishedMainReference,
  validatePublishedMainSource,
} from "../lib/published-source.mjs";
import { destroyQualificationRegtest } from "../lib/regtest-qualification-lifecycle.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repository);

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function runCampaign(name, command, args, environment = {}) {
  process.stdout.write(`\n[qualification] ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: repository,
    stdio: "inherit",
    env: { ...process.env, ...environment },
  });
  if (result.status !== 0) throw new Error(`qualification campaign failed: ${name}`);
  return Object.freeze({ name, status: "passed" });
}

async function ensureOutputDirectory(outputDirectory) {
  try {
    const state = await lstat(outputDirectory);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("outputs must be a real directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(outputDirectory, { mode: 0o700 });
  }
  await chmod(outputDirectory, 0o700);
}

async function readProductionDurationEvidence(path, expectedSourceCommit) {
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o600 || state.size > 65_536) {
    throw new Error("production-duration companion evidence is not one bounded mode-0600 regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("production-duration companion evidence is not valid JSON");
  }
  return verifyProductionDurationEvidence(parsed, { expectedSourceCommit });
}

function outputName() {
  if (process.argv.length === 2) return `local-qualification-${new Date().toISOString().replaceAll(":", "-")}.json`;
  if (process.argv.length !== 4 || process.argv[2] !== "--out-name") {
    throw new Error("Usage: node scripts/run-local-qualification.mjs [--out-name evidence.json]");
  }
  const name = process.argv[3];
  if (basename(name) !== name || !/^[a-z0-9][a-z0-9._-]{0,100}\.json$/.test(name)) {
    throw new Error("evidence output name must be one safe JSON filename");
  }
  return name;
}

function currentPublishedCommit() {
  const status = capture("git", ["status", "--porcelain", "--untracked-files=all"]);
  const branch = capture("git", ["branch", "--show-current"]);
  const head = capture("git", ["rev-parse", "HEAD"]);
  const originUrl = capture("git", ["remote", "get-url", "origin"]);
  assertTreeSwapCanonicalOrigin(originUrl);
  const published = parsePublishedMainReference(
    capture("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"]),
  );
  return validatePublishedMainSource({ branch, head, originUrl, published, status });
}

const requestedOutputName = outputName();
const branch = "main";
const sourceCommit = currentPublishedCommit();
const outputDirectory = join(repository, "outputs");
await ensureOutputDirectory(outputDirectory);

const configurationFiles = RELEASE_QUALIFICATION_CONFIGURATION_FILES;
if (new Set(configurationFiles).size !== configurationFiles.length) {
  throw new Error("qualification configuration file paths must be unique");
}
const configurationHashes = {};
for (const path of configurationFiles) {
  configurationHashes[path] = hashQualificationFile(await readFile(join(repository, path)));
}
const composeSource = await readFile(join(repository, "infra/regtest/compose.yml"), "utf8");
const pinnedImages = [...new Set([...composeSource.matchAll(/^\s*image:\s*([^\s]+@sha256:[0-9a-f]{64})\s*$/gm)]
  .map((match) => match[1]))];

const campaigns = [
  ["web:lint", "npm", ["run", "lint"]],
  ["web:security-tests", "npm", ["test"]],
  ["web:vercel-build", "npm", ["run", "vercel-build"]],
  ["contracts:format", "forge", ["fmt", "--check"]],
  ["contracts:test", "forge", ["test"]],
  ["coordinator:evm-faults", "npm", ["run", "test:coordinator-evm"]],
  ["evm:outbox-finality-and-provider-faults", "npm", ["run", "test:evm-outbox-faults"]],
  ["operations:safety-monitor", "npm", ["run", "test:safety-monitor"]],
  ["operations:account-storage-monitor", "npm", ["run", "test:account-storage-monitor"]],
  ["governance:account-backup-restore-evidence", "npm", [
    "run",
    "test:account-backup-restore-evidence",
  ]],
  ["operations:retained-release-custody", "node", [
    "--test",
    "tests/release-retention-custody.test.mjs",
  ]],
  ["governance:closed-deployment-rehearsal", "npm", ["run", "test:deployment-rehearsal"]],
  ["governance:closed-testnet-deployment-plan", "node", [
    "--test",
    "tests/closed-testnet-deployment-files.test.mjs",
    "tests/closed-testnet-deployment-plan.test.mjs",
  ]],
  ["governance:closed-testnet-deployment-preflight", "node", [
    "--test",
    "tests/closed-testnet-deployment-preflight.test.mjs",
  ]],
  ["governance:closed-testnet-deployment-postflight", "node", [
    "--test",
    "tests/closed-testnet-deployment-postflight.test.mjs",
  ]],
  ["governance:deployment-manifest-promotion", "node", [
    "--import",
    "./tests/register-cloudflare-loader.mjs",
    "--test",
    "tests/deployment-manifest-promotion.test.mjs",
  ]],
  ["governance:bit-provider-evidence", "node", [
    "--test",
    "tests/bit-deployment-observer.test.mjs",
    "tests/bit-provider-evidence.test.mjs",
  ]],
  ["governance:bit-review-ceremony-preflight", "node", [
    "--test",
    "tests/bit-review-ceremony-preflight.test.mjs",
  ]],
  ["governance:bit-independent-review", "node", [
    "--test",
    "tests/bit-independent-review.test.mjs",
  ]],
  ["governance:bit-reviewed-manifest", "node", [
    "--test",
    "tests/bit-reviewed-manifest.test.mjs",
  ]],
  ["governance:wallet-session-route-review", "npm", ["run", "test:wallet-session-route-review"]],
  ["governance:wallet-session-route-deployment-preflight", "npm", [
    "run",
    "test:wallet-session-route-deployment-preflight",
  ]],
  ["governance:wallet-session-route-deployment-postflight", "npm", [
    "run",
    "test:wallet-session-route-deployment-postflight",
  ]],
  ["governance:wallet-session-route-deployment-live-review", "npm", [
    "run",
    "test:wallet-session-route-deployment-live-review",
  ]],
  ["evm:escrow-reorgs", "npm", ["run", "test:escrow-reorg"]],
  ["lightning:credential-lifecycle", "npm", ["run", "regtest:credential-smoke"]],
  ["lightning:credential-overlap-rotation", "npm", ["run", "regtest:credential-rotation-smoke"]],
  ["lightning:tls-certificate-rotation", "npm", ["run", "regtest:tls-rotation-smoke"]],
  ["lightning:adapter-hold", "npm", ["run", "regtest:adapter-smoke"]],
  ["lightning:invoice-faults", "npm", ["run", "regtest:invoice-fault-smoke"]],
  ["lightning:policy-faults", "npm", ["run", "regtest:policy-fault-smoke"]],
  ["lightning:directional-capacity", "npm", ["run", "regtest:directional-capacity-smoke"]],
  ["lightning:daily-cap", "npm", ["run", "regtest:daily-cap-smoke"]],
  ["lightning:stateless-chain-initialization", "npm", ["run", "regtest:stateless-init-smoke"]],
  ["lightning:production-duration-chain-delay", "npm", ["run", "regtest:production-duration-smoke"]],
  ["lightning:stale-chain-header", "npm", ["run", "regtest:stale-chain-smoke"]],
  ["lightning:unsynced-chain-catchup", "npm", ["run", "regtest:unsynced-chain-smoke"]],
  ["lightning:force-close-recovery", "npm", ["run", "regtest:force-close-smoke"]],
  ["lightning:route-and-duplicate-faults", "npm", ["run", "regtest:route-fault-smoke"]],
  ["lightning:htlc-cutoff", "npm", ["run", "regtest:htlc-cutoff-smoke"]],
  ["lightning:selected-solver-invoice-material", "npm", ["run", "regtest:selected-solver-invoice-smoke"]],
  ["lightning:selected-solver-invoice-private-service", "npm", ["run", "regtest:selected-solver-invoice-private-service-smoke"]],
  ["cross-chain:deadline-ordering", "npm", ["run", "test:cross-chain-deadlines"]],
  ["solver:lightning-node-proof", "npm", ["run", "regtest:solver-node-proof-smoke"]],
  ["solver:capacity-readers", "npm", ["run", "regtest:solver-capacity-smoke"]],
  ["solver:permissionless-admission", "node", [
    "--import",
    "./tests/register-cloudflare-loader.mjs",
    "--test",
    "tests/admission-policy.test.mjs",
    "tests/admission-store.test.mjs",
    "tests/rfq-delivery.test.mjs",
    "tests/rfq.test.mjs",
    "tests/solver-capability.test.mjs",
  ]],
  ["governance:release-authorization", "node", [
    "--import",
    "./tests/register-cloudflare-loader.mjs",
    "--test",
    "tests/capabilities.test.mjs",
    "tests/release-authorization.test.mjs",
    "tests/public-testnet-release-approval.test.mjs",
  ]],
  ["adoption:public-testnet-evidence", "node", [
    "--import",
    "./tests/register-cloudflare-loader.mjs",
    "--test",
    "tests/public-testnet-campaign-workflow.test.mjs",
    "tests/public-testnet-bootstrap-evidence.test.mjs",
    "tests/independent-review-evidence.test.mjs",
    "tests/adoption-policy.test.mjs",
    "tests/operational-readiness-evidence.test.mjs",
    "tests/service-isolation-evidence.test.mjs",
    "tests/public-testnet-evidence.test.mjs",
    "tests/public-testnet-release-candidate.test.mjs",
  ]],
  ["coordinator:payer-lost-response", "npm", ["run", "regtest:coordinator-smoke"]],
  ["coordinator:invoice-lost-response", "npm", ["run", "regtest:coordinator-invoice-smoke"]],
];
if (campaigns.length !== RELEASE_QUALIFICATION_CAMPAIGN_NAMES.length
    || campaigns.some(([name], index) => name !== RELEASE_QUALIFICATION_CAMPAIGN_NAMES[index])) {
  throw new Error("qualification campaign commands do not match the mandatory release plan");
}
const startedAt = new Date().toISOString();
const results = [];
const productionDurationCompanionPath = join(
  outputDirectory,
  `production-duration-${randomBytes(16).toString("hex")}.json`,
);
let productionDurationEvidence = null;
let campaignError = null;
try {
  destroyQualificationRegtest({ repository });
  for (const [name, command, args] of campaigns) {
    const environment = name === "lightning:production-duration-chain-delay"
      ? {
        TREESWAP_PRODUCTION_DURATION_EVIDENCE_PATH: productionDurationCompanionPath,
        TREESWAP_QUALIFICATION_SOURCE_COMMIT: sourceCommit,
      }
      : {};
    results.push(runCampaign(name, command, args, environment));
    if (name === "lightning:production-duration-chain-delay") {
      productionDurationEvidence = await readProductionDurationEvidence(
        productionDurationCompanionPath,
        sourceCommit,
      );
    }
  }
} catch (error) {
  campaignError = error;
} finally {
  try {
    destroyQualificationRegtest({ repository });
  } catch (cleanupError) {
    campaignError = campaignError
      ? new AggregateError([campaignError, cleanupError], "qualification campaign and regtest destruction failed")
      : cleanupError;
  }
  try {
    await unlink(productionDurationCompanionPath);
  } catch (cleanupError) {
    if (cleanupError?.code !== "ENOENT") {
      campaignError = campaignError
        ? new AggregateError([campaignError, cleanupError], "qualification campaign and companion cleanup failed")
        : cleanupError;
    }
  }
}
if (campaignError) throw campaignError;
if (!productionDurationEvidence) throw new Error("qualification did not retain production-duration evidence");
if (currentPublishedCommit() !== sourceCommit) throw new Error("qualification source changed during the campaigns");

const evidence = buildQualificationEvidence({
  branch,
  sourceCommit,
  startedAt,
  finishedAt: new Date().toISOString(),
  runtimeVersions: {
    node: process.version,
    docker: capture("docker", ["version", "--format", "{{.Server.Version}}"]),
    dockerCompose: capture("docker", ["compose", "version", "--short"]),
    forge: capture("forge", ["--version"]).split("\n", 1)[0],
  },
  pinnedImages,
  configurationHashes,
  campaigns: results,
  productionDurationEvidence,
});

const outputPath = join(outputDirectory, requestedOutputName);
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({
  status: "passed",
  evidenceDigest: evidence.evidenceDigest,
  output: relative(repository, outputPath),
})}\n`);
