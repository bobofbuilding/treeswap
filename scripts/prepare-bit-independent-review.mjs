#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBitIndependentReviewCandidate } from "../lib/bit-independent-review.mjs";
import { verifyBitProviderEvidence } from "../lib/bit-provider-evidence.mjs";
import { currentPublishedBitSource, revalidatePublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run prepare:bit-independent-review -- --provider-candidate candidate.json --provider-attestations attestations.json --policy review-policy.json --artifacts review-artifacts.json --findings finding-counts.json --out review-candidate.json";
const REQUIRED = Object.freeze([
  "--artifacts",
  "--findings",
  "--out",
  "--policy",
  "--provider-attestations",
  "--provider-candidate",
]);

function parseArguments(values) {
  if (values.length !== REQUIRED.length * 2) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!REQUIRED.includes(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = resolve(value);
  }
  if (REQUIRED.some((flag) => !result[flag])) throw new Error(USAGE);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = currentPublishedBitSource(repository);
  const [providerCandidate, providerAttestations, policy, artifacts, findingCounts] = await Promise.all([
    readBoundedJson(options["--provider-candidate"], "BIT provider evidence candidate", {
      maximumBytes: 262_144,
    }),
    readBoundedJson(options["--provider-attestations"], "BIT provider attestations", {
      maximumBytes: 65_536,
    }),
    readBoundedJson(options["--policy"], "BIT independent review policy", { maximumBytes: 65_536 }),
    readBoundedJson(options["--artifacts"], "BIT independent review artifacts", { maximumBytes: 65_536 }),
    readBoundedJson(options["--findings"], "BIT independent review finding counts", {
      maximumBytes: 4_096,
    }),
  ]);
  const now = new Date();
  const providerVerification = verifyBitProviderEvidence({
    candidate: providerCandidate,
    attestations: providerAttestations,
    observedAt: now,
  });
  const candidate = prepareBitIndependentReviewCandidate({
    providerVerification,
    policy,
    artifacts,
    findingCounts,
    preparedAt: now,
  });
  if (candidate.record.sourceCommit !== source.sourceCommit) {
    throw new Error("BIT independent review does not match the exact clean commit published on origin/main");
  }
  revalidatePublishedBitSource(repository, source.sourceCommit);
  await writeExclusiveJson(options["--out"], candidate);
  process.stdout.write(`${options["--out"]}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT independent review preparation failed"}\n`);
  process.exitCode = 1;
});
