import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createAuthenticatedLightningCapacityReader } from "../../lib/lightning-capacity-protocol.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const adapterUrl = new URL(required("ADAPTER_URL"));
if (adapterUrl.protocol !== "http:" || !/^[a-z0-9-]+$/.test(adapterUrl.hostname) || adapterUrl.port !== "3000") {
  throw new Error("capacity smoke adapter URL must be one private compose service on port 3000");
}
const direction = required("CAPACITY_DIRECTION");
const oppositeDirection = direction === "lightning-to-bit" ? "bit-to-lightning" : "lightning-to-bit";
const [requesterPrivatePem, observerPublicPem] = await Promise.all([
  readFile(required("COORDINATOR_PRIVATE_KEY_PATH")),
  readFile(required("CAPACITY_OBSERVER_PUBLIC_KEY_PATH")),
]);
const requesterPrivateKey = createPrivateKey(requesterPrivatePem);
const observerPublicKey = createPublicKey(observerPublicPem);
const endpointKey = generateKeyPairSync("ed25519").publicKey;
const capabilityDigest = `0x${randomBytes(32).toString("hex")}`;

async function fetchObservation(envelope) {
  const response = await fetch(new URL("/v1/capacity", adapterUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("capacity endpoint rejected the authenticated request");
  return response.json();
}

const read = createAuthenticatedLightningCapacityReader({
  observerPublicKey,
  observerKeyId: required("CAPACITY_OBSERVER_KEY_ID"),
  requesterPrivateKey,
  requesterKeyId: required("COORDINATOR_KEY_ID"),
  fetchObservation,
  maxObservationAgeSeconds: 30,
  maxClockSkewSeconds: 5,
  maxObservationTtlSeconds: 30,
  timeoutMs: 5_000,
});

const request = {
  capabilityDigest,
  capacityEpoch: required("CAPACITY_EPOCH"),
  direction,
  endpointOrigin: "https://solver-regtest.example",
  endpointPublicKey: endpointKey,
  lightningNodePubkey: required("LIGHTNING_NODE_PUBKEY").toLowerCase(),
  solverId: required("SOLVER_ID"),
};
const observation = await read(request);
assert.ok(BigInt(observation.availableLightningSats) > 0n);
assert.ok(BigInt(observation.availableLightningSats) <= 100_000n);
assert.equal(observation.capacityEpoch, "1");
assert.equal(observation.nodePubkey, request.lightningNodePubkey);

await assert.rejects(() => read({ ...request, direction: oppositeDirection }), /rejected/);
const unsigned = await fetch(new URL("/v1/capacity", adapterUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
  signal: AbortSignal.timeout(5_000),
});
assert.equal(unsigned.status, 403);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  direction,
  availableLightningSats: observation.availableLightningSats,
  capacityEpoch: observation.capacityEpoch,
  privacy: "aggregate-only-no-channel-identifiers",
})}\n`);
