import { createActiveSolverDaemonContext } from "./capabilities.mjs";
import {
  bindActiveSolverSettlementExecutionPolicy,
  createActiveSolverDaemonExecutionFence,
  deactivateActiveSolverDaemonExecutionFence,
  executeActiveSolverDaemonStep,
} from "./active-solver-daemon-runtime.mjs";
import {
  claimPreparedCoordinatorActiveExecutionPolicySet,
} from "./coordinator-active-execution-policy.mjs";
import { assertCoordinatorServiceLeaseOwnership } from "./coordinator-service-state.mjs";
import { CoordinatorStore, coordinatorCommitmentDigest, isVerifiedCoordinatorStore } from "./coordinator-store.mjs";
import { isCoordinatorReleaseVerificationSupervisor } from "./coordinator-release-supervisor.mjs";

export const COORDINATOR_ACTIVE_EXECUTION_LIFECYCLE_SCHEMA =
  "treeswap.coordinator-active-execution-lifecycle.v1";

const INPUT_KEYS = Object.freeze([
  "intervalSeconds",
  "maxSettlementsPerCycle",
  "policyPreparation",
  "releaseRefreshSeconds",
  "releaseSupervisor",
  "serviceLease",
  "store",
]);
const ORIGINAL_STORE_METHODS = Object.freeze({
  getFirmOffer: CoordinatorStore.prototype.getFirmOffer,
  getSettlement: CoordinatorStore.prototype.getSettlement,
  listNonterminalSettlements: CoordinatorStore.prototype.listNonterminalSettlements,
});
const EMPTY_COUNTS = Object.freeze({
  discovered: 0,
  eligible: 0,
  attempted: 0,
  advanced: 0,
  waiting: 0,
  gateClosed: 0,
  done: 0,
  halted: 0,
  backlog: 0,
});
const NON_ADVANCING_OUTCOMES = new Set(["WAITING", "GATE_CLOSED", "DONE", "HALTED"]);

