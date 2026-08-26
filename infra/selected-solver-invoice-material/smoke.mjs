import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  LndRestClient,
  LndRestError,
} from "../../lib/lnd-rest-client.mjs";
import {
  createSelectedSolverInvoiceMaterialService,
  loadSelectedSolverPaymentSecretKey,
  resolveSelectedSolverInvoiceMaterial,
  selectedSolverInvoiceMaterialBinding,
} from "../../lib/selected-solver-invoice-material.mjs";

function requiredEnvironment(name) {
  const value = String(process.env[name] ?? "");
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function digest() {
  let value;
  do {
    value = randomBytes(32).toString("hex");
  } while (/^0+$/.test(value));
  return `0x${value}`;
}

const paymentSecretKey = await loadSelectedSolverPaymentSecretKey(
  requiredEnvironment("PAYMENT_SECRET_KEY_PATH"),
);
const lndClient = await LndRestClient.create({
  baseUrl: requiredEnvironment("LND_REST_URL"),
  macaroonPath: requiredEnvironment("LND_MACAROON_PATH"),
  tlsCertPath: requiredEnvironment("LND_TLS_CERT_PATH"),
  expectedCertificateFingerprint: requiredEnvironment("LND_TLS_CERT_FINGERPRINT"),
  maximumResponseBytes: 1_048_576,
});
const input = Object.freeze({
  requestId: digest(),
  requestDigest: digest(),
  capabilityDigest: digest(),
  selectedOfferId: digest(),
  amountSats: "10000",
});
const configuration = Object.freeze({
  lndClient,
  memo: "treeswap-selected-solver-material-regtest",
  paymentSecretKey,
  paymentSecretKeyId: "regtest-selected-solver-payment-secret-1",
  policy: Object.freeze({
    addTimeoutMs: 5_000,
    lookupTimeoutMs: 5_000,
    invoiceExpirySeconds: 3_600,
    cltvExpiry: 80,
    maximumInvoiceBytes: 4_096,
  }),
});

const firstService = createSelectedSolverInvoiceMaterialService(configuration);
const first = await resolveSelectedSolverInvoiceMaterial(firstService, input, {
  recovery: false,
  signal: new AbortController().signal,
});
assert.equal(selectedSolverInvoiceMaterialBinding(first), first);
assert.match(first.invoice, /^lnbcrt[0-9a-z]+$/);
assert.equal(first.invoiceState, "OPEN");
assert.equal(first.fundingAuthorization, false);
assert.equal(first.settlementAuthorization, false);
assert.equal(firstService.status().networkListener, false);
assert.equal(firstService.status().exposesPreimage, false);
assert.equal(firstService.status().exposesLndCredential, false);

const restartedService = createSelectedSolverInvoiceMaterialService(configuration);
const recovered = await resolveSelectedSolverInvoiceMaterial(restartedService, input, {
  recovery: true,
  signal: new AbortController().signal,
});
assert.equal(recovered.paymentHash, first.paymentHash);
assert.equal(recovered.invoice, first.invoice);
assert.equal(recovered.invoiceDigest, first.invoiceDigest);
assert.equal(recovered.addIndex, first.addIndex);

await assert.rejects(
  lndClient.cancelInvoice(first.paymentHash, 5_000),
  (error) => error instanceof LndRestError && error.reason === "permission-denied",
);

process.stdout.write(JSON.stringify({
  amountSats: first.amountSats,
  invoice: first.invoice,
  invoiceDigest: first.invoiceDigest,
  paymentHash: first.paymentHash,
}));
