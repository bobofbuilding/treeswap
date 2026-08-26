import {
  createClientSafeBlindQuoteSession,
  createTestClientSafeBlindQuoteSession,
} from "./blind-quote-preview.mjs";
import {
  buildMultipathBlindQuoteBook,
  validateBlindSolverOffer,
} from "./blind-rfq.mjs";
import { isVerifiedBitWbtcPoolPriceSignal } from "./bit-wbtc-market-reference.mjs";
import { isVerifiedExecutableVenuePriceSignal } from "./executable-venue-price-signal.mjs";
import {
  MAX_RFQ_DELIVERY_OFFER_CANDIDATES,
  rfqDeliveryPayloadDigest,
  verifiedRfqDeliveryCollection,
} from "./rfq-delivery.mjs";
import {
  isProductionRfqDeliveryService,
  isRfqDeliveryService,
} from "./rfq-delivery-service.mjs";
import {
  MAX_PRICE_SIGNAL_CANDIDATES,
  bitRiskPolicyDigest,
  buildBitRiskAttestation,
  evaluateBitRisk,
} from "./risk-policy.mjs";
import { verifiedSolverQuoteBinding } from "./solver-capability.mjs";

const DATE_NOW = Date.now.bind(Date);
const READER_CALL_FIELDS = Object.freeze(["pricing", "signal"]);
const CALLBACK_READER_FIELDS = Object.freeze(["read"]);
const SERVICE_READER_FIELDS = Object.freeze([
  "blindPolicy",
  "capabilityVerifications",
  "deliveryService",
  "marketRiskPolicy",
  "marketRiskSnapshot",
  "priceSignals",
  "signal",
]);
const TEST_SERVICE_READER_FIELDS = Object.freeze([
  ...SERVICE_READER_FIELDS,
  "nowSeconds",
  "randomBytesImpl",
]);
const PUBLIC_PRICING_FIELDS = Object.freeze([
  "capacityEpoch", "chainId", "direction", "exactOutput", "expiresAt", "maxFeeBps",
  "maxRoutingFeeSats", "outputUnit", "pricingId",
]);
const BLIND_POLICY_FIELDS = Object.freeze([
  "bitToLightningContract", "bitToLightningContractCodeHash", "chainId", "lightningToBitContract",
  "lightningToBitContractCodeHash", "marketRiskPolicyDigest", "maxClockSkewSeconds",
  "maxOffersPerRequest", "maxQuoteTtlSeconds", "minimumIndependentSolvers",
]);
const MARKET_RISK_POLICY_FIELDS = Object.freeze([
  "allowedPriceSourcePolicyDigests", "baseFeeBpsBitToLightning", "baseFeeBpsLightningToBit",
  "chainId", "decimals", "expectedImplementation", "expectedImplementationCodeHash",
  "expectedProxyCodeHash", "maxEpochBitWei", "maxFeeBps", "maxFinalityLagBlocks",
  "maxMarketDeviationBps", "maxPriceAgeSeconds", "maxSignalSpreadBps", "maxSnapshotAgeSeconds",
  "maxSwapBitWei", "minPriceSources", "proxyAddress", "referenceSatsPerBit", "reserveFloorBps",
  "scarcityStartsBps",
]);
const MARKET_RISK_SNAPSHOT_FIELDS = Object.freeze([
  "availableBitWei", "availableLightningSats", "bitCapacityWei", "chainId", "decimals",
  "epochBitVolumeWei", "finalizedBlock", "implementation", "implementationCodeHash", "latestBlock",
  "lightningCapacitySats", "observedAt", "paused", "proxyAddress", "proxyCodeHash",
]);
const READERS = new WeakMap();
const READER_LEASES = new WeakMap();
const BOUND_SERVICES = new WeakSet();

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const wanted = [...expected].sort();
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const actual = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function exactDataArray(value, name, maximumLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value")
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
      || lengthDescriptor.value > maximumLength) {
    throw new RangeError(`${name} length is invalid or unbounded`);
  }
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (keys.length !== expected.size
      || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError(`${name} must be dense and contain no extra properties`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function snapshotRecord(value, fields, name) {
  const source = exactDataRecord(value, fields, name);
  const entries = fields.map((field) => {
    const entry = source[field];
    if (entry === null || !["bigint", "boolean", "number", "string"].includes(typeof entry)) {
      throw new TypeError(`${name}.${field} must be a primitive data value`);
    }
    return [field, entry];
  });
  return Object.freeze(Object.fromEntries(entries));
}

function snapshotPolicy(value) {
  const policy = exactDataRecord(value, MARKET_RISK_POLICY_FIELDS, "RFQ ingress market-risk policy");
  const allowed = exactDataArray(
    policy.allowedPriceSourcePolicyDigests,
    "RFQ ingress allowed price-source policy set",
    MAX_PRICE_SIGNAL_CANDIDATES,
  );
  if (allowed.some((digest) => typeof digest !== "string"
      || !/^0x(?!0{64}$)[0-9a-f]{64}$/.test(digest))) {
    throw new TypeError("RFQ ingress allowed price-source policy digests must be nonzero lowercase bytes32");
  }
  const result = {};
  for (const field of MARKET_RISK_POLICY_FIELDS) {
    if (field === "allowedPriceSourcePolicyDigests") continue;
    const entry = policy[field];
    if (entry === null || !["bigint", "boolean", "number", "string"].includes(typeof entry)) {
      throw new TypeError(`RFQ ingress market-risk policy.${field} must be a primitive data value`);
    }
    result[field] = entry;
  }
  return Object.freeze({ ...result, allowedPriceSourcePolicyDigests: allowed });
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function unsignedInteger(value, name) {
  let raw;
  if (typeof value === "bigint" && value >= 0n) raw = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) raw = String(value);
  else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) raw = value;
  else throw new TypeError(`${name} must be a canonical unsigned integer data value`);
  return BigInt(raw);
}

function publicPricing(value) {
  return snapshotRecord(value, PUBLIC_PRICING_FIELDS, "RFQ ingress reader pricing");
}

function marketRequest(direction, offer, now) {
  return Object.freeze({
    now,
    direction,
    bitWei: offer.grossBitAmount - offer.feeBitAmount,
    lightningSats: offer.lightningAmountSats,
  });
}

function readerIsActive(context) {
  if (context.state !== "active" || context.deploymentSignal.aborted) return false;
  try {
    return context.isActive() === true;
  } catch {
    return false;
  }
}

function activeReader(context) {
  if (!readerIsActive(context)) {
    context.state = "stopped";
    throw new Error("RFQ quote ingress reader is stopped");
  }
}

function readerStatus(context) {
  return Object.freeze({
    schema: "treeswap.rfq-quote-ingress-reader-status.v1",
    state: context.state,
    mode: context.mode,
    source: context.source,
    requestsStarted: context.started,
    requestsCompleted: context.completed,
    requestsFailed: context.failed,
    requestsInFlight: context.inFlight,
    fundingAuthorization: false,
    settlementAuthorization: false,
    signingAuthorization: false,
    networkListener: false,
  });
}

function buildReader({ mode, source, deploymentSignal, isActive, readImpl }) {
  const context = {
    completed: 0,
    deploymentSignal,
    failed: 0,
    inFlight: 0,
    isActive,
    lease: null,
    mode,
    readImpl,
    source,
    started: 0,
    state: deploymentSignal.aborted ? "stopped" : "active",
  };
  const stop = () => { context.state = "stopped"; };
  deploymentSignal.addEventListener("abort", stop, { once: true });
  const reader = Object.freeze({
    async read(input) {
      if (this !== reader || READERS.get(this) !== context) {
        throw new TypeError("RFQ quote ingress reader lacks factory provenance");
      }
      if (context.lease) throw new Error("RFQ quote ingress reader is route-owned");
      activeReader(context);
      const call = exactDataRecord(input, READER_CALL_FIELDS, "RFQ quote ingress reader call");
      const pricing = publicPricing(call.pricing);
      if (!(call.signal instanceof AbortSignal)) {
        throw new TypeError("RFQ quote ingress reader requires an AbortSignal");
      }
      context.started += 1;
      context.inFlight += 1;
      try {
        const result = await context.readImpl(pricing, AbortSignal.any([
          context.deploymentSignal,
          call.signal,
        ]));
        context.completed += 1;
        return result;
      } catch (error) {
        context.failed += 1;
        throw error;
      } finally {
        context.inFlight -= 1;
      }
    },
    status() {
      if (this !== reader || READERS.get(this) !== context) {
        throw new TypeError("RFQ quote ingress reader lacks factory provenance");
      }
      if (!readerIsActive(context)) context.state = "stopped";
      return readerStatus(context);
    },
  });
  READERS.set(reader, context);
  return reader;
}

function serviceReader(rawInput, {
  expectedProduction,
  mode,
  nowSeconds,
  sessionFactory,
}) {
  const expectedFields = expectedProduction ? SERVICE_READER_FIELDS : TEST_SERVICE_READER_FIELDS;
  const source = exactDataRecord(rawInput, expectedFields, "RFQ quote ingress service-reader input");
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("RFQ quote ingress service reader requires an active deployment AbortSignal");
  }
  if (!isRfqDeliveryService(source.deliveryService)
      || isProductionRfqDeliveryService(source.deliveryService) !== expectedProduction
      || source.deliveryService.status().state !== "active") {
    throw new TypeError("RFQ quote ingress service reader requires a matching active RFQ delivery service");
  }
  if (BOUND_SERVICES.has(source.deliveryService)) {
    throw new TypeError("RFQ delivery service is already bound to an ingress reader");
  }
  const blindPolicy = snapshotRecord(source.blindPolicy, BLIND_POLICY_FIELDS, "RFQ ingress blind policy");
  const marketRiskPolicy = snapshotPolicy(source.marketRiskPolicy);
  const marketRiskSnapshot = snapshotRecord(
    source.marketRiskSnapshot,
    MARKET_RISK_SNAPSHOT_FIELDS,
    "RFQ ingress market-risk snapshot",
  );
  const policyDigest = bitRiskPolicyDigest(marketRiskPolicy);
  if (blindPolicy.marketRiskPolicyDigest !== policyDigest) {
    throw new Error("RFQ ingress blind policy is not bound to the exact market-risk policy");
  }
  const blindChainId = unsignedInteger(blindPolicy.chainId, "RFQ ingress blind-policy chain ID");
  const riskChainId = unsignedInteger(marketRiskPolicy.chainId, "RFQ ingress risk-policy chain ID");
  const snapshotChainId = unsignedInteger(marketRiskSnapshot.chainId, "RFQ ingress risk-snapshot chain ID");
  if (blindChainId !== riskChainId || snapshotChainId !== riskChainId) {
    throw new Error("RFQ ingress service reader chain bindings disagree");
  }
  const minimumIndependentSolvers = unsignedInteger(
    blindPolicy.minimumIndependentSolvers,
    "RFQ ingress minimum independent solvers",
  );
  if (minimumIndependentSolvers < 2n
      || minimumIndependentSolvers > BigInt(MAX_RFQ_DELIVERY_OFFER_CANDIDATES)) {
    throw new RangeError("RFQ ingress minimum independent solver count is unsafe");
  }
  const minimumSolvers = Number(minimumIndependentSolvers);

  const capabilities = exactDataArray(
    source.capabilityVerifications,
    "RFQ ingress solver capability set",
    MAX_RFQ_DELIVERY_OFFER_CANDIDATES,
  );
  if (capabilities.length < minimumSolvers) {
    throw new RangeError("RFQ ingress service reader lacks the required solver capabilities");
  }
  const capabilityBindings = new Map();
  for (const verification of capabilities) {
    const binding = verifiedSolverQuoteBinding(verification);
    const key = `${binding.direction}:${binding.solverId.toLowerCase()}`;
    if (capabilityBindings.has(key)) {
      throw new Error("RFQ ingress solver capability set contains a duplicate direction and solver");
    }
    if (unsignedInteger(binding.chainId, "RFQ ingress capability chain ID") !== blindChainId) {
      throw new Error("RFQ ingress solver capability belongs to another chain");
    }
    capabilityBindings.set(key, Object.freeze({ binding, verification }));
  }

  const priceSignals = exactDataArray(
    source.priceSignals,
    "RFQ ingress price-signal set",
    MAX_PRICE_SIGNAL_CANDIDATES,
  );
  let poolSignals = 0;
  for (const signal of priceSignals) {
    const executable = isVerifiedExecutableVenuePriceSignal(signal);
    const pool = isVerifiedBitWbtcPoolPriceSignal(signal);
    if (!executable && !pool) {
      throw new TypeError("RFQ ingress price signal lacks original verifier provenance");
    }
    if (pool) poolSignals += 1;
  }
  if (poolSignals > 1) {
    throw new RangeError("RFQ ingress permits at most one BIT/WBTC pool signal");
  }

  const readImpl = async (pricing, signal) => {
    if (signal.aborted) throw new Error("RFQ quote ingress collection was cancelled");
    if (source.deliveryService.status().state !== "active") {
      throw new Error("RFQ delivery service stopped before quote collection");
    }
    const now = integer(nowSeconds(), "RFQ ingress service-reader time");
    const selectedCapabilities = capabilities.filter((verification) => (
      verifiedSolverQuoteBinding(verification).direction === pricing.direction
    ));
    if (selectedCapabilities.length < minimumSolvers) {
      throw new RangeError("RFQ ingress lacks current solver capabilities for the requested direction");
    }
    const requestDigest = rfqDeliveryPayloadDigest(pricing);
    const collection = await source.deliveryService.collect({
      requestDigest,
      requestId: pricing.pricingId,
      rfq: pricing,
      signal,
    });
    const delivery = verifiedRfqDeliveryCollection(collection);
    const attestations = new Map();
    for (const path of delivery.deliveries) {
      for (const rawEnvelope of path.envelopes) {
        let verification = null;
        const rawOffer = rawEnvelope && typeof rawEnvelope === "object" && !Array.isArray(rawEnvelope)
          ? Object.getOwnPropertyDescriptor(rawEnvelope, "offer")
          : null;
        const rawSolver = rawOffer && Object.hasOwn(rawOffer, "value")
            && rawOffer.enumerable === true && rawOffer.value && typeof rawOffer.value === "object"
          ? Object.getOwnPropertyDescriptor(rawOffer.value, "solver")
          : null;
        if (rawSolver && Object.hasOwn(rawSolver, "value") && rawSolver.enumerable === true
            && typeof rawSolver.value === "string") {
          const solver = rawSolver.value.toLowerCase();
          verification = capabilityBindings.get(`${pricing.direction}:${solver}`)?.verification ?? null;
        }
        const checked = validateBlindSolverOffer({
          capabilityVerification: verification,
          envelope: rawEnvelope,
          now,
          policy: blindPolicy,
          pricing,
        });
        if (!checked.valid) continue;
        const request = marketRequest(pricing.direction, checked.envelope.offer, now);
        const evaluation = evaluateBitRisk({
          policy: marketRiskPolicy,
          priceSignals,
          request,
          snapshot: marketRiskSnapshot,
        });
        if (!evaluation.enabled) continue;
        const attestation = buildBitRiskAttestation({
          evaluation,
          policy: marketRiskPolicy,
          request,
          snapshot: marketRiskSnapshot,
        });
        if (!attestations.has(attestation.requestDigest)) {
          attestations.set(attestation.requestDigest, attestation);
        }
      }
    }
    if (signal.aborted) throw new Error("RFQ quote ingress collection was cancelled");
    const book = buildMultipathBlindQuoteBook({
      capabilityVerifications: selectedCapabilities,
      collection,
      marketRiskAttestations: [...attestations.values()],
      now,
      policy: blindPolicy,
      pricing,
    });
    return sessionFactory(book);
  };

  const reader = buildReader({
    deploymentSignal: source.signal,
    isActive: () => source.deliveryService.status().state === "active",
    mode,
    readImpl,
    source: "delivery-service",
  });
  BOUND_SERVICES.add(source.deliveryService);
  return reader;
}

