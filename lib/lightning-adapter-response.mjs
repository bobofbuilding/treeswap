import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";

export const LIGHTNING_ADAPTER_RESPONSE_SCHEMA = "treeswap.lightning-adapter-response.v1";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const ENVELOPE_FIELDS = Object.freeze(["payload", "signature"]);
const PAYLOAD_FIELDS = Object.freeze(["body", "keyId", "schema"]);
const SIGN_FIELDS = Object.freeze(["body", "keyId", "privateKey"]);
const VERIFY_FIELDS = Object.freeze(["envelope", "expectedKeyId", "publicKey"]);

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const actual = [...keys].sort();
  const wanted = [...expected].sort();
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

function snapshotJson(value, name, state = { depth: 0, nodes: { value: 0 } }) {
  state.nodes.value += 1;
  if (state.depth > 16 || state.nodes.value > 65_536) {
    throw new RangeError(`${name} is outside the bounded response policy`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 8_192) throw new RangeError(`${name} string is too long`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} number must be a safe integer`);
    return value;
  }
  if (!value || typeof value !== "object") throw new TypeError(`${name} contains an unsupported value`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 4_096) {
      throw new TypeError(`${name} contains an unsupported array`);
    }
    const keys = Reflect.ownKeys(value);
    const expected = ["length", ...Array.from({ length: value.length }, (_, index) => String(index))].sort();
    const actual = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw new TypeError(`${name} array fields are not exact`);
    }
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${name}[${index}] must be an enumerable data property`);
      }
      result.push(snapshotJson(descriptor.value, `${name}[${index}]`, {
        depth: state.depth + 1,
        nodes: state.nodes,
      }));
    }
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} contains an unsupported object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 32 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} object fields are outside policy`);
  }
  const result = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > 80) throw new TypeError(`${name} contains an invalid field name`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name}.${key} must be an enumerable data property`);
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: snapshotJson(descriptor.value, `${name}.${key}`, {
        depth: state.depth + 1,
        nodes: state.nodes,
      }),
    });
  }
  return Object.freeze(result);
}

function keyId(value, name) {
  if (typeof value !== "string" || !KEY_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function privateEd25519Key(value) {
  let key;
  try {
    key = value?.type === "private" ? value : createPrivateKey(value);
  } catch {
    throw new TypeError("Lightning adapter response private key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Lightning adapter response private key must be Ed25519");
  }
  return key;
}

function publicEd25519Key(value) {
  let key;
  try {
    key = value?.type === "public" ? value : createPublicKey(value);
  } catch {
    throw new TypeError("Lightning adapter response public key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Lightning adapter response public key must be Ed25519");
  }
  return key;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function normalizePayload(value) {
  const source = exactDataRecord(value, PAYLOAD_FIELDS, "Lightning adapter response payload");
  if (source.schema !== LIGHTNING_ADAPTER_RESPONSE_SCHEMA) {
    throw new TypeError("Lightning adapter response schema is unsupported");
  }
  return Object.freeze({
    schema: LIGHTNING_ADAPTER_RESPONSE_SCHEMA,
    keyId: keyId(source.keyId, "Lightning adapter response key identifier"),
    body: snapshotJson(source.body, "Lightning adapter response body"),
  });
}

function responseDigest(payload) {
  return `0x${createHash("sha256").update(canonicalize(normalizePayload(payload))).digest("hex")}`;
}

function responseMessage(digest) {
  if (!BYTES32.test(digest)) throw new TypeError("Lightning adapter response digest is invalid");
  return Buffer.from(`TreeSwap Lightning adapter response v1\n${digest}\n`, "utf8");
}

function canonicalSignature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TypeError("Lightning adapter response signature is not canonical base64");
  }
  const signature = Buffer.from(value, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== value) {
    throw new TypeError("Lightning adapter response signature is invalid");
  }
  return signature;
}

export function signLightningAdapterResponseEnvelope(input) {
  const source = exactDataRecord(input, SIGN_FIELDS, "Lightning adapter response signing input");
  const payload = normalizePayload({
    schema: LIGHTNING_ADAPTER_RESPONSE_SCHEMA,
    keyId: source.keyId,
    body: source.body,
  });
  const digest = responseDigest(payload);
  return Object.freeze({
    payload,
    signature: signMessage(null, responseMessage(digest), privateEd25519Key(source.privateKey)).toString("base64"),
  });
}

export function verifyLightningAdapterResponseEnvelope(input) {
  const source = exactDataRecord(input, VERIFY_FIELDS, "Lightning adapter response verification input");
  const envelope = exactDataRecord(source.envelope, ENVELOPE_FIELDS, "Lightning adapter response envelope");
  const payload = normalizePayload(envelope.payload);
  const expectedKeyId = keyId(source.expectedKeyId, "expected Lightning adapter response key identifier");
  if (payload.keyId !== expectedKeyId) throw new Error("Lightning adapter response key is not active");
  const digest = responseDigest(payload);
  const publicKey = publicEd25519Key(source.publicKey);
  if (!verifyMessage(
    null,
    responseMessage(digest),
    publicKey,
    canonicalSignature(envelope.signature),
  )) throw new Error("Lightning adapter response signature is invalid");
  return Object.freeze({
    body: payload.body,
    keyId: payload.keyId,
    publicKeyDigest: `0x${createHash("sha256").update(
      publicKey.export({ format: "der", type: "spki" }),
    ).digest("hex")}`,
    responseDigest: digest,
  });
}
