import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { id, TypedDataEncoder, Wallet } from "ethers";
import {
  createClientSafeBlindQuoteSession,
  createTestClientSafeBlindQuoteSession,
  isClientSafeBlindQuoteSession,
  isProductionClientSafeBlindQuoteSession,
} from "../lib/blind-quote-preview.mjs";
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
  verifiedBlindQuoteBook,
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
  collectTestVerifiedRfqDeliveries,
  collectVerifiedRfqDeliveries,
  createRfqDeliveryClient,
  createTestRfqDeliveryClient,
  isProductionRfqDeliveryClient,
  isRfqDeliveryClient,
  queryTestVerifiedRfqDelivery,
  queryVerifiedRfqDelivery,
  rfqDeliveryClientLifecycleState,
  rfqDeliveryClientTransportMode,
  rfqDeliveryPayloadDigest,
  rfqDeliveryResponseDigest,
  verifiedRfqDeliveryCollection,
} from "../lib/rfq-delivery.mjs";
import {
  RFQ_QUOTE_AUTHORIZATION_TYPES,
  buildRfqQuoteAuthorization,
  createRfqQuoteIngressReader,
  createRfqQuoteIngressRoute,
  createRfqSelectionReservationService,
  createTestRfqQuoteIngressReader,
  createTestRfqQuoteIngressServiceReader,
  createTestRfqQuoteIngressRoute,
  createTestRfqSelectionReservationService,
  isRfqQuoteIngressRoute,
  rfqQuoteIngressPolicyDigest,
} from "../lib/rfq-quote-ingress.mjs";
import {
  authorizeFinalizedContractIntent,
  prepareFinalizedContractIntent,
  verifiedAuthorizedContractIntent,
} from "../lib/rfq-contract-intent.mjs";
import { RfqQuoteIngressStore } from "../lib/rfq-quote-ingress-store.mjs";
import {
  claimRfqSelectedSolverFinalizationOwnership,
  claimRfqSelectionReservationOwnership,
} from "../lib/rfq-selection-reservation.mjs";
import {
  buildSignedSelectedSolverFinalizationResponse,
  createTestSelectedSolverFinalizationClient,
  verifySelectedSolverFinalizationRequest,
} from "../lib/selected-solver-finalization-transport.mjs";
import {
  createRfqExecutionCeremonyRoute,
  createRfqPrivateCeremonyRoute,
  createTestRfqExecutionCeremonyRoute,
  createTestRfqPrivateCeremonyRoute,
  isRfqExecutionCeremonyRoute,
  isRfqPrivateCeremonyRoute,
} from "../lib/rfq-private-ceremony.mjs";
import {
  isProductionRfqDeliveryService,
  isRfqDeliveryService,
  startRfqDeliveryService,
  startTestRfqDeliveryService,
} from "../lib/rfq-delivery-service.mjs";
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
import { TREE_SWAP_SETTLEMENT_POLICY_V1 } from "../lib/settlement-policy.mjs";
import { createBolt11Invoice, testBolt11Payee } from "./bolt11-fixture.mjs";

const NOW = 2_000_000_000;
const BIT = 10n ** 18n;
const LIGHTNING_TO_BIT = "0x1111111111111111111111111111111111111111";
const BIT_TO_LIGHTNING = "0x2222222222222222222222222222222222222222";
const LIGHTNING_TO_BIT_CODE_HASH = id("delivery-lightning-to-bit-runtime");
const BIT_TO_LIGHTNING_CODE_HASH = id("delivery-bit-to-lightning-runtime");
const QUOTE_API_ORIGIN = "https://quotes.treeswap.example";
const QUOTE_CLIENT_ORIGIN = "https://app.treeswap.example";
const CEREMONY_API_ORIGIN = "https://authorize.treeswap.example";
const privateCeremonyPolicy = Object.freeze({
  apiOrigin: CEREMONY_API_ORIGIN,
  clientOrigin: QUOTE_CLIENT_ORIGIN,
  maximumInFlightRequests: 16,
  maximumProcessingMilliseconds: 5_000,
  maximumRequestBytes: 32_768,
  maximumResponseBytes: 262_144,
});
const invoicePolicy = Object.freeze({
  allowHashedDescriptions: false,
  maxExpirySeconds: 86_400,
  maxInvoiceLength: 4_096,
  maxRouteHints: 20,
  maximumFinalCltvDelta: 288,
  minimumFinalCltvDelta: 80,
  minimumRemainingSeconds: 900,
});
const lightningNodePrivateKeys = [
  `0x${"51".repeat(32)}`,
  `0x${"52".repeat(32)}`,
  `0x${"53".repeat(32)}`,
];
const solvers = [
  new Wallet(`0x${"31".repeat(32)}`),
  new Wallet(`0x${"32".repeat(32)}`),
  new Wallet(`0x${"34".repeat(32)}`),
];
const user = new Wallet(`0x${"33".repeat(32)}`);
const quoteIngressPolicy = Object.freeze({
  apiOrigin: QUOTE_API_ORIGIN,
  bitToLightningContract: BIT_TO_LIGHTNING,
  chainId: 1,
  clientOrigin: QUOTE_CLIENT_ORIGIN,
  lightningToBitContract: LIGHTNING_TO_BIT,
  maximumActiveSessionsPerIdentity: 2,
  maximumAuthorizationTtlSeconds: 60,
  maximumExactBitOutputWei: String(1_000n * BIT),
  maximumExactLightningOutputSats: "1000000",
  maximumFeeBps: 300,
  maximumLiveRequests: 16,
  maximumProcessingMilliseconds: 250,
  maximumRequestBytes: 16_384,
  maximumRequestLifetimeSeconds: 120,
  maximumResponseBytes: 262_144,
  maximumRequestsPerIdentityWindow: 4,
  maximumRequestsPerWindowGlobal: 16,
  maximumRoutingFeeSats: "1000",
  minimumExactBitOutputWei: String(BIT / 100n),
  minimumExactLightningOutputSats: "1",
  quotaWindowSeconds: 600,
});
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
const userInvoice = createBolt11Invoice({
  amountSats: 25_000n,
  paymentHash: id("private-bit-to-lightning-payment").toLowerCase(),
  paymentSecret: id("private-bit-to-lightning-secret").toLowerCase(),
  timestamp: NOW - 30,
});
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
  const nodePubkey = testBolt11Payee(lightningNodePrivateKeys[index]);
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

function currentMarketRiskSnapshot(policy = marketRiskPolicy) {
  return {
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
  const snapshot = currentMarketRiskSnapshot(policy);
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

async function fixture({ includeThirdRelay = false, pricingRequest = pricing } = {}) {
  const offers = pricingRequest.direction === "lightning-to-bit"
    ? [
      await blindEnvelope(0, 10_000, { pricingRequest }),
      await blindEnvelope(1, 10_100, { pricingRequest }),
    ]
    : [
      await blindEnvelope(0, Number(pricingRequest.exactOutput), {
        pricingRequest,
        grossBitAmount: 252n * BIT + BIT / 2n,
        feeBitAmount: 2n * BIT + BIT / 2n,
      }),
      await blindEnvelope(1, Number(pricingRequest.exactOutput), {
        pricingRequest,
        grossBitAmount: 253n * BIT,
        feeBitAmount: 2n * BIT + BIT / 2n,
      }),
    ];
  const verifications = offers.map((item) => item.verification);
  const paths = pathPlan(verifications, { includeThirdRelay });
  const responder = async (_url, options, pathId) => {
    const wireRequest = JSON.parse(options.body);
    assert.deepEqual(wireRequest.rfq, pricingRequest);
    assert.equal(wireRequest.requestDigest, rfqDeliveryPayloadDigest(pricingRequest));
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
  return { offers, pricingRequest, verifications, paths, responder };
}

async function collect(options = {}) {
  const data = await fixture(options);
  const collection = await collectTestVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: data.pricingRequest.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(data.pricingRequest),
    rfq: data.pricingRequest,
    policy: deliveryPolicy,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 7),
  });
  return { ...data, collection };
}

async function collectedBlindBook(options = {}) {
  const data = await collect(options);
  return {
    ...data,
    book: buildMultipathBlindQuoteBook({
      pricing: data.pricingRequest,
      collection: data.collection,
      capabilityVerifications: data.verifications,
      marketRiskAttestations: marketRiskAttestationsForCollection(data.collection),
      now: NOW,
      policy: blindPolicy,
    }),
  };
}

async function quoteIngressStore(policy = quoteIngressPolicy) {
  return RfqQuoteIngressStore.open({
    allowMemory: true,
    identityKey: Buffer.alloc(32, 91),
    initialize: true,
    maximumActiveSessionsPerIdentity: policy.maximumActiveSessionsPerIdentity,
    maximumLiveRequests: policy.maximumLiveRequests,
    maximumRequestLifetimeSeconds: policy.maximumRequestLifetimeSeconds,
    maximumRequestsPerIdentityWindow: policy.maximumRequestsPerIdentityWindow,
    maximumRequestsPerWindowGlobal: policy.maximumRequestsPerWindowGlobal,
    path: ":memory:",
    policyDigest: rfqQuoteIngressPolicyDigest(policy),
    quotaWindowSeconds: policy.quotaWindowSeconds,
  });
}

async function signedQuoteIngressBody({
  policy = quoteIngressPolicy,
  publicPricing = pricing,
  requestNonce = "17",
  authorizationExpiresAt = NOW + 30,
} = {}) {
  const material = buildRfqQuoteAuthorization({
    authorizationExpiresAt,
    policy,
    pricing: publicPricing,
    requestNonce,
    user: user.address,
  });
  return {
    pricing: publicPricing,
    authorization: material.message,
    signature: await user.signTypedData(material.domain, RFQ_QUOTE_AUTHORIZATION_TYPES, material.message),
  };
}

function quoteIngressRequest(path, value, overrides = {}) {
  const body = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  const headers = new Headers({
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": "application/json",
    origin: QUOTE_CLIENT_ORIGIN,
    ...overrides.headers,
  });
  if (overrides.omitContentLength) headers.delete("content-length");
  return new Request(`${overrides.origin ?? QUOTE_API_ORIGIN}${path}`, {
    method: overrides.method ?? "POST",
    headers,
    body: overrides.method === "GET" ? undefined : body,
    signal: overrides.signal,
  });
}

function privateCeremonyRequest(path, value, overrides = {}) {
  const body = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item), "utf8");
  const headers = new Headers({
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": "application/json",
    origin: QUOTE_CLIENT_ORIGIN,
    ...overrides.headers,
  });
  if (overrides.omitContentLength) headers.delete("content-length");
  return new Request(`${overrides.origin ?? CEREMONY_API_ORIGIN}${path}`, {
    method: overrides.method ?? "POST",
    headers,
    body: overrides.method === "GET" || overrides.method === "OPTIONS" ? undefined : body,
    signal: overrides.signal,
  });
}

async function quoteIngressFixture(t, {
  nowSeconds = () => NOW,
  policy = quoteIngressPolicy,
  read = null,
  randomBytesImpl = null,
} = {}) {
  const { book, verifications } = await collectedBlindBook();
  const store = await quoteIngressStore(policy);
  const coordinatorStore = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const deployment = new AbortController();
  let previewEntropy = 40;
  let reads = 0;
  let lastReaderPricing = null;
  const reader = createTestRfqQuoteIngressReader({
    read: read ?? (async (publicPricing, { signal }) => {
      reads += 1;
      lastReaderPricing = publicPricing;
      assert.equal(signal.aborted, false);
      return createTestClientSafeBlindQuoteSession({
        book,
        nowSeconds,
        randomBytesImpl: () => Buffer.alloc(32, ++previewEntropy),
      });
    }),
  });
  let reservationEntropy = 110;
  const selectionReservation = createTestRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: verifications,
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: policy.maximumLiveRequests,
    nowSeconds,
    randomBytesImpl: () => Buffer.alloc(32, ++reservationEntropy),
    signal: deployment.signal,
  });
  let routeEntropy = 70;
  const route = createTestRfqQuoteIngressRoute({
    nowSeconds,
    policy,
    quoteReader: reader,
    randomBytesImpl: randomBytesImpl ?? (() => Buffer.alloc(32, ++routeEntropy)),
    replayStore: store,
    selectionReservation,
    signal: deployment.signal,
  });
  t.after(() => {
    try { route.stop(); } catch {}
    try { store.close(); } catch {}
    try { coordinatorStore.close(); } catch {}
  });
  return {
    book,
    coordinatorStore,
    deployment,
    lastReaderPricing: () => lastReaderPricing,
    reader,
    reads: () => reads,
    route,
    selectionReservation,
    store,
  };
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

async function authorizedContractFixture(t, direction) {
  const request = direction === "lightning-to-bit" ? privateRequest : bitToLightningRequest;
  const pricingRequest = direction === "lightning-to-bit" ? pricing : bitToLightningPricing;
  const data = await collectedBlindBook({ pricingRequest });
  const selection = selectBlindQuote(data.book, data.book.offers[0].offer.offerId);
  const { reservation } = await durableReservation(t, {
    selection,
    verification: data.verifications[0],
    privateSettlementRequest: request,
  });
  const invoice = direction === "lightning-to-bit"
    ? createBolt11Invoice({
        amountSats: BigInt(selection.selected.offer.lightningAmountSats),
        paymentHash: id("contract-intent-lightning-to-bit-payment").toLowerCase(),
        paymentSecret: id("contract-intent-lightning-to-bit-secret").toLowerCase(),
        privateKey: lightningNodePrivateKeys[0],
        timestamp: NOW - 30,
      })
    : userInvoice;
  const base = await executableEnvelope(selection.selected.offer, 0, { request });
  const offer = direction === "lightning-to-bit"
    ? {
        ...base.offer,
        paymentHash: id("contract-intent-lightning-to-bit-payment").toLowerCase(),
        invoiceDigest: invoiceDigest(invoice),
      }
    : base.offer;
  const envelope = {
    offer,
    signature: await solvers[0].signTypedData(
      rfqDomain(request),
      EXECUTABLE_RFQ_OFFER_TYPES,
      offer,
    ),
  };
  const finalized = finalizeSelectedBlindQuote({
    request,
    reservation,
    envelope,
    capabilityVerification: data.verifications[0],
    now: NOW,
    quotePolicy,
  });
  const authorized = await executionAuthorization(request, finalized);
  return { authorized, invoice, request, selection };
}

