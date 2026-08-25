import { createHash } from "node:crypto";
import { coordinatorCommitmentDigest } from "./coordinator-store.mjs";
import { signLightningAuthorizationEnvelope } from "./lightning-authorization-envelope.mjs";
import { invoiceDigest, isPrivateLndHostname } from "./lnd-rest-client.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const UINT64_MAX = (1n << 64n) - 1n;
const LIGHTNING_METHODS = new Set([
  "/invoicesrpc.Invoices/AddHoldInvoice",
  "/invoicesrpc.Invoices/SettleInvoice",
  "/invoicesrpc.Invoices/CancelInvoice",
  "/routerrpc.Router/SendPaymentV2",
]);
const ADAPTER_AUDIT_FIELDS = Object.freeze([
  "amountSats",
  "capacityEpoch",
  "credentialIdHash",
  "decision",
  "intentDigest",
  "invoiceDigest",
  "method",
  "observedAt",
  "paymentHash",
  "reasons",
  "requestId",
  "role",
]);
const PAYMENT_TRACKING_STATES = new Set(["FAILED", "IN_FLIGHT", "SUCCEEDED"]);
const INVOICE_STATES = new Set(["ACCEPTED", "CANCELED", "OPEN", "SETTLED"]);
const INVOICE_HTLC_STATES = new Set(["ACCEPTED", "CANCELED", "SETTLED"]);

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
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
  const result = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value,
    });
  }
  return Object.freeze(result);
}

function exactDataArray(value, name, maximumLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || lengthDescriptor.value > maximumLength) {
    throw new RangeError(`${name} length is invalid or unbounded`);
  }
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const expected = ["length", ...Array.from({ length }, (_, index) => String(index))].sort();
  const actual = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} must be dense and contain no extra properties`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) throw new TypeError(`${name} must be lowercase bytes32`);
  return value;
}

function uint(value, name) {
  if (typeof value !== "string" || !UINT.test(value)) {
    throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  }
  if (value.length > 20 || BigInt(value) > UINT64_MAX) throw new RangeError(`${name} must fit uint64`);
  return value;
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function normalizeOperation(method, operation) {
  if (!LIGHTNING_METHODS.has(method)) throw new RangeError("action is not a Lightning adapter method");
  switch (method) {
    case "/invoicesrpc.Invoices/AddHoldInvoice": {
      const source = exactDataRecord(
        operation,
        ["cltvExpiry", "expirySeconds", "isPrivate", "memo"],
        "hold-invoice operation",
      );
      if (typeof source.isPrivate !== "boolean") throw new TypeError("isPrivate must be a boolean");
      if (typeof source.memo !== "string" || source.memo.length > 256) {
        throw new TypeError("memo must be a string no longer than 256 characters");
      }
      return Object.freeze({
        cltvExpiry: integer(source.cltvExpiry, "cltvExpiry"),
        expirySeconds: integer(source.expirySeconds, "expirySeconds"),
        isPrivate: source.isPrivate,
        memo: source.memo,
      });
    }
    case "/invoicesrpc.Invoices/SettleInvoice": {
      const source = exactDataRecord(operation, ["preimage"], "settle-invoice operation");
      return Object.freeze({ preimage: bytes32(source.preimage, "preimage") });
    }
    case "/invoicesrpc.Invoices/CancelInvoice":
      return exactDataRecord(operation, [], "cancel-invoice operation");
    case "/routerrpc.Router/SendPaymentV2": {
      const source = exactDataRecord(
        operation,
        ["feeLimitSats", "paymentRequest", "timeoutSeconds"],
        "send-payment operation",
      );
      if (typeof source.paymentRequest !== "string" || source.paymentRequest.length === 0
          || source.paymentRequest.length > 8_192) {
        throw new TypeError("paymentRequest must be a non-empty string no longer than 8192 characters");
      }
      return Object.freeze({
        feeLimitSats: uint(source.feeLimitSats, "feeLimitSats"),
        paymentRequest: source.paymentRequest,
        timeoutSeconds: integer(source.timeoutSeconds, "timeoutSeconds"),
      });
    }
    default:
      throw new RangeError("action is not a Lightning adapter method");
  }
}

function privateAdapterActionUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:") throw new TypeError("adapter URL must use the isolated network's HTTP transport");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError("adapter URL must contain only its private origin");
  }
  if (!isPrivateLndHostname(url.hostname)) throw new TypeError("adapter URL must target an explicitly private hostname");
  return new URL("/v1/action", url);
}

async function boundedJson(response, maximumBytes = 262_144) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("adapter response exceeded its size limit");
  if (!response.body) throw new Error("adapter returned an empty response");
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new Error("adapter response exceeded its size limit");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("adapter response was not JSON");
  }
}

function preimageHash(preimage) {
  return `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
}

