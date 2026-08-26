import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { TextDecoder as NodeTextDecoder } from "node:util";
import {
  assertRfqSelectionCeremonyOwnershipAvailable,
  claimRfqSelectionCeremonyOwnership,
  isRfqSelectionReservationService,
  rfqSelectionReservationServiceMode,
} from "./rfq-selection-reservation.mjs";

const ROUTE_FIELDS = Object.freeze(["policy", "selectionReservation", "signal"]);
const POLICY_FIELDS = Object.freeze([
  "apiOrigin",
  "clientOrigin",
  "maximumInFlightRequests",
  "maximumProcessingMilliseconds",
  "maximumRequestBytes",
  "maximumResponseBytes",
]);
const PREPARE_FIELDS = Object.freeze([
  "authorizationExpiresAt",
  "request",
  "reservationToken",
]);
const RESERVE_FIELDS = Object.freeze([
  "authorization",
  "request",
  "reservationToken",
  "signature",
]);
const ROUTES = new WeakMap();

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const wanted = [...expected].sort();
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const actual = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function origin(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a canonical HTTPS origin`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${name} must be a canonical HTTPS origin`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || (parsed.port && parsed.port !== "443") || parsed.pathname !== "/"
      || parsed.search || parsed.hash || value !== parsed.origin) {
    throw new TypeError(`${name} must be a canonical HTTPS origin`);
  }
  return parsed.origin;
}

function normalizedPolicy(input) {
  const raw = exactDataRecord(input, POLICY_FIELDS, "RFQ private ceremony policy");
  const policy = Object.freeze({
    apiOrigin: origin(raw.apiOrigin, "RFQ private ceremony API origin"),
    clientOrigin: origin(raw.clientOrigin, "RFQ private ceremony client origin"),
    maximumInFlightRequests: integer(
      raw.maximumInFlightRequests,
      "RFQ private ceremony in-flight request limit",
      1,
      4_096,
    ),
    maximumProcessingMilliseconds: integer(
      raw.maximumProcessingMilliseconds,
      "RFQ private ceremony processing timeout",
      250,
      30_000,
    ),
    maximumRequestBytes: integer(
      raw.maximumRequestBytes,
      "RFQ private ceremony request limit",
      4_096,
      65_536,
    ),
    maximumResponseBytes: integer(
      raw.maximumResponseBytes,
      "RFQ private ceremony response limit",
      4_096,
      1_048_576,
    ),
  });
  if (policy.apiOrigin === policy.clientOrigin) {
    throw new Error("RFQ private ceremony API and browser origins must be separated");
  }
  return policy;
}

function responseHeaders(policy, includeCors = true) {
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Encoding": "identity",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Content-Type": "application/json; charset=utf-8",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  if (includeCors) headers.set("Access-Control-Allow-Origin", policy.clientOrigin);
  return headers;
}

function jsonResponse(status, payload, policy, includeCors = true) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > policy.maximumResponseBytes) {
    throw new RangeError("RFQ private ceremony response exceeds its fixed limit");
  }
  return new Response(body, {
    status,
    headers: responseHeaders(policy, includeCors),
  });
}

function rejectedResponse(policy, includeCors = true) {
  return jsonResponse(400, Object.freeze({
    schema: "treeswap.rfq-private-ceremony-error.v1",
    error: "request rejected",
  }), policy, includeCors);
}