test("turns an authorized Lightning-to-BIT RFQ into the exact dual-signed vault intent", async (t) => {
  const fixture = await authorizedContractFixture(t, "lightning-to-bit");
  const prepared = prepareFinalizedContractIntent({
    bitcoinHeight: 900_000,
    finalization: fixture.authorized,
    invoice: fixture.invoice,
    invoicePolicy,
    now: NOW,
    settlementPolicy: TREE_SWAP_SETTLEMENT_POLICY_V1,
  });
  assert.equal(prepared.schema, "treeswap.prepared-contract-intent.v1");
  assert.equal(prepared.primaryType, "SelectedQuote");
  assert.equal(prepared.domain.name, "TreeSwap BIT Vault");
  assert.equal(prepared.domain.verifyingContract, LIGHTNING_TO_BIT);
  assert.equal(prepared.message.user, user.address);
  assert.equal(prepared.message.solver, solvers[0].address);
  assert.equal(prepared.message.beneficiary, privateRequest.beneficiary);
  assert.equal(prepared.message.nonce, privateRequest.nonce);
  assert.equal(prepared.message.amount - prepared.message.fee, privateRequest.exactBitOutputWei);
  assert.equal(prepared.digest, TypedDataEncoder.hash(prepared.domain, prepared.types, prepared.message));
  assert.ok(prepared.message.quoteExpiresAt < prepared.message.lastSafeClaimAt);
  assert.ok(prepared.message.lastSafeClaimAt < prepared.message.refundAfter);
  assert.equal(prepared.movesFundsImmediately, false);
  assert.equal(prepared.walletDispatchAuthority, false);
  assert.equal(prepared.lightningDispatchAuthority, false);

  const solverSignature = await solvers[0].signTypedData(
    prepared.domain,
    prepared.types,
    prepared.message,
  );
  const userSignature = await user.signTypedData(prepared.domain, prepared.types, prepared.message);
  assert.throws(() => authorizeFinalizedContractIntent({
    now: NOW,
    prepared,
    solverSignature: userSignature,
    userSignature,
  }), /solver contract intent signature belongs to another account/);
  assert.throws(() => authorizeFinalizedContractIntent({
    now: NOW,
    prepared: { ...prepared },
    solverSignature,
    userSignature,
  }), /original prepared RFQ artifact/);
  const authorized = authorizeFinalizedContractIntent({
    now: NOW,
    prepared,
    solverSignature,
    userSignature,
  });
  assert.equal(authorized.schema, "treeswap.authorized-contract-intent.v1");
  assert.equal(authorized.contractIntentDigest, prepared.digest);
  assert.equal(authorized.userAuthorizationDigest, fixture.authorized.userAuthorizationDigest);
  assert.equal(authorized.transaction.from, user.address);
  assert.equal(authorized.transaction.to, LIGHTNING_TO_BIT);
  assert.equal(authorized.transaction.value, "0x0");
  assert.equal(authorized.transaction.data.slice(0, 10), "0x688ff634");
  assert.equal(authorized.walletDispatchAuthority, false);
  assert.equal(authorized.lightningDispatchAuthority, false);
  assert.equal(verifiedAuthorizedContractIntent(authorized, { now: NOW + 1 }), authorized);
  assert.throws(
    () => verifiedAuthorizedContractIntent({ ...authorized }, { now: NOW + 1 }),
    /lacks verified RFQ and signature provenance/,
  );
});

test("turns an authorized BIT-to-Lightning RFQ into a solver-signed user escrow intent", async (t) => {
  const fixture = await authorizedContractFixture(t, "bit-to-lightning");
  const prepared = prepareFinalizedContractIntent({
    bitcoinHeight: 900_000,
    finalization: fixture.authorized,
    invoice: `lightning:${fixture.invoice.toUpperCase()}`,
    invoicePolicy,
    now: NOW,
    settlementPolicy: TREE_SWAP_SETTLEMENT_POLICY_V1,
  });
  assert.equal(prepared.primaryType, "BitToLightningQuote");
  assert.equal(prepared.domain.name, "TreeSwap User BIT Escrow");
  assert.equal(prepared.domain.verifyingContract, BIT_TO_LIGHTNING);
  assert.equal(prepared.message.user, user.address);
  assert.equal(prepared.message.solver, solvers[0].address);
  assert.equal(prepared.message.solverBeneficiary, solvers[0].address);
  assert.equal(prepared.message.solverNonce, fixture.authorized.envelope.offer.offerNonce);
  assert.equal(prepared.message.lightningAmountSats, bitToLightningRequest.exactLightningOutputSats);
  const solverSignature = await solvers[0].signTypedData(
    prepared.domain,
    prepared.types,
    prepared.message,
  );
  const unnecessaryUserSignature = await user.signTypedData(
    prepared.domain,
    prepared.types,
    prepared.message,
  );
  assert.throws(() => authorizeFinalizedContractIntent({
    now: NOW,
    prepared,
    solverSignature,
    userSignature: unnecessaryUserSignature,
  }), /must not carry a user contract signature/);
  const authorized = authorizeFinalizedContractIntent({
    now: NOW,
    prepared,
    solverSignature,
    userSignature: null,
  });
  assert.equal(authorized.userSignature, null);
  assert.equal(authorized.transaction.from, user.address);
  assert.equal(authorized.transaction.to, BIT_TO_LIGHTNING);
  assert.equal(authorized.transaction.data.slice(0, 10), "0xcd83331b");
  assert.equal(authorized.walletDispatchAuthority, false);
  assert.throws(() => prepareFinalizedContractIntent({
    bitcoinHeight: 900_000,
    finalization: fixture.authorized,
    invoice: `${fixture.invoice}changed`,
    invoicePolicy,
    now: NOW,
    settlementPolicy: TREE_SWAP_SETTLEMENT_POLICY_V1,
  }), /invoice validation failed/);
  assert.throws(() => prepareFinalizedContractIntent({
    bitcoinHeight: 900_000,
    finalization: fixture.authorized,
    invoice: fixture.invoice,
    invoicePolicy,
    now: NOW + 31,
    settlementPolicy: TREE_SWAP_SETTLEMENT_POLICY_V1,
  }), /required wallet submission window/);
});

async function executionCeremonyFixture(t, {
  onRequest = null,
  pricingRequest = pricing,
  privateSettlementRequest = privateRequest,
  routePolicy = privateCeremonyPolicy,
  solverInvoice = null,
} = {}) {
  const data = await collectedBlindBook({ pricingRequest });
  const selection = selectBlindQuote(data.book, data.book.offers[0].offer.offerId);
  const coordinatorStore = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const deployment = new AbortController();
  const service = createTestRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: data.verifications,
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: 4,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 137),
    signal: deployment.signal,
  });
  const selectionLease = claimRfqSelectionReservationOwnership(service, deployment.signal);
  const handoff = selectionLease.accept({
    expiresAt: NOW + 45,
    identityCommitment: id(`execution-ceremony:${pricingRequest.direction}`).toLowerCase(),
    requestNonce: "31",
    selection,
    user: user.address,
  });
  const firstPrompt = service.prepare({
    authorizationExpiresAt: NOW + 40,
    request: privateSettlementRequest,
    reservationToken: handoff.reservationToken,
  });
  service.reserve({
    authorization: firstPrompt.message,
    request: privateSettlementRequest,
    reservationToken: handoff.reservationToken,
    signature: await user.signTypedData(firstPrompt.domain, firstPrompt.types, firstPrompt.message),
  });

  const requesterKeys = generateKeyPairSync("ed25519");
  const requesterDigest = solverEndpointPublicKeyDigest(pem(requesterKeys));
  const invoice = pricingRequest.direction === "lightning-to-bit"
    ? solverInvoice ?? createBolt11Invoice({
        amountSats: BigInt(selection.selected.offer.lightningAmountSats),
        paymentHash: id("private-payment-0").toLowerCase(),
        paymentSecret: id("private-payment-secret-0").toLowerCase(),
        privateKey: lightningNodePrivateKeys[0],
        timestamp: NOW - 30,
      })
    : userInvoice;
  let requests = 0;
  const defaultResponse = async (options) => {
    const providerBinding = verifiedSolverQuoteBinding(data.verifications[0]);
    const providerRequest = verifySelectedSolverFinalizationRequest({
      request: JSON.parse(options.body),
      authority: {
        requesterPublicKeyDigest: requesterDigest,
        capabilityDigest: providerBinding.capabilityDigest,
        endpointPublicKeyDigest: providerBinding.endpointPublicKeyDigest,
        solverId: providerBinding.solverId,
        direction: providerBinding.direction,
      },
      now: NOW,
    });
    let envelope = await executableEnvelope(selection.selected.offer, 0, {
      request: privateSettlementRequest,
    });
    if (pricingRequest.direction === "lightning-to-bit") {
      const offer = { ...envelope.offer, invoiceDigest: invoiceDigest(invoice) };
      envelope = {
        offer,
        signature: await solvers[0].signTypedData(
          rfqDomain(privateSettlementRequest),
          EXECUTABLE_RFQ_OFFER_TYPES,
          offer,
        ),
      };
    }
    return jsonResponse(buildSignedSelectedSolverFinalizationResponse({
      request: providerRequest,
      invoice,
      envelope,
      servedAt: NOW,
      expiresAt: NOW + 15,
      endpointPrivateKey: endpointKeys[0].privateKey,
    }));
  };
  const client = createTestSelectedSolverFinalizationClient({
    requesterPrivateKey: requesterKeys.privateKey,
    signal: deployment.signal,
    nowSeconds: () => NOW,
    requestImpl: async (_url, options) => {
      requests += 1;
      const buildDefaultResponse = () => defaultResponse(options);
      return onRequest
        ? onRequest(Object.freeze({ buildDefaultResponse, options, requestNumber: requests }))
        : buildDefaultResponse();
    },
  });
  const route = createTestRfqExecutionCeremonyRoute({
    client,
    policy: routePolicy,
    quotePolicy,
    selectionReservation: service,
    signal: deployment.signal,
  });
  t.after(() => {
    deployment.abort();
    try { route.stop(); } catch {}
    try { coordinatorStore.close(); } catch {}
  });
  return {
    ...data,
    client,
    coordinatorStore,
    deployment,
    finalizeBody: {
      invoice: pricingRequest.direction === "lightning-to-bit" ? "" : invoice,
      request: privateSettlementRequest,
      reservationToken: handoff.reservationToken,
    },
    handoff,
    invoice,
    requests: () => requests,
    route,
    selection,
    service,
  };
}

test("projects authenticated competition into an opaque client-safe quote set", async () => {
  const { book } = await collectedBlindBook();
  let entropy = 0;
  const session = createTestClientSafeBlindQuoteSession({
    book,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, ++entropy),
  });
  assert.equal(isClientSafeBlindQuoteSession(session), true);
  assert.equal(isProductionClientSafeBlindQuoteSession(session), false);
  assert.equal(verifiedBlindQuoteBook(book), book);
  assert.throws(() => verifiedBlindQuoteBook({ ...book }), /authenticated complete delivery collection/);

  const preview = session.preview();
  assert.deepEqual(Object.keys(preview).sort(), [
    "direction", "exactOutput", "expiresAt", "marketRiskPolicyDigest", "offers", "outputUnit",
    "pricingDigest", "pricingId", "quoteCount", "receivedSetDigest", "schema",
  ].sort());
  assert.equal(preview.schema, "treeswap.client-safe-blind-quote-set.v1");
  assert.equal(preview.quoteCount, 2);
  assert.equal(preview.offers.length, 2);
  assert.deepEqual(Object.keys(preview.offers[0]).sort(), [
    "choiceId", "expiresAt", "feeBitAmount", "grossBitAmount", "lightningAmountSats",
    "maxRoutingFeeSats", "netBitAmount", "rank",
  ].sort());
  assert.match(preview.offers[0].choiceId, /^0x[0-9a-f]{64}$/);
  assert.notEqual(preview.offers[0].choiceId, preview.offers[1].choiceId);
  assert.equal(preview.offers[0].rank, 1);
  assert.equal(preview.offers[0].netBitAmount, pricing.exactOutput);
  assert.equal(preview.offers[0].lightningAmountSats, "10000");

  const publicWire = JSON.stringify(preview).toLowerCase();
  for (const envelope of book.offers) {
    for (const secret of [
      envelope.source,
      envelope.offer.offerId,
      envelope.offer.solver,
      envelope.offer.capabilityDigest,
      envelope.offer.capacitySnapshotDigest,
      envelope.offer.endpointPublicKeyDigest,
      envelope.offer.settlementContractCodeHash,
      envelope.signature,
    ]) {
      assert.equal(publicWire.includes(String(secret).toLowerCase()), false);
    }
  }
  for (const secret of ["relay-a", "relay-b", "direct-a", "direct-b", "availableBitWei", "availableLightningSats"]) {
    assert.equal(publicWire.includes(secret.toLowerCase()), false);
  }
  assert.deepEqual(session.status(), {
    schema: "treeswap.blind-quote-preview-status.v1",
    state: "active",
    mode: "injected-test",
    quoteCount: 2,
    fundingAuthorization: false,
    settlementAuthorization: false,
    networkListener: false,
  });
});

test("selects one original blind quote through an opaque one-use choice", async () => {
  const { book } = await collectedBlindBook();
  let entropy = 8;
  const session = createTestClientSafeBlindQuoteSession({
    book,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, ++entropy),
  });
  const preview = session.preview();
  const copied = { ...session };
  assert.throws(() => copied.preview(), /factory provenance/);
  const extracted = session.select;
  assert.throws(() => extracted({ choiceId: preview.offers[0].choiceId }), /factory provenance/);
  assert.throws(
    () => session.select({ choiceId: `0x${"ff".repeat(32)}` }),
    /not in the client preview/,
  );
  const selection = session.select({ choiceId: preview.offers[0].choiceId });
  assert.equal(selection.selected.offer.offerId, book.offers[0].offer.offerId);
  assert.equal(selection.receivedSetDigest, preview.receivedSetDigest);
  assert.equal(session.status().state, "selected");
  assert.equal(session.status().quoteCount, 0);
  assert.throws(
    () => session.select({ choiceId: preview.offers[1].choiceId }),
    /no longer active/,
  );
  assert.throws(
    () => createTestClientSafeBlindQuoteSession({
      book,
      nowSeconds: () => NOW,
      randomBytesImpl: () => Buffer.alloc(32, 22),
    }),
    /already has a client preview session/,
  );
});

test("fails closed on expiry, entropy faults, decorated choices, and closed sessions", async () => {
  const first = await collectedBlindBook();
  assert.throws(
    () => createTestClientSafeBlindQuoteSession({
      book: first.book,
      nowSeconds: () => Math.min(...first.book.offers.map(({ offer }) => offer.expiresAt)),
      randomBytesImpl: () => Buffer.alloc(32, 1),
    }),
    /expired or empty/,
  );

  const second = await collectedBlindBook();
  assert.throws(
    () => createTestClientSafeBlindQuoteSession({
      book: second.book,
      nowSeconds: () => NOW,
      randomBytesImpl: () => Buffer.alloc(31, 1),
    }),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => createTestClientSafeBlindQuoteSession({
      book: second.book,
      nowSeconds: () => NOW,
      randomBytesImpl: () => Buffer.alloc(32, 2),
    }),
    /entropy collided/,
  );

  const third = await collectedBlindBook();
  assert.throws(
    () => createTestClientSafeBlindQuoteSession({
      book: third.book,
      nowSeconds: () => NOW,
      randomBytesImpl: () => Buffer.alloc(32, 1),
      authority: true,
    }),
    /fields are not exact/,
  );
  let entropy = 31;
  let observedAt = NOW;
  const session = createTestClientSafeBlindQuoteSession({
    book: third.book,
    nowSeconds: () => observedAt,
    randomBytesImpl: () => Buffer.alloc(32, ++entropy),
  });
  const preview = session.preview();
  const choice = { choiceId: preview.offers[0].choiceId };
  Object.defineProperty(choice, "choiceId", {
    enumerable: true,
    get() {
      throw new Error("choice accessor executed");
    },
  });
  assert.throws(() => session.select(choice), /enumerable data properties/);
  const symbolicChoice = { choiceId: preview.offers[0].choiceId };
  symbolicChoice[Symbol("authority")] = true;
  assert.throws(() => session.select(symbolicChoice), /not exact data properties/);
  assert.throws(
    () => session.select(Object.create({ choiceId: preview.offers[0].choiceId })),
    /plain data object/,
  );
  observedAt = preview.expiresAt;
  assert.equal(session.status().state, "expired");
  assert.equal(session.status().quoteCount, 0);
  assert.throws(() => session.preview(), /no longer active/);
  assert.throws(
    () => session.select({ choiceId: preview.offers[0].choiceId }),
    /no longer active/,
  );
});

test("production preview sessions use module-owned time and entropy", async () => {
  const { book } = await collectedBlindBook();
  const session = createClientSafeBlindQuoteSession(book);
  assert.equal(isProductionClientSafeBlindQuoteSession(session), true);
  assert.equal(session.status().mode, "system-entropy");
  assert.match(session.preview().offers[0].choiceId, /^0x[0-9a-f]{64}$/);
  assert.equal(session.close().state, "closed");
});

