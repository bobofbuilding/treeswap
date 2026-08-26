import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { id, TypedDataEncoder, Wallet } from "ethers";
import {
  BLIND_RFQ_OFFER_TYPES,
  USER_EXECUTION_AUTHORIZATION_TYPES,
  USER_SELECTION_AUTHORIZATION_TYPES,
  activeBlindQuoteReservationBinding,
  authorizeFinalizedBlindQuote,
  bindFinalizedSolverInvoice,
  blindRfqDomain,
  buildBlindQuoteSelectionAuthorization,
  buildFinalizedQuoteUserAuthorization,
  buildMultipathBlindQuoteBook,
  buildSelectedSolverDisclosure,
  finalizeSelectedBlindQuote,
  reserveSelectedBlindQuote,
  selectBlindQuote,
  validateBlindSolverOffer,
  verifyBlindQuoteSelectionAuthorization,
  verifiedFinalizedExecutableQuote,
} from "../lib/blind-rfq.mjs";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import { invoiceDigest } from "../lib/lnd-rest-client.mjs";
import {
  buildExecutableVenuePriceSignal,
  executableVenueObservationTypedData,
} from "../lib/executable-venue-price-signal.mjs";
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
  buildRfqDeliveryRequest,
  buildSignedRfqDeliveryResponse,
  collectVerifiedRfqDeliveries,
  queryVerifiedRfqDelivery,
  rfqDeliveryPayloadDigest,
  rfqDeliveryResponseDigest,
  verifiedRfqDeliveryCollection,
} from "../lib/rfq-delivery.mjs";
import {
  bitRiskPolicyDigest,
  buildBitRiskAttestation,
  evaluateBitRisk,
} from "../lib/risk-policy.mjs";
import {
  SOLVER_CAPABILITY_TYPES,
  solverCapabilityClaimsDigest,
  solverCapabilityDomain,
  solverCapabilityProofMessage,
  solverEndpointOriginDigest,
  solverEndpointPublicKeyDigest,
  solverLightningNodePubkeyDigest,
  verifiedSolverCapacityRecord,
  verifiedSolverQuoteBinding,
  verifySolverCapability,
} from "../lib/solver-capability.mjs";

