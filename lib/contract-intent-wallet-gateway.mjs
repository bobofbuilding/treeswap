import {
  createPrivateKey,
  createPublicKey,
  randomBytes as nodeRandomBytes,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import { TextDecoder as NodeTextDecoder } from "node:util";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import {
  contractIntentWalletJournalArtifact,
  recordContractIntentWalletOutcome,
  verifyContractIntentWalletContext,
} from "./contract-intent-wallet.mjs";
import { claimContractIntentWalletForDispatch } from "./contract-intent-wallet-store.mjs";
import { isPrivateLndHostname } from "./lnd-rest-client.mjs";

export const CONTRACT_INTENT_WALLET_GATEWAY_REQUEST_SCHEMA =
  "treeswap.contract-intent-wallet-gateway-request.v1";
export const CONTRACT_INTENT_WALLET_GATEWAY_RESPONSE_SCHEMA =
  "treeswap.contract-intent-wallet-gateway-response.v1";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const TOKEN = /^(?!0{64}$)[0-9a-f]{64}$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const QUANTITY = /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/;
const CALLDATA = /^0x(?:[0-9a-f]{2})+$/;
const DECIMAL = /^[1-9][0-9]*$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const WALLET_REVIEW_EFFECT =
  "Submits this exact zero-ETH escrow call. It is not a token approval and does not authorize Lightning by itself.";
const WALLET_REVIEW_TITLES = new Set(["Lock BIT for Lightning", "Reserve solver BIT"]);
const MAXIMUM_REQUEST_TTL_SECONDS = 30;
const MAXIMUM_CLOCK_SKEW_SECONDS = 5;
const MAXIMUM_REPORT_GRACE_SECONDS = 10 * 60;
const MAXIMUM_CLAIM_LIFETIME_SECONDS = 20 * 60;
const MAXIMUM_STAGED_PREFLIGHTS = 128;
const MAXIMUM_ACTIVE_CLAIMS = 128;
const DEFAULT_MAXIMUM_REQUEST_BYTES = 64 * 1024;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_MAXIMUM_PROCESSING_MILLISECONDS = 5_000;
const DEFAULT_MAXIMUM_IN_FLIGHT = 16;
const GATEWAYS = new WeakMap();
const BUILT_CLAIM_REQUESTS = new WeakSet();
const BUILT_OUTCOME_REQUESTS = new WeakSet();
const VERIFIED_CLAIM_RESPONSES = new WeakMap();
const VERIFIED_OUTCOME_RESPONSES = new WeakSet();

const CLAIM_REQUEST_FIELDS = Object.freeze([
  "expiresAt",
  "kind",
  "requestDigest",
  "requestId",
  "requestedAt",
  "requesterKeyId",
  "schema",
  "sessionDigest",
  "signature",
  "wallet",
]);
const OUTCOME_REQUEST_FIELDS = Object.freeze([
  "beforeAccounts",
  "beforeChainId",
  "claimToken",
  "contextObservedAt",
  "expiresAt",
  "kind",
  "outcome",
  "outcomeObservedAt",
  "postAccounts",
  "postChainId",
  "requestDigest",
  "requestId",
  "requestedAt",
  "requesterKeyId",
  "schema",
  "sessionDigest",
  "signature",
  "wallet",
]);
const CLAIM_RESPONSE_FIELDS = Object.freeze([
  "claimToken",
  "contractIntentDigest",
  "dispatchExpiresAt",
  "issuedAt",
  "kind",
  "reportExpiresAt",
  "request",
  "requestDigest",
  "requestId",
  "responseKeyId",
  "review",
  "schema",
  "signature",
]);
const OUTCOME_RESPONSE_FIELDS = Object.freeze([
  "canonicalFinalizedReservation",
  "contractIntentDigest",
  "fundingAuthorization",
  "independentProviderOperationVerified",
  "kind",
  "lightningDispatchAuthority",
  "recordedAt",
  "requestDigest",
  "requestId",
  "responseKeyId",
  "retryAuthorized",
  "schema",
  "signature",
  "state",
  "transactionHash",
  "walletDispatchAuthority",
]);
const OUTCOME_FIELDS = Object.freeze(["errorCode", "status", "transactionHash"]);
const WALLET_REQUEST_FIELDS = Object.freeze(["method", "params"]);
const WALLET_TRANSACTION_FIELDS = Object.freeze(["data", "from", "to", "value"]);
const REVIEW_FIELDS = Object.freeze([
  "account",
  "calldataDigest",
  "chainId",
  "contract",
  "contractIntentDigest",
  "effect",
  "expiresAt",
  "quoteId",
  "title",
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

function exactDenseArray(value, maximum, name, minimum = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${name} must be a bounded dense array`);
  }
  const expected = new Set([...Array(value.length).keys()].map(String).concat("length"));
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size
      || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
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

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  }
  return value;
}

function token(value, name) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new TypeError(`${name} must be an exact secret token`);
  }
  return value;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function quantity(value, name) {
  if (typeof value !== "string" || !QUANTITY.test(value)) {
    throw new TypeError(`${name} must be a canonical JSON-RPC quantity`);
  }
  return value;
}

function canonicalize(value, depth = 0) {
  if (depth > 12) throw new RangeError("wallet gateway value is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("wallet gateway numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("wallet gateway values must contain plain data only");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("wallet gateway values cannot contain symbols");
    }
    keys.sort();
    return `{${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new TypeError("wallet gateway values require enumerable data properties");
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  }
  throw new TypeError("wallet gateway value contains unsupported data");
}

function digest(value) {
  return keccak256(toUtf8Bytes(canonicalize(value))).toLowerCase();
}

function publicKey(value, name) {
  try {
    const key = value?.type === "public" ? value : createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new TypeError(`${name} must be an Ed25519 public key`);
  }
}

function privateKey(value, name) {
  try {
    const key = value?.type === "private" ? value : createPrivateKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new TypeError(`${name} must be an Ed25519 private key`);
  }
}

export function contractIntentWalletGatewayKeyId(value) {
  const key = value?.type === "private" ? createPublicKey(value) : publicKey(value, "wallet gateway key");
  const der = key.export({ format: "der", type: "spki" });
  return keccak256(der).toLowerCase();
}

function requestMessage(requestDigest) {
  return Buffer.from(`TreeSwap contract intent wallet gateway request v1\n${requestDigest}\n`, "utf8");
}

function responseMessage(responseDigest) {
  return Buffer.from(`TreeSwap contract intent wallet gateway response v1\n${responseDigest}\n`, "utf8");
}

function unsigned(value, fields) {
  return Object.freeze(Object.fromEntries(fields
    .filter((field) => field !== "signature")
    .map((field) => [field, value[field]])));
}

function withoutRequestId(value, fields) {
  return Object.freeze(Object.fromEntries(fields
    .filter((field) => field !== "requestId" && field !== "signature")
    .map((field) => [field, value[field]])));
}

function normalizeAccounts(value, name, minimum = 0) {
  return Object.freeze(exactDenseArray(value, 32, name, minimum)
    .map((entry, index) => address(entry, `${name}[${index}]`)));
}

function normalizeOutcome(value) {
  const source = exactRecord(value, OUTCOME_FIELDS, "wallet gateway outcome");
  if (source.status === "reported") {
    if (source.errorCode !== null) throw new Error("reported wallet gateway outcome cannot carry an error");
    return Object.freeze({
      errorCode: null,
      status: "reported",
      transactionHash: bytes32(source.transactionHash, "wallet gateway transaction hash"),
    });
  }
  if (source.status === "rejected") {
    if (source.errorCode !== 4001 || source.transactionHash !== null) {
      throw new Error("wallet gateway rejection must be exact EIP-1193 code 4001");
    }
    return Object.freeze({ errorCode: 4001, status: "rejected", transactionHash: null });
  }
  if (source.status === "ambiguous") {
    if (source.errorCode !== null || source.transactionHash !== null) {
      throw new Error("ambiguous wallet gateway outcome cannot claim a hash or error");
    }
    return Object.freeze({ errorCode: null, status: "ambiguous", transactionHash: null });
  }
  throw new Error("wallet gateway outcome status is unsupported");
}

function normalizeClaimRequest(raw) {
  const source = exactRecord(raw, CLAIM_REQUEST_FIELDS, "wallet gateway claim request");
  if (source.schema !== CONTRACT_INTENT_WALLET_GATEWAY_REQUEST_SCHEMA || source.kind !== "CLAIM") {
    throw new Error("wallet gateway claim request schema is unsupported");
  }
  const normalized = Object.freeze({
    schema: source.schema,
    kind: source.kind,
    requestId: bytes32(source.requestId, "wallet gateway claim request ID"),
    requestDigest: bytes32(source.requestDigest, "wallet gateway preflight digest"),
    wallet: address(source.wallet, "wallet gateway wallet"),
    sessionDigest: bytes32(source.sessionDigest, "wallet gateway session digest"),
    requesterKeyId: bytes32(source.requesterKeyId, "wallet gateway requester key ID"),
    requestedAt: integer(source.requestedAt, "wallet gateway claim request time", 1),
    expiresAt: integer(source.expiresAt, "wallet gateway claim request expiry", 1),
    signature: source.signature,
  });
  if (normalized.expiresAt <= normalized.requestedAt
      || normalized.expiresAt - normalized.requestedAt > MAXIMUM_REQUEST_TTL_SECONDS
      || typeof normalized.signature !== "string" || !BASE64_SIGNATURE.test(normalized.signature)) {
    throw new Error("wallet gateway claim request window or signature is invalid");
  }
  const expectedId = digest({
    schema: normalized.schema,
    kind: normalized.kind,
    requestDigest: normalized.requestDigest,
    wallet: normalized.wallet,
    sessionDigest: normalized.sessionDigest,
    requesterKeyId: normalized.requesterKeyId,
    requestedAt: normalized.requestedAt,
    expiresAt: normalized.expiresAt,
  });
  if (normalized.requestId !== expectedId) throw new Error("wallet gateway claim request ID changed");
  return normalized;
}

function normalizeOutcomeRequest(raw) {
  const source = exactRecord(raw, OUTCOME_REQUEST_FIELDS, "wallet gateway outcome request");
  if (source.schema !== CONTRACT_INTENT_WALLET_GATEWAY_REQUEST_SCHEMA || source.kind !== "OUTCOME") {
    throw new Error("wallet gateway outcome request schema is unsupported");
  }
  const postUnavailable = source.postChainId === null && source.postAccounts === null;
  if ((source.postChainId === null) !== (source.postAccounts === null)) {
    throw new Error("wallet gateway post-context must be complete or unavailable");
  }
  const normalized = Object.freeze({
    schema: source.schema,
    kind: source.kind,
    requestId: bytes32(source.requestId, "wallet gateway outcome request ID"),
    requestDigest: bytes32(source.requestDigest, "wallet gateway outcome preflight digest"),
    claimToken: token(source.claimToken, "wallet gateway claim token"),
    wallet: address(source.wallet, "wallet gateway outcome wallet"),
    sessionDigest: bytes32(source.sessionDigest, "wallet gateway outcome session digest"),
    requesterKeyId: bytes32(source.requesterKeyId, "wallet gateway outcome requester key ID"),
    beforeChainId: quantity(source.beforeChainId, "wallet gateway before-chain ID"),
    beforeAccounts: normalizeAccounts(source.beforeAccounts, "wallet gateway before-accounts", 1),
    postChainId: postUnavailable ? null : quantity(source.postChainId, "wallet gateway post-chain ID"),
    postAccounts: postUnavailable
      ? null
      : normalizeAccounts(source.postAccounts, "wallet gateway post-accounts"),
    contextObservedAt: integer(source.contextObservedAt, "wallet gateway context time", 1),
    outcomeObservedAt: integer(source.outcomeObservedAt, "wallet gateway outcome time", 1),
    outcome: normalizeOutcome(source.outcome),
    requestedAt: integer(source.requestedAt, "wallet gateway outcome request time", 1),
    expiresAt: integer(source.expiresAt, "wallet gateway outcome request expiry", 1),
    signature: source.signature,
  });
  if (normalized.outcomeObservedAt < normalized.contextObservedAt
      || normalized.requestedAt < normalized.outcomeObservedAt
      || normalized.expiresAt <= normalized.requestedAt
      || normalized.expiresAt - normalized.requestedAt > MAXIMUM_REQUEST_TTL_SECONDS
      || typeof normalized.signature !== "string" || !BASE64_SIGNATURE.test(normalized.signature)) {
    throw new Error("wallet gateway outcome chronology or signature is invalid");
  }
  const expectedId = digest(withoutRequestId(normalized, OUTCOME_REQUEST_FIELDS));
  if (normalized.requestId !== expectedId) throw new Error("wallet gateway outcome request ID changed");
  return normalized;
}

function verifySignedRequest(raw, expectedKind, requesterKey, expectedRequesterKeyId, now) {
  const request = expectedKind === "CLAIM" ? normalizeClaimRequest(raw) : normalizeOutcomeRequest(raw);
  if (request.requesterKeyId !== expectedRequesterKeyId) {
    throw new Error("wallet gateway requester key is not allowlisted");
  }
  if (now < request.requestedAt - MAXIMUM_CLOCK_SKEW_SECONDS || now >= request.expiresAt) {
    throw new Error("wallet gateway request is outside its live window");
  }
  const requestDigest = digest(unsigned(
    request,
    expectedKind === "CLAIM" ? CLAIM_REQUEST_FIELDS : OUTCOME_REQUEST_FIELDS,
  ));
  if (!verifyMessage(
    null,
    requestMessage(requestDigest),
    requesterKey,
    Buffer.from(request.signature, "base64"),
  )) throw new Error("wallet gateway request signature is invalid");
  return Object.freeze({ ...request, signedRequestDigest: requestDigest });
}

function signedRequest(unsignedRequest, requesterPrivateKey) {
  const requestDigest = digest(unsignedRequest);
  return Object.freeze({
    ...unsignedRequest,
    signature: signMessage(
      null,
      requestMessage(requestDigest),
      privateKey(requesterPrivateKey, "wallet gateway requester private key"),
    ).toString("base64"),
  });
}

export function buildContractIntentWalletGatewayClaimRequest(input) {
  const source = exactRecord(input, [
    "expiresAt",
    "requestDigest",
    "requestedAt",
    "requesterPrivateKey",
    "sessionDigest",
    "wallet",
  ], "wallet gateway claim request construction");
  const requesterKey = privateKey(source.requesterPrivateKey, "wallet gateway requester private key");
  const unsignedRequest = Object.freeze({
    schema: CONTRACT_INTENT_WALLET_GATEWAY_REQUEST_SCHEMA,
    kind: "CLAIM",
    requestId: digest({
      schema: CONTRACT_INTENT_WALLET_GATEWAY_REQUEST_SCHEMA,
      kind: "CLAIM",
      requestDigest: bytes32(source.requestDigest, "wallet gateway preflight digest"),
      wallet: address(source.wallet, "wallet gateway wallet"),
      sessionDigest: bytes32(source.sessionDigest, "wallet gateway session digest"),
      requesterKeyId: contractIntentWalletGatewayKeyId(requesterKey),
      requestedAt: integer(source.requestedAt, "wallet gateway claim request time", 1),
      expiresAt: integer(source.expiresAt, "wallet gateway claim request expiry", 1),
    }),
    requestDigest: bytes32(source.requestDigest, "wallet gateway preflight digest"),
    wallet: address(source.wallet, "wallet gateway wallet"),
    sessionDigest: bytes32(source.sessionDigest, "wallet gateway session digest"),
    requesterKeyId: contractIntentWalletGatewayKeyId(requesterKey),
    requestedAt: integer(source.requestedAt, "wallet gateway claim request time", 1),
    expiresAt: integer(source.expiresAt, "wallet gateway claim request expiry", 1),
  });
  const request = signedRequest(unsignedRequest, requesterKey);
  normalizeClaimRequest(request);
  BUILT_CLAIM_REQUESTS.add(request);
  return request;
}

export function buildContractIntentWalletGatewayOutcomeRequest(input) {
  const source = exactRecord(input, [
    "beforeAccounts",
    "beforeChainId",
    "claimToken",
    "contextObservedAt",
    "expiresAt",
    "outcome",
    "outcomeObservedAt",
    "postAccounts",
    "postChainId",
    "requestDigest",
    "requestedAt",
    "requesterPrivateKey",
    "sessionDigest",
    "wallet",
  ], "wallet gateway outcome request construction");
  const requesterKey = privateKey(source.requesterPrivateKey, "wallet gateway requester private key");
  const postUnavailable = source.postChainId === null && source.postAccounts === null;
  if ((source.postChainId === null) !== (source.postAccounts === null)) {
    throw new Error("wallet gateway post-context must be complete or unavailable");
  }
  const base = Object.freeze({
    schema: CONTRACT_INTENT_WALLET_GATEWAY_REQUEST_SCHEMA,
    kind: "OUTCOME",
    requestDigest: bytes32(source.requestDigest, "wallet gateway outcome preflight digest"),
    claimToken: token(source.claimToken, "wallet gateway claim token"),
    wallet: address(source.wallet, "wallet gateway outcome wallet"),
    sessionDigest: bytes32(source.sessionDigest, "wallet gateway outcome session digest"),
    requesterKeyId: contractIntentWalletGatewayKeyId(requesterKey),
    beforeChainId: quantity(source.beforeChainId, "wallet gateway before-chain ID"),
    beforeAccounts: normalizeAccounts(source.beforeAccounts, "wallet gateway before-accounts", 1),
    postChainId: postUnavailable ? null : quantity(source.postChainId, "wallet gateway post-chain ID"),
    postAccounts: postUnavailable
      ? null
      : normalizeAccounts(source.postAccounts, "wallet gateway post-accounts"),
    contextObservedAt: integer(source.contextObservedAt, "wallet gateway context time", 1),
    outcomeObservedAt: integer(source.outcomeObservedAt, "wallet gateway outcome time", 1),
    outcome: normalizeOutcome(source.outcome),
    requestedAt: integer(source.requestedAt, "wallet gateway outcome request time", 1),
    expiresAt: integer(source.expiresAt, "wallet gateway outcome request expiry", 1),
  });
  const unsignedRequest = Object.freeze({ ...base, requestId: digest(base) });
  const request = signedRequest(unsignedRequest, requesterKey);
  normalizeOutcomeRequest(request);
  BUILT_OUTCOME_REQUESTS.add(request);
  return request;
}

function normalizeWalletRequest(raw) {
  const source = exactRecord(raw, WALLET_REQUEST_FIELDS, "wallet gateway transaction request");
  if (source.method !== "eth_sendTransaction") throw new Error("wallet gateway method is unsupported");
  const params = exactDenseArray(source.params, 1, "wallet gateway transaction params", 1);
  const transaction = exactRecord(params[0], WALLET_TRANSACTION_FIELDS, "wallet gateway transaction");
  if (typeof transaction.data !== "string" || !CALLDATA.test(transaction.data)
      || transaction.value !== "0x0") {
    throw new Error("wallet gateway transaction must be canonical zero-ETH escrow calldata");
  }
  return Object.freeze({
    method: source.method,
    params: Object.freeze([Object.freeze({
      data: transaction.data,
      from: address(transaction.from, "wallet gateway transaction sender"),
      to: address(transaction.to, "wallet gateway transaction target"),
      value: transaction.value,
    })]),
  });
}

function normalizeReview(raw) {
  const source = exactRecord(raw, REVIEW_FIELDS, "wallet gateway review");
  if (!WALLET_REVIEW_TITLES.has(source.title) || source.effect !== WALLET_REVIEW_EFFECT
      || typeof source.chainId !== "string" || !DECIMAL.test(source.chainId)
      || BigInt(source.chainId) > MAX_UINT256) {
    throw new Error("wallet gateway review text or chain is invalid");
  }
  return Object.freeze({
    title: source.title,
    effect: source.effect,
    chainId: source.chainId,
    account: address(source.account, "wallet gateway review account"),
    contract: address(source.contract, "wallet gateway review contract"),
    quoteId: bytes32(source.quoteId, "wallet gateway review quote ID"),
    contractIntentDigest: bytes32(
      source.contractIntentDigest,
      "wallet gateway review contract intent digest",
    ),
    calldataDigest: bytes32(source.calldataDigest, "wallet gateway review calldata digest"),
    expiresAt: integer(source.expiresAt, "wallet gateway review expiry", 1),
  });
}

function normalizeClaimResponse(raw) {
  const source = exactRecord(raw, CLAIM_RESPONSE_FIELDS, "wallet gateway claim response");
  if (source.schema !== CONTRACT_INTENT_WALLET_GATEWAY_RESPONSE_SCHEMA || source.kind !== "CLAIMED") {
    throw new Error("wallet gateway claim response schema is unsupported");
  }
  const response = Object.freeze({
    schema: source.schema,
    kind: source.kind,
    requestId: bytes32(source.requestId, "wallet gateway claim response request ID"),
    requestDigest: bytes32(source.requestDigest, "wallet gateway claim response preflight digest"),
    contractIntentDigest: bytes32(source.contractIntentDigest, "wallet gateway contract intent digest"),
    claimToken: token(source.claimToken, "wallet gateway response claim token"),
    request: normalizeWalletRequest(source.request),
    review: normalizeReview(source.review),
    issuedAt: integer(source.issuedAt, "wallet gateway claim response time", 1),
    dispatchExpiresAt: integer(source.dispatchExpiresAt, "wallet gateway dispatch expiry", 1),
    reportExpiresAt: integer(source.reportExpiresAt, "wallet gateway report expiry", 1),
    responseKeyId: bytes32(source.responseKeyId, "wallet gateway response key ID"),
    signature: source.signature,
  });
  if (response.dispatchExpiresAt <= response.issuedAt
      || response.reportExpiresAt <= response.dispatchExpiresAt
      || response.reportExpiresAt - response.issuedAt > MAXIMUM_CLAIM_LIFETIME_SECONDS
      || typeof response.signature !== "string" || !BASE64_SIGNATURE.test(response.signature)) {
    throw new Error("wallet gateway claim response window or signature is invalid");
  }
  return response;
}

function normalizeOutcomeResponse(raw) {
  const source = exactRecord(raw, OUTCOME_RESPONSE_FIELDS, "wallet gateway outcome response");
  if (source.schema !== CONTRACT_INTENT_WALLET_GATEWAY_RESPONSE_SCHEMA || source.kind !== "RECORDED") {
    throw new Error("wallet gateway outcome response schema is unsupported");
  }
  const response = Object.freeze({
    schema: source.schema,
    kind: source.kind,
    requestId: bytes32(source.requestId, "wallet gateway outcome response request ID"),
    requestDigest: bytes32(source.requestDigest, "wallet gateway outcome response preflight digest"),
    contractIntentDigest: bytes32(source.contractIntentDigest, "wallet gateway outcome contract intent"),
    state: source.state,
    transactionHash: source.transactionHash === null
      ? null
      : bytes32(source.transactionHash, "wallet gateway outcome response transaction hash"),
    recordedAt: integer(source.recordedAt, "wallet gateway outcome response time", 1),
    retryAuthorized: source.retryAuthorized,
    walletDispatchAuthority: source.walletDispatchAuthority,
    canonicalFinalizedReservation: source.canonicalFinalizedReservation,
    independentProviderOperationVerified: source.independentProviderOperationVerified,
    lightningDispatchAuthority: source.lightningDispatchAuthority,
    fundingAuthorization: source.fundingAuthorization,
    responseKeyId: bytes32(source.responseKeyId, "wallet gateway response key ID"),
    signature: source.signature,
  });
  if (![
    "USER_REJECTED",
    "USER_REJECTED_CONTEXT_CHANGED",
    "SUBMISSION_UNKNOWN",
    "SUBMISSION_UNKNOWN_CONTEXT_CHANGED",
    "SUBMISSION_REPORTED",
    "SUBMISSION_REPORTED_CONTEXT_CHANGED",
  ].includes(response.state)
      || typeof response.signature !== "string" || !BASE64_SIGNATURE.test(response.signature)
      || (response.state.startsWith("SUBMISSION_REPORTED"))
        !== (response.transactionHash !== null)
      || response.retryAuthorized !== false || response.walletDispatchAuthority !== false
      || response.canonicalFinalizedReservation !== false
      || response.independentProviderOperationVerified !== false
      || response.lightningDispatchAuthority !== false || response.fundingAuthorization !== false) {
    throw new Error("wallet gateway outcome response authority or state is invalid");
  }
  return response;
}

function signResponse(unsignedResponse, responsePrivateKey) {
  const responseDigest = digest(unsignedResponse);
  return Object.freeze({
    ...unsignedResponse,
    signature: signMessage(
      null,
      responseMessage(responseDigest),
      responsePrivateKey,
    ).toString("base64"),
  });
}

function verifyResponseSignature(response, fields, responsePublicKey, expectedResponseKeyId) {
  if (response.responseKeyId !== expectedResponseKeyId) {
    throw new Error("wallet gateway response key changed");
  }
  const responseDigest = digest(unsigned(response, fields));
  if (!verifyMessage(
    null,
    responseMessage(responseDigest),
    responsePublicKey,
    Buffer.from(response.signature, "base64"),
  )) throw new Error("wallet gateway response signature is invalid");
}

export function verifyContractIntentWalletGatewayClaimResponse(input) {
  const source = exactRecord(input, [
    "now",
    "preflight",
    "request",
    "response",
    "responsePublicKey",
  ], "wallet gateway claim response verification");
  const artifact = contractIntentWalletJournalArtifact(source.preflight);
  if (artifact.kind !== "PREFLIGHT") throw new TypeError("wallet gateway claim requires an original preflight");
  if (!BUILT_CLAIM_REQUESTS.has(source.request)) {
    throw new TypeError("wallet gateway claim response requires the original locally built claim request");
  }
  const request = normalizeClaimRequest(source.request);
  const response = normalizeClaimResponse(source.response);
  const observedAt = integer(source.now, "wallet gateway claim response verification time", 1);
  const responsePublicKey = publicKey(source.responsePublicKey, "wallet gateway response public key");
  const responseKeyId = contractIntentWalletGatewayKeyId(responsePublicKey);
  verifyResponseSignature(response, CLAIM_RESPONSE_FIELDS, responsePublicKey, responseKeyId);
  if (observedAt < response.issuedAt - MAXIMUM_CLOCK_SKEW_SECONDS
      || observedAt >= response.dispatchExpiresAt
      || response.issuedAt < request.requestedAt - MAXIMUM_CLOCK_SKEW_SECONDS
      || response.issuedAt >= request.expiresAt
      || response.requestId !== request.requestId
      || request.requestDigest !== source.preflight.requestDigest
      || request.wallet !== source.preflight.from
      || request.expiresAt > source.preflight.expiresAt
      || response.requestDigest !== source.preflight.requestDigest
      || response.contractIntentDigest !== source.preflight.contractIntentDigest
      || canonicalize(response.request) !== canonicalize(source.preflight.request)
      || canonicalize(response.review) !== canonicalize(source.preflight.review)
      || response.dispatchExpiresAt !== source.preflight.expiresAt
      || response.reportExpiresAt
        !== source.preflight.expiresAt + MAXIMUM_REPORT_GRACE_SECONDS) {
    throw new Error("wallet gateway claim response changed the expected preflight");
  }
  const verified = Object.freeze({ ...response });
  VERIFIED_CLAIM_RESPONSES.set(verified, Object.freeze({
    preflight: source.preflight,
    request: source.request,
  }));
  return verified;
}

export function verifiedContractIntentWalletGatewayClaimResponse(value) {
  if (!VERIFIED_CLAIM_RESPONSES.has(value)) {
    throw new TypeError("wallet gateway claim response lacks verified provenance");
  }
  return value;
}

export function verifyContractIntentWalletGatewayOutcomeResponse(input) {
  const source = exactRecord(input, [
    "claim",
    "request",
    "response",
    "responsePublicKey",
  ], "wallet gateway outcome response verification");
  const claimContext = VERIFIED_CLAIM_RESPONSES.get(source.claim);
  if (!claimContext) {
    throw new TypeError("wallet gateway outcome response requires the original verified claim response");
  }
  if (!BUILT_OUTCOME_REQUESTS.has(source.request)) {
    throw new TypeError("wallet gateway outcome response requires the original locally built outcome request");
  }
  const request = normalizeOutcomeRequest(source.request);
  const response = normalizeOutcomeResponse(source.response);
  const responsePublicKey = publicKey(source.responsePublicKey, "wallet gateway response public key");
  verifyResponseSignature(
    response,
    OUTCOME_RESPONSE_FIELDS,
    responsePublicKey,
    contractIntentWalletGatewayKeyId(responsePublicKey),
  );
  const contextChanged = request.postChainId === null
    || BigInt(request.postChainId) !== BigInt(request.beforeChainId)
    || request.postAccounts[0] !== request.beforeAccounts[0];
  const expectedState = request.outcome.status === "reported"
    ? contextChanged ? "SUBMISSION_REPORTED_CONTEXT_CHANGED" : "SUBMISSION_REPORTED"
    : request.outcome.status === "rejected"
      ? contextChanged ? "USER_REJECTED_CONTEXT_CHANGED" : "USER_REJECTED"
      : contextChanged ? "SUBMISSION_UNKNOWN_CONTEXT_CHANGED" : "SUBMISSION_UNKNOWN";
  if (request.requestDigest !== source.claim.requestDigest
      || request.claimToken !== source.claim.claimToken
      || request.wallet !== claimContext.preflight.from
      || request.wallet !== claimContext.request.wallet
      || request.sessionDigest !== claimContext.request.sessionDigest
      || request.requesterKeyId !== claimContext.request.requesterKeyId
      || BigInt(request.beforeChainId).toString() !== claimContext.preflight.chainId
      || request.beforeAccounts[0] !== claimContext.preflight.from
      || request.contextObservedAt < claimContext.preflight.preparedAt
      || request.contextObservedAt >= claimContext.preflight.expiresAt
      || request.outcomeObservedAt >= source.claim.reportExpiresAt
      || request.requestedAt >= source.claim.reportExpiresAt
      || response.requestId !== request.requestId
      || response.requestDigest !== request.requestDigest
      || response.contractIntentDigest !== source.claim.contractIntentDigest
      || response.state !== expectedState
      || response.transactionHash !== request.outcome.transactionHash
      || response.recordedAt < request.requestedAt - MAXIMUM_CLOCK_SKEW_SECONDS
      || response.recordedAt >= request.expiresAt
      || response.recordedAt >= source.claim.reportExpiresAt) {
    throw new Error("wallet gateway outcome response changed the submitted outcome");
  }
  const verified = Object.freeze({ ...response });
  VERIFIED_OUTCOME_RESPONSES.add(verified);
  return verified;
}

export function verifiedContractIntentWalletGatewayOutcomeResponse(value) {
  if (!VERIFIED_OUTCOME_RESPONSES.has(value)) {
    throw new TypeError("wallet gateway outcome response lacks verified provenance");
  }
  return value;
}

function normalizedOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new TypeError("wallet gateway API origin is invalid");
  }
  let url;
  try { url = new URL(value); } catch { throw new TypeError("wallet gateway API origin is invalid"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")
      || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash || !isPrivateLndHostname(url.hostname)) {
    throw new TypeError("wallet gateway API origin must be private production HTTPS on port 443");
  }
  return url.origin;
}

async function strictRequestJson(request, maximumBytes, signal) {
  const contentType = String(request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("wallet gateway content type is invalid");
  const encoding = String(request.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (encoding !== "identity" || request.headers.has("transfer-encoding")) {
    throw new Error("wallet gateway request framing is unsupported");
  }
  const declaredRaw = request.headers.get("content-length");
  if (declaredRaw === null || !/^(?:0|[1-9][0-9]*)$/.test(declaredRaw)) {
    throw new Error("wallet gateway content length is required");
  }
  const declared = Number(declaredRaw);
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > maximumBytes) {
    throw new Error("wallet gateway request is too large or empty");
  }
  if (!request.body || typeof request.body.getReader !== "function") {
    throw new Error("wallet gateway request body is missing");
  }
  const reader = request.body.getReader();
  const abort = () => { try { reader.cancel(); } catch {} };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("wallet gateway request was interrupted");
      const frame = await reader.read();
      if (frame.done) break;
      if (!(frame.value instanceof Uint8Array)) throw new Error("wallet gateway request body is invalid");
      received += frame.value.byteLength;
      if (received > maximumBytes) throw new Error("wallet gateway request is too large");
      chunks.push(Buffer.from(frame.value));
    }
    if (received !== declared) throw new Error("wallet gateway content length changed");
    const bytes = Buffer.concat(chunks);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error("wallet gateway byte order mark is forbidden");
    }
    const text = new NodeTextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-type": "application/json; charset=utf-8",
      "cross-origin-resource-policy": "same-site",
      "pragma": "no-cache",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function rejectedResponse(status = 400) {
  return jsonResponse(status, Object.freeze({ error: "wallet intent gateway request rejected" }));
}

function systemRandomBytes(size) {
  return nodeRandomBytes(size);
}

function systemClock() {
  return Math.floor(Date.now() / 1_000);
}

function tokenDigest(value) {
  return digest({ claimToken: value });
}

function createGateway(input, injected) {
  const fields = injected ? [
    "apiOrigin",
    "clock",
    "maximumInFlightRequests",
    "maximumProcessingMilliseconds",
    "maximumRequestBytes",
    "maximumResponseBytes",
    "randomBytes",
    "requesterPublicKey",
    "responsePrivateKey",
    "signal",
    "store",
  ] : [
    "apiOrigin",
    "maximumInFlightRequests",
    "maximumProcessingMilliseconds",
    "maximumRequestBytes",
    "maximumResponseBytes",
    "requesterPublicKey",
    "responsePrivateKey",
    "signal",
    "store",
  ];
  const source = exactRecord(input, fields, "contract-intent wallet gateway options");
  const requesterPublicKey = publicKey(source.requesterPublicKey, "wallet gateway requester public key");
  const responsePrivateKey = privateKey(source.responsePrivateKey, "wallet gateway response private key");
  const expectedRequesterKeyId = contractIntentWalletGatewayKeyId(requesterPublicKey);
  const responseKeyId = contractIntentWalletGatewayKeyId(responsePrivateKey);
  if (expectedRequesterKeyId === responseKeyId) {
    throw new Error("wallet gateway requester and response keys must be separate");
  }
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("wallet gateway requires an active deployment AbortSignal");
  }
  const context = {
    apiOrigin: normalizedOrigin(source.apiOrigin),
    claims: new Map(),
    clock: injected ? source.clock : systemClock,
    completed: 0,
    failed: 0,
    inFlight: 0,
    maximumInFlightRequests: integer(
      source.maximumInFlightRequests,
      "wallet gateway maximum in-flight requests",
      1,
      DEFAULT_MAXIMUM_IN_FLIGHT,
    ),
    maximumProcessingMilliseconds: integer(
      source.maximumProcessingMilliseconds,
      "wallet gateway maximum processing time",
      1,
      DEFAULT_MAXIMUM_PROCESSING_MILLISECONDS,
    ),
    maximumRequestBytes: integer(
      source.maximumRequestBytes,
      "wallet gateway maximum request bytes",
      1_024,
      DEFAULT_MAXIMUM_REQUEST_BYTES,
    ),
    maximumResponseBytes: integer(
      source.maximumResponseBytes,
      "wallet gateway maximum response bytes",
      1_024,
      DEFAULT_MAXIMUM_RESPONSE_BYTES,
    ),
    outcomesRecorded: 0,
    randomBytes: injected ? source.randomBytes : systemRandomBytes,
    requesterPublicKey,
    expectedRequesterKeyId,
    responsePrivateKey,
    responseKeyId,
    signal: source.signal,
    staged: new Map(),
    started: 0,
    state: "active",
    store: source.store,
  };
  if (typeof context.clock !== "function" || typeof context.randomBytes !== "function") {
    throw new TypeError("test wallet gateway clock and entropy must be functions");
  }
  const stop = () => {
    if (context.state === "stopped") return;
    context.state = "stopped";
    context.claims.clear();
    context.staged.clear();
  };
  source.signal.addEventListener("abort", stop, { once: true });

  const prune = (now) => {
    for (const [requestDigest, staged] of context.staged) {
      if (staged.preflight.expiresAt <= now) context.staged.delete(requestDigest);
    }
    for (const [claimDigest, claim] of context.claims) {
      if (claim.reportExpiresAt <= now) context.claims.delete(claimDigest);
    }
  };

  const gateway = Object.freeze({
    stage(preflight, inputValue) {
      if (this !== gateway || GATEWAYS.get(this) !== context || context.state !== "active") {
        throw new TypeError("wallet gateway staging requires the original active gateway");
      }
      const sourceValue = exactRecord(inputValue, ["now"], "wallet gateway staging");
      const now = integer(sourceValue.now, "wallet gateway staging time", 1);
      const artifact = contractIntentWalletJournalArtifact(preflight);
      if (artifact.kind !== "PREFLIGHT" || now < preflight.preparedAt || now >= preflight.expiresAt) {
        throw new Error("wallet gateway preflight is not live");
      }
      if (preflight.expiresAt + MAXIMUM_REPORT_GRACE_SECONDS
          > now + MAXIMUM_CLAIM_LIFETIME_SECONDS) {
        throw new Error("wallet gateway preflight exceeds the bounded claim lifetime");
      }
      const responseMaterialBytes = Buffer.byteLength(JSON.stringify({
        request: preflight.request,
        review: preflight.review,
      }), "utf8") + 2_048;
      if (responseMaterialBytes > context.maximumResponseBytes) {
        throw new Error("wallet gateway preflight exceeds the bounded response size");
      }
      prune(now);
      if (context.staged.size >= MAXIMUM_STAGED_PREFLIGHTS) {
        throw new Error("wallet gateway staged-preflight bound is exhausted");
      }
      if (context.staged.has(preflight.requestDigest)) {
        throw new Error("wallet gateway preflight is already staged");
      }
      context.staged.set(preflight.requestDigest, Object.freeze({ preflight }));
      return Object.freeze({
        schema: "treeswap.contract-intent-wallet-gateway-stage.v1",
        requestDigest: preflight.requestDigest,
        expiresAt: preflight.expiresAt,
        browserClaimAuthority: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
    async handle(webRequest) {
      if (this !== gateway || GATEWAYS.get(this) !== context) {
        throw new TypeError("wallet gateway requests require the original gateway");
      }
      context.started += 1;
      const saturated = context.inFlight >= context.maximumInFlightRequests;
      context.inFlight += 1;
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal.addEventListener("abort", abort, { once: true });
      webRequest?.signal?.addEventListener?.("abort", abort, { once: true });
      const timer = setTimeout(abort, context.maximumProcessingMilliseconds);
      try {
        if (context.state !== "active" || saturated || !(webRequest instanceof Request)) {
          throw new Error("wallet gateway request is unavailable");
        }
        const url = new URL(webRequest.url);
        if (url.origin !== context.apiOrigin
            || !["/v1/wallet-intent/claim", "/v1/wallet-intent/outcome"].includes(url.pathname)
            || url.search || url.hash || webRequest.method !== "POST"
            || webRequest.headers.has("origin") || webRequest.headers.has("cookie")
            || webRequest.headers.has("authorization")) {
          throw new Error("wallet gateway target or credentials are invalid");
        }
        const body = await strictRequestJson(webRequest, context.maximumRequestBytes, controller.signal);
        if (controller.signal.aborted) throw new Error("wallet gateway request was aborted");
        const now = integer(context.clock(), "wallet gateway clock", 1);
        prune(now);
        let response;
        if (url.pathname === "/v1/wallet-intent/claim") {
          const request = verifySignedRequest(
            body,
            "CLAIM",
            context.requesterPublicKey,
            context.expectedRequesterKeyId,
            now,
          );
          const staged = context.staged.get(request.requestDigest);
          if (!staged || request.wallet !== staged.preflight.from
              || request.expiresAt > staged.preflight.expiresAt) {
            throw new Error("wallet gateway claim does not match a staged preflight");
          }
          if (context.claims.size >= MAXIMUM_ACTIVE_CLAIMS) {
            throw new Error("wallet gateway active-claim bound is exhausted");
          }
          const entropy = context.randomBytes(32);
          if ((!Buffer.isBuffer(entropy) && !(entropy instanceof Uint8Array)) || entropy.byteLength !== 32) {
            throw new Error("wallet gateway entropy source is invalid");
          }
          const claimToken = Buffer.from(entropy).toString("hex");
          token(claimToken, "wallet gateway generated claim token");
          const claimDigest = tokenDigest(claimToken);
          if (context.claims.has(claimDigest)) throw new Error("wallet gateway claim token collided");
          const reportExpiresAt = staged.preflight.expiresAt + MAXIMUM_REPORT_GRACE_SECONDS;
          const unsignedResponse = Object.freeze({
            schema: CONTRACT_INTENT_WALLET_GATEWAY_RESPONSE_SCHEMA,
            kind: "CLAIMED",
            requestId: request.requestId,
            requestDigest: staged.preflight.requestDigest,
            contractIntentDigest: staged.preflight.contractIntentDigest,
            claimToken,
            request: staged.preflight.request,
            review: staged.preflight.review,
            issuedAt: now,
            dispatchExpiresAt: staged.preflight.expiresAt,
            reportExpiresAt,
            responseKeyId: context.responseKeyId,
          });
          response = signResponse(unsignedResponse, context.responsePrivateKey);
          normalizeClaimResponse(response);
          if (Buffer.byteLength(JSON.stringify(response), "utf8") > context.maximumResponseBytes) {
            throw new Error("wallet gateway claim response exceeds the configured bound");
          }
          claimContractIntentWalletForDispatch(context.store, staged.preflight, { now });
          context.claims.set(claimDigest, {
            outcomeDigest: null,
            outcomeResponse: null,
            preflight: staged.preflight,
            reportExpiresAt,
            sessionDigest: request.sessionDigest,
            wallet: request.wallet,
          });
          context.staged.delete(request.requestDigest);
        } else {
          const request = verifySignedRequest(
            body,
            "OUTCOME",
            context.requesterPublicKey,
            context.expectedRequesterKeyId,
            now,
          );
          const claim = context.claims.get(tokenDigest(request.claimToken));
          if (!claim || request.requestDigest !== claim.preflight.requestDigest
              || request.wallet !== claim.wallet || request.sessionDigest !== claim.sessionDigest
              || request.contextObservedAt < claim.preflight.preparedAt
              || request.contextObservedAt >= claim.preflight.expiresAt
              || request.outcomeObservedAt > request.requestedAt
              || request.outcomeObservedAt >= claim.reportExpiresAt
              || now >= claim.reportExpiresAt) {
            throw new Error("wallet gateway outcome does not match its live claim");
          }
          const outcomeDigest = request.signedRequestDigest;
          if (claim.outcomeDigest !== null) {
            if (claim.outcomeDigest !== outcomeDigest || claim.outcomeResponse === null) {
              throw new Error("wallet gateway claim already has another outcome");
            }
            response = claim.outcomeResponse;
          } else {
            const walletContext = verifyContractIntentWalletContext({
              accounts: request.beforeAccounts,
              chainId: request.beforeChainId,
              now: request.contextObservedAt,
              preflight: claim.preflight,
            });
            const submission = recordContractIntentWalletOutcome({
              accounts: request.postAccounts,
              chainId: request.postChainId,
              context: walletContext,
              now: request.outcomeObservedAt,
              outcome: request.outcome,
            });
            context.store.record(submission, { now });
            const unsignedResponse = Object.freeze({
              schema: CONTRACT_INTENT_WALLET_GATEWAY_RESPONSE_SCHEMA,
              kind: "RECORDED",
              requestId: request.requestId,
              requestDigest: submission.requestDigest,
              contractIntentDigest: submission.contractIntentDigest,
              state: submission.state,
              transactionHash: submission.transactionHash,
              recordedAt: now,
              retryAuthorized: false,
              walletDispatchAuthority: false,
              canonicalFinalizedReservation: false,
              independentProviderOperationVerified: false,
              lightningDispatchAuthority: false,
              fundingAuthorization: false,
              responseKeyId: context.responseKeyId,
            });
            response = signResponse(unsignedResponse, context.responsePrivateKey);
            normalizeOutcomeResponse(response);
            claim.outcomeDigest = outcomeDigest;
            claim.outcomeResponse = response;
            context.outcomesRecorded += 1;
          }
        }
        if (controller.signal.aborted) throw new Error("wallet gateway request was aborted");
        if (Buffer.byteLength(JSON.stringify(response), "utf8") > context.maximumResponseBytes) {
          throw new Error("wallet gateway response exceeds the configured bound");
        }
        context.completed += 1;
        return jsonResponse(200, response);
      } catch {
        context.failed += 1;
        return rejectedResponse(400);
      } finally {
        clearTimeout(timer);
        controller.abort();
        context.inFlight -= 1;
        context.signal.removeEventListener("abort", abort);
        webRequest?.signal?.removeEventListener?.("abort", abort);
      }
    },
    status() {
      if (this !== gateway || GATEWAYS.get(this) !== context) {
        throw new TypeError("wallet gateway status requires the original gateway");
      }
      return Object.freeze({
        schema: "treeswap.contract-intent-wallet-gateway-status.v1",
        state: context.state,
        stagedPreflights: context.staged.size,
        activeClaims: context.claims.size,
        requestsStarted: context.started,
        requestsCompleted: context.completed,
        requestsRejected: context.failed,
        requestsInFlight: context.inFlight,
        outcomesRecorded: context.outcomesRecorded,
        claimTokensInStatus: false,
        walletsInStatus: false,
        sessionDigestsInStatus: false,
        networkListener: false,
        browserWalletProvider: false,
        automaticClaimReplay: false,
        automaticWalletRetry: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
    stop() {
      if (this !== gateway || GATEWAYS.get(this) !== context) {
        throw new TypeError("wallet gateway stop requires the original gateway");
      }
      stop();
      return this.status();
    },
  });
  GATEWAYS.set(gateway, context);
  return gateway;
}

export function createContractIntentWalletGateway(input) {
  return createGateway(input, false);
}

export function createContractIntentWalletGatewayForTests(input) {
  return createGateway(input, true);
}
