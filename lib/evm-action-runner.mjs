import {
  Interface,
  Transaction,
  getAddress,
  id,
  keccak256,
  sha256,
} from "ethers";
import { coordinatorCommitmentDigest } from "./coordinator-store.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const DATA = /^0x(?:[0-9a-f]{2})*$/;
const QUANTITY = /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/;
const CLAIM_INTERFACE = new Interface([
  "function claim(bytes32 quoteId, bytes32 preimage)",
]);
const CLAIMED_TOPIC = id("Claimed(bytes32,address,uint256,uint256)").toLowerCase();
const MAX_GAS_LIMIT = 5_000_000n;
const MAX_RESPONSE_BYTES = 128 * 1024;

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function address(value, name) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function uint(value, name, { nonzero = false, maximum = (1n << 256n) - 1n } = {}) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${name} must be an unsigned integer`);
  }
  if (parsed < 0n || parsed > maximum || (nonzero && parsed === 0n)) {
    throw new RangeError(`${name} is outside its permitted range`);
  }
  return parsed;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function quantity(value, name) {
  const raw = String(value ?? "");
  if (!QUANTITY.test(raw)) throw new TypeError(`${name} must be a canonical JSON-RPC quantity`);
  return BigInt(raw);
}

function normalizeClaimOperation(operation) {
  exactKeys(operation, [
    "chainId", "contract", "contractCodeHash", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "nonce",
    "preimage", "quoteId", "value",
  ], "EVM claim operation");
  const normalized = Object.freeze({
    chainId: uint(operation.chainId, "operation.chainId", { nonzero: true }),
    contract: address(operation.contract, "operation.contract"),
    contractCodeHash: bytes32(operation.contractCodeHash, "operation.contractCodeHash"),
    nonce: uint(operation.nonce, "operation.nonce", { maximum: BigInt(Number.MAX_SAFE_INTEGER) }),
    gasLimit: uint(operation.gasLimit, "operation.gasLimit", { nonzero: true, maximum: MAX_GAS_LIMIT }),
    maxFeePerGas: uint(operation.maxFeePerGas, "operation.maxFeePerGas", { nonzero: true }),
    maxPriorityFeePerGas: uint(operation.maxPriorityFeePerGas, "operation.maxPriorityFeePerGas"),
    value: uint(operation.value, "operation.value"),
    quoteId: bytes32(operation.quoteId, "operation.quoteId"),
    preimage: bytes32(operation.preimage, "operation.preimage"),
  });
  if (normalized.value !== 0n) throw new RangeError("EVM claim transaction must not transfer native value");
  if (normalized.maxPriorityFeePerGas > normalized.maxFeePerGas) {
    throw new RangeError("EVM priority fee exceeds the maximum fee");
  }
  return normalized;
}

function claimCalldata(operation) {
  return CLAIM_INTERFACE.encodeFunctionData("claim", [operation.quoteId, operation.preimage]).toLowerCase();
}

function actionTerms(action) {
  if (!action || action.method !== "evm:claim") throw new RangeError("action is not an EVM claim");
  return {
    method: "evm:claim",
    requestId: bytes32(action.requestId, "action.requestId"),
    intentDigest: bytes32(action.intentDigest, "action.intentDigest"),
    paymentHash: bytes32(action.paymentHash, "action.paymentHash"),
    invoiceDigest: bytes32(action.invoiceDigest, "action.invoiceDigest"),
    amountSats: String(action.amountSats),
    capacityEpoch: timestamp(action.capacityEpoch, "action.capacityEpoch"),
  };
}

export function evmClaimActionCommitment(action, operation, signerAddress) {
  const normalized = normalizeClaimOperation(operation);
  if (sha256(normalized.preimage).toLowerCase() !== bytes32(action.paymentHash, "action.paymentHash")) {
    throw new Error("EVM claim preimage does not match the persisted payment hash");
  }
  const data = claimCalldata(normalized);
  return coordinatorCommitmentDigest({
    ...actionTerms(action),
    transaction: {
      type: 2,
      chainId: normalized.chainId.toString(),
      from: address(signerAddress, "signerAddress"),
      to: normalized.contract,
      contractCodeHash: normalized.contractCodeHash,
      nonce: normalized.nonce.toString(),
      gasLimit: normalized.gasLimit.toString(),
      maxFeePerGas: normalized.maxFeePerGas.toString(),
      maxPriorityFeePerGas: normalized.maxPriorityFeePerGas.toString(),
      value: "0",
      calldataDigest: keccak256(data).toLowerCase(),
    },
  });
}

function transactionRequest(operation) {
  return {
    type: 2,
    chainId: operation.chainId,
    to: operation.contract,
    nonce: Number(operation.nonce),
    gasLimit: operation.gasLimit,
    maxFeePerGas: operation.maxFeePerGas,
    maxPriorityFeePerGas: operation.maxPriorityFeePerGas,
    value: 0n,
    data: claimCalldata(operation),
  };
}

async function signAndValidate({
  action,
  operation,
  signer,
  expectedChainId,
  expectedContract,
  expectedContractCodeHash,
  maximumGasCostWei,
}) {
  const normalized = normalizeClaimOperation(operation);
  const chainId = uint(expectedChainId, "expectedChainId", { nonzero: true });
  const contract = address(expectedContract, "expectedContract");
  const contractCodeHash = bytes32(expectedContractCodeHash, "expectedContractCodeHash");
  const gasCostCap = uint(maximumGasCostWei, "maximumGasCostWei", { nonzero: true });
  if (normalized.chainId !== chainId) throw new Error("EVM claim chain changed");
  if (normalized.contract !== contract) throw new Error("EVM claim contract changed");
  if (normalized.contractCodeHash !== contractCodeHash) throw new Error("EVM claim contract code commitment changed");
  if (normalized.gasLimit * normalized.maxFeePerGas > gasCostCap) throw new Error("EVM claim gas cost exceeds policy");
  const signerAddress = address(await signer.getAddress(), "signer address");
  if (evmClaimActionCommitment(action, normalized, signerAddress) !== action.payloadDigest) {
    throw new Error("transient EVM claim does not match the durable commitment");
  }
  const signedTransaction = String(await signer.signTransaction(transactionRequest(normalized))).toLowerCase();
  if (!DATA.test(signedTransaction)) throw new Error("signer returned malformed transaction bytes");
  const parsed = Transaction.from(signedTransaction);
  if (
    parsed.type !== 2 || parsed.chainId !== normalized.chainId || parsed.to?.toLowerCase() !== normalized.contract
      || BigInt(parsed.nonce) !== normalized.nonce || parsed.gasLimit !== normalized.gasLimit
      || parsed.maxFeePerGas !== normalized.maxFeePerGas || parsed.maxPriorityFeePerGas !== normalized.maxPriorityFeePerGas
      || parsed.value !== 0n || parsed.data.toLowerCase() !== claimCalldata(normalized)
      || parsed.from?.toLowerCase() !== signerAddress
  ) throw new Error("signed EVM transaction changed committed terms");
  return Object.freeze({
    normalized,
    signerAddress,
    signedTransaction,
    transactionHash: bytes32(parsed.hash?.toLowerCase(), "signed transaction hash"),
    signedTransactionDigest: coordinatorCommitmentDigest({ signedTransaction }),
  });
}

export async function prepareEvmClaimAction({
  store,
  action,
  operation,
  signer,
  expectedChainId,
  expectedContract,
  expectedContractCodeHash,
  maximumGasCostWei,
  boundAt,
  beforeStateChange = null,
}) {
  const settlement = store.getSettlement(action.settlementId);
  if (!settlement) throw new Error("settlement does not exist");
  const normalized = normalizeClaimOperation(operation);
  if (settlement.reservationId !== normalized.quoteId) throw new Error("EVM claim quote does not match the observed reservation");
  const signed = await signAndValidate({
    action,
    operation: normalized,
    signer,
    expectedChainId,
    expectedContract,
    expectedContractCodeHash,
    maximumGasCostWei,
  });
  if (beforeStateChange !== null) {
    if (typeof beforeStateChange !== "function") throw new TypeError("beforeStateChange must be a function");
    await beforeStateChange("evm-action-plan");
  }
  store.planAction(action);
  if (beforeStateChange !== null) await beforeStateChange("evm-transaction-bind");
  const transaction = store.bindEvmTransaction({
    actionId: action.actionId,
    chainId: signed.normalized.chainId.toString(),
    fromAddress: signed.signerAddress,
    toAddress: signed.normalized.contract,
    nonce: signed.normalized.nonce.toString(),
    transactionHash: signed.transactionHash,
    signedTransactionDigest: signed.signedTransactionDigest,
    boundAt: timestamp(boundAt, "boundAt"),
  });
  return Object.freeze({ action: store.getAction(action.actionId), transaction });
}

function validatedRpcUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("EVM RPC URL is invalid");
  }
  if (url.username || url.password || url.hash) throw new TypeError("EVM RPC URL must not contain credentials or a fragment");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new TypeError("EVM RPC URL must use HTTPS except on loopback");
  }
  return url.toString();
}

async function defaultRpcRequest({ url, method, params, signal }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("EVM RPC response exceeds its size limit");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("EVM RPC returned malformed JSON");
  }
  if (!response.ok || body?.jsonrpc !== "2.0" || body?.id !== 1 || body.error || !("result" in body)) {
    throw new Error("EVM RPC did not return a valid result");
  }
  return body.result;
}

async function callRpc({ rpcUrl, rpcRequestImpl, method, params, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timestamp(timeoutMs, "timeoutMs"));
  try {
    return await rpcRequestImpl({ url: validatedRpcUrl(rpcUrl), method, params, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function dispatchEvmClaimAction({
  store,
  actionId,
  operation,
  signer,
  expectedChainId,
  expectedContract,
  expectedContractCodeHash,
  maximumGasCostWei,
  rpcUrl,
  rpcRequestImpl = defaultRpcRequest,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  requestTimeoutMs = 30_000,
  beforeSideEffect = null,
}) {
  const action = store.getAction(bytes32(actionId, "actionId"));
  const transaction = store.getEvmTransaction(actionId);
  if (!action || !transaction) throw new Error("bound EVM action does not exist");
  if (action.state !== "PENDING" && action.state !== "UNKNOWN") throw new Error("EVM action is not broadcastable");
  const signed = await signAndValidate({
    action,
    operation,
    signer,
    expectedChainId,
    expectedContract,
    expectedContractCodeHash,
    maximumGasCostWei,
  });
  if (
    signed.transactionHash !== transaction.transactionHash
      || signed.signedTransactionDigest !== transaction.signedTransactionDigest
      || signed.signerAddress !== transaction.fromAddress
  ) throw new Error("reconstructed signed transaction does not match the durable EVM outbox");
  const rpcChainId = quantity(await callRpc({
    rpcUrl,
    rpcRequestImpl,
    method: "eth_chainId",
    params: [],
    timeoutMs: requestTimeoutMs,
  }), "RPC chain ID");
  const liveCode = String(await callRpc({
    rpcUrl,
    rpcRequestImpl,
    method: "eth_getCode",
    params: [signed.normalized.contract, "latest"],
    timeoutMs: requestTimeoutMs,
  })).toLowerCase();
  if (rpcChainId !== signed.normalized.chainId) throw new Error("EVM RPC chain changed before broadcast");
  if (!DATA.test(liveCode) || liveCode === "0x" || keccak256(liveCode).toLowerCase() !== signed.normalized.contractCodeHash) {
    throw new Error("EVM claim contract code changed before broadcast");
  }
  const broadcastAt = timestamp(nowSeconds(), "broadcastAt");
  if (beforeSideEffect !== null) {
    if (typeof beforeSideEffect !== "function") throw new TypeError("beforeSideEffect must be a function");
    await beforeSideEffect("evm-broadcast-claim");
  }
  store.claimEvmBroadcast(action.actionId, broadcastAt);
  if (beforeSideEffect !== null) await beforeSideEffect("evm-broadcast-send");
  let result;
  let resultCode = "BROADCAST_UNPROVEN";
  try {
    result = await callRpc({
      rpcUrl,
      rpcRequestImpl,
      method: "eth_sendRawTransaction",
      params: [signed.signedTransaction],
      timeoutMs: requestTimeoutMs,
    });
    if (String(result).toLowerCase() === transaction.transactionHash) resultCode = "BROADCAST_ACCEPTED";
  } catch {
    resultCode = "BROADCAST_TRANSPORT";
  }
  const observedAt = timestamp(nowSeconds(), "observedAt");
  const resultDigest = coordinatorCommitmentDigest({
    actionId: action.actionId,
    transactionHash: transaction.transactionHash,
    resultCode,
    observedAt,
  });
  store.recordActionResult({
    actionId: action.actionId,
    outcome: "ambiguous",
    resultDigest,
    resultCode,
    recordedAt: observedAt,
  });
  return Object.freeze({
    action: store.getAction(action.actionId),
    transaction: store.getEvmTransaction(action.actionId),
    broadcastAccepted: resultCode === "BROADCAST_ACCEPTED",
  });
}

function rpcTransactionOperation(transaction, contractCodeHash) {
  if (!transaction || typeof transaction !== "object" || transaction.type !== "0x2") {
    throw new Error("EVM transaction is not an EIP-1559 transaction");
  }
  if (!DATA.test(String(transaction.input ?? ""))) throw new Error("EVM transaction input is malformed");
  const decoded = CLAIM_INTERFACE.decodeFunctionData("claim", transaction.input);
  const operation = Object.freeze({
    chainId: quantity(transaction.chainId, "transaction.chainId"),
    contract: address(transaction.to, "transaction.to"),
    contractCodeHash: bytes32(contractCodeHash, "contractCodeHash"),
    nonce: quantity(transaction.nonce, "transaction.nonce"),
    gasLimit: quantity(transaction.gas, "transaction.gas"),
    maxFeePerGas: quantity(transaction.maxFeePerGas, "transaction.maxFeePerGas"),
    maxPriorityFeePerGas: quantity(transaction.maxPriorityFeePerGas, "transaction.maxPriorityFeePerGas"),
    value: quantity(transaction.value, "transaction.value"),
    quoteId: bytes32(String(decoded.quoteId).toLowerCase(), "transaction quoteId"),
    preimage: bytes32(String(decoded.preimage).toLowerCase(), "transaction preimage"),
  });
  if (String(transaction.input).toLowerCase() !== claimCalldata(operation)) {
    throw new Error("EVM transaction calldata is not the exact canonical claim");
  }
  return operation;
}

function matchingClaimedLog(receipt, contract, quoteId, transactionHash, blockHash) {
  if (!Array.isArray(receipt.logs)) throw new Error("EVM receipt logs are malformed");
  return receipt.logs.some((log) => {
    try {
      if (
        !log || address(log.address, "log.address") !== contract || !Array.isArray(log.topics)
          || log.topics.length !== 3 || !/^0x[0-9a-fA-F]{128}$/.test(String(log.data ?? ""))
          || bytes32(String(log.transactionHash).toLowerCase(), "log.transactionHash") !== transactionHash
          || bytes32(String(log.blockHash).toLowerCase(), "log.blockHash") !== blockHash
      ) return false;
      return String(log.topics[0] ?? "").toLowerCase() === CLAIMED_TOPIC
        && String(log.topics[1] ?? "").toLowerCase() === quoteId;
    } catch {
      return false;
    }
  });
}

function safeBlockNumber(value, name) {
  const parsed = quantity(value, name);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe integer range`);
  return Number(parsed);
}

