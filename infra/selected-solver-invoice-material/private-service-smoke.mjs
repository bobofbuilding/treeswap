import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  createSelectedSolverInvoiceMaterialClient,
  verifiedSelectedSolverInvoiceMaterialResponse,
} from "../../lib/selected-solver-invoice-material-transport.mjs";

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

function digest() {
  let bytes;
  do bytes = randomBytes(32); while (bytes.every((value) => value === 0));
  return `0x${bytes.toString("hex")}`;
}

async function readPrivateState(path) {
  const [directory, file] = await Promise.all([stat(dirname(path)), lstat(path)]);
  const currentUid = process.getuid?.();
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0
      || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o177) !== 0
      || (currentUid !== undefined && (directory.uid !== currentUid || file.uid !== currentUid))) {
    throw new Error("invoice-material client state is not owner-controlled");
  }
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > 32_768) {
    throw new Error("invoice-material client state is outside policy");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
}

async function writePrivateState(path, value) {
  const directory = await stat(dirname(path));
  const currentUid = process.getuid?.();
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0
      || (currentUid !== undefined && directory.uid !== currentUid)) {
    throw new Error("invoice-material client state directory is not owner-controlled");
  }
  const pendingPath = `${path}.pending`;
  const handle = await open(pendingPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(pendingPath, path);
}

const mode = requiredEnvironment("SMOKE_MODE");
if (mode !== "create" && mode !== "recover") throw new Error("SMOKE_MODE is unsupported");
const statePath = requiredEnvironment("CLIENT_STATE_PATH");
const now = Math.floor(Date.now() / 1_000);
const record = mode === "create"
  ? {
    request: {
      requestId: digest(),
      requestDigest: digest(),
      capabilityDigest: digest(),
      selectedOfferId: digest(),
      amountSats: "10000",
      authorizationExpiresAt: now + 30,
    },
  }
  : await readPrivateState(statePath);

const lifecycle = new AbortController();
const client = createSelectedSolverInvoiceMaterialClient({
  endpointOrigin: requiredEnvironment("PROVIDER_ORIGIN"),
  requesterPrivateKey: await readFile(requiredEnvironment("REQUESTER_PRIVATE_KEY_PATH")),
  requesterKeyId: requiredEnvironment("REQUESTER_KEY_ID"),
  providerPublicKey: await readFile(requiredEnvironment("PROVIDER_PUBLIC_KEY_PATH")),
  providerKeyId: requiredEnvironment("PROVIDER_KEY_ID"),
  providerCertificate: await readFile(
    requiredEnvironment("PROVIDER_TLS_CERTIFICATE_PATH"),
    "utf8",
  ),
  expectedCertificateFingerprint: requiredEnvironment("PROVIDER_TLS_CERT_FINGERPRINT"),
  paymentSecretKeyId: requiredEnvironment("PAYMENT_SECRET_KEY_ID"),
  requestTtlSeconds: environmentInteger("REQUEST_TTL_SECONDS", 1, 30),
  timeoutMs: environmentInteger("REQUEST_TIMEOUT_MS", 100, 10_000),
  signal: lifecycle.signal,
});

try {
  const response = verifiedSelectedSolverInvoiceMaterialResponse(
    await client.send(client.prepare(record.request)),
  );
  assert.equal(response.requestId, record.request.requestId);
  assert.equal(response.requestDigest, record.request.requestDigest);
  assert.equal(response.capabilityDigest, record.request.capabilityDigest);
  assert.equal(response.selectedOfferId, record.request.selectedOfferId);
  assert.equal(response.amountSats, record.request.amountSats);
  assert.equal(response.invoiceState, "OPEN");
  assert.match(response.invoice, /^lnbcrt[0-9a-z]+$/);
  assert.equal(client.status().fundingAuthorization, false);
  assert.equal(client.status().settlementAuthorization, false);
  const responseJson = JSON.stringify(response);
  if (mode === "create") {
    await writePrivateState(statePath, { request: record.request, responseJson });
  } else {
    assert.equal(responseJson, record.responseJson);
  }
  process.stdout.write(response.paymentHash);
} finally {
  lifecycle.abort();
}
