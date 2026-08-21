#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import { buildServiceIsolationAttestationMessage } from "../lib/service-isolation-evidence.mjs";

const USAGE = "Usage: prepare-service-isolation-attestation --record record.json --policy policy.json --role role --operator-id 0x...";

function argumentsFromCommandLine(values) {
  const allowed = new Set(["--operator-id", "--policy", "--record", "--role"]);
  if (values.length !== 8) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!allowed.has(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  return result;
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const [record, policy] = await Promise.all([
  readBoundedJson(args["--record"], "service isolation record"),
  readBoundedJson(args["--policy"], "service isolation policy"),
]);
const typed = buildServiceIsolationAttestationMessage({
  record,
  policy,
  role: args["--role"],
  operatorId: args["--operator-id"],
});
process.stdout.write(`${JSON.stringify({
  scope: "service-isolation-attestation-only-no-secrets-signing-or-funding-authorization",
  primaryType: "ServiceIsolationAttestation",
  domain: Object.freeze({ ...typed.domain, chainId: typed.domain.chainId.toString() }),
  types: typed.types,
  message: typed.value,
}, null, 2)}\n`);