export function createRfqQuoteIngressReader(input) {
  return serviceReader(input, {
    expectedProduction: true,
    mode: "production",
    nowSeconds: () => Math.floor(DATE_NOW() / 1_000),
    sessionFactory: (book) => createClientSafeBlindQuoteSession(book),
  });
}

export function createTestRfqQuoteIngressServiceReader(input) {
  const source = exactDataRecord(
    input,
    TEST_SERVICE_READER_FIELDS,
    "test RFQ quote ingress service-reader input",
  );
  if (typeof source.nowSeconds !== "function" || typeof source.randomBytesImpl !== "function") {
    throw new TypeError("test RFQ quote ingress service reader requires injected clock and entropy functions");
  }
  return serviceReader(input, {
    expectedProduction: false,
    mode: "injected-test",
    nowSeconds: source.nowSeconds,
    sessionFactory: (book) => createTestClientSafeBlindQuoteSession({
      book,
      nowSeconds: source.nowSeconds,
      randomBytesImpl: source.randomBytesImpl,
    }),
  });
}

export function createTestRfqQuoteIngressReader(input) {
  const source = exactDataRecord(input, CALLBACK_READER_FIELDS, "test RFQ quote ingress reader input");
  if (typeof source.read !== "function") {
    throw new TypeError("test RFQ quote ingress reader requires a read function");
  }
  const deployment = new AbortController();
  return buildReader({
    deploymentSignal: deployment.signal,
    isActive: () => true,
    mode: "injected-test",
    readImpl: (pricing, signal) => source.read(pricing, { signal }),
    source: "test-callback",
  });
}

