import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecoverySolverDaemonExecutionFence,
  deactivateRecoverySolverDaemonExecutionFence,
} from "../lib/active-solver-daemon-runtime.mjs";
import { createCoordinatorRecoveryActionLoop } from "../lib/coordinator-recovery-action-loop.mjs";

const SETTLEMENT_ID = `0x${"11".repeat(32)}`;

function job(overrides = {}) {
  return {
    settlementId: SETTLEMENT_ID,
    solverCapabilityVerification: Object.freeze({ original: true }),
    evidencePolicy: { schema: "test-policy", nested: { value: 1 } },
    runtime: { packetClient: null, controls: {}, lightning: null, evm: null },
    ...overrides,
  };
}

function inactiveLoop(overrides = {}) {
  return createCoordinatorRecoveryActionLoop({
    recoverySupervisor: {
      status: () => ({ state: "inactive", providerSecret: "must-not-escape" }),
      useActiveActivation: () => { throw new Error("inactive supervisor must not expose an activation"); },
    },
    serviceLease: { copied: true },
    store: null,
    intervalSeconds: 5,
    jobs: [job()],
    ...overrides,
  });
}

test("inactive recovery verification fails closed before lease, store, or job execution", async () => {
  const loop = inactiveLoop();
  assert.equal(loop.status().state, "idle");
  const firstCycle = loop.runCycle();
  await assert.rejects(loop.runCycle(), /already running/);
  const status = await firstCycle;
  assert.equal(status.state, "inactive");
  assert.equal(status.consecutiveFailures, 1);
  assert.deepEqual(status.counts, {
    attempted: 0,
    advanced: 0,
    waiting: 0,
    gateClosed: 0,
    done: 0,
    halted: 0,
  });
  assert.deepEqual(status.authorizations, {
    funding: false,
    lightningDispatch: false,
    newExposure: false,
  });
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(SETTLEMENT_ID), false);
  assert.equal(serialized.includes("must-not-escape"), false);
  assert.equal(loop.stop(), true);
  assert.equal(loop.stop(), false);
  assert.equal(loop.status().state, "stopped");
  await assert.rejects(loop.runCycle(), /is stopped/);
  assert.throws(() => loop.start(), /is stopped/);
});

test("construction rejects mutable authority, duplicate jobs, excess jobs, and caller guards", () => {
  assert.throws(() => createCoordinatorRecoveryActionLoop({}), /fields are not exact/);
  assert.throws(() => inactiveLoop({ intervalSeconds: 4 }), /interval is outside policy/);
  assert.throws(() => inactiveLoop({ jobs: [] }), /between 1 and 64/);
  assert.throws(() => inactiveLoop({ jobs: Array.from({ length: 65 }, (_, index) => job({
    settlementId: `0x${(index + 1).toString(16).padStart(64, "0")}`,
  })) }), /between 1 and 64/);
  assert.throws(() => inactiveLoop({ jobs: [job(), job()] }), /duplicated/);
  assert.throws(() => inactiveLoop({ jobs: [job({ unexpected: true })] }), /fields are not exact/);
  assert.throws(() => inactiveLoop({ jobs: [job({ settlementId: `0x${"00".repeat(32)}` })] }), /nonzero lowercase bytes32/);
  assert.throws(() => inactiveLoop({ jobs: [job({
    runtime: {
      packetClient: null,
      controls: {},
      lightning: null,
      evm: null,
      beforeSideEffect: async () => {},
    },
  })] }), /fields are not exact/);
  assert.throws(() => inactiveLoop({ jobs: [job({
    runtime: {
      packetClient: null,
      controls: { authorizeLightning: async () => true },
      lightning: null,
      evm: null,
    },
  })] }), /control is not permitted/);
  assert.throws(() => inactiveLoop({ recoverySupervisor: null }), /supervisor is invalid/);
});

test("execution fences are same-process, cancellable, and non-transferable", () => {
  const fence = createRecoverySolverDaemonExecutionFence();
  assert.equal(deactivateRecoverySolverDaemonExecutionFence(fence), true);
  assert.equal(deactivateRecoverySolverDaemonExecutionFence(fence), false);
  assert.throws(
    () => deactivateRecoverySolverDaemonExecutionFence(structuredClone(fence)),
    /original same-process execution fence/,
  );
});
