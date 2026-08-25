import { CoordinatorStore } from "./coordinator-store.mjs";
import {
  createCoordinatorRecoveryExecutionSupervisor,
} from "./coordinator-recovery-execution-supervisor.mjs";
import { createCoordinatorRecoveryVerificationSupervisor } from "./coordinator-recovery-supervisor.mjs";
import {
  acquireCoordinatorServiceLease,
  assertCoordinatorServiceLeaseOwnership,
  buildCoordinatorRecoveryExecutionBootstrapStatus,
  normalizeCoordinatorServiceConfig,
} from "./coordinator-service-state.mjs";

const BOOTSTRAP_INPUT_KEYS = Object.freeze([
  "heartbeatSeconds",
  "intervalSeconds",
  "preparationTimeoutSeconds",
  "prepareJobSetVerification",
  "recoveredInterruptedActions",
  "recoveryRefreshSeconds",
  "recoverySupervisor",
  "serviceLease",
  "signal",
  "store",
]);

const SERVICE_INPUT_KEYS = Object.freeze([
  "environment",
  "fetchImpl",
  "prepareJobSetVerification",
  "signal",
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

function abortSignal(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean"
      || typeof value.addEventListener !== "function"
      || typeof value.removeEventListener !== "function") {
    throw new TypeError("recovery execution abort signal is invalid");
  }
  return value;
}

function wholeSecondIso(seconds) {
  return new Date(seconds * 1_000).toISOString();
}

function stoppedReason(value) {
  if (!["requested", "startup-failure", "background-failure", "aborted"].includes(value)) {
    throw new TypeError("recovery execution shutdown reason is invalid");
  }
  return value;
}

export function createCoordinatorRecoveryExecutionBootstrap(input) {
  exactKeys(input, BOOTSTRAP_INPUT_KEYS, "coordinator recovery execution bootstrap");
  const heartbeatSeconds = boundedInteger(
    input.heartbeatSeconds,
    5,
    30,
    "recovery execution bootstrap heartbeat interval",
  );
  const intervalSeconds = boundedInteger(
    input.intervalSeconds,
    5,
    30,
    "recovery execution action interval",
  );
  const preparationTimeoutSeconds = boundedInteger(
    input.preparationTimeoutSeconds,
    10,
    300,
    "recovery execution preparation timeout",
  );
  const recoveryRefreshSeconds = boundedInteger(
    input.recoveryRefreshSeconds,
    5,
    30,
    "recovery execution verification refresh interval",
  );
  if (!Number.isSafeInteger(input.recoveredInterruptedActions)
      || input.recoveredInterruptedActions < 0) {
    throw new TypeError("recovery execution recovered-action count is invalid");
  }
  if (typeof input.prepareJobSetVerification !== "function") {
    throw new TypeError("recovery execution job-set preparation function is required");
  }
  const externalSignal = abortSignal(input.signal);
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
    throw new Error("recovery execution bootstrap requires active same-process verification");
  }

  const preparationAbort = new AbortController();
  const tickSeconds = Math.min(heartbeatSeconds, recoveryRefreshSeconds);
  let lifecycle = "created";
  let latestBootstrapStatus = null;
  let bootstrapPublishing = null;
  let preparation = null;
  let preparationTimer = null;
  let heartbeatTimer = null;
  let executionSupervisor = null;
  let shutdownPromise = null;
  let resolveStopped;
  let rejectStopped;
  const stoppedPromise = new Promise((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  stoppedPromise.catch(() => {});

  async function publishPreparationStatus() {
    if (lifecycle !== "starting") {
      throw new Error("recovery execution bootstrap is not preparing");
    }
    if (bootstrapPublishing) {
      throw new Error("recovery execution bootstrap publication is already running");
    }
    const operation = (async () => {
      const now = Math.floor(Date.now() / 1_000);
      const verification = recoverySupervisor.status({ now });
      if (!verification || verification.state !== "active") {
        throw new Error("recovery execution bootstrap verification is inactive");
      }
      await assertCoordinatorServiceLeaseOwnership(serviceLease);
      const status = buildCoordinatorRecoveryExecutionBootstrapStatus({
        store,
        serviceStartedAt: serviceLease.startedAt,
        heartbeatAt: wholeSecondIso(now),
        leaseIdentifier: serviceLease.leaseId,
        recoveredInterruptedActions: input.recoveredInterruptedActions,
        recoveryVerification: verification,
      });
      await serviceLease.publish(status);
      latestBootstrapStatus = status;
      return status;
    })();
    bootstrapPublishing = operation;
    try {
      return await operation;
    } finally {
      if (bootstrapPublishing === operation) bootstrapPublishing = null;
    }
  }

  function scheduleHeartbeat() {
    if (lifecycle !== "starting") return;
    heartbeatTimer = setTimeout(async () => {
      heartbeatTimer = null;
      if (lifecycle !== "starting") return;
      try {
        await publishPreparationStatus();
      } catch {
        void stop("background-failure").catch(() => {});
        return;
      }
      scheduleHeartbeat();
    }, tickSeconds * 1_000);
  }

  function stop(reason = "requested") {
    if (shutdownPromise) return shutdownPromise;
    const finalReason = stoppedReason(reason);
    lifecycle = "stopping";
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (preparationTimer) clearTimeout(preparationTimer);
    heartbeatTimer = null;
    preparationTimer = null;
    preparationAbort.abort();
    let synchronousFailure = null;
    try {
      recoverySupervisor.stop();
    } catch (error) {
      synchronousFailure = error;
    }
    let executionStop = null;
    if (executionSupervisor) {
      try {
        executionStop = executionSupervisor.stop();
      } catch (error) {
        synchronousFailure ??= error;
      }
    }
    shutdownPromise = (async () => {
      try {
        if (bootstrapPublishing) await bootstrapPublishing.catch(() => {});
        if (preparation) await preparation.catch(() => {});
        if (executionStop) await executionStop;
        if (executionSupervisor) await executionSupervisor.waitUntilStopped();
        if (synchronousFailure) throw synchronousFailure;
        lifecycle = "stopped";
        if (externalSignal) externalSignal.removeEventListener("abort", externalAbort);
        const result = Object.freeze({ reason: finalReason });
        resolveStopped(result);
        return result;
      } catch (error) {
        lifecycle = "stopped";
        if (externalSignal) externalSignal.removeEventListener("abort", externalAbort);
        rejectStopped(error);
        throw error;
      }
    })();
    shutdownPromise.catch(() => {});
    return shutdownPromise;
  }

  function externalAbort() {
    void stop("aborted").catch(() => {});
  }

  if (externalSignal) externalSignal.addEventListener("abort", externalAbort, { once: true });

  async function start() {
    if (lifecycle === "running") return false;
    if (lifecycle !== "created") throw new Error("recovery execution bootstrap cannot be restarted");
    lifecycle = "starting";
    try {
      if (externalSignal?.aborted) throw new Error("recovery execution bootstrap was aborted");
      await publishPreparationStatus();
      scheduleHeartbeat();
      preparationTimer = setTimeout(() => {
        void stop("background-failure").catch(() => {});
      }, preparationTimeoutSeconds * 1_000);
      const operation = Promise.resolve().then(() => input.prepareJobSetVerification(Object.freeze({
        abortSignal: preparationAbort.signal,
        recoverySupervisor,
        serviceLease,
        store,
      })));
      preparation = operation;
      const jobSetVerification = await operation;
      if (preparation === operation) preparation = null;
      if (lifecycle !== "starting") {
        throw new Error("recovery execution bootstrap stopped during preparation");
      }
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (preparationTimer) clearTimeout(preparationTimer);
      heartbeatTimer = null;
      preparationTimer = null;
      if (bootstrapPublishing) await bootstrapPublishing;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
      if (lifecycle !== "starting") {
        throw new Error("recovery execution bootstrap stopped during preparation handoff");
      }
      const now = Math.floor(Date.now() / 1_000);
      const verification = recoverySupervisor.status({ now });
      if (!verification || verification.state !== "active") {
        throw new Error("recovery execution bootstrap verification expired during preparation");
      }
      await assertCoordinatorServiceLeaseOwnership(serviceLease);
      executionSupervisor = createCoordinatorRecoveryExecutionSupervisor({
        heartbeatSeconds,
        intervalSeconds,
        jobSetVerification,
        recoveredInterruptedActions: input.recoveredInterruptedActions,
        recoveryRefreshSeconds,
        recoverySupervisor,
        serviceLease,
        store,
      });
      await executionSupervisor.start();
      if (lifecycle !== "starting") {
        await executionSupervisor.stop();
        throw new Error("recovery execution bootstrap stopped during execution startup");
      }
      lifecycle = "running";
      void executionSupervisor.waitUntilStopped().then(
        ({ reason }) => {
          if (lifecycle === "running") {
            void stop(reason === "background-failure" ? reason : "background-failure").catch(() => {});
          }
        },
        () => {
          if (lifecycle === "running") void stop("background-failure").catch(() => {});
        },
      );
      return true;
    } catch (error) {
      if (preparation && lifecycle === "starting") preparation = null;
      const reason = externalSignal?.aborted ? "aborted" : "startup-failure";
      await stop(reason).catch(() => {});
      throw error;
    }
  }

  async function publishStatus() {
    if (lifecycle === "starting") return publishPreparationStatus();
    if (lifecycle === "running" && executionSupervisor) {
      return executionSupervisor.publishStatus();
    }
    if (["stopping", "stopped"].includes(lifecycle)) {
      throw new Error("recovery execution bootstrap is stopped");
    }
    throw new Error("recovery execution bootstrap has not started");
  }

  return Object.freeze({
    publishStatus,
    start,
    status: () => executionSupervisor?.status() ?? latestBootstrapStatus,
    stop: () => stop("requested"),
    waitUntilStopped: () => stoppedPromise,
  });
}

export async function startCoordinatorRecoveryExecutionService(input) {
  exactKeys(input, SERVICE_INPUT_KEYS, "coordinator recovery execution service");
  if (!input.environment || typeof input.environment !== "object" || Array.isArray(input.environment)) {
    throw new TypeError("coordinator recovery execution environment is invalid");
  }
  if (typeof input.fetchImpl !== "function") {
    throw new TypeError("coordinator recovery execution fetch implementation is required");
  }
  if (typeof input.prepareJobSetVerification !== "function") {
    throw new TypeError("coordinator recovery execution job-set preparation function is required");
  }
  const signal = abortSignal(input.signal);
  const config = normalizeCoordinatorServiceConfig(input.environment);
  if (config.mode !== "recovery-execution-only") {
    throw new Error("coordinator recovery execution service requires recovery-execution-only mode");
  }
  if (signal?.aborted) throw new Error("coordinator recovery execution service was aborted");

  let lease = null;
  let store = null;
  let recoverySupervisor = null;
  let bootstrap = null;
  let cleanupPromise = null;

  function cleanup(reason) {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let failure = null;
      try {
        recoverySupervisor?.stop();
      } catch (error) {
        failure = error;
      }
      if (store) {
        try {
          store.close();
        } catch (error) {
          failure ??= error;
        }
        store = null;
      }
      let leaseReleased = false;
      if (lease) {
        try {
          leaseReleased = await lease.release();
        } catch (error) {
          failure ??= error;
        }
        lease = null;
      }
      if (failure) throw failure;
      return Object.freeze({ reason, leaseReleased });
    })();
    cleanupPromise.catch(() => {});
    return cleanupPromise;
  }

  try {
    lease = await acquireCoordinatorServiceLease(config);
    store = await CoordinatorStore.open(config.databasePath);
    const recoveredInterruptedActions = store.recoverInterruptedActions(
      Math.floor(Date.now() / 1_000),
    );
    recoverySupervisor = createCoordinatorRecoveryVerificationSupervisor({
      manifestPath: config.recoveryActivationManifestPath,
      environment: input.environment,
      fetchImpl: input.fetchImpl,
      timeoutMs: config.recoveryProviderTimeoutMs,
    });
    const verification = await recoverySupervisor.refresh({ now: Math.floor(Date.now() / 1_000) });
    if (!verification || verification.state !== "active") {
      throw new Error("coordinator recovery execution service verification is inactive");
    }
    if (signal?.aborted) throw new Error("coordinator recovery execution service was aborted");
    bootstrap = createCoordinatorRecoveryExecutionBootstrap({
      heartbeatSeconds: config.heartbeatSeconds,
      intervalSeconds: config.recoveryActionIntervalSeconds,
      preparationTimeoutSeconds: config.recoveryPreparationTimeoutSeconds,
      prepareJobSetVerification: input.prepareJobSetVerification,
      recoveredInterruptedActions,
      recoveryRefreshSeconds: config.recoveryRefreshSeconds,
      recoverySupervisor,
      serviceLease: lease,
      signal,
      store,
    });
    const stoppedPromise = bootstrap.waitUntilStopped().then(
      ({ reason }) => cleanup(reason),
      async (error) => {
        await cleanup("background-failure").catch(() => {});
        throw error;
      },
    );
    stoppedPromise.catch(() => {});
    await bootstrap.start();
    return Object.freeze({
      status: () => bootstrap.status(),
      stop: async () => {
        await bootstrap.stop();
        return stoppedPromise;
      },
      waitUntilStopped: () => stoppedPromise,
    });
  } catch (error) {
    if (bootstrap) await bootstrap.stop().catch(() => {});
    else recoverySupervisor?.stop();
    await cleanup(signal?.aborted ? "aborted" : "startup-failure").catch(() => {});
    throw error;
  }
}
