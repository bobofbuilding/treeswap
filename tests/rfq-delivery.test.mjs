import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { id, Wallet } from "ethers";
import {
  BLIND_RFQ_OFFER_TYPES,
  bindFinalizedSolverInvoice,
  blindRfqDomain,
  buildMultipathBlindQuoteBook,
  finalizeSelectedBlindQuote,
  selectBlindQuote,
  validateBlindSolverOffer,
  verifiedFinalizedExecutableQuote,
} from "../lib/blind-rfq.mjs";
import { buildBlindPricingRequest } from "../lib/privacy.mjs";
import {
  EXECUTABLE_RFQ_OFFER_TYPES,
  ZERO_BYTES32,
  bindSelectedSolverInvoice,
  buildExecutableQuoteBook,
  rfqDomain,
  validateExecutableSolverOffer,
} from "../lib/rfq.mjs";
import {
  RfqDeliveryError,
  buildSignedRfqDeliveryResponse,
  collectVerifiedRfqDeliveries,
  rfqDeliveryPayloadDigest,
  rfqDeliveryResponseDigest,
  verifiedRfqDeliveryCollection,
} from "../lib/rfq-delivery.mjs";
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
const LIGHTNING_TO_BIT = "0x1111111111111111111111111111111111111111";
const BIT_TO_LIGHTNING = "0x2222222222222222222222222222222222222222";
const LIGHTNING_TO_BIT_CODE_HASH = id("delivery-lightning-to-bit-runtime");
const BIT_TO_LIGHTNING_CODE_HASH = id("delivery-bit-to-lightning-runtime");
const solvers = [new Wallet(`0x${"31".repeat(32)}`), new Wallet(`0x${"32".repeat(32)}`)];
const endpointKeys = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
const relayKeys = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
const privateRequest = {
  requestId: id("private-settlement-request"),
  direction: "lightning-to-bit",
  chainId: 1,
  verifyingContract: LIGHTNING_TO_BIT,
  user: "0x3333333333333333333333333333333333333333",
  beneficiary: "0x4444444444444444444444444444444444444444",
  paymentHash: ZERO_BYTES32,
  invoiceDigest: ZERO_BYTES32,
  nonce: 9n,
  expiresAt: NOW + 120,
  exactBitOutputWei: 100n * BIT,
  exactLightningOutputSats: 0n,
  maxRoutingFeeSats: 20n,
  maxFeeBps: 100n,
};
const pricing = buildBlindPricingRequest({
  ...privateRequest,
  pricingId: id("unlinkable-public-pricing-request"),
  capacityEpoch: 1,
});
const quotePolicy = {
  maxSourceLength: 64,
  maxClockSkewSeconds: 5,
  maxQuoteTtlSeconds: 120,
  maxOffersPerRequest: 16,
  minimumIndependentSolvers: 2,
};
const blindPolicy = {
  chainId: "1",
  lightningToBitContract: LIGHTNING_TO_BIT,
  bitToLightningContract: BIT_TO_LIGHTNING,
  lightningToBitContractCodeHash: LIGHTNING_TO_BIT_CODE_HASH,
  bitToLightningContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
  maxClockSkewSeconds: 5,
  maxOffersPerRequest: 16,
  maxQuoteTtlSeconds: 120,
  minimumIndependentSolvers: 2,
};
const deliveryPolicy = {
  maxClockSkewSeconds: 5,
  maxOffersPerPath: 8,
  maxPaths: 8,
  maxResponseTtlSeconds: 15,
  minimumDirectSolverPaths: 2,
  minimumRelayPaths: 2,
};
const capabilityPolicy = {
  chainId: "1",
  lightningToBitContract: LIGHTNING_TO_BIT,
  bitToLightningContract: BIT_TO_LIGHTNING,
  lightningToBitContractCodeHash: LIGHTNING_TO_BIT_CODE_HASH,
  bitToLightningContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
  maxCapabilityTtlSeconds: 120,
  maxCapacityObservationAgeSeconds: 30,
  maxClockSkewSeconds: 5,
};

function pem(keys) {
  return keys.publicKey.export({ format: "pem", type: "spki" }).toString();
}

