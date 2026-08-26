# Contract-intent wallet boundary

Status: a repository core prepares and reviews the exact user-wallet transaction for either TreeSwap escrow, records the wallet outcome without authorizing retry, verifies a reported or same-nonce replacement transaction, and classifies its receipt, reservation event, finality, mismatch, revert, disappearance, or reorg. A strict private SQLite journal durably claims the attempt and records each original core artifact. A fixed same-process dispatcher now requires fresh explicit confirmation, the original preflight, an original journal claim, and an exact chain/account check before making one EIP-1193 request; every uncertain result becomes reconciliation-only work. This is local repository evidence, not a deployed browser/coordinator integration. It calls no Lightning node and its two-observation result does not prove independent provider operation or authorize funds. Funded operation remains closed.

## Pricing and settlement scope

The wallet boundary consumes the already authorized winning Lightning/BIT solver intent. Competing signed RFQs remain the only source of executable amounts and fees. `1 BIT = 100 sats` is a non-binding reference, not a wallet or contract invariant.

No BIT/WBTC pool exists, so it supplies no evidence. A future separately reviewed, mature, sufficiently liquid pool may supply at most one request-sized pre-selection risk signal. It cannot choose the solver, rewrite the signed intent, become this settlement transaction, satisfy price quorum alone, or restore fixed-par pricing.

## Exact preflight

`prepareContractIntentWalletPreflight` accepts only the original same-process authorized contract intent. It decodes and canonically re-encodes `TreeSwapBitVault.reserve` or `TreeSwapUserEscrow.open`, rechecks the calldata hash, quote ID, user, chain, target, runtime-code commitment, expiry, and zero ETH value, and produces one reviewable `eth_sendTransaction` request.

The function does not call `ethereum.request`. It neither connects an account nor switches a chain. The returned request and review carry `walletDispatchAuthority: false`, `lightningDispatchAuthority: false`, and `fundingAuthorization: false`.

Immediately before a future dispatcher may use that request, `verifyContractIntentWalletContext` requires the configured chain and the exact intent sender as the first active wallet account. A copied preflight has no provenance and rejects.

## Wallet outcome and retry rule

The response recorder admits exactly three outcomes:

- a lowercase transaction hash reported by the wallet;
- exact EIP-1193 user rejection code `4001`; or
- an ambiguous result with neither a hash nor a claimed error code.

It reads chain and accounts again after the wallet returns. If the chain changes, the wallet disconnects, or the post-request context cannot be read after returning a hash, the hash is retained under `SUBMISSION_REPORTED_CONTEXT_CHANGED`; `postContextUnavailable` distinguishes an unreadable post-context. It is never discarded. Every non-rejection requires independent reconciliation and every outcome has `retryAuthorized: false`; an unknown result cannot be converted into a second send.

## Transaction and replacement rule

The current v1 verifier accepts only a projected type-2 EIP-1559 transaction with canonical JSON-RPC quantities. Sender, destination, calldata, zero ETH value, chain, and reported hash must match the reviewed request exactly.

A replacement is accepted only when it has a different hash, the same nonce, and the same exact intent semantics. A cancellation, value transfer, other contract, other calldata, other chain, other sender, or different nonce rejects. Legacy/type-1 wallet transactions are deliberately outside v1 until their exact transport and replacement behavior is separately reviewed.

## Receipt and event rule

An observation validates the reviewed escrow runtime-code hash, receipt transaction identity, canonical inclusion block, receipt status, and the complete direction-specific `Reserved` or `Opened` event. The decoded quote ID, payment hash, user, solver, beneficiary, BIT amount, fee, Lightning amount, invoice digest, nonce, and all three deadlines must equal the authorized calldata.

The repository core classifies observations as:

- `NOT_FOUND` or `REORGED` when the transaction/receipt disappears;
- `REVERTED` for status zero;
- `MISMATCH` when the exact reservation event is absent or changed;
- `INCLUDED` before the provider's finalized head reaches inclusion; or
- `FINALIZED` when it does.

Two original observations must use distinct provider identities and agree on the exact transaction, receipt, inclusion block, finalized head, runtime-code hash, request, and contract-intent commitments. Even then the result is named `REPOSITORY_CORE_VERIFIED` and keeps `canonicalFinalizedReservation: false`: caller-supplied identity labels and projections do not prove that two independent providers were actually operated.

