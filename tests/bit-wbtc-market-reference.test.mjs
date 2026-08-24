import assert from "node:assert/strict";
import test from "node:test";
import { TypedDataEncoder, Wallet } from "ethers";
import {
  BIT_TOKEN_ADDRESS,
  UNISWAP_V3_FACTORY_ADDRESS,
  WBTC_TOKEN_ADDRESS,
  arithmeticMeanTick,
  bitWbtcObservationTypedData,
  buildBitWbtcPoolPriceSignal,
  harmonicMeanLiquidity,
  isVerifiedBitWbtcPoolPriceSignal,
  quoteWbtcAtomicPerBitAtTick,
  sqrtRatioX96AtTick,
} from "../lib/bit-wbtc-market-reference.mjs";

const NOW = 2_000_000_000n;
const BIT = 10n ** 18n;
const HASH = (byte) => `0x${byte.repeat(64)}`;
const PROVIDER_WALLETS = [null, new Wallet(HASH("1")), new Wallet(HASH("2"))];
const PROVIDER_ORGANIZATIONS = [null, HASH("3"), HASH("4")];

const policy = Object.freeze({
  chainId: 1,
  bitToken: BIT_TOKEN_ADDRESS,
  wbtcToken: WBTC_TOKEN_ADDRESS,
  uniswapV3Factory: UNISWAP_V3_FACTORY_ADDRESS,
  uniswapV3FactoryCodeHash: HASH("5"),
  wbtcTokenCodeHash: HASH("6"),
  poolAddress: "0x1111111111111111111111111111111111111111",
  poolCodeHash: HASH("a"),
  poolFee: 3_000,
  poolInitializedAt: NOW - 700_000n,
  poolInitializationTxHash: HASH("7"),
  wideRangeMethodologyDigest: HASH("8"),
  providers: Object.freeze([1, 2].map((index) => Object.freeze({
    providerId: `provider-${index}`,
    signer: PROVIDER_WALLETS[index].address,
    organization: PROVIDER_ORGANIZATIONS[index],
  }))),
  quoterAddress: "0x2222222222222222222222222222222222222222",
  quoterCodeHash: HASH("b"),
  wbtcBtcFeed: "0x3333333333333333333333333333333333333333",
  wbtcBtcFeedCodeHash: HASH("c"),
  wbtcBtcAggregator: "0x4444444444444444444444444444444444444444",
  wbtcBtcAggregatorCodeHash: HASH("e"),
  twapWindowSeconds: 1_800,
  minimumPoolAgeSeconds: 604_800,
  minimumObservationCardinality: 64,
  minimumHarmonicMeanLiquidity: 1_000_000,
  minimumWideRangeLiquidity: 500_000,
  maximumObservationAgeSeconds: 30,
  maximumBlockAgeSeconds: 60,
  maximumFinalityLagBlocks: 80,
  maximumFeedAgeSeconds: 3_600,
  maximumProviderSkewSeconds: 10,
  maximumWbtcPegDeviationBps: 100,
  maximumSpotTwapDeviationBps: 300,
  maximumProbeTwapDeviationBps: 300,
  minimumProviders: 2,
});

const request = Object.freeze({
  now: NOW,
  direction: "lightning-to-bit",
  bitWei: BIT,
  lightningSats: 100,
});