const NOW = 2_000_000_000;
const BIT = 10n ** 18n;
const LIGHTNING_TO_BIT = "0x1111111111111111111111111111111111111111";
const BIT_TO_LIGHTNING = "0x2222222222222222222222222222222222222222";
const LIGHTNING_TO_BIT_CODE_HASH = id("delivery-lightning-to-bit-runtime");
const BIT_TO_LIGHTNING_CODE_HASH = id("delivery-bit-to-lightning-runtime");
const solvers = [
  new Wallet(`0x${"31".repeat(32)}`),
  new Wallet(`0x${"32".repeat(32)}`),
  new Wallet(`0x${"34".repeat(32)}`),
];
const user = new Wallet(`0x${"33".repeat(32)}`);
const marketSigners = [
  new Wallet(`0x${"41".repeat(32)}`),
  new Wallet(`0x${"42".repeat(32)}`),
  new Wallet(`0x${"43".repeat(32)}`),
];
const marketSourcePolicies = marketSigners.map((signer, index) => Object.freeze({
  chainId: 1,
  verifyingContract: "0x57A447E4d5e18A9423408C365963A73F08B9d18C",
  source: `rfq-market-${index + 1}`,
  venueId: id(`rfq-market-venue-${index + 1}`).toLowerCase(),
  controlDomain: id(`rfq-market-control-${index + 1}`).toLowerCase(),
  operatorOrganization: id(`rfq-market-operator-${index + 1}`).toLowerCase(),
  signer: signer.address,
  maximumValiditySeconds: 120,
}));
const marketRiskPolicy = Object.freeze({
  chainId: 1,
  proxyAddress: "0x57A447E4d5e18A9423408C365963A73F08B9d18C",
  expectedImplementation: "0x1111111111111111111111111111111111111111",
  expectedProxyCodeHash: `0x${"aa".repeat(32)}`,
  expectedImplementationCodeHash: `0x${"bb".repeat(32)}`,
  decimals: 18,
  referenceSatsPerBit: 100,
  maxSnapshotAgeSeconds: 120,
  maxFinalityLagBlocks: 80,
  maxPriceAgeSeconds: 120,
  minPriceSources: 3,
  maxSignalSpreadBps: 100,
  maxMarketDeviationBps: 500,
  maxSwapBitWei: 10_000n * BIT,
  maxEpochBitWei: 100_000n * BIT,
  baseFeeBpsLightningToBit: 18,
  baseFeeBpsBitToLightning: 72,
  maxFeeBps: 300,
  reserveFloorBps: 2_500,
  scarcityStartsBps: 6_000,
  allowedPriceSourcePolicyDigests: marketSourcePolicies.map((sourcePolicy) => (
    executableVenueObservationTypedData({
      sourcePolicy,
      observation: {
        source: sourcePolicy.source,
        direction: "lightning-to-bit",
        observedAt: NOW,
        validUntil: NOW + 90,
        priceMsatPerBit: 100_000n,
        executableDepthSats: 1_000_000n,
        executableDepthBitWei: 10_000n * BIT,
        quoteCommitment: id(`risk-policy-source:${sourcePolicy.source}`).toLowerCase(),
      },
    }).value.sourcePolicyDigest
  )),
});
const endpointKeys = [
  generateKeyPairSync("ed25519"),
  generateKeyPairSync("ed25519"),
  generateKeyPairSync("ed25519"),
];
const relayKeys = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
const privateRequest = {
  requestId: id("private-settlement-request"),
  direction: "lightning-to-bit",
  chainId: 1,
  verifyingContract: LIGHTNING_TO_BIT,
  user: user.address,
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
const userInvoice = "lnbc250u1treeswapprivate";
const bitToLightningRequest = {
  requestId: id("private-bit-to-lightning-request"),
  direction: "bit-to-lightning",
  chainId: 1,
  verifyingContract: BIT_TO_LIGHTNING,
  user: user.address,
  beneficiary: "0x5555555555555555555555555555555555555555",
  paymentHash: id("private-bit-to-lightning-payment"),
  invoiceDigest: invoiceDigest(userInvoice),
  nonce: 11n,
  expiresAt: NOW + 120,
  exactBitOutputWei: 0n,
  exactLightningOutputSats: 25_000n,
  maxRoutingFeeSats: 20n,
  maxFeeBps: 100n,
};
const bitToLightningPricing = buildBlindPricingRequest({
  ...bitToLightningRequest,
  pricingId: id("unlinkable-bit-to-lightning-pricing-request"),
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
  marketRiskPolicyDigest: bitRiskPolicyDigest(marketRiskPolicy),
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
const admissionPolicy = {
  minimumNotionalSats: "1000",
  maxRfqTtlSeconds: 120,
  maxActiveRequestsPerIdentity: 10,
  maxRequestsPerWindow: 10,
  maxCancellationsPerWindow: 10,
  quotaWindowSeconds: 60,
  maxFirmQuoteTtlSeconds: 120,
  maxCapacityAgeSeconds: 30,
  maxActiveFirmQuotesPerSolver: 4,
  maxConsecutiveFailures: 2,
  minimumReliabilitySample: "4",
  minimumReliabilityBps: "9000",
  minimumCompletedFillsForEstablished: "3",
  unknownSolverMaxBitToLightningSats: "100000",
  establishedSolverMaxBitToLightningSats: "100000",
  maxGlobalBitToLightningInFlightSats: "500000",
};

function pem(keys) {
  return keys.publicKey.export({ format: "pem", type: "spki" }).toString();
}

async function capability(index, { direction = "lightning-to-bit" } = {}) {
  const lightningToBit = direction === "lightning-to-bit";
  const verifyingContract = lightningToBit ? LIGHTNING_TO_BIT : BIT_TO_LIGHTNING;
  const origin = `https://direct-${index + 1}.example`;
  const endpointPublicKey = pem(endpointKeys[index]);
  const nodePubkey = `02${String(index + 1).padStart(2, "0").repeat(32)}`;
  const claims = {
    capabilityId: id(`delivery-capability-${direction}-${index}`),
    direction: id(direction),
    solver: solvers[index].address,
    lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(nodePubkey),
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    endpointOriginDigest: solverEndpointOriginDigest(origin),
    availableBitWei: lightningToBit ? String(200n * BIT) : "0",
    availableLightningSats: "250000",
    capacityEpoch: String(index + 10),
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
  const result = await verifySolverCapability({
    envelope: {
      declaration,
      endpointOrigin: origin,
      endpointPublicKey,
      endpointSignature: sign(null, proofMessage, endpointKeys[index].privateKey).toString("base64"),
      evmSignature: await solvers[index].signTypedData(
        solverCapabilityDomain({ chainId: capabilityPolicy.chainId, verifyingContract }),
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
      availableBitWei: lightningToBit ? String(200n * BIT) : "0",
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

async function blindEnvelope(index, lightningAmountSats, {
  pricingRequest = pricing,
  grossBitAmount = 100n * BIT + 5n * 10n ** 17n,
  feeBitAmount = 5n * 10n ** 17n,
} = {}) {
  const verification = await capability(index, { direction: pricingRequest.direction });
  const binding = verifiedSolverQuoteBinding(verification);
  const offer = {
    offerId: id(pricingRequest === pricing
      ? `delivery-offer-${index}`
      : `delivery-offer-${pricingRequest.direction}-${index}`),
    pricingId: pricingRequest.pricingId,
    direction: id(pricingRequest.direction),
    solver: solvers[index].address,
    grossBitAmount: String(grossBitAmount),
    feeBitAmount: String(feeBitAmount),
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
        blindRfqDomain({
          chainId: 1,
          verifyingContract: pricingRequest.direction === "lightning-to-bit"
            ? LIGHTNING_TO_BIT
            : BIT_TO_LIGHTNING,
        }),
        BLIND_RFQ_OFFER_TYPES,
        offer,
      ),
    },
  };
}

async function executableEnvelope(blind, index, { request = privateRequest } = {}) {
  const solverCreatesInvoice = request.direction === "lightning-to-bit";
  const offer = {
    offerId: blind.offerId,
    requestId: request.requestId,
    direction: id(request.direction),
    user: request.user,
    beneficiary: request.beneficiary,
    solver: solvers[index].address,
    grossBitAmount: blind.grossBitAmount,
    feeBitAmount: blind.feeBitAmount,
    lightningAmountSats: blind.lightningAmountSats,
    maxRoutingFeeSats: blind.maxRoutingFeeSats,
    paymentHash: solverCreatesInvoice ? id(`private-payment-${index}`) : request.paymentHash,
    invoiceDigest: solverCreatesInvoice ? id(`private-invoice-${index}`) : request.invoiceDigest,
    requestNonce: String(request.nonce),
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
      rfqDomain(request),
      EXECUTABLE_RFQ_OFFER_TYPES,
      offer,
    ),
  };
}

function marketSignal(index, direction, offerId, validUntil = NOW + 90) {
  const sourcePolicy = marketSourcePolicies[index];
  const observation = {
    source: sourcePolicy.source,
    direction,
    observedAt: NOW,
    validUntil,
    priceMsatPerBit: 100_000n,
    executableDepthSats: 1_000_000n,
    executableDepthBitWei: 10_000n * BIT,
    quoteCommitment: id(`rfq-market-quote:${offerId}:${index}`).toLowerCase(),
  };
  const typedData = executableVenueObservationTypedData({ sourcePolicy, observation });
  return buildExecutableVenuePriceSignal({
    sourcePolicy,
    observation: {
      ...observation,
      signature: marketSigners[index].signingKey.sign(
        TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.value),
      ).serialized,
    },
  });
}

function marketRiskAttestationForOffer(rawOffer, {
  validUntil = NOW + 90,
  policyOverrides = {},
} = {}) {
  const direction = rawOffer?.direction === id("lightning-to-bit")
    ? "lightning-to-bit"
    : rawOffer?.direction === id("bit-to-lightning")
      ? "bit-to-lightning"
      : null;
  if (!direction) return null;
  const grossBitAmount = BigInt(rawOffer.grossBitAmount);
  const feeBitAmount = BigInt(rawOffer.feeBitAmount);
  const lightningAmountSats = BigInt(rawOffer.lightningAmountSats);
  if (grossBitAmount <= feeBitAmount || lightningAmountSats <= 0n) return null;
  const priceSignals = marketSigners.map(
    (_signer, index) => marketSignal(index, direction, rawOffer.offerId, validUntil),
  );
  const policy = { ...marketRiskPolicy, ...policyOverrides };
  const snapshot = {
    chainId: 1,
    observedAt: NOW,
    proxyAddress: policy.proxyAddress,
    implementation: policy.expectedImplementation,
    proxyCodeHash: policy.expectedProxyCodeHash,
    implementationCodeHash: policy.expectedImplementationCodeHash,
    decimals: 18,
    paused: false,
    latestBlock: 1_000,
    finalizedBlock: 970,
    epochBitVolumeWei: 0n,
    availableBitWei: 100_000n * BIT,
    bitCapacityWei: 100_000n * BIT,
    availableLightningSats: 10_000_000n,
    lightningCapacitySats: 10_000_000n,
  };
  const request = {
    now: NOW,
    direction,
    bitWei: grossBitAmount - feeBitAmount,
    lightningSats: lightningAmountSats,
  };
  const evaluation = evaluateBitRisk({ policy, snapshot, priceSignals, request });
  if (!evaluation.enabled) return null;
  return buildBitRiskAttestation({ policy, snapshot, request, evaluation });
}

function marketRiskAttestationsForCollection(collection) {
  const verified = verifiedRfqDeliveryCollection(collection);
  const attestations = new Map();
  for (const delivery of verified.deliveries) {
    for (const envelope of delivery.envelopes) {
      try {
        const attestation = marketRiskAttestationForOffer(envelope.offer);
        if (attestation && !attestations.has(attestation.requestDigest)) {
          attestations.set(attestation.requestDigest, attestation);
        }
      } catch {}
    }
  }
  return [...attestations.values()];
}

function pathPlan(verifications, { includeThirdRelay = false, includeThirdSolver = false } = {}) {
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
  if (includeThirdSolver) paths.push({
    kind: "direct-solver",
    pathId: "direct-c",
    endpointOrigin: "https://direct-3.example",
    publicKey: pem(endpointKeys[2]),
    operatorCommitment: id("solver-operator-c"),
    solverId: solvers[2].address,
    capabilityVerification: verifications[2],
  });
  return paths;
}

function responseKey(pathId) {
  if (pathId === "relay-a") return relayKeys[0].privateKey;
  if (pathId === "relay-b") return relayKeys[1].privateKey;
  if (pathId === "relay-c") return relayKeys[2].privateKey;
  if (pathId === "direct-a") return endpointKeys[0].privateKey;
  if (pathId === "direct-b") return endpointKeys[1].privateKey;
  if (pathId === "direct-c") return endpointKeys[2].privateKey;
  throw new Error("unknown test path");
}

function jsonResponse(value, options = {}) {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status: options.status ?? 200,
    headers: {
      "cache-control": "no-store",
      "content-type": options.contentType ?? "application/json",
      ...options.headers,
    },
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

async function preparedDurableStore(t, {
  selection,
  verification,
  privateSettlementRequest = privateRequest,
  now = NOW,
}) {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-blind-reservation-"));
  const path = join(directory, "coordinator.sqlite");
  const store = await CoordinatorStore.open(path);
  t.after(() => {
    try { store.close(); } catch {}
    return rm(directory, { recursive: true, force: true });
  });
  const identity = {
    authenticated: true,
    commitment: id(`blind-rfq-identity:${selection.pricingId}`),
    key: privateSettlementRequest.user,
  };
  store.admitRfq({
    identity,
    request: {
      requestId: selection.pricingId,
      user: privateSettlementRequest.user,
      direction: selection.pricing.direction,
      notionalSats: selection.selected.offer.lightningAmountSats.toString(),
      nonce: privateSettlementRequest.nonce.toString(),
      expiresAt: selection.pricing.expiresAt,
    },
    policy: admissionPolicy,
    now,
  });
  store.recordSolverCapacity(verifiedSolverCapacityRecord(verification));
  return { directory, identity, path, store };
}

async function selectionAuthorization(selection, request = privateRequest, now = NOW) {
  const prepared = buildBlindQuoteSelectionAuthorization({
    selection,
    request,
    authorizationExpiresAt: Math.min(request.expiresAt, selection.selected.offer.expiresAt),
  });
  const signature = await user.signTypedData(prepared.domain, USER_SELECTION_AUTHORIZATION_TYPES, prepared.message);
  return verifyBlindQuoteSelectionAuthorization({
    selection,
    request,
    authorization: prepared.message,
    signature,
    now,
  });
}

async function executionAuthorization(request, finalization, now = NOW) {
  const prepared = buildFinalizedQuoteUserAuthorization({
    request,
    finalization,
    authorizationExpiresAt: finalization.envelope.offer.expiresAt,
  });
  const signature = await user.signTypedData(prepared.domain, USER_EXECUTION_AUTHORIZATION_TYPES, prepared.message);
  return authorizeFinalizedBlindQuote({
    request,
    finalization,
    authorization: prepared.message,
    signature,
    now,
  });
}

async function durableReservation(t, {
  selection,
  verification,
  privateSettlementRequest = privateRequest,
  now = NOW,
}) {
  const prepared = await preparedDurableStore(t, {
    selection,
    verification,
    privateSettlementRequest,
    now,
  });
  const userAuthorization = await selectionAuthorization(selection, privateSettlementRequest, now);
  const reservation = reserveSelectedBlindQuote({
    selection,
    userAuthorization,
    capabilityVerification: verification,
    coordinatorStore: prepared.store,
    admissionPolicy,
    now,
  });
  return { ...prepared, reservation, userAuthorization };
}

test("atomically reserves authenticated blind competition before private disclosure and finalization", async (t) => {
  const { collection, verifications } = await collect();
  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: verifications,
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: blindPolicy,
  });
  assert.equal(book.deliveryAuthenticated, true);
  assert.equal(book.marketRiskBound, true);
  assert.equal(book.marketRiskPolicyDigest, blindPolicy.marketRiskPolicyDigest);
  assert.equal(book.solverCount, 2);
  assert.equal(book.relayOfferPathCount, 2);
  assert.equal(book.directSolverOfferPathCount, 2);
  assert.equal(book.offers.length, 2);
  const selection = selectBlindQuote(book, id("delivery-offer-0"));
  assert.equal(selection.requiresPrivatePeerDisclosure, true);
  assert.throws(() => finalizeSelectedBlindQuote({
    request: privateRequest,
    reservation: selection,
    envelope: {},
    capabilityVerification: verifications[0],
    now: NOW,
    quotePolicy,
  }), /module-private blind-offer reservation/);
  const { path, reservation, store } = await durableReservation(t, {
    selection,
    verification: verifications[0],
  });
  assert.equal(activeBlindQuoteReservationBinding(reservation, { now: NOW }), reservation);
  assert.equal(store.getFirmOffer(reservation.selectedOfferId).state, "ACTIVE");
  assert.equal(
    store.getFirmOffer(reservation.selectedOfferId).marketRiskDigest,
    selection.marketRiskDigest,
  );
  assert.equal(
    store.getFirmOffer(reservation.selectedOfferId).marketRiskPolicyDigest,
    blindPolicy.marketRiskPolicyDigest,
  );
  assert.equal(
    store.getFirmOffer(reservation.selectedOfferId).marketRiskValidUntil,
    Number(selection.marketRiskValidUntil),
  );
  assert.equal(store.getSolverCapacity(reservation.selectedSolver.toLowerCase()).committedBitWei, String(100n * BIT + 5n * 10n ** 17n));
  const publicReservation = JSON.stringify(reservation).toLowerCase();
  for (const secret of [privateRequest.requestId, privateRequest.user, privateRequest.beneficiary]) {
    assert.doesNotMatch(publicReservation, new RegExp(secret.slice(2).toLowerCase()));
  }
  const disclosure = buildSelectedSolverDisclosure({
    request: privateRequest,
    reservation,
    invoice: "",
    channel: { authenticated: true, encrypted: true, peer: solvers[0].address },
    now: NOW,
  });
  assert.equal(disclosure.selectedOfferId, reservation.selectedOfferId);
  assert.equal(disclosure.invoice, "");
  assert.equal(disclosure.chainId, "1");
  assert.equal(disclosure.verifyingContract, LIGHTNING_TO_BIT);
  assert.equal(disclosure.requestNonce, privateRequest.nonce.toString());
  assert.equal("email" in disclosure, false);
  assert.throws(() => buildSelectedSolverDisclosure({
    request: privateRequest,
    reservation,
    invoice: "",
    channel: { authenticated: true, encrypted: false, peer: solvers[0].address },
    now: NOW,
  }), /authenticated encrypted peer-bound/);
  const executable = await executableEnvelope(selection.selected.offer, 0);
  const finalized = finalizeSelectedBlindQuote({
    request: privateRequest,
    reservation,
    envelope: executable,
    capabilityVerification: verifications[0],
    now: NOW,
    quotePolicy,
  });
  assert.throws(() => verifiedFinalizedExecutableQuote(finalized), /exact verified user authorization/);
  assert.equal(store.getFirmOffer(reservation.selectedOfferId).privateRequestDigest, finalized.requestDigest);
  assert.equal(store.getFirmOffer(reservation.selectedOfferId).executableOfferDigest, finalized.executableOfferDigest);
  assert.equal(store.getFirmOffer(reservation.selectedOfferId).executionBindingDigest, finalized.executionBindingDigest);
  assert.equal(finalizeSelectedBlindQuote({
    request: privateRequest,
    reservation,
    envelope: executable,
    capabilityVerification: verifications[0],
    now: NOW,
    quotePolicy,
  }), finalized);
  assert.throws(() => buildSelectedSolverDisclosure({
    request: privateRequest,
    reservation,
    invoice: "",
    channel: { authenticated: true, encrypted: true, peer: solvers[0].address },
    now: NOW,
  }), /already bound to an executable quote/);
  const changedInvoiceOffer = {
    ...executable.offer,
    paymentHash: id("second-private-payment"),
    invoiceDigest: id("second-private-invoice"),
  };
  const changedInvoiceEnvelope = {
    offer: changedInvoiceOffer,
    signature: await solvers[0].signTypedData(
      rfqDomain(privateRequest),
      EXECUTABLE_RFQ_OFFER_TYPES,
      changedInvoiceOffer,
    ),
  };
  assert.throws(() => finalizeSelectedBlindQuote({
    request: privateRequest,
    reservation,
    envelope: changedInvoiceEnvelope,
    capabilityVerification: verifications[0],
    now: NOW,
    quotePolicy,
  }), /already bound to another executable quote/);
  const authorized = await executionAuthorization(privateRequest, finalized);
  assert.equal(verifiedFinalizedExecutableQuote(authorized, { now: NOW }), authorized);
  assert.equal(
    store.getFirmOffer(reservation.selectedOfferId).executionAuthorizationDigest,
    authorized.userAuthorizationDigest,
  );
  const intent = bindFinalizedSolverInvoice(privateRequest, authorized, { now: NOW });
  assert.equal(intent.paymentHash, id("private-payment-0"));
  assert.equal(intent.selectedSolver, solvers[0].address);
  assert.equal(intent.receivedSetDigest, book.receiptDigest);
  assert.notEqual(intent.pricingId, intent.requestId);
  const finalizationDb = new DatabaseSync(path);
  finalizationDb.prepare("UPDATE firm_offer_commitments SET finalized_at = ? WHERE offer_id = ?")
    .run(NOW + 1, reservation.selectedOfferId);
  finalizationDb.close();
  assert.throws(
    () => activeBlindQuoteReservationBinding(reservation, { now: NOW + 1 }),
    /finalization time changed/,
  );
});

test("requires original current market evidence through every retained offer expiry", async () => {
  const { collection, offers, verifications } = await collect();
  const input = {
    pricing,
    collection,
    capabilityVerifications: verifications,
    now: NOW,
    policy: blindPolicy,
  };
  assert.throws(
    () => buildMultipathBlindQuoteBook(input),
    /current market-risk attestations/,
  );

  const current = marketRiskAttestationsForCollection(collection);
  assert.throws(() => buildMultipathBlindQuoteBook({
    ...input,
    marketRiskAttestations: current.map((attestation) => ({ ...attestation })),
  }), /not enough independent valid blind solver offers/);

  const tooShort = offers.map(({ envelope }) => marketRiskAttestationForOffer(
    envelope.offer,
    { validUntil: NOW + 30 },
  ));
  assert.throws(() => buildMultipathBlindQuoteBook({
    ...input,
    marketRiskAttestations: tooShort,
  }), /not enough independent valid blind solver offers/);

  const weakPolicy = offers.map(({ envelope }) => marketRiskAttestationForOffer(
    envelope.offer,
    { policyOverrides: { maxMarketDeviationBps: 10_000 } },
  ));
  assert.ok(weakPolicy.every(
    (attestation) => attestation.policyDigest !== blindPolicy.marketRiskPolicyDigest,
  ));
  assert.throws(() => buildMultipathBlindQuoteBook({
    ...input,
    marketRiskAttestations: weakPolicy,
  }), /not enough independent valid blind solver offers/);

  const book = buildMultipathBlindQuoteBook({ ...input, marketRiskAttestations: current });
  assert.equal(book.solverCount, 2);
  assert.equal(book.rejected.length, 0);
  assert.equal(book.marketRiskPolicyDigest, bitRiskPolicyDigest(marketRiskPolicy));
  assert.ok(book.offers.every((offer) => offer.marketRiskValidUntil >= BigInt(offer.offer.expiresAt)));
});

test("reserves outbound Lightning plus routing headroom before disclosing the user invoice", async (t) => {
  const offers = [
    await blindEnvelope(0, 25_000, {
      pricingRequest: bitToLightningPricing,
      grossBitAmount: 251n * BIT,
      feeBitAmount: 1n * BIT,
    }),
    await blindEnvelope(1, 25_000, {
      pricingRequest: bitToLightningPricing,
      grossBitAmount: 252n * BIT,
      feeBitAmount: 1n * BIT,
    }),
  ];
  const verifications = offers.map((item) => item.verification);
  const paths = pathPlan(verifications);
  const collection = await collectVerifiedRfqDeliveries({
    paths,
    requestId: bitToLightningPricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(bitToLightningPricing),
    rfq: bitToLightningPricing,
    policy: deliveryPolicy,
    requestImpl: async (_url, options, pathId) => {
      const wireRequest = JSON.parse(options.body);
      const delivered = pathId === "direct-a" ? [offers[0].envelope]
        : pathId === "direct-b" ? [offers[1].envelope]
          : offers.map((item) => item.envelope);
      return jsonResponse(buildSignedRfqDeliveryResponse({
        request: wireRequest,
        envelopes: delivered,
        servedAt: NOW,
        expiresAt: NOW + 10,
        privateKey: responseKey(pathId),
      }));
    },
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 9),
  });
  const book = buildMultipathBlindQuoteBook({
    pricing: bitToLightningPricing,
    collection,
    capabilityVerifications: verifications,
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: blindPolicy,
  });
  const selection = selectBlindQuote(book, offers[0].envelope.offer.offerId);
  const { reservation, store } = await durableReservation(t, {
    selection,
    verification: verifications[0],
    privateSettlementRequest: bitToLightningRequest,
  });
  assert.equal(reservation.amount, "25010");
  assert.equal(store.getFirmOffer(reservation.selectedOfferId).bitAmountWei, "0");
  assert.equal(store.getFirmOffer(reservation.selectedOfferId).lightningAmountSats, "25010");
  assert.equal(store.getSolverCapacity(reservation.selectedSolver.toLowerCase()).committedBitWei, "0");
  assert.equal(store.getSolverCapacity(reservation.selectedSolver.toLowerCase()).committedLightningSats, "25010");
  const disclosure = buildSelectedSolverDisclosure({
    request: bitToLightningRequest,
    reservation,
    invoice: `lightning:${userInvoice.toUpperCase()}`,
    channel: { authenticated: true, encrypted: true, peer: solvers[0].address.toLowerCase() },
    now: NOW,
  });
  assert.equal(disclosure.invoice, `lightning:${userInvoice.toUpperCase()}`);
  assert.equal(disclosure.paymentHash, bitToLightningRequest.paymentHash);
  assert.throws(() => buildSelectedSolverDisclosure({
    request: bitToLightningRequest,
    reservation,
    invoice: `${userInvoice}changed`,
    channel: { authenticated: true, encrypted: true, peer: solvers[0].address },
    now: NOW,
  }), /does not match its commitment/);
  assert.throws(() => buildSelectedSolverDisclosure({
    request: bitToLightningRequest,
    reservation,
    invoice: userInvoice,
    channel: { authenticated: true, encrypted: true, peer: solvers[0].address },
    now: NOW,
    maxDisclosureTtlSeconds: 121,
  }), /lifetime is outside policy/);
  const executable = await executableEnvelope(selection.selected.offer, 0, {
    request: bitToLightningRequest,
  });
  const finalized = finalizeSelectedBlindQuote({
    request: bitToLightningRequest,
    reservation,
    envelope: executable,
    capabilityVerification: verifications[0],
    now: NOW,
    quotePolicy,
  });
  assert.throws(() => verifiedFinalizedExecutableQuote(finalized), /exact verified user authorization/);
  const authorized = await executionAuthorization(bitToLightningRequest, finalized);
  assert.equal(verifiedFinalizedExecutableQuote(authorized, { now: NOW }), authorized);
  assert.equal(authorized.envelope.offer.invoiceDigest, bitToLightningRequest.invoiceDigest);
});

test("requires two exact user signatures before reservation and executable use", async (t) => {
  assert.throws(() => {
    USER_SELECTION_AUTHORIZATION_TYPES.UserSelectionAuthorization[0].name = "substituted";
  }, /read only|Cannot assign/);
  assert.throws(() => {
    USER_EXECUTION_AUTHORIZATION_TYPES.UserExecutionAuthorization[0].type = "string";
  }, /read only|Cannot assign/);
  const { collection, offers, verifications } = await collect();
  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: verifications,
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: blindPolicy,
  });
  const selection = selectBlindQuote(book, offers[0].envelope.offer.offerId);
  const preparedStore = await preparedDurableStore(t, { selection, verification: verifications[0] });
  assert.throws(() => reserveSelectedBlindQuote({
    selection,
    capabilityVerification: verifications[0],
    coordinatorStore: preparedStore.store,
    admissionPolicy,
    now: NOW,
  }), /verified user selection authorization/);

  const preparedSelection = buildBlindQuoteSelectionAuthorization({
    selection,
    request: privateRequest,
    authorizationExpiresAt: selection.selected.offer.expiresAt,
  });
  const selectionSignature = await user.signTypedData(
    preparedSelection.domain,
    USER_SELECTION_AUTHORIZATION_TYPES,
    preparedSelection.message,
  );
  const changedSelection = {
    ...preparedSelection.message,
    beneficiary: "0x9999999999999999999999999999999999999999",
  };
  assert.throws(() => verifyBlindQuoteSelectionAuthorization({
    selection,
    request: privateRequest,
    authorization: changedSelection,
    signature: selectionSignature,
    now: NOW,
  }), /changed exact quote terms/);
  const wrongSelectionSignature = await solvers[1].signTypedData(
    preparedSelection.domain,
    USER_SELECTION_AUTHORIZATION_TYPES,
    preparedSelection.message,
  );
  assert.throws(() => verifyBlindQuoteSelectionAuthorization({
    selection,
    request: privateRequest,
    authorization: preparedSelection.message,
    signature: wrongSelectionSignature,
    now: NOW,
  }), /signer does not match/);
  const selected = verifyBlindQuoteSelectionAuthorization({
    selection,
    request: privateRequest,
    authorization: preparedSelection.message,
    signature: selectionSignature,
    now: NOW,
  });
  assert.throws(() => reserveSelectedBlindQuote({
    selection,
    userAuthorization: { ...selected },
    capabilityVerification: verifications[0],
    coordinatorStore: preparedStore.store,
    admissionPolicy,
    now: NOW,
  }), /exact verified user selection authorization/);
  const reservation = reserveSelectedBlindQuote({
    selection,
    userAuthorization: selected,
    capabilityVerification: verifications[0],
    coordinatorStore: preparedStore.store,
    admissionPolicy,
    now: NOW,
  });
  const reverifiedSelection = verifyBlindQuoteSelectionAuthorization({
    selection,
    request: privateRequest,
    authorization: preparedSelection.message,
    signature: selectionSignature,
    now: NOW,
  });
  assert.equal(reserveSelectedBlindQuote({
    selection,
    userAuthorization: reverifiedSelection,
    capabilityVerification: verifications[0],
    coordinatorStore: preparedStore.store,
    admissionPolicy,
    now: NOW,
  }), reservation);
  assert.equal(
    preparedStore.store.getFirmOffer(reservation.selectedOfferId).selectionAuthorizationDigest,
    selected.selectionAuthorizationDigest,
  );
  assert.equal(
    preparedStore.store.getFirmOffer(reservation.selectedOfferId).selectionAuthorizationExpiresAt,
    selected.authorizationExpiresAt,
  );
  assert.throws(() => buildSelectedSolverDisclosure({
    request: { ...privateRequest, beneficiary: "0x9999999999999999999999999999999999999999" },
    reservation,
    invoice: "",
    channel: { authenticated: true, encrypted: true, peer: solvers[0].address },
    now: NOW,
  }), /user-authorized private request digest changed/);

  const executable = await executableEnvelope(selection.selected.offer, 0);
  const finalized = finalizeSelectedBlindQuote({
    request: privateRequest,
    reservation,
    envelope: executable,
    capabilityVerification: verifications[0],
    now: NOW,
    quotePolicy,
  });
  assert.throws(
    () => bindFinalizedSolverInvoice(privateRequest, finalized),
    /exact verified user authorization/,
  );
  const preparedExecution = buildFinalizedQuoteUserAuthorization({
    request: privateRequest,
    finalization: finalized,
    authorizationExpiresAt: finalized.envelope.offer.expiresAt,
  });
  const executionSignature = await user.signTypedData(
    preparedExecution.domain,
    USER_EXECUTION_AUTHORIZATION_TYPES,
    preparedExecution.message,
  );
  assert.throws(() => authorizeFinalizedBlindQuote({
    request: privateRequest,
    finalization: finalized,
    authorization: { ...preparedExecution.message, invoiceDigest: id("substituted-invoice") },
    signature: executionSignature,
    now: NOW,
  }), /changed exact quote or invoice terms/);
  const wrongExecutionSignature = await solvers[1].signTypedData(
    preparedExecution.domain,
    USER_EXECUTION_AUTHORIZATION_TYPES,
    preparedExecution.message,
  );
  assert.throws(() => authorizeFinalizedBlindQuote({
    request: privateRequest,
    finalization: finalized,
    authorization: preparedExecution.message,
    signature: wrongExecutionSignature,
    now: NOW,
  }), /signer does not match/);
  const authorized = authorizeFinalizedBlindQuote({
    request: privateRequest,
    finalization: finalized,
    authorization: preparedExecution.message,
    signature: executionSignature,
    now: NOW,
  });
  assert.equal(authorizeFinalizedBlindQuote({
    request: privateRequest,
    finalization: finalized,
    authorization: preparedExecution.message,
    signature: executionSignature,
    now: NOW + 1,
  }), authorized);
  assert.equal(
    preparedStore.store.getFirmOffer(reservation.selectedOfferId).executionAuthorizationDigest,
    authorized.userAuthorizationDigest,
  );
  assert.equal(
    preparedStore.store.getFirmOffer(reservation.selectedOfferId).executionAuthorizationExpiresAt,
    authorized.userAuthorizationExpiresAt,
  );
  assert.throws(
    () => verifiedFinalizedExecutableQuote(authorized, { now: authorized.userAuthorizationExpiresAt }),
    /user execution authorization is expired/,
  );
  assert.throws(
    () => verifiedFinalizedExecutableQuote({ ...authorized }),
    /exact verified user authorization/,
  );
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
    /exact verified user authorization/,
  );
});

