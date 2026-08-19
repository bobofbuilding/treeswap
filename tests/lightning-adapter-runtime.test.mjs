import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { id, sha256 } from "ethers";
import { LightningActionJournal } from "../lib/lightning-action-journal.mjs";
import { LightningAdapterRuntime } from "../lib/lightning-adapter-runtime.mjs";
import { signLightningAuthorizationEnvelope } from "../lib/lightning-authorization-envelope.mjs";
import { invoiceDigest, LndRestError } from "../lib/lnd-rest-client.mjs";

const NOW = 2_000_000_000;
const PAYMENT_REQUEST = "lnbcrt1treeswapexact";
const PREIMAGE = id("runtime-preimage").toLowerCase();
const PAYMENT_HASH = sha256(PREIMAGE).toLowerCase();
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const policy = {
  maxAuthorizationLifetimeSeconds: 30,
  maxCredentialAgeSeconds: 86_400,
  pinnedCertificateFingerprint: "sha256:regtest-node",
  maxPaymentSats: 100_000n,
  maxDailyValueSats: 500_000n,
  maxInFlightSats: 150_000n,
  capacityEpoch: 7,
  maxPendingChannels: 1,
  minimumActiveChannels: 1,
  maxChainHeaderAgeSeconds: 3_600,
  maxChainNoProgressSeconds: 3_600,
  maxChainHeaderFutureSeconds: 300,
  healthTimeoutMs: 1_000,
  dispatchTimeoutMs: 2_000,
  minimumInvoiceExpirySeconds: 300,
  maximumInvoiceExpirySeconds: 10_800,
  minimumHoldInvoiceCltvBlocks: 48,
  maximumHoldInvoiceCltvBlocks: 144,
  fulfillmentSafetyBlocks: 24,
  maximumPaymentTimeoutSeconds: 30,
  maximumRoutingFeeSats: 10,
  invoiceExpiryMarginSeconds: 60,
  minimumPaymentCltvBlocks: 18,
};

class MockLnd {
  certificateFingerprint = policy.pinnedCertificateFingerprint;
  privateNetworkVerified = true;
  sendError = null;
  calls = [];
  info = { synced_to_chain: true, wallet_synced: true, best_header_timestamp: String(NOW - 30), block_height: 900_000 };

  async getInfo() { return this.info; }
  async listChannels() {
    return { channels: [{ active: true, local_balance: "500000", remote_balance: "500000", pending_htlcs: [] }] };
  }
  async pendingChannels() { return {}; }
  async decodePaymentRequest(paymentRequest) {
    this.calls.push(["decode", paymentRequest]);
    return {
      payment_hash: PAYMENT_HASH.slice(2),
      num_satoshis: "10000",
      num_msat: "10000000",
      timestamp: String(NOW - 10),
      expiry: "600",
      cltv_expiry: "18",
    };
  }
  async sendPayment() {
    this.calls.push(["send"]);
    if (this.sendError) throw this.sendError;
    return {
      status: "SUCCEEDED",
      payment_hash: PAYMENT_HASH.slice(2),
      value_sat: "10000",
      fee_sat: "1",
      payment_preimage: PREIMAGE.slice(2),
    };
  }
  async lookupInvoice() {
    return {
      state: "ACCEPTED",
      amt_paid_sat: "10000",
      htlcs: [{ state: "ACCEPTED", amt_msat: "10000000", accept_height: 900_000, expiry_height: 900_080 }],
    };
  }
  async settleInvoice() { this.calls.push(["settle"]); return {}; }
}

function authorization(method, operation, overrides = {}) {
  return signLightningAuthorizationEnvelope({
    schema: "treeswap.lightning-authorization.v1",
    keyId: "coordinator-regtest-1",
    method,
    requestId: id(`request-${method}`).toLowerCase(),
    intentDigest: id("runtime-intent").toLowerCase(),
    paymentHash: PAYMENT_HASH,
    invoiceDigest: invoiceDigest(PAYMENT_REQUEST),
    amountSats: "10000",
    capacityEpoch: 7,
    authorizedAt: NOW,
    expiresAt: NOW + 15,
    operation,
    ...overrides,
  }, privateKey);
}

async function runtime(role, lnd = new MockLnd(), now = () => NOW + 1, policyOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-runtime-"));
  const journal = await LightningActionJournal.open(join(directory, "actions.jsonl"));
  return {
    lnd,
    journal,
    adapter: new LightningAdapterRuntime({
      role,
      credential: {
        id: `${role}-regtest`,
        rootKeyId: role === "invoice" ? 102 : 103,
        active: true,
        revoked: false,
        browserExposed: false,
        issuedAt: NOW - 100,
      },
      publicKey,
      keyId: "coordinator-regtest-1",
      lnd,
      journal,
      policy: { ...policy, ...policyOverrides },
      now,
    }),
  };
}

test("pays only an exact signed and decoded invoice, then permanently rejects replay", async () => {
  const { adapter, journal } = await runtime("payer");
  const envelope = authorization("/routerrpc.Router/SendPaymentV2", {
    paymentRequest: PAYMENT_REQUEST,
    timeoutSeconds: 10,
    feeLimitSats: "10",
  });
  const executed = await adapter.execute(envelope);
  assert.equal(executed.result.status, "SUCCEEDED");
  assert.equal(executed.result.preimage, PREIMAGE);
  assert.equal(journal.state(envelope.payload.requestId), "succeeded");
  await assert.rejects(() => adapter.execute(envelope), /already used/);
});

