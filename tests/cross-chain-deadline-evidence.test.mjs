import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCrossChainDeadlineEvidence,
  crossChainDeadlineSchemas,
} from "../lib/cross-chain-deadline-evidence.mjs";
import {
  buildLiveBitCrossChainDeadlineEvidence,
  liveBitCrossChainDeadlinePolicy,
  liveBitCrossChainDeadlineSchemas,
} from "../lib/live-bit-cross-chain-deadline-evidence.mjs";
import { coordinatorCommitmentDigest } from "../lib/coordinator-store.mjs";
import { deriveSettlementSchedule } from "../lib/settlement-policy.mjs";

const NOW = 2_000_000_000;
const HEIGHT = 900_000;
const policy = Object.freeze({
  version: "1",
  maxClockSkewSeconds: 60,
  minimumPaymentCltvBlocks: 18,
  minimumHoldInvoiceCltvBlocks: 48,
  fulfillmentSafetyBlocks: 24,
  minimumBitcoinBlockSeconds: 300,
  invoiceExpiryMarginSeconds: 300,
  ethereumConfirmations: 12,
  maximumEthereumBlockSeconds: 18,
  maxFinalityLagBlocks: 80,
  minimumPaymentWindowSeconds: 600,
  minimumHeldHtlcActionSeconds: 900,
  quoteTtlSeconds: 120,
  claimRelaySeconds: 600,
  ethereumCongestionSeconds: 1_800,
  maximumLockSeconds: 172_800,
  maxAuthorizationAgeSeconds: 15,
});

function directionInvoice(direction) {
  return Object.freeze({
    timestamp: NOW - 5,
    expirySeconds: 10_800,
    minFinalCltvExpiryDelta: direction === "lightning-to-bit" ? 80 : 40,
  });
}

function fixture() {
  const bitInvoice = directionInvoice("bit-to-lightning");
  const lightningInvoice = directionInvoice("lightning-to-bit");
  const bitSchedule = deriveSettlementSchedule({
    direction: "bit-to-lightning",
    nowSeconds: NOW,
    bitcoinHeight: HEIGHT,
    invoice: bitInvoice,
    policy,
  });
  const lightningSchedule = deriveSettlementSchedule({
    direction: "lightning-to-bit",
    nowSeconds: NOW,
    bitcoinHeight: HEIGHT,
    invoice: lightningInvoice,
    policy,
  });
  return {
    schema: crossChainDeadlineSchemas.observation,
    policy: { ...policy },
    evm: {
      chainId: "31337",
      executionClient: "anvil 1.4.0-stable",
      userEscrowRuntimeCodeHash: `0x${"11".repeat(32)}`,
      vaultRuntimeCodeHash: `0x${"22".repeat(32)}`,
    },
    bitToLightning: {
      bitcoinHeight: HEIGHT,
      invoice: { ...bitInvoice },
      schedule: { ...bitSchedule },
      lightning: {
        paymentSucceeded: true,
        paymentPreimageMatched: true,
      },
      evm: {
        openedAt: NOW + 1,
        finalizedAt: NOW + 199,
        confirmations: 12,
        refundRejectedBeforeClaim: true,
        claimedAt: NOW + 220,
        claimSucceeded: true,
      },
    },
    lightningToBit: {
      bitcoinHeight: HEIGHT,
      invoice: { ...lightningInvoice },
      schedule: { ...lightningSchedule },
      lightning: {
        acceptedHeight: HEIGHT,
        expiryHeight: HEIGHT + 80,
        safeHeight: HEIGHT + 56,
        boundaryHeight: HEIGHT + 56,
        initialHtlcValid: true,
        settlementRejectedAtBoundary: true,
        payerReleased: true,
      },
      evm: {
        reservedAt: NOW + 1,
        finalizedAt: NOW + 199,
        confirmations: 12,
        refundRejectedBeforeBoundary: true,
        claimSimulationSucceededBeforeRefund: true,
        claimRejectedAtRefundBoundary: true,
        refundedAt: lightningSchedule.refundAfter,
        refundSucceeded: true,
      },
    },
  };
}

test("builds privacy-safe evidence for both exact deadline directions", () => {
  const evidence = buildCrossChainDeadlineEvidence(fixture());
  assert.equal(evidence.schema, crossChainDeadlineSchemas.evidence);
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.scope, "local-dual-chain-no-funding-authorization");
  assert.match(evidence.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(evidence.directions.bitToLightning.claimSucceeded, true);
  assert.equal(evidence.directions.lightningToBit.refundSucceeded, true);
  assert.deepEqual(evidence.limitations, {
    publicTestnetIncluded: false,
    independentProvidersIncluded: false,
    productionInfrastructureIncluded: false,
    simulatedEvmFinality: true,
    fundingAuthorization: false,
  });
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /paymentHash|paymentRequest|preimage|invoiceDigest|https?:\/\//i);
});

