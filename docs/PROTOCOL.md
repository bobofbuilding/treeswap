# TreeSwap protocol sketch

Status: local prototype specification, not audited and not ready for real funds.

## 1. Product invariant

TreeSwap clears swaps between:

- Bitcoin on the Lightning Network, measured in satoshis; and
- BIT on Ethereum mainnet, contract `0x57A447E4d5e18A9423408C365963A73F08B9d18C`.

The prototype uses a par value of:

```text
1 BIT = 100 sats
```

The verified BIT implementation is an upgradeable, pausable, 18-decimal ERC-20 vault token. Users mint BIT by depositing BNote ERC-1155 assets and redeem BNotes by burning BIT plus a configurable premium. TreeSwap does not call those mint or redeem paths. It only transfers existing BIT into and out of an isolated swap escrow.

The 100-sat par value is a TreeSwap economic rule supplied by the project owner. It is not an invariant in the BIT contract. Every swap therefore carries an explicit limit and minimum output; the interface must never imply the peg is guaranteed by the token contract.

## 2. Participants

| Participant | Role |
| --- | --- |
| Maker | Publishes a signed desired outcome with a limit, quantity, recipient, expiry, and fee ceiling. |
| Counter-maker | Publishes an intent in the opposite direction and can directly clear a compatible maker. |
| Solver | Quotes and fills unmatched or residual flow using its own Lightning and BIT inventory. |
| Coordinator | Relays intents, checks executability, reserves matches, and indexes state. It must not be able to steal escrowed assets. |
| Escrow contract | Holds BIT against a payment hash, reserved recipient, and timeout. |
| Lightning adapter | Creates or validates invoices and watches settlement/preimage state. |
| Liquidity provider | Funds one asset side and receives only that side's allocated fee share. |

## 3. Intent shape

An intent is an EIP-712 signed message plus direction-specific settlement data.

```ts
type TreeSwapIntent = {
  maker: `0x${string}` | `ln:${string}`;
  direction: "LIGHTNING_TO_BIT" | "BIT_TO_LIGHTNING";
  inputAmount: bigint;
  minimumOutput: bigint;
  parSatsPerBit: 100;
  destination: `0x${string}` | string;
  paymentHash: `0x${string}`;
  maxProtocolFeeBps: number;
  maxSolverFeeBps: number;
  maxRoutingFeeSats: bigint;
  allowPartial: boolean;
  nonce: bigint;
  expiry: number;
};
```

BIT does not expose native EIP-2612 permit in its verified ABI. A production flow therefore needs either a prior escrow allowance, a separate approval transaction, or a carefully reviewed Permit2 integration.

## 4. One book, two kinds of liquidity

Opposite user intents and solver quotes enter the same executable order book.

1. A Lightning → BIT intent is a bid to buy BIT with sats.
2. A BIT → Lightning intent is an ask to sell BIT for sats.
3. A solver quote is treated as a short-lived, fully collateralized order on the appropriate side.
4. Compatible opposite user intents match before the system requests inventory from a solver, when their net outcomes are at least as good as the best solver quote.
5. Solvers fill unmatched sizes and residual amounts.

The MVP uses all-or-nothing Lightning invoices. Partial fills require splitting a maker quantity into independently hashed child intents before publication; a single invoice/payment hash must not be reused across independent fills.

## 5. Ranking and rewards

TreeSwap borrows DeepState's price-first, time-second order-book rule, with an important change: it ranks **net executable output**, not an unadjusted headline price.

For each offer, the coordinator computes:

```text
net output = par output
           - protocol fee
           - solver spread
           - quoted Lightning routing allowance
           - any disclosed interface fee
```

Ranking rules:

1. Better net executable output wins.
2. Greater executable quantity wins only when a user asks for more than the first offer can fill.
3. Earlier verified arrival time breaks equal-output ties.
4. An order loses its position when collateral, invoice, channel capacity, heartbeat, or expiry is no longer valid.
5. The matching contract or signed execution receipt records the applied fee schedule so an active quote cannot be repriced.
6. Equal-output ties use an authenticated append-only sequence; coordinator receipt time alone is not trustworthy.

Only the current executable leader on each side accrues maker reward weight. Reward weight is proportional to time at the top and usable quantity, capped by the schedule. Rewards remain disabled until the ordering record is independently reproducible or challengeable. The prototype does not issue a reward token; the first implementation should use a bounded share of collected fees.

This avoids treating a stale or unexecutable top quote as economically superior. Consumers should still display quantity, expected gas, routing allowance, protocol fee, solver fee, and quote expiry.

## 6. Direct counter-intent settlement

### BIT → Lightning maker matched by Lightning → BIT taker

This is the cleanest direct match:

1. Alice creates a Lightning invoice for the sats she wants. Its payment hash is `H`.
2. Alice escrows BIT on Ethereum against `H`, a timeout, and the future taker's reserved Ethereum address.
3. Bob's opposite intent accepts the net price and the coordinator reserves the escrow to Bob.
4. Bob pays Alice's Lightning invoice.
5. Successful Lightning settlement reveals preimage `R` to Bob, where `sha256(R) = H`.
6. Bob submits `R` to the Ethereum escrow and receives Alice's BIT.
7. If the invoice is not paid before the reservation expires, Alice can unreserve and eventually refund her BIT.

