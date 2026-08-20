# TreeSwap settlement clock policy

Status: deterministic policy and boundary-test harness, local two-direction execution-client reorg evidence, a live rapid-block LND cutoff campaign, and one integrated local EVM/LND deadline campaign. Pinned live-BIT-fork and public-testnet timing evidence remain required before funding.

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

For Lightning → BIT, TreeSwap creates a hold invoice with a larger final CLTV than an ordinary invoice. The default policy requires at least 48 blocks and reserves 24 blocks for terminal onchain fulfillment. The wall-clock estimate uses a conservative minimum block interval because unexpectedly fast Bitcoin blocks make a height deadline arrive sooner. Once an HTLC is accepted, its actual expiry height is checked and can differ from the advertised final CLTV because of route and node policy. TreeSwap uses the stricter effective cutoff: an observed HTLC can shorten, but never extend, the signed deadline.

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

The pure policy tests cover ordering, exact cutoffs, unsafe invoice expiry, insufficient final CLTV, held-HTLC boundaries, Ethereum finality, reorg detection, and fail-closed service state. A local Anvil campaign replaces blocks containing both direction-specific escrows before authorization, after authorization, and after claim; dispatch is denied on a changed canonical hash and an orphaned claim rolls back to `LOCKED` before one canonical beneficiary-bound recovery claim. The same six boundaries now pass on an Anvil fork of the pinned live BIT state. Regtest proves rapid blocks reach the 24-block reserve while the HTLC remains accepted, the adapter rejects the correct preimage at the exact boundary, cancellation releases the payer, and no replacement payment is issued.

`npm run test:cross-chain-deadlines` now combines both systems in one bounded campaign. It deploys the actual TreeSwap vault and user escrow to an isolated loopback Anvil chain, binds live standard and hold BOLT 11 fields and payment hashes into their real EIP-712 quotes, requires twelve simulated EVM confirmations before either Lightning action, claims the BIT-to-Lightning escrow only with the actual paid-invoice proof, and drives the hold HTLC to its exact observed 24-block boundary. At that live boundary the vault is still non-refundable, a claim remains simulatable only before refund, claims fail exactly when refunds open, and solver inventory is restored only by the refund. Pinned LND advertised an 80-block final CLTV but produced an 83-block accepted delta in this direct route; the verifier accepts that safer route adjustment while rejecting an off-by-one boundary or any HTLC below policy. Private temporary state contains no invoice string or preimage, and the final evidence omits payment hashes, invoice digests, invoices, preimages, URLs, and funding authority.

The campaign uses mock BIT and simulated local EVM finality. A repeat on the pinned live BIT fork, genuine public-testnet finality through independent providers, production-like mempool congestion, and independently operated infrastructure remain testnet launch gates.

Clean published source `ccae7f05b4dbe8b082cc7880924717b781b20b6f` passed the integrated campaign inside all 34 sealed local qualification campaigns from `2026-08-20T19:45:37.092Z` through `2026-08-20T20:54:09.927Z`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32410170977) passed the same source. The ignored mode-`0600` artifact independently reconstructs to `sha256:7bc2988a39081d511a46abb7e27e2160e5dceabe23354e6faeeab14c0381f9ec` and explicitly records local-only scope, simulated EVM finality, no public testnet, no production infrastructure, no independent review, and no funding authorization.

`test:live-bit-cross-chain-deadlines` is the credentialed repeat of that exact sequence against the pinned BIT proxy fork. It requires clean published `main`, exact block/proxy/implementation/code-hash/slot/token-configuration provenance, live LND, the same deadline policy, and a distinct evidence schema that cannot be produced by mock mode. The runner and adversarial verifier are implemented, but no result is recorded for this checkpoint because no authorized archive RPC is available. See [Pinned live-BIT cross-chain deadline evidence](./LIVE_BIT_CROSS_CHAIN_EVIDENCE.md).
