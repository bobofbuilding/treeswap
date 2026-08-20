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
  - [x] An exact promotion verifier now revalidates the complete deployment policy and matching fresh canonical observations, binds the finalized block, source, manifest, provider observation, review-bundle, and findings digests, and requires distinct EIP-712 approvals from every provider plus contract and operations reviewers. Its provenance-bound output has no funding authority. See [Signed deployment-manifest promotion](./DEPLOYMENT_PROMOTION.md).
  - [x] Clean published source checkpoint `bcbf2b03e7064be136cb54a8c567f905abec8516` passed 271 application/security tests, 91 direct pinned-runtime tests plus bounded-filesystem rollback, 68 contract tests, both builds, and all 33 sealed local campaigns from `2026-08-20T18:12:50.167Z` through `2026-08-20T19:20:55.699Z`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32401732721) passed the same source. Its ignored mode-`0600` evidence independently reconstructs to `sha256:cbb4f5b62033429e8db734a8fd98f29db6b4c444ccdf5ec18949f91059f90152`. It explicitly excludes real public-testnet operators, independent provider/reviewer evidence, production infrastructure, and funding authorization.
  - [x] The public-testnet evidence policy binds the exact reviewed deployment-manifest, source, admission, risk, and fee digests into every participant attestation. It cannot create or promote the manifest, and a changed digest invalidates every signature.
- [ ] Run controlled execution-client reorgs before and after escrow authorization/claim and attach finality-rollback evidence.
  - [x] A deterministic Anvil campaign replaces actual vault and user-escrow blocks before authorization, after authorization, and after claim; both directions reject stale authorization/dispatch, roll back orphaned receipts and balances, and recover through one canonical beneficiary-bound claim.
  - [x] Published commit `1908b539e2bcb6fa48ce9c2883a0770979b82b01` repeats all six block-replacement boundaries on an Anvil fork of exact Ethereum block `25788856` using the pinned live BIT proxy and implementation. The clean-published, secret-free result has digest `0x1475c60668bf57ded78659302e1e03382f17a26c1d8479835f8a8a2436176507`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32366965287) passed 240 application/security tests, 89 pinned-runtime tests plus disk-full rollback, 68 contract tests, both builds, and every noncredentialed EVM campaign.
  - [ ] Repeat on public testnet with genuine finalized/unfinalized transitions, two independently operated authenticated providers, deployed test escrows, and retained operator evidence.

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
  - [x] The uncompressed 3,600-second block-delay threshold passed again on published daemon-recovery commit `e860eabbfb188d3597df25ee8dfa14001126026e`: 3,603 monotonic seconds, 119 continuous observations, restart persistence after 1,813 seconds, deterministic no-progress rejection, and zero target-payment dispatch.
- [ ] Prove that the computed Lightning cutoff always precedes the EVM refund boundary by the published margin. Pure ordering, the live Lightning-height boundary, and an integrated local EVM/LND campaign pass; pinned live-BIT-fork and public-testnet evidence remain.
  - [x] The integrated local campaign binds both live invoice directions to actual TreeSwap escrows, waits for twelve simulated EVM confirmations, claims BIT only from the matching paid-invoice proof, drives the accepted hold HTLC to its exact observed 24-block boundary, proves the vault is not refundable there, and proves claim/refund mutual exclusion at the exact EVM refund timestamp. Its privacy-safe output has no funding authority; mock BIT and simulated EVM finality remain explicit limitations.
  - [x] Clean published source `ccae7f05b4dbe8b082cc7880924717b781b20b6f` passed 279 application/security tests, 91 direct pinned-runtime tests plus bounded-filesystem rollback, 68 contract tests, both builds, and all 34 sealed local campaigns from `2026-08-20T19:45:37.092Z` through `2026-08-20T20:54:09.927Z`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32410170977) passed the same source. Its ignored mode-`0600` evidence independently reconstructs to `sha256:7bc2988a39081d511a46abb7e27e2160e5dceabe23354e6faeeab14c0381f9ec`. This remains local-only evidence with simulated EVM finality and grants no funding authority.
  - [x] A credentialed combined runner now requires clean published `main`, forks the exact pinned live BIT block, re-verifies the proxy, implementation, both runtime hashes, implementation slot, symbol, decimals, and pause state, then runs the same live-LND two-direction deadline sequence. Its distinct evidence verifier rejects every provenance mutation and cannot accept mock evidence. See [Pinned live-BIT cross-chain deadline evidence](./LIVE_BIT_CROSS_CHAIN_EVIDENCE.md).
  - [ ] Execute that runner from the final published checkpoint through an authorized archive RPC and attach its privacy-safe digest. No authorized archive RPC is available in the current environment, so no live-BIT combined result is claimed.
