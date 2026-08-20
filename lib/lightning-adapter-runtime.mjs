import { assertAuditIsSecretFree, authorizeLightningRpc } from "./lightning-adapter-policy.mjs";
import { verifyLightningAuthorizationEnvelope } from "./lightning-authorization-envelope.mjs";
import { invoiceDigest, LndRestError } from "./lnd-rest-client.mjs";

const ZERO_HASH = `0x${"00".repeat(32)}`;
const COMPRESSED_NODE_PUBKEY = /^(?:02|03)[0-9a-f]{64}$/;
const EXPOSURE_METHODS = new Set([
  "/invoicesrpc.Invoices/AddHoldInvoice",
  "/routerrpc.Router/SendPaymentV2",
]);
const ROLE_METHODS = Object.freeze({
  invoice: new Set([
    "/invoicesrpc.Invoices/AddHoldInvoice",
    "/invoicesrpc.Invoices/LookupInvoiceV2",
    "/invoicesrpc.Invoices/SettleInvoice",
    "/invoicesrpc.Invoices/CancelInvoice",
  ]),
  payer: new Set([
    "/lnrpc.Lightning/DecodePayReq",
    "/routerrpc.Router/SendPaymentV2",
    "/routerrpc.Router/TrackPaymentV2",
  ]),
});

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function decimal(value, name) {
  const normalized = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  return BigInt(normalized);
}

