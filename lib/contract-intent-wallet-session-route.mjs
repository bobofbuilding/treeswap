import {
  CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER,
  contractIntentWalletSessionKeyId,
  createContractIntentWalletSessionProvider,
  createContractIntentWalletSessionProviderForTests,
} from "./contract-intent-wallet-session-reader.mjs";

export const CONTRACT_INTENT_WALLET_SESSION_ROUTE_MODE = "closed-test";
export const CONTRACT_INTENT_WALLET_SESSION_ROUTE_MAXIMUM_ROTATION_OVERLAP_SECONDS = 15 * 60;
export const CONTRACT_INTENT_WALLET_SESSION_ROUTE_ENVIRONMENT_KEYS = Object.freeze({
  apiOrigin: "TREESWAP_WALLET_SESSION_API_ORIGIN",
  currentRequesterPublicKey: "TREESWAP_WALLET_SESSION_CURRENT_REQUESTER_PUBLIC_KEY_PEM",
  currentResponsePrivateKey: "TREESWAP_WALLET_SESSION_CURRENT_RESPONSE_PRIVATE_KEY_PEM",
  deploymentId: "TREESWAP_WALLET_SESSION_DEPLOYMENT_ID",
  mode: "TREESWAP_WALLET_SESSION_ROUTE_MODE",
  retiringAcceptUntil: "TREESWAP_WALLET_SESSION_RETIRING_ACCEPT_UNTIL_EPOCH_SECONDS",
  retiringRequesterPublicKey: "TREESWAP_WALLET_SESSION_RETIRING_REQUESTER_PUBLIC_KEY_PEM",
  retiringResponsePrivateKey: "TREESWAP_WALLET_SESSION_RETIRING_RESPONSE_PRIVATE_KEY_PEM",
});

const DEPLOYMENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAXIMUM_IN_FLIGHT = 16;
const MAXIMUM_ENVIRONMENT_VALUE_BYTES = 8 * 1_024;
const ROUTES = new WeakMap();

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

function environmentValue(environment, key, { optional = false } = {}) {
  const value = environment[key];
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || value.length === 0
      || Buffer.byteLength(value, "utf8") > MAXIMUM_ENVIRONMENT_VALUE_BYTES
      || value.includes("\u0000")) {
    throw new TypeError(`wallet session route environment value ${key} is invalid`);
  }
  return value;
}

function deploymentId(value) {
  if (typeof value !== "string" || !DEPLOYMENT_ID.test(value)) {
    throw new TypeError("wallet session route deployment ID is invalid");
  }
  return value;
}

function responseHeaders() {
  return {
    "cache-control": "no-store, max-age=0",
    "cdn-cache-control": "no-store",
    "cloudflare-cdn-cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-site",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "surrogate-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
  };
}

function jsonResponse(status) {
  const bytes = JSON.stringify({ error: "wallet session request rejected" });
  return new Response(bytes, {
    status,
    headers: {
      ...responseHeaders(),
      "content-length": String(Buffer.byteLength(bytes, "utf8")),
    },
  });
}

function hardenedResponse(response) {
  if (!(response instanceof Response)) throw new TypeError("wallet session provider response is invalid");
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(responseHeaders())) headers.set(name, value);
  headers.delete("server");
  headers.delete("server-timing");
  headers.delete("set-cookie");
  headers.delete("x-powered-by");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function discardRequestBody(request) {
  if (request?.body && !request.body.locked) void request.body.cancel().catch(() => {});
}

function discardResponseBody(response) {
  if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
}

function systemClock() {
  return Math.floor(Date.now() / 1_000);
}

