# Durable wallet-intent abuse ledger

Status: implemented and adversarially tested as a repository control. It is not
deployed, does not create a wallet route, and grants no wallet, Lightning, pool,
or funding authority.

## Purpose

The same-origin SIWE edge permits at most eight authenticated wallet-intent
requests per session in one fixed 60-second window. That limit must not reset
when the edge process restarts. `ContractIntentWalletAbuseStore` therefore owns
one separate private SQLite ledger on the same single-replica deployment
boundary as the wallet edge.

The ledger never stores the raw session token, the server token hash, the
SIWE-session digest, a wallet, request or contract-intent digest, quote, invoice,
CSRF value, ownership handle, gateway claim token, request body, or response
body. Its primary key is a domain-separated SHA-256 commitment to the already
pseudorandom session digest. The remaining fields are only the fixed-window
start, count, session expiry, and last-seen time.

## Fixed policy and atomicity

The schema fixes these values in both strict table constraints and exact
metadata:

- eight accepted requests per session per 60 seconds;
- at most 128 active session windows; and
- a session lifetime no longer than 24 hours.

Each consumption uses one `BEGIN IMMEDIATE` transaction. The transaction checks
and advances a global durable clock high-water mark, removes only expired
windows, verifies the exact stored row, and either inserts or conditionally
increments one session counter. A rejected ninth request still commits the
new clock high-water mark. Concurrent processes on the same SQLite file cannot
both consume the same next count.

Backward time halts the ledger. Unexpected storage, schema, policy, or
transaction failure also halts it. The SIWE edge converts ordinary exhaustion
to its generic `429` response; a halted or unavailable ledger is a fatal edge
failure, causing the exclusive perimeter to return generic `503` and stop the
wallet path. No failure authorizes retrying a wallet request.

## Lifecycle and filesystem boundary

Persistent storage requires an explicit first initialization and a separate
`initialize: false` reopen. Initialization refuses an existing file; ordinary
startup refuses a missing, empty, permissive, symlinked, corrupted, or
policy-changed database. The parent is private mode `0700`, the database is a
regular mode-`0600` file, SQLite uses full synchronous writes and a delete
journal, and in-memory storage is accepted only as explicit initialized test
state.

One original store grants one exclusive same-process lease to one original SIWE
edge lifecycle. Retained direct references, copies, a second edge, accessors,
extra fields, post-abort consumption, and lifecycle substitution reject. Status
contains only aggregate counts and fixed policy flags.

A private backup is available only for persistent storage and, after an edge
has claimed the store, only after that edge lifecycle stops. The SQLite backup
is written through a fresh temporary file, fully integrity- and policy-checked,
synchronized, copied without overwrite to a fresh mode-`0600` destination, and
checked again. Verification and restore accept only private regular files and
restore only to a fresh path. Their records expose only aggregate state, file
size and digest; they grant no request or asset authority. See [Wallet-edge
volume recovery evidence](./WALLET_EDGE_VOLUME_RECOVERY.md).

## Evidence and remaining limits

Local tests cover exact exhaustion, restart persistence, durable clock rollback,
the 128-window ceiling and expiry, lease exclusivity, copied/accessor inputs,
unsafe paths and permissions, symlinks, policy tampering, verified private
backup/restore, a real `SIGKILL`, retained crash fencing, actual tmpfs
`ENOSPC`, and exclusion of the raw session digest from both database and
backup. The both-direction wallet path uses a real private file and checks that
session tokens, wallets, and request digests are absent from it.

This ledger removes the restart-reset gap for the supported conservative
single-replica deployment only. It is not a distributed rate limiter, consensus
lease, or automatic-failover mechanism. Production still requires a persistent
owner-controlled volume, witnessed execution of the implemented backup/restore
and failure campaigns on that volume, alerting for ledger halt or capacity
exhaustion, reviewed retention and access policy, the existing no-stale-takeover
replica fence, and an independently reviewed
distributed fence plus distributed abuse policy before any multi-host,
serverless, or automatic-failover wallet claiming. Funded operation remains
closed.