- [ ] Produce a secret-free evidence bundle from the final published release commit containing versions, configuration hashes, test results, and timestamps—never macaroons, invoices, or preimages.
  - [x] A fail-closed generator requires clean published `main`, reruns every local qualification campaign, records no command output or environment data, rejects secret-bearing fields, and writes a non-overwriting mode-`0600` artifact under ignored `outputs/`.
  - [x] Published checkpoint `794b9f3bedb21dd6fe39dae0d7a10a5e94289899` passed all 25 local campaigns and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32312491429); its independently rebuilt local-only digest is `sha256:985eb9ff7eb610982edfa27088a731b6eabd277add22bfe0a7dabf6d61aba825`.
  - [x] Authenticated-endpoint checkpoint `f474e9c577f9c4e70183275f693ce89216e24032` passed all 25 local campaigns and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32318279120); its independently rebuilt local-only digest is `sha256:55170d90bb3509ca5c0f133327290863d158f2cfa6e0401178a7b8ce3d523b3a`.
  - [x] Capacity-reader checkpoint `67655f859ec70c191501d073e75cba808ce06def` passed all 26 local campaigns from `2026-08-20T02:15:55.025Z` through `2026-08-20T03:23:02.372Z` and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32323948108); its independently rebuilt local-only digest is `sha256:0c20cb3ea69ca7eb56ed5f79b215ad317523908ee09436ac4203966c90ac3d58`.
  - [x] Daemon-recovery checkpoint `e860eabbfb188d3597df25ee8dfa14001126026e` passed all 26 local campaigns from `2026-08-20T03:38:59.074Z` through `2026-08-20T04:45:56.472Z` and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32328893965); its independently rebuilt local-only digest is `sha256:65a86a92f7f93407df0cc8254e61cf3740fda2aaf9f76d663c3d9d49e8895419`. The mode-`0600` ignored record explicitly excludes production infrastructure, public testnet, independent review, and funding authorization.
  - [x] Deployment-observer checkpoint `44d929e708768d8bbe53087b415eda0f4ac75f43` passed 239 application/security tests, 89 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both builds, all 29 sealed local campaigns from `2026-08-20T10:44:40.005Z` through `2026-08-20T11:52:49.730Z`, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32360223386). Its independently rebuilt mode-`0600` local-only digest is `sha256:9a0bb29bc90d603327b56606603489247f2b3cab5f3be5ecad18d2cd8417d5e9`; the record explicitly excludes independent providers, production multisigs, public testnet, production infrastructure, review, and funding authorization.
  - [x] Live-BIT-reorg qualification checkpoint `c67d385cc00a6506ce7b8766d208c7c1ceb2b11b` passed 240 application/security tests, 89 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both builds, and all 29 sealed local campaigns from `2026-08-20T12:08:42.039Z` through `2026-08-20T13:16:50.096Z`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32367298446) passed the same published source. The ignored mode-`0600` record independently reconstructs to `sha256:20c43996d638a6d95b4d51a3c388701d5e245096dd9dc3eb9b1c5b77f986afef`. It configuration-hashes the credentialed live-fork runner; the separate clean-published fork result is `0x1475c60668bf57ded78659302e1e03382f17a26c1d8479835f8a8a2436176507`. Neither record includes public testnet, independent providers, production infrastructure, independent review, or funding authorization.
  - [x] Cross-chain-deadline qualification checkpoint `ccae7f05b4dbe8b082cc7880924717b781b20b6f` passed all 34 local campaigns, including the uncompressed 3,604-second/119-observation chain-delay campaign and the integrated two-direction EVM/LND deadline campaign. The clean-source artifact independently reconstructs to `sha256:7bc2988a39081d511a46abb7e27e2160e5dceabe23354e6faeeab14c0381f9ec`; its limitations exclude public testnet, production infrastructure, independent review, and funding authorization.
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
  - [x] The unattended daemon requires exactly two read-only EVM provider observations to agree before one durable transition; outage or disagreement leaves the action `UNKNOWN` without recording an inclusion.
  - [x] A second controlled Anvil campaign proves genuine local finalized success, higher-fee same-nonce replacement without claim execution, byte-identical rebroadcast only, provider disagreement before durable mutation, relayer substitution rejection, newly bound relayer rotation, and no persisted preimage. The two agreeing origins share one local backend and do not satisfy independent-provider evidence.
  - [ ] Repeat finalized success, provider outage/disagreement, dropped/replaced transaction and nonce contention, relayer-key rotation, and reorgs before and after authorization/claim on the pinned live BIT fork and public testnet using two independently operated authenticated providers.