class ActiveExecutionLifecycleStoppedError extends Error {}

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

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside policy`);
  }
  return value;
}

function originalStore(store) {
  if (!isVerifiedCoordinatorStore(store)) {
    throw new TypeError("active execution lifecycle requires an original coordinator store");
  }
  for (const [name, method] of Object.entries(ORIGINAL_STORE_METHODS)) {
    if (store[name] !== method) {
      throw new TypeError("active execution lifecycle requires unmodified store discovery methods");
    }
  }
  return store;
}

function wholeSecondIso(seconds) {
  return new Date(seconds * 1_000).toISOString();
}

function authorizations(state) {
  const active = state === "active";
  return Object.freeze({
    funding: active,
    lightningDispatch: active,
    newExposure: active,
  });
}

function statusRecord({
  state,
  startedAt,
  lastAttemptAt,
  lastSuccessAt,
  consecutiveFailures,
  policyPreparation,
  counts = EMPTY_COUNTS,
  cycleDigest = null,
  cursor = null,
}) {
  return Object.freeze({
    schema: COORDINATOR_ACTIVE_EXECUTION_LIFECYCLE_SCHEMA,
    state,
    scope: "database-derived-lightning-bit-settlements-only-no-network-job-intake",
    workSource: "original-coordinator-store-nonterminal-settlements",
    networkListener: false,
    startedAt,
    lastAttemptAt,
    lastSuccessAt,
    consecutiveFailures,
    releaseRecordDigest: policyPreparation.releaseRecordDigest,
    policySetDigest: policyPreparation.policySetDigest,
    policyCount: policyPreparation.policyCount,
    counts: Object.freeze({ ...counts }),
    cycleDigest,
    cursorDigest: cursor === null ? null : coordinatorCommitmentDigest({
      schema: "treeswap.coordinator-active-execution-cursor.v1",
      settlementId: cursor,
    }),
    authorizations: authorizations(state),
  });
}

function policyForSettlement(store, settlement, policies) {
  const offer = ORIGINAL_STORE_METHODS.getFirmOffer.call(store, settlement.selectedOfferId);
  if (!offer || offer.offerId !== settlement.selectedOfferId
      || offer.requestId !== settlement.pricingId || offer.direction !== settlement.direction
      || offer.capacityEpoch !== settlement.capacityEpoch) return null;
  const matches = policies.filter(({ descriptor }) => (
    descriptor.direction === settlement.direction
      && descriptor.solverId === offer.solverId
      && descriptor.capacityEpoch === settlement.capacityEpoch
      && descriptor.solverCapabilityDigest === offer.capabilityDigest
      && (settlement.releaseRecordDigest === null
        || settlement.releaseRecordDigest === descriptor.releaseRecordDigest)
      && (settlement.solverCapabilityDigest === null
        || settlement.solverCapabilityDigest === descriptor.solverCapabilityDigest)
      && (settlement.evidencePolicyDigest === null
        || settlement.evidencePolicyDigest === descriptor.evidencePolicyDigest)
  ));
  return matches.length === 1 ? matches[0] : null;
}

function rotateAfterCursor(settlements, cursor) {
  if (cursor === null || settlements.length === 0) return settlements;
  const index = settlements.findIndex(({ settlementId }) => settlementId > cursor);
  if (index <= 0) return index === 0 ? settlements : settlements;
  return Object.freeze([...settlements.slice(index), ...settlements.slice(0, index)]);
}

function resultCounts(discovered, eligible, results, attempted, maximum) {
  const counts = {
    ...EMPTY_COUNTS,
    discovered,
    eligible,
    attempted,
    gateClosed: discovered - eligible,
    backlog: Math.max(eligible - maximum, 0),
  };
  for (const result of results) {
    if (result.outcome === "WAITING") counts.waiting += 1;
    else if (result.outcome === "GATE_CLOSED") counts.gateClosed += 1;
    else if (result.outcome === "DONE") counts.done += 1;
    else if (result.outcome === "HALTED") counts.halted += 1;
    if (!NON_ADVANCING_OUTCOMES.has(result.outcome)) counts.advanced += 1;
  }
  return counts;
}

export function createCoordinatorActiveExecutionLifecycle(input) {
  exactKeys(input, INPUT_KEYS, "coordinator active execution lifecycle");
  const intervalSeconds = boundedInteger(input.intervalSeconds, 5, 30, "active execution interval");
  const releaseRefreshSeconds = boundedInteger(
    input.releaseRefreshSeconds,
    5,
    30,
    "active execution release refresh interval",
  );
  const maxSettlementsPerCycle = boundedInteger(
    input.maxSettlementsPerCycle,
    1,
    64,
    "active execution maximum settlements per cycle",
  );
  const store = originalStore(input.store);
  const { releaseSupervisor, serviceLease, policyPreparation } = input;
  if (!isCoordinatorReleaseVerificationSupervisor(releaseSupervisor)) {
    throw new TypeError("active execution requires an original same-process release supervisor");
  }
  const createdAt = Math.floor(Date.now() / 1_000);
  const initialVerification = releaseSupervisor.status({ now: createdAt });
  if (!initialVerification || initialVerification.state !== "active"
      || initialVerification.recordDigest !== policyPreparation.releaseRecordDigest) {
    throw new Error("active execution lifecycle requires its prepared current release");
  }
  const policies = claimPreparedCoordinatorActiveExecutionPolicySet(
    policyPreparation,
    { releaseSupervisor, serviceLease, store },
    (value) => value,
  );
  const startedAt = wholeSecondIso(createdAt);
  const executionFence = createActiveSolverDaemonExecutionFence();
  let nextRefreshAt = createdAt + releaseRefreshSeconds;
  let lastObservedAt = createdAt;
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let consecutiveFailures = 0;
  let cursor = null;
  let currentStatus = statusRecord({
    state: "idle",
    startedAt,
    lastAttemptAt,
    lastSuccessAt,
    consecutiveFailures,
    policyPreparation,
  });
  let running = null;
  let timer = null;
  let lifecycle = "created";
  let fatal = false;
  let shutdownPromise = null;
  let resolveStopped;
  let rejectStopped;
  const stoppedPromise = new Promise((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  stoppedPromise.catch(() => {});

  function recordFailedCycle(now) {
    fatal = true;
    try { deactivateActiveSolverDaemonExecutionFence(executionFence); } catch {}
    try { releaseSupervisor.stop(); } catch {}
    consecutiveFailures += 1;
    currentStatus = statusRecord({
      state: "inactive",
      startedAt,
      lastAttemptAt: wholeSecondIso(now),
      lastSuccessAt,
      consecutiveFailures,
      policyPreparation,
      cursor,
    });
    return currentStatus;
  }

  async function performCycle() {
    const observedAt = Math.floor(Date.now() / 1_000);
    const now = observedAt < lastObservedAt ? lastObservedAt : observedAt;
    lastAttemptAt = wholeSecondIso(now);
    currentStatus = statusRecord({
      state: "running",
      startedAt,
      lastAttemptAt,
      lastSuccessAt,
      consecutiveFailures,
      policyPreparation,
      cursor,
    });
    if (observedAt < lastObservedAt) return recordFailedCycle(now);
    lastObservedAt = now;
    try {
      if (["stopping", "stopped"].includes(lifecycle)) {
        throw new ActiveExecutionLifecycleStoppedError("active execution lifecycle is stopped");
      }
      if (now >= nextRefreshAt) {
        const refreshed = await releaseSupervisor.refresh({ now });
        if (!refreshed || refreshed.state !== "active"
            || refreshed.recordDigest !== policyPreparation.releaseRecordDigest) {
          throw new Error("active execution release refresh is inactive or changed release");
        }
        nextRefreshAt = now + releaseRefreshSeconds;
      }
      const verification = releaseSupervisor.status({ now: Math.floor(Date.now() / 1_000) });
      if (!verification || verification.state !== "active"
          || verification.recordDigest !== policyPreparation.releaseRecordDigest) {
        throw new Error("active execution release verification is inactive or changed release");
      }
      await assertCoordinatorServiceLeaseOwnership(serviceLease);
      originalStore(store);
      const settlements = ORIGINAL_STORE_METHODS.listNonterminalSettlements.call(store);
      const eligible = settlements.map((settlement) => Object.freeze({
        settlement,
        policy: policyForSettlement(store, settlement, policies),
      }));
      const unmatched = eligible.filter(({ policy }) => policy === null);
      const cycleResults = [];
      if (unmatched.length > 0) {
        const counts = resultCounts(settlements.length, eligible.length - unmatched.length, [], 0, 0);
        const cycleDigest = coordinatorCommitmentDigest({
          schema: "treeswap.coordinator-active-execution-cycle.v1",
          releaseRecordDigest: policyPreparation.releaseRecordDigest,
          policySetDigest: policyPreparation.policySetDigest,
          discoveredSettlementIds: settlements.map(({ settlementId }) => settlementId),
          unmatchedSettlementIds: unmatched.map(({ settlement }) => settlement.settlementId),
          attempted: 0,
          results: [],
        });
        consecutiveFailures = 0;
        currentStatus = statusRecord({
          state: "degraded",
          startedAt,
          lastAttemptAt,
          lastSuccessAt,
          consecutiveFailures,
          policyPreparation,
          counts,
          cycleDigest,
          cursor,
        });
        return currentStatus;
      }
      const ordered = rotateAfterCursor(eligible, cursor);
      const selected = ordered.slice(0, maxSettlementsPerCycle);
      for (const { settlement, policy } of selected) {
        if (["stopping", "stopped"].includes(lifecycle)) {
          throw new ActiveExecutionLifecycleStoppedError("active execution lifecycle is stopped");
        }
        const executionContext = releaseSupervisor.useActiveActivation(({ activation }) => (
          createActiveSolverDaemonContext({
            solverCapabilityVerification: policy.solverCapabilityVerification,
            deployment: activation.deployment,
            capabilities: activation.capabilities,
            evidencePolicy: policy.evidencePolicy,
            now: Math.floor(Date.now() / 1_000),
          })
        ), { now: Math.floor(Date.now() / 1_000) });
        let currentSettlement = ORIGINAL_STORE_METHODS.getSettlement.call(store, settlement.settlementId);
        if (currentSettlement.executionPolicyBindingDigest === null) {
          currentSettlement = await bindActiveSolverSettlementExecutionPolicy({
            executionContext,
            executionFence,
            serviceLease,
            settlementId: settlement.settlementId,
            store,
          });
        }
        const result = await executeActiveSolverDaemonStep({
          executionContext,
          executionFence,
          serviceLease,
          settlementId: currentSettlement.settlementId,
          store,
          ...policy.runtime,
        });
        cycleResults.push(Object.freeze({
          settlementId: result.settlementId,
          stepKind: result.stepKind,
          outcome: result.outcome,
        }));
        cursor = settlement.settlementId;
      }
      const counts = resultCounts(
        settlements.length,
        eligible.length,
        cycleResults,
        selected.length,
        maxSettlementsPerCycle,
      );
      const cycleDigest = coordinatorCommitmentDigest({
        schema: "treeswap.coordinator-active-execution-cycle.v1",
        releaseRecordDigest: policyPreparation.releaseRecordDigest,
        policySetDigest: policyPreparation.policySetDigest,
        discoveredSettlementIds: settlements.map(({ settlementId }) => settlementId),
        attempted: selected.length,
        results: cycleResults,
      });
      lastSuccessAt = lastAttemptAt;
      consecutiveFailures = 0;
      currentStatus = statusRecord({
        state: counts.gateClosed === 0 ? "active" : "degraded",
        startedAt,
        lastAttemptAt,
        lastSuccessAt,
        consecutiveFailures,
        policyPreparation,
        counts,
        cycleDigest,
        cursor,
      });
      return currentStatus;
    } catch (error) {
      if (error instanceof ActiveExecutionLifecycleStoppedError
          || ["stopping", "stopped"].includes(lifecycle)) return currentStatus;
      return recordFailedCycle(now);
    }
  }

  function runCycle() {
    if (fatal) {
      return Promise.reject(new Error("active execution lifecycle is inactive"));
    }
    if (["stopping", "stopped"].includes(lifecycle)) {
      return Promise.reject(new Error("active execution lifecycle is stopped"));
    }
    if (running) return Promise.reject(new Error("active execution cycle is already running"));
    running = performCycle().finally(() => { running = null; });
    return running;
  }

  function schedule() {
    if (lifecycle !== "running") return;
    timer = setTimeout(async () => {
      timer = null;
      const status = await runCycle().catch(() => null);
      if (!status || status.state === "inactive") {
        void stop("background-failure").catch(() => {});
        return;
      }
      schedule();
    }, intervalSeconds * 1_000);
    timer.unref?.();
  }

  async function start() {
    if (lifecycle === "running") return false;
    if (lifecycle !== "created") throw new Error("active execution lifecycle cannot be restarted");
    lifecycle = "starting";
    const status = await runCycle();
    if (status.state === "inactive") {
      await stop("startup-failure");
      throw new Error("active execution lifecycle failed its initial cycle");
    }
    if (lifecycle !== "starting") return false;
    lifecycle = "running";
    schedule();
    return true;
  }

  function stop(reason = "requested") {
    if (shutdownPromise) return shutdownPromise;
    if (!["requested", "startup-failure", "background-failure"].includes(reason)) {
      return Promise.reject(new TypeError("active execution shutdown reason is invalid"));
    }
    lifecycle = "stopping";
    if (timer) clearTimeout(timer);
    timer = null;
    let synchronousFailure = null;
    try {
      deactivateActiveSolverDaemonExecutionFence(executionFence);
    } catch (error) {
      synchronousFailure = error;
    }
    try {
      releaseSupervisor.stop();
    } catch (error) {
      synchronousFailure ??= error;
    }
    shutdownPromise = (async () => {
      try {
        if (running) await running.catch(() => {});
        if (synchronousFailure) throw synchronousFailure;
        lifecycle = "stopped";
        currentStatus = statusRecord({
          state: "stopped",
          startedAt,
          lastAttemptAt,
          lastSuccessAt,
          consecutiveFailures,
          policyPreparation,
          cursor,
        });
        const result = Object.freeze({ reason });
        resolveStopped(result);
        return result;
      } catch (error) {
        lifecycle = "stopped";
        rejectStopped(error);
        throw error;
      }
    })();
    shutdownPromise.catch(() => {});
    return shutdownPromise;
  }

  return Object.freeze({
    runCycle,
    start,
    status: () => currentStatus,
    stop: () => stop("requested"),
    waitUntilStopped: () => stoppedPromise,
  });
}
