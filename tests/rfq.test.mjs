import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  EXECUTABLE_RFQ_OFFER_TYPES,
  RFQ_OFFER_TYPES,
  ZERO_BYTES32,
  bindSelectedSolverInvoice,
  buildExecutableQuoteBook,
  buildReceivedQuoteBook,
  fallbackAuthorization,
  rfqDomain,
  selectReceivedQuote,
  validateExecutableSolverOffer,
  validateSolverOffer,
} from "../lib/rfq.mjs";
import {
  SOLVER_CAPABILITY_TYPES,
  solverCapabilityClaimsDigest,
  solverCapabilityDomain,
  solverCapabilityProofMessage,
  solverEndpointOriginDigest,
  solverEndpointPublicKeyDigest,
  solverLightningNodePubkeyDigest,
  verifiedSolverQuoteBinding,
  verifySolverCapability,
} from "../lib/solver-capability.mjs";

const NOW = 2_000_000_000;
const BIT = 10n ** 18n;
const LIGHTNING_TO_BIT_CODE_HASH = id("rfq-lightning-to-bit-runtime");
const BIT_TO_LIGHTNING_CODE_HASH = id("rfq-bit-to-lightning-runtime");
const BIT_TO_LIGHTNING_CONTRACT = "0x7777777777777777777777777777777777777777";
const solvers = [new Wallet(`0x${"11".repeat(32)}`), new Wallet(`0x${"22".repeat(32)}`), new Wallet(`0x${"33".repeat(32)}`)];
const request = {
  requestId: id("request-1"),
  direction: "lightning-to-bit",
  chainId: 1,
  verifyingContract: "0x4444444444444444444444444444444444444444",
  user: "0x5555555555555555555555555555555555555555",
  beneficiary: "0x6666666666666666666666666666666666666666",
  paymentHash: ZERO_BYTES32,
  invoiceDigest: ZERO_BYTES32,
  nonce: 7n,
  expiresAt: NOW + 120,
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
    paymentHash: id(`payment-hash-${index}`),
    invoiceDigest: id(`invoice-${index}`),
    requestNonce: request.nonce,
    offerNonce: BigInt(index),
    expiresAt: NOW + 60,
    capacityEpoch: 42,
  };
}

async function executableCapability(solver, index, direction = "lightning-to-bit") {
  const endpointKeys = generateKeyPairSync("ed25519");
  const endpointPublicKey = endpointKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const endpointOrigin = `https://solver-${index}.example`;
  const lightningNodePubkey = `02${index.toString(16).padStart(2, "0").repeat(32)}`;
  const verifyingContract = direction === "lightning-to-bit" ? request.verifyingContract : BIT_TO_LIGHTNING_CONTRACT;
  const availableBitWei = direction === "lightning-to-bit" ? String(200n * BIT) : "0";
  const availableLightningSats = "250000";
  const capacityEpoch = 40 + index;
  const capabilityPolicy = {
    chainId: "1",
    lightningToBitContract: request.verifyingContract,
    bitToLightningContract: BIT_TO_LIGHTNING_CONTRACT,
    lightningToBitContractCodeHash: LIGHTNING_TO_BIT_CODE_HASH,
    bitToLightningContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
    maxCapabilityTtlSeconds: 120,
    maxCapacityObservationAgeSeconds: 30,
    maxClockSkewSeconds: 5,
  };
  const claims = {
    capabilityId: id(`rfq-capability-${direction}-${index}`),
    direction: id(direction),
    solver: solver.address,
    lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(lightningNodePubkey),
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    endpointOriginDigest: solverEndpointOriginDigest(endpointOrigin),
    availableBitWei,
    availableLightningSats,
    capacityEpoch: String(capacityEpoch),
    issuedAt: NOW,
    expiresAt: NOW + 90,
  };
  const declaration = {
    ...claims,
    proofChallenge: solverCapabilityClaimsDigest(claims, {
      chainId: capabilityPolicy.chainId,
      verifyingContract,
    }),
  };
  const proofMessage = solverCapabilityProofMessage(declaration.proofChallenge);
  const envelope = {
    declaration,
    endpointOrigin,
    endpointPublicKey,
    endpointSignature: sign(null, proofMessage, endpointKeys.privateKey).toString("base64"),
    evmSignature: await solver.signTypedData(
      solverCapabilityDomain({ chainId: capabilityPolicy.chainId, verifyingContract }),
      SOLVER_CAPABILITY_TYPES,
      declaration,
    ),
    lightningNodePubkey,
    lightningSignature: "y".repeat(104),
  };
  const verification = await verifySolverCapability({
    envelope,
    now: NOW,
    policy: capabilityPolicy,
    verifyLightningNodeSignature: async () => ({ valid: true, pubkey: lightningNodePubkey }),
    readVerifiedBitInventory: async () => ({ availableBitWei, observedAt: NOW, solverId: solver.address }),
    readVerifiedLightningCapacity: async () => ({
      availableLightningSats,
      capacityEpoch: String(capacityEpoch),
      nodePubkey: lightningNodePubkey,
      observedAt: NOW,
    }),
  });
  assert.equal(verification.valid, true);
  return verification;
}

