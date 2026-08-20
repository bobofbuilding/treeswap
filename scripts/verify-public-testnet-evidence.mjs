import { lstat, readFile } from "node:fs/promises";
import {
  buildPublicTestnetAdoptionSummary,
  buildPublicTestnetReleaseEvidence,
  verifyPublicTestnetCampaign,
} from "../lib/public-testnet-evidence.mjs";

function argumentsFromCommandLine(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || !["--attestations", "--policy", "--record"].includes(flag) || result[flag]) {
      throw new Error("Usage: verify-public-testnet-evidence --record record.json --policy policy.json --attestations attestations.json");
    }
    result[flag] = value;
  }
  if (Object.keys(result).length !== 3) {
    throw new Error("Usage: verify-public-testnet-evidence --record record.json --policy policy.json --attestations attestations.json");
  }
  return result;
}

async function boundedJson(path, name) {
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink() || state.size === 0 || state.size > 1_000_000) {
    throw new Error(`${name} must be a non-symlink JSON file no larger than 1 MB`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const [record, policy, attestations] = await Promise.all([
  boundedJson(args["--record"], "record"),
  boundedJson(args["--policy"], "policy"),
  boundedJson(args["--attestations"], "attestations"),
]);
const verification = verifyPublicTestnetCampaign({ record, policy, attestations });
process.stdout.write(`${JSON.stringify({
  status: verification.status,
  scope: verification.scope,
  recordDigest: verification.recordDigest,
  policyDigest: verification.policyDigest,
  releaseEvidence: buildPublicTestnetReleaseEvidence(verification),
  adoptionSummary: buildPublicTestnetAdoptionSummary(verification),
}, null, 2)}\n`);
