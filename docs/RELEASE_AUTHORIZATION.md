# Release authorization boundary

Status: exact public-testnet v2 release records, distinct tiny-bootstrap and campaign-qualified modes, signed bootstrap-operator evidence, five-role signed independent-review evidence, evidence-derived candidate preparation, guarded five-role payload preparation and receipt verification, finalized ERC-1271 quorum verification, postflight/promotion binding, and provenance-bound capability activation are implemented locally. Release v2 rejects mainnet; a later schema may add it only after an equivalent mainnet preflight/postflight and promotion ceremony exists. TreeSwap has no signed public-testnet release record, and `V1_CAPABILITIES.webSolverFunding` remains disabled.

## Purpose

A build flag, administrator assertion, green CI run, or document checkbox must never enable funding. `lib/release-authorization.mjs` makes operator funding depend on one exact, short-lived release record and all required approvals.

The record commits:

- release ID, protocol version, environment, chain, gate, source commit, prior release, validity window, and the exact finalized approval block number/hash/timestamp and provider-set digest;
- deployment manifest, signed deployment postflight, signed deployment promotion, admission, risk, fee, qualification, provider, solver, monitoring, backup, incident, loss-allocation, support, and finding-disposition evidence digests;
- contract, Lightning, coordinator, identity/privacy, and operations review digests;
- independent provider, Lightning-observer, monitor, relay, solver, alert-channel, and multisig counts;
- exact per-swap, epoch, daily Lightning, in-flight, routing, price-band, and reserve limits; and
- the complete feature set, while public deposits, shares, yield, rewards, and partial fills remain forbidden.

`treeswap.release-record.v2` and `treeswap.release-policy.v2` both require the exact deployment-postflight and deployment-promotion commitments. `operator-testnet-bootstrap` is a separate pre-campaign mode with hard ceilings of 500 sats per swap, 1,000 sats in flight, 5,000 sats per epoch, 10,000 sats per day, 50 sats routing fee, and 250 basis points price band. `operator-testnet` is campaign-qualified, requires the signed public-testnet campaign commitment, and remains hard-capped at 5,000 sats per swap, 10,000 sats in flight, 50,000 sats per epoch, 100,000 sats per day, 100 sats routing fee, and 500 basis points price band. Signed policy may only tighten these limits. Both funded modes require every operations digest, loss allocation, support policy, five independent review digests, and at least two monitors in addition to the other operator minima. Legacy v1 records, all mainnet environments and funding modes, unknown or extra fields, non-canonical integers, zero required digests, digest substitution, excessive limits, insufficient reserves or operator counts, validity longer than policy, and an environment/funding-mode mismatch fail closed.

## Evidence-derived release candidates

Operators must not hand-merge promotion, bootstrap, campaign, or review JSON. [`PUBLIC_TESTNET_RELEASE_CANDIDATES.md`](./PUBLIC_TESTNET_RELEASE_CANDIDATES.md) defines two non-authorizing preparation commands. Both re-verify the complete postflight-bound deployment promotion and the [five-reviewer evidence package](./INDEPENDENT_REVIEW_EVIDENCE.md), then derive chain, gate, source, manifest, provider commitments, Safe counts, all five review digests, release evidence, policy digests, and EIP-712 approval payload. The bootstrap command also re-verifies one attestation from every operator in the short-lived [bootstrap roster](./PUBLIC_TESTNET_BOOTSTRAP_EVIDENCE.md), derives every count, and requires its EVM provider identities and signers to match the promotion. The qualified command re-verifies the entire signed seven-day campaign and combines duplicated provider and findings domains rather than letting one source overwrite the other. Candidate schema v1 and release-record template v1 are rejected because they accepted unsigned review hashes. Output is mode `0600`, non-overwriting, and has no signing, broadcasting, gate-opening, or funding authority.

## Five independent approvals

Controller, guardian, Lightning operator, security reviewer, and incident commander approve the same canonical record digest and canonical release-policy digest under an EIP-712 domain bound to the exact chain and gate. The signed policy digest prevents replaying valid record signatures under looser provider-count, cap, reserve, release-lifetime, or runtime-freshness policy.

- Controller and guardian approvals use ERC-1271 contract signatures. The verifier reads both signatures and the reviewed wallet runtime hashes at the exact signed canonical finalized block through the exact signed provider-identity set. The observed block number, hash, and timestamp must all match, and the provider count must equal the record.
- Lightning operator, security reviewer, and incident commander use their exact policy-pinned EIP-712 identities.
- Every role identity must be distinct. A missing, duplicate, wrong-role, replayed, malformed, oversized, expired, wrong-chain, or wrong-contract approval fails closed.

Successful verification is module-private provenance, not a copyable JSON claim. Copying or reconstructing a verification result or capability object cannot activate it in another process.

