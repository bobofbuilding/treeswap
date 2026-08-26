import {
  AbiCoder,
  Interface,
  Signature,
  TypedDataEncoder,
  getAddress,
  keccak256,
  verifyTypedData,
} from "ethers";
import {
  persistFinalizedContractIntentBinding,
  verifiedFinalizedContractIntentContext,
} from "./blind-rfq.mjs";
import {
  TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES,
  TREE_SWAP_SELECTED_QUOTE_TYPES,
  validateContractIntentBinding,
  validateContractIntentSigningPayload,
} from "./contract-intent-schema.mjs";
import { validateFullFillInvoice, validatedInvoicePolicy } from "./invoice-policy.mjs";
import {
  deriveSettlementSchedule,
  validatedTreeSwapSettlementPolicy,
} from "./settlement-policy.mjs";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT96_MAX = (1n << 96n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const MINIMUM_SUBMISSION_WINDOW_SECONDS = 30;
const PREPARED_INTENTS = new WeakMap();
const AUTHORIZED_INTENTS = new WeakMap();

export {
  TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES,
  TREE_SWAP_SELECTED_QUOTE_TYPES,
};

const BIT_VAULT = new Interface([
  "function reserve((bytes32 quoteId,address user,address solver,address beneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 nonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter) quote,bytes userSignature,bytes solverSignature)",
]);
const USER_ESCROW = new Interface([
  "function open((bytes32 quoteId,address user,address solver,address solverBeneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 solverNonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter) quote,bytes solverSignature)",
]);

function exactRecord(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...fields].sort();
  if (keys.some((key) => typeof key !== "string") || keys.length !== expected.length
      || [...keys].sort().some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function uint(value, name, maximum) {
  if (typeof value !== "bigint" && typeof value !== "string") {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
  const raw = typeof value === "bigint" ? value.toString() : value;
  if (!UINT.test(raw) || raw.length > maximum.toString().length) {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
  const parsed = BigInt(raw);
  if (parsed > maximum) throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  return parsed;
}

function bytes32(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be non-zero lowercase bytes32`);
  const raw = value;
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be non-zero lowercase bytes32`);
  return raw;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function canonicalSignature(value, name) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) {
    throw new TypeError(`${name} must be a canonical 65-byte ECDSA signature`);
  }
  try {
    const signature = Signature.from(value);
    if (signature.serialized.length !== 132 || (signature.v !== 27 && signature.v !== 28)) throw new Error();
    return signature.serialized;
  } catch {
    throw new TypeError(`${name} must be a canonical 65-byte ECDSA signature`);
  }
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function quoteId(context) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["string", "bytes32", "bytes32", "bytes32"],
    [
      "TreeSwap contract intent v1",
      context.settlementId,
      context.selectedOfferId,
      context.userAuthorizationDigest,
    ],
  ));
}

function invoiceForSchedule(canonical) {
  return Object.freeze({
    timestamp: canonical.timestamp,
    expirySeconds: canonical.expiresAt - canonical.timestamp,
    minFinalCltvExpiryDelta: canonical.minFinalCltvDelta,
  });
}

function signingMaterial(context, schedule, expiresAt) {
  const chainId = uint(context.chainId, "contract intent chainId", UINT256_MAX);
  const verifyingContract = address(context.settlementContract, "contract intent settlement contract");
  const amount = uint(context.grossBitAmount, "contract intent BIT amount", UINT96_MAX);
  const fee = uint(context.feeBitAmount, "contract intent BIT fee", UINT96_MAX);
  const lightningAmountSats = uint(
    context.lightningAmountSats,
    "contract intent Lightning amount",
    UINT64_MAX,
  );
  if (amount === 0n || fee >= amount || lightningAmountSats === 0n) {
    throw new RangeError("contract intent amount or fee is invalid");
  }
  const base = {
    quoteId: quoteId(context),
    user: address(context.user, "contract intent user"),
    solver: address(context.solver, "contract intent solver"),
    amount,
    fee,
    lightningAmountSats,
    paymentHash: bytes32(context.paymentHash, "contract intent payment hash"),
    invoiceDigest: bytes32(context.invoiceDigest, "contract intent invoice digest"),
    quoteExpiresAt: expiresAt,
    lastSafeClaimAt: schedule.lastSafeClaimAt,
    refundAfter: schedule.refundAfter,
  };
  if (context.direction === "lightning-to-bit") {
    return Object.freeze({
      primaryType: "SelectedQuote",
      domain: Object.freeze({
        name: "TreeSwap BIT Vault",
        version: "1",
        chainId,
        verifyingContract,
      }),
      types: TREE_SWAP_SELECTED_QUOTE_TYPES,
      message: Object.freeze({
        quoteId: base.quoteId,
        user: base.user,
        solver: base.solver,
        beneficiary: address(context.beneficiary, "contract intent beneficiary"),
        amount,
        fee,
        lightningAmountSats,
        paymentHash: base.paymentHash,
        invoiceDigest: base.invoiceDigest,
        nonce: uint(context.requestNonce, "contract intent user nonce", UINT256_MAX),
        quoteExpiresAt: expiresAt,
        lastSafeClaimAt: schedule.lastSafeClaimAt,
        refundAfter: schedule.refundAfter,
      }),
    });
  }
  if (context.direction !== "bit-to-lightning") {
    throw new RangeError("contract intent direction is unsupported");
  }
  return Object.freeze({
    primaryType: "BitToLightningQuote",
    domain: Object.freeze({
      name: "TreeSwap User BIT Escrow",
      version: "1",
      chainId,
      verifyingContract,
    }),
    types: TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES,
    message: Object.freeze({
      quoteId: base.quoteId,
      user: base.user,
      solver: base.solver,
      // The authenticated solver EOA is the only v1 payout address. A separate
      // beneficiary needs its own capability proof and is deliberately deferred.
      solverBeneficiary: base.solver,
      amount,
      fee,
      lightningAmountSats,
      paymentHash: base.paymentHash,
      invoiceDigest: base.invoiceDigest,
      solverNonce: uint(context.offerNonce, "contract intent solver nonce", UINT256_MAX),
      quoteExpiresAt: expiresAt,
      lastSafeClaimAt: schedule.lastSafeClaimAt,
      refundAfter: schedule.refundAfter,
    }),
  });
}

