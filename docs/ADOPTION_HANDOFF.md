# TreeSwap adoption handoff

Status: TreeSwap's repository and local evidence controls are mature, but funded operation is closed. The first adoptable target is a tiny, operator-owned Sepolia bootstrap. It is not a public-liquidity product, not permissionless execution, and not mainnet. Release schema v2 rejects mainnet.

This is the shortest safe route from the public prototype to a witnessed testnet service. It organizes the existing mandatory workflows; it does not replace or weaken any verifier.

## Recommended first release

Use `operator-testnet-bootstrap` with operator-owned inventory only:

| Control | Hard ceiling |
| --- | ---: |
| Per swap | 500 sats |
| In flight | 1,000 sats |
| Per epoch | 5,000 sats |
| Daily Lightning | 10,000 sats |
| Routing fee | 50 sats |
| Reference-price band | 250 bps |

The signed policy may tighten these values but cannot increase them. Public solver execution, public deposits, LP shares, rewards, promised yield, partial fills, and mainnet remain disabled.

## Staff before deploying

Assign the real operators below and preserve every separation rule enforced by the linked verifier. Do not infer a minimum headcount by merging roles: some roles may align across packages, while other overlaps are explicitly forbidden.

| Workstream | Required control |
| --- | --- |
| Contract custody | Three distinct 2-of-3-or-stronger controller, guardian, and fee-recipient Safes; disjoint hardware-backed owner sets; tested recovery |
| BIT observation | Two independently operated authenticated Ethereum providers with distinct signers and retained identity, organization, and service evidence |
| BIT review | Separate contract-security and provider-independence reviewers who do not overlap the BIT providers |
| Bootstrap network | At least two operators in each role: EVM provider, Lightning observer, monitor, relay, and solver; one operator ID or signer cannot count in multiple bootstrap roles |
| External review | Five distinct reviewers: contracts, Lightning, coordinator, identity/privacy, and operations |
| Service isolation | Distinct infrastructure operator, Lightning operator, and security reviewer across at least two organization commitments |
| Release and incident authority | Controller Safe, guardian Safe, Lightning operator, security reviewer, and incident commander approve one exact release candidate |
| User operations | Named support owner, public support/security/status paths, two retained alert channels, and an incident commander |

Cryptographic identity separation does not prove competence, hardware custody, service independence, or organizational independence. Reviewers must inspect the retained real-world evidence.

## Ordered adoption path

### 1. Freeze the release boundary

- Select one clean commit already published on `origin/main`.
- Run the complete sealed qualification on that exact commit and have a non-overlapping reviewer reconstruct and sign its exact bytes through [qualification review evidence](./QUALIFICATION_REVIEW_EVIDENCE.md).
- Keep `V1_CAPABILITIES.webSolverFunding` disabled and the onchain gate closed.
- Agree the public [adoption policy](./ADOPTION_POLICY.md), including directional fees, caps, reserves, privacy retention, loss allocation, support ownership, and immutable-upgrade response.
- Make no inventory deposit and collect no public funds.

Any source or policy change starts a new evidence chain.

### 2. Review the live BIT dependency

1. Capture matching current observations through two genuinely independent authenticated providers.
2. Have both provider operators sign the exact short-lived comparison.
3. Have the two non-overlapping BIT reviewers inspect and sign the exact source/compiler, role/storage, upgrade, provider-independence, and findings artifacts.
4. Derive the reviewed BIT manifest in the same process from the live verified provenance.

Use [BIT mainnet evidence](./BIT_MAINNET_EVIDENCE.md), [provider evidence](./BIT_PROVIDER_EVIDENCE.md), [BIT independent review](./BIT_INDEPENDENT_REVIEW.md), and [reviewed BIT manifest](./BIT_REVIEWED_MANIFEST.md). A serialized verification summary is not reusable authority.

### 3. Deploy Sepolia closed

