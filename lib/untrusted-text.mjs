const DIRECTIONAL_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const INVISIBLE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/gu;
const SPACE_RUN = /\s+/gu;
const RELAY_SOURCE = /^[a-z0-9](?:[a-z0-9._:-]{0,62}[a-z0-9])?$/u;

function boundedLength(value, maxLength) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 4096) {
    throw new RangeError("maxLength must be an integer from 1 through 4096");
  }
  return Array.from(value).slice(0, maxLength).join("");
}

function auditPrimitive(value) {
  return value === null || ["string", "number", "boolean", "bigint"].includes(typeof value);
}

/**
 * Returns display-only text. Never use this to canonicalize a signed field: signed
 * values must be rejected if their original bytes are not already canonical.
 */
export function sanitizeDisplayText(value, { maxLength = 280, fallback = "" } = {}) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(DIRECTIONAL_CONTROLS, "")
    .replace(INVISIBLE_CONTROLS, "")
    .replace(SPACE_RUN, " ")
    .trim();
  const bounded = boundedLength(normalized, maxLength);
  return bounded || boundedLength(String(fallback).normalize("NFKC").trim(), maxLength);
}

export function sanitizeSolverLabel(value) {
  return sanitizeDisplayText(value, { maxLength: 48, fallback: "Unnamed solver" });
}

export function sanitizeInvoiceMemo(value) {
  return sanitizeDisplayText(value, { maxLength: 280 });
}

export function sanitizeTokenLabel(value) {
  return sanitizeDisplayText(value, { maxLength: 16, fallback: "Unknown token" });
}

export function canonicalRelaySource(value, maxLength = 64) {
  const source = String(value ?? "");
  const canonical = sanitizeDisplayText(source, { maxLength }).toLowerCase();
  if (source !== canonical || source.length > maxLength || !RELAY_SOURCE.test(source)) {
    throw new TypeError("invalid quote source");
  }
  return source;
}

export function escapeHtmlText(value, options) {
  return sanitizeDisplayText(value, options)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeAuditLine(event, fields = {}) {
  const record = {};
  Object.defineProperty(record, "event", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: sanitizeDisplayText(auditPrimitive(event) ? event : "unknown", {
      maxLength: 64,
      fallback: "unknown",
    }),
  });
  const keys = fields && typeof fields === "object" ? Reflect.ownKeys(fields) : [];
  let accepted = 0;
  for (const key of keys) {
    if (accepted >= 32) break;
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(fields, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) continue;
    const safeKey = sanitizeDisplayText(key, { maxLength: 48 });
    if (!safeKey || Object.hasOwn(record, safeKey) || !auditPrimitive(descriptor.value)) continue;
    Object.defineProperty(record, safeKey, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: sanitizeDisplayText(descriptor.value, { maxLength: 280 }),
    });
    accepted += 1;
  }
  return JSON.stringify(record);
}