- [ ] Run at least two independent RFQ relays plus direct solver endpoints; a relay may deliver but never rewrite or select a quote.
- [ ] Operate a solver daemon that quotes, reserves, waits for finality, performs the exact Lightning action, relays the preimage, reconciles, and halts on any mismatch.
  - [x] Schema v4 atomically persists opaque identity quotas, rolling cancellation/request events, permanent cancellation sequences, verified capability digests and expiries, monotonic solver capacity epochs, exact firm commitments, fill/failure reliability, and suspension. A quote cannot outlive its capability; v3 capability records migrate expired. Independent local connections cannot oversubscribe an identity or solver, and fills close the RFQ plus release competitors in one transaction.
  - [x] Published recovery checkpoint `dbc9f1daa205549a0af559bc024c40b347ca8ecd` passes 18 persistence tests directly inside the immutable Node `22.22.0-alpine` coordinator image plus a real bounded-filesystem `SQLITE_FULL` campaign. Verified non-overwriting backup/fresh-path restore, startup integrity and unknown-schema refusal, SIGKILL/WAL recovery, v2 migration, and rollback without partial state pass locally and in [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32311057995).
  - [x] The local capability verifier feeds only fully verified, independently observed capacity plus its signed expiry into the ledger; malformed proofs, cross-direction replay, capacity overstatement, stale observations, epoch rebinding, and expired capability/quote combinations fail closed.
  - [x] A local authenticated endpoint protocol binds each fresh request challenge, exact solver, direction, origin, response window, capability envelope, and Ed25519 response signature. Its default client refuses redirects and private, reserved, mapped, or mixed DNS; pins the public address through TLS; preserves SNI/hostname verification; bounds response work; and enforces a hard deadline.
  - [x] Concrete local readers independently compare finalized, canonical EIP-1898 BIT-vault state across two providers and obtain direction-bound, reserve/budget-capped Lightning aggregates through a separately signed short-lived request/observation protocol. The Lightning observation contains no channel identifiers and authenticates private node state; it is not a trustless balance proof.
  - [x] A deterministic durable-state planner prioritizes restart recovery and ambiguity, enforces direction-specific action order, forbids a BIT claim before confirmed Lightning payment, and halts paid-but-unclaimable paths. Confirmed payment preimages can be re-read after restart through an exact signed request but are never persisted.
  - [x] Published checkpoint `e860eabbfb188d3597df25ee8dfa14001126026e` passed 210 application/security tests, 52 direct pinned-runtime coordinator tests plus the bounded-filesystem rollback campaign, both web builds, 68 contract tests, every live Lightning campaign, and hosted CI. Its real payer lost-response campaign restarts twice, re-reads the exact hash-bound success proof without redispatch, and finds no invoice or preimage in SQLite, WAL, or shared memory.
  - [x] A local signed one-use private-packet protocol binds the exact settlement, reservation, action, quote, selected offer, capacity epoch, payment hash, invoice digest, deadlines, direction, purpose, provider, and fresh caller challenge. Only the verified module-private result may reach execution; replay, mutation, wrong action/provider/purpose, deadline inflation, public origins, and an EVM packet containing a preimage fail closed.
  - [x] A bounded local runtime executes one planner step per call, requires an independent authorization bound to the exact packet and observed reservation block before dispatch, preserves one-shot ambiguity handling, repairs the planned-but-unbound EVM transaction crash window, and requires an independent both-assets proof before terminal state. Its live payer campaign loses the successful response, restarts, reconciles without redispatch, and persists no invoice or preimage. The current local matrix passes 246 application/security tests and 91 direct pinned-runtime tests plus the bounded-filesystem rollback campaign.
  - [x] Published authenticated-runtime checkpoint `ac08946d962d062845d585a716c829c0ad73a4a0` passed the full matrix, all 26 sealed local qualification campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32334233367). The qualification ran from `2026-08-20T05:05:56.878Z` through `2026-08-20T06:12:48.897Z` and independently reconstructs to `sha256:dc6f60bacfa32332eb90bba0b75a879e35022f1cb473cba17241f225feb5450d`. It explicitly grants no funding authorization.
  - [x] Published EVM-outbox quorum checkpoint `cd2a81c0f5ecc7ab1902a1fa576d71f4c7520509` passed 226 application/security tests, 74 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both build paths, all 27 sealed local campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32339918956). The qualification ran from `2026-08-20T06:32:18.096Z` through `2026-08-20T07:39:19.663Z` and independently reconstructs to `sha256:f0e362260e813c3880b4328800a074c8f57df1459ec6b37a045369a718d17e5a`. It explicitly records no independent provider, public testnet, production infrastructure, review, or funding authorization.
  - [ ] Deploy the endpoint, private-packet, and reader protocols with independently operated RPC/Lightning observers; protect provider confidentiality with reviewed network identity and encrypted transport; deploy finality authorizers, the both-assets verifier, bounded daemons, and reviewed persistence; then run deployed-volume recovery plus real multi-instance drills.
