import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { getAddress, id, parseEther } from "ethers";
import test from "node:test";
import {
  readBoundedJson,
  verifyPublishedArtifactSources,
  writeExclusiveJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import { closedTestnetArtifactFixtures } from "./fixtures/closed-testnet-artifacts.mjs";

const execFile = promisify(execFileCallback);
const repository = resolve(new URL("..", import.meta.url).pathname);

function address(number) {
  return getAddress(`0x${number.toString(16).padStart(40, "0")}`);
}

function role(wallet, owners, label) {
  return {
    address: address(wallet),
    ownerAddresses: owners.map(address),
    threshold: 2,
    runtimeCodeHash: id(`${label} runtime`).toLowerCase(),
  };
}

function risk() {
  return {
    maxFeeBps: "100",
    maxPriceDeviationBps: "1000",
    referenceSatsPerBit: "100",
    epochDurationSeconds: "86400",
    minSettlementWindowSeconds: "1800",
    minClaimBufferSeconds: "900",
    maxLockDurationSeconds: "172800",
    maxSwapAmountWei: parseEther("10").toString(),
    maxEpochVolumeWei: parseEther("100").toString(),
  };
}

function input(reviewedBuildCommit) {
  return {
    schema: "treeswap.closed-testnet-deployment-input.v1",
    environment: "public-testnet",
    chainId: "11155111",
    reviewedBuildCommit,
    independentReviewDigest: id("independent public testnet review").toLowerCase(),
    deployer: address(1),
    startingNonce: "17",
    roles: {
      controller: role(2, [10, 11, 12], "controller"),
      guardian: role(3, [13, 14, 15], "guardian"),
      feeCollector: role(4, [16, 17, 18], "fee collector"),
    },
    bit: {
      tokenBoundary: "reviewed-public-testnet-bit-proxy",
      proxyAddress: address(5),
      implementationAddress: address(6),
      proxyCodeHash: id("bit proxy runtime").toLowerCase(),
      implementationCodeHash: id("bit implementation runtime").toLowerCase(),
      symbol: "BIT",
      decimals: 18,
      paused: false,
    },
    gate: { resumeDelaySeconds: 86_400, maxOpenDurationSeconds: 172_800 },
    vaultRisk: risk(),
    userEscrowRisk: risk(),
  };
}

async function publishedCommit() {
  return (await execFile("git", ["rev-parse", "origin/main"], { cwd: repository })).stdout.trim();
}

test("published artifact commitments reproduce every contract source at the reviewed commit", async () => {
  const artifacts = closedTestnetArtifactFixtures();
  const reviewedBuildCommit = await publishedCommit();
  assert.deepEqual(verifyPublishedArtifactSources({ artifacts, repository, reviewedBuildCommit }), {
    status: "published-artifact-sources-verified",
    reviewedBuildCommit,
    sourceFilesVerified: 5,
  });
  const changed = structuredClone(artifacts);
  const [sourcePath] = Object.keys(changed.vault.metadata.sources);
  changed.vault.metadata.sources[sourcePath].keccak256 = id("forged source").toLowerCase();
  assert.throws(
    () => verifyPublishedArtifactSources({ artifacts: changed, repository, reviewedBuildCommit }),
    /does not match|disagree/,
  );
  assert.throws(
    () => verifyPublishedArtifactSources({ artifacts, repository, reviewedBuildCommit: "0".repeat(40) }),
    /not available locally/,
  );
});

test("bounded JSON rejects symlinks and exclusive output is private and durable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-deployment-files-"));
  try {
    const source = join(directory, "source.json");
    const link = join(directory, "link.json");
    const output = join(directory, "output.json");
    await writeFile(source, "{}\n", { mode: 0o600 });
    await symlink(source, link);
    await assert.rejects(readBoundedJson(link, "linked input"), /non-symlink/);
    await writeExclusiveJson(output, { ok: true });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { ok: true });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(writeExclusiveJson(output, { overwritten: true }), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline prepare and verify CLIs reproduce one exact plan without endpoints or funding authority", async (context) => {
  const [reviewedBuildCommit, head, sourceStatus] = await Promise.all([
    publishedCommit(),
    execFile("git", ["rev-parse", "HEAD"], { cwd: repository }).then(({ stdout }) => stdout.trim()),
    execFile("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repository })
      .then(({ stdout }) => stdout),
  ]);
  if (head !== reviewedBuildCommit || sourceStatus !== "") {
    context.skip("requires the exact clean reviewed commit published on origin/main");
    return;
  }
  try {
    await access(join(repository, "contracts/out/TreeSwapOpenGate.sol/TreeSwapOpenGate.json"));
  } catch {
    context.skip("requires Foundry artifacts; the dedicated contract job builds them before this campaign");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "treeswap-deployment-cli-"));
  try {
    const inputPath = join(directory, "input.json");
    const planPath = join(directory, "plan.json");
    await writeFile(inputPath, `${JSON.stringify(input(reviewedBuildCommit))}\n`, { mode: 0o600 });
    const prepared = JSON.parse((await execFile(
      process.execPath,
      ["scripts/prepare-closed-testnet-deployment.mjs", "--input", inputPath, "--out", planPath],
      { cwd: repository, maxBuffer: 2_000_000 },
    )).stdout);
    const verified = JSON.parse((await execFile(
      process.execPath,
      ["scripts/verify-closed-testnet-deployment.mjs", "--input", inputPath, "--plan", planPath],
      { cwd: repository, maxBuffer: 2_000_000 },
    )).stdout);
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(prepared.status, "prepared-exact-unsigned-closed-testnet-plan");
    assert.equal(verified.status, "exact-unsigned-plan-verified");
    assert.equal(prepared.planDigest, verified.planDigest);
    assert.equal(plan.planDigest, verified.planDigest);
    assert.equal(verified.fundingAuthorization, false);
    assert.equal("rpcUrl" in plan, false);
    assert.equal(JSON.stringify(plan).includes("signature"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