async function executableEnvelope(solver, index, lightningAmountSats, source, direction = "lightning-to-bit") {
  const verification = await executableCapability(solver, index, direction);
  const binding = verifiedSolverQuoteBinding(verification);
  const signedOffer = {
    ...offer(solver, index, lightningAmountSats),
    direction: id(direction),
    capabilityDigest: binding.capabilityDigest,
    capacitySnapshotDigest: binding.capacitySnapshotDigest,
    endpointPublicKeyDigest: binding.endpointPublicKeyDigest,
    settlementContractCodeHash: binding.settlementContractCodeHash,
    capacityEpoch: binding.capacityEpoch,
    availableBitWei: BigInt(binding.availableBitWei),
    availableLightningSats: BigInt(binding.availableLightningSats),
  };
  return {
    verification,
    envelope: {
      source,
      receivedAt: NOW,
      offer: signedOffer,
      signature: await solver.signTypedData(rfqDomain(request), EXECUTABLE_RFQ_OFFER_TYPES, signedOffer),
    },
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
  assert.equal(selection.executable, false);
  assert.equal(selection.receiptDigest, book.receiptDigest);
  assert.throws(
    () => bindSelectedSolverInvoice(request, book, id("offer-1")),
    /executable selection requires capability-bound/,
  );
  assert.throws(() => { book.offers[0].offer.paymentHash = id("post-verification-mutation"); }, /read only/);
  assert.throws(
    () => bindSelectedSolverInvoice({ ...request, maxFeeBps: 99n }, book, id("offer-1")),
    /request changed after quote verification/,
  );
  assert.throws(() => selectReceivedQuote(book, id("suppressed-offer")), /not in the verified received set/);
  assert.throws(() => selectReceivedQuote({ ...book }, id("offer-1")), /locally verified offers/);
  assert.throws(
    () => buildReceivedQuoteBook({ request: { ...request, hiddenFallback: true }, envelopes: [], now: NOW, policy }),
    /fields are not exact/,
  );
});

test("requires each Lightning-to-BIT solver to bind a distinct hold invoice", async () => {
  const first = await envelope(solvers[0], 1, 10_000, "relay-a");
  const copied = await envelope(solvers[1], 2, 10_100, "relay-b");
  copied.offer.paymentHash = first.offer.paymentHash;
  copied.offer.invoiceDigest = first.offer.invoiceDigest;
  copied.signature = await solvers[1].signTypedData(rfqDomain(request), RFQ_OFFER_TYPES, copied.offer);
  const third = await envelope(solvers[2], 3, 10_200, "direct-c");
  const book = buildReceivedQuoteBook({ request, envelopes: [first, copied, third], now: NOW, policy });
  assert.equal(book.solverCount, 2);
  assert.match(book.rejected[0].reasons.join("; "), /distinct hold invoices/);

  const prebound = { ...request, paymentHash: id("shared"), invoiceDigest: id("shared-invoice") };
  assert.throws(
    () => buildReceivedQuoteBook({ request: prebound, envelopes: [first, third], now: NOW, policy }),
    /not enough independent valid solver offers/,
  );
});

