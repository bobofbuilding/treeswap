import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";

const ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const NETWORK_PREFIX = Object.freeze({
  mainnet: "lnbc",
  regtest: "lnbcrt",
  signet: "lntbs",
  testnet: "lntb",
});
const DEFAULT_PRIVATE_KEY = `0x${"11".repeat(32)}`;

function polymod(values) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = (((checksum & 0x1ffffff) << 5) ^ value) >>> 0;
    for (let index = 0; index < GENERATORS.length; index += 1) {
      if (((top >>> index) & 1) !== 0) checksum = (checksum ^ GENERATORS[index]) >>> 0;
    }
  }
  return checksum >>> 0;
}

function expand(value) {
  return [
    ...[...value].map((character) => character.charCodeAt(0) >>> 5),
    0,
    ...[...value].map((character) => character.charCodeAt(0) & 31),
  ];
}

function convertBits(values, fromBits, toBits, pad) {
  let accumulator = 0;
  let bits = 0;
  const maximumValue = (1 << toBits) - 1;
  const maximumAccumulator = (1 << (fromBits + toBits - 1)) - 1;
  const result = [];
  for (const value of values) {
    accumulator = ((accumulator << fromBits) | value) & maximumAccumulator;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >>> bits) & maximumValue);
    }
  }
  if (pad && bits > 0) result.push((accumulator << (toBits - bits)) & maximumValue);
  return result;
}

function encodeBech32(humanReadablePart, words) {
  const values = [...expand(humanReadablePart), ...words, 0, 0, 0, 0, 0, 0];
  const checksum = polymod(values) ^ 1;
  const checksumWords = Array.from({ length: 6 }, (_, index) => (
    (checksum >>> (5 * (5 - index))) & 31
  ));
  return `${humanReadablePart}1${[...words, ...checksumWords].map((word) => ALPHABET[word]).join("")}`;
}

function privateKeyBytes(value) {
  return Uint8Array.from(Buffer.from(value.replace(/^0x/, ""), "hex"));
}

function hexBytes(value) {
  return Uint8Array.from(Buffer.from(value.replace(/^0x/, ""), "hex"));
}

function timestampWords(value) {
  const words = Array(7).fill(0);
  let remaining = BigInt(value);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    words[index] = Number(remaining & 31n);
    remaining >>= 5n;
  }
  if (remaining !== 0n) throw new RangeError("test BOLT 11 timestamp exceeds 35 bits");
  return words;
}

export function bolt11WordsFromBytes(value) {
  return convertBits(Uint8Array.from(value), 8, 5, true);
}

export function bolt11IntegerWords(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new RangeError("test BOLT 11 integer is negative");
  if (remaining === 0n) return [];
  const words = [];
  while (remaining > 0n) {
    words.unshift(Number(remaining & 31n));
    remaining >>= 5n;
  }
  return words;
}

export function bolt11FeatureWords(bits) {
  if (bits.length === 0) return [];
  const maximum = Math.max(...bits);
  const words = Array(Math.floor(maximum / 5) + 1).fill(0);
  for (const bit of bits) {
    words[words.length - 1 - Math.floor(bit / 5)] |= 1 << (bit % 5);
  }
  return words;
}

export function bolt11Tag(type, words) {
  const typeWord = ALPHABET.indexOf(type);
  if (typeWord < 0 || words.length > 1_023) throw new TypeError("test BOLT 11 tag is invalid");
  return Object.freeze({ type, words: Object.freeze([...words]) });
}

export function bolt11BytesTag(type, value) {
  return bolt11Tag(type, bolt11WordsFromBytes(value));
}

export function createRawBolt11Invoice({
  highS = false,
  humanReadablePart,
  privateKey = DEFAULT_PRIVATE_KEY,
  tags,
  timestamp,
}) {
  const tagWords = tags.flatMap(({ type, words }) => {
    const typeWord = ALPHABET.indexOf(type);
    return [typeWord, words.length >>> 5, words.length & 31, ...words];
  });
  const signingWords = [...timestampWords(timestamp), ...tagWords];
  const message = Buffer.concat([
    Buffer.from(humanReadablePart, "utf8"),
    Buffer.from(convertBits(signingWords, 5, 8, true)),
  ]);
  const messageHash = createHash("sha256").update(message).digest();
  let signature = secp256k1.sign(messageHash, privateKeyBytes(privateKey), { lowS: true });
  if (highS) {
    signature = new secp256k1.Signature(
      signature.r,
      secp256k1.CURVE.n - signature.s,
      signature.recovery ^ 1,
    );
  }
  const signatureBytes = Uint8Array.from([
    ...signature.toCompactRawBytes(),
    signature.recovery,
  ]);
  const signatureWords = convertBits(signatureBytes, 8, 5, true);
  if (signatureWords.length !== 104) throw new Error("test BOLT 11 signature encoding changed");
  return encodeBech32(humanReadablePart, [...signingWords, ...signatureWords]);
}

export function createBolt11Invoice({
  amountSats,
  description = "TreeSwap test invoice",
  descriptionHash = null,
  expirySeconds = 3_600,
  extraTags = [],
  featureBits = [9, 15, 17],
  highS = false,
  humanReadablePart = null,
  includeDestination = false,
  minFinalCltvDelta = 80,
  network = "mainnet",
  paymentHash,
  paymentSecret,
  privateKey = DEFAULT_PRIVATE_KEY,
  timestamp,
}) {
  const prefix = NETWORK_PREFIX[network];
  if (!prefix) throw new TypeError("test BOLT 11 network is unsupported");
  const encodedHumanReadablePart = humanReadablePart ?? `${prefix}${BigInt(amountSats) * 10n}n`;
  const tags = [
    bolt11BytesTag("p", hexBytes(paymentHash)),
    bolt11BytesTag("s", hexBytes(paymentSecret)),
    bolt11Tag("x", bolt11IntegerWords(expirySeconds)),
    bolt11Tag("c", bolt11IntegerWords(minFinalCltvDelta)),
  ];
  if ((description === null) === (descriptionHash === null)) {
    throw new TypeError("test BOLT 11 invoice needs exactly one description form");
  }
  if (description !== null) tags.splice(2, 0, bolt11BytesTag("d", Buffer.from(description, "utf8")));
  else tags.splice(2, 0, bolt11BytesTag("h", hexBytes(descriptionHash)));
  if (includeDestination) {
    tags.push(bolt11BytesTag("n", secp256k1.getPublicKey(privateKeyBytes(privateKey), true)));
  }
  if (featureBits.length > 0) tags.push(bolt11Tag("9", bolt11FeatureWords(featureBits)));
  tags.push(...extraTags);
  return createRawBolt11Invoice({
    highS,
    humanReadablePart: encodedHumanReadablePart,
    privateKey,
    tags,
    timestamp,
  });
}

export function testBolt11Payee(privateKey = DEFAULT_PRIVATE_KEY) {
  return Buffer.from(secp256k1.getPublicKey(privateKeyBytes(privateKey), true)).toString("hex");
}