function preflightResponse(request, policy) {
  const requestedMethod = request.headers.get("access-control-request-method");
  const rawHeaders = request.headers.get("access-control-request-headers");
  const requestedHeaders = String(rawHeaders ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (requestedMethod !== "POST"
      || requestedHeaders.length !== 2
      || requestedHeaders[0] !== "cache-control"
      || requestedHeaders[1] !== "content-type"
      || request.headers.has("authorization")
      || request.headers.has("cookie")
      || request.headers.has("access-control-request-private-network")) {
    throw new Error("RFQ private ceremony preflight is invalid");
  }
  const headers = responseHeaders(policy);
  headers.delete("Content-Type");
  headers.set("Access-Control-Allow-Methods", "POST");
  headers.set("Access-Control-Allow-Headers", "cache-control, content-type");
  headers.set("Access-Control-Max-Age", "0");
  return new Response(null, { status: 204, headers });
}

function cancelReader(reader) {
  try {
    const pending = reader?.cancel?.();
    if (pending && typeof pending.catch === "function") void pending.catch(() => {});
  } catch {
    // Rejected body teardown never becomes authority.
  }
}

async function strictRequestJson(request, maximumBytes, signal) {
  const contentType = String(request.headers.get("content-type") ?? "").trim();
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(contentType)) {
    throw new Error("RFQ private ceremony content type is invalid");
  }
  const cacheControl = String(request.headers.get("cache-control") ?? "").toLowerCase();
  if (!cacheControl.split(",").some((directive) => directive.trim() === "no-store")) {
    throw new Error("RFQ private ceremony request must disable storage");
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding.trim().toLowerCase() !== "identity") {
    throw new Error("RFQ private ceremony content encoding is invalid");
  }
  if (request.headers.has("authorization") || request.headers.has("cookie")) {
    throw new Error("RFQ private ceremony credentials must not be sent in headers");
  }
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null && !/^(?:0|[1-9][0-9]*)$/.test(declaredHeader)) {
    throw new Error("RFQ private ceremony content length is invalid");
  }
  const transferEncoding = request.headers.get("transfer-encoding");
  if (transferEncoding !== null
      && (declaredHeader !== null || transferEncoding.trim().toLowerCase() !== "chunked")) {
    throw new Error("RFQ private ceremony framing is ambiguous");
  }
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && declared > maximumBytes) {
    throw new Error("RFQ private ceremony request is too large");
  }
  if (!request.body || typeof request.body.getReader !== "function") {
    throw new Error("RFQ private ceremony request body is empty");
  }
  const reader = request.body.getReader();
  const abort = () => cancelReader(reader);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("RFQ private ceremony request was interrupted");
      let frame;
      try {
        frame = await reader.read();
      } catch {
        throw new Error("RFQ private ceremony request was interrupted");
      }
      if (frame.done) break;
      if (!(frame.value instanceof Uint8Array)) {
        throw new Error("RFQ private ceremony request body is invalid");
      }
      received += frame.value.byteLength;
      if (received > maximumBytes) throw new Error("RFQ private ceremony request is too large");
      chunks.push(Buffer.from(frame.value));
    }
    if (declared !== null && received !== declared) {
      throw new Error("RFQ private ceremony request length changed");
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error("RFQ private ceremony request contains a forbidden byte order mark");
    }
    let text;
    try {
      text = new NodeTextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("RFQ private ceremony request is not valid UTF-8");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("RFQ private ceremony request is malformed");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) cancelReader(reader);
  }
}

