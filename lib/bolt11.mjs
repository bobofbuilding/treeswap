import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { secp256k1 } from "@noble/curves/secp256k1";

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_INDEX = new Map([...BECH32_ALPHABET].map((character, index) => [character, index]));
const BECH32_GENERATORS = Object.freeze([0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]);
const NETWORK_PREFIXES = Object.freeze([
  Object.freeze(["lnbcrt", "regtest"]),
  Object.freeze(["lntbs", "signet"]),
  Object.freeze(["lntb", "testnet"]),
  Object.freeze(["lnbc", "mainnet"]),
]);
const FIXED_TAG_LENGTHS = Object.freeze({ h: 52, n: 53, p: 52, s: 52 });
const SINGLETON_TAGS = Object.freeze(["p", "s", "d", "h", "n", "x", "c", "9"]);
const INVOICE_FEATURE_PAIRS = Object.freeze([
  Object.freeze([8, 9]),
  Object.freeze([14, 15]),
  Object.freeze([16, 17]),
  Object.freeze([24, 25]),
  Object.freeze([36, 37]),
  Object.freeze([48, 49]),
]);
const KNOWN_INVOICE_FEATURE_BITS = new Set(INVOICE_FEATURE_PAIRS.flat());
const SUPPORTED_REQUIRED_FEATURE_BITS = new Set([8, 14, 16, 48]);
const SIGNATURE_WORDS = 104;
const TIMESTAMP_WORDS = 7;
const MAXIMUM_TAGS = 128;
const MAXIMUM_UINT64 = (1n << 64n) - 1n;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
const DECODED_INVOICES = new WeakSet();

export class Bolt11DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "Bolt11DecodeError";
  }
}

function fail(message) {
  throw new Bolt11DecodeError(message);
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

export function normalizeBolt11Invoice(value) {
  if (typeof value !== "string") throw new TypeError("BOLT 11 invoice must be a string");
  const trimmed = value.trim();
  const invoice = /^lightning:/i.test(trimmed) ? trimmed.slice("lightning:".length) : trimmed;
  if (!invoice || /[^!-~]/.test(invoice)) fail("BOLT 11 invoice contains unsupported characters");
  if (/[a-z]/.test(invoice) && /[A-Z]/.test(invoice)) fail("BOLT 11 invoice uses mixed case");
  return invoice.toLowerCase();
}

function polymod(values) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = (((checksum & 0x1ffffff) << 5) ^ value) >>> 0;
    for (let index = 0; index < BECH32_GENERATORS.length; index += 1) {
      if (((top >>> index) & 1) !== 0) checksum = (checksum ^ BECH32_GENERATORS[index]) >>> 0;
    }
  }
  return checksum >>> 0;
}

function humanReadableExpansion(value) {
  return Object.freeze([
    ...[...value].map((character) => character.charCodeAt(0) >>> 5),
    0,
    ...[...value].map((character) => character.charCodeAt(0) & 31),
  ]);
}

function decodeBech32(invoice) {
  const separator = invoice.lastIndexOf("1");
  if (separator < 1 || separator + 7 > invoice.length) fail("BOLT 11 Bech32 separator is invalid");
  const humanReadablePart = invoice.slice(0, separator);
  if ([...humanReadablePart].some((character) => {
    const code = character.charCodeAt(0);
    return code < 33 || code > 126;
  })) fail("BOLT 11 human-readable part is invalid");
  const words = [];
  for (const character of invoice.slice(separator + 1)) {
    const word = BECH32_INDEX.get(character);
    if (word === undefined) fail("BOLT 11 contains a non-Bech32 character");
    words.push(word);
  }
  if (polymod([...humanReadableExpansion(humanReadablePart), ...words]) !== 1) {
    fail("BOLT 11 Bech32 checksum is invalid");
  }
  return Object.freeze({
    humanReadablePart,
    words: Object.freeze(words.slice(0, -6)),
  });
}

