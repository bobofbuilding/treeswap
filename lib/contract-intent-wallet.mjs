import {
  Interface,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { verifiedAuthorizedContractIntent } from "./rfq-contract-intent.mjs";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const DATA = /^0x(?:[0-9a-f]{2})*$/;
const QUANTITY = /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const BIT_VAULT = new Interface([
  "function reserve((bytes32 quoteId,address user,address solver,address beneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 nonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter) quote,bytes userSignature,bytes solverSignature)",
  "event Reserved(bytes32 indexed quoteId,bytes32 indexed paymentHash,address indexed solver,address user,address beneficiary,uint256 amount,uint256 fee,uint256 lightningAmountSats,bytes32 invoiceDigest,uint256 nonce,uint256 quoteExpiresAt,uint256 lastSafeClaimAt,uint256 refundAfter)",
]);
const USER_ESCROW = new Interface([
  "function open((bytes32 quoteId,address user,address solver,address solverBeneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 solverNonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter) quote,bytes solverSignature)",
  "event Opened(bytes32 indexed quoteId,bytes32 indexed paymentHash,address indexed user,address solver,address solverBeneficiary,uint256 amount,uint256 fee,uint256 lightningAmountSats,bytes32 invoiceDigest,uint256 solverNonce,uint256 quoteExpiresAt,uint256 lastSafeClaimAt,uint256 refundAfter)",
]);
const PREFLIGHTS = new WeakMap();
const CONTEXTS = new WeakMap();
const SUBMISSIONS = new WeakMap();
const TRANSACTIONS = new WeakMap();
const RECEIPT_OBSERVATIONS = new WeakMap();
const RECEIPT_QUORUMS = new WeakMap();

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

function exactDenseArray(value, maximum, name, minimum = 1) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${name} must be a bounded dense array`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set([...Array(value.length).keys()].map(String).concat("length"));
  if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError(`${name} must be an undecorated dense array`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  try {
    const result = getAddress(value).toLowerCase();
    if (result === "0x0000000000000000000000000000000000000000") throw new Error();
    return result;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  }
  return value;
}

function data(value, name) {
  if (typeof value !== "string" || !DATA.test(value) || value.length > 262_146) {
    throw new TypeError(`${name} must be bounded lowercase hex data`);
  }
  return value;
}

function quantity(value, name) {
  if (typeof value !== "string" || !QUANTITY.test(value)) {
    throw new TypeError(`${name} must be a canonical lowercase JSON-RPC quantity`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw new RangeError(`${name} exceeds uint256`);
  return parsed;
}

function safeNumber(value, name) {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} exceeds safe range`);
  }
  return Number(parsed);
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("canonical value contains unsupported data");
}

function digest(value) {
  return keccak256(toUtf8Bytes(canonicalize(value))).toLowerCase();
}

function quoteFromCalldata(direction, calldata) {
  const contract = direction === "lightning-to-bit" ? BIT_VAULT : USER_ESCROW;
  const method = direction === "lightning-to-bit" ? "reserve" : "open";
  const decoded = contract.decodeFunctionData(method, calldata);
  if (contract.encodeFunctionData(method, [...decoded]).toLowerCase() !== calldata) {
    throw new Error("contract intent calldata is not canonical");
  }
  const quote = decoded[0];
  const beneficiaryField = direction === "lightning-to-bit" ? "beneficiary" : "solverBeneficiary";
  const nonceField = direction === "lightning-to-bit" ? "nonce" : "solverNonce";
  return Object.freeze({
    quoteId: String(quote.quoteId).toLowerCase(),
    paymentHash: String(quote.paymentHash).toLowerCase(),
    user: address(quote.user, "wallet quote user"),
    solver: address(quote.solver, "wallet quote solver"),
    beneficiary: address(quote[beneficiaryField], `wallet quote ${beneficiaryField}`),
    amount: BigInt(quote.amount).toString(),
    fee: BigInt(quote.fee).toString(),
    lightningAmountSats: BigInt(quote.lightningAmountSats).toString(),
    invoiceDigest: String(quote.invoiceDigest).toLowerCase(),
    nonce: BigInt(quote[nonceField]).toString(),
    quoteExpiresAt: safeNumber(quote.quoteExpiresAt, "wallet quote expiry"),
    lastSafeClaimAt: safeNumber(quote.lastSafeClaimAt, "wallet quote last-safe-claim time"),
    refundAfter: safeNumber(quote.refundAfter, "wallet quote refund time"),
  });
}

