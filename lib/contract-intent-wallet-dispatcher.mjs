import {
  contractIntentWalletJournalArtifact,
  recordContractIntentWalletOutcome,
  verifyContractIntentWalletContext,
} from "./contract-intent-wallet.mjs";
import {
  claimContractIntentWalletForDispatch,
  consumeContractIntentWalletDispatchClaim,
} from "./contract-intent-wallet-store.mjs";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const DEFAULT_WALLET_TIMEOUT_MS = 10 * 60 * 1_000;
const DISPATCHERS = new WeakMap();
const IN_FLIGHT_PREFLIGHTS = new WeakSet();

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

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function systemClock() {
  return Math.floor(Date.now() / 1_000);
}

function walletRequest(provider) {
  if ((!provider || (typeof provider !== "object" && typeof provider !== "function"))
      || typeof provider.request !== "function") {
    throw new TypeError("contract-intent dispatch requires an EIP-1193 wallet provider");
  }
  return provider.request.bind(provider);
}

function withDeadline(operation, timeoutMs, phase) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${phase} timed out`)), timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(operation),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

function confirmationPrompt(preflight) {
  return Object.freeze({
    schema: "treeswap.contract-intent-wallet-dispatch-confirmation.v1",
    requestDigest: preflight.requestDigest,
    review: preflight.review,
    request: preflight.request,
    expiresAt: preflight.expiresAt,
    walletDispatchAuthority: false,
    lightningDispatchAuthority: false,
    fundingAuthorization: false,
  });
}

function exactUserRejection(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return Boolean(descriptor && Object.hasOwn(descriptor, "value") && descriptor.value === 4001);
}

function classifiedOutcome(response, error) {
  if (error === null && typeof response === "string" && BYTES32.test(response)) {
    return Object.freeze({
      errorCode: null,
      status: "reported",
      transactionHash: response,
    });
  }
  if (error !== null && exactUserRejection(error)) {
    return Object.freeze({
      errorCode: 4001,
      status: "rejected",
      transactionHash: null,
    });
  }
  return Object.freeze({
    errorCode: null,
    status: "ambiguous",
    transactionHash: null,
  });
}

async function readContext(request, timeoutMs) {
  return Promise.all([
    withDeadline(() => request(Object.freeze({ method: "eth_chainId" })), timeoutMs, "wallet chain read"),
    withDeadline(() => request(Object.freeze({ method: "eth_accounts" })), timeoutMs, "wallet account read"),
  ]);
}

async function readPostContext(request, timeoutMs) {
  const results = await Promise.allSettled([
    withDeadline(() => request(Object.freeze({ method: "eth_chainId" })), timeoutMs, "wallet post-chain read"),
    withDeadline(() => request(Object.freeze({ method: "eth_accounts" })), timeoutMs, "wallet post-account read"),
  ]);
  if (results.some((result) => result.status !== "fulfilled")) {
    return Object.freeze({ accounts: null, chainId: null });
  }
  return Object.freeze({
    chainId: results[0].value,
    accounts: results[1].value,
  });
}

function recordOutcome({ context, now, outcome, postContext }) {
  try {
    return recordContractIntentWalletOutcome({
      accounts: postContext.accounts,
      chainId: postContext.chainId,
      context,
      now,
      outcome,
    });
  } catch (error) {
    if (postContext.accounts === null && postContext.chainId === null) throw error;
    return recordContractIntentWalletOutcome({
      accounts: null,
      chainId: null,
      context,
      now,
      outcome,
    });
  }
}

export class ContractIntentWalletDispatchError extends Error {
  constructor(message, {
    code,
    durableAttemptCreated,
    phase,
    requestMayHaveBeenSent,
    transactionHash = null,
  }) {
    super(message);
    this.name = "ContractIntentWalletDispatchError";
    this.code = code;
    this.phase = phase;
    this.durableAttemptCreated = durableAttemptCreated;
    this.requestMayHaveBeenSent = requestMayHaveBeenSent;
    this.transactionHash = transactionHash;
    this.retryAuthorized = false;
    this.walletDispatchAuthority = false;
    this.lightningDispatchAuthority = false;
    this.fundingAuthorization = false;
  }
}

function dispatchError(message, values) {
  return new ContractIntentWalletDispatchError(message, values);
}

function buildDispatcher({
  clock,
  provider,
  requestExplicitConfirmation,
  store,
  walletResponseTimeoutMs,
}) {
  if (typeof clock !== "function") throw new TypeError("wallet dispatcher clock must be a function");
  if (typeof requestExplicitConfirmation !== "function") {
    throw new TypeError("wallet dispatcher requires an explicit confirmation function");
  }
  const request = walletRequest(provider);
  const timeoutMs = integer(
    walletResponseTimeoutMs,
    "wallet response timeout",
    1,
    DEFAULT_WALLET_TIMEOUT_MS,
  );
  const dispatcher = Object.freeze({
    async dispatch(preflight) {
      if (!DISPATCHERS.has(this)) {
        throw new TypeError("wallet dispatch requires the original fixed dispatcher");
      }
      contractIntentWalletJournalArtifact(preflight);
      if (IN_FLIGHT_PREFLIGHTS.has(preflight)) {
        throw dispatchError("this contract-intent wallet request is already in progress", {
          code: "DISPATCH_IN_PROGRESS",
          durableAttemptCreated: false,
          phase: "confirmation",
          requestMayHaveBeenSent: false,
        });
      }
      IN_FLIGHT_PREFLIGHTS.add(preflight);
      let durableAttemptCreated = false;
      let requestMayHaveBeenSent = false;
      let reportedHash = null;
      try {
        const beforeConfirmation = integer(clock(), "wallet dispatcher clock", 1);
        if (beforeConfirmation < preflight.preparedAt || beforeConfirmation >= preflight.expiresAt) {
          throw dispatchError("contract-intent wallet request expired before confirmation", {
            code: "REQUEST_EXPIRED",
            durableAttemptCreated,
            phase: "confirmation",
            requestMayHaveBeenSent,
          });
        }
        let confirmation;
        try {
          confirmation = exactRecord(
            await requestExplicitConfirmation(confirmationPrompt(preflight)),
            ["confirmed", "requestDigest"],
            "contract-intent wallet explicit confirmation",
          );
        } catch {
          throw dispatchError("contract-intent wallet confirmation was not completed", {
            code: "CONFIRMATION_INCOMPLETE",
            durableAttemptCreated,
            phase: "confirmation",
            requestMayHaveBeenSent,
          });
        }
        if (confirmation.confirmed !== true || confirmation.requestDigest !== preflight.requestDigest) {
          throw dispatchError("contract-intent wallet request was not explicitly confirmed", {
            code: "CONFIRMATION_DECLINED",
            durableAttemptCreated,
            phase: "confirmation",
            requestMayHaveBeenSent,
          });
        }
        const claimTime = integer(clock(), "wallet dispatcher claim clock", beforeConfirmation);
        let claim;
        try {
          claim = claimContractIntentWalletForDispatch(store, preflight, { now: claimTime });
        } catch {
          throw dispatchError("wallet attempt could not be durably claimed; do not send", {
            code: "DURABLE_CLAIM_UNAVAILABLE",
            durableAttemptCreated,
            phase: "journal",
            requestMayHaveBeenSent,
          });
        }
        durableAttemptCreated = true;

        let beforeChain;
        let beforeAccounts;
        try {
          [beforeChain, beforeAccounts] = await readContext(request, timeoutMs);
        } catch {
          throw dispatchError("wallet context could not be verified after the durable claim", {
            code: "CONTEXT_UNAVAILABLE",
            durableAttemptCreated,
            phase: "context",
            requestMayHaveBeenSent,
          });
        }
        const contextTime = integer(clock(), "wallet dispatcher context clock", claimTime);
        let context;
        try {
          context = verifyContractIntentWalletContext({
            accounts: beforeAccounts,
            chainId: beforeChain,
            now: contextTime,
            preflight,
          });
        } catch {
          throw dispatchError("wallet context does not match the durable contract intent", {
            code: "CONTEXT_MISMATCH",
            durableAttemptCreated,
            phase: "context",
            requestMayHaveBeenSent,
          });
        }
        try {
          consumeContractIntentWalletDispatchClaim(claim, { now: contextTime });
        } catch {
          throw dispatchError("durable wallet claim could not be consumed exactly once", {
            code: "DURABLE_CLAIM_UNAVAILABLE",
            durableAttemptCreated,
            phase: "journal",
            requestMayHaveBeenSent,
          });
        }

        let response = null;
        let walletError = null;
        requestMayHaveBeenSent = true;
        try {
          response = await withDeadline(
            () => request(preflight.request),
            timeoutMs,
            "wallet transaction request",
          );
        } catch (error) {
          walletError = error;
        }
        const outcome = classifiedOutcome(response, walletError);
        reportedHash = outcome.transactionHash;
        const postContext = await readPostContext(request, timeoutMs);
        let outcomeTime;
        let submission;
        try {
          outcomeTime = integer(clock(), "wallet dispatcher outcome clock", contextTime);
          submission = recordOutcome({ context, now: outcomeTime, outcome, postContext });
          store.record(submission, { now: outcomeTime });
        } catch {
          throw dispatchError("wallet outcome could not be durably recorded; reconcile without resend", {
            code: "DURABLE_OUTCOME_UNAVAILABLE",
            durableAttemptCreated,
            phase: "journal",
            requestMayHaveBeenSent,
            transactionHash: reportedHash,
          });
        }
        return Object.freeze({
          schema: "treeswap.contract-intent-wallet-dispatch-result.v1",
          requestDigest: submission.requestDigest,
          contractIntentDigest: submission.contractIntentDigest,
          state: submission.state,
          transactionHash: submission.transactionHash,
          postContextUnavailable: submission.postContextUnavailable,
          expiredAtResponse: submission.expiredAtResponse,
          submission,
          retryAuthorized: false,
          walletDispatchAuthority: false,
          canonicalFinalizedReservation: false,
          independentProviderOperationVerified: false,
          lightningDispatchAuthority: false,
          fundingAuthorization: false,
        });
      } finally {
        IN_FLIGHT_PREFLIGHTS.delete(preflight);
      }
    },
    status() {
      if (!DISPATCHERS.has(this)) {
        throw new TypeError("wallet dispatcher status requires the original fixed dispatcher");
      }
      return Object.freeze({
        schema: "treeswap.contract-intent-wallet-dispatcher-status.v1",
        state: "ready",
        automaticRetry: false,
        requestsWalletConnection: false,
        requestsChainSwitch: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
  });
  DISPATCHERS.set(dispatcher, Object.freeze({ store }));
  return dispatcher;
}

export function createContractIntentWalletDispatcher(input) {
  const source = exactRecord(input, [
    "provider",
    "requestExplicitConfirmation",
    "store",
  ], "contract-intent wallet dispatcher options");
  return buildDispatcher({
    ...source,
    clock: systemClock,
    walletResponseTimeoutMs: DEFAULT_WALLET_TIMEOUT_MS,
  });
}

export function createContractIntentWalletDispatcherForTests(input) {
  const source = exactRecord(input, [
    "clock",
    "provider",
    "requestExplicitConfirmation",
    "store",
    "walletResponseTimeoutMs",
  ], "test contract-intent wallet dispatcher options");
  return buildDispatcher(source);
}

Object.freeze(ContractIntentWalletDispatchError.prototype);
Object.freeze(ContractIntentWalletDispatchError);