test("rejects schedule mutation and policy drift", () => {
  const changedSchedule = fixture();
  changedSchedule.bitToLightning.schedule.refundAfter += 1;
  assert.throws(() => buildCrossChainDeadlineEvidence(changedSchedule), /does not match the derived schedule/);

  const changedPolicy = fixture();
  changedPolicy.policy.ethereumCongestionSeconds += 1;
  assert.throws(() => buildCrossChainDeadlineEvidence(changedPolicy), /required campaign policy/);
});

test("rejects an off-by-one boundary but accepts a safer route-adjusted HTLC delta", () => {
  const offByOne = fixture();
  offByOne.lightningToBit.lightning.boundaryHeight -= 1;
  assert.throws(() => buildCrossChainDeadlineEvidence(offByOne), /safety height/);

  const saferRouteDelta = fixture();
  saferRouteDelta.lightningToBit.lightning.expiryHeight += 3;
  saferRouteDelta.lightningToBit.lightning.safeHeight += 3;
  saferRouteDelta.lightningToBit.lightning.boundaryHeight += 3;
  const evidence = buildCrossChainDeadlineEvidence(saferRouteDelta);
  assert.equal(evidence.directions.lightningToBit.advertisedSafeHeight, HEIGHT + 56);
  assert.equal(evidence.directions.lightningToBit.safeHeight, HEIGHT + 59);

  const tooShort = fixture();
  tooShort.lightningToBit.lightning.expiryHeight = HEIGHT + 47;
  tooShort.lightningToBit.lightning.safeHeight = HEIGHT + 23;
  tooShort.lightningToBit.lightning.boundaryHeight = HEIGHT + 23;
  assert.throws(() => buildCrossChainDeadlineEvidence(tooShort), /not safely actionable/);
});

test("rejects missing EVM finality and timestamps outside the ordered window", () => {
  const shallow = fixture();
  shallow.bitToLightning.evm.confirmations = 11;
  assert.throws(() => buildCrossChainDeadlineEvidence(shallow), /lacked confirmations/);

  const lateFinality = fixture();
  lateFinality.lightningToBit.evm.finalizedAt = lateFinality.lightningToBit.schedule.ethereumFinalAt + 1;
  assert.throws(() => buildCrossChainDeadlineEvidence(lateFinality), /exceeded the derived allowance/);

  const earlyRefund = fixture();
  earlyRefund.lightningToBit.evm.refundedAt = earlyRefund.lightningToBit.schedule.refundAfter - 1;
  assert.throws(() => buildCrossChainDeadlineEvidence(earlyRefund), /before its exact boundary/);
});

