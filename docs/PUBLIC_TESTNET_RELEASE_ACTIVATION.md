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

## Coordinator integration

There is intentionally no command that writes an “active release” JSON file. A file cannot retain process provenance. The long-running coordinator must:

1. load and verify the raw upstream evidence;
2. rebuild the exact candidate;
3. load the five signatures and configure independent providers;
4. obtain the two fresh reconciliation signatures;
5. call `activatePublicTestnetRelease` without restarting; and
6. pass the returned capability and runtime snapshot objects plus the exact live `verifySolverCapability` result directly to `authorizeSolverFunding` for each solver-funding decision.

The final decision accepts no `authenticated`, `role`, or `capabilityVerified` boolean. It reopens the module-private solver proof, requires its independently observed capacity to remain within the release runtime freshness window, fails at the exact capability-expiry boundary, and binds its chain, direction-specific escrow address, and escrow runtime code hash to the same deployment manifest used by live release activation. A copied proof, a proof for another chain or escrow, stale capacity, or an otherwise valid capability from a different release cannot authorize.

Restart, reconciliation expiry, runtime staleness, release expiry, or any monitoring halt requires a fresh activation. The coordinator must never persist the returned objects as authority. Persist only secret-free audit digests and the non-authorizing approval receipt.

## Remaining external boundary

Local mocks prove the verifier logic, not real independence or truthful observations. Adoption still requires deployed Sepolia contracts and three distinct production Safes, hardware-backed owners, independently operated authenticated providers and runtime attesters, persistent coordinator infrastructure, real monitoring and alert delivery, drills, multiple testnet solvers, retained evidence, and independent review. No operator inventory should be deposited until those facts are complete and witnessed.
