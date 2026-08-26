import { coordinatorCommitmentDigest } from "./coordinator-store.mjs";
import {
  TREE_SWAP_SETTLEMENT_POLICY_V1,
  deriveSettlementSchedule,
  validateHeldHtlc,
} from "./settlement-policy.mjs";

const OBSERVATION_SCHEMA = "treeswap.cross-chain-deadline-observation.v1";
const EVIDENCE_SCHEMA = "treeswap.cross-chain-deadline-evidence.v1";
const SCOPE = "local-dual-chain-no-funding-authorization";
const HASH = /^0x[0-9a-f]{64}$/;
const REQUIRED_POLICY = TREE_SWAP_SETTLEMENT_POLICY_V1;

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return value;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function positive(value, name) {
  const result = integer(value, name);
  if (result === 0) throw new RangeError(`${name} must be positive`);
  return result;
}

function truth(value, name) {
  if (value !== true) throw new Error(`${name} must be true`);
  return true;
}

function hash(value, name) {
  const result = String(value ?? "").toLowerCase();
  if (!HASH.test(result) || result === `0x${"00".repeat(32)}`) throw new TypeError(`${name} must be a nonzero bytes32`);
  return result;
}

function exactPolicy(policy) {
  exactObject(policy, [
    "claimRelaySeconds",
    "ethereumConfirmations",
    "ethereumCongestionSeconds",
    "fulfillmentSafetyBlocks",
    "invoiceExpiryMarginSeconds",
    "maxAuthorizationAgeSeconds",
    "maxClockSkewSeconds",
    "maxFinalityLagBlocks",
    "maximumEthereumBlockSeconds",
    "maximumLockSeconds",
    "minimumBitcoinBlockSeconds",
    "minimumHeldHtlcActionSeconds",
    "minimumHoldInvoiceCltvBlocks",
    "minimumPaymentCltvBlocks",
    "minimumPaymentWindowSeconds",
    "quoteTtlSeconds",
    "version",
  ], "policy");
  if (String(policy.version) !== "1") throw new RangeError("policy version is unsupported");
  for (const [key, value] of Object.entries(policy)) {
    if (key !== "version") positive(value, `policy.${key}`);
    if (value !== REQUIRED_POLICY[key]) throw new RangeError(`policy.${key} does not match the required campaign policy`);
  }
  if (policy.fulfillmentSafetyBlocks >= policy.minimumHoldInvoiceCltvBlocks) {
    throw new RangeError("policy has no hold-invoice settlement window");
  }
  return policy;
}

function exactInvoice(invoice, name) {
  exactObject(invoice, ["expirySeconds", "minFinalCltvExpiryDelta", "timestamp"], name);
  return Object.freeze({
    timestamp: integer(invoice.timestamp, `${name}.timestamp`),
    expirySeconds: positive(invoice.expirySeconds, `${name}.expirySeconds`),
    minFinalCltvExpiryDelta: positive(invoice.minFinalCltvExpiryDelta, `${name}.minFinalCltvExpiryDelta`),
  });
}

function exactSchedule(schedule, expected, name) {
  exactObject(schedule, [
    "bitcoinHeight",
    "claimBufferSeconds",
    "cltvCutoffAt",
    "cltvSafeHeight",
    "derivedAt",
    "direction",
    "ethereumFinalAt",
    "invoiceCutoffAt",
    "invoiceExpiresAt",
    "lastSafeClaimAt",
    "policyVersion",
    "quoteExpiresAt",
    "refundAfter",
  ], name);
  for (const key of Object.keys(expected)) {
    if (schedule[key] !== expected[key]) throw new Error(`${name}.${key} does not match the derived schedule`);
  }
  if (!(schedule.quoteExpiresAt < schedule.lastSafeClaimAt && schedule.lastSafeClaimAt < schedule.refundAfter)) {
    throw new Error(`${name} deadline order is unsafe`);
  }
  if (schedule.refundAfter - schedule.lastSafeClaimAt !== schedule.claimBufferSeconds) {
    throw new Error(`${name} claim buffer does not match the refund boundary`);
  }
  return schedule;
}

function exactEvm(evm) {
  exactObject(evm, ["chainId", "executionClient", "userEscrowRuntimeCodeHash", "vaultRuntimeCodeHash"], "evm");
  if (String(evm.chainId) !== "31337") throw new RangeError("cross-chain campaign must use the isolated EVM chain");
  if (typeof evm.executionClient !== "string" || evm.executionClient.length < 3 || evm.executionClient.length > 200 || /[\r\n]/.test(evm.executionClient)) {
    throw new TypeError("execution client version is invalid");
  }
  return Object.freeze({
    chainId: "31337",
    executionClient: evm.executionClient,
    userEscrowRuntimeCodeHash: hash(evm.userEscrowRuntimeCodeHash, "evm.userEscrowRuntimeCodeHash"),
    vaultRuntimeCodeHash: hash(evm.vaultRuntimeCodeHash, "evm.vaultRuntimeCodeHash"),
  });
}

