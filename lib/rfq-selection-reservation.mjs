import { randomBytes } from "node:crypto";
import {
  getAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  assertBlindQuoteSelectionCapability,
  activeBlindQuoteReservationBinding,
  authorizeFinalizedBlindQuote,
  bindFinalizedSolverInvoice,
  buildBlindQuoteSelectionAuthorization,
  buildFinalizedQuoteUserAuthorization,
  buildSelectedSolverDisclosure,
  finalizeSelectedBlindQuote,
  reserveSelectedBlindQuote,
  USER_EXECUTION_AUTHORIZATION_TYPES,
  USER_SELECTION_AUTHORIZATION_TYPES,
  verifiedBlindQuoteSelection,
  verifyBlindQuoteSelectionAuthorization,
} from "./blind-rfq.mjs";
import {
  CoordinatorStore,
  isVerifiedCoordinatorStore,
  validatedCoordinatorAdmissionPolicy,
} from "./coordinator-store.mjs";
import {
  validateFullFillInvoice,
  validatedInvoicePolicy,
} from "./invoice-policy.mjs";
import { rfqRequestDigest, rfqRequestPayload } from "./rfq.mjs";
import {
  verifiedSolverCapacityRecord,
  verifiedSolverQuoteBinding,
  verifiedSolverRecoveryAuthority,
} from "./solver-capability.mjs";
import {
  assertSelectedSolverFinalizationClientLifecycle,
  selectedSolverFinalizationClientMode,
} from "./selected-solver-finalization-transport.mjs";

const LOWER_BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const DATE_NOW = Date.now.bind(Date);
const SERVICES = new WeakMap();
const BOUND_SERVICES = new WeakSet();
const BOUND_CEREMONY_SERVICES = new WeakSet();
const BOUND_FINALIZATION_SERVICES = new WeakSet();
const ACTIVE_BOUND_SERVICES = new WeakSet();
const ACTIVE_CEREMONY_SERVICES = new WeakSet();
const ACTIVE_FINALIZATION_SERVICES = new WeakSet();
const RESERVATION_LEASES = new WeakMap();
const CEREMONY_LEASES = new WeakMap();
const FINALIZATION_LEASES = new WeakMap();
const ADMISSION_POLICY_FIELDS = Object.freeze([
  "establishedSolverMaxBitToLightningSats",
  "maxActiveFirmQuotesPerSolver",
  "maxActiveRequestsPerIdentity",
  "maxCancellationsPerWindow",
  "maxCapacityAgeSeconds",
  "maxConsecutiveFailures",
  "maxFirmQuoteTtlSeconds",
  "maxGlobalBitToLightningInFlightSats",
  "maxRequestsPerWindow",
  "maxRfqTtlSeconds",
  "minimumCompletedFillsForEstablished",
  "minimumNotionalSats",
  "minimumReliabilityBps",
  "minimumReliabilitySample",
  "quotaWindowSeconds",
  "unknownSolverMaxBitToLightningSats",
]);
const REQUEST_FIELDS = Object.freeze([
  "beneficiary",
  "chainId",
  "direction",
  "exactBitOutputWei",
  "exactLightningOutputSats",
  "expiresAt",
  "invoiceDigest",
  "maxFeeBps",
  "maxRoutingFeeSats",
  "nonce",
  "paymentHash",
  "requestId",
  "user",
  "verifyingContract",
]);
const SELECTION_AUTHORIZATION_FIELDS = Object.freeze([
  "authorizationExpiresAt",
  "beneficiary",
  "direction",
  "feeBitAmount",
  "grossBitAmount",
  "invoiceDigest",
  "lightningAmountSats",
  "maxRoutingFeeSats",
  "paymentHash",
  "pricingDigest",
  "pricingId",
  "quoteExpiresAt",
  "receivedSetDigest",
  "requestDigest",
  "requestId",
  "requestNonce",
  "selectedBlindOfferDigest",
  "selectedSolver",
  "user",
]);
const SERVICE_FIELDS = Object.freeze([
  "admissionPolicy",
  "capabilityVerifications",
  "coordinatorStore",
  "invoicePolicy",
  "maximumPendingSelections",
  "signal",
]);
const TEST_SERVICE_FIELDS = Object.freeze([
  ...SERVICE_FIELDS,
  "nowSeconds",
  "randomBytesImpl",
]);
const ACCEPT_FIELDS = Object.freeze([
  "expiresAt",
  "identityCommitment",
  "requestNonce",
  "selection",
  "user",
]);
const PREPARE_FIELDS = Object.freeze([
  "authorizationExpiresAt",
  "request",
  "reservationToken",
]);
const RESERVE_FIELDS = Object.freeze([
  "authorization",
  "request",
  "reservationToken",
  "signature",
]);
const FINALIZE_FIELDS = Object.freeze([
  "invoice",
  "request",
  "reservationToken",
]);
const AUTHORIZE_FIELDS = Object.freeze([
  "authorization",
  "request",
  "reservationToken",
  "signature",
]);
const EXECUTION_AUTHORIZATION_FIELDS = Object.freeze([
  "authorizationExpiresAt",
  "beneficiary",
  "direction",
  "executableOfferDigest",
  "executionBindingDigest",
  "feeBitAmount",
  "grossBitAmount",
  "invoiceDigest",
  "lightningAmountSats",
  "maxRoutingFeeSats",
  "paymentHash",
  "quoteExpiresAt",
  "requestDigest",
  "selectedSolver",
  "selectionAuthorizationDigest",
  "user",
]);
const QUOTE_POLICY_FIELDS = Object.freeze([
  "maxClockSkewSeconds",
  "maxOffersPerRequest",
  "maxQuoteTtlSeconds",
  "maxSourceLength",
  "minimumIndependentSolvers",
]);
const COORDINATOR_METHODS = Object.freeze({
  admitRfq: CoordinatorStore.prototype.admitRfq,
  recordSolverCapacity: CoordinatorStore.prototype.recordSolverCapacity,
  reserveVerifiedFirmOffer: CoordinatorStore.prototype.reserveVerifiedFirmOffer,
});

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
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 1 || length > maximumLength) {
    throw new RangeError(`${name} length is outside policy`);
  }
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