test("authenticates quote ingress, exposes only opaque competition, and consumes selection once", async (t) => {
  const data = await quoteIngressFixture(t);
  const body = await signedQuoteIngressBody();
  const created = await data.route.handle(quoteIngressRequest("/v1/quotes", body));
  assert.equal(created.status, 200);
  assert.equal(created.headers.get("cache-control"), "no-store");
  assert.equal(created.headers.get("content-type"), "application/json");
  assert.equal(created.headers.get("x-content-type-options"), "nosniff");
  assert.equal(created.headers.get("x-frame-options"), "DENY");
  const payload = await created.json();
  assert.deepEqual(Object.keys(payload).sort(), [
    "fundingAuthorization", "preview", "schema", "sessionToken", "settlementAuthorization",
  ].sort());
  assert.equal(payload.schema, "treeswap.rfq-quote-ingress-response.v1");
  assert.equal(payload.fundingAuthorization, false);
  assert.equal(payload.settlementAuthorization, false);
  assert.match(payload.sessionToken, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(data.lastReaderPricing(), pricing);
  assert.equal(data.reads(), 1);

  const publicWire = JSON.stringify(payload).toLowerCase();
  for (const secret of [body.signature, body.authorization.user]) {
    assert.equal(publicWire.includes(secret.toLowerCase()), false);
  }
  for (const envelope of data.book.offers) {
    for (const secret of [
      envelope.source,
      envelope.offer.offerId,
      envelope.offer.solver,
      envelope.offer.capabilityDigest,
      envelope.offer.endpointPublicKeyDigest,
      envelope.signature,
    ]) assert.equal(publicWire.includes(String(secret).toLowerCase()), false);
  }

  const selected = await data.route.handle(quoteIngressRequest("/v1/quotes/select", {
    choiceId: payload.preview.offers[0].choiceId,
    sessionToken: payload.sessionToken,
  }));
  assert.equal(selected.status, 200);
  const selectionPayload = await selected.json();
  assert.deepEqual(selectionPayload, {
    schema: "treeswap.rfq-quote-selection-ack.v1",
    status: "selected",
    reservationToken: `0x${"6f".repeat(32)}`,
    expiresAt: payload.preview.expiresAt,
    privateSettlementRequired: true,
    fundingAuthorization: false,
    settlementAuthorization: false,
  });
  const signingPayload = data.selectionReservation.prepare({
    authorizationExpiresAt: NOW + 30,
    request: privateRequest,
    reservationToken: selectionPayload.reservationToken,
  });
  assert.equal(signingPayload.schema, "treeswap.selection-reservation-signing-payload.v1");
  assert.equal(signingPayload.primaryType, "UserSelectionAuthorization");
  assert.equal(JSON.stringify(signingPayload).includes(data.book.offers[0].signature), false);
  const selectionSignature = await user.signTypedData(
    signingPayload.domain,
    signingPayload.types,
    signingPayload.message,
  );
  assert.deepEqual(data.selectionReservation.reserve({
    authorization: signingPayload.message,
    request: privateRequest,
    reservationToken: selectionPayload.reservationToken,
    signature: selectionSignature,
  }), {
    schema: "treeswap.selection-reservation-ack.v1",
    status: "reserved",
    expiresAt: NOW + 30,
    privateExecutionRequired: true,
    fundingAuthorization: false,
    settlementAuthorization: false,
  });
  assert.equal(data.coordinatorStore.getFirmOffer(data.book.offers[0].offer.offerId).state, "ACTIVE");
  assert.equal((await data.route.handle(quoteIngressRequest("/v1/quotes", body))).status, 400);
  assert.equal((await data.route.handle(quoteIngressRequest("/v1/quotes/select", {
    choiceId: payload.preview.offers[0].choiceId,
    sessionToken: payload.sessionToken,
  }))).status, 400);
  assert.equal(data.reads(), 1);
  assert.deepEqual(data.route.status(), {
    schema: "treeswap.rfq-quote-ingress-status.v1",
    state: "active",
    mode: "injected-test",
    requestsStarted: 4,
    requestsAccepted: 1,
    requestsRejected: 2,
    requestsInFlight: 0,
    selectionsCompleted: 1,
    inMemoryReadySessions: 0,
    inMemorySelectedSessions: 0,
    durableLiveClaimedRequests: 0,
    durableLiveReadySessions: 0,
    fundingAuthorization: false,
    settlementAuthorization: false,
    signingAuthorization: false,
    networkListener: false,
  });
  assert.deepEqual(data.selectionReservation.status(), {
    schema: "treeswap.selection-reservation-status.v2",
    state: "active",
    mode: "injected-test",
    selectionsAccepted: 1,
    signingPayloadsPrepared: 1,
    reservationsCompleted: 1,
    requestsFailed: 0,
    pendingSelected: 0,
    pendingPrepared: 0,
    inMemoryReservations: 1,
    finalizationsInFlightOrRetryable: 0,
    executableQuotesFinalized: 0,
    executionAuthorizationsCompleted: 0,
    terminalFinalizationFailures: 0,
    fundingAuthorization: false,
    settlementAuthorization: false,
    signingAuthority: false,
    networkListener: false,
  });
});

test("serves the private selection ceremony without logging or inheriting reservation authority", async (t) => {
  const data = await quoteIngressFixture(t);
  const ceremony = createTestRfqPrivateCeremonyRoute({
    policy: privateCeremonyPolicy,
    selectionReservation: data.selectionReservation,
    signal: data.deployment.signal,
  });
  t.after(() => { try { ceremony.stop(); } catch {} });
  assert.equal(isRfqPrivateCeremonyRoute(ceremony), true);

  const quoteResponse = await data.route.handle(quoteIngressRequest(
    "/v1/quotes",
    await signedQuoteIngressBody(),
  ));
  const quotePayload = await quoteResponse.json();
  const selectionResponse = await data.route.handle(quoteIngressRequest("/v1/quotes/select", {
    choiceId: quotePayload.preview.offers[0].choiceId,
    sessionToken: quotePayload.sessionToken,
  }));
  const selection = await selectionResponse.json();
  const preparationBody = {
    authorizationExpiresAt: NOW + 30,
    request: privateRequest,
    reservationToken: selection.reservationToken,
  };
  assert.throws(
    () => data.selectionReservation.prepare(preparationBody),
    /ceremony is route-owned/,
  );
  assert.throws(
    () => data.selectionReservation.stop(),
    /lifecycle is route-owned/,
  );

  const preparedResponse = await ceremony.handle(privateCeremonyRequest(
    "/v1/selection/prepare",
    preparationBody,
  ));
  assert.equal(preparedResponse.status, 200);
  assert.equal(preparedResponse.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(preparedResponse.headers.get("pragma"), "no-cache");
  assert.equal(preparedResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(preparedResponse.headers.get("access-control-allow-origin"), QUOTE_CLIENT_ORIGIN);
  assert.equal(preparedResponse.headers.get("access-control-allow-credentials"), null);
  const signingPayload = await preparedResponse.json();
  assert.equal(signingPayload.schema, "treeswap.selection-reservation-signing-payload.v1");
  assert.equal(signingPayload.message.selectedSolver, data.book.offers[0].offer.solver);
  assert.equal(JSON.stringify(signingPayload).includes(data.book.offers[0].signature), false);

  const wrongSignature = await Wallet.createRandom().signTypedData(
    signingPayload.domain,
    signingPayload.types,
    signingPayload.message,
  );
  const wrongResponse = await ceremony.handle(privateCeremonyRequest(
    "/v1/selection/reserve",
    {
      authorization: signingPayload.message,
      request: privateRequest,
      reservationToken: selection.reservationToken,
      signature: wrongSignature,
    },
  ));
  assert.equal(wrongResponse.status, 400);
  const wrongWire = await wrongResponse.text();
  assert.equal(wrongWire.includes(selection.reservationToken), false);
  assert.equal(wrongWire.toLowerCase().includes(privateRequest.user.toLowerCase()), false);
  assert.equal(data.coordinatorStore.getFirmOffer(data.book.offers[0].offer.offerId), null);

  const signature = await user.signTypedData(
    signingPayload.domain,
    signingPayload.types,
    signingPayload.message,
  );
  const confirmationBody = {
    authorization: signingPayload.message,
    request: privateRequest,
    reservationToken: selection.reservationToken,
    signature,
  };
  const confirmed = await ceremony.handle(privateCeremonyRequest(
    "/v1/selection/reserve",
    confirmationBody,
  ));
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), {
    schema: "treeswap.selection-reservation-ack.v1",
    status: "reserved",
    expiresAt: NOW + 30,
    privateExecutionRequired: true,
    fundingAuthorization: false,
    settlementAuthorization: false,
  });
  assert.equal(data.coordinatorStore.getFirmOffer(data.book.offers[0].offer.offerId).state, "ACTIVE");
  const replay = await ceremony.handle(privateCeremonyRequest(
    "/v1/selection/reserve",
    confirmationBody,
  ));
  assert.equal(replay.status, 200);

  const status = ceremony.status();
  assert.deepEqual(status, {
    schema: "treeswap.rfq-private-ceremony-status.v1",
    state: "active",
    mode: "injected-test",
    requestsStarted: 4,
    requestsCompleted: 3,
    requestsRejected: 1,
    requestsInFlight: 0,
    signingPayloadsPrepared: 1,
    reservationsCompleted: 2,
    bearerTokensInStatus: false,
    privateTermsInStatus: false,
    networkListener: false,
    signingAuthority: false,
    fundingAuthorization: false,
    settlementAuthorization: false,
  });
  const statusWire = JSON.stringify(status).toLowerCase();
  for (const secret of [
    selection.reservationToken,
    privateRequest.requestId,
    privateRequest.user,
    privateRequest.beneficiary,
    signingPayload.message.selectedSolver,
    signature,
  ]) assert.equal(statusWire.includes(secret.toLowerCase()), false);
  assert.throws(() => createTestRfqPrivateCeremonyRoute({
    policy: privateCeremonyPolicy,
    selectionReservation: data.selectionReservation,
    signal: data.deployment.signal,
  }), /already route-bound/);
  const copied = { ...ceremony };
  await assert.rejects(
    copied.handle(privateCeremonyRequest("/v1/selection/prepare", preparationBody)),
    /factory provenance/,
  );
  const extracted = ceremony.handle;
  await assert.rejects(
    extracted(privateCeremonyRequest("/v1/selection/prepare", preparationBody)),
    /factory provenance/,
  );
});

test("fails the private ceremony closed on origins, headers, framing, fields, and preflight", async (t) => {
  const data = await quoteIngressFixture(t);
  const ceremony = createTestRfqPrivateCeremonyRoute({
    policy: privateCeremonyPolicy,
    selectionReservation: data.selectionReservation,
    signal: data.deployment.signal,
  });
  t.after(() => { try { ceremony.stop(); } catch {} });
  const preparation = {
    authorizationExpiresAt: NOW + 30,
    request: privateRequest,
    reservationToken: id("unavailable-private-ceremony-token").toLowerCase(),
  };

  const preflight = await ceremony.handle(new Request(
    `${CEREMONY_API_ORIGIN}/v1/selection/prepare`,
    {
      method: "OPTIONS",
      headers: {
        "access-control-request-headers": "Content-Type, Cache-Control",
        "access-control-request-method": "POST",
        origin: QUOTE_CLIENT_ORIGIN,
      },
    },
  ));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "cache-control, content-type");
  assert.equal(preflight.headers.get("access-control-max-age"), "0");

  for (const request of [
    privateCeremonyRequest("/v1/selection/prepare", preparation, {
      origin: "https://other-api.treeswap.example",
    }),
    privateCeremonyRequest("/v1/selection/prepare?token=secret", preparation),
    privateCeremonyRequest("/v1/selection/prepare", preparation, {
      headers: { origin: "https://evil.example" },
    }),
    privateCeremonyRequest("/v1/selection/prepare", preparation, {
      headers: { authorization: "Bearer leaked" },
    }),
    privateCeremonyRequest("/v1/selection/prepare", preparation, {
      headers: { cookie: "reservation=leaked" },
    }),
    privateCeremonyRequest("/v1/selection/prepare", preparation, {
      headers: { "cache-control": "" },
    }),
    privateCeremonyRequest("/v1/selection/prepare", { ...preparation, extra: true }),
    privateCeremonyRequest("/v1/selection/prepare", Buffer.alloc(32_769, 1)),
    privateCeremonyRequest("/v1/selection/prepare", preparation, { method: "GET" }),
  ]) {
    const response = await ceremony.handle(request);
    assert.equal(response.status, 400);
    const wire = await response.text();
    assert.equal(wire.includes(preparation.reservationToken), false);
    assert.equal(wire.includes("Bearer leaked"), false);
  }

  const invalidPreflight = await ceremony.handle(new Request(
    `${CEREMONY_API_ORIGIN}/v1/selection/prepare`,
    {
      method: "OPTIONS",
      headers: {
        "access-control-request-headers": "Content-Type, Authorization",
        "access-control-request-method": "POST",
        origin: QUOTE_CLIENT_ORIGIN,
      },
    },
  ));
  assert.equal(invalidPreflight.status, 400);
  assert.equal(invalidPreflight.headers.get("access-control-allow-credentials"), null);
  const privateNetworkPreflight = await ceremony.handle(new Request(
    `${CEREMONY_API_ORIGIN}/v1/selection/prepare`,
    {
      method: "OPTIONS",
      headers: {
        "access-control-request-headers": "Content-Type, Cache-Control",
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
        origin: QUOTE_CLIENT_ORIGIN,
      },
    },
  ));
  assert.equal(privateNetworkPreflight.status, 400);
});

test("bounds stalled private-ceremony bodies and shares deployment shutdown", async (t) => {
  const data = await quoteIngressFixture(t);
  const ceremony = createTestRfqPrivateCeremonyRoute({
    policy: {
      ...privateCeremonyPolicy,
      maximumInFlightRequests: 1,
      maximumProcessingMilliseconds: 250,
    },
    selectionReservation: data.selectionReservation,
    signal: data.deployment.signal,
  });
  t.after(() => { try { ceremony.stop(); } catch {} });
  let cancelled = false;
  const neverEndingBody = new ReadableStream({
    start() {},
    cancel() { cancelled = true; },
  });
  const request = new Request(`${CEREMONY_API_ORIGIN}/v1/selection/prepare`, {
    method: "POST",
    headers: {
      "cache-control": "no-store",
      "content-length": "10",
      "content-type": "application/json",
      origin: QUOTE_CLIENT_ORIGIN,
    },
    body: neverEndingBody,
    duplex: "half",
  });
  const startedAt = Date.now();
  const stalled = ceremony.handle(request);
  assert.equal((await ceremony.handle(privateCeremonyRequest(
    "/v1/selection/prepare",
    {
      authorizationExpiresAt: NOW + 30,
      request: privateRequest,
      reservationToken: id("saturated-private-ceremony-token").toLowerCase(),
    },
  ))).status, 400);
  assert.equal(cancelled, false);
  assert.equal((await stalled).status, 400);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(cancelled, true);
  assert.equal(ceremony.status().requestsInFlight, 0);
  data.deployment.abort();
  assert.equal(ceremony.status().state, "stopped");
  assert.equal(data.selectionReservation.status().state, "stopped");
  assert.equal((await ceremony.handle(privateCeremonyRequest(
    "/v1/selection/prepare",
    {
      authorizationExpiresAt: NOW + 30,
      request: privateRequest,
      reservationToken: id("stopped-private-ceremony-token").toLowerCase(),
    },
  ))).status, 400);
});

