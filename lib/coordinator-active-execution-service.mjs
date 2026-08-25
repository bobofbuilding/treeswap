import { CoordinatorStore } from "./coordinator-store.mjs";
import {
  createCoordinatorActiveExecutionSupervisor,
} from "./coordinator-active-execution-supervisor.mjs";
import { createCoordinatorReleaseVerificationSupervisor } from "./coordinator-release-supervisor.mjs";
import {
  acquireCoordinatorServiceLease,
  assertCoordinatorServiceLeaseMode,
  buildCoordinatorActiveExecutionBootstrapStatus,
  normalizeCoordinatorServiceConfig,
} from "./coordinator-service-state.mjs";

const BOOTSTRAP_INPUT_KEYS = Object.freeze([
  "heartbeatSeconds",
  "integritySeconds",
  "intervalSeconds",
  "maxSettlementsPerCycle",
  "preparationTimeoutSeconds",
  "prepareExecutionPolicySet",
  "recordStatus",
  "recoveredInterruptedActions",
  "releaseRefreshSeconds",
  "releaseSupervisor",
  "serviceLease",
  "signal",
  "store",
]);

const SERVICE_INPUT_KEYS = Object.freeze([
  "environment",
  "fetchImpl",
  "prepareExecutionPolicySet",
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
    throw new TypeError("active execution abort signal is invalid");
  }
  return value;
}

function wholeSecondIso(seconds) {
  return new Date(seconds * 1_000).toISOString();
}

function stoppedReason(value) {
  if (!["requested", "startup-failure", "background-failure", "aborted"].includes(value)) {
    throw new TypeError("active execution shutdown reason is invalid");
  }
  return value;
}