function validateBitToLightning(value, policy) {
  exactObject(value, ["bitcoinHeight", "evm", "invoice", "lightning", "schedule"], "bitToLightning");
  const invoice = exactInvoice(value.invoice, "bitToLightning.invoice");
  const bitcoinHeight = positive(value.bitcoinHeight, "bitToLightning.bitcoinHeight");
  const expected = deriveSettlementSchedule({
    direction: "bit-to-lightning",
    nowSeconds: integer(value.schedule?.derivedAt, "bitToLightning.schedule.derivedAt"),
    bitcoinHeight,
    invoice,
    policy,
  });
  const schedule = exactSchedule(value.schedule, expected, "bitToLightning.schedule");
  exactObject(value.lightning, ["paymentPreimageMatched", "paymentSucceeded"], "bitToLightning.lightning");
  truth(value.lightning.paymentSucceeded, "bitToLightning.lightning.paymentSucceeded");
  truth(value.lightning.paymentPreimageMatched, "bitToLightning.lightning.paymentPreimageMatched");
  exactObject(value.evm, [
    "claimSucceeded",
    "claimedAt",
    "confirmations",
    "finalizedAt",
    "openedAt",
    "refundRejectedBeforeClaim",
  ], "bitToLightning.evm");
  const openedAt = integer(value.evm.openedAt, "bitToLightning.evm.openedAt");
  const finalizedAt = integer(value.evm.finalizedAt, "bitToLightning.evm.finalizedAt");
  const claimedAt = integer(value.evm.claimedAt, "bitToLightning.evm.claimedAt");
  const confirmations = positive(value.evm.confirmations, "bitToLightning.evm.confirmations");
  if (openedAt > schedule.quoteExpiresAt) throw new Error("BIT-to-Lightning escrow opened after quote expiry");
  if (confirmations < policy.ethereumConfirmations) throw new Error("BIT-to-Lightning escrow lacked confirmations before payment");
  if (finalizedAt < openedAt || finalizedAt > schedule.ethereumFinalAt) {
    throw new Error("BIT-to-Lightning finality exceeded the derived allowance");
  }
  if (claimedAt < finalizedAt || claimedAt >= schedule.refundAfter) {
    throw new Error("BIT-to-Lightning claim was outside the post-finality claim window");
  }
  truth(value.evm.refundRejectedBeforeClaim, "bitToLightning.evm.refundRejectedBeforeClaim");
  truth(value.evm.claimSucceeded, "bitToLightning.evm.claimSucceeded");
  return Object.freeze({
    schedule,
    confirmations,
    openedAt,
    finalizedAt,
    claimedAt,
    paymentSucceeded: true,
    paymentProofMatched: true,
    refundRejectedBeforeClaim: true,
    claimSucceeded: true,
  });
}

