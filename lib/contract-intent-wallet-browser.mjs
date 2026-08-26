import { getAddress, keccak256, toUtf8Bytes } from "ethers";

export const CONTRACT_INTENT_WALLET_BROWSER_CLAIM_SCHEMA =
  "treeswap.contract-intent-wallet-browser-claim.v1";
export const CONTRACT_INTENT_WALLET_BROWSER_RESULT_SCHEMA =
  "treeswap.contract-intent-wallet-browser-result.v1";
export const CONTRACT_INTENT_WALLET_BROWSER_REPORT_SCHEMA =
  "treeswap.contract-intent-wallet-browser-report.v1";

const GATEWAY_RESPONSE_SCHEMA = "treeswap.contract-intent-wallet-gateway-response.v1";
const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const TOKEN = /^(?!0{64}$)[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const QUANTITY = /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/;
const CALLDATA = /^0x(?:[0-9a-f]{2})+$/;
const DECIMAL = /^[1-9][0-9]*$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAXIMUM_CLOCK_SKEW_SECONDS = 5;
const MAXIMUM_CLAIM_LIFETIME_SECONDS = 20 * 60;
const MAXIMUM_CALLDATA_BYTES = 16 * 1024;
const MAXIMUM_VERIFIED_CLAIMS = 128;
const MAXIMUM_TOMBSTONES = 128;
const MAXIMUM_TOMBSTONE_BYTES = 32 * 1024;
const MAXIMUM_SPKI_BYTES = 128;
const DEFAULT_WALLET_TIMEOUT_MS = 10 * 60 * 1_000;
const WALLET_REVIEW_EFFECT =
  "Submits this exact zero-ETH escrow call. It is not a token approval and does not authorize Lightning by itself.";
const WALLET_REVIEW_TITLES = new Set(["Lock BIT for Lightning", "Reserve solver BIT"]);
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
const CLAIM_EXPECTATION_FIELDS = Object.freeze([
  "calldataDigest",
  "chainId",
  "contract",
  "contractIntentDigest",
  "dispatchExpiresAt",
  "quoteId",
  "requestDigest",
  "wallet",
]);
const CLAIM_RESPONSE_EXACT_FIELDS = CLAIM_RESPONSE_FIELDS;
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
const CONFIRMATION_FIELDS = Object.freeze(["confirmed", "requestDigest"]);
const DISPATCH_INPUT_FIELDS = Object.freeze(["claim", "confirmation"]);
const ADAPTERS = new WeakMap();
const TOMBSTONE_CONSUMERS = new WeakMap();
const VERIFIED_CLAIMS = new WeakMap();
const VERIFIED_CLAIM_DIGESTS = new Map();
const IN_FLIGHT_CLAIMS = new WeakSet();
const CONSUMED_CLAIMS = new WeakSet();
const TOMBSTONE_STORAGE_KEY = "treeswap:wallet-intent:no-resend:v1";
const TOMBSTONE_LOCK_NAME = "treeswap-wallet-intent-no-resend-v1";

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
  if (typeof value !== "string" || value.length > 66 || !QUANTITY.test(value)
      || BigInt(value) > MAX_UINT256) {
    throw new TypeError(`${name} must be a canonical JSON-RPC quantity`);
  }
  return value;
}

function decimal(value, name) {
  if (typeof value !== "string" || !DECIMAL.test(value) || BigInt(value) > MAX_UINT256) {
    throw new TypeError(`${name} must be a canonical uint256 decimal`);
  }
  return value;
}

