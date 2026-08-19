import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeLightningAction,
  consumeLightningAuthorization,
  deriveSettlementSchedule,
  issueLightningAuthorization,
  validateLightningDispatch,
  validateHeldHtlc,
} from "../lib/settlement-policy.mjs";
import { id } from "ethers";

const NOW = 2_000_000_000;
const HEIGHT = 900_000;
const policy = {
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
};

const canonicalChain = {
  latestBlock: 1_200,
  finalizedBlock: 1_190,
  escrowBlock: 1_180,
  escrowBlockHash: "0xabc",
  canonicalBlockHash: "0xabc",
  escrowDigest: "0xintent",
  expectedEscrowDigest: "0xintent",
};

const healthyService = {
  riskGateEnabled: true,
  balancesReconciled: true,
  lightningNodeSynced: true,
  adapterHealthy: true,
};

function derive(direction = "lightning-to-bit") {
  return deriveSettlementSchedule({
    direction,
    nowSeconds: NOW,
    bitcoinHeight: HEIGHT,
    invoice: {
      timestamp: NOW - 10,
      expirySeconds: 10_800,
      minFinalCltvExpiryDelta: direction === "lightning-to-bit" ? 60 : 18,
    },
    policy,
  });
}

test("derives quote, Lightning cutoff, and refund in a strict monotonic order", () => {
  const schedule = derive();
  assert.ok(schedule.quoteExpiresAt < schedule.lastSafeClaimAt);
  assert.ok(schedule.lastSafeClaimAt < schedule.refundAfter);
  assert.ok(schedule.ethereumFinalAt + policy.minimumPaymentWindowSeconds <= schedule.lastSafeClaimAt);
  assert.equal(schedule.claimBufferSeconds, 2_616);
  assert.equal(schedule.cltvSafeHeight, HEIGHT + 36);
});

test("rejects an invoice that cannot outlive finality and payment margins", () => {
  assert.throws(
    () => deriveSettlementSchedule({
      direction: "bit-to-lightning",
      nowSeconds: NOW,
      bitcoinHeight: HEIGHT,
      invoice: { timestamp: NOW, expirySeconds: 900, minFinalCltvExpiryDelta: 18 },
      policy,
    }),
    /cannot outlive Ethereum finality/,
  );
});

test("requires a larger final CLTV window for a held Lightning-to-BIT payment", () => {
  assert.throws(
    () => deriveSettlementSchedule({
      direction: "lightning-to-bit",
      nowSeconds: NOW,
      bitcoinHeight: HEIGHT,
      invoice: { timestamp: NOW, expirySeconds: 10_800, minFinalCltvExpiryDelta: 18 },
      policy,
    }),
    /final CLTV is below policy/,
  );
});

test("never extends the signed deadline after observing an accepted hold HTLC", () => {
  const schedule = derive();
  const held = validateHeldHtlc({
    schedule,
    observedAt: NOW + 300,
    currentBitcoinHeight: HEIGHT + 1,
    htlcExpiryHeight: HEIGHT + 80,
    policy,
  });
  assert.equal(held.valid, true);
  assert.ok(held.effectiveLastSafeAt <= schedule.lastSafeClaimAt);
});

test("rejects a held HTLC near the force-close safety boundary", () => {
  const held = validateHeldHtlc({
    schedule: derive(),
    observedAt: NOW + 300,
    currentBitcoinHeight: HEIGHT + 40,
    htlcExpiryHeight: HEIGHT + 60,
    policy,
  });
  assert.equal(held.valid, false);
  assert.match(held.reasons.join("; "), /below the hold-invoice minimum|too close/);
});

test("authorizes Lightning only after a matching escrow is canonical and finalized", () => {
  const schedule = derive("bit-to-lightning");
  const result = authorizeLightningAction({
    schedule,
    nowSeconds: NOW + 1_000,
    chain: canonicalChain,
    service: healthyService,
    policy,
  });
  assert.deepEqual(result, { authorized: true, reasons: [] });
});

test("fails closed on reorg, insufficient finality, unhealthy service, or exact cutoff", () => {
  const schedule = derive("bit-to-lightning");
  const result = authorizeLightningAction({
    schedule,
    nowSeconds: schedule.lastSafeClaimAt,
    chain: {
      latestBlock: 1_190,
      finalizedBlock: 1_170,
      escrowBlock: 1_180,
      escrowBlockHash: "0xorphaned",
      canonicalBlockHash: "0xcanonical",
      escrowDigest: "0xchanged",
      expectedEscrowDigest: "0xintent",
    },
    service: {
      riskGateEnabled: false,
      balancesReconciled: false,
      lightningNodeSynced: false,
      adapterHealthy: false,
    },
    policy,
  });
  assert.equal(result.authorized, false);
  assert.match(result.reasons.join("; "), /cutoff|not finalized|canonical|do not match|risk gate|not reconciled|not synced|unhealthy/);
});

test("revalidates and consumes one short-lived Lightning authorization immediately before RPC", () => {
  const schedule = derive("bit-to-lightning");
  const authorization = issueLightningAuthorization({
    actionId: id("one-shot-action"),
    schedule,
    chain: canonicalChain,
    service: healthyService,
    nowSeconds: NOW + 1_000,
    policy,
  });
  assert.equal(authorization.expiresAt, NOW + 1_015);
  const decision = validateLightningDispatch({
    authorization,
    chain: canonicalChain,
    service: healthyService,
    nowSeconds: NOW + 1_001,
    policy,
  });
  assert.equal(decision.authorized, true);
  const used = consumeLightningAuthorization([], authorization, decision);
  assert.deepEqual(used, [authorization.actionId]);
  assert.equal(validateLightningDispatch({
    authorization,
    chain: canonicalChain,
    service: healthyService,
    usedActionIds: used,
    nowSeconds: NOW + 1_002,
    policy,
  }).authorized, false);
});

test("rejects a reorg, finality rollback, intent change, or service failure after authorization", () => {
  const authorization = issueLightningAuthorization({
    actionId: id("reorg-action"),
    schedule: derive("bit-to-lightning"),
    chain: canonicalChain,
    service: healthyService,
    nowSeconds: NOW + 1_000,
    policy,
  });
  const cases = [
    { chain: { ...canonicalChain, canonicalBlockHash: "0xreorg" }, service: healthyService, reason: /reorged/ },
    { chain: { ...canonicalChain, finalizedBlock: 1_189 }, service: healthyService, reason: /regressed/ },
    { chain: { ...canonicalChain, escrowDigest: "0xchanged" }, service: healthyService, reason: /intent changed/ },
    { chain: canonicalChain, service: { ...healthyService, riskGateEnabled: false }, reason: /risk gate closed/ },
  ];
  for (const entry of cases) {
    const decision = validateLightningDispatch({
      authorization,
      chain: entry.chain,
      service: entry.service,
      nowSeconds: NOW + 1_001,
      policy,
    });
    assert.equal(decision.authorized, false);
    assert.match(decision.reasons.join("; "), entry.reason);
  }
});

test("rejects the authorization at its exact expiry boundary", () => {
  const authorization = issueLightningAuthorization({
    actionId: id("expired-action"),
    schedule: derive("bit-to-lightning"),
    chain: canonicalChain,
    service: healthyService,
    nowSeconds: NOW + 1_000,
    policy,
  });
  const decision = validateLightningDispatch({
    authorization,
    chain: canonicalChain,
    service: healthyService,
    nowSeconds: authorization.expiresAt,
    policy,
  });
  assert.equal(decision.authorized, false);
  assert.match(decision.reasons.join("; "), /expired/);
});