function scalar(value, name) {
  if (typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new TypeError(`${name} must be a primitive integer or string`);
}

function snapshotRecord(value, fields, name) {
  const source = exactDataRecord(value, fields, name);
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, scalar(source[field], `${name}.${field}`)])));
}

function snapshotRequest(value) {
  return snapshotRecord(value, REQUEST_FIELDS, "private RFQ request");
}

function snapshotAuthorization(value) {
  return snapshotRecord(value, SELECTION_AUTHORIZATION_FIELDS, "selection authorization");
}

function snapshotExecutionAuthorization(value) {
  return snapshotRecord(value, EXECUTION_AUTHORIZATION_FIELDS, "execution authorization");
}

function snapshotQuotePolicy(value) {
  const source = snapshotRecord(
    value,
    QUOTE_POLICY_FIELDS,
    "selected-solver executable quote policy",
  );
  const policy = Object.freeze({
    maxSourceLength: integer(source.maxSourceLength, "quote policy source limit", 1, 64),
    maxClockSkewSeconds: integer(source.maxClockSkewSeconds, "quote policy clock skew", 0, 60),
    maxQuoteTtlSeconds: integer(source.maxQuoteTtlSeconds, "quote policy quote TTL", 1, 300),
    maxOffersPerRequest: integer(source.maxOffersPerRequest, "quote policy offer limit", 2, 128),
    minimumIndependentSolvers: integer(
      source.minimumIndependentSolvers,
      "quote policy independent-solver minimum",
      2,
      128,
    ),
  });
  if (policy.minimumIndependentSolvers > policy.maxOffersPerRequest) {
    throw new RangeError("quote policy independent-solver minimum exceeds its offer limit");
  }
  return policy;
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function uint(value, name) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`${name} must be a canonical unsigned integer`);
  }
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${name} must be a canonical unsigned integer`);
  }
  const raw = String(value);
  if (!DECIMAL.test(raw) || raw.length > UINT256_MAX.toString().length || BigInt(raw) > UINT256_MAX) {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
  return raw;
}

function bytes32(value, name) {
  if (typeof value !== "string" || !LOWER_BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  }
  return value;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a nonzero Ethereum address`);
  try {
    const normalized = getAddress(value);
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function randomToken(randomBytesImpl) {
  const value = randomBytesImpl(32);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("selection reservation entropy must return bytes");
  }
  const bytes = Buffer.from(value);
  if (bytes.length !== 32) throw new RangeError("selection reservation entropy must return 32 bytes");
  const token = `0x${bytes.toString("hex")}`;
  return bytes32(token, "selection reservation token");
}

function tokenDigest(token) {
  return keccak256(toUtf8Bytes(token));
}

function wireValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return Object.freeze(value.map(wireValue));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wireValue(item)])));
  }
  return value;
}

function signableMaterial(material) {
  return Object.freeze({
    schema: "treeswap.selection-reservation-signing-payload.v1",
    primaryType: "UserSelectionAuthorization",
    domain: wireValue(material.domain),
    types: wireValue(USER_SELECTION_AUTHORIZATION_TYPES),
    message: wireValue(material.message),
    digest: material.digest,
    fundingAuthorization: false,
    settlementAuthorization: false,
  });
}

