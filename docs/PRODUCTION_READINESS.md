# Production readiness

Status: Gate 0 is complete. Gates 1 through 4 are in progress. No funded testnet or mainnet gate is complete.

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
  - [x] A deterministic Anvil campaign replaces actual vault and user-escrow blocks before authorization, after authorization, and after claim; both directions reject stale authorization/dispatch, roll back orphaned receipts and balances, and recover through one canonical beneficiary-bound claim.
  - [ ] Reproduce against the pinned live BIT fork and public testnet with genuine finalized/unfinalized transitions and independent-provider observations.

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

The current reproducibility and fork evidence is recorded in [BIT mainnet boundary evidence](./BIT_MAINNET_EVIDENCE.md) and [controlled EVM reorg evidence](./EVM_REORG_EVIDENCE.md).

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
- [x] Test standard invoices and hold invoices through create, accept, settle, cancel, expire, late-settle, and replay paths.
  - [x] Hold create/accept/settle, cancel, expiry, wrong and late preimage, exact signed-action replay, and restart while accepted pass through the isolated adapters.
  - [x] Standard invoices above the signed fee cap or per-payment cap are rejected before dispatch, and read-only tracking proves `NOT_FOUND`.
  - [x] Standard success, terminal no-route failure, exact-request replay, same-hash duplicate rejection, and payer- and invoice-side lost-response recovery pass with one-dispatch evidence.
- [ ] Inject delayed and fast Bitcoin blocks, LND restart, lost responses, idempotent retry, force close, unsynced state, TLS identity change, credential rotation, and credential revocation. Accepted-state LND restart, terminal no-route failure, exact and same-hash duplicate rejection, one-dispatch payer and invoice recovery, overlap credential rotation and old-root revocation, real TLS certificate/pin rotation with rollback, live in-flight saturation, channel-offline recovery, genuine unsynced-node catch-up, full force-close recovery, and compressed-threshold stale-header rejection now pass.
  - [x] Rapid blocks reach the live HTLC boundary; the adapter rejects settlement at a 24-block reserve, six blocks before the auto-cancel boundary observed in pinned LND.
  - [x] A real no-block interval holds LND's observed height/header past a compressed local-progress limit; the adapter independently requires chain sync, wallet sync, bounded past age and future skew, and fresh progress, rejects before dispatch, and read-only tracking proves no payment exists even when the synthetic header timestamp is ahead of wall time.
  - [x] Pausing the payer node across a real 500-block backlog forces a genuine unsynced catch-up state; exact payment authorization rejects, read-only tracking proves zero dispatch, and both sync flags plus the active channel recover.
  - [x] Force-closing the only channel blocks new exposure; the real commitment confirms, its node-reported CSV maturity and sweep complete, pending-close exposure clears, and a fresh balanced channel restores service with zero prior dispatch.
  - [x] Draining one live channel side below a 100,000-sat exposure makes both outbound payment and inbound hold-invoice creation fail before dispatch; rebalancing restores the exact operations, with one payment and a canceled hold invoice.
  - [x] Separate live payer and invoice adapters saturate a 10,000-sat daily cap, restart against their durable journals, and reject the next exposure before dispatch; exact-boundary tests prove UTC value rollover never rolls permanent replay protection.
  - [x] Prove an exact replacement credential works concurrently, remains live after deterministic old-root revocation, and permits baseline recovery without leaving the temporary root or credential behind.
  - [x] Prove a real LND certificate/key rotation invalidates the old pin, preserves the node/channel, dispatches no payment, and recovers only after explicit peer reconnection and new-pin rollout, with rollback on failure.
  - [x] Prove fresh adapter state and restart cannot authorize exposure until a higher real block and new hash are durably observed; clock/height/hash/header conflicts remain latched until later progress.
  - [x] The uncompressed 3,600-second block-delay threshold passed again on published commit `f474e9c577f9c4e70183275f693ce89216e24032`: 3,603 monotonic seconds, 119 continuous observations, restart persistence after 1,813 seconds, deterministic no-progress rejection, and zero target-payment dispatch.