export function prepareFinalizedContractIntent(input) {
  const source = exactRecord(input, [
    "bitcoinHeight",
    "finalization",
    "invoice",
    "invoicePolicy",
    "now",
    "settlementPolicy",
  ], "contract intent preparation");
  const now = integer(source.now, "contract intent time", 1);
  const context = verifiedFinalizedContractIntentContext(source.finalization, { now });
  const invoicePolicy = validatedInvoicePolicy(source.invoicePolicy);
  const settlementPolicy = validatedTreeSwapSettlementPolicy(source.settlementPolicy);
  const invoice = String(source.invoice ?? "").trim().replace(/^lightning:/i, "").toLowerCase();
  const validation = validateFullFillInvoice({
    rawInvoice: invoice,
    request: {
      amountSats: context.lightningAmountSats,
      childIndex: null,
      expectedPayee: context.direction === "lightning-to-bit" ? context.lightningNodePubkey : null,
      fillAmountSats: context.lightningAmountSats,
      invoiceDigest: context.invoiceDigest,
      parentIntentId: null,
      paymentHash: context.paymentHash,
      totalAmountSats: context.lightningAmountSats,
    },
    registry: {
      consumedPaymentHashes: [],
      reservedPaymentHashes: [],
    },
    policy: invoicePolicy,
    now,
  });
  if (!validation.valid || !validation.canonical || validation.canonical.invoice !== invoice) {
    throw new Error(`contract intent invoice validation failed: ${validation.reasons.join("; ")}`);
  }
  const schedule = deriveSettlementSchedule({
    direction: context.direction,
    nowSeconds: now,
    bitcoinHeight: integer(source.bitcoinHeight, "contract intent Bitcoin height", 1),
    invoice: invoiceForSchedule(validation.canonical),
    policy: settlementPolicy,
  });
  const contractQuoteExpiresAt = Math.min(
    schedule.quoteExpiresAt,
    integer(context.offerExpiresAt, "contract intent offer expiry", now + 1),
    integer(context.userAuthorizationExpiresAt, "contract intent user authorization expiry", now + 1),
  );
  if (contractQuoteExpiresAt - now < MINIMUM_SUBMISSION_WINDOW_SECONDS) {
    throw new RangeError("contract intent has less than the required wallet submission window");
  }
  const material = signingMaterial(context, schedule, contractQuoteExpiresAt);
  const digest = TypedDataEncoder.hash(material.domain, material.types, material.message);
  const prepared = Object.freeze({
    schema: "treeswap.prepared-contract-intent.v1",
    settlementId: context.settlementId,
    direction: context.direction,
    userAuthorizationDigest: context.userAuthorizationDigest,
    selectedOfferId: context.selectedOfferId,
    settlementContractCodeHash: context.settlementContractCodeHash,
    primaryType: material.primaryType,
    domain: material.domain,
    types: material.types,
    message: material.message,
    digest,
    schedule,
    preparedAt: now,
    expiresAt: contractQuoteExpiresAt,
    requiresSolverSignature: true,
    requiresUserContractSignature: context.direction === "lightning-to-bit",
    movesFundsImmediately: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
  });
  PREPARED_INTENTS.set(prepared, Object.freeze({
    context,
    finalization: source.finalization,
    invoice,
  }));
  return prepared;
}

