import { readFile } from "node:fs/promises";
import { evaluateLightningCloseCollectorQuorum } from "../lib/lightning-close-collector.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name, maximum) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

let serialized = "";
for await (const chunk of process.stdin) {
  serialized += chunk;
  if (Buffer.byteLength(serialized) > 524_288) throw new Error("collector quorum input exceeds 512 KiB");
}

let input;
try {
  input = JSON.parse(serialized);
} catch {
  throw new Error("collector quorum input is not valid JSON");
}
if (!input || typeof input !== "object" || Array.isArray(input)) {
  throw new TypeError("collector quorum input must be an object");
}
const keys = Object.keys(input).sort();
if (keys.length !== 2 || keys[0] !== "attestations" || keys[1] !== "now") {
  throw new TypeError("collector quorum input fields are not exact");
}

const collectors = await Promise.all([
  Object.freeze({
    collectorId: required("LIGHTNING_CLOSE_COLLECTOR_A_ID"),
    publicKey: await readFile(required("LIGHTNING_CLOSE_COLLECTOR_A_PUBLIC_KEY_PATH")),
  }),
  Object.freeze({
    collectorId: required("LIGHTNING_CLOSE_COLLECTOR_B_ID"),
    publicKey: await readFile(required("LIGHTNING_CLOSE_COLLECTOR_B_PUBLIC_KEY_PATH")),
  }),
]);

const result = evaluateLightningCloseCollectorQuorum({
  attestations: input.attestations,
  collectors,
  expectedNodeCommitment: required("LIGHTNING_NODE_COMMITMENT"),
  now: input.now,
  maximumLifetimeSeconds: integer("MAXIMUM_COLLECTOR_ATTESTATION_LIFETIME_SECONDS", 60),
  maximumClockSkewSeconds: integer("MAXIMUM_COLLECTOR_CLOCK_SKEW_SECONDS", 60),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
