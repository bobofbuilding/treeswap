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
    actionPlan: safety.bindActions({
      closeQuotes: async () => { calls += 1; return { closed: true }; },
      guardianActions: safety.guardianBroadcasters.map(() => async () => {
        calls += 1;
        return { halted: false, reasonDigest: id("unused").toLowerCase(), transactionHash: id("unused").toLowerCase() };
      }),
      alertActions: safety.alertRoutes.map(() => async () => { calls += 1; return { delivered: true }; }),
    }),
    nowSeconds: () => NOW,
  });
  assert.equal(result.outcome, "HEALTHY");
  assert.equal(calls, 0);
  assert.equal(result.guardianBroadcastsAttempted, 0);
  assert.equal(result.alertRoutesAttempted, 0);
});

test("unsafe monitoring closes quotes, uses both guardian broadcasters, then uses both secret-free alert routes", async () => {
  const order = [];
  let quoteClosed = false;
  let gateHalted = false;
  const guardianActions = safety.guardianBroadcasters.map((route) => async (alert) => {
    order.push(`gate:${route.routeId}`);
    assert.equal(quoteClosed, true);
    gateHalted = true;
    return { halted: true, reasonDigest: alert.alertDigest, transactionHash: route.routeId };
  });
  const alertActions = safety.alertRoutes.map((route) => async (alert) => {
    order.push(`alert:${route.routeId}`);
    assert.equal(quoteClosed && gateHalted, true);
    assert.equal(JSON.stringify(alert).includes("invoice"), false);
    return { delivered: true };
  });
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations({ "evm-provider-quorum": { status: "unsafe" } }),
    actionPlan: safety.bindActions({
      closeQuotes: async (alert) => {
        order.push("quotes");
        assert.match(alert.alertDigest, /^0x[0-9a-f]{64}$/);
        quoteClosed = true;
        return { closed: true };
      },
      guardianActions,
      alertActions,
    }),
    nowSeconds: () => NOW,
  });
  assert.equal(result.outcome, "HALTED_AND_ALERTED");
  assert.equal(result.newExposureClosed, true);
  assert.equal(result.guardianBroadcastsSucceeded, 2);
  assert.equal(result.guardianBroadcastDegraded, false);
  assert.equal(result.alertRoutesDelivered, 2);
  assert.equal(result.alertDeliveryDegraded, false);
  assert.deepEqual(order, [
    "quotes",
    ...safety.guardianBroadcasters.map((route) => `gate:${route.routeId}`),
    ...safety.alertRoutes.map((route) => `alert:${route.routeId}`),
  ]);
});

test("closure or alert transport failures remain explicit and never become healthy", async () => {
  const unsafe = await safety.observations({ "audit-pipeline": { status: "unsafe" } });
  const incomplete = await runSafetyMonitorCycle({
    observations: unsafe,
    actionPlan: safety.bindActions({
      closeQuotes: async () => { throw new Error("offline"); },
      alertActions: safety.alertRoutes.map(() => async () => ({ delivered: false })),
    }),
    nowSeconds: () => NOW,
  });
  assert.equal(incomplete.outcome, "HALT_INCOMPLETE");
  assert.equal(incomplete.onchainGateHalted, true);
  assert.equal(incomplete.newExposureClosed, false);
  assert.equal(incomplete.guardianBroadcastsSucceeded, 2);

  const alertFailure = await runSafetyMonitorCycle({
    observations: unsafe,
    actionPlan: safety.bindActions({
      alertActions: safety.alertRoutes.map(() => async () => { throw new Error("paging offline"); }),
    }),
    nowSeconds: () => NOW,
  });
  assert.equal(alertFailure.outcome, "HALTED_ALERT_UNDELIVERED");
  assert.equal(alertFailure.newExposureClosed, true);
  assert.equal(alertFailure.alertDelivered, false);
  assert.equal(alertFailure.alertRoutesDelivered, 0);
  assert.equal(alertFailure.alertDeliveryDegraded, true);
});

test("one guardian-broadcast outage and one alert-route outage are tolerated but explicit", async () => {
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations({ "bit-contract": { status: "unsafe" } }),
    actionPlan: safety.bindActions({
      guardianActions: [
        async () => { throw new Error("broadcaster offline"); },
        async (alert) => ({
          halted: true,
          reasonDigest: alert.alertDigest,
          transactionHash: id("surviving-guardian-broadcast").toLowerCase(),
        }),
      ],
      alertActions: [
        async () => ({ delivered: false }),
        async () => ({ delivered: true }),
      ],
    }),
    nowSeconds: () => NOW,
  });
  assert.equal(result.outcome, "HALTED_AND_ALERTED");
  assert.equal(result.newExposureClosed, true);
  assert.equal(result.guardianBroadcastsAttempted, 2);
  assert.equal(result.guardianBroadcastsSucceeded, 1);
  assert.equal(result.guardianBroadcastDegraded, true);
  assert.equal(result.alertRoutesAttempted, 2);
  assert.equal(result.alertRoutesDelivered, 1);
  assert.equal(result.alertDeliveryDegraded, true);
});

test("all guardian-broadcast failures keep the halt incomplete even when quotes and paging close", async () => {
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations({ "price-quorum": { status: "unsafe" } }),
    actionPlan: safety.bindActions({
      guardianActions: safety.guardianBroadcasters.map(() => async () => { throw new Error("offline"); }),
    }),
    nowSeconds: () => NOW,
  });
  assert.equal(result.outcome, "HALT_INCOMPLETE");
  assert.equal(result.quoteIssuanceClosed, true);
  assert.equal(result.onchainGateHalted, false);
  assert.equal(result.guardianBroadcastsSucceeded, 0);
  assert.equal(result.alertRoutesDelivered, 2);
  assert.equal(result.newExposureClosed, false);
});

