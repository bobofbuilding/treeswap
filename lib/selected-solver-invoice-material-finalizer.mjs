import { invoiceDigest } from "./lnd-rest-client.mjs";
import {
  createSelectedSolverFinalizationProviderFinalizer,
} from "./selected-solver-finalization-provider.mjs";
import {
  assertSelectedSolverInvoiceMaterialClientLifecycle,
  verifiedSelectedSolverInvoiceMaterialResponse,
} from "./selected-solver-invoice-material-transport.mjs";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const BUILDERS = new WeakMap();
const COMPOSITIONS = new WeakSet();

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

function snapshotJson(value, name, depth = 0, counter = { value: 0 }) {
  counter.value += 1;
  if (depth > 8 || counter.value > 512) throw new RangeError(`${name} is outside bounded JSON policy`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 16_384) throw new RangeError(`${name} contains an oversized string`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== "object") throw new TypeError(`${name} contains unsupported data`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
      throw new TypeError(`${name} must contain only bounded plain arrays`);
    }
    const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.size
        || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
      throw new TypeError(`${name} array fields are not exact`);
    }
    return Object.freeze(value.map((item, index) => snapshotJson(
      item,
      `${name}[${index}]`,
      depth + 1,
      counter,
    )));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must contain only plain data objects`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 96 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} object fields are outside policy`);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name}.${key} must be an enumerable data property`);
    }
    result[key] = snapshotJson(descriptor.value, `${name}.${key}`, depth + 1, counter);
  }
  return Object.freeze(result);
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  }
  return value;
}

function uint(value, name) {
  if (typeof value !== "string" || !UINT.test(value)) {
    throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  }
  return value;
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function direction(value) {
  if (typeof value !== "string" || !DIRECTIONS.has(value)) {
    throw new TypeError("invoice-material finalizer direction is invalid");
  }
  return value;
}

function canonicalInvoice(value) {
  if (typeof value !== "string") throw new TypeError("invoice-material finalizer invoice is invalid");
  const invoice = value.trim().replace(/^lightning:/i, "").toLowerCase();
  if (!invoice || Buffer.byteLength(invoice) > 8_192 || !/^ln[a-z0-9]+$/.test(invoice)) {
    throw new TypeError("invoice-material finalizer invoice is invalid");
  }
  return invoice;
}

export function createSelectedSolverExecutableOfferBuilder(input) {
  const source = exactDataRecord(input, ["build", "load"], "selected-solver executable offer builder");
  if (typeof source.build !== "function" || typeof source.load !== "function") {
    throw new TypeError("selected-solver executable offer builder requires load and build functions");
  }
  const builder = Object.freeze({
    status() {
      if (this !== builder || !BUILDERS.has(this)) {
        throw new TypeError("selected-solver executable builder lacks provenance");
      }
      return Object.freeze({
        schema: "treeswap.selected-solver-executable-offer-builder.v1",
        state: "available",
        receivesLndCredential: false,
        receivesPaymentSecretKey: false,
        receivesPreimage: false,
        fundingAuthorization: false,
        settlementAuthorization: false,
      });
    },
  });
  BUILDERS.set(builder, Object.freeze({ build: source.build, load: source.load }));
  return builder;
}

function validateBuilderResult(raw, request, invoice, material) {
  const source = exactDataRecord(
    snapshotJson(raw, "selected-solver executable builder result"),
    ["envelope", "expiresAt"],
    "selected-solver executable builder result",
  );
  const envelope = exactDataRecord(
    source.envelope,
    ["offer", "signature"],
    "selected-solver executable envelope",
  );
  if (typeof envelope.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(envelope.signature)) {
    throw new TypeError("selected-solver executable signature is invalid");
  }
  const offer = envelope.offer;
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) {
    throw new TypeError("selected-solver executable offer is invalid");
  }
  for (const [field, expected] of Object.entries({
    offerId: request.disclosure.selectedOfferId,
    requestId: request.disclosure.requestId,
    solver: request.disclosure.selectedSolver,
    capabilityDigest: request.capabilityDigest,
    capacitySnapshotDigest: request.capacitySnapshotDigest,
    paymentHash: material?.paymentHash ?? request.disclosure.paymentHash,
    invoiceDigest: material?.invoiceDigest ?? request.disclosure.invoiceDigest,
  })) {
    const actual = String(offer[field] ?? "");
    const matches = field === "solver"
      ? actual.toLowerCase() === String(expected).toLowerCase()
      : actual === expected;
    if (!matches) {
      throw new Error(`selected-solver executable builder changed ${field}`);
    }
  }
  if (uint(String(offer.lightningAmountSats ?? ""), "executable Lightning amount")
      !== request.disclosure.exactLightningOutputSats) {
    throw new Error("selected-solver executable builder changed the Lightning amount");
  }
  if (invoiceDigest(invoice) !== offer.invoiceDigest) {
    throw new Error("selected-solver executable builder changed the invoice digest");
  }
  const expiresAt = integer(source.expiresAt, "selected-solver executable result expiry", 1);
  const offerExpiresAt = integer(offer.expiresAt, "selected-solver executable offer expiry", 1);
  const upperBound = Math.min(request.expiresAt, offerExpiresAt, material?.expiresAt ?? request.expiresAt);
  if (expiresAt > upperBound) throw new Error("selected-solver executable result outlives its authority");
  return Object.freeze({ envelope, expiresAt, invoice });
}

export function createSelectedSolverInvoiceMaterialBackedFinalizer(input) {
  const source = exactDataRecord(
    input,
    ["executableBuilder", "invoiceMaterialClient", "signal"],
    "selected-solver invoice-material finalizer",
  );
  const builder = BUILDERS.get(source.executableBuilder);
  if (!builder) throw new TypeError("selected-solver invoice-material finalizer requires its concrete builder");
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("selected-solver invoice-material finalizer requires an active lifecycle");
  }
  assertSelectedSolverInvoiceMaterialClientLifecycle(source.invoiceMaterialClient, source.signal);
  const attempts = new Map();

  const resolve = async (request, options) => {
    const requestDirection = direction(request.direction);
    const requestId = bytes32(request.requestId, "selected-solver finalizer request ID");
    const requestDigest = bytes32(request.requestDigest, "selected-solver finalizer request digest");
    const option = exactDataRecord(
      options,
      ["recovery", "requestDigest", "requestId", "signal"],
      "selected-solver provider finalizer options",
    );
    if (option.requestId !== requestId || option.requestDigest !== requestDigest
        || (option.recovery !== true && option.recovery !== false)
        || !(option.signal instanceof AbortSignal) || option.signal.aborted
        || source.signal.aborted) {
      throw new Error("selected-solver invoice-material finalizer authority changed");
    }
    const selectedOffer = exactDataRecord(
      snapshotJson(await builder.load(Object.freeze({ request }), Object.freeze({
        recovery: option.recovery,
        signal: option.signal,
      })), "selected-solver executable offer load result"),
      ["lightningAmountSats", "selectedOfferId"],
      "selected-solver executable offer load result",
    );
    if (bytes32(selectedOffer.selectedOfferId, "loaded selected offer ID")
        !== request.disclosure.selectedOfferId) {
      throw new Error("selected-solver executable offer loader changed the selected offer");
    }
    const lightningAmountSats = uint(
      selectedOffer.lightningAmountSats,
      "loaded selected offer Lightning amount",
    );
    if (BigInt(lightningAmountSats) === 0n
        || (requestDirection === "bit-to-lightning"
          && lightningAmountSats !== request.disclosure.exactLightningOutputSats)) {
      throw new Error("selected-solver executable offer loader changed the Lightning amount");
    }
    let material = null;
    if (requestDirection === "lightning-to-bit") {
      let attemptRecord = attempts.get(requestId);
      if (attemptRecord && (attemptRecord.requestDigest !== requestDigest
          || attemptRecord.lightningAmountSats !== lightningAmountSats)) {
        throw new Error("selected-solver invoice-material request digest conflicted");
      }
      if (!attemptRecord) {
        const attempt = source.invoiceMaterialClient.prepare({
          requestId,
          requestDigest,
          capabilityDigest: request.capabilityDigest,
          selectedOfferId: request.disclosure.selectedOfferId,
          amountSats: lightningAmountSats,
          authorizationExpiresAt: request.expiresAt,
        });
        attemptRecord = Object.freeze({ attempt, requestDigest, lightningAmountSats });
        attempts.set(requestId, attemptRecord);
      }
      material = verifiedSelectedSolverInvoiceMaterialResponse(
        await source.invoiceMaterialClient.send(attemptRecord.attempt),
      );
    }
    const invoice = requestDirection === "lightning-to-bit"
      ? canonicalInvoice(material.invoice)
      : canonicalInvoice(request.disclosure.invoice);
    const rawResult = await builder.build(Object.freeze({
      request,
      invoiceMaterial: material,
      selectedOffer,
    }), Object.freeze({
      recovery: option.recovery,
      signal: option.signal,
    }));
    return validateBuilderResult(rawResult, request, invoice, material);
  };

  const finalizer = createSelectedSolverFinalizationProviderFinalizer({
    finalize: resolve,
    recover: resolve,
  });
  COMPOSITIONS.add(finalizer);
  const originalStatus = finalizer.status;
  const status = finalizer.status();
  if (status.fundingAuthorization !== false || status.settlementAuthorization !== false
      || typeof originalStatus !== "function") {
    throw new Error("selected-solver finalizer authority is invalid");
  }
  return finalizer;
}

export function isSelectedSolverInvoiceMaterialBackedFinalizer(value) {
  return Boolean(value && COMPOSITIONS.has(value));
}
