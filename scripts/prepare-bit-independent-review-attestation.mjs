#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBitIndependentReviewApprovalMessage } from "../lib/bit-independent-review.mjs";
import { verifyBitProviderEvidence } from "../lib/bit-provider-evidence.mjs";
import { currentPublishedBitSource, revalidatePublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run prepare:bit-independent-review-attestation -- --candidate review-candidate.json --provider-candidate provider-candidate.json --provider-attestations provider-attestations.json --role reviewer-role";
const REQUIRED = Object.freeze([
  "--candidate",
  "--provider-attestations",
  "--provider-candidate",
  "--role",
]);

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
  const source = currentPublishedBitSource(repository);
  const [candidate, providerCandidate, providerAttestations] = await Promise.all([
    readBoundedJson(options["--candidate"], "BIT independent review candidate", {
      maximumBytes: 131_072,
    }),
    readBoundedJson(options["--provider-candidate"], "BIT provider evidence candidate", {
      maximumBytes: 262_144,
    }),
    readBoundedJson(options["--provider-attestations"], "BIT provider attestations", {
      maximumBytes: 65_536,
    }),
  ]);
  if (candidate.record?.sourceCommit !== source.sourceCommit
      || providerCandidate.record?.sourceCommit !== source.sourceCommit) {
    throw new Error("BIT independent review does not match the exact clean commit published on origin/main");
  }
  const providerVerification = verifyBitProviderEvidence({
    candidate: providerCandidate,
    attestations: providerAttestations,
    observedAt: new Date(),
  });
  const typed = buildBitIndependentReviewApprovalMessage({
    candidate,
    providerVerification,
    role: options["--role"],
  });
  revalidatePublishedBitSource(repository, source.sourceCommit);
  process.stdout.write(`${JSON.stringify({
    scope: "bit-independent-review-attestation-only-no-signing-or-funding-authorization",
    primaryType: "BitIndependentReviewApproval",
    domain: Object.freeze({ ...typed.domain, chainId: typed.domain.chainId.toString() }),
    types: typed.types,
    message: Object.fromEntries(Object.entries(typed.value).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ])),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT independent review attestation preparation failed"}\n`);
  process.exitCode = 1;
});
