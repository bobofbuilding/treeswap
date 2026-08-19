# Launch checklist

Status: the public prototype gate passes. Testnet and funded-mainnet gates do not.

No repository checkbox can substitute for deployed evidence. A gate becomes complete only when its artifact, exact deployment identifiers, test result, reviewer, and date are attached to a release record.

## Public prototype — complete

- [x] Swap actions are simulations; direct sends are labeled real, wallet-authorized, irreversible, and outside bridge protection.
- [x] `1 BIT = 100 sats` is disclosed as a reference rather than a token-enforced redemption promise.
- [x] No public pool, LP share, APY, yield, reward, partial-fill, or permissionless-solver path exists.
- [x] Threat model, policy documents, MIT license, locked dependencies, CI, and reproducible local build exist.
- [x] Both immutable escrow directions, the sealed shared registry, open gate, and adversarial harness are in the repository.

## Funded testnet — blocked

- [ ] Record the exact BIT proxy, implementation, proxy bytecode hash, implementation bytecode hash, pause state, decimals, and finalized block in a reviewed deployment manifest.
  - [x] Credential-safe finalized-state observer and negative tests implemented.
  - [ ] Capture matching observations from two independent authenticated RPC providers, verify source/bytecode, and promote them through review.
- [ ] Run the full escrow suite against a controlled Ethereum mainnet fork: proxy implementation change, pause/unpause while locked, reorg before and after open/claim, nonstandard transfer behavior, and finality rollback.
  - [x] Both actual TreeSwap escrows pass local Anvil block replacement before authorization, after authorization, and after claim, including canonical recovery with one beneficiary payout.
  - [ ] Repeat the reorg campaign against the pinned live BIT fork and public testnet; attach genuine finality-transition and independent-provider evidence.
- [ ] Run an isolated Bitcoin/LND regtest adapter: standard and hold invoices, exact BOLT 11 decode, delayed/fast blocks, accepted-HTLC cutoff, timeout, LND restart, force close, credential rotation/revocation, and negative macaroon permissions.
  - [x] Reproducible two-node regtest, balanced private channel, isolated real adapter processes, distinct expiring exact-URI credentials, authorization-specific negative checks, root-key revocation, hold-invoice terminal faults, accepted-state LND restart, rapid-block 24-block cutoff, genuine 500-block unsynced catch-up, full force-close/CSV-sweep/channel-replacement recovery, compressed-threshold stale-header rejection, fee/amount/in-flight caps, channel-offline recovery, and TLS-pin mismatch implemented.
  - [x] Live directional exhaustion rejects both outbound payment and inbound hold-invoice exposure before dispatch, then the exact operations recover after channel rebalancing.
  - [x] Fail-closed secret-free local qualification generator binds a clean published commit, immutable images, configuration hashes, timestamps, and complete pass states without capturing command output.
  - [x] Published checkpoint `d493edc3ee04b8f2392aa1fe2f5c6cb55c38c22b` passed all 19 local campaigns and hosted CI; local-only evidence digest `sha256:36465e9e780d9461808f4787ac2d56256497426f0e0e5affa929cbf06e58b06b`.
  - [ ] Complete the remaining production-duration delay, daily-cap rollover, and real TLS/credential rotation fault matrix. Full force-close recovery, genuine unsynced catch-up, directional exhaustion/rebalancing, no-route failure, compressed-threshold stale-header rejection, and both exact/same-hash duplicate paths now pass with one-or-zero dispatch as required.
- [ ] Deploy the gate, registry, and both escrows from the reviewed source commit. Seal the registry to exactly those escrows and prove every constructor immutable and runtime code hash.
- [ ] Deploy distinct 2-of-3-or-stronger controller, guardian, and fee-recipient contract wallets; record owners, thresholds, hardware-key custody, and recovery contacts.
- [ ] Operate atomic persistent RFQ quotas, cancellation sequence, capacity epochs, solver reliability, idempotent Lightning requests, and one-shot payment authorization.
  - [x] Atomic settlement/action store, one-dispatch Lightning outbox, restart recovery, and live payer- and invoice-side lost-response reconciliation implemented.
  - [x] Connect the EVM claim outbox to exact signed bytes, canonical receipt/finality checks, and fail-closed reorg detection; local execution-client evidence passes.
  - [ ] Connect atomic RFQ/admission counters, the complete solver daemon, deployed backups, and alerts; reproduce the EVM evidence on controlled forks and public testnet.
- [ ] Operate continuous BIT proxy/pause/finality/price monitoring and BIT/Lightning/in-flight reconciliation. Prove alerts close the gate and never block exits.
- [ ] Run at least two independent solvers with tiny testnet limits and no public deposits or rewards.
- [ ] Deploy durable SIWE/session storage only if accounts are enabled; otherwise disable the account feature. Keep email delivery disabled.

## Capped mainnet beta — blocked

- [ ] Obtain independent review of the Solidity contracts, Lightning timing/adapter, solver/coordinator, authentication/privacy, and operational controls; pin the report digest in the deployment manifest.
- [ ] Complete an incident drill for BIT upgrade, BIT pause, oracle disagreement, Ethereum reorg, LND outage, credential compromise, inventory mismatch, and suspected preimage leak.
- [ ] Publish exact per-swap, per-epoch, daily Lightning, in-flight, routing, price-band, and inventory-reserve caps. Start substantially below tested limits.
- [ ] Publish loss allocation, trust assumptions, solver liveness limits, privacy linkage, upgrade response, and support/escalation contacts.
- [ ] Collect testnet reliability data and adopt either an objectively adjudicable solver bond or an explicit no-bond exclusion/limit policy reviewed for the beta.
- [ ] Require a final release sign-off from engineering, security reviewer, Lightning operator, contract-wallet signers, and incident commander.

## Public liquidity — intentionally out of scope

Public deposits, transferable shares, yield, rewards, and withdrawal queues require a new protocol and separate custody, accounting, insolvency, adverse-selection, economic, and legal review. They cannot be enabled by changing a v1 flag.

The ordered work packages and evidence required to progress these gates are in [Production readiness](./PRODUCTION_READINESS.md).
