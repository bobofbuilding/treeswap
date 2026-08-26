# Account storage monitoring

Status: the aggregate-only, fail-closed monitor protocol and a private scheduled Worker composition are implemented and locally tested. No collector, Cron Trigger, observer service, paging route, retained production window, or authority is deployed.

## Purpose

Accounts are optional and cannot move BIT or Lightning, but session and notification records are still sensitive. A working database is not enough. Production account access must remain closed unless operators can continuously detect:

- D1 outage, schema failure, or excessive probe latency;
- unauthorized read or write attempts;
- D1 access-policy changes;
- expired-record backlog or a failed/stale maintenance schedule; and
- failed or degraded operator escalation.

`lib/account-storage-monitor.mjs` provides the repository control for that boundary. It does not deploy a monitor and it cannot authorize accounts, swaps, wallet dispatch, Lightning dispatch, settlement, pool funding, or release activation.

## Bounded database observation

One server-side collector runs the existing zero-row schema probe and three indexed, cutoff-bound count queries in one D1 batch. Each count is capped at 101 rows: one row beyond the maintenance batch limit is enough to prove that one normal maintenance pass cannot drain the queue. The collector retains only:

- availability and schema status;
- total probe latency;
- capped expired-record counts for challenges, sessions, and notification records;
- saturation or generic collection-failure state; and
- one digest of that aggregate.

It never returns a challenge, session hash, wallet, email, invoice, payment hash, preimage, row body, query error, endpoint, or credential. Database exceptions collapse to a fixed unsafe code.

The default local policy fails closed above 1,000 ms D1 latency, after 120 seconds without a fresh observation, when any table exceeds 100 expired records, or when the 101-row probe saturates. These are conservative starting limits for the private closed deployment, not mainnet performance claims.

## Independent access and maintenance observations

The monitor also requires two separate aggregate observations:

1. An access observer covers at least five continuous minutes, proves audit coverage is complete, and reports aggregate unauthorized reads, unauthorized writes, and access-policy changes. Any nonzero event is unsafe.
2. A maintenance observer binds retained evidence for the latest bounded run. Failure, unfinished backlog, an observation older than 120 seconds, or a successful run older than 30 minutes is unsafe.

The local builders use module-private provenance so copied or serialized objects cannot be relabeled as live input in the same process. They do not authenticate an external platform by themselves, and every evaluation explicitly records that external-input authentication, continuous deployment, a retained monitoring window, and paging-provider independence are unverified. The [scheduled account-storage monitor](./SCHEDULED_ACCOUNT_STORAGE_MONITOR.md) now supplies the strict deployment wrapper: separate private Service Bindings return request-bound Ed25519 observations for access audit and retained maintenance evidence, while the D1 probe remains local to the caller. Signatures authenticate configured keys and causality, not the truth, custody, or independence of the external claims. Those facts remain live-review evidence. The production database collector and monitor cycle own their system clocks; clock injection exists only in explicitly test-named exports.

## Escalation

A healthy cycle calls no external action. An unsafe cycle sends one secret-free alert containing only the timestamp, reason codes, policy digest, and evidence digest to exactly two configured routes. Extra-field, malformed, failed, or timed-out responses do not count. One successful route records escalation with degraded redundancy; zero successful routes records `ESCALATION_INCOMPLETE`.

The alert callback receives an abort signal and is bounded to 30 seconds by default. The scheduled wrapper binds each request to a distinct route commitment and counts only a strict empty no-store acknowledgement. It retains every evaluated aggregate cycle in create-only R2 evidence and fails the invocation after unsafe, degraded, or retention-failed outcomes. Alerting cannot disable accounts, modify D1, open or close a bridge gate, dispatch a wallet or Lightning payment, settle a swap, fund a pool, or activate a release. The account routes already fail closed on unavailable storage; incident operators must separately follow the reviewed account-disable and credential-revocation procedure. A separate external mechanism must detect a missing Cron or failed Worker because the Worker cannot be its own total-platform-failure monitor.

## Production evidence still required

Before enabling accounts outside the owner-only closed deployment:

1. independently review the exact D1 access and least-privilege operator policy;
2. deploy the reviewed [scheduled account-storage monitor](./SCHEDULED_ACCOUNT_STORAGE_MONITOR.md), its separately governed access and maintenance observers, two independently operated alert routes, and an external missing-Cron monitor;
3. deploy the reviewed [scheduled account maintenance](./SCHEDULED_ACCOUNT_MAINTENANCE.md) worker without a reusable browser credential and have the authenticated maintenance observer consume its locked aggregate R2 evidence;
4. retain at least 24 continuous hours of secret-free observations and alert acknowledgements bound to the exact reviewed deployment;
5. drill D1 outage, latency breach, schema failure, missing audit coverage, unauthorized access, access-policy change, maintenance failure, queue saturation, one alert-route outage, and total paging outage;
6. prove alerts reached the named operator escalation path within the reviewed response window; and
7. have the three-role live-review ceremony inspect the private monitoring artifacts and dispositions.

Backup retention and a fresh isolated restore use the separate [account backup/restore evidence](./ACCOUNT_BACKUP_RESTORE_EVIDENCE.md) ceremony.

Until that evidence exists, the corresponding launch-checklist deployment item remains open and the account feature must stay private or disabled.
