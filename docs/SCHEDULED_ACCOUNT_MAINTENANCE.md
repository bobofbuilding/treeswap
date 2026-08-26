# Scheduled account maintenance

Status: a private scheduled-only Worker runtime is implemented and locally tested. It is not deployed, no Cron Trigger or R2 bucket is configured, and no live account record is changed by this repository checkpoint.

## Runtime boundary

`infra/account-maintenance-scheduler/worker.mjs` exposes only a `scheduled()` handler. There is no `fetch()` handler, browser credential, public route, email path, wallet call, Lightning call, settlement path, or funding authority.

The handler accepts only Cloudflare's exact UTC `*/15 * * * *` Cron Trigger and rejects an invocation that starts in the future, is not minute-aligned, or starts or finishes more than ten minutes after the scheduled time. It requires:

- one D1 binding for the authoritative account database;
- one separate R2 binding for secret-free maintenance evidence;
- the exact clean source commit and deployment version;
- distinct commitments for the source database and evidence bucket; and
- the literal `private-scheduled-only` deployment mode.

Each run calls the existing three-statement transactional D1 purge with the scheduled time as its cutoff. Each statement deletes at most 100 already-expired rows and returns only an aggregate count to the evidence boundary. D1 batch failure rolls back the sequence under Cloudflare's documented [D1 batch transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

The runtime then writes one canonical JSON object under `account-maintenance/v1/` with a SHA-256 checksum and an HTTP `If-None-Match: *` precondition. The object contains only the source/deployment/database/bucket commitments, schedule and completion times, aggregate deletion counts, backlog state, and false authority flags. Provider errors are reduced to one fixed failure. A malformed or failed R2 response never becomes a retained receipt.

If any table reaches the 100-row bound, the worker first retains `completed-backlog-remains` evidence and then fails the Cron invocation. The independent account-storage monitor must treat either that state or missing fresh completion evidence as unsafe and page both configured routes.

## Why a separate worker and evidence bucket

[Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) invoke a Worker's `scheduled()` handler in UTC. A dedicated worker avoids exposing the cleanup capability through an HTTP route and avoids a reusable browser session.

R2 is separate from the database being cleaned, so a D1 outage cannot rewrite the retained history. Before deployment, the evidence prefix must have an independently reviewed [R2 bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/) and a retention period that covers incident investigation. Workers Logs may corroborate the Cron invocation, but R2 is the primary record because log retention and export are separate platform settings.

The D1 deletion and R2 write cannot be one cross-service transaction. If deletion succeeds and the evidence write fails, the invocation fails closed and supplies no positive deletion proof. Operators must preserve the platform failure record and repeat the witnessed drill with newly and independently aged fixtures; a later zero-deletion receipt cannot be relabelled as proof of the earlier deletion.

## Deployment plan — not executed

The reviewed private deployment must define a separate Worker whose source of truth includes this shape:

```json
{
  "main": "infra/account-maintenance-scheduler/worker.mjs",
  "triggers": { "crons": ["*/15 * * * *"] },
  "d1_databases": [{ "binding": "DB", "database_id": "reviewed-private-value" }],
  "r2_buckets": [{ "binding": "ACCOUNT_MAINTENANCE_EVIDENCE", "bucket_name": "reviewed-private-value" }]
}
```

The deployment version, source commit, source-database commitment, evidence-bucket commitment, and `private-scheduled-only` mode are non-secret runtime values. Database and bucket names, account identifiers, operator credentials, and retained objects remain private. Wrangler-managed Cron configuration must remain the single source of truth; commenting out `triggers.crons` does not remove an existing trigger, while an explicit empty array does. Cloudflare notes that trigger changes can take up to 15 minutes to propagate, so enablement and removal require observed postflight evidence.

## Witnessed adoption drill

The checklist item stays open until the exact reviewed deployment completes all of the following:

1. create one nonce, one session, and one notification preference through their normal private account paths using a dedicated test wallet;
2. retain secret commitments to each fixture, never the raw nonce, cookie, token hash, wallet, or email in public evidence;
3. allow each record to expire naturally and independently while keeping one active control record of each type;
4. observe one exact scheduled invocation delete at least one record from all three expired sets with `moreWorkPossible: false`;
5. prove each active control still exists and remains usable where appropriate;
6. retrieve the exact locked R2 object and reproduce its SHA-256 digest, metadata, deployment/source/database/bucket commitments, and aggregate counts;
7. verify Cron configuration, Worker invocation/audit logs, bucket lock, retention, D1 least privilege, and both storage-monitor alert routes through independent platform inspection;
8. drill D1 failure, R2 failure after D1 completion, a delayed/missing Cron, a saturated queue, one paging outage, and total paging outage; and
9. have the independent account/privacy reviewers bind their reports and dispositions to the retained private artifacts.

Until that evidence exists, account enablement remains private or disabled and funded operation remains closed.