function adapterRole(method) {
  if (method.startsWith("/invoicesrpc.Invoices/")) return "invoice";
  if (method.startsWith("/routerrpc.Router/")) return "payer";
  throw new RangeError("adapter response method has no role");
}

function validateAdapterAudit(action, method, requestId, authorizedAt, expiresAt, rawAudit) {
  const audit = exactDataRecord(rawAudit, ADAPTER_AUDIT_FIELDS, "adapter authorization audit");
  const reasons = exactDataArray(audit.reasons, "adapter authorization reasons", 32);
  if (audit.decision !== "allowed" || reasons.length !== 0) {
    throw new Error("adapter audit did not prove an allowed authorization");
  }
  if (audit.role !== adapterRole(method) || audit.method !== method) {
    throw new Error("adapter audit role or method changed");
  }
  const credentialIdHash = bytes32(audit.credentialIdHash, "adapter credentialIdHash");
  if (/^0x0{64}$/.test(credentialIdHash)) throw new TypeError("adapter credentialIdHash must be nonzero");
  if (bytes32(audit.requestId, "adapter audit requestId") !== requestId) {
    throw new Error("adapter audit request identifier changed");
  }
  if (bytes32(audit.intentDigest, "adapter audit intentDigest") !== action.intentDigest
      || bytes32(audit.paymentHash, "adapter audit paymentHash") !== action.paymentHash
      || bytes32(audit.invoiceDigest, "adapter audit invoiceDigest") !== action.invoiceDigest) {
    throw new Error("adapter audit action binding changed");
  }
  if (uint(audit.amountSats, "adapter audit amountSats") !== action.amountSats
      || integer(audit.capacityEpoch, "adapter audit capacityEpoch") !== action.capacityEpoch) {
    throw new Error("adapter audit amount or capacity epoch changed");
  }
  const observedAt = integer(audit.observedAt, "adapter audit observedAt");
  if (observedAt < authorizedAt || observedAt >= expiresAt) {
    throw new Error("adapter audit was outside the signed authorization window");
  }
  return Object.freeze({
    observedAt,
    decision: "allowed",
    role: audit.role,
    credentialIdHash,
    requestId,
    method,
    intentDigest: action.intentDigest,
    paymentHash: action.paymentHash,
    invoiceDigest: action.invoiceDigest,
    amountSats: action.amountSats,
    capacityEpoch: action.capacityEpoch,
  });
}

