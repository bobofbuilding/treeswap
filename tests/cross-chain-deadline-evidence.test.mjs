import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCrossChainDeadlineEvidence,
  crossChainDeadlineSchemas,
} from "../lib/cross-chain-deadline-evidence.mjs";
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

function smokeEnvironment(statePath, mnemonic = "test test test test test test test test test test test junk") {
  return {
    ...process.env,
    CROSS_CHAIN_DEADLINE_RPC_URL: "http://127.0.0.1:18555",
    CROSS_CHAIN_DEADLINE_MNEMONIC: mnemonic,
    CROSS_CHAIN_DEADLINE_STATE_PATH: statePath,
    CROSS_CHAIN_DEADLINE_ANVIL_VERSION: "anvil test",
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
