import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { id } from "ethers";
import { collectLightningCloseAttestation } from "../lib/lightning-close-collector-runtime.mjs";
import {
  evaluateLightningCloseCollectorQuorum,
  signLightningCloseCollectorAttestation,
  verifyLightningCloseCollectorAttestation,
} from "../lib/lightning-close-collector.mjs";
import { evaluateLightningCloseRecovery } from "../lib/lightning-close-monitor.mjs";
import { evaluateSafetyMonitor, REQUIRED_SAFETY_CHECKS } from "../lib/safety-monitor.mjs";

const NOW = 2_100_000_000;
const NODE_COMMITMENT = id("treeswap-regtest-alice-close-monitor").toLowerCase();

function keyPair() {
  return generateKeyPairSync("ed25519");
}

const A = { collectorId: "alice-close-a", ...keyPair() };
const B = { collectorId: "alice-close-b", ...keyPair() };
const C = { collectorId: "alice-close-c", ...keyPair() };

function emptyPendingChannels() {
  return {
    total_limbo_balance: "0",
    pending_open_channels: [],
    pending_closing_channels: [],
    pending_force_closing_channels: [],
    waiting_close_channels: [],
  };
}

function evidence(overrides = {}) {
  return evaluateLightningCloseRecovery({
    pendingChannels: emptyPendingChannels(),
    pendingSweeps: { pending_sweeps: [] },
    blockHeight: 263,
    observedAt: NOW,
    ...overrides,
  });
}

function attestation(collector, closeEvidence = evidence()) {
  return signLightningCloseCollectorAttestation({
    collectorId: collector.collectorId,
    nodeCommitment: NODE_COMMITMENT,
    evidence: closeEvidence,
    expiresAt: NOW + 30,
  }, collector.privateKey);
}

function collectors(overrides = {}) {
  return [
    { collectorId: A.collectorId, publicKey: A.publicKey },
    { collectorId: B.collectorId, publicKey: B.publicKey },
  ].map((entry, index) => ({ ...entry, ...(overrides[index] ?? {}) }));
}

function quorum(attestations, overrides = {}) {
  return evaluateLightningCloseCollectorQuorum({
    attestations,
    collectors: collectors(),
    expectedNodeCommitment: NODE_COMMITMENT,
    now: NOW + 5,
    maximumLifetimeSeconds: 30,
    maximumClockSkewSeconds: 5,
    ...overrides,
  });
}