async function capability(index) {
  const origin = `https://direct-${index + 1}.example`;
  const endpointPublicKey = pem(endpointKeys[index]);
  const nodePubkey = `02${String(index + 1).padStart(2, "0").repeat(32)}`;
  const claims = {
    capabilityId: id(`delivery-capability-${index}`),
    direction: id("lightning-to-bit"),
    solver: solvers[index].address,
    lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(nodePubkey),
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    endpointOriginDigest: solverEndpointOriginDigest(origin),
    availableBitWei: String(200n * BIT),
    availableLightningSats: "250000",
    capacityEpoch: String(index + 10),
    issuedAt: NOW,
    expiresAt: NOW + 90,
  };
  const declaration = {
    ...claims,
    proofChallenge: solverCapabilityClaimsDigest(claims, {
      chainId: capabilityPolicy.chainId,
      verifyingContract: LIGHTNING_TO_BIT,
    }),
  };
  const proofMessage = solverCapabilityProofMessage(declaration.proofChallenge);
  const result = await verifySolverCapability({
    envelope: {
      declaration,
      endpointOrigin: origin,
      endpointPublicKey,
      endpointSignature: sign(null, proofMessage, endpointKeys[index].privateKey).toString("base64"),
      evmSignature: await solvers[index].signTypedData(
        solverCapabilityDomain({ chainId: capabilityPolicy.chainId, verifyingContract: LIGHTNING_TO_BIT }),
        SOLVER_CAPABILITY_TYPES,
        declaration,
      ),
      lightningNodePubkey: nodePubkey,
      lightningSignature: "y".repeat(104),
    },
    now: NOW,
    policy: capabilityPolicy,
    verifyLightningNodeSignature: async () => ({ valid: true, pubkey: nodePubkey }),
    readVerifiedBitInventory: async () => ({
      solverId: solvers[index].address,
      availableBitWei: String(200n * BIT),
      observedAt: NOW,
    }),
    readVerifiedLightningCapacity: async () => ({
      nodePubkey,
      availableLightningSats: "250000",
      capacityEpoch: String(index + 10),
      observedAt: NOW,
    }),
  });
  assert.equal(result.valid, true);
  return result;
}

async function blindEnvelope(index, lightningAmountSats) {
  const verification = await capability(index);
  const binding = verifiedSolverQuoteBinding(verification);
  const offer = {
    offerId: id(`delivery-offer-${index}`),
    pricingId: pricing.pricingId,
    direction: id(pricing.direction),
    solver: solvers[index].address,
    grossBitAmount: String(100n * BIT + 5n * 10n ** 17n),
    feeBitAmount: String(5n * 10n ** 17n),
    lightningAmountSats: String(lightningAmountSats),
    maxRoutingFeeSats: "10",
    expiresAt: NOW + 60,
    capacityEpoch: binding.capacityEpoch,
    capabilityDigest: binding.capabilityDigest,
    capacitySnapshotDigest: binding.capacitySnapshotDigest,
    endpointPublicKeyDigest: binding.endpointPublicKeyDigest,
    settlementContractCodeHash: binding.settlementContractCodeHash,
    availableBitWei: binding.availableBitWei,
    availableLightningSats: binding.availableLightningSats,
  };
  return {
    verification,
    envelope: {
      offer,
      signature: await solvers[index].signTypedData(
        blindRfqDomain({ chainId: 1, verifyingContract: LIGHTNING_TO_BIT }),
        BLIND_RFQ_OFFER_TYPES,
        offer,
      ),
    },
  };
}

async function executableEnvelope(blind, index) {
  const offer = {
    offerId: blind.offerId,
    requestId: privateRequest.requestId,
    direction: id(privateRequest.direction),
    user: privateRequest.user,
    beneficiary: privateRequest.beneficiary,
    solver: solvers[index].address,
    grossBitAmount: blind.grossBitAmount,
    feeBitAmount: blind.feeBitAmount,
    lightningAmountSats: blind.lightningAmountSats,
    maxRoutingFeeSats: blind.maxRoutingFeeSats,
    paymentHash: id(`private-payment-${index}`),
    invoiceDigest: id(`private-invoice-${index}`),
    requestNonce: String(privateRequest.nonce),
    offerNonce: String(index + 1),
    expiresAt: blind.expiresAt,
    capacityEpoch: blind.capacityEpoch,
    capabilityDigest: blind.capabilityDigest,
    capacitySnapshotDigest: blind.capacitySnapshotDigest,
    endpointPublicKeyDigest: blind.endpointPublicKeyDigest,
    settlementContractCodeHash: blind.settlementContractCodeHash,
    availableBitWei: blind.availableBitWei,
    availableLightningSats: blind.availableLightningSats,
  };
  return {
    offer,
    signature: await solvers[index].signTypedData(
      rfqDomain(privateRequest),
      EXECUTABLE_RFQ_OFFER_TYPES,
      offer,
    ),
  };
}

