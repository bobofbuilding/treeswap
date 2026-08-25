import {
  createRecoverySolverDaemonContext,
} from "./capabilities.mjs";
import {
  createRecoverySolverDaemonExecutionFence,
  deactivateRecoverySolverDaemonExecutionFence,
  executeRecoverySolverDaemonStep,
} from "./active-solver-daemon-runtime.mjs";
import { assertCoordinatorServiceLeaseOwnership } from "./coordinator-service-state.mjs";
import { coordinatorCommitmentDigest } from "./coordinator-store.mjs";
import {
  releaseRetainedReleaseRecoveryJobSetLease,
  verifiedRetainedReleaseRecoveryJobs,
} from "./release-retention-custody.mjs";

export const COORDINATOR_RECOVERY_ACTION_LOOP_SCHEMA =
  "treeswap.coordinator-recovery-action-loop.v2";

const AUTHORIZATIONS = Object.freeze({
  funding: false,
  lightningDispatch: false,
  newExposure: false,
});
const EMPTY_COUNTS = Object.freeze({
  attempted: 0,
  advanced: 0,
  waiting: 0,
  gateClosed: 0,
  done: 0,
  halted: 0,
});
const NON_ADVANCING_OUTCOMES = new Set(["WAITING", "GATE_CLOSED", "DONE", "HALTED"]);

class RecoveryActionLoopStoppedError extends Error {}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function wholeSecondIso(seconds) {
  return new Date(seconds * 1_000).toISOString();
}

function statusRecord({
  state,
  startedAt,
  lastAttemptAt,
  lastSuccessAt,
  consecutiveFailures,
  releaseId,
  releaseRecordDigest,
  jobSetDigest,
  jobCount,
  counts = EMPTY_COUNTS,
  cycleDigest = null,
}) {
  return Object.freeze({
    schema: COORDINATOR_RECOVERY_ACTION_LOOP_SCHEMA,
    state,
    scope: "already-bound-settlement-recovery-only-no-lightning-planning-dispatch-new-exposure-or-funding-authority",
    startedAt,
    lastAttemptAt,
    lastSuccessAt,
    consecutiveFailures,
    releaseId,
    releaseRecordDigest,
    jobSetDigest,
    jobCount,
    counts: Object.freeze({ ...counts }),
    cycleDigest,
    authorizations: AUTHORIZATIONS,
  });
}

function countResults(results, attempted = results.length) {
  const counts = { ...EMPTY_COUNTS, attempted };
  for (const result of results) {
    if (result.outcome === "WAITING") counts.waiting += 1;
    else if (result.outcome === "GATE_CLOSED") counts.gateClosed += 1;
    else if (result.outcome === "DONE") counts.done += 1;
    else if (result.outcome === "HALTED") counts.halted += 1;
    if (!NON_ADVANCING_OUTCOMES.has(result.outcome)) counts.advanced += 1;
  }
  return counts;
}

