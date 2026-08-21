#!/usr/bin/env node

import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildOperationalReadinessEvidenceSummary,
  verifyOperationalReadinessEvidence,
} from "../lib/operational-readiness-evidence.mjs";
import { verifyServiceIsolationEvidence } from "../lib/service-isolation-evidence.mjs";

const USAGE = "Usage: verify-operational-readiness-evidence --record record.json --policy policy.json --attestations attestations.json --isolation-record isolation-record.json --isolation-policy isolation-policy.json --isolation-attestations isolation-attestations.json";

function argumentsFromCommandLine(values) {
  const allowed = new Set([
    "--attestations",
    "--isolation-attestations",
    "--isolation-policy",
    "--isolation-record",
    "--policy",
    "--record",
  ]);
  if (values.length !== 12) throw new Error(USAGE);
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
const [record, policy, attestations, isolationRecord, isolationPolicy, isolationAttestations] = await Promise.all([
  readBoundedJson(args["--record"], "operational readiness record"),
  readBoundedJson(args["--policy"], "operational readiness policy"),
  readBoundedJson(args["--attestations"], "operational readiness attestations"),
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
const verification = verifyOperationalReadinessEvidence({
  record,
  policy,
  attestations,
  serviceIsolationVerification,
});
process.stdout.write(`${JSON.stringify(buildOperationalReadinessEvidenceSummary(verification), null, 2)}\n`);
