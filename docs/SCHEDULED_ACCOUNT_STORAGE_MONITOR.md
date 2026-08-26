# Scheduled account storage monitor

Status: a private scheduled-only Worker runtime and its adversarial tests are implemented. It is not deployed, no Cron Trigger, observer service, paging route, or evidence bucket is configured, and this checkpoint does not enable accounts or funded operation.

## Runtime boundary

`infra/account-storage-monitor/worker.mjs` exposes only a `scheduled()` handler. It has no HTTP route and no capability to enable or disable accounts, send email, dispatch a wallet or Lightning payment, settle a swap, fund a pool, or activate a release.

The handler accepts only Cloudflare's exact UTC `* * * * *` Cron Trigger. It rejects a future or non-minute-aligned invocation, a start more than 60 seconds late, or completion more than two minutes after the scheduled time. A run requires six pairwise separate runtime bindings:

- the authoritative account D1 database;
- a private access-audit observer service;
- a private maintenance-evidence observer service;
- primary and secondary paging services; and
- a separate R2 bucket for aggregate monitor evidence.

It also requires the exact clean source commit, deployment version, non-secret commitments for the database, evidence bucket, and both paging routes, two distinct Ed25519 observer public keys, and the literal `private-scheduled-monitor-only` mode. Object identity and commitment inequality catch accidental local reuse. They do not prove that the configured resources, operators, organizations, or providers are actually distinct; independent platform inspection remains mandatory.

[Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) invoke a Worker's `scheduled()` handler in UTC and can take up to 15 minutes to propagate after configuration changes. Wrangler-managed Cron configuration must remain the single source of truth, and postflight inspection must prove the deployed trigger rather than infer it from source.

## Authenticated observations

The access and maintenance observations arrive through private [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/). Service Bindings avoid a public route, but remain Cloudflare-account configuration and do not establish organizational independence on their own.

Each observer receives one strict JSON request containing only the observation kind, source and deployment commitments, database commitment, request time, 30-second expiry, and a fresh 256-bit challenge. The two challenges must differ. The observer response must:

- use the exact role-specific schema and fields;
- bind the complete canonical request digest and configured signer key ID;
- be current and use the exact request expiry;
- carry only aggregate evidence and one retained-evidence digest;
- have an exact bounded, uncompressed, no-store JSON response; and
- verify under the role's raw Ed25519 public key.

A missing, stale, replayed, malformed, oversized, decorated, forged, wrong-key, wrong-request, cached, compressed, cookie-bearing, or timed-out response becomes an invalid observation. It can never make a cycle healthy. The access observer must report at least five continuous minutes of complete audit coverage with zero unauthorized reads, writes, or privilege changes. The maintenance observer must bind a recent completed scheduled-maintenance record with no remaining work.

Observer signatures authenticate configured keys and request causality. They do not prove that an observer truthfully queried Cloudflare, read the locked maintenance object, controls its claimed organization, or retained the underlying evidence. The deployment ceremony must establish those facts directly.

## Database, escalation, and evidence

The Worker runs the existing read-only aggregate D1 schema, latency, and capped backlog probe. It then evaluates all three observations through `lib/account-storage-monitor.mjs`. A healthy cycle sends no alert. An unsafe cycle attempts exactly two alerts containing only reason codes, timestamp, policy digest, and aggregate evidence digest.

Each paging request is bound to its route commitment and complete canonical body. Only an exact empty HTTP 204 response that echoes both digests and disables caching counts as delivery. A failed, malformed, or timed-out response records degraded delivery. Distinct service bindings and route commitments prevent accidental aliasing, but live evidence must still prove two independently operated providers and a named human escalation path. A separate external monitor must page on a missing Cron invocation or Worker failure because a total Cloudflare or Worker failure cannot reliably page through the failed Worker itself.

Every evaluated cycle is written once under `account-storage-monitor/v1/` in a separate R2 bucket. The object is canonical aggregate JSON with a SHA-256 checksum and an HTTP `If-None-Match: *` precondition. [R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) return no object when the condition fails; a missing or malformed storage result therefore cannot become a positive receipt. The record contains only source/resource/key/route commitments, schedule times, reason codes, policy and evidence digests, delivery counts, and false authority flags.

Unsafe or degraded cycles are retained and then fail the Cron invocation. If retention itself fails, both paging routes receive a separate aggregate retention-failure alert and the invocation fails without emitting a positive receipt. Provider errors are collapsed to fixed failure states and never enter evidence or logs.

## Deployment plan — not executed

The reviewed private deployment must define a dedicated Worker whose source of truth includes this shape:

```json
{
  "main": "infra/account-storage-monitor/worker.mjs",
  "triggers": { "crons": ["* * * * *"] },
  "d1_databases": [{ "binding": "DB", "database_id": "reviewed-private-value" }],
  "r2_buckets": [{ "binding": "ACCOUNT_MONITOR_EVIDENCE", "bucket_name": "reviewed-private-value" }],
  "services": [
    { "binding": "ACCOUNT_ACCESS_OBSERVER", "service": "reviewed-private-value" },
    { "binding": "ACCOUNT_MAINTENANCE_OBSERVER", "service": "reviewed-private-value" },
    { "binding": "ACCOUNT_ALERT_PRIMARY", "service": "reviewed-private-value" },
    { "binding": "ACCOUNT_ALERT_SECONDARY", "service": "reviewed-private-value" }
  ]
}
```

The target services must be deployed before the caller because Cloudflare deploys Service-Bound Workers separately. The exact configuration must also provide the non-secret values and public keys described above. Service names, account/database/bucket identifiers, retained objects, underlying audit data, credentials, and provider endpoints remain private.

Do not deploy this Worker until the D1 access-policy ceremony is complete. The monitor's D1 binding is technically write-capable at the platform layer even though the reviewed code issues only fixed reads; Cloudflare does not provide query-level D1 permission separation for this binding. Deployment authority, binding mutation, observer-key rotation, route rotation, Cron changes, and rollback therefore require the same reviewed least-privilege and postflight controls.

## Evidence required before account adoption

The launch-checklist item remains open until the exact reviewed deployment provides all of the following:

1. direct platform proof of the source, version, UTC one-minute Cron, D1/R2/service bindings, route absence, and D1 least-privilege dispositions;
2. separate custody and organizational evidence for both observer signing keys and both paging providers;
3. independently reproduced signed access and maintenance responses bound to real retained source evidence;
4. an independently locked R2 prefix and at least 24 continuous hours of one-per-minute retained monitor records with no unexplained gaps;
5. an external missing-Cron/Worker-failure alert and proof that both paging routes reach the named escalation path inside the reviewed response window;
6. witnessed drills for D1 outage and latency, schema failure, access-audit gaps, unauthorized read/write, privilege change, missing/stale/forged observer responses, failed/stale/saturated maintenance, one paging outage, total paging outage, R2 failure, delayed/missing Cron, key rotation, and binding substitution; and
7. the required independent platform, application-security, and privacy reviewers binding their reports and resolved findings to the exact private artifacts.

Until all evidence exists, accounts stay owner-only or disabled, email stays disabled, and funded operation stays closed.
