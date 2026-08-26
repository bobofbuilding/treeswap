#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_BACKUP_RESTORE_ROLES,
  buildAccountBackupRestoreApprovalMessage,
} from "../lib/account-backup-restore-evidence.mjs";
import { readBoundedJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  currentPublishedWalletSessionRouteReviewSource,
  revalidatePublishedWalletSessionRouteReviewSource,
} from "../lib/wallet-session-route-review-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run prepare:account-backup-restore-attestation -- --candidate candidate.json --role account-data-custodian|independent-restore-witness";

function parseArguments(values) {
  if (values.length !== 4) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!["--candidate", "--role"].includes(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  if (!ACCOUNT_BACKUP_RESTORE_ROLES.includes(result["--role"])) throw new Error(USAGE);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = currentPublishedWalletSessionRouteReviewSource(repository);
  const candidate = await readBoundedJson(
    resolve(options["--candidate"]),
    "account backup restore candidate",
    { maximumBytes: 262_144 },
  );
  if (candidate.policy?.sourceBranch !== source.sourceBranch
      || candidate.policy?.sourceCommit !== source.sourceCommit) {
    throw new Error("account backup restore candidate does not match the exact clean branch published on origin");
  }
  const observedAt = Math.floor(Date.now() / 1_000);
  const typed = buildAccountBackupRestoreApprovalMessage({
    policy: candidate.policy,
    record: candidate.record,
    role: options["--role"],
    attestedAt: observedAt,
    observedAt,
  });
  revalidatePublishedWalletSessionRouteReviewSource(repository, source);
  process.stdout.write(`${JSON.stringify({
    scope: "account-backup-restore-attestation-only-no-signing-platform-mutation-production-restore-or-funding-authority",
    primaryType: "AccountBackupRestoreEvidence",
    domain: typed.domain,
    types: typed.types,
    message: Object.fromEntries(Object.entries(typed.value).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ])),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "account backup attestation preparation failed"}\n`);
  process.exitCode = 1;
});