function safeProviderLabel(value) {
  const label = String(value ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(label)) throw new TypeError("EVM provider label is invalid");
  return label;
}

function claimObservation({
  actionId,
  canonicalCodeHash = null,
  canonicalInclusion = false,
  finalized = false,
  inclusionBlockHash = null,
  inclusionBlockNumber = null,
  observedAt,
  observedState,
  providerLabel,
  receiptPresent,
  receiptStatus = null,
  transactionHash,
  transactionPresent,
}) {
  const consensus = Object.freeze({
    schema: "treeswap.evm-claim-observation.v1",
    actionId,
    transactionHash,
    observedState,
    transactionPresent,
    receiptPresent,
    canonicalInclusion,
    inclusionBlockNumber,
    inclusionBlockHash,
    receiptStatus,
    finalized,
    canonicalCodeHash,
  });
  return Object.freeze({
    ...consensus,
    providerLabel: safeProviderLabel(providerLabel),
    observedAt,
    consensusDigest: coordinatorCommitmentDigest(consensus),
  });
}

export class EvmProviderQuorumError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "EvmProviderQuorumError";
    this.code = code;
  }
}

export async function observeEvmClaimAction({
  store,
  actionId,
  rpcUrl,
  expectedContractCodeHash,
  providerLabel = "single-provider",
  rpcRequestImpl = defaultRpcRequest,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  requestTimeoutMs = 30_000,
}) {
  const action = store.getAction(bytes32(actionId, "actionId"));
  const bound = store.getEvmTransaction(actionId);
  if (!action || !bound || action.method !== "evm:claim") throw new Error("bound EVM action does not exist");
  if (action.state !== "UNKNOWN") throw new Error("EVM action does not require reconciliation");
  const contractCodeHash = bytes32(expectedContractCodeHash, "expectedContractCodeHash");
  const rpc = (method, params) => callRpc({ rpcUrl, rpcRequestImpl, method, params, timeoutMs: requestTimeoutMs });
  const observedAt = timestamp(nowSeconds(), "observedAt");
  const transaction = await rpc("eth_getTransactionByHash", [bound.transactionHash]);
  const receipt = await rpc("eth_getTransactionReceipt", [bound.transactionHash]);

  let observedOperation = null;
  if (transaction) {
    try {
      const operation = rpcTransactionOperation(transaction, contractCodeHash);
      if (
        bytes32(String(transaction.hash).toLowerCase(), "transaction.hash") !== bound.transactionHash
          || address(transaction.from, "transaction.from") !== bound.fromAddress
          || operation.contract !== bound.toAddress || operation.chainId.toString() !== bound.chainId
          || operation.nonce.toString() !== bound.nonce
          || evmClaimActionCommitment(action, operation, transaction.from) !== action.payloadDigest
      ) throw new Error("transaction commitment changed");
      observedOperation = operation;
    } catch {
      return claimObservation({
        actionId: action.actionId,
        observedAt,
        observedState: "MISMATCH",
        providerLabel,
        receiptPresent: Boolean(receipt),
        transactionHash: bound.transactionHash,
        transactionPresent: true,
      });
    }
  }

  if (receipt && !observedOperation) {
    return claimObservation({
      actionId: action.actionId,
      observedAt,
      observedState: "MISMATCH",
      providerLabel,
      receiptPresent: true,
      transactionHash: bound.transactionHash,
      transactionPresent: false,
    });
  }

  if (!receipt) {
    const observedState = bound.inclusionBlockHash ? "REORGED" : transaction ? "LOCKED" : "NOT_FOUND";
    return claimObservation({
      actionId: action.actionId,
      inclusionBlockHash: bound.inclusionBlockHash,
      inclusionBlockNumber: bound.inclusionBlockNumber,
      observedAt,
      transactionHash: bound.transactionHash,
      observedState,
      providerLabel,
      receiptPresent: false,
      transactionPresent: Boolean(transaction),
    });
  }

  let transactionHash;
  let blockHash;
  let blockNumber;
  let receiptStatus;
  try {
    transactionHash = bytes32(String(receipt.transactionHash).toLowerCase(), "receipt.transactionHash");
    blockHash = bytes32(String(receipt.blockHash).toLowerCase(), "receipt.blockHash");
    blockNumber = safeBlockNumber(receipt.blockNumber, "receipt.blockNumber");
    receiptStatus = quantity(receipt.status, "receipt.status");
    if (transactionHash !== bound.transactionHash || (receiptStatus !== 0n && receiptStatus !== 1n)) throw new Error();
  } catch {
    return claimObservation({
      actionId: action.actionId,
      observedAt,
      observedState: "MISMATCH",
      providerLabel,
      receiptPresent: true,
      transactionHash: bound.transactionHash,
      transactionPresent: true,
    });
  }

  const canonicalBlock = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!canonicalBlock || String(canonicalBlock.hash).toLowerCase() !== blockHash) {
    return claimObservation({
      actionId: action.actionId,
      inclusionBlockHash: blockHash,
      inclusionBlockNumber: blockNumber,
      observedAt,
      observedState: "REORGED",
      providerLabel,
      receiptPresent: true,
      receiptStatus: receiptStatus.toString(),
      transactionHash,
      transactionPresent: true,
    });
  }
  if (bound.inclusionBlockHash && (
    bound.inclusionBlockHash !== blockHash || bound.inclusionBlockNumber !== blockNumber
  )) {
    return claimObservation({
      actionId: action.actionId,
      inclusionBlockHash: blockHash,
      inclusionBlockNumber: blockNumber,
      observedAt,
      observedState: "REORGED",
      providerLabel,
      receiptPresent: true,
      receiptStatus: receiptStatus.toString(),
      transactionHash,
      transactionPresent: true,
    });
  }
  const includedCode = String(await rpc("eth_getCode", [bound.toAddress, { blockHash, requireCanonical: true }])).toLowerCase();
  if (!DATA.test(includedCode) || includedCode === "0x" || keccak256(includedCode).toLowerCase() !== contractCodeHash) {
    return claimObservation({
      actionId: action.actionId,
      inclusionBlockHash: blockHash,
      inclusionBlockNumber: blockNumber,
      observedAt,
      observedState: "MISMATCH",
      providerLabel,
      receiptPresent: true,
      receiptStatus: receiptStatus.toString(),
      transactionHash,
      transactionPresent: true,
    });
  }
  const canonicalCodeHash = keccak256(includedCode).toLowerCase();
  const finalizedBlock = await rpc("eth_getBlockByNumber", ["finalized", false]);
  const finalizedNumber = safeBlockNumber(finalizedBlock?.number, "finalized block number");
  bytes32(String(finalizedBlock?.hash).toLowerCase(), "finalized block hash");
  if (finalizedNumber < blockNumber) {
    return claimObservation({
      actionId: action.actionId,
      canonicalCodeHash,
      canonicalInclusion: true,
      inclusionBlockHash: blockHash,
      inclusionBlockNumber: blockNumber,
      observedAt,
      observedState: "INCLUDED",
      providerLabel,
      receiptPresent: true,
      receiptStatus: receiptStatus.toString(),
      transactionHash,
      transactionPresent: true,
    });
  }
  const observedState = receiptStatus === 0n
    ? "REVERTED"
    : matchingClaimedLog(receipt, bound.toAddress, observedOperation.quoteId, transactionHash, blockHash)
      ? "CLAIMED"
      : "MISMATCH";
  return claimObservation({
    actionId: action.actionId,
    canonicalCodeHash,
    canonicalInclusion: true,
    finalized: true,
    inclusionBlockHash: blockHash,
    inclusionBlockNumber: blockNumber,
    observedAt,
    observedState,
    providerLabel,
    receiptPresent: true,
    receiptStatus: receiptStatus.toString(),
    transactionHash,
    transactionPresent: true,
  });
}