function executableSignableMaterial(material, invoice) {
  return Object.freeze({
    schema: "treeswap.selected-solver-execution-signing-payload.v1",
    primaryType: "UserExecutionAuthorization",
    domain: wireValue(material.domain),
    types: wireValue(USER_EXECUTION_AUTHORIZATION_TYPES),
    message: wireValue(material.message),
    digest: material.digest,
    invoice: String(invoice),
    movesFundsImmediately: false,
    requiresSeparateAssetAction: true,
    fundingAuthorization: false,
    settlementAuthorization: true,
  });
}

function finalizationAck(record) {
  const offer = record.finalization.envelope.offer;
  return Object.freeze({
    schema: "treeswap.selected-solver-authorization-ack.v1",
    status: "authorized",
    direction: record.selection.pricing.direction,
    selectedOfferId: record.reservation.selectedOfferId,
    selectedSolver: record.reservation.selectedSolver,
    paymentHash: offer.paymentHash,
    invoiceDigest: offer.invoiceDigest,
    invoice: record.invoice,
    expiresAt: record.authorized.userAuthorizationExpiresAt,
    requiresSeparateAssetAction: true,
    fundingAuthorization: false,
    settlementDispatchAuthority: false,
  });
}

function reservationAck(record) {
  return Object.freeze({
    schema: "treeswap.selection-reservation-ack.v1",
    status: "reserved",
    expiresAt: record.expiresAt,
    privateExecutionRequired: true,
    fundingAuthorization: false,
    settlementAuthorization: false,
  });
}

function capabilityIndex(values) {
  const capabilities = exactDataArray(values, "selection reservation capabilities", 128);
  const bySolverDirection = new Map();
  for (const capability of capabilities) {
    const binding = verifiedSolverQuoteBinding(capability);
    const key = `${binding.solverId.toLowerCase()}:${binding.direction}`;
    if (bySolverDirection.has(key)) {
      throw new TypeError("selection reservation capabilities contain a duplicate solver direction");
    }
    bySolverDirection.set(key, capability);
  }
  return Object.freeze({ capabilities, bySolverDirection });
}

function assertStore(store) {
  if (!isVerifiedCoordinatorStore(store) || !(store instanceof CoordinatorStore)) {
    throw new TypeError("selection reservation requires a factory-opened durable coordinator store");
  }
  for (const [name, method] of Object.entries(COORDINATOR_METHODS)) {
    if (CoordinatorStore.prototype[name] !== method || store[name] !== method) {
      throw new TypeError("selection reservation requires unmodified coordinator store methods");
    }
  }
  return store;
}

