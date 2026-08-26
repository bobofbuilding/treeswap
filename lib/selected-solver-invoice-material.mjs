import {
  KeyObject,
  createHash,
  createHmac,
  createSecretKey,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  invoiceDigest,
  isLndRestClient,
  LndRestError,
} from "./lnd-rest-client.mjs";

export const SELECTED_SOLVER_INVOICE_MATERIAL_SCHEMA =
  "treeswap.selected-solver-invoice-material.v1";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const INT64_MAX = (1n << 63n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const SERVICE_KEYS = Object.freeze([
  "lndClient",
  "memo",
  "paymentSecretKey",
  "paymentSecretKeyId",
  "policy",
]);
const TEST_SERVICE_KEYS = Object.freeze([
  "invoiceNode",
  "memo",
  "paymentSecretKey",
  "paymentSecretKeyId",
  "policy",
]);
const NODE_KEYS = Object.freeze(["addHoldInvoice", "lookupInvoice"]);
const POLICY_KEYS = Object.freeze([
  "addTimeoutMs",
  "cltvExpiry",
  "invoiceExpirySeconds",
  "lookupTimeoutMs",
  "maximumInvoiceBytes",
]);
const RESOLVE_KEYS = Object.freeze([
  "amountSats",
  "capabilityDigest",
  "requestDigest",
  "requestId",
  "selectedOfferId",
]);
const OPTIONS_KEYS = Object.freeze(["recovery", "signal"]);
const PAYMENT_SECRET_DOMAIN = Buffer.from(
  "TreeSwap selected-solver hold-invoice preimage v1\0",
  "utf8",
);
const SERVICES = new WeakMap();
const TEST_NODES = new WeakMap();
const MATERIALS = new WeakSet();

function privateAbsolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)
      || Buffer.byteLength(value) > 4_096 || value.includes("\0")) {
    throw new TypeError(`${name} must be a bounded absolute path`);
  }
  return value;
}

export async function loadSelectedSolverPaymentSecretKey(value) {
  const path = privateAbsolutePath(value, "selected-solver payment-secret key path");
  const parent = await lstat(dirname(path));
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
      || (currentUid !== null && parent.uid !== currentUid)) {
    throw new Error("selected-solver payment-secret key parent must be a private directory");
  }
  let handle;
  let bytes;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== 32 || (metadata.mode & 0o077) !== 0
        || (currentUid !== null && metadata.uid !== currentUid)) {
      throw new Error("selected-solver payment-secret key file is unsafe");
    }
    bytes = await handle.readFile();
    if (bytes.length !== 32) throw new Error("selected-solver payment-secret key changed while loading");
    return createSecretKey(bytes);
  } finally {
    if (bytes) bytes.fill(0);
    if (handle) await handle.close();
  }
}

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
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
      throw new TypeError(`${name} must be a bounded plain array`);
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

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  }
  return value;
}

function keyId(value) {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw new TypeError("selected-solver payment-secret key ID is invalid");
  }
  return value;
}

function amount(value) {
  if (typeof value !== "string" || !UINT.test(value)) {
    throw new TypeError("selected-solver invoice amount must be a canonical decimal string");
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed > INT64_MAX) {
    throw new RangeError("selected-solver invoice amount must be nonzero and fit LND int64");
  }
  return value;
}

function policy(value) {
  const source = exactDataRecord(value, POLICY_KEYS, "selected-solver invoice policy");
  return Object.freeze({
    addTimeoutMs: integer(source.addTimeoutMs, "invoice add timeout", 100, 120_000),
    lookupTimeoutMs: integer(source.lookupTimeoutMs, "invoice lookup timeout", 100, 60_000),
    invoiceExpirySeconds: integer(
      source.invoiceExpirySeconds,
      "hold-invoice expiry",
      3_600,
      10_800,
    ),
    cltvExpiry: integer(source.cltvExpiry, "hold-invoice CLTV", 48, 144),
    maximumInvoiceBytes: integer(source.maximumInvoiceBytes, "maximum invoice bytes", 256, 8_192),
  });
}

function secretKey(value) {
  if (!(value instanceof KeyObject) || value.type !== "secret"
      || !Number.isSafeInteger(value.symmetricKeySize)
      || value.symmetricKeySize < 32) {
    throw new TypeError("selected-solver payment-secret key must be a 32-byte-or-larger secret KeyObject");
  }
  return value;
}

