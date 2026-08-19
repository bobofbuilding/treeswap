# Campaign report

Scope: `TreeSwapBitVault`, one solver handler, exact-balance mock BIT, signed reservations, deposits, withdrawals, claims, and timeout refunds.

The suite currently contains 17 deterministic and parameterized tests plus three stateful invariants. Each invariant completed 256 runs and 16,384 calls with zero reverts and zero discarded actions. The campaign covers token liabilities, solver-account segregation, bounded epoch exposure, beneficiary binding, quote mutation, vault and chain replay, malformed signatures, nonce and payment-hash reuse, price and volume caps, fee caps, and claim/refund boundary timestamps.

This is a development harness, not an audit. Broader campaigns still need a mainnet-fork BIT token, proxy upgrade and pause scenarios, malicious-token callbacks, EIP-1271 signatures if contract wallets are supported, both-chain timeout races, a Lightning regtest adapter, and the complementary user-funded escrow.