function observation(index, changes = {}) {
  const base = {
    providerId: `provider-${index}`,
    providerOrganization: PROVIDER_ORGANIZATIONS[index],
    chainId: 1,
    observedAt: NOW - BigInt(6 - index),
    blockNumber: 20_000_000,
    finalizedBlockNumber: 20_000_000,
    latestBlockNumber: 20_000_030,
    blockHash: HASH("d"),
    blockTimestamp: NOW - 10n,
    bitToken: BIT_TOKEN_ADDRESS,
    wbtcToken: WBTC_TOKEN_ADDRESS,
    wbtcTokenCodeHash: policy.wbtcTokenCodeHash,
    factory: UNISWAP_V3_FACTORY_ADDRESS,
    factoryCodeHash: policy.uniswapV3FactoryCodeHash,
    factoryPool: policy.poolAddress,
    pool: policy.poolAddress,
    poolCodeHash: policy.poolCodeHash,
    poolToken0: WBTC_TOKEN_ADDRESS,
    poolToken1: BIT_TOKEN_ADDRESS,
    fee: policy.poolFee,
    observationCardinality: 64,
    wideRangeLiquidity: 1_000_000,
    wideRangeMethodologyDigest: policy.wideRangeMethodologyDigest,
    poolInitializedAt: NOW - 700_000n,
    poolInitializationTxHash: policy.poolInitializationTxHash,
    twapWindowSeconds: 1_800,
    tickCumulativePast: 0,
    tickCumulativeNow: 368_400n * 1_800n,
    secondsPerLiquidityPastX128: 1_000,
    secondsPerLiquidityNowX128: 1_001,
    spotTick: 368_400,
    quoterAddress: policy.quoterAddress,
    quoterCodeHash: policy.quoterCodeHash,
    wbtcBtcFeed: policy.wbtcBtcFeed,
    wbtcBtcFeedCodeHash: policy.wbtcBtcFeedCodeHash,
    wbtcBtcAggregator: policy.wbtcBtcAggregator,
    wbtcBtcAggregatorCodeHash: policy.wbtcBtcAggregatorCodeHash,
    wbtcBtcRoundId: 50,
    wbtcBtcAnsweredInRound: 50,
    wbtcBtcAnswer: 100_000_000,
    wbtcBtcUpdatedAt: NOW - 20n,
    wbtcBtcDecimals: 8,
    probe: {
      direction: "lightning-to-bit",
      quoteMode: "exact-output",
      tokenIn: WBTC_TOKEN_ADDRESS,
      tokenOut: BIT_TOKEN_ADDRESS,
      amountBitWei: BIT,
      amountWbtcAtomic: 100,
    },
  };
  const unsigned = { ...base, ...changes, probe: changes.probe ? { ...base.probe, ...changes.probe } : base.probe };
  const typedData = bitWbtcObservationTypedData({ policy, observation: unsigned });
  return {
    ...unsigned,
    providerSignature: PROVIDER_WALLETS[index].signingKey.sign(
      TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.value),
    ).serialized,
  };
}

test("reproduces Uniswap tick arithmetic with integer-only BIT/WBTC quotes", () => {
  assert.equal(sqrtRatioX96AtTick(0), 1n << 96n);
  assert.equal(sqrtRatioX96AtTick(-887_272), 4_295_128_739n);
  assert.equal(sqrtRatioX96AtTick(887_272), 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n);
  assert.equal(arithmeticMeanTick(0, -1, 2), -1);
  assert.equal(arithmeticMeanTick(0, 2, 2), 1);
  assert.equal(quoteWbtcAtomicPerBitAtTick(368_400), 100n);
  assert.ok(quoteWbtcAtomicPerBitAtTick(368_000) > quoteWbtcAtomicPerBitAtTick(369_000));
  assert.ok(harmonicMeanLiquidity(1_000, 1_001, 1_800) > 1_000_000n);
});

test("builds one request-sized pool signal from two agreeing provider domains", () => {
  const result = buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [observation(1), observation(2)],
  });
  assert.equal(result.priceSignal.kind, "bit-wbtc-twap-probe");
  assert.equal(result.priceSignal.direction, "lightning-to-bit");
  assert.equal(result.priceSignal.priceMsatPerBit, 100_000n);
  assert.equal(result.priceSignal.executableDepthSats, 100n);
  assert.equal(result.priceSignal.executableDepthBitWei, BIT);
  assert.equal(result.priceSignal.pricePolicyDigest, result.evidence.policyDigest);
  assert.ok(result.priceSignal.validUntil > request.now);
  assert.equal(result.evidence.providerCount, 2);
  assert.equal(result.evidence.fundingAuthorization, false);
  assert.match(result.evidence.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(isVerifiedBitWbtcPoolPriceSignal(result.priceSignal), true);
  assert.equal(isVerifiedBitWbtcPoolPriceSignal({ ...result.priceSignal }), false);
});

test("counts two RPCs as agreement on one venue, never as two prices", () => {
  const result = buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [observation(1), observation(2)],
  });
  assert.match(result.priceSignal.source, /^uniswap-v3:0x/);
  assert.match(result.priceSignal.venueId, /^0x[0-9a-f]{64}$/);
  assert.match(result.priceSignal.controlDomain, /^0x[0-9a-f]{64}$/);
  assert.equal(result.priceSignal.observationDigest, result.evidence.evidenceDigest);
});

test("fails closed on provider disagreement, reused control claims, or stale data", () => {
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [observation(1), observation(2, { spotTick: 368_401 })],
  }), /providers disagree/);
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [observation(1), observation(2, { providerOrganization: observation(1).providerOrganization })],
  }), /not pinned by policy/);
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [observation(1), observation(2, { observedAt: NOW - 31n })],
  }), /stale/);
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [observation(1, { latestBlockNumber: 20_000_100 }), observation(2, { latestBlockNumber: 20_000_100 })],
  }), /finality lag is excessive/);
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [observation(1, { blockTimestamp: NOW - 61n }), observation(2, { blockTimestamp: NOW - 61n })],
  }), /finalized price block is stale/);
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [
      observation(1, { wbtcBtcAggregatorCodeHash: HASH("f") }),
      observation(2, { wbtcBtcAggregatorCodeHash: HASH("f") }),
    ],
  }), /AggregatorCodeHash does not match policy/);
});