export function isRfqQuoteIngressReader(value) {
  return Boolean(value && READERS.has(value));
}

export function claimRfqQuoteIngressReaderOwnership(value, deploymentSignal) {
  const context = READERS.get(value);
  if (!context) throw new TypeError("RFQ quote ingress reader lacks factory provenance");
  if (!(deploymentSignal instanceof AbortSignal)) {
    throw new TypeError("RFQ quote ingress reader ownership requires an AbortSignal");
  }
  if (context.source === "delivery-service" && deploymentSignal !== context.deploymentSignal) {
    throw new TypeError("RFQ quote ingress reader and route must share one deployment lifecycle");
  }
  activeReader(context);
  if (context.lease) throw new TypeError("RFQ quote ingress reader is already route-owned");
  if (context.inFlight !== 0) throw new TypeError("RFQ quote ingress reader has an active unowned request");
  const lease = Object.freeze({
    read(input) {
      if (this !== lease || READER_LEASES.get(this) !== context) {
        throw new TypeError("RFQ quote ingress reader lease lacks factory provenance");
      }
      activeReader(context);
      const call = exactDataRecord(input, READER_CALL_FIELDS, "RFQ quote ingress reader call");
      const pricing = publicPricing(call.pricing);
      if (!(call.signal instanceof AbortSignal)) {
        throw new TypeError("RFQ quote ingress reader requires an AbortSignal");
      }
      context.started += 1;
      context.inFlight += 1;
      try {
        return Promise.resolve(context.readImpl(pricing, AbortSignal.any([
          context.deploymentSignal,
          call.signal,
        ]))).then((result) => {
          context.completed += 1;
          return result;
        }, (error) => {
          context.failed += 1;
          throw error;
        }).finally(() => {
          context.inFlight -= 1;
        });
      } catch (error) {
        context.failed += 1;
        context.inFlight -= 1;
        throw error;
      }
    },
    close() {
      if (this !== lease || READER_LEASES.get(this) !== context) {
        throw new TypeError("RFQ quote ingress reader lease lacks factory provenance");
      }
      context.state = "stopped";
      return readerStatus(context);
    },
  });
  context.lease = lease;
  READER_LEASES.set(lease, context);
  return lease;
}

export function rfqQuoteIngressReaderMode(value) {
  const mode = READERS.get(value)?.mode;
  if (!mode) throw new TypeError("RFQ quote ingress reader lacks factory provenance");
  return mode;
}
