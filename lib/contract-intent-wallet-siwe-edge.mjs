import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { TextDecoder as NodeTextDecoder } from "node:util";
import { getAddress } from "ethers";
import {
  buildContractIntentWalletGatewayClaimRequest,
  buildContractIntentWalletGatewayOutcomeRequest,
  assertContractIntentWalletGatewayLifecycle,
  contractIntentWalletGatewayBinding,
  contractIntentWalletGatewayKeyId,
  verifyContractIntentWalletGatewayClaimResponse,
  verifyContractIntentWalletGatewayOutcomeResponse,
} from "./contract-intent-wallet-gateway.mjs";
import {
  assertContractIntentWalletOwnershipLifecycle,
  claimContractIntentWalletOwnershipEdge,
  contractIntentWalletOwnershipMode,
} from "./contract-intent-wallet-ownership.mjs";
import { isAllowedTreeSwapOrigin } from "./siwe-policy.mjs";

const SESSION_COOKIE = "__Host-treeswap_session";
const SESSION_QUERY = `SELECT
  token_hash AS tokenHash,
  wallet_address AS walletAddress,
  chain_id AS chainId,
  created_at AS createdAt,
  expires_at AS expiresAt
FROM auth_sessions
WHERE token_hash = ? AND expires_at > ?
LIMIT 2`;
const TOKEN = /^(?!0{64}$)[0-9a-f]{64}$/;
const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const MAXIMUM_SESSION_SECONDS = 24 * 60 * 60;
const MAXIMUM_CLAIM_CSRF_SECONDS = 60;
const MAXIMUM_OUTCOME_CSRF_SECONDS = 5 * 60;
const MAXIMUM_REQUEST_SECONDS = 30;
const MAXIMUM_REQUEST_BYTES = 64 * 1024;
const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const MAXIMUM_BODY_READ_MILLISECONDS = 5_000;
const MAXIMUM_RATE_ENTRIES = 128;
const MAXIMUM_ACTIVE_CLAIMS = 128;
const RATE_WINDOW_SECONDS = 60;
const RATE_REQUESTS_PER_WINDOW = 8;
const EDGES = new WeakMap();
const SESSION_CONTEXTS = new WeakMap();

class EdgeAuthenticationError extends Error {}
class EdgeRateLimitError extends Error {}

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

function exactDenseArray(value, maximum, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maximum) {
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

function token(value, name) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new TypeError(`${name} must be an exact secret token`);
  }
  return value;
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
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

