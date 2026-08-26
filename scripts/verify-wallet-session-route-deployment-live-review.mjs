#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readBoundedFile,
  readBoundedJson,
  writeExclusiveJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import {
  reconstructWalletSessionRouteDeploymentEvidenceChain,
} from "../lib/wallet-session-route-deployment-evidence-chain.mjs";
import {
  buildWalletSessionRouteDeploymentLiveReviewSummary,
  verifyWalletSessionRouteDeploymentLiveReview,
} from "../lib/wallet-session-route-deployment-live-review.mjs";
import {
  prepareWalletSessionRouteReviewCandidate,
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
  "--postflight-evidence",
  "--postflight-attestations",
  "--live-review-policy",
  "--live-review-reports",
  "--live-review-attestations",
]);
const ALLOWED = new Set([...REQUIRED, "--out"]);
const USAGE = "Usage: npm run verify:wallet-session-route-deployment-live-review -- --review-artifact artifact.json --review-policy policy.json --review-reports reports.json --review-attestations attestations.json --plan plan.json --preflight-attestations attestations.json --postflight-evidence evidence.json --postflight-attestations attestations.json --live-review-policy policy.json --live-review-reports reports.json --live-review-attestations attestations.json [--out summary.json]";

function parseArguments(values) {
  if (![REQUIRED.length * 2, (REQUIRED.length + 1) * 2].includes(values.length)) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!ALLOWED.has(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = resolve(value);
  }
  if (REQUIRED.some((flag) => !result[flag])) throw new Error(USAGE);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [artifactFileBytes, reviewPolicy, reviewReports, reviewAttestations, deploymentPlan,
    deploymentPreflightAttestations, deploymentPostflightEvidence,
    deploymentPostflightAttestations, liveReviewPolicy, liveReviewReports,
    liveReviewAttestations] = await Promise.all([
    readBoundedFile(options["--review-artifact"], "wallet session route review artifact"),
    readBoundedJson(options["--review-policy"], "wallet session route review policy", { maximumBytes: 65_536 }),
    readBoundedJson(options["--review-reports"], "wallet session route review reports", { maximumBytes: 65_536 }),
    readBoundedJson(options["--review-attestations"], "wallet session route review attestations", { maximumBytes: 65_536 }),
    readBoundedJson(options["--plan"], "wallet session route deployment plan", { maximumBytes: 65_536 }),
    readBoundedJson(options["--preflight-attestations"], "wallet session route deployment preflight attestations", { maximumBytes: 65_536 }),
    readBoundedJson(options["--postflight-evidence"], "wallet session route deployment postflight evidence", { maximumBytes: 65_536 }),
    readBoundedJson(options["--postflight-attestations"], "wallet session route deployment postflight attestations", { maximumBytes: 65_536 }),
    readBoundedJson(options["--live-review-policy"], "wallet session route deployment live review policy", { maximumBytes: 65_536 }),
    readBoundedJson(options["--live-review-reports"], "wallet session route deployment live review reports", { maximumBytes: 65_536 }),
    readBoundedJson(options["--live-review-attestations"], "wallet session route deployment live review attestations", { maximumBytes: 65_536 }),
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
  const chain = reconstructWalletSessionRouteDeploymentEvidenceChain({
    artifactFileBytes,
    reviewPolicy,
    reviewReports,
    reviewAttestations,
    deploymentPlan,
    deploymentPreflightAttestations,
    deploymentPostflightEvidence,
    deploymentPostflightAttestations,
  });
  const verification = verifyWalletSessionRouteDeploymentLiveReview({
    deploymentPostflightVerification: chain.deploymentPostflightVerification,
    policy: liveReviewPolicy,
    reports: liveReviewReports,
    attestations: liveReviewAttestations,
  });
  const summary = buildWalletSessionRouteDeploymentLiveReviewSummary(verification);
  revalidatePublishedWalletSessionRouteReviewSource(repository, routeCandidate.artifact);
  if (options["--out"]) {
    await writeExclusiveJson(options["--out"], summary);
    process.stdout.write(`${options["--out"]}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "wallet session route live review verification failed"}\n`);
  process.exitCode = 1;
});
