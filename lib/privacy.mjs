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
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, nested] of Object.entries(current)) {
      if (SENSITIVE_KEYS.has(key)) throw new TypeError(`public pricing request contains sensitive field: ${key}`);
      stack.push(nested);
    }
  }
  return true;
}

export function privacySafeAudit(event, record = {}) {
  const output = { event: String(event).slice(0, 64) };
  for (const [key, value] of Object.entries(record).slice(0, 32)) {
    if (SENSITIVE_KEYS.has(key)) {
      output[key] = "[redacted]";
    } else if (typeof value === "bigint") {
      output[key] = value.toString();
    } else if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      output[key] = value;
    }
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