export function createCoordinatorActiveExecutionBootstrap(input) {
  exactKeys(input, BOOTSTRAP_INPUT_KEYS, "coordinator active execution bootstrap");
  const heartbeatSeconds = boundedInteger(
    input.heartbeatSeconds,
    5,
    30,
    "active execution bootstrap heartbeat interval",
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
  const maxSettlementsPerCycle = boundedInteger(
    input.maxSettlementsPerCycle,
    1,
    64,
    "active execution maximum settlements per cycle",
  );
  const preparationTimeoutSeconds = boundedInteger(
    input.preparationTimeoutSeconds,
    10,
    300,
    "active execution preparation timeout",
  );
  if (!Number.isSafeInteger(input.recoveredInterruptedActions)
      || input.recoveredInterruptedActions < 0) {
    throw new TypeError("active execution recovered-action count is invalid");
  }
  if (typeof input.prepareExecutionPolicySet !== "function") {
    throw new TypeError("active execution policy preparation function is required");
  }
  if (typeof input.recordStatus !== "function") {
    throw new TypeError("active execution durable status recorder is required");
  }
  const externalSignal = abortSignal(input.signal);
  const { releaseSupervisor, serviceLease, store } = input;
  if (!releaseSupervisor || typeof releaseSupervisor.refresh !== "function"
      || typeof releaseSupervisor.status !== "function"
      || typeof releaseSupervisor.stop !== "function"
      || typeof releaseSupervisor.useActiveActivation !== "function") {
    throw new TypeError("active execution release supervisor is invalid");
  }
  if (!serviceLease || typeof serviceLease.publish !== "function"
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
    throw new Error("active execution bootstrap requires active same-process verification");
  }

  const preparationAbort = new AbortController();
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
      throw new Error("active execution bootstrap is not preparing");
    }
    if (bootstrapPublishing) {
      throw new Error("active execution bootstrap publication is already running");
    }
    const operation = (async () => {
      const now = Math.floor(Date.now() / 1_000);
      const verification = releaseSupervisor.status({ now });
      if (!verification || verification.state !== "active") {
        throw new Error("active execution bootstrap verification is inactive");
      }
      await assertCoordinatorServiceLeaseMode(serviceLease, "active-execution-only");
      const status = buildCoordinatorActiveExecutionBootstrapStatus({
        store,
        serviceStartedAt: serviceLease.startedAt,
        heartbeatAt: wholeSecondIso(now),
        leaseIdentifier: serviceLease.leaseId,
        recoveredInterruptedActions: input.recoveredInterruptedActions,
        releaseVerification: verification,
      });
      await input.recordStatus(status);
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
    }, heartbeatSeconds * 1_000);
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
    let executionStop = null;
    if (executionSupervisor) {
      try {
        executionStop = executionSupervisor.stop();
      } catch (error) {
        synchronousFailure = error;
      }
    } else {
      try {
        releaseSupervisor.stop();
      } catch (error) {
        synchronousFailure = error;
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
    if (lifecycle !== "created") throw new Error("active execution bootstrap cannot be restarted");
    lifecycle = "starting";
    try {
      if (externalSignal?.aborted) throw new Error("active execution bootstrap was aborted");
      await publishPreparationStatus();
      scheduleHeartbeat();
      preparationTimer = setTimeout(() => {
        void stop("background-failure").catch(() => {});
      }, preparationTimeoutSeconds * 1_000);
      const operation = Promise.resolve().then(() => input.prepareExecutionPolicySet(Object.freeze({
        abortSignal: preparationAbort.signal,
        releaseSupervisor,
        serviceLease,
        store,
      })));
      preparation = operation;
      const policyPreparation = await operation;
      if (preparation === operation) preparation = null;
      if (lifecycle !== "starting") {
        throw new Error("active execution bootstrap stopped during preparation");
      }
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (preparationTimer) clearTimeout(preparationTimer);
      heartbeatTimer = null;
      preparationTimer = null;
      if (bootstrapPublishing) await bootstrapPublishing;
      if (lifecycle !== "starting") {
        throw new Error("active execution bootstrap stopped during preparation handoff");
      }
      const now = Math.floor(Date.now() / 1_000);
      const verification = releaseSupervisor.status({ now });
      if (!verification || verification.state !== "active") {
        throw new Error("active execution bootstrap verification expired during preparation");
      }
      if (!policyPreparation || policyPreparation.releaseRecordDigest !== verification.recordDigest) {
        throw new Error("active execution policy set is bound to another verified release");
      }
      await assertCoordinatorServiceLeaseMode(serviceLease, "active-execution-only");
      executionSupervisor = createCoordinatorActiveExecutionSupervisor({
        heartbeatSeconds,
        integritySeconds,
        intervalSeconds,
        maxSettlementsPerCycle,
        policyPreparation,
        recordStatus: input.recordStatus,
        recoveredInterruptedActions: input.recoveredInterruptedActions,
        releaseRefreshSeconds,
        releaseSupervisor,
        serviceLease,
        store,
      });
      await executionSupervisor.start();
      if (lifecycle !== "starting") {
        await executionSupervisor.stop();
        throw new Error("active execution bootstrap stopped during execution startup");
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
      throw new Error("active execution bootstrap is stopped");
    }
    throw new Error("active execution bootstrap has not started");
  }

  return Object.freeze({
    publishStatus,
    start,
    status: () => executionSupervisor?.status() ?? latestBootstrapStatus,
    stop: () => stop("requested"),
    waitUntilStopped: () => stoppedPromise,
  });
}

export async function startCoordinatorActiveExecutionService(input) {
  exactKeys(input, SERVICE_INPUT_KEYS, "coordinator active execution service");
  if (!input.environment || typeof input.environment !== "object" || Array.isArray(input.environment)) {
    throw new TypeError("coordinator active execution environment is invalid");
  }
  if (typeof input.fetchImpl !== "function") {
    throw new TypeError("coordinator active execution fetch implementation is required");
  }
  if (typeof input.prepareExecutionPolicySet !== "function") {
    throw new TypeError("coordinator active execution policy preparation function is required");
  }
  const signal = abortSignal(input.signal);
  const config = normalizeCoordinatorServiceConfig(input.environment);
  if (config.mode !== "active-execution-only") {
    throw new Error("coordinator active execution service requires active-execution-only mode");
  }
  if (signal?.aborted) throw new Error("coordinator active execution service was aborted");

  let lease = null;
  let store = null;
  let releaseSupervisor = null;
  let bootstrap = null;
  let serviceRun = null;
  let cleanupPromise = null;

  function cleanup(reason) {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let failure = null;
      try {
        releaseSupervisor?.stop();
      } catch (error) {
        failure = error;
      }
      if (store) {
        if (serviceRun) {
          try {
            store.finishServiceRun({
              handle: serviceRun.handle,
              finishedAt: Math.floor(Date.now() / 1_000),
              reason,
            });
          } catch (error) {
            failure ??= error;
          }
          serviceRun = null;
        }
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
    serviceRun = store.beginServiceRun({
      mode: config.mode,
      startedAt: Math.floor(Date.parse(lease.startedAt) / 1_000),
      failureWindowSeconds: config.activeFailureWindowSeconds,
      maximumFailures: config.activeMaximumFailures,
    });
    releaseSupervisor = createCoordinatorReleaseVerificationSupervisor({
      manifestPath: config.releaseActivationManifestPath,
      environment: input.environment,
      fetchImpl: input.fetchImpl,
      timeoutMs: config.releaseProviderTimeoutMs,
    });
    const verification = await releaseSupervisor.refresh({ now: Math.floor(Date.now() / 1_000) });
    if (!verification || verification.state !== "active") {
      throw new Error("coordinator active execution service verification is inactive");
    }
    if (signal?.aborted) throw new Error("coordinator active execution service was aborted");
    bootstrap = createCoordinatorActiveExecutionBootstrap({
      heartbeatSeconds: config.heartbeatSeconds,
      integritySeconds: config.integritySeconds,
      intervalSeconds: config.activeExecutionIntervalSeconds,
      maxSettlementsPerCycle: config.activeMaxSettlementsPerCycle,
      preparationTimeoutSeconds: config.activePreparationTimeoutSeconds,
      prepareExecutionPolicySet: input.prepareExecutionPolicySet,
      recordStatus: async (status) => {
        if (!serviceRun || !store) throw new Error("active execution service run is unavailable");
        store.recordServiceRunStatus({
          handle: serviceRun.handle,
          observedAt: Math.floor(Date.parse(status.heartbeatAt) / 1_000),
          status,
        });
      },
      recoveredInterruptedActions,
      releaseRefreshSeconds: config.releaseRefreshSeconds,
      releaseSupervisor,
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
    else releaseSupervisor?.stop();
    await cleanup(signal?.aborted ? "aborted" : "startup-failure").catch(() => {});
    throw error;
  }
}
