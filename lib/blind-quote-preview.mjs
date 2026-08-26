import { randomBytes } from "node:crypto";
import { selectBlindQuote, verifiedBlindQuoteBook } from "./blind-rfq.mjs";

const DATE_NOW = Date.now.bind(Date);
const LOWER_BYTES32 = /^0x[0-9a-f]{64}$/;
const SELECTION_FIELDS = Object.freeze(["choiceId"]);
const TEST_SESSION_FIELDS = Object.freeze(["book", "nowSeconds", "randomBytesImpl"]);
const SESSIONS = new WeakMap();
const BOUND_BOOKS = new WeakSet();

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

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function choiceId(bytesImpl) {
  const value = bytesImpl(32);
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("blind quote choice entropy must return exactly 32 bytes");
  }
  return `0x${Buffer.from(value).toString("hex")}`;
}

function sessionStatus(context) {
  return Object.freeze({
    schema: "treeswap.blind-quote-preview-status.v1",
    state: context.state,
    mode: context.mode,
    quoteCount: context.choiceById.size,
    fundingAuthorization: false,
    settlementAuthorization: false,
    networkListener: false,
  });
}

function synchronizeExpiry(context) {
  if (context.state === "active"
      && integer(context.nowSeconds(), "blind quote preview time") >= context.expiresAt) {
    context.state = "expired";
    context.choiceById.clear();
  }
}

function buildSession(bookInput, { mode, nowSeconds, randomBytesImpl }) {
  const book = verifiedBlindQuoteBook(bookInput);
  if (BOUND_BOOKS.has(book)) throw new TypeError("blind quote book already has a client preview session");
  const observedAt = integer(nowSeconds(), "blind quote preview time");
  const expiries = book.offers.map(({ offer }) => integer(offer.expiresAt, "blind offer expiry"));
  const expiresAt = Math.min(integer(book.pricing.expiresAt, "blind pricing expiry"), ...expiries);
  if (book.offers.length === 0 || expiresAt <= observedAt) {
    throw new RangeError("blind quote preview is expired or empty");
  }

  const choiceById = new Map();
  const offers = book.offers.map((envelope, index) => {
    let opaqueChoiceId = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      opaqueChoiceId = choiceId(randomBytesImpl);
      if (!choiceById.has(opaqueChoiceId)) break;
    }
    if (!LOWER_BYTES32.test(opaqueChoiceId) || choiceById.has(opaqueChoiceId)) {
      throw new Error("blind quote choice entropy collided");
    }
    choiceById.set(opaqueChoiceId, envelope.offer.offerId);
    const grossBitAmount = BigInt(envelope.offer.grossBitAmount);
    const feeBitAmount = BigInt(envelope.offer.feeBitAmount);
    return Object.freeze({
      choiceId: opaqueChoiceId,
      rank: index + 1,
      grossBitAmount: grossBitAmount.toString(),
      feeBitAmount: feeBitAmount.toString(),
      netBitAmount: (grossBitAmount - feeBitAmount).toString(),
      lightningAmountSats: BigInt(envelope.offer.lightningAmountSats).toString(),
      maxRoutingFeeSats: BigInt(envelope.offer.maxRoutingFeeSats).toString(),
      expiresAt: envelope.offer.expiresAt,
    });
  });
  const preview = Object.freeze({
    schema: "treeswap.client-safe-blind-quote-set.v1",
    pricingId: book.pricingId,
    pricingDigest: book.pricingDigest,
    receivedSetDigest: book.receiptDigest,
    marketRiskPolicyDigest: book.marketRiskPolicyDigest,
    direction: book.pricing.direction,
    exactOutput: book.pricing.exactOutput,
    outputUnit: book.pricing.outputUnit,
    expiresAt,
    quoteCount: offers.length,
    offers: Object.freeze(offers),
  });
  const context = {
    book,
    choiceById,
    expiresAt,
    mode,
    nowSeconds,
    preview,
    state: "active",
  };
  const session = Object.freeze({
    preview() {
      if (this !== session || SESSIONS.get(this) !== context) {
        throw new TypeError("blind quote preview session lacks factory provenance");
      }
      synchronizeExpiry(context);
      if (context.state !== "active") throw new Error("blind quote preview session is no longer active");
      return context.preview;
    },
    select(input) {
      if (this !== session || SESSIONS.get(this) !== context) {
        throw new TypeError("blind quote preview session lacks factory provenance");
      }
      synchronizeExpiry(context);
      if (context.state !== "active") throw new Error("blind quote preview session is no longer active");
      const source = exactDataRecord(input, SELECTION_FIELDS, "blind quote choice");
      if (typeof source.choiceId !== "string" || !LOWER_BYTES32.test(source.choiceId)) {
        throw new TypeError("blind quote choice identifier must be canonical lowercase bytes32");
      }
      const offerId = context.choiceById.get(source.choiceId);
      if (!offerId) throw new RangeError("blind quote choice is not in the client preview");
      const selection = selectBlindQuote(context.book, offerId);
      context.state = "selected";
      context.choiceById.clear();
      return selection;
    },
    close() {
      if (this !== session || SESSIONS.get(this) !== context) {
        throw new TypeError("blind quote preview session lacks factory provenance");
      }
      synchronizeExpiry(context);
      if (context.state === "active") {
        context.state = "closed";
        context.choiceById.clear();
      }
      return sessionStatus(context);
    },
    status() {
      if (this !== session || SESSIONS.get(this) !== context) {
        throw new TypeError("blind quote preview session lacks factory provenance");
      }
      synchronizeExpiry(context);
      return sessionStatus(context);
    },
  });
  BOUND_BOOKS.add(book);
  SESSIONS.set(session, context);
  return session;
}

export function createClientSafeBlindQuoteSession(book) {
  return buildSession(book, {
    mode: "system-entropy",
    nowSeconds: () => Math.floor(DATE_NOW() / 1_000),
    randomBytesImpl: randomBytes,
  });
}

export function createTestClientSafeBlindQuoteSession(input) {
  const source = exactDataRecord(input, TEST_SESSION_FIELDS, "test blind quote preview session input");
  if (typeof source.randomBytesImpl !== "function") {
    throw new TypeError("test blind quote choice entropy must be a function");
  }
  if (typeof source.nowSeconds !== "function") {
    throw new TypeError("test blind quote preview clock must be a function");
  }
  return buildSession(source.book, {
    mode: "injected-test",
    nowSeconds: source.nowSeconds,
    randomBytesImpl: source.randomBytesImpl,
  });
}

export function isClientSafeBlindQuoteSession(value) {
  return Boolean(value && SESSIONS.has(value));
}

export function isProductionClientSafeBlindQuoteSession(value) {
  return SESSIONS.get(value)?.mode === "system-entropy";
}
