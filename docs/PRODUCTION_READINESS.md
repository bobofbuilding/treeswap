# Production readiness

Status: Gate 0 is complete. Gate 1 tooling has started. No funded testnet or mainnet gate is complete.

“Production” means a capped mainnet bridge operated against published limits after testnet evidence and independent review. It does not mean public pooled liquidity, yield, or unlimited permissionless exposure.

## Gate 0 — freeze the safety boundary — complete

- [x] Full-fill, two-direction intent format and immutable escrows.
- [x] Exact units, fees, beneficiaries, hashes, deadlines, nonces, and replay domains.
- [x] No public LP deposits, rewards, partial fills, email delivery, or hidden upgrade path.
- [x] Local unit, integration, adversarial, and stateful invariant campaigns.
- [x] Threat ledger, launch checklist, incident sequence, and CI.

## Gate 1 — prove the live EVM boundary — in progress

- [x] Implement a credential-safe observer for one finalized BIT snapshot.
- [x] Pin the EIP-1967 implementation slot, proxy and implementation code hashes, pause state, decimals, symbol, finalized block hash, and source commit in its output.
- [x] Fail on the wrong chain, missing bytecode, an empty implementation slot, malformed finality, or unsafe token state.
- [ ] Capture the observation through two independently operated Ethereum RPC providers and compare every field.
- [ ] Match both runtime bytecodes to independently reviewed source and compiler settings.
- [ ] Promote the reviewed observation into a signed deployment manifest; never promote an `unreviewed-live-observation` automatically.
- [ ] Fork the recorded block and run proxy upgrade, pause/unpause, transfer-delta, finality rollback, escrow-open, claim, refund, and cross-direction hash-reuse campaigns.

Run the observer only with an authenticated mainnet endpoint:

```sh
ETHEREUM_RPC_URL=<secret> \
ETHEREUM_RPC_PROVIDER_LABEL=<provider> \
npm run observe:bit -- --out bit-observation.json
```

The command refuses to overwrite an existing file and never records the RPC URL.

## Gate 2 — prove the Lightning boundary

- [x] Build a pinned, internal two-node Bitcoin/LND regtest with balanced private-channel liquidity.
- [x] Bake distinct exact-URI invoice, payer, and observer credentials and prove representative forbidden RPCs fail.
- [x] Complete a real 10,000-sat hold-invoice create, decode, pay, accept, settle, and success smoke across the nodes.
- [ ] Connect the repository policy to a real isolated adapter process.
- [ ] Prove the complete forbidden-RPC matrix and credential timeouts.
- [ ] Test standard invoices and hold invoices through create, accept, settle, cancel, expire, and replay paths.
- [ ] Inject delayed and fast Bitcoin blocks, LND restart, lost responses, idempotent retry, force close, unsynced state, TLS pin change, credential rotation, and credential revocation.
- [ ] Prove that the computed Lightning cutoff always precedes the EVM refund boundary by the published margin.
- [ ] Produce a secret-free evidence bundle containing versions, configuration hashes, test results, and timestamps—never macaroons, invoices, or preimages.

The current lab and remaining fault matrix are documented in [Lightning regtest lab](./LIGHTNING_REGTEST.md).

## Gate 3 — build the durable automatic coordinator

- [ ] Persist intent nonce, payment hash, quote receipt, selected set, capacity epoch, reservation, Lightning action, and terminal state atomically.
- [ ] Make every value-moving action idempotent and recoverable after a process crash or ambiguous response.
- [ ] Run at least two independent RFQ relays plus direct solver endpoints; a relay may deliver but never rewrite or select a quote.
- [ ] Operate a solver daemon that quotes, reserves, waits for finality, performs the exact Lightning action, relays the preimage, reconciles, and halts on any mismatch.
- [ ] Keep browser, web server, relay, coordinator, and Lightning credentials in separate trust domains.
- [ ] Add structured metrics and alerts without logging invoices, preimages, wallet links, email, or unrestricted addresses.

## Gate 4 — permissionless solver testnet

- [ ] Permit any solver to publish a signed capability declaration and indicative quote without a central allowlist.
- [ ] Require an executable quote to bind exact inventory, capacity epoch, limits, endpoint keys, quote expiry, and settlement contract version.
- [ ] Allow Lightning → BIT only against already deposited, solver-owned BIT inventory.
- [ ] Give unknown BIT → Lightning solvers a tiny first-fill cap; raise limits only from objective completed-swap history or a separately reviewed bond design.
- [ ] Let clients query multiple relays, verify every signature locally, commit the received set, and choose one exact quote.
- [ ] Run two or more independently operated solvers through adversarial churn, withholding, relay censorship, restarts, and insolvency simulations.
- [ ] Publish fill rate, timeout rate, median completion, capacity freshness, and halt history per solver without claiming a globally best price.

## Gate 5 — deploy governance and operations

- [ ] Deploy distinct 2-of-3-or-stronger controller, guardian, and fee-recipient contract wallets with hardware-backed owners and tested recovery.
- [ ] Deploy the reviewed versioned contracts closed, seal the payment-hash registry, and reproduce every immutable and runtime code hash.
- [ ] Monitor the external BIT proxy implementation slot, BIT pause/decimals, EVM finality, price sources, solver capacity, LND health, and asset reconciliation continuously.
- [ ] Prove an alert blocks new exposure while every existing claim, refund, and withdrawal remains available.
- [ ] Run every incident in the incident runbook and attach the evidence to the release record.

## Gate 6 — independent review

- [ ] Contract review: both escrows, registry, gate, signatures, accounting, boundaries, and deployment reproducibility.
- [ ] Lightning review: invoice validation, HTLC timing, adapter permissions, idempotency, restarts, and force-close behavior.
- [ ] Coordinator review: persistence, concurrency, quote fairness, replay resistance, and recovery.
- [ ] Identity/privacy review: SIWE, optional wallet linking, retention, logs, and cross-network correlation.
- [ ] Operational review: multisigs, secrets, monitoring, reconciliation, incident command, and loss allocation.
- [ ] Pin every report digest and close or explicitly accept every finding before opening the release gate.

## Gate 7 — capped mainnet beta

- [ ] Publish exact contract addresses, source commit, review digests, fee schedule, price band, per-swap and per-epoch caps, daily Lightning cap, in-flight cap, reserve floor, and support path.
- [ ] Start with operator-owned solver inventory only, at substantially smaller limits than the tested maximum.
- [ ] Require explicit user confirmation for the exact quote and, when paying Lightning, the exact invoice.
- [ ] Reconcile continuously and close automatically on stale data, disagreement, unexpected code, role loss, or any inventory mismatch.
- [ ] Increase caps only through a new signed release record supported by observed reliability and incident-free operation.

## Separate future gate — public liquidity

Third-party deposits, shares, withdrawal queues, yield, and rewards are a new custody and economic protocol. They require new contracts and independent insolvency, accounting, adverse-selection, governance, and legal review. They are not required for a permissionless solver market.
