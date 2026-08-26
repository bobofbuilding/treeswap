import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { verifyLndNodeSignature } from "../lib/lnd-node-signature.mjs";

const ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";
const PREFIX = Buffer.from("Lightning Signed Message:", "utf8");
const PRIVATE_KEY = Buffer.from("11".repeat(32), "hex");
const MESSAGE = Buffer.from(`TreeSwap solver capability v1\n0x${"22".repeat(32)}\n`, "utf8");

function digest(message, { singleHash = false } = {}) {
  const first = createHash("sha256").update(PREFIX).update(message).digest();
  return singleHash ? first : createHash("sha256").update(first).digest();
}

function encodeZbase32(bytes) {
  let output = "";
  let accumulator = 0;
  let availableBits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    availableBits += 8;
    while (availableBits >= 5) {
      availableBits -= 5;
      output += ALPHABET[(accumulator >>> availableBits) & 31];
      accumulator &= (1 << availableBits) - 1;
    }
  }
  if (availableBits !== 0) output += ALPHABET[(accumulator << (5 - availableBits)) & 31];
  return output;
}

function compactSignature(message, { singleHash = false } = {}) {
  const signed = secp256k1.sign(digest(message, { singleHash }), PRIVATE_KEY);
  return {
    encoded: encodeZbase32(Buffer.concat([
      Buffer.from([31 + signed.recovery]),
      Buffer.from(signed.toCompactRawBytes()),
    ])),
    signed,
  };
}

test("recovers the exact compressed node key from LND's default double-hash signature", () => {
  const { encoded } = compactSignature(MESSAGE);
  const expected = Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex");
  assert.equal(encoded.length, 104);
  assert.deepEqual(verifyLndNodeSignature({ message: MESSAGE, signature: encoded }), {
    pubkey: expected,
    valid: true,
  });
});

test("a changed challenge or single-hash signature cannot recover the declared node", () => {
  const expected = Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex");
  const { encoded } = compactSignature(MESSAGE);
  const changed = verifyLndNodeSignature({
    message: Buffer.from(`${MESSAGE.toString("utf8")}mutated`, "utf8"),
    signature: encoded,
  });
  assert.equal(changed.valid, true);
  assert.notEqual(changed.pubkey, expected);

  const singleHash = verifyLndNodeSignature({
    message: MESSAGE,
    signature: compactSignature(MESSAGE, { singleHash: true }).encoded,
  });
  assert.equal(singleHash.valid, true);
  assert.notEqual(singleHash.pubkey, expected);
});

test("rejects high-S, malformed, uncompressed, and non-canonical signatures", () => {
  const { signed } = compactSignature(MESSAGE);
  const highS = new secp256k1.Signature(signed.r, secp256k1.CURVE.n - signed.s)
    .addRecoveryBit(signed.recovery ^ 1);
  const highSCompact = Buffer.concat([
    Buffer.from([31 + highS.recovery]),
    Buffer.from(highS.toCompactRawBytes()),
  ]);
  assert.deepEqual(verifyLndNodeSignature({
    message: MESSAGE,
    signature: encodeZbase32(highSCompact),
  }), { pubkey: "", valid: false });

  const { encoded } = compactSignature(MESSAGE);
  const uncompressed = Buffer.from(highSCompact);
  uncompressed[0] = 27 + signed.recovery;
  for (const signature of [
    encoded.slice(0, -1),
    `${encoded.slice(0, -1)}0`,
    encoded.toUpperCase(),
    encodeZbase32(uncompressed),
    "y".repeat(104),
  ]) {
    assert.deepEqual(verifyLndNodeSignature({ message: MESSAGE, signature }), {
      pubkey: "",
      valid: false,
    });
  }
});

test("does not invoke accessors or accept non-Buffer message inputs", () => {
  let calls = 0;
  const input = { signature: compactSignature(MESSAGE).encoded };
  Object.defineProperty(input, "message", {
    enumerable: true,
    get() {
      calls += 1;
      return MESSAGE;
    },
  });
  assert.deepEqual(verifyLndNodeSignature(input), { pubkey: "", valid: false });
  assert.equal(calls, 0);
  assert.deepEqual(verifyLndNodeSignature({
    message: new Uint8Array(MESSAGE),
    signature: compactSignature(MESSAGE).encoded,
  }), { pubkey: "", valid: false });
  assert.deepEqual(verifyLndNodeSignature({
    message: MESSAGE,
    signature: compactSignature(MESSAGE).encoded,
    valid: true,
  }), { pubkey: "", valid: false });
});
