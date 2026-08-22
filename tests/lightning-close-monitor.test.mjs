import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import {
  DEFAULT_LIGHTNING_CLOSE_POLICY,
  evaluateLightningCloseRecovery,
  lightningCloseSafetyObservation,
} from "../lib/lightning-close-monitor.mjs";
import { evaluateSafetyMonitor, REQUIRED_SAFETY_CHECKS } from "../lib/safety-monitor.mjs";

const NOW = 2_100_000_000;
const HEIGHT = 263;

function emptyPendingChannels() {
  return {
    total_limbo_balance: "0",
    pending_open_channels: [],
    pending_closing_channels: [],
    pending_force_closing_channels: [],
    waiting_close_channels: [],
  };
}

function anchor(overrides = {}) {
  return {
    outpoint: { txid_str: "a".repeat(64), output_index: 1 },
    witness_type: "COMMITMENT_ANCHOR",
    amount_sat: 330,
    sat_per_vbyte: 0,
    broadcast_attempts: 153,
    requested_sat_per_vbyte: 0,
    immediate: false,
    budget: 330,
    deadline_height: 1_117,
    maturity_height: 110,
    next_broadcast_height: 0,
    requested_conf_target: 0,
    force: false,
    ...overrides,
  };
}

function evaluate(overrides = {}) {
  return evaluateLightningCloseRecovery({
    pendingChannels: emptyPendingChannels(),
    pendingSweeps: { pending_sweeps: [] },
    blockHeight: HEIGHT,
    observedAt: NOW,
    ...overrides,
  });
}