function pathPlan(verifications, { includeThirdRelay = false } = {}) {
  const paths = [
    {
      kind: "relay",
      pathId: "relay-a",
      endpointOrigin: "https://relay-a.example",
      publicKey: pem(relayKeys[0]),
      operatorCommitment: id("relay-operator-a"),
    },
    {
      kind: "relay",
      pathId: "relay-b",
      endpointOrigin: "https://relay-b.example",
      publicKey: pem(relayKeys[1]),
      operatorCommitment: id("relay-operator-b"),
    },
    {
      kind: "direct-solver",
      pathId: "direct-a",
      endpointOrigin: "https://direct-1.example",
      publicKey: pem(endpointKeys[0]),
      operatorCommitment: id("solver-operator-a"),
      solverId: solvers[0].address,
      capabilityVerification: verifications[0],
    },
    {
      kind: "direct-solver",
      pathId: "direct-b",
      endpointOrigin: "https://direct-2.example",
      publicKey: pem(endpointKeys[1]),
      operatorCommitment: id("solver-operator-b"),
      solverId: solvers[1].address,
      capabilityVerification: verifications[1],
    },
  ];
  if (includeThirdRelay) paths.splice(2, 0, {
    kind: "relay",
    pathId: "relay-c",
    endpointOrigin: "https://relay-c.example",
    publicKey: pem(relayKeys[2]),
    operatorCommitment: id("relay-operator-c"),
  });
  return paths;
}

function responseKey(pathId) {
  if (pathId === "relay-a") return relayKeys[0].privateKey;
  if (pathId === "relay-b") return relayKeys[1].privateKey;
  if (pathId === "relay-c") return relayKeys[2].privateKey;
  if (pathId === "direct-a") return endpointKeys[0].privateKey;
  if (pathId === "direct-b") return endpointKeys[1].privateKey;
  throw new Error("unknown test path");
}

function jsonResponse(value, options = {}) {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "application/json", ...options.headers },
  });
}

async function fixture({ includeThirdRelay = false } = {}) {
  const offers = [await blindEnvelope(0, 10_000), await blindEnvelope(1, 10_100)];
  const verifications = offers.map((item) => item.verification);
  const paths = pathPlan(verifications, { includeThirdRelay });
  const responder = async (_url, options, pathId) => {
    const wireRequest = JSON.parse(options.body);
    assert.deepEqual(wireRequest.rfq, pricing);
    assert.equal(wireRequest.requestDigest, rfqDeliveryPayloadDigest(pricing));
    const delivered = pathId === "direct-a" ? [offers[0].envelope]
      : pathId === "direct-b" ? [offers[1].envelope]
        : offers.map((item) => item.envelope);
    const response = buildSignedRfqDeliveryResponse({
      request: wireRequest,
      envelopes: delivered,
      servedAt: NOW,
      expiresAt: NOW + 10,
      privateKey: responseKey(pathId),
    });
    const publicWire = JSON.stringify({ request: wireRequest, response }).toLowerCase();
    for (const secret of [
      privateRequest.requestId,
      privateRequest.user,
      privateRequest.beneficiary,
      id("private-payment-0"),
      id("private-invoice-0"),
    ]) assert.doesNotMatch(publicWire, new RegExp(secret.slice(2).toLowerCase()));
    return jsonResponse(response);
  };
  return { offers, verifications, paths, responder };
}

async function collect(options = {}) {
  const data = await fixture(options);
  const collection = await collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 7),
  });
  return { ...data, collection };
}

test("authenticates blind relay competition before private selected-solver finalization", async () => {
  const { collection, verifications } = await collect();
  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: verifications,
    now: NOW,
    policy: blindPolicy,
  });
  assert.equal(book.deliveryAuthenticated, true);
  assert.equal(book.solverCount, 2);
  assert.equal(book.relayOfferPathCount, 2);
  assert.equal(book.directSolverOfferPathCount, 2);
  assert.equal(book.offers.length, 2);
  const selection = selectBlindQuote(book, id("delivery-offer-0"));
  assert.equal(selection.requiresPrivatePeerDisclosure, true);
  const executable = await executableEnvelope(selection.selected.offer, 0);
  const finalized = finalizeSelectedBlindQuote({
    request: privateRequest,
    selection,
    envelope: executable,
    capabilityVerification: verifications[0],
    now: NOW,
    quotePolicy,
  });
  assert.equal(verifiedFinalizedExecutableQuote(finalized), finalized);
  const intent = bindFinalizedSolverInvoice(privateRequest, finalized);
  assert.equal(intent.paymentHash, id("private-payment-0"));
  assert.equal(intent.selectedSolver, solvers[0].address);
  assert.equal(intent.receivedSetDigest, book.receiptDigest);
  assert.notEqual(intent.pricingId, intent.requestId);
});