1. Independently reconstruct the deterministic unsigned plan.
2. Collect the short-lived two-provider preflight and operations-reviewer approval.
3. Hardware-backed Safe operators submit only the exact reviewed transactions.
4. Keep the gate closed and all TreeSwap balances and liabilities at zero.
5. Capture matching finalized postflight observations, exact receipts, runtime hashes, Safe owners and thresholds, BIT implementation state, escrow bindings, and zero-balance accounting.
6. Obtain the distinct contract-reviewer approval and promote the exact deployment manifest.

Use [closed testnet deployment](./CLOSED_TESTNET_DEPLOYMENT.md), [postflight](./CLOSED_TESTNET_DEPLOYMENT_POSTFLIGHT.md), and [deployment promotion](./DEPLOYMENT_PROMOTION.md). A provider label or different URL is not proof of independent operation.

### 4. Deploy isolated services

Deploy the persistent coordinator, solver endpoints, private-packet provider, capacity readers, and the distinct Lightning-operator and security-reviewer [daemon-evidence routes](./SOLVER_DAEMON_EVIDENCE_CLIENT.md) through the [durable provider boundary](./DURABLE_EVIDENCE_PROVIDER.md), each with its own initialized persistent replay-ledger volume and independent reader. Deploy the finality authorizers, both-assets verifier, two relays, two solver daemons, continuous monitors, redundant guardian broadcasters, recovery procedures, and alert delivery in the trust domains required by [service-isolation evidence](./SERVICE_ISOLATION_EVIDENCE.md). Deploy the [wallet ownership service and gateway](./CONTRACT_INTENT_WALLET.md) only on a private coordinator origin behind the SIWE edge, with a server-derived session digest, dedicated edge requester key, separate coordinator response key, handle/body logging disabled, and one enforced replica.

Required properties include:

- no Lightning credential in the browser, public web server, relay, or EVM service;
- no EVM signer in the browser, relay, reader, or Lightning adapter;
- the SIWE edge verifies wallet/session ownership, derives the opaque session digest server-side, checks exact Origin/Fetch Metadata plus CSRF and rate limits, and atomically consumes only an issued ownership handle before signing one wallet claim; it cannot recover or replay a lost claim response;
- only the reviewed browser adapter may call `eth_sendTransaction`; it independently verifies the coordinator claim, requires active user interaction, writes the digest-only Web-Lock/local-storage tombstone first, and never persists the token or response, while the coordinator durably claims first and every restart remains no-resend;
- authenticated encrypted private paths and reviewed service identity;
- independently retained encrypted backups and a witnessed isolated restore;
- continuous proxy, pause, decimals, finality, price, solver-capacity, LND-health, close-risk, and two-asset reconciliation;
- an alert closes new exposure before notification while claims, refunds, and withdrawals remain available; and
- no process restart between final candidate reconstruction, approval verification, live reconciliation, and activation.

### 5. Produce external evidence

Complete and retain:

- the independently signed [bootstrap operator roster](./PUBLIC_TESTNET_BOOTSTRAP_EVIDENCE.md);
- the five-report, five-signer [independent review package](./INDEPENDENT_REVIEW_EVIDENCE.md), with every finding closed or safely dispositioned and no accepted critical/high risk;
- the exact artifact and independent signer package required by [qualification review evidence](./QUALIFICATION_REVIEW_EVIDENCE.md);
- the three-role [service-isolation package](./SERVICE_ISOLATION_EVIDENCE.md);
- the exact v4 [safety-monitor policy](./MONITORING.md) whose confirmer routes are assigned to the two isolated EVM services;
- the five-role [operational-readiness package](./OPERATIONAL_READINESS_EVIDENCE.md), including alert delivery, backup/restore, every required incident drill, support, loss allocation, and zero unreconciled liabilities; and
- the exact public adoption policy used by every package and release limit.

Raw reports, credentials, endpoints, invoices, preimages, private identity evidence, and reusable signatures must remain outside Git. Commit only public policies and safe digests. Private generated records are non-overwriting mode-`0600` files.

### 6. Prepare and approve the tiny release

