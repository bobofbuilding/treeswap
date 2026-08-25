import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecoverySolverDaemonExecutionFence,
  deactivateRecoverySolverDaemonExecutionFence,
} from "../lib/active-solver-daemon-runtime.mjs";
import { createCoordinatorRecoveryActionLoop } from "../lib/coordinator-recovery-action-loop.mjs";

const SETTLEMENT_ID = `0x${"11".repeat(32)}`;

function invalidLoop(overrides = {}) {
  return {
    recoverySupervisor: {
      status: () => ({ state: "inactive", providerSecret: "must-not-escape" }),
      useActiveActivation: () => { throw new Error("inactive supervisor must not expose an activation"); },
    },
    serviceLease: { copied: true },
    store: null,
    intervalSeconds: 5,
    jobSetVerification: Object.freeze({ copied: true }),
    ...overrides,
  };
}

test("construction rejects raw jobs, copied job-set claims, and caller-selected authority", () => {
  assert.throws(() => createCoordinatorRecoveryActionLoop({}), /fields are not exact/);
  assert.throws(() => createCoordinatorRecoveryActionLoop({
    ...invalidLoop(),
    jobs: [{ settlementId: SETTLEMENT_ID }],
  }), /fields are not exact/);
  assert.throws(() => createCoordinatorRecoveryActionLoop(invalidLoop()), /job-set provenance/);
  assert.throws(() => createCoordinatorRecoveryActionLoop(invalidLoop({
    jobSetVerification: structuredClone(invalidLoop().jobSetVerification),
  })), /job-set provenance/);
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
