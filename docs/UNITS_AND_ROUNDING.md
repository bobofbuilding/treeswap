# TreeSwap units and rounding

Status: canonical integer model and adversarial test harness. UI decimal previews are informational; only canonical integer quote fields may be signed or submitted.

## Canonical units

- Lightning invoices and quote outputs: whole satoshis in unsigned 64-bit range.
- Lightning adapter internals: millisatoshis, accepted only when divisible by 1,000 for v1.
- BIT: wei at 18 decimals, with escrow amounts bounded to unsigned 96-bit range.
- Reference conversion: `1 BIT = 100 sats`, so one reference sat is exactly `10^16 BIT wei`.
- Rates: integer basis points over 10,000.

No floating-point number crosses an RFQ, signature, capacity, adapter, or contract boundary.

## Rounding order

The protocol fee is always `floor(gross BIT wei × feeBps / 10,000)` and is charged only on the BIT leg.

For Lightning → BIT, whole input sats convert to gross BIT wei, the BIT fee is rounded down, and the remainder is the exact user payout.

For BIT → Lightning, the BIT fee is rounded down first. The remaining BIT converts to whole output sats rounded down, then the signed maximum routing fee is subtracted. Any sub-satoshi BIT remainder stays explicitly recorded as `dustBitWei` in the solver leg; it is never silently counted as a protocol fee.

Exact-output quoting searches for the smallest gross integer input that satisfies the requested output. One unit less must not satisfy it.

## Conservation

Every accepted quote must satisfy:

```text
gross BIT wei = BIT payout/solver BIT wei + protocol fee BIT wei
reference Lightning sats = user Lightning sats + routing fee sats
solver BIT wei = reference Lightning sats × 10^16 + recorded dust BIT wei
```

An expired or unmatched quote charges no fee, so it has no fee or dust accumulator. Tests cover non-whole millisatoshis, one-wei boundaries, maximum supported values, exact-output minimality, and 10,000 small fills.