function validateAdapterResult(action, operation, body, authorization) {
  const response = exactDataRecord(body, ["audit", "result"], "adapter success response");
  const auditBinding = validateAdapterAudit(
    action,
    action.method,
    action.requestId,
    authorization.authorizedAt,
    authorization.expiresAt,
    response.audit,
  );
  const result = response.result;
  switch (action.method) {
    case "/invoicesrpc.Invoices/AddHoldInvoice": {
      const normalized = exactDataRecord(result, ["addIndex", "invoiceDigest", "paymentRequest"], "hold-invoice result");
      if (typeof normalized.paymentRequest !== "string" || normalized.paymentRequest.length === 0
          || normalized.paymentRequest.length > 8_192) {
        throw new TypeError("adapter returned an invalid payment request");
      }
      if (invoiceDigest(normalized.paymentRequest) !== normalized.invoiceDigest) throw new Error("adapter returned an invalid invoice digest");
      uint(normalized.addIndex, "addIndex");
      bytes32(normalized.invoiceDigest, "created invoice digest");
      return Object.freeze({ result: Object.freeze({ ...normalized }), auditBinding });
    }
    case "/invoicesrpc.Invoices/SettleInvoice": {
      const normalized = exactDataRecord(result, ["state"], "settle-invoice result");
      if (normalized.state !== "SETTLED") throw new Error("adapter did not confirm invoice settlement");
      return Object.freeze({ result: Object.freeze({ state: "SETTLED" }), auditBinding });
    }
    case "/invoicesrpc.Invoices/CancelInvoice": {
      const normalized = exactDataRecord(result, ["state"], "cancel-invoice result");
      if (normalized.state !== "CANCELED") throw new Error("adapter did not confirm invoice cancellation");
      return Object.freeze({ result: Object.freeze({ state: "CANCELED" }), auditBinding });
    }
    case "/routerrpc.Router/SendPaymentV2": {
      const normalized = exactDataRecord(
        result,
        ["amountSats", "feeSats", "paymentHash", "preimage", "status"],
        "send-payment result",
      );
      if (normalized.status !== "SUCCEEDED") throw new Error("adapter did not confirm Lightning payment success");
      const paymentHash = bytes32(normalized.paymentHash, "result paymentHash");
      const preimage = bytes32(normalized.preimage, "result preimage");
      if (paymentHash !== action.paymentHash || preimageHash(preimage) !== action.paymentHash) {
        throw new Error("adapter payment proof does not match the action hash");
      }
      if (uint(normalized.amountSats, "result amountSats") !== action.amountSats) throw new Error("adapter payment amount changed");
      if (BigInt(uint(normalized.feeSats, "result feeSats")) > BigInt(operation.feeLimitSats)) {
        throw new Error("adapter payment fee exceeded the signed limit");
      }
      return Object.freeze({
        result: Object.freeze({
          status: "SUCCEEDED",
          paymentHash,
          amountSats: action.amountSats,
          feeSats: normalized.feeSats,
          preimage,
        }),
        auditBinding,
      });
    }
    default:
      throw new RangeError("action is not a Lightning adapter method");
  }
}

