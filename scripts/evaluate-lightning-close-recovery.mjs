import {
  DEFAULT_LIGHTNING_CLOSE_POLICY,
  evaluateLightningCloseRecovery,
} from "../lib/lightning-close-monitor.mjs";

if (process.argv.length !== 2) {
  throw new Error("Usage: node scripts/evaluate-lightning-close-recovery.mjs < observation.json");
}

let serialized = "";
for await (const chunk of process.stdin) {
  serialized += chunk;
  if (Buffer.byteLength(serialized) > 2_097_152) throw new Error("Lightning close observation exceeds 2 MiB");
}

let input;
try {
  input = JSON.parse(serialized);
} catch {
  throw new Error("Lightning close observation is not valid JSON");
}
if (!input || typeof input !== "object" || Array.isArray(input)) {
  throw new TypeError("Lightning close observation must be an object");
}
const keys = Object.keys(input).sort();
const expected = ["blockHeight", "observedAt", "pendingChannels", "pendingSweeps"];
if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
  throw new TypeError("Lightning close observation fields are not exact");
}

const evidence = evaluateLightningCloseRecovery({
  ...input,
  policy: DEFAULT_LIGHTNING_CLOSE_POLICY,
});
process.stdout.write(`${JSON.stringify(evidence)}\n`);