function exactKeys(value, allowed, name) {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields do not match the operation schema`);
  }
}

function normalizedHash(value, name) {
  const raw = String(value ?? "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new TypeError(`${name} is not a payment hash`);
  return `0x${raw}`;
}

function normalizedBlockHash(value) {
  const raw = String(value ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new TypeError("LND best block hash is invalid");
  return raw;
}

function sumPendingHtlcs(channels) {
  let total = 0n;
  for (const channel of channels?.channels ?? []) {
    for (const htlc of channel.pending_htlcs ?? []) total += decimal(htlc.amount ?? "0", "pending HTLC amount");
  }
  return total;
}

function channelLiquidity(channels) {
  let activeChannels = 0;
  let outboundSats = 0n;
  let inboundSats = 0n;
  for (const channel of channels?.channels ?? []) {
    if (channel.active !== true) continue;
    activeChannels += 1;
    outboundSats += decimal(channel.local_balance ?? "0", "channel local balance");
    inboundSats += decimal(channel.remote_balance ?? "0", "channel remote balance");
  }
  return { activeChannels, outboundSats, inboundSats };
}

function secretFreeInvoiceView(invoice, paymentHash) {
  return Object.freeze({
    paymentHash,
    state: String(invoice.state ?? "UNKNOWN"),
    valueSats: String(invoice.value ?? "0"),
    amountPaidSats: String(invoice.amt_paid_sat ?? "0"),
    htlcs: Object.freeze((invoice.htlcs ?? []).map((htlc) => Object.freeze({
      state: String(htlc.state ?? "UNKNOWN"),
      amountMsat: String(htlc.amt_msat ?? "0"),
      acceptHeight: Number(htlc.accept_height ?? 0),
      expiryHeight: Number(htlc.expiry_height ?? 0),
    }))),
  });
}

export class LightningAdapterRuntime {
  #role;
  #credential;
  #publicKey;
  #keyId;
  #lnd;
  #journal;
  #chainProgress;
  #policy;
  #now;

  constructor({ role, credential, publicKey, keyId, lnd, journal, chainProgress, policy, now = () => Math.floor(Date.now() / 1_000) }) {
    if (!ROLE_METHODS[role]) throw new TypeError("adapter role is unsupported");
    if (!chainProgress || typeof chainProgress.observe !== "function") throw new TypeError("chain progress store is required");
    this.#role = role;
    this.#credential = Object.freeze({ ...credential, role });
    this.#publicKey = publicKey;
    this.#keyId = keyId;
    this.#lnd = lnd;
    this.#journal = journal;
    this.#chainProgress = chainProgress;
    this.#policy = policy;
    this.#now = now;
  }

  async #observeService() {
    const [info, channels, pending] = await Promise.all([
      this.#lnd.getInfo(this.#policy.healthTimeoutMs),
      this.#lnd.listChannels(this.#policy.healthTimeoutMs),
      this.#lnd.pendingChannels(this.#policy.healthTimeoutMs),
    ]);
    const pendingChannelCount = [
      ...(pending.pending_open_channels ?? []),
      ...(pending.pending_closing_channels ?? []),
      ...(pending.pending_force_closing_channels ?? []),
      ...(pending.waiting_close_channels ?? []),
    ].length;
    const liquidity = channelLiquidity(channels);
    const observedAt = integer(this.#now(), "service observation timestamp");
    const walletSynced = info.wallet_synced === true;
    const bestHeaderTimestamp = integer(Number(info.best_header_timestamp), "LND best header timestamp");
    const blockHeight = integer(Number(info.block_height), "LND block height");
    const bestBlockHash = normalizedBlockHash(info.block_hash);
    const progress = await this.#chainProgress.observe({
      blockHeight,
      bestBlockHash,
      bestHeaderTimestamp,
      observedAt,
    });
    const noProgressSeconds = progress.noProgressSeconds;
    const reportedHeaderAgeSeconds = Math.max(0, observedAt - bestHeaderTimestamp);
    const headerFutureSeconds = Math.max(0, bestHeaderTimestamp - observedAt);
    return Object.freeze({
      healthy: info.synced_to_chain === true
        && walletSynced
        && reportedHeaderAgeSeconds <= this.#policy.maxChainHeaderAgeSeconds
        && noProgressSeconds <= this.#policy.maxChainNoProgressSeconds
        && headerFutureSeconds <= this.#policy.maxChainHeaderFutureSeconds
        && pendingChannelCount <= this.#policy.maxPendingChannels
        && liquidity.activeChannels >= this.#policy.minimumActiveChannels,
      syncedToChain: info.synced_to_chain === true,
      walletSynced,
      bestHeaderTimestamp,
      headerAgeSeconds: reportedHeaderAgeSeconds,
      headerFutureSeconds,
      noProgressSeconds,
      chainProgressInitialized: progress.initialized,
      chainProgressConflicted: progress.conflicted,
      capacityEpoch: this.#policy.capacityEpoch,
      nodePubkey: String(info.identity_pubkey ?? "").toLowerCase(),
      inFlightSats: sumPendingHtlcs(channels),
      outboundSats: liquidity.outboundSats,
      inboundSats: liquidity.inboundSats,
      blockHeight,
      observedAt,
    });
  }

  async initializeChainProgress() {
    await this.#observeService();
  }

  async observeCapacity(direction) {
    if (!new Set(["lightning-to-bit", "bit-to-lightning"]).has(direction)) {
      throw new TypeError("Lightning capacity direction is unsupported");
    }
    const expectedRole = direction === "lightning-to-bit" ? "invoice" : "payer";
    if (this.#role !== expectedRole) throw new Error("Lightning capacity direction does not belong to this adapter role");
    const service = await this.#observeService();
    if (service.healthy !== true || service.syncedToChain !== true || service.walletSynced !== true
        || service.chainProgressInitialized !== true || service.chainProgressConflicted === true) {
      throw new Error("Lightning capacity is unavailable while the node or chain observation is unhealthy");
    }
    if (!COMPRESSED_NODE_PUBKEY.test(service.nodePubkey)) throw new Error("Lightning node identity is unavailable");
    const inbound = direction === "lightning-to-bit";
    const gross = inbound ? service.inboundSats : service.outboundSats;
    const reserve = decimal(
      inbound ? this.#policy.minimumInboundReserveSats : this.#policy.minimumOutboundReserveSats,
      inbound ? "minimum inbound reserve" : "minimum outbound reserve",
    );
    const budget = decimal(
      inbound ? this.#policy.maximumAdvertisedInboundSats : this.#policy.maximumAdvertisedOutboundSats,
      inbound ? "maximum advertised inbound capacity" : "maximum advertised outbound capacity",
    );
    if (budget === 0n) throw new Error("Lightning advertised-capacity budget must be positive");
    const deductions = service.inFlightSats + reserve;
    const net = gross > deductions ? gross - deductions : 0n;
    const available = net < budget ? net : budget;
    return Object.freeze({
      nodePubkey: service.nodePubkey,
      capacityEpoch: String(this.#policy.capacityEpoch),
      grossLightningSats: gross.toString(),
      inFlightSats: service.inFlightSats.toString(),
      reserveSats: reserve.toString(),
      budgetSats: budget.toString(),
      availableLightningSats: available.toString(),
      observedAt: service.observedAt,
    });
  }

  async #validateOperation(payload, service) {
    const operation = payload.operation;
    switch (payload.method) {
      case "/invoicesrpc.Invoices/AddHoldInvoice": {
        exactKeys(operation, ["cltvExpiry", "expirySeconds", "isPrivate", "memo"], "hold invoice");
        if (payload.invoiceDigest !== ZERO_HASH) throw new Error("hold-invoice creation must use the zero pre-creation invoice digest");
        const expirySeconds = integer(operation.expirySeconds, "expirySeconds", this.#policy.maximumInvoiceExpirySeconds);
        if (expirySeconds < this.#policy.minimumInvoiceExpirySeconds) throw new Error("hold-invoice expiry is below policy");
        const cltvExpiry = integer(operation.cltvExpiry, "cltvExpiry", this.#policy.maximumHoldInvoiceCltvBlocks);
        if (cltvExpiry < this.#policy.minimumHoldInvoiceCltvBlocks) throw new Error("hold-invoice CLTV is below policy");
        if (operation.isPrivate !== true) throw new Error("hold invoice must include private routing hints");
        if (typeof operation.memo !== "string" || operation.memo.length > 80) throw new Error("hold-invoice memo is invalid");
        return { expirySeconds, cltvExpiry };
      }
      case "/invoicesrpc.Invoices/LookupInvoiceV2":
        exactKeys(operation, [], "invoice lookup");
        return {};
      case "/invoicesrpc.Invoices/SettleInvoice": {
        exactKeys(operation, ["preimage"], "invoice settlement");
        const invoice = await this.#lnd.lookupInvoice(payload.paymentHash, this.#policy.healthTimeoutMs);
        if (invoice.state !== "ACCEPTED") throw new Error("hold invoice is not accepted");
        if (decimal(invoice.amt_paid_sat ?? "0", "accepted invoice amount") !== BigInt(payload.amountSats)) {
          throw new Error("accepted hold-invoice amount changed");
        }
        const acceptedHtlcs = (invoice.htlcs ?? []).filter((htlc) => htlc.state === "ACCEPTED");
        if (acceptedHtlcs.length === 0) throw new Error("hold invoice has no accepted HTLC");
        for (const htlc of acceptedHtlcs) {
          const expiryHeight = integer(Number(htlc.expiry_height), "HTLC expiry height");
          if (expiryHeight <= service.blockHeight + this.#policy.fulfillmentSafetyBlocks) {
            throw new Error("accepted HTLC is inside the settlement safety margin");
          }
        }
        return { preimage: String(operation.preimage) };
      }
      case "/invoicesrpc.Invoices/CancelInvoice": {
        exactKeys(operation, [], "invoice cancellation");
        const invoice = await this.#lnd.lookupInvoice(payload.paymentHash, this.#policy.healthTimeoutMs);
        if (invoice.state === "SETTLED") throw new Error("settled invoice cannot be canceled");
        return {};
      }
      case "/lnrpc.Lightning/DecodePayReq": {
        exactKeys(operation, ["paymentRequest"], "invoice decode");
        if (invoiceDigest(operation.paymentRequest) !== payload.invoiceDigest) throw new Error("BOLT 11 invoice digest changed");
        return { decoded: await this.#decodeAndValidatePayment(payload, operation.paymentRequest) };
      }
      case "/routerrpc.Router/SendPaymentV2": {
        exactKeys(operation, ["feeLimitSats", "paymentRequest", "timeoutSeconds"], "payment send");
        if (invoiceDigest(operation.paymentRequest) !== payload.invoiceDigest) throw new Error("BOLT 11 invoice digest changed");
        const timeoutSeconds = integer(operation.timeoutSeconds, "timeoutSeconds", this.#policy.maximumPaymentTimeoutSeconds);
        if (timeoutSeconds === 0) throw new Error("payment timeout must be non-zero");
        const feeLimitSats = decimal(operation.feeLimitSats, "feeLimitSats");
        if (feeLimitSats > BigInt(this.#policy.maximumRoutingFeeSats)) throw new Error("routing fee limit exceeds policy");
        const decoded = await this.#decodeAndValidatePayment(payload, operation.paymentRequest);
        return { decoded, timeoutSeconds, feeLimitSats };
      }
      case "/routerrpc.Router/TrackPaymentV2":
        exactKeys(operation, [], "payment tracking");
        return {};
      default:
        throw new Error("adapter method is unsupported");
    }
  }

  async #decodeAndValidatePayment(payload, paymentRequest) {
    const decoded = await this.#lnd.decodePaymentRequest(paymentRequest, this.#policy.healthTimeoutMs);
    if (normalizedHash(decoded.payment_hash, "decoded payment hash") !== payload.paymentHash) {
      throw new Error("decoded payment hash changed");
    }
    if (decimal(decoded.num_satoshis, "decoded invoice amount") !== BigInt(payload.amountSats)) {
      throw new Error("decoded invoice amount changed");
    }
    if (decimal(decoded.num_msat, "decoded invoice millisatoshis") !== BigInt(payload.amountSats) * 1_000n) {
      throw new Error("decoded invoice has sub-satoshi or inconsistent value");
    }
    const createdAt = integer(Number(decoded.timestamp), "invoice timestamp");
    const expiry = integer(Number(decoded.expiry), "invoice expiry");
    if (this.#now() >= createdAt + expiry - this.#policy.invoiceExpiryMarginSeconds) {
      throw new Error("invoice is expired or inside its safety margin");
    }
    if (integer(Number(decoded.cltv_expiry), "invoice CLTV") < this.#policy.minimumPaymentCltvBlocks) {
      throw new Error("invoice final CLTV is below policy");
    }
    return decoded;
  }

  async #dispatch(payload, validated) {
    switch (payload.method) {
      case "/invoicesrpc.Invoices/AddHoldInvoice": {
        const result = await this.#lnd.addHoldInvoice({
          paymentHash: payload.paymentHash,
          amountSats: payload.amountSats,
          memo: payload.operation.memo,
          expirySeconds: validated.expirySeconds,
          cltvExpiry: validated.cltvExpiry,
          isPrivate: true,
        }, this.#policy.dispatchTimeoutMs);
        return Object.freeze({
          paymentRequest: result.payment_request,
          invoiceDigest: invoiceDigest(result.payment_request),
          addIndex: String(result.add_index),
        });
      }
      case "/invoicesrpc.Invoices/LookupInvoiceV2":
        return secretFreeInvoiceView(
          await this.#lnd.lookupInvoice(payload.paymentHash, this.#policy.healthTimeoutMs),
          payload.paymentHash,
        );
      case "/invoicesrpc.Invoices/SettleInvoice":
        await this.#lnd.settleInvoice(validated.preimage, this.#policy.dispatchTimeoutMs);
        return Object.freeze({ state: "SETTLED" });
      case "/invoicesrpc.Invoices/CancelInvoice":
        await this.#lnd.cancelInvoice(payload.paymentHash, this.#policy.dispatchTimeoutMs);
        return Object.freeze({ state: "CANCELED" });
      case "/lnrpc.Lightning/DecodePayReq":
        return Object.freeze({
          paymentHash: normalizedHash(validated.decoded.payment_hash, "decoded payment hash"),
          amountSats: String(validated.decoded.num_satoshis),
          expiry: String(validated.decoded.expiry),
          cltvExpiry: String(validated.decoded.cltv_expiry),
        });
      case "/routerrpc.Router/SendPaymentV2": {
        const result = await this.#lnd.sendPayment({
          paymentRequest: payload.operation.paymentRequest,
          timeoutSeconds: validated.timeoutSeconds,
          feeLimitSats: validated.feeLimitSats,
        }, (validated.timeoutSeconds + 5) * 1_000);
        if (result.status !== "SUCCEEDED") throw new Error(`Lightning payment failed: ${String(result.failure_reason ?? "unknown")}`);
        if (normalizedHash(result.payment_hash, "payment result hash") !== payload.paymentHash) {
          throw new LndRestError("LND returned a different payment hash", { ambiguous: true });
        }
        if (decimal(result.value_sat, "payment result amount") !== BigInt(payload.amountSats)) {
          throw new LndRestError("LND returned a different payment amount", { ambiguous: true });
        }
        return Object.freeze({
          status: "SUCCEEDED",
          paymentHash: payload.paymentHash,
          amountSats: String(result.value_sat),
          feeSats: String(result.fee_sat ?? "0"),
          preimage: normalizedHash(result.payment_preimage, "payment preimage"),
        });
      }
      case "/routerrpc.Router/TrackPaymentV2": {
        const result = await this.#lnd.trackPayment(payload.paymentHash, this.#policy.dispatchTimeoutMs);
        const status = String(result.status);
        const tracked = {
          status: String(result.status),
          paymentHash: normalizedHash(result.payment_hash, "tracked payment hash"),
          amountSats: String(result.value_sat ?? "0"),
          feeSats: String(result.fee_sat ?? "0"),
        };
        if (status === "SUCCEEDED") {
          tracked.preimage = normalizedHash(result.payment_preimage, "tracked payment preimage");
        }
        return Object.freeze(tracked);
      }
      default:
        throw new Error("adapter method is unsupported");
    }
  }

  async execute(envelope) {
    const now = this.#now();
    const payload = verifyLightningAuthorizationEnvelope({
      envelope,
      publicKey: this.#publicKey,
      expectedKeyId: this.#keyId,
      now,
      maxLifetimeSeconds: this.#policy.maxAuthorizationLifetimeSeconds,
    });
    if (!ROLE_METHODS[this.#role].has(payload.method)) throw new Error("authorization method does not belong to this adapter role");
    if (this.#journal.has(payload.requestId)) throw new Error("adapter request identifier was already used");
    if (EXPOSURE_METHODS.has(payload.method) && this.#journal.hasExposurePaymentHash(payload.paymentHash)) {
      throw new Error("payment hash was already used for Lightning exposure");
    }
    const service = await this.#observeService();
    const validated = await this.#validateOperation(payload, service);
    const usage = this.#journal.usageForUtcDay(now);
    const request = {
      method: payload.method,
      requestId: payload.requestId,
      intentDigest: payload.intentDigest,
      paymentHash: payload.paymentHash,
      invoiceDigest: payload.invoiceDigest,
      amountSats: payload.amountSats,
      ...(payload.method === "/invoicesrpc.Invoices/SettleInvoice" ? { preimage: payload.operation.preimage } : {}),
    };
    const intent = {
      intentDigest: payload.intentDigest,
      paymentHash: payload.paymentHash,
      invoiceDigest: payload.invoiceDigest,
      amountSats: payload.amountSats,
      capacityEpoch: payload.capacityEpoch,
    };
    const decision = authorizeLightningRpc({
      request,
      credential: this.#credential,
      transport: {
        tlsVerified: true,
        peerCertificateFingerprint: this.#lnd.certificateFingerprint,
        privateNetwork: this.#lnd.privateNetworkVerified === true,
      },
      intent,
      service: {
        ...service,
        availableSats: payload.method === "/invoicesrpc.Invoices/AddHoldInvoice"
          ? service.inboundSats
          : service.outboundSats,
      },
      usage,
      policy: this.#policy,
      now,
    });
    if (!decision.allowed) throw new Error(`Lightning adapter denied authorization: ${decision.reasons.join("; ")}`);
    assertAuditIsSecretFree(decision.audit);

    await this.#journal.reserve({
      requestId: payload.requestId,
      method: payload.method,
      intentDigest: payload.intentDigest,
      paymentHash: payload.paymentHash,
      amountSats: payload.amountSats,
      countsExposure: EXPOSURE_METHODS.has(payload.method),
      recordedAt: now,
    });
    try {
      const result = await this.#dispatch(payload, validated);
      await this.#journal.complete(payload.requestId, "succeeded", this.#now(), "rpc-succeeded");
      return Object.freeze({ result, audit: decision.audit });
    } catch (error) {
      const ambiguous = error instanceof LndRestError && error.ambiguous;
      await this.#journal.complete(payload.requestId, ambiguous ? "unknown" : "failed", this.#now(), ambiguous ? "rpc-ambiguous" : "rpc-failed");
      throw error;
    }
  }
}
