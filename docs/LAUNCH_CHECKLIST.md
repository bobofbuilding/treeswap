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
  - [x] Live payer and invoice daily caps survive adapter restart and reject before dispatch; deterministic journal coverage proves exact UTC rollover while replay protection remains permanent.
  - [x] A replacement exact-role Lightning credential overlaps with the old credential, survives old-root revocation without service loss, and returns to a clean baseline across four consecutive runs.
  - [x] A real LND certificate/key rotation invalidates the old adapter pin without dispatch, preserves the node identity and channel, explicitly reconnects the peer, and restores service on the new pin with rollback protection.
  - [x] Fresh durable chain-progress state and restart both reject new exposure until a genuinely higher LND block is observed; the live campaign then permits exactly one payment.
  - [x] Fail-closed secret-free local qualification generator binds a clean published commit, immutable images, configuration hashes, timestamps, and complete pass states without capturing command output.
  - [x] Published checkpoint `794b9f3bedb21dd6fe39dae0d7a10a5e94289899` passed all 25 local campaigns and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32312491429); independently rebuilt local-only evidence digest `sha256:985eb9ff7eb610982edfa27088a731b6eabd277add22bfe0a7dabf6d61aba825`.
  - [x] Authenticated-endpoint checkpoint `f474e9c577f9c4e70183275f693ce89216e24032` passed all 25 local campaigns from `2026-08-20T00:43:19.448Z` through `2026-08-20T01:49:47.891Z` and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32318279120); its independently rebuilt local-only digest is `sha256:55170d90bb3509ca5c0f133327290863d158f2cfa6e0401178a7b8ce3d523b3a`.
  - [x] Capacity-reader checkpoint `67655f859ec70c191501d073e75cba808ce06def` passed all 26 local campaigns from `2026-08-20T02:15:55.025Z` through `2026-08-20T03:23:02.372Z` and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32323948108); independently rebuilt local-only evidence digest `sha256:0c20cb3ea69ca7eb56ed5f79b215ad317523908ee09436ac4203966c90ac3d58`.
  - [x] Daemon-recovery checkpoint `e860eabbfb188d3597df25ee8dfa14001126026e` passed all 26 local campaigns from `2026-08-20T03:38:59.074Z` through `2026-08-20T04:45:56.472Z` and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32328893965); independently rebuilt local-only evidence digest `sha256:65a86a92f7f93407df0cc8254e61cf3740fda2aaf9f76d663c3d9d49e8895419`. The record is mode `0600`, ignored, secret-free, and not funding authorization.
  - [x] The full 3,600-second no-progress interval passed with 3,603 monotonic seconds, 119 continuous observations, restart persistence after 1,813 seconds, deterministic rejection, and zero target-payment dispatch. Stateless initialization, full force-close recovery, genuine unsynced catch-up, daily-cap rollover, directional exhaustion/rebalancing, real TLS and overlap credential rotation/revocation, no-route failure, compressed-threshold stale-header rejection, both exact/same-hash duplicate paths, and four-challenge solver-node possession proof also pass with one-or-zero dispatch as required.
- [ ] Deploy the gate, registry, and both escrows from the reviewed source commit. Seal the registry to exactly those escrows and prove every constructor immutable and runtime code hash.
- [ ] Deploy distinct 2-of-3-or-stronger controller, guardian, and fee-recipient contract wallets; record owners, thresholds, hardware-key custody, and recovery contacts.
- [ ] Operate atomic persistent RFQ quotas, cancellation sequence, capacity epochs, solver reliability, idempotent Lightning requests, and one-shot payment authorization.
  - [x] Atomic settlement/action store, one-dispatch Lightning outbox, restart recovery, and live payer- and invoice-side lost-response reconciliation implemented.
  - [x] Connect the EVM claim outbox to exact signed bytes, canonical receipt/finality checks, and fail-closed reorg detection; local execution-client evidence passes.
  - [x] EVM reconciliation is read-only across exactly two provider origins and mutates durable state once only after exact agreement. A controlled timed-slot Anvil campaign passes finalized claim, disagreement-without-mutation, higher-fee same-nonce replacement, byte-identical rebroadcast, relayer rotation, and preimage non-persistence. The agreeing origins share one local backend, so this is not independent-provider evidence.
  - [x] Atomic local RFQ/admission persistence covers opaque rolling identity quotas, permanent cancellation sequences, monotonic capacity epochs, non-oversubscribed firm commitments, fill/failure reliability, and fail-closed suspension across restart and competing connections.
  - [x] The exact pinned coordinator image passes schema-v4 parity, verified non-overwriting backup/fresh-path restore, corruption and unknown-schema refusal, SIGKILL/WAL recovery, v2 migration, fail-closed v3 capability migration, solver capability, endpoint, capacity, action-recovery, and daemon-ordering verification, plus a real bounded-filesystem `SQLITE_FULL` rollback. The expanded pinned-runtime matrix passes 52 tests locally; published daemon-recovery commit `e860eabbfb188d3597df25ee8dfa14001126026e` also passed all 210 application/security tests and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32328893965).
  - [x] The local capability verifier binds EVM, LND-node, and endpoint-key possession to exact direction, inventory, epoch, and expiry; only fresh independently observed capacity reaches durable admission, and no firm quote may outlive the capability.
  - [x] The local endpoint protocol issues a fresh random challenge, authenticates the exact short-lived response with the bound Ed25519 key, pins the expected solver/direction/origin, refuses redirects and private or mixed DNS, preserves TLS hostname verification, and fails closed on timeout, malformed response, replay, or overstatement.
  - [x] Concrete local readers compare finalized canonical vault state across two RPC providers and obtain separately signed, direction-bound, reserve/budget-capped Lightning aggregates without channel identifiers. Mutation, replay, provider disagreement, insolvency, wrong code, cross-role use, and timeout fail closed.
  - [x] The durable-state daemon planner enforces restart/reconciliation priority and direction-specific payment/claim ordering. A lost or later-restarted successful payer action can recover its exact bound preimage through signed tracking while SQLite, WAL, and shared memory retain no invoice or preimage.
  - [x] The local one-use private-packet protocol and bounded daemon runtime bind an exact fresh packet plus observed reservation block and deadlines to an independent pre-dispatch authorization, execute at most one value-moving step, reconcile ambiguity without redispatch, repair an unbound EVM action after restart, and require a both-assets proof before terminal state. The current local matrix passes 226 application/security tests and 74 direct pinned-runtime tests plus the bounded-filesystem rollback campaign.
  - [x] Published authenticated-runtime checkpoint `ac08946d962d062845d585a716c829c0ad73a4a0` passed all 26 sealed local campaigns and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32334233367). Its independently reconstructed evidence digest is `sha256:dc6f60bacfa32332eb90bba0b75a879e35022f1cb473cba17241f225feb5450d`; its scope remains local-only with no funding authorization.
  - [x] Published EVM-outbox quorum checkpoint `cd2a81c0f5ecc7ab1902a1fa576d71f4c7520509` passed 226 application/security tests, 74 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both builds, all 27 sealed local campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32339918956). Its independently reconstructed digest is `sha256:f0e362260e813c3880b4328800a074c8f57df1459ec6b37a045369a718d17e5a`; agreeing local EVM origins share one backend, and the record grants no funding authorization.
  - [ ] Deploy the authenticated capability endpoint, private-packet provider, readers, finality authorizers, asset verifier, and bounded daemons with independent operators; add reviewed encrypted private transport, persistence, retained backups, alerts, and deployed-volume recovery drills; reproduce the EVM evidence on the pinned BIT fork and public testnet with two independently operated providers.
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
