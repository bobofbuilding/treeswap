import assert from "node:assert/strict";
import test from "node:test";
import { TypedDataEncoder, Wallet } from "ethers";
import {
  buildExecutableVenuePriceSignal,
  executableVenueObservationTypedData,
  isVerifiedExecutableVenuePriceSignal,
} from "../lib/executable-venue-price-signal.mjs";
import { buildBitRiskAttestation, evaluateBitRisk } from "../lib/risk-policy.mjs";

const NOW = 2_000_000_000;
const BIT = 10n ** 18n;
const HASH = (byte) => `0x${byte.repeat(64)}`;
const WALLETS = [null, new Wallet(HASH("1")), new Wallet(HASH("2")), new Wallet(HASH("3"))];
const SOURCE_POLICIES = [null, 1, 2, 3].map((index) => index === null ? null : Object.freeze({
  chainId: 1,
  verifyingContract: "0x57A447E4d5e18A9423408C365963A73F08B9d18C",
  source: `venue-${String.fromCharCode(96 + index)}`,
  venueId: HASH(String.fromCharCode(96 + index)),
  controlDomain: HASH(String.fromCharCode(99 + index)),
  operatorOrganization: HASH(String(index + 3)),
  signer: WALLETS[index].address,
  maximumValiditySeconds: 60,
}));

function venueSignal(index, observationChanges = {}, policyChanges = {}) {
  const sourcePolicy = { ...SOURCE_POLICIES[index], ...policyChanges };
  const unsigned = {
    source: sourcePolicy.source,
    direction: "lightning-to-bit",
    observedAt: NOW - index - 2,
    validUntil: NOW + 20,
    priceMsatPerBit: [0, 100_000n, 101_000n, 99_500n][index],
    executableDepthSats: 50_000n,
    executableDepthBitWei: 500n * BIT,
    quoteCommitment: HASH(String(index + 6)),
    ...observationChanges,
  };
  const typedData = executableVenueObservationTypedData({ sourcePolicy, observation: unsigned });
  return buildExecutableVenuePriceSignal({
    sourcePolicy,
    observation: {
      ...unsigned,
      signature: WALLETS[index].signingKey.sign(
        TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.value),
      ).serialized,
    },
  });
}

const policy = {
  chainId: 1,
  proxyAddress: "0x57A447E4d5e18A9423408C365963A73F08B9d18C",
  expectedImplementation: "0x1111111111111111111111111111111111111111",
  expectedProxyCodeHash: `0x${"aa".repeat(32)}`,
  expectedImplementationCodeHash: `0x${"bb".repeat(32)}`,
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
  allowedPriceSourcePolicyDigests: [],
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

const priceSignals = [venueSignal(1), venueSignal(2), venueSignal(3)];
policy.allowedPriceSourcePolicyDigests = priceSignals.map((signal) => signal.pricePolicyDigest);

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
    venueSignal(1, { observedAt: NOW - 100, validUntil: NOW - 50 }),
    priceSignals[0],
    venueSignal(2, { executableDepthSats: 1n }),
    venueSignal(3, { priceMsatPerBit: 150_000n }),
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
    priceSignals: [1, 2, 3].map((index) => venueSignal(index, { direction: "bit-to-lightning" })),
    request: { ...request, direction: "bit-to-lightning" },
  });
  assert.equal(result.enabled, true);
  assert.equal(result.feeBps, 72);
});

test("commits the exact healthy proxy, finality, market, and source set", () => {
  const evaluation = evaluateBitRisk({ policy, snapshot, priceSignals, request });
  const first = buildBitRiskAttestation({ policy, snapshot, evaluation });
  const reorderedEvaluation = evaluateBitRisk({ policy, snapshot, priceSignals: [...priceSignals].reverse(), request });
  const reordered = buildBitRiskAttestation({
    policy,
    snapshot,
    evaluation: reorderedEvaluation,
  });
  assert.equal(first.riskDigest, reordered.riskDigest);
  assert.match(first.riskDigest, /^0x[0-9a-f]{64}$/);
  assert.match(first.policyDigest, /^0x[0-9a-f]{64}$/);

  const unsafeSnapshot = { ...snapshot, paused: true };
  const unsafeEvaluation = evaluateBitRisk({ policy, snapshot: unsafeSnapshot, priceSignals, request });
  assert.throws(
    () => buildBitRiskAttestation({ policy, snapshot: unsafeSnapshot, evaluation: unsafeEvaluation }),
    /unsafe BIT state/,
  );
  assert.throws(
    () => buildBitRiskAttestation({
      policy,
      snapshot,
      evaluation: { ...evaluation, qualifiedPriceSources: ["substituted", ...evaluation.qualifiedPriceSources.slice(1)] },
    }),
    /original verified evaluation/,
  );
  assert.throws(
    () => buildBitRiskAttestation({ policy: { ...policy, maxPriceAgeSeconds: 31 }, snapshot, evaluation }),
    /policy or snapshot does not match/,
  );
  assert.throws(
    () => buildBitRiskAttestation({ policy, snapshot: { ...snapshot, finalizedBlock: 969 }, evaluation }),
    /policy or snapshot does not match/,
  );
});