function validateReconciliationResult(action, method, body, authorization) {
  const response = exactDataRecord(body, ["audit", "result"], "adapter reconciliation response");
  const auditBinding = validateAdapterAudit(
    action,
    method,
    authorization.requestId,
    authorization.authorizedAt,
    authorization.expiresAt,
    response.audit,
  );
  const result = response.result;
  if (method === "/routerrpc.Router/TrackPaymentV2") {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError("payment tracking result must be an object");
    }
    const statusDescriptor = Object.getOwnPropertyDescriptor(result, "status");
    if (!statusDescriptor || !("value" in statusDescriptor) || typeof statusDescriptor.value !== "string"
        || !PAYMENT_TRACKING_STATES.has(statusDescriptor.value)) {
      throw new TypeError("payment tracking state is unsupported");
    }
    const status = statusDescriptor.value;
    const normalized = exactDataRecord(
      result,
      status === "SUCCEEDED"
        ? ["amountSats", "feeSats", "paymentHash", "preimage", "status"]
        : ["amountSats", "feeSats", "paymentHash", "status"],
      "payment tracking result",
    );
    if (bytes32(normalized.paymentHash, "tracked paymentHash") !== action.paymentHash) {
      throw new Error("tracked payment hash changed");
    }
    if (uint(normalized.amountSats, "tracked amountSats") !== action.amountSats) {
      throw new Error("tracked payment amount changed");
    }
    uint(normalized.feeSats, "tracked feeSats");
    const observation = {
      status,
      paymentHash: action.paymentHash,
      amountSats: action.amountSats,
      feeSats: normalized.feeSats,
    };
    if (status === "SUCCEEDED") {
      const preimage = bytes32(normalized.preimage, "tracked preimage");
      if (preimageHash(preimage) !== action.paymentHash) throw new Error("tracked preimage does not match the payment hash");
      observation.preimage = preimage;
    }
    return Object.freeze({ observation: Object.freeze(observation), auditBinding });
  }
  const normalized = exactDataRecord(
    result,
    ["amountPaidSats", "htlcs", "paymentHash", "state", "valueSats"],
    "invoice lookup result",
  );
  if (typeof normalized.state !== "string" || !INVOICE_STATES.has(normalized.state)) {
    throw new TypeError("invoice lookup state is unsupported");
  }
  if (bytes32(normalized.paymentHash, "looked-up paymentHash") !== action.paymentHash) {
    throw new Error("looked-up payment hash changed");
  }
  if (uint(normalized.valueSats, "invoice valueSats") !== action.amountSats) throw new Error("looked-up invoice amount changed");
  const amountPaidSats = uint(normalized.amountPaidSats, "invoice amountPaidSats");
  const htlcs = exactDataArray(normalized.htlcs, "invoice HTLC summary", 4_096).map((raw, index) => {
    const htlc = exactDataRecord(
      raw,
      ["acceptHeight", "amountMsat", "expiryHeight", "state"],
      `invoice HTLC summary ${index}`,
    );
    if (typeof htlc.state !== "string" || !INVOICE_HTLC_STATES.has(htlc.state)) {
      throw new TypeError("invoice HTLC state is unsupported");
    }
    const acceptHeight = integer(htlc.acceptHeight, "invoice HTLC acceptHeight");
    const expiryHeight = integer(htlc.expiryHeight, "invoice HTLC expiryHeight");
    if (expiryHeight < acceptHeight) throw new Error("invoice HTLC height order is invalid");
    return Object.freeze({
      state: htlc.state,
      amountMsat: uint(htlc.amountMsat, "invoice HTLC amountMsat"),
      acceptHeight,
      expiryHeight,
    });
  });
  if (normalized.state === "SETTLED" && BigInt(amountPaidSats) < BigInt(action.amountSats)) {
    throw new Error("settled invoice paid amount is insufficient");
  }
  if (normalized.state === "ACCEPTED") {
    const acceptedMsat = htlcs
      .filter((htlc) => htlc.state === "ACCEPTED")
      .reduce((total, htlc) => total + BigInt(htlc.amountMsat), 0n);
    if (acceptedMsat < BigInt(action.amountSats) * 1_000n) {
      throw new Error("accepted invoice HTLC amount is insufficient");
    }
  }
  return Object.freeze({
    observation: Object.freeze({
      status: normalized.state,
      paymentHash: action.paymentHash,
      valueSats: action.amountSats,
      amountPaidSats,
      htlcCount: htlcs.length,
    }),
    auditBinding,
  });
}

function validateNotFoundResponse(response, body) {
  if (response.status !== 502) throw new Error("adapter NOT_FOUND status is invalid");
  const error = exactDataRecord(body, ["ambiguous", "error", "errorCode"], "adapter NOT_FOUND response");
  if (error.ambiguous !== false || error.errorCode !== "NOT_FOUND"
      || typeof error.error !== "string" || error.error.length === 0 || error.error.length > 240) {
    throw new Error("adapter NOT_FOUND response is invalid");
  }
  return true;
}

export function lightningActionCommitment(action, operation) {
  const normalizedOperation = normalizeOperation(action.method, operation);
  return coordinatorCommitmentDigest({
    method: action.method,
    requestId: bytes32(action.requestId, "requestId"),
    intentDigest: bytes32(action.intentDigest, "intentDigest"),
    paymentHash: bytes32(action.paymentHash, "paymentHash"),
    invoiceDigest: bytes32(action.invoiceDigest, "invoiceDigest"),
    amountSats: uint(action.amountSats, "amountSats"),
    capacityEpoch: integer(action.capacityEpoch, "capacityEpoch"),
    operation: normalizedOperation,
  });
}