function walletRequest(preflight) {
  return Object.freeze({
    method: "eth_sendTransaction",
    params: Object.freeze([Object.freeze({
      data: preflight.calldata,
      from: preflight.from,
      to: preflight.to,
      value: "0x0",
    })]),
  });
}

export function prepareContractIntentWalletPreflight(input) {
  const source = exactRecord(input, ["authorizedIntent", "now"], "contract intent wallet preflight");
  const observedAt = integer(source.now, "wallet preflight time", 1);
  const authorized = verifiedAuthorizedContractIntent(source.authorizedIntent, { now: observedAt });
  const chainId = BigInt(authorized.transaction.chainId);
  if (chainId <= 0n || chainId > MAX_UINT256) throw new Error("wallet preflight chain is invalid");
  const calldata = data(authorized.transaction.data.toLowerCase(), "wallet preflight calldata");
  if (keccak256(calldata).toLowerCase() !== authorized.transaction.dataDigest) {
    throw new Error("wallet preflight calldata digest changed");
  }
  if (authorized.transaction.value !== "0x0") throw new Error("wallet preflight must transfer zero ETH");
  const quote = quoteFromCalldata(authorized.direction, calldata);
  if (quote.quoteId !== authorized.quoteId || quote.user !== address(authorized.transaction.from, "wallet sender")) {
    throw new Error("wallet preflight quote or sender changed");
  }
  const core = Object.freeze({
    schema: "treeswap.contract-intent-wallet-preflight.v1",
    settlementId: authorized.settlementId,
    direction: authorized.direction,
    quoteId: authorized.quoteId,
    contractIntentDigest: authorized.contractIntentDigest,
    contractCodeHash: authorized.settlementContractCodeHash,
    chainId: chainId.toString(),
    from: address(authorized.transaction.from, "wallet sender"),
    to: address(authorized.transaction.to, "wallet target"),
    calldata,
    calldataDigest: authorized.transaction.dataDigest,
    value: "0x0",
    quote,
    preparedAt: observedAt,
    expiresAt: authorized.expiresAt,
  });
  const preflight = Object.freeze({
    ...core,
    request: walletRequest(core),
    requestDigest: digest(core),
    review: Object.freeze({
      title: authorized.direction === "lightning-to-bit" ? "Reserve solver BIT" : "Lock BIT for Lightning",
      effect: "Submits this exact zero-ETH escrow call. It is not a token approval and does not authorize Lightning by itself.",
      chainId: chainId.toString(),
      account: core.from,
      contract: core.to,
      quoteId: core.quoteId,
      contractIntentDigest: core.contractIntentDigest,
      calldataDigest: core.calldataDigest,
      expiresAt: core.expiresAt,
    }),
    requestsWalletConnection: false,
    requestsChainSwitch: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
  PREFLIGHTS.set(preflight, Object.freeze({ authorized }));
  return preflight;
}

function accounts(value, expected = null, minimum = 1) {
  const list = exactDenseArray(value, 32, "wallet accounts", minimum);
  const normalized = [];
  for (let index = 0; index < list.length; index += 1) {
    normalized.push(address(list[index], `wallet account ${index}`));
  }
  if (expected !== null && normalized[0] !== expected) {
    throw new Error("connect the exact contract-intent wallet");
  }
  Object.freeze(normalized);
  return normalized;
}

export function verifyContractIntentWalletContext(input) {
  const source = exactRecord(input, ["accounts", "chainId", "now", "preflight"], "wallet context");
  const provenance = PREFLIGHTS.get(source.preflight);
  if (!provenance) throw new TypeError("wallet context requires the original contract-intent preflight");
  const observedAt = integer(source.now, "wallet context time", source.preflight.preparedAt);
  if (observedAt >= source.preflight.expiresAt) throw new Error("contract-intent wallet request is expired");
  const chainId = quantity(source.chainId, "wallet chain ID");
  if (chainId.toString() !== source.preflight.chainId) throw new Error("wallet chain does not match the contract intent");
  const activeAccounts = accounts(source.accounts, source.preflight.from);
  const context = Object.freeze({
    schema: "treeswap.verified-contract-intent-wallet-context.v1",
    requestDigest: source.preflight.requestDigest,
    chainId: chainId.toString(),
    account: activeAccounts[0],
    verifiedAt: observedAt,
    expiresAt: source.preflight.expiresAt,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
  CONTEXTS.set(context, Object.freeze({ preflight: source.preflight, provenance }));
  return context;
}

export function recordContractIntentWalletOutcome(input) {
  const source = exactRecord(input, [
    "accounts",
    "chainId",
    "context",
    "now",
    "outcome",
  ], "wallet outcome recording");
  const context = CONTEXTS.get(source.context);
  if (!context) throw new TypeError("wallet outcome requires the original verified wallet context");
  const observedAt = integer(source.now, "wallet outcome time", source.context.verifiedAt);
  const outcome = exactRecord(source.outcome, [
    "errorCode",
    "status",
    "transactionHash",
  ], "wallet outcome");
  const postChainId = quantity(source.chainId, "wallet post-request chain ID");
  const postAccounts = accounts(source.accounts, null, 0);
  const contextChanged = postChainId.toString() !== context.preflight.chainId
    || postAccounts[0] !== source.context.account;
  let state;
  let transactionHash = null;
  if (outcome.status === "reported") {
    if (outcome.errorCode !== null) throw new TypeError("reported wallet outcome cannot carry an error");
    transactionHash = bytes32(outcome.transactionHash, "wallet transaction hash");
    state = contextChanged ? "SUBMISSION_REPORTED_CONTEXT_CHANGED" : "SUBMISSION_REPORTED";
  } else if (outcome.status === "rejected") {
    if (outcome.transactionHash !== null || outcome.errorCode !== 4001) {
      throw new TypeError("wallet rejection must be exact EIP-1193 code 4001");
    }
    state = contextChanged ? "USER_REJECTED_CONTEXT_CHANGED" : "USER_REJECTED";
  } else if (outcome.status === "ambiguous") {
    if (outcome.transactionHash !== null || outcome.errorCode !== null) {
      throw new TypeError("ambiguous wallet outcome cannot claim a hash or error code");
    }
    state = contextChanged ? "SUBMISSION_UNKNOWN_CONTEXT_CHANGED" : "SUBMISSION_UNKNOWN";
  } else {
    throw new RangeError("wallet outcome status is unsupported");
  }
  const submission = Object.freeze({
    schema: "treeswap.contract-intent-wallet-submission.v1",
    requestDigest: context.preflight.requestDigest,
    settlementId: context.preflight.settlementId,
    contractIntentDigest: context.preflight.contractIntentDigest,
    state,
    transactionHash,
    observedAt,
    contextChanged,
    expiredAtResponse: observedAt >= context.preflight.expiresAt,
    requiresIndependentReconciliation: outcome.status !== "rejected",
    retryAuthorized: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
  SUBMISSIONS.set(submission, Object.freeze({ context: source.context, preflight: context.preflight }));
  return submission;
}

function normalizeRpcTransaction(raw, name) {
  const source = exactRecord(raw, [
    "blockHash",
    "blockNumber",
    "chainId",
    "from",
    "hash",
    "input",
    "nonce",
    "to",
    "type",
    "value",
  ], name);
  const blockHash = source.blockHash === null ? null : bytes32(source.blockHash, `${name}.blockHash`);
  const blockNumber = source.blockNumber === null ? null : quantity(source.blockNumber, `${name}.blockNumber`);
  if ((blockHash === null) !== (blockNumber === null)) throw new Error(`${name} block binding is incomplete`);
  const type = quantity(source.type, `${name}.type`);
  if (type !== 2n) throw new Error(`${name} must be an EIP-1559 transaction`);
  return Object.freeze({
    hash: bytes32(source.hash, `${name}.hash`),
    from: address(source.from, `${name}.from`),
    to: address(source.to, `${name}.to`),
    input: data(source.input, `${name}.input`),
    value: quantity(source.value, `${name}.value`),
    chainId: quantity(source.chainId, `${name}.chainId`),
    nonce: quantity(source.nonce, `${name}.nonce`),
    type,
    blockHash,
    blockNumber,
  });
}

function matchingTransaction(preflight, transaction) {
  return transaction.from === preflight.from
    && transaction.to === preflight.to
    && transaction.input === preflight.calldata
    && transaction.value === 0n
    && transaction.chainId.toString() === preflight.chainId;
}

function transactionResult(preflight, transaction, replacementOf) {
  const result = Object.freeze({
    schema: "treeswap.verified-contract-intent-wallet-transaction.v1",
    requestDigest: preflight.requestDigest,
    contractIntentDigest: preflight.contractIntentDigest,
    transactionHash: transaction.hash,
    replacementOf,
    nonce: transaction.nonce.toString(),
    state: transaction.blockHash === null ? "PENDING" : "INCLUDED",
    inclusionBlockHash: transaction.blockHash,
    inclusionBlockNumber: transaction.blockNumber === null
      ? null
      : safeNumber(transaction.blockNumber, "wallet transaction inclusion block"),
    exactIntentCall: true,
    canonicalFinalizedReservation: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
  TRANSACTIONS.set(result, Object.freeze({ preflight, transaction }));
  return result;
}

export function verifyReportedContractIntentWalletTransaction(input) {
  const source = exactRecord(input, ["submission", "transaction"], "wallet transaction verification");
  const context = SUBMISSIONS.get(source.submission);
  if (!context || (source.submission.state !== "SUBMISSION_REPORTED"
      && source.submission.state !== "SUBMISSION_REPORTED_CONTEXT_CHANGED")) {
    throw new TypeError("wallet transaction requires an original reported submission");
  }
  const transaction = normalizeRpcTransaction(source.transaction, "wallet transaction");
  if (transaction.hash !== source.submission.transactionHash || !matchingTransaction(context.preflight, transaction)) {
    throw new Error("wallet transaction changed the exact contract intent");
  }
  return transactionResult(context.preflight, transaction, null);
}

export function verifyReplacementContractIntentWalletTransaction(input) {
  const source = exactRecord(input, ["previous", "transaction"], "wallet replacement verification");
  const context = TRANSACTIONS.get(source.previous);
  if (!context) throw new TypeError("wallet replacement requires the original verified transaction");
  const transaction = normalizeRpcTransaction(source.transaction, "wallet replacement transaction");
  if (transaction.hash === source.previous.transactionHash
      || transaction.nonce.toString() !== source.previous.nonce
      || !matchingTransaction(context.preflight, transaction)) {
    throw new Error("wallet replacement changed the nonce or exact contract intent");
  }
  return transactionResult(context.preflight, transaction, source.previous.transactionHash);
}

function normalizeBlock(raw, name) {
  const source = exactRecord(raw, ["hash", "number"], name);
  const number = quantity(source.number, `${name}.number`);
  return Object.freeze({ hash: bytes32(source.hash, `${name}.hash`), number: safeNumber(number, name) });
}

function normalizeLog(raw, index) {
  const source = exactRecord(raw, [
    "address",
    "blockHash",
    "data",
    "logIndex",
    "removed",
    "topics",
    "transactionHash",
  ], `wallet receipt log ${index}`);
  const topics = exactDenseArray(source.topics, 4, `wallet receipt log ${index} topics`)
    .map((topic, topicIndex) => bytes32(topic, `wallet receipt log ${index} topic ${topicIndex}`));
  if (typeof source.removed !== "boolean") throw new TypeError("wallet receipt log removed must be boolean");
  return Object.freeze({
    address: address(source.address, `wallet receipt log ${index} address`),
    blockHash: bytes32(source.blockHash, `wallet receipt log ${index} blockHash`),
    transactionHash: bytes32(source.transactionHash, `wallet receipt log ${index} transactionHash`),
    logIndex: quantity(source.logIndex, `wallet receipt log ${index} index`),
    removed: source.removed,
    topics: Object.freeze(topics),
    data: data(source.data, `wallet receipt log ${index} data`),
  });
}

function matchesExpectedEvent(preflight, log) {
  if (log.address !== preflight.to || log.removed) return false;
  const contract = preflight.direction === "lightning-to-bit" ? BIT_VAULT : USER_ESCROW;
  const eventName = preflight.direction === "lightning-to-bit" ? "Reserved" : "Opened";
  try {
    const decoded = contract.decodeEventLog(eventName, log.data, log.topics);
    const quote = preflight.quote;
    const beneficiary = preflight.direction === "lightning-to-bit" ? decoded.beneficiary : decoded.solverBeneficiary;
    const nonce = preflight.direction === "lightning-to-bit" ? decoded.nonce : decoded.solverNonce;
    return String(decoded.quoteId).toLowerCase() === quote.quoteId
      && String(decoded.paymentHash).toLowerCase() === quote.paymentHash
      && address(decoded.user, "wallet event user") === quote.user
      && address(decoded.solver, "wallet event solver") === quote.solver
      && address(beneficiary, "wallet event beneficiary") === quote.beneficiary
      && BigInt(decoded.amount).toString() === quote.amount
      && BigInt(decoded.fee).toString() === quote.fee
      && BigInt(decoded.lightningAmountSats).toString() === quote.lightningAmountSats
      && String(decoded.invoiceDigest).toLowerCase() === quote.invoiceDigest
      && BigInt(nonce).toString() === quote.nonce
      && Number(decoded.quoteExpiresAt) === quote.quoteExpiresAt
      && Number(decoded.lastSafeClaimAt) === quote.lastSafeClaimAt
      && Number(decoded.refundAfter) === quote.refundAfter;
  } catch {
    return false;
  }
}

export function observeContractIntentWalletReceipt(input) {
  const source = exactRecord(input, [
    "canonicalBlock",
    "contractCodeHash",
    "finalizedBlock",
    "observedAt",
    "providerIdentity",
    "receipt",
    "transaction",
  ], "wallet receipt observation");
  const context = TRANSACTIONS.get(source.transaction);
  if (!context) throw new TypeError("wallet receipt requires the original verified transaction");
  const providerIdentity = bytes32(source.providerIdentity, "wallet receipt provider identity");
  const observedAt = integer(source.observedAt, "wallet receipt observation time", 1);
  const contractCodeHash = bytes32(source.contractCodeHash, "wallet receipt contract code hash");
  if (contractCodeHash !== context.preflight.contractCodeHash) {
    throw new Error("wallet receipt observed unreviewed contract code");
  }
  let state;
  let blockHash = null;
  let blockNumber = null;
  let receiptDigest = null;
  let finalizedBlockHash = null;
  let finalizedBlockNumber = null;
  if (source.receipt === null) {
    if (source.canonicalBlock !== null || source.finalizedBlock !== null) {
      throw new TypeError("missing wallet receipt cannot carry block observations");
    }
    state = source.transaction.inclusionBlockHash === null ? "NOT_FOUND" : "REORGED";
  } else {
    const receipt = exactRecord(source.receipt, [
      "blockHash",
      "blockNumber",
      "from",
      "logs",
      "status",
      "to",
      "transactionHash",
    ], "wallet receipt");
    const canonicalBlock = normalizeBlock(source.canonicalBlock, "wallet canonical inclusion block");
    const finalizedBlock = normalizeBlock(source.finalizedBlock, "wallet finalized block");
    finalizedBlockHash = finalizedBlock.hash;
    finalizedBlockNumber = finalizedBlock.number;
    blockHash = bytes32(receipt.blockHash, "wallet receipt block hash");
    const parsedBlockNumber = quantity(receipt.blockNumber, "wallet receipt block number");
    if (parsedBlockNumber > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("wallet receipt block exceeds safe range");
    blockNumber = Number(parsedBlockNumber);
    const status = quantity(receipt.status, "wallet receipt status");
    if (status !== 0n && status !== 1n) throw new Error("wallet receipt status is unsupported");
    const logs = exactDenseArray(receipt.logs, 64, "wallet receipt logs", 0).map(normalizeLog);
    if (bytes32(receipt.transactionHash, "wallet receipt transaction hash") !== source.transaction.transactionHash
        || address(receipt.from, "wallet receipt sender") !== context.preflight.from
        || address(receipt.to, "wallet receipt target") !== context.preflight.to) {
      throw new Error("wallet receipt changed the exact transaction identity");
    }
    if (canonicalBlock.hash !== blockHash || canonicalBlock.number !== blockNumber) state = "REORGED";
    else if (status === 0n) state = "REVERTED";
    else if (!logs.some((log) => log.blockHash === blockHash
      && log.transactionHash === source.transaction.transactionHash
      && matchesExpectedEvent(context.preflight, log))) state = "MISMATCH";
    else state = finalizedBlock.number >= blockNumber ? "FINALIZED" : "INCLUDED";
    receiptDigest = digest({
      transactionHash: source.transaction.transactionHash,
      blockHash,
      blockNumber,
      status: status.toString(),
      logs: logs.map((log) => ({
        address: log.address,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex.toString(),
        removed: log.removed,
        topics: log.topics,
        data: log.data,
      })),
    });
  }
  const consensus = Object.freeze({
    schema: "treeswap.contract-intent-wallet-receipt-consensus.v1",
    requestDigest: context.preflight.requestDigest,
    contractIntentDigest: context.preflight.contractIntentDigest,
    transactionHash: source.transaction.transactionHash,
    state,
    blockHash,
    blockNumber,
    receiptDigest,
    contractCodeHash,
    finalizedBlockHash,
    finalizedBlockNumber,
  });
  const observation = Object.freeze({
    ...consensus,
    providerIdentity,
    observedAt,
    consensusDigest: digest(consensus),
    canonicalFinalizedReservation: false,
    independentProviderOperationVerified: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
  RECEIPT_OBSERVATIONS.set(observation, Object.freeze({ preflight: context.preflight, transaction: source.transaction }));
  return observation;
}

export function verifyContractIntentWalletReceiptQuorum(input) {
  const source = exactRecord(input, ["observations"], "wallet receipt quorum");
  const observations = exactDenseArray(source.observations, 2, "wallet receipt quorum observations");
  if (observations.length !== 2) throw new Error("wallet receipt quorum requires exactly two providers");
  const contexts = observations.map((observation) => RECEIPT_OBSERVATIONS.get(observation));
  if (contexts.some((context) => !context) || contexts[0].preflight !== contexts[1].preflight
      || observations[0].providerIdentity === observations[1].providerIdentity) {
    throw new TypeError("wallet receipt quorum lacks original distinct-provider provenance");
  }
  if (observations.some(({ state }) => state !== "FINALIZED")
      || observations[0].consensusDigest !== observations[1].consensusDigest) {
    throw new Error("wallet receipt providers do not agree on one finalized reservation");
  }
  const quorum = Object.freeze({
    schema: "treeswap.verified-contract-intent-wallet-receipt-quorum.v1",
    requestDigest: observations[0].requestDigest,
    contractIntentDigest: observations[0].contractIntentDigest,
    transactionHash: observations[0].transactionHash,
    blockHash: observations[0].blockHash,
    blockNumber: observations[0].blockNumber,
    consensusDigest: observations[0].consensusDigest,
    providerIdentities: Object.freeze(observations.map(({ providerIdentity }) => providerIdentity).sort()),
    state: "REPOSITORY_CORE_VERIFIED",
    canonicalFinalizedReservation: false,
    independentProviderOperationVerified: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
  RECEIPT_QUORUMS.set(quorum, Object.freeze({ preflight: contexts[0].preflight }));
  return quorum;
}

export function contractIntentWalletJournalArtifact(value) {
  if (PREFLIGHTS.has(value)) {
    return Object.freeze({
      kind: "PREFLIGHT",
      requestDigest: value.requestDigest,
      settlementId: value.settlementId,
      direction: value.direction,
      contractIntentDigest: value.contractIntentDigest,
      contractCodeHash: value.contractCodeHash,
      chainId: value.chainId,
      from: value.from,
      to: value.to,
      calldata: value.calldata,
      calldataDigest: value.calldataDigest,
      value: value.value,
      quote: Object.freeze({ ...value.quote }),
      preparedAt: value.preparedAt,
      expiresAt: value.expiresAt,
    });
  }
  if (SUBMISSIONS.has(value)) {
    return Object.freeze({
      kind: "SUBMISSION",
      requestDigest: value.requestDigest,
      settlementId: value.settlementId,
      contractIntentDigest: value.contractIntentDigest,
      state: value.state,
      transactionHash: value.transactionHash,
      observedAt: value.observedAt,
      contextChanged: value.contextChanged,
      expiredAtResponse: value.expiredAtResponse,
      requiresIndependentReconciliation: value.requiresIndependentReconciliation,
      retryAuthorized: value.retryAuthorized,
    });
  }
  if (TRANSACTIONS.has(value)) {
    return Object.freeze({
      kind: "TRANSACTION",
      requestDigest: value.requestDigest,
      contractIntentDigest: value.contractIntentDigest,
      transactionHash: value.transactionHash,
      replacementOf: value.replacementOf,
      nonce: value.nonce,
      state: value.state,
      inclusionBlockHash: value.inclusionBlockHash,
      inclusionBlockNumber: value.inclusionBlockNumber,
      exactIntentCall: value.exactIntentCall,
    });
  }
  if (RECEIPT_OBSERVATIONS.has(value)) {
    return Object.freeze({
      kind: "OBSERVATION",
      requestDigest: value.requestDigest,
      contractIntentDigest: value.contractIntentDigest,
      transactionHash: value.transactionHash,
      state: value.state,
      blockHash: value.blockHash,
      blockNumber: value.blockNumber,
      receiptDigest: value.receiptDigest,
      contractCodeHash: value.contractCodeHash,
      finalizedBlockHash: value.finalizedBlockHash,
      finalizedBlockNumber: value.finalizedBlockNumber,
      providerIdentity: value.providerIdentity,
      observedAt: value.observedAt,
      consensusDigest: value.consensusDigest,
    });
  }
  if (RECEIPT_QUORUMS.has(value)) {
    return Object.freeze({
      kind: "QUORUM",
      requestDigest: value.requestDigest,
      contractIntentDigest: value.contractIntentDigest,
      transactionHash: value.transactionHash,
      blockHash: value.blockHash,
      blockNumber: value.blockNumber,
      consensusDigest: value.consensusDigest,
      providerIdentities: value.providerIdentities,
      state: value.state,
      canonicalFinalizedReservation: value.canonicalFinalizedReservation,
      independentProviderOperationVerified: value.independentProviderOperationVerified,
    });
  }
  throw new TypeError("wallet journal artifact requires original contract-intent wallet provenance");
}