The solver version is identical: the winning solver pays the invoice and claims the reserved BIT with the preimage.

### Lightning → BIT maker matched by BIT → Lightning taker

1. The BIT seller creates or controls a Lightning hold invoice with payment hash `H` and preimage `R`.
2. The seller escrows BIT to the buyer's Ethereum address against `H`.
3. The Lightning buyer pays the hold invoice.
4. The seller settles the invoice with `R` and irrevocably receives the sats.
5. The buyer learns `R` from the settled Lightning payment and claims the BIT escrow.
6. If the Lightning HTLC expires, the seller refunds the BIT after the longer Ethereum timeout.

Timeouts must be ordered so the party revealing a preimage always has enough time to claim the other leg. Exact values require review against the chosen Lightning implementation and Ethereum confirmation policy.

## 7. Escrow state machine

```text
DRAFT
  → OPEN          BIT deposited; hash and limits fixed
  → RESERVED      winning taker address and reservation deadline fixed
  → CLAIMED       valid preimage supplied; BIT released to reserved taker

OPEN or RESERVED
  → CANCELLED     only if no irreversible opposite-leg payment exists
  → REFUNDED      absolute timeout passed; BIT returned to depositor
```

Required protections include replay-safe nonces, reentrancy guards, token balance accounting, reservation expiry, explicit recipient binding, pause controls, bounded fees, and emergency actions that cannot redirect user escrow.

## 8. Directional fees

Recommended prototype defaults:

| Direction | Protocol default | Solver/routing treatment |
| --- | ---: | --- |
| Lightning → BIT | 10 bps | Sender pays normal Lightning routing; solver bids compete above the protocol fee. |
| BIT → Lightning | 35 bps | Solver quote adds outbound-liquidity spread and a capped routing allowance. |

The displayed prototype book shows total indicative costs starting around 18 bps and 72 bps respectively because the solver or counter-intent component is included.

Fee governance rules:

- Separate configurable defaults and hard caps per direction.
- Every intent signs maximum protocol, solver, routing, and interface fees.
- A governance change affects only new intents.
- In v1, the protocol fee is settled from the BIT leg in either direction; the solver's Lightning spread and routing allowance are embedded in the signed net-sats quote.
- Protocol fees apply only to successfully matched value, never unmatched collateral.
- Failed or expired intents pay no protocol execution fee, though users may still incur Ethereum gas or Lightning probing costs.
- A multisig and timelock should govern production changes before any broader onchain governance is considered.

## 9. Either-side liquidity pools

Lightning and BIT liquidity are accounted for separately.

- A Lightning LP funds solver-controlled Lightning capacity or a clearly disclosed custodial pool. It earns a share of fees from fills that consume outgoing sats.
- A BIT LP deposits into an audited vault with share accounting. It earns a share of fills that consume outgoing BIT.
- Depositing one side must not create an undisclosed claim on the other side.
- Inventory rebalancing is performed by solver trades, not by silently repricing LP shares away from the 100-sat project par.
- Withdrawals use a queue so funds committed to an accepted intent cannot be withdrawn mid-settlement.

Permissionless pooled Lightning custody is the highest-risk part of the design. The recommended MVP starts with solver-owned Lightning balances and a capped BIT vault, then adds public Lightning funding only after custody, channel, accounting, and insolvency behavior are specified and audited.

## 10. Mandatory safety invariants

- The Ethereum beneficiary is immutably bound before Lightning payment authorization.
- Payment hashes and maker nonces are single-use.
- Claim and refund are mutually exclusive terminal states.
- Claim/refund exits remain available when new intents are paused.
- Ethereum refund time is later than the final safe Lightning settlement time plus confirmation and congestion buffers.
- Every fee is included in the signed cap and cannot change after acceptance.
- BIT proxy implementation changes or pauses stop new reservations pending review.
- The 100-sat reference is protected by inventory caps, imbalance fees, and circuit breakers; it is not an unconditional redemption promise.
- Rewards remain off until price-time ordering can be independently verified.
- Partial fills use unique child hashes; a Lightning invoice hash is never reused.

See [`THREAT_MODEL.md`](THREAT_MODEL.md) for the complete adversarial review, findings, required properties, and launch gates.

## 11. Prototype boundaries and next milestones

Current prototype:

- demonstrates the product, quote ranking, price-time book, directional fees, settlement sequence, and LP concept;
- uses fabricated balances, offers, and settlement events;
- creates no external state and handles no real funds.

Recommended implementation order:

1. Solidity escrow contract and Foundry tests on a local Ethereum fork.
2. Regtest Lightning adapter with hold invoices and preimage lifecycle tests.
3. Signed intent and solver-quote schemas plus a deterministic matching library.
4. Adversarial tests for expiry races, preimage leakage, stale offers, griefing, partial fills, and fee rounding.
5. Capped testnet deployment with one operator and multiple independent solver processes.
6. Independent security review before any mainnet or public LP funds.
