import { createCoordinatorRecoveryActionLoop } from "./coordinator-recovery-action-loop.mjs";
import {
  assertCoordinatorServiceLeaseOwnership,
  buildCoordinatorRecoveryExecutionStatus,
} from "./coordinator-service-state.mjs";

const INPUT_KEYS = Object.freeze([
  "heartbeatSeconds",
  "intervalSeconds",
  "jobSetVerification",
  "recoveredInterruptedActions",
  "recoveryRefreshSeconds",
  "recoverySupervisor",
  "serviceLease",
  "store",
]);

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

function boundedInterval(value, name) {
  if (!Number.isSafeInteger(value) || value < 5 || value > 30) {
    throw new RangeError(`${name} is outside policy`);
  }
  return value;
}

function wholeSecondIso(seconds) {
  return new Date(seconds * 1_000).toISOString();
}

export function createCoordinatorRecoveryExecutionSupervisor(input) {
  exactKeys(input, INPUT_KEYS, "coordinator recovery execution supervisor");
  const heartbeatSeconds = boundedInterval(input.heartbeatSeconds, "recovery execution heartbeat interval");
  const recoveryRefreshSeconds = boundedInterval(
    input.recoveryRefreshSeconds,
    "recovery execution verification refresh interval",
  );
  boundedInterval(input.intervalSeconds, "recovery execution action interval");
  if (!Number.isSafeInteger(input.recoveredInterruptedActions)
      || input.recoveredInterruptedActions < 0) {
    throw new TypeError("recovery execution recovered-action count is invalid");
  }
  const { recoverySupervisor, serviceLease, store } = input;
  if (!recoverySupervisor
      || typeof recoverySupervisor.refresh !== "function"
      || typeof recoverySupervisor.status !== "function"
      || typeof recoverySupervisor.stop !== "function"
      || typeof recoverySupervisor.useActiveActivation !== "function") {
    throw new TypeError("recovery execution verification supervisor is invalid");
  }
  if (!serviceLease || typeof serviceLease.publish !== "function"
      || typeof serviceLease.leaseId !== "string" || typeof serviceLease.startedAt !== "string") {
    throw new TypeError("recovery execution service lease is invalid");
  }
  if (!store || typeof store.integrityCheck !== "function"
      || typeof store.metrics !== "function" || typeof store.admissionMetrics !== "function") {
    throw new TypeError("recovery execution coordinator store is invalid");
  }
  const createdAt = Math.floor(Date.now() / 1_000);
  const initialVerification = recoverySupervisor.status({ now: createdAt });
  if (!initialVerification || initialVerification.state !== "active") {
    throw new Error("recovery execution requires an active same-process recovery verification");
  }
  const actionLoop = createCoordinatorRecoveryActionLoop({
    recoverySupervisor,
    serviceLease,
    store,
    intervalSeconds: input.intervalSeconds,
    jobSetVerification: input.jobSetVerification,
  });
  const tickSeconds = Math.min(heartbeatSeconds, recoveryRefreshSeconds);
  let nextRefreshAt = createdAt + recoveryRefreshSeconds;
  let latestStatus = null;
  let timer = null;
  let publishing = null;
  let lifecycle = "created";
  let shutdownPromise = null;
  let resolveStopped;
  let rejectStopped;
  const stoppedPromise = new Promise((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  stoppedPromise.catch(() => {});

  function buildStatus(now, recoveryVerification, recoveryAction) {
    return buildCoordinatorRecoveryExecutionStatus({
      store,
      serviceStartedAt: serviceLease.startedAt,
      heartbeatAt: wholeSecondIso(now),
      leaseIdentifier: serviceLease.leaseId,
      recoveredInterruptedActions: input.recoveredInterruptedActions,
      recoveryVerification,
      recoveryAction,
    });
  }

  async function publishStatus() {
    if (["stopping", "stopped"].includes(lifecycle)) {
      throw new Error("recovery execution supervisor is stopped");
    }
    if (publishing) throw new Error("recovery execution status publication is already running");
    const operation = (async () => {
      let observedAt = Math.floor(Date.now() / 1_000);
      if (observedAt >= nextRefreshAt) {
        const refreshed = await recoverySupervisor.refresh({ now: observedAt });
        if (!refreshed || refreshed.state !== "active") {
          throw new Error("recovery execution verification refresh is inactive");
        }
        nextRefreshAt = observedAt + recoveryRefreshSeconds;
        observedAt = Math.floor(Date.now() / 1_000);
      }
      const recoveryVerification = recoverySupervisor.status({ now: observedAt });
      if (!recoveryVerification || recoveryVerification.state !== "active") {
        throw new Error("recovery execution verification is inactive");
      }
      const recoveryAction = actionLoop.status();
      if (lifecycle === "running" && recoveryAction.state === "inactive") {
        throw new Error("recovery execution action loop is inactive");
      }
      await assertCoordinatorServiceLeaseOwnership(serviceLease);
      const status = buildStatus(observedAt, recoveryVerification, recoveryAction);
      await serviceLease.publish(status);
      latestStatus = status;
      return status;
    })();
    publishing = operation;
    let failed = false;
    try {
      return await operation;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (publishing === operation) publishing = null;
      if (failed && lifecycle === "running") {
        queueMicrotask(() => { void stop("background-failure").catch(() => {}); });
      }
    }
  }

  function schedule() {
    if (lifecycle !== "running") return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        await publishStatus();
      } catch {
        void stop("background-failure").catch(() => {});
        return;
      }
      schedule();
    }, tickSeconds * 1_000);
  }

  async function start() {
    if (lifecycle === "running") return false;
    if (lifecycle !== "created") throw new Error("recovery execution supervisor cannot be restarted");
    lifecycle = "starting";
    try {
      await publishStatus();
      if (lifecycle !== "starting") return false;
      actionLoop.start();
      lifecycle = "running";
      schedule();
      return true;
    } catch (error) {
      await stop("startup-failure").catch(() => {});
      throw error;
    }
  }

  function stop(reason = "requested") {
    if (shutdownPromise) return shutdownPromise;
    if (!["requested", "startup-failure", "background-failure"].includes(reason)) {
      return Promise.reject(new TypeError("recovery execution shutdown reason is invalid"));
    }
    lifecycle = "stopping";
    if (timer) clearTimeout(timer);
    timer = null;
    let synchronousFailure = null;
    try {
      recoverySupervisor.stop();
    } catch (error) {
      synchronousFailure = error;
    }
    try {
      actionLoop.stop();
    } catch (error) {
      synchronousFailure ??= error;
    }
    shutdownPromise = (async () => {
      try {
        if (publishing) await publishing.catch(() => {});
        await actionLoop.waitUntilStopped();
        if (synchronousFailure) throw synchronousFailure;
        lifecycle = "stopped";
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
    publishStatus,
    start,
    status: () => latestStatus,
    stop: () => stop("requested"),
    waitUntilStopped: () => stoppedPromise,
  });
}
