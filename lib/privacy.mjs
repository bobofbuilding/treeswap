import { id } from "ethers";

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SENSITIVE_KEYS = new Set([
  "beneficiary",
  "email",
  "invoice",
  "invoiceDigest",
  "macaroon",
  "payee",
  "paymentHash",
  "paymentSecret",
  "preimage",
  "routeHints",
  "signature",
  "user",
]);
const SENSITIVE_KEY_SHAPES = new Set(
  [...SENSITIVE_KEYS].map((key) => key.toLowerCase()),
);
const PUBLIC_PRICING_KEYS = Object.freeze([
  "capacityEpoch",
  "chainId",
  "direction",
  "exactOutput",
  "expiresAt",
  "maxFeeBps",
  "maxRoutingFeeSats",
  "outputUnit",
  "pricingId",
]);
const LOWER_BYTES32 = /^0x[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export const PRIVACY_RETENTION_SECONDS = Object.freeze({
  publicPricing: 10 * 60,
  unselectedQuote: 10 * 60,
  privateSettlementAfterTerminal: 60 * 60,
  pendingEmail: 24 * 60 * 60,
  minimalReceipt: 30 * 24 * 60 * 60,
});

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function unsigned(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${name} must be an unsigned integer`);
  }
}

function assertBytes32(value, name) {
  if (!BYTES32.test(String(value ?? ""))) throw new TypeError(`${name} must be bytes32`);
  return String(value).toLowerCase();
}

function direction(request) {
  if (request.direction !== "lightning-to-bit" && request.direction !== "bit-to-lightning") {
    throw new TypeError("unsupported direction");
  }
  return request.direction;
}

function sensitiveKey(value) {
  const shape = String(value)
    .normalize("NFKC")
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
  return SENSITIVE_KEY_SHAPES.has(shape);
}

function exactPublicPricingRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("public pricing request must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("public pricing request must be a plain object");
  }
  const keys = Reflect.ownKeys(value);
  const actual = keys.every((key) => typeof key === "string") ? [...keys].sort() : [];
  if (actual.length !== PUBLIC_PRICING_KEYS.length
      || actual.some((key, index) => key !== PUBLIC_PRICING_KEYS[index])) {
    throw new TypeError("public pricing request fields are not exact");
  }
  const result = {};
  for (const key of PUBLIC_PRICING_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("public pricing request fields must be enumerable data properties");
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value,
    });
  }
  return Object.freeze(result);
}

export function buildBlindPricingRequest(request) {
  const swapDirection = direction(request);
  const pricingId = assertBytes32(request.pricingId, "pricingId");
  if (request.requestId && pricingId === String(request.requestId).toLowerCase()) {
    throw new TypeError("public pricing and private settlement identifiers must be unlinkable");
  }
  const exactOutput = swapDirection === "lightning-to-bit"
    ? unsigned(request.exactBitOutputWei, "exactBitOutputWei")
    : unsigned(request.exactLightningOutputSats, "exactLightningOutputSats");
  if (exactOutput === 0n) throw new RangeError("exact output must be positive");

  const projected = Object.freeze({
    pricingId,
    direction: swapDirection,
    chainId: integer(Number(request.chainId), "chainId"),
    exactOutput: exactOutput.toString(),
    outputUnit: swapDirection === "lightning-to-bit" ? "bit-wei" : "sats",
    maxFeeBps: unsigned(request.maxFeeBps, "maxFeeBps").toString(),
    maxRoutingFeeSats: unsigned(request.maxRoutingFeeSats, "maxRoutingFeeSats").toString(),
    capacityEpoch: integer(Number(request.capacityEpoch), "capacityEpoch"),
    expiresAt: integer(Number(request.expiresAt), "expiresAt"),
  });
  assertPublicPricingRequest(projected);
  return projected;
}

export function assertPublicPricingRequest(value) {
  const request = exactPublicPricingRecord(value);
  if (typeof request.pricingId !== "string" || !LOWER_BYTES32.test(request.pricingId)) {
    throw new TypeError("public pricing request pricingId must be canonical lowercase bytes32");
  }
  if (request.direction !== "lightning-to-bit" && request.direction !== "bit-to-lightning") {
    throw new TypeError("public pricing request direction is unsupported");
  }
  if (!Number.isSafeInteger(request.chainId) || request.chainId < 0
      || !Number.isSafeInteger(request.capacityEpoch) || request.capacityEpoch < 0
      || !Number.isSafeInteger(request.expiresAt) || request.expiresAt < 0) {
    throw new TypeError("public pricing request integer fields are invalid");
  }
  if (typeof request.exactOutput !== "string" || !POSITIVE_DECIMAL.test(request.exactOutput)) {
    throw new TypeError("public pricing request exactOutput must be a positive decimal string");
  }
  if (typeof request.maxFeeBps !== "string" || !UNSIGNED_DECIMAL.test(request.maxFeeBps)
      || typeof request.maxRoutingFeeSats !== "string"
      || !UNSIGNED_DECIMAL.test(request.maxRoutingFeeSats)) {
    throw new TypeError("public pricing request caps must be canonical unsigned decimal strings");
  }
  const expectedUnit = request.direction === "lightning-to-bit" ? "bit-wei" : "sats";
  if (request.outputUnit !== expectedUnit) {
    throw new TypeError("public pricing request outputUnit does not match direction");
  }
  return true;
}

export function privacySafeAudit(event, record = {}) {
  const output = {};
  Object.defineProperty(output, "event", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: String(event).slice(0, 64),
  });
  const keys = record && typeof record === "object" ? Reflect.ownKeys(record) : [];
  let accepted = 0;
  for (const key of keys) {
    if (accepted >= 32) break;
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)
        || Object.hasOwn(output, key)) continue;
    const value = descriptor.value;
    let projected;
    if (sensitiveKey(key)) {
      projected = "[redacted]";
    } else if (typeof value === "bigint") {
      projected = value.toString();
    } else if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      projected = value;
    } else {
      continue;
    }
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: projected,
    });
    accepted += 1;
  }
  return Object.freeze(output);
}

export function retentionDeadline({ kind, createdAt, terminalAt }) {
  const created = integer(createdAt, "createdAt");
  if (kind === "privateSettlement") {
    if (terminalAt === undefined) throw new TypeError("terminalAt is required for private settlement data");
    return integer(terminalAt, "terminalAt") + PRIVACY_RETENTION_SECONDS.privateSettlementAfterTerminal;
  }
  const ttl = PRIVACY_RETENTION_SECONDS[kind];
  if (!ttl) throw new TypeError("unsupported retention class");
  return created + ttl;
}

export function unlinkablePricingId(randomBytes32) {
  return id(`treeswap-pricing:${assertBytes32(randomBytes32, "randomBytes32")}`);
}