test("does not count duplicate venues, control domains, organizations, or wrong-direction prices as independent", () => {
  const duplicateVenue = venueSignal(2, {}, { source: "venue-d", venueId: priceSignals[0].venueId });
  const duplicateControl = venueSignal(3, {}, { source: "venue-e", controlDomain: priceSignals[0].controlDomain });
  const duplicateOrganization = venueSignal(2, {}, {
    source: "venue-g",
    venueId: HASH("9"),
    controlDomain: HASH("8"),
    operatorOrganization: priceSignals[0].operatorOrganization,
  });
  const wrongDirection = venueSignal(3, { direction: "bit-to-lightning" }, { source: "venue-f" });
  const duplicatePolicy = {
    ...policy,
    allowedPriceSourcePolicyDigests: [
      priceSignals[0].pricePolicyDigest,
      duplicateVenue.pricePolicyDigest,
      duplicateControl.pricePolicyDigest,
      duplicateOrganization.pricePolicyDigest,
      wrongDirection.pricePolicyDigest,
    ],
  };
  const duplicated = [
    priceSignals[0],
    duplicateVenue,
    duplicateControl,
    duplicateOrganization,
    wrongDirection,
  ];
  const result = evaluateBitRisk({ policy: duplicatePolicy, snapshot, priceSignals: duplicated, request });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.qualifiedPriceSources, []);
  assert.match(result.reasons.join("; "), /conflicting price signal identity/);
  assert.match(result.reasons.join("; "), /insufficient fresh executable price sources/);
});

test("conflicting fresh observations cannot make price evaluation depend on caller order", () => {
  const conflictingVenueA = venueSignal(1, {
    observedAt: NOW - 1,
    validUntil: NOW + 20,
    priceMsatPerBit: 150_000n,
  });
  const safeFirst = evaluateBitRisk({
    policy,
    snapshot,
    priceSignals: [priceSignals[0], priceSignals[1], priceSignals[2], conflictingVenueA],
    request,
  });
  const unsafeFirst = evaluateBitRisk({
    policy,
    snapshot,
    priceSignals: [conflictingVenueA, priceSignals[1], priceSignals[2], priceSignals[0]],
    request,
  });

  assert.equal(safeFirst.enabled, false);
  assert.equal(unsafeFirst.enabled, false);
  assert.deepEqual(safeFirst.qualifiedPriceEvidence, unsafeFirst.qualifiedPriceEvidence);
  assert.match(safeFirst.reasons.join("; "), /conflicting price signal identity/);
  assert.match(unsafeFirst.reasons.join("; "), /conflicting price signal identity/);
});

test("bounds price candidate work before verified signals are normalized", () => {
  const result = evaluateBitRisk({
    policy,
    snapshot,
    priceSignals: Array.from({ length: 65 }, () => priceSignals[0]),
    request,
  });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.qualifiedPriceSources, []);
  assert.match(result.reasons.join("; "), /price signal candidate limit exceeded/);
});

test("an exact repeated price observation is harmless and remains one source", () => {
  const result = evaluateBitRisk({
    policy,
    snapshot,
    priceSignals: [...priceSignals, priceSignals[0]],
    request,
  });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.qualifiedPriceSources, ["venue-a", "venue-b", "venue-c"]);
  assert.doesNotMatch(result.reasons.join("; "), /conflicting price signal identity/);
});

test("rejects a valid source whose executable depth covers only one asset leg", () => {
  const shallowBit = [
    venueSignal(1, { executableDepthBitWei: request.bitWei - 1n }),
    priceSignals[1],
    priceSignals[2],
  ];
  const result = evaluateBitRisk({ policy, snapshot, priceSignals: shallowBit, request });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.qualifiedPriceSources, ["venue-b", "venue-c"]);
  assert.match(result.reasons.join("; "), /insufficient fresh executable price sources/);
});

test("rejects copied or non-allowlisted executable venue signals", () => {
  const unallowlisted = venueSignal(1, {}, { source: "venue-z", venueId: HASH("f") });
  const result = evaluateBitRisk({
    policy,
    snapshot,
    priceSignals: [{ ...priceSignals[0] }, priceSignals[1], unallowlisted],
    request,
  });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.qualifiedPriceSources, ["venue-b"]);
  assert.equal(isVerifiedExecutableVenuePriceSignal(priceSignals[0]), true);
  assert.equal(isVerifiedExecutableVenuePriceSignal({ ...priceSignals[0] }), false);
});

test("rejects signer substitution, signed mutation, and overlong venue validity", () => {
  const sourcePolicy = SOURCE_POLICIES[1];
  const unsigned = {
    source: sourcePolicy.source,
    direction: "lightning-to-bit",
    observedAt: NOW - 2,
    validUntil: NOW + 20,
    priceMsatPerBit: 100_000n,
    executableDepthSats: 50_000n,
    executableDepthBitWei: 500n * BIT,
    quoteCommitment: HASH("7"),
  };
  const typedData = executableVenueObservationTypedData({ sourcePolicy, observation: unsigned });
  const wrongSignature = WALLETS[2].signingKey.sign(
    TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.value),
  ).serialized;
  assert.throws(() => buildExecutableVenuePriceSignal({
    sourcePolicy,
    observation: { ...unsigned, signature: wrongSignature },
  }), /not from the pinned signer/);
  const rightSignature = WALLETS[1].signingKey.sign(
    TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.value),
  ).serialized;
  assert.throws(() => buildExecutableVenuePriceSignal({
    sourcePolicy,
    observation: { ...unsigned, priceMsatPerBit: 100_001n, signature: rightSignature },
  }), /signature is invalid|not from the pinned signer/);
  assert.throws(() => venueSignal(1, { validUntil: NOW + 100 }), /validity is unsafe/);
});
