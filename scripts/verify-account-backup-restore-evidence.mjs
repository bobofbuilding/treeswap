#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAccountBackupRestoreSummary,
  verifyAccountBackupRestoreEvidence,
} from "../lib/account-backup-restore-evidence.mjs";
import { readBoundedJson, writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  currentPublishedWalletSessionRouteReviewSource,
  revalidatePublishedWalletSessionRouteReviewSource,
} from "../lib/wallet-session-route-review-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run verify:account-backup-restore-evidence -- --candidate candidate.json --attestations attestations.json [--out summary.json]";

function parseArguments(values) {
  if (![4, 6].includes(values.length)) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!["--attestations", "--candidate", "--out"].includes(flag) || !value || result[flag]) {
      throw new Error(USAGE);
    }
    result[flag] = value;
  }
  if (!result["--candidate"] || !result["--attestations"]) throw new Error(USAGE);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = currentPublishedWalletSessionRouteReviewSource(repository);
  const [candidate, attestations] = await Promise.all([
    readBoundedJson(resolve(options["--candidate"]), "account backup restore candidate", {
      maximumBytes: 262_144,
    }),
    readBoundedJson(resolve(options["--attestations"]), "account backup restore attestations", {
      maximumBytes: 65_536,
    }),
  ]);
  if (candidate.policy?.sourceBranch !== source.sourceBranch
      || candidate.policy?.sourceCommit !== source.sourceCommit) {
    throw new Error("account backup restore candidate does not match the exact clean branch published on origin");
  }
  const verification = verifyAccountBackupRestoreEvidence({
    policy: candidate.policy,
    record: candidate.record,
    attestations,
  });
  const summary = buildAccountBackupRestoreSummary(verification);
  revalidatePublishedWalletSessionRouteReviewSource(repository, source);
  if (options["--out"]) {
    const output = resolve(options["--out"]);
    await writeExclusiveJson(output, summary);
    process.stdout.write(`${output}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "account backup evidence verification failed"}\n`);
  process.exitCode = 1;
});
