#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBitProviderEvidenceApprovalMessage } from "../lib/bit-provider-evidence.mjs";
import { currentPublishedBitSource, revalidatePublishedBitSource } from "../lib/bit-evidence-source.mjs";
import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run prepare:bit-provider-attestation -- --candidate candidate.json --provider-identity 0x...";

function parseArguments(values) {
  if (values.length !== 4) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!["--candidate", "--provider-identity"].includes(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = currentPublishedBitSource(repository);
  const candidate = await readBoundedJson(
    resolve(options["--candidate"]),
    "BIT provider evidence candidate",
    { maximumBytes: 262_144 },
  );
  const typed = buildBitProviderEvidenceApprovalMessage({
    candidate,
    providerIdentity: options["--provider-identity"],
  });
  if (candidate.record?.sourceCommit !== source.sourceCommit) {
    throw new Error("BIT provider evidence does not match the exact clean commit published on origin/main");
  }
  revalidatePublishedBitSource(repository, source.sourceCommit);
  process.stdout.write(`${JSON.stringify({
    scope: "bit-provider-comparison-attestation-only-no-signing-or-funding-authorization",
    primaryType: "BitProviderEvidenceApproval",
    domain: Object.freeze({ ...typed.domain, chainId: typed.domain.chainId.toString() }),
    types: typed.types,
    message: Object.fromEntries(Object.entries(typed.value).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ])),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "BIT provider attestation preparation failed"}\n`);
  process.exitCode = 1;
});