function createRoute(input, expectedMode) {
  const source = exactDataRecord(input, ROUTE_FIELDS, "RFQ private ceremony route input");
  const policy = normalizedPolicy(source.policy);
  if (!isRfqSelectionReservationService(source.selectionReservation)
      || rfqSelectionReservationServiceMode(source.selectionReservation) !== expectedMode) {
    throw new TypeError("RFQ private ceremony requires a matching factory-created reservation service");
  }
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("RFQ private ceremony requires an active deployment AbortSignal");
  }
  const deploymentSignal = source.signal;
  assertRfqSelectionCeremonyOwnershipAvailable(source.selectionReservation, deploymentSignal);
  const ceremonyLease = claimRfqSelectionCeremonyOwnership(
    source.selectionReservation,
    deploymentSignal,
  );
  const lifecycle = new AbortController();
  const context = {
    completed: 0,
    failed: 0,
    inFlight: 0,
    mode: expectedMode,
    prepared: 0,
    reserved: 0,
    started: 0,
    state: "active",
  };
  const stop = () => {
    if (context.state === "stopped") return;
    context.state = "stopped";
    lifecycle.abort();
    try { ceremonyLease.close(); } catch {}
    deploymentSignal.removeEventListener("abort", stop);
  };
  deploymentSignal.addEventListener("abort", stop, { once: true });

  const route = Object.freeze({
    async handle(webRequest) {
      if (this !== route || ROUTES.get(this) !== context) {
        throw new TypeError("RFQ private ceremony route lacks factory provenance");
      }
      context.started += 1;
      const saturated = context.inFlight >= policy.maximumInFlightRequests;
      context.inFlight += 1;
      const controller = new AbortController();
      const abortRequest = () => controller.abort();
      webRequest?.signal?.addEventListener?.("abort", abortRequest, { once: true });
      lifecycle.signal.addEventListener("abort", abortRequest, { once: true });
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setNodeTimeout(() => {
          controller.abort();
          reject(new Error("RFQ private ceremony timed out"));
        }, policy.maximumProcessingMilliseconds);
      });
      let includeCors = false;
      try {
        if (context.state !== "active" || !(webRequest instanceof Request)) {
          throw new Error("RFQ private ceremony request is invalid");
        }
        if (saturated) throw new Error("RFQ private ceremony request capacity is exhausted");
        const url = new URL(webRequest.url);
        includeCors = webRequest.headers.get("origin") === policy.clientOrigin;
        if (url.origin !== policy.apiOrigin
            || (url.pathname !== "/v1/selection/prepare" && url.pathname !== "/v1/selection/reserve")
            || url.search || url.hash || !includeCors) {
          throw new Error("RFQ private ceremony target or client origin is invalid");
        }
        if (webRequest.method === "OPTIONS") return preflightResponse(webRequest, policy);
        if (webRequest.method !== "POST") throw new Error("RFQ private ceremony method is invalid");
        const body = await Promise.race([
          strictRequestJson(webRequest, policy.maximumRequestBytes, controller.signal),
          deadline,
        ]);
        if (controller.signal.aborted) throw new Error("RFQ private ceremony request was aborted");
        let result;
        if (url.pathname === "/v1/selection/prepare") {
          result = ceremonyLease.prepare(exactDataRecord(body, PREPARE_FIELDS, "RFQ private ceremony preparation"));
          context.prepared += 1;
        } else {
          result = ceremonyLease.reserve(exactDataRecord(body, RESERVE_FIELDS, "RFQ private ceremony confirmation"));
          context.reserved += 1;
        }
        if (controller.signal.aborted) throw new Error("RFQ private ceremony request was aborted");
        context.completed += 1;
        return jsonResponse(200, result, policy);
      } catch {
        context.failed += 1;
        return rejectedResponse(policy, includeCors);
      } finally {
        clearNodeTimeout(timer);
        controller.abort();
        context.inFlight -= 1;
        webRequest?.signal?.removeEventListener?.("abort", abortRequest);
        lifecycle.signal.removeEventListener("abort", abortRequest);
      }
    },
    status() {
      if (this !== route || ROUTES.get(this) !== context) {
        throw new TypeError("RFQ private ceremony route lacks factory provenance");
      }
      return Object.freeze({
        schema: "treeswap.rfq-private-ceremony-status.v1",
        state: context.state,
        mode: context.mode,
        requestsStarted: context.started,
        requestsCompleted: context.completed,
        requestsRejected: context.failed,
        requestsInFlight: context.inFlight,
        signingPayloadsPrepared: context.prepared,
        reservationsCompleted: context.reserved,
        bearerTokensInStatus: false,
        privateTermsInStatus: false,
        networkListener: false,
        signingAuthority: false,
        fundingAuthorization: false,
        settlementAuthorization: false,
      });
    },
    stop() {
      if (this !== route || ROUTES.get(this) !== context) {
        throw new TypeError("RFQ private ceremony route lacks factory provenance");
      }
      stop();
      return this.status();
    },
  });
  ROUTES.set(route, context);
  return route;
}

export function createRfqPrivateCeremonyRoute(input) {
  return createRoute(input, "production");
}

export function createTestRfqPrivateCeremonyRoute(input) {
  return createRoute(input, "injected-test");
}

export function isRfqPrivateCeremonyRoute(value) {
  return Boolean(value && ROUTES.has(value));
}
