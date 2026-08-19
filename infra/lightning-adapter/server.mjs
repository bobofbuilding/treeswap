import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { LightningActionJournal } from "../../lib/lightning-action-journal.mjs";
import { LightningAdapterRuntime } from "../../lib/lightning-adapter-runtime.mjs";
import { LndRestClient, LndRestError } from "../../lib/lnd-rest-client.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function bigint(name) {
  const value = required(name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} is invalid`);
  return BigInt(value);
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 262_144) throw new Error("request body exceeds adapter limit");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function send(response, statusCode, payload) {
  const body = `${JSON.stringify(payload, (_, value) => typeof value === "bigint" ? value.toString() : value)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

const role = required("ADAPTER_ROLE");
const publicKey = createPublicKey(await readFile(required("COORDINATOR_PUBLIC_KEY_PATH")));
const lnd = await LndRestClient.create({
  baseUrl: required("LND_REST_URL"),
  macaroonPath: required("LND_MACAROON_PATH"),
  tlsCertPath: required("LND_TLS_CERT_PATH"),
  expectedCertificateFingerprint: required("LND_TLS_CERT_FINGERPRINT"),
});
const journal = await LightningActionJournal.open(required("ADAPTER_JOURNAL_PATH"));
const policy = Object.freeze({
  maxAuthorizationLifetimeSeconds: integer("MAX_AUTHORIZATION_LIFETIME_SECONDS", 300),
  maxCredentialAgeSeconds: integer("MAX_CREDENTIAL_AGE_SECONDS", 31_536_000),
  pinnedCertificateFingerprint: required("LND_TLS_CERT_FINGERPRINT"),
  maxPaymentSats: bigint("MAX_PAYMENT_SATS"),
  maxDailyValueSats: bigint("MAX_DAILY_VALUE_SATS"),
  maxInFlightSats: bigint("MAX_IN_FLIGHT_SATS"),
  capacityEpoch: integer("CAPACITY_EPOCH"),
  maxPendingChannels: integer("MAX_PENDING_CHANNELS", 100),
  minimumActiveChannels: integer("MINIMUM_ACTIVE_CHANNELS", 100),
  maxChainHeaderAgeSeconds: integer("MAX_CHAIN_HEADER_AGE_SECONDS", 604_800),
  maxChainHeaderFutureSeconds: integer("MAX_CHAIN_HEADER_FUTURE_SECONDS", 7_200),
  healthTimeoutMs: integer("HEALTH_TIMEOUT_MS", 60_000),
  dispatchTimeoutMs: integer("DISPATCH_TIMEOUT_MS", 120_000),
  minimumInvoiceExpirySeconds: integer("MINIMUM_INVOICE_EXPIRY_SECONDS", 86_400),
  maximumInvoiceExpirySeconds: integer("MAXIMUM_INVOICE_EXPIRY_SECONDS", 604_800),
  minimumHoldInvoiceCltvBlocks: integer("MINIMUM_HOLD_INVOICE_CLTV_BLOCKS", 2_016),
  maximumHoldInvoiceCltvBlocks: integer("MAXIMUM_HOLD_INVOICE_CLTV_BLOCKS", 2_016),
  fulfillmentSafetyBlocks: integer("FULFILLMENT_SAFETY_BLOCKS", 2_016),
  maximumPaymentTimeoutSeconds: integer("MAXIMUM_PAYMENT_TIMEOUT_SECONDS", 300),
  maximumRoutingFeeSats: integer("MAXIMUM_ROUTING_FEE_SATS", Number.MAX_SAFE_INTEGER),
  invoiceExpiryMarginSeconds: integer("INVOICE_EXPIRY_MARGIN_SECONDS", 86_400),
  minimumPaymentCltvBlocks: integer("MINIMUM_PAYMENT_CLTV_BLOCKS", 2_016),
});
const runtime = new LightningAdapterRuntime({
  role,
  credential: {
    id: required("CREDENTIAL_ID"),
    rootKeyId: integer("CREDENTIAL_ROOT_KEY_ID"),
    active: true,
    revoked: false,
    browserExposed: false,
    issuedAt: integer("CREDENTIAL_ISSUED_AT"),
  },
  publicKey,
  keyId: required("COORDINATOR_KEY_ID"),
  lnd,
  journal,
  policy,
});

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, 200, { status: "ready", role });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/action") {
    send(response, 404, { error: "not found" });
    return;
  }
  if (request.headers["content-type"] !== "application/json") {
    send(response, 415, { error: "content-type must be application/json" });
    return;
  }
  try {
    send(response, 200, await runtime.execute(await readJsonBody(request)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "adapter request failed";
    const errorCode = error instanceof LndRestError && Number(error.grpcCode) === 5 ? "NOT_FOUND" : "REJECTED";
    const status = /already used/.test(message) ? 409
      : error instanceof LndRestError && error.ambiguous ? 503
        : error instanceof LndRestError ? 502
          : 403;
    send(response, status, {
      error: message.slice(0, 240),
      errorCode,
      ambiguous: error instanceof LndRestError && error.ambiguous,
    });
  }
});

server.listen(3000, "0.0.0.0", () => {
  process.stdout.write(`TreeSwap ${role} Lightning adapter ready on the private network.\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