test("rejects copied provenance, caller-asserted verification, fake stores, and method substitution", async (t) => {
  const { collection, offers, verifications } = await collect();
  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: verifications,
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: blindPolicy,
  });
  const selection = selectBlindQuote(book, offers[0].envelope.offer.offerId);
  const prepared = await preparedDurableStore(t, { selection, verification: verifications[0] });
  const userAuthorization = await selectionAuthorization(selection);
  const input = {
    selection,
    userAuthorization,
    capabilityVerification: verifications[0],
    coordinatorStore: prepared.store,
    admissionPolicy,
    now: NOW,
  };
  assert.throws(
    () => reserveSelectedBlindQuote({ ...input, selection: { ...selection } }),
    /locally selected authenticated blind quote/,
  );
  assert.throws(
    () => reserveSelectedBlindQuote({ ...input, capabilityVerification: { ...verifications[0], valid: true } }),
    /exact locally verified capability/,
  );
  assert.throws(
    () => reserveSelectedBlindQuote({ ...input, coordinatorStore: { reserveVerifiedFirmOffer() {} } }),
    /durable coordinator store/,
  );
  prepared.store.getFirmOffer = () => null;
  assert.throws(() => reserveSelectedBlindQuote(input), /unmodified coordinator store methods/);
  delete prepared.store.getFirmOffer;
  const reservation = reserveSelectedBlindQuote(input);
  assert.equal(reserveSelectedBlindQuote(input), reservation);
  assert.throws(
    () => reserveSelectedBlindQuote({ ...input, coordinatorStore: {} }),
    /another durable reservation authority/,
  );
  assert.throws(
    () => activeBlindQuoteReservationBinding({ ...reservation }, { now: NOW }),
    /module-private blind-offer reservation/,
  );
  assert.throws(
    () => activeBlindQuoteReservationBinding(reservation, { now: NOW - 1 }),
    /clock moved backward/,
  );
});