## Durable attempt journal

`ContractIntentWalletStore` is a Node-only, non-dispatching storage boundary. Before a future wallet dispatcher can be composed, it must durably claim the original preflight in this journal. That claim is an unresolved wallet attempt on every restart; serialization never restores same-process preflight provenance or permission to call the wallet.

The journal uses one exact strict SQLite schema, full synchronous writes, WAL, foreign keys, a monotonic high-water clock, bounded intent/artifact counts, canonical payloads, record digests, and owner-only regular files under an owner-only directory. It stores the exact chain, sender, escrow, calldata and digest, runtime-code commitment, quote commitments, expiry, wallet outcome, transaction/replacement chain, nonce, inclusion block, provider observations, and repository quorum. It stores no raw invoice, preimage, private key, provider URL, or wallet credential.

Only original same-process core artifacts can append. A copied object, second conflicting submission, invalid transition, future-dated observation, clock rollback, malformed path, permissive or symlinked database, changed schema, changed record, changed artifact, or inconsistent transition fails closed. Exact retries are idempotent.

Startup recovery returns one of four authority-free actions:

- `SEARCH_QUOTE_NO_RESEND` when the attempt was claimed or the wallet response was ambiguous;
- `RECONCILE_TRANSACTION_NO_RESEND` for a reported, pending, or temporarily missing transaction;
- `RECONCILE_RECEIPT_NO_LIGHTNING` after inclusion but before acceptable external finality; or
- `HALT_AND_RECONCILE_NO_RESEND` after revert, mismatch, or reorg.

A repository quorum returns `REQUIRE_DEPLOYED_FINALITY_PROOF_NO_LIGHTNING`. Every recovery has `retryAuthorized: false`; none authorizes wallet dispatch, Lightning, provider independence, canonical finality, or funding.

## Fixed one-shot dispatcher

`createContractIntentWalletDispatcher` fixes the system clock and a bounded wallet-response window. It accepts no connect or switch method. For one original preflight it performs this sequence:

1. present the exact frozen review and `eth_sendTransaction` request to the configured explicit-confirmation function;
2. durably create the journal claim;
3. read `eth_chainId` and `eth_accounts`, then verify the exact chain and first account;
4. consume the original same-process claim once immediately before dispatch;
5. call the wallet exactly once with the original frozen request;
6. classify exact code `4001`, a lowercase transaction hash, or every other result as ambiguous;
7. re-read context and durably record the original outcome before returning.

A timeout, malformed response, non-data or inherited rejection code, provider error, lost response, or unreadable post-context cannot trigger another send. If the journal fails after the request may have started, the dispatcher returns an explicit reconciliation-required error with any already-returned hash and `retryAuthorized: false`. If context fails after the claim but before the wallet request, restart still returns `SEARCH_QUOTE_NO_RESEND`. A declined confirmation creates no claim and contacts no provider. Concurrent or later use of the same claimed request cannot send again.

The production factory has no injected clock or timeout. A separately named test factory is the only path that accepts them. Local tests exercise both directions, exact request identity, rejection, response loss, post-hash disconnect, wrong chain, duplicate use, copied preflight, declined confirmation, and restart.

This module cannot prove that a callback represented a human gesture, prevent unrelated application code from directly calling an injected provider, or bridge the Node-only journal into a remote browser by itself. Those are deployment and architecture gates, not properties claimed by this checkpoint.

## Remaining release gates

This checkpoint intentionally leaves the production checklist open. Before either asset can move, TreeSwap still needs:

1. an authenticated deployed browser-to-coordinator claim/outcome route that makes the fixed dispatcher the only wallet path, demonstrates a real user gesture, and never turns a process or network retry into another wallet request;
2. composition of the journal into the persistent coordinator plus process-kill, disk-full, backup/restore, and multi-replica conflict drills;
3. fixed authenticated Ethereum clients that project raw responses into this core, prove two genuinely independent providers, and bind the finalized reservation to the durable coordinator settlement;
4. deployed testnet evidence for both directions and common wallet types, including rejection, disconnect, dropped response, speed-up, cancellation, nonce contention, revert, provider disagreement/outage, and reorg before and after finality;
5. independent contract, wallet, coordinator, and operations review.

EIP-1271 user accounts remain excluded from this v1 wallet path. Supporting them requires a separately reviewed onchain signature-verification and deployed-wallet compatibility path.
