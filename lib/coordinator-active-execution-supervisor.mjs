import { createCoordinatorActiveExecutionLifecycle } from "./coordinator-active-execution-lifecycle.mjs";
import {
  assertCoordinatorServiceLeaseMode,
  buildCoordinatorActiveExecutionStatus,
} from "./coordinator-service-state.mjs";

const INPUT_KEYS = Object.freeze([
  "heartbeatSeconds",
  "integritySeconds",
  "intervalSeconds",
  "maxSettlementsPerCycle",
  "policyPreparation",
  "recoveredInterruptedActions",
  "releaseRefreshSeconds",
  "releaseSupervisor",
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

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside policy`);
  }
  return value;
}

function wholeSecondIso(seconds) {
  return new Date(seconds * 1_000).toISOString();
}

export function createCoordinatorActiveExecutionSupervisor(input) {
  exactKeys(input, INPUT_KEYS, "coordinator active execution supervisor");
  const heartbeatSeconds = boundedInteger(
    input.heartbeatSeconds,
    5,
    30,
    "active execution heartbeat interval",
  );
  const integritySeconds = boundedInteger(
    input.integritySeconds,
    10,
    300,
    "active execution integrity interval",
  );
  const intervalSeconds = boundedInteger(
    input.intervalSeconds,
    5,
    30,
    "active execution action interval",
  );
  const releaseRefreshSeconds = boundedInteger(
    input.releaseRefreshSeconds,
    5,
    30,
    "active execution release refresh interval",
  );
  if (intervalSeconds > releaseRefreshSeconds) {
    throw new Error("active execution interval cannot exceed its release refresh interval");
  }
  boundedInteger(
    input.maxSettlementsPerCycle,
    1,
    64,
    "active execution maximum settlements per cycle",
  );
  if (!Number.isSafeInteger(input.recoveredInterruptedActions)
      || input.recoveredInterruptedActions < 0) {
    throw new TypeError("active execution recovered-action count is invalid");
  }
  const { releaseSupervisor, serviceLease, store } = input;
  if (!releaseSupervisor || typeof releaseSupervisor.status !== "function"
      || typeof releaseSupervisor.stop !== "function") {
    throw new TypeError("active execution release supervisor is invalid");
  }
  if (!serviceLease || typeof serviceLease.publish !== "function"
      || typeof serviceLease.release !== "function"
      || typeof serviceLease.leaseId !== "string" || typeof serviceLease.startedAt !== "string") {
    throw new TypeError("active execution service lease is invalid");
  }
  if (!store || typeof store.integrityCheck !== "function"
      || typeof store.metrics !== "function" || typeof store.admissionMetrics !== "function") {
    throw new TypeError("active execution coordinator store is invalid");
  }
  const createdAt = Math.floor(Date.now() / 1_000);
  const initialVerification = releaseSupervisor.status({ now: createdAt });
  if (!initialVerification || initialVerification.state !== "active") {
    throw new Error("active execution requires a current same-process release verification");
  }
  const activeExecution = createCoordinatorActiveExecutionLifecycle({
    intervalSeconds,
    maxSettlementsPerCycle: input.maxSettlementsPerCycle,
    policyPreparation: input.policyPreparation,
    releaseRefreshSeconds,
    releaseSupervisor,
    serviceLease,
    store,
  });
  let lastIntegrityAt = 0;
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

  async function publishStatus() {
    if (["stopping", "stopped"].includes(lifecycle)) {
      throw new Error("active execution supervisor is stopped");
    }
    if (publishing) throw new Error("active execution status publication is already running");
    const operation = (async () => {
      const now = Math.floor(Date.now() / 1_000);
      const releaseVerification = releaseSupervisor.status({ now });
      if (!releaseVerification || releaseVerification.state !== "active") {
        throw new Error("active execution release verification is inactive");
      }
      const activeStatus = activeExecution.status();
      if (activeStatus.state === "inactive" || activeStatus.state === "stopped") {
        throw new Error("active execution lifecycle is inactive");
      }
      await assertCoordinatorServiceLeaseMode(serviceLease, "active-execution-only");
      if (now - lastIntegrityAt >= integritySeconds) {
        store.integrityCheck({ full: false });
        lastIntegrityAt = now;
      }
      const status = buildCoordinatorActiveExecutionStatus({
        store,
        serviceStartedAt: serviceLease.startedAt,
        heartbeatAt: wholeSecondIso(now),
        leaseIdentifier: serviceLease.leaseId,
        recoveredInterruptedActions: input.recoveredInterruptedActions,
        releaseVerification,
        activeExecution: activeStatus,
      });
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
    }, heartbeatSeconds * 1_000);
  }

  async function start() {
    if (lifecycle === "running") return false;
    if (lifecycle !== "created") throw new Error("active execution supervisor cannot be restarted");
    lifecycle = "starting";
    try {
      await activeExecution.start();
      if (lifecycle !== "starting") return false;
      await publishStatus();
      if (lifecycle !== "starting") return false;
      lifecycle = "running";
      void activeExecution.waitUntilStopped().then(
        () => {
          if (lifecycle === "running") {
            void stop("background-failure").catch(() => {});
          }
        },
        () => {
          if (lifecycle === "running") {
            void stop("background-failure").catch(() => {});
          }
        },
      );
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
      return Promise.reject(new TypeError("active execution shutdown reason is invalid"));
    }
    lifecycle = "stopping";
    if (timer) clearTimeout(timer);
    timer = null;
    let executionStop = null;
    let leaseRelease = null;
    let synchronousFailure = null;
    try {
      executionStop = activeExecution.stop();
    } catch (error) {
      synchronousFailure = error;
    }
    try {
      leaseRelease = serviceLease.release();
    } catch (error) {
      synchronousFailure ??= error;
    }
    shutdownPromise = (async () => {
      try {
        if (publishing) await publishing.catch(() => {});
        if (leaseRelease) await leaseRelease;
        if (executionStop) await executionStop;
        await activeExecution.waitUntilStopped();
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
