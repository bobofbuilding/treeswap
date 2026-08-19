import assert from "node:assert/strict";
import test from "node:test";
import { id, sha256, toUtf8Bytes } from "ethers";
import {
  assertAuditIsSecretFree,
  authorizeLightningRpc,
} from "../lib/lightning-adapter-policy.mjs";

const NOW = 2_000_000_000;
const PREIMAGE = id("adapter-preimage");
const PAYMENT_HASH = sha256(PREIMAGE);
const intent = {
  intentDigest: id("accepted-intent"),
  paymentHash: PAYMENT_HASH,
  invoiceDigest: id("invoice"),
  amountSats: 50_000n,
  capacityEpoch: 7,
};
const policy = {
  maxCredentialAgeSeconds: 86_400,
  pinnedCertificateFingerprint: "sha256:node-certificate",
  maxPaymentSats: 100_000n,
  maxDailyValueSats: 500_000n,
  maxInFlightSats: 150_000n,
  maxChainHeaderAgeSeconds: 3_600,
  maxChainNoProgressSeconds: 3_600,
  maxChainHeaderFutureSeconds: 300,
};
const transport = {
  tlsVerified: true,
  peerCertificateFingerprint: policy.pinnedCertificateFingerprint,
  privateNetwork: true,
};
const service = {
  healthy: true,
  syncedToChain: true,
  walletSynced: true,
  headerAgeSeconds: 30,
  noProgressSeconds: 10,
  chainProgressInitialized: true,
  chainProgressConflicted: false,
  headerFutureSeconds: 0,
  capacityEpoch: 7,
  inFlightSats: 25_000n,
  availableSats: 250_000n,
};
const usage = { dailyValueSats: 100_000n, requestIds: [] };

function credential(role, overrides = {}) {
  return {
    id: `${role}-2026-08-19`,
    role,
    rootKeyId: role === "invoice" ? 11 : 12,
    active: true,
    revoked: false,
    browserExposed: false,
    issuedAt: NOW - 100,
    ...overrides,
  };
}

function request(method, overrides = {}) {
  return {
    method,
    requestId: id(`${method}-request`),
    intentDigest: intent.intentDigest,
    paymentHash: intent.paymentHash,
    invoiceDigest: intent.invoiceDigest,
    amountSats: intent.amountSats,
    ...overrides,
  };
}

function authorize(overrides = {}) {
  return authorizeLightningRpc({
    request: request("/routerrpc.Router/SendPaymentV2"),
    credential: credential("payer"),
    transport,
    intent,
    service,
    usage,
    policy,
    now: NOW,
    ...overrides,
  });
}

test("allows only an exact intent-bound payer RPC and emits a secret-free audit", () => {
  const result = authorize();
  assert.equal(result.allowed, true);
  assert.equal(result.nextDailyValueSats, 150_000n);
  assert.equal(assertAuditIsSecretFree(result.audit), true);
  assert.equal("preimage" in result.audit, false);
  assert.equal("macaroon" in result.audit, false);
});

test("separates invoice and payment credentials by exact RPC URI", () => {
  const wrongRole = authorize({ credential: credential("invoice") });
  assert.equal(wrongRole.allowed, false);
  assert.match(wrongRole.reasons.join("; "), /not allowed for credential role/);

  const admin = authorize({ request: request("/lnrpc.Lightning/SendCoins") });
  assert.equal(admin.allowed, false);
  assert.match(admin.reasons.join("; "), /not allowed/);
});

test("fails closed for stale, revoked, browser-exposed, or default-root credentials", () => {
  for (const changed of [
    credential("payer", { issuedAt: NOW - 86_401 }),
    credential("payer", { revoked: true }),
    credential("payer", { browserExposed: true }),
    credential("payer", { rootKeyId: 0 }),
  ]) {
    assert.equal(authorize({ credential: changed }).allowed, false);
  }
});

test("fails closed on TLS pin, private-network, health, or capacity changes", () => {
  assert.equal(authorize({ transport: { ...transport, peerCertificateFingerprint: "changed" } }).allowed, false);
  assert.equal(authorize({ transport: { ...transport, privateNetwork: false } }).allowed, false);
  assert.equal(authorize({ service: { ...service, syncedToChain: false } }).allowed, false);
  assert.equal(authorize({ service: { ...service, walletSynced: false } }).allowed, false);
  const stale = authorize({ service: { ...service, healthy: false, headerAgeSeconds: 3_601 } });
  assert.equal(stale.allowed, false);
  assert.match(stale.reasons.join("; "), /best chain header is stale/);
  const stalled = authorize({ service: { ...service, healthy: false, noProgressSeconds: 3_601 } });
  assert.equal(stalled.allowed, false);
  const uninitialized = authorize({ service: { ...service, chainProgressInitialized: false } });
  assert.equal(uninitialized.allowed, false);
  assert.match(uninitialized.reasons.join("; "), /baseline is not initialized/);
  const conflicted = authorize({ service: { ...service, chainProgressConflicted: true } });
  assert.equal(conflicted.allowed, false);
  assert.match(conflicted.reasons.join("; "), /observation conflicted/);
  assert.match(stalled.reasons.join("; "), /no observed progress/);
  const future = authorize({ service: { ...service, healthy: false, headerFutureSeconds: 301 } });
  assert.equal(future.allowed, false);
  assert.match(future.reasons.join("; "), /too far in the future/);
  assert.equal(authorize({ service: { ...service, capacityEpoch: 8 } }).allowed, false);
});

test("enforces exact hash, amount, invoice, replay, and value caps", () => {
  for (const changedRequest of [
    request("/routerrpc.Router/SendPaymentV2", { paymentHash: id("changed") }),
    request("/routerrpc.Router/SendPaymentV2", { amountSats: 50_001n }),
    request("/routerrpc.Router/SendPaymentV2", { invoiceDigest: id("changed invoice") }),
  ]) {
    assert.equal(authorize({ request: changedRequest }).allowed, false);
  }
  assert.equal(authorize({ usage: { ...usage, requestIds: [request("/routerrpc.Router/SendPaymentV2").requestId] } }).allowed, false);
  assert.equal(authorize({ policy: { ...policy, maxPaymentSats: 49_999n } }).allowed, false);
  assert.equal(authorize({ usage: { ...usage, dailyValueSats: 475_000n } }).allowed, false);
  assert.equal(authorize({ service: { ...service, availableSats: 49_999n } }).allowed, false);
});

test("settles a hold invoice only with the matching preimage", () => {
  const method = "/invoicesrpc.Invoices/SettleInvoice";
  const accepted = authorize({
    request: request(method, { preimage: PREIMAGE }),
    credential: credential("invoice"),
  });
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.nextDailyValueSats, usage.dailyValueSats);

  const exitAtCaps = authorizeLightningRpc({
    request: request(method, { preimage: PREIMAGE }),
    credential: credential("invoice"),
    transport,
    intent,
    service: { ...service, inFlightSats: 999_999n, availableSats: 0n },
    usage: { ...usage, dailyValueSats: 999_999n },
    policy: { ...policy, maxPaymentSats: 1n, maxDailyValueSats: 1n, maxInFlightSats: 1n },
    now: NOW,
  });
  assert.equal(exitAtCaps.allowed, true);

  const rejected = authorize({
    request: request(method, { preimage: id("wrong") }),
    credential: credential("invoice"),
  });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reasons.join("; "), /preimage does not match/);
});

test("never accepts a macaroon from an application request", () => {
  const result = authorize({ request: request("/routerrpc.Router/SendPaymentV2", { macaroon: toUtf8Bytes("admin") }) });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join("; "), /must not carry macaroons/);
});