function createService(input, mode, { nowSeconds, randomBytesImpl }) {
  const source = exactDataRecord(input, SERVICE_FIELDS, "selection reservation service input");
  const admissionPolicy = validatedCoordinatorAdmissionPolicy(
    snapshotRecord(
      source.admissionPolicy,
      ADMISSION_POLICY_FIELDS,
      "selection reservation admission policy",
    ),
  );
  const { capabilities, bySolverDirection } = capabilityIndex(source.capabilityVerifications);
  const coordinatorStore = assertStore(source.coordinatorStore);
  const invoicePolicy = validatedInvoicePolicy(source.invoicePolicy);
  const maximumPendingSelections = integer(
    source.maximumPendingSelections,
    "selection reservation pending limit",
    1,
    4_096,
  );
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("selection reservation requires an active deployment AbortSignal");
  }
  const deploymentSignal = source.signal;
  const records = new Map();
  const context = {
    accepted: 0,
    capabilities,
    failed: 0,
    invoicePolicy,
    mode,
    prepared: 0,
    records,
    reservations: 0,
    signal: deploymentSignal,
    state: "active",
  };

  const observeNow = () => integer(nowSeconds(), "selection reservation time", 1);
  const cleanup = (now) => {
    for (const [key, record] of records) {
      if (record.expiresAt <= now) records.delete(key);
    }
  };
  const assertActive = () => {
    if (context.state !== "active" || deploymentSignal.aborted) {
      throw new Error("selection reservation service is stopped");
    }
  };
  const findRecord = (reservationToken, now) => {
    assertActive();
    const token = bytes32(reservationToken, "selection reservation token");
    cleanup(now);
    const record = records.get(tokenDigest(token));
    if (!record || record.expiresAt <= now) {
      throw new Error("selection reservation token is unavailable or expired");
    }
    return record;
  };
  context.findRecord = findRecord;
  context.observeNow = observeNow;
  const stop = () => {
    if (context.state === "stopped") return;
    context.state = "stopped";
    records.clear();
    deploymentSignal.removeEventListener("abort", stop);
  };
  context.stop = stop;
  deploymentSignal.addEventListener("abort", stop, { once: true });

  const accept = (inputValue) => {
    assertActive();
    const acceptedAt = observeNow();
    cleanup(acceptedAt);
    if (records.size >= maximumPendingSelections) {
      throw new Error("selection reservation pending limit is exhausted");
    }
    const value = exactDataRecord(inputValue, ACCEPT_FIELDS, "selection reservation handoff");
    const user = address(value.user, "selection reservation user");
    const identityCommitment = bytes32(
      value.identityCommitment,
      "selection reservation identity commitment",
    );
    const requestNonce = uint(value.requestNonce, "selection reservation request nonce");
    if (requestNonce === "0") throw new RangeError("selection reservation request nonce must be positive");
    const expiresAt = integer(value.expiresAt, "selection reservation expiry", acceptedAt + 1);
    const selection = verifiedBlindQuoteSelection(value.selection);
    const selectedSolver = address(selection?.selected?.offer?.solver, "selected solver");
    const direction = selection?.pricing?.direction;
    const capability = bySolverDirection.get(`${selectedSolver.toLowerCase()}:${direction}`);
    if (!capability) throw new Error("selected solver lacks the exact configured capability");
    assertBlindQuoteSelectionCapability(selection, capability);
    const binding = verifiedSolverQuoteBinding(capability);
    const marketRiskValidUntil = integer(
      Number(selection.marketRiskValidUntil),
      "selection market-risk expiry",
      acceptedAt + 1,
    );
    const maximumExpiry = Math.min(
      selection.pricing.expiresAt,
      selection.selected.offer.expiresAt,
      marketRiskValidUntil,
      binding.expiresAt,
    );
    if (expiresAt > maximumExpiry) {
      throw new Error("selection reservation outlives its authenticated quote evidence");
    }
    const reservationToken = randomToken(randomBytesImpl);
    const digest = tokenDigest(reservationToken);
    if (records.has(digest)) throw new Error("selection reservation entropy repeated");
    records.set(digest, Object.freeze({
      capability,
      expiresAt,
      identityCommitment,
      requestNonce,
      selection,
      state: "selected",
      user,
    }));
    context.accepted += 1;
    return Object.freeze({
      reservationToken,
      expiresAt,
      privateSettlementRequired: true,
      fundingAuthorization: false,
      settlementAuthorization: false,
    });
  };
  context.accept = accept;

  const prepare = (inputValue) => {
    try {
      const value = exactDataRecord(inputValue, PREPARE_FIELDS, "selection reservation preparation");
      const now = observeNow();
      const record = findRecord(value.reservationToken, now);
      if (record.state === "reserved") throw new Error("selection reservation is already durable");
      const request = snapshotRequest(value.request);
      const payload = rfqRequestPayload(request);
      if (!sameAddress(payload.user, record.user)) {
        throw new Error("private RFQ user changed after quote selection");
      }
      const authorizationExpiresAt = integer(
        value.authorizationExpiresAt,
        "selection authorization expiry",
        now + 1,
        record.expiresAt,
      );
      const material = buildBlindQuoteSelectionAuthorization({
        selection: record.selection,
        request,
        authorizationExpiresAt,
      });
      const signingPayload = signableMaterial(material);
      context.prepared += 1;
      return signingPayload;
    } catch (error) {
      context.failed += 1;
      throw error;
    }
  };
  context.prepare = prepare;

  const reserve = (inputValue) => {
    try {
      const value = exactDataRecord(inputValue, RESERVE_FIELDS, "selection reservation confirmation");
      const now = observeNow();
      const record = findRecord(value.reservationToken, now);
      if (record.state !== "selected" && record.state !== "reserved") {
        throw new Error("selection reservation is not available for confirmation");
      }
      const request = snapshotRequest(value.request);
      rfqRequestDigest(request);
      const authorization = snapshotAuthorization(value.authorization);
      if (typeof value.signature !== "string") {
        throw new TypeError("selection authorization signature must be a string");
      }
      const userAuthorization = verifyBlindQuoteSelectionAuthorization({
        selection: record.selection,
        request,
        authorization,
        signature: value.signature,
        now,
      });
      if (userAuthorization.authorizationExpiresAt > record.expiresAt) {
        throw new Error("selection authorization outlives the reservation ceremony");
      }
      if (record.state === "reserved") {
        if (record.userAuthorization.selectionAuthorizationDigest
              !== userAuthorization.selectionAuthorizationDigest) {
          throw new Error("selection reservation confirmation changed after durable reservation");
        }
        activeBlindQuoteReservationBinding(record.reservation, { now });
        return reservationAck(record);
      }
      const store = assertStore(coordinatorStore);
      COORDINATOR_METHODS.recordSolverCapacity.call(
        store,
        verifiedSolverCapacityRecord(record.capability),
      );
      COORDINATOR_METHODS.admitRfq.call(store, {
        identity: {
          authenticated: true,
          commitment: record.identityCommitment,
          key: record.user,
        },
        request: {
          requestId: record.selection.pricingId,
          user: record.user,
          direction: record.selection.pricing.direction,
          notionalSats: record.selection.selected.offer.lightningAmountSats.toString(),
          nonce: record.requestNonce,
          expiresAt: record.selection.pricing.expiresAt,
        },
        policy: admissionPolicy,
        now,
      });
      const reservation = reserveSelectedBlindQuote({
        selection: record.selection,
        userAuthorization,
        capabilityVerification: record.capability,
        coordinatorStore: store,
        admissionPolicy,
        now,
      });
      const reserved = Object.freeze({
        ...record,
        expiresAt: Math.min(reservation.expiresAt, userAuthorization.authorizationExpiresAt),
        reservation,
        state: "reserved",
        userAuthorization,
      });
      records.set(tokenDigest(value.reservationToken), reserved);
      context.reservations += 1;
      return reservationAck(reserved);
    } catch (error) {
      context.failed += 1;
      throw error;
    }
  };
  context.reserve = reserve;

  const service = Object.freeze({
    prepare(inputValue) {
      if (this !== service || SERVICES.get(this) !== context) {
        throw new TypeError("selection reservation service lacks factory provenance");
      }
      if (BOUND_CEREMONY_SERVICES.has(service)) {
        throw new TypeError("selection reservation ceremony is route-owned");
      }
      return prepare(inputValue);
    },
    reserve(inputValue) {
      if (this !== service || SERVICES.get(this) !== context) {
        throw new TypeError("selection reservation service lacks factory provenance");
      }
      if (BOUND_CEREMONY_SERVICES.has(service)) {
        throw new TypeError("selection reservation ceremony is route-owned");
      }
      return reserve(inputValue);
    },
    status() {
      if (this !== service || SERVICES.get(this) !== context) {
        throw new TypeError("selection reservation service lacks factory provenance");
      }
      const now = observeNow();
      cleanup(now);
      let selected = 0;
      let prepared = 0;
      let reserved = 0;
      let finalizing = 0;
      let finalized = 0;
      let authorized = 0;
      let failedFinalizations = 0;
      for (const record of records.values()) {
        if (record.state === "selected") selected += 1;
        if (record.state === "prepared") prepared += 1;
        if (record.state === "reserved") reserved += 1;
        if (record.state === "finalizing") finalizing += 1;
        if (record.state === "finalized") finalized += 1;
        if (record.state === "authorized") authorized += 1;
        if (record.state === "finalization-failed") failedFinalizations += 1;
      }
      return Object.freeze({
        schema: "treeswap.selection-reservation-status.v2",
        state: context.state,
        mode: context.mode,
        selectionsAccepted: context.accepted,
        signingPayloadsPrepared: context.prepared,
        reservationsCompleted: context.reservations,
        requestsFailed: context.failed,
        pendingSelected: selected,
        pendingPrepared: prepared,
        inMemoryReservations: reserved + finalizing + finalized + authorized + failedFinalizations,
        finalizationsInFlightOrRetryable: finalizing,
        executableQuotesFinalized: finalized,
        executionAuthorizationsCompleted: authorized,
        terminalFinalizationFailures: failedFinalizations,
        fundingAuthorization: false,
        settlementAuthorization: false,
        signingAuthority: false,
        networkListener: false,
      });
    },
    stop() {
      if (this !== service || SERVICES.get(this) !== context) {
        throw new TypeError("selection reservation service lacks factory provenance");
      }
      if (ACTIVE_BOUND_SERVICES.has(service) || ACTIVE_CEREMONY_SERVICES.has(service)
          || ACTIVE_FINALIZATION_SERVICES.has(service)) {
        throw new TypeError("selection reservation lifecycle is route-owned");
      }
      stop();
      return this.status();
    },
  });
  SERVICES.set(service, context);
  return service;
}