test("keeps a flat executable list and copied finalization non-authorizing", async () => {
  const { offers, verifications } = await collect();
  const executable = await Promise.all(offers.map((item, index) => executableEnvelope(item.envelope.offer, index)));
  const flat = buildExecutableQuoteBook({
    request: privateRequest,
    envelopes: executable.map((envelope, index) => ({
      source: `claimed-source-${index}`,
      receivedAt: NOW,
      ...envelope,
    })),
    capabilityVerifications: verifications,
    now: NOW,
    policy: quotePolicy,
  });
  assert.equal(flat.deliveryAuthenticated, false);
  assert.throws(() => bindSelectedSolverInvoice(privateRequest, flat, id("delivery-offer-0")), /selected-offer finalization/);
  assert.throws(
    () => verifiedFinalizedExecutableQuote({ requestId: privateRequest.requestId }),
    /selected blind-offer finalization/,
  );
});

test("rejects an RFQ payload mismatch before transport", async () => {
  const data = await fixture();
  let requests = 0;
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: { ...pricing, maxFeeBps: "999" },
    policy: deliveryPolicy,
    requestImpl: async () => { requests += 1; },
    nowSeconds: () => NOW,
  }), /does not match its request digest/);
  assert.equal(requests, 0);
});

test("rejects relay rewriting while retaining valid offers from two other relay paths", async () => {
  const data = await fixture({ includeThirdRelay: true });
  const baseResponder = data.responder;
  const responder = async (url, options, pathId) => {
    if (pathId !== "relay-a") return baseResponder(url, options, pathId);
    const changed = {
      ...data.offers[0].envelope,
      offer: { ...data.offers[0].envelope.offer, grossBitAmount: String(101n * BIT) },
    };
    return jsonResponse(buildSignedRfqDeliveryResponse({
      request: JSON.parse(options.body),
      envelopes: [changed],
      servedAt: NOW,
      expiresAt: NOW + 10,
      privateKey: relayKeys[0].privateKey,
    }));
  };
  const collection = await collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 8),
  });
  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: data.verifications,
    now: NOW,
    policy: blindPolicy,
  });
  assert.equal(book.relayOfferPathCount, 2);
  assert.match(book.rejected.flatMap((item) => item.reasons).join("; "), /signature is invalid|exact BIT output changed/);
});

test("rejects private or executable fields at the public delivery boundary", async () => {
  const data = await fixture();
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async (url, options, pathId) => {
      if (pathId !== "relay-b") return data.responder(url, options, pathId);
      const leaked = {
        ...data.offers[0].envelope,
        offer: { ...data.offers[0].envelope.offer, paymentHash: id("private-field-on-public-path") },
      };
      const request = JSON.parse(options.body);
      const unsigned = {
        schema: "treeswap.rfq-delivery-response.v1",
        request,
        envelopes: [leaked],
        servedAt: NOW,
        expiresAt: NOW + 10,
      };
      const digest = rfqDeliveryResponseDigest(unsigned);
      const signature = sign(
        null,
        Buffer.from(`TreeSwap RFQ delivery response v1\n${digest}\n`, "utf8"),
        relayKeys[1].privateKey,
      ).toString("base64");
      return jsonResponse({ ...unsigned, signature });
    },
    nowSeconds: () => NOW,
  }), (error) => error instanceof RfqDeliveryError && error.code === "INSUFFICIENT_PATH_DIVERSITY");
});

test("does not count an authenticated empty path as valid quote delivery", async () => {
  const data = await fixture();
  const baseResponder = data.responder;
  const responder = async (url, options, pathId) => {
    if (pathId !== "direct-b") return baseResponder(url, options, pathId);
    return jsonResponse(buildSignedRfqDeliveryResponse({
      request: JSON.parse(options.body),
      envelopes: [],
      servedAt: NOW,
      expiresAt: NOW + 10,
      privateKey: endpointKeys[1].privateKey,
    }));
  };
  const collection = await collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: responder,
    nowSeconds: () => NOW,
  });
  assert.equal(collection.directSolverCount, 2);
  assert.throws(() => buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: data.verifications,
    now: NOW,
    policy: blindPolicy,
  }), /not enough authenticated delivery paths supplied valid blind offers/);
});