async function applyEvmClaimObservation(store, observation, beforeStateChange = null) {
  const action = store.getAction(observation.actionId);
  const bound = store.getEvmTransaction(observation.actionId);
  if (!action || !bound || action.state !== "UNKNOWN") throw new Error("unknown EVM action does not exist");
  if (bound.transactionHash !== observation.transactionHash) throw new Error("EVM observation transaction changed");
  if (observation.canonicalInclusion) {
    const inclusionDigest = coordinatorCommitmentDigest({
      actionId: observation.actionId,
      transactionHash: observation.transactionHash,
      blockHash: observation.inclusionBlockHash,
      blockNumber: observation.inclusionBlockNumber,
      receiptStatus: observation.receiptStatus,
    });
    if (beforeStateChange !== null) {
      if (typeof beforeStateChange !== "function") throw new TypeError("beforeStateChange must be a function");
      await beforeStateChange("evm-inclusion-record");
    }
    store.recordEvmInclusion({
      actionId: observation.actionId,
      transactionHash: observation.transactionHash,
      blockHash: observation.inclusionBlockHash,
      blockNumber: observation.inclusionBlockNumber,
      observationDigest: inclusionDigest,
      observedAt: observation.observedAt,
    });
  }
  if (beforeStateChange !== null) {
    if (typeof beforeStateChange !== "function") throw new TypeError("beforeStateChange must be a function");
    await beforeStateChange("evm-reconciliation");
  }
  return store.reconcileAction({
    actionId: observation.actionId,
    observedState: observation.observedState,
    observationDigest: observation.consensusDigest,
    observedAt: observation.observedAt,
  });
}

