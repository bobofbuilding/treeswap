import assert from "node:assert/strict";
import test from "node:test";
import { id, keccak256, toUtf8Bytes } from "ethers";
import { compareDeploymentObservations } from "../lib/deployment-observer.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function manifestDigest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function observation(providerLabel, providerIdentity) {
  const manifest = {
    chainId: 31_337,
    gate: { defaultClosed: true },
    paymentHashRegistry: { sealed: true },
  };
  return {
    schema: "treeswap.deployment-observation.v1",
    evidenceStatus: "unreviewed-rpc-observation",
    observedAt: "2026-08-20T09:00:00.000Z",
    providerLabel,
    providerIdentity,
    sourceCommit: "a".repeat(40),
    chainId: 31_337,
    providerFinalizedHead: { number: 40, hash: id("head").toLowerCase() },
    finalizedBlock: { number: 39, hash: id("deployment-block").toLowerCase() },
    stateAnchor: { blockHash: id("deployment-block").toLowerCase(), requireCanonical: true },
    manifest,
    manifestDigest: manifestDigest(manifest),
  };
}

test("accepts two distinct provider observations of one exact finalized manifest", () => {
  const first = observation("provider-a", id("provider-a").toLowerCase());
  const second = observation("provider-b", id("provider-b").toLowerCase());
  assert.deepEqual(compareDeploymentObservations(first, second), { eligible: true, reasons: [] });
});

test("rejects provider identity reuse and any manifest disagreement", () => {
  const first = observation("provider-a", id("provider-a").toLowerCase());
  const second = structuredClone(first);
  second.providerLabel = "provider-b";
  second.manifest.gate.defaultClosed = false;
  second.manifestDigest = manifestDigest(second.manifest);
  const result = compareDeploymentObservations(first, second);
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join("; "), /distinct identities|manifestDigest differs|manifests differ/);
});

test("rejects an unfinalized, noncanonical, or self-inconsistent observation", () => {
  const first = observation("provider-a", id("provider-a").toLowerCase());
  const second = observation("provider-b", id("provider-b").toLowerCase());
  second.providerFinalizedHead.number = 38;
  second.stateAnchor.requireCanonical = false;
  second.manifestDigest = id("forged manifest digest").toLowerCase();
  const result = compareDeploymentObservations(first, second);
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join("; "), /not canonically anchored|did not prove|digest is invalid/);
});