test("keeps sibling ceremony leases active until the shared route lifecycle closes", async (t) => {
  const data = await quoteIngressFixture(t);
  const selectionCeremony = createTestRfqPrivateCeremonyRoute({
    policy: privateCeremonyPolicy,
    selectionReservation: data.selectionReservation,
    signal: data.deployment.signal,
  });
  const requesterKeys = generateKeyPairSync("ed25519");
  const client = createTestSelectedSolverFinalizationClient({
    requesterPrivateKey: requesterKeys.privateKey,
    signal: data.deployment.signal,
    nowSeconds: () => NOW,
    requestImpl: async () => { throw new Error("unreachable sibling route transport"); },
  });
  const executionCeremony = createTestRfqExecutionCeremonyRoute({
    client,
    policy: privateCeremonyPolicy,
    quotePolicy,
    selectionReservation: data.selectionReservation,
    signal: data.deployment.signal,
  });
  t.after(() => {
    try { executionCeremony.stop(); } catch {}
    try { selectionCeremony.stop(); } catch {}
  });

  assert.equal(executionCeremony.stop().state, "stopped");
  assert.equal(data.selectionReservation.status().state, "active");
  assert.equal(selectionCeremony.stop().state, "stopped");
  assert.equal(data.selectionReservation.status().state, "active");
  assert.equal(data.route.stop().state, "stopped");
  assert.equal(data.selectionReservation.status().state, "stopped");
});

test("hands one original selection into user-authorized durable reservation without bearer-token griefing", async (t) => {
  const data = await collectedBlindBook();
  const selection = selectBlindQuote(data.book, data.book.offers[0].offer.offerId);
  const coordinatorStore = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const deployment = new AbortController();
  assert.throws(() => createTestRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: [{ ...data.verifications[0] }, data.verifications[1]],
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: 4,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 130),
    signal: deployment.signal,
  }), /locally verified capability/);
  let policyAccessorRead = false;
  const accessorPolicy = { ...admissionPolicy };
  Object.defineProperty(accessorPolicy, "minimumNotionalSats", {
    enumerable: true,
    get() {
      policyAccessorRead = true;
      throw new Error("admission policy accessor executed");
    },
  });
  assert.throws(() => createTestRfqSelectionReservationService({
    admissionPolicy: accessorPolicy,
    capabilityVerifications: data.verifications,
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: 4,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 130),
    signal: deployment.signal,
  }), /enumerable data properties/);
  assert.equal(policyAccessorRead, false);
  const service = createTestRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: data.verifications,
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: 4,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 131),
    signal: deployment.signal,
  });
  t.after(() => {
    deployment.abort();
    try { coordinatorStore.close(); } catch {}
  });
  const lease = claimRfqSelectionReservationOwnership(service, deployment.signal);
  const copiedLease = { ...lease };
  assert.throws(() => copiedLease.accept({}), /route lease lacks factory provenance/);
  const extractedAccept = lease.accept;
  assert.throws(() => extractedAccept({}), /route lease lacks factory provenance/);
  assert.throws(() => lease.accept({
    expiresAt: NOW + 60,
    identityCommitment: id("selection-reservation-identity").toLowerCase(),
    requestNonce: "17",
    selection: { ...selection },
    user: user.address,
  }), /locally verified blind quote book/);
  let accessorRead = false;
  const accessorSelection = {};
  Object.defineProperty(accessorSelection, "selected", {
    enumerable: true,
    get() {
      accessorRead = true;
      throw new Error("selection accessor executed");
    },
  });
  assert.throws(() => lease.accept({
    expiresAt: NOW + 60,
    identityCommitment: id("selection-reservation-identity").toLowerCase(),
    requestNonce: "17",
    selection: accessorSelection,
    user: user.address,
  }), /locally verified blind quote book/);
  assert.equal(accessorRead, false);

  const handoff = lease.accept({
    expiresAt: NOW + 40,
    identityCommitment: id("selection-reservation-identity").toLowerCase(),
    requestNonce: "17",
    selection,
    user: user.address,
  });
  assert.deepEqual(Object.keys(handoff).sort(), [
    "expiresAt", "fundingAuthorization", "privateSettlementRequired", "reservationToken",
    "settlementAuthorization",
  ].sort());
  assert.match(handoff.reservationToken, /^0x[0-9a-f]{64}$/);
  const copiedService = { ...service };
  assert.throws(() => copiedService.prepare({
    authorizationExpiresAt: NOW + 30,
    request: privateRequest,
    reservationToken: handoff.reservationToken,
  }), /factory provenance/);

  const griefRequest = {
    ...privateRequest,
    beneficiary: "0x6666666666666666666666666666666666666666",
  };
  const griefPayload = service.prepare({
    authorizationExpiresAt: NOW + 25,
    request: griefRequest,
    reservationToken: handoff.reservationToken,
  });
  const signingPayload = service.prepare({
    authorizationExpiresAt: NOW + 30,
    request: privateRequest,
    reservationToken: handoff.reservationToken,
  });
  assert.notEqual(griefPayload.digest, signingPayload.digest);
  assert.equal(coordinatorStore.getRfqRequest(selection.pricingId), null);

  let requestAccessorRead = false;
  const accessorRequest = { ...privateRequest };
  Object.defineProperty(accessorRequest, "beneficiary", {
    enumerable: true,
    get() {
      requestAccessorRead = true;
      throw new Error("private request accessor executed");
    },
  });
  assert.throws(() => service.prepare({
    authorizationExpiresAt: NOW + 30,
    request: accessorRequest,
    reservationToken: handoff.reservationToken,
  }), /enumerable data properties/);
  assert.equal(requestAccessorRead, false);

  const wrongSigner = Wallet.createRandom();
  const wrongSignature = await wrongSigner.signTypedData(
    signingPayload.domain,
    signingPayload.types,
    signingPayload.message,
  );
  assert.throws(() => service.reserve({
    authorization: signingPayload.message,
    request: privateRequest,
    reservationToken: handoff.reservationToken,
    signature: wrongSignature,
  }), /signer does not match/);
  assert.equal(coordinatorStore.getRfqRequest(selection.pricingId), null);
  assert.equal(coordinatorStore.getSolverCapacity(selection.selected.offer.solver.toLowerCase()), null);

  const extended = buildBlindQuoteSelectionAuthorization({
    selection,
    request: privateRequest,
    authorizationExpiresAt: NOW + 50,
  });
  const extendedSignature = await user.signTypedData(
    extended.domain,
    extended.types,
    extended.message,
  );
  assert.throws(() => service.reserve({
    authorization: extended.message,
    request: privateRequest,
    reservationToken: handoff.reservationToken,
    signature: extendedSignature,
  }), /outlives the reservation ceremony/);
  assert.equal(coordinatorStore.getRfqRequest(selection.pricingId), null);

  const signature = await user.signTypedData(
    signingPayload.domain,
    signingPayload.types,
    signingPayload.message,
  );
  const input = {
    authorization: signingPayload.message,
    request: privateRequest,
    reservationToken: handoff.reservationToken,
    signature,
  };
  const reserved = service.reserve(input);
  assert.deepEqual(service.reserve(input), reserved);
  assert.equal(reserved.expiresAt, NOW + 30);
  assert.equal(coordinatorStore.getFirmOffer(selection.selected.offer.offerId).state, "ACTIVE");
  assert.throws(() => service.prepare({
    authorizationExpiresAt: NOW + 30,
    request: privateRequest,
    reservationToken: handoff.reservationToken,
  }), /already durable/);
  const status = service.status();
  assert.equal(JSON.stringify(status).includes(handoff.reservationToken), false);
  assert.equal(status.selectionsAccepted, 1);
  assert.equal(status.signingPayloadsPrepared, 2);
  assert.equal(status.reservationsCompleted, 1);
  assert.equal(status.requestsFailed, 4);
  assert.equal(status.inMemoryReservations, 1);
  coordinatorStore.getFirmOffer = () => ({ state: "ACTIVE" });
  assert.throws(() => service.reserve(input), /unmodified coordinator store methods/);
  delete coordinatorStore.getFirmOffer;
  assert.deepEqual(service.reserve(input), reserved);
  deployment.abort();
  assert.equal(service.status().state, "stopped");
  assert.throws(() => service.reserve(input), /stopped/);
});

test("reserves BIT-to-Lightning output and routing headroom through the same selection handoff", async (t) => {
  const data = await collectedBlindBook({ pricingRequest: bitToLightningPricing });
  const selection = selectBlindQuote(data.book, data.book.offers[0].offer.offerId);
  const coordinatorStore = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const deployment = new AbortController();
  const service = createTestRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: data.verifications,
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: 4,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 132),
    signal: deployment.signal,
  });
  t.after(() => {
    deployment.abort();
    try { coordinatorStore.close(); } catch {}
  });
  const lease = claimRfqSelectionReservationOwnership(service, deployment.signal);
  const handoff = lease.accept({
    expiresAt: NOW + 60,
    identityCommitment: id("selection-reservation-bit-to-lightning-identity").toLowerCase(),
    requestNonce: "19",
    selection,
    user: user.address,
  });
  const signingPayload = service.prepare({
    authorizationExpiresAt: NOW + 30,
    request: bitToLightningRequest,
    reservationToken: handoff.reservationToken,
  });
  const signature = await user.signTypedData(
    signingPayload.domain,
    signingPayload.types,
    signingPayload.message,
  );
  const ack = service.reserve({
    authorization: signingPayload.message,
    request: bitToLightningRequest,
    reservationToken: handoff.reservationToken,
    signature,
  });
  assert.equal(ack.status, "reserved");
  const firm = coordinatorStore.getFirmOffer(selection.selected.offer.offerId);
  assert.equal(firm.state, "ACTIVE");
  assert.equal(
    firm.lightningAmountSats,
    String(selection.selected.offer.lightningAmountSats + selection.selected.offer.maxRoutingFeeSats),
  );
  assert.equal(firm.bitAmountWei, "0");
});

test("carries one durable reservation through authenticated solver finalization and exact second user authorization", async (t) => {
  const data = await collectedBlindBook();
  const selection = selectBlindQuote(data.book, data.book.offers[0].offer.offerId);
  const coordinatorStore = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const deployment = new AbortController();
  const service = createTestRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: data.verifications,
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: 4,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 133),
    signal: deployment.signal,
  });
  const selectionLease = claimRfqSelectionReservationOwnership(service, deployment.signal);
  const handoff = selectionLease.accept({
    expiresAt: NOW + 45,
    identityCommitment: id("selected-solver-finalization-identity").toLowerCase(),
    requestNonce: "23",
    selection,
    user: user.address,
  });
  const firstPrompt = service.prepare({
    authorizationExpiresAt: NOW + 40,
    request: privateRequest,
    reservationToken: handoff.reservationToken,
  });
  const firstSignature = await user.signTypedData(
    firstPrompt.domain,
    firstPrompt.types,
    firstPrompt.message,
  );
  service.reserve({
    authorization: firstPrompt.message,
    request: privateRequest,
    reservationToken: handoff.reservationToken,
    signature: firstSignature,
  });

  const requesterKeys = generateKeyPairSync("ed25519");
  const requesterDigest = solverEndpointPublicKeyDigest(pem(requesterKeys));
  const solverInvoice = createBolt11Invoice({
    amountSats: BigInt(selection.selected.offer.lightningAmountSats),
    paymentHash: id("private-payment-0").toLowerCase(),
    paymentSecret: id("private-payment-secret-durable-0").toLowerCase(),
    privateKey: lightningNodePrivateKeys[0],
    timestamp: NOW - 30,
  });
  let requests = 0;
  let requestBody = null;
  let providerFailure = null;
  const client = createTestSelectedSolverFinalizationClient({
    requesterPrivateKey: requesterKeys.privateKey,
    signal: deployment.signal,
    nowSeconds: () => NOW,
    requestImpl: async (_url, options) => {
      try {
        requests += 1;
        requestBody = requestBody ?? options.body;
        assert.equal(options.body, requestBody);
        const providerBinding = verifiedSolverQuoteBinding(data.verifications[0]);
        const providerRequest = verifySelectedSolverFinalizationRequest({
          request: JSON.parse(options.body),
          authority: {
            requesterPublicKeyDigest: requesterDigest,
            capabilityDigest: providerBinding.capabilityDigest,
            endpointPublicKeyDigest: providerBinding.endpointPublicKeyDigest,
            solverId: providerBinding.solverId,
            direction: providerBinding.direction,
          },
          now: NOW,
        });
        const offer = {
          ...(await executableEnvelope(selection.selected.offer, 0)).offer,
          invoiceDigest: invoiceDigest(solverInvoice),
        };
        const executable = {
          offer,
          signature: await solvers[0].signTypedData(
            rfqDomain(privateRequest),
            EXECUTABLE_RFQ_OFFER_TYPES,
            offer,
          ),
        };
        return jsonResponse(buildSignedSelectedSolverFinalizationResponse({
          request: providerRequest,
          invoice: solverInvoice,
          envelope: executable,
          servedAt: NOW,
          expiresAt: NOW + 30,
          endpointPrivateKey: endpointKeys[0].privateKey,
        }));
      } catch (error) {
        providerFailure = error;
        throw error;
      }
    },
  });
  const wrongLifecycle = new AbortController();
  const wrongLifecycleClient = createTestSelectedSolverFinalizationClient({
    requesterPrivateKey: requesterKeys.privateKey,
    signal: wrongLifecycle.signal,
    nowSeconds: () => NOW,
    requestImpl: async () => { throw new Error("unreachable"); },
  });
  assert.throws(() => claimRfqSelectedSolverFinalizationOwnership(service, {
    client: wrongLifecycleClient,
    quotePolicy,
    signal: deployment.signal,
  }), /share one active deployment lifecycle/);
  wrongLifecycle.abort();
  const finalizationLease = claimRfqSelectedSolverFinalizationOwnership(service, {
    client,
    quotePolicy,
    signal: deployment.signal,
  });
  t.after(() => {
    deployment.abort();
    try { coordinatorStore.close(); } catch {}
  });

  let secondPrompt;
  try {
    secondPrompt = await finalizationLease.finalize({
      invoice: "",
      request: privateRequest,
      reservationToken: handoff.reservationToken,
    });
  } catch (error) {
    throw providerFailure ?? error;
  }
  assert.equal(secondPrompt.primaryType, "UserExecutionAuthorization");
  assert.equal(secondPrompt.invoice, solverInvoice);
  assert.equal(secondPrompt.settlementAuthorization, true);
  assert.equal(secondPrompt.movesFundsImmediately, false);
  assert.equal(requests, 1);
  assert.equal(service.status().executableQuotesFinalized, 1);
  assert.equal(
    coordinatorStore.getFirmOffer(selection.selected.offer.offerId).privateRequestDigest,
    secondPrompt.message.requestDigest,
  );

  const secondSignature = await user.signTypedData(
    secondPrompt.domain,
    secondPrompt.types,
    secondPrompt.message,
  );
  const ack = finalizationLease.authorize({
    authorization: secondPrompt.message,
    request: privateRequest,
    reservationToken: handoff.reservationToken,
    signature: secondSignature,
  });
  assert.equal(ack.schema, "treeswap.selected-solver-authorization-ack.v2");
  assert.equal(ack.status, "authorized");
  assert.equal(ack.settlementStatus, "accepted");
  assert.equal(ack.settlementId, privateRequest.requestId);
  assert.equal(ack.invoice, solverInvoice);
  assert.equal(ack.paymentHash, id("private-payment-0"));
  assert.equal(ack.evmReservationAuthority, false);
  assert.equal(ack.lightningDispatchAuthority, false);
  assert.equal(ack.settlementDispatchAuthority, false);
  assert.equal(service.status().executionAuthorizationsCompleted, 1);
  assert.equal(
    coordinatorStore.getFirmOffer(selection.selected.offer.offerId).executionAuthorizationDigest,
    secondPrompt.digest,
  );
  const settlement = coordinatorStore.getSettlement(privateRequest.requestId);
  assert.equal(settlement.state, "INTENT_ACCEPTED");
  assert.equal(settlement.pricingId, selection.pricingId);
  assert.equal(settlement.nonceAuthorityDigest, firstPrompt.digest);
  assert.equal(settlement.intentNonce, privateRequest.nonce.toString());
  assert.equal(settlement.intentDigest, secondPrompt.digest);
  assert.equal(settlement.paymentHash, id("private-payment-0"));
  assert.equal(settlement.invoiceDigest, secondPrompt.message.invoiceDigest);
  assert.equal(settlement.quoteReceiptDigest, selection.receivedSetDigest);
  assert.equal(settlement.selectedSetDigest, selection.selectedBlindOfferDigest);
  assert.equal(settlement.selectedOfferId, selection.selected.offer.offerId);
  assert.equal(settlement.recordDigest, ack.settlementRecordDigest);
  assert.equal(settlement.reservationId, null);
  assert.deepEqual(coordinatorStore.listSettlementActions(settlement.settlementId), []);
  const contractIntent = finalizationLease.prepareContractIntent({
    bitcoinHeight: 900_000,
    reservationToken: handoff.reservationToken,
    settlementPolicy: TREE_SWAP_SETTLEMENT_POLICY_V1,
  });
  assert.equal(contractIntent.primaryType, "SelectedQuote");
  assert.equal(contractIntent.userAuthorizationDigest, secondPrompt.digest);
  assert.equal(contractIntent.walletDispatchAuthority, false);
  assert.equal(finalizationLease.prepareContractIntent({
    bitcoinHeight: 900_000,
    reservationToken: handoff.reservationToken,
    settlementPolicy: TREE_SWAP_SETTLEMENT_POLICY_V1,
  }), contractIntent);
  assert.throws(() => finalizationLease.prepareContractIntent({
    bitcoinHeight: 900_001,
    reservationToken: handoff.reservationToken,
    settlementPolicy: TREE_SWAP_SETTLEMENT_POLICY_V1,
  }), /Bitcoin height changed/);
  assert.deepEqual(await finalizationLease.finalize({
    invoice: "",
    request: privateRequest,
    reservationToken: handoff.reservationToken,
  }), ack);
  assert.equal(requests, 1);
  const copied = { ...finalizationLease };
  await assert.rejects(() => copied.finalize({}), /lease lacks factory provenance/);
});

