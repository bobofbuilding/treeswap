# TreeSwap fee policy

Status: enforced by both direction-specific escrow prototypes and canonical quote arithmetic. Live fee parameters remain deployment-manifest inputs subject to the immutable contract ceiling.

The public-testnet [adoption policy](./ADOPTION_POLICY.md) additionally requires BIT → Lightning to have a strictly higher base fee than Lightning → BIT and binds both values, the maximum fee, and inventory-scarcity thresholds into the five-role operational package and release candidate. The repository fixture uses 72 bps and 18 bps respectively; a real release must publish its own exact signed values within the deployed immutable ceiling.

## One protocol fee asset

TreeSwap charges its protocol fee only in BIT wei, in both directions. It never tries to skim a Lightning payment.

```text
protocol fee BIT wei = floor(gross BIT wei × signed feeBps / 10,000)
```

For Lightning → BIT, the fee is deducted from the BIT released to the user. For BIT → Lightning, it is deducted from the BIT released to the solver. The fee amount is part of the exact signed quote, checked against the immutable deployment cap, and transferred to the immutable `feeCollector` only after a valid preimage claim.

An unmatched, rejected, expired, or refunded swap pays no protocol fee. The entire locked BIT amount returns to its original owner on refund.

## Solver price and Lightning routing

The solver's spread is represented by the exact signed exchange amounts, not by an undisclosed transfer. A BIT → Lightning quote also binds `maxRoutingFeeSats`; its quoted Lightning output must already account for that cost. Any route cost above the signed maximum belongs to the solver and cannot reduce the user's output.

The product labels the percentage as a “BIT fee” and displays Lightning routing separately. A quote must show gross BIT, fee BIT, net BIT/Lightning output, and routing cap before authorization.

## Changes

An active swap cannot be repriced. A solver may offer a different fee only in a new short-lived quote that remains below the escrow's immutable `maxFeeBps`; the user must authorize the new exact terms. Changing the fee collector, absolute cap, or direction contracts requires a new reviewed deployment and cannot mutate existing escrows.
