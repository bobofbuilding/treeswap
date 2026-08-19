function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function minimum(left, right) {
  return left < right ? left : right;
}

export function deriveSettlementSchedule({ direction, nowSeconds, bitcoinHeight, invoice, policy }) {
  const now = integer(nowSeconds, "nowSeconds");
  const height = integer(bitcoinHeight, "bitcoinHeight");
  const createdAt = integer(invoice.timestamp, "invoice.timestamp");
  const expirySeconds = integer(invoice.expirySeconds, "invoice.expirySeconds");
  const finalCltv = integer(invoice.minFinalCltvExpiryDelta, "invoice.minFinalCltvExpiryDelta");

  if (direction !== "lightning-to-bit" && direction !== "bit-to-lightning") {
    throw new RangeError("unsupported settlement direction");
  }
  if (createdAt > now + integer(policy.maxClockSkewSeconds, "maxClockSkewSeconds")) {
    throw new RangeError("invoice timestamp is in the future");
  }
  if (expirySeconds === 0) throw new RangeError("invoice expiry is required");

  const minimumFinalCltv = direction === "lightning-to-bit"
    ? integer(policy.minimumHoldInvoiceCltvBlocks, "minimumHoldInvoiceCltvBlocks")
    : integer(policy.minimumPaymentCltvBlocks, "minimumPaymentCltvBlocks");
  if (finalCltv < minimumFinalCltv) throw new RangeError("invoice final CLTV is below policy");

  const fulfillmentSafetyBlocks = integer(policy.fulfillmentSafetyBlocks, "fulfillmentSafetyBlocks");
  if (direction === "lightning-to-bit" && finalCltv <= fulfillmentSafetyBlocks) {
    throw new RangeError("hold invoice has no safe settlement block window");
  }

  const invoiceExpiresAt = createdAt + expirySeconds;
  const invoiceCutoffAt = invoiceExpiresAt - integer(policy.invoiceExpiryMarginSeconds, "invoiceExpiryMarginSeconds");
  if (invoiceCutoffAt <= now) throw new RangeError("invoice is expired or inside its safety margin");

  let cltvCutoffAt = Number.MAX_SAFE_INTEGER;
  let cltvSafeHeight = null;
  if (direction === "lightning-to-bit") {
    cltvSafeHeight = height + finalCltv - fulfillmentSafetyBlocks;
    cltvCutoffAt = now
      + (cltvSafeHeight - height) * integer(policy.minimumBitcoinBlockSeconds, "minimumBitcoinBlockSeconds");
  }

  const lastSafeClaimAt = minimum(invoiceCutoffAt, cltvCutoffAt);
  const ethereumFinalitySeconds = integer(policy.ethereumConfirmations, "ethereumConfirmations")
    * integer(policy.maximumEthereumBlockSeconds, "maximumEthereumBlockSeconds");
  const ethereumFinalAt = now + ethereumFinalitySeconds;
  const minimumPaymentWindowSeconds = integer(policy.minimumPaymentWindowSeconds, "minimumPaymentWindowSeconds");
  if (lastSafeClaimAt - ethereumFinalAt < minimumPaymentWindowSeconds) {
    throw new RangeError("invoice cannot outlive Ethereum finality and the Lightning action window");
  }

  const quoteExpiresAt = minimum(
    now + integer(policy.quoteTtlSeconds, "quoteTtlSeconds"),
    lastSafeClaimAt - minimumPaymentWindowSeconds,
  );
  if (quoteExpiresAt <= now || quoteExpiresAt >= lastSafeClaimAt) {
    throw new RangeError("quote expiry cannot be safely ordered");
  }

  const claimBufferSeconds = integer(policy.claimRelaySeconds, "claimRelaySeconds")
    + ethereumFinalitySeconds
    + integer(policy.ethereumCongestionSeconds, "ethereumCongestionSeconds");
  const refundAfter = lastSafeClaimAt + claimBufferSeconds;
  if (refundAfter - now > integer(policy.maximumLockSeconds, "maximumLockSeconds")) {
    throw new RangeError("derived refund exceeds the maximum lock duration");
  }

  return Object.freeze({
    direction,
    derivedAt: now,
    bitcoinHeight: height,
    invoiceExpiresAt,
    invoiceCutoffAt,
    cltvSafeHeight,
    cltvCutoffAt: cltvCutoffAt === Number.MAX_SAFE_INTEGER ? null : cltvCutoffAt,
    ethereumFinalAt,
    quoteExpiresAt,
    lastSafeClaimAt,
    refundAfter,
    claimBufferSeconds,
    policyVersion: String(policy.version),
  });
}