test("keeps the user's BIT-to-Lightning invoice fixed through selected-solver finalization", async (t) => {
  const data = await collectedBlindBook({ pricingRequest: bitToLightningPricing });
  const selection = selectBlindQuote(data.book, data.book.offers[0].offer.offerId);
  const coordinatorStore = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const deployment = new AbortController();
  const service = createTestRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: data.verifications,
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: 4,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 134),
    signal: deployment.signal,
  });
  const selectionLease = claimRfqSelectionReservationOwnership(service, deployment.signal);
  const handoff = selectionLease.accept({
    expiresAt: NOW + 45,
    identityCommitment: id("selected-solver-bit-to-lightning-finalization").toLowerCase(),
    requestNonce: "29",
    selection,
    user: user.address,
  });
  const firstPrompt = service.prepare({
    authorizationExpiresAt: NOW + 40,
    request: bitToLightningRequest,
    reservationToken: handoff.reservationToken,
  });
  service.reserve({
    authorization: firstPrompt.message,
    request: bitToLightningRequest,
    reservationToken: handoff.reservationToken,
    signature: await user.signTypedData(firstPrompt.domain, firstPrompt.types, firstPrompt.message),
  });

  const requesterKeys = generateKeyPairSync("ed25519");
  const requesterDigest = solverEndpointPublicKeyDigest(pem(requesterKeys));
  const client = createTestSelectedSolverFinalizationClient({
    requesterPrivateKey: requesterKeys.privateKey,
    signal: deployment.signal,
    nowSeconds: () => NOW,
    requestImpl: async (_url, options) => {
      const providerBinding = verifiedSolverQuoteBinding(data.verifications[0]);
      const providerRequest = verifySelectedSolverFinalizationRequest({
        request: JSON.parse(options.body),
        authority: {
          requesterPublicKeyDigest: requesterDigest,
          capabilityDigest: providerBinding.capabilityDigest,
          endpointPublicKeyDigest: providerBinding.endpointPublicKeyDigest,
          solverId: providerBinding.solverId,
          direction: providerBinding.direction,
        },
        now: NOW,
      });
      return jsonResponse(buildSignedSelectedSolverFinalizationResponse({
        request: providerRequest,
        invoice: userInvoice,
        envelope: await executableEnvelope(selection.selected.offer, 0, { request: bitToLightningRequest }),
        servedAt: NOW,
        expiresAt: NOW + 15,
        endpointPrivateKey: endpointKeys[0].privateKey,
      }));
    },
  });
  const finalizationLease = claimRfqSelectedSolverFinalizationOwnership(service, {
    client,
    quotePolicy,
    signal: deployment.signal,
  });
  t.after(() => {
    deployment.abort();
    try { coordinatorStore.close(); } catch {}
  });
  const secondPrompt = await finalizationLease.finalize({
    invoice: `lightning:${userInvoice.toUpperCase()}`,
    request: bitToLightningRequest,
    reservationToken: handoff.reservationToken,
  });
  assert.equal(secondPrompt.invoice, userInvoice);
  assert.equal(secondPrompt.message.invoiceDigest, bitToLightningRequest.invoiceDigest);
  assert.equal(secondPrompt.message.paymentHash, bitToLightningRequest.paymentHash);
  const ack = finalizationLease.authorize({
    authorization: secondPrompt.message,
    request: bitToLightningRequest,
    reservationToken: handoff.reservationToken,
    signature: await user.signTypedData(secondPrompt.domain, secondPrompt.types, secondPrompt.message),
  });
  assert.equal(ack.direction, "bit-to-lightning");
  assert.equal(ack.settlementStatus, "accepted");
  assert.equal(ack.settlementId, bitToLightningRequest.requestId);
  assert.equal(ack.invoice, userInvoice);
  assert.equal(ack.invoiceDigest, bitToLightningRequest.invoiceDigest);
  assert.equal(ack.paymentHash, bitToLightningRequest.paymentHash);
  const settlement = coordinatorStore.getSettlement(bitToLightningRequest.requestId);
  assert.equal(settlement.state, "INTENT_ACCEPTED");
  assert.equal(settlement.amountSats, bitToLightningRequest.exactLightningOutputSats.toString());
  assert.equal(settlement.quoteReceiptDigest, selection.receivedSetDigest);
  assert.equal(settlement.selectedSetDigest, selection.selectedBlindOfferDigest);
  assert.equal(settlement.reservationId, null);
  assert.deepEqual(coordinatorStore.listSettlementActions(settlement.settlementId), []);
});

test("serves selected-solver finalization and exact second authorization through the private browser route", async (t) => {
  const data = await executionCeremonyFixture(t);
  assert.equal(isRfqExecutionCeremonyRoute(data.route), true);
  assert.throws(() => data.service.stop(), /lifecycle is route-owned/);
  assert.throws(() => createRfqExecutionCeremonyRoute({
    client: data.client,
    policy: privateCeremonyPolicy,
    quotePolicy,
    selectionReservation: data.service,
    signal: data.deployment.signal,
  }), /matching reservation service/);
  assert.throws(() => createTestRfqExecutionCeremonyRoute({
    client: data.client,
    policy: privateCeremonyPolicy,
    quotePolicy,
    selectionReservation: data.service,
    signal: data.deployment.signal,
  }), /already route-bound/);

  const finalized = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  assert.equal(finalized.status, 200);
  assert.equal(finalized.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(finalized.headers.get("access-control-allow-origin"), QUOTE_CLIENT_ORIGIN);
  assert.equal(finalized.headers.get("access-control-allow-credentials"), null);
  const prompt = await finalized.json();
  assert.equal(prompt.schema, "treeswap.selected-solver-execution-signing-payload.v1");
  assert.equal(prompt.invoice, data.invoice);
  assert.equal(prompt.message.selectedSolver, data.selection.selected.offer.solver);
  assert.equal(prompt.movesFundsImmediately, false);
  assert.equal(prompt.requiresSeparateAssetAction, true);
  assert.equal(data.requests(), 1);

  const wrongSignature = await Wallet.createRandom().signTypedData(
    prompt.domain,
    prompt.types,
    prompt.message,
  );
  const wrong = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/authorize",
    {
      authorization: prompt.message,
      request: privateRequest,
      reservationToken: data.handoff.reservationToken,
      signature: wrongSignature,
    },
  ));
  assert.equal(wrong.status, 400);
  const wrongWire = await wrong.text();
  assert.equal(wrongWire.includes(data.handoff.reservationToken), false);
  assert.equal(wrongWire.toLowerCase().includes(privateRequest.user.toLowerCase()), false);

  const signature = await user.signTypedData(prompt.domain, prompt.types, prompt.message);
  const authorized = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/authorize",
    {
      authorization: prompt.message,
      request: privateRequest,
      reservationToken: data.handoff.reservationToken,
      signature,
    },
  ));
  assert.equal(authorized.status, 200);
  const ack = await authorized.json();
  assert.equal(ack.schema, "treeswap.selected-solver-authorization-ack.v2");
  assert.equal(ack.status, "authorized");
  assert.equal(ack.settlementStatus, "accepted");
  assert.equal(ack.settlementId, privateRequest.requestId);
  assert.equal(ack.invoice, data.invoice);
  assert.equal(ack.evmReservationAuthority, false);
  assert.equal(ack.lightningDispatchAuthority, false);
  assert.equal(ack.settlementDispatchAuthority, false);
  const acceptedSettlement = data.coordinatorStore.getSettlement(privateRequest.requestId);
  assert.equal(acceptedSettlement.state, "INTENT_ACCEPTED");
  assert.equal(acceptedSettlement.recordDigest, ack.settlementRecordDigest);
  assert.equal(acceptedSettlement.reservationId, null);
  assert.deepEqual(data.coordinatorStore.listSettlementActions(ack.settlementId), []);

  const replay = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), ack);
  assert.equal(data.requests(), 1);
  const status = data.route.status();
  assert.deepEqual(status, {
    schema: "treeswap.rfq-execution-ceremony-status.v1",
    state: "active",
    mode: "injected-test",
    requestsStarted: 4,
    requestsCompleted: 3,
    requestsRejected: 1,
    requestsPending: 0,
    requestsInFlight: 0,
    finalizationsInFlight: 0,
    executionSigningPayloadsPrepared: 1,
    executionAuthorizationsCompleted: 1,
    bearerTokensInStatus: false,
    privateTermsInStatus: false,
    networkListener: false,
    signingAuthority: false,
    fundingAuthorization: false,
    settlementDispatchAuthority: false,
  });
  const statusWire = JSON.stringify(status).toLowerCase();
  for (const secret of [
    data.handoff.reservationToken,
    privateRequest.requestId,
    privateRequest.user,
    privateRequest.beneficiary,
    prompt.message.selectedSolver,
    data.invoice,
    signature,
  ]) assert.equal(statusWire.includes(secret.toLowerCase()), false);
  const copied = { ...data.route };
  await assert.rejects(
    copied.handle(privateCeremonyRequest("/v1/selection/finalize", data.finalizeBody)),
    /factory provenance/,
  );
});

test("preserves the user invoice through the BIT-to-Lightning browser finalization route", async (t) => {
  const data = await executionCeremonyFixture(t, {
    pricingRequest: bitToLightningPricing,
    privateSettlementRequest: bitToLightningRequest,
  });
  const finalized = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  assert.equal(finalized.status, 200);
  const prompt = await finalized.json();
  assert.equal(prompt.invoice, userInvoice);
  assert.equal(prompt.message.invoiceDigest, bitToLightningRequest.invoiceDigest);
  assert.equal(prompt.message.paymentHash, bitToLightningRequest.paymentHash);
  const authorized = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/authorize",
    {
      authorization: prompt.message,
      request: bitToLightningRequest,
      reservationToken: data.handoff.reservationToken,
      signature: await user.signTypedData(prompt.domain, prompt.types, prompt.message),
    },
  ));
  assert.equal(authorized.status, 200);
  const ack = await authorized.json();
  assert.equal(ack.direction, "bit-to-lightning");
  assert.equal(ack.settlementStatus, "accepted");
  assert.equal(ack.settlementId, bitToLightningRequest.requestId);
  assert.equal(ack.invoice, userInvoice);
  assert.equal(ack.invoiceDigest, bitToLightningRequest.invoiceDigest);
  assert.equal(ack.paymentHash, bitToLightningRequest.paymentHash);
  assert.equal(data.coordinatorStore.getSettlement(ack.settlementId).state, "INTENT_ACCEPTED");
  assert.equal(data.coordinatorStore.getSettlement(ack.settlementId).reservationId, null);
});

test("rejects an invalid user invoice before disclosing it to the selected solver", async (t) => {
  const data = await executionCeremonyFixture(t, {
    pricingRequest: bitToLightningPricing,
    privateSettlementRequest: bitToLightningRequest,
  });
  const corrupted = `${userInvoice.slice(0, -1)}${userInvoice.endsWith("q") ? "p" : "q"}`;
  const response = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    { ...data.finalizeBody, invoice: corrupted },
  ));
  assert.equal(response.status, 400);
  assert.equal(data.requests(), 0);
  assert.equal(data.service.status().terminalFinalizationFailures, 1);
  const wire = await response.text();
  assert.equal(wire.includes(corrupted), false);
  assert.equal(wire.includes(bitToLightningRequest.paymentHash), false);
});

test("rejects a solver-signed invoice unless every decoded field matches reviewed policy", async (t) => {
  const base = {
    amountSats: 10_000n,
    paymentHash: id("private-payment-0").toLowerCase(),
    paymentSecret: id("solver-policy-payment-secret").toLowerCase(),
    privateKey: lightningNodePrivateKeys[0],
    timestamp: NOW - 30,
  };
  const cases = [
    ["malformed encoding", "lnbc1invalid"],
    ["changed amount", createBolt11Invoice({ ...base, amountSats: 10_001n })],
    ["changed payment hash", createBolt11Invoice({
      ...base,
      paymentHash: id("wrong-solver-payment-hash").toLowerCase(),
    })],
    ["wrong capability-bound payee", createBolt11Invoice({
      ...base,
      privateKey: lightningNodePrivateKeys[1],
    })],
    ["unknown required feature", createBolt11Invoice({
      ...base,
      featureBits: [2, 9, 15],
    })],
  ];
  for (const [name, solverInvoice] of cases) {
    await t.test(name, async (child) => {
      const data = await executionCeremonyFixture(child, { solverInvoice });
      const response = await data.route.handle(privateCeremonyRequest(
        "/v1/selection/finalize",
        data.finalizeBody,
      ));
      assert.equal(response.status, 400);
      assert.equal(data.requests(), 1);
      assert.equal(data.service.status().executableQuotesFinalized, 0);
      assert.equal(data.service.status().terminalFinalizationFailures, 1);
      const wire = await response.text();
      assert.equal(wire.includes(solverInvoice), false);
      assert.equal(wire.includes(id("private-payment-0")), false);
    });
  }
});

