# Production readiness

Status: Gate 0 is complete. Gates 1, 2, and 3 are in progress. No funded testnet or mainnet gate is complete.

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
- [x] Pin one exact block behind each provider's finalized head, bind every state read to its canonical block hash with EIP-1898, and compare all safety-critical fields.
- [x] Reproduce the proxy from an exact Sourcify match and the implementation from Etherscan standard JSON, including the implementation-address immutables.
- [x] Fork the recorded block and pass live BIT snapshot, transfer-delta, both-direction open/claim/refund, pause/unpause, implementation-slot, and cross-direction hash-reuse campaigns.
- [ ] Capture the observation through two independently operated Ethereum RPC providers and compare every field.
- [ ] Obtain independent review of both matched source bundles, compiler inputs, roles, storage, and upgrade behavior.
- [ ] Promote the reviewed observation into a signed deployment manifest; never promote an `unreviewed-live-observation` automatically.
- [ ] Run controlled execution-client reorgs before and after escrow authorization/claim and attach finality-rollback evidence.

Run the observer only with an authenticated mainnet endpoint:

```sh
ETHEREUM_RPC_URL=<secret> \
ETHEREUM_RPC_PROVIDER_LABEL=<provider> \
npm run observe:bit -- --out bit-observation.json
```

For the second provider, pass the first observation's `finalizedBlock.number` so both providers inspect the identical state:

```sh
ETHEREUM_RPC_URL=<second-secret> \
ETHEREUM_RPC_PROVIDER_LABEL=<independent-provider> \
npm run observe:bit -- --block <first-finalized-block> --out bit-observation-2.json
npm run compare:bit -- bit-observation.json bit-observation-2.json --out bit-comparison.json
```

Only an eligible comparison from independent operators may enter review. The comparison remains explicitly unreviewed until source verification and reviewer signatures are attached.

The current reproducibility and fork evidence is recorded in [BIT mainnet boundary evidence](./BIT_MAINNET_EVIDENCE.md).

The command refuses to overwrite an existing file and never records the RPC URL.

## Gate 2 — prove the Lightning boundary

- [x] Build a pinned, internal two-node Bitcoin/LND regtest with balanced private-channel liquidity.
- [x] Bake distinct exact-URI invoice, payer, and observer credentials and prove representative forbidden RPCs fail.
- [x] Complete a real 10,000-sat hold-invoice create, decode, pay, accept, settle, and success smoke across the nodes.
- [x] Connect the repository policy to separate real invoice and payer adapter processes on the internal regtest network.
- [x] Require an exact, short-lived Ed25519 coordinator authorization before every action; the adapters hold only the public key.
- [x] Pin and verify LND TLS, mount one exact role credential per process, recheck node sync/active directional liquidity, and expose no host port.
- [x] Persist request IDs before dispatch and prove a completed payment remains replay-blocked after the payer process restarts.
- [x] Prove a payer authorization is rejected by the invoice process and representative forbidden macaroon RPCs fail.
- [x] Prove each credential's exact grant manifest against the pinned LND permission registry, require representative forbidden capability categories to fail specifically for authorization, and demonstrate live timeout enforcement.
- [ ] Test standard invoices and hold invoices through create, accept, settle, cancel, expire, late-settle, and replay paths.
  - [x] Hold create/accept/settle, cancel, expiry, wrong and late preimage, exact signed-action replay, and restart while accepted pass through the isolated adapters.
  - [x] Standard invoices above the signed fee cap or per-payment cap are rejected before dispatch, and read-only tracking proves `NOT_FOUND`.
  - [ ] Standard-invoice route failure and an explicit duplicate-payment attempt remain; standard success plus payer- and invoice-side lost-response recovery pass.
- [ ] Inject delayed and fast Bitcoin blocks, LND restart, lost responses, idempotent retry, force close, unsynced state, TLS pin change, credential rotation, and credential revocation. Accepted-state LND restart, one-dispatch payer and invoice recovery, root-key revocation, live in-flight saturation, channel-offline recovery, and TLS-pin mismatch now pass.
  - [x] Rapid blocks reach the live HTLC boundary; the adapter rejects settlement at a 24-block reserve, six blocks before the auto-cancel boundary observed in pinned LND.
