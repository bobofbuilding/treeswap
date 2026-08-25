import { getAddress, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "./bit-deployment-observer.mjs";

export const BIT_TOKEN_ADDRESS = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";
export const WBTC_TOKEN_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
export const UNISWAP_V3_FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
export const BIT_WBTC_MARKET_POLICY_SCHEMA = "treeswap.bit-wbtc-market-policy.v2";
export const BIT_WBTC_PROVIDER_OBSERVATION_SCHEMA = "treeswap.bit-wbtc-provider-observation.v2";
export const BIT_WBTC_PRICE_REQUEST_SCHEMA = "treeswap.bit-wbtc-price-request.v2";

const BIT_SCALE = 10n ** 18n;
const BPS = 10_000n;
const Q32 = 1n << 32n;
const Q128 = 1n << 128n;
const Q192 = 1n << 192n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const ALLOWED_FEE_TIERS = new Set([100, 500, 3_000, 10_000]);
const verifiedPoolSignals = new WeakSet();
const verifiedPoolSignalRequests = new WeakMap();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function integer(value, name) {
  try {
    return BigInt(value);
  } catch {
    throw new TypeError(`${name} must be an integer`);
  }
}

function boundedInteger(value, minimum, maximum, name) {
  const parsed = integer(value, name);
  if (parsed < minimum || parsed > maximum) throw new RangeError(`${name} is outside its allowed range`);
  return parsed;
}

function safeAddress(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an address`);
  }
}

function safeNonzeroAddress(value, name) {
  const parsed = safeAddress(value, name);
  if (BigInt(parsed) === 0n) throw new TypeError(`${name} must be nonzero`);
  return parsed;
}

function bytes32(value, name) {
  const parsed = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(parsed) || /^0x0{64}$/.test(parsed)) throw new TypeError(`${name} must be nonzero bytes32`);
  return parsed;
}

function safeId(value, name) {
  const parsed = String(value ?? "");
  if (!/^[a-z0-9][a-z0-9._:-]{1,79}$/.test(parsed)) throw new TypeError(`${name} is invalid`);
  return parsed;
}

function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value))));
}

function exceedsDeviationBps(left, right, maximumBps) {
  if (left <= 0n || right <= 0n) throw new RangeError("prices must be positive");
  const difference = left > right ? left - right : right - left;
  return difference * BPS > right * maximumBps;
}

function mulDiv(left, right, denominator) {
  if (denominator === 0n) throw new RangeError("division by zero");
  return left * right / denominator;
}

export function arithmeticMeanTick(tickCumulativePast, tickCumulativeNow, windowSeconds) {
  const seconds = boundedInteger(windowSeconds, 1n, 604_800n, "windowSeconds");
  const delta = integer(tickCumulativeNow, "tickCumulativeNow") - integer(tickCumulativePast, "tickCumulativePast");
  let result = delta / seconds;
  if (delta < 0n && delta % seconds !== 0n) result -= 1n;
  if (result < BigInt(MIN_TICK) || result > BigInt(MAX_TICK)) throw new RangeError("mean tick is outside Uniswap bounds");
  return Number(result);
}

export function harmonicMeanLiquidity(secondsPerLiquidityPastX128, secondsPerLiquidityNowX128, windowSeconds) {
  const seconds = boundedInteger(windowSeconds, 1n, 604_800n, "windowSeconds");
  const delta = integer(secondsPerLiquidityNowX128, "secondsPerLiquidityNowX128")
    - integer(secondsPerLiquidityPastX128, "secondsPerLiquidityPastX128");
  if (delta <= 0n) throw new RangeError("seconds-per-liquidity delta must be positive");
  return seconds * MAX_UINT160 / (delta * Q32);
}

export function sqrtRatioX96AtTick(tick) {
  const parsed = Number(tick);
  if (!Number.isInteger(parsed) || parsed < MIN_TICK || parsed > MAX_TICK) throw new RangeError("tick is outside Uniswap bounds");
  let absolute = parsed < 0 ? -parsed : parsed;
  let ratio = (absolute & 0x1) !== 0
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  const factors = [
    0xfff97272373d413259a46990580e213an,
    0xfff2e50f5f656932ef12357cf3c7fdccn,
    0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n,
    0xff973b41fa98c081472e6896dfb254c0n,
    0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n,
    0xfcbe86c7900a88aedcffc83b479aa3a4n,
    0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n,
    0xe7159475a2c29b7443b29c7fa6e889d9n,
    0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n,
    0x70d869a156d2a1b890bb3df62baf32f7n,
    0x31be135f97d08fd981231505542fcfa6n,
    0x9aa508b5b7a84e1c677de54f3e99bc9n,
    0x5d6af8dedb81196699c329225ee604n,
    0x2216e584f5fa1ea926041bedfe98n,
    0x48a170391f7dc42444e8fa2n,
  ];
  for (let index = 0; index < factors.length; index += 1) {
    const mask = 1 << (index + 1);
    if ((absolute & mask) !== 0) ratio = ratio * factors[index] >> 128n;
  }
  if (parsed > 0) ratio = MAX_UINT256 / ratio;
  const shifted = ratio >> 32n;
  return shifted + (ratio % Q32 === 0n ? 0n : 1n);
}

export function quoteWbtcAtomicPerBitAtTick(tick) {
  const sqrtRatioX96 = sqrtRatioX96AtTick(tick);
  const bit = BigInt(BIT_TOKEN_ADDRESS.toLowerCase());
  const wbtc = BigInt(WBTC_TOKEN_ADDRESS.toLowerCase());
  let result;
  if (sqrtRatioX96 <= MAX_UINT128) {
    const ratioX192 = sqrtRatioX96 * sqrtRatioX96;
    result = bit < wbtc
      ? mulDiv(ratioX192, BIT_SCALE, Q192)
      : mulDiv(Q192, BIT_SCALE, ratioX192);
  } else {
    const ratioX128 = mulDiv(sqrtRatioX96, sqrtRatioX96, 1n << 64n);
    result = bit < wbtc
      ? mulDiv(ratioX128, BIT_SCALE, Q128)
      : mulDiv(Q128, BIT_SCALE, ratioX128);
  }
  if (result <= 0n) throw new RangeError("tick produces a zero BIT/WBTC quote");
  return result;
}

function validatePolicy(policy) {
  exactKeys(policy, [
    "bitDecimals",
    "bitImplementation",
    "bitImplementationCodeHash",
    "bitImplementationSlot",
    "bitPaused",
    "bitProxyCodeHash",
    "bitSymbol",
    "bitToken",
    "chainId",
    "maximumBlockAgeSeconds",
    "maximumFeedAgeSeconds",
    "maximumFinalityLagBlocks",
    "maximumObservationAgeSeconds",
    "maximumProbeTwapDeviationBps",
    "maximumProviderSkewSeconds",
    "maximumSpotTwapDeviationBps",
    "maximumWbtcPegDeviationBps",
    "minimumHarmonicMeanLiquidity",
    "minimumObservationCardinality",
    "minimumPoolAgeSeconds",
    "minimumProviders",
    "minimumWideRangeLiquidity",
    "poolAddress",
    "poolCodeHash",
    "poolFee",
    "poolInitializedAt",
    "poolInitializationTxHash",
    "providers",
    "quoterAddress",
    "quoterCodeHash",
    "schema",
    "twapWindowSeconds",
    "uniswapV3Factory",
    "uniswapV3FactoryCodeHash",
    "wideRangeMethodologyDigest",
    "wbtcBtcFeed",
    "wbtcBtcAggregator",
    "wbtcBtcAggregatorCodeHash",
    "wbtcBtcFeedCodeHash",
    "wbtcToken",
    "wbtcTokenCodeHash",
    "wbtcSymbol",
    "wbtcDecimals",
    "wbtcPaused",
  ], "BIT/WBTC market policy");
  if (policy.schema !== BIT_WBTC_MARKET_POLICY_SCHEMA) throw new Error("BIT/WBTC market policy schema is invalid");
  if (integer(policy.chainId, "policy.chainId") !== 1n) throw new Error("BIT/WBTC market policy must use Ethereum mainnet");
  if (safeAddress(policy.bitToken, "policy.bitToken") !== getAddress(BIT_TOKEN_ADDRESS)) throw new Error("policy BIT token is not canonical");
  safeNonzeroAddress(policy.bitImplementation, "policy.bitImplementation");
  bytes32(policy.bitProxyCodeHash, "policy.bitProxyCodeHash");
  bytes32(policy.bitImplementationCodeHash, "policy.bitImplementationCodeHash");
  if (bytes32(policy.bitImplementationSlot, "policy.bitImplementationSlot") !== EIP1967_IMPLEMENTATION_SLOT) {
    throw new Error("policy BIT implementation slot is not EIP-1967");
  }
  if (policy.bitSymbol !== "BIT") throw new Error("policy BIT symbol must be BIT");
  if (integer(policy.bitDecimals, "policy.bitDecimals") !== 18n) throw new Error("policy BIT decimals must be 18");
  if (policy.bitPaused !== false) throw new Error("policy BIT state must be unpaused");
  if (safeAddress(policy.wbtcToken, "policy.wbtcToken") !== getAddress(WBTC_TOKEN_ADDRESS)) throw new Error("policy WBTC token is not canonical");
  if (policy.wbtcSymbol !== "WBTC") throw new Error("policy WBTC symbol must be WBTC");
  if (integer(policy.wbtcDecimals, "policy.wbtcDecimals") !== 8n) throw new Error("policy WBTC decimals must be 8");
  if (policy.wbtcPaused !== false) throw new Error("policy WBTC state must be unpaused");
  if (safeAddress(policy.uniswapV3Factory, "policy.uniswapV3Factory") !== getAddress(UNISWAP_V3_FACTORY_ADDRESS)) {
    throw new Error("policy Uniswap v3 factory is not canonical");
  }
  safeNonzeroAddress(policy.poolAddress, "policy.poolAddress");
  safeNonzeroAddress(policy.quoterAddress, "policy.quoterAddress");
  safeNonzeroAddress(policy.wbtcBtcFeed, "policy.wbtcBtcFeed");
  safeNonzeroAddress(policy.wbtcBtcAggregator, "policy.wbtcBtcAggregator");
  bytes32(policy.uniswapV3FactoryCodeHash, "policy.uniswapV3FactoryCodeHash");
  bytes32(policy.wbtcTokenCodeHash, "policy.wbtcTokenCodeHash");
  bytes32(policy.poolCodeHash, "policy.poolCodeHash");
  bytes32(policy.quoterCodeHash, "policy.quoterCodeHash");
  bytes32(policy.wbtcBtcFeedCodeHash, "policy.wbtcBtcFeedCodeHash");
  bytes32(policy.wbtcBtcAggregatorCodeHash, "policy.wbtcBtcAggregatorCodeHash");
  bytes32(policy.poolInitializationTxHash, "policy.poolInitializationTxHash");
  bytes32(policy.wideRangeMethodologyDigest, "policy.wideRangeMethodologyDigest");
  boundedInteger(policy.poolInitializedAt, 1n, (1n << 64n) - 1n, "policy.poolInitializedAt");
  const fee = Number(boundedInteger(policy.poolFee, 1n, 1_000_000n, "policy.poolFee"));
  if (!ALLOWED_FEE_TIERS.has(fee)) throw new Error("policy pool fee is not an allowed Uniswap v3 tier");
  boundedInteger(policy.twapWindowSeconds, 1_800n, 86_400n, "policy.twapWindowSeconds");
  boundedInteger(policy.minimumPoolAgeSeconds, 604_800n, 31_536_000n, "policy.minimumPoolAgeSeconds");
  boundedInteger(policy.minimumObservationCardinality, 2n, 65_535n, "policy.minimumObservationCardinality");
  boundedInteger(policy.minimumHarmonicMeanLiquidity, 1n, MAX_UINT128, "policy.minimumHarmonicMeanLiquidity");
  boundedInteger(policy.minimumWideRangeLiquidity, 1n, MAX_UINT128, "policy.minimumWideRangeLiquidity");
  boundedInteger(policy.maximumObservationAgeSeconds, 1n, 300n, "policy.maximumObservationAgeSeconds");
  boundedInteger(policy.maximumBlockAgeSeconds, 1n, 300n, "policy.maximumBlockAgeSeconds");
  boundedInteger(policy.maximumFinalityLagBlocks, 1n, 256n, "policy.maximumFinalityLagBlocks");
  boundedInteger(policy.maximumFeedAgeSeconds, 1n, 86_400n, "policy.maximumFeedAgeSeconds");
  boundedInteger(policy.maximumProviderSkewSeconds, 0n, 30n, "policy.maximumProviderSkewSeconds");
  boundedInteger(policy.maximumWbtcPegDeviationBps, 1n, 500n, "policy.maximumWbtcPegDeviationBps");
  boundedInteger(policy.maximumSpotTwapDeviationBps, 1n, 2_000n, "policy.maximumSpotTwapDeviationBps");
  boundedInteger(policy.maximumProbeTwapDeviationBps, 1n, 2_000n, "policy.maximumProbeTwapDeviationBps");
  boundedInteger(policy.minimumProviders, 2n, 5n, "policy.minimumProviders");
  if (!Array.isArray(policy.providers) || policy.providers.length < Number(policy.minimumProviders) || policy.providers.length > 5) {
    throw new Error("policy must pin enough BIT/WBTC provider organizations");
  }
  const providerIds = new Set();
  const providerSigners = new Set();
  const providerOrganizations = new Set();
  for (const provider of policy.providers) {
    exactKeys(provider, ["organization", "providerId", "signer"], "BIT/WBTC policy provider");
    const providerId = safeId(provider.providerId, "policy.providers.providerId");
    const signer = safeAddress(provider.signer, "policy.providers.signer").toLowerCase();
    const organization = bytes32(provider.organization, "policy.providers.organization");
    if (providerIds.has(providerId) || providerSigners.has(signer) || providerOrganizations.has(organization)) {
      throw new Error("policy BIT/WBTC providers must be independent");
    }
    providerIds.add(providerId);
    providerSigners.add(signer);
    providerOrganizations.add(organization);
  }
  return policy;
}

function observationWithoutSignature(observation) {
  const unsigned = { ...observation };
  delete unsigned.providerSignature;
  return unsigned;
}

export function bitWbtcObservationTypedData({ policy, observation }) {
  const unsigned = observationWithoutSignature(observation);
  const providerId = safeId(unsigned.providerId, "observation.providerId");
  const organization = bytes32(unsigned.providerOrganization, "observation.providerOrganization");
  return Object.freeze({
    domain: Object.freeze({
      name: "TreeSwap BIT/WBTC Market Observer",
      version: "1",
      chainId: Number(boundedInteger(policy.chainId, 1n, (1n << 53n) - 1n, "policy.chainId")),
      verifyingContract: safeAddress(policy.poolAddress, "policy.poolAddress"),
    }),
    types: Object.freeze({
      Observation: Object.freeze([
        Object.freeze({ name: "providerIdHash", type: "bytes32" }),
        Object.freeze({ name: "organization", type: "bytes32" }),
        Object.freeze({ name: "observationDigest", type: "bytes32" }),
      ]),
    }),
    value: Object.freeze({
      providerIdHash: keccak256(toUtf8Bytes(providerId)),
      organization,
      observationDigest: digest(unsigned),
    }),
  });
}

function validateObservation(observation, policy, request, now) {
  exactKeys(observation, [
    "bitDecimals",
    "bitImplementation",
    "bitImplementationCodeHash",
    "bitImplementationSlot",
    "bitPaused",
    "bitProxyCodeHash",
    "bitSymbol",
    "bitToken",
    "blockHash",
    "blockNumber",
    "blockTimestamp",
    "chainId",
    "factory",
    "factoryCodeHash",
    "factoryPool",
    "fee",
    "finalizedBlockNumber",
    "latestBlockNumber",
    "observationCardinality",
    "observedAt",
    "pool",
    "poolCodeHash",
    "poolInitializedAt",
    "poolInitializationTxHash",
    "poolToken0",
    "poolToken1",
    "probe",
    "providerId",
    "providerOrganization",
    "providerSignature",
    "quoterAddress",
    "quoterCodeHash",
    "schema",
    "secondsPerLiquidityNowX128",
    "secondsPerLiquidityPastX128",
    "spotTick",
    "tickCumulativeNow",
    "tickCumulativePast",
    "twapWindowSeconds",
    "wideRangeLiquidity",
    "wideRangeMethodologyDigest",
    "wbtcBtcAggregator",
    "wbtcBtcAggregatorCodeHash",
    "wbtcBtcAnswer",
    "wbtcBtcAnsweredInRound",
    "wbtcBtcDecimals",
    "wbtcBtcFeed",
    "wbtcBtcFeedCodeHash",
    "wbtcBtcRoundId",
    "wbtcBtcUpdatedAt",
    "wbtcToken",
    "wbtcTokenCodeHash",
    "wbtcSymbol",
    "wbtcDecimals",
    "wbtcPaused",
  ], "BIT/WBTC provider observation");
  if (observation.schema !== BIT_WBTC_PROVIDER_OBSERVATION_SCHEMA) {
    throw new Error("BIT/WBTC provider observation schema is invalid");
  }
  exactKeys(observation.probe, [
    "amountBitWei",
    "amountWbtcAtomic",
    "direction",
    "quoteMode",
    "tokenIn",
    "tokenOut",
  ], "BIT/WBTC executable probe");

  const providerId = safeId(observation.providerId, "observation.providerId");
  const providerOrganization = bytes32(observation.providerOrganization, "observation.providerOrganization");
  const policyProvider = policy.providers.find((provider) => provider.providerId === providerId);
  if (!policyProvider || bytes32(policyProvider.organization, "policy provider organization") !== providerOrganization) {
    throw new Error("BIT/WBTC observation provider is not pinned by policy");
  }
  let recoveredSigner;
  try {
    const typedData = bitWbtcObservationTypedData({ policy, observation });
    recoveredSigner = verifyTypedData(typedData.domain, typedData.types, typedData.value, observation.providerSignature);
  } catch {
    throw new Error("BIT/WBTC provider signature is invalid");
  }
  if (recoveredSigner.toLowerCase() !== safeAddress(policyProvider.signer, "policy provider signer").toLowerCase()) {
    throw new Error("BIT/WBTC provider signature is not from the pinned signer");
  }
  if (integer(observation.chainId, "observation.chainId") !== integer(policy.chainId, "policy.chainId")) throw new Error("provider observed the wrong chain");
  for (const [field, expected] of [
    ["bitToken", policy.bitToken],
    ["bitImplementation", policy.bitImplementation],
    ["wbtcToken", policy.wbtcToken],
    ["factory", policy.uniswapV3Factory],
    ["pool", policy.poolAddress],
    ["quoterAddress", policy.quoterAddress],
    ["wbtcBtcFeed", policy.wbtcBtcFeed],
    ["wbtcBtcAggregator", policy.wbtcBtcAggregator],
    ["factoryPool", policy.poolAddress],
  ]) {
    if (safeAddress(observation[field], `observation.${field}`) !== safeAddress(expected, `policy.${field}`)) {
      throw new Error(`provider ${field} does not match policy`);
    }
  }
  for (const [field, expected] of [
    ["bitProxyCodeHash", policy.bitProxyCodeHash],
    ["bitImplementationCodeHash", policy.bitImplementationCodeHash],
    ["bitImplementationSlot", policy.bitImplementationSlot],
    ["poolCodeHash", policy.poolCodeHash],
    ["factoryCodeHash", policy.uniswapV3FactoryCodeHash],
    ["wbtcTokenCodeHash", policy.wbtcTokenCodeHash],
    ["quoterCodeHash", policy.quoterCodeHash],
    ["wbtcBtcFeedCodeHash", policy.wbtcBtcFeedCodeHash],
    ["wbtcBtcAggregatorCodeHash", policy.wbtcBtcAggregatorCodeHash],
  ]) {
    if (bytes32(observation[field], `observation.${field}`) !== bytes32(expected, `policy.${field}`)) {
      throw new Error(`provider ${field} does not match policy`);
    }
  }
  if (observation.bitSymbol !== policy.bitSymbol) throw new Error("provider BIT symbol does not match policy");
  if (integer(observation.bitDecimals, "observation.bitDecimals") !== integer(policy.bitDecimals, "policy.bitDecimals")) {
    throw new Error("provider BIT decimals do not match policy");
  }
  if (typeof observation.bitPaused !== "boolean") throw new TypeError("observation.bitPaused must be boolean");
  if (observation.bitPaused !== policy.bitPaused) throw new Error("provider BIT pause state does not match policy");
  if (observation.wbtcSymbol !== policy.wbtcSymbol) throw new Error("provider WBTC symbol does not match policy");
  if (integer(observation.wbtcDecimals, "observation.wbtcDecimals") !== integer(policy.wbtcDecimals, "policy.wbtcDecimals")) {
    throw new Error("provider WBTC decimals do not match policy");
  }
  if (typeof observation.wbtcPaused !== "boolean") throw new TypeError("observation.wbtcPaused must be boolean");
  if (observation.wbtcPaused !== policy.wbtcPaused) throw new Error("provider WBTC pause state does not match policy");
  if (integer(observation.fee, "observation.fee") !== integer(policy.poolFee, "policy.poolFee")) throw new Error("provider pool fee does not match policy");
  const expectedToken0 = BigInt(policy.bitToken) < BigInt(policy.wbtcToken) ? policy.bitToken : policy.wbtcToken;
  const expectedToken1 = BigInt(policy.bitToken) < BigInt(policy.wbtcToken) ? policy.wbtcToken : policy.bitToken;
  if (safeAddress(observation.poolToken0, "observation.poolToken0") !== safeAddress(expectedToken0, "expected token0")
      || safeAddress(observation.poolToken1, "observation.poolToken1") !== safeAddress(expectedToken1, "expected token1")) {
    throw new Error("BIT/WBTC pool token ordering is invalid");
  }
  if (integer(observation.twapWindowSeconds, "observation.twapWindowSeconds") !== integer(policy.twapWindowSeconds, "policy.twapWindowSeconds")) {
    throw new Error("provider TWAP window does not match policy");
  }

  const observedAt = boundedInteger(observation.observedAt, 1n, now, "observation.observedAt");
  if (now - observedAt > integer(policy.maximumObservationAgeSeconds, "policy.maximumObservationAgeSeconds")) {
    throw new Error("provider observation is stale");
  }
  const blockNumber = boundedInteger(observation.blockNumber, 1n, (1n << 64n) - 1n, "observation.blockNumber");
  const finalizedBlockNumber = boundedInteger(observation.finalizedBlockNumber, 1n, (1n << 64n) - 1n, "observation.finalizedBlockNumber");
  const latestBlockNumber = boundedInteger(observation.latestBlockNumber, finalizedBlockNumber, (1n << 64n) - 1n, "observation.latestBlockNumber");
  if (blockNumber !== finalizedBlockNumber) throw new Error("BIT/WBTC price anchor is not the finalized head");
  if (latestBlockNumber - finalizedBlockNumber > integer(policy.maximumFinalityLagBlocks, "policy.maximumFinalityLagBlocks")) {
    throw new Error("BIT/WBTC price finality lag is excessive");
  }
  const blockTimestamp = boundedInteger(observation.blockTimestamp, 1n, observedAt, "observation.blockTimestamp");
  if (now - blockTimestamp > integer(policy.maximumBlockAgeSeconds, "policy.maximumBlockAgeSeconds")) {
    throw new Error("BIT/WBTC finalized price block is stale");
  }
  bytes32(observation.blockHash, "observation.blockHash");
  const initializedAt = boundedInteger(observation.poolInitializedAt, 1n, blockTimestamp, "observation.poolInitializedAt");
  if (initializedAt !== integer(policy.poolInitializedAt, "policy.poolInitializedAt")) {
    throw new Error("BIT/WBTC pool initialization does not match policy");
  }
  if (bytes32(observation.poolInitializationTxHash, "observation.poolInitializationTxHash")
      !== bytes32(policy.poolInitializationTxHash, "policy.poolInitializationTxHash")) {
    throw new Error("BIT/WBTC pool initialization transaction does not match policy");
  }
  if (blockTimestamp - initializedAt < integer(policy.minimumPoolAgeSeconds, "policy.minimumPoolAgeSeconds")) {
    throw new Error("BIT/WBTC pool is too new");
  }
  if (integer(observation.observationCardinality, "observation.observationCardinality")
      < integer(policy.minimumObservationCardinality, "policy.minimumObservationCardinality")) {
    throw new Error("BIT/WBTC pool observation cardinality is insufficient");
  }
  const feedUpdatedAt = boundedInteger(observation.wbtcBtcUpdatedAt, 1n, blockTimestamp, "observation.wbtcBtcUpdatedAt");
  if (blockTimestamp - feedUpdatedAt > integer(policy.maximumFeedAgeSeconds, "policy.maximumFeedAgeSeconds")) {
    throw new Error("WBTC/BTC peg feed is stale");
  }
  const roundId = boundedInteger(observation.wbtcBtcRoundId, 1n, (1n << 128n) - 1n, "observation.wbtcBtcRoundId");
  if (integer(observation.wbtcBtcAnsweredInRound, "observation.wbtcBtcAnsweredInRound") < roundId) {
    throw new Error("WBTC/BTC peg round is incomplete");
  }
  if (integer(observation.wbtcBtcDecimals, "observation.wbtcBtcDecimals") !== 8n) throw new Error("WBTC/BTC peg feed must use 8 decimals");
  const peg = boundedInteger(observation.wbtcBtcAnswer, 1n, (1n << 192n) - 1n, "observation.wbtcBtcAnswer");
  if (exceedsDeviationBps(
    peg,
    100_000_000n,
    integer(policy.maximumWbtcPegDeviationBps, "policy.maximumWbtcPegDeviationBps"),
  )) {
    throw new Error("WBTC/BTC peg is outside policy");
  }
  const spotTick = Number(boundedInteger(observation.spotTick, BigInt(MIN_TICK), BigInt(MAX_TICK), "observation.spotTick"));
  const meanTick = arithmeticMeanTick(
    observation.tickCumulativePast,
    observation.tickCumulativeNow,
    observation.twapWindowSeconds,
  );
  const liquidity = harmonicMeanLiquidity(
    observation.secondsPerLiquidityPastX128,
    observation.secondsPerLiquidityNowX128,
    observation.twapWindowSeconds,
  );
  if (liquidity < integer(policy.minimumHarmonicMeanLiquidity, "policy.minimumHarmonicMeanLiquidity")) {
    throw new Error("BIT/WBTC harmonic mean liquidity is insufficient");
  }
  const wideRangeLiquidity = boundedInteger(observation.wideRangeLiquidity, 0n, MAX_UINT128, "observation.wideRangeLiquidity");
  if (bytes32(observation.wideRangeMethodologyDigest, "observation.wideRangeMethodologyDigest")
      !== bytes32(policy.wideRangeMethodologyDigest, "policy.wideRangeMethodologyDigest")) {
    throw new Error("BIT/WBTC wide-range liquidity methodology does not match policy");
  }
  if (wideRangeLiquidity < integer(policy.minimumWideRangeLiquidity, "policy.minimumWideRangeLiquidity")) {
    throw new Error("BIT/WBTC wide-range liquidity is insufficient");
  }
  const twapWbtcAtomicPerBit = quoteWbtcAtomicPerBitAtTick(meanTick);
  const spotWbtcAtomicPerBit = quoteWbtcAtomicPerBitAtTick(spotTick);
  if (exceedsDeviationBps(
    spotWbtcAtomicPerBit,
    twapWbtcAtomicPerBit,
    integer(policy.maximumSpotTwapDeviationBps, "policy.maximumSpotTwapDeviationBps"),
  )) {
    throw new Error("BIT/WBTC spot price is too far from TWAP");
  }

  if (observation.probe.direction !== request.direction) throw new Error("BIT/WBTC probe direction does not match request");
  const expectedProbe = request.direction === "lightning-to-bit"
    ? { quoteMode: "exact-output", tokenIn: policy.wbtcToken, tokenOut: policy.bitToken }
    : { quoteMode: "exact-input", tokenIn: policy.bitToken, tokenOut: policy.wbtcToken };
  if (observation.probe.quoteMode !== expectedProbe.quoteMode
      || safeAddress(observation.probe.tokenIn, "probe.tokenIn") !== safeAddress(expectedProbe.tokenIn, "expected probe tokenIn")
      || safeAddress(observation.probe.tokenOut, "probe.tokenOut") !== safeAddress(expectedProbe.tokenOut, "expected probe tokenOut")) {
    throw new Error("BIT/WBTC executable probe semantics do not match direction");
  }
  const probeBitWei = boundedInteger(observation.probe.amountBitWei, 1n, (1n << 96n) - 1n, "probe.amountBitWei");
  const probeWbtcAtomic = boundedInteger(observation.probe.amountWbtcAtomic, 1n, (1n << 128n) - 1n, "probe.amountWbtcAtomic");
  if (probeBitWei !== integer(request.bitWei, "request.bitWei")) {
    throw new Error("BIT/WBTC executable probe must use the exact requested BIT amount");
  }
  const probeWbtcAtomicPerBit = probeWbtcAtomic * BIT_SCALE / probeBitWei;
  if (exceedsDeviationBps(
    probeWbtcAtomicPerBit,
    twapWbtcAtomicPerBit,
    integer(policy.maximumProbeTwapDeviationBps, "policy.maximumProbeTwapDeviationBps"),
  )) {
    throw new Error("BIT/WBTC executable probe is too far from TWAP");
  }
  const executableDepthSats = probeWbtcAtomic * peg / 100_000_000n;
  const priceMsatPerBit = probeWbtcAtomicPerBit * peg * 1_000n / 100_000_000n;
  if (priceMsatPerBit <= 0n) throw new Error("BIT/WBTC price rounds to zero");

  return Object.freeze({
    providerId: observation.providerId,
    providerOrganization: observation.providerOrganization.toLowerCase(),
    providerSigner: recoveredSigner.toLowerCase(),
    providerObservationDigest: digest(observationWithoutSignature(observation)),
    providerSignatureDigest: keccak256(observation.providerSignature),
    observedAt,
    blockNumber,
    finalizedBlockNumber,
    latestBlockNumber,
    blockTimestamp,
    meanTick,
    harmonicMeanLiquidity: liquidity,
    wideRangeLiquidity,
    twapWbtcAtomicPerBit,
    spotWbtcAtomicPerBit,
    probeWbtcAtomicPerBit,
    peg,
    priceMsatPerBit,
    executableDepthSats,
  });
}

function commonObservation(observation) {
  const common = { ...observation };
  delete common.providerId;
  delete common.providerOrganization;
  delete common.providerSignature;
  delete common.observedAt;
  return common;
}

export function buildBitWbtcPoolPriceSignal({ policy, observations, request }) {
  validatePolicy(policy);
  exactKeys(request, ["bitWei", "direction", "lightningSats", "now", "schema"], "BIT/WBTC price request");
  if (request.schema !== BIT_WBTC_PRICE_REQUEST_SCHEMA) throw new Error("BIT/WBTC price request schema is invalid");
  const now = boundedInteger(request.now, 1n, (1n << 64n) - 1n, "request.now");
  if (request.direction !== "lightning-to-bit" && request.direction !== "bit-to-lightning") {
    throw new Error("BIT/WBTC request direction is invalid");
  }
  boundedInteger(request.bitWei, 1n, (1n << 96n) - 1n, "request.bitWei");
  boundedInteger(request.lightningSats, 1n, (1n << 64n) - 1n, "request.lightningSats");
  if (!Array.isArray(observations) || observations.length < Number(policy.minimumProviders)) {
    throw new Error("BIT/WBTC price requires the policy minimum provider count");
  }
  const verified = observations.map((observation) => validateObservation(observation, policy, request, now));
  const providerIds = new Set(verified.map(({ providerId }) => providerId));
  const signers = new Set(verified.map(({ providerSigner }) => providerSigner));
  const organizations = new Set(verified.map(({ providerOrganization }) => providerOrganization));
  if (providerIds.size !== verified.length || signers.size !== verified.length || organizations.size !== verified.length) {
    throw new Error("BIT/WBTC providers must have distinct identities and organizations");
  }
  const observedTimes = verified.map(({ observedAt }) => observedAt);
  const earliest = observedTimes.reduce((left, right) => (left < right ? left : right));
  const latest = observedTimes.reduce((left, right) => (left > right ? left : right));
  if (latest - earliest > integer(policy.maximumProviderSkewSeconds, "policy.maximumProviderSkewSeconds")) {
    throw new Error("BIT/WBTC provider observation skew is excessive");
  }
  const commonDigest = digest(commonObservation(observations[0]));
  if (observations.some((observation) => digest(commonObservation(observation)) !== commonDigest)) {
    throw new Error("BIT/WBTC providers disagree");
  }
  const first = verified[0];
  if (verified.some((entry) => entry.priceMsatPerBit !== first.priceMsatPerBit
      || entry.executableDepthSats !== first.executableDepthSats
      || entry.meanTick !== first.meanTick
      || entry.harmonicMeanLiquidity !== first.harmonicMeanLiquidity)) {
    throw new Error("BIT/WBTC derived provider results disagree");
  }

  const providerSet = verified
    .map(({
      providerId,
      providerSigner,
      providerOrganization,
      providerObservationDigest,
      providerSignatureDigest,
      observedAt,
    }) => ({
      providerId,
      providerSigner,
      providerOrganization,
      providerObservationDigest,
      providerSignatureDigest,
      observedAt,
    }))
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
  const providerSetDigest = digest(providerSet);
  const policyDigest = digest(policy);
  const requestDigest = digest(request);
  const venueId = keccak256(toUtf8Bytes([
    "treeswap.bit-wbtc-uniswap-v3.v1",
    String(policy.chainId),
    getAddress(policy.uniswapV3Factory),
    getAddress(policy.poolAddress),
  ].join("|")));
  const controlDomain = keccak256(toUtf8Bytes("ethereum-mainnet:uniswap-v3-core"));
  const operatorOrganization = controlDomain;
  const evidence = Object.freeze({
    schema: "treeswap.bit-wbtc-market-reference.v2",
    scope: "market-reference-only-no-settlement-or-funding-authorization",
    direction: request.direction,
    blockNumber: first.blockNumber,
    blockTimestamp: first.blockTimestamp,
    bitProxyCodeHash: bytes32(policy.bitProxyCodeHash, "policy.bitProxyCodeHash"),
    bitImplementation: safeAddress(policy.bitImplementation, "policy.bitImplementation"),
    bitImplementationCodeHash: bytes32(policy.bitImplementationCodeHash, "policy.bitImplementationCodeHash"),
    bitImplementationSlot: bytes32(policy.bitImplementationSlot, "policy.bitImplementationSlot"),
    bitSymbol: policy.bitSymbol,
    bitDecimals: integer(policy.bitDecimals, "policy.bitDecimals"),
    bitPaused: policy.bitPaused,
    wbtcToken: safeAddress(policy.wbtcToken, "policy.wbtcToken"),
    wbtcTokenCodeHash: bytes32(policy.wbtcTokenCodeHash, "policy.wbtcTokenCodeHash"),
    wbtcSymbol: policy.wbtcSymbol,
    wbtcDecimals: integer(policy.wbtcDecimals, "policy.wbtcDecimals"),
    wbtcPaused: policy.wbtcPaused,
    policyDigest,
    requestDigest,
    commonObservationDigest: commonDigest,
    meanTick: first.meanTick,
    harmonicMeanLiquidity: first.harmonicMeanLiquidity,
    wideRangeLiquidity: first.wideRangeLiquidity,
    twapWbtcAtomicPerBit: first.twapWbtcAtomicPerBit,
    spotWbtcAtomicPerBit: first.spotWbtcAtomicPerBit,
    probeWbtcAtomicPerBit: first.probeWbtcAtomicPerBit,
    wbtcBtcPeg: first.peg,
    priceMsatPerBit: first.priceMsatPerBit,
    executableDepthSats: first.executableDepthSats,
    executableDepthBitWei: integer(observations[0].probe.amountBitWei, "probe.amountBitWei"),
    venueId,
    controlDomain,
    operatorOrganization,
    providerSetDigest,
    providerCount: providerSet.length,
    fundingAuthorization: false,
  });
  const evidenceDigest = digest(evidence);
  const priceSignal = Object.freeze({
    kind: "bit-wbtc-twap-probe",
    chainId: integer(policy.chainId, "policy.chainId"),
    source: `uniswap-v3:${getAddress(policy.poolAddress).toLowerCase()}`,
    venueId,
    controlDomain,
    operatorOrganization,
    pricePolicyDigest: policyDigest,
    observationDigest: evidenceDigest,
    direction: request.direction,
    observedAt: latest,
    validUntil: latest + integer(policy.maximumObservationAgeSeconds, "policy.maximumObservationAgeSeconds"),
    priceMsatPerBit: first.priceMsatPerBit,
    executableDepthSats: first.executableDepthSats,
    executableDepthBitWei: integer(observations[0].probe.amountBitWei, "probe.amountBitWei"),
  });
  verifiedPoolSignals.add(priceSignal);
  verifiedPoolSignalRequests.set(priceSignal, Object.freeze({
    direction: request.direction,
    bitWei: integer(request.bitWei, "request.bitWei"),
    lightningSats: integer(request.lightningSats, "request.lightningSats"),
  }));
  return Object.freeze({
    evidence: Object.freeze({ ...evidence, evidenceDigest }),
    priceSignal,
  });
}

export function isVerifiedBitWbtcPoolPriceSignal(value, request = null) {
  if (!value || typeof value !== "object" || !verifiedPoolSignals.has(value)) return false;
  if (request === null) return true;
  try {
    const bound = verifiedPoolSignalRequests.get(value);
    return Boolean(bound
      && bound.direction === request.direction
      && bound.bitWei === integer(request.bitWei, "request.bitWei")
      && bound.lightningSats === integer(request.lightningSats, "request.lightningSats"));
  } catch {
    return false;
  }
}