- [ ] Keep browser, web server, relay, coordinator, and Lightning credentials in separate trust domains.
  - [x] Repository containers separate the coordinator signing key/database from the adapters' public key and role macaroons; the public web database contains neither.
  - [ ] Reproduce that boundary with deployed service identities, networks, secret scopes, and encrypted independently retained backups; measure restore objectives on the deployed volume.
- [ ] Add structured metrics and alerts without logging invoices, preimages, wallet links, email, or unrestricted addresses.
  - [x] The store exposes aggregate settlement, RFQ, firm-offer, capacity-conflict, and suspension counters plus a secret-free event view; live campaigns prove neither the raw invoice nor EVM claim preimage is persisted, and storage tests find no raw RFQ wallet identity.
  - [x] A bounded local monitor accepts only exact fresh digest-only observations, emits fixed reason codes, closes quote issuance, submits the same digest to the actual onchain gate through a guardian contract, and alerts after closure. Malformed or extra-field input fails closed without entering the alert; a healthy cycle has no reopen authority.
  - [x] Published safety-monitor checkpoint `4b40a3ca682b63f8d1fec11fa1900448d33676f5` passed 233 application/security tests, 81 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both builds, all 28 sealed local campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32345936040). The qualification ran from `2026-08-20T07:52:32.228Z` through `2026-08-20T08:59:56.235Z` and independently reconstructs to `sha256:2644372eebed253ae9649c625a770953ed8c90b9d8da7876cb69ec514e265450`. It explicitly records no public testnet, production infrastructure, independent review, or funding authorization.
  - [ ] Deploy continuous redundant collectors, scheduler, guardian broadcasters, and alert routing; prove delivery/escalation against the deployed gate and retain secret-free incident evidence.

The coordinator state, crash semantics, live evidence, runtime qualification risk, and remaining work are documented in [Durable coordinator boundary](./COORDINATOR.md).

## Gate 4 — permissionless solver testnet

