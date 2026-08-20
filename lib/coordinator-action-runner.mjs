import { createHash } from "node:crypto";
import { coordinatorCommitmentDigest } from "./coordinator-store.mjs";
import { signLightningAuthorizationEnvelope } from "./lightning-authorization-envelope.mjs";
import { invoiceDigest, isPrivateLndHostname } from "./lnd-rest-client.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const LIGHTNING_METHODS = new Set([
  "/invoicesrpc.Invoices/AddHoldInvoice",
  "/invoicesrpc.Invoices/SettleInvoice",
  "/invoicesrpc.Invoices/CancelInvoice",
  "/routerrpc.Router/SendPaymentV2",
]);

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function uint(value, name) {
  const raw = String(value ?? "");
  if (!UINT.test(raw)) throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  return raw;
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
    case "/invoicesrpc.Invoices/AddHoldInvoice":
      exactKeys(operation, ["cltvExpiry", "expirySeconds", "isPrivate", "memo"], "hold-invoice operation");
      return {
        cltvExpiry: integer(operation.cltvExpiry, "cltvExpiry"),
        expirySeconds: integer(operation.expirySeconds, "expirySeconds"),
        isPrivate: operation.isPrivate === true,
        memo: String(operation.memo ?? ""),
      };
    case "/invoicesrpc.Invoices/SettleInvoice":
      exactKeys(operation, ["preimage"], "settle-invoice operation");
      return { preimage: bytes32(operation.preimage, "preimage") };
    case "/invoicesrpc.Invoices/CancelInvoice":
      exactKeys(operation, [], "cancel-invoice operation");
      return {};
    case "/routerrpc.Router/SendPaymentV2":
      exactKeys(operation, ["feeLimitSats", "paymentRequest", "timeoutSeconds"], "send-payment operation");
      return {
        feeLimitSats: uint(operation.feeLimitSats, "feeLimitSats"),
        paymentRequest: String(operation.paymentRequest ?? ""),
        timeoutSeconds: integer(operation.timeoutSeconds, "timeoutSeconds"),
      };
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

function validateAdapterResult(action, operation, body) {
  exactKeys(body, ["audit", "result"], "adapter success response");
  const result = body.result;
  switch (action.method) {
    case "/invoicesrpc.Invoices/AddHoldInvoice":
      exactKeys(result, ["addIndex", "invoiceDigest", "paymentRequest"], "hold-invoice result");
      if (invoiceDigest(result.paymentRequest) !== result.invoiceDigest) throw new Error("adapter returned an invalid invoice digest");
      uint(result.addIndex, "addIndex");
      bytes32(result.invoiceDigest, "created invoice digest");
      return Object.freeze({ ...result });
    case "/invoicesrpc.Invoices/SettleInvoice":
      exactKeys(result, ["state"], "settle-invoice result");
      if (result.state !== "SETTLED") throw new Error("adapter did not confirm invoice settlement");
      return Object.freeze({ state: "SETTLED" });
    case "/invoicesrpc.Invoices/CancelInvoice":
      exactKeys(result, ["state"], "cancel-invoice result");
      if (result.state !== "CANCELED") throw new Error("adapter did not confirm invoice cancellation");
      return Object.freeze({ state: "CANCELED" });
    case "/routerrpc.Router/SendPaymentV2": {
      exactKeys(result, ["amountSats", "feeSats", "paymentHash", "preimage", "status"], "send-payment result");
      if (result.status !== "SUCCEEDED") throw new Error("adapter did not confirm Lightning payment success");
      const paymentHash = bytes32(result.paymentHash, "result paymentHash");
      const preimage = bytes32(result.preimage, "result preimage");
      if (paymentHash !== action.paymentHash || preimageHash(preimage) !== action.paymentHash) {
        throw new Error("adapter payment proof does not match the action hash");
      }
      if (uint(result.amountSats, "result amountSats") !== action.amountSats) throw new Error("adapter payment amount changed");
      if (BigInt(uint(result.feeSats, "result feeSats")) > BigInt(operation.feeLimitSats)) {
        throw new Error("adapter payment fee exceeded the signed limit");
      }
      return Object.freeze({
        status: "SUCCEEDED",
        paymentHash,
        amountSats: action.amountSats,
        feeSats: result.feeSats,
        preimage,
      });
    }
    default:
      throw new RangeError("action is not a Lightning adapter method");
  }
}

function validateReconciliationResult(action, method, body) {
  exactKeys(body, ["audit", "result"], "adapter reconciliation response");
  const result = body.result;
  if (method === "/routerrpc.Router/TrackPaymentV2") {
    const status = String(result.status ?? "UNKNOWN");
    exactKeys(
      result,
      status === "SUCCEEDED"
        ? ["amountSats", "feeSats", "paymentHash", "preimage", "status"]
        : ["amountSats", "feeSats", "paymentHash", "status"],
      "payment tracking result",
    );
    if (bytes32(result.paymentHash, "tracked paymentHash") !== action.paymentHash) {
      throw new Error("tracked payment hash changed");
    }
    if (uint(result.amountSats, "tracked amountSats") !== action.amountSats) {
      throw new Error("tracked payment amount changed");
    }
    uint(result.feeSats, "tracked feeSats");
    const observation = {
      status,
      paymentHash: action.paymentHash,
      amountSats: action.amountSats,
      feeSats: result.feeSats,
    };
    if (status === "SUCCEEDED") {
      const preimage = bytes32(result.preimage, "tracked preimage");
      if (preimageHash(preimage) !== action.paymentHash) throw new Error("tracked preimage does not match the payment hash");
      observation.preimage = preimage;
    }
    return Object.freeze(observation);
  }
  exactKeys(result, ["amountPaidSats", "htlcs", "paymentHash", "state", "valueSats"], "invoice lookup result");
  if (bytes32(result.paymentHash, "looked-up paymentHash") !== action.paymentHash) {
    throw new Error("looked-up payment hash changed");
  }
  if (uint(result.valueSats, "invoice valueSats") !== action.amountSats) throw new Error("looked-up invoice amount changed");
  uint(result.amountPaidSats, "invoice amountPaidSats");
  if (!Array.isArray(result.htlcs)) throw new TypeError("invoice HTLC summary must be an array");
  return Object.freeze({
    status: String(result.state ?? "UNKNOWN"),
    paymentHash: action.paymentHash,
    valueSats: action.amountSats,
    amountPaidSats: result.amountPaidSats,
    htlcCount: result.htlcs.length,
  });
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
    expiresAt: authorizedAt + lifetime,
    operation: normalizedOperation,
  }, privateKey);
  store.claimAction(action.actionId, authorizedAt);

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

  let result;
  try {
    result = validateAdapterResult(action, normalizedOperation, body);
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
  const resultDigest = coordinatorCommitmentDigest(result);
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
  const envelope = signLightningAuthorizationEnvelope({
    schema: "treeswap.lightning-authorization.v1",
    keyId,
    method,
    requestId: bytes32(reconciliationRequestId, "reconciliationRequestId"),
    intentDigest: action.intentDigest,
    paymentHash: action.paymentHash,
    invoiceDigest: action.invoiceDigest,
    amountSats: action.amountSats,
    capacityEpoch: action.capacityEpoch,
    authorizedAt,
    expiresAt: authorizedAt + lifetime,
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
    if (body?.errorCode === "NOT_FOUND" && body?.ambiguous !== true) {
      const observationDigest = coordinatorCommitmentDigest({
        actionId: action.actionId,
        method,
        status: "NOT_FOUND",
        observedAt,
      });
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
  let observation;
  try {
    observation = validateReconciliationResult(action, method, body);
  } catch {
    throw new CoordinatorDispatchError("read-only Lightning reconciliation proof was invalid; the action remains unknown", {
      ambiguous: true,
      actionState: "UNKNOWN",
    });
  }
  const observationDigest = coordinatorCommitmentDigest(observation);
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
  const envelope = signLightningAuthorizationEnvelope({
    schema: "treeswap.lightning-authorization.v1",
    keyId,
    method,
    requestId: bytes32(requestId, "requestId"),
    intentDigest: action.intentDigest,
    paymentHash: action.paymentHash,
    invoiceDigest: action.invoiceDigest,
    amountSats: action.amountSats,
    capacityEpoch: action.capacityEpoch,
    authorizedAt,
    expiresAt: authorizedAt + lifetime,
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
  let proof;
  try {
    proof = validateReconciliationResult(action, method, body);
    if (proof.status !== "SUCCEEDED" || !proof.preimage) throw new Error("payment is not successful");
  } catch {
    throw new CoordinatorDispatchError("confirmed payment proof was invalid", {
      ambiguous: false,
      actionState: "CONFIRMED",
    });
  }
  return proof;
}
