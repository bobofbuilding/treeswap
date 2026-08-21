#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import { buildOperationalReadinessAttestationMessage } from "../lib/operational-readiness-evidence.mjs";
import { verifyServiceIsolationEvidence } from "../lib/service-isolation-evidence.mjs";

const USAGE = "Usage: prepare-operational-readiness-attestation --record record.json --policy policy.json --isolation-record isolation-record.json --isolation-policy isolation-policy.json --isolation-attestations isolation-attestations.json --role role --operator-id 0x...";

function argumentsFromCommandLine(values) {
  const allowed = new Set([
    "--isolation-attestations",
    "--isolation-policy",
    "--isolation-record",
    "--operator-id",
    "--policy",
    "--record",
    "--role",
  ]);
  if (values.length !== 14) throw new Error(USAGE);
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
const [record, policy, isolationRecord, isolationPolicy, isolationAttestations] = await Promise.all([
  readBoundedJson(args["--record"], "operational readiness record"),
  readBoundedJson(args["--policy"], "operational readiness policy"),
  readBoundedJson(args["--isolation-record"], "service isolation record"),
  readBoundedJson(args["--isolation-policy"], "service isolation policy"),
  readBoundedJson(args["--isolation-attestations"], "service isolation attestations"),
]);
const serviceIsolationVerification = verifyServiceIsolationEvidence({
  record: isolationRecord,
  policy: isolationPolicy,
  attestations: isolationAttestations,
  now: record.preparedAt,
});
const typed = buildOperationalReadinessAttestationMessage({
  record,
  policy,
  serviceIsolationVerification,
  role: args["--role"],
  operatorId: args["--operator-id"],
});
process.stdout.write(`${JSON.stringify({
  scope: "operational-readiness-attestation-only-no-signing-or-funding-authorization",
  primaryType: "OperationalReadinessAttestation",
  domain: Object.freeze({ ...typed.domain, chainId: typed.domain.chainId.toString() }),
  types: typed.types,
  message: typed.value,
}, null, 2)}\n`);
