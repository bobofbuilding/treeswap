#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readBoundedFile,
  readBoundedJson,
  writeExclusiveJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildWalletSessionRouteReviewSummary,
  prepareWalletSessionRouteReviewCandidate,
  verifyWalletSessionRouteReview,
} from "../lib/wallet-session-route-review.mjs";
import {
  revalidatePublishedWalletSessionRouteReviewSource,
  verifyPublishedWalletSessionRouteReviewArtifact,
} from "../lib/wallet-session-route-review-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = Object.freeze(["--artifact", "--attestations", "--policy", "--reports"]);
const ALLOWED = new Set([...REQUIRED, "--out"]);
const USAGE = "Usage: npm run verify:wallet-session-route-review -- --artifact artifact.json --policy policy.json --reports reports.json --attestations attestations.json [--out summary.json]";

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
  const [artifactFileBytes, policy, reports, attestations] = await Promise.all([
    readBoundedFile(options["--artifact"], "wallet session route review artifact"),
    readBoundedJson(options["--policy"], "wallet session route review policy", { maximumBytes: 65_536 }),
    readBoundedJson(options["--reports"], "wallet session route review reports", { maximumBytes: 65_536 }),
    readBoundedJson(options["--attestations"], "wallet session route review attestations", { maximumBytes: 65_536 }),
  ]);
  const candidate = prepareWalletSessionRouteReviewCandidate({ artifactFileBytes, policy, reports });
  verifyPublishedWalletSessionRouteReviewArtifact({
    repository,
    artifactFileBytes,
    artifact: candidate.artifact,
  });
  const verification = verifyWalletSessionRouteReview({
    artifactFileBytes,
    policy,
    reports,
    attestations,
  });
  const summary = buildWalletSessionRouteReviewSummary(verification);
  revalidatePublishedWalletSessionRouteReviewSource(repository, candidate.artifact);
  if (options["--out"]) {
    await writeExclusiveJson(options["--out"], summary);
    process.stdout.write(`${options["--out"]}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "wallet session route review verification failed"}\n`);
  process.exitCode = 1;
});