function convertBits(values, fromBits, toBits, pad) {
  let accumulator = 0;
  let bits = 0;
  const maximumValue = (1 << toBits) - 1;
  const maximumAccumulator = (1 << (fromBits + toBits - 1)) - 1;
  const result = [];
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || (value >>> fromBits) !== 0) {
      fail("BOLT 11 contains an invalid data word");
    }
    accumulator = ((accumulator << fromBits) | value) & maximumAccumulator;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >>> bits) & maximumValue);
    }
  }
  if (pad) {
    if (bits > 0) result.push((accumulator << (toBits - bits)) & maximumValue);
  } else if (bits >= fromBits || ((accumulator << (toBits - bits)) & maximumValue) !== 0) {
    fail("BOLT 11 data has invalid nonzero padding");
  }
  return Uint8Array.from(result);
}

function wordsToInteger(words, name) {
  if (words.length > 0 && words[0] === 0) fail(`${name} is not minimally encoded`);
  let value = 0n;
  for (const word of words) value = (value << 5n) | BigInt(word);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${name} is outside the safe integer range`);
  return Number(value);
}

function parseNetworkAndAmount(humanReadablePart) {
  const match = NETWORK_PREFIXES.find(([prefix]) => humanReadablePart.startsWith(prefix));
  if (!match) fail("BOLT 11 network prefix is unsupported");
  const [prefix, network] = match;
  const amount = humanReadablePart.slice(prefix.length);
  if (amount === "") return Object.freeze({ amountMsat: 0n, network, prefix });
  const parsed = /^([1-9][0-9]*)([munp]?)$/.exec(amount);
  if (!parsed) fail("BOLT 11 amount is not canonical");
  const quantity = BigInt(parsed[1]);
  let amountMsat;
  if (parsed[2] === "m") amountMsat = quantity * 100_000_000n;
  else if (parsed[2] === "u") amountMsat = quantity * 100_000n;
  else if (parsed[2] === "n") amountMsat = quantity * 100n;
  else if (parsed[2] === "p") {
    if (!parsed[1].endsWith("0")) fail("BOLT 11 pico-bitcoin amount is below millisatoshi precision");
    amountMsat = quantity / 10n;
  } else amountMsat = quantity * 100_000_000_000n;
  if (amountMsat === 0n || amountMsat > MAXIMUM_UINT64) fail("BOLT 11 amount is outside policy");
  return Object.freeze({ amountMsat, network, prefix });
}

function bytes32(words, name) {
  const bytes = convertBits(words, 5, 8, false);
  if (bytes.length !== 32) fail(`${name} is not 32 bytes`);
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function compressedPublicKey(words, name) {
  const bytes = convertBits(words, 5, 8, false);
  if (bytes.length !== 33 || (bytes[0] !== 2 && bytes[0] !== 3)) fail(`${name} is not compressed`);
  try {
    secp256k1.ProjectivePoint.fromHex(bytes);
  } catch {
    fail(`${name} is not a valid secp256k1 point`);
  }
  return Buffer.from(bytes).toString("hex");
}

function validateRouteHint(words) {
  const bytes = convertBits(words, 5, 8, false);
  if (bytes.length === 0 || bytes.length % 51 !== 0) fail("BOLT 11 route hint has an invalid length");
  for (let offset = 0; offset < bytes.length; offset += 51) {
    const publicKey = bytes.subarray(offset, offset + 33);
    if (publicKey[0] !== 2 && publicKey[0] !== 3) fail("BOLT 11 route hint has an invalid public key");
    try {
      secp256k1.ProjectivePoint.fromHex(publicKey);
    } catch {
      fail("BOLT 11 route hint has an invalid public key");
    }
  }
}

function validateFallback(words) {
  if (words.length === 0) fail("BOLT 11 fallback address is empty");
  const version = words[0];
  if (version >= 19) return;
  const program = convertBits(words.slice(1), 5, 8, false);
  if (version === 17 || version === 18) {
    if (program.length !== 20) fail("BOLT 11 legacy fallback program has an invalid length");
    return;
  }
  if (version > 16 || program.length < 2 || program.length > 40) {
    fail("BOLT 11 witness fallback program is invalid");
  }
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    fail("BOLT 11 version-zero fallback program has an invalid length");
  }
}

function featureBits(words) {
  if (words.length === 0 || words[0] === 0) fail("BOLT 11 features are not minimally encoded");
  const bits = [];
  for (let wordIndex = words.length - 1; wordIndex >= 0; wordIndex -= 1) {
    const word = words[wordIndex];
    for (let bitIndex = 0; bitIndex < 5; bitIndex += 1) {
      if (((word >>> bitIndex) & 1) !== 0) bits.push((words.length - 1 - wordIndex) * 5 + bitIndex);
    }
  }
  for (const [required, optional] of INVOICE_FEATURE_PAIRS) {
    if (bits.includes(required) && bits.includes(optional)) {
      fail(`BOLT 11 feature pair ${required}/${optional} sets both bits`);
    }
  }
  return Object.freeze(bits.sort((left, right) => left - right));
}

function tagState(words) {
  const counts = Object.fromEntries(SINGLETON_TAGS.map((tag) => [tag, 0]));
  const state = {
    counts,
    description: null,
    descriptionHash: null,
    destination: null,
    expirySeconds: 3_600,
    fallbackCount: 0,
    features: Object.freeze([]),
    metadataCount: 0,
    minFinalCltvDelta: 18,
    paymentHash: null,
    paymentSecret: null,
    routeHintCount: 0,
    tagCount: 0,
    unknownTagCount: 0,
  };
  let offset = 0;
  while (offset < words.length) {
    if (words.length - offset < 3) fail("BOLT 11 tagged field header is truncated");
    state.tagCount += 1;
    if (state.tagCount > MAXIMUM_TAGS) fail("BOLT 11 has too many tagged fields");
    const type = BECH32_ALPHABET[words[offset]];
    const length = (words[offset + 1] << 5) | words[offset + 2];
    offset += 3;
    if (length > words.length - offset) fail("BOLT 11 tagged field data is truncated");
    const data = words.slice(offset, offset + length);
    offset += length;
    if (Object.hasOwn(counts, type)) counts[type] += 1;
    if (Object.hasOwn(FIXED_TAG_LENGTHS, type) && length !== FIXED_TAG_LENGTHS[type]) {
      fail(`BOLT 11 ${type} tag has an invalid length`);
    }
    if (type === "p") state.paymentHash = bytes32(data, "BOLT 11 payment hash");
    else if (type === "s") state.paymentSecret = bytes32(data, "BOLT 11 payment secret");
    else if (type === "h") state.descriptionHash = bytes32(data, "BOLT 11 description hash");
    else if (type === "n") state.destination = compressedPublicKey(data, "BOLT 11 payee");
    else if (type === "d") {
      try {
        state.description = FATAL_UTF8.decode(convertBits(data, 5, 8, false));
      } catch (error) {
        if (error instanceof Bolt11DecodeError) throw error;
        fail("BOLT 11 description is not valid UTF-8");
      }
    } else if (type === "x") state.expirySeconds = wordsToInteger(data, "BOLT 11 expiry");
    else if (type === "c") state.minFinalCltvDelta = wordsToInteger(data, "BOLT 11 final CLTV delta");
    else if (type === "9") state.features = featureBits(data);
    else if (type === "r") {
      validateRouteHint(data);
      state.routeHintCount += 1;
    } else if (type === "f") {
      validateFallback(data);
      state.fallbackCount += 1;
    } else if (type === "m") {
      convertBits(data, 5, 8, false);
      state.metadataCount += 1;
    } else state.unknownTagCount += 1;
  }
  for (const tag of SINGLETON_TAGS) {
    if (counts[tag] > 1) fail(`BOLT 11 repeats singleton tag ${tag}`);
  }
  if (counts.p !== 1) fail("BOLT 11 must contain exactly one payment hash tag");
  if (counts.s !== 1) fail("BOLT 11 must contain exactly one payment secret tag");
  if (counts.d + counts.h !== 1) fail("BOLT 11 must contain exactly one description or description-hash tag");
  if (state.metadataCount > 0 && !state.features.some((bit) => bit === 48 || bit === 49)) {
    fail("BOLT 11 payment metadata lacks its feature bit");
  }
  return Object.freeze({
    ...state,
    counts: Object.freeze({ ...counts }),
  });
}

function verifySignature(humanReadablePart, signingWords, signatureWords, tagged) {
  const signatureBytes = convertBits(signatureWords, 5, 8, false);
  if (signatureBytes.length !== 65 || signatureBytes[64] > 3) fail("BOLT 11 signature is malformed");
  const message = Buffer.concat([
    Buffer.from(humanReadablePart, "utf8"),
    Buffer.from(convertBits(signingWords, 5, 8, true)),
  ]);
  const messageHash = createHash("sha256").update(message).digest();
  let signature;
  try {
    signature = secp256k1.Signature.fromCompact(signatureBytes.subarray(0, 64));
  } catch {
    fail("BOLT 11 signature scalar is invalid");
  }
  if (tagged.destination !== null) {
    if (signature.hasHighS()) fail("BOLT 11 explicit-payee signature is not low-S");
    if (!secp256k1.verify(signature, messageHash, tagged.destination, { lowS: true })) {
      fail("BOLT 11 signature does not match its explicit payee");
    }
    return tagged.destination;
  }
  let publicKey;
  try {
    const recovered = signature.addRecoveryBit(signatureBytes[64]).recoverPublicKey(messageHash);
    publicKey = Buffer.from(recovered.toRawBytes(true)).toString("hex");
  } catch {
    fail("BOLT 11 signature public key is not recoverable");
  }
  if (!secp256k1.verify(signature, messageHash, publicKey, { lowS: false })) {
    fail("BOLT 11 recovered signature is invalid");
  }
  return publicKey;
}

export function decodeBolt11Invoice(rawInvoice, options) {
  const source = exactDataRecord(options, ["maximumInvoiceLength"], "BOLT 11 decoder options");
  const maximumInvoiceLength = integer(
    source.maximumInvoiceLength,
    "maximum BOLT 11 invoice length",
    256,
    8_192,
  );
  const invoice = normalizeBolt11Invoice(rawInvoice);
  if (Buffer.byteLength(invoice) > maximumInvoiceLength) fail("BOLT 11 invoice exceeds the length limit");
  const decoded = decodeBech32(invoice);
  const networkAmount = parseNetworkAndAmount(decoded.humanReadablePart);
  if (decoded.words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) fail("BOLT 11 data is too short");
  const signingWords = decoded.words.slice(0, -SIGNATURE_WORDS);
  const signatureWords = decoded.words.slice(-SIGNATURE_WORDS);
  let timestamp = 0;
  for (const word of signingWords.slice(0, TIMESTAMP_WORDS)) timestamp = timestamp * 32 + word;
  const tagged = tagState(signingWords.slice(TIMESTAMP_WORDS));
  const destination = verifySignature(decoded.humanReadablePart, signingWords, signatureWords, tagged);
  const featureSet = new Set(tagged.features);
  const unknownRequiredFeatures = tagged.features.filter((bit) => bit % 2 === 0
    && !KNOWN_INVOICE_FEATURE_BITS.has(bit));
  const unsupportedRequiredFeatures = tagged.features.filter((bit) => bit % 2 === 0
    && KNOWN_INVOICE_FEATURE_BITS.has(bit) && !SUPPORTED_REQUIRED_FEATURE_BITS.has(bit));
  const result = Object.freeze({
    schema: "treeswap.bolt11-decoded.v1",
    invoice,
    decodeSucceeded: true,
    signatureValid: true,
    network: networkAmount.network,
    amountMsat: networkAmount.amountMsat,
    paymentHash: tagged.paymentHash,
    paymentSecret: tagged.paymentSecret,
    destination,
    timestamp,
    expirySeconds: tagged.expirySeconds,
    minFinalCltvDelta: tagged.minFinalCltvDelta,
    basicMpp: featureSet.has(16) || featureSet.has(17),
    amp: featureSet.has(30) || featureSet.has(31),
    keysend: false,
    bolt12: false,
    featureBits: tagged.features,
    unknownRequiredFeatures: Object.freeze([...unknownRequiredFeatures]),
    unsupportedRequiredFeatures: Object.freeze([...unsupportedRequiredFeatures]),
    routeHintCount: tagged.routeHintCount,
    fallbackCount: tagged.fallbackCount,
    metadataCount: tagged.metadataCount,
    unknownTagCount: tagged.unknownTagCount,
    singletonTagCounts: tagged.counts,
    hasInlineDescription: tagged.description !== null,
    hasHashedDescription: tagged.descriptionHash !== null,
  });
  DECODED_INVOICES.add(result);
  return result;
}

export function isDecodedBolt11Invoice(value) {
  return DECODED_INVOICES.has(value);
}
