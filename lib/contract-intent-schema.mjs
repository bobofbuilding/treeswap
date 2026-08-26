import {
  Interface,
  Signature,
  TypedDataEncoder,
  getAddress,
  keccak256,
  verifyTypedData,
} from "ethers";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT96_MAX = (1n << 96n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function typedFields(fields) {
  return Object.freeze(fields.map((field) => Object.freeze(field)));
}

export const TREE_SWAP_SELECTED_QUOTE_TYPES = Object.freeze({
  SelectedQuote: typedFields([
    { name: "quoteId", type: "bytes32" },
    { name: "user", type: "address" },
    { name: "solver", type: "address" },
    { name: "beneficiary", type: "address" },
    { name: "amount", type: "uint96" },
    { name: "fee", type: "uint96" },
    { name: "lightningAmountSats", type: "uint64" },
    { name: "paymentHash", type: "bytes32" },
    { name: "invoiceDigest", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "quoteExpiresAt", type: "uint64" },
    { name: "lastSafeClaimAt", type: "uint64" },
    { name: "refundAfter", type: "uint64" },
  ]),
});

export const TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES = Object.freeze({
  BitToLightningQuote: typedFields([
    { name: "quoteId", type: "bytes32" },
    { name: "user", type: "address" },
    { name: "solver", type: "address" },
    { name: "solverBeneficiary", type: "address" },
    { name: "amount", type: "uint96" },
    { name: "fee", type: "uint96" },
    { name: "lightningAmountSats", type: "uint64" },
    { name: "paymentHash", type: "bytes32" },
    { name: "invoiceDigest", type: "bytes32" },
    { name: "solverNonce", type: "uint256" },
    { name: "quoteExpiresAt", type: "uint64" },
    { name: "lastSafeClaimAt", type: "uint64" },
    { name: "refundAfter", type: "uint64" },
  ]),
});

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
    return getAddress(value).toLowerCase();
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
    return signature.serialized.toLowerCase();
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

function calldata(value) {
  if (typeof value !== "string") {
    throw new TypeError("contract intent calldata must be bounded lowercase hex bytes");
  }
  const raw = value;
  if (!/^0x[0-9a-f]+$/.test(raw) || raw.length % 2 !== 0 || raw.length > 32_770) {
    throw new TypeError("contract intent calldata must be bounded lowercase hex bytes");
  }
  return raw;
}

function normalizedDomain(value, direction) {
  const source = exactRecord(value, ["chainId", "name", "verifyingContract", "version"], "contract intent domain");
  const expectedName = direction === "lightning-to-bit" ? "TreeSwap BIT Vault" : "TreeSwap User BIT Escrow";
  if (source.name !== expectedName || source.version !== "1") {
    throw new Error("contract intent EIP-712 domain is unsupported");
  }
  return Object.freeze({
    name: source.name,
    version: source.version,
    chainId: uint(source.chainId, "contract intent chainId", UINT256_MAX),
    verifyingContract: address(source.verifyingContract, "contract intent verifying contract"),
  });
}

function normalizedMessage(value, direction) {
  const lightningToBit = direction === "lightning-to-bit";
  const beneficiaryField = lightningToBit ? "beneficiary" : "solverBeneficiary";
  const nonceField = lightningToBit ? "nonce" : "solverNonce";
  const source = exactRecord(value, [
    "amount", beneficiaryField, "fee", "invoiceDigest", "lastSafeClaimAt", "lightningAmountSats",
    nonceField, "paymentHash", "quoteExpiresAt", "quoteId", "refundAfter", "solver", "user",
  ], "contract intent message");
  const amount = uint(source.amount, "contract intent BIT amount", UINT96_MAX);
  const fee = uint(source.fee, "contract intent BIT fee", UINT96_MAX);
  const lightningAmountSats = uint(
    source.lightningAmountSats,
    "contract intent Lightning amount",
    UINT64_MAX,
  );
  const quoteExpiresAt = integer(source.quoteExpiresAt, "contract intent quote expiry", 1);
  const lastSafeClaimAt = integer(source.lastSafeClaimAt, "contract intent last safe claim", 1);
  const refundAfter = integer(source.refundAfter, "contract intent refund time", 1);
  const user = address(source.user, "contract intent user");
  const solver = address(source.solver, "contract intent solver");
  const beneficiary = address(source[beneficiaryField], `contract intent ${beneficiaryField}`);
  if (amount === 0n || fee >= amount || lightningAmountSats === 0n) {
    throw new RangeError("contract intent amount or fee is invalid");
  }
  if (!(quoteExpiresAt < lastSafeClaimAt && lastSafeClaimAt < refundAfter)) {
    throw new RangeError("contract intent deadlines are not safely ordered");
  }
  if (!lightningToBit && beneficiary !== solver) {
    throw new Error("BIT-to-Lightning solver beneficiary must be the authenticated solver EOA");
  }
  return Object.freeze({
    quoteId: bytes32(source.quoteId, "contract intent quote ID"),
    user,
    solver,
    [beneficiaryField]: beneficiary,
    amount,
    fee,
    lightningAmountSats,
    paymentHash: bytes32(source.paymentHash, "contract intent payment hash"),
    invoiceDigest: bytes32(source.invoiceDigest, "contract intent invoice digest"),
    [nonceField]: uint(source[nonceField], `contract intent ${nonceField}`, UINT256_MAX),
    quoteExpiresAt,
    lastSafeClaimAt,
    refundAfter,
  });
}

export function validateContractIntentBinding(input) {
  const source = exactRecord(input, [
    "authorizedAt", "direction", "domain", "expiresAt", "message", "primaryType", "selectedOfferId",
    "settlementContractCodeHash", "settlementId", "solverSignature", "transaction", "userAuthorizationDigest",
    "userSignature",
  ], "contract intent binding");
  if (source.direction !== "lightning-to-bit" && source.direction !== "bit-to-lightning") {
    throw new RangeError("contract intent direction is unsupported");
  }
  const lightningToBit = source.direction === "lightning-to-bit";
  const expectedPrimaryType = lightningToBit ? "SelectedQuote" : "BitToLightningQuote";
  if (source.primaryType !== expectedPrimaryType) throw new Error("contract intent primary type is invalid");
  const domain = normalizedDomain(source.domain, source.direction);
  const message = normalizedMessage(source.message, source.direction);
  const types = lightningToBit ? TREE_SWAP_SELECTED_QUOTE_TYPES : TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES;
  const solverSignature = canonicalSignature(source.solverSignature, "solver contract intent signature");
  if (!sameAddress(verifyTypedData(domain, types, message, solverSignature), message.solver)) {
    throw new Error("solver contract intent signature belongs to another account");
  }
  let userSignature = null;
  let expectedData;
  if (lightningToBit) {
    userSignature = canonicalSignature(source.userSignature, "user contract intent signature");
    if (!sameAddress(verifyTypedData(domain, types, message, userSignature), message.user)) {
      throw new Error("user contract intent signature belongs to another account");
    }
    expectedData = BIT_VAULT.encodeFunctionData("reserve", [message, userSignature, solverSignature]).toLowerCase();
  } else {
    if (source.userSignature !== null) {
      throw new TypeError("BIT-to-Lightning contract intent must not carry a user contract signature");
    }
    expectedData = USER_ESCROW.encodeFunctionData("open", [message, solverSignature]).toLowerCase();
  }
  const transaction = exactRecord(
    source.transaction,
    ["chainId", "data", "dataDigest", "from", "to", "value"],
    "contract intent transaction",
  );
  const data = calldata(transaction.data);
  if (data !== expectedData) throw new Error("contract intent calldata does not encode the verified quote and signatures");
  const dataDigest = bytes32(transaction.dataDigest, "contract intent calldata digest");
  if (dataDigest !== keccak256(data)) throw new Error("contract intent calldata digest is invalid");
  const chainId = uint(transaction.chainId, "contract intent transaction chainId", UINT256_MAX);
  const fromAddress = address(transaction.from, "contract intent transaction sender");
  const toAddress = address(transaction.to, "contract intent transaction target");
  if (chainId !== domain.chainId || fromAddress !== message.user || toAddress !== domain.verifyingContract
      || transaction.value !== "0x0") {
    throw new Error("contract intent transaction changed its exact chain, sender, target, or value");
  }
  const authorizedAt = integer(source.authorizedAt, "contract intent authorization time", 1);
  const expiresAt = integer(source.expiresAt, "contract intent expiry", 1);
  if (expiresAt !== message.quoteExpiresAt || authorizedAt >= expiresAt) {
    throw new RangeError("contract intent authorization window is invalid");
  }
  const contractIntentDigest = TypedDataEncoder.hash(domain, types, message).toLowerCase();
  return Object.freeze({
    schema: "treeswap.contract-intent-binding.v1",
    settlementId: bytes32(source.settlementId, "contract intent settlement ID"),
    direction: source.direction,
    userAuthorizationDigest: bytes32(source.userAuthorizationDigest, "contract intent user authorization digest"),
    selectedOfferId: bytes32(source.selectedOfferId, "contract intent selected offer ID"),
    quoteId: message.quoteId,
    contractIntentDigest,
    settlementContractCodeHash: bytes32(
      source.settlementContractCodeHash,
      "contract intent settlement contract code hash",
    ),
    chainId: chainId.toString(),
    fromAddress,
    toAddress,
    calldata: data,
    calldataDigest: dataDigest,
    transactionValue: "0x0",
    userAddress: message.user,
    solverAddress: message.solver,
    beneficiaryAddress: message[lightningToBit ? "beneficiary" : "solverBeneficiary"],
    bitAmount: message.amount.toString(),
    feeBitAmount: message.fee.toString(),
    lightningAmountSats: message.lightningAmountSats.toString(),
    paymentHash: message.paymentHash,
    invoiceDigest: message.invoiceDigest,
    nonce: message[lightningToBit ? "nonce" : "solverNonce"].toString(),
    quoteExpiresAt: message.quoteExpiresAt,
    lastSafeClaimAt: message.lastSafeClaimAt,
    refundAfter: message.refundAfter,
    solverSignature,
    userSignature,
    authorizedAt,
    expiresAt,
  });
}
