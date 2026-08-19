# Campaign report

Scope: `TreeSwapBitVault`, one solver handler, exact-balance mock BIT, deposits, withdrawals, reservations, claims, and timeout refunds.

The suite includes deterministic lifecycle and adversarial relayer tests, a parameter fuzz test for deposit/withdraw conservation, and stateful invariants for token liabilities and solver-account segregation.

This is a development harness, not an audit. Broader campaigns still need a mainnet-fork BIT token, proxy upgrade/pause scenarios, malicious-token callbacks, timeout/refund actions in the stateful handler, and a Lightning regtest adapter.
