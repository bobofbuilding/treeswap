import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  SolverDaemonEvidenceReplayStore,
  isSolverDaemonEvidenceReplayStore,
} from "./solver-daemon-evidence-provider.mjs";
import {
  buildSignedPrivatePacketResponse,
  privatePacketProviderOrigin,
  privatePacketRequestDigest,
  verifyPrivatePacketRequest,
} from "./solver-private-packet.mjs";

export const SOLVER_PRIVATE_PACKET_REPLAY_SCHEMA = "treeswap.private-packet-replay.v1";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_REQUEST_BYTES = 65_536;
const STORE_KEYS = Object.freeze(["allowMemory", "initialize", "maximumLiveRequests", "path"]);
const CLAIM_KEYS = Object.freeze(["expiresAt", "now", "requesterKeyId", "requestId"]);
const CONSUME_KEYS = Object.freeze(["expiresAt", "now", "requesterKeyId", "requestId"]);
const READER_KEYS = Object.freeze(["read"]);
const ROUTE_KEYS = Object.freeze([
  "expectedRequesterKeyId",
  "maximumRequestBytes",
  "maxClockSkewSeconds",
  "minimumEvmSafetySeconds",
  "nowSeconds",
  "packetReader",
  "providerKeyId",
  "providerOrigin",
  "providerPrivateKey",
  "replayStore",
  "requesterPublicKey",
  "responseTtlSeconds",
  "timeoutMs",
]);
const STORE_CONSTRUCTOR_TOKEN = Symbol("TreeSwap private packet replay store");
const INNER_REQUESTER_NAMESPACE = "private-packet";
const replayStores = new WeakSet();
const replayClaims = new WeakMap();
const packetReaders = new WeakSet();
const providerRoutes = new WeakSet();

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
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
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotPlainData(value, name, state = { depth: 0, counter: { value: 0 } }) {
  state.counter.value += 1;
  if (state.counter.value > 512 || state.depth > 16) {
    throw new RangeError(`${name} is outside the bounded data policy`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 16_384) throw new RangeError(`${name} string is too large`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== "object") throw new TypeError(`${name} contains an unsupported value`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
      throw new TypeError(`${name} contains an unsupported array`);
    }
    const expected = [...Array(value.length).keys()].map(String).concat("length");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length
        || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
      throw new TypeError(`${name} array fields are not exact`);
    }
    return Object.freeze([...Array(value.length).keys()].map((index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${name}[${index}] must be an enumerable data property`);
      }
      return snapshotPlainData(descriptor.value, `${name}[${index}]`, {
        depth: state.depth + 1,
        counter: state.counter,
      });
    }));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} contains an unsupported object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} object fields are outside policy`);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name}.${key} must be an enumerable data property`);
    }
    result[key] = snapshotPlainData(descriptor.value, `${name}.${key}`, {
      depth: state.depth + 1,
      counter: state.counter,
    });
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
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function keyId(value, name) {
  const raw = String(value ?? "");
  if (!KEY_ID.test(raw)) throw new TypeError(`${name} is invalid`);
  return raw;
}

function privateEd25519Key(value, name) {
  let key;
  try {
    key = value?.type === "private" ? value : createPrivateKey(value);
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`${name} must be Ed25519`);
  return key;
}

function publicEd25519Key(value, name) {
  let key;
  try {
    key = value?.type === "public" ? value : createPublicKey(value);
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`${name} must be Ed25519`);
  return key;
}

export class SolverPrivatePacketReplayStore {
  #inner;
  #closed = false;

  constructor(inner, token) {
    if (token !== STORE_CONSTRUCTOR_TOKEN || !isSolverDaemonEvidenceReplayStore(inner)) {
      throw new TypeError("private packet replay stores must be opened through the factory");
    }
    this.#inner = inner;
    replayStores.add(this);
    Object.freeze(this);
  }

  static async open(input) {
    const source = exactDataRecord(input, STORE_KEYS, "private packet replay store");
    const inner = await SolverDaemonEvidenceReplayStore.open(source);
    return new SolverPrivatePacketReplayStore(inner, STORE_CONSTRUCTOR_TOKEN);
  }

  #assertOpen() {
    if (this.#closed) throw new Error("private packet replay store is closed");
  }

  observeTime(input) {
    this.#assertOpen();
    return this.#inner.observeTime(input);
  }

  claim(input) {
    this.#assertOpen();
    const source = exactDataRecord(input, CLAIM_KEYS, "private packet replay claim");
    const requesterKeyId = keyId(source.requesterKeyId, "private packet replay requesterKeyId");
    const requestId = bytes32(source.requestId, "private packet replay requestId");
    const expiresAt = integer(source.expiresAt, "private packet replay request expiry", 1);
    const now = integer(source.now, "private packet replay claim time", 1);
    const innerClaim = this.#inner.claim({
      requesterKeyId: INNER_REQUESTER_NAMESPACE,
      requestId,
      expiresAt,
      now,
    });
    if (!innerClaim) return null;
    const claim = Object.freeze({
      schema: SOLVER_PRIVATE_PACKET_REPLAY_SCHEMA,
      status: "request-claimed",
      expiresAt,
    });
    replayClaims.set(claim, Object.freeze({
      store: this,
      innerClaim,
      requesterKeyId,
      requestId,
      expiresAt,
      consumed: false,
    }));
    return claim;
  }

  consume(claim, input) {
    this.#assertOpen();
    const context = replayClaims.get(claim);
    if (!context || context.store !== this) {
      throw new TypeError("private packet replay claim provenance is invalid");
    }
    if (context.consumed) return false;
    const source = exactDataRecord(input, CONSUME_KEYS, "private packet replay consumption");
    const requesterKeyId = keyId(source.requesterKeyId, "private packet replay requesterKeyId");
    const requestId = bytes32(source.requestId, "private packet replay requestId");
    const expiresAt = integer(source.expiresAt, "private packet replay request expiry", 1);
    const now = integer(source.now, "private packet replay consumption time", 1);
    if (requesterKeyId !== context.requesterKeyId
        || requestId !== context.requestId || expiresAt !== context.expiresAt) {
      return false;
    }
    const consumed = this.#inner.consume(context.innerClaim, {
      requesterKeyId: INNER_REQUESTER_NAMESPACE,
      requestId,
      expiresAt,
      now,
    });
    if (consumed) replayClaims.set(claim, Object.freeze({ ...context, consumed: true }));
    return consumed;
  }

  status(input) {
    this.#assertOpen();
    const status = this.#inner.status(input);
    return Object.freeze({
      schema: SOLVER_PRIVATE_PACKET_REPLAY_SCHEMA,
      status: "healthy-private-packet-replay-store",
      liveClaimedRequests: status.liveClaimedRequests,
      liveConsumedRequests: status.liveConsumedRequests,
      expiredRequestsAwaitingCleanup: status.expiredRequestsAwaitingCleanup,
      maximumLiveRequests: status.maximumLiveRequests,
    });
  }

  get path() {
    return this.#inner.path;
  }

  close() {
    if (this.#closed) return false;
    this.#closed = true;
    replayStores.delete(this);
    return this.#inner.close();
  }
}

Object.freeze(SolverPrivatePacketReplayStore.prototype);
Object.freeze(SolverPrivatePacketReplayStore);

export function isSolverPrivatePacketReplayStore(value) {
  return Boolean(value && replayStores.has(value));
}

export function createSolverPrivatePacketProviderReader(input) {
  const source = exactDataRecord(input, READER_KEYS, "private packet provider reader");
  if (typeof source.read !== "function") {
    throw new TypeError("private packet provider reader requires a read function");
  }
  const readImpl = source.read;
  const reader = Object.freeze({
    read: (request, options) => readImpl(request, options),
  });
  packetReaders.add(reader);
  return reader;
}

export function isSolverPrivatePacketProviderReader(value) {
  return Boolean(value && packetReaders.has(value));
}

async function boundedRequestJson(request, maximumBytes, signal) {
  const contentType = String(request.headers?.get?.("content-type") ?? "")
    .split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("private packet provider content type is invalid");
  const cacheControl = String(request.headers.get("cache-control") ?? "").toLowerCase();
  if (!cacheControl.split(",").some((value) => value.trim() === "no-store")) {
    throw new Error("private packet provider request must disable storage");
  }
  const contentEncoding = String(request.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (contentEncoding !== "identity") throw new Error("private packet provider content encoding is invalid");
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null && !/^[0-9]+$/.test(declaredHeader)) {
    throw new Error("private packet provider content length is invalid");
  }
  if (Number(declaredHeader ?? 0) > maximumBytes) throw new Error("private packet provider request is too large");
  if (!request.body) throw new Error("private packet provider request body is empty");
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (signal?.aborted) cancel();
  else signal?.addEventListener?.("abort", cancel, { once: true });
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new Error("private packet provider request is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener?.("abort", cancel);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("private packet provider request is malformed");
  }
}

function jsonResponse(status, body) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  if (bytes.length > MAX_REQUEST_BYTES) throw new Error("private packet provider response is too large");
  return new Response(bytes, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-length": String(bytes.length),
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
  });
}

function requestShape(value) {
  return value instanceof Request;
}

function responseExpiry({ packet, request, responseAt, responseTtlSeconds }) {
  const quoteExpiresAt = integer(packet.quoteExpiresAt, "private packet quote expiry", 1);
  const actionExpiresAt = request.purpose === "EVM_CLAIM"
    ? integer(packet.evmRefundAt, "private packet EVM refund time", 1)
    : integer(packet.lightningActionDeadline, "private packet Lightning deadline", 1);
  const expiresAt = Math.min(
    request.expiresAt,
    quoteExpiresAt,
    actionExpiresAt,
    responseAt + responseTtlSeconds,
  );
  if (expiresAt <= responseAt) throw new Error("private packet provider response has no live authority window");
  return expiresAt;
}

export async function createSolverPrivatePacketProviderRoute(input) {
  const source = exactDataRecord(input, ROUTE_KEYS, "private packet provider route");
  if (!isSolverPrivatePacketReplayStore(source.replayStore)) {
    throw new TypeError("private packet provider requires the concrete durable replay store");
  }
  if (!isSolverPrivatePacketProviderReader(source.packetReader)) {
    throw new TypeError("private packet provider requires the concrete packet reader");
  }
  if (typeof source.nowSeconds !== "function") throw new TypeError("private packet provider requires a clock");
  const nowSeconds = source.nowSeconds;
  const origin = privatePacketProviderOrigin(source.providerOrigin);
  const requesterPublicKey = publicEd25519Key(
    source.requesterPublicKey,
    "private packet provider requester public key",
  );
  const expectedRequesterKeyId = keyId(
    source.expectedRequesterKeyId,
    "private packet provider expected requester key ID",
  );
  const providerPrivateKey = privateEd25519Key(
    source.providerPrivateKey,
    "private packet provider private key",
  );
  const providerKeyId = keyId(source.providerKeyId, "private packet provider key ID");
  const maximumRequestBytes = integer(
    source.maximumRequestBytes,
    "private packet provider maximum request bytes",
    1_024,
    MAX_REQUEST_BYTES,
  );
  const maxClockSkewSeconds = integer(
    source.maxClockSkewSeconds,
    "private packet provider maximum clock skew",
    0,
    5,
  );
  const minimumEvmSafetySeconds = integer(
    source.minimumEvmSafetySeconds,
    "private packet provider minimum EVM safety seconds",
    1,
    86_400,
  );
  const responseTtlSeconds = integer(
    source.responseTtlSeconds,
    "private packet provider response TTL",
    1,
    30,
  );
  const timeoutMs = integer(
    source.timeoutMs,
    "private packet provider timeout",
    1,
    30_000,
  );
  const replayStore = source.replayStore;
  const readPacket = source.packetReader.read;

  const handle = async (webRequest) => {
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort();
    webRequest?.signal?.addEventListener?.("abort", abortFromRequest, { once: true });
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("private packet provider timed out"));
      }, timeoutMs);
    });
    try {
      const startedAt = integer(nowSeconds(), "private packet provider request start time", 1);
      if (!requestShape(webRequest) || webRequest.method !== "POST") {
        throw new Error("private packet provider request method is invalid");
      }
      const url = new URL(webRequest.url);
      if (url.origin !== origin || url.pathname !== "/v1/private-packet" || url.search || url.hash) {
        throw new Error("private packet provider request target is invalid");
      }
      replayStore.observeTime({ now: startedAt });
      const rawEnvelope = await Promise.race([
        boundedRequestJson(webRequest, maximumRequestBytes, controller.signal),
        deadline,
      ]);
      const requestEnvelope = snapshotPlainData(rawEnvelope, "private packet provider request envelope");
      const verifiedAt = integer(nowSeconds(), "private packet provider verification time", 1);
      replayStore.observeTime({ now: verifiedAt });
      const request = verifyPrivatePacketRequest({
        envelope: requestEnvelope,
        publicKey: requesterPublicKey,
        expectedKeyId: expectedRequesterKeyId,
        now: verifiedAt,
        maxClockSkewSeconds,
      });
      const claim = replayStore.claim({
        requesterKeyId: request.requesterKeyId,
        requestId: request.requestId,
        expiresAt: request.expiresAt,
        now: verifiedAt,
      });
      if (!claim) throw new Error("private packet provider request was already claimed");
      if (controller.signal.aborted) throw new Error("private packet provider request was aborted");
      const rawPacket = await Promise.race([
        readPacket(request, { signal: controller.signal }),
        deadline,
      ]);
      if (controller.signal.aborted) throw new Error("private packet provider request was aborted");
      const packet = snapshotPlainData(rawPacket, "private packet provider reader result");
      const responseAt = integer(nowSeconds(), "private packet provider response time", 1);
      replayStore.observeTime({ now: responseAt });
      const requestDigest = privatePacketRequestDigest(request);
      const expiresAt = responseExpiry({ packet, request, responseAt, responseTtlSeconds });
      const response = await buildSignedPrivatePacketResponse({
        requestEnvelope,
        requesterPublicKey,
        expectedRequesterKeyId,
        packet,
        providerKeyId,
        providerPrivateKey,
        consumeRequest: (descriptor) => {
          const consumed = exactDataRecord(descriptor, [
            "expiresAt", "requestDigest", "requesterKeyId", "requestId", "servedAt",
          ], "private packet provider replay descriptor");
          if (consumed.requesterKeyId !== request.requesterKeyId
              || consumed.requestId !== request.requestId
              || consumed.requestDigest !== requestDigest
              || consumed.servedAt !== responseAt
              || consumed.expiresAt !== request.expiresAt) {
            return false;
          }
          const consumedAt = integer(nowSeconds(), "private packet provider consumption time", 1);
          replayStore.observeTime({ now: consumedAt });
          return replayStore.consume(claim, {
            requesterKeyId: request.requesterKeyId,
            requestId: request.requestId,
            expiresAt: request.expiresAt,
            now: consumedAt,
          });
        },
        servedAt: responseAt,
        expiresAt,
        minimumEvmSafetySeconds,
      });
      if (controller.signal.aborted) throw new Error("private packet provider request was aborted");
      const completedAt = integer(nowSeconds(), "private packet provider completion time", 1);
      replayStore.observeTime({ now: completedAt });
      if (response.expiresAt <= completedAt) {
        throw new Error("private packet provider response expired before delivery");
      }
      return jsonResponse(200, response);
    } catch {
      return jsonResponse(400, { error: "private packet request rejected" });
    } finally {
      clearTimeout(timer);
      controller.abort();
      webRequest?.signal?.removeEventListener?.("abort", abortFromRequest);
    }
  };

  const route = Object.freeze({
    handle,
    status: (...statusArguments) => {
      if (statusArguments.length !== 0) {
        throw new TypeError("private packet provider status accepts no caller input");
      }
      const now = integer(nowSeconds(), "private packet provider status time", 1);
      replayStore.observeTime({ now });
      return replayStore.status({ now });
    },
  });
  providerRoutes.add(route);
  return route;
}

export function isSolverPrivatePacketProviderRoute(value) {
  return Boolean(value && providerRoutes.has(value));
}