function canonicalize(value, depth = 0) {
  if (depth > 12) throw new RangeError("wallet browser value is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("wallet browser numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = exactDenseArray(value, 128, "wallet browser canonical array");
    return `[${entries.map((entry) => canonicalize(entry, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("wallet browser values must contain plain data only");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("wallet browser values cannot contain symbols");
    }
    keys.sort();
    return `{${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new TypeError("wallet browser values require enumerable data properties");
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  }
  throw new TypeError("wallet browser value contains unsupported data");
}

function digest(value) {
  return keccak256(toUtf8Bytes(canonicalize(value))).toLowerCase();
}

function base64Bytes(value, name, maximumBytes) {
  if (typeof value !== "string" || !BASE64.test(value) || value.length > maximumBytes * 2) {
    throw new TypeError(`${name} must be bounded canonical base64`);
  }
  let decoded;
  try {
    const binary = globalThis.atob(value);
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError(`${name} must be bounded canonical base64`);
  }
  if (decoded.byteLength === 0 || decoded.byteLength > maximumBytes) {
    throw new TypeError(`${name} must be bounded canonical base64`);
  }
  const canonical = globalThis.btoa(String.fromCharCode(...decoded));
  if (canonical !== value) throw new TypeError(`${name} must be canonical base64`);
  return decoded;
}

function unsigned(value, fields) {
  return Object.freeze(Object.fromEntries(fields
    .filter((field) => field !== "signature")
    .map((field) => [field, value[field]])));
}

function normalizeWalletRequest(raw) {
  const source = exactRecord(raw, WALLET_REQUEST_FIELDS, "wallet browser transaction request");
  if (source.method !== "eth_sendTransaction") throw new Error("wallet browser method is unsupported");
  const params = exactDenseArray(source.params, 1, "wallet browser transaction params", 1);
  const transaction = exactRecord(params[0], WALLET_TRANSACTION_FIELDS, "wallet browser transaction");
  if (typeof transaction.data !== "string" || transaction.data.length > 2 + (MAXIMUM_CALLDATA_BYTES * 2)
      || !CALLDATA.test(transaction.data)
      || transaction.value !== "0x0") {
    throw new Error("wallet browser transaction must be canonical zero-ETH escrow calldata");
  }
  return Object.freeze({
    method: source.method,
    params: Object.freeze([Object.freeze({
      data: transaction.data,
      from: address(transaction.from, "wallet browser transaction sender"),
      to: address(transaction.to, "wallet browser transaction target"),
      value: transaction.value,
    })]),
  });
}

function normalizeReview(raw) {
  const source = exactRecord(raw, REVIEW_FIELDS, "wallet browser review");
  if (!WALLET_REVIEW_TITLES.has(source.title) || source.effect !== WALLET_REVIEW_EFFECT) {
    throw new Error("wallet browser review text is invalid");
  }
  return Object.freeze({
    title: source.title,
    effect: source.effect,
    chainId: decimal(source.chainId, "wallet browser review chain"),
    account: address(source.account, "wallet browser review account"),
    contract: address(source.contract, "wallet browser review contract"),
    quoteId: bytes32(source.quoteId, "wallet browser review quote ID"),
    contractIntentDigest: bytes32(
      source.contractIntentDigest,
      "wallet browser review contract intent digest",
    ),
    calldataDigest: bytes32(source.calldataDigest, "wallet browser review calldata digest"),
    expiresAt: integer(source.expiresAt, "wallet browser review expiry", 1),
  });
}

function normalizeClaimResponse(raw) {
  const source = exactRecord(raw, CLAIM_RESPONSE_EXACT_FIELDS, "wallet browser claim response");
  if (source.schema !== GATEWAY_RESPONSE_SCHEMA || source.kind !== "CLAIMED") {
    throw new Error("wallet browser claim response schema is unsupported");
  }
  const response = Object.freeze({
    schema: source.schema,
    kind: source.kind,
    requestId: bytes32(source.requestId, "wallet browser claim request ID"),
    requestDigest: bytes32(source.requestDigest, "wallet browser preflight digest"),
    contractIntentDigest: bytes32(source.contractIntentDigest, "wallet browser contract intent digest"),
    claimToken: token(source.claimToken, "wallet browser claim token"),
    request: normalizeWalletRequest(source.request),
    review: normalizeReview(source.review),
    issuedAt: integer(source.issuedAt, "wallet browser claim issue time", 1),
    dispatchExpiresAt: integer(source.dispatchExpiresAt, "wallet browser dispatch expiry", 1),
    reportExpiresAt: integer(source.reportExpiresAt, "wallet browser report expiry", 1),
    responseKeyId: bytes32(source.responseKeyId, "wallet browser response key ID"),
    signature: source.signature,
  });
  if (response.dispatchExpiresAt <= response.issuedAt
      || response.reportExpiresAt <= response.dispatchExpiresAt
      || response.reportExpiresAt - response.issuedAt > MAXIMUM_CLAIM_LIFETIME_SECONDS
      || typeof response.signature !== "string" || !BASE64_SIGNATURE.test(response.signature)) {
    throw new Error("wallet browser claim response window or signature is invalid");
  }
  return response;
}

function normalizeExpectation(raw) {
  const source = exactRecord(raw, CLAIM_EXPECTATION_FIELDS, "wallet browser claim expectation");
  return Object.freeze({
    requestDigest: bytes32(source.requestDigest, "wallet browser expected request digest"),
    contractIntentDigest: bytes32(
      source.contractIntentDigest,
      "wallet browser expected contract intent digest",
    ),
    wallet: address(source.wallet, "wallet browser expected wallet"),
    chainId: decimal(source.chainId, "wallet browser expected chain"),
    contract: address(source.contract, "wallet browser expected contract"),
    quoteId: bytes32(source.quoteId, "wallet browser expected quote ID"),
    calldataDigest: bytes32(source.calldataDigest, "wallet browser expected calldata digest"),
    dispatchExpiresAt: integer(source.dispatchExpiresAt, "wallet browser expected expiry", 1),
  });
}

function responseMessage(responseDigest) {
  return new TextEncoder().encode(
    `TreeSwap contract intent wallet gateway response v1\n${responseDigest}\n`,
  );
}

async function importResponseKey(spkiBytes, subtle) {
  try {
    return await subtle.importKey("spki", spkiBytes, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new TypeError("wallet browser response key must be an Ed25519 SPKI key");
  }
}

async function verifyClaim(input, subtle) {
  const source = exactRecord(input, [
    "expected",
    "now",
    "response",
    "responsePublicKeySpki",
  ], "wallet browser claim verification");
  const expected = normalizeExpectation(source.expected);
  const response = normalizeClaimResponse(source.response);
  const observedAt = integer(source.now, "wallet browser claim verification time", 1);
  const spki = base64Bytes(source.responsePublicKeySpki, "wallet browser response SPKI", MAXIMUM_SPKI_BYTES);
  const responseKeyId = keccak256(spki).toLowerCase();
  if (response.responseKeyId !== responseKeyId) throw new Error("wallet browser response key changed");
  const responseDigest = digest(unsigned(response, CLAIM_RESPONSE_FIELDS));
  const signature = base64Bytes(response.signature, "wallet browser response signature", 64);
  const key = await importResponseKey(spki, subtle);
  if (!await subtle.verify({ name: "Ed25519" }, key, signature, responseMessage(responseDigest))) {
    throw new Error("wallet browser claim response signature is invalid");
  }
  const transaction = response.request.params[0];
  if (observedAt < response.issuedAt - MAXIMUM_CLOCK_SKEW_SECONDS
      || observedAt >= response.dispatchExpiresAt
      || response.requestDigest !== expected.requestDigest
      || response.contractIntentDigest !== expected.contractIntentDigest
      || response.dispatchExpiresAt !== expected.dispatchExpiresAt
      || response.review.expiresAt !== expected.dispatchExpiresAt
      || response.review.account !== expected.wallet
      || response.review.chainId !== expected.chainId
      || response.review.contract !== expected.contract
      || response.review.quoteId !== expected.quoteId
      || response.review.contractIntentDigest !== expected.contractIntentDigest
      || response.review.calldataDigest !== expected.calldataDigest
      || transaction.from !== expected.wallet
      || transaction.to !== expected.contract
      || keccak256(transaction.data).toLowerCase() !== expected.calldataDigest) {
    throw new Error("wallet browser claim changed the expected contract intent");
  }
  const claimDigest = digest({
    claimToken: response.claimToken,
    requestId: response.requestId,
    responseKeyId: response.responseKeyId,
  });
  for (const [retainedDigest, expiresAt] of VERIFIED_CLAIM_DIGESTS) {
    if (expiresAt <= observedAt) VERIFIED_CLAIM_DIGESTS.delete(retainedDigest);
  }
  if (VERIFIED_CLAIM_DIGESTS.has(claimDigest)) {
    throw new Error("wallet browser claim response was already verified in this page");
  }
  if (VERIFIED_CLAIM_DIGESTS.size >= MAXIMUM_VERIFIED_CLAIMS) {
    throw new Error("wallet browser verified-claim bound is exhausted");
  }
  const claim = Object.freeze({
    schema: CONTRACT_INTENT_WALLET_BROWSER_CLAIM_SCHEMA,
    requestId: response.requestId,
    requestDigest: response.requestDigest,
    contractIntentDigest: response.contractIntentDigest,
    claimToken: response.claimToken,
    request: response.request,
    review: response.review,
    issuedAt: response.issuedAt,
    dispatchExpiresAt: response.dispatchExpiresAt,
    reportExpiresAt: response.reportExpiresAt,
    responseKeyId: response.responseKeyId,
    claimVerified: true,
    durableNoResendTombstoneRequired: true,
    persistentClaimToken: false,
    retryAuthorized: false,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
  VERIFIED_CLAIM_DIGESTS.set(claimDigest, response.reportExpiresAt);
  VERIFIED_CLAIMS.set(claim, Object.freeze({ expected }));
  return claim;
}

export async function verifyContractIntentWalletBrowserClaim(input) {
  if (!globalThis.crypto?.subtle) throw new Error("wallet browser Web Crypto is unavailable");
  return verifyClaim(input, globalThis.crypto.subtle);
}

function systemClock() {
  return Math.floor(Date.now() / 1_000);
}

function systemUserActivation() {
  return globalThis.navigator?.userActivation?.isActive === true;
}

function claimTombstoneDigest(claim) {
  return digest({
    requestId: claim.requestId,
    responseKeyId: claim.responseKeyId,
  });
}

function tombstoneRecord(raw, now) {
  if (raw === null) {
    return Object.freeze({
      schema: "treeswap.contract-intent-wallet-browser-tombstones.v1",
      clockHighWater: now,
      entries: Object.freeze([]),
    });
  }
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAXIMUM_TOMBSTONE_BYTES) {
    throw new Error("wallet browser no-resend tombstones are malformed");
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("wallet browser no-resend tombstones are malformed"); }
  const source = exactRecord(
    parsed,
    ["clockHighWater", "entries", "schema"],
    "wallet browser no-resend tombstones",
  );
  if (source.schema !== "treeswap.contract-intent-wallet-browser-tombstones.v1") {
    throw new Error("wallet browser no-resend tombstone schema changed");
  }
  const clockHighWater = integer(source.clockHighWater, "wallet browser tombstone clock", 1);
  if (now < clockHighWater) throw new Error("wallet browser tombstone clock regressed");
  const entries = exactDenseArray(
    source.entries,
    MAXIMUM_TOMBSTONES,
    "wallet browser no-resend tombstone entries",
  ).map((entry, index) => {
    const normalized = exactRecord(
      entry,
      ["digest", "expiresAt"],
      `wallet browser no-resend tombstone ${index}`,
    );
    return Object.freeze({
      digest: bytes32(normalized.digest, `wallet browser tombstone ${index} digest`),
      expiresAt: integer(normalized.expiresAt, `wallet browser tombstone ${index} expiry`, 1),
    });
  });
  if (new Set(entries.map((entry) => entry.digest)).size !== entries.length) {
    throw new Error("wallet browser no-resend tombstones contain a duplicate");
  }
  return Object.freeze({
    schema: source.schema,
    clockHighWater: now,
    entries: Object.freeze(entries.filter((entry) => entry.expiresAt > now)),
  });
}

async function consumeClaimTombstone(claim, { locks, now, storage }) {
  if (!locks || typeof locks.request !== "function" || !storage
      || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw new Error("wallet browser durable no-resend storage is unavailable");
  }
  integer(now, "wallet browser tombstone observation time", 1);
  const claimDigest = claimTombstoneDigest(claim);
  let consumed = false;
  await locks.request(TOMBSTONE_LOCK_NAME, { mode: "exclusive" }, () => {
    const current = tombstoneRecord(storage.getItem(TOMBSTONE_STORAGE_KEY), now);
    if (current.entries.some((entry) => entry.digest === claimDigest)) {
      throw new Error("wallet browser claim already has a durable no-resend tombstone");
    }
    if (current.entries.length >= MAXIMUM_TOMBSTONES) {
      throw new Error("wallet browser no-resend tombstone bound is exhausted");
    }
    const next = Object.freeze({
      schema: current.schema,
      clockHighWater: now,
      entries: Object.freeze(current.entries.concat(Object.freeze({
        digest: claimDigest,
        expiresAt: claim.reportExpiresAt,
      }))),
    });
    const serialized = JSON.stringify(next);
    if (serialized.length > MAXIMUM_TOMBSTONE_BYTES) {
      throw new Error("wallet browser no-resend tombstone record is too large");
    }
    storage.setItem(TOMBSTONE_STORAGE_KEY, serialized);
    if (storage.getItem(TOMBSTONE_STORAGE_KEY) !== serialized) {
      throw new Error("wallet browser no-resend tombstone could not be verified");
    }
    consumed = true;
  });
  if (!consumed) throw new Error("wallet browser no-resend tombstone was not consumed");
}

async function consumeProductionClaimTombstone(claim) {
  return consumeClaimTombstone(claim, {
    locks: globalThis.navigator?.locks,
    now: systemClock(),
    storage: globalThis.localStorage,
  });
}

export function createContractIntentWalletBrowserTombstoneConsumerForTests(input) {
  const source = exactRecord(
    input,
    ["clock", "locks", "storage"],
    "test wallet browser tombstone consumer options",
  );
  if (typeof source.clock !== "function") {
    throw new TypeError("test wallet browser tombstone clock must be a function");
  }
  const consumer = Object.freeze({
    async consume(claim) {
      if (this !== consumer || !TOMBSTONE_CONSUMERS.has(this)) {
        throw new TypeError("wallet browser tombstone consumption requires the original consumer");
      }
      if (!VERIFIED_CLAIMS.has(claim)) {
        throw new TypeError("wallet browser tombstone requires an original verified claim");
      }
      return consumeClaimTombstone(claim, {
        locks: source.locks,
        now: integer(source.clock(), "test wallet browser tombstone clock", 1),
        storage: source.storage,
      });
    },
  });
  TOMBSTONE_CONSUMERS.set(consumer, Object.freeze({ storage: source.storage }));
  return consumer;
}

function walletRequest(provider) {
  if ((!provider || (typeof provider !== "object" && typeof provider !== "function"))
      || typeof provider.request !== "function") {
    throw new TypeError("wallet browser adapter requires an EIP-1193 wallet provider");
  }
  return provider.request.bind(provider);
}

function withDeadline(operation, timeoutMs, phase) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${phase} timed out`)), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

function exactUserRejection(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return Boolean(descriptor && Object.hasOwn(descriptor, "value") && descriptor.value === 4001);
}

function classifiedOutcome(response, error) {
  if (error === null && typeof response === "string" && BYTES32.test(response)) {
    return Object.freeze({ errorCode: null, status: "reported", transactionHash: response });
  }
  if (error !== null && exactUserRejection(error)) {
    return Object.freeze({ errorCode: 4001, status: "rejected", transactionHash: null });
  }
  return Object.freeze({ errorCode: null, status: "ambiguous", transactionHash: null });
}

function normalizedAccounts(raw, minimum, name) {
  return Object.freeze(exactDenseArray(raw, 32, name, minimum)
    .map((entry, index) => address(entry, `${name}[${index}]`)));
}

async function readContext(request, timeoutMs) {
  const [chainId, accounts] = await Promise.all([
    withDeadline(() => request(Object.freeze({ method: "eth_chainId" })), timeoutMs, "wallet chain read"),
    withDeadline(() => request(Object.freeze({ method: "eth_accounts" })), timeoutMs, "wallet account read"),
  ]);
  return Object.freeze({
    chainId: quantity(chainId, "wallet browser chain ID"),
    accounts: normalizedAccounts(accounts, 1, "wallet browser accounts"),
  });
}

async function readPostContext(request, timeoutMs) {
  const results = await Promise.allSettled([
    withDeadline(() => request(Object.freeze({ method: "eth_chainId" })), timeoutMs, "wallet post-chain read"),
    withDeadline(() => request(Object.freeze({ method: "eth_accounts" })), timeoutMs, "wallet post-account read"),
  ]);
  if (results.some((result) => result.status !== "fulfilled")) {
    return Object.freeze({ accounts: null, chainId: null });
  }
  try {
    return Object.freeze({
      chainId: quantity(results[0].value, "wallet browser post-chain ID"),
      accounts: normalizedAccounts(results[1].value, 0, "wallet browser post-accounts"),
    });
  } catch {
    return Object.freeze({ accounts: null, chainId: null });
  }
}

export class ContractIntentWalletBrowserError extends Error {
  constructor(message, {
    code,
    claimConsumed,
    phase,
    requestMayHaveBeenSent,
    transactionHash = null,
  }) {
    super(message);
    this.name = "ContractIntentWalletBrowserError";
    this.code = code;
    this.phase = phase;
    this.claimConsumed = claimConsumed;
    this.requestMayHaveBeenSent = requestMayHaveBeenSent;
    this.transactionHash = transactionHash;
    this.retryAuthorized = false;
    this.walletDispatchAuthority = false;
    this.lightningDispatchAuthority = false;
    this.fundingAuthorization = false;
  }
}

function browserError(message, values) {
  return new ContractIntentWalletBrowserError(message, values);
}

function createAdapter({
  clock,
  consumeClaimTombstone,
  provider,
  readUserActivation,
  walletResponseTimeoutMs,
}) {
  if (typeof clock !== "function" || typeof consumeClaimTombstone !== "function"
      || typeof readUserActivation !== "function") {
    throw new TypeError("wallet browser clock, tombstone, and user-activation controls must be functions");
  }
  const request = walletRequest(provider);
  const timeoutMs = integer(
    walletResponseTimeoutMs,
    "wallet browser response timeout",
    1,
    DEFAULT_WALLET_TIMEOUT_MS,
  );
  const adapter = Object.freeze({
    async dispatch(input) {
      if (this !== adapter || !ADAPTERS.has(this)) {
        throw new TypeError("wallet browser dispatch requires the original fixed adapter");
      }
      const source = exactRecord(input, DISPATCH_INPUT_FIELDS, "wallet browser dispatch input");
      const claimContext = VERIFIED_CLAIMS.get(source.claim);
      if (!claimContext) throw new TypeError("wallet browser dispatch requires an original verified claim");
      if (IN_FLIGHT_CLAIMS.has(source.claim) || CONSUMED_CLAIMS.has(source.claim)) {
        throw browserError("this wallet claim is already in progress or consumed", {
          code: "CLAIM_CONSUMED",
          claimConsumed: CONSUMED_CLAIMS.has(source.claim),
          phase: "confirmation",
          requestMayHaveBeenSent: false,
        });
      }
      const confirmation = exactRecord(
        source.confirmation,
        CONFIRMATION_FIELDS,
        "wallet browser confirmation",
      );
      if (confirmation.confirmed !== true
          || confirmation.requestDigest !== source.claim.requestDigest) {
        throw browserError("wallet request was not explicitly confirmed", {
          code: "CONFIRMATION_DECLINED",
          claimConsumed: false,
          phase: "confirmation",
          requestMayHaveBeenSent: false,
        });
      }
      let activated;
      try { activated = readUserActivation(); } catch { activated = false; }
      if (activated !== true) {
        throw browserError("wallet request requires active user interaction", {
          code: "USER_ACTIVATION_REQUIRED",
          claimConsumed: false,
          phase: "confirmation",
          requestMayHaveBeenSent: false,
        });
      }
      const startTime = integer(clock(), "wallet browser dispatch clock", 1);
      if (startTime < source.claim.issuedAt || startTime >= source.claim.dispatchExpiresAt) {
        throw browserError("wallet claim expired before dispatch", {
          code: "REQUEST_EXPIRED",
          claimConsumed: false,
          phase: "confirmation",
          requestMayHaveBeenSent: false,
        });
      }
      IN_FLIGHT_CLAIMS.add(source.claim);
      let requestMayHaveBeenSent = false;
      let reportedHash = null;
      try {
        try {
          await consumeClaimTombstone(source.claim);
        } catch {
          throw browserError("wallet claim could not be durably consumed; do not send", {
            code: "DURABLE_TOMBSTONE_UNAVAILABLE",
            claimConsumed: false,
            phase: "tombstone",
            requestMayHaveBeenSent,
          });
        }
        CONSUMED_CLAIMS.add(source.claim);
        let activationStillLive;
        try { activationStillLive = readUserActivation(); } catch { activationStillLive = false; }
        if (activationStillLive !== true) {
          throw browserError("user interaction expired after durable claim consumption", {
            code: "USER_ACTIVATION_EXPIRED",
            claimConsumed: true,
            phase: "tombstone",
            requestMayHaveBeenSent,
          });
        }
        let before;
        try {
          before = await readContext(request, timeoutMs);
        } catch {
          throw browserError("wallet context could not be read after claim consumption", {
            code: "CONTEXT_UNAVAILABLE",
            claimConsumed: true,
            phase: "context",
            requestMayHaveBeenSent,
          });
        }
        const contextTime = integer(clock(), "wallet browser context clock", startTime);
        const expected = claimContext.expected;
        if (BigInt(before.chainId).toString() !== expected.chainId
            || before.accounts[0] !== expected.wallet
            || contextTime >= source.claim.dispatchExpiresAt) {
          throw browserError("wallet context does not match the consumed contract intent", {
            code: "CONTEXT_MISMATCH",
            claimConsumed: true,
            phase: "context",
            requestMayHaveBeenSent,
          });
        }
        let activationBeforeSend;
        try { activationBeforeSend = readUserActivation(); } catch { activationBeforeSend = false; }
        if (activationBeforeSend !== true) {
          throw browserError("user interaction expired before the wallet request", {
            code: "USER_ACTIVATION_EXPIRED",
            claimConsumed: true,
            phase: "context",
            requestMayHaveBeenSent,
          });
        }
        let response = null;
        let walletError = null;
        requestMayHaveBeenSent = true;
        try {
          response = await withDeadline(
            () => request(source.claim.request),
            timeoutMs,
            "wallet transaction request",
          );
        } catch (error) {
          walletError = error;
        }
        const outcome = classifiedOutcome(response, walletError);
        reportedHash = outcome.transactionHash;
        const post = await readPostContext(request, timeoutMs);
        const outcomeTime = integer(clock(), "wallet browser outcome clock", contextTime);
        const report = outcomeTime >= source.claim.reportExpiresAt
          ? null
          : Object.freeze({
              schema: CONTRACT_INTENT_WALLET_BROWSER_REPORT_SCHEMA,
              requestDigest: source.claim.requestDigest,
              contractIntentDigest: source.claim.contractIntentDigest,
              claimToken: source.claim.claimToken,
              wallet: expected.wallet,
              beforeChainId: before.chainId,
              beforeAccounts: before.accounts,
              postChainId: post.chainId,
              postAccounts: post.accounts,
              contextObservedAt: contextTime,
              outcomeObservedAt: outcomeTime,
              outcome,
              retryAuthorized: false,
              walletDispatchAuthority: false,
              lightningDispatchAuthority: false,
              fundingAuthorization: false,
            });
        return Object.freeze({
          schema: CONTRACT_INTENT_WALLET_BROWSER_RESULT_SCHEMA,
          requestDigest: source.claim.requestDigest,
          contractIntentDigest: source.claim.contractIntentDigest,
          state: report === null ? "OUTCOME_REPORT_EXPIRED" : "OUTCOME_READY",
          transactionHash: outcome.transactionHash,
          outcomeStatus: outcome.status,
          postContextUnavailable: post.chainId === null,
          report,
          claimConsumed: true,
          requestMayHaveBeenSent: true,
          durableNoResendTombstone: true,
          persistentClaimToken: false,
          retryAuthorized: false,
          walletDispatchAuthority: false,
          canonicalFinalizedReservation: false,
          independentProviderOperationVerified: false,
          lightningDispatchAuthority: false,
          fundingAuthorization: false,
        });
      } catch (error) {
        if (error instanceof ContractIntentWalletBrowserError) throw error;
        throw browserError("wallet browser outcome is unknown; reconcile without resend", {
          code: "OUTCOME_UNAVAILABLE",
          claimConsumed: true,
          phase: "outcome",
          requestMayHaveBeenSent,
          transactionHash: reportedHash,
        });
      } finally {
        IN_FLIGHT_CLAIMS.delete(source.claim);
      }
    },
    status() {
      if (this !== adapter || !ADAPTERS.has(this)) {
        throw new TypeError("wallet browser status requires the original fixed adapter");
      }
      return Object.freeze({
        schema: "treeswap.contract-intent-wallet-browser-status.v1",
        state: "ready",
        claimSignatureVerification: "Ed25519 Web Crypto",
        requiresActiveUserInteraction: true,
        automaticRetry: false,
        durableNoResendTombstone: true,
        persistentClaimToken: false,
        requestsWalletConnection: false,
        requestsChainSwitch: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
  });
  ADAPTERS.set(adapter, Object.freeze({ provider }));
  return adapter;
}

export function createContractIntentWalletBrowserAdapter(input) {
  const source = exactRecord(input, ["provider"], "wallet browser adapter options");
  return createAdapter({
    provider: source.provider,
    clock: systemClock,
    consumeClaimTombstone: consumeProductionClaimTombstone,
    readUserActivation: systemUserActivation,
    walletResponseTimeoutMs: DEFAULT_WALLET_TIMEOUT_MS,
  });
}

export function createContractIntentWalletBrowserAdapterForTests(input) {
  const source = exactRecord(input, [
    "clock",
    "consumeClaimTombstone",
    "provider",
    "readUserActivation",
    "walletResponseTimeoutMs",
  ], "test wallet browser adapter options");
  return createAdapter(source);
}

Object.freeze(ContractIntentWalletBrowserError.prototype);
Object.freeze(ContractIntentWalletBrowserError);
