import { getBytes } from "ethers";
import { invoiceDigest as canonicalInvoiceDigest } from "./lnd-rest-client.mjs";

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-fA-F]{64}$/;
const SINGLETON_TAGS = ["p", "s", "d", "h", "n", "x", "c", "9"];

function bigint(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function addReason(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

function normalizedInvoice(value) {
  return String(value).trim().replace(/^lightning:/i, "").toLowerCase();
}

export function validateFullFillInvoice({ rawInvoice, decoded, request, registry, policy, now }) {
  const reasons = [];
  const invoice = normalizedInvoice(rawInvoice);
  const observedAt = integer(now, "now");
  const amountMsat = bigint(decoded.amountMsat, "decoded.amountMsat");
  const amountSats = amountMsat / 1_000n;
  const timestamp = integer(decoded.timestamp, "decoded.timestamp");
  const expirySeconds = integer(decoded.expirySeconds, "decoded.expirySeconds");
  const expiresAt = timestamp + expirySeconds;
  const minFinalCltvDelta = integer(decoded.minFinalCltvDelta, "decoded.minFinalCltvDelta");
  const invoiceDigest = canonicalInvoiceDigest(invoice);
  const tagCounts = decoded.singletonTagCounts ?? {};

  addReason(reasons, invoice.length === 0 || invoice.length > integer(policy.maxInvoiceLength, "policy.maxInvoiceLength"), "invoice length is unsupported");
  addReason(reasons, !invoice.startsWith("lnbc"), "only mainnet BOLT 11 invoices are supported");
  addReason(reasons, decoded.decodeSucceeded !== true || decoded.signatureValid !== true, "BOLT 11 checksum or signature is invalid");
  addReason(reasons, decoded.network !== "mainnet", "invoice network is not Bitcoin mainnet");
  addReason(reasons, invoiceDigest !== request.invoiceDigest, "invoice digest changed");
  addReason(reasons, amountMsat === 0n, "amountless invoices are not supported");
  addReason(reasons, amountMsat % 1_000n !== 0n, "invoice amount is not a whole satoshi");
  addReason(reasons, amountSats !== bigint(request.amountSats, "request.amountSats"), "invoice amount changed");
  addReason(reasons, !BYTES32.test(String(decoded.paymentHash ?? "")), "invoice payment hash is invalid");
  addReason(reasons, decoded.paymentHash !== request.paymentHash, "invoice payment hash changed");
  addReason(reasons, !BYTES32.test(String(decoded.paymentSecret ?? "")), "invoice payment secret is required");
  try {
    addReason(reasons, getBytes(decoded.paymentSecret).every((value) => value === 0), "invoice payment secret cannot be zero");
  } catch {
    reasons.push("invoice payment secret is malformed");
  }
  addReason(reasons, !COMPRESSED_PUBKEY.test(String(decoded.destination ?? "")), "invoice payee is invalid");
  if (request.expectedPayee) {
    addReason(reasons, String(decoded.destination).toLowerCase() !== String(request.expectedPayee).toLowerCase(), "invoice payee changed");
  }
  addReason(reasons, timestamp > observedAt, "invoice timestamp is in the future");
  addReason(reasons, expirySeconds === 0 || expirySeconds > integer(policy.maxExpirySeconds, "policy.maxExpirySeconds"), "invoice expiry is unsupported");
  addReason(reasons, expiresAt <= observedAt + integer(policy.minimumRemainingSeconds, "policy.minimumRemainingSeconds"), "invoice does not have enough safe time remaining");
  addReason(
    reasons,
    minFinalCltvDelta < integer(policy.minimumFinalCltvDelta, "policy.minimumFinalCltvDelta")
      || minFinalCltvDelta > integer(policy.maximumFinalCltvDelta, "policy.maximumFinalCltvDelta"),
    "invoice final CLTV delta is outside policy",
  );
  addReason(reasons, decoded.amp === true, "AMP invoices are not supported");
  addReason(reasons, decoded.keysend === true, "keysend is not supported");
  addReason(reasons, decoded.bolt12 === true, "BOLT 12 is not supported");
  addReason(reasons, (decoded.unknownRequiredFeatures ?? []).length > 0, "invoice has an unknown required feature");
  addReason(reasons, integer(decoded.routeHintCount ?? 0, "decoded.routeHintCount") > integer(policy.maxRouteHints, "policy.maxRouteHints"), "invoice has too many route hints");
  for (const tag of SINGLETON_TAGS) {
    addReason(reasons, integer(tagCounts[tag] ?? 0, `singletonTagCounts.${tag}`) > 1, `invoice repeats singleton tag ${tag}`);
  }
  addReason(reasons, integer(tagCounts.p ?? 0, "singletonTagCounts.p") !== 1, "invoice must contain one payment hash tag");
  addReason(reasons, integer(tagCounts.s ?? 0, "singletonTagCounts.s") !== 1, "invoice must contain one payment secret tag");
  addReason(
    reasons,
    request.requiresHoldInvoice === true && decoded.invoiceKind !== "hold",
    "direction requires a hold invoice",
  );
  addReason(
    reasons,
    request.requiresHoldInvoice !== true && decoded.invoiceKind !== "standard",
    "direction requires a standard invoice",
  );
  addReason(
    reasons,
    bigint(request.fillAmountSats, "request.fillAmountSats")
      !== bigint(request.totalAmountSats, "request.totalAmountSats"),
    "partial fills are not supported",
  );
  addReason(reasons, request.parentIntentId != null || request.childIndex != null, "child intents are not supported in v1");
  const reserved = new Set((registry.reservedPaymentHashes ?? []).map((value) => String(value).toLowerCase()));
  const consumed = new Set((registry.consumedPaymentHashes ?? []).map((value) => String(value).toLowerCase()));
  addReason(reasons, reserved.has(String(decoded.paymentHash).toLowerCase()), "payment hash is already reserved");
  addReason(reasons, consumed.has(String(decoded.paymentHash).toLowerCase()), "payment hash was already consumed");

  return Object.freeze({
    valid: reasons.length === 0,
    reasons,
    canonical: reasons.length === 0
      ? Object.freeze({
          invoiceDigest,
          paymentHash: decoded.paymentHash,
          paymentSecret: decoded.paymentSecret,
          destination: decoded.destination,
          amountSats,
          timestamp,
          expiresAt,
          minFinalCltvDelta,
          invoiceKind: decoded.invoiceKind,
          multiPartPaymentAllowedOnlyForSingleFullInvoice: decoded.basicMpp === true,
        })
      : null,
  });
}

export function reserveValidatedPaymentHash(registry, validation) {
  if (!validation?.valid || !validation.canonical) throw new Error("only a validated full-fill invoice can reserve a hash");
  const paymentHash = validation.canonical.paymentHash.toLowerCase();
  return Object.freeze({
    reservedPaymentHashes: Object.freeze([...(registry.reservedPaymentHashes ?? []), paymentHash]),
    consumedPaymentHashes: Object.freeze([...(registry.consumedPaymentHashes ?? [])]),
  });
}
