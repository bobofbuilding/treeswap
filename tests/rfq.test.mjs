import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  RFQ_OFFER_TYPES,
  buildReceivedQuoteBook,
  fallbackAuthorization,
  rfqDomain,
  selectReceivedQuote,
} from "../lib/rfq.mjs";

const NOW = 2_000_000_000;
const BIT = 10n ** 18n;
const solvers = [new Wallet(`0x${"11".repeat(32)}`), new Wallet(`0x${"22".repeat(32)}`), new Wallet(`0x${"33".repeat(32)}`)];
const request = {
  requestId: id("request-1"),
  direction: "lightning-to-bit",
  chainId: 1,
  verifyingContract: "0x4444444444444444444444444444444444444444",
  user: "0x5555555555555555555555555555555555555555",
  beneficiary: "0x6666666666666666666666666666666666666666",
  paymentHash: id("payment-hash"),
  invoiceDigest: id("invoice"),
  nonce: 7n,
  expiresAt: NOW + 120,
  capacityEpoch: 42,
  exactBitOutputWei: 100n * BIT,
  exactLightningOutputSats: 0n,
  maxRoutingFeeSats: 20n,
  maxFeeBps: 100n,
};
const policy = {
  maxSourceLength: 64,
  maxClockSkewSeconds: 5,
  maxQuoteTtlSeconds: 120,
  maxOffersPerRequest: 16,
  minimumIndependentSolvers: 2,
};

function offer(solver, index, lightningAmountSats) {
  return {
    offerId: id(`offer-${index}`),
    requestId: request.requestId,
    direction: id(request.direction),
    user: request.user,
    beneficiary: request.beneficiary,
    solver: solver.address,
    grossBitAmount: 100n * BIT + 5n * 10n ** 17n,
    feeBitAmount: 5n * 10n ** 17n,
    lightningAmountSats: BigInt(lightningAmountSats),
    maxRoutingFeeSats: 10n,
    paymentHash: request.paymentHash,
    invoiceDigest: request.invoiceDigest,
    requestNonce: request.nonce,
    offerNonce: BigInt(index),
    expiresAt: NOW + 60,
    capacityEpoch: request.capacityEpoch,
  };
}

async function envelope(solver, index, lightningAmountSats, source, receivedAt = NOW) {
  const signedOffer = offer(solver, index, lightningAmountSats);
  return {
    source,
    receivedAt,
    offer: signedOffer,
    signature: await solver.signTypedData(rfqDomain(request), RFQ_OFFER_TYPES, signedOffer),
  };
}

test("orders exact signed offers by price and then receipt time", async () => {
  const envelopes = [
    await envelope(solvers[0], 1, 10_100, "relay-a", NOW + 1),
    await envelope(solvers[1], 2, 10_000, "relay-b", NOW + 2),
    await envelope(solvers[2], 3, 10_000, "direct-c", NOW),
  ];
  const book = buildReceivedQuoteBook({ request, envelopes, now: NOW + 2, policy });

  assert.equal(book.label, "Best received quote");
  assert.equal(book.solverCount, 3);
  assert.equal(book.sourceCount, 3);
  assert.equal(book.offers[0].offer.offerId, id("offer-3"));
  assert.equal(book.offers[1].offer.offerId, id("offer-2"));
});

test("rejects a mutated beneficiary even when the original signature is valid", async () => {
  const valid = await envelope(solvers[0], 1, 10_000, "relay-a");
  const mutated = { ...valid, offer: { ...valid.offer, beneficiary: "0x7777777777777777777777777777777777777777" } };
  const second = await envelope(solvers[1], 2, 10_100, "relay-b");

  assert.throws(
    () => buildReceivedQuoteBook({ request, envelopes: [mutated, second], now: NOW, policy }),
    /not enough independent valid solver offers/,
  );
});

test("retains only one bounded offer per solver", async () => {
  const book = buildReceivedQuoteBook({
    request,
    envelopes: [
      await envelope(solvers[0], 1, 10_100, "relay-a"),
      await envelope(solvers[0], 2, 10_000, "relay-b"),
      await envelope(solvers[1], 3, 10_200, "direct-b"),
    ],
    now: NOW,
    policy,
  });
  assert.equal(book.solverCount, 2);
  assert.equal(book.offers[0].offer.offerId, id("offer-2"));
  assert.match(book.rejected.map((item) => item.reasons.join(" ")).join("; "), /best valid offer per solver/);
});

test("requires an explicit selection from the committed received set", async () => {
  const book = buildReceivedQuoteBook({
    request,
    envelopes: [
      await envelope(solvers[0], 1, 10_000, "relay-a"),
      await envelope(solvers[1], 2, 10_100, "relay-b"),
    ],
    now: NOW,
    policy,
  });
  const selection = selectReceivedQuote(book, id("offer-1"));
  assert.equal(selection.requiresExactUserAuthorization, true);
  assert.equal(selection.receiptDigest, book.receiptDigest);
  assert.throws(() => selectReceivedQuote(book, id("suppressed-offer")), /not in the verified received set/);
});

test("never silently falls back to another solver", async () => {
  const book = buildReceivedQuoteBook({
    request,
    envelopes: [
      await envelope(solvers[0], 1, 10_000, "relay-a"),
      await envelope(solvers[1], 2, 10_100, "relay-b"),
    ],
    now: NOW,
    policy,
  });
  const first = selectReceivedQuote(book, id("offer-1"));
  const second = selectReceivedQuote(book, id("offer-2"));
  assert.deepEqual(fallbackAuthorization(first, second), {
    allowed: false,
    requiresFreshAuthorization: true,
    reason: "every fallback solver requires a new exact user authorization",
  });
});

test("bounds work before signature verification", async () => {
  const one = await envelope(solvers[0], 1, 10_000, "relay-a");
  assert.throws(
    () => buildReceivedQuoteBook({ request, envelopes: Array(17).fill(one), now: NOW, policy }),
    /bounded offer limit/,
  );
});

test("rejects untrusted relay labels instead of normalizing signed receipt data", async () => {
  const malicious = await envelope(solvers[0], 1, 10_000, "relay-a\nforged=true");
  const second = await envelope(solvers[1], 2, 10_100, "relay-b");
  assert.throws(
    () => buildReceivedQuoteBook({ request, envelopes: [malicious, second], now: NOW, policy }),
    /not enough independent valid solver offers/,
  );
});

test("rejects stale capacity epochs and routing costs above the signed request cap", async () => {
  const stale = await envelope(solvers[0], 1, 10_000, "relay-a");
  stale.offer.capacityEpoch = request.capacityEpoch - 1;
  stale.signature = await solvers[0].signTypedData(rfqDomain(request), RFQ_OFFER_TYPES, stale.offer);
  const expensive = await envelope(solvers[1], 2, 10_000, "relay-b");
  expensive.offer.maxRoutingFeeSats = request.maxRoutingFeeSats + 1n;
  expensive.signature = await solvers[1].signTypedData(rfqDomain(request), RFQ_OFFER_TYPES, expensive.offer);
  const valid = await envelope(solvers[2], 3, 10_100, "direct-c");

  assert.throws(
    () => buildReceivedQuoteBook({ request, envelopes: [stale, expensive, valid], now: NOW, policy }),
    /not enough independent valid solver offers/,
  );
});