export function validateHeldHtlc({ schedule, observedAt, currentBitcoinHeight, htlcExpiryHeight, policy }) {
  const reasons = [];
  const now = integer(observedAt, "observedAt");
  const currentHeight = integer(currentBitcoinHeight, "currentBitcoinHeight");
  const expiryHeight = integer(htlcExpiryHeight, "htlcExpiryHeight");
  const safetyBlocks = integer(policy.fulfillmentSafetyBlocks, "fulfillmentSafetyBlocks");
  const minimumDelta = integer(policy.minimumHoldInvoiceCltvBlocks, "minimumHoldInvoiceCltvBlocks");

  if (schedule.direction !== "lightning-to-bit") reasons.push("hold HTLC is not valid for this direction");
  if (expiryHeight < currentHeight + minimumDelta) reasons.push("accepted HTLC expiry is below the hold-invoice minimum");
  if (expiryHeight <= currentHeight + safetyBlocks) reasons.push("accepted HTLC has no onchain fulfillment margin");

  const safeHeight = expiryHeight > safetyBlocks ? expiryHeight - safetyBlocks : 0;
  const safeBlocksRemaining = safeHeight > currentHeight ? safeHeight - currentHeight : 0;
  const htlcLastSafeAt = now
    + safeBlocksRemaining * integer(policy.minimumBitcoinBlockSeconds, "minimumBitcoinBlockSeconds");
  const effectiveLastSafeAt = minimum(schedule.lastSafeClaimAt, htlcLastSafeAt);
  if (effectiveLastSafeAt - now < integer(policy.minimumHeldHtlcActionSeconds, "minimumHeldHtlcActionSeconds")) {
    reasons.push("accepted HTLC is too close to its safe settlement boundary");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    safeHeight,
    htlcLastSafeAt,
    effectiveLastSafeAt,
  };
}

export function authorizeLightningAction({ schedule, chain, service, nowSeconds, policy }) {
  const reasons = [];
  const now = integer(nowSeconds, "nowSeconds");
  const latestBlock = integer(chain.latestBlock, "chain.latestBlock");
  const finalizedBlock = integer(chain.finalizedBlock, "chain.finalizedBlock");
  const escrowBlock = integer(chain.escrowBlock, "chain.escrowBlock");
  const requiredConfirmations = integer(policy.ethereumConfirmations, "ethereumConfirmations");

  if (now >= schedule.lastSafeClaimAt) reasons.push("Lightning action cutoff has passed");
  if (latestBlock < escrowBlock) reasons.push("escrow block is ahead of the observed chain");
  if (latestBlock >= escrowBlock && latestBlock - escrowBlock + 1 < requiredConfirmations) {
    reasons.push("escrow does not have enough confirmations");
  }
  if (escrowBlock > finalizedBlock) reasons.push("escrow is not finalized");
  if (finalizedBlock > latestBlock) reasons.push("invalid Ethereum finality state");
  if (latestBlock >= finalizedBlock && latestBlock - finalizedBlock > integer(policy.maxFinalityLagBlocks, "maxFinalityLagBlocks")) {
    reasons.push("Ethereum finality lag exceeds policy");
  }
  if (!chain.escrowBlockHash || chain.escrowBlockHash !== chain.canonicalBlockHash) {
    reasons.push("escrow block is no longer canonical");
  }
  if (chain.escrowDigest !== chain.expectedEscrowDigest) reasons.push("escrow terms do not match the authorized intent");
  if (service.riskGateEnabled !== true) reasons.push("risk gate is closed");
  if (service.balancesReconciled !== true) reasons.push("solver balances are not reconciled");
  if (service.lightningNodeSynced !== true) reasons.push("Lightning node is not synced");
  if (service.adapterHealthy !== true) reasons.push("Lightning adapter is unhealthy");

  return { authorized: reasons.length === 0, reasons };
}