test("returns generic pending while browser finalization continues and replays one solver result", async (t) => {
  let releaseResponse;
  let buildResponse;
  const transport = new Promise((resolve) => { releaseResponse = resolve; });
  const data = await executionCeremonyFixture(t, {
    routePolicy: {
      ...privateCeremonyPolicy,
      maximumProcessingMilliseconds: 250,
    },
    onRequest: ({ buildDefaultResponse }) => {
      buildResponse = buildDefaultResponse;
      return transport;
    },
  });
  const first = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  assert.equal(first.status, 425);
  assert.equal(first.headers.get("retry-after"), "1");
  assert.deepEqual(await first.json(), {
    schema: "treeswap.rfq-execution-ceremony-pending.v1",
    status: "pending",
    retryable: true,
  });
  assert.equal(data.route.status().finalizationsInFlight, 1);
  assert.throws(() => data.route.stop(), /cannot stop while finalization is pending/);

  const concurrent = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  assert.equal(concurrent.status, 425);
  assert.equal(data.requests(), 1);
  releaseResponse(await buildResponse());
  for (let attempt = 0; attempt < 20 && data.route.status().finalizationsInFlight !== 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(data.route.status().finalizationsInFlight, 0);
  const recovered = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  assert.equal(recovered.status, 200);
  const prompt = await recovered.json();
  assert.equal(prompt.schema, "treeswap.selected-solver-execution-signing-payload.v1");
  assert.equal(prompt.invoice, data.invoice);
  assert.equal(data.requests(), 1);
  const status = data.route.status();
  assert.equal(status.requestsPending, 2);
  assert.equal(status.executionSigningPayloadsPrepared, 1);
  assert.equal(JSON.stringify(status).includes(data.handoff.reservationToken), false);
});

test("retries the same solver attempt after an authenticated provider-pending response", async (t) => {
  const requestBodies = [];
  const data = await executionCeremonyFixture(t, {
    onRequest: ({ buildDefaultResponse, options, requestNumber }) => {
      requestBodies.push(options.body);
      if (requestNumber === 1) {
        return new Response(JSON.stringify({ status: "pending" }), {
          status: 425,
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        });
      }
      return buildDefaultResponse();
    },
  });
  const pending = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  assert.equal(pending.status, 425);
  const recovered = await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).invoice, data.invoice);
  assert.equal(data.requests(), 2);
  assert.equal(requestBodies[0], requestBodies[1]);
});

test("fails the execution ceremony closed on origin, framing, fields, and lifecycle", async (t) => {
  const data = await executionCeremonyFixture(t);
  const preflight = await data.route.handle(new Request(
    `${CEREMONY_API_ORIGIN}/v1/selection/finalize`,
    {
      method: "OPTIONS",
      headers: {
        "access-control-request-headers": "Content-Type, Cache-Control",
        "access-control-request-method": "POST",
        origin: QUOTE_CLIENT_ORIGIN,
      },
    },
  ));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  for (const request of [
    privateCeremonyRequest("/v1/selection/finalize?token=secret", data.finalizeBody),
    privateCeremonyRequest("/v1/selection/finalize", data.finalizeBody, {
      headers: { origin: "https://evil.example" },
    }),
    privateCeremonyRequest("/v1/selection/finalize", data.finalizeBody, {
      headers: { authorization: "Bearer leaked" },
    }),
    privateCeremonyRequest("/v1/selection/finalize", data.finalizeBody, {
      headers: { cookie: "reservation=leaked" },
    }),
    privateCeremonyRequest("/v1/selection/finalize", data.finalizeBody, {
      headers: { "cache-control": "" },
    }),
    privateCeremonyRequest("/v1/selection/finalize", { ...data.finalizeBody, extra: true }),
    privateCeremonyRequest("/v1/selection/finalize", Buffer.alloc(32_769, 1)),
    privateCeremonyRequest("/v1/selection/finalize", data.finalizeBody, { method: "GET" }),
  ]) {
    const response = await data.route.handle(request);
    assert.equal(response.status, 400);
    const wire = await response.text();
    assert.equal(wire.includes(data.handoff.reservationToken), false);
    assert.equal(wire.includes("Bearer leaked"), false);
  }
  assert.equal(data.requests(), 0);
  data.deployment.abort();
  assert.equal(data.route.status().state, "stopped");
  assert.equal(data.service.status().state, "stopped");
  assert.equal((await data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ))).status, 400);
});

test("rejects a delayed solver result after execution-ceremony shutdown", async (t) => {
  let releaseResponse;
  let buildResponse;
  const transport = new Promise((resolve) => { releaseResponse = resolve; });
  const data = await executionCeremonyFixture(t, {
    onRequest: ({ buildDefaultResponse }) => {
      buildResponse = buildDefaultResponse;
      return transport;
    },
  });
  const pending = data.route.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  for (let attempt = 0; attempt < 20 && data.requests() === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(data.requests(), 1);
  data.deployment.abort();
  assert.equal((await pending).status, 425);
  releaseResponse(await buildResponse());
  for (let attempt = 0; attempt < 20 && data.route.status().finalizationsInFlight !== 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(data.route.status().finalizationsInFlight, 0);
  assert.equal(data.route.status().state, "stopped");
  const firm = data.coordinatorStore.getFirmOffer(data.selection.selected.offer.offerId);
  assert.equal(firm.state, "ACTIVE");
  assert.equal(firm.privateRequestDigest, null);
  assert.equal(firm.executionAuthorizationDigest, null);
});

test("does not deserialize an expired browser bearer token after lifecycle replacement", async (t) => {
  const data = await executionCeremonyFixture(t);
  data.deployment.abort();
  const replacementDeployment = new AbortController();
  const replacementService = createTestRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: data.verifications,
    coordinatorStore: data.coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: 4,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 138),
    signal: replacementDeployment.signal,
  });
  const replacementKeys = generateKeyPairSync("ed25519");
  let solverRequests = 0;
  const replacementClient = createTestSelectedSolverFinalizationClient({
    requesterPrivateKey: replacementKeys.privateKey,
    signal: replacementDeployment.signal,
    nowSeconds: () => NOW,
    requestImpl: async () => {
      solverRequests += 1;
      throw new Error("old browser authority reached the solver");
    },
  });
  const replacementRoute = createTestRfqExecutionCeremonyRoute({
    client: replacementClient,
    policy: privateCeremonyPolicy,
    quotePolicy,
    selectionReservation: replacementService,
    signal: replacementDeployment.signal,
  });
  t.after(() => {
    replacementDeployment.abort();
    try { replacementRoute.stop(); } catch {}
  });
  const response = await replacementRoute.handle(privateCeremonyRequest(
    "/v1/selection/finalize",
    data.finalizeBody,
  ));
  assert.equal(response.status, 400);
  assert.equal(solverRequests, 0);
  const firm = data.coordinatorStore.getFirmOffer(data.selection.selected.offer.offerId);
  assert.equal(firm.state, "ACTIVE");
  assert.equal(firm.privateRequestDigest, null);
  assert.equal(firm.executionAuthorizationDigest, null);
});

test("composes quote ingress through the owned RFQ service and reviewed evidence", async (t) => {
  const data = await fixture();
  const deployment = new AbortController();
  const client = createTestRfqDeliveryClient({
    paths: data.paths,
    policy: deliveryPolicy,
    requestTtlSeconds: 15,
    timeoutMs: 5_000,
    maximumResponseBytes: 262_144,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 12),
  });
  const service = startTestRfqDeliveryService({ client, signal: deployment.signal });
  let previewEntropy = 20;
  const reader = createTestRfqQuoteIngressServiceReader({
    blindPolicy,
    capabilityVerifications: data.verifications,
    deliveryService: service,
    marketRiskPolicy,
    marketRiskSnapshot: currentMarketRiskSnapshot(),
    nowSeconds: () => NOW,
    priceSignals: marketSigners.map((_signer, index) => (
      marketSignal(index, "lightning-to-bit", id(`ingress-service-reader-${index}`))
    )),
    randomBytesImpl: () => Buffer.alloc(32, ++previewEntropy),
    signal: deployment.signal,
  });
  t.after(() => deployment.abort());
  const session = await reader.read({ pricing, signal: new AbortController().signal });
  assert.equal(isClientSafeBlindQuoteSession(session), true);
  assert.equal(isProductionClientSafeBlindQuoteSession(session), false);
  assert.equal(session.preview().pricingId, pricing.pricingId);
  assert.equal(session.preview().quoteCount, 2);
  assert.equal(service.status().requestsCompleted, 1);
  assert.deepEqual(reader.status(), {
    schema: "treeswap.rfq-quote-ingress-reader-status.v1",
    state: "active",
    mode: "injected-test",
    source: "delivery-service",
    requestsStarted: 1,
    requestsCompleted: 1,
    requestsFailed: 0,
    requestsInFlight: 0,
    fundingAuthorization: false,
    settlementAuthorization: false,
    signingAuthorization: false,
    networkListener: false,
  });
  session.close();
  assert.throws(() => createTestRfqQuoteIngressServiceReader({
    blindPolicy,
    capabilityVerifications: data.verifications,
    deliveryService: service,
    marketRiskPolicy,
    marketRiskSnapshot: currentMarketRiskSnapshot(),
    nowSeconds: () => NOW,
    priceSignals: [],
    randomBytesImpl: () => Buffer.alloc(32, 21),
    signal: deployment.signal,
  }), /already bound/);
});

test("fails closed on substituted, mutable, or stale ingress-reader evidence", async (t) => {
  const data = await fixture();
  const deployment = new AbortController();
  const client = createTestRfqDeliveryClient({
    paths: data.paths,
    policy: deliveryPolicy,
    requestTtlSeconds: 15,
    timeoutMs: 5_000,
    maximumResponseBytes: 262_144,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 31),
  });
  const service = startTestRfqDeliveryService({ client, signal: deployment.signal });
  const signals = marketSigners.map((_signer, index) => (
    marketSignal(index, "lightning-to-bit", id(`ingress-evidence-${index}`))
  ));
  const base = {
    blindPolicy: { ...blindPolicy },
    capabilityVerifications: [...data.verifications],
    deliveryService: service,
    marketRiskPolicy: {
      ...marketRiskPolicy,
      allowedPriceSourcePolicyDigests: [...marketRiskPolicy.allowedPriceSourcePolicyDigests],
    },
    marketRiskSnapshot: currentMarketRiskSnapshot(),
    nowSeconds: () => NOW,
    priceSignals: signals,
    randomBytesImpl: () => Buffer.alloc(32, 32),
    signal: deployment.signal,
  };
  t.after(() => deployment.abort());

  let getterCalls = 0;
  const accessorInput = { ...base };
  Object.defineProperty(accessorInput, "blindPolicy", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return blindPolicy;
    },
  });
  assert.throws(
    () => createTestRfqQuoteIngressServiceReader(accessorInput),
    /enumerable data properties/,
  );
  assert.equal(getterCalls, 0);
  let coercionCalls = 0;
  assert.throws(() => createTestRfqQuoteIngressServiceReader({
    ...base,
    blindPolicy: {
      ...blindPolicy,
      chainId: {
        valueOf() {
          coercionCalls += 1;
          return 1;
        },
      },
    },
  }), /primitive data value/);
  assert.equal(coercionCalls, 0);
  assert.throws(() => createTestRfqQuoteIngressServiceReader({
    ...base,
    capabilityVerifications: [{ ...data.verifications[0] }, data.verifications[1]],
  }), /locally verified capability/);
  assert.throws(() => createTestRfqQuoteIngressServiceReader({
    ...base,
    priceSignals: [{ ...signals[0] }, signals[1], signals[2]],
  }), /original verifier provenance/);
  assert.throws(() => createTestRfqQuoteIngressServiceReader({
    ...base,
    blindPolicy: { ...blindPolicy, marketRiskPolicyDigest: id("another-market-risk-policy") },
  }), /exact market-risk policy/);

  let entropy = 33;
  const reader = createTestRfqQuoteIngressServiceReader({
    ...base,
    randomBytesImpl: () => Buffer.alloc(32, ++entropy),
  });
  base.blindPolicy.minimumIndependentSolvers = 16;
  base.marketRiskPolicy.allowedPriceSourcePolicyDigests.length = 0;
  base.marketRiskSnapshot.observedAt = 0;
  const session = await reader.read({ pricing, signal: new AbortController().signal });
  assert.equal(session.preview().quoteCount, 2);
  session.close();
  service.stop();
  assert.equal(reader.status().state, "stopped");

  const staleDeployment = new AbortController();
  const staleClient = createTestRfqDeliveryClient({
    paths: data.paths,
    policy: deliveryPolicy,
    requestTtlSeconds: 15,
    timeoutMs: 5_000,
    maximumResponseBytes: 262_144,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 35),
  });
  const staleService = startTestRfqDeliveryService({ client: staleClient, signal: staleDeployment.signal });
  let staleEntropy = 40;
  const staleReader = createTestRfqQuoteIngressServiceReader({
    ...base,
    blindPolicy,
    deliveryService: staleService,
    marketRiskPolicy,
    marketRiskSnapshot: { ...currentMarketRiskSnapshot(), observedAt: NOW - 121 },
    priceSignals: signals,
    randomBytesImpl: () => Buffer.alloc(32, ++staleEntropy),
    signal: staleDeployment.signal,
  });
  t.after(() => staleDeployment.abort());
  await assert.rejects(
    staleReader.read({ pricing, signal: new AbortController().signal }),
    /not enough independent valid blind solver offers/,
  );
  assert.equal(staleReader.status().requestsFailed, 1);
});