function memo(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) === 0 || Buffer.byteLength(value) > 80
      || /[\r\n\0]/.test(value)) {
    throw new TypeError("selected-solver invoice memo must be a bounded single-line string");
  }
  return value;
}

function normalizeResolveInput(value) {
  const source = exactDataRecord(value, RESOLVE_KEYS, "selected-solver invoice request");
  return Object.freeze({
    requestId: bytes32(source.requestId, "invoice request ID"),
    requestDigest: bytes32(source.requestDigest, "invoice request digest"),
    capabilityDigest: bytes32(source.capabilityDigest, "invoice capability digest"),
    selectedOfferId: bytes32(source.selectedOfferId, "invoice selected offer ID"),
    amountSats: amount(source.amountSats),
  });
}

function normalizeOptions(value) {
  const source = exactDataRecord(value, OPTIONS_KEYS, "selected-solver invoice resolution options");
  if (source.recovery !== true && source.recovery !== false) {
    throw new TypeError("selected-solver invoice recovery flag must be a boolean");
  }
  if (!(source.signal instanceof AbortSignal)) {
    throw new TypeError("selected-solver invoice resolution requires an AbortSignal");
  }
  return Object.freeze({ recovery: source.recovery, signal: source.signal });
}

function paymentPreimage(context, request) {
  const hmac = createHmac("sha256", context.paymentSecretKey);
  hmac.update(PAYMENT_SECRET_DOMAIN);
  for (const value of [
    context.paymentSecretKeyId,
    request.requestId,
    request.requestDigest,
    request.capabilityDigest,
    request.selectedOfferId,
    request.amountSats,
  ]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hmac.update(length);
    hmac.update(bytes);
  }
  return hmac.digest();
}

function expectedPaymentHash(context, request) {
  const preimage = paymentPreimage(context, request);
  try {
    return `0x${createHash("sha256").update(preimage).digest("hex")}`;
  } finally {
    preimage.fill(0);
  }
}

function base64Hash(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be canonical base64 bytes32`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new TypeError(`${name} must be canonical base64 bytes32`);
  }
  return `0x${decoded.toString("hex")}`;
}

function canonicalUint(value, name, maximum) {
  if (typeof value !== "string" || !UINT.test(value)) {
    throw new TypeError(`${name} must be a canonical decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > maximum) throw new RangeError(`${name} is outside policy`);
  return value;
}

function requireNoPreimage(value) {
  if (value === "") return;
  if (typeof value !== "string") {
    throw new Error("selected-solver LND invoice unexpectedly exposes a preimage");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value
      || decoded.some((byte) => byte !== 0)) {
    throw new Error("selected-solver LND invoice unexpectedly exposes a preimage");
  }
}

function canonicalInvoice(value, maximumBytes) {
  if (typeof value !== "string") throw new TypeError("selected-solver LND payment request is invalid");
  const invoice = value.trim().replace(/^lightning:/i, "").toLowerCase();
  if (!invoice || Buffer.byteLength(invoice) > maximumBytes || !/^ln[a-z0-9]+$/.test(invoice)) {
    throw new TypeError("selected-solver LND payment request is invalid");
  }
  return invoice;
}