test("revokes disclosure and finalization when the durable RFQ cancels", async (t) => {
  const { collection, offers, verifications } = await collect();
  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: verifications,
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: blindPolicy,
  });
  const selection = selectBlindQuote(book, offers[0].envelope.offer.offerId);
  const { identity, reservation, store } = await durableReservation(t, {
    selection,
    verification: verifications[0],
  });
  store.cancelRfqs({
    identity,
    cancellationId: id("cancel-selected-blind-rfq"),
    cancellationSequence: privateRequest.nonce.toString(),
    recordedAt: NOW + 1,
  });
  assert.equal(store.getFirmOffer(reservation.selectedOfferId).state, "USER_ABANDONED");
  assert.throws(
    () => activeBlindQuoteReservationBinding(reservation, { now: NOW + 1 }),
    /no longer active/,
  );
  assert.throws(() => buildSelectedSolverDisclosure({
    request: privateRequest,
    reservation,
    invoice: "",
    channel: { authenticated: true, encrypted: true, peer: solvers[0].address },
    now: NOW + 1,
  }), /no longer active/);
});

test("rejects expired, same-ID-mutated, and stale-capacity reservations", async (t) => {
  const build = async () => {
    const { collection, offers, verifications } = await collect();
    const book = buildMultipathBlindQuoteBook({
      pricing,
      collection,
      capabilityVerifications: verifications,
      marketRiskAttestations: marketRiskAttestationsForCollection(collection),
      now: NOW,
      policy: blindPolicy,
    });
    return { selection: selectBlindQuote(book, offers[0].envelope.offer.offerId), verifications };
  };

  const expired = await build();
  const expiredDurable = await durableReservation(t, {
    selection: expired.selection,
    verification: expired.verifications[0],
  });
  assert.throws(
    () => activeBlindQuoteReservationBinding(expiredDurable.reservation, { now: NOW + 60 }),
    /user selection authorization is expired|no longer active/,
  );

  const mutated = await build();
  const mutatedDurable = await durableReservation(t, {
    selection: mutated.selection,
    verification: mutated.verifications[0],
  });
  const mutationDb = new DatabaseSync(mutatedDurable.path);
  mutationDb.prepare("UPDATE firm_offer_commitments SET record_digest = ? WHERE offer_id = ?")
    .run(id("mutated-firm-record"), mutatedDurable.reservation.selectedOfferId);
  mutationDb.close();
  assert.throws(
    () => activeBlindQuoteReservationBinding(mutatedDurable.reservation, { now: NOW }),
    /firm record digest changed/,
  );

  const stale = await build();
  const staleDurable = await durableReservation(t, {
    selection: stale.selection,
    verification: stale.verifications[0],
  });
  const capacityDb = new DatabaseSync(staleDurable.path);
  capacityDb.prepare("UPDATE solver_capacity SET snapshot_digest = ? WHERE solver_id = ?")
    .run(id("mutated-capacity-record"), staleDurable.reservation.selectedSolver.toLowerCase());
  capacityDb.close();
  assert.throws(
    () => activeBlindQuoteReservationBinding(staleDurable.reservation, { now: NOW }),
    /capacity snapshot digest changed/,
  );

  const accounting = await build();
  const accountingDurable = await durableReservation(t, {
    selection: accounting.selection,
    verification: accounting.verifications[0],
  });
  const accountingDb = new DatabaseSync(accountingDurable.path);
  accountingDb.prepare("UPDATE solver_capacity SET committed_bit_wei = '0' WHERE solver_id = ?")
    .run(accountingDurable.reservation.selectedSolver.toLowerCase());
  accountingDb.close();
  assert.throws(
    () => activeBlindQuoteReservationBinding(accountingDurable.reservation, { now: NOW }),
    /commitment accounting diverged/,
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

test("rejects accessor and coercion RFQ inputs without executing caller code", async () => {
  const data = await fixture();
  let getterCalls = 0;
  let coercionCalls = 0;
  let requests = 0;
  const accessorPricing = { ...pricing };
  Object.defineProperty(accessorPricing, "maxFeeBps", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return pricing.maxFeeBps;
    },
  });
  assert.throws(() => rfqDeliveryPayloadDigest(accessorPricing), /enumerable data properties/);

  const coercionPricing = {
    ...pricing,
    maxFeeBps: {
      toString() {
        coercionCalls += 1;
        return pricing.maxFeeBps;
      },
    },
  };
  assert.throws(() => rfqDeliveryPayloadDigest(coercionPricing), /canonical bounded unsigned integer/);

  const accessorCall = {
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async () => { requests += 1; },
    nowSeconds: () => NOW,
  };
  Object.defineProperty(accessorCall, "policy", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return deliveryPolicy;
    },
  });
  await assert.rejects(collectVerifiedRfqDeliveries(accessorCall), /enumerable data properties/);

  const accessorPaths = pathPlan(data.verifications);
  Object.defineProperty(accessorPaths[0], "kind", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "relay";
    },
  });
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths: accessorPaths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async () => { requests += 1; },
    nowSeconds: () => NOW,
  }), /enumerable data properties/);
  assert.equal(getterCalls, 0);
  assert.equal(coercionCalls, 0);
  assert.equal(requests, 0);
});