export function createRfqSelectionReservationService(input) {
  return createService(input, "production", {
    nowSeconds: () => Math.floor(DATE_NOW() / 1_000),
    randomBytesImpl: randomBytes,
  });
}

export function createTestRfqSelectionReservationService(input) {
  const source = exactDataRecord(input, TEST_SERVICE_FIELDS, "test selection reservation service input");
  if (typeof source.nowSeconds !== "function" || typeof source.randomBytesImpl !== "function") {
    throw new TypeError("test selection reservation service requires injected clock and entropy functions");
  }
  return createService(Object.freeze({
    admissionPolicy: source.admissionPolicy,
    capabilityVerifications: source.capabilityVerifications,
    coordinatorStore: source.coordinatorStore,
    invoicePolicy: source.invoicePolicy,
    maximumPendingSelections: source.maximumPendingSelections,
    signal: source.signal,
  }), "injected-test", {
    nowSeconds: source.nowSeconds,
    randomBytesImpl: source.randomBytesImpl,
  });
}

export function isRfqSelectionReservationService(value) {
  return SERVICES.has(value);
}

export function rfqSelectionReservationServiceMode(value) {
  const context = SERVICES.get(value);
  if (!context) throw new TypeError("selection reservation service lacks factory provenance");
  return context.mode;
}

