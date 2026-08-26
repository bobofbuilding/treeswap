# Account maintenance evidence

Status: passed for an expired nonce on owner-only Sites version 12 at published source `b63ca78870628fa2a1bd5ef0c33fb979863ae95d`; continuous scheduling and independently aged session and notification evidence remain required. This grants no funding authority.

## Maintenance boundary

Routine nonce issuance no longer deletes every expired nonce, and routine account reads no longer delete other wallets' notification records. An authenticated account read may delete only that same wallet's already-expired notification record.

The private Sites deployment exposes `POST /api/internal/account-maintenance` for an operator exercise. It accepts only the exact private Sites request URL and `Origin`, requires the complete D1 schema, and requires a currently active SIWE session. A request without all three conditions fails before maintenance runs.

One D1 transactional batch deletes at most 100 expired rows from each of `siwe_nonces`, `auth_sessions`, and `notification_preferences`. Every statement independently compares its retention timestamp with the same canonical UTC cutoff, orders oldest first, applies the fixed bound, and returns only enough row identifiers for the server to count success. The HTTP response exposes only the cutoff, fixed limit, aggregate counts, and whether another bounded pass might be needed. It never returns a wallet, email, nonce, session hash, or row body.

This endpoint is an owner exercise, not a scheduler. The separate [scheduled account maintenance](./SCHEDULED_ACCOUNT_MAINTENANCE.md) runtime now defines a private Cron-only path with no browser credential, bounded deletion, create-only aggregate R2 evidence, and fail-closed backlog/retention behavior. Its real deployment and witnessed three-record drill remain open.

The repository's [account storage monitor](./ACCOUNT_STORAGE_MONITORING.md) now defines bounded D1 backlog probes, maintenance freshness, access-audit observations, and dual-route escalation. It does not create that schedule or any live collector.

Encrypted retention and a fresh isolated restore are governed separately by [account backup/restore evidence](./ACCOUNT_BACKUP_RESTORE_EVIDENCE.md); the verifier performs no platform mutation.

## Live exercise

After publishing and privately deploying the exact clean `main` commit, run:

```bash
TREESWAP_ACCOUNT_BYPASS_TOKEN=<short-lived-owner-token> \
TREESWAP_ACCOUNT_DEPLOYMENT_VERSION=<exact-version> \
npm run qualify:live-account-maintenance
```

The runner creates a fresh unfunded EOA in memory, signs in, issues a second nonce, proves a foreign origin cannot run maintenance, waits until that nonce is expired, runs one same-origin bounded batch, observes at least one expired nonce deletion, and proves the active session survived. It then signs out and proves the deleted session can no longer authorize maintenance. Best-effort sign-out runs on failure.

The non-overwriting mode-`0600` evidence record contains only exact source/deployment provenance, nine boolean checks, the fixed batch limit, timestamps, limitations, and its digest. It excludes the temporary wallet, nonce, SIWE message, signature, cookie, Sites credential, email, raw database output, and funding authority.

## What remains open

The passing first run does not prove:

- continuous scheduled execution or alerting;
- deletion of an independently aged 24-hour session;
- deletion of an independently aged 24-hour notification record;
- backlog recovery across repeated batches;
- independently governed least-privilege D1 access;
- backup creation and witnessed restore; or
- independent authentication and privacy review.

Those items remain launch blockers in the [launch checklist](./LAUNCH_CHECKLIST.md).

## Retained checkpoint

The version 12 exercise ran from `2026-08-21T19:16:58.564Z` through `2026-08-21T19:27:18.972Z` and passed all nine exact checks. It observed a real expired-nonce deletion, preserved the active session, rejected a foreign origin, and rejected the deleted session after sign-out. Its ignored mode-`0600` record independently reconstructs to:

```text
0x1b5a81b5a28755ea559f3d5f76b28270209b3425af2cc8fb9cafe0be2c45800a
```

The Sites control plane immediately before deployment reported custom access with exactly one owner, no groups, and no external visitors. That is operator evidence, not the required independent access-policy attestation. The public Vercel deployment separately returned the exact disabled account capability, no session, no email delivery, and a `403` maintenance-origin rejection.