test("rejects hidden, symbolic, inherited, sparse, and decorated RFQ authority", async () => {
  const data = await fixture();
  let requests = 0;
  const base = {
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async () => { requests += 1; },
    nowSeconds: () => NOW,
  };
  const hiddenPolicy = { ...deliveryPolicy };
  Object.defineProperty(hiddenPolicy, "override", { enumerable: false, value: true });
  await assert.rejects(collectVerifiedRfqDeliveries({
    ...base,
    paths: data.paths,
    policy: hiddenPolicy,
  }), /fields are outside policy/);

  const symbolicPricing = { ...pricing, [Symbol("private-beneficiary")]: user.address };
  assert.throws(() => rfqDeliveryPayloadDigest(symbolicPricing), /fields are outside policy/);

  const inheritedPath = Object.assign(Object.create({ privileged: true }), data.paths[0]);
  const inheritedPaths = [...data.paths];
  inheritedPaths[0] = inheritedPath;
  await assert.rejects(collectVerifiedRfqDeliveries({ ...base, paths: inheritedPaths }), /plain data object/);

  const sparsePaths = [...data.paths];
  delete sparsePaths[1];
  await assert.rejects(collectVerifiedRfqDeliveries({ ...base, paths: sparsePaths }), /dense/);

  const decoratedPaths = [...data.paths];
  Object.defineProperty(decoratedPaths, "selected", { enumerable: false, value: 0 });
  await assert.rejects(collectVerifiedRfqDeliveries({ ...base, paths: decoratedPaths }), /dense/);
  assert.equal(requests, 0);
});

