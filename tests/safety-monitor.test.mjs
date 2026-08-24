import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import {
  evaluateSafetyMonitor,
  runSafetyMonitorCycle,
} from "../lib/safety-monitor.mjs";
import { createSignedSafetyObservationFixture } from "./fixtures/signed-safety-observations.mjs";

const NOW = 2_100_000_000;
const safety = createSignedSafetyObservationFixture({ now: NOW });

test("accepts only two signed, release-policy-bound operator observations from every required safety domain", async () => {
  const result = evaluateSafetyMonitor({
    observations: await safety.observations(),
    now: NOW,
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
  });
  assert.equal(result.healthy, true);
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.monitorPolicyDigest, safety.policyDigest);
  assert.match(result.evidenceSetDigest, /^0x[0-9a-f]{64}$/);
  assert.match(result.alertDigest, /^0x[0-9a-f]{64}$/);
});

test("outage, stale, future, duplicate, unsafe, or unverified observations fail closed", async () => {
  const unsafe = await safety.observations({
    "bit-contract": { status: "unsafe" },
    "price-quorum": { observedAt: NOW - 100 },
    "lightning-node": { observedAt: NOW + 1 },
  });
  unsafe.pop();
  unsafe.push(unsafe[0]);
  unsafe.push({
    kind: "audit-pipeline",
    status: "healthy",
    observedAt: NOW,
    evidenceDigest: id("malformed").toLowerCase(),
    privateKey: "must-not-enter-the-alert",
  });
  const result = evaluateSafetyMonitor({
    observations: unsafe,
    now: NOW,
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
  });
  assert.equal(result.healthy, false);
  assert.ok(result.reasonCodes.includes("BIT_CONTRACT_UNSAFE"));
  assert.ok(result.reasonCodes.includes("PRICE_QUORUM_STALE"));
  assert.ok(result.reasonCodes.includes("PRICE_QUORUM_EXPIRED"));
  assert.ok(result.reasonCodes.includes("LIGHTNING_NODE_FUTURE"));
  assert.ok(result.reasonCodes.includes("SOLVER_CAPACITY_COLLECTOR_OUTAGE"));
  assert.ok(result.reasonCodes.includes("ASSET_RECONCILIATION_COLLECTOR_DUPLICATE"));
  assert.ok(result.reasonCodes.includes("MONITOR_INPUT_INVALID"));
  assert.equal(JSON.stringify(result).includes("must-not-enter-the-alert"), false);
  assert.equal(JSON.stringify(result).includes("privateKey"), false);
});

test("one collector outage or cross-operator disagreement cannot produce a healthy cycle", async () => {
  const priceCollectors = safety.collectors.filter((collector) => collector.kind === "price-quorum");
  assert.equal(priceCollectors.length, 2);

  const missingOne = (await safety.observations())
    .filter((observation) => observation.collectorId !== priceCollectors[1].collectorId);
  const outage = evaluateSafetyMonitor({
    observations: missingOne,
    now: NOW,
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
  });
  assert.equal(outage.healthy, false);
  assert.ok(outage.reasonCodes.includes("PRICE_QUORUM_COLLECTOR_OUTAGE"));

  const missingBoth = evaluateSafetyMonitor({
    observations: (await safety.observations()).filter((observation) => observation.kind !== "price-quorum"),
    now: NOW,
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
  });
  assert.equal(missingBoth.healthy, false);
  assert.ok(missingBoth.reasonCodes.includes("PRICE_QUORUM_MISSING"));
  assert.ok(missingBoth.reasonCodes.includes("PRICE_QUORUM_COLLECTOR_OUTAGE"));

  const disagreement = evaluateSafetyMonitor({
    observations: await safety.observations({
      [priceCollectors[1].collectorId]: { status: "unsafe" },
    }),
    now: NOW,
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
  });
  assert.equal(disagreement.healthy, false);
  assert.ok(disagreement.reasonCodes.includes("PRICE_QUORUM_DISAGREEMENT"));
  assert.ok(disagreement.reasonCodes.includes("PRICE_QUORUM_UNSAFE"));
});

test("collector delivery order cannot change the canonical evidence digest", async () => {
  const observations = await safety.observations();
  const evaluate = (candidate) => evaluateSafetyMonitor({
    observations: candidate,
    now: NOW,
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
  });
  assert.equal(evaluate(observations).evidenceSetDigest, evaluate([...observations].reverse()).evidenceSetDigest);
});

test("healthy monitoring has no authority to open or mutate either exposure gate", async () => {
  let calls = 0;
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations(),
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
    nowSeconds: () => NOW,
    closeQuoteIssuance: async () => { calls += 1; },
    haltOnchainGate: async () => { calls += 1; },
    deliverAlert: async () => { calls += 1; },
  });
  assert.equal(result.outcome, "HEALTHY");
  assert.equal(calls, 0);
});

