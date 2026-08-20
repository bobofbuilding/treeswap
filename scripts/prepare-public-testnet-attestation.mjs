import { lstat, readFile } from "node:fs/promises";
import { buildPublicTestnetAttestationMessage } from "../lib/public-testnet-evidence.mjs";

function argumentsFromCommandLine(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || !["--operator-id", "--policy", "--record", "--role"].includes(flag) || result[flag]) {
      throw new Error("Usage: prepare-public-testnet-attestation --record record.json --policy policy.json --role role --operator-id 0x...");
    }
    result[flag] = value;
  }
  if (Object.keys(result).length !== 4) {
    throw new Error("Usage: prepare-public-testnet-attestation --record record.json --policy policy.json --role role --operator-id 0x...");
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
const [record, policy] = await Promise.all([
  boundedJson(args["--record"], "record"),
  boundedJson(args["--policy"], "policy"),
]);
const message = buildPublicTestnetAttestationMessage({
  record,
  policy,
  role: args["--role"],
  operatorId: args["--operator-id"],
});
process.stdout.write(`${JSON.stringify({
  scope: "operator-attestation-only-no-funding-authorization",
  primaryType: "CampaignAttestation",
  domain: { ...message.domain, chainId: message.domain.chainId.toString() },
  types: message.types,
  message: message.value,
}, null, 2)}\n`);
