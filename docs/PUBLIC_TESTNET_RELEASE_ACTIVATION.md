# Public-testnet release activation

Status: the same-process activation boundary is implemented and adversarially tested locally. It supplies no deployment, signer, provider, inventory, operator, or authority. Funded operation remains closed until every external launch gate is satisfied.

## Why activation is separate

A signed release record is necessary but not sufficient. A standalone approval receipt is serializable, an old runtime snapshot can become unsafe, and a matching JSON object is not proof that any live system was observed. TreeSwap therefore does not let `activateReleaseCapabilities` plus caller-supplied booleans authorize funding.

The production coordinator must call `activatePublicTestnetRelease` in `lib/capabilities.mjs`. That single in-memory call requires:

1. a candidate freshly rebuilt in the same process from provenance-bound deployment promotion, independent-review, operational-readiness, and bootstrap or campaign verification results;
2. the exact five-role approval bundle;
3. a provider set created in that process from candidate-bound identities and secret environment variables;
4. a fresh runtime reconciliation signed by both the policy-pinned Lightning operator and security reviewer; and
5. live agreement from every configured provider on the same current canonical block and exact release-bound contract state.

The function re-verifies all five release approvals through the live provider set. It does not trust a prior receipt. The candidate, provider set, approval verification, release capability, runtime snapshot, and capability/snapshot pairing each use module-private process provenance. Copying, serializing, reconstructing, or mixing any of those objects removes authority.

## Gate binding

`publicTestnetReleaseOpenRiskDigest(candidate)` derives the only accepted gate risk digest from the release ID, record and policy digests, deployment manifest, postflight, promotion, and release expiry. The controller may schedule that digest only through the deployed gate's immutable delay. Runtime activation requires the gate to be open, not emergency halted, unexpired, no longer-lived than the signed release, and exposing that exact active digest.

This separates two time scales safely: the release digest can wait through the gate's minimum 24-hour reopen delay, while balances and coordinator state are independently reconciled seconds before activation.

## Fresh reconciliation

The runtime reconciliation is an exact `treeswap.runtime-reconciliation.v1` EIP-712 record. It binds:

- release ID, record digest, and policy digest;
- observation and expiry times;
- available and in-flight Lightning sats;
- epoch and daily Lightning volume;
- exactly zero unexplained liabilities; and
- Lightning inventory, coordinator-state, and in-flight-state digests.

Its validity may not exceed the release policy's runtime-observation limit and may not outlive the release. Available Lightning must meet the signed reserve, while in-flight, epoch, and daily amounts must stay within signed caps. The Lightning operator and security reviewer must both sign the same record with their release-policy identities. These may be independently operated, narrowly scoped online attestation services; they must not share keys, hosts, persistence, or failure domains.

Funding authorization expires at the earliest of the reconciliation expiry, runtime freshness deadline, and signed release expiry. A new reconciliation and activation are required after that point.

## Live EVM quorum

Every candidate-bound provider must independently return the same state at the newest block number available from all provider heads. This tolerates a provider being one block ahead without weakening consensus: every provider must return the identical block hash, timestamp, and state for that exact common height. Reads use an EIP-1898 canonical block-hash anchor. Activation checks:

- chain and approval-block ordering;
- controller, guardian, and fee-collector wallet runtime hashes, exact owners, and thresholds;
- gate, registry, vault, user-escrow, BIT proxy, and BIT implementation runtime hashes;
- the exact EIP-1967 BIT implementation address;
- an unpaused BIT token;
- a sealed registry containing exactly the two reviewed escrows;
- the release-bound active gate digest and expiry;
- vault available plus locked equals accounted equals raw BIT balance;
- user-escrow locked equals its raw BIT balance;
- the signed minimum BIT reserve; and
- the signed maximum BIT-equivalent in-flight amount at TreeSwap's pinned 100 sats per BIT reference.

Any provider disagreement, stale or future head, implementation change, code change, gate closure, wrong risk digest, registry change, BIT pause, accounting mismatch, reserve shortfall, or cap excess aborts activation.

## Operator activation preflight

