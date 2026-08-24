import { CoordinatorStore } from "../../lib/coordinator-store.mjs";
import {
  acquireCoordinatorServiceLease,
  buildCoordinatorClosedStatus,
  buildCoordinatorReleaseVerificationStatus,
  normalizeCoordinatorServiceConfig,
} from "../../lib/coordinator-service-state.mjs";
import { createCoordinatorReleaseVerificationSupervisor } from "../../lib/coordinator-release-supervisor.mjs";

function wholeSecondIso(milliseconds = Date.now()) {
  return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString();
}

async function run() {
  const config = normalizeCoordinatorServiceConfig();
  const lease = await acquireCoordinatorServiceLease(config);
  let store;
  let timer = null;
  let stopped = false;
  let releaseSupervisor = null;
  let stopLoop;
  const stoppedPromise = new Promise((resolve) => {
    stopLoop = resolve;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      releaseSupervisor?.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  try {
    store = await CoordinatorStore.open(config.databasePath);
    const recoveredInterruptedActions = store.recoverInterruptedActions(Math.floor(Date.now() / 1_000));
    if (config.mode === "release-verification-only") {
      releaseSupervisor = createCoordinatorReleaseVerificationSupervisor({
        manifestPath: config.releaseActivationManifestPath,
        timeoutMs: config.releaseProviderTimeoutMs,
      });
    }
    let lastIntegrityAt = 0;
    let nextReleaseRefreshAt = 0;
    const publish = async () => {
      let observedAt = Date.now();
      const observedAtSeconds = Math.floor(observedAt / 1_000);
      if (releaseSupervisor && observedAtSeconds >= nextReleaseRefreshAt) {
        await releaseSupervisor.refresh({ now: observedAtSeconds });
        nextReleaseRefreshAt = observedAtSeconds + config.releaseRefreshSeconds;
        observedAt = Date.now();
      }
      if (observedAt - lastIntegrityAt >= config.integritySeconds * 1_000) {
        store.integrityCheck({ full: false });
        lastIntegrityAt = observedAt;
      }
      const common = {
        store,
        serviceStartedAt: lease.startedAt,
        heartbeatAt: wholeSecondIso(observedAt),
        leaseIdentifier: lease.leaseId,
        recoveredInterruptedActions,
      };
      const status = releaseSupervisor
        ? buildCoordinatorReleaseVerificationStatus({
          ...common,
          releaseVerification: releaseSupervisor.status({ now: Math.floor(observedAt / 1_000) }),
        })
        : buildCoordinatorClosedStatus(common);
      await lease.publish(status);
      return status;
    };
    const firstStatus = await publish();
    process.stdout.write(`${JSON.stringify({
      status: firstStatus.mode === "closed"
        ? "ready-closed-no-funding-authority"
        : `running-release-verification-${firstStatus.releaseVerification.state}-no-dispatch-or-funding-authority`,
      schema: firstStatus.schema,
    })}\n`);
    const intervalSeconds = releaseSupervisor
      ? Math.min(config.heartbeatSeconds, config.releaseRefreshSeconds)
      : config.heartbeatSeconds;
    while (!stopped) {
      await Promise.race([
        new Promise((resolve) => {
          timer = setTimeout(resolve, intervalSeconds * 1_000);
        }),
        stoppedPromise,
      ]);
      timer = null;
      if (!stopped) await publish();
    }
  } finally {
    if (timer) clearTimeout(timer);
    releaseSupervisor?.stop();
    store?.close();
    await lease.release();
    stopLoop?.();
  }
}

run().catch((error) => {
  process.stderr.write(`coordinator supervisor failed: ${error?.message ?? "unknown error"}\n`);
  process.exitCode = 1;
});
