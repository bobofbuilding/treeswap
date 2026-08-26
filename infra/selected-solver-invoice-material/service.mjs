import { createPrivateKey } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { LndRestClient } from "../../lib/lnd-rest-client.mjs";
import {
  createSelectedSolverInvoiceMaterialService,
  loadSelectedSolverPaymentSecretKey,
} from "../../lib/selected-solver-invoice-material.mjs";
import {
  SelectedSolverInvoiceMaterialProviderStore,
  createSelectedSolverInvoiceMaterialProviderRoute,
} from "../../lib/selected-solver-invoice-material-provider.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value) throw new Error(`missing ${name}`);
  return value;
}

function environmentInteger(name, minimum, maximum) {
  const raw = requiredEnvironment(name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside policy`);
  }
  return value;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function loadPrivateKey(path) {
  const bytes = await readFile(path);
  try {
    return createPrivateKey(bytes);
  } finally {
    bytes.fill(0);
  }
}

const origin = requiredEnvironment("PROVIDER_ORIGIN");
const originUrl = new URL(origin);
const port = environmentInteger("PORT", 1, 65_535);
const statePath = requiredEnvironment("PROVIDER_STATE_PATH");
const providerPrivateKey = await loadPrivateKey(requiredEnvironment("PROVIDER_PRIVATE_KEY_PATH"));
const requesterPublicKey = await readFile(requiredEnvironment("REQUESTER_PUBLIC_KEY_PATH"));
const tlsKey = await readFile(requiredEnvironment("TLS_PRIVATE_KEY_PATH"));
const tlsCertificate = await readFile(requiredEnvironment("TLS_CERTIFICATE_PATH"));
const paymentSecretKey = await loadSelectedSolverPaymentSecretKey(
  requiredEnvironment("PAYMENT_SECRET_KEY_PATH"),
);
const lndClient = await LndRestClient.create({
  baseUrl: requiredEnvironment("LND_REST_URL"),
  macaroonPath: requiredEnvironment("LND_MACAROON_PATH"),
  tlsCertPath: requiredEnvironment("LND_TLS_CERT_PATH"),
  expectedCertificateFingerprint: requiredEnvironment("LND_TLS_CERT_FINGERPRINT"),
  maximumResponseBytes: environmentInteger("MAXIMUM_LND_RESPONSE_BYTES", 1_024, 8_388_608),
});
const invoiceService = createSelectedSolverInvoiceMaterialService({
  lndClient,
  memo: requiredEnvironment("INVOICE_MEMO"),
  paymentSecretKey,
  paymentSecretKeyId: requiredEnvironment("PAYMENT_SECRET_KEY_ID"),
  policy: Object.freeze({
    addTimeoutMs: environmentInteger("LND_ADD_TIMEOUT_MS", 100, 120_000),
    lookupTimeoutMs: environmentInteger("LND_LOOKUP_TIMEOUT_MS", 100, 60_000),
    invoiceExpirySeconds: environmentInteger("INVOICE_EXPIRY_SECONDS", 3_600, 10_800),
    cltvExpiry: environmentInteger("INVOICE_CLTV_EXPIRY", 48, 144),
    maximumInvoiceBytes: environmentInteger("MAXIMUM_INVOICE_BYTES", 256, 8_192),
  }),
});
const store = await SelectedSolverInvoiceMaterialProviderStore.open({
  path: statePath,
  initialize: !(await exists(statePath)),
  allowMemory: false,
  maximumLiveRequests: environmentInteger("MAXIMUM_LIVE_REQUESTS", 1, 4_096),
});
const lifecycle = new AbortController();
const route = createSelectedSolverInvoiceMaterialProviderRoute({
  store,
  invoiceService,
  providerOrigin: origin,
  requesterPublicKey,
  expectedRequesterKeyId: requiredEnvironment("REQUESTER_KEY_ID"),
  providerPrivateKey,
  providerKeyId: requiredEnvironment("PROVIDER_KEY_ID"),
  paymentSecretKeyId: requiredEnvironment("PAYMENT_SECRET_KEY_ID"),
  maximumRequestBytes: environmentInteger("MAXIMUM_REQUEST_BYTES", 1_024, 16_384),
  maxClockSkewSeconds: environmentInteger("MAXIMUM_CLOCK_SKEW_SECONDS", 0, 60),
  requestTimeoutMs: environmentInteger("REQUEST_TIMEOUT_MS", 100, 10_000),
  recoveryLeaseSeconds: environmentInteger("RECOVERY_LEASE_SECONDS", 1, 15),
  responseTtlSeconds: environmentInteger("RESPONSE_TTL_SECONDS", 1, 30),
  signal: lifecycle.signal,
});

function writeResponse(response, status, headers, bytes) {
  response.writeHead(status, Object.fromEntries(headers));
  response.end(bytes);
}

const server = createServer({
  key: tlsKey,
  cert: tlsCertificate,
  minVersion: "TLSv1.3",
  maxVersion: "TLSv1.3",
  handshakeTimeout: 5_000,
  requestTimeout: 6_000,
  headersTimeout: 5_000,
  keepAliveTimeout: 1_000,
  maxHeaderSize: 8_192,
  requestCert: false,
}, async (incoming, outgoing) => {
  outgoing.setHeader("connection", "close");
  try {
    if (incoming.method === "GET" && incoming.url === "/healthz") {
      const status = route.status();
      const bytes = Buffer.from(JSON.stringify({
        status: status.provider.state === "active" ? "ok" : "stopped",
        liveClaimedRequests: status.liveClaimedRequests,
        liveReadyResponses: status.liveReadyResponses,
      }));
      writeResponse(outgoing, 200, new Headers({
        "cache-control": "no-store",
        "content-length": String(bytes.length),
        "content-type": "application/json",
      }), bytes);
      return;
    }
    if (incoming.headers.host !== originUrl.host) throw new Error("host changed");
    const abort = new AbortController();
    incoming.once("aborted", () => abort.abort());
    const request = new Request(`${origin}${incoming.url ?? ""}`, {
      method: incoming.method,
      headers: incoming.headers,
      body: incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined : Readable.toWeb(incoming),
      duplex: "half",
      signal: abort.signal,
    });
    const result = await route.handle(request);
    writeResponse(
      outgoing,
      result.status,
      result.headers,
      Buffer.from(await result.arrayBuffer()),
    );
  } catch {
    const bytes = Buffer.from('{"error":"request rejected"}');
    writeResponse(outgoing, 400, new Headers({
      "cache-control": "no-store",
      "content-length": String(bytes.length),
      "content-type": "application/json",
    }), bytes);
  }
});
tlsKey.fill(0);
server.maxHeadersCount = 32;
server.maxRequestsPerSocket = 1;

server.listen(port, "0.0.0.0");

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  lifecycle.abort();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