`npm run verify:testnet-release-activation -- --inputs /absolute/activation-inputs.json --out activation-preflight.json` exercises the production activation boundary without starting a solver or retaining authority. The input manifest must use `treeswap.public-testnet-release-activation-inputs.v1`, canonical absolute paths, one distinct file per input, and one of the two exact evidence shapes shown in `examples/public-testnet-bootstrap-release-activation-inputs.json` and `examples/public-testnet-release-activation-inputs.json`. The first supports the tiny operator-owned bootstrap; the second requires the completed campaign-qualified release. The two shapes cannot be mixed. Provider URLs stay in the environment variables named by the provider configuration; they never enter the manifest or output.

The command does not load a serialized candidate. In one process it reopens all raw deployment, campaign, review, service-isolation, operational-readiness, safety-monitor-policy, adoption-policy, and qualification artifacts; reconstructs every module-private verification object and the v6 candidate; requires the monitor's upstream record binding and derives its final-release policy; builds the candidate-bound provider set; rechecks the five release approvals; verifies the two reconciliation signatures; and obtains fresh live EVM quorum state. A copied candidate, missing or extra evidence field, reused file path, provider mismatch, stale reconciliation, or unsafe live state fails before a receipt is written.

The exclusive mode-`0600` output is a secret-free `treeswap.public-testnet-release-activation-preflight.v1` summary. It contains only release, input, approval, reconciliation, provider-consensus, and runtime-block digests plus explicit false authorization fields. The in-memory capability is never serialized, no solver capability or daemon context is accepted, and process exit destroys the only activation provenance. Passing this preflight proves that an exact external evidence package can cross the activation boundary; it does not prove operator independence and does not satisfy the persistent-coordinator launch gate.

## Coordinator integration

There is intentionally no command that writes an “active release” JSON file. A file cannot retain process provenance. The preflight command above writes only a non-authorizing audit summary. The long-running coordinator must:

1. load and verify the raw upstream evidence;
2. rebuild the exact candidate;
3. load the five signatures and configure independent providers;
4. obtain the two fresh reconciliation signatures;
5. call `activatePublicTestnetRelease` without restarting; and
6. combine the returned capability/runtime snapshot, the original `verifySolverCapability` result, and the exact release-policy-bound daemon evidence policy with `createActiveSolverDaemonContext`; then call only `executeActiveSolverDaemonStep` with the original live coordinator service lease for live daemon work.

The packaged coordinator now implements steps 1–5 as the opt-in, verification-only persistent mode. It reloads the raw manifest at a bounded interval, retains the original activation only in its closure, emits no capability, and exposes a same-process callback solely for the future trusted daemon integration. The step-6 wrapper is implemented and requires the original activation, solver proof, store, and service lease, but the packaged service deliberately accepts no solver inputs and never invokes it. Every value-moving operation therefore remains unavailable. The default container mode is still `closed`.

Refresh is a revocation boundary: the prior activation is deactivated before new evidence is read. Provider or signature failure, malformed or changed files, expiry, clock rollback, shutdown, and replacement all leave the coordinator inactive. An activation-derived solver context then fails its new-exposure funding check immediately instead of waiting for the prior runtime observation to age out; recovery-only processing keeps its narrower existing path.

Context creation reruns the final funding decision and accepts no `authenticated`, `role`, or `capabilityVerified` boolean. It reopens the module-private solver proof, requires its independently observed capacity to remain within the release runtime freshness window, fails at the exact capability-expiry boundary, and binds the daemon policy's release digest, chain, solver, direction, escrow address/runtime hash, Lightning operator, security reviewer, and evidence freshness to the same deployment and policy used by live release activation. At execution it accepts only an original `CoordinatorStore` instance and requires the durable settlement's selected firm offer to name that solver, direction, capability epoch, and Lightning amount and to contain the completed executable-quote plus second user-authorization records. New exposure additionally requires the offer, user authorization, and RFQ to remain active. A copied context, caller-selected policy digest, lookalike store, orphan settlement, solver/epoch substitution, incomplete user authorization, proof for another chain or escrow, substituted evidence signer, stale capacity, or otherwise valid capability from a different release cannot authorize.