export async function reconcileEvmClaimAction(input) {
  const observation = await observeEvmClaimAction(input);
  return applyEvmClaimObservation(input.store, observation, input.beforeStateChange ?? null);
}

function quorumProvider(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("EVM provider must be an object");
  const keys = Object.keys(value);
  if (!keys.includes("label") || !keys.includes("rpcUrl") || keys.some((key) => !["label", "rpcRequestImpl", "rpcUrl"].includes(key))) {
    throw new TypeError("EVM provider fields are not exact");
  }
  return Object.freeze({
    label: safeProviderLabel(value.label),
    rpcUrl: validatedRpcUrl(value.rpcUrl),
    rpcRequestImpl: value.rpcRequestImpl ?? defaultRpcRequest,
  });
}

export async function reconcileEvmClaimActionWithQuorum({
  store,
  actionId,
  providers,
  expectedContractCodeHash,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  requestTimeoutMs = 30_000,
  beforeStateChange = null,
}) {
  if (!Array.isArray(providers) || providers.length !== 2) {
    throw new TypeError("exactly two EVM reconciliation providers are required");
  }
  const configured = providers.map(quorumProvider);
  if (configured[0].label === configured[1].label) throw new Error("EVM provider labels must be independent");
  if (new URL(configured[0].rpcUrl).origin === new URL(configured[1].rpcUrl).origin) {
    throw new Error("EVM provider origins must be independent");
  }
  const observedAt = timestamp(nowSeconds(), "observedAt");
  const results = await Promise.allSettled(configured.map((provider) => observeEvmClaimAction({
    store,
    actionId,
    rpcUrl: provider.rpcUrl,
    expectedContractCodeHash,
    providerLabel: provider.label,
    rpcRequestImpl: provider.rpcRequestImpl,
    nowSeconds: () => observedAt,
    requestTimeoutMs,
  })));
  if (results.some((result) => result.status !== "fulfilled")) {
    throw new EvmProviderQuorumError("EVM provider quorum is unavailable", "PROVIDER_UNAVAILABLE");
  }
  const observations = results.map((result) => result.value);
  if (observations[0].consensusDigest !== observations[1].consensusDigest) {
    throw new EvmProviderQuorumError("EVM reconciliation providers disagree", "PROVIDER_DISAGREEMENT");
  }
  const reconciled = await applyEvmClaimObservation(store, observations[0], beforeStateChange);
  return Object.freeze({
    ...reconciled,
    providerQuorum: Object.freeze({
      consensusDigest: observations[0].consensusDigest,
      providers: Object.freeze(observations.map((observation) => observation.providerLabel).sort()),
    }),
  });
}