- [ ] Prove that the computed Lightning cutoff always precedes the EVM refund boundary by the published margin. Pure ordering and the live Lightning-height boundary pass; combined EVM/Lightning fork or testnet evidence remains.
- [ ] Produce a secret-free evidence bundle containing versions, configuration hashes, test results, and timestamps—never macaroons, invoices, or preimages.

The current adapter boundary, live lab, and remaining fault matrix are documented in [Lightning adapter](./LIGHTNING_ADAPTER.md) and [Lightning regtest lab](./LIGHTNING_REGTEST.md).

## Gate 3 — build the durable automatic coordinator

- [x] Persist intent nonce, payment hash, quote receipt, selected set, capacity epoch, reservation, Lightning action, and mutually exclusive terminal state through atomic transitions.
- [ ] Make every value-moving action idempotent and recoverable after a process crash or ambiguous response.
  - [x] Lightning actions use a durable one-dispatch outbox; process restart, transport loss, replay conflict, and malformed success enter `UNKNOWN` and block retries.
  - [x] A live regtest payment recovers from a deliberately lost success response through a fresh read-only tracking request with dispatch count one.
  - [x] A live accepted hold invoice recovers from a deliberately lost settlement response through a preimage-free lookup with dispatch count one; SQLite, WAL, and shared-memory scans contain no preimage.
  - [x] Bind EVM claims to one signed transaction hash before broadcast; persist no raw preimage; permit only byte-identical rebroadcasts; require a canonical finalized successful receipt and exact `Claimed` event.
  - [x] A local Anvil campaign proves a real claim remains `UNKNOWN` after RPC acceptance, records its inclusion, and halts after the included transaction is removed by a snapshot reorg.
  - [ ] Prove finalized success, dropped/replaced transaction handling, nonce contention, provider disagreement, relayer-key rotation, and reorgs before and after authorization/claim on controlled forks and public testnet.
- [ ] Run at least two independent RFQ relays plus direct solver endpoints; a relay may deliver but never rewrite or select a quote.
- [ ] Operate a solver daemon that quotes, reserves, waits for finality, performs the exact Lightning action, relays the preimage, reconciles, and halts on any mismatch.
- [ ] Keep browser, web server, relay, coordinator, and Lightning credentials in separate trust domains.
  - [x] Repository containers separate the coordinator signing key/database from the adapters' public key and role macaroons; the public web database contains neither.
  - [ ] Reproduce that boundary with deployed service identities, networks, secret scopes, and independent backups.
- [ ] Add structured metrics and alerts without logging invoices, preimages, wallet links, email, or unrestricted addresses.
  - [x] The store exposes aggregate state counters and a secret-free event view; live campaigns prove neither the raw invoice nor EVM claim preimage is persisted.
  - [ ] Deploy alert routing and prove it closes only new exposure.

The coordinator state, crash semantics, live evidence, runtime qualification risk, and remaining work are documented in [Durable coordinator boundary](./COORDINATOR.md).

## Gate 4 — permissionless solver testnet

- [ ] Permit any solver to publish a signed capability declaration and indicative quote without a central allowlist.
- [ ] Require an executable quote to bind exact inventory, capacity epoch, limits, endpoint keys, quote expiry, and settlement contract version.
- [ ] Allow Lightning → BIT only against already deposited, solver-owned BIT inventory.
- [ ] Give unknown BIT → Lightning solvers a tiny first-fill cap; raise limits only from objective completed-swap history or a separately reviewed bond design.
- [ ] Let clients query multiple relays, verify every signature locally, commit the received set, and choose one exact quote.
  - [x] Direction-specific invoice competition is enforced: one user invoice for BIT → Lightning and one distinct solver hold invoice per Lightning → BIT offer.
  - [ ] Bind solver capability declarations to live Lightning node/payee control and authenticated endpoint keys.
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
