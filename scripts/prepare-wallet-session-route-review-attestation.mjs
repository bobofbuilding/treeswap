#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readBoundedFile,
  readBoundedJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildWalletSessionRouteReviewApprovalMessage,
  prepareWalletSessionRouteReviewCandidate,
} from "../lib/wallet-session-route-review.mjs";
import {
  revalidatePublishedWalletSessionRouteReviewSource,
  verifyPublishedWalletSessionRouteReviewArtifact,
} from "../lib/wallet-session-route-review-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = Object.freeze(["--artifact", "--policy", "--reports", "--role"]);
const USAGE = "Usage: npm run prepare:wallet-session-route-review-attestation -- --artifact artifact.json --policy policy.json --reports reports.json --role reviewer-role";

function parseArguments(values) {
  if (values.length !== REQUIRED.length * 2) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!REQUIRED.includes(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = flag === "--role" ? value : resolve(value);
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [artifactFileBytes, policy, reports] = await Promise.all([
    readBoundedFile(options["--artifact"], "wallet session route review artifact"),
    readBoundedJson(options["--policy"], "wallet session route review policy", { maximumBytes: 65_536 }),
    readBoundedJson(options["--reports"], "wallet session route review reports", { maximumBytes: 65_536 }),
  ]);
  const candidate = prepareWalletSessionRouteReviewCandidate({ artifactFileBytes, policy, reports });
  verifyPublishedWalletSessionRouteReviewArtifact({
    repository,
    artifactFileBytes,
    artifact: candidate.artifact,
  });
  const typed = buildWalletSessionRouteReviewApprovalMessage({
    artifactFileBytes,
    policy,
    reports,
    role: options["--role"],
  });
  revalidatePublishedWalletSessionRouteReviewSource(repository, candidate.artifact);
  process.stdout.write(`${JSON.stringify({
    scope: "wallet-session-route-review-attestation-only-no-signing-deployment-or-funding-authorization",
    primaryType: "WalletSessionRouteReviewApproval",
    domain: typed.domain,
    types: typed.types,
    message: typed.value,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "wallet session route review attestation preparation failed"}\n`);
  process.exitCode = 1;
});