`executeActiveSolverDaemonStep` uses a fresh internal wall-clock read at every boundary and accepts only the original same-process service lease; callers may supply neither time, policy digest, nor leadership hook. It rechecks live funding authorization before the actual Lightning outbox claim and send, checks current lease ownership on entry, and checks it again after external evidence reads immediately before every pre-request or evidence-derived durable state change. Private packets, dual-signed action evidence, and the Lightning adapter authorization envelope must still be unexpired at their actual use boundary, and backward time closes the step. Lightning and EVM dispatch each check once before their durable outbox claim and again immediately before the network request. Leadership or validity loss before the claim leaves the action untouched; loss after the claim starts no network request and leaves a conservative interrupted action for `UNKNOWN` recovery. After a network request has actually started, the original call may persist only the response or ambiguity needed to prevent unsafe replay. Expired reconciliation, release, runtime state, solver capacity, evidence, packet, envelope, or leadership therefore closes new work safely. The same original in-process context may still perform read-only reconciliation, EVM claim recovery, and terminal accounting when backed by fresh dual-signed action evidence and live leadership; it cannot dispatch another Lightning action. The lower-level daemon executor exists for bounded protocol testing and may not be wired as a funded production entry point.

## Closed-gate and restart recovery

`activatePublicTestnetRecovery` and `activatePublicTestnetRecoveryFromManifest` rebuild a separate, short-lived recovery-only authority after restart or release closure. They re-open the raw candidate evidence in one process, re-verify the historical five-role release approval at its signed boundary, rebuild the candidate-bound provider set, and require every provider to agree now on the same fresh canonical block, exact reviewed code and ownership, sealed registry, BIT implementation and identity, and reconciled escrow accounting. Recovery deliberately tolerates an expired release, closed or emergency-halted gate, paused BIT, reserve shortfall, and cap excess because those are conditions under which already-started liabilities may need safe resolution. An open gate must still expose the reviewed risk digest and an active window. The resulting activation and context explicitly authorize no funding, new exposure, or Lightning dispatch.

Coordinator schema v7 makes that narrow authority durable without making it transferable. Before any reservation or action, `bindActiveSolverSettlementExecutionPolicy` atomically binds the accepted settlement to one unique selected firm offer, the offer's exact historical capability digest, the reviewed release record, the daemon-evidence policy, and the binding time. The method derives those values from the original active context, requires the original live service lease and unmodified store methods, and accepts only an active fully user-authorized firm offer and matching RFQ. A recovery context may present a newer short-lived capability epoch for the same solver, but `executeRecoverySolverDaemonStep` still requires the settlement's historical offer capability and original release/policy binding. It always closes a Lightning-dispatch step, while reconciliation, EVM claim recovery, and terminal accounting retain their existing live-lease, private-packet, provider-quorum, and fresh dual-signed evidence requirements. Schema v6 and older databases with active firm offers or any nonterminal settlement refuse migration because the missing authority cannot be inferred safely.

A paused BIT observation permits read-only recovery activation but sets EVM claim work to closed. The recovery wrapper will not recover a preimage into a claim action, bind a claim transaction, or broadcast a claim until a later fresh recovery activation observes BIT unpaused. This avoids deliberately preparing or sending a transaction expected to revert while preserving incident visibility and Lightning-side reconciliation.

Restart therefore requires fresh same-process activation; no serialized object or status restores authority. Reconciliation expiry, runtime staleness, release expiry, solver-capability expiry, or any monitoring halt prevents new exposure. Recovery after restart additionally requires the recovery manifest, current provider quorum, a fresh solver capability, the exact schema-v7 settlement binding, and current per-action evidence. Persist only the durable binding and secret-free audit digests—not a reusable capability.

The packaged coordinator's opt-in `recovery-verification-only` mode now performs the raw-evidence and live-provider portion continuously. It requires the exact recovery manifest shape in `examples/public-testnet-recovery-activation-inputs.json`, revokes the previous same-process recovery activation before every refresh, and becomes unhealthy on failure, expiry, external deactivation, or clock rollback. Its aggregate status exposes incident flags but no manifest path, endpoint, signature, capability, solver context, invoice, payment hash, or preimage. All value-moving and gate authorities remain false. The packaged service still has no solver-input or action-execution loop, so deployed solver identity verification, bounded action wiring, retained-host drills, and independent evidence remain external gates.

## Remaining external boundary

Local mocks prove the verifier logic, not real independence or truthful observations. Adoption still requires deployed Sepolia contracts and three distinct production Safes, hardware-backed owners, independently operated authenticated providers and runtime attesters, persistent coordinator infrastructure, real monitoring and alert delivery, drills, multiple testnet solvers, retained evidence, and independent review. No operator inventory should be deposited until those facts are complete and witnessed.
