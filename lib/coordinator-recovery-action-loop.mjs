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

export const COORDINATOR_RECOVERY_ACTION_LOOP_SCHEMA =
  "treeswap.coordinator-recovery-action-loop.v1";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const JOB_KEYS = Object.freeze([
  "evidencePolicy",
  "runtime",
  "settlementId",
  "solverCapabilityVerification",
]);
const RUNTIME_KEYS = Object.freeze(["controls", "evm", "lightning", "packetClient"]);
const CONTROL_KEYS = new Set(["authorizeEvmClaim", "observeReservation", "verifyAssets"]);
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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return deepFreeze(structuredClone(value));
}

function snapshotControls(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("recovery action controls must be an object");
  }
  const controls = {};
  for (const [name, implementation] of Object.entries(value)) {
    if (!CONTROL_KEYS.has(name)) throw new TypeError("recovery action control is not permitted");
    if (typeof implementation !== "function") throw new TypeError("recovery action control must be a function");
    controls[name] = (...args) => implementation.apply(value, args);
  }
  return Object.freeze(controls);
}

function snapshotPacketClient(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || typeof value.read !== "function") {
    throw new TypeError("recovery private packet client is invalid");
  }
  const read = value.read;
  return Object.freeze({ read: (...args) => read.apply(value, args) });
}

function snapshotRuntime(value) {
  exactKeys(value, RUNTIME_KEYS, "recovery action runtime");
  const copyConfig = (config, name) => {
    if (config === null) return null;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError(`${name} must be an object or null`);
    }
    const copy = { ...config };
    if (Array.isArray(copy.reconciliationProviders)) {
      copy.reconciliationProviders = Object.freeze([...copy.reconciliationProviders]);
    }
    return Object.freeze(copy);
  };
  return Object.freeze({
    packetClient: snapshotPacketClient(value.packetClient),
    controls: snapshotControls(value.controls),
    lightning: copyConfig(value.lightning, "recovery Lightning configuration"),
    evm: copyConfig(value.evm, "recovery EVM configuration"),
  });
}

function normalizeJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > 64) {
    throw new RangeError("recovery action jobs must contain between 1 and 64 settlements");
  }
  const seen = new Set();
  return Object.freeze(jobs.map((job) => {
    exactKeys(job, JOB_KEYS, "recovery action job");
    const settlementId = String(job.settlementId ?? "");
    if (!BYTES32.test(settlementId)) throw new TypeError("recovery action settlementId must be nonzero lowercase bytes32");
    if (seen.has(settlementId)) throw new Error("recovery action settlementId is duplicated");
    seen.add(settlementId);
    if (!job.solverCapabilityVerification || typeof job.solverCapabilityVerification !== "object") {
      throw new TypeError("recovery solver capability verification is required");
    }
    return Object.freeze({
      settlementId,
      solverCapabilityVerification: job.solverCapabilityVerification,
      evidencePolicy: snapshotPlainObject(job.evidencePolicy, "recovery evidence policy"),
      runtime: snapshotRuntime(job.runtime),
    });
  }));
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
  exactKeys(input, ["intervalSeconds", "jobs", "recoverySupervisor", "serviceLease", "store"], "recovery action loop");
  const { recoverySupervisor, serviceLease, store } = input;
  if (!recoverySupervisor || typeof recoverySupervisor.status !== "function"
      || typeof recoverySupervisor.useActiveActivation !== "function") {
    throw new TypeError("recovery verification supervisor is invalid");
  }
  if (!Number.isSafeInteger(input.intervalSeconds)
      || input.intervalSeconds < 5 || input.intervalSeconds > 30) {
    throw new RangeError("recovery action interval is outside policy");
  }
  const jobs = normalizeJobs(input.jobs);
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
    jobCount: jobs.length,
  });
  let running = null;
  let fence = null;
  let timer = null;
  let stopped = false;

  function inactive(now, { results = [], attempted = 0 } = {}) {
    consecutiveFailures += 1;
    const cycleDigest = results.length === 0 ? null : coordinatorCommitmentDigest({
      schema: "treeswap.coordinator-recovery-action-cycle.v1",
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
    currentStatus = statusRecord({
      state: "stopped",
      startedAt,
      lastAttemptAt,
      lastSuccessAt,
      consecutiveFailures,
      jobCount: jobs.length,
    });
    return true;
  }

  return Object.freeze({ runCycle, start, status: () => currentStatus, stop });
}
