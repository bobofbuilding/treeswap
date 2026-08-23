import { CoordinatorStore } from "../../lib/coordinator-store.mjs";
import {
  acquireCoordinatorServiceLease,
  buildCoordinatorClosedStatus,
  normalizeCoordinatorServiceConfig,
} from "../../lib/coordinator-service-state.mjs";

function wholeSecondIso(milliseconds = Date.now()) {
  return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString();
}

async function run() {
  const config = normalizeCoordinatorServiceConfig();
  const lease = await acquireCoordinatorServiceLease(config);
  let store;
  let timer = null;
  let stopped = false;
  let rejectLoop;
  const stoppedPromise = new Promise((resolve, reject) => {
    rejectLoop = reject;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  try {
    store = await CoordinatorStore.open(config.databasePath);
    const recoveredInterruptedActions = store.recoverInterruptedActions(Math.floor(Date.now() / 1_000));
    let lastIntegrityAt = 0;
    const publish = async () => {
      const observedAt = Date.now();
      if (observedAt - lastIntegrityAt >= config.integritySeconds * 1_000) {
        store.integrityCheck({ full: false });
        lastIntegrityAt = observedAt;
      }
      await lease.publish(buildCoordinatorClosedStatus({
        store,
        serviceStartedAt: lease.startedAt,
        heartbeatAt: wholeSecondIso(observedAt),
        leaseIdentifier: lease.leaseId,
        recoveredInterruptedActions,
      }));
    };
    await publish();
    process.stdout.write(`${JSON.stringify({
      status: "ready-closed-no-funding-authority",
      schema: "treeswap.coordinator-service-status.v1",
    })}\n`);
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(async () => {
        try {
          await publish();
          schedule();
        } catch (error) {
          rejectLoop(error);
        }
      }, config.heartbeatSeconds * 1_000);
    };
    schedule();
    await stoppedPromise;
  } finally {
    if (timer) clearTimeout(timer);
    store?.close();
    await lease.release();
  }
}

run().catch((error) => {
  process.stderr.write(`closed coordinator supervisor failed: ${error?.message ?? "unknown error"}\n`);
  process.exitCode = 1;
});
