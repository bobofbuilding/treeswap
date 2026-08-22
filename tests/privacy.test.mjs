import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import {
  PRIVACY_RETENTION_SECONDS,
  assertPublicPricingRequest,
  buildBlindPricingRequest,
  privacySafeAudit,
  retentionDeadline,
  unlinkablePricingId,
} from "../lib/privacy.mjs";

const NOW = 2_000_000_000;
const request = {
  pricingId: unlinkablePricingId(id("random pricing nonce")),
  requestId: id("private settlement"),
  direction: "bit-to-lightning",
  chainId: 1,
  exactBitOutputWei: 0n,
  exactLightningOutputSats: 25_000n,
  maxFeeBps: 100n,
  maxRoutingFeeSats: 20n,
  capacityEpoch: 9,
  expiresAt: NOW + 90,
  user: "0x2222222222222222222222222222222222222222",
  beneficiary: "0x3333333333333333333333333333333333333333",
  paymentHash: id("payment"),
  invoiceDigest: id("invoice"),
};

test("publishes only the minimum unlinkable fields required to price an exact swap", () => {
  const publicRequest = buildBlindPricingRequest(request);
  assert.deepEqual(Object.keys(publicRequest), [
    "pricingId", "direction", "chainId", "exactOutput", "outputUnit", "maxFeeBps",
    "maxRoutingFeeSats", "capacityEpoch", "expiresAt",
  ]);
  const encoded = JSON.stringify(publicRequest);
  for (const secret of [request.requestId, request.user, request.beneficiary, request.paymentHash, request.invoiceDigest]) {
    assert.doesNotMatch(encoded.toLowerCase(), new RegExp(secret.slice(2).toLowerCase()));
  }
});

test("rejects sensitive fields anywhere in a public pricing request", () => {
  assert.throws(() => assertPublicPricingRequest({ nested: { invoice: "lnbc..." } }), /sensitive field: invoice/);
  assert.throws(() => buildBlindPricingRequest({ ...request, pricingId: request.requestId }), /must be unlinkable/);
});

test("redacts cross-network identifiers and supplies deletion deadlines", () => {
  assert.deepEqual(privacySafeAudit("settled", {
    requestId: request.requestId,
    paymentHash: request.paymentHash,
    invoice: "lnbc...",
    beneficiary: request.beneficiary,
    amountSats: 25_000n,
  }), {
    event: "settled",
    requestId: request.requestId,
    paymentHash: "[redacted]",
    invoice: "[redacted]",
    beneficiary: "[redacted]",
    amountSats: "25000",
  });
  assert.equal(retentionDeadline({ kind: "publicPricing", createdAt: NOW }), NOW + PRIVACY_RETENTION_SECONDS.publicPricing);
  assert.equal(
    retentionDeadline({ kind: "privateSettlement", createdAt: NOW, terminalAt: NOW + 100 }),
    NOW + 100 + PRIVACY_RETENTION_SECONDS.privateSettlementAfterTerminal,
  );
});
