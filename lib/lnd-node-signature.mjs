import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";

const INPUT_KEYS = Object.freeze(["message", "signature"]);
const LND_MESSAGE_PREFIX = Buffer.from("Lightning Signed Message:", "utf8");
const ZBASE32_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";
const ZBASE32_VALUES = Object.freeze(Object.fromEntries(
  [...ZBASE32_ALPHABET].map((character, index) => [character, index]),
));
const CANONICAL_SIGNATURE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{104}$/;
const INVALID_RESULT = Object.freeze({ pubkey: "", valid: false });

function exactInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("LND node-signature verification input must be an object");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== INPUT_KEYS.length
      || keys.some((key) => typeof key !== "string" || !INPUT_KEYS.includes(key))) {
    throw new TypeError("LND node-signature verification fields are not exact");
  }
  const result = Object.create(null);
  for (const key of INPUT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("LND node-signature verification fields must be enumerable data properties");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function decodeZbase32(value) {
  const output = Buffer.allocUnsafe(65);
  let accumulator = 0;
  let availableBits = 0;
  let outputIndex = 0;
  for (const character of value) {
    accumulator = (accumulator << 5) | ZBASE32_VALUES[character];
    availableBits += 5;
    if (availableBits >= 8) {
      availableBits -= 8;
      output[outputIndex] = (accumulator >>> availableBits) & 0xff;
      outputIndex += 1;
      accumulator &= (1 << availableBits) - 1;
    }
  }
  if (availableBits !== 0 || outputIndex !== output.length) {
    throw new TypeError("LND node signature is not canonical zbase32");
  }
  return output;
}

function lndMessageDigest(message) {
  const firstHash = createHash("sha256").update(LND_MESSAGE_PREFIX).update(message).digest();
  return createHash("sha256").update(firstHash).digest();
}

export function verifyLndNodeSignature(input) {
  try {
    const source = exactInput(input);
    if (!Buffer.isBuffer(source.message)
        || source.message.length < 1 || source.message.length > 4_096) {
      return INVALID_RESULT;
    }
    if (typeof source.signature !== "string" || !CANONICAL_SIGNATURE.test(source.signature)) {
      return INVALID_RESULT;
    }
    const compact = decodeZbase32(source.signature);
    const recovery = compact[0] - 31;
    if (recovery < 0 || recovery > 3) return INVALID_RESULT;
    const signatureBytes = compact.subarray(1);
    const digest = lndMessageDigest(Buffer.from(source.message));
    const signature = secp256k1.Signature.fromCompact(signatureBytes).addRecoveryBit(recovery);
    if (signature.hasHighS()) return INVALID_RESULT;
    const publicKey = signature.recoverPublicKey(digest).toRawBytes(true);
    if (!secp256k1.verify(signatureBytes, digest, publicKey)) return INVALID_RESULT;
    return Object.freeze({ pubkey: Buffer.from(publicKey).toString("hex"), valid: true });
  } catch {
    return INVALID_RESULT;
  }
}
