# Contract-intent wallet boundary

Status: a non-dispatching repository core prepares and reviews the exact user-wallet transaction for either TreeSwap escrow, records the wallet outcome without authorizing retry, verifies a reported or same-nonce replacement transaction, and classifies its receipt, reservation event, finality, mismatch, revert, disappearance, or reorg. It does not call a wallet, Ethereum provider, escrow, or Lightning node. Its two-observation result explicitly does not prove independent provider operation or authorize funds. Funded operation remains closed.

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

It reads chain and accounts again after the wallet returns. If the chain changes or the wallet disconnects after returning a hash, the hash is retained under `SUBMISSION_REPORTED_CONTEXT_CHANGED`. It is never discarded. Every non-rejection requires independent reconciliation and every outcome has `retryAuthorized: false`; an unknown result cannot be converted into a second send.

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

## Remaining release gates

This checkpoint intentionally leaves the production checklist open. Before either asset can move, TreeSwap still needs:

1. a fixed EIP-1193 dispatcher that invokes only the original preflight after a fresh explicit user confirmation, retains the returned hash, and never retries an ambiguous request automatically;
2. a strict durable journal and startup reconciler for preflight, wallet outcome, nonce, replacements, receipts, and reorgs, with disk-full, process-kill, backup/restore, and clock-rollback drills;
3. fixed authenticated Ethereum clients that project raw responses into this core, prove two genuinely independent providers, and bind the finalized reservation to the durable coordinator settlement;
4. deployed testnet evidence for both directions and common wallet types, including rejection, disconnect, dropped response, speed-up, cancellation, nonce contention, revert, provider disagreement/outage, and reorg before and after finality;
5. independent contract, wallet, coordinator, and operations review.

EIP-1271 user accounts remain excluded from this v1 wallet path. Supporting them requires a separately reviewed onchain signature-verification and deployed-wallet compatibility path.