function validateLightningToBit(value, policy) {
  exactObject(value, ["bitcoinHeight", "evm", "invoice", "lightning", "schedule"], "lightningToBit");
  const invoice = exactInvoice(value.invoice, "lightningToBit.invoice");
  const bitcoinHeight = positive(value.bitcoinHeight, "lightningToBit.bitcoinHeight");
  const expected = deriveSettlementSchedule({
    direction: "lightning-to-bit",
    nowSeconds: integer(value.schedule?.derivedAt, "lightningToBit.schedule.derivedAt"),
    bitcoinHeight,
    invoice,
    policy,
  });
  const schedule = exactSchedule(value.schedule, expected, "lightningToBit.schedule");
  exactObject(value.lightning, [
    "acceptedHeight",
    "boundaryHeight",
    "expiryHeight",
    "initialHtlcValid",
    "payerReleased",
    "safeHeight",
    "settlementRejectedAtBoundary",
  ], "lightningToBit.lightning");
  const acceptedHeight = positive(value.lightning.acceptedHeight, "lightningToBit.lightning.acceptedHeight");
  const expiryHeight = positive(value.lightning.expiryHeight, "lightningToBit.lightning.expiryHeight");
  const safeHeight = positive(value.lightning.safeHeight, "lightningToBit.lightning.safeHeight");
  const boundaryHeight = positive(value.lightning.boundaryHeight, "lightningToBit.lightning.boundaryHeight");
  if (safeHeight !== expiryHeight - policy.fulfillmentSafetyBlocks || boundaryHeight !== safeHeight) {
    throw new Error("live HTLC boundary does not equal the configured safety height");
  }
  const initial = validateHeldHtlc({
    schedule,
    observedAt: schedule.derivedAt,
    currentBitcoinHeight: acceptedHeight,
    htlcExpiryHeight: expiryHeight,
    policy,
  });
  if (!initial.valid || initial.safeHeight !== safeHeight) throw new Error("initial live HTLC was not safely actionable");
  const boundary = validateHeldHtlc({
    schedule,
    observedAt: schedule.derivedAt,
    currentBitcoinHeight: boundaryHeight,
    htlcExpiryHeight: expiryHeight,
    policy,
  });
  if (boundary.valid) throw new Error("live HTLC remained actionable at the safety boundary");
  truth(value.lightning.initialHtlcValid, "lightningToBit.lightning.initialHtlcValid");
  truth(value.lightning.settlementRejectedAtBoundary, "lightningToBit.lightning.settlementRejectedAtBoundary");
  truth(value.lightning.payerReleased, "lightningToBit.lightning.payerReleased");
  exactObject(value.evm, [
    "claimRejectedAtRefundBoundary",
    "claimSimulationSucceededBeforeRefund",
    "confirmations",
    "finalizedAt",
    "refundRejectedBeforeBoundary",
    "refundSucceeded",
    "refundedAt",
    "reservedAt",
  ], "lightningToBit.evm");
  const reservedAt = integer(value.evm.reservedAt, "lightningToBit.evm.reservedAt");
  const finalizedAt = integer(value.evm.finalizedAt, "lightningToBit.evm.finalizedAt");
  const refundedAt = integer(value.evm.refundedAt, "lightningToBit.evm.refundedAt");
  const confirmations = positive(value.evm.confirmations, "lightningToBit.evm.confirmations");
  if (reservedAt > schedule.quoteExpiresAt) throw new Error("Lightning-to-BIT vault reserved after quote expiry");
  if (confirmations < policy.ethereumConfirmations) throw new Error("Lightning-to-BIT vault lacked confirmations before payment");
  if (finalizedAt < reservedAt || finalizedAt > schedule.ethereumFinalAt) {
    throw new Error("Lightning-to-BIT finality exceeded the derived allowance");
  }
  if (refundedAt < schedule.refundAfter) throw new Error("Lightning-to-BIT refund occurred before its exact boundary");
  truth(value.evm.refundRejectedBeforeBoundary, "lightningToBit.evm.refundRejectedBeforeBoundary");
  truth(value.evm.claimSimulationSucceededBeforeRefund, "lightningToBit.evm.claimSimulationSucceededBeforeRefund");
  truth(value.evm.claimRejectedAtRefundBoundary, "lightningToBit.evm.claimRejectedAtRefundBoundary");
  truth(value.evm.refundSucceeded, "lightningToBit.evm.refundSucceeded");
  return Object.freeze({
    schedule,
    confirmations,
    reservedAt,
    finalizedAt,
    refundedAt,
    acceptedHeight,
    expiryHeight,
    advertisedSafeHeight: schedule.cltvSafeHeight,
    safeHeight,
    boundaryHeight,
    initialHtlcValid: true,
    settlementRejectedAtBoundary: true,
    payerReleased: true,
    refundRejectedBeforeBoundary: true,
    claimSimulationSucceededBeforeRefund: true,
    claimRejectedAtRefundBoundary: true,
    refundSucceeded: true,
  });
}

export function buildCrossChainDeadlineEvidence(observation) {
  exactObject(observation, ["bitToLightning", "evm", "lightningToBit", "policy", "schema"], "observation");
  if (observation.schema !== OBSERVATION_SCHEMA) throw new RangeError("cross-chain observation schema is unsupported");
  const policy = exactPolicy(observation.policy);
  const evm = exactEvm(observation.evm);
  const bitToLightning = validateBitToLightning(observation.bitToLightning, policy);
  const lightningToBit = validateLightningToBit(observation.lightningToBit, policy);
  const evidence = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    scope: SCOPE,
    evm,
    policyDigest: coordinatorCommitmentDigest(policy),
    directions: Object.freeze({
      bitToLightning,
      lightningToBit,
    }),
    limitations: Object.freeze({
      publicTestnetIncluded: false,
      independentProvidersIncluded: false,
      productionInfrastructureIncluded: false,
      simulatedEvmFinality: true,
      fundingAuthorization: false,
    }),
  });
  return Object.freeze({
    ...evidence,
    evidenceDigest: coordinatorCommitmentDigest(evidence),
  });
}

export const crossChainDeadlineSchemas = Object.freeze({
  observation: OBSERVATION_SCHEMA,
  evidence: EVIDENCE_SCHEMA,
  scope: SCOPE,
});

export const crossChainDeadlinePolicy = REQUIRED_POLICY;
