# Wallet-edge volume recovery evidence

Status: implemented as a local, non-authorizing campaign. It proves behavior of
the repository storage and fence primitives. It does not prove a deployed
persistent volume, operator practice, backup custody, host power-loss recovery,
or permission to start a wallet route.

## Safety objective

The supported wallet-intent edge is deliberately single-replica. A process
restart must not reset its authenticated-session request limit, and a crashed
replica must leave a fence that prevents automatic replacement. A full or
damaged volume must close the wallet path without committing a partial counter.
A backup must preserve the exact clock and rate state without containing a raw
session token, server token hash, session digest, wallet, request, quote,
invoice, handle, CSRF value, or gateway claim.

## Verified private backup and restore

`ContractIntentWalletAbuseStore.createVerifiedBackup` uses the runtime SQLite
backup API to create a consistent snapshot. If the store has been leased to an
edge, that edge must be stopped first. The destination must be a new file under
a private owner-controlled directory; the operation never overwrites the
source, an existing destination, a symlink, or a permissive path. A temporary
snapshot is checked with full SQLite integrity, exact schema and policy, and
every bounded row before it is synchronously copied to a mode-`0600` file.

The returned record contains only schema, aggregate window and clock values,
size, page count, and a SHA-256 file digest. Independent verification repeats
the full checks. Restore accepts only such a private verified backup, copies it
to a fresh private path, synchronizes the file and parent, opens it through the
normal strict store factory, and repeats full verification. It never replaces
the live database or grants request, wallet, Lightning, settlement, or funding
authority.

The adversarial test fills one session window, snapshots it, restores it, and
proves the restored ninth request remains rejected until the original window
expires. It also rejects active-edge backup, overwrite, in-memory backup,
extracted methods, permissive parents, policy-mutated snapshots, and restore of
a mutated snapshot. Raw session material remains absent from the backup.

## Real process-death and disk-full campaigns

The process-death test launches a separate Node process against a real private
database and runtime directory. That process commits one rate consumption,
acquires the no-stale-takeover replica fence, and is terminated with `SIGKILL`.
The next process reopens the database with the committed window intact and
cannot acquire the retained fence. The campaign deliberately does not delete or
reconcile that fence; automatic stale takeover remains forbidden.

The pinned coordinator image also runs the abuse ledger on a 128 KiB tmpfs,
commits a baseline window, fills the filesystem to an actual `ENOSPC`, and
attempts another consumption. SQLite failure halts the store and the second
window is not committed. After the filler is removed, a fresh process passes
full startup verification, retains the baseline window, and can add the second
window exactly once.

## Required deployed procedure

These local campaigns do not complete the deployment gate. A testnet operator
must still retain evidence for this sequence on the actual owner-controlled
volume:

1. close new wallet-intent admission and quiesce the one edge replica;
2. retain the crash fence until an independent check proves the old process is
   absent; never configure age-based deletion or automatic failover;
3. create a verified private backup, retain its digest under the approved
   custody and retention policy, and restore it to an isolated fresh path;
4. prove the isolated restore preserves the expected aggregate state, then
   destroy or re-custody it under the same privacy policy;
5. exercise real process kill, host restart, disk full, read-only volume,
   rollback, corruption, and alert delivery while the public gate remains
   closed; and
6. restart only after reconciliation confirms no active old replica, no lost
   wallet attempt, no unexpected counter rollback, and no open exposure.

The deployed CDN/listener, D1 session composition, private TLS, key custody,
monitoring, backup access controls, operator independence, browser campaigns,
and independent review remain required. Multi-host, serverless, and automatic
failover remain unsupported until a separate distributed fence and distributed
abuse policy are reviewed.
