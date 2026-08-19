# TreeSwap BIT vault properties

The Foundry campaign exercises the smallest production-relevant BIT inventory boundary for solver-funded Lightning → BIT swaps.

## Executable properties

1. The vault token balance always equals available solver inventory plus locked swap inventory.
2. A solver can withdraw only inventory that is not locked to an accepted swap.
3. A valid preimage always pays the beneficiary fixed in the user-signed quote, regardless of who relays it.
4. A swap reaches only one terminal state: claimed or refunded.
5. Every payment hash is single-use, including after a terminal state.
6. Every user nonce is single-use.
7. A signed quote cannot be changed after acceptance and cannot replay on another vault or chain.
8. Malformed or non-canonical ECDSA signatures cannot reserve inventory.
9. The signed net BIT amount and Lightning amount must remain within the immutable reference-price band.
10. No reservation can exceed the immutable per-swap cap or the solver's immutable per-epoch volume cap.
11. Quote acceptance precedes the last safe Lightning claim time, which precedes the Ethereum refund by an immutable buffer.
12. Claims close at the exact timestamp refunds open, eliminating an overlapping terminal-action window.
13. A failed or expired swap charges no execution fee.
14. A successful fee never exceeds the immutable contract cap.

## Out of scope for this harness

The campaign does not model Bitcoin block production, Lightning HTLC behavior, deriving `lastSafeClaimAt` from BOLT 11 expiry and CLTV, Ethereum reorgs, BIT proxy upgrades or pauses, EIP-1271 contract-wallet signatures, or the complementary user-funded BIT → Lightning escrow. Those require regtest, mainnet-fork, and integration tests before a testnet funding flow.
