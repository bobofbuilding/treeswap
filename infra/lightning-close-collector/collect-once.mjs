import { createPrivateKey } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { collectLightningCloseAttestation } from "../../lib/lightning-close-collector-runtime.mjs";
import { LndRestClient } from "../../lib/lnd-rest-client.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name, maximum) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

const signingKeyPath = required("COLLECTOR_SIGNING_PRIVATE_KEY_PATH");
const [signingKeyPem, signingKeyStat] = await Promise.all([
  readFile(signingKeyPath),
  stat(signingKeyPath),
]);
if ((signingKeyStat.mode & 0o077) !== 0) {
  throw new Error("collector signing key must not be group/world accessible");
}
const signingKey = createPrivateKey(signingKeyPem);
if (signingKey.asymmetricKeyType !== "ed25519") throw new Error("collector signing key must be Ed25519");

const lnd = await LndRestClient.create({
  baseUrl: required("LND_REST_URL"),
  macaroonPath: required("LND_MACAROON_PATH"),
  tlsCertPath: required("LND_TLS_CERT_PATH"),
  expectedCertificateFingerprint: required("LND_TLS_CERT_FINGERPRINT"),
  maximumResponseBytes: integer("MAXIMUM_LND_RESPONSE_BYTES", 8_388_608),
});

const attestation = await collectLightningCloseAttestation({
  lnd,
  collectorId: required("COLLECTOR_ID"),
  nodeCommitment: required("LIGHTNING_NODE_COMMITMENT"),
  signingKey,
  attestationLifetimeSeconds: integer("ATTESTATION_LIFETIME_SECONDS", 60),
  requestTimeoutMs: integer("LND_REQUEST_TIMEOUT_MS", 120_000),
});
process.stdout.write(`${JSON.stringify(attestation)}\n`);
