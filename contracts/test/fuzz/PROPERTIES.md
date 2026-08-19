# TreeSwap BIT vault properties

The Foundry campaign exercises the smallest production-relevant BIT inventory boundary:

1. The vault token balance always equals available solver inventory plus locked swap inventory.
2. A solver can withdraw only inventory that is not locked to an accepted swap.
3. A valid preimage always pays the beneficiary fixed at reservation, regardless of who relays it.
4. A swap reaches only one terminal state: claimed or refunded.
5. Every payment hash is single-use, including after a terminal state.
6. A failed or expired swap charges no execution fee.
7. A successful fee never exceeds the immutable contract cap.

The campaign does not model Bitcoin block production, Lightning HTLC behavior, BIT proxy upgrades, or Ethereum reorgs. Those require regtest/fork integration tests before a testnet funding flow.