test("signs and verifies one short-lived aggregate-only Ed25519 attestation", () => {
  const signed = attestation(A);
  assert.throws(() => signLightningCloseCollectorAttestation({
    collectorId: A.collectorId,
    nodeCommitment: NODE_COMMITMENT,
    evidence: { ...evidence() },
    expiresAt: NOW + 30,
  }, A.privateKey), /must come from the evaluator/);
  const verified = verifyLightningCloseCollectorAttestation({
    attestation: signed,
    publicKey: A.publicKey,
    expectedCollectorId: A.collectorId,
    expectedNodeCommitment: NODE_COMMITMENT,
    now: NOW + 5,
    maximumLifetimeSeconds: 30,
    maximumClockSkewSeconds: 5,
  });
  assert.equal(verified.status, "healthy");
  assert.match(verified.signature, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.match(verified.attestationDigest, /^0x[0-9a-f]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(verified),
    /(channel.?point|outpoint|txid|node.?pub|invoice|macaroon|preimage|private.?key)/i,
  );
});

test("rejects body, signature, identity, node, lifetime, and expired replay mutations", () => {
  const signed = attestation(A);
  const verify = (candidate, options = {}) => verifyLightningCloseCollectorAttestation({
    attestation: candidate,
    publicKey: A.publicKey,
    expectedCollectorId: A.collectorId,
    expectedNodeCommitment: NODE_COMMITMENT,
    now: NOW + 5,
    maximumLifetimeSeconds: 30,
    maximumClockSkewSeconds: 5,
    ...options,
  });
  assert.throws(() => verify({ ...signed, evidenceDigest: id("tampered").toLowerCase() }), /verification failed/);
  assert.throws(() => verify({ ...signed, signature: signed.signature.slice(1) }), /signature is invalid/);
  assert.throws(() => verify({ ...signed, collectorId: B.collectorId }), /identity mismatch/);
  assert.throws(() => verify({ ...signed, nodeCommitment: id("other-node").toLowerCase() }), /node commitment mismatch/);
  assert.throws(() => verify({ ...signed, expiresAt: NOW + 31 }), /lifetime is invalid/);
  assert.throws(() => verify(signed, { now: NOW + 31 }), /expired/);
  assert.throws(() => verify(signed, { publicKey: B.publicKey }), /verification failed/);
});

test("requires exactly two distinct healthy collectors and exposes only digests", () => {
  const result = quorum([attestation(A), attestation(B)]);
  assert.equal(result.status, "healthy");
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.collectors.length, 2);
  assert.deepEqual(result.observation, {
    kind: "lightning-node",
    status: "healthy",
    observedAt: NOW,
    evidenceDigest: result.observation.evidenceDigest,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /(signature|channel.?point|outpoint|txid|node.?pub|invoice|macaroon|preimage|private.?key)/i,
  );
});

test("fails closed on unsafe, missing, duplicate, unknown, stale, wrong-node, and reused-key reports", () => {
  const unsafeChannels = emptyPendingChannels();
  unsafeChannels.total_limbo_balance = "1";
  const unsafeEvidence = evidence({ pendingChannels: unsafeChannels });
  const unsafe = quorum([attestation(A, unsafeEvidence), attestation(B)]);
  assert.equal(unsafe.status, "unsafe");
  assert.ok(unsafe.reasonCodes.includes("COLLECTOR_REPORTED_UNSAFE"));

  for (const candidate of [
    [attestation(A)],
    [attestation(A), attestation(A)],
    [attestation(A), attestation(C)],
  ]) {
    const result = quorum(candidate);
    assert.equal(result.status, "unsafe");
    assert.ok(result.reasonCodes.includes("COLLECTOR_QUORUM_INVALID"));
  }

  const stale = quorum([attestation(A), attestation(B)], { now: NOW + 31 });
  assert.equal(stale.status, "unsafe");
  assert.ok(stale.reasonCodes.includes("COLLECTOR_QUORUM_INVALID"));

  const wrongNode = quorum([
    { ...attestation(A), nodeCommitment: id("wrong-node").toLowerCase() },
    attestation(B),
  ]);
  assert.equal(wrongNode.status, "unsafe");

  const keyReuse = quorum([attestation(A), attestation(B)], {
    collectors: collectors({ 1: { publicKey: A.publicKey } }),
  });
  assert.equal(keyReuse.status, "unsafe");
  assert.ok(keyReuse.reasonCodes.includes("COLLECTOR_CONFIGURATION_INVALID"));
  assert.ok(keyReuse.reasonCodes.includes("COLLECTOR_QUORUM_INVALID"));
});

test("the signed quorum drives the existing Lightning safety halt domain", () => {
  const healthy = quorum([attestation(A), attestation(B)]);
  const observations = REQUIRED_SAFETY_CHECKS.map((kind) => kind === "lightning-node"
    ? healthy.observation
    : { kind, status: "healthy", observedAt: NOW, evidenceDigest: id(`collector:${kind}`).toLowerCase() });
  const result = evaluateSafetyMonitor({ observations, now: NOW + 5, maximumObservationAgeSeconds: 15 });
  assert.equal(result.healthy, true);

  const missing = quorum([attestation(A)]);
  const halted = evaluateSafetyMonitor({
    observations: observations.map((entry) => entry.kind === "lightning-node" ? missing.observation : entry),
    now: NOW + 5,
    maximumObservationAgeSeconds: 15,
  });
  assert.equal(halted.healthy, false);
  assert.ok(halted.reasonCodes.includes("LIGHTNING_NODE_UNSAFE"));
});

test("one-shot runtime signs healthy data and converts transport failure to secret-free unsafe data", async () => {
  const calls = [];
  const healthyLnd = {
    getInfo: async (timeout) => { calls.push(["getInfo", timeout]); return { block_height: "263" }; },
    pendingChannels: async (timeout) => { calls.push(["pendingChannels", timeout]); return emptyPendingChannels(); },
    pendingSweeps: async (timeout) => { calls.push(["pendingSweeps", timeout]); return { pending_sweeps: [] }; },
  };
  const healthy = await collectLightningCloseAttestation({
    lnd: healthyLnd,
    collectorId: A.collectorId,
    nodeCommitment: NODE_COMMITMENT,
    signingKey: A.privateKey,
    attestationLifetimeSeconds: 30,
    requestTimeoutMs: 5_000,
    nowSeconds: () => NOW,
  });
  assert.equal(healthy.status, "healthy");
  assert.deepEqual(calls.sort(), [
    ["getInfo", 5_000],
    ["pendingChannels", 5_000],
    ["pendingSweeps", 5_000],
  ]);

  const remoteSecret = "lnbcrt-private-channel-point-macaroon";
  const failed = await collectLightningCloseAttestation({
    lnd: {
      getInfo: async () => { throw new Error(remoteSecret); },
      pendingChannels: async () => emptyPendingChannels(),
      pendingSweeps: async () => ({ pending_sweeps: [] }),
    },
    collectorId: A.collectorId,
    nodeCommitment: NODE_COMMITMENT,
    signingKey: A.privateKey,
    attestationLifetimeSeconds: 30,
    requestTimeoutMs: 5_000,
    nowSeconds: () => NOW,
  });
  assert.equal(failed.status, "unsafe");
  assert.deepEqual(failed.reasonCodes, ["PENDING_CHANNEL_RESPONSE_INVALID", "PENDING_SWEEP_RESPONSE_INVALID"]);
  assert.equal(JSON.stringify(failed).includes(remoteSecret), false);
});