test("keeps quote ingress factories, execution modes, and methods provenance-bound", async (t) => {
  const data = await fixture();
  const store = await quoteIngressStore();
  const coordinatorStore = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const deployment = new AbortController();
  const productionClient = createRfqDeliveryClient({
    paths: data.paths,
    policy: deliveryPolicy,
    requestTtlSeconds: 15,
    timeoutMs: 5_000,
    maximumResponseBytes: 262_144,
  });
  const productionService = startRfqDeliveryService({
    client: productionClient,
    signal: deployment.signal,
  });
  assert.throws(() => createRfqQuoteIngressReader({ read: async () => null }), /fields are not exact/);
  const productionReader = createRfqQuoteIngressReader({
    blindPolicy,
    capabilityVerifications: data.verifications,
    deliveryService: productionService,
    marketRiskPolicy,
    marketRiskSnapshot: currentMarketRiskSnapshot(),
    priceSignals: marketSigners.map((_signer, index) => (
      marketSignal(index, "lightning-to-bit", id(`production-ingress-reader-${index}`))
    )),
    signal: deployment.signal,
  });
  const productionSelectionReservation = createRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: data.verifications,
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: quoteIngressPolicy.maximumLiveRequests,
    signal: deployment.signal,
  });
  const testSelectionReservation = createTestRfqSelectionReservationService({
    admissionPolicy,
    capabilityVerifications: data.verifications,
    coordinatorStore,
    invoicePolicy,
    maximumPendingSelections: quoteIngressPolicy.maximumLiveRequests,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 2),
    signal: deployment.signal,
  });
  const testReader = createTestRfqQuoteIngressReader({ read: async () => null });
  t.after(() => {
    deployment.abort();
    try { store.close(); } catch {}
    try { coordinatorStore.close(); } catch {}
  });
  assert.throws(() => createRfqQuoteIngressRoute({
    policy: quoteIngressPolicy,
    quoteReader: productionReader,
    replayStore: store,
    selectionReservation: testSelectionReservation,
    signal: deployment.signal,
  }), /matching factory-created selection reservation service/);
  assert.throws(() => createRfqQuoteIngressRoute({
    policy: quoteIngressPolicy,
    quoteReader: testReader,
    replayStore: store,
    selectionReservation: productionSelectionReservation,
    signal: deployment.signal,
  }), /matching factory-created quote reader/);
  assert.throws(() => createTestRfqQuoteIngressRoute({
    nowSeconds: () => NOW,
    policy: quoteIngressPolicy,
    quoteReader: productionReader,
    randomBytesImpl: () => Buffer.alloc(32, 1),
    replayStore: store,
    selectionReservation: productionSelectionReservation,
    signal: deployment.signal,
  }), /matching factory-created quote reader/);
  assert.throws(() => createRfqPrivateCeremonyRoute({
    policy: privateCeremonyPolicy,
    selectionReservation: testSelectionReservation,
    signal: deployment.signal,
  }), /matching factory-created reservation service/);
  assert.throws(() => createTestRfqPrivateCeremonyRoute({
    policy: privateCeremonyPolicy,
    selectionReservation: productionSelectionReservation,
    signal: deployment.signal,
  }), /matching factory-created reservation service/);
  assert.throws(() => createRfqPrivateCeremonyRoute({
    policy: privateCeremonyPolicy,
    selectionReservation: productionSelectionReservation,
    signal: new AbortController().signal,
  }), /share one deployment lifecycle/);
  let policyAccessorRead = false;
  const accessorPolicy = { ...privateCeremonyPolicy };
  Object.defineProperty(accessorPolicy, "apiOrigin", {
    enumerable: true,
    get() {
      policyAccessorRead = true;
      return CEREMONY_API_ORIGIN;
    },
  });
  assert.throws(() => createTestRfqPrivateCeremonyRoute({
    policy: accessorPolicy,
    selectionReservation: testSelectionReservation,
    signal: deployment.signal,
  }), /enumerable data properties/);
  assert.equal(policyAccessorRead, false);
  let policyCoercionRead = false;
  assert.throws(() => createTestRfqPrivateCeremonyRoute({
    policy: {
      ...privateCeremonyPolicy,
      apiOrigin: {
        toString() {
          policyCoercionRead = true;
          return CEREMONY_API_ORIGIN;
        },
      },
    },
    selectionReservation: testSelectionReservation,
    signal: deployment.signal,
  }), /canonical HTTPS origin/);
  assert.equal(policyCoercionRead, false);
  const ceremonyRoute = createRfqPrivateCeremonyRoute({
    policy: privateCeremonyPolicy,
    selectionReservation: productionSelectionReservation,
    signal: deployment.signal,
  });
  assert.equal(isRfqPrivateCeremonyRoute(ceremonyRoute), true);
  assert.throws(
    () => productionSelectionReservation.prepare({}),
    /ceremony is route-owned/,
  );
  const copiedCeremony = { ...ceremonyRoute };
  await assert.rejects(
    copiedCeremony.handle(privateCeremonyRequest("/v1/selection/prepare", {})),
    /factory provenance/,
  );
  const extractedCeremony = ceremonyRoute.handle;
  await assert.rejects(
    extractedCeremony(privateCeremonyRequest("/v1/selection/prepare", {})),
    /factory provenance/,
  );
  assert.throws(() => createRfqQuoteIngressRoute({
    policy: quoteIngressPolicy,
    quoteReader: productionReader,
    replayStore: store,
    selectionReservation: productionSelectionReservation,
    signal: new AbortController().signal,
  }), /share one deployment lifecycle/);
  const route = createRfqQuoteIngressRoute({
    policy: quoteIngressPolicy,
    quoteReader: productionReader,
    replayStore: store,
    selectionReservation: productionSelectionReservation,
    signal: deployment.signal,
  });
  await assert.rejects(productionReader.read({}), /route-owned/);
  assert.equal(isRfqQuoteIngressRoute(route), true);
  const copied = { ...route };
  await assert.rejects(copied.handle(quoteIngressRequest("/v1/quotes", {})), /factory provenance/);
  const extracted = route.handle;
  await assert.rejects(extracted(quoteIngressRequest("/v1/quotes", {})), /factory provenance/);
  assert.equal(route.stop().state, "stopped");
  assert.throws(() => createRfqQuoteIngressRoute({
    policy: quoteIngressPolicy,
    quoteReader: productionReader,
    replayStore: store,
    selectionReservation: productionSelectionReservation,
    signal: deployment.signal,
  }), /already bound/);
});

test("permits only the exact credential-free browser preflight", async (t) => {
  const data = await quoteIngressFixture(t);
  const valid = () => new Request(`${QUOTE_API_ORIGIN}/v1/quotes`, {
    method: "OPTIONS",
    headers: {
      "access-control-request-headers": "Content-Type, Cache-Control",
      "access-control-request-method": "POST",
      origin: QUOTE_CLIENT_ORIGIN,
    },
  });
  const accepted = await data.route.handle(valid());
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get("access-control-allow-origin"), QUOTE_CLIENT_ORIGIN);
  assert.equal(accepted.headers.get("access-control-allow-methods"), "POST");
  assert.equal(accepted.headers.get("access-control-allow-headers"), "cache-control, content-type");
  assert.equal(accepted.headers.get("access-control-allow-credentials"), null);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.equal(await accepted.text(), "");
  for (const headers of [
    { "access-control-request-headers": "content-type", "access-control-request-method": "POST" },
    { "access-control-request-headers": "authorization, cache-control, content-type", "access-control-request-method": "POST" },
    { "access-control-request-headers": "cache-control, content-type", "access-control-request-method": "GET" },
    { "access-control-request-headers": "cache-control, content-type", "access-control-request-method": "POST", "access-control-request-private-network": "true" },
  ]) {
    const request = new Request(`${QUOTE_API_ORIGIN}/v1/quotes`, {
      method: "OPTIONS",
      headers: { ...headers, origin: QUOTE_CLIENT_ORIGIN },
    });
    assert.equal((await data.route.handle(request)).status, 400);
  }
  assert.equal(data.reads(), 0);
  assert.equal(data.route.status().durableLiveClaimedRequests, 0);
});

test("rejects changed, expired, overlong, and incorrectly signed quote authorizations before RFQ access", async (t) => {
  const data = await quoteIngressFixture(t);
  const valid = await signedQuoteIngressBody();
  const otherSigner = await user.signTypedData(
    buildRfqQuoteAuthorization({
      authorizationExpiresAt: NOW + 30,
      policy: quoteIngressPolicy,
      pricing,
      requestNonce: "17",
      user: solvers[0].address,
    }).domain,
    RFQ_QUOTE_AUTHORIZATION_TYPES,
    buildRfqQuoteAuthorization({
      authorizationExpiresAt: NOW + 30,
      policy: quoteIngressPolicy,
      pricing,
      requestNonce: "17",
      user: solvers[0].address,
    }).message,
  );
  const expired = await signedQuoteIngressBody({ authorizationExpiresAt: NOW });
  const overlong = await signedQuoteIngressBody({ authorizationExpiresAt: NOW + 61 });
  const policyInvalidPricing = { ...pricing, maxFeeBps: "301" };
  const policyInvalid = await signedQuoteIngressBody({
    publicPricing: policyInvalidPricing,
    authorizationExpiresAt: NOW + 30,
  });
  const cases = [
    { ...valid, pricing: { ...valid.pricing, maxFeeBps: "101" } },
    { ...valid, authorization: { ...valid.authorization, pricingDigest: id("changed-pricing") } },
    { ...valid, authorization: { ...valid.authorization, clientOriginDigest: id("changed-origin") } },
    { ...valid, signature: `${valid.signature.slice(0, -2)}00` },
    { ...valid, authorization: { ...valid.authorization, user: solvers[0].address }, signature: otherSigner },
    expired,
    overlong,
    policyInvalid,
  ];
  for (const [index, body] of cases.entries()) {
    const response = await data.route.handle(quoteIngressRequest("/v1/quotes", body));
    assert.equal(response.status, 400, `authorization rejection case ${index}`);
    assert.deepEqual(await response.json(), { error: "quote request rejected" });
  }
  assert.equal(data.reads(), 0);
  assert.equal(data.route.status().durableLiveClaimedRequests, 0);
});

test("rejects noncanonical quote HTTP targets, credentials, framing, UTF-8, and JSON", async (t) => {
  const data = await quoteIngressFixture(t);
  const body = await signedQuoteIngressBody();
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  const requests = [
    quoteIngressRequest("/v1/quotes", body, { method: "GET" }),
    quoteIngressRequest("/v1/quotes/", body),
    quoteIngressRequest("/v1/quotes?mode=fast", body),
    quoteIngressRequest("/v1/quotes#fragment", body),
    quoteIngressRequest("/v1/quotes", body, { origin: "https://other.treeswap.example" }),
    quoteIngressRequest("/v1/quotes", body, { headers: { origin: "https://evil.example" } }),
    quoteIngressRequest("/v1/quotes", body, { headers: { "content-type": "text/plain" } }),
    quoteIngressRequest("/v1/quotes", body, { headers: { "content-type": "application/json; charset=utf-16" } }),
    quoteIngressRequest("/v1/quotes", body, { headers: { "cache-control": "max-age=0" } }),
    quoteIngressRequest("/v1/quotes", body, { headers: { "content-encoding": "gzip" } }),
    quoteIngressRequest("/v1/quotes", body, { headers: { authorization: "Bearer ambient" } }),
    quoteIngressRequest("/v1/quotes", body, { headers: { cookie: "session=ambient" } }),
    quoteIngressRequest("/v1/quotes", body, { headers: { "transfer-encoding": "chunked" } }),
    quoteIngressRequest("/v1/quotes", body, { omitContentLength: true }),
    quoteIngressRequest("/v1/quotes", body, { headers: { "content-length": `0${encoded.length}` } }),
    quoteIngressRequest("/v1/quotes", body, { headers: { "content-length": String(encoded.length + 1) } }),
    quoteIngressRequest("/v1/quotes", body, { headers: { "content-length": String(quoteIngressPolicy.maximumRequestBytes + 1) } }),
    quoteIngressRequest("/v1/quotes", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded])),
    quoteIngressRequest("/v1/quotes", Buffer.from([0xc3, 0x28])),
    quoteIngressRequest("/v1/quotes", "{"),
    quoteIngressRequest("/v1/quotes", `${JSON.stringify(body)} true`),
  ];
  for (const request of requests) {
    const response = await data.route.handle(request);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "quote request rejected" });
  }
  assert.equal(data.reads(), 0);
  assert.equal(data.route.status().durableLiveClaimedRequests, 0);
});

test("bounds stalled bodies and fails closed when deployment stops during collection", async (t) => {
  const stalled = await quoteIngressFixture(t);
  const neverEndingBody = new ReadableStream({ start() {} });
  const stalledRequest = new Request(`${QUOTE_API_ORIGIN}/v1/quotes`, {
    method: "POST",
    headers: {
      "cache-control": "no-store",
      "content-length": "10",
      "content-type": "application/json",
      origin: QUOTE_CLIENT_ORIGIN,
    },
    body: neverEndingBody,
    duplex: "half",
  });
  const startedAt = Date.now();
  assert.equal((await stalled.route.handle(stalledRequest)).status, 400);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(stalled.reads(), 0);

  let collectionStarted;
  const reachedReader = new Promise((resolve) => { collectionStarted = resolve; });
  let observedSignal;
  const interrupted = await quoteIngressFixture(t, {
    read: async (_publicPricing, { signal }) => {
      observedSignal = signal;
      collectionStarted();
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
      return null;
    },
  });
  const pending = interrupted.route.handle(quoteIngressRequest(
    "/v1/quotes",
    await signedQuoteIngressBody(),
  ));
  await reachedReader;
  interrupted.deployment.abort();
  assert.equal((await pending).status, 400);
  assert.equal(observedSignal.aborted, true);
  const stopped = interrupted.route.status();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.inMemoryReadySessions, 0);
  assert.equal(stopped.requestsInFlight, 0);
  assert.equal(stopped.durableLiveClaimedRequests, 1);
});

test("closes a genuine preview session returned through the wrong ingress mode", async (t) => {
  const { book } = await collectedBlindBook();
  const productionSession = createClientSafeBlindQuoteSession(book);
  const data = await quoteIngressFixture(t, { read: async () => productionSession });
  const response = await data.route.handle(quoteIngressRequest(
    "/v1/quotes",
    await signedQuoteIngressBody(),
  ));
  assert.equal(response.status, 400);
  assert.equal(productionSession.status().state, "closed");
  assert.equal(data.route.status().durableLiveClaimedRequests, 1);
});

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
  finalizationDb.prepare("UPDATE settlements SET payment_hash = ? WHERE settlement_id = ?")
    .run(id("tampered-durable-settlement-payment"), privateRequest.requestId);
  assert.throws(
    () => verifiedFinalizedExecutableQuote(authorized, { now: NOW }),
    /durable settlement payment hash changed/,
  );
  finalizationDb.prepare("UPDATE settlements SET payment_hash = ? WHERE settlement_id = ?")
    .run(intent.paymentHash, privateRequest.requestId);
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
    /blind quote-book input fields are not exact/,
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

test("rejects non-data blind competition authority without accessors or coercion", async () => {
  const { collection, offers, verifications } = await collect();
  const marketRiskAttestations = marketRiskAttestationsForCollection(collection);
  const base = {
    pricing,
    collection,
    capabilityVerifications: verifications,
    marketRiskAttestations,
    now: NOW,
    policy: blindPolicy,
  };
  let getterCalls = 0;
  let coercionCalls = 0;

  const outerAccessor = { ...base };
  Object.defineProperty(outerAccessor, "pricing", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return pricing;
    },
  });
  assert.throws(
    () => buildMultipathBlindQuoteBook(outerAccessor),
    /enumerable data properties/,
  );

  const policyAccessor = { ...blindPolicy };
  Object.defineProperty(policyAccessor, "marketRiskPolicyDigest", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return blindPolicy.marketRiskPolicyDigest;
    },
  });
  assert.throws(
    () => buildMultipathBlindQuoteBook({ ...base, policy: policyAccessor }),
    /enumerable data properties/,
  );

  const amountCoercion = {
    toString() {
      coercionCalls += 1;
      return pricing.exactOutput;
    },
  };
  assert.throws(
    () => buildMultipathBlindQuoteBook({
      ...base,
      pricing: { ...pricing, exactOutput: amountCoercion },
    }),
    /canonical bounded unsigned integer/,
  );

  const attestationAccessor = {};
  Object.defineProperty(attestationAccessor, "requestDigest", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return marketRiskAttestations[0].requestDigest;
    },
  });
  assert.throws(
    () => buildMultipathBlindQuoteBook({
      ...base,
      marketRiskAttestations: [attestationAccessor, ...marketRiskAttestations.slice(1)],
    }),
    /requestDigest must be an enumerable data property/,
  );

  const envelopeAccessor = {};
  Object.defineProperty(envelopeAccessor, "offer", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return offers[0].envelope.offer;
    },
  });
  Object.defineProperty(envelopeAccessor, "signature", {
    enumerable: true,
    value: offers[0].envelope.signature,
  });
  const accessorResult = validateBlindSolverOffer({
    pricing,
    envelope: envelopeAccessor,
    capabilityVerification: verifications[0],
    now: NOW,
    policy: blindPolicy,
  });
  assert.equal(accessorResult.valid, false);
  assert.match(accessorResult.reasons[0], /enumerable data properties/);

  const signatureCoercion = {
    toString() {
      coercionCalls += 1;
      return offers[0].envelope.signature;
    },
  };
  const coercionResult = validateBlindSolverOffer({
    pricing,
    envelope: { offer: offers[0].envelope.offer, signature: signatureCoercion },
    capabilityVerification: verifications[0],
    now: NOW,
    policy: blindPolicy,
  });
  assert.equal(coercionResult.valid, false);
  assert.match(coercionResult.reasons[0], /signature must be a string/);
  assert.equal(getterCalls, 0);
  assert.equal(coercionCalls, 0);
});

