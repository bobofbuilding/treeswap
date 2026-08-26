#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readBoundedFile,
  readBoundedJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildWalletSessionRouteDeploymentPreflightMessage,
} from "../lib/wallet-session-route-deployment-preflight.mjs";
import {
  prepareWalletSessionRouteReviewCandidate,
  verifyWalletSessionRouteReview,
} from "../lib/wallet-session-route-review.mjs";
import {
  revalidatePublishedWalletSessionRouteReviewSource,
  verifyPublishedWalletSessionRouteReviewArtifact,
} from "../lib/wallet-session-route-review-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = Object.freeze([
  "--review-artifact",
  "--review-policy",
  "--review-reports",
  "--review-attestations",
  "--plan",
  "--role",
]);
const USAGE = "Usage: npm run prepare:wallet-session-route-deployment-preflight-attestation -- --review-artifact artifact.json --review-policy policy.json --review-reports reports.json --review-attestations attestations.json --plan plan.json --role operator-role";

function parseArguments(values) {
  if (values.length !== REQUIRED.length * 2) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!REQUIRED.includes(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = flag === "--role" ? value : resolve(value);
  }
  if (REQUIRED.some((flag) => !result[flag])) throw new Error(USAGE);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [artifactFileBytes, policy, reports, reviewAttestations, plan] = await Promise.all([
    readBoundedFile(options["--review-artifact"], "wallet session route review artifact"),
    readBoundedJson(options["--review-policy"], "wallet session route review policy", { maximumBytes: 65_536 }),
    readBoundedJson(options["--review-reports"], "wallet session route review reports", { maximumBytes: 65_536 }),
    readBoundedJson(options["--review-attestations"], "wallet session route review attestations", { maximumBytes: 65_536 }),
    readBoundedJson(options["--plan"], "wallet session route deployment plan", { maximumBytes: 65_536 }),
  ]);
  const candidate = prepareWalletSessionRouteReviewCandidate({ artifactFileBytes, policy, reports });
  verifyPublishedWalletSessionRouteReviewArtifact({
    repository,
    artifactFileBytes,
    artifact: candidate.artifact,
  });
  const routeReviewVerification = verifyWalletSessionRouteReview({
    artifactFileBytes,
    policy,
    reports,
    attestations: reviewAttestations,
  });
  const typed = buildWalletSessionRouteDeploymentPreflightMessage({
    routeReviewVerification,
    plan,
    role: options["--role"],
  });
  revalidatePublishedWalletSessionRouteReviewSource(repository, candidate.artifact);
  process.stdout.write(`${JSON.stringify({
    scope: "deployment-preflight-attestation-only-no-signing-deployment-dispatch-settlement-or-funding-authorization",
    primaryType: "WalletSessionRouteDeploymentPreflight",
    domain: typed.domain,
    types: typed.types,
    message: typed.value,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "wallet session route deployment preflight attestation preparation failed"}\n`);
  process.exitCode = 1;
});
