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

The command does not load a serialized candidate. In one process it reopens all raw deployment, campaign, review, service-isolation, operational-readiness, adoption-policy, and qualification artifacts; reconstructs every module-private verification object and the candidate; builds the candidate-bound provider set; rechecks the five release approvals; verifies the two reconciliation signatures; and obtains fresh live EVM quorum state. A copied candidate, missing or extra evidence field, reused file path, provider mismatch, stale reconciliation, or unsafe live state fails before a receipt is written.

The exclusive mode-`0600` output is a secret-free `treeswap.public-testnet-release-activation-preflight.v1` summary. It contains only release, input, approval, reconciliation, provider-consensus, and runtime-block digests plus explicit false authorization fields. The in-memory capability is never serialized, no solver capability or daemon context is accepted, and process exit destroys the only activation provenance. Passing this preflight proves that an exact external evidence package can cross the activation boundary; it does not prove operator independence and does not satisfy the persistent-coordinator launch gate.

## Coordinator integration

There is intentionally no command that writes an “active release” JSON file. A file cannot retain process provenance. The preflight command above writes only a non-authorizing audit summary. The long-running coordinator must:

1. load and verify the raw upstream evidence;
2. rebuild the exact candidate;
3. load the five signatures and configure independent providers;
4. obtain the two fresh reconciliation signatures;
5. call `activatePublicTestnetRelease` without restarting; and
6. combine the returned capability/runtime snapshot, the original `verifySolverCapability` result, and the exact release-policy-bound daemon evidence policy with `createActiveSolverDaemonContext`; then call only `executeActiveSolverDaemonStep` for live daemon work.

The packaged coordinator now implements steps 1–5 as the opt-in, verification-only persistent mode. It reloads the raw manifest at a bounded interval, retains the original activation only in its closure, emits no capability, and exposes a same-process callback solely for the future trusted daemon integration. It deliberately accepts no solver inputs, so step 6 and every value-moving operation remain unavailable. The default container mode is still `closed`.

Refresh is a revocation boundary: the prior activation is deactivated before new evidence is read. Provider or signature failure, malformed or changed files, expiry, clock rollback, shutdown, and replacement all leave the coordinator inactive. An activation-derived solver context then fails its new-exposure funding check immediately instead of waiting for the prior runtime observation to age out; recovery-only processing keeps its narrower existing path.

Context creation reruns the final funding decision and accepts no `authenticated`, `role`, or `capabilityVerified` boolean. It reopens the module-private solver proof, requires its independently observed capacity to remain within the release runtime freshness window, fails at the exact capability-expiry boundary, and binds the daemon policy's release digest, chain, solver, direction, escrow address/runtime hash, Lightning operator, security reviewer, and evidence freshness to the same deployment and policy used by live release activation. At execution it accepts only an original `CoordinatorStore` instance and requires the durable settlement's selected firm offer to name that solver, direction, capability epoch, and Lightning amount and to contain the completed executable-quote plus second user-authorization records. New exposure additionally requires the offer, user authorization, and RFQ to remain active. A copied context, caller-selected policy digest, lookalike store, orphan settlement, solver/epoch substitution, incomplete user authorization, proof for another chain or escrow, substituted evidence signer, stale capacity, or otherwise valid capability from a different release cannot authorize.

`executeActiveSolverDaemonStep` uses its own wall clock and rechecks live funding authorization immediately before every Lightning dispatch; callers may supply neither time nor policy digest. Expired reconciliation, release, runtime state, or solver capacity therefore closes new exposure without changing durable state. The same original in-process context may still perform read-only reconciliation, EVM claim recovery, and terminal accounting when backed by fresh dual-signed action evidence; it cannot dispatch another Lightning action. The lower-level daemon executor exists for bounded protocol testing and may not be wired as a funded production entry point.

Restart requires fresh activation because none of the module-private objects can be persisted as authority. Reconciliation expiry, runtime staleness, release expiry, solver-capability expiry, or any monitoring halt prevents new exposure; already-started recovery remains narrowly bound to the original in-process release/solver context and fresh dual-signed action evidence. Persist only secret-free audit digests and the non-authorizing approval receipt.

## Remaining external boundary

Local mocks prove the verifier logic, not real independence or truthful observations. Adoption still requires deployed Sepolia contracts and three distinct production Safes, hardware-backed owners, independently operated authenticated providers and runtime attesters, persistent coordinator infrastructure, real monitoring and alert delivery, drills, multiple testnet solvers, retained evidence, and independent review. No operator inventory should be deposited until those facts are complete and witnessed.
