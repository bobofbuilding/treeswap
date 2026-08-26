import { getBytes } from "ethers";
import { TextDecoder } from "node:util";
import { decodeBolt11Invoice } from "../lib/bolt11.mjs";
import { invoiceDigest } from "../lib/lnd-rest-client.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/;
const FIELDS = Object.freeze(["amountSats", "invoice", "invoiceDigest", "paymentHash"]);

function exactDataRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("regtest BOLT 11 material must be a plain object");
  }
  const actual = Reflect.ownKeys(value).sort();
  const wanted = [...FIELDS].sort();
  if (actual.length !== FIELDS.length
      || actual.some((key, index) => typeof key !== "string" || key !== wanted[index])) {
    throw new TypeError("regtest BOLT 11 material fields are not exact");
  }
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError("regtest BOLT 11 material fields must be enumerable data properties");
    }
  }
  return value;
}

async function readMaterial() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 8_192) throw new RangeError("regtest BOLT 11 material is too large");
    chunks.push(bytes);
  }
  if (size === 0) throw new Error("regtest BOLT 11 material is required on stdin");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (text.charCodeAt(0) === 0xfeff) throw new TypeError("regtest BOLT 11 material has a BOM");
  return exactDataRecord(JSON.parse(text));
}

const material = await readMaterial();
if (material.amountSats !== "10000") throw new Error("regtest BOLT 11 amount changed");
if (!BYTES32.test(material.paymentHash) || !BYTES32.test(material.invoiceDigest)) {
  throw new TypeError("regtest BOLT 11 commitments are malformed");
}
const decoded = decodeBolt11Invoice(material.invoice, { maximumInvoiceLength: 4_096 });
const observedAt = Math.floor(Date.now() / 1_000);
if (decoded.invoice !== material.invoice
    || decoded.network !== "regtest"
    || decoded.amountMsat !== 10_000_000n
    || decoded.paymentHash !== material.paymentHash
    || invoiceDigest(decoded.invoice) !== material.invoiceDigest
    || decoded.expirySeconds !== 3_600
    || decoded.minFinalCltvDelta !== 80
    || decoded.timestamp > observedAt + 5
    || decoded.timestamp + decoded.expirySeconds <= observedAt + 900
    || !COMPRESSED_PUBKEY.test(decoded.destination)
    || decoded.amp
    || decoded.hasHashedDescription
    || !decoded.hasInlineDescription
    || decoded.routeHintCount > 20
    || decoded.unknownRequiredFeatures.length !== 0
    || decoded.unsupportedRequiredFeatures.length !== 0
    || !BYTES32.test(decoded.paymentSecret)
    || getBytes(decoded.paymentSecret).every((value) => value === 0)) {
  throw new Error("regtest BOLT 11 material failed independent validation");
}

process.stdout.write(material.paymentHash);