export function assertRfqSelectionReservationOwnershipAvailable(service, signal) {
  const context = SERVICES.get(service);
  if (!context) throw new TypeError("selection reservation service lacks factory provenance");
  if (BOUND_SERVICES.has(service)) throw new TypeError("selection reservation service is already route-bound");
  if (signal !== context.signal || signal.aborted || context.state !== "active") {
    throw new TypeError("selection reservation service and route must share one deployment lifecycle");
  }
  return service;
}

export function claimRfqSelectionReservationOwnership(service, signal) {
  assertRfqSelectionReservationOwnershipAvailable(service, signal);
  const context = SERVICES.get(service);
  BOUND_SERVICES.add(service);
  ACTIVE_BOUND_SERVICES.add(service);
  let state = "active";
  const lease = Object.freeze({
    accept(input) {
      if (this !== lease || RESERVATION_LEASES.get(this) !== context) {
        throw new TypeError("selection reservation route lease lacks factory provenance");
      }
      if (state !== "active") throw new Error("selection reservation route lease is closed");
      return context.accept(input);
    },
    close() {
      if (this !== lease || RESERVATION_LEASES.get(this) !== context) {
        throw new TypeError("selection reservation route lease lacks factory provenance");
      }
      if (state === "closed") return;
      state = "closed";
      ACTIVE_BOUND_SERVICES.delete(service);
      if (!ACTIVE_CEREMONY_SERVICES.has(service)
          && !ACTIVE_FINALIZATION_SERVICES.has(service)) context.stop();
    },
  });
  RESERVATION_LEASES.set(lease, context);
  return lease;
}

export function assertRfqSelectionCeremonyOwnershipAvailable(service, signal) {
  const context = SERVICES.get(service);
  if (!context) throw new TypeError("selection reservation service lacks factory provenance");
  if (BOUND_CEREMONY_SERVICES.has(service)) {
    throw new TypeError("selection reservation ceremony is already route-bound");
  }
  if (signal !== context.signal || signal.aborted || context.state !== "active") {
    throw new TypeError("selection reservation ceremony and service must share one deployment lifecycle");
  }
  return service;
}

export function claimRfqSelectionCeremonyOwnership(service, signal) {
  assertRfqSelectionCeremonyOwnershipAvailable(service, signal);
  const context = SERVICES.get(service);
  BOUND_CEREMONY_SERVICES.add(service);
  ACTIVE_CEREMONY_SERVICES.add(service);
  let state = "active";
  const lease = Object.freeze({
    prepare(input) {
      if (this !== lease || CEREMONY_LEASES.get(this) !== context) {
        throw new TypeError("selection reservation ceremony lease lacks factory provenance");
      }
      if (state !== "active") throw new Error("selection reservation ceremony lease is closed");
      return context.prepare(input);
    },
    reserve(input) {
      if (this !== lease || CEREMONY_LEASES.get(this) !== context) {
        throw new TypeError("selection reservation ceremony lease lacks factory provenance");
      }
      if (state !== "active") throw new Error("selection reservation ceremony lease is closed");
      return context.reserve(input);
    },
    close() {
      if (this !== lease || CEREMONY_LEASES.get(this) !== context) {
        throw new TypeError("selection reservation ceremony lease lacks factory provenance");
      }
      if (state === "closed") return;
      state = "closed";
      ACTIVE_CEREMONY_SERVICES.delete(service);
      if (!ACTIVE_BOUND_SERVICES.has(service)
          && !ACTIVE_FINALIZATION_SERVICES.has(service)) context.stop();
    },
  });
  CEREMONY_LEASES.set(lease, context);
  return lease;
}

function normalizedInvoice(value) {
  return String(value ?? "").trim().replace(/^lightning:/i, "").toLowerCase();
}

function independentlyValidatedInvoice({
  amountSats,
  expectedPayee,
  invoice,
  invoiceDigest,
  invoicePolicy,
  now,
  paymentHash,
}) {
  const validation = validateFullFillInvoice({
    rawInvoice: invoice,
    request: {
      amountSats,
      childIndex: null,
      expectedPayee,
      fillAmountSats: amountSats,
      invoiceDigest,
      parentIntentId: null,
      paymentHash,
      totalAmountSats: amountSats,
    },
    registry: {
      consumedPaymentHashes: [],
      reservedPaymentHashes: [],
    },
    policy: invoicePolicy,
    now,
  });
  if (!validation.valid || !validation.canonical) {
    throw new Error(`Lightning invoice failed independent policy validation: ${validation.reasons.join("; ")}`);
  }
  return validation.canonical;
}