test("noncanonical or secret-bearing action results are rejected and never copied into output", async () => {
  const secret = "lnbc-private-result";
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations({ "audit-pipeline": { status: "unsafe" } }),
    actionPlan: safety.bindActions({
      closeQuotes: async () => ({ closed: true, remote: secret }),
      guardianActions: [
        async (alert) => ({
          halted: true,
          reasonDigest: alert.alertDigest,
          transactionHash: id("extra-field-halt").toLowerCase(),
          invoice: secret,
        }),
        async (alert) => ({
          halted: true,
          reasonDigest: alert.alertDigest,
          transactionHash: id("uppercase-halt").toUpperCase(),
        }),
      ],
      alertActions: safety.alertRoutes.map(() => async () => ({ delivered: true, remote: secret })),
    }),
    nowSeconds: () => NOW,
  });
  assert.equal(result.outcome, "HALT_INCOMPLETE");
  assert.equal(result.quoteIssuanceClosed, false);
  assert.equal(result.guardianBroadcastsSucceeded, 0);
  assert.equal(result.alertRoutesDelivered, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("hostile action-result objects cannot escape fail-closed validation", async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations({ "audit-pipeline": { status: "unsafe" } }),
    actionPlan: safety.bindActions({
      closeQuotes: async () => revoked.proxy,
      guardianActions: safety.guardianBroadcasters.map(() => async () => revoked.proxy),
      alertActions: safety.alertRoutes.map(() => async () => revoked.proxy),
    }),
    nowSeconds: () => NOW,
  });
  assert.equal(result.outcome, "HALT_INCOMPLETE");
  assert.equal(result.quoteIssuanceClosed, false);
  assert.equal(result.guardianBroadcastsSucceeded, 0);
  assert.equal(result.alertRoutesDelivered, 0);
});

test("copied or missing action-plan provenance executes no caller-supplied route", async () => {
  let calls = 0;
  const original = safety.bindActions({
    closeQuotes: async () => { calls += 1; return { closed: true }; },
  });
  for (const actionPlan of [undefined, { ...original }]) {
    const result = await runSafetyMonitorCycle({
      observations: await safety.observations(),
      actionPlan,
      nowSeconds: () => NOW,
    });
    assert.equal(result.outcome, "HALT_INCOMPLETE");
    assert.deepEqual(result.reasonCodes, ["MONITOR_ACTION_PLAN_INVALID"]);
    assert.equal(result.newExposureClosed, false);
  }
  assert.equal(calls, 0);
});

test("monitor clock or configuration failure still attempts both closures with a fixed alert", async () => {
  let closures = 0;
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations(),
    actionPlan: safety.bindActions({
      closeQuotes: async () => {
        closures += 1;
        return { closed: true };
      },
      guardianActions: safety.guardianBroadcasters.map((route) => async (alert) => {
        closures += 1;
        return { halted: true, reasonDigest: alert.alertDigest, transactionHash: route.routeId };
      }),
    }),
    actionTimeoutMs: 0,
    nowSeconds: () => { throw new Error("clock failed"); },
  });
  assert.equal(result.outcome, "HALTED_AND_ALERTED");
  assert.deepEqual(result.reasonCodes, ["MONITOR_INPUT_INVALID"]);
  assert.equal(closures, 3);
});

test("an action plan cannot outlive its signed monitor policy", async () => {
  let calls = 0;
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations(),
    actionPlan: safety.bindActions({
      closeQuotes: async () => { calls += 1; return { closed: true }; },
      guardianActions: safety.guardianBroadcasters.map((route) => async (alert) => {
        calls += 1;
        return { halted: true, reasonDigest: alert.alertDigest, transactionHash: route.routeId };
      }),
      alertActions: safety.alertRoutes.map(() => async () => { calls += 1; return { delivered: true }; }),
    }),
    nowSeconds: () => safety.policy.validUntil,
  });
  assert.equal(result.outcome, "HALTED_AND_ALERTED");
  assert.ok(result.reasonCodes.includes("MONITOR_POLICY_INACTIVE"));
  assert.equal(calls, 5);
});

test("a hung quote shutdown is bounded so the guardian halt and alert still run", async () => {
  let signalAborted = false;
  let haltCalled = false;
  let alertCalled = false;
  const result = await runSafetyMonitorCycle({
    observations: await safety.observations({ "lightning-node": { status: "unsafe" } }),
    actionPlan: safety.bindActions({
      closeQuotes: async (_alert, { signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          signalAborted = true;
          resolve({ closed: false });
        }, { once: true });
      }),
      guardianActions: safety.guardianBroadcasters.map((route) => async (alert) => {
        haltCalled = true;
        return { halted: true, reasonDigest: alert.alertDigest, transactionHash: route.routeId };
      }),
      alertActions: safety.alertRoutes.map(() => async () => {
        alertCalled = true;
        return { delivered: true };
      }),
    }),
    actionTimeoutMs: 5,
    nowSeconds: () => NOW,
  });
  assert.equal(signalAborted, true);
  assert.equal(haltCalled, true);
  assert.equal(alertCalled, true);
  assert.equal(result.outcome, "HALT_INCOMPLETE");
  assert.equal(result.onchainGateHalted, true);
});
