#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import { buildPublicTestnetBootstrapAttestationMessage } from "../lib/public-testnet-bootstrap-evidence.mjs";

const USAGE = "Usage: prepare-public-testnet-bootstrap-attestation --record record.json --policy policy.json --role role --operator-id 0x...";

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
  readBoundedJson(args["--record"], "bootstrap evidence record"),
  readBoundedJson(args["--policy"], "bootstrap evidence policy"),
]);
const typed = buildPublicTestnetBootstrapAttestationMessage({
  record,
  policy,
  role: args["--role"],
  operatorId: args["--operator-id"],
});
process.stdout.write(`${JSON.stringify({
  scope: "bootstrap-operator-attestation-only-no-signing-or-funding-authorization",
  primaryType: "BootstrapOperatorAttestation",
  domain: Object.freeze({ ...typed.domain, chainId: typed.domain.chainId.toString() }),
  types: typed.types,
  message: typed.value,
}, null, 2)}\n`);
