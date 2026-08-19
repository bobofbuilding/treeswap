# TreeSwap settlement clock policy

Status: deterministic policy and boundary-test harness. Regtest, mainnet-fork, and fault-injection campaigns remain required before testnet funding.

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

For Lightning → BIT, TreeSwap creates a hold invoice with a larger final CLTV than an ordinary invoice. The default policy requires at least 48 blocks and reserves 18 blocks for terminal onchain fulfillment. The wall-clock estimate uses a conservative minimum block interval because unexpectedly fast Bitcoin blocks make a height deadline arrive sooner. Once an HTLC is accepted, its actual expiry height is checked and may shorten—but never extend—the signed deadline.

## Authorization gate

The Lightning adapter receives authorization only when all checks pass together:

- the escrow block has enough confirmations and is at or below the finalized head;
- its stored block hash is still canonical;
- the escrow digest exactly matches the signed intent;
- Ethereum finality lag is healthy;
- the BIT risk gate is open;
- BIT and Lightning balances reconcile;
- the Lightning node is synced; and
- the adapter is healthy and still before `lastSafeClaimAt`.

Any unknown or stale input rejects authorization. Observing a transaction is distinct from authorizing a Lightning payment.

## Required integration campaign

The pure policy tests cover ordering, exact cutoffs, unsafe invoice expiry, insufficient final CLTV, held-HTLC boundaries, Ethereum finality, reorg detection, and fail-closed service state. The remaining campaign must run with Bitcoin regtest, LND hold invoices, an Ethereum fork or testnet, controlled reorgs, delayed and fast blocks, mempool congestion, LND restart, held-HTLC timeout, and force-close. Those external results are a testnet launch gate, not something unit tests can prove.