test("snapshots RFQ collection inputs before concurrent delivery", async () => {
  const data = await fixture();
  const mutablePricing = { ...pricing };
  const mutablePolicy = { ...deliveryPolicy };
  const mutablePaths = pathPlan(data.verifications);
  const pending = collectVerifiedRfqDeliveries({
    paths: mutablePaths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: mutablePricing,
    policy: mutablePolicy,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 9),
  });
  mutablePricing.maxFeeBps = "999";
  mutablePolicy.minimumRelayPaths = 16;
  mutablePaths[0].kind = "direct-solver";
  mutablePaths.push({ ...mutablePaths[0], pathId: "late-path" });
  const collection = await pending;
  assert.equal(collection.relayCount, 2);
  assert.equal(collection.directSolverCount, 2);
  assert.equal(collection.attemptCount, 4);
  assert.equal(collection.rfqPayloadDigest, rfqDeliveryPayloadDigest(pricing));
});

test("rejects accessor-bearing response digest inputs without executing them", () => {
  let getterCalls = 0;
  const response = {
    schema: "treeswap.rfq-delivery-response.v1",
    request: {},
    envelopes: [],
    servedAt: NOW,
    expiresAt: NOW + 10,
  };
  Object.defineProperty(response, "request", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return {};
    },
  });
  assert.throws(() => rfqDeliveryResponseDigest(response), /enumerable data properties/);
  assert.equal(getterCalls, 0);
});