test("requires two authenticated relay responses but tolerates a failed extra path", async () => {
  const data = await fixture({ includeThirdRelay: true });
  const baseResponder = data.responder;
  const responder = async (url, options, pathId) => {
    if (pathId === "relay-c") throw new Error("private upstream details");
    return baseResponder(url, options, pathId);
  };
  const collection = await collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: responder,
    nowSeconds: () => NOW,
  });
  assert.deepEqual(collection.failures, [{ pathId: "relay-c", kind: "relay", code: "TRANSPORT_FAILED" }]);
  assert.doesNotMatch(JSON.stringify(collection), /private upstream details/);

  const exactlyFour = await fixture();
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths: exactlyFour.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async (url, options, pathId) => {
      if (pathId === "relay-b") throw new Error("down");
      return exactlyFour.responder(url, options, pathId);
    },
    nowSeconds: () => NOW,
  }), (error) => error instanceof RfqDeliveryError && error.code === "INSUFFICIENT_PATH_DIVERSITY");
});

test("rejects direct solver substitution and copied capability provenance", async () => {
  const data = await fixture();
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async (url, options, pathId) => {
      if (pathId !== "direct-a") return data.responder(url, options, pathId);
      return jsonResponse(buildSignedRfqDeliveryResponse({
        request: JSON.parse(options.body),
        envelopes: [data.offers[1].envelope],
        servedAt: NOW,
        expiresAt: NOW + 10,
        privateKey: endpointKeys[0].privateKey,
      }));
    },
    nowSeconds: () => NOW,
  }), (error) => error.code === "INSUFFICIENT_PATH_DIVERSITY");

  const copied = pathPlan(data.verifications);
  copied[2] = { ...copied[2], capabilityVerification: { ...data.verifications[0] } };
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths: copied,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
  }), /locally verified capability/);
});

test("binds each direct response to the exact capability configured for that path", async () => {
  const data = await fixture();
  const changedOffer = {
    ...data.offers[0].envelope.offer,
    capabilityDigest: id("unconfigured-refreshed-capability"),
  };
  const changedEnvelope = {
    offer: changedOffer,
    signature: await solvers[0].signTypedData(
      blindRfqDomain({ chainId: 1, verifyingContract: LIGHTNING_TO_BIT }),
      BLIND_RFQ_OFFER_TYPES,
      changedOffer,
    ),
  };
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async (url, options, pathId) => {
      if (pathId !== "direct-a") return data.responder(url, options, pathId);
      return jsonResponse(buildSignedRfqDeliveryResponse({
        request: JSON.parse(options.body),
        envelopes: [changedEnvelope],
        servedAt: NOW,
        expiresAt: NOW + 10,
        privateKey: endpointKeys[0].privateKey,
      }));
    },
    nowSeconds: () => NOW,
  }), (error) => error instanceof RfqDeliveryError && error.code === "INSUFFICIENT_PATH_DIVERSITY");
});

test("rejects duplicate path identity claims before network access", async () => {
  const data = await fixture();
  let requests = 0;
  for (const mutation of [
    (paths) => { paths[1] = { ...paths[1], operatorCommitment: paths[0].operatorCommitment }; },
    (paths) => { paths[1] = { ...paths[1], endpointOrigin: paths[0].endpointOrigin }; },
    (paths) => { paths[1] = { ...paths[1], publicKey: paths[0].publicKey }; },
  ]) {
    const paths = pathPlan(data.verifications);
    mutation(paths);
    await assert.rejects(collectVerifiedRfqDeliveries({
      paths,
      requestId: pricing.pricingId,
      requestDigest: rfqDeliveryPayloadDigest(pricing),
      rfq: pricing,
      policy: deliveryPolicy,
      requestImpl: async () => { requests += 1; },
      nowSeconds: () => NOW,
    }), /duplicate/);
  }
  assert.equal(requests, 0);
});

