#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  D1_ACCESS_REVIEW_ROLES,
  buildD1AccessReviewApprovalMessage,
} from "../lib/d1-access-policy-review.mjs";
import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  currentPublishedWalletSessionRouteReviewSource,
  revalidatePublishedWalletSessionRouteReviewSource,
} from "../lib/wallet-session-route-review-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run prepare:d1-access-policy-review-attestation -- --candidate candidate.json --role cloudflare-access-security-reviewer|data-privacy-least-privilege-reviewer";

function parseArguments(values) {
  if (values.length !== 4) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!["--candidate", "--role"].includes(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  if (!D1_ACCESS_REVIEW_ROLES.includes(result["--role"])) throw new Error(USAGE);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = currentPublishedWalletSessionRouteReviewSource(repository);
  const candidate = await readBoundedJson(
    resolve(options["--candidate"]),
    "D1 access review candidate",
    { maximumBytes: 262_144 },
  );
  if (candidate.policy?.sourceBranch !== source.sourceBranch
      || candidate.policy?.sourceCommit !== source.sourceCommit) {
    throw new Error("D1 access review candidate does not match the exact clean branch published on origin");
  }
  const observedAt = Math.floor(Date.now() / 1_000);
  const typed = buildD1AccessReviewApprovalMessage({
    policy: candidate.policy,
    record: candidate.record,
    role: options["--role"],
    attestedAt: observedAt,
    observedAt,
  });
  revalidatePublishedWalletSessionRouteReviewSource(repository, source);
  process.stdout.write(`${JSON.stringify({
    scope: "d1-access-review-attestation-only-no-signing-platform-mutation-account-enablement-deployment-or-funding-authority",
    primaryType: "D1AccessPolicyReview",
    domain: typed.domain,
    types: typed.types,
    message: typed.value,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "D1 access review attestation preparation failed"}\n`);
  process.exitCode = 1;
});