test("rejects accessor and decorated response-builder inputs without executing them", async () => {
  const candidate = await blindEnvelope(0, 10_000);
  const request = buildRfqDeliveryRequest({
    challenge: id("exact-data-builder-challenge").toLowerCase(),
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    pathIdentityDigest: id("exact-data-builder-path").toLowerCase(),
    rfq: pricing,
    requestedAt: NOW,
    expiresAt: NOW + 15,
  });
  let getterCalls = 0;
  const accessorEnvelope = { ...candidate.envelope };
  Object.defineProperty(accessorEnvelope, "offer", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return candidate.envelope.offer;
    },
  });
  assert.throws(() => buildSignedRfqDeliveryResponse({
    request,
    envelopes: [accessorEnvelope],
    servedAt: NOW,
    expiresAt: NOW + 10,
    privateKey: relayKeys[0].privateKey,
  }), /enumerable data properties/);

  const decorated = [candidate.envelope];
  decorated.source = "caller-selected";
  assert.throws(() => buildSignedRfqDeliveryResponse({
    request,
    envelopes: decorated,
    servedAt: NOW,
    expiresAt: NOW + 10,
    privateKey: relayKeys[0].privateKey,
  }), /dense/);
  assert.equal(getterCalls, 0);
});

test("bounds strict RFQ response framing under the complete transport deadline", async () => {
  const data = await fixture();
  const args = {
    path: data.paths[0],
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 7),
  };
  const framed = (headers) => async (url, options, pathId) => {
    const valid = await data.responder(url, options, pathId);
    return new Response(await valid.text(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        ...headers,
      },
    });
  };
  for (const headers of [
    { "cache-control": "" },
    { "content-encoding": "gzip" },
    { "content-length": "01" },
    { "content-length": "2", "transfer-encoding": "chunked" },
    { "content-length": "1" },
    { "content-type": "application/json; charset=utf-16" },
    { "transfer-encoding": "gzip" },
  ]) {
    await assert.rejects(queryVerifiedRfqDelivery({
      ...args,
      requestImpl: framed(headers),
    }), (error) => error.code === "INVALID_RESPONSE" && error.ambiguous === false);
  }

  for (const bytes of [
    [0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d],
    [0xef, 0xbb, 0xbf, ...Buffer.from('{"x":true}')],
  ]) {
    await assert.rejects(queryVerifiedRfqDelivery({
      ...args,
      requestImpl: async () => new Response(Uint8Array.from(bytes), {
        headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
      }),
    }), (error) => error.code === "INVALID_RESPONSE" && error.ambiguous === false);
  }

  let stalledCancelled = 0;
  await assert.rejects(queryVerifiedRfqDelivery({
    ...args,
    timeoutMs: 5,
    requestImpl: async () => new Response(new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel() {
        stalledCancelled += 1;
      },
    }), {
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    }),
  }), (error) => error.code === "TRANSPORT_FAILED" && error.ambiguous === false);
  assert.equal(stalledCancelled, 1);
});

