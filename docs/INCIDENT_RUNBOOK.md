# Incident runbook

Status: response sequence defined; live roles, alert integrations, and drills remain required.

## First principle

Protect exits before availability. Halt only new RFQs, firm quotes, reservations, and opens. Never deploy a response that disables a valid claim, refund, or withdrawal. The recorded BIT v1 pause leaves ERC-20 transfers enabled; treat any future implementation that blocks them as a degraded exit, preserve escrow state, and keep the retry path available after recovery.

## Automatic halt conditions

- BIT proxy implementation or pinned runtime code changes;
- BIT pauses, changes decimals, or returns unexpected transfer deltas;
- fewer than three fresh executable price sources, excessive source disagreement, or price outside the reviewed band;
- Ethereum finality lag, reorg, canonical-block mismatch, or RPC disagreement;
- Lightning node unsynced/unhealthy, TLS pin change, stale capacity epoch, daily/in-flight cap breach, or credential revocation;
- BIT, Lightning, or in-flight reconciliation mismatch;
- duplicate request, payment hash, adapter authorization, or unexplained preimage observation; or
- loss of quorum, signer compromise, monitoring outage, or missing audit data.

## Response sequence

1. The monitor stops quote issuance and the guardian calls `halt` with a public reason digest.
2. The coordinator stops creating new invoices and payment authorizations; the adapter rejects new value-moving RPCs.
3. Operators preserve logs without invoices, macaroons, preimages, email, or unnecessary addresses and record finalized chain/node snapshots.
4. Existing safe claims, refunds, and solver withdrawals continue. Operators publish any BIT-level pause that prevents an exit and monitor until recovery.
5. Reconcile every solver's available BIT, locked BIT, Lightning budget, in-flight HTLCs, terminal swaps, and fees. Treat an unexplained difference as loss until resolved.
6. Rotate or revoke the affected credential/root-key ID, session secret, signer, RPC endpoint, or TLS pin. Do not reuse a suspected secret.
7. Publish a plain-language incident notice describing affected directions, times, limits, user action, and known uncertainty without exposing private invoice data.
8. Prepare a reviewed root-cause record and remediation test. A controller may schedule reopening only with a fresh risk digest.
9. Wait the immutable reopen delay. Anyone may verify and execute the exact staged digest only while it remains fresh.

## Required evidence before reopening

- root cause and affected inventory are bounded;
- both chains and the Lightning node are healthy and reconciled;
- deployed code, implementation slot, roles, token settings, and price inputs match the reviewed manifest;
- compromised credentials are revoked and negative-permission tests pass;
- the original failure has a regression test or documented external drill result;
- guardian, controller quorum, Lightning operator, and incident commander sign the same release record; and
- users can still complete every outstanding claim, refund, and withdrawal.
