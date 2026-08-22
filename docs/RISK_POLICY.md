# TreeSwap fail-closed risk policy

Status: executable policy, bounded secret-free monitor, and local actual-gate halt harness. Production quotes remain disabled until live inputs, continuous scheduling, redundant guardian delivery, alert routing, and operations are deployed and independently reviewed.

## Why 100 sats is not enough

`1 BIT = 100 sats` is a TreeSwap reference, not a redemption right enforced by the BIT token. A solver must not quote solely from that value. Every quote first passes `evaluateBitRisk` in `lib/risk-policy.mjs`.

## Required inputs

The pre-quote gate rejects a request unless all of these are true:

1. Ethereum is mainnet and finality lag is within the configured limit.
2. The BIT proxy address, proxy bytecode hash, ERC-1967 implementation address, and implementation bytecode hash match pinned deployment values.
3. `decimals()` is exactly 18 and `paused()` is exactly false. An unavailable response fails closed.
4. The state snapshot is fresh.
5. At least three independent, fresh price sources each expose executable depth for the requested size.
6. The median executable price remains inside the configured reference band and the sources agree within a tighter spread limit.
7. Immutable contract caps and the offchain per-swap and per-epoch caps are not exceeded.
8. The inventory consumed by the direction remains above its reserve floor after the quote.

Duplicate, stale, shallow, or unavailable price sources do not count. A web-page price, last trade, or non-executable oracle observation is not sufficient.

## Inventory fees

Each direction has its own starting fee. The BIT → Lightning fee starts higher because it consumes outbound Lightning capacity. When the consumed side falls below the configured scarcity threshold, the fee increases linearly toward the hard maximum. The direction stops before the reserve floor can be crossed.

The fee is a risk and allocation control, not a substitute for the market-price circuit breaker.

For public-testnet adoption, the exact two base fees, maximum fee, reserve floor, and scarcity start are canonical fields in the signed [adoption policy](./ADOPTION_POLICY.md). Candidate preparation requires its eight limits and reserves to equal the release record and rejects fees above either deployed escrow's immutable ceiling.

## BIT proxy monitor and onchain gate

The monitor reads the standardized ERC-1967 implementation slot:

`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`

It also pins both proxy and implementation bytecode hashes. An `Upgraded` event is an alert input, but each quote must re-read state rather than trusting that an event was observed. `buildBitRiskAttestation` commits the reviewed chain, proxy, implementation, code hashes, decimals, pause flag, observation time, latest and finalized blocks, executable-price median/spread, and independent source set.

`TreeSwapOpenGate` deploys closed. A controller stages that nonzero digest, waits the immutable resume delay, and opens only until the attestation's bounded expiry. A stale attestation closes automatically. The guardian or controller can halt new reservations immediately and cancel a pending reopen. Neither role is called by deposits, withdrawals, claims, or refunds, so TreeSwap governance cannot pause exits. Both escrows also read `decimals()` and `paused()` at the opening transition and fail closed on an unavailable or unexpected response.

## Recovery rule

An automated halt is immediate. Resuming requires all inputs to be healthy, a written implementation and market review, the immutable delay, and the configured multisig change process. No single web server or solver process may silently update the pinned implementation or loosen the reference band. The controller and guardian addresses, delay, maximum open duration, and escrow gate address are immutable deployment parameters.

The recorded BIT v1 implementation applies its pause to mint and redeem, not ordinary ERC-20 transfers. The pinned mainnet-fork campaign therefore proves that a BIT pause closes new TreeSwap exposure while existing claims, refunds, and withdrawals remain transferable. TreeSwap must still model a transfer-blocking pause as a future-upgrade fault: if BIT's implementation changes that behavior, escrow state rolls back intact and the exit must be retried after recovery. Never authorize a Lightning action while paused. An implementation change never resumes automatically: review the new code and storage behavior, update the pinned deployment manifest through a new reviewed deployment if required, and only then stage a new risk digest.

## Deployment gate

Before testnet funding, record the expected proxy and implementation addresses and code hashes, configure three independent executable price sources, run the monitor continuously, alert on every failure reason, and test that the quote service actually stops. Before capped mainnet, the policy, data sources, and multisig recovery procedure require independent review.

The local monitor now requires fresh digest-only observations across the BIT, price, finality, provider-quorum, Lightning, capacity, reconciliation, and audit domains. Its actual-gate campaign closes quotes, submits a guardian halt, verifies the gate closed, and emits the alert afterward. This proves the bounded repository path, not a continuously deployed monitor or public alert integration. See [Safety monitoring boundary](./MONITORING.md).