- [ ] Deploy and demonstrate open solver competition on public testnet through multiple independent operators and delivery paths.
  - [x] An exact candidate-evidence verifier now requires at least two separately identified and signing EVM providers, Lightning observers, monitors, relays, solvers, and alert channels; a seven-day bidirectional campaign; twenty-four mandatory adversarial scenarios; per-solver reliability/halt metrics; a final closed gate; and zero unreconciled liabilities. Its derived output has no funding authority. See [Public-testnet campaign evidence](./PUBLIC_TESTNET_EVIDENCE.md).
  - [x] Clean published evidence-boundary checkpoint `e662885346791b80153835c3123f0f77b63ad9f5` passed 263 application/security tests, 91 direct pinned-runtime tests plus bounded-filesystem rollback, 68 contract tests, both builds, and all 32 sealed local campaigns from `2026-08-20T16:49:58.056Z` through `2026-08-20T17:57:51.589Z`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32394191747) passed the same source. The ignored mode-`0600` record independently reconstructs to `sha256:de647c4a2b35e411bed48a2062e2964c008702f6f17715072b5d9c9388575e6d` and explicitly excludes real public-testnet operators, production infrastructure, independent review, and funding authorization.
  - [x] Repository admission has no solver allowlist: any solver may publish an indicative offer, while only a fully verified EVM, endpoint, LND-node, escrow-runtime, and independently observed capacity declaration can produce an executable offer.
  - [x] An executable offer binds the exact capability and capacity-snapshot digests, observed inventory, per-solver capacity epoch, endpoint key, quote expiry, and direction-specific settlement runtime code hash. An indicative book cannot authorize invoice payment or settlement.
  - [x] Lightning → BIT is admitted only against exact, independently verified, already deposited solver-owned BIT inventory plus sufficient inbound Lightning capacity.
  - [x] Unknown BIT → Lightning solvers receive the configured first-fill cap, while an atomic global in-flight ceiling spans all identities to contain Sybil multiplication. The higher established cap requires objective completed-swap history backed by an exact selected-offer and both-assets terminal proof; there is no administrator promotion flag.
  - [x] The first accepted RFQ permanently binds the normalized admission-policy digest in coordinator metadata; every later admission, reservation, and outcome fails closed if caps, quotas, or promotion/failure thresholds drift.
  - [x] Clients can verify multiple solver signatures locally, retain one offer per solver, commit the complete received set, select one exact executable quote, and require new authorization for fallback.
  - [x] Direction-specific invoice competition is enforced: one user invoice for BIT → Lightning and one distinct solver hold invoice per Lightning → BIT offer.
  - [x] A short-lived direction-specific declaration binds the EVM solver, escrow domain and runtime code, LND node public key, canonical HTTPS origin, Ed25519 endpoint key, exact capacities, monotonic epoch, and expiry. Local verification requires all three possession proofs plus fresh independent capacity observations; the live regtest campaign recovers the exact LND node from four challenges and rejects mutation/cross-role use.
  - [x] The local request/response transport authenticates the bound endpoint on a fresh challenge and fails closed on response mutation, stale authority, origin/identity mismatch, redirect, malformed input, timeout, capacity overstatement, and SSRF targets.
  - [x] The local capacity-reader campaign proves direction binding, dual-provider finalized vault agreement, exact runtime/proxy/implementation hashes, vault solvency, reserves and budgets, response/request replay rejection, separate observer keys, aggregate-only Lightning output, and cross-role denial.
  - [x] Clean published permissionless-admission checkpoint `430a829bed99e88596d27326aecb6e3aca21a35a` passed 246 application/security tests, 91 direct pinned-runtime tests plus bounded-filesystem rollback, 68 contract tests, both builds, and all 30 sealed local campaigns from `2026-08-20T13:46:25.789Z` through `2026-08-20T14:54:24.378Z`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32375971751) passed the same source. The ignored mode-`0600` evidence independently reconstructs to `sha256:acd75e9bd650883329ffac589e802c6c429d6afecab96e63d80bd220ec9e64c3`. It records local-only scope, a simulated EVM reservation, no public testnet, independent providers, production multisigs or infrastructure, independent review, or funding authorization.
  - [ ] Deploy the authenticated endpoint and reader protocols, then prove all repository bindings and risk caps across at least two independently operated testnet solvers, observers, and relays.
- [ ] Run two or more independently operated solvers through adversarial churn, withholding, relay censorship, restarts, and insolvency simulations.
- [ ] Publish fill rate, timeout rate, median completion, capacity freshness, and halt history per solver without claiming a globally best price.
  - [x] The verified adoption summary derives those rates from reconciled integer outcomes, publishes only solver digests and aggregate metrics, and omits participant signers, endpoints, invoices, payment hashes, and preimages. No real campaign summary exists yet.

## Gate 5 — deploy governance and operations

- [ ] Deploy distinct 2-of-3-or-stronger controller, guardian, and fee-recipient contract wallets with hardware-backed owners and tested recovery.
  - [x] Repository authorization now requires five distinct policy-pinned approval identities over one exact EIP-712 release record and policy digest. Controller and guardian ERC-1271 approvals must match reviewed runtime hashes at the record's exact canonical finalized block through its exact provider-set digest; number, hash, timestamp, and provider count must agree. The Lightning operator, security reviewer, and incident commander sign the same record directly.
  - [x] Only a module-proven verified release can derive an operator-funding capability. Arbitrary feature flags, nominal audit/test booleans, copied verification objects, wrong manifests, stale runtime observations, closed gates, or unreconciled balances cannot authorize funding. Mainnet records require prior public-testnet evidence, every review and operations digest, exact caps, reserves, counts, and finding disposition.
  - [x] Clean published signed-release checkpoint `2e2917389b6191a4c62bdbe56f6bab9904141406` passed 252 application/security tests, 91 direct pinned-runtime tests plus bounded-filesystem rollback, 68 contract tests, both builds, and all 31 sealed local campaigns from `2026-08-20T15:15:57.828Z` through `2026-08-20T16:34:26.514Z`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32384877772) passed the same source. The ignored mode-`0600` evidence independently reconstructs to `sha256:22011a8ab9c608dbbac34cc88b09074d9f4a562626666d33e208ae22922a6fa3`. It records a simulated EVM reservation and no public testnet, production infrastructure, independent review, or funding authorization.
  - [ ] Reproduce this path with deployed Safe contracts, hardware-backed owners, independently operated providers, real evidence artifacts, and retained approval receipts. Provider labels or repository signatures alone do not establish operational independence.
