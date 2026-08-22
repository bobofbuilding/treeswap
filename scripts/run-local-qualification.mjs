import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildQualificationEvidence, hashQualificationFile } from "../lib/qualification-evidence.mjs";
import {
  assertTreeSwapCanonicalOrigin,
  parsePublishedMainReference,
  validatePublishedMainSource,
} from "../lib/published-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repository);

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function runCampaign(name, command, args) {
  process.stdout.write(`\n[qualification] ${name}\n`);
  const result = spawnSync(command, args, { cwd: repository, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`qualification campaign failed: ${name}`);
  return Object.freeze({ name, status: "passed" });
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

const configurationFiles = [
  "package.json",
  "package-lock.json",
  "foundry.toml",
  "infra/regtest/compose.yml",
  "infra/regtest/lab.sh",
  "infra/lightning-adapter/Dockerfile",
  "infra/lightning-adapter/server.mjs",
  "infra/coordinator/Dockerfile",
  "infra/coordinator/runtime/package-lock.json",
  "infra/coordinator/smoke.mjs",
  "infra/coordinator/invoice-smoke.mjs",
  "infra/coordinator/disk-full-smoke.mjs",
  "infra/evm/escrow-reorg-smoke.mjs",
  "infra/evm/outbox-fault-smoke.mjs",
  "infra/evm/safety-monitor-smoke.mjs",
  "infra/evm/deployment-rehearsal-smoke.mjs",
  "infra/evm/cross-chain-deadline-smoke.mjs",
  "scripts/run-coordinator-runtime-smoke.sh",
  "scripts/run-escrow-reorg-smoke.sh",
  "scripts/run-evm-outbox-fault-smoke.sh",
  "scripts/run-safety-monitor-smoke.sh",
  "scripts/run-deployment-rehearsal-smoke.sh",
  "scripts/run-cross-chain-deadline-smoke.sh",
  "scripts/run-live-bit-cross-chain-deadline-smoke.sh",
  "scripts/write-live-bit-cross-chain-deadline-evidence.mjs",
  "scripts/run-live-bit-reorg-smoke.sh",
  "scripts/observe-bit-deployment.mjs",
  "scripts/compare-bit-observations.mjs",
  "scripts/prepare-bit-provider-evidence.mjs",
  "scripts/prepare-bit-provider-attestation.mjs",
  "scripts/verify-bit-provider-evidence.mjs",
  "scripts/prepare-bit-independent-review.mjs",
  "scripts/prepare-bit-independent-review-attestation.mjs",
  "scripts/verify-bit-independent-review.mjs",
  "scripts/verify-published-main.mjs",
  "scripts/run-local-qualification.mjs",
  "scripts/run-live-account-evidence.mjs",
  "scripts/run-live-account-maintenance-evidence.mjs",
  "scripts/prepare-closed-testnet-deployment.mjs",
  "scripts/verify-closed-testnet-deployment.mjs",
  "scripts/observe-closed-testnet-deployment-preflight.mjs",
  "scripts/observe-deployment-manifest.mjs",
  "scripts/prepare-closed-testnet-deployment-preflight-record.mjs",
  "scripts/prepare-closed-testnet-deployment-preflight-approval.mjs",
  "scripts/verify-closed-testnet-deployment-preflight.mjs",
  "scripts/observe-closed-testnet-deployment-postflight.mjs",
  "scripts/prepare-closed-testnet-deployment-postflight-record.mjs",
  "scripts/prepare-closed-testnet-deployment-postflight-approval.mjs",
  "scripts/verify-closed-testnet-deployment-postflight.mjs",
  "scripts/manage-public-testnet-campaign.mjs",
  "scripts/prepare-public-testnet-attestation.mjs",
  "scripts/verify-public-testnet-evidence.mjs",
  "scripts/prepare-public-testnet-bootstrap-attestation.mjs",
  "scripts/verify-public-testnet-bootstrap-evidence.mjs",
  "scripts/prepare-independent-review-attestation.mjs",
  "scripts/verify-independent-review-evidence.mjs",
  "scripts/prepare-operational-readiness-attestation.mjs",
  "scripts/verify-operational-readiness-evidence.mjs",
  "scripts/prepare-service-isolation-attestation.mjs",
  "scripts/verify-service-isolation-evidence.mjs",
  "scripts/prepare-public-testnet-bootstrap-release-candidate.mjs",
  "scripts/prepare-public-testnet-release-candidate.mjs",
  "scripts/prepare-public-testnet-release-approval.mjs",
  "scripts/verify-public-testnet-release-approvals.mjs",
  "scripts/prepare-deployment-promotion-approval.mjs",
  "scripts/prepare-deployment-promotion-postflight-bundle.mjs",
  "scripts/verify-deployment-promotion.mjs",
  "lib/lightning-adapter-policy.mjs",
  "lib/lightning-adapter-runtime.mjs",
  "lib/lightning-chain-progress.mjs",
  "lib/lnd-rest-client.mjs",
  "lib/coordinator-store.mjs",
  "lib/coordinator-action-runner.mjs",
  "lib/evm-action-runner.mjs",
  "lib/deployment-observer.mjs",
  "lib/deployment-policy.mjs",
  "lib/deployment-manifest-promotion.mjs",
  "lib/deployment-promotion-postflight-bundle.mjs",
  "lib/closed-testnet-deployment-files.mjs",
  "lib/closed-testnet-deployment-plan.mjs",
  "lib/closed-testnet-deployment-preflight-observer.mjs",
  "lib/closed-testnet-deployment-preflight.mjs",
  "lib/closed-testnet-deployment-postflight-observer.mjs",
  "lib/closed-testnet-deployment-postflight.mjs",
  "lib/release-authorization.mjs",
  "lib/public-testnet-release-approval.mjs",
  "lib/public-testnet-campaign-workflow.mjs",
  "lib/public-testnet-evidence.mjs",
  "lib/public-testnet-bootstrap-evidence.mjs",
  "lib/independent-review-evidence.mjs",
  "lib/adoption-policy.mjs",
  "lib/operational-readiness-evidence.mjs",
  "lib/service-isolation-evidence.mjs",
  "lib/public-testnet-release-candidate.mjs",
  "lib/bit-deployment-observer.mjs",
  "lib/bit-evidence-source.mjs",
  "lib/bit-provider-evidence.mjs",
  "lib/bit-independent-review.mjs",
  "lib/published-source.mjs",
  "lib/admission-policy.mjs",
  "lib/capabilities.mjs",
  "lib/rfq.mjs",
  "lib/solver-capability.mjs",
  "lib/solver-endpoint-transport.mjs",
  "lib/solver-capacity-readers.mjs",
  "lib/lightning-capacity-protocol.mjs",
  "lib/solver-daemon-planner.mjs",
  "lib/solver-daemon-runtime.mjs",
  "lib/solver-private-packet.mjs",
  "lib/safety-monitor.mjs",
  "lib/settlement-policy.mjs",
  "lib/account.mjs",
  "lib/account-capability.mjs",
  "lib/account-maintenance.mjs",
  "lib/siwe-policy.mjs",
  "lib/siwe-server.ts",
  "lib/live-account-evidence.mjs",
  "lib/live-account-lifecycle.mjs",
  "lib/live-account-maintenance-evidence.mjs",
  "lib/live-account-maintenance-lifecycle.mjs",
  "db/index.ts",
  "db/schema.ts",
  "drizzle/0000_puzzling_captain_america.sql",
  "drizzle/0001_mushy_squadron_supreme.sql",
  "app/api/auth/nonce/route.ts",
  "app/api/auth/session/route.ts",
  "app/api/auth/verify/route.ts",
  "app/api/internal/account-maintenance/route.ts",
  "lib/cross-chain-deadline-evidence.mjs",
  "lib/live-bit-cross-chain-deadline-evidence.mjs",
];
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
  ["governance:bit-independent-review", "node", [
    "--test",
    "tests/bit-independent-review.test.mjs",
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
  ["cross-chain:deadline-ordering", "npm", ["run", "test:cross-chain-deadlines"]],
  ["solver:lightning-node-proof", "npm", ["run", "regtest:solver-node-proof-smoke"]],
  ["solver:capacity-readers", "npm", ["run", "regtest:solver-capacity-smoke"]],
  ["solver:permissionless-admission", "node", [
    "--import",
    "./tests/register-cloudflare-loader.mjs",
    "--test",
    "tests/admission-policy.test.mjs",
    "tests/admission-store.test.mjs",
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
const startedAt = new Date().toISOString();
const results = [];
let campaignError = null;
try {
  for (const [name, command, args] of campaigns) results.push(runCampaign(name, command, args));
} catch (error) {
  campaignError = error;
} finally {
  const stopped = spawnSync("npm", ["run", "regtest:down"], {
    cwd: repository,
    stdio: "inherit",
    env: process.env,
  });
  if (stopped.status !== 0 && !campaignError) campaignError = new Error("regtest cleanup failed");
}
if (campaignError) throw campaignError;
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
});

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
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({
  status: "passed",
  evidenceDigest: evidence.evidenceDigest,
  output: relative(repository, outputPath),
})}\n`);
