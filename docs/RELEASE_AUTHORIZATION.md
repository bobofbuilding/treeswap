# Release authorization boundary

Status: exact release records, five-role approvals, finalized ERC-1271 quorum verification, and provenance-bound capability activation are implemented locally. TreeSwap has no signed public-testnet or mainnet release record, and `V1_CAPABILITIES.webSolverFunding` remains disabled.

## Purpose

A build flag, administrator assertion, green CI run, or document checkbox must never enable funding. `lib/release-authorization.mjs` makes operator funding depend on one exact, short-lived release record and all required approvals.

The record commits:

- release ID, protocol version, environment, chain, gate, source commit, prior release, validity window, and the exact finalized approval block number/hash/timestamp and provider-set digest;
- deployment, admission, risk, fee, qualification, provider, solver, monitoring, backup, incident, loss-allocation, support, and finding-disposition evidence digests;
- contract, Lightning, coordinator, identity/privacy, and operations review digests;
- independent provider, observer, relay, solver, alert-channel, and multisig counts;
- exact per-swap, epoch, daily Lightning, in-flight, routing, price-band, and reserve limits; and
- the complete feature set, while public deposits, shares, yield, rewards, and partial fills remain forbidden.

Unknown or extra fields, non-canonical integers, zero required digests, excessive limits, insufficient reserves or operator counts, validity longer than policy, and an environment/funding-mode mismatch fail closed. A capped-mainnet record additionally requires a prior release, public-testnet evidence, every external evidence digest, every review digest, and the disposition of all findings.

## Five independent approvals

Controller, guardian, Lightning operator, security reviewer, and incident commander approve the same canonical record digest and canonical release-policy digest under an EIP-712 domain bound to the exact chain and gate. The signed policy digest prevents replaying valid record signatures under looser provider-count, cap, reserve, release-lifetime, or runtime-freshness policy.

- Controller and guardian approvals use ERC-1271 contract signatures. The verifier reads both signatures and the reviewed wallet runtime hashes at the exact signed canonical finalized block through the exact signed provider-identity set. The observed block number, hash, and timestamp must all match, and the provider count must equal the record.
- Lightning operator, security reviewer, and incident commander use their exact policy-pinned EIP-712 identities.
- Every role identity must be distinct. A missing, duplicate, wrong-role, replayed, malformed, oversized, expired, wrong-chain, or wrong-contract approval fails closed.

Successful verification is module-private provenance, not a copyable JSON claim. Copying or reconstructing a verification result or capability object cannot activate it in another process.

## Runtime activation

`activateReleaseCapabilities` can derive an operator-funding profile only while the signed record is active and its funding mode is not closed. `authorizeSolverFunding` then requires:

- the provenance-bound release profile;
- an authenticated solver session whose cryptographic solver capability passed;
- one exact runtime snapshot bound to the signed release-record digest, signed release-policy digest, and deployment-manifest digest;
- a fresh observation inside the signed policy's maximum age;
- an open risk gate with a nonzero risk digest; and
- reconciled balances with a nonzero reconciliation digest.

Nominal booleans such as `audited: true`, an arbitrary `webSolverFunding: true`, a copied capability object, stale state, or a different manifest cannot authorize funding.

## Local qualification evidence

Clean published source commit [`2e2917389b6191a4c62bdbe56f6bab9904141406`](https://github.com/bobofbuilding/treeswap/commit/2e2917389b6191a4c62bdbe56f6bab9904141406) passed 252 application/security tests, 91 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both web build paths, all 31 sealed local qualification campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32384877772). The sealed run lasted from `2026-08-20T15:15:57.828Z` through `2026-08-20T16:34:26.514Z`. Its ignored mode-`0600` evidence independently reconstructs to `sha256:22011a8ab9c608dbbac34cc88b09074d9f4a562626666d33e208ae22922a6fa3`.

This checkpoint proves the local release-authorization, permissionless-admission, EVM-fault, Lightning-regtest, coordinator-recovery, and safety-monitor campaigns against the published source. It explicitly records `publicTestnetIncluded: false`, `independentReviewIncluded: false`, `productionInfrastructureIncluded: false`, and `simulatedEvmReservation: true`. It contains no production multisigs, hardware signers, independently operated providers, public-testnet solvers, external reviews, infrastructure evidence, inventory, or funding authorization.

## Remaining external boundary

The repository can verify signatures and configured provider agreement; it cannot prove that provider identities are independently operated, Safe owners use hardware keys, evidence artifacts are truthful, operators are organizationally independent, or reviewers are qualified. Those facts require retained external evidence and human review.

No production record, signer set, provider set, code hash, deployment manifest, review digest, or incident evidence is embedded in this repository. The shipped profile remains closed. A public-testnet record must be assembled only after the independent deployments exist; a mainnet record must additionally bind the completed public-testnet campaign and every independent review.

The deployment-manifest input must first pass the [signed deployment-manifest promotion](./DEPLOYMENT_PROMOTION.md) boundary. That verifier rechecks the exact policy, source, canonical finalized provider observations, observed topology and code, and review bundle before distinct provider, contract-reviewer, and operations-reviewer signatures can derive candidate deployment evidence. Its output cannot activate a release capability.

The local promotion implementation at clean published commit [`bcbf2b03e7064be136cb54a8c567f905abec8516`](https://github.com/bobofbuilding/treeswap/commit/bcbf2b03e7064be136cb54a8c567f905abec8516) passed 33 sealed campaigns and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32401732721). Its independently reconstructed evidence digest is `sha256:cbb4f5b62033429e8db734a8fd98f29db6b4c444ccdf5ec18949f91059f90152`; the record is local-only and supplies none of the external provider, reviewer, deployment, signer-custody, or funding facts required by a release.

The candidate campaign format and verifier are specified in [Public-testnet campaign evidence](./PUBLIC_TESTNET_EVIDENCE.md). Its provenance-bound mapper supplies exact deployment, policy, provider, solver, monitoring, backup, incident, qualification, finding-disposition, campaign, and operator-count inputs for release assembly. It does not sign a release or activate capabilities.
