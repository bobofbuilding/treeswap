import { createHash } from "node:crypto";

export const LIGHTNING_RPC_ALLOWLIST = Object.freeze({
  invoice: Object.freeze([
    "/lnrpc.Lightning/GetInfo",
    "/lnrpc.Lightning/ListChannels",
    "/lnrpc.Lightning/PendingChannels",
    "/invoicesrpc.Invoices/AddHoldInvoice",
    "/invoicesrpc.Invoices/SettleInvoice",
    "/invoicesrpc.Invoices/CancelInvoice",
    "/invoicesrpc.Invoices/LookupInvoiceV2",
  ]),
  payer: Object.freeze([
    "/lnrpc.Lightning/GetInfo",
    "/lnrpc.Lightning/ListChannels",
    "/lnrpc.Lightning/PendingChannels",
    "/lnrpc.Lightning/DecodePayReq",
    "/routerrpc.Router/SendPaymentV2",
    "/routerrpc.Router/TrackPaymentV2",
  ]),
  observer: Object.freeze([
    "/lnrpc.Lightning/GetInfo",
    "/lnrpc.Lightning/ListChannels",
    "/lnrpc.Lightning/PendingChannels",
    "/lnrpc.Lightning/ChannelBalance",
    "/walletrpc.WalletKit/PendingSweeps",
  ]),
});

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const NEW_EXPOSURE_METHODS = new Set([
  "/invoicesrpc.Invoices/AddHoldInvoice",
  "/routerrpc.Router/SendPaymentV2",
]);

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function bigint(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function addReason(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

function preimageMatches(preimage, paymentHash) {
  if (!BYTES32.test(String(preimage ?? "")) || !BYTES32.test(String(paymentHash ?? ""))) return false;
  const digest = `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
  return digest === paymentHash.toLowerCase();
}

function auditHash(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function authorizeLightningRpc({ request, credential, transport, intent, service, usage, policy, now }) {
  const reasons = [];
  const observedAt = integer(now, "now");
  const amountSats = bigint(request.amountSats, "request.amountSats");
  const dailyValueSats = bigint(usage.dailyValueSats, "usage.dailyValueSats");
  const method = String(request.method ?? "");
  const opensExposure = NEW_EXPOSURE_METHODS.has(method);
  const role = String(credential.role ?? "");
  const permittedMethods = LIGHTNING_RPC_ALLOWLIST[role] ?? [];

  addReason(reasons, credential.active !== true || credential.revoked === true, "credential is inactive or revoked");
  addReason(reasons, credential.browserExposed === true, "node credential must never enter a browser");
  addReason(reasons, !String(credential.id ?? ""), "credential identifier is required");
  addReason(reasons, !Number.isSafeInteger(credential.rootKeyId) || credential.rootKeyId <= 0, "dedicated positive root key is required");
  addReason(reasons, integer(credential.issuedAt, "credential.issuedAt") > observedAt, "credential issuance time is in the future");
  addReason(
    reasons,
    observedAt - integer(credential.issuedAt, "credential.issuedAt") > integer(policy.maxCredentialAgeSeconds, "policy.maxCredentialAgeSeconds"),
    "credential rotation deadline exceeded",
  );
  addReason(reasons, !permittedMethods.includes(method), "RPC method is not allowed for credential role");
  addReason(reasons, transport.tlsVerified !== true, "LND TLS verification is required");
  addReason(reasons, transport.peerCertificateFingerprint !== policy.pinnedCertificateFingerprint, "LND certificate pin changed");
  addReason(reasons, transport.privateNetwork !== true, "LND RPC must remain on a private network");
  addReason(reasons, service.healthy !== true || service.syncedToChain !== true, "Lightning service is unhealthy or unsynced");
  addReason(reasons, service.walletSynced !== true, "Lightning wallet is unsynced");
  addReason(
    reasons,
    integer(service.headerAgeSeconds, "service.headerAgeSeconds")
      > integer(policy.maxChainHeaderAgeSeconds, "policy.maxChainHeaderAgeSeconds"),
    "Lightning best chain header is stale",
  );
  addReason(
    reasons,
    integer(service.noProgressSeconds, "service.noProgressSeconds")
      > integer(policy.maxChainNoProgressSeconds, "policy.maxChainNoProgressSeconds"),
    "Lightning chain made no observed progress",
  );
  addReason(
    reasons,
    integer(service.headerFutureSeconds, "service.headerFutureSeconds")
      > integer(policy.maxChainHeaderFutureSeconds, "policy.maxChainHeaderFutureSeconds"),
    "Lightning best chain header is too far in the future",
  );
  addReason(reasons, usage.requestIds?.includes(request.requestId), "adapter request identifier was already used");
  addReason(reasons, !BYTES32.test(String(request.requestId ?? "")), "invalid adapter request identifier");
  addReason(reasons, !BYTES32.test(String(request.intentDigest ?? "")), "invalid intent digest");
  addReason(reasons, request.intentDigest !== intent.intentDigest, "adapter request is not bound to the accepted intent");
  addReason(reasons, !BYTES32.test(String(request.paymentHash ?? "")), "invalid payment hash");
  addReason(reasons, request.paymentHash !== intent.paymentHash, "adapter payment hash changed");
  addReason(reasons, amountSats === 0n || amountSats !== bigint(intent.amountSats, "intent.amountSats"), "adapter amount changed");
  if (opensExposure) {
    addReason(reasons, service.chainProgressInitialized !== true, "Lightning chain progress baseline is not initialized");
    addReason(reasons, service.chainProgressConflicted === true, "Lightning chain progress observation conflicted");
    addReason(reasons, amountSats > bigint(policy.maxPaymentSats, "policy.maxPaymentSats"), "per-payment Lightning cap exceeded");
    addReason(reasons, dailyValueSats + amountSats > bigint(policy.maxDailyValueSats, "policy.maxDailyValueSats"), "daily Lightning cap exceeded");
  }
  addReason(reasons, !BYTES32.test(String(request.invoiceDigest ?? "")), "invalid invoice digest");
  addReason(reasons, request.invoiceDigest !== intent.invoiceDigest, "adapter invoice digest changed");
  addReason(reasons, service.capacityEpoch !== intent.capacityEpoch, "Lightning capacity epoch changed");
  if (opensExposure) {
    addReason(
      reasons,
      bigint(service.inFlightSats, "service.inFlightSats") + amountSats
        > bigint(policy.maxInFlightSats, "policy.maxInFlightSats"),
      "Lightning in-flight cap exceeded",
    );
    addReason(reasons, bigint(service.availableSats, "service.availableSats") < amountSats, "directional Lightning liquidity is insufficient");
  }
  if (method === "/invoicesrpc.Invoices/SettleInvoice") {
    addReason(reasons, !preimageMatches(request.preimage, request.paymentHash), "settlement preimage does not match payment hash");
  }
  if (method !== "/invoicesrpc.Invoices/SettleInvoice" && request.preimage !== undefined) {
    reasons.push("preimage supplied to a method that must not receive it");
  }
  addReason(reasons, request.macaroon !== undefined, "application requests must not carry macaroons");

  const allowed = reasons.length === 0;
  const countsValue = opensExposure;
  return Object.freeze({
    allowed,
    reasons,
    nextDailyValueSats: allowed && countsValue ? dailyValueSats + amountSats : dailyValueSats,
    audit: Object.freeze({
      observedAt,
      decision: allowed ? "allowed" : "denied",
      role,
      method,
      credentialIdHash: auditHash(String(credential.id ?? "missing")),
      requestId: request.requestId,
      intentDigest: request.intentDigest,
      paymentHash: request.paymentHash,
      amountSats,
      reasons: [...reasons],
    }),
  });
}

export function assertAuditIsSecretFree(audit) {
  const serialized = JSON.stringify(audit, (_, value) => typeof value === "bigint" ? value.toString() : value);
  for (const forbidden of ["macaroon", "preimage", "payment_request", "invoice_text"]) {
    if (serialized.toLowerCase().includes(forbidden)) throw new Error(`audit contains forbidden ${forbidden} data`);
  }
  return true;
}
