#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildPublishedWalletSessionRouteReviewArtifact,
  currentPublishedWalletSessionRouteReviewSource,
  revalidatePublishedWalletSessionRouteReviewSource,
} from "../lib/wallet-session-route-review-source.mjs";
import {
  WALLET_SESSION_ROUTE_REVIEW_ROLES,
  hashWalletSessionRouteReviewArtifactFile,
  serializeWalletSessionRouteReviewArtifact,
  walletSessionRouteReviewControlSetDigest,
} from "../lib/wallet-session-route-review.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run prepare:wallet-session-route-review -- --out /secure-review/wallet-session-route-artifact.json";

function outputPath(values) {
  if (values.length !== 2 || values[0] !== "--out" || !values[1]) throw new Error(USAGE);
  return resolve(values[1]);
}

async function main() {
  const target = outputPath(process.argv.slice(2));
  const source = currentPublishedWalletSessionRouteReviewSource(repository);
  const artifact = buildPublishedWalletSessionRouteReviewArtifact(repository, source);
  revalidatePublishedWalletSessionRouteReviewSource(repository, source);
  await writeExclusiveJson(target, artifact);
  process.stdout.write(`${JSON.stringify({
    scope: "wallet-session-route-review-artifact-only-no-review-deployment-or-funding-authorization",
    artifact: target,
    artifactFileDigest: hashWalletSessionRouteReviewArtifactFile(
      serializeWalletSessionRouteReviewArtifact(artifact),
    ),
    sourceBranch: source.sourceBranch,
    sourceCommit: source.sourceCommit,
    reviewerControlSets: WALLET_SESSION_ROUTE_REVIEW_ROLES.map((role) => ({
      role,
      controlSetDigest: walletSessionRouteReviewControlSetDigest(role),
    })),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "wallet session route review preparation failed"}\n`);
  process.exitCode = 1;
});