test("binds settlement to an accepted amount, safe HTLC, and matching preimage", async () => {
  const { adapter } = await runtime("invoice");
  const envelope = authorization("/invoicesrpc.Invoices/SettleInvoice", { preimage: PREIMAGE });
  const executed = await adapter.execute(envelope);
  assert.equal(executed.result.state, "SETTLED");

  const second = await runtime("invoice");
  const wrong = authorization("/invoicesrpc.Invoices/SettleInvoice", { preimage: id("wrong").toLowerCase() }, {
    requestId: id("wrong-settlement").toLowerCase(),
  });
  await assert.rejects(() => second.adapter.execute(wrong), /preimage does not match/);
});

test("journals an ambiguous payment without exposing it to automatic retry", async () => {
  const lnd = new MockLnd();
  lnd.sendError = new LndRestError("transport ended after dispatch", { ambiguous: true });
  const { adapter, journal } = await runtime("payer", lnd);
  const envelope = authorization("/routerrpc.Router/SendPaymentV2", {
    paymentRequest: PAYMENT_REQUEST,
    timeoutSeconds: 10,
    feeLimitSats: "10",
  }, { requestId: id("ambiguous-payment").toLowerCase() });
  await assert.rejects(() => adapter.execute(envelope), /transport ended/);
  assert.equal(journal.state(envelope.payload.requestId), "unknown");
  await assert.rejects(() => adapter.execute(envelope), /already used/);
});

test("rejects a changed invoice before dispatch", async () => {
  const { adapter, lnd } = await runtime("payer");
  const envelope = authorization("/routerrpc.Router/SendPaymentV2", {
    paymentRequest: "lnbcrt1changed",
    timeoutSeconds: 10,
    feeLimitSats: "10",
  });
  await assert.rejects(() => adapter.execute(envelope), /invoice digest changed/);
  assert.equal(lnd.calls.some(([name]) => name === "send"), false);
});

test("rejects a stale best header or unsynced wallet before payment dispatch", async () => {
  for (const info of [
    { synced_to_chain: true, wallet_synced: true, best_header_timestamp: String(NOW - 3_601), block_height: 900_000 },
    { synced_to_chain: true, wallet_synced: false, best_header_timestamp: String(NOW - 30), block_height: 900_000 },
  ]) {
    const lnd = new MockLnd();
    lnd.info = info;
    const { adapter } = await runtime("payer", lnd);
    const envelope = authorization("/routerrpc.Router/SendPaymentV2", {
      paymentRequest: PAYMENT_REQUEST,
      timeoutSeconds: 10,
      feeLimitSats: "10",
    }, { requestId: id(`unhealthy-${info.best_header_timestamp}-${info.wallet_synced}`).toLowerCase() });
    await assert.rejects(() => adapter.execute(envelope), /unhealthy or unsynced|best chain header is stale|wallet is unsynced/);
    assert.equal(lnd.calls.some(([name]) => name === "send"), false);
  }
});

test("rejects locally observed header stagnation even when the reported timestamp is in the future", async () => {
  let observedAt = NOW + 1;
  const lnd = new MockLnd();
  lnd.info = {
    synced_to_chain: true,
    wallet_synced: true,
    best_header_timestamp: String(NOW + 5),
    block_height: 900_000,
  };
  const { adapter } = await runtime("payer", lnd, () => observedAt, {
    maxChainNoProgressSeconds: 1,
    maxChainHeaderFutureSeconds: 300,
  });
  await adapter.execute(authorization("/lnrpc.Lightning/DecodePayReq", {
    paymentRequest: PAYMENT_REQUEST,
  }, { requestId: id("stalled-header-baseline").toLowerCase() }));
  observedAt += 2;
  const envelope = authorization("/routerrpc.Router/SendPaymentV2", {
    paymentRequest: PAYMENT_REQUEST,
    timeoutSeconds: 10,
    feeLimitSats: "10",
  }, { requestId: id("stalled-header-payment").toLowerCase() });
  await assert.rejects(() => adapter.execute(envelope), /chain made no observed progress/);
  assert.equal(lnd.calls.some(([name]) => name === "send"), false);
});

test("rejects a header beyond the configured future-skew limit", async () => {
  const lnd = new MockLnd();
  lnd.info = {
    synced_to_chain: true,
    wallet_synced: true,
    best_header_timestamp: String(NOW + 302),
    block_height: 900_000,
  };
  const { adapter } = await runtime("payer", lnd);
  const envelope = authorization("/routerrpc.Router/SendPaymentV2", {
    paymentRequest: PAYMENT_REQUEST,
    timeoutSeconds: 10,
    feeLimitSats: "10",
  }, { requestId: id("future-header-payment").toLowerCase() });
  await assert.rejects(() => adapter.execute(envelope), /too far in the future/);
  assert.equal(lnd.calls.some(([name]) => name === "send"), false);
});