test("rejects nominal success flags that omit an observed safety action", () => {
  for (const mutate of [
    (value) => { value.bitToLightning.lightning.paymentPreimageMatched = false; },
    (value) => { value.bitToLightning.evm.refundRejectedBeforeClaim = false; },
    (value) => { value.lightningToBit.lightning.settlementRejectedAtBoundary = false; },
    (value) => { value.lightningToBit.evm.claimRejectedAtRefundBoundary = false; },
    (value) => { value.lightningToBit.evm.refundSucceeded = false; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => buildCrossChainDeadlineEvidence(value), /must be true/);
  }
});

test("rejects unknown fields, unsafe policy, wrong chain, and invalid code hashes", () => {
  const extra = fixture();
  extra.authorized = true;
  assert.throws(() => buildCrossChainDeadlineEvidence(extra), /fields are not exact/);

  const unsafePolicy = fixture();
  unsafePolicy.policy.fulfillmentSafetyBlocks = unsafePolicy.policy.minimumHoldInvoiceCltvBlocks;
  assert.throws(() => buildCrossChainDeadlineEvidence(unsafePolicy), /required campaign policy/);

  const wrongChain = fixture();
  wrongChain.evm.chainId = "1";
  assert.throws(() => buildCrossChainDeadlineEvidence(wrongChain), /isolated EVM chain/);

  const zeroHash = fixture();
  zeroHash.evm.vaultRuntimeCodeHash = `0x${"00".repeat(32)}`;
  assert.throws(() => buildCrossChainDeadlineEvidence(zeroHash), /nonzero bytes32/);
});

function liveBitFixture() {
  return {
    observation: fixture(),
    source: {
      branch: "main",
      commit: "ab".repeat(20),
      clean: true,
      published: true,
    },
    token: { ...liveBitCrossChainDeadlinePolicy },
  };
}

test("builds distinct privacy-safe evidence for the exact pinned live-BIT fork", () => {
  const evidence = buildLiveBitCrossChainDeadlineEvidence(liveBitFixture());
  assert.equal(evidence.schema, liveBitCrossChainDeadlineSchemas.evidence);
  assert.equal(evidence.scope, liveBitCrossChainDeadlineSchemas.scope);
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.deadlineEvidence.status, "passed");
  assert.equal(evidence.token.proxyAddress, liveBitCrossChainDeadlinePolicy.proxyAddress);
  assert.equal(evidence.source.commit, "ab".repeat(20));
  assert.deepEqual(evidence.limitations, {
    publicTestnetIncluded: false,
    independentProvidersIncluded: false,
    productionInfrastructureIncluded: false,
    localForkProvider: true,
    simulatedEvmFinality: true,
    fundingAuthorization: false,
  });
  assert.match(evidence.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /paymentHash|paymentRequest|preimage|invoiceDigest|https?:\/\//i);
});

test("live-BIT evidence rejects every pinned fork and token identity drift", () => {
  for (const [field, value] of [
    ["sourceChainId", "11155111"],
    ["forkBlockNumber", "25788857"],
    ["forkBlockHash", `0x${"33".repeat(32)}`],
    ["proxyAddress", `0x${"44".repeat(20)}`],
    ["proxyCodeHash", `0x${"55".repeat(32)}`],
    ["implementationAddress", `0x${"66".repeat(20)}`],
    ["implementationCodeHash", `0x${"77".repeat(32)}`],
    ["implementationSlot", `0x${"88".repeat(32)}`],
    ["symbol", "NOT-BIT"],
    ["decimals", "8"],
    ["paused", true],
  ]) {
    const input = liveBitFixture();
    input.token[field] = value;
    assert.throws(() => buildLiveBitCrossChainDeadlineEvidence(input), /pinned live-BIT snapshot/);
  }
});

test("live-BIT evidence requires exact published main and revalidates deadline observations", () => {
  for (const mutate of [
    (value) => { value.source.branch = "feature"; },
    (value) => { value.source.clean = false; },
    (value) => { value.source.published = false; },
    (value) => { value.source.commit = "not-a-commit"; },
  ]) {
    const input = liveBitFixture();
    mutate(input);
    assert.throws(() => buildLiveBitCrossChainDeadlineEvidence(input), /clean published main|source commit/);
  }

  const unsafeDeadline = liveBitFixture();
  unsafeDeadline.observation.lightningToBit.lightning.boundaryHeight -= 1;
  assert.throws(() => buildLiveBitCrossChainDeadlineEvidence(unsafeDeadline), /safety height/);

  const unknown = liveBitFixture();
  unknown.token.rpcUrl = "https://example.invalid";
  assert.throws(() => buildLiveBitCrossChainDeadlineEvidence(unknown), /fields are not exact/);
});

test("credentialed live-BIT runner is pinned, private, and never falls back to mock evidence", async () => {
  const runner = await readFile(new URL("../scripts/run-live-bit-cross-chain-deadline-smoke.sh", import.meta.url), "utf8");
  assert.match(runner, /git status --porcelain --untracked-files=all/);
  assert.match(runner, /source_branch.*main/);
  assert.match(runner, /source_commit.*published_commit/);
  assert.match(runner, /MAINNET_RPC_URL is required/);
  assert.match(runner, /--fork-block-number 25788856/);
  assert.match(runner, /--host 127\.0\.0\.1/);
  assert.match(runner, /CROSS_CHAIN_DEADLINE_TOKEN_MODE="live-bit"/);
  assert.match(runner, /CROSS_CHAIN_DEADLINE_EVIDENCE_PATH="\$evidence_path"/);
  assert.match(runner, /--out-name/);
  assert.match(runner, /chmod 0700/);
  assert.doesNotMatch(runner, /echo[^\n]*\$MAINNET_RPC_URL|printf[^\n]*\$MAINNET_RPC_URL/);
  assert.doesNotMatch(runner, /TOKEN_MODE="mock"/);
});

test("durable live-BIT evidence is exclusive, private, digest-bound, and correlation-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-live-bit-evidence-test-"));
  await chmod(directory, 0o700);
  const target = join(directory, "live-bit-evidence.json");
  const writer = fileURLToPath(new URL("../scripts/write-live-bit-cross-chain-deadline-evidence.mjs", import.meta.url));
  try {
    const evidence = buildLiveBitCrossChainDeadlineEvidence(liveBitFixture());
    const first = spawnSync(process.execPath, [writer, target], {
      cwd: new URL("..", import.meta.url),
      input: `${JSON.stringify(evidence)}\n`,
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).evidenceDigest, evidence.evidenceDigest);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), evidence);
    assert.equal((await lstat(target)).mode & 0o777, 0o600);

    const second = spawnSync(process.execPath, [writer, target], {
      cwd: new URL("..", import.meta.url),
      input: `${JSON.stringify(evidence)}\n`,
      encoding: "utf8",
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /exist/i);

    const linkedTarget = join(directory, "linked-target.json");
    await symlink(target, linkedTarget);
    const linkedTargetResult = spawnSync(process.execPath, [writer, linkedTarget], {
      cwd: new URL("..", import.meta.url),
      input: `${JSON.stringify(evidence)}\n`,
      encoding: "utf8",
    });
    assert.notEqual(linkedTargetResult.status, 0);
    assert.match(linkedTargetResult.stderr, /exist|loop/i);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), evidence);

    const linkedParent = join(directory, "linked-parent");
    await symlink(directory, linkedParent);
    const linkedParentResult = spawnSync(process.execPath, [writer, join(linkedParent, "linked-parent.json")], {
      cwd: new URL("..", import.meta.url),
      input: `${JSON.stringify(evidence)}\n`,
      encoding: "utf8",
    });
    assert.notEqual(linkedParentResult.status, 0);
    assert.match(linkedParentResult.stderr, /private real directory/);

    for (const mutate of [
      (value) => { value.evidenceDigest = `0x${"ff".repeat(32)}`; },
      (value) => { value.rpcUrl = "https://example.invalid"; },
      (value) => { value.paymentHash = `0x${"11".repeat(32)}`; },
      (value) => { value.limitations.fundingAuthorization = true; },
    ]) {
      const invalid = structuredClone(evidence);
      mutate(invalid);
      const invalidTarget = join(directory, `invalid-${Math.random().toString(16).slice(2)}.json`);
      const result = spawnSync(process.execPath, [writer, invalidTarget], {
        cwd: new URL("..", import.meta.url),
        input: `${JSON.stringify(invalid)}\n`,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      await assert.rejects(readFile(invalidTarget), /ENOENT/);
    }

    const forged = structuredClone(evidence);
    forged.deadlineEvidence.directions.lightningToBit.boundaryHeight -= 1;
    const nestedCommitment = { ...forged.deadlineEvidence };
    delete nestedCommitment.evidenceDigest;
    forged.deadlineEvidence.evidenceDigest = coordinatorCommitmentDigest(nestedCommitment);
    const outerCommitment = { ...forged };
    delete outerCommitment.evidenceDigest;
    forged.evidenceDigest = coordinatorCommitmentDigest(outerCommitment);
    const forgedTarget = join(directory, "forged.json");
    const forgedResult = spawnSync(process.execPath, [writer, forgedTarget], {
      cwd: new URL("..", import.meta.url),
      input: `${JSON.stringify(forged)}\n`,
      encoding: "utf8",
    });
    assert.notEqual(forgedResult.status, 0);
    assert.match(forgedResult.stderr, /unsafe/);
    await assert.rejects(readFile(forgedTarget), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function smokeEnvironment(statePath, mnemonic = "test test test test test test test test test test test junk") {
  return {
    ...process.env,
    CROSS_CHAIN_DEADLINE_RPC_URL: "http://127.0.0.1:18555",
    CROSS_CHAIN_DEADLINE_MNEMONIC: mnemonic,
    CROSS_CHAIN_DEADLINE_STATE_PATH: statePath,
    CROSS_CHAIN_DEADLINE_ANVIL_VERSION: "anvil test",
    CROSS_CHAIN_DEADLINE_TOKEN_MODE: "mock",
  };
}

test("live harness refuses any mnemonic that could represent non-test funds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-cross-chain-test-"));
  await chmod(directory, 0o700);
  try {
    const result = spawnSync(process.execPath, ["infra/evm/cross-chain-deadline-smoke.mjs", "initialize"], {
      cwd: new URL("..", import.meta.url),
      env: smokeEnvironment(join(directory, "state.json"), "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
      input: "{}\n",
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only the public Anvil test mnemonic/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live harness refuses symlinked private state before reading it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-cross-chain-test-"));
  await chmod(directory, 0o700);
  try {
    const target = join(directory, "target.json");
    const link = join(directory, "state.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, link);
    const result = spawnSync(process.execPath, ["infra/evm/cross-chain-deadline-smoke.mjs", "finalize-evidence"], {
      cwd: new URL("..", import.meta.url),
      env: smokeEnvironment(link),
      input: "{}\n",
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private bounded regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
