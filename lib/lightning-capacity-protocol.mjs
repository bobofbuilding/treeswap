import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isPrivateLndHostname } from "./lnd-rest-client.mjs";
import { resolvePinnedPrivateAddress } from "./private-https-address.mjs";

export const LIGHTNING_CAPACITY_OBSERVATION_SCHEMA = "treeswap.lightning-capacity-observation.v1";
export const LIGHTNING_CAPACITY_REQUEST_SCHEMA = "treeswap.lightning-capacity-request.v1";
const AUTHENTICATED_LIGHTNING_CAPACITY_READERS = new WeakMap();

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMPRESSED_NODE_PUBKEY = /^(?:02|03)[0-9a-f]{64}$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const UINT64_MAX = (1n << 64n) - 1n;
const LIGHTNING_OBSERVATION_FIELDS = Object.freeze([
  "availableLightningSats", "budgetSats", "capabilityDigest", "capacityEpoch", "direction", "expiresAt",
  "grossLightningSats", "inFlightSats", "nodePubkey", "observedAt", "observerKeyId", "reserveSats",
  "requestId", "schema", "solverId",
]);
const LIGHTNING_REQUEST_FIELDS = Object.freeze([
  "capabilityDigest", "capacityEpoch", "direction", "expiresAt", "keyId", "lightningNodePubkey",
  "requestedAt", "requestId", "schema", "solverId",
]);
const PRODUCTION_READER_FIELDS = Object.freeze([
  "maxClockSkewSeconds",
  "maxObservationAgeSeconds",
  "maxObservationTtlSeconds",
  "maximumResponseBytes",
  "observerKeyId",
  "observerOrigin",
  "observerPublicKey",
  "requesterKeyId",
  "requesterPrivateKey",
  "timeoutMs",
]);
const TEST_READER_FIELDS = Object.freeze([
  "fetchObservation",
  "maxClockSkewSeconds",
  "maxObservationAgeSeconds",
  "maxObservationTtlSeconds",
  "nowSeconds",
  "observerKeyId",
  "observerPublicKey",
  "randomBytesImpl",
  "requesterKeyId",
  "requesterPrivateKey",
  "timeoutMs",
]);
const MAX_CAPACITY_RESPONSE_BYTES = 262_144;

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

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
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function uint(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > UINT64_MAX || String(value) !== parsed.toString()) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function address(value, name) {
  const raw = String(value ?? "");
  if (!ADDRESS.test(raw)) throw new TypeError(`${name} must be an Ethereum address`);
  return raw.toLowerCase();
}

function direction(value) {
  const raw = String(value ?? "");
  if (!DIRECTIONS.has(raw)) throw new RangeError("capacity direction is unsupported");
  return raw;
}

