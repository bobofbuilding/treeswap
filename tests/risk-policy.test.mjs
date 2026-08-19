import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBitRisk } from "../lib/risk-policy.mjs";

const NOW = 2_000_000_000;
const BIT = 10n ** 18n;

const policy = {
  chainId: 1,
  proxyAddress: "0x57A447E4d5e18A9423408C365963A73F08B9d18C",
  expectedImplementation: "0x1111111111111111111111111111111111111111",
  expectedProxyCodeHash: "0xproxy",
  expectedImplementationCodeHash: "0ximpl",
  decimals: 18,
  referenceSatsPerBit: 100,
  maxSnapshotAgeSeconds: 30,
  maxFinalityLagBlocks: 80,
  maxPriceAgeSeconds: 30,
  minPriceSources: 3,
  maxSignalSpreadBps: 300,
  maxMarketDeviationBps: 1_000,
  maxSwapBitWei: 500n * BIT,
  maxEpochBitWei: 2_000n * BIT,
  baseFeeBpsLightningToBit: 18,
  baseFeeBpsBitToLightning: 72,
  maxFeeBps: 300,
  reserveFloorBps: 2_500,
  scarcityStartsBps: 6_000,
};

const snapshot = {
  chainId: 1,
  observedAt: NOW - 5,
  proxyAddress: policy.proxyAddress,
  implementation: policy.expectedImplementation,
  proxyCodeHash: policy.expectedProxyCodeHash,
  implementationCodeHash: policy.expectedImplementationCodeHash,
  decimals: 18,
  paused: false,
  latestBlock: 1_000,
  finalizedBlock: 970,
  epochBitVolumeWei: 100n * BIT,
  availableBitWei: 1_000n * BIT,
  bitCapacityWei: 1_000n * BIT,
  availableLightningSats: 100_000n,
  lightningCapacitySats: 100_000n,
};

const request = {
  now: NOW,
  direction: "lightning-to-bit",
  bitWei: 100n * BIT,
  lightningSats: 10_000n,
};

const priceSignals = [
  { source: "venue-a", observedAt: NOW - 3, priceMsatPerBit: 100_000n, executableDepthSats: 50_000n },
  { source: "venue-b", observedAt: NOW - 4, priceMsatPerBit: 101_000n, executableDepthSats: 50_000n },
  { source: "venue-c", observedAt: NOW - 5, priceMsatPerBit: 99_500n, executableDepthSats: 50_000n },
];

test("enables a capped quote only when token, market, finality, and inventory checks pass", () => {
  const result = evaluateBitRisk({ policy, snapshot, priceSignals, request });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.feeBps, 18);
  assert.deepEqual(result.qualifiedPriceSources, ["venue-a", "venue-b", "venue-c"]);
});

test("fails closed on a proxy implementation change or pause", () => {
  const changed = evaluateBitRisk({
    policy,
    snapshot: { ...snapshot, implementation: "0x2222222222222222222222222222222222222222", paused: true },
    priceSignals,
    request,
  });
  assert.equal(changed.enabled, false);
  assert.match(changed.reasons.join("; "), /implementation changed/);
  assert.match(changed.reasons.join("; "), /paused/);
});

test("fails closed when price sources are stale, shallow, duplicated, or disagree", () => {
  const unsafeSignals = [
    { source: "same", observedAt: NOW - 100, priceMsatPerBit: 100_000n, executableDepthSats: 50_000n },
    { source: "same", observedAt: NOW, priceMsatPerBit: 100_000n, executableDepthSats: 50_000n },
    { source: "shallow", observedAt: NOW, priceMsatPerBit: 100_000n, executableDepthSats: 1n },
    { source: "outlier", observedAt: NOW, priceMsatPerBit: 150_000n, executableDepthSats: 50_000n },
  ];
  const result = evaluateBitRisk({ policy, snapshot, priceSignals: unsafeSignals, request });
  assert.equal(result.enabled, false);
  assert.match(result.reasons.join("; "), /insufficient fresh executable price sources/);
});

test("raises the fee as the consumed side becomes scarce and then halts", () => {
  const scarce = evaluateBitRisk({
    policy,
    snapshot: { ...snapshot, availableBitWei: 650n * BIT },
    priceSignals,
    request,
  });
  assert.equal(scarce.enabled, true);
  assert.ok(scarce.feeBps > policy.baseFeeBpsLightningToBit);

  const halted = evaluateBitRisk({
    policy,
    snapshot: { ...snapshot, availableBitWei: 300n * BIT },
    priceSignals,
    request,
  });
  assert.equal(halted.enabled, false);
  assert.match(halted.reasons.join("; "), /inventory reserve/);
});

test("keeps the higher base fee for BIT to Lightning", () => {
  const result = evaluateBitRisk({
    policy,
    snapshot,
    priceSignals,
    request: { ...request, direction: "bit-to-lightning" },
  });
  assert.equal(result.enabled, true);
  assert.equal(result.feeBps, 72);
});