export function createCoordinatorRecoveryActionLoop(input) {
  exactKeys(
    input,
    ["intervalSeconds", "jobSetVerification", "recoverySupervisor", "serviceLease", "store"],
    "recovery action loop",
  );
  const { recoverySupervisor, serviceLease, store } = input;
  if (!recoverySupervisor || typeof recoverySupervisor.status !== "function"
      || typeof recoverySupervisor.useActiveActivation !== "function") {
    throw new TypeError("recovery verification supervisor is invalid");
  }
  if (!Number.isSafeInteger(input.intervalSeconds)
      || input.intervalSeconds < 5 || input.intervalSeconds > 30) {
    throw new RangeError("recovery action interval is outside policy");
  }
  const verifiedJobSet = verifiedRetainedReleaseRecoveryJobs({
    jobSetVerification: input.jobSetVerification,
    restoredStore: store,
    now: Math.floor(Date.now() / 1_000),
  });
  const {
    jobs,
    jobSetDigest,
    lease: jobSetLease,
    releaseId,
    releaseRecordDigest,
  } = verifiedJobSet;
  const startedAtSeconds = Math.floor(Date.now() / 1_000);
  const startedAt = wholeSecondIso(startedAtSeconds);
  let lastObservedAt = startedAtSeconds;
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let consecutiveFailures = 0;
  let currentStatus = statusRecord({
    state: "idle",
    startedAt,
    lastAttemptAt,
    lastSuccessAt,
    consecutiveFailures,
    releaseId,
    releaseRecordDigest,
    jobSetDigest,
    jobCount: jobs.length,
  });
  let running = null;
  let fence = null;
  let timer = null;
  let stopped = false;
  let jobSetLeaseReleased = false;
  let resolveStopped;
  let rejectStopped;
  const stoppedPromise = new Promise((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  stoppedPromise.catch(() => {});

  function releaseJobSetLease() {
    if (jobSetLeaseReleased) return false;
    jobSetLeaseReleased = true;
    try {
      const released = releaseRetainedReleaseRecoveryJobSetLease(jobSetLease);
      resolveStopped(Object.freeze({ released }));
      return released;
    } catch (error) {
      rejectStopped(error);
      throw error;
    }
  }

  function inactive(now, { results = [], attempted = 0 } = {}) {
    consecutiveFailures += 1;
    const cycleDigest = results.length === 0 ? null : coordinatorCommitmentDigest({
      schema: "treeswap.coordinator-recovery-action-cycle.v1",
      releaseId,
      releaseRecordDigest,
      jobSetDigest,
      jobCount: jobs.length,
      attempted,
      results,
    });
    currentStatus = statusRecord({
      state: "inactive",
      startedAt,
      lastAttemptAt: wholeSecondIso(now),
      lastSuccessAt,
      consecutiveFailures,
      releaseId,
      releaseRecordDigest,
      jobSetDigest,
      jobCount: jobs.length,
      counts: countResults(results, attempted),
      cycleDigest,
    });
    return currentStatus;
  }

  async function performCycle() {
    const now = Math.floor(Date.now() / 1_000);
    lastAttemptAt = wholeSecondIso(now);
    if (now < lastObservedAt) return inactive(lastObservedAt);
    lastObservedAt = now;
    currentStatus = statusRecord({
      state: "running",
      startedAt,
      lastAttemptAt,
      lastSuccessAt,
      consecutiveFailures,
      releaseId,
      releaseRecordDigest,
      jobSetDigest,
      jobCount: jobs.length,
    });
    const results = [];
    let attempted = 0;
    try {
      if (stopped) throw new RecoveryActionLoopStoppedError("recovery action loop is stopped");
      const verification = recoverySupervisor.status({ now });
      if (!verification || verification.state !== "active") return inactive(now);
      await assertCoordinatorServiceLeaseOwnership(serviceLease);
      if (stopped) throw new RecoveryActionLoopStoppedError("recovery action loop is stopped");
      fence = createRecoverySolverDaemonExecutionFence();
      for (const job of jobs) {
        if (stopped) throw new RecoveryActionLoopStoppedError("recovery action loop is stopped");
        attempted += 1;
        const executionContext = recoverySupervisor.useActiveActivation(({ activation }) => (
          createRecoverySolverDaemonContext({
            solverCapabilityVerification: job.solverCapabilityVerification,
            deployment: activation.deployment,
            evidencePolicy: job.evidencePolicy,
            now: Math.floor(Date.now() / 1_000),
          })
        ), { now: Math.floor(Date.now() / 1_000) });
        const result = await executeRecoverySolverDaemonStep({
          executionContext,
          executionFence: fence,
          serviceLease,
          store,
          settlementId: job.settlementId,
          ...job.runtime,
        });
        if (stopped) throw new RecoveryActionLoopStoppedError("recovery action loop is stopped");
        results.push(Object.freeze({ stepKind: result.stepKind, outcome: result.outcome }));
      }
      const counts = countResults(results, attempted);
      const cycleDigest = coordinatorCommitmentDigest({
        schema: "treeswap.coordinator-recovery-action-cycle.v1",
        releaseId,
        releaseRecordDigest,
        jobSetDigest,
        jobCount: jobs.length,
        attempted,
        results,
      });
      lastSuccessAt = lastAttemptAt;
      consecutiveFailures = 0;
      currentStatus = statusRecord({
        state: "active",
        startedAt,
        lastAttemptAt,
        lastSuccessAt,
        consecutiveFailures,
        releaseId,
        releaseRecordDigest,
        jobSetDigest,
        jobCount: jobs.length,
        counts,
        cycleDigest,
      });
      return currentStatus;
    } catch (error) {
      if (error instanceof RecoveryActionLoopStoppedError || stopped) return currentStatus;
      return inactive(now, { results, attempted });
    } finally {
      if (fence) {
        deactivateRecoverySolverDaemonExecutionFence(fence);
        fence = null;
      }
    }
  }

  function runCycle() {
    if (stopped) return Promise.reject(new Error("recovery action loop is stopped"));
    if (running) return Promise.reject(new Error("recovery action cycle is already running"));
    running = performCycle().finally(() => { running = null; });
    return running;
  }

  function start() {
    if (stopped) throw new Error("recovery action loop is stopped");
    if (timer) return false;
    void runCycle().catch(() => {});
    timer = setInterval(() => { void runCycle().catch(() => {}); }, input.intervalSeconds * 1_000);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (fence) deactivateRecoverySolverDaemonExecutionFence(fence);
    if (running) void running.then(releaseJobSetLease, releaseJobSetLease).catch(() => {});
    else releaseJobSetLease();
    currentStatus = statusRecord({
      state: "stopped",
      startedAt,
      lastAttemptAt,
      lastSuccessAt,
      consecutiveFailures,
      releaseId,
      releaseRecordDigest,
      jobSetDigest,
      jobCount: jobs.length,
    });
    return true;
  }

  return Object.freeze({
    runCycle,
    start,
    status: () => currentStatus,
    stop,
    waitUntilStopped: () => stoppedPromise,
  });
}