function createRoute(input, injected) {
  const fields = [
    "apiOrigin",
    "currentRequesterPublicKey",
    "currentResponsePrivateKey",
    "database",
    "deploymentId",
    "mode",
    "retiringAcceptUntil",
    "retiringRequesterPublicKey",
    "retiringResponsePrivateKey",
    "signal",
  ];
  if (injected) fields.push("clock");
  const source = exactRecord(input, fields, "wallet session route options");
  if (source.mode !== CONTRACT_INTENT_WALLET_SESSION_ROUTE_MODE) {
    throw new Error("wallet session route is restricted to closed-test mode");
  }
  deploymentId(source.deploymentId);
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("wallet session route requires an active lifecycle");
  }
  const clock = injected ? source.clock : systemClock;
  if (typeof clock !== "function") throw new TypeError("wallet session route clock is invalid");
  const now = integer(clock(), "wallet session route initialization time", 1);

  const retiringValues = [
    source.retiringRequesterPublicKey,
    source.retiringResponsePrivateKey,
    source.retiringAcceptUntil,
  ];
  const retiringConfigured = retiringValues.every((value) => value !== null);
  if (!retiringConfigured && retiringValues.some((value) => value !== null)) {
    throw new Error("wallet session route retiring credentials must be complete");
  }
  if (retiringConfigured) {
    integer(
      source.retiringAcceptUntil,
      "wallet session route retiring credential expiry",
      now + 1,
      now + CONTRACT_INTENT_WALLET_SESSION_ROUTE_MAXIMUM_ROTATION_OVERLAP_SECONDS,
    );
  }

  const keyIds = [
    contractIntentWalletSessionKeyId(source.currentRequesterPublicKey),
    contractIntentWalletSessionKeyId(source.currentResponsePrivateKey),
  ];
  if (retiringConfigured) {
    keyIds.push(
      contractIntentWalletSessionKeyId(source.retiringRequesterPublicKey),
      contractIntentWalletSessionKeyId(source.retiringResponsePrivateKey),
    );
  }
  if (new Set(keyIds).size !== keyIds.length) {
    throw new Error("wallet session route credential keys must all be separate");
  }

  const lifecycle = new AbortController();
  const abort = () => lifecycle.abort();
  source.signal.addEventListener("abort", abort, { once: true });
  const providerFactory = injected
    ? createContractIntentWalletSessionProviderForTests
    : createContractIntentWalletSessionProvider;
  const providerOptions = (requesterPublicKey, responsePrivateKey) => ({
    apiOrigin: source.apiOrigin,
    ...(injected ? { clock } : {}),
    database: source.database,
    ...(injected ? { maximumProcessingMilliseconds: 5_000 } : {}),
    requesterPublicKey,
    responsePrivateKey,
    signal: lifecycle.signal,
  });
  const current = providerFactory(providerOptions(
    source.currentRequesterPublicKey,
    source.currentResponsePrivateKey,
  ));
  const retiring = retiringConfigured
    ? providerFactory(providerOptions(
        source.retiringRequesterPublicKey,
        source.retiringResponsePrivateKey,
      ))
    : null;
  const context = {
    clock,
    clockFailures: 0,
    clockHighWater: now,
    current,
    currentKeyId: keyIds[0],
    currentRequests: 0,
    inFlight: 0,
    lifecycle,
    providerFailures: 0,
    rejectedRequests: 0,
    retiring,
    retiringAcceptUntil: retiringConfigured ? source.retiringAcceptUntil : null,
    retiringKeyId: retiringConfigured ? keyIds[2] : null,
    retiringRequests: 0,
    sourceSignal: source.signal,
    state: "active",
  };
  const snapshot = () => {
    const providerStatuses = [context.current, context.retiring]
      .filter(Boolean)
      .map((provider) => provider.status());
    return Object.freeze({
      schema: "treeswap.contract-intent-wallet-session-route-status.v1",
      mode: CONTRACT_INTENT_WALLET_SESSION_ROUTE_MODE,
      state: context.state,
      currentRequests: context.currentRequests,
      retiringRequests: context.retiringRequests,
      rejectedRequests: context.rejectedRequests,
      providerFailures: context.providerFailures,
      clockFailures: context.clockFailures,
      inFlightRequests: context.inFlight,
      activeResponses: providerStatuses.reduce((sum, status) => sum + status.activeResponses, 0),
      inactiveResponses: providerStatuses.reduce((sum, status) => sum + status.inactiveResponses, 0),
      retiringCredentialSlotConfigured: context.retiring !== null,
      maximumRotationOverlapSeconds:
        CONTRACT_INTENT_WALLET_SESSION_ROUTE_MAXIMUM_ROTATION_OVERLAP_SECONDS,
      authoritativeD1ReadOnly: true,
      sensitiveBodyLoggingAllowed: false,
      keyIdsDisclosed: false,
      deploymentIdentityDisclosed: false,
      walletDispatchAuthority: false,
      lightningDispatchAuthority: false,
      settlementAuthority: false,
      fundingAuthorization: false,
      releaseActivationAuthority: false,
    });
  };
  const halt = (kind) => {
    if (kind === "clock") context.clockFailures += 1;
    else context.providerFailures += 1;
    context.state = "halted";
    context.lifecycle.abort();
  };
  const observeNow = () => {
    let observed;
    try {
      observed = integer(context.clock(), "wallet session route time", 1);
      if (observed < context.clockHighWater) throw new Error("clock regressed");
      context.clockHighWater = observed;
      return observed;
    } catch {
      halt("clock");
      return null;
    }
  };
  const route = Object.freeze({
    async handle(request) {
      if (this !== route || ROUTES.get(this) !== context) {
        throw new TypeError("wallet session route request requires the original service");
      }
      if (context.state !== "active" || context.sourceSignal.aborted || context.lifecycle.signal.aborted) {
        discardRequestBody(request);
        return jsonResponse(503);
      }
      if (!(request instanceof Request)) {
        context.rejectedRequests += 1;
        return jsonResponse(400);
      }
      if (context.inFlight >= MAXIMUM_IN_FLIGHT) {
        context.rejectedRequests += 1;
        discardRequestBody(request);
        return jsonResponse(429);
      }
      context.inFlight += 1;
      try {
        const observed = observeNow();
        if (observed === null) {
          discardRequestBody(request);
          return jsonResponse(503);
        }
        const requesterKeyId = request.headers.get(
          CONTRACT_INTENT_WALLET_SESSION_REQUESTER_KEY_HEADER,
        );
        let provider;
        if (requesterKeyId === context.currentKeyId) {
          provider = context.current;
          context.currentRequests += 1;
        } else if (requesterKeyId === context.retiringKeyId
            && context.retiring !== null && observed < context.retiringAcceptUntil) {
          provider = context.retiring;
          context.retiringRequests += 1;
        } else {
          context.rejectedRequests += 1;
          discardRequestBody(request);
          return jsonResponse(400);
        }
        const response = await provider.handle(request);
        const providerStatus = provider.status();
        if (providerStatus.state === "halted") {
          halt("provider");
          return hardenedResponse(response);
        }
        if (provider === context.retiring) {
          const responseObservedAt = observeNow();
          if (responseObservedAt === null) {
            discardResponseBody(response);
            return jsonResponse(503);
          }
          if (responseObservedAt >= context.retiringAcceptUntil) {
            context.rejectedRequests += 1;
            discardResponseBody(response);
            return jsonResponse(400);
          }
        }
        return hardenedResponse(response);
      } catch {
        halt("provider");
        discardRequestBody(request);
        return jsonResponse(503);
      } finally {
        context.inFlight -= 1;
      }
    },
    status() {
      if (this !== route || ROUTES.get(this) !== context) {
        throw new TypeError("wallet session route status requires the original service");
      }
      return snapshot();
    },
    stop() {
      if (this !== route || ROUTES.get(this) !== context) {
        throw new TypeError("wallet session route stop requires the original service");
      }
      if (context.state !== "halted") context.state = "stopped";
      context.lifecycle.abort();
      context.sourceSignal.removeEventListener("abort", abort);
      return snapshot();
    },
  });
  ROUTES.set(route, context);
  source.signal.addEventListener("abort", () => {
    if (context.state !== "halted") context.state = "stopped";
  }, { once: true });
  return route;
}