- [ ] Prove that the computed Lightning cutoff always precedes the EVM refund boundary by the published margin. Pure ordering and the live Lightning-height boundary pass; combined EVM/Lightning fork or testnet evidence remains.
- [ ] Produce a secret-free evidence bundle from the final published release commit containing versions, configuration hashes, test results, and timestamps—never macaroons, invoices, or preimages.
  - [x] A fail-closed generator requires clean published `main`, reruns every local qualification campaign, records no command output or environment data, rejects secret-bearing fields, and writes a non-overwriting mode-`0600` artifact under ignored `outputs/`.
  - [x] Published checkpoint `794b9f3bedb21dd6fe39dae0d7a10a5e94289899` passed all 25 local campaigns and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32312491429); its independently rebuilt local-only digest is `sha256:985eb9ff7eb610982edfa27088a731b6eabd277add22bfe0a7dabf6d61aba825`.
  - [x] Authenticated-endpoint checkpoint `f474e9c577f9c4e70183275f693ce89216e24032` passed all 25 local campaigns and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32318279120); its independently rebuilt local-only digest is `sha256:55170d90bb3509ca5c0f133327290863d158f2cfa6e0401178a7b8ce3d523b3a`.
  - [x] Capacity-reader checkpoint `67655f859ec70c191501d073e75cba808ce06def` passed all 26 local campaigns from `2026-08-20T02:15:55.025Z` through `2026-08-20T03:23:02.372Z` and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32323948108); its independently rebuilt local-only digest is `sha256:0c20cb3ea69ca7eb56ed5f79b215ad317523908ee09436ac4203966c90ac3d58`.
  - [ ] Attach the final release artifact digest, reviewer, and date to the signed deployment manifest.

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
  - [x] Schema v4 atomically persists opaque identity quotas, rolling cancellation/request events, permanent cancellation sequences, verified capability digests and expiries, monotonic solver capacity epochs, exact firm commitments, fill/failure reliability, and suspension. A quote cannot outlive its capability; v3 capability records migrate expired. Independent local connections cannot oversubscribe an identity or solver, and fills close the RFQ plus release competitors in one transaction.
  - [x] Published recovery checkpoint `dbc9f1daa205549a0af559bc024c40b347ca8ecd` passes 18 persistence tests directly inside the immutable Node `22.22.0-alpine` coordinator image plus a real bounded-filesystem `SQLITE_FULL` campaign. Verified non-overwriting backup/fresh-path restore, startup integrity and unknown-schema refusal, SIGKILL/WAL recovery, v2 migration, and rollback without partial state pass locally and in [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32311057995).
  - [x] The local capability verifier feeds only fully verified, independently observed capacity plus its signed expiry into the ledger; malformed proofs, cross-direction replay, capacity overstatement, stale observations, epoch rebinding, and expired capability/quote combinations fail closed.
  - [x] A local authenticated endpoint protocol binds each fresh request challenge, exact solver, direction, origin, response window, capability envelope, and Ed25519 response signature. Its default client refuses redirects and private, reserved, mapped, or mixed DNS; pins the public address through TLS; preserves SNI/hostname verification; bounds response work; and enforces a hard deadline.
  - [x] Concrete local readers independently compare finalized, canonical EIP-1898 BIT-vault state across two providers and obtain direction-bound, reserve/budget-capped Lightning aggregates through a separately signed short-lived request/observation protocol. The Lightning observation contains no channel identifiers and authenticates private node state; it is not a trustless balance proof.
  - [x] A deterministic durable-state planner prioritizes restart recovery and ambiguity, enforces direction-specific action order, forbids a BIT claim before confirmed Lightning payment, and halts paid-but-unclaimable paths. Confirmed payment preimages can be re-read after restart through an exact signed request but are never persisted.
  - [ ] Deploy the endpoint and reader protocols with independently operated RPC/Lightning observers; connect the planner to reviewed private-packet/secret rehydration and the existing finality/dispatch modules; deploy the reviewed persistence service; and run deployed-volume recovery plus real multi-instance drills.
- [ ] Keep browser, web server, relay, coordinator, and Lightning credentials in separate trust domains.
  - [x] Repository containers separate the coordinator signing key/database from the adapters' public key and role macaroons; the public web database contains neither.
  - [ ] Reproduce that boundary with deployed service identities, networks, secret scopes, and encrypted independently retained backups; measure restore objectives on the deployed volume.
- [ ] Add structured metrics and alerts without logging invoices, preimages, wallet links, email, or unrestricted addresses.
  - [x] The store exposes aggregate settlement, RFQ, firm-offer, capacity-conflict, and suspension counters plus a secret-free event view; live campaigns prove neither the raw invoice nor EVM claim preimage is persisted, and storage tests find no raw RFQ wallet identity.
  - [ ] Deploy alert routing and prove it closes only new exposure.

The coordinator state, crash semantics, live evidence, runtime qualification risk, and remaining work are documented in [Durable coordinator boundary](./COORDINATOR.md).

## Gate 4 — permissionless solver testnet

- [ ] Permit any solver to publish a signed capability declaration and indicative quote without a central allowlist.
- [ ] Require an executable quote to bind exact inventory, capacity epoch, limits, endpoint keys, quote expiry, and settlement contract version.
- [ ] Allow Lightning → BIT only against already deposited, solver-owned BIT inventory.
- [ ] Give unknown BIT → Lightning solvers a tiny first-fill cap; raise limits only from objective completed-swap history or a separately reviewed bond design.
- [ ] Let clients query multiple relays, verify every signature locally, commit the received set, and choose one exact quote.
  - [x] Direction-specific invoice competition is enforced: one user invoice for BIT → Lightning and one distinct solver hold invoice per Lightning → BIT offer.
  - [x] A short-lived direction-specific declaration binds the EVM solver, escrow domain, LND node public key, canonical HTTPS origin, Ed25519 endpoint key, exact capacities, monotonic epoch, and expiry. Local verification requires all three possession proofs plus fresh independent capacity observations; the live regtest campaign recovers the exact LND node from four challenges and rejects mutation/cross-role use.
  - [x] The local request/response transport authenticates the bound endpoint on a fresh challenge and fails closed on response mutation, stale authority, origin/identity mismatch, redirect, malformed input, timeout, capacity overstatement, and SSRF targets.
  - [x] The local capacity-reader campaign proves direction binding, dual-provider finalized vault agreement, exact runtime/proxy/implementation hashes, vault solvency, reserves and budgets, response/request replay rejection, separate observer keys, aggregate-only Lightning output, and cross-role denial.
  - [ ] Deploy the authenticated endpoint and reader protocols, then prove these bindings across at least two independently operated testnet solvers, observers, and relays.
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