- [ ] Deploy the reviewed versioned contracts closed, seal the payment-hash registry, and reproduce every immutable and runtime code hash.
  - [x] A local finalized RPC rehearsal deploys the actual gate, registry, and both escrows closed; reconstructs exact role owners/thresholds, runtime hashes, BIT implementation slot, escrow bindings/limits, and registry set through two distinct local identities; and rejects a captured quorum plus production promotion. Its deterministic digest is `0xcab23fa2503054e2bc95c25238ac153f83f44f4f38b17cb316359972a4deef2a`.
  - [x] The rehearsal is included in the 29-campaign sealed checkpoint bound to clean published commit `44d929e708768d8bbe53087b415eda0f4ac75f43`; the local evidence independently reconstructs to `sha256:9a0bb29bc90d603327b56606603489247f2b3cab5f3be5ecad18d2cd8417d5e9`.
  - [ ] Repeat with production Safe contracts and hardware-backed owners on public testnet, two independently operated providers, the reviewed BIT deployment, and an independently signed release manifest.
- [ ] Monitor the external BIT proxy implementation slot, BIT pause/decimals, EVM finality, price sources, solver capacity, LND health, and asset reconciliation continuously.
  - [x] The repository monitor requires all eight domains on every bounded cycle; missing, stale, duplicate, malformed, future, or unsafe observations take the halt path.
  - [ ] Deploy independently sourced, continuously scheduled, supervised redundant monitor instances and prove monitor-outage escalation.
- [ ] Prove an alert blocks new exposure while every existing claim, refund, and withdrawal remains available.
  - [x] Local combined evidence opens the actual gate, closes quotes, submits a guardian halt, observes the gate closed before alert delivery, and retains the contract-suite guarantees that halts are absent from claim, refund, and withdrawal paths.
  - [ ] Repeat through production-like multisigs, external paging, redundant transaction delivery, deployed escrows, and outstanding testnet liabilities.
- [ ] Run every incident in the incident runbook and attach the evidence to the release record.
  - [x] The release-record schema has mandatory incident-drill, monitoring, backup/restore, provider, solver, loss-allocation, support, and finding-disposition digest slots; an operator-funding record cannot omit the deployed operating evidence, and a mainnet record cannot omit any review.

## Gate 6 — independent review

- [ ] Contract review: both escrows, registry, gate, signatures, accounting, boundaries, and deployment reproducibility.
- [ ] Lightning review: invoice validation, HTLC timing, adapter permissions, idempotency, restarts, and force-close behavior.
- [ ] Coordinator review: persistence, concurrency, quote fairness, replay resistance, and recovery.
- [ ] Identity/privacy review: SIWE, optional wallet linking, retention, logs, and cross-network correlation.
- [ ] Operational review: multisigs, secrets, monitoring, reconciliation, incident command, and loss allocation.
- [ ] Pin every report digest and close or explicitly accept every finding before opening the release gate.
  - [x] The local release verifier requires five distinct review digests plus a separate finding-disposition digest for capped mainnet and binds them into all five approvals. No reports or dispositions have yet been supplied.

## Gate 7 — capped mainnet beta

- [ ] Publish exact contract addresses, source commit, review digests, fee schedule, price band, per-swap and per-epoch caps, daily Lightning cap, in-flight cap, reserve floor, and support path.
- [ ] Start with operator-owned solver inventory only, at substantially smaller limits than the tested maximum.
- [ ] Require explicit user confirmation for the exact quote and, when paying Lightning, the exact invoice.
- [ ] Reconcile continuously and close automatically on stale data, disagreement, unexpected code, role loss, or any inventory mismatch.
- [ ] Increase caps only through a new signed release record supported by observed reliability and incident-free operation.

## Separate future gate — public liquidity

Third-party deposits, shares, withdrawal queues, yield, and rewards are a new custody and economic protocol. They require new contracts and independent insolvency, accounting, adverse-selection, governance, and legal review. They are not required for a permissionless solver market.