function validateLookup(raw, { context, request, paymentHash }) {
  const invoice = snapshotJson(raw, "selected-solver LND invoice");
  if (!invoice || typeof invoice !== "object" || Array.isArray(invoice)) {
    throw new TypeError("selected-solver LND lookup must return an object");
  }
  if (base64Hash(invoice.r_hash, "LND invoice payment hash") !== paymentHash) {
    throw new Error("selected-solver LND invoice payment hash changed");
  }
  if (amount(invoice.value) !== request.amountSats) {
    throw new Error("selected-solver LND invoice amount changed");
  }
  if (canonicalUint(invoice.expiry, "LND invoice expiry", 10_800n)
      !== String(context.policy.invoiceExpirySeconds)) {
    throw new Error("selected-solver LND invoice expiry changed");
  }
  if (canonicalUint(invoice.cltv_expiry, "LND invoice CLTV", 144n)
      !== String(context.policy.cltvExpiry)) {
    throw new Error("selected-solver LND invoice CLTV changed");
  }
  if (invoice.memo !== context.memo) {
    throw new Error("selected-solver LND invoice memo changed");
  }
  const state = invoice.state;
  if (typeof state !== "string") throw new TypeError("selected-solver LND invoice state is invalid");
  if (state !== "OPEN" && state !== "ACCEPTED") {
    throw new Error("selected-solver LND invoice is no longer safely payable");
  }
  if (invoice.is_amp !== false) {
    throw new Error("selected-solver LND invoice unexpectedly enables AMP");
  }
  if (invoice.is_keysend !== false || invoice.is_blinded !== false || invoice.settled !== false) {
    throw new Error("selected-solver LND invoice kind or settlement state changed");
  }
  requireNoPreimage(invoice.r_preimage);
  const paymentAddress = base64Hash(invoice.payment_addr, "LND invoice payment address");
  if (!BYTES32.test(paymentAddress)) {
    throw new Error("selected-solver LND invoice payment address is zero");
  }
  const paymentRequest = canonicalInvoice(invoice.payment_request, context.policy.maximumInvoiceBytes);
  const addIndex = canonicalUint(invoice.add_index, "LND invoice add index", UINT64_MAX);
  if (BigInt(addIndex) === 0n) {
    throw new TypeError("selected-solver LND invoice add index is invalid");
  }
  const material = Object.freeze({
    schema: SELECTED_SOLVER_INVOICE_MATERIAL_SCHEMA,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    capabilityDigest: request.capabilityDigest,
    selectedOfferId: request.selectedOfferId,
    amountSats: request.amountSats,
    paymentHash,
    invoice: paymentRequest,
    invoiceDigest: invoiceDigest(paymentRequest),
    paymentSecretKeyId: context.paymentSecretKeyId,
    invoiceState: state,
    addIndex,
    fundingAuthorization: false,
    settlementAuthorization: false,
  });
  MATERIALS.add(material);
  return material;
}

function isNotFound(error) {
  if (!(error instanceof LndRestError) || error.ambiguous !== false) return false;
  if (error.reason === "not-found" && Number(error.grpcCode) === 5) return true;
  return error.reason === "invoice-not-found"
    && ((Number(error.httpStatus) === 404 && Number(error.grpcCode) === 5)
      || (Number(error.httpStatus) === 500 && Number(error.grpcCode) === 2));
}

function permitsIdempotentCreate(error) {
  return isNotFound(error)
    || (error instanceof LndRestError
      && error.ambiguous === false
      && Number(error.httpStatus) === 500
      && Number(error.grpcCode) === 2
      && error.reason === "invoice-not-found");
}

async function lookup(context, request, paymentHash) {
  return validateLookup(
    await context.node.lookupInvoice(paymentHash, context.policy.lookupTimeoutMs),
    { context, request, paymentHash },
  );
}

async function resolveOnce(context, request, options, paymentHash) {
  if (options.signal.aborted) {
    throw new SelectedSolverInvoiceMaterialError("selected-solver invoice resolution was aborted", {
      ambiguous: false,
      code: "ABORTED_BEFORE_LND",
    });
  }
  try {
    return await lookup(context, request, paymentHash);
  } catch (error) {
    if (!permitsIdempotentCreate(error)) throw error;
  }
  if (options.signal.aborted) {
    throw new SelectedSolverInvoiceMaterialError("selected-solver invoice resolution was aborted", {
      ambiguous: false,
      code: "ABORTED_BEFORE_ADD",
    });
  }
  let addError = null;
  try {
    const added = snapshotJson(await context.node.addHoldInvoice({
      paymentHash,
      amountSats: request.amountSats,
      memo: context.memo,
      expirySeconds: context.policy.invoiceExpirySeconds,
      cltvExpiry: context.policy.cltvExpiry,
      isPrivate: true,
    }, context.policy.addTimeoutMs), "selected-solver LND add response");
    canonicalInvoice(added.payment_request, context.policy.maximumInvoiceBytes);
    const addIndex = canonicalUint(added.add_index, "LND invoice add index", UINT64_MAX);
    if (BigInt(addIndex) === 0n) {
      throw new TypeError("selected-solver LND add index is invalid");
    }
  } catch (error) {
    addError = error;
  }
  try {
    const material = await lookup(context, request, paymentHash);
    if (options.signal.aborted) {
      throw new SelectedSolverInvoiceMaterialError("selected-solver invoice response was interrupted", {
        ambiguous: true,
        code: "ABORTED_AFTER_ADD",
      });
    }
    return material;
  } catch (error) {
    if (error instanceof SelectedSolverInvoiceMaterialError) throw error;
    if (addError === null) {
      if (isNotFound(error) || error instanceof LndRestError) {
        throw new SelectedSolverInvoiceMaterialError("selected-solver invoice creation outcome is ambiguous", {
          ambiguous: true,
          code: "LND_CREATE_AMBIGUOUS",
        });
      }
      throw new SelectedSolverInvoiceMaterialError("selected-solver invoice lookup conflicted after creation", {
        ambiguous: true,
        code: "LND_RECOVERY_CONFLICT",
      });
    }
    if (permitsIdempotentCreate(error)) {
      if (addError instanceof LndRestError && !addError.ambiguous
          && Number(addError.grpcCode) !== 6) {
        throw addError;
      }
      throw new SelectedSolverInvoiceMaterialError("selected-solver invoice creation outcome is ambiguous", {
        ambiguous: true,
        code: "LND_CREATE_AMBIGUOUS",
      });
    }
    throw new SelectedSolverInvoiceMaterialError("selected-solver invoice recovery returned conflicting material", {
      ambiguous: true,
      code: "LND_RECOVERY_CONFLICT",
    });
  }
}