function selectedSolverFinalizationConfiguration(service, input) {
  const context = SERVICES.get(service);
  if (!context) throw new TypeError("selection reservation service lacks factory provenance");
  const source = exactDataRecord(
    input,
    ["client", "quotePolicy", "signal"],
    "selected-solver finalization ownership",
  );
  if (BOUND_FINALIZATION_SERVICES.has(service)) {
    throw new TypeError("selected-solver finalization is already route-bound");
  }
  if (source.signal !== context.signal || source.signal.aborted || context.state !== "active") {
    throw new TypeError("selected-solver finalization and reservation must share one deployment lifecycle");
  }
  const clientMode = selectedSolverFinalizationClientMode(source.client);
  if ((context.mode === "production") !== (clientMode === "production")) {
    throw new TypeError("selected-solver finalization client mode does not match the reservation service");
  }
  assertSelectedSolverFinalizationClientLifecycle(source.client, source.signal);
  const quotePolicy = snapshotQuotePolicy(source.quotePolicy);
  return Object.freeze({ client: source.client, context, quotePolicy });
}

export function assertRfqSelectedSolverFinalizationOwnershipAvailable(service, input) {
  selectedSolverFinalizationConfiguration(service, input);
  return service;
}

export function claimRfqSelectedSolverFinalizationOwnership(service, input) {
  const configuration = selectedSolverFinalizationConfiguration(service, input);
  const { client, context, quotePolicy } = configuration;
  BOUND_FINALIZATION_SERVICES.add(service);
  ACTIVE_FINALIZATION_SERVICES.add(service);
  let state = "active";

  const find = (token, now) => context.findRecord(token, now);
  const replace = (token, record) => {
    context.records.set(tokenDigest(bytes32(token, "selection reservation token")), Object.freeze(record));
    return context.records.get(tokenDigest(token));
  };
  const assertLease = (lease) => {
    if (FINALIZATION_LEASES.get(lease) !== context) {
      throw new TypeError("selected-solver finalization lease lacks factory provenance");
    }
    if (state !== "active" || context.state !== "active" || context.signal.aborted) {
      throw new Error("selected-solver finalization lease is closed");
    }
  };

  const lease = Object.freeze({
    async finalize(inputValue) {
      assertLease(this);
      const value = exactDataRecord(
        inputValue,
        FINALIZE_FIELDS,
        "selected-solver finalization request",
      );
      const now = context.observeNow();
      let record = find(value.reservationToken, now);
      if (record.state === "finalization-failed") {
        throw new Error("selected-solver finalization failed terminally; select a fresh quote");
      }
      const request = snapshotRequest(value.request);
      const privateRequestDigest = rfqRequestDigest(request);
      const suppliedInvoice = normalizedInvoice(value.invoice);
      if (record.privateRequestDigest && record.privateRequestDigest !== privateRequestDigest) {
        throw new Error("private RFQ request changed during selected-solver finalization");
      }
      if (record.suppliedInvoice !== undefined && record.suppliedInvoice !== suppliedInvoice) {
        throw new Error("private Lightning invoice changed during selected-solver finalization");
      }
      if (record.state === "authorized") return finalizationAck(record);
      if (record.state === "finalized") return record.executionSigningPayload;
      if (record.state !== "reserved" && record.state !== "finalizing") {
        throw new Error("selected quote is not durably reserved for finalization");
      }

      if (record.state === "reserved") {
        try {
          activeBlindQuoteReservationBinding(record.reservation, { now });
          if (record.selection.pricing.direction === "bit-to-lightning") {
            const validated = independentlyValidatedInvoice({
              amountSats: request.exactLightningOutputSats,
              expectedPayee: null,
              invoice: suppliedInvoice,
              invoiceDigest: request.invoiceDigest,
              invoicePolicy: context.invoicePolicy,
              now,
              paymentHash: request.paymentHash,
            });
            if (validated.invoice !== suppliedInvoice) {
              throw new Error("private Lightning invoice is not canonical");
            }
          } else if (suppliedInvoice !== "") {
            throw new Error("Lightning-to-BIT finalization cannot supply a user invoice");
          }
          const disclosure = buildSelectedSolverDisclosure({
            request,
            reservation: record.reservation,
            invoice: String(value.invoice ?? ""),
            channel: {
              authenticated: true,
              encrypted: true,
              peer: record.reservation.selectedSolver,
            },
            now,
          });
          const attempt = client.prepare({
            capabilityVerification: record.capability,
            disclosure,
            requestTtlSeconds: Math.min(30, disclosure.expiresAt - now),
          });
          record = replace(value.reservationToken, {
            ...record,
            attempt,
            disclosure,
            privateRequestDigest,
            request,
            state: "finalizing",
            suppliedInvoice,
          });
        } catch (error) {
          context.failed += 1;
          replace(value.reservationToken, { ...record, state: "finalization-failed" });
          throw error;
        }
      }

      let transport;
      try {
        transport = await client.send(record.attempt);
      } catch (error) {
        context.failed += 1;
        if (error?.ambiguous !== true) {
          replace(value.reservationToken, { ...record, state: "finalization-failed" });
        }
        throw error;
      }
      assertLease(this);

      try {
        if (transport.channel.authenticated !== true || transport.channel.encrypted !== true
            || !sameAddress(transport.channel.peer, record.reservation.selectedSolver)) {
          throw new Error("selected-solver transport lost its authenticated peer binding");
        }
        const finalization = finalizeSelectedBlindQuote({
          request: record.request,
          reservation: record.reservation,
          envelope: transport.envelope,
          capabilityVerification: record.capability,
          now: context.observeNow(),
          quotePolicy,
        });
        const invoice = normalizedInvoice(transport.invoice);
        if (!invoice || (record.selection.pricing.direction === "bit-to-lightning"
            && invoice !== record.suppliedInvoice)) {
          throw new Error("selected-solver response changed the exact Lightning invoice");
        }
        const offer = finalization.envelope.offer;
        const expectedPayee = record.selection.pricing.direction === "lightning-to-bit"
          ? verifiedSolverRecoveryAuthority(record.capability).lightningNodePubkey
          : null;
        const validated = independentlyValidatedInvoice({
          amountSats: offer.lightningAmountSats,
          expectedPayee,
          invoice,
          invoiceDigest: offer.invoiceDigest,
          invoicePolicy: context.invoicePolicy,
          now: context.observeNow(),
          paymentHash: offer.paymentHash,
        });
        if (validated.invoice !== invoice) {
          throw new Error("selected-solver response invoice is not canonical");
        }
        const authorizationExpiresAt = Math.min(
          transport.expiresAt,
          finalization.envelope.offer.expiresAt,
          record.expiresAt,
        );
        const material = buildFinalizedQuoteUserAuthorization({
          request: record.request,
          finalization,
          authorizationExpiresAt,
        });
        const executionSigningPayload = executableSignableMaterial(material, invoice);
        record = replace(value.reservationToken, {
          ...record,
          executionSigningPayload,
          finalization,
          invoice,
          state: "finalized",
          transport,
        });
        return record.executionSigningPayload;
      } catch (error) {
        context.failed += 1;
        replace(value.reservationToken, { ...record, state: "finalization-failed" });
        throw error;
      }
    },

    authorize(inputValue) {
      assertLease(this);
      const value = exactDataRecord(
        inputValue,
        AUTHORIZE_FIELDS,
        "selected-solver execution authorization",
      );
      const now = context.observeNow();
      let record = find(value.reservationToken, now);
      if (record.state !== "finalized" && record.state !== "authorized") {
        throw new Error("selected-solver quote is not ready for exact user authorization");
      }
      const request = snapshotRequest(value.request);
      if (rfqRequestDigest(request) !== record.privateRequestDigest) {
        throw new Error("private RFQ request changed before execution authorization");
      }
      const authorization = snapshotExecutionAuthorization(value.authorization);
      if (typeof value.signature !== "string") {
        throw new TypeError("execution authorization signature must be a string");
      }
      const authorized = authorizeFinalizedBlindQuote({
        request,
        finalization: record.finalization,
        authorization,
        signature: value.signature,
        now,
      });
      let settlementRequest = request;
      if (record.selection.pricing.direction === "lightning-to-bit") {
        settlementRequest = bindFinalizedSolverInvoice(request, authorized, { now });
      }
      record = replace(value.reservationToken, {
        ...record,
        authorized,
        settlementRequest,
        state: "authorized",
      });
      return finalizationAck(record);
    },

    close() {
      if (FINALIZATION_LEASES.get(this) !== context) {
        throw new TypeError("selected-solver finalization lease lacks factory provenance");
      }
      if (state === "closed") return;
      state = "closed";
      ACTIVE_FINALIZATION_SERVICES.delete(service);
      if (!ACTIVE_BOUND_SERVICES.has(service)
          && !ACTIVE_CEREMONY_SERVICES.has(service)) context.stop();
    },
  });
  FINALIZATION_LEASES.set(lease, context);
  return lease;
}