export class CoordinatorDispatchError extends Error {
  constructor(message, { ambiguous, actionState }) {
    super(message);
    this.name = "CoordinatorDispatchError";
    this.ambiguous = ambiguous;
    this.actionState = actionState;
  }
}

export async function dispatchLightningAction({
  store,
  actionId,
  operation,
  privateKey,
  keyId,
  adapterUrl,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  authorizationLifetimeSeconds = 15,
  requestImpl = fetch,
  dispatchTimeoutMs = 120_000,
  beforeSideEffect = null,
}) {
  const action = store.getAction(bytes32(actionId, "actionId"));
  if (!action) throw new Error("action does not exist");
  if (action.state !== "PENDING") throw new Error("action is not pending");
  const normalizedOperation = normalizeOperation(action.method, operation);
  if (lightningActionCommitment(action, normalizedOperation) !== action.payloadDigest) {
    throw new Error("transient Lightning operation does not match the durable commitment");
  }
  const actionUrl = privateAdapterActionUrl(adapterUrl);
  const authorizedAt = integer(nowSeconds(), "authorizedAt");
  const lifetime = integer(authorizationLifetimeSeconds, "authorizationLifetimeSeconds", 30);
  if (lifetime === 0) throw new RangeError("authorization lifetime must be non-zero");
  const expiresAt = authorizedAt + lifetime;
  const envelope = signLightningAuthorizationEnvelope({
    schema: "treeswap.lightning-authorization.v1",
    keyId,
    method: action.method,
    requestId: action.requestId,
    intentDigest: action.intentDigest,
    paymentHash: action.paymentHash,
    invoiceDigest: action.invoiceDigest,
    amountSats: action.amountSats,
    capacityEpoch: action.capacityEpoch,
    authorizedAt,
    expiresAt,
    operation: normalizedOperation,
  }, privateKey);
  if (beforeSideEffect !== null) {
    if (typeof beforeSideEffect !== "function") throw new TypeError("beforeSideEffect must be a function");
    await beforeSideEffect("lightning-dispatch-claim");
  }
  store.claimAction(action.actionId, authorizedAt);
  if (beforeSideEffect !== null) await beforeSideEffect("lightning-dispatch-send");
  const sendAt = integer(nowSeconds(), "dispatch send time");
  if (sendAt < authorizedAt) throw new Error("Lightning dispatch clock moved backwards before send");
  if (sendAt >= expiresAt) throw new Error("Lightning authorization envelope expired before send");

  let response;
  let body;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), integer(dispatchTimeoutMs, "dispatchTimeoutMs", 300_000));
  try {
    response = await requestImpl(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    body = await boundedJson(response);
  } catch {
    const observedAt = integer(nowSeconds(), "recordedAt");
    const proof = coordinatorCommitmentDigest({ actionId: action.actionId, code: "TRANSPORT_AMBIGUOUS", observedAt });
    store.recordActionResult({
      actionId: action.actionId,
      outcome: "ambiguous",
      resultDigest: proof,
      resultCode: "TRANSPORT_AMBIGUOUS",
      recordedAt: observedAt,
    });
    throw new CoordinatorDispatchError("Lightning adapter response is ambiguous; reconcile before retry", {
      ambiguous: true,
      actionState: "UNKNOWN",
    });
  } finally {
    clearTimeout(timeout);
  }

  const observedAt = integer(nowSeconds(), "recordedAt");
  if (!response.ok) {
    const resultCode = body?.ambiguous === true || response.status === 409 || response.status >= 500
      ? "ADAPTER_AMBIGUOUS"
      : "ADAPTER_REJECTED_UNPROVEN";
    const proof = coordinatorCommitmentDigest({ actionId: action.actionId, httpStatus: response.status, resultCode, observedAt });
    store.recordActionResult({
      actionId: action.actionId,
      outcome: "ambiguous",
      resultDigest: proof,
      resultCode,
      recordedAt: observedAt,
    });
    throw new CoordinatorDispatchError("Lightning adapter did not return a success proof; reconcile before retry", {
      ambiguous: true,
      actionState: "UNKNOWN",
    });
  }

  let validated;
  try {
    validated = validateAdapterResult(action, normalizedOperation, body, { authorizedAt, expiresAt });
  } catch {
    const proof = coordinatorCommitmentDigest({ actionId: action.actionId, code: "INVALID_SUCCESS_RESPONSE", observedAt });
    store.recordActionResult({
      actionId: action.actionId,
      outcome: "ambiguous",
      resultDigest: proof,
      resultCode: "INVALID_SUCCESS_RESPONSE",
      recordedAt: observedAt,
    });
    throw new CoordinatorDispatchError("Lightning adapter returned an invalid success proof; reconcile before retry", {
      ambiguous: true,
      actionState: "UNKNOWN",
    });
  }
  const result = validated.result;
  const resultDigest = coordinatorCommitmentDigest(validated);
  store.recordActionResult({
    actionId: action.actionId,
    outcome: "confirmed",
    resultDigest,
    resultCode: result.status ?? result.state ?? "SUCCEEDED",
    recordedAt: observedAt,
  });
  return Object.freeze({ action: store.getAction(action.actionId), result });
}

