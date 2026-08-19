# TreeSwap escrow properties

The Foundry campaign exercises both immutable BIT escrow directions, the sealed payment-hash registry, and the fail-closed open gate.

## Executable properties

1. The solver vault token balance always equals available inventory plus locked inventory.
2. The user escrow token balance always equals locked user liabilities.
3. Every user-funded deposit is exactly one of claimed, refunded, or still locked.
4. A solver can withdraw only inventory that is not locked to an accepted swap.
5. A valid preimage pays only the beneficiary fixed in the signed quote, regardless of the relayer.
6. A swap reaches only one terminal state, and claim closes exactly when refund opens.
7. Every payment hash is single-use across both real escrow contracts, including after a terminal state.
8. User and solver nonces are single-use in their direction.
9. Every field in both EIP-712 quote structures changes the signed digest.
10. Stateful mutation attempts against every signed field are rejected while other deposits, withdrawals, opens, claims, and refunds interleave.
11. Quotes cannot replay on another vault, chain, direction, or signature role.
12. Canonical EOA and ERC-1271 signatures pass; malformed, high-risk, wrong-owner, and mutated signatures fail.
13. Reference-price, per-swap, per-epoch, and fee caps cannot be exceeded.
14. Failed or expired swaps collect no fee; claims apply only the exact signed BIT fee.
15. Gate halts block new exposure without blocking withdrawals, claims, or refunds.
16. A hostile future token implementation that pauses transfers after open leaves state locked and recoverable after unpause; the recorded BIT v1 pause itself leaves transfers enabled.
17. Fee-on-transfer behavior fails the exact sender/recipient balance-delta checks and cannot advance state.
18. Registry allowlisting is exactly two contracts and irreversible after sealing.

## External campaigns still required

This local campaign does not model Bitcoin block production, live Lightning HTLC behavior, LND restarts or force closes, Ethereum reorg execution, or the deployed upgradeable BIT proxy. Those require Bitcoin regtest, a controlled Ethereum fork, exact deployed bytecode, and an isolated Lightning adapter before any funded testnet phase.