test("emits one branded healthy aggregate without channel or transaction identifiers", () => {
  const evidence = evaluate();
  assert.equal(evidence.status, "healthy");
  assert.deepEqual(evidence.reasonCodes, []);
  assert.equal(evidence.pendingSweeps, 0);
  assert.match(evidence.evidenceDigest, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(lightningCloseSafetyObservation(evidence), {
    kind: "lightning-node",
    status: "healthy",
    observedAt: NOW,
    evidenceDigest: evidence.evidenceDigest,
  });
  assert.throws(() => lightningCloseSafetyObservation({ ...evidence }), /must come from the evaluator/);
  assert.doesNotMatch(JSON.stringify(evidence), /(outpoint|txid|channel.?point|node.?pub|invoice|macaroon|preimage)/i);
});

test("accepts only narrowly bounded matured 330-sat commitment anchors", () => {
  const first = evaluate({ pendingSweeps: { pending_sweeps: [anchor()] } });
  const second = evaluate({
    pendingSweeps: { pending_sweeps: [anchor({ outpoint: { txid_str: "b".repeat(64), output_index: 0 } })] },
  });
  assert.equal(first.status, "healthy");
  assert.equal(first.uneconomicAnchorSweeps, 1);
  assert.equal(first.uneconomicAnchorSats, "330");
  assert.equal(first.oldestUneconomicAnchorAgeBlocks, 153);
  assert.equal(first.soonestUneconomicAnchorDeadlineBlocks, 854);
  assert.equal(first.evidenceDigest, second.evidenceDigest);
  assert.equal(JSON.stringify(first).includes("a".repeat(64)), false);
});

test("a pending force close or HTLC fails closed with aggregate-only evidence", () => {
  const pendingChannels = emptyPendingChannels();
  pendingChannels.total_limbo_balance = "10000";
  pendingChannels.pending_force_closing_channels = [{
    channel: { channel_point: `${"c".repeat(64)}:0` },
    pending_htlcs: [{ amount: "10000", outpoint: `${"d".repeat(64)}:1` }],
  }];
  const evidence = evaluate({ pendingChannels });
  assert.equal(evidence.status, "unsafe");
  assert.equal(evidence.pendingForceCloseChannels, 1);
  assert.equal(evidence.pendingHtlcs, 1);
  assert.equal(evidence.pendingHtlcSats, "10000");
  assert.ok(evidence.reasonCodes.includes("PENDING_FORCE_CLOSE"));
  assert.ok(evidence.reasonCodes.includes("TIME_SENSITIVE_PENDING_HTLC"));
  assert.ok(evidence.reasonCodes.includes("NONZERO_LIMBO_BALANCE"));
  assert.equal(JSON.stringify(evidence).includes("c".repeat(64)), false);
  assert.equal(JSON.stringify(evidence).includes("d".repeat(64)), false);
});

test("a nonzero limbo aggregate fails closed even when LND returns no close entry", () => {
  const pendingChannels = emptyPendingChannels();
  pendingChannels.total_limbo_balance = "1";
  const evidence = evaluate({ pendingChannels });
  assert.equal(evidence.status, "unsafe");
  assert.deepEqual(evidence.reasonCodes, ["NONZERO_LIMBO_BALANCE"]);
});

test("HTLC and overdue non-anchor sweeps are always unsafe", () => {
  const evidence = evaluate({
    pendingSweeps: {
      pending_sweeps: [
        anchor({ witness_type: "HTLC_ACCEPTED_SUCCESS_SECOND_LEVEL", amount_sat: 10_000 }),
        anchor({ witness_type: "COMMITMENT_TIME_LOCK", amount_sat: 500_000, maturity_height: HEIGHT - 1 }),
      ],
    },
  });
  assert.equal(evidence.status, "unsafe");
  assert.equal(evidence.timeSensitiveHtlcSweeps, 1);
  assert.equal(evidence.nonAnchorSweeps, 1);
  assert.ok(evidence.reasonCodes.includes("TIME_SENSITIVE_HTLC_SWEEP"));
  assert.ok(evidence.reasonCodes.includes("PENDING_NON_ANCHOR_SWEEP"));
  assert.ok(evidence.reasonCodes.includes("OVERDUE_NON_ANCHOR_SWEEP"));
});

test("amount, budget, maturity, urgency, age, retries, deadline, count, and total caps bound the anchor exception", () => {
  const invalid = evaluate({
    pendingSweeps: {
      pending_sweeps: [anchor({
        amount_sat: 331,
        budget: 500,
        immediate: true,
        force: true,
        maturity_height: 0,
        deadline_height: HEIGHT,
        broadcast_attempts: DEFAULT_LIGHTNING_CLOSE_POLICY.maximumUneconomicAnchorBroadcastAttempts + 1,
      })],
    },
  });
  assert.equal(invalid.status, "unsafe");
  assert.ok(invalid.reasonCodes.includes("UNECONOMIC_ANCHOR_EXCEPTION_INVALID"));
  assert.ok(invalid.reasonCodes.includes("UNECONOMIC_ANCHOR_RETRY_LIMIT_EXCEEDED"));
  assert.ok(invalid.reasonCodes.includes("UNECONOMIC_ANCHOR_DEADLINE_TOO_CLOSE"));

  const aged = evaluate({
    blockHeight: 2_000,
    pendingSweeps: { pending_sweeps: [anchor({ maturity_height: 1, deadline_height: 3_000 })] },
  });
  assert.ok(aged.reasonCodes.includes("UNECONOMIC_ANCHOR_AGE_EXCEEDED"));

  const tooMany = evaluate({
    pendingSweeps: {
      pending_sweeps: Array.from({ length: 5 }, (_, index) => anchor({
        outpoint: { txid_str: String(index).padStart(64, "0"), output_index: 0 },
      })),
    },
  });
  assert.ok(tooMany.reasonCodes.includes("UNECONOMIC_ANCHOR_AGGREGATE_LIMIT_EXCEEDED"));
});

test("malformed LND responses and policy mutation fail closed without retaining raw input", () => {
  const pendingChannels = { ...emptyPendingChannels(), secretInvoice: "lnbcrt-sensitive" };
  const malformed = evaluate({
    pendingChannels,
    pendingSweeps: { pending_sweeps: [{ privateKey: "must-not-leak" }] },
  });
  assert.equal(malformed.status, "unsafe");
  assert.ok(malformed.reasonCodes.includes("PENDING_CHANNEL_RESPONSE_INVALID"));
  assert.ok(malformed.reasonCodes.includes("PENDING_SWEEP_RESPONSE_INVALID"));
  assert.equal(JSON.stringify(malformed).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(malformed).includes("lnbcrt-sensitive"), false);

  const invalidPolicy = evaluate({ policy: { ...DEFAULT_LIGHTNING_CLOSE_POLICY, extra: 1 } });
  assert.equal(invalidPolicy.status, "unsafe");
  assert.deepEqual(invalidPolicy.reasonCodes, ["LIGHTNING_CLOSE_POLICY_INVALID"]);
  assert.equal(invalidPolicy.policyDigest, `0x${"00".repeat(32)}`);
});

test("the aggregate drives the existing lightning-node halt domain", () => {
  const unsafe = evaluate({ pendingSweeps: { pending_sweeps: [anchor({ witness_type: "COMMITMENT_TIME_LOCK" })] } });
  const lightning = lightningCloseSafetyObservation(unsafe);
  const observations = REQUIRED_SAFETY_CHECKS.map((kind) => kind === "lightning-node" ? lightning : ({
    kind,
    status: "healthy",
    observedAt: NOW,
    evidenceDigest: id(`close-monitor:${kind}`).toLowerCase(),
  }));
  const result = evaluateSafetyMonitor({ observations, now: NOW, maximumObservationAgeSeconds: 15 });
  assert.equal(result.healthy, false);
  assert.ok(result.reasonCodes.includes("LIGHTNING_NODE_UNSAFE"));
  assert.equal(result.evidenceSetDigest.includes(unsafe.evidenceDigest.slice(2)), false);
});
