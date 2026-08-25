# TreeSwap fail-closed risk policy

Status: executable policy, bounded secret-free monitor, policy-bound two-route guardian/finalized-confirmation/alert failover, and local actual-gate halt harness. Production quotes remain disabled until live inputs, continuous scheduling, genuinely redundant guardian delivery and finalized-state confirmation, public alert routing, and operations are deployed and independently reviewed.

## Why 100 sats is not enough

`1 BIT = 100 sats` is a TreeSwap reference, not a redemption right enforced by the BIT token. A solver must not quote solely from that value. Every quote first passes `evaluateBitRisk` in `lib/risk-policy.mjs`.

## Required inputs

The pre-quote gate rejects a request unless all of these are true:

1. Ethereum is mainnet and finality lag is within the configured limit.
2. The BIT proxy address, proxy bytecode hash, ERC-1967 implementation address, and implementation bytecode hash match pinned deployment values.
3. `decimals()` is exactly 18 and `paused()` is exactly false. An unavailable response fails closed.
4. The state snapshot is fresh.
5. At least three independent, fresh price sources each bind the exact request direction, evidence digest, venue, control domain, and executable depth for both asset legs. Each source-policy digest must be explicitly allowlisted by the signed release risk policy. The complete caller-supplied set is hard-capped at 64 before source verification work.
6. The median executable price remains inside the configured reference band and the sources agree within a tighter spread limit.
7. The exact swap price implied by the Lightning sats and net BIT wei remains inside the same signed deviation ceiling around the live market median in both directions.
8. Immutable contract caps and the offchain per-swap and per-epoch caps are not exceeded.
9. The inventory consumed by the direction remains above its reserve floor after the quote.

Duplicate, stale, shallow, wrong-direction, wrong-chain, expired, copied, unverified, or non-allowlisted price sources do not count. An exact repeated observation is reduced to one candidate. Conflicting otherwise-eligible observations that reuse a source, venue ID, control domain, or operator organization are all quarantined and make the evaluation unsafe; caller ordering can never choose the surviving price. The remaining independent set is sorted canonically before its median and evidence are derived. Two RPC providers reading one pool are observation quorum for one price, not two prices. A web-page price, last trade, or non-executable oracle observation is not sufficient.

Every non-pool source must pass `lib/executable-venue-price-signal.mjs`: a policy-pinned organization signs a maximum-five-minute EIP-712 observation containing its exact price, dual-asset executable depth, validity, direction, and quote commitment. The risk gate accepts only the original same-process verified object and commits its policy and observation digests; a caller cannot supply a plausible-looking JSON substitute. An allowlisted signer proves which operator made the claim, while the release review must separately verify that each venue and control domain is genuinely independent and executable.

A future BIT/WBTC Uniswap v3 pool may contribute one request-sized source through the [BIT/WBTC market-reference boundary](./BIT_WBTC_MARKET_REFERENCE.md). Lightning ↔ BIT remains the only bridge product and settlement path; the pool only helps price BIT in bitcoin terms. It requires the exact policy-pinned BIT proxy and implementation runtime with an unpaused `BIT` / 18-decimal state, the canonical WBTC runtime with an unpaused `WBTC` / 8-decimal state, a finalized TWAP, active and wide-range liquidity floors, an exact-direction probe for the exact requested BIT amount, two-provider agreement, and a separately pinned WBTC/BTC peg conversion. The original pool signal is bound to the exact request direction and both economic amounts before the risk gate can use it. A favorable exact-output probe retains its actual lower market notional rather than being mislabeled shallow; the separate quote-versus-market check decides whether the TreeSwap terms are safe. Any BIT upgrade or unsafe BIT/WBTC token-state change invalidates the source. The pool and conversion feed cannot satisfy the three-source requirement by themselves, and the source is unavailable until the pool exists and completes its rollout gate. Tiny operator-funded testnet work may proceed under its separate closed caps without pretending the absent pool supplies a live price; public funded quotes may not.

## Inventory fees

