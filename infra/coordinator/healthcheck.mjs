import {
  normalizeCoordinatorServiceConfig,
  readCoordinatorServiceHealth,
} from "../../lib/coordinator-service-state.mjs";

try {
  const health = await readCoordinatorServiceHealth(normalizeCoordinatorServiceConfig());
  process.stdout.write(`${JSON.stringify(health)}\n`);
} catch (error) {
  process.stderr.write(`coordinator health check failed: ${error?.message ?? "unknown error"}\n`);
  process.exitCode = 1;
}