export function createContractIntentWalletSessionRoute(input) {
  return createRoute(input, false);
}

export function createContractIntentWalletSessionRouteForTests(input) {
  return createRoute(input, true);
}

export function createContractIntentWalletSessionRouteFromEnvironment(input) {
  const source = exactRecord(
    input,
    ["database", "environment", "signal"],
    "wallet session route environment options",
  );
  if (!source.environment || (typeof source.environment !== "object"
      && typeof source.environment !== "function")) {
    throw new TypeError("wallet session route environment is unavailable");
  }
  const keys = CONTRACT_INTENT_WALLET_SESSION_ROUTE_ENVIRONMENT_KEYS;
  const retiringRequesterPublicKey = environmentValue(
    source.environment,
    keys.retiringRequesterPublicKey,
    { optional: true },
  );
  const retiringResponsePrivateKey = environmentValue(
    source.environment,
    keys.retiringResponsePrivateKey,
    { optional: true },
  );
  const retiringAcceptUntilValue = environmentValue(
    source.environment,
    keys.retiringAcceptUntil,
    { optional: true },
  );
  let retiringAcceptUntil = null;
  if (retiringAcceptUntilValue !== null) {
    if (!/^[1-9][0-9]{0,15}$/.test(retiringAcceptUntilValue)) {
      throw new TypeError("wallet session route retiring expiry is invalid");
    }
    retiringAcceptUntil = Number(retiringAcceptUntilValue);
  }
  return createContractIntentWalletSessionRoute({
    apiOrigin: environmentValue(source.environment, keys.apiOrigin),
    currentRequesterPublicKey: environmentValue(
      source.environment,
      keys.currentRequesterPublicKey,
    ),
    currentResponsePrivateKey: environmentValue(
      source.environment,
      keys.currentResponsePrivateKey,
    ),
    database: source.database,
    deploymentId: environmentValue(source.environment, keys.deploymentId),
    mode: environmentValue(source.environment, keys.mode),
    retiringAcceptUntil,
    retiringRequesterPublicKey,
    retiringResponsePrivateKey,
    signal: source.signal,
  });
}

export function contractIntentWalletSessionRouteUnavailableResponse() {
  return jsonResponse(503);
}