test("unsafe monitoring closes quotes, halts onchain exposure, then emits one secret-free alert", async () => {
  const order = [];
  let quoteClosed = false;
  let gateHalted = false;
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations({ "evm-provider-quorum": { status: "unsafe" } }),
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
    nowSeconds: () => NOW,
    closeQuoteIssuance: async (alert) => {
      order.push("quotes");
      assert.match(alert.alertDigest, /^0x[0-9a-f]{64}$/);
      quoteClosed = true;
      return { closed: true };
    },
    haltOnchainGate: async (alert) => {
      order.push("gate");
      assert.equal(quoteClosed, true);
      gateHalted = true;
      return { halted: true, reasonDigest: alert.alertDigest, transactionHash: id("halt-tx").toLowerCase() };
    },
    deliverAlert: async (alert) => {
      order.push("alert");
      assert.equal(quoteClosed && gateHalted, true);
      assert.equal(JSON.stringify(alert).includes("invoice"), false);
      return { delivered: true };
    },
  });
  assert.equal(result.outcome, "HALTED_AND_ALERTED");
  assert.equal(result.newExposureClosed, true);
  assert.deepEqual(order, ["quotes", "gate", "alert"]);
});

test("closure or alert transport failures remain explicit and never become healthy", async () => {
  const unsafe = await safety.observations({ "audit-pipeline": { status: "unsafe" } });
  const incomplete = await runSafetyMonitorCycle({
    observations: unsafe,
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
    nowSeconds: () => NOW,
    closeQuoteIssuance: async () => { throw new Error("offline"); },
    haltOnchainGate: async (alert) => ({
      halted: true,
      reasonDigest: alert.alertDigest,
      transactionHash: id("halted-despite-quote-failure").toLowerCase(),
    }),
    deliverAlert: async () => ({ delivered: false }),
  });
  assert.equal(incomplete.outcome, "HALT_INCOMPLETE");
  assert.equal(incomplete.onchainGateHalted, true);
  assert.equal(incomplete.newExposureClosed, false);

  const alertFailure = await runSafetyMonitorCycle({
    observations: unsafe,
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
    nowSeconds: () => NOW,
    closeQuoteIssuance: async () => ({ closed: true }),
    haltOnchainGate: async (alert) => ({
      halted: true,
      reasonDigest: alert.alertDigest,
      transactionHash: id("halted-alert-failure").toLowerCase(),
    }),
    deliverAlert: async () => { throw new Error("paging offline"); },
  });
  assert.equal(alertFailure.outcome, "HALTED_ALERT_UNDELIVERED");
  assert.equal(alertFailure.newExposureClosed, true);
  assert.equal(alertFailure.alertDelivered, false);
});

test("monitor clock or configuration failure still attempts both closures with a fixed alert", async () => {
  let closures = 0;
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations(),
    maximumObservationAgeSeconds: 0,
    expectedSafetyPolicyDigest: safety.policyDigest,
    actionTimeoutMs: 0,
    nowSeconds: () => { throw new Error("clock failed"); },
    closeQuoteIssuance: async () => {
      closures += 1;
      return { closed: true };
    },
    haltOnchainGate: async (alert) => {
      closures += 1;
      return {
        halted: true,
        reasonDigest: alert.alertDigest,
        transactionHash: id("monitor-input-failure-halt").toLowerCase(),
      };
    },
    deliverAlert: async () => ({ delivered: true }),
  });
  assert.equal(result.outcome, "HALTED_AND_ALERTED");
  assert.deepEqual(result.reasonCodes, ["MONITOR_INPUT_INVALID"]);
  assert.equal(closures, 2);
});

test("a hung quote shutdown is bounded so the guardian halt and alert still run", async () => {
  let signalAborted = false;
  let haltCalled = false;
  let alertCalled = false;
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations({ "lightning-node": { status: "unsafe" } }),
    maximumObservationAgeSeconds: 15,
    expectedSafetyPolicyDigest: safety.policyDigest,
    actionTimeoutMs: 5,
    nowSeconds: () => NOW,
    closeQuoteIssuance: async (_alert, { signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        signalAborted = true;
        resolve({ closed: false });
      }, { once: true });
    }),
    haltOnchainGate: async (alert) => {
      haltCalled = true;
      return {
        halted: true,
        reasonDigest: alert.alertDigest,
        transactionHash: id("hung-quote-halt").toLowerCase(),
      };
    },
    deliverAlert: async () => {
      alertCalled = true;
      return { delivered: true };
    },
  });
  assert.equal(signalAborted, true);
  assert.equal(haltCalled, true);
  assert.equal(alertCalled, true);
  assert.equal(result.outcome, "HALT_INCOMPLETE");
  assert.equal(result.onchainGateHalted, true);
});