test("rejects invented providers, copied signatures, and reversed quoter semantics", () => {
  const first = observation(1);
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [first, { ...observation(2), providerSignature: first.providerSignature }],
  }), /pinned signer/);
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [observation(1), observation(2, { providerId: "provider-invented" })],
  }), /not pinned by policy/);
  const reversed = {
    quoteMode: "exact-input",
    tokenIn: BIT_TOKEN_ADDRESS,
    tokenOut: WBTC_TOKEN_ADDRESS,
  };
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy,
    request,
    observations: [observation(1, { probe: reversed }), observation(2, { probe: reversed })],
  }), /probe semantics do not match direction/);
});

test("pins factory discovery, token order, initialization, and liquidity methodology", () => {
  for (const [changes, pattern] of [
    [{ factoryPool: "0x9999999999999999999999999999999999999999" }, /factoryPool does not match policy/],
    [{ poolToken0: BIT_TOKEN_ADDRESS, poolToken1: WBTC_TOKEN_ADDRESS }, /token ordering is invalid/],
    [{ factoryCodeHash: HASH("9") }, /factoryCodeHash does not match policy/],
    [{ poolInitializationTxHash: HASH("9") }, /initialization transaction does not match policy/],
    [{ wideRangeMethodologyDigest: HASH("9") }, /methodology does not match policy/],
  ]) {
    assert.throws(() => buildBitWbtcPoolPriceSignal({
      policy,
      request,
      observations: [observation(1, changes), observation(2, changes)],
    }), pattern);
  }
});

test("binds the complete policy and exact request into the evidence digest", () => {
  const first = buildBitWbtcPoolPriceSignal({ policy, request, observations: [observation(1), observation(2)] });
  const changedPolicy = { ...policy, maximumSpotTwapDeviationBps: 301 };
  const second = buildBitWbtcPoolPriceSignal({ policy: changedPolicy, request, observations: [observation(1), observation(2)] });
  const third = buildBitWbtcPoolPriceSignal({
    policy,
    request: { ...request, lightningSats: 99 },
    observations: [observation(1), observation(2)],
  });
  assert.notEqual(first.evidence.policyDigest, second.evidence.policyDigest);
  assert.notEqual(first.evidence.evidenceDigest, second.evidence.evidenceDigest);
  assert.notEqual(first.evidence.requestDigest, third.evidence.requestDigest);
  assert.notEqual(first.evidence.evidenceDigest, third.evidence.evidenceDigest);
});

test("fails closed when the pool is new, shallow, depegged, or non-executable", () => {
  assert.throws(() => buildBitWbtcPoolPriceSignal({
    policy: { ...policy, minimumPoolAgeSeconds: 800_000 },
    request,
    observations: [observation(1), observation(2)],
  }), /too new/);
  for (const [changes, pattern] of [
    [{ secondsPerLiquidityNowX128: 10n ** 40n }, /liquidity is insufficient/],
    [{ wideRangeLiquidity: 1 }, /wide-range liquidity is insufficient/],
    [{ wbtcBtcAnswer: 97_000_000 }, /peg is outside policy/],
    [{ probe: { amountWbtcAtomic: 80 } }, /probe is too far from TWAP/],
    [{ probe: { amountBitWei: BIT - 1n } }, /probe is too shallow/],
  ]) {
    assert.throws(() => buildBitWbtcPoolPriceSignal({
      policy,
      request,
      observations: [observation(1, changes), observation(2, changes)],
    }), pattern);
  }
});

test("does not let WBTC/BTC feed conversion masquerade as another BIT venue", () => {
  const result = buildBitWbtcPoolPriceSignal({
    policy,
    request: { ...request, lightningSats: 99 },
    observations: [
      observation(1, { wbtcBtcAnswer: 99_500_000 }),
      observation(2, { wbtcBtcAnswer: 99_500_000 }),
    ],
  });
  assert.equal(result.priceSignal.priceMsatPerBit, 99_500n);
  assert.equal(result.priceSignal.executableDepthSats, 99n);
  assert.equal(result.evidence.providerCount, 2);
  assert.equal("secondaryPriceSource" in result.evidence, false);
});