export function authorizeFinalizedContractIntent(input) {
  const source = exactRecord(input, [
    "now",
    "prepared",
    "solverSignature",
    "userSignature",
  ], "contract intent signature binding");
  const preparedContext = PREPARED_INTENTS.get(source.prepared);
  if (!preparedContext) throw new TypeError("contract intent requires the original prepared RFQ artifact");
  const now = integer(source.now, "contract intent authorization time", source.prepared.preparedAt);
  if (now >= source.prepared.expiresAt) throw new Error("contract intent expired before signature binding");
  const solverSignature = canonicalSignature(source.solverSignature, "solver contract intent signature");
  if (!sameAddress(
    verifyTypedData(source.prepared.domain, source.prepared.types, source.prepared.message, solverSignature),
    source.prepared.message.solver,
  )) throw new Error("solver contract intent signature belongs to another account");

  let userSignature = null;
  let data;
  if (source.prepared.direction === "lightning-to-bit") {
    userSignature = canonicalSignature(source.userSignature, "user contract intent signature");
    if (!sameAddress(
      verifyTypedData(source.prepared.domain, source.prepared.types, source.prepared.message, userSignature),
      source.prepared.message.user,
    )) throw new Error("user contract intent signature belongs to another account");
    data = BIT_VAULT.encodeFunctionData("reserve", [
      source.prepared.message,
      userSignature,
      solverSignature,
    ]);
  } else {
    if (source.userSignature !== null) {
      throw new TypeError("BIT-to-Lightning contract intent must not carry a user contract signature");
    }
    data = USER_ESCROW.encodeFunctionData("open", [source.prepared.message, solverSignature]);
  }

  const authorized = Object.freeze({
    schema: "treeswap.authorized-contract-intent.v1",
    settlementId: source.prepared.settlementId,
    direction: source.prepared.direction,
    userAuthorizationDigest: source.prepared.userAuthorizationDigest,
    selectedOfferId: source.prepared.selectedOfferId,
    quoteId: source.prepared.message.quoteId,
    contractIntentDigest: source.prepared.digest,
    settlementContractCodeHash: source.prepared.settlementContractCodeHash,
    schedule: source.prepared.schedule,
    solverSignature,
    userSignature,
    transaction: Object.freeze({
      chainId: source.prepared.domain.chainId.toString(),
      from: source.prepared.message.user,
      to: source.prepared.domain.verifyingContract,
      data,
      dataDigest: keccak256(data),
      value: "0x0",
    }),
    authorizedAt: now,
    expiresAt: source.prepared.expiresAt,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
  });
  const bindingInput = Object.freeze({
    authorizedAt: now,
    direction: source.prepared.direction,
    domain: source.prepared.domain,
    expiresAt: source.prepared.expiresAt,
    message: source.prepared.message,
    primaryType: source.prepared.primaryType,
    selectedOfferId: source.prepared.selectedOfferId,
    settlementContractCodeHash: source.prepared.settlementContractCodeHash,
    settlementId: source.prepared.settlementId,
    solverSignature,
    transaction: authorized.transaction,
    userAuthorizationDigest: source.prepared.userAuthorizationDigest,
    userSignature,
  });
  const binding = validateContractIntentBinding(bindingInput);
  if (binding.contractIntentDigest !== authorized.contractIntentDigest
      || binding.calldataDigest !== authorized.transaction.dataDigest) {
    throw new Error("authorized contract intent failed independent canonical validation");
  }
  AUTHORIZED_INTENTS.set(authorized, Object.freeze({
    binding,
    bindingInput,
    prepared: source.prepared,
    ...preparedContext,
  }));
  return authorized;
}

export function verifiedPreparedContractIntent(value, input) {
  const context = PREPARED_INTENTS.get(value);
  if (!context) throw new TypeError("contract intent lacks original prepared RFQ provenance");
  const source = exactRecord(input, ["now"], "prepared contract intent verification");
  const observedAt = integer(source.now, "contract intent verification time", value.preparedAt);
  if (observedAt >= value.expiresAt) throw new Error("prepared contract intent is expired");
  verifiedFinalizedContractIntentContext(context.finalization, { now: observedAt });
  const payload = validateContractIntentSigningPayload({
    direction: value.direction,
    domain: value.domain,
    message: value.message,
    primaryType: value.primaryType,
  });
  if (payload.contractIntentDigest !== value.digest) {
    throw new Error("prepared contract intent digest is inconsistent");
  }
  return value;
}

export function verifiedAuthorizedContractIntent(value, { now } = {}) {
  const context = AUTHORIZED_INTENTS.get(value);
  if (!context) throw new TypeError("contract intent lacks verified RFQ and signature provenance");
  const observedAt = integer(now, "contract intent verification time", value.authorizedAt);
  if (observedAt >= value.expiresAt) throw new Error("authorized contract intent is expired");
  verifiedFinalizedContractIntentContext(context.finalization, { now: observedAt });
  return value;
}

export function persistAuthorizedContractIntent(value, { now } = {}) {
  const verified = verifiedAuthorizedContractIntent(value, { now });
  const context = AUTHORIZED_INTENTS.get(verified);
  const observedAt = integer(now, "contract intent persistence time", verified.authorizedAt);
  const settlement = persistFinalizedContractIntentBinding(
    context.finalization,
    context.bindingInput,
    { now: observedAt },
  );
  if (settlement.contractIntentDigest !== verified.contractIntentDigest
      || settlement.contractCalldataDigest !== verified.transaction.dataDigest
      || settlement.contractQuoteId !== verified.quoteId) {
    throw new Error("durable contract intent does not match the authorized artifact");
  }
  return settlement;
}