Each direction has its own starting fee. The BIT → Lightning fee starts higher because it consumes outbound Lightning capacity. When the consumed side falls below the configured scarcity threshold, the fee increases linearly toward the hard maximum. The direction stops before the reserve floor can be crossed.

The fee is a risk and allocation control, not a substitute for the market-price circuit breaker.

For public-testnet adoption, the exact two base fees, maximum fee, reserve floor, and scarcity start are canonical fields in the signed [adoption policy](./ADOPTION_POLICY.md). Candidate preparation requires its eight limits and reserves to equal the release record and rejects fees above either deployed escrow's immutable ceiling.

## BIT proxy monitor and onchain gate

The monitor reads the standardized ERC-1967 implementation slot:

`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`

It also pins both proxy and implementation bytecode hashes. An `Upgraded` event is an alert input, but each quote must re-read state rather than trusting that an event was observed. `buildBitRiskAttestation` v2 accepts only the exact request used by the original same-process evaluation and commits its digest plus the complete snapshot digest, reviewed chain, proxy, implementation, code hashes, decimals, pause flag, observation time, latest and finalized blocks, executable-price median/spread, implied quote price, exact quote/market deviation, inventory fee and reserve result, independent source set, exact source-policy digests, and complete risk-policy digest. Substituting the direction, net BIT amount, Lightning amount, snapshot, or policy invalidates the attestation.

All deviation authorization decisions use exact cross-multiplication. The reported basis-point values may round down for display, but a value even one atomic unit beyond a signed ceiling rejects rather than disappearing in integer division.

`TreeSwapOpenGate` deploys closed. A controller stages that nonzero digest, waits the immutable resume delay, and opens only until the attestation's bounded expiry. A stale attestation closes automatically. The guardian or controller can halt new reservations immediately and cancel a pending reopen. Neither role is called by deposits, withdrawals, claims, or refunds, so TreeSwap governance cannot pause exits. Both escrows also read `decimals()` and `paused()` at the opening transition and fail closed on an unavailable or unexpected response.

## Recovery rule

An automated halt is immediate. Resuming requires all inputs to be healthy, a written implementation and market review, the immutable delay, and the configured multisig change process. No single web server or solver process may silently update the pinned implementation or loosen the reference band. The controller and guardian addresses, delay, maximum open duration, and escrow gate address are immutable deployment parameters.

The recorded BIT v1 implementation applies its pause to mint and redeem, not ordinary ERC-20 transfers. The pinned mainnet-fork campaign therefore proves that a BIT pause closes new TreeSwap exposure while existing claims, refunds, and withdrawals remain transferable. TreeSwap must still model a transfer-blocking pause as a future-upgrade fault: if BIT's implementation changes that behavior, escrow state rolls back intact and the exit must be retried after recovery. Never authorize a Lightning action while paused. An implementation change never resumes automatically: review the new code and storage behavior, update the pinned deployment manifest through a new reviewed deployment if required, and only then stage a new risk digest.

## Deployment gate

Before testnet funding, record the expected proxy and implementation addresses and code hashes, configure three independent executable price sources, run the monitor continuously, alert on every failure reason, and test that the quote service actually stops. Before capped mainnet, the policy, data sources, and multisig recovery procedure require independent review.

The local monitor now requires two fresh, short-lived EIP-712 observations from distinct policy-pinned operator commitments in each of the BIT, price, finality, provider-quorum, Lightning, capacity, reconciliation, and audit domains. One missing collector, disagreement, or any unsafe report halts. The same policy binds one quote closer, two distinct guardian-broadcast routes, two distinct finalized gate-confirmation routes, and two distinct alert routes. Its actual-gate campaign closes quotes, tolerates one guardian outage while the other broadcasts a halt, requires both read-only confirmers to agree on the exact successful finalized receipt, event, block, and fully closed gate state, and then tolerates one alert-route outage while the other delivers. A broadcaster's success claim alone never closes the monitor result; one confirmation outage or disagreement leaves the halt incomplete while alerts still run. Signatures and route commitments authenticate the configured local claims and wiring only; they do not prove honest, deployed, or organizationally independent operation. See [Safety monitoring boundary](./MONITORING.md).
