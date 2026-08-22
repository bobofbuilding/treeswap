#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBitIndependentReviewSummary,
  verifyBitIndependentReview,
} from "../lib/bit-independent-review.mjs";
import { verifyBitProviderEvidence } from "../lib/bit-provider-evidence.mjs";
import { currentPublishedBitSource, revalidatePublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run verify:bit-independent-review -- --candidate review-candidate.json --provider-candidate provider-candidate.json --provider-attestations provider-attestations.json --attestations review-attestations.json [--out review-summary.json]";
const REQUIRED = Object.freeze([
  "--attestations",
  "--candidate",
  "--provider-attestations",
  "--provider-candidate",
]);
const ALLOWED = new Set([...REQUIRED, "--out"]);

function parseArguments(values) {
  if (![REQUIRED.length * 2, (REQUIRED.length + 1) * 2].includes(values.length)) {
    throw new Error(USAGE);
  }
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
  const [candidate, providerCandidate, providerAttestations, attestations] = await Promise.all([
    readBoundedJson(options["--candidate"], "BIT independent review candidate", {
      maximumBytes: 131_072,
    }),
    readBoundedJson(options["--provider-candidate"], "BIT provider evidence candidate", {
      maximumBytes: 262_144,
    }),
    readBoundedJson(options["--provider-attestations"], "BIT provider attestations", {
      maximumBytes: 65_536,
    }),
    readBoundedJson(options["--attestations"], "BIT independent review attestations", {
      maximumBytes: 65_536,
    }),
  ]);
  if (candidate.record?.sourceCommit !== source.sourceCommit
      || providerCandidate.record?.sourceCommit !== source.sourceCommit) {
    throw new Error("BIT independent review does not match the exact clean commit published on origin/main");
  }
  const now = new Date();
  const providerVerification = verifyBitProviderEvidence({
    candidate: providerCandidate,
    attestations: providerAttestations,
    observedAt: now,
  });
  const verification = verifyBitIndependentReview({
    candidate,
    providerVerification,
    attestations,
    observedAt: now,
  });
  const summary = buildBitIndependentReviewSummary(verification);
  revalidatePublishedBitSource(repository, source.sourceCommit);
  if (options["--out"]) {
    await writeExclusiveJson(options["--out"], summary);
    process.stdout.write(`${options["--out"]}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT independent review verification failed"}\n`);
  process.exitCode = 1;
});