[`PUBLIC_TESTNET_RELEASE_APPROVALS.md`](./PUBLIC_TESTNET_RELEASE_APPROVALS.md) defines the operator ceremony. One command reconstructs the exact payload for one policy role without accessing a key. A second command requires a candidate-bound five-role bundle and live configured provider quorum, then writes a mode-`0600`, non-overwriting receipt with no raw signatures or provider URLs. That command deliberately discards module-private verification provenance and never calls capability activation. Its receipt proves the supplied bundle passed at that moment; it does not prove upstream candidate provenance, organizational independence, signer custody, or funding authority.

## Runtime activation

`activateReleaseCapabilities` can derive an operator-funding profile only while the signed record is active and its funding mode is not closed. `authorizeSolverFunding` then requires:

- the provenance-bound release profile;
- an authenticated solver session whose cryptographic solver capability passed;
- one exact runtime snapshot bound to the signed release-record digest, signed release-policy digest, deployment-manifest digest, verified postflight digest, and verified promotion digest;
- a fresh observation inside the signed policy's maximum age;
- an open risk gate with a nonzero risk digest; and
- reconciled balances with a nonzero reconciliation digest.

Nominal booleans such as `audited: true`, an arbitrary `webSolverFunding: true`, a copied capability object, stale state, or a different manifest cannot authorize funding.

## Local qualification evidence

Clean published source commit [`2e2917389b6191a4c62bdbe56f6bab9904141406`](https://github.com/bobofbuilding/treeswap/commit/2e2917389b6191a4c62bdbe56f6bab9904141406) passed 252 application/security tests, 91 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both web build paths, all 31 sealed local qualification campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32384877772). The sealed run lasted from `2026-08-20T15:15:57.828Z` through `2026-08-20T16:34:26.514Z`. Its ignored mode-`0600` evidence independently reconstructs to `sha256:22011a8ab9c608dbbac34cc88b09074d9f4a562626666d33e208ae22922a6fa3`.

This checkpoint proves the local release-authorization, permissionless-admission, EVM-fault, Lightning-regtest, coordinator-recovery, and safety-monitor campaigns against the published source. It explicitly records `publicTestnetIncluded: false`, `independentReviewIncluded: false`, `productionInfrastructureIncluded: false`, and `simulatedEvmReservation: true`. It contains no production multisigs, hardware signers, independently operated providers, public-testnet solvers, external reviews, infrastructure evidence, inventory, or funding authorization.

## Remaining external boundary

The repository can verify signatures and configured provider agreement; it cannot prove that provider identities are independently operated, Safe owners use hardware keys, evidence artifacts are truthful, operators are organizationally independent, or reviewers are qualified. Those facts require retained external evidence and human review.

No production record, signer set, provider set, code hash, deployment manifest, review digest, or incident evidence is embedded in this repository. The shipped profile remains closed. A bootstrap public-testnet record must be derived only after the independent deployment and operating evidence exists. A qualified public-testnet record must additionally bind the completed seven-day campaign. A future mainnet schema must bind the qualified public-testnet campaign, an equivalent mainnet deployment ceremony, and every independent review; v2 cannot authorize it.

The deployment-manifest input must first pass the [signed deployment-manifest promotion](./DEPLOYMENT_PROMOTION.md) boundary. Promotion v2 re-verifies the complete signed postflight in-process, retains its exact providers and reviewers, and rechecks the exact policy, source, canonical finalized provider observations, observed topology and code, and review bundle. Release-candidate preparation consumes that live provenance and derives the exact postflight/promotion commitments in both record and policy; operators do not copy them by hand. The promotion output cannot activate a release capability by itself.

The local promotion implementation at clean published commit [`bcbf2b03e7064be136cb54a8c567f905abec8516`](https://github.com/bobofbuilding/treeswap/commit/bcbf2b03e7064be136cb54a8c567f905abec8516) passed 33 sealed campaigns and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32401732721). Its independently reconstructed evidence digest is `sha256:cbb4f5b62033429e8db734a8fd98f29db6b4c444ccdf5ec18949f91059f90152`; the record is local-only and supplies none of the external provider, reviewer, deployment, signer-custody, or funding facts required by a release.

The candidate campaign format and verifier are specified in [Public-testnet campaign evidence](./PUBLIC_TESTNET_EVIDENCE.md). Its provenance-bound mapper supplies exact deployment, policy, provider, solver, monitoring, backup, incident, qualification, finding-disposition, campaign, and operator-count inputs. The release-candidate assembler combines that output with the separate provenance-bound promotion mapping, commits to both record and policy digests, and derives the complete signed inputs without manual digest copying. Neither mapper nor assembler signs a release or activates capabilities.