function canonicalize(value, depth = 0) {
  if (depth > 12) throw new RangeError("wallet edge value is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("wallet edge numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = exactDenseArray(value, 64, "wallet edge array");
    return `[${entries.map((entry) => canonicalize(entry, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("wallet edge values must contain plain data only");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("wallet edge values cannot contain symbols");
    }
    keys.sort();
    return `{${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new TypeError("wallet edge values require enumerable data properties");
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  }
  throw new TypeError("wallet edge value contains unsupported data");
}

function digest(label, value) {
  return createHash("sha256")
    .update(`${label}\n`, "utf8")
    .update(canonicalize(value), "utf8")
    .digest("hex");
}

function canonicalIso(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be canonical UTC time`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new TypeError(`${name} must be canonical UTC time`);
  }
  return Math.floor(millis / 1_000);
}

function normalizedClientOrigin(value, injected) {
  if (typeof value !== "string" || !isAllowedTreeSwapOrigin(value)) {
    throw new TypeError("wallet edge client origin is not allowlisted");
  }
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash || (!injected && url.protocol !== "https:")) {
    throw new TypeError("wallet edge client origin is not canonical production HTTPS");
  }
  return url.origin;
}

function cookieToken(header) {
  if (typeof header !== "string" || header.length === 0 || header.length > 4_096) {
    throw new EdgeAuthenticationError("wallet edge session cookie is unavailable");
  }
  const entries = header.split(";");
  if (entries.length > 32) throw new EdgeAuthenticationError("wallet edge cookie set is invalid");
  const matches = [];
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (name === SESSION_COOKIE) matches.push(value);
  }
  if (matches.length !== 1) throw new EdgeAuthenticationError("wallet edge session cookie is invalid");
  return token(matches[0], "wallet edge session cookie");
}

function sessionTokenHash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sessionDigest(value, wallet, expiresAt) {
  return `0x${createHmac("sha256", Buffer.from(value, "hex"))
    .update("TreeSwap wallet intent SIWE session v1\n", "utf8")
    .update(`${wallet}\n1\n${expiresAt}\n`, "utf8")
    .digest("hex")}`;
}

function csrfToken(sessionContext, purpose, secret, expiresAt) {
  return createHmac("sha256", Buffer.from(sessionContext.token, "hex"))
    .update("TreeSwap wallet intent CSRF v1\n", "utf8")
    .update(`${purpose}\n${secret}\n${expiresAt}\n`, "utf8")
    .digest("hex");
}

function constantTokenEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function browserMetadata(request, clientOrigin, paths) {
  if (!(request instanceof Request)) throw new TypeError("wallet edge requires a Request");
  const url = new URL(request.url);
  if (url.origin !== clientOrigin || !paths.has(url.pathname) || url.search || url.hash
      || request.method !== "POST" || request.headers.get("origin") !== clientOrigin
      || request.headers.get("sec-fetch-site") !== "same-origin"
      || request.headers.get("sec-fetch-mode") !== "cors"
      || request.headers.get("sec-fetch-dest") !== "empty"
      || request.headers.has("sec-fetch-user") || request.headers.has("authorization")) {
    throw new Error("wallet edge browser request metadata is invalid");
  }
  return url.pathname;
}

async function strictJson(request, maximumBodyReadMilliseconds) {
  const contentType = String(request.headers.get("content-type") ?? "")
    .split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("wallet edge content type is invalid");
  if (!String(request.headers.get("cache-control") ?? "").toLowerCase()
    .split(",").some((value) => value.trim() === "no-store")) {
    throw new Error("wallet edge request must disable storage");
  }
  const encoding = String(request.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (encoding !== "identity" || request.headers.has("transfer-encoding")) {
    throw new Error("wallet edge request framing is unsupported");
  }
  const declaredRaw = request.headers.get("content-length");
  if (declaredRaw !== null && !/^(?:0|[1-9][0-9]*)$/.test(declaredRaw)) {
    throw new Error("wallet edge content length is invalid");
  }
  const declared = declaredRaw === null ? null : Number(declaredRaw);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared <= 0
      || declared > MAXIMUM_REQUEST_BYTES)) {
    throw new Error("wallet edge request is too large or empty");
  }
  if (!request.body || typeof request.body.getReader !== "function") {
    throw new Error("wallet edge request body is missing");
  }
  const reader = request.body.getReader();
  let timeout;
  const operation = (async () => {
    const chunks = [];
    let received = 0;
    while (true) {
      const frame = await reader.read();
      if (frame.done) break;
      if (!(frame.value instanceof Uint8Array)) throw new Error("wallet edge request body is invalid");
      received += frame.value.byteLength;
      if (received > MAXIMUM_REQUEST_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error("wallet edge request is too large");
      }
      chunks.push(Buffer.from(frame.value));
    }
    if (received === 0 || (declared !== null && received !== declared)) {
      throw new Error("wallet edge content length changed");
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error("wallet edge byte order mark is forbidden");
    }
    return JSON.parse(new NodeTextDecoder("utf-8", { fatal: true }).decode(bytes));
  })();
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new Error("wallet edge request body deadline exceeded"));
    }, maximumBodyReadMilliseconds);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function responseHeaders() {
  return {
    "cache-control": "no-store, max-age=0",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    vary: "Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest",
    "x-content-type-options": "nosniff",
  };
}

function jsonResponse(status, body) {
  const bytes = JSON.stringify(body);
  if (Buffer.byteLength(bytes, "utf8") > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("wallet edge response exceeds its bound");
  }
  return new Response(bytes, {
    status,
    headers: {
      ...responseHeaders(),
      "content-length": String(Buffer.byteLength(bytes, "utf8")),
    },
  });
}

function rejectedResponse(status = 400) {
  return jsonResponse(status, Object.freeze({ error: "wallet intent request rejected" }));
}

function gatewayRequest(origin, path, body) {
  const bytes = JSON.stringify(body);
  return new Request(new URL(path, origin), {
    method: "POST",
    headers: {
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(bytes, "utf8")),
      "content-type": "application/json",
    },
    body: bytes,
  });
}

async function gatewayResponse(response) {
  if (!(response instanceof Response) || response.status !== 200
      || response.headers.get("content-type") !== "application/json; charset=utf-8"
      || !String(response.headers.get("cache-control") ?? "").includes("no-store")
      || response.headers.has("set-cookie")) {
    throw new Error("wallet edge private gateway response is invalid");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("wallet edge private gateway response is out of bounds");
  }
  return JSON.parse(new NodeTextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function systemClock() {
  return Math.floor(Date.now() / 1_000);
}

function databaseBinding(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")
      || typeof value.prepare !== "function") {
    throw new TypeError("wallet edge session database is unavailable");
  }
  return value;
}

async function readSession(context, request, now) {
  try {
    const rawToken = cookieToken(request.headers.get("cookie"));
    const tokenHash = sessionTokenHash(rawToken);
    const observedAt = new Date(now * 1_000).toISOString();
    const statement = context.database.prepare(SESSION_QUERY);
    if (!statement || typeof statement.bind !== "function") throw new Error();
    const bound = statement.bind(tokenHash, observedAt);
    if (!bound || typeof bound.all !== "function") throw new Error();
    const result = await bound.all();
    const rows = exactDenseArray(result?.results, 2, "wallet edge session rows");
    if (rows.length !== 1) throw new Error();
    const row = exactRecord(rows[0], [
      "chainId",
      "createdAt",
      "expiresAt",
      "tokenHash",
      "walletAddress",
    ], "wallet edge session row");
    const wallet = address(row.walletAddress, "wallet edge session wallet");
    const createdAt = canonicalIso(row.createdAt, "wallet edge session creation time");
    const expiresAt = canonicalIso(row.expiresAt, "wallet edge session expiry");
    if (row.tokenHash !== tokenHash || row.walletAddress !== wallet || row.chainId !== 1
        || createdAt > now || expiresAt <= now || expiresAt - createdAt > MAXIMUM_SESSION_SECONDS) {
      throw new Error();
    }
    const session = Object.freeze({
      schema: "treeswap.contract-intent-wallet-siwe-session.v1",
      wallet,
      chainId: 1,
      expiresAt,
      sessionDigest: sessionDigest(rawToken, wallet, expiresAt),
    });
    SESSION_CONTEXTS.set(session, Object.freeze({ token: rawToken }));
    return session;
  } catch {
    throw new EdgeAuthenticationError("wallet edge session is unavailable");
  }
}

function consumeRate(context, session, now) {
  for (const [key, record] of context.rate) {
    if (record.windowEndsAt <= now) context.rate.delete(key);
  }
  let record = context.rate.get(session.sessionDigest);
  if (!record) {
    if (context.rate.size >= MAXIMUM_RATE_ENTRIES) {
      throw new EdgeRateLimitError("wallet edge rate entry bound is exhausted");
    }
    record = { count: 0, windowEndsAt: now + RATE_WINDOW_SECONDS };
    context.rate.set(session.sessionDigest, record);
  }
  if (record.count >= RATE_REQUESTS_PER_WINDOW) {
    throw new EdgeRateLimitError("wallet edge request rate is exceeded");
  }
  record.count += 1;
}

function sessionContext(session) {
  const context = SESSION_CONTEXTS.get(session);
  if (!context) throw new TypeError("wallet edge requires its original verified SIWE session");
  return context;
}

function normalizeClaimBody(value, now) {
  const source = exactRecord(value, [
    "csrfExpiresAt",
    "csrfToken",
    "ownershipHandle",
  ], "wallet edge claim body");
  const csrfExpiresAt = integer(source.csrfExpiresAt, "wallet edge claim CSRF expiry", 1);
  if (csrfExpiresAt <= now || csrfExpiresAt > now + MAXIMUM_CLAIM_CSRF_SECONDS) {
    throw new Error("wallet edge claim CSRF window is invalid");
  }
  return Object.freeze({
    ownershipHandle: token(source.ownershipHandle, "wallet edge ownership handle"),
    csrfToken: token(source.csrfToken, "wallet edge claim CSRF token"),
    csrfExpiresAt,
  });
}

function normalizeOutcomeBody(value, now) {
  const source = exactRecord(value, [
    "csrfExpiresAt",
    "csrfToken",
    "report",
  ], "wallet edge outcome body");
  const csrfExpiresAt = integer(source.csrfExpiresAt, "wallet edge outcome CSRF expiry", 1);
  if (csrfExpiresAt <= now || csrfExpiresAt > now + MAXIMUM_OUTCOME_CSRF_SECONDS) {
    throw new Error("wallet edge outcome CSRF window is invalid");
  }
  if (!source.report || typeof source.report !== "object" || Array.isArray(source.report)) {
    throw new TypeError("wallet edge outcome report is invalid");
  }
  return Object.freeze({
    csrfToken: token(source.csrfToken, "wallet edge outcome CSRF token"),
    csrfExpiresAt,
    report: source.report,
  });
}

function createEdge(input, injected) {
  const fields = injected
    ? [
        "clientOrigin",
        "clock",
        "database",
        "gateway",
        "maximumBodyReadMilliseconds",
        "ownership",
        "requesterPrivateKey",
        "responsePublicKey",
        "signal",
      ]
    : [
        "clientOrigin",
        "database",
        "gateway",
        "ownership",
        "requesterPrivateKey",
        "responsePublicKey",
        "signal",
      ];
  const source = exactRecord(input, fields, "contract-intent wallet SIWE edge options");
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("wallet edge requires an active deployment AbortSignal");
  }
  assertContractIntentWalletGatewayLifecycle(source.gateway, source.signal);
  assertContractIntentWalletOwnershipLifecycle(
    source.ownership,
    source.gateway,
    source.signal,
  );
  const expectedMode = injected ? "test" : "production";
  const gatewayBinding = contractIntentWalletGatewayBinding(source.gateway);
  if (gatewayBinding.mode !== expectedMode
      || contractIntentWalletOwnershipMode(source.ownership) !== expectedMode) {
    throw new TypeError("wallet edge, ownership, and gateway modes must match");
  }
  if (source.requesterPrivateKey?.type !== "private"
      || source.responsePublicKey?.type !== "public") {
    throw new TypeError("wallet edge requires a requester private key and response public key");
  }
  const requesterKeyId = contractIntentWalletGatewayKeyId(source.requesterPrivateKey);
  const responseKeyId = contractIntentWalletGatewayKeyId(source.responsePublicKey);
  if (requesterKeyId !== gatewayBinding.requesterKeyId
      || responseKeyId !== gatewayBinding.responseKeyId
      || requesterKeyId === responseKeyId) {
    throw new TypeError("wallet edge keys do not match the private gateway binding");
  }
  const context = {
    activeClaims: new Map(),
    claimsIssued: 0,
    clientOrigin: normalizedClientOrigin(source.clientOrigin, injected),
    clock: injected ? source.clock : systemClock,
    clockHighWater: 0,
    database: databaseBinding(source.database),
    gateway: source.gateway,
    gatewayOrigin: gatewayBinding.apiOrigin,
    maximumBodyReadMilliseconds: injected
      ? integer(
          source.maximumBodyReadMilliseconds,
          "test wallet edge body-read deadline",
          1,
          MAXIMUM_BODY_READ_MILLISECONDS,
        )
      : MAXIMUM_BODY_READ_MILLISECONDS,
    outcomeResponses: 0,
    ownership: null,
    prepared: 0,
    rate: new Map(),
    rejected: 0,
    requesterPrivateKey: source.requesterPrivateKey,
    responsePublicKey: source.responsePublicKey,
    signal: source.signal,
    state: "active",
    mode: expectedMode,
    perimeterLease: null,
    haltedOnClockRollback: false,
  };
  if (typeof context.clock !== "function") throw new TypeError("test wallet edge clock must be a function");
  context.ownership = claimContractIntentWalletOwnershipEdge(
    source.ownership,
    source.gateway,
    source.signal,
  );
  const stop = () => {
    if (context.state === "stopped") return;
    context.state = "stopped";
    context.activeClaims.clear();
    context.rate.clear();
  };
  source.signal.addEventListener("abort", stop, { once: true });
  const observeNow = () => {
    const now = integer(context.clock(), "wallet edge clock", 1);
    if (now < context.clockHighWater) {
      context.state = "halted";
      context.haltedOnClockRollback = true;
      context.activeClaims.clear();
      context.rate.clear();
      throw new Error("wallet edge clock regressed");
    }
    context.clockHighWater = now;
    return now;
  };
  const pruneClaims = (now) => {
    for (const [key, record] of context.activeClaims) {
      if (record.reportExpiresAt <= now) context.activeClaims.delete(key);
    }
  };
  const assertEdge = (edge) => {
    const expected = context.perimeterLease ?? service;
    if (edge !== expected || context.state !== "active"
        || (edge === service && EDGES.get(edge) !== context)) {
      throw new TypeError("wallet edge operation requires the original active service");
    }
  };

  const service = Object.freeze({
    async issue(preflight, webRequest) {
      assertEdge(this);
      try {
        browserMetadata(
          webRequest,
          context.clientOrigin,
          new Set(["/v1/wallet-intent/prepare"]),
        );
        const now = observeNow();
        exactRecord(
          await strictJson(webRequest, context.maximumBodyReadMilliseconds),
          [],
          "wallet edge prepare body",
        );
        const session = await readSession(context, webRequest, now);
        consumeRate(context, session, now);
        const handle = context.ownership.issue({
          preflight,
          sessionDigest: session.sessionDigest,
          wallet: session.wallet,
        });
        const csrfExpiresAt = Math.min(
          handle.expiresAt,
          session.expiresAt,
          now + MAXIMUM_CLAIM_CSRF_SECONDS,
        );
        const csrf = csrfToken(
          sessionContext(session),
          "CLAIM",
          handle.ownershipHandle,
          csrfExpiresAt,
        );
        context.prepared += 1;
        return jsonResponse(200, Object.freeze({
          schema: "treeswap.contract-intent-wallet-siwe-edge-prepare.v1",
          ownershipHandle: handle.ownershipHandle,
          csrfToken: csrf,
          csrfExpiresAt,
          singleUse: true,
          requestDigestDisclosed: false,
          contractIntentDisclosed: false,
          quoteDisclosed: false,
          invoiceDisclosed: false,
          walletDisclosed: false,
          sessionDigestDisclosed: false,
          walletDispatchAuthority: false,
          lightningDispatchAuthority: false,
          fundingAuthorization: false,
        }));
      } catch (error) {
        context.rejected += 1;
        if (error instanceof EdgeRateLimitError) return rejectedResponse(429);
        if (error instanceof EdgeAuthenticationError) return rejectedResponse(401);
        return rejectedResponse(400);
      }
    },
    async handle(webRequest) {
      assertEdge(this);
      try {
        const path = browserMetadata(
          webRequest,
          context.clientOrigin,
          new Set(["/v1/wallet-intent/claim", "/v1/wallet-intent/outcome"]),
        );
        const now = observeNow();
        pruneClaims(now);
        const body = await strictJson(webRequest, context.maximumBodyReadMilliseconds);
        const session = await readSession(context, webRequest, now);
        consumeRate(context, session, now);
        if (path === "/v1/wallet-intent/claim") {
          const claimBody = normalizeClaimBody(body, now);
          const expectedCsrf = csrfToken(
            sessionContext(session),
            "CLAIM",
            claimBody.ownershipHandle,
            claimBody.csrfExpiresAt,
          );
          if (!constantTokenEqual(claimBody.csrfToken, expectedCsrf)) {
            throw new EdgeAuthenticationError("wallet edge claim CSRF token is invalid");
          }
          if (context.activeClaims.size >= MAXIMUM_ACTIVE_CLAIMS) {
            throw new EdgeRateLimitError("wallet edge active claim bound is exhausted");
          }
          const ownershipClaim = context.ownership.claim({
            ownershipHandle: claimBody.ownershipHandle,
            sessionDigest: session.sessionDigest,
            wallet: session.wallet,
          });
          const handoff = context.ownership.take(ownershipClaim);
          if (handoff.wallet !== session.wallet || handoff.sessionDigest !== session.sessionDigest) {
            throw new Error("wallet edge ownership handoff changed session binding");
          }
          const claimRequest = buildContractIntentWalletGatewayClaimRequest({
            expiresAt: Math.min(
              handoff.expiresAt,
              now + MAXIMUM_REQUEST_SECONDS,
            ),
            requestDigest: handoff.requestDigest,
            requestedAt: now,
            requesterPrivateKey: context.requesterPrivateKey,
            sessionDigest: handoff.sessionDigest,
            wallet: handoff.wallet,
          });
          const rawClaim = await gatewayResponse(await context.gateway.handle(gatewayRequest(
            context.gatewayOrigin,
            "/v1/wallet-intent/claim",
            claimRequest,
          )));
          const verifiedClaim = verifyContractIntentWalletGatewayClaimResponse({
            now,
            preflight: handoff.preflight,
            request: claimRequest,
            response: rawClaim,
            responsePublicKey: context.responsePublicKey,
          });
          const claimKey = digest("TreeSwap wallet edge gateway claim token v1", {
            claimToken: verifiedClaim.claimToken,
          });
          if (context.activeClaims.has(claimKey)) {
            throw new Error("wallet edge claim token collided");
          }
          const outcomeCsrfExpiresAt = Math.min(
            verifiedClaim.reportExpiresAt,
            session.expiresAt,
            now + MAXIMUM_OUTCOME_CSRF_SECONDS,
          );
          const outcomeCsrf = csrfToken(
            sessionContext(session),
            "OUTCOME",
            verifiedClaim.claimToken,
            outcomeCsrfExpiresAt,
          );
          context.activeClaims.set(claimKey, {
            outcomeDigest: null,
            outcomeFailed: false,
            outcomePromise: null,
            outcomeResponse: null,
            preflight: handoff.preflight,
            reportExpiresAt: verifiedClaim.reportExpiresAt,
            sessionDigest: session.sessionDigest,
            verifiedClaim,
            wallet: session.wallet,
          });
          context.claimsIssued += 1;
          return jsonResponse(200, Object.freeze({
            schema: "treeswap.contract-intent-wallet-siwe-edge-claim.v1",
            claim: rawClaim,
            outcomeCsrfToken: outcomeCsrf,
            outcomeCsrfExpiresAt,
            retryAuthorized: false,
            persistentClaimToken: false,
            walletDispatchAuthority: false,
            lightningDispatchAuthority: false,
            fundingAuthorization: false,
          }));
        }

        const outcomeBody = normalizeOutcomeBody(body, now);
        const reportSource = exactRecord(outcomeBody.report, [
          "beforeAccounts",
          "beforeChainId",
          "claimToken",
          "contractIntentDigest",
          "contextObservedAt",
          "fundingAuthorization",
          "lightningDispatchAuthority",
          "outcome",
          "outcomeObservedAt",
          "postAccounts",
          "postChainId",
          "requestDigest",
          "retryAuthorized",
          "schema",
          "wallet",
          "walletDispatchAuthority",
        ], "wallet edge browser outcome report");
        const claimToken = token(reportSource.claimToken, "wallet edge outcome claim token");
        const claimKey = digest("TreeSwap wallet edge gateway claim token v1", { claimToken });
        const record = context.activeClaims.get(claimKey);
        if (!record || record.wallet !== session.wallet
            || record.sessionDigest !== session.sessionDigest || now >= record.reportExpiresAt) {
          throw new EdgeAuthenticationError("wallet edge outcome claim is unavailable");
        }
        if (reportSource.schema !== "treeswap.contract-intent-wallet-browser-report.v1"
            || bytes32(reportSource.requestDigest, "wallet edge outcome request digest")
              !== record.preflight.requestDigest
            || bytes32(reportSource.contractIntentDigest, "wallet edge outcome contract intent")
              !== record.preflight.contractIntentDigest
            || address(reportSource.wallet, "wallet edge outcome wallet") !== record.wallet
            || reportSource.retryAuthorized !== false
            || reportSource.walletDispatchAuthority !== false
            || reportSource.lightningDispatchAuthority !== false
            || reportSource.fundingAuthorization !== false) {
          throw new Error("wallet edge browser outcome changed its verified claim binding");
        }
        const expectedCsrf = csrfToken(
          sessionContext(session),
          "OUTCOME",
          claimToken,
          outcomeBody.csrfExpiresAt,
        );
        if (!constantTokenEqual(outcomeBody.csrfToken, expectedCsrf)) {
          throw new EdgeAuthenticationError("wallet edge outcome CSRF token is invalid");
        }
        const semanticDigest = digest("TreeSwap wallet edge browser outcome v1", reportSource);
        if (record.outcomeDigest !== null) {
          if (record.outcomeDigest !== semanticDigest || record.outcomeFailed) {
            throw new Error("wallet edge claim already has another or failed outcome");
          }
          if (record.outcomeResponse !== null) return jsonResponse(200, record.outcomeResponse);
          if (record.outcomePromise !== null) return jsonResponse(200, await record.outcomePromise);
          throw new Error("wallet edge outcome state is inconsistent");
        }
        record.outcomeDigest = semanticDigest;
        const operation = (async () => {
          const outcomeRequest = buildContractIntentWalletGatewayOutcomeRequest({
            beforeAccounts: reportSource.beforeAccounts,
            beforeChainId: reportSource.beforeChainId,
            claimToken,
            contextObservedAt: reportSource.contextObservedAt,
            expiresAt: Math.min(record.reportExpiresAt, now + MAXIMUM_REQUEST_SECONDS),
            outcome: reportSource.outcome,
            outcomeObservedAt: reportSource.outcomeObservedAt,
            postAccounts: reportSource.postAccounts,
            postChainId: reportSource.postChainId,
            requestDigest: record.preflight.requestDigest,
            requestedAt: now,
            requesterPrivateKey: context.requesterPrivateKey,
            sessionDigest: record.sessionDigest,
            wallet: record.wallet,
          });
          const rawOutcome = await gatewayResponse(await context.gateway.handle(gatewayRequest(
            context.gatewayOrigin,
            "/v1/wallet-intent/outcome",
            outcomeRequest,
          )));
          verifyContractIntentWalletGatewayOutcomeResponse({
            claim: record.verifiedClaim,
            request: outcomeRequest,
            response: rawOutcome,
            responsePublicKey: context.responsePublicKey,
          });
          const wrapped = Object.freeze({
            schema: "treeswap.contract-intent-wallet-siwe-edge-outcome.v1",
            outcome: rawOutcome,
            retryAuthorized: false,
            walletDispatchAuthority: false,
            lightningDispatchAuthority: false,
            fundingAuthorization: false,
          });
          record.outcomeResponse = wrapped;
          context.outcomeResponses += 1;
          return wrapped;
        })();
        record.outcomePromise = operation;
        try {
          return jsonResponse(200, await operation);
        } catch (error) {
          record.outcomeFailed = true;
          throw error;
        } finally {
          record.outcomePromise = null;
        }
      } catch (error) {
        context.rejected += 1;
        if (error instanceof EdgeRateLimitError) return rejectedResponse(429);
        if (error instanceof EdgeAuthenticationError) return rejectedResponse(401);
        return rejectedResponse(400);
      }
    },
    status() {
      const expected = context.perimeterLease ?? service;
      if (this !== expected || (this === service && EDGES.get(this) !== context)) {
        throw new TypeError("wallet edge status requires the original service");
      }
      if (context.state === "active") pruneClaims(observeNow());
      return Object.freeze({
        schema: "treeswap.contract-intent-wallet-siwe-edge-status.v1",
        state: context.state,
        haltedOnClockRollback: context.haltedOnClockRollback,
        preparedHandles: context.prepared,
        claimsIssued: context.claimsIssued,
        outcomeResponses: context.outcomeResponses,
        requestsRejected: context.rejected,
        activeClaims: context.activeClaims.size,
        activeRateWindows: context.rate.size,
        sessionCookieName: SESSION_COOKIE,
        exactOriginRequired: true,
        fetchMetadataRequired: true,
        csrfBinding: "session-hmac-handle-or-claim",
        rateLimit: `${RATE_REQUESTS_PER_WINDOW}/${RATE_WINDOW_SECONDS}s/session`,
        bodyReadTimeoutMilliseconds: context.maximumBodyReadMilliseconds,
        handleTokensInStatus: false,
        csrfTokensInStatus: false,
        gatewayClaimTokensInStatus: false,
        requestDigestsInStatus: false,
        contractIntentsInStatus: false,
        quotesInStatus: false,
        invoicesInStatus: false,
        walletsInStatus: false,
        sessionDigestsInStatus: false,
        persistentClaimToken: false,
        networkListener: false,
        browserWalletProvider: false,
        automaticClaimRetry: false,
        automaticWalletRetry: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
    stop() {
      const expected = context.perimeterLease ?? service;
      if (this !== expected || (this === service && EDGES.get(this) !== context)) {
        throw new TypeError("wallet edge stop requires the original service");
      }
      stop();
      return this.status();
    },
  });
  EDGES.set(service, context);
  return service;
}

export function createContractIntentWalletSiweEdge(input) {
  return createEdge(input, false);
}

export function createContractIntentWalletSiweEdgeForTests(input) {
  return createEdge(input, true);
}

export function assertContractIntentWalletSiweEdgeLifecycle(edge, signal) {
  const context = edge && typeof edge === "object" ? EDGES.get(edge) : null;
  if (!context || context.signal !== signal || context.state !== "active") {
    throw new TypeError("wallet perimeter requires the original active SIWE edge lifecycle");
  }
  return Object.freeze({
    clientOrigin: context.clientOrigin,
    maximumBodyReadMilliseconds: context.maximumBodyReadMilliseconds,
    mode: context.mode,
  });
}

export function claimContractIntentWalletSiweEdgePerimeter(edge, signal) {
  const context = edge && typeof edge === "object" ? EDGES.get(edge) : null;
  if (!context || context.signal !== signal || context.state !== "active") {
    throw new TypeError("wallet perimeter requires the original active SIWE edge lifecycle");
  }
  if (context.perimeterLease !== null) {
    throw new Error("wallet SIWE edge already belongs to a perimeter");
  }
  let lease;
  lease = Object.freeze({
    issue(preflight, request) {
      if (this !== lease || context.perimeterLease !== lease) {
        throw new TypeError("wallet perimeter lease issue requires the original lease");
      }
      return edge.issue.call(lease, preflight, request);
    },
    handle(request) {
      if (this !== lease || context.perimeterLease !== lease) {
        throw new TypeError("wallet perimeter lease request requires the original lease");
      }
      return edge.handle.call(lease, request);
    },
    status() {
      if (this !== lease || context.perimeterLease !== lease) {
        throw new TypeError("wallet perimeter lease status requires the original lease");
      }
      return edge.status.call(lease);
    },
    stop() {
      if (this !== lease || context.perimeterLease !== lease) {
        throw new TypeError("wallet perimeter lease stop requires the original lease");
      }
      return edge.stop.call(lease);
    },
  });
  context.perimeterLease = lease;
  return lease;
}

export const CONTRACT_INTENT_WALLET_SESSION_QUERY = SESSION_QUERY;
