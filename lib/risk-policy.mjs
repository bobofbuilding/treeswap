import { AbiCoder, Contract, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { isVerifiedBitWbtcPoolPriceSignal } from "./bit-wbtc-market-reference.mjs";
import { isVerifiedExecutableVenuePriceSignal } from "./executable-venue-price-signal.mjs";

export const BIT_PROXY_ADDRESS = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const BIT_SCALE = 10n ** 18n;
const BPS = 10_000n;
const verifiedRiskEvaluations = new WeakMap();

function asBigInt(value, name) {
  try {
    return BigInt(value);
  } catch {
    throw new TypeError(`${name} must be an integer`);
  }
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function normalizedBytes32(value) {
  const parsed = String(value ?? "").toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(parsed) && !/^0x0{64}$/.test(parsed) ? parsed : "";
}

function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function objectDigest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value))));
}

function median(values) {
  const ordered = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2n;
}

function deviationBps(observed, reference) {
  const difference = observed > reference ? observed - reference : reference - observed;
  return (difference * BPS) / reference;
}

function addReason(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

export function computeInventoryFeeBps({
  available,
  capacity,
  requested,
  baseFeeBps,
  maxFeeBps,
  reserveFloorBps,
  scarcityStartsBps,
}) {
  const availableAmount = asBigInt(available, "available");
  const capacityAmount = asBigInt(capacity, "capacity");
  const requestedAmount = asBigInt(requested, "requested");
  const base = asBigInt(baseFeeBps, "baseFeeBps");
  const maximum = asBigInt(maxFeeBps, "maxFeeBps");
  const floor = asBigInt(reserveFloorBps, "reserveFloorBps");
  const scarcityStart = asBigInt(scarcityStartsBps, "scarcityStartsBps");

  if (capacityAmount <= 0n || requestedAmount <= 0n || availableAmount < requestedAmount) {
    return { enabled: false, feeBps: maximum, remainingBps: 0n };
  }

  const remaining = availableAmount - requestedAmount;
  const remainingBps = (remaining * BPS) / capacityAmount;
  if (remainingBps < floor) return { enabled: false, feeBps: maximum, remainingBps };
  if (remainingBps >= scarcityStart || scarcityStart <= floor) {
    return { enabled: true, feeBps: base, remainingBps };
  }

  const scarcityUsed = scarcityStart - remainingBps;
  const scarcityRange = scarcityStart - floor;
  const surcharge = ((maximum - base) * scarcityUsed + scarcityRange - 1n) / scarcityRange;
  return { enabled: true, feeBps: base + surcharge, remainingBps };
}

export function evaluateBitRisk({ policy, snapshot, priceSignals, request }) {
  const reasons = [];
  const now = asBigInt(request.now, "request.now");
  const snapshotAt = asBigInt(snapshot.observedAt, "snapshot.observedAt");
  const requestedBitWei = asBigInt(request.bitWei, "request.bitWei");
  const requestedLightningSats = asBigInt(request.lightningSats, "request.lightningSats");
  const referencePriceMsat = asBigInt(policy.referenceSatsPerBit, "referenceSatsPerBit") * 1_000n;
  const allowedPricePolicies = new Set(
    (Array.isArray(policy.allowedPriceSourcePolicyDigests) ? policy.allowedPriceSourcePolicyDigests : [])
      .map(normalizedBytes32)
      .filter(Boolean),
  );

  addReason(reasons, request.direction !== "lightning-to-bit" && request.direction !== "bit-to-lightning", "unsupported direction");
  addReason(reasons, requestedBitWei <= 0n || requestedLightningSats <= 0n, "amount must be positive");
  addReason(reasons, asBigInt(snapshot.chainId, "snapshot.chainId") !== asBigInt(policy.chainId, "policy.chainId"), "wrong chain");
  addReason(reasons, !sameAddress(snapshot.proxyAddress, policy.proxyAddress), "unexpected BIT proxy");
  addReason(reasons, !sameAddress(snapshot.implementation, policy.expectedImplementation), "BIT implementation changed");
  addReason(reasons, snapshot.proxyCodeHash !== policy.expectedProxyCodeHash, "BIT proxy code changed");
  addReason(reasons, snapshot.implementationCodeHash !== policy.expectedImplementationCodeHash, "BIT implementation code changed");
  addReason(reasons, Number(snapshot.decimals) !== Number(policy.decimals), "BIT decimals changed");
  addReason(reasons, snapshot.paused !== false, "BIT is paused or pause state is unavailable");
  addReason(reasons, snapshotAt > now || now - snapshotAt > asBigInt(policy.maxSnapshotAgeSeconds, "maxSnapshotAgeSeconds"), "BIT state snapshot is stale");

  const latestBlock = asBigInt(snapshot.latestBlock, "snapshot.latestBlock");
  const finalizedBlock = asBigInt(snapshot.finalizedBlock, "snapshot.finalizedBlock");
  addReason(reasons, finalizedBlock > latestBlock, "invalid finality state");
  addReason(reasons, latestBlock - finalizedBlock > asBigInt(policy.maxFinalityLagBlocks, "maxFinalityLagBlocks"), "Ethereum finality is unhealthy");
  addReason(reasons, requestedBitWei > asBigInt(policy.maxSwapBitWei, "maxSwapBitWei"), "per-swap BIT cap exceeded");
  addReason(
    reasons,
    asBigInt(snapshot.epochBitVolumeWei, "snapshot.epochBitVolumeWei") + requestedBitWei
      > asBigInt(policy.maxEpochBitWei, "maxEpochBitWei"),
    "per-epoch BIT cap exceeded",
  );

  const uniqueSignals = new Map();
  const uniqueVenues = new Set();
  const uniqueControlDomains = new Set();
  const uniqueOrganizations = new Set();
  for (const rawSignal of Array.isArray(priceSignals) ? priceSignals : []) {
    const source = String(rawSignal.source ?? "").trim().toLowerCase();
    const venueId = normalizedBytes32(rawSignal.venueId);
    const controlDomain = normalizedBytes32(rawSignal.controlDomain);
    const observationDigest = normalizedBytes32(rawSignal.observationDigest);
    const pricePolicyDigest = normalizedBytes32(rawSignal.pricePolicyDigest);
    const operatorOrganization = normalizedBytes32(rawSignal.operatorOrganization);
    const kind = String(rawSignal.kind ?? "");
    if (
      !/^[a-z0-9][a-z0-9._:-]{1,79}$/.test(source)
      || !venueId
      || !controlDomain
      || !observationDigest
      || !pricePolicyDigest
      || !operatorOrganization
      || asBigInt(rawSignal.chainId, "priceSignal.chainId") !== asBigInt(policy.chainId, "policy.chainId")
      || !allowedPricePolicies.has(pricePolicyDigest)
      || (kind !== "executable-venue" && kind !== "bit-wbtc-twap-probe")
      || (kind === "executable-venue" && !isVerifiedExecutableVenuePriceSignal(rawSignal))
      || (kind === "bit-wbtc-twap-probe" && !isVerifiedBitWbtcPoolPriceSignal(rawSignal))
      || rawSignal.direction !== request.direction
      || uniqueSignals.has(source)
      || uniqueVenues.has(venueId)
      || uniqueControlDomains.has(controlDomain)
      || uniqueOrganizations.has(operatorOrganization)
    ) continue;
    const observedAt = asBigInt(rawSignal.observedAt, "priceSignal.observedAt");
    const priceMsatPerBit = asBigInt(rawSignal.priceMsatPerBit, "priceSignal.priceMsatPerBit");
    const executableDepthSats = asBigInt(rawSignal.executableDepthSats, "priceSignal.executableDepthSats");
    const executableDepthBitWei = asBigInt(rawSignal.executableDepthBitWei, "priceSignal.executableDepthBitWei");
    const validUntil = asBigInt(rawSignal.validUntil, "priceSignal.validUntil");
    if (
      observedAt <= now
      && validUntil > now
      && now - observedAt <= asBigInt(policy.maxPriceAgeSeconds, "maxPriceAgeSeconds")
      && priceMsatPerBit > 0n
      && executableDepthSats >= requestedLightningSats
      && executableDepthBitWei >= requestedBitWei
    ) {
      uniqueSignals.set(source, {
        source,
        kind,
        venueId,
        controlDomain,
        observationDigest,
        pricePolicyDigest,
        operatorOrganization,
        observedAt,
        priceMsatPerBit,
        executableDepthSats,
        executableDepthBitWei,
      });
      uniqueVenues.add(venueId);
      uniqueControlDomains.add(controlDomain);
      uniqueOrganizations.add(operatorOrganization);
    }
  }

  const signals = [...uniqueSignals.values()];
  addReason(reasons, signals.length < Number(policy.minPriceSources), "insufficient fresh executable price sources");

  let marketPriceMsatPerBit = 0n;
  let signalSpreadBps = 0n;
  if (signals.length > 0) {
    const prices = signals.map((signal) => signal.priceMsatPerBit);
    marketPriceMsatPerBit = median(prices);
    const low = prices.reduce((value, price) => (price < value ? price : value));
    const high = prices.reduce((value, price) => (price > value ? price : value));
    signalSpreadBps = (high - low) * BPS / marketPriceMsatPerBit;
    addReason(reasons, signalSpreadBps > asBigInt(policy.maxSignalSpreadBps, "maxSignalSpreadBps"), "external price sources disagree");
    addReason(
      reasons,
      deviationBps(marketPriceMsatPerBit, referencePriceMsat)
        > asBigInt(policy.maxMarketDeviationBps, "maxMarketDeviationBps"),
      "market price is outside the reference band",
    );
  }

  const consumesBit = request.direction === "lightning-to-bit";
  const inventory = computeInventoryFeeBps({
    available: consumesBit ? snapshot.availableBitWei : snapshot.availableLightningSats,
    capacity: consumesBit ? snapshot.bitCapacityWei : snapshot.lightningCapacitySats,
    requested: consumesBit ? requestedBitWei : requestedLightningSats,
    baseFeeBps: consumesBit ? policy.baseFeeBpsLightningToBit : policy.baseFeeBpsBitToLightning,
    maxFeeBps: policy.maxFeeBps,
    reserveFloorBps: policy.reserveFloorBps,
    scarcityStartsBps: policy.scarcityStartsBps,
  });
  addReason(reasons, !inventory.enabled, `${consumesBit ? "BIT" : "Lightning"} inventory reserve would be breached`);

  const evaluation = Object.freeze({
    enabled: reasons.length === 0,
    reasons: Object.freeze([...reasons]),
    feeBps: Number(inventory.feeBps),
    remainingInventoryBps: Number(inventory.remainingBps),
    marketPriceMsatPerBit,
    signalSpreadBps,
    qualifiedPriceSources: Object.freeze(signals.map((signal) => signal.source)),
    qualifiedPriceEvidence: Object.freeze(signals.map((signal) => Object.freeze({
      source: signal.source,
      kind: signal.kind,
      venueId: signal.venueId,
      controlDomain: signal.controlDomain,
      observationDigest: signal.observationDigest,
      pricePolicyDigest: signal.pricePolicyDigest,
      operatorOrganization: signal.operatorOrganization,
      direction: request.direction,
    }))),
  });
  verifiedRiskEvaluations.set(evaluation, Object.freeze({
    policyDigest: objectDigest(policy),
    snapshotDigest: objectDigest(snapshot),
  }));
  return evaluation;
}

export async function readBitRiskSnapshot(provider, { proxyAddress = BIT_PROXY_ADDRESS } = {}) {
  const token = new Contract(
    proxyAddress,
    ["function decimals() view returns (uint8)", "function paused() view returns (bool)"],
    provider,
  );
  const [network, proxyCode, implementationWord, decimals, paused, latest, finalized] = await Promise.all([
    provider.getNetwork(),
    provider.getCode(proxyAddress),
    provider.getStorage(proxyAddress, ERC1967_IMPLEMENTATION_SLOT),
    token.decimals(),
    token.paused(),
    provider.getBlock("latest"),
    provider.getBlock("finalized"),
  ]);

  const implementation = getAddress(`0x${implementationWord.slice(-40)}`);
  const implementationCode = await provider.getCode(implementation);
  if (proxyCode === "0x" || implementationCode === "0x" || !latest || !finalized) {
    throw new Error("BIT proxy state is incomplete");
  }

  return {
    chainId: network.chainId,
    observedAt: Math.floor(Date.now() / 1_000),
    proxyAddress: getAddress(proxyAddress),
    implementation,
    proxyCodeHash: keccak256(proxyCode),
    implementationCodeHash: keccak256(implementationCode),
    decimals: Number(decimals),
    paused: Boolean(paused),
    latestBlock: latest.number,
    finalizedBlock: finalized.number,
  };
}

export function buildBitRiskAttestation({ policy, snapshot, evaluation }) {
  const provenance = evaluation && typeof evaluation === "object" ? verifiedRiskEvaluations.get(evaluation) : null;
  if (!provenance) throw new Error("risk attestation requires the original verified evaluation");
  const policyDigest = objectDigest(policy);
  if (provenance.policyDigest !== policyDigest || provenance.snapshotDigest !== objectDigest(snapshot)) {
    throw new Error("risk attestation policy or snapshot does not match the verified evaluation");
  }
  if (evaluation?.enabled !== true) throw new Error("cannot attest an unsafe BIT state");
  const sources = [...(evaluation.qualifiedPriceSources ?? [])].map((source) => String(source).toLowerCase()).sort();
  if (sources.length < Number(policy.minPriceSources)) throw new Error("risk attestation lacks independent price sources");
  const evidenceSources = [];
  const evidence = [...(evaluation.qualifiedPriceEvidence ?? [])]
    .map((entry) => {
      const fields = [
        String(entry.source ?? "").toLowerCase(),
        String(entry.kind ?? ""),
        normalizedBytes32(entry.venueId),
        normalizedBytes32(entry.controlDomain),
        normalizedBytes32(entry.observationDigest),
        normalizedBytes32(entry.pricePolicyDigest),
        normalizedBytes32(entry.operatorOrganization),
        String(entry.direction ?? ""),
      ];
      if (fields.some((field) => !field)) throw new Error("risk attestation lacks exact price-source evidence");
      evidenceSources.push(fields[0]);
      return fields.join("|");
    })
    .sort();
  evidenceSources.sort();
  if (evidence.length !== sources.length || evidenceSources.some((source, index) => source !== sources[index])) {
    throw new Error("risk attestation lacks exact price-source evidence");
  }
  const sourceSetDigest = keccak256(toUtf8Bytes(evidence.join("||")));
  const coder = AbiCoder.defaultAbiCoder();
  const riskDigest = keccak256(coder.encode(
    [
      "string",
      "uint256",
      "address",
      "address",
      "bytes32",
      "bytes32",
      "uint8",
      "bool",
      "uint64",
      "uint64",
      "uint64",
      "uint256",
      "uint256",
      "bytes32",
      "bytes32",
    ],
    [
      "TreeSwap BIT risk attestation v1",
      asBigInt(snapshot.chainId, "snapshot.chainId"),
      getAddress(snapshot.proxyAddress),
      getAddress(snapshot.implementation),
      snapshot.proxyCodeHash,
      snapshot.implementationCodeHash,
      Number(snapshot.decimals),
      Boolean(snapshot.paused),
      asBigInt(snapshot.observedAt, "snapshot.observedAt"),
      asBigInt(snapshot.latestBlock, "snapshot.latestBlock"),
      asBigInt(snapshot.finalizedBlock, "snapshot.finalizedBlock"),
      asBigInt(evaluation.marketPriceMsatPerBit, "evaluation.marketPriceMsatPerBit"),
      asBigInt(evaluation.signalSpreadBps, "evaluation.signalSpreadBps"),
      sourceSetDigest,
      policyDigest,
    ],
  ));
  return Object.freeze({ riskDigest, sourceSetDigest, policyDigest, sources });
}

export { BIT_SCALE };