export async function reconcileLightningAction({
  store,
  actionId,
  reconciliationRequestId,
  privateKey,
  keyId,
  adapterUrl,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  authorizationLifetimeSeconds = 15,
  requestImpl = fetch,
  requestTimeoutMs = 30_000,
  beforeStateChange = null,
}) {
  const action = store.getAction(bytes32(actionId, "actionId"));
  if (!action) throw new Error("action does not exist");
  if (action.state !== "UNKNOWN") throw new Error("action does not require reconciliation");
  const method = action.method === "/routerrpc.Router/SendPaymentV2"
    ? "/routerrpc.Router/TrackPaymentV2"
    : action.method.startsWith("/invoicesrpc.Invoices/")
      ? "/invoicesrpc.Invoices/LookupInvoiceV2"
      : null;
  if (!method) throw new RangeError("action requires a chain-specific reconciler");
  const actionUrl = privateAdapterActionUrl(adapterUrl);
  const authorizedAt = integer(nowSeconds(), "authorizedAt");
  const lifetime = integer(authorizationLifetimeSeconds, "authorizationLifetimeSeconds", 30);
  if (lifetime === 0) throw new RangeError("authorization lifetime must be non-zero");
  const expiresAt = authorizedAt + lifetime;
  const requestId = bytes32(reconciliationRequestId, "reconciliationRequestId");
  const envelope = signLightningAuthorizationEnvelope({
    schema: "treeswap.lightning-authorization.v1",
    keyId,
    method,
    requestId,
    intentDigest: action.intentDigest,
    paymentHash: action.paymentHash,
    invoiceDigest: action.invoiceDigest,
    amountSats: action.amountSats,
    capacityEpoch: action.capacityEpoch,
    authorizedAt,
    expiresAt,
    operation: {},
  }, privateKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), integer(requestTimeoutMs, "requestTimeoutMs", 120_000));
  let response;
  let body;
  try {
    response = await requestImpl(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    body = await boundedJson(response);
  } catch {
    throw new CoordinatorDispatchError("read-only Lightning reconciliation did not return; the action remains unknown", {
      ambiguous: true,
      actionState: "UNKNOWN",
    });
  } finally {
    clearTimeout(timeout);
  }
  const observedAt = integer(nowSeconds(), "observedAt");
  if (!response.ok) {
    let notFound = false;
    try {
      validateNotFoundResponse(response, body);
      notFound = true;
    } catch {
      // A malformed, misrouted, or unauthenticated error cannot change durable state.
    }
    if (notFound) {
      const observationDigest = coordinatorCommitmentDigest({
        actionId: action.actionId,
        method,
        status: "NOT_FOUND",
        observedAt,
      });
      if (beforeStateChange !== null) {
        if (typeof beforeStateChange !== "function") throw new TypeError("beforeStateChange must be a function");
        await beforeStateChange("lightning-reconciliation");
      }
      return store.reconcileAction({
        actionId: action.actionId,
        observedState: "NOT_FOUND",
        observationDigest,
        observedAt,
      });
    }
    throw new CoordinatorDispatchError("read-only Lightning reconciliation was rejected; the action remains unknown", {
      ambiguous: true,
      actionState: "UNKNOWN",
    });
  }
  let validated;
  try {
    validated = validateReconciliationResult(action, method, body, { requestId, authorizedAt, expiresAt });
  } catch {
    throw new CoordinatorDispatchError("read-only Lightning reconciliation proof was invalid; the action remains unknown", {
      ambiguous: true,
      actionState: "UNKNOWN",
    });
  }
  const observation = validated.observation;
  const observationDigest = coordinatorCommitmentDigest(validated);
  if (beforeStateChange !== null) {
    if (typeof beforeStateChange !== "function") throw new TypeError("beforeStateChange must be a function");
    await beforeStateChange("lightning-reconciliation");
  }
  const reconciled = store.reconcileAction({
    actionId: action.actionId,
    observedState: observation.status,
    observationDigest,
    observedAt,
  });
  return Object.freeze({ ...reconciled, transientResult: observation });
}

