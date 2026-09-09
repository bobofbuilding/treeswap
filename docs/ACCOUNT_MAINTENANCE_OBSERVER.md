# Retained maintenance observer

Status: implemented and tested locally, including scheduler → retained object → signed observer → monitor composition. No service, signing key, R2 lock, access policy, or deployment is supplied.

`infra/account-maintenance-observer/worker.mjs` serves the scheduled monitor through a private Service Binding. Its only operation reads maintenance evidence and signs a request-bound aggregate response. It has no D1 binding and never runs deletion, changes accounts, sends payments, or activates a release.

## Evidence selection and verification

The observer lists at most two objects under the exact source-bound prefix for the current UTC fifteen-minute slot. More than one match or a truncated listing is ambiguous and fails. During that slot's ten-minute execution window only, an absent current object permits the preceding slot. After that deadline, the current slot must exist. Invalid or backlogged current evidence never falls back to an older successful record.

One object is read with a 16 KiB limit. The observer reconstructs its SHA-256 digest, content-addressed key, exact metadata, canonical JSON bytes, source commit, maintenance deployment version, database and bucket commitments, schedule, start and completion times, exact aggregate counts, and every false authority field. Only `completed-drained` evidence with counts below the 100-row limit and no remaining work can produce a signed response. Missing, stale, changed, duplicate, malformed, future, failed, or saturated evidence returns an empty generic 503; the scheduled monitor then uses its existing unsafe-observation escalation.

The complete request must match the configured monitor commit, monitor deployment version, database, role, fresh challenge and 30-second validity. The response binds its canonical digest and exact expiry. Ed25519 signing uses a separate secret-manager key and verifies the signature against the configured public key before returning it. Configuration accepts canonical unpadded base64url: 48-byte PKCS#8 private key and 32-byte raw public key. No key is generated or logged by this runtime.

All request-body, listing, object-read and signing work shares a ten-second deadline. Cancellation is best effort. A late storage result cannot pass the aborted-signal check or return a signed success to the caller. Clock rollback, expiry, malformed configuration, and key mismatch produce the same generic response.

## Required private configuration

Set `ACCOUNT_MAINTENANCE_OBSERVER_MODE=private-service-binding-only`. The reviewed deployment must also supply:

- `ACCOUNT_MAINTENANCE_EVIDENCE`: the maintenance evidence R2 bucket, separate from monitor-cycle storage;
- `ACCOUNT_MONITOR_SOURCE_COMMIT` and `ACCOUNT_MONITOR_DEPLOYMENT_VERSION`: the exact permitted caller;
- `ACCOUNT_MAINTENANCE_SOURCE_COMMIT` and `ACCOUNT_MAINTENANCE_DEPLOYMENT_VERSION`: the exact evidence producer;
- `ACCOUNT_MAINTENANCE_SOURCE_DATABASE_DIGEST` and `ACCOUNT_MAINTENANCE_EVIDENCE_BUCKET_DIGEST`;
- `ACCOUNT_MAINTENANCE_OBSERVER_PUBLIC_KEY`; and
- secret-manager-only `ACCOUNT_MAINTENANCE_OBSERVER_PRIVATE_KEY`.

The public key must match the monitor's maintenance-observer key and remain separate from the access observer and paging identities. Deploy with `workers_dev: false`, `preview_urls: false`, and no public routes. Only the reviewed monitor may bind this service. The internal URL check is input validation, not caller authentication; Service Binding access and deployment authority must be verified at the platform boundary. R2 bindings are technically write-capable even though this code uses only `list` and `get`.

`infra/account-maintenance-observer/wrangler.example.jsonc` is a build-only template with no resource bindings or key values. It includes Node compatibility for the existing shared protocol dependency. The local bundle check is `npx wrangler deploy --dry-run --config infra/account-maintenance-observer/wrangler.example.jsonc`; this does not deploy or establish platform isolation.

## Before adoption

Independently prove the exact Worker source/configuration, absence of public ingress, permitted caller, signing-key custody, R2 bucket identity/lock/retention, deployment permissions and audit coverage. Extend the reviewed access-policy inventory if the new Worker or its operators add a principal. Run real scheduled cleanup, retrieve original retained objects, reproduce checksum and signature verification, and witness missing/duplicate/backlogged evidence, timeout, key rotation, binding substitution, and downstream dual-paging drills. A checksum authenticates bytes, not the truth of deletion or an independently enforced bucket lock.

The required local qualification includes the observer campaign and hashes its runtime, Worker entrypoint and tests. Local fixtures establish protocol composition only; live deletion and independent operator evidence remain separate prerequisites.
