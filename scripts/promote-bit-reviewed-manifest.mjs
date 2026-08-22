#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBitIndependentReview } from "../lib/bit-independent-review.mjs";
import { verifyBitProviderEvidence } from "../lib/bit-provider-evidence.mjs";
import {
  buildReviewedBitDeploymentManifestSummary,
  promoteReviewedBitDeploymentManifest,
} from "../lib/bit-reviewed-manifest.mjs";
import { currentPublishedBitSource, revalidatePublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run promote:bit-reviewed-manifest -- --provider-candidate provider-candidate.json --provider-attestations provider-attestations.json --review-candidate review-candidate.json --review-attestations review-attestations.json --out reviewed-bit-manifest.json";
const REQUIRED = Object.freeze([
  "--out",
  "--provider-attestations",
  "--provider-candidate",
  "--review-attestations",
  "--review-candidate",
]);
const ALLOWED = new Set(REQUIRED);

function parseArguments(values) {
  if (values.length !== REQUIRED.length * 2) throw new Error(USAGE);
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
  const source = currentPublishedBitSource(repository);
  const [providerCandidate, providerAttestations, reviewCandidate, reviewAttestations] = await Promise.all([
    readBoundedJson(options["--provider-candidate"], "BIT provider evidence candidate", {
      maximumBytes: 262_144,
    }),
    readBoundedJson(options["--provider-attestations"], "BIT provider attestations", {
      maximumBytes: 65_536,
    }),
    readBoundedJson(options["--review-candidate"], "BIT independent review candidate", {
      maximumBytes: 131_072,
    }),
    readBoundedJson(options["--review-attestations"], "BIT independent review attestations", {
      maximumBytes: 65_536,
    }),
  ]);
  if (providerCandidate.record?.sourceCommit !== source.sourceCommit
      || reviewCandidate.record?.sourceCommit !== source.sourceCommit) {
    throw new Error("reviewed BIT manifest does not match the exact clean commit published on origin/main");
  }

  const now = new Date();
  const providerVerification = verifyBitProviderEvidence({
    candidate: providerCandidate,
    attestations: providerAttestations,
    observedAt: now,
  });
  const reviewVerification = verifyBitIndependentReview({
    candidate: reviewCandidate,
    providerVerification,
    attestations: reviewAttestations,
    observedAt: now,
  });
  const verification = promoteReviewedBitDeploymentManifest({
    providerVerification,
    reviewVerification,
    promotedAt: now,
    observedAt: now,
  });
  const summary = buildReviewedBitDeploymentManifestSummary(verification);
  revalidatePublishedBitSource(repository, source.sourceCommit);
  await writeExclusiveJson(options["--out"], summary);
  process.stdout.write(`${options["--out"]}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "reviewed BIT manifest promotion failed"}\n`);
  process.exitCode = 1;
});
