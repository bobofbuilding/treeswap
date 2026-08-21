# Account maintenance evidence

Status: bounded owner-only D1 maintenance and a secret-free live evidence runner are executable; the first retained live purge checkpoint is still required. This grants no funding authority.

## Maintenance boundary

Routine nonce issuance no longer deletes every expired nonce, and routine account reads no longer delete other wallets' notification records. An authenticated account read may delete only that same wallet's already-expired notification record.

The private Sites deployment exposes `POST /api/internal/account-maintenance` for an operator exercise. It accepts only the exact private Sites request URL and `Origin`, requires the complete D1 schema, and requires a currently active SIWE session. A request without all three conditions fails before maintenance runs.

One D1 transactional batch deletes at most 100 expired rows from each of `siwe_nonces`, `auth_sessions`, and `notification_preferences`. Every statement independently compares its retention timestamp with the same canonical UTC cutoff, orders oldest first, applies the fixed bound, and returns only enough row identifiers for the server to count success. The HTTP response exposes only the cutoff, fixed limit, aggregate counts, and whether another bounded pass might be needed. It never returns a wallet, email, nonce, session hash, or row body.

This endpoint is an owner exercise, not a scheduler. A production schedule must use a separately reviewed Cloudflare scheduled invocation or equivalently authenticated operator path, retain every aggregate result, alert on failures and sustained backlog, and never introduce a reusable browser credential.

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

Even a passing first run does not prove:

- continuous scheduled execution or alerting;
- deletion of an independently aged 24-hour session;
- deletion of an independently aged 24-hour notification record;
- backlog recovery across repeated batches;
- independently governed least-privilege D1 access;
- backup creation and witnessed restore; or
- independent authentication and privacy review.

Those items remain launch blockers in the [launch checklist](./LAUNCH_CHECKLIST.md).
