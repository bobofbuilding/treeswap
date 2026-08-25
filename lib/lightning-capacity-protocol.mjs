import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";

export const LIGHTNING_CAPACITY_OBSERVATION_SCHEMA = "treeswap.lightning-capacity-observation.v1";
export const LIGHTNING_CAPACITY_REQUEST_SCHEMA = "treeswap.lightning-capacity-request.v1";
const AUTHENTICATED_LIGHTNING_CAPACITY_READERS = new WeakSet();

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

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
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

export function createAuthenticatedLightningCapacityReader({
  observerPublicKey,
  observerKeyId,
  requesterPrivateKey,
  requesterKeyId,
  fetchObservation,
  maxObservationAgeSeconds,
  maxClockSkewSeconds,
  maxObservationTtlSeconds,
  timeoutMs = 5_000,
  randomBytesImpl = randomBytes,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
}) {
  const observerKey = publicEd25519Key(observerPublicKey, "Lightning observer public key");
  const expectedKeyId = String(observerKeyId ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(expectedKeyId)) throw new TypeError("Lightning observer key identifier is invalid");
  if (typeof fetchObservation !== "function") throw new TypeError("Lightning capacity observation fetcher is required");
  const requesterKey = privateEd25519Key(requesterPrivateKey, "Lightning capacity requester private key");
  const capacityRequesterKeyId = String(requesterKeyId ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(capacityRequesterKeyId)) {
    throw new TypeError("Lightning capacity requester key identifier is invalid");
  }
  const maxAge = integer(maxObservationAgeSeconds, "maximum Lightning observation age", 300);
  const maxSkew = integer(maxClockSkewSeconds, "maximum Lightning clock skew", 60);
  const maxTtl = integer(maxObservationTtlSeconds, "maximum Lightning observation TTL", 300);
  const deadlineMs = integer(timeoutMs, "Lightning reader timeout", 30_000);
  if (maxAge === 0 || maxTtl === 0 || deadlineMs === 0) throw new RangeError("Lightning reader windows must be positive");
  if (typeof nowSeconds !== "function" || typeof randomBytesImpl !== "function") {
    throw new TypeError("Lightning reader clock and entropy source are required");
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
    const envelope = await withDeadline(
      Promise.resolve().then(() => fetchObservation(requestEnvelope)),
      deadlineMs,
      "Lightning capacity observation timed out",
    );
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
  AUTHENTICATED_LIGHTNING_CAPACITY_READERS.add(reader);
  return reader;
}

export function isAuthenticatedLightningCapacityReader(value) {
  return Boolean(value && AUTHENTICATED_LIGHTNING_CAPACITY_READERS.has(value));
}
