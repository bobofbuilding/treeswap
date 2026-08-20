import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { LightningActionJournal } from "../../lib/lightning-action-journal.mjs";
import { LightningChainProgressStore } from "../../lib/lightning-chain-progress.mjs";
import { LightningAdapterRuntime } from "../../lib/lightning-adapter-runtime.mjs";
import { LndRestClient, LndRestError } from "../../lib/lnd-rest-client.mjs";
import {
  buildLightningCapacityObservation,
  signLightningCapacityObservation,
  verifyLightningCapacityRequest,
} from "../../lib/lightning-capacity-protocol.mjs";

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
const capacitySigningKeyPath = required("CAPACITY_SIGNING_PRIVATE_KEY_PATH");
const [capacitySigningKeyPem, capacitySigningKeyStat] = await Promise.all([
  readFile(capacitySigningKeyPath),
  stat(capacitySigningKeyPath),
]);
if ((capacitySigningKeyStat.mode & 0o077) !== 0) throw new Error("capacity signing key must not be group/world accessible");
const capacitySigningKey = createPrivateKey(capacitySigningKeyPem);
if (capacitySigningKey.asymmetricKeyType !== "ed25519") throw new Error("capacity signing key must be Ed25519");
const capacitySigningKeyId = required("CAPACITY_SIGNING_KEY_ID");
const capacityRequestLifetimeSeconds = integer("MAX_CAPACITY_REQUEST_LIFETIME_SECONDS", 60);
const capacityObservationTtlSeconds = integer("MAX_CAPACITY_OBSERVATION_TTL_SECONDS", 60);
const capacityClockSkewSeconds = integer("MAX_CAPACITY_CLOCK_SKEW_SECONDS", 60);
if (capacityRequestLifetimeSeconds === 0 || capacityObservationTtlSeconds === 0) {
  throw new Error("capacity authority windows must be positive");
}
const lnd = await LndRestClient.create({
  baseUrl: required("LND_REST_URL"),
  macaroonPath: required("LND_MACAROON_PATH"),
  tlsCertPath: required("LND_TLS_CERT_PATH"),
  expectedCertificateFingerprint: required("LND_TLS_CERT_FINGERPRINT"),
});
const journal = await LightningActionJournal.open(required("ADAPTER_JOURNAL_PATH"));
const chainProgress = await LightningChainProgressStore.open(required("CHAIN_PROGRESS_PATH"));
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
  maxChainNoProgressSeconds: integer("MAX_CHAIN_NO_PROGRESS_SECONDS", 604_800),
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
  minimumInboundReserveSats: bigint("MINIMUM_INBOUND_RESERVE_SATS"),
  minimumOutboundReserveSats: bigint("MINIMUM_OUTBOUND_RESERVE_SATS"),
  maximumAdvertisedInboundSats: bigint("MAXIMUM_ADVERTISED_INBOUND_SATS"),
  maximumAdvertisedOutboundSats: bigint("MAXIMUM_ADVERTISED_OUTBOUND_SATS"),
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
  chainProgress,
  policy,
});
await runtime.initializeChainProgress();

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, 200, { status: "ready", role });
    return;
  }
  if (request.method === "POST" && request.url === "/v1/capacity") {
    if (request.headers["content-type"] !== "application/json") {
      send(response, 415, { error: "content-type must be application/json" });
      return;
    }
    try {
      const now = Math.floor(Date.now() / 1_000);
      const authorized = verifyLightningCapacityRequest({
        envelope: await readJsonBody(request),
        publicKey,
        expectedKeyId: required("COORDINATOR_KEY_ID"),
        now,
        maxLifetimeSeconds: capacityRequestLifetimeSeconds,
        maxClockSkewSeconds: capacityClockSkewSeconds,
      });
      const aggregate = await runtime.observeCapacity(authorized.direction);
      const expiresAt = Math.min(authorized.expiresAt, aggregate.observedAt + capacityObservationTtlSeconds);
      send(response, 200, signLightningCapacityObservation(buildLightningCapacityObservation({
        request: authorized,
        aggregate,
        observerKeyId: capacitySigningKeyId,
        expiresAt,
      }), capacitySigningKey));
    } catch {
      send(response, 403, { error: "capacity unavailable" });
    }
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
