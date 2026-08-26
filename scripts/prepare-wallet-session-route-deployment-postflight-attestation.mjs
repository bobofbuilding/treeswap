#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readBoundedFile,
  readBoundedJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildWalletSessionRouteDeploymentPostflightMessage,
} from "../lib/wallet-session-route-deployment-postflight.mjs";
import {
  verifyWalletSessionRouteDeploymentPreflight,
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
  "--preflight-attestations",
  "--evidence",
  "--role",
]);
const USAGE = "Usage: npm run prepare:wallet-session-route-deployment-postflight-attestation -- --review-artifact artifact.json --review-policy policy.json --review-reports reports.json --review-attestations attestations.json --plan plan.json --preflight-attestations attestations.json --evidence evidence.json --role observer-role";

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
  const [artifactFileBytes, reviewPolicy, reviewReports, reviewAttestations, plan,
    preflightAttestations, evidence] = await Promise.all([
    readBoundedFile(options["--review-artifact"], "wallet session route review artifact"),
    readBoundedJson(options["--review-policy"], "wallet session route review policy", { maximumBytes: 65_536 }),
    readBoundedJson(options["--review-reports"], "wallet session route review reports", { maximumBytes: 65_536 }),
    readBoundedJson(options["--review-attestations"], "wallet session route review attestations", { maximumBytes: 65_536 }),
    readBoundedJson(options["--plan"], "wallet session route deployment plan", { maximumBytes: 65_536 }),
    readBoundedJson(options["--preflight-attestations"], "wallet session route deployment preflight attestations", { maximumBytes: 65_536 }),
    readBoundedJson(options["--evidence"], "wallet session route deployment postflight evidence", { maximumBytes: 65_536 }),
  ]);
  const routeCandidate = prepareWalletSessionRouteReviewCandidate({
    artifactFileBytes,
    policy: reviewPolicy,
    reports: reviewReports,
  });
  verifyPublishedWalletSessionRouteReviewArtifact({
    repository,
    artifactFileBytes,
    artifact: routeCandidate.artifact,
  });
  const routeReviewVerification = verifyWalletSessionRouteReview({
    artifactFileBytes,
    policy: reviewPolicy,
    reports: reviewReports,
    attestations: reviewAttestations,
  });
  const deploymentPreflightVerification = verifyWalletSessionRouteDeploymentPreflight({
    routeReviewVerification,
    plan,
    attestations: preflightAttestations,
  });
  const typed = buildWalletSessionRouteDeploymentPostflightMessage({
    deploymentPreflightVerification,
    evidence,
    role: options["--role"],
  });
  revalidatePublishedWalletSessionRouteReviewSource(repository, routeCandidate.artifact);
  process.stdout.write(`${JSON.stringify({
    scope: "deployment-postflight-attestation-only-no-signing-platform-query-deployment-dispatch-settlement-or-funding-authorization",
    primaryType: "WalletSessionRouteDeploymentPostflight",
    domain: typed.domain,
    types: typed.types,
    message: typed.value,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "wallet session route postflight attestation preparation failed"}\n`);
  process.exitCode = 1;
});
