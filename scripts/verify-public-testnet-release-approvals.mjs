#!/usr/bin/env node

import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  createPublicTestnetReleaseApprovalProviderSet,
  inspectPreparedPublicTestnetReleaseCandidate,
  verifyPublicTestnetReleaseApprovals,
} from "../lib/public-testnet-release-approval.mjs";

const FLAGS = Object.freeze(["--approvals", "--candidate", "--out", "--providers"]);
const USAGE = "Usage: verify-public-testnet-release-approvals --candidate release-candidate.json --approvals approvals.json --providers providers.json --out verification-receipt.json";

function argumentsFromCommandLine(values) {
  if (values.length !== FLAGS.length * 2) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || !FLAGS.includes(flag) || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  return result;
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const [candidate, approvalBundle, providerConfiguration] = await Promise.all([
  readBoundedJson(args["--candidate"], "prepared public-testnet release candidate"),
  readBoundedJson(args["--approvals"], "public-testnet release approval bundle"),
  readBoundedJson(args["--providers"], "public-testnet release approval provider configuration", {
    maximumBytes: 65_536,
  }),
]);
const inspected = inspectPreparedPublicTestnetReleaseCandidate(candidate);
const providerSet = createPublicTestnetReleaseApprovalProviderSet({
  configuration: providerConfiguration,
  expectedProviderCount: inspected.candidate.record.counts.independentEvmProviders,
  expectedProviderSetDigest: inspected.candidate.record.approvalProviderSetDigest,
});
const receipt = await verifyPublicTestnetReleaseApprovals({
  candidate: inspected.candidate,
  approvalBundle,
  providers: providerSet.providers,
});
if (Buffer.byteLength(JSON.stringify(receipt)) > 1_000_000) {
  throw new Error("public-testnet release approval verification receipt exceeds 1 MB");
}
const output = await writeExclusiveJson(args["--out"], receipt);
process.stdout.write(`${JSON.stringify({
  schema: receipt.schema,
  status: receipt.status,
  scope: receipt.scope,
  releaseId: receipt.releaseId,
  recordDigest: receipt.recordDigest,
  policyDigest: receipt.policyDigest,
  approvalBundleDigest: receipt.approvalBundleDigest,
  approvalCount: receipt.approvalCount,
  providerQuorum: receipt.providerQuorum,
  output,
  signingAuthorization: false,
  broadcastAuthorization: false,
  gateOpeningAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
