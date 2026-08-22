import { spawnSync } from "node:child_process";

export function destroyQualificationRegtest({
  repository,
  run = spawnSync,
  environment = process.env,
  stdio = "inherit",
} = {}) {
  if (typeof repository !== "string" || repository.length === 0) {
    throw new TypeError("qualification repository is required");
  }
  if (typeof run !== "function") throw new TypeError("qualification process runner is required");

  const result = run("npm", ["run", "regtest:destroy"], {
    cwd: repository,
    env: environment,
    stdio,
  });
  if (!result || result.status !== 0) {
    throw new Error("qualification regtest destruction failed");
  }
}