export async function readConfirmedLightningPaymentProof({
  store,
  actionId,
  requestId,
  privateKey,
  keyId,
  adapterUrl,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  authorizationLifetimeSeconds = 15,
  requestImpl = fetch,
  requestTimeoutMs = 30_000,
}) {
  const action = store.getAction(bytes32(actionId, "actionId"));
  if (!action || action.method !== "/routerrpc.Router/SendPaymentV2") {
    throw new Error("confirmed payment action does not exist");
  }
  if (action.state !== "CONFIRMED") throw new Error("payment action is not confirmed");
  const method = "/routerrpc.Router/TrackPaymentV2";
  const actionUrl = privateAdapterActionUrl(adapterUrl);
  const authorizedAt = integer(nowSeconds(), "authorizedAt");
  const lifetime = integer(authorizationLifetimeSeconds, "authorizationLifetimeSeconds", 30);
  if (lifetime === 0) throw new RangeError("authorization lifetime must be non-zero");
  const expiresAt = authorizedAt + lifetime;
  const proofRequestId = bytes32(requestId, "requestId");
  const envelope = signLightningAuthorizationEnvelope({
    schema: "treeswap.lightning-authorization.v1",
    keyId,
    method,
    requestId: proofRequestId,
    intentDigest: action.intentDigest,
    paymentHash: action.paymentHash,
    invoiceDigest: action.invoiceDigest,
    amountSats: action.amountSats,
    capacityEpoch: action.capacityEpoch,
    authorizedAt,
    expiresAt,
    operation: {},
  }, privateKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), integer(requestTimeoutMs, "requestTimeoutMs", 120_000));
  let response;
  let body;
  try {
    response = await requestImpl(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    body = await boundedJson(response);
  } catch {
    throw new CoordinatorDispatchError("confirmed payment proof lookup did not return", {
      ambiguous: false,
      actionState: "CONFIRMED",
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new CoordinatorDispatchError("confirmed payment proof lookup was rejected", {
      ambiguous: false,
      actionState: "CONFIRMED",
    });
  }
  let validated;
  try {
    validated = validateReconciliationResult(action, method, body, {
      requestId: proofRequestId,
      authorizedAt,
      expiresAt,
    });
    const proof = validated.observation;
    if (proof.status !== "SUCCEEDED" || !proof.preimage) throw new Error("payment is not successful");
  } catch {
    throw new CoordinatorDispatchError("confirmed payment proof was invalid", {
      ambiguous: false,
      actionState: "CONFIRMED",
    });
  }
  return validated.observation;
}