test("keeps one user invoice fixed across all BIT-to-Lightning solver offers", async () => {
  const userInvoiceRequest = {
    ...request,
    direction: "bit-to-lightning",
    paymentHash: id("user-invoice-payment"),
    invoiceDigest: id("user-invoice-digest"),
    exactBitOutputWei: 0n,
    exactLightningOutputSats: 10_000n,
  };
  async function userInvoiceEnvelope(solver, index, source, changedHash = null) {
    const signedOffer = {
      ...offer(solver, index, 10_000),
      direction: id(userInvoiceRequest.direction),
      paymentHash: changedHash ?? userInvoiceRequest.paymentHash,
      invoiceDigest: userInvoiceRequest.invoiceDigest,
      grossBitAmount: 101n * BIT,
      feeBitAmount: 1n * BIT,
    };
    return {
      source,
      receivedAt: NOW,
      offer: signedOffer,
      signature: await solver.signTypedData(rfqDomain(userInvoiceRequest), RFQ_OFFER_TYPES, signedOffer),
    };
  }
  const valid = await userInvoiceEnvelope(solvers[0], 10, "relay-a");
  const changed = await userInvoiceEnvelope(solvers[1], 11, "relay-b", id("substituted-payment"));
  const second = await userInvoiceEnvelope(solvers[2], 12, "direct-c");
  const book = buildReceivedQuoteBook({ request: userInvoiceRequest, envelopes: [valid, changed, second], now: NOW, policy });
  assert.equal(book.solverCount, 2);
  assert.match(book.rejected[0].reasons.join("; "), /payment hash changed/);
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
  assert.throws(
    () => buildReceivedQuoteBook({ request, envelopes: [], now: NOW, policy: { ...policy, maxOffersPerRequest: Number.NaN } }),
    /non-negative safe integer/,
  );
  assert.throws(
    () => buildReceivedQuoteBook({ request, envelopes: [], now: NOW, policy: { ...policy, minimumIndependentSolvers: 1 } }),
    /minimum is outside policy/,
  );
  const oversized = await envelope(solvers[0], 2, 10_000, "relay-a");
  oversized.offer.grossBitAmount = "9".repeat(10_000);
  const result = validateSolverOffer({ request, envelope: oversized, now: NOW, policy });
  assert.equal(result.valid, false);
  assert.match(result.reasons.join("; "), /canonical bounded unsigned integer/);
});

test("rejects untrusted relay labels instead of normalizing signed receipt data", async () => {
  const malicious = await envelope(solvers[0], 1, 10_000, "relay-a\nforged=true");
  const second = await envelope(solvers[1], 2, 10_100, "relay-b");
  assert.throws(
    () => buildReceivedQuoteBook({ request, envelopes: [malicious, second], now: NOW, policy }),
    /not enough independent valid solver offers/,
  );
});

test("rejects routing costs above the signed request cap", async () => {
  const expensive = await envelope(solvers[1], 2, 10_000, "relay-b");
  expensive.offer.maxRoutingFeeSats = request.maxRoutingFeeSats + 1n;
  expensive.signature = await solvers[1].signTypedData(rfqDomain(request), RFQ_OFFER_TYPES, expensive.offer);

  assert.throws(
    () => buildReceivedQuoteBook({ request, envelopes: [expensive], now: NOW, policy }),
    /not enough independent valid solver offers/,
  );
});

