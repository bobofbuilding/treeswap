#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildD1AccessPolicyReviewSummary,
  verifyD1AccessPolicyReview,
} from "../lib/d1-access-policy-review.mjs";
import {
  readBoundedJson,
  writeExclusiveJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import {
  currentPublishedWalletSessionRouteReviewSource,
  revalidatePublishedWalletSessionRouteReviewSource,
} from "../lib/wallet-session-route-review-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = Object.freeze(["--attestations", "--candidate"]);
const ALLOWED = new Set([...REQUIRED, "--out"]);
const USAGE = "Usage: npm run verify:d1-access-policy-review -- --candidate candidate.json --attestations attestations.json [--out summary.json]";

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
  const source = currentPublishedWalletSessionRouteReviewSource(repository);
  const [candidate, attestations] = await Promise.all([
    readBoundedJson(options["--candidate"], "D1 access review candidate", { maximumBytes: 262_144 }),
    readBoundedJson(options["--attestations"], "D1 access review attestations", { maximumBytes: 65_536 }),
  ]);
  if (candidate.policy?.sourceBranch !== source.sourceBranch
      || candidate.policy?.sourceCommit !== source.sourceCommit) {
    throw new Error("D1 access review candidate does not match the exact clean branch published on origin");
  }
  const verification = verifyD1AccessPolicyReview({
    policy: candidate.policy,
    record: candidate.record,
    attestations,
  });
  const summary = buildD1AccessPolicyReviewSummary(verification);
  revalidatePublishedWalletSessionRouteReviewSource(repository, source);
  if (options["--out"]) {
    await writeExclusiveJson(options["--out"], summary);
    process.stdout.write(`${options["--out"]}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "D1 access review verification failed"}\n`);
  process.exitCode = 1;
});