function nodePubkey(value) {
  const raw = String(value ?? "").toLowerCase();
  if (!COMPRESSED_NODE_PUBKEY.test(raw)) throw new TypeError("capacity node pubkey is invalid");
  return raw;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function canonicalBase64(value, bytes, name) {
  const raw = String(value ?? "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new TypeError(`${name} is not canonical base64`);
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== raw) throw new TypeError(`${name} is invalid`);
  return decoded;
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

function keyDer(key) {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  return publicKey.export({ format: "der", type: "spki" });
}

function digest(value) {
  return `0x${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function withDeadline(operation, timeoutMs, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

function abortSignal(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean"
      || typeof value.addEventListener !== "function" || typeof value.removeEventListener !== "function") {
    throw new TypeError("Lightning capacity abort signal is invalid");
  }
  return value;
}

export function lightningCapacityObserverOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new TypeError("Lightning capacity observer origin must be a bounded string");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Lightning capacity observer origin is invalid");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) {
    throw new TypeError("Lightning capacity observer must use private HTTPS on port 443");
  }
  if (url.username || url.password || url.search || url.hash || url.href !== `${url.origin}/`) {
    throw new TypeError("Lightning capacity observer URL must contain only its private origin");
  }
  if (!isPrivateLndHostname(url.hostname)) {
    throw new TypeError("Lightning capacity observer must target an explicitly private hostname");
  }
  return url.origin;
}

function headerValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined ? null : String(value);
}

export async function fixedLightningCapacityHttpsRequest(observerOrigin, envelope, {
  maximumResponseBytes = 65_536,
  signal = null,
} = {}, {
  httpsRequestImpl = httpsRequest,
  lookupImpl,
} = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Lightning capacity TLS certificate verification is disabled");
  }
  const origin = lightningCapacityObserverOrigin(observerOrigin);
  const requestSignal = abortSignal(signal);
  const maximumBytes = integer(
    maximumResponseBytes,
    "maximum Lightning capacity response bytes",
    MAX_CAPACITY_RESPONSE_BYTES,
  );
  if (maximumBytes < 1_024) throw new RangeError("Lightning capacity response limit is too small");
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TypeError("Lightning capacity request envelope is invalid");
  }
  const body = JSON.stringify(envelope);
  const url = new URL("/v1/capacity", `${origin}/`);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const target = lookupImpl === undefined
    ? await resolvePinnedPrivateAddress(hostname)
    : await resolvePinnedPrivateAddress(hostname, lookupImpl);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    let request;
    try {
      request = httpsRequestImpl({
        protocol: "https:",
        hostname: target.address,
        family: target.family,
        port: 443,
        servername: isIP(hostname) === 0 ? hostname : undefined,
        method: "POST",
        path: "/v1/capacity",
        agent: false,
        rejectUnauthorized: true,
        signal: requestSignal ?? undefined,
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          host: url.host,
        },
      }, (response) => {
        const contentType = String(headerValue(response.headers, "content-type") ?? "")
          .split(";", 1)[0].trim().toLowerCase();
        const cacheControl = String(headerValue(response.headers, "cache-control") ?? "").toLowerCase();
        const contentEncoding = String(headerValue(response.headers, "content-encoding") ?? "identity").toLowerCase();
        const declaredHeader = headerValue(response.headers, "content-length");
        const transferEncoding = headerValue(response.headers, "transfer-encoding");
        if ((response.statusCode ?? 0) !== 200 || contentType !== "application/json"
            || !cacheControl.split(",").some((entry) => entry.trim() === "no-store")
            || (contentEncoding !== "" && contentEncoding !== "identity")
            || (declaredHeader !== null && !/^(?:0|[1-9][0-9]*)$/.test(declaredHeader))
            || (declaredHeader !== null && transferEncoding !== null)
            || Number(declaredHeader ?? 0) > maximumBytes) {
          response.destroy?.();
          finish(reject, new Error("Lightning capacity observer returned an invalid response"));
          return;
        }
        const chunks = [];
        let received = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          const bytes = Buffer.from(chunk);
          received += bytes.length;
          if (received > maximumBytes) {
            response.destroy?.();
            finish(reject, new Error("Lightning capacity observer response exceeded its size limit"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("aborted", () => finish(reject, new Error("Lightning capacity observer response was interrupted")));
        response.on("error", (error) => finish(reject, error));
        response.on("end", () => {
          if (declaredHeader !== null && received !== Number(declaredHeader)) {
            finish(reject, new Error("Lightning capacity observer response length changed"));
            return;
          }
          try {
            finish(resolve, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            finish(reject, new Error("Lightning capacity observer response was not JSON"));
          }
        });
      });
      request.on("error", (error) => finish(reject, error));
      request.end(body);
    } catch (error) {
      request?.destroy?.();
      finish(reject, error);
    }
  });
}

function normalizeLightningRequestPayload(raw) {
  exactKeys(raw, LIGHTNING_REQUEST_FIELDS, "Lightning capacity request payload");
  const payload = Object.freeze({
    schema: String(raw.schema ?? ""),
    requestId: bytes32(raw.requestId, "Lightning capacity request ID"),
    capabilityDigest: bytes32(raw.capabilityDigest, "Lightning capability digest"),
    capacityEpoch: uint(raw.capacityEpoch, "requested Lightning capacity epoch").toString(),
    direction: direction(raw.direction),
    solverId: address(raw.solverId, "Lightning solver"),
    lightningNodePubkey: nodePubkey(raw.lightningNodePubkey),
    requestedAt: integer(raw.requestedAt, "Lightning capacity requestedAt"),
    expiresAt: integer(raw.expiresAt, "Lightning capacity request expiresAt"),
    keyId: String(raw.keyId ?? ""),
  });
  if (payload.schema !== LIGHTNING_CAPACITY_REQUEST_SCHEMA) throw new TypeError("Lightning capacity request schema is unsupported");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(payload.keyId)) {
    throw new TypeError("Lightning capacity requester key identifier is invalid");
  }
  return payload;
}

export function lightningCapacityRequestDigest(payload) {
  return digest(normalizeLightningRequestPayload(payload));
}

function lightningCapacityRequestMessage(value) {
  return Buffer.from(`TreeSwap Lightning capacity request v1\n${bytes32(value, "capacity request digest")}\n`, "utf8");
}

export function signLightningCapacityRequest(payload, privateKey) {
  const normalized = normalizeLightningRequestPayload(payload);
  const key = privateEd25519Key(privateKey, "Lightning capacity requester private key");
  return Object.freeze({
    payload: normalized,
    signature: signMessage(
      null,
      lightningCapacityRequestMessage(lightningCapacityRequestDigest(normalized)),
      key,
    ).toString("base64"),
  });
}

export function verifyLightningCapacityRequest({
  envelope,
  publicKey,
  expectedKeyId,
  now,
  maxLifetimeSeconds,
  maxClockSkewSeconds,
}) {
  exactKeys(envelope, ["payload", "signature"], "Lightning capacity request envelope");
  const payload = normalizeLightningRequestPayload(envelope.payload);
  const signature = canonicalBase64(envelope.signature, 64, "Lightning capacity request signature");
  const key = publicEd25519Key(publicKey, "Lightning capacity requester public key");
  const observedAt = integer(now, "Lightning capacity request verification timestamp");
  const maximumLifetime = integer(maxLifetimeSeconds, "maximum Lightning capacity request lifetime", 60);
  const maximumSkew = integer(maxClockSkewSeconds, "maximum Lightning capacity request clock skew", 60);
  if (maximumLifetime === 0 || payload.keyId !== expectedKeyId
      || payload.requestedAt > observedAt + maximumSkew || payload.expiresAt <= observedAt
      || payload.expiresAt <= payload.requestedAt || payload.expiresAt - payload.requestedAt > maximumLifetime) {
    throw new Error("Lightning capacity request is outside its authority window");
  }
  if (!verifyMessage(
    null,
    lightningCapacityRequestMessage(lightningCapacityRequestDigest(payload)),
    key,
    signature,
  )) throw new Error("Lightning capacity request signature is invalid");
  return payload;
}

function normalizeLightningObservation(raw) {
  exactKeys(raw, LIGHTNING_OBSERVATION_FIELDS, "Lightning capacity observation");
  const observation = Object.freeze({
    schema: String(raw.schema ?? ""),
    requestId: bytes32(raw.requestId, "Lightning capacity request ID"),
    capabilityDigest: bytes32(raw.capabilityDigest, "Lightning capability digest"),
    direction: direction(raw.direction),
    solverId: address(raw.solverId, "Lightning solver"),
    nodePubkey: nodePubkey(raw.nodePubkey),
    capacityEpoch: uint(raw.capacityEpoch, "Lightning capacity epoch").toString(),
    grossLightningSats: uint(raw.grossLightningSats, "gross Lightning capacity").toString(),
    inFlightSats: uint(raw.inFlightSats, "Lightning in-flight amount").toString(),
    reserveSats: uint(raw.reserveSats, "Lightning reserve").toString(),
    budgetSats: uint(raw.budgetSats, "Lightning budget").toString(),
    availableLightningSats: uint(raw.availableLightningSats, "available Lightning capacity").toString(),
    observedAt: integer(raw.observedAt, "Lightning observedAt"),
    expiresAt: integer(raw.expiresAt, "Lightning expiresAt"),
    observerKeyId: String(raw.observerKeyId ?? ""),
  });
  if (observation.schema !== LIGHTNING_CAPACITY_OBSERVATION_SCHEMA) {
    throw new TypeError("Lightning capacity observation schema is unsupported");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(observation.observerKeyId)) {
    throw new TypeError("Lightning observer key identifier is invalid");
  }
  const gross = BigInt(observation.grossLightningSats);
  const deductions = BigInt(observation.inFlightSats) + BigInt(observation.reserveSats);
  const net = gross > deductions ? gross - deductions : 0n;
  const expectedAvailable = net < BigInt(observation.budgetSats) ? net : BigInt(observation.budgetSats);
  if (BigInt(observation.availableLightningSats) !== expectedAvailable) {
    throw new Error("Lightning capacity deductions are inconsistent");
  }
  return observation;
}

export function lightningCapacityObservationDigest(observation) {
  return digest(normalizeLightningObservation(observation));
}

function lightningCapacityMessage(value) {
  return Buffer.from(`TreeSwap Lightning capacity observation v1\n${bytes32(value, "capacity digest")}\n`, "utf8");
}

export function signLightningCapacityObservation(observation, privateKey) {
  const normalized = normalizeLightningObservation(observation);
  const key = privateEd25519Key(privateKey, "Lightning observer private key");
  const observationDigest = lightningCapacityObservationDigest(normalized);
  return Object.freeze({
    observation: normalized,
    signature: signMessage(null, lightningCapacityMessage(observationDigest), key).toString("base64"),
  });
}

export function buildLightningCapacityObservation({ request, aggregate, observerKeyId, expiresAt }) {
  const payload = normalizeLightningRequestPayload(request);
  exactKeys(aggregate, [
    "availableLightningSats", "budgetSats", "capacityEpoch", "grossLightningSats", "inFlightSats",
    "nodePubkey", "observedAt", "reserveSats",
  ], "Lightning capacity aggregate");
  if (String(aggregate.capacityEpoch) !== payload.capacityEpoch
      || nodePubkey(aggregate.nodePubkey) !== payload.lightningNodePubkey) {
    throw new Error("Lightning capacity aggregate does not match the authorized request");
  }
  return normalizeLightningObservation({
    schema: LIGHTNING_CAPACITY_OBSERVATION_SCHEMA,
    requestId: payload.requestId,
    capabilityDigest: payload.capabilityDigest,
    capacityEpoch: payload.capacityEpoch,
    direction: payload.direction,
    solverId: payload.solverId,
    nodePubkey: payload.lightningNodePubkey,
    grossLightningSats: String(aggregate.grossLightningSats),
    inFlightSats: String(aggregate.inFlightSats),
    reserveSats: String(aggregate.reserveSats),
    budgetSats: String(aggregate.budgetSats),
    availableLightningSats: String(aggregate.availableLightningSats),
    observedAt: aggregate.observedAt,
    expiresAt,
    observerKeyId,
  });
}

function normalizeLightningReaderRequest(raw) {
  exactKeys(raw, [
    "capabilityDigest", "capacityEpoch", "direction", "endpointOrigin", "endpointPublicKey",
    "lightningNodePubkey", "solverId",
  ], "Lightning capacity request");
  return Object.freeze({
    capabilityDigest: bytes32(raw.capabilityDigest, "Lightning capability digest"),
    capacityEpoch: uint(raw.capacityEpoch, "requested Lightning capacity epoch").toString(),
    direction: direction(raw.direction),
    endpointOrigin: String(raw.endpointOrigin ?? ""),
    endpointPublicKey: publicEd25519Key(raw.endpointPublicKey, "solver endpoint public key"),
    lightningNodePubkey: nodePubkey(raw.lightningNodePubkey),
    solverId: address(raw.solverId, "Lightning solver"),
  });
}

function createLightningCapacityReader(source, transportMode) {
  const observerKey = publicEd25519Key(source.observerPublicKey, "Lightning observer public key");
  const expectedKeyId = String(source.observerKeyId ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(expectedKeyId)) throw new TypeError("Lightning observer key identifier is invalid");
  const requesterKey = privateEd25519Key(source.requesterPrivateKey, "Lightning capacity requester private key");
  const capacityRequesterKeyId = String(source.requesterKeyId ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(capacityRequesterKeyId)) {
    throw new TypeError("Lightning capacity requester key identifier is invalid");
  }
  if (keyDer(requesterKey).equals(keyDer(observerKey))) {
    throw new Error("Lightning capacity requester and observer keys must be separate");
  }
  const maxAge = integer(source.maxObservationAgeSeconds, "maximum Lightning observation age", 300);
  const maxSkew = integer(source.maxClockSkewSeconds, "maximum Lightning clock skew", 60);
  const maxTtl = integer(source.maxObservationTtlSeconds, "maximum Lightning observation TTL", 300);
  const deadlineMs = integer(source.timeoutMs, "Lightning reader timeout", 30_000);
  if (maxAge === 0 || maxTtl === 0 || deadlineMs === 0) throw new RangeError("Lightning reader windows must be positive");
  const nowSeconds = transportMode === "fixed-node-https"
    ? () => Math.floor(Date.now() / 1_000)
    : source.nowSeconds;
  const randomBytesImpl = transportMode === "fixed-node-https" ? randomBytes : source.randomBytesImpl;
  if (typeof nowSeconds !== "function" || typeof randomBytesImpl !== "function") {
    throw new TypeError("Lightning reader clock and entropy source are required");
  }
  let observerOrigin = null;
  let maximumResponseBytes = null;
  if (transportMode === "fixed-node-https") {
    observerOrigin = lightningCapacityObserverOrigin(source.observerOrigin);
    maximumResponseBytes = integer(
      source.maximumResponseBytes,
      "maximum Lightning capacity response bytes",
      MAX_CAPACITY_RESPONSE_BYTES,
    );
    if (maximumResponseBytes < 1_024) throw new RangeError("Lightning capacity response limit is too small");
  } else if (typeof source.fetchObservation !== "function") {
    throw new TypeError("test Lightning capacity observation fetcher is required");
  }

  const reader = async function readVerifiedLightningCapacity(rawRequest) {
    const request = normalizeLightningReaderRequest(rawRequest);
    if (keyDer(request.endpointPublicKey).equals(keyDer(observerKey))) {
      throw new Error("Lightning observer key must be independent from the solver endpoint key");
    }
    const requestedAt = integer(nowSeconds(), "Lightning capacity request timestamp");
    const entropy = randomBytesImpl(32);
    if (!Buffer.isBuffer(entropy) || entropy.length !== 32) throw new Error("Lightning request entropy source failed");
    const requestEnvelope = signLightningCapacityRequest({
      schema: LIGHTNING_CAPACITY_REQUEST_SCHEMA,
      requestId: `0x${entropy.toString("hex")}`,
      capabilityDigest: request.capabilityDigest,
      capacityEpoch: request.capacityEpoch,
      direction: request.direction,
      solverId: request.solverId,
      lightningNodePubkey: request.lightningNodePubkey,
      requestedAt,
      expiresAt: requestedAt + Math.min(maxTtl, 30),
      keyId: capacityRequesterKeyId,
    }, requesterKey);
    let envelope;
    if (transportMode === "fixed-node-https") {
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Lightning capacity observation timed out"));
        }, deadlineMs);
      });
      try {
        envelope = await Promise.race([
          fixedLightningCapacityHttpsRequest(observerOrigin, requestEnvelope, {
            maximumResponseBytes,
            signal: controller.signal,
          }),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    } else {
      envelope = await withDeadline(
        Promise.resolve().then(() => source.fetchObservation(requestEnvelope)),
        deadlineMs,
        "Lightning capacity observation timed out",
      );
    }
    exactKeys(envelope, ["observation", "signature"], "Lightning capacity envelope");
    const observation = normalizeLightningObservation(envelope.observation);
    const signature = canonicalBase64(envelope.signature, 64, "Lightning capacity signature");
    const observationDigest = lightningCapacityObservationDigest(observation);
    if (!verifyMessage(null, lightningCapacityMessage(observationDigest), observerKey, signature)) {
      throw new Error("Lightning capacity observation signature is invalid");
    }
    if (observation.observerKeyId !== expectedKeyId) throw new Error("Lightning observer key identifier changed");
    if (observation.capabilityDigest !== request.capabilityDigest
        || observation.capacityEpoch !== request.capacityEpoch || observation.direction !== request.direction
        || observation.nodePubkey !== request.lightningNodePubkey || observation.solverId !== request.solverId
        || observation.requestId !== requestEnvelope.payload.requestId) {
      throw new Error("Lightning capacity observation binding changed");
    }
    const observedAt = integer(nowSeconds(), "Lightning verification timestamp");
    if (observation.observedAt > observedAt + maxSkew || observedAt - observation.observedAt > maxAge
        || observation.expiresAt <= observedAt || observation.expiresAt <= observation.observedAt
        || observation.expiresAt > requestEnvelope.payload.expiresAt
        || observation.expiresAt - observation.observedAt > maxTtl) {
      throw new Error("Lightning capacity observation is outside its time window");
    }
    return Object.freeze({
      availableLightningSats: observation.availableLightningSats,
      capacityEpoch: observation.capacityEpoch,
      nodePubkey: observation.nodePubkey,
      observedAt: observation.observedAt,
    });
  };
  AUTHENTICATED_LIGHTNING_CAPACITY_READERS.set(reader, Object.freeze({
    observerOrigin,
    transportMode,
  }));
  return reader;
}

export function createAuthenticatedLightningCapacityReader(input) {
  const source = exactDataRecord(input, PRODUCTION_READER_FIELDS, "production Lightning capacity reader");
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Lightning capacity TLS certificate verification is disabled");
  }
  return createLightningCapacityReader(source, "fixed-node-https");
}

export function createTestAuthenticatedLightningCapacityReader(input) {
  const source = exactDataRecord(input, TEST_READER_FIELDS, "test Lightning capacity reader");
  return createLightningCapacityReader(source, "injected-test");
}

export function isAuthenticatedLightningCapacityReader(value) {
  return Boolean(value && AUTHENTICATED_LIGHTNING_CAPACITY_READERS.has(value));
}

export function isProductionAuthenticatedLightningCapacityReader(value) {
  return AUTHENTICATED_LIGHTNING_CAPACITY_READERS.get(value)?.transportMode === "fixed-node-https";
}

export function lightningCapacityReaderTransportMode(value) {
  const mode = AUTHENTICATED_LIGHTNING_CAPACITY_READERS.get(value)?.transportMode;
  if (!mode) throw new TypeError("Lightning capacity reader lacks factory provenance");
  return mode;
}