test("rejects hidden, symbolic, inherited, sparse, and decorated blind competition authority", async () => {
  const { collection, verifications } = await collect();
  const marketRiskAttestations = marketRiskAttestationsForCollection(collection);
  const base = {
    pricing,
    collection,
    capabilityVerifications: verifications,
    marketRiskAttestations,
    now: NOW,
    policy: blindPolicy,
  };

  const hiddenPricing = { ...pricing };
  Object.defineProperty(hiddenPricing, "preferredSolver", { enumerable: false, value: solvers[0].address });
  assert.throws(
    () => buildMultipathBlindQuoteBook({ ...base, pricing: hiddenPricing }),
    /outside policy/,
  );

  const symbolicPolicy = { ...blindPolicy };
  symbolicPolicy[Symbol("fallback")] = true;
  assert.throws(
    () => buildMultipathBlindQuoteBook({ ...base, policy: symbolicPolicy }),
    /outside policy/,
  );

  const inheritedPolicy = Object.create(blindPolicy);
  assert.throws(
    () => buildMultipathBlindQuoteBook({ ...base, policy: inheritedPolicy }),
    /plain data object/,
  );

  const sparseCapabilities = [...verifications];
  delete sparseCapabilities[1];
  assert.throws(
    () => buildMultipathBlindQuoteBook({ ...base, capabilityVerifications: sparseCapabilities }),
    /dense/,
  );

  const decoratedCapabilities = [...verifications];
  decoratedCapabilities.preferred = solvers[0].address;
  assert.throws(
    () => buildMultipathBlindQuoteBook({ ...base, capabilityVerifications: decoratedCapabilities }),
    /dense/,
  );

  const sparseAttestations = [...marketRiskAttestations];
  delete sparseAttestations[0];
  assert.throws(
    () => buildMultipathBlindQuoteBook({ ...base, marketRiskAttestations: sparseAttestations }),
    /dense/,
  );

  const decoratedAttestations = [...marketRiskAttestations];
  Object.defineProperty(decoratedAttestations, "fallback", { enumerable: false, value: "reference-par" });
  assert.throws(
    () => buildMultipathBlindQuoteBook({ ...base, marketRiskAttestations: decoratedAttestations }),
    /dense/,
  );
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
  const collection = await collectTestVerifiedRfqDeliveries({
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
  await assert.rejects(collectTestVerifiedRfqDeliveries({
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

test("separates the fixed production RFQ client from explicit test dependencies", async () => {
  const data = await fixture();
  const configuration = {
    paths: data.paths,
    policy: deliveryPolicy,
    requestTtlSeconds: 15,
    timeoutMs: 5_000,
    maximumResponseBytes: 262_144,
  };
  const production = createRfqDeliveryClient(configuration);
  assert.equal(isRfqDeliveryClient(production), true);
  assert.equal(isProductionRfqDeliveryClient(production), true);
  assert.equal(rfqDeliveryClientTransportMode(production), "fixed-public-node-https");
  assert.equal(isRfqDeliveryClient({ ...production }), false);
  let getterCalls = 0;
  const accessorConfiguration = { ...configuration };
  Object.defineProperty(accessorConfiguration, "policy", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return deliveryPolicy;
    },
  });
  assert.throws(() => createRfqDeliveryClient(accessorConfiguration), /enumerable data properties/);
  assert.equal(getterCalls, 0);
  assert.throws(() => createRfqDeliveryClient({
    ...configuration,
    requestImpl: data.responder,
  }), /fields are (?:not exact|outside policy)/);
  assert.throws(() => createRfqDeliveryClient({
    ...configuration,
    nowSeconds: () => NOW,
  }), /fields are (?:not exact|outside policy)/);
  assert.throws(() => createRfqDeliveryClient({
    ...configuration,
    randomBytesImpl: () => Buffer.alloc(32, 1),
  }), /fields are (?:not exact|outside policy)/);
  let injectedRequests = 0;
  const productionCallSignal = new AbortController().signal;
  await assert.rejects(collectVerifiedRfqDeliveries({
    ...configuration,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    signal: productionCallSignal,
    requestImpl: async () => { injectedRequests += 1; },
  }), /fields are (?:not exact|outside policy)/);
  await assert.rejects(queryVerifiedRfqDelivery({
    path: data.paths[0],
    policy: deliveryPolicy,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    signal: productionCallSignal,
    requestImpl: async () => { injectedRequests += 1; },
  }), /fields are (?:not exact|outside policy)/);
  await assert.rejects(collectVerifiedRfqDeliveries({
    ...configuration,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
  }), /fields are not exact/);
  assert.equal(injectedRequests, 0);

  const mutablePaths = pathPlan(data.verifications);
  const mutablePolicy = { ...deliveryPolicy };
  const testClient = createTestRfqDeliveryClient({
    ...configuration,
    paths: mutablePaths,
    policy: mutablePolicy,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 9),
  });
  mutablePaths.length = 0;
  mutablePolicy.minimumRelayPaths = 16;
  assert.equal(isRfqDeliveryClient(testClient), true);
  assert.equal(isProductionRfqDeliveryClient(testClient), false);
  assert.equal(rfqDeliveryClientTransportMode(testClient), "injected-test");
  const controller = new AbortController();
  const collection = await testClient.collect({
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    signal: controller.signal,
  });
  assert.equal(verifiedRfqDeliveryCollection(collection), collection);
  assert.equal(collection.attemptCount, 4);

  const copied = { ...testClient };
  assert.throws(() => copied.collect({
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    signal: controller.signal,
  }), /factory provenance/);
  testClient.close();
  assert.throws(() => testClient.collect({
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    signal: controller.signal,
  }), (error) => error instanceof RfqDeliveryError && error.code === "CLIENT_CLOSED");
});

test("cancels every in-flight RFQ path on caller abort or client shutdown", async () => {
  const data = await fixture();
  for (const cancelWith of ["caller", "client"]) {
    let requests = 0;
    const client = createTestRfqDeliveryClient({
      paths: data.paths,
      policy: deliveryPolicy,
      requestTtlSeconds: 15,
      timeoutMs: 30_000,
      maximumResponseBytes: 262_144,
      requestImpl: async () => {
        requests += 1;
        return new Promise(() => {});
      },
      nowSeconds: () => NOW,
      randomBytesImpl: () => Buffer.alloc(32, 8),
    });
    const controller = new AbortController();
    const pending = client.collect({
      requestId: pricing.pricingId,
      requestDigest: rfqDeliveryPayloadDigest(pricing),
      rfq: pricing,
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, data.paths.length);
    if (cancelWith === "caller") controller.abort();
    else client.close();
    await assert.rejects(
      pending,
      (error) => error instanceof RfqDeliveryError && error.code === "CANCELLED" && error.ambiguous === false,
    );
    client.close();
  }
});

test("binds one production RFQ client to one authority-free service lifecycle", async () => {
  const data = await fixture();
  const configuration = {
    paths: data.paths,
    policy: deliveryPolicy,
    requestTtlSeconds: 15,
    timeoutMs: 5_000,
    maximumResponseBytes: 262_144,
  };
  const productionClient = createRfqDeliveryClient(configuration);
  const deploymentController = new AbortController();
  let getterCalls = 0;
  const accessorInput = { client: productionClient, signal: deploymentController.signal };
  Object.defineProperty(accessorInput, "client", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return productionClient;
    },
  });
  assert.throws(() => startRfqDeliveryService(accessorInput), /enumerable data properties/);
  assert.equal(getterCalls, 0);

  const service = startRfqDeliveryService({
    client: productionClient,
    signal: deploymentController.signal,
  });
  assert.equal(rfqDeliveryClientLifecycleState(productionClient), "owned");
  assert.throws(() => productionClient.collect({
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    signal: new AbortController().signal,
  }), (error) => error.code === "CLIENT_OWNED");
  assert.throws(() => productionClient.close(), (error) => error.code === "CLIENT_OWNED");
  assert.equal(isRfqDeliveryService(service), true);
  assert.equal(isProductionRfqDeliveryService(service), true);
  assert.deepEqual(service.status(), {
    schema: "treeswap.rfq-delivery-service-status.v1",
    state: "active",
    transportMode: "fixed-public-node-https",
    requestsStarted: 0,
    requestsCompleted: 0,
    requestsCancelled: 0,
    requestsFailed: 0,
    requestsInFlight: 0,
    fundingAuthorization: false,
    settlementAuthorization: false,
    networkListener: false,
  });
  assert.equal(isRfqDeliveryService({ ...service }), false);
  assert.throws(() => ({ ...service }).status(), /factory provenance/);
  assert.throws(() => startRfqDeliveryService({
    client: productionClient,
    signal: new AbortController().signal,
  }), /already owned/);

  const testClient = createTestRfqDeliveryClient({
    ...configuration,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 4),
  });
  assert.throws(() => startRfqDeliveryService({
    client: testClient,
    signal: new AbortController().signal,
  }), /fixed public Node HTTPS/);
  const testService = startTestRfqDeliveryService({
    client: testClient,
    signal: new AbortController().signal,
  });
  assert.equal(isProductionRfqDeliveryService(testService), false);
  testService.stop();

  const preExistingClient = createTestRfqDeliveryClient({
    ...configuration,
    requestImpl: data.responder,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 5),
  });
  const preExistingCall = preExistingClient.collect({
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    signal: new AbortController().signal,
  });
  assert.throws(() => startTestRfqDeliveryService({
    client: preExistingClient,
    signal: new AbortController().signal,
  }), /active unowned request/);
  await preExistingCall;
  const claimedAfterSettle = startTestRfqDeliveryService({
    client: preExistingClient,
    signal: new AbortController().signal,
  });
  claimedAfterSettle.stop();

  const stopped = service.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.fundingAuthorization, false);
  assert.equal(rfqDeliveryClientLifecycleState(productionClient), "closed");
  assert.throws(() => startRfqDeliveryService({
    client: productionClient,
    signal: new AbortController().signal,
  }), /already closed|already owned/);
});

test("collects without identifier-bearing health and cancels through either lifecycle", async () => {
  const data = await fixture();
  let hanging = false;
  const client = createTestRfqDeliveryClient({
    paths: data.paths,
    policy: deliveryPolicy,
    requestTtlSeconds: 15,
    timeoutMs: 30_000,
    maximumResponseBytes: 262_144,
    requestImpl: async (...args) => (hanging ? new Promise(() => {}) : data.responder(...args)),
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 3),
  });
  const deploymentController = new AbortController();
  const service = startTestRfqDeliveryService({ client, signal: deploymentController.signal });
  const firstController = new AbortController();
  const call = {
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    signal: firstController.signal,
  };
  const collection = await service.collect(call);
  assert.equal(verifiedRfqDeliveryCollection(collection), collection);
  const completed = service.status();
  assert.equal(completed.state, "active");
  assert.equal(completed.requestsStarted, 1);
  assert.equal(completed.requestsCompleted, 1);
  assert.equal(completed.requestsInFlight, 0);
  assert.doesNotMatch(JSON.stringify(completed), new RegExp(pricing.pricingId.slice(2), "i"));

  hanging = true;
  const callerController = new AbortController();
  const callerPending = service.collect({ ...call, signal: callerController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.status().requestsInFlight, 1);
  callerController.abort();
  await assert.rejects(callerPending, (error) => error.code === "CANCELLED");
  const callerCancelled = service.status();
  assert.equal(callerCancelled.state, "active");
  assert.equal(callerCancelled.requestsCancelled, 1);

  const deploymentPending = service.collect({ ...call, signal: new AbortController().signal });
  await new Promise((resolve) => setImmediate(resolve));
  deploymentController.abort();
  await assert.rejects(deploymentPending, (error) => error.code === "CANCELLED");
  const stopped = service.status();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.requestsStarted, 3);
  assert.equal(stopped.requestsCompleted, 1);
  assert.equal(stopped.requestsCancelled, 2);
  assert.equal(stopped.requestsFailed, 0);
  assert.equal(stopped.requestsInFlight, 0);
  await assert.rejects(service.collect(call), (error) => error.code === "SERVICE_STOPPED");
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
  await assert.rejects(collectTestVerifiedRfqDeliveries(accessorCall), /enumerable data properties/);

  const accessorPaths = pathPlan(data.verifications);
  Object.defineProperty(accessorPaths[0], "kind", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "relay";
    },
  });
  await assert.rejects(collectTestVerifiedRfqDeliveries({
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
  await assert.rejects(collectTestVerifiedRfqDeliveries({
    ...base,
    paths: data.paths,
    policy: hiddenPolicy,
  }), /fields are outside policy/);

  const symbolicPricing = { ...pricing, [Symbol("private-beneficiary")]: user.address };
  assert.throws(() => rfqDeliveryPayloadDigest(symbolicPricing), /fields are outside policy/);

  const inheritedPath = Object.assign(Object.create({ privileged: true }), data.paths[0]);
  const inheritedPaths = [...data.paths];
  inheritedPaths[0] = inheritedPath;
  await assert.rejects(collectTestVerifiedRfqDeliveries({ ...base, paths: inheritedPaths }), /plain data object/);

  const sparsePaths = [...data.paths];
  delete sparsePaths[1];
  await assert.rejects(collectTestVerifiedRfqDeliveries({ ...base, paths: sparsePaths }), /dense/);

  const decoratedPaths = [...data.paths];
  Object.defineProperty(decoratedPaths, "selected", { enumerable: false, value: 0 });
  await assert.rejects(collectTestVerifiedRfqDeliveries({ ...base, paths: decoratedPaths }), /dense/);
  assert.equal(requests, 0);
});

test("snapshots RFQ collection inputs before concurrent delivery", async () => {
  const data = await fixture();
  const mutablePricing = { ...pricing };
  const mutablePolicy = { ...deliveryPolicy };
  const mutablePaths = pathPlan(data.verifications);
  const pending = collectTestVerifiedRfqDeliveries({
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
    await assert.rejects(queryTestVerifiedRfqDelivery({
      ...args,
      requestImpl: framed(headers),
    }), (error) => error.code === "INVALID_RESPONSE" && error.ambiguous === false);
  }

  for (const bytes of [
    [0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d],
    [0xef, 0xbb, 0xbf, ...Buffer.from('{"x":true}')],
  ]) {
    await assert.rejects(queryTestVerifiedRfqDelivery({
      ...args,
      requestImpl: async () => new Response(Uint8Array.from(bytes), {
        headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
      }),
    }), (error) => error.code === "INVALID_RESPONSE" && error.ambiguous === false);
  }

  let stalledCancelled = 0;
  await assert.rejects(queryTestVerifiedRfqDelivery({
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
    await assert.rejects(queryTestVerifiedRfqDelivery({
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
  const collection = await collectTestVerifiedRfqDeliveries({
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
  const collection = await collectTestVerifiedRfqDeliveries({
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
  const collection = await collectTestVerifiedRfqDeliveries({
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
  await assert.rejects(collectTestVerifiedRfqDeliveries({
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
  const collection = await collectTestVerifiedRfqDeliveries({
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
  const collection = await collectTestVerifiedRfqDeliveries({
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
  await assert.rejects(collectTestVerifiedRfqDeliveries({
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
  await assert.rejects(collectTestVerifiedRfqDeliveries({
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
  await assert.rejects(collectTestVerifiedRfqDeliveries({
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
  await assert.rejects(collectTestVerifiedRfqDeliveries({
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
    await assert.rejects(collectTestVerifiedRfqDeliveries({
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
    await assert.rejects(collectTestVerifiedRfqDeliveries({
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
  await assert.rejects(collectTestVerifiedRfqDeliveries({
    paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: deliveryPolicy,
    requestImpl: async () => { requests += 1; },
    nowSeconds: () => NOW,
  }), /not public/);
  await assert.rejects(collectTestVerifiedRfqDeliveries({
    paths: data.paths,
    requestId: pricing.pricingId,
    requestDigest: rfqDeliveryPayloadDigest(pricing),
    rfq: pricing,
    policy: { ...deliveryPolicy, minimumRelayPaths: 1 },
    requestImpl: async () => { requests += 1; },
    nowSeconds: () => NOW,
  }), /diversity minimum/);
  await assert.rejects(collectTestVerifiedRfqDeliveries({
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