test("cancels malformed and rejected RFQ bodies without trusting teardown", async () => {
  const data = await fixture();
  const args = {
    path: data.paths[0],
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 7),
  };
  let cancelled = 0;
  for (const response of [
    { status: 200, redirected: false, contentType: "text/plain", code: "INVALID_RESPONSE" },
    { status: 503, redirected: false, contentType: "application/json", code: "HTTP_REJECTED" },
    { status: 200, redirected: true, contentType: "application/json", code: "REDIRECT_REFUSED" },
  ]) {
    await assert.rejects(queryVerifiedRfqDelivery({
      ...args,
      requestImpl: async () => ({
        status: response.status,
        redirected: response.redirected,
        headers: new Headers({
          "cache-control": "no-store",
          "content-type": response.contentType,
        }),
        body: new ReadableStream({
          cancel() {
            cancelled += 1;
            return new Promise(() => {});
          },
        }),
      }),
    }), (error) => error.code === response.code && error.ambiguous === false);
  }
  assert.equal(cancelled, 3);
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
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: blindPolicy,
  });
  assert.equal(book.relayOfferPathCount, 2);
  assert.match(book.rejected.flatMap((item) => item.reasons).join("; "), /signature is invalid|exact BIT output changed/);
});

test("invalid relay offers cannot exhaust the retained competition limit", async () => {
  const data = await fixture();
  const unknownSolver = new Wallet(`0x${"44".repeat(32)}`);
  const invalid = Array.from({ length: 7 }, (_, index) => ({
    offer: {
      ...data.offers[0].envelope.offer,
      offerId: id(`relay-cap-poison-${index}`),
      solver: unknownSolver.address,
    },
    signature: `0x${"00".repeat(65)}`,
  }));
  const collection = await collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async (url, options, pathId) => {
      if (pathId !== "relay-a") return data.responder(url, options, pathId);
      return jsonResponse(buildSignedRfqDeliveryResponse({
        request: JSON.parse(options.body),
        envelopes: [data.offers[0].envelope, ...invalid],
        servedAt: NOW,
        expiresAt: NOW + 10,
        privateKey: relayKeys[0].privateKey,
      }));
    },
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 6),
  });

  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: data.verifications,
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: { ...blindPolicy, maxOffersPerRequest: 2 },
  });
  assert.equal(book.solverCount, 2);
  assert.equal(book.relayOfferPathCount, 2);
  assert.equal(book.directSolverOfferPathCount, 2);
  assert.equal(book.rejected.length, 7);
  assert.match(book.rejected.flatMap((item) => item.reasons).join("; "), /locally verified capability/);
  assert.throws(() => buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: Array.from({ length: 129 }, () => data.verifications[0]),
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: blindPolicy,
  }), /bounded candidate limit/);
});

test("retained competition limit keeps the deterministic best valid offers", async () => {
  const data = await fixture();
  const third = await blindEnvelope(2, 9_900);
  const offers = [...data.offers, third];
  const verifications = [...data.verifications, third.verification];
  const paths = pathPlan(verifications, { includeThirdSolver: true });
  const collection = await collectVerifiedRfqDeliveries({
    paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async (_url, options, pathId) => {
      const delivered = pathId === "direct-a" ? [offers[0].envelope]
        : pathId === "direct-b" ? [offers[1].envelope]
          : pathId === "direct-c" ? [offers[2].envelope]
            : offers.map((item) => item.envelope);
      return jsonResponse(buildSignedRfqDeliveryResponse({
        request: JSON.parse(options.body),
        envelopes: delivered,
        servedAt: NOW,
        expiresAt: NOW + 10,
        privateKey: responseKey(pathId),
      }));
    },
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 5),
  });

  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: verifications,
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: { ...blindPolicy, maxOffersPerRequest: 2 },
  });
  assert.deepEqual(
    book.offers.map(({ offer }) => offer.offerId),
    [third.envelope.offer.offerId, data.offers[0].envelope.offer.offerId],
  );
  assert.equal(book.relayOfferPathCount, 2);
  assert.equal(book.directSolverOfferPathCount, 2);
  assert.match(
    book.rejected.flatMap((item) => item.reasons).join("; "),
    /outside the deterministic retained-offer limit/,
  );
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
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
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
  await assert.rejects(collectVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: { ...deliveryPolicy, maxOffersPerPath: 17 },
    requestImpl: async () => { requests += 1; },
    nowSeconds: () => NOW,
  }), /too many total offer candidates/);
  assert.equal(requests, 0);
});

test("rejects post-selection repricing, solver change, and request linkage", async (t) => {
  const { collection, offers, verifications } = await collect();
  const book = buildMultipathBlindQuoteBook({
    pricing,
    collection,
    capabilityVerifications: verifications,
    marketRiskAttestations: marketRiskAttestationsForCollection(collection),
    now: NOW,
    policy: blindPolicy,
  });
  const selection = selectBlindQuote(book, offers[0].envelope.offer.offerId);
  const { reservation } = await durableReservation(t, {
    selection,
    verification: verifications[0],
  });
  const valid = await executableEnvelope(selection.selected.offer, 0);
  for (const [field, value, reason] of [
    ["grossBitAmount", String(101n * BIT), /grossBitAmount|exact BIT output/],
    ["solver", solvers[1].address, /invalid|solver|capability/],
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
      reservation,
      envelope: changed,
      capabilityVerification: verifications[field === "solver" ? 1 : 0],
      now: NOW,
      quotePolicy,
    }), reason);
  }
  assert.throws(() => finalizeSelectedBlindQuote({
    request: { ...privateRequest, maxFeeBps: 99n },
    reservation,
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