function createService(input, mode) {
  const expected = mode === "production" ? SERVICE_KEYS : TEST_SERVICE_KEYS;
  const source = exactDataRecord(input, expected, "selected-solver invoice material service");
  let node;
  if (mode === "production") {
    if (!isLndRestClient(source.lndClient)) {
      throw new TypeError("selected-solver production invoice service requires an LND REST client");
    }
    node = source.lndClient;
  } else {
    const nodeContext = TEST_NODES.get(source.invoiceNode);
    if (!nodeContext) {
      throw new TypeError("selected-solver test invoice service requires the concrete test node");
    }
    node = nodeContext;
  }
  const context = {
    mode,
    node,
    memo: memo(source.memo),
    paymentSecretKey: secretKey(source.paymentSecretKey),
    paymentSecretKeyId: keyId(source.paymentSecretKeyId),
    policy: policy(source.policy),
    inFlight: new Map(),
  };
  const service = Object.freeze({
    status: (...arguments_) => {
      if (arguments_.length !== 0) throw new TypeError("selected-solver invoice service status accepts no input");
      return Object.freeze({
        schema: "treeswap.selected-solver-invoice-material-service.v1",
        mode: context.mode,
        inFlightRequests: context.inFlight.size,
        exposesPreimage: false,
        exposesLndCredential: false,
        networkListener: false,
        fundingAuthorization: false,
        settlementAuthorization: false,
      });
    },
  });
  SERVICES.set(service, context);
  return service;
}

export function createSelectedSolverInvoiceMaterialService(input) {
  return createService(input, "production");
}

export function createTestSelectedSolverInvoiceMaterialNode(input) {
  const source = exactDataRecord(input, NODE_KEYS, "test selected-solver invoice node");
  if (typeof source.addHoldInvoice !== "function" || typeof source.lookupInvoice !== "function") {
    throw new TypeError("test selected-solver invoice node requires add and lookup functions");
  }
  const node = Object.freeze({
    status: () => Object.freeze({ mode: "injected-test", fundingAuthorization: false }),
  });
  TEST_NODES.set(node, Object.freeze({
    addHoldInvoice: source.addHoldInvoice,
    lookupInvoice: source.lookupInvoice,
  }));
  return node;
}

export function createTestSelectedSolverInvoiceMaterialService(input) {
  return createService(input, "injected-test");
}

export async function resolveSelectedSolverInvoiceMaterial(service, input, options) {
  const context = SERVICES.get(service);
  if (!context) throw new TypeError("selected-solver invoice service provenance is invalid");
  const request = normalizeResolveInput(input);
  const normalizedOptions = normalizeOptions(options);
  const paymentHash = expectedPaymentHash(context, request);
  const existing = context.inFlight.get(paymentHash);
  if (existing) return existing;
  const resolution = resolveOnce(context, request, normalizedOptions, paymentHash);
  context.inFlight.set(paymentHash, resolution);
  try {
    return await resolution;
  } finally {
    if (context.inFlight.get(paymentHash) === resolution) context.inFlight.delete(paymentHash);
  }
}

export function selectedSolverInvoiceMaterialBinding(value) {
  if (!value || !MATERIALS.has(value)) {
    throw new TypeError("selected-solver invoice material provenance is invalid");
  }
  return value;
}

export class SelectedSolverInvoiceMaterialError extends Error {
  constructor(message, { ambiguous, code }) {
    super(message);
    this.name = "SelectedSolverInvoiceMaterialError";
    this.ambiguous = ambiguous === true;
    this.code = String(code ?? "UNKNOWN");
  }
}