1. Prepare the evidence-derived bootstrap candidate through [public-testnet release candidates](./PUBLIC_TESTNET_RELEASE_CANDIDATES.md).
   Candidate v6 reconstructs the original qualification artifact and reviewer signature in-process, exposes the monitor upstream-record and operational safety-monitor/confirmer digests, and derives the final-release monitor policy; a copied verification summary, opaque test digest, or legacy candidate v5 is rejected.
2. Have all five release roles independently reconstruct the candidate from original evidence and compare both candidate digests out of band.
3. Prepare each role's exact payload without exposing a private key.
4. Collect controller and guardian ERC-1271 approvals from the reviewed Safes plus the three exact EIP-712 role approvals.
5. Verify the complete bundle against the candidate's live finalized provider quorum through [the approval ceremony](./PUBLIC_TESTNET_RELEASE_APPROVALS.md).

The standalone receipt cannot open the gate or authorize funding.

### 7. Activate once, then add tiny operator inventory

After the gate's minimum reopen delay, use the [same-process activation boundary](./PUBLIC_TESTNET_RELEASE_ACTIVATION.md) to:

1. rebuild the candidate from live provenance;
2. reverify all five approvals;
3. obtain fresh Lightning-operator and security-reviewer reconciliation signatures;
4. require exact live provider agreement on the gate, registry, escrows, BIT implementation, accounting, reserves, and caps; and
5. bind each solver's original locally verified capability and fresh capacity proof to that same active release and direction-specific escrow runtime.

Only the resulting in-memory capability/runtime pair may authorize the already-reviewed operator-funding workflow. Never restore authority from JSON, a database flag, a receipt, a copied proof, or a successful CI run. Deposit only the approved tiny operator-owned inventory after the witnessed activation succeeds.

### 8. Qualify permissionless testnet

Run at least two independently operated solvers for seven days through every mandatory scenario in [public-testnet campaign evidence](./PUBLIC_TESTNET_EVIDENCE.md), including churn, withholding, relay censorship, restarts, provider failure, reorg/finality rollback, Lightning failures, insolvency signals, monitoring loss, and incident response.

Publish privacy-safe per-solver fill, timeout, completion-time, capacity-freshness, and halt metrics. Reconcile to zero and close the gate before finalizing the campaign. A new `operator-testnet` candidate, approvals, gate delay, live activation, and funding decision are required; the bootstrap cannot silently become permissionless.

## Automatic stop rules

Stop new exposure and preserve exits when any required evidence expires or disagrees, a provider or signer set changes, BIT pauses or upgrades, runtime code changes, finality degrades, capacity becomes stale, LND or monitor health fails, a credential may be compromised, accounting does not reconcile, a cap is exceeded, or an incident remains unresolved.

Do not improvise around a failed verifier. Correct the external condition and produce a new signed evidence chain.

## Mainnet boundary

Passing the tiny bootstrap and seven-day permissionless testnet campaign does not authorize mainnet. Mainnet requires a later release schema, an equivalent mainnet preflight/postflight and promotion ceremony, new exact limits, real production reviews and incident evidence, a fresh five-role approval, and another same-process activation. Public pooled liquidity remains a separate future protocol and review scope.

## Adoption exit criteria

TreeSwap is ready for the tiny Sepolia bootstrap only when all of the following are simultaneously true:

- the exact source, BIT manifest, Sepolia deployment, postflight, and promotion chain verify;
- the gate is closed, balances and liabilities reconcile, and no public deposits exist;
- all required independent operators, reviewers, Safes, service identities, monitors, alerts, backups, drills, and support paths are live and evidenced;
- the adoption policy, bootstrap roster, external review, service-isolation, and operational packages verify without overlap or open high-risk findings;
- all five release approvals verify against the fresh provider quorum; and
- same-process live activation succeeds and issues only the tiny bootstrap capability.

Until then, the public site remains a non-funding prototype and direct sends remain ordinary wallet actions outside the bridge.
