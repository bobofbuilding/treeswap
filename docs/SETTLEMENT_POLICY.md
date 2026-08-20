# TreeSwap settlement clock policy

Status: deterministic policy and boundary-test harness, local two-direction execution-client reorg evidence, and a live rapid-block LND cutoff campaign. Combined EVM/Lightning fork or testnet timing evidence remains required before funding.

## One ordered schedule

TreeSwap never accepts user- or solver-chosen deadlines directly. `deriveSettlementSchedule` combines the signed BOLT 11 fields, observed Bitcoin height, and configured Ethereum finality and congestion margins into:

```text
quoteExpiresAt < lastSafeClaimAt < refundAfter
```

- `quoteExpiresAt` is the last time the signed quote can open or reserve escrow.
- `lastSafeClaimAt` is the last time the Lightning adapter may begin or settle the direction-specific Lightning action.
- `refundAfter` is later by the complete Ethereum claim-relay, confirmation, and congestion buffer.

The onchain contracts independently enforce the same ordering and make claim and refund mutually exclusive at the exact refund boundary.

## Direction-specific Lightning rule

For BIT → Lightning, the solver pays a validated external invoice only after the user's BIT escrow is canonical and finalized.

For Lightning → BIT, TreeSwap creates a hold invoice with a larger final CLTV than an ordinary invoice. The default policy requires at least 48 blocks and reserves 24 blocks for terminal onchain fulfillment. The wall-clock estimate uses a conservative minimum block interval because unexpectedly fast Bitcoin blocks make a height deadline arrive sooner. Once an HTLC is accepted, its actual expiry height is checked and may shorten—but never extend—the signed deadline.

The pinned regtest LND release canceled a held HTLC when rapid mining reached the prior 18-block reserve. TreeSwap therefore uses 24 blocks locally, creating a six-block separation from that observed implementation boundary. This is conservative local evidence, not a promise that every LND version or channel policy uses the same auto-cancel height; production must pin and retest the node release and keep the TreeSwap cutoff earlier.

## Authorization gate

The Lightning adapter receives authorization only when all checks pass together:

- the escrow block has enough confirmations and is at or below the finalized head;
- its stored block hash is still canonical;
- the escrow digest exactly matches the signed intent;
- Ethereum finality lag is healthy;
- the BIT risk gate is open;
- BIT and Lightning balances reconcile;
- the Lightning node reports both chain and wallet sync, its best-header timestamp is inside configured past-age and future-skew limits, and the observed height/header has not exceeded the local no-progress ceiling; and
- the adapter is healthy and still before `lastSafeClaimAt`.

Any unknown or stale input rejects authorization. Observing a transaction is distinct from authorizing a Lightning payment.

Authorization is not a reusable boolean. `issueLightningAuthorization` creates a one-shot action ID bound to the exact intent, escrow block/hash, finalized head, and a maximum 15-second lifetime. Immediately before the LND RPC, `validateLightningDispatch` re-reads canonical block hash, finalized head, intent digest, risk gate, balances, node sync, and adapter health. A reorg, finality rollback, state change, exact expiry, or reused action ID rejects dispatch. Successful dispatch consumes the action ID once.

## Required integration campaign

The pure policy tests cover ordering, exact cutoffs, unsafe invoice expiry, insufficient final CLTV, held-HTLC boundaries, Ethereum finality, reorg detection, and fail-closed service state. A local Anvil campaign replaces blocks containing both direction-specific escrows before authorization, after authorization, and after claim; dispatch is denied on a changed canonical hash and an orphaned claim rolls back to `LOCKED` before one canonical beneficiary-bound recovery claim. The same six boundaries now pass on an Anvil fork of the pinned live BIT state. Regtest proves rapid blocks reach the 24-block reserve while the HTLC remains accepted, the adapter rejects the correct preimage at the exact boundary, cancellation releases the payer, and no replacement payment is issued. It also proves a real no-block interval crosses both the compressed local-progress ceiling and the uncompressed 3,600-second production ceiling despite a future-dated synthetic header, a real 500-block backlog forces unsynced catch-up, and a unilateral close blocks exposure through confirmation, CSV maturity, sweep, and fresh-channel recovery. Combined Ethereum/Lightning timing, genuine public-testnet finality through independent providers, and mempool congestion remain testnet launch gates.
