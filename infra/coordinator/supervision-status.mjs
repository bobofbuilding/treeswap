import { CoordinatorStore } from "../../lib/coordinator-store.mjs";
import { normalizeCoordinatorServiceConfig } from "../../lib/coordinator-service-state.mjs";

try {
  const config = normalizeCoordinatorServiceConfig();
  if (config.mode !== "active-execution-only") {
    throw new Error("coordinator supervision status requires active-execution-only mode");
  }
  const status = await CoordinatorStore.inspectServiceRunStatus(config.databasePath);
  process.stdout.write(`${JSON.stringify(status)}\n`);
  if (status.state !== "RUNNING" || status.lastStatusHealthy !== true || status.crashLoopOpen) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`coordinator supervision status failed: ${error?.message ?? "unknown error"}\n`);
  process.exitCode = 1;
}