test("binds an executable selection to independently verified capability, inventory, endpoint, and code", async () => {
  const first = await executableEnvelope(solvers[0], 1, 10_000, "relay-a");
  const second = await executableEnvelope(solvers[1], 2, 10_100, "direct-b");
  const book = buildExecutableQuoteBook({
    request,
    envelopes: [first.envelope, second.envelope],
    capabilityVerifications: [first.verification, second.verification],
    now: NOW,
    policy,
  });
  assert.equal(book.executable, true);
  assert.equal(book.offers[0].offer.capacityEpoch, 41);
  assert.equal(book.offers[1].offer.capacityEpoch, 42);
  const selection = selectReceivedQuote(book, id("offer-1"));
  assert.equal(selection.executable, true);
  const selectedIntent = bindSelectedSolverInvoice(request, book, id("offer-1"));
  assert.equal(selectedIntent.paymentHash, id("payment-hash-1"));
  assert.equal(selectedIntent.invoiceDigest, id("invoice-1"));
  assert.equal(selectedIntent.selectedSolver, solvers[0].address);
  assert.equal(selectedIntent.capabilityDigest, first.verification.capabilityDigest);
  assert.equal(selectedIntent.capacitySnapshotDigest, first.verification.capacitySnapshotDigest);
  assert.equal(selectedIntent.endpointPublicKeyDigest, first.verification.binding.endpointPublicKeyDigest);
  assert.equal(selectedIntent.settlementContractCodeHash, LIGHTNING_TO_BIT_CODE_HASH);
  assert.equal(selectedIntent.capacityEpoch, 41);
});

test("rejects executable offer rebinding and forged capability provenance", async () => {
  const first = await executableEnvelope(solvers[0], 1, 10_000, "relay-a");
  const second = await executableEnvelope(solvers[1], 2, 10_100, "relay-b");
  const third = await executableEnvelope(solvers[2], 3, 10_200, "direct-c");
  assert.throws(
    () => buildExecutableQuoteBook({
      request,
      envelopes: [first.envelope, second.envelope],
      capabilityVerifications: [{ ...first.verification }, second.verification],
      now: NOW,
      policy,
    }),
    /locally verified capability/,
  );

  for (const [changedRequest, reason] of [
    [{ ...request, chainId: 2n }, /capability chain changed/],
    [{ ...request, verifyingContract: BIT_TO_LIGHTNING_CONTRACT }, /capability settlement contract changed/],
  ]) {
    const reboundEnvelope = {
      ...first.envelope,
      signature: await solvers[0].signTypedData(
        rfqDomain(changedRequest),
        EXECUTABLE_RFQ_OFFER_TYPES,
        first.envelope.offer,
      ),
    };
    const result = validateExecutableSolverOffer({
      request: changedRequest,
      envelope: reboundEnvelope,
      capabilityVerification: first.verification,
      now: NOW,
      policy,
    });
    assert.equal(result.valid, false);
    assert.match(result.reasons.join("; "), reason);
  }

  for (const [field, changed, reason] of [
    ["capabilityDigest", id("changed-capability"), /capability digest changed/],
    ["capacitySnapshotDigest", id("changed-snapshot"), /capacity snapshot digest changed/],
    ["endpointPublicKeyDigest", id("changed-endpoint"), /endpoint key changed/],
    ["settlementContractCodeHash", id("changed-runtime"), /contract version changed/],
    ["capacityEpoch", 999, /capacity declaration is stale/],
    ["availableBitWei", 199n * BIT, /BIT inventory snapshot changed/],
    ["availableLightningSats", 249_999n, /Lightning capacity snapshot changed/],
  ]) {
    const mutatedOffer = { ...first.envelope.offer, [field]: changed };
    const mutated = {
      ...first.envelope,
      offer: mutatedOffer,
      signature: await solvers[0].signTypedData(rfqDomain(request), EXECUTABLE_RFQ_OFFER_TYPES, mutatedOffer),
    };
    const book = buildExecutableQuoteBook({
      request,
      envelopes: [mutated, second.envelope, third.envelope],
      capabilityVerifications: [first.verification, second.verification, third.verification],
      now: NOW,
      policy,
    });
    assert.equal(book.solverCount, 2);
    assert.match(book.rejected[0].reasons.join("; "), reason);
  }
});