test("rejects responder-controlled receipt metadata and request rebinding", async () => {
  const data = await fixture();
  for (const mode of ["extra-metadata", "changed-request"]) {
    await assert.rejects(collectVerifiedRfqDeliveries({
      paths: data.paths,
      requestId: pricing.pricingId,
      requestDigest: rfqDeliveryPayloadDigest(pricing),
      rfq: pricing,
      policy: deliveryPolicy,
      requestImpl: async (url, options, pathId) => {
        if (pathId !== "relay-b") return data.responder(url, options, pathId);
        const response = buildSignedRfqDeliveryResponse({
          request: JSON.parse(options.body),
          envelopes: data.offers.map((item) => item.envelope),
          servedAt: NOW,
          expiresAt: NOW + 10,
          privateKey: relayKeys[1].privateKey,
        });
        if (mode === "extra-metadata") return jsonResponse({ ...response, receivedAt: 1, source: "forged" });
        return jsonResponse({
          ...response,
          request: { ...response.request, requestDigest: id("other-pricing") },
        });
      },
      nowSeconds: () => NOW,
    }), (error) => error.code === "INSUFFICIENT_PATH_DIVERSITY");
  }
});

test("rejects private endpoints and weakened diversity policy before transport", async () => {
  const data = await fixture();
  let requests = 0;
  const paths = pathPlan(data.verifications);
  paths[0] = { ...paths[0], endpointOrigin: "https://127.0.0.1" };
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async () => { requests += 1; },
    nowSeconds: () => NOW,
  }), /not public/);
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: { ...deliveryPolicy, minimumRelayPaths: 1 },
    requestImpl: async () => { requests += 1; },
    nowSeconds: () => NOW,
  }), /diversity minimum/);
  assert.equal(requests, 0);
});

test("rejects post-selection repricing, solver change, and request linkage", async () => {
  const { collection, offers, verifications } = await collect();
  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: verifications,
    now: NOW,
    policy: blindPolicy,
  });
  const selection = selectBlindQuote(book, offers[0].envelope.offer.offerId);
  const valid = await executableEnvelope(selection.selected.offer, 0);
  for (const [field, value, reason] of [
    ["grossBitAmount", String(101n * BIT), /grossBitAmount|exact BIT output/],
    ["solver", solvers[1].address, /invalid|solver/],
    ["capabilityDigest", id("changed-capability"), /invalid|capability/],
  ]) {
    const changedOffer = { ...valid.offer, [field]: value };
    const changed = {
      offer: changedOffer,
      signature: await solvers[field === "solver" ? 1 : 0].signTypedData(
        rfqDomain(privateRequest),
        EXECUTABLE_RFQ_OFFER_TYPES,
        changedOffer,
      ),
    };
    assert.throws(() => finalizeSelectedBlindQuote({
      request: privateRequest,
      selection,
      envelope: changed,
      capabilityVerification: verifications[field === "solver" ? 1 : 0],
      now: NOW,
      quotePolicy,
    }), reason);
  }
  assert.throws(() => finalizeSelectedBlindQuote({
    request: { ...privateRequest, maxFeeBps: 99n },
    selection,
    envelope: valid,
    capabilityVerification: verifications[0],
    now: NOW,
    quotePolicy,
  }), /changed the blind price limits/);
  assert.throws(() => verifiedRfqDeliveryCollection({ ...collection }), /locally authenticated and complete/);
});

test("enforces the exact fee cap without basis-point rounding slack", async () => {
  const item = await blindEnvelope(0, 10_000);
  const exactOutput = privateRequest.exactBitOutputWei;
  const feeBitAmount = exactOutput / 99n + 1n;
  const grossBitAmount = exactOutput + feeBitAmount;
  const blindOffer = {
    ...item.envelope.offer,
    grossBitAmount: grossBitAmount.toString(),
    feeBitAmount: feeBitAmount.toString(),
  };
  const blind = {
    offer: blindOffer,
    signature: await solvers[0].signTypedData(
      blindRfqDomain({ chainId: 1, verifyingContract: LIGHTNING_TO_BIT }),
      BLIND_RFQ_OFFER_TYPES,
      blindOffer,
    ),
  };
  const blindResult = validateBlindSolverOffer({
    pricing,
    envelope: blind,
    capabilityVerification: item.verification,
    now: NOW,
    policy: blindPolicy,
  });
  assert.equal(blindResult.valid, false);
  assert.match(blindResult.reasons.join("; "), /fee exceeds the user cap/);

  const full = await executableEnvelope(blindOffer, 0);
  const fullResult = validateExecutableSolverOffer({
    request: privateRequest,
    envelope: { source: "selected-private-endpoint", receivedAt: NOW, ...full },
    capabilityVerification: item.verification,
    now: NOW,
    policy: quotePolicy,
  });
  assert.equal(fullResult.valid, false);
  assert.match(fullResult.reasons.join("; "), /fee exceeds the user cap/);
});
