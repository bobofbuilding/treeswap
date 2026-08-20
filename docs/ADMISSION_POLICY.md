# TreeSwap RFQ admission and firm-quote policy

Status: executable repository policy. Solver entry has no allowlist, but public-testnet endpoints, shared persistence, independent operators, reviewed limits, and production reliability telemetry remain deployment gates. Funded operation is closed.

## Two stages, one inventory lock

An RFQ request is only a short-lived request for prices. It does not reserve BIT or Lightning. The gateway accepts it only from an authenticated identity, applies a minimum quantity, active-request and rolling-window quotas, and rejects a nonce at or below that identity's cancellation sequence.

A solver may enter without operator approval only after the local verifier proves its EVM key, endpoint key, Lightning node, escrow domain and runtime code, and independently observed inventory. An indicative signed response is not executable. An executable response must additionally bind the exact verified capability digest, capacity-snapshot digest and values, endpoint-key digest, direction-specific escrow runtime hash, per-solver capacity epoch, and expiry. A copied or reconstructed verification result has no authority.

The response becomes a firm quote only after the solver signs those exact terms and its fresh capacity epoch has enough uncommitted inventory. Capacity accounting must be written atomically before the signature is released. One solver cannot occupy more than its configured number of active firm-quote slots. The first accepted RFQ permanently binds the complete admission-policy digest in that coordinator database; later calls cannot silently raise a cap, relax a quota, or change the promotion threshold.

For Lightning → BIT, the onchain vault is the final commitment: the solver pre-funds its segregated balance and signs the same selected quote as the user. Only the named user can exercise it, and the solver no longer has a transaction-time veto. The vault permits one active reservation per user and releases that slot only at `CLAIMED` or `REFUNDED`.

For BIT → Lightning, Ethereum cannot force an offchain Lightning payment. The user-funded escrow is fully refundable and charges no fee on failure. A solver with insufficient completed history receives only the configured unknown-solver cap. It reaches the higher established cap only after the configured number of settlements have reached `COMPLETED` with an independently verified both-assets terminal proof bound to the selected offer. A claimed fill without that proof cannot change history. A separate atomic global BIT → Lightning in-flight ceiling prevents one operator from multiplying aggregate exposure across many fresh solver identities. Consecutive attributable failures suspend the solver; user abandonment or an unexercised expiry does not count against it.

## Deliberate v1 limits

- Repository admission is open and cryptographic; there is no solver allowlist or administrator promotion switch.
- Unknown BIT → Lightning exposure is capped. Promotion uses completed-swap evidence only.
- Aggregate BIT → Lightning in-flight exposure is capped across every solver identity.
- Lightning → BIT is limited by exact, independently verified, solver-owned prefunded BIT inventory.
- Quotes are full-fill, short-lived, exact, and signed.
- No public order reservation exists before a user selects a quote.
- Every fallback requires a new user authorization.
- Bonds and slashing are deferred because an honest-failure adjudicator does not yet exist. Reliability and small exposure caps are safer than a subjective slashing admin.

These are repository controls, not evidence of a public permissionless service. The web product must not publish executable funded quotes until multiple independent testnet solvers, relays, capacity observers, durable infrastructure, monitoring, incident drills, and review satisfy the production checklist.

The exact candidate record for that external campaign is defined in [Public-testnet campaign evidence](./PUBLIC_TESTNET_EVIDENCE.md). It requires at least two solver operators, twenty selected swaps per solver with ten in each direction, reconciled outcome totals, bounded timeout/failure rates, capacity freshness, halt history, relay-censorship and solver-fault drills, a final closed gate, and zero unexplained liabilities. The verifier produces adoption telemetry and release inputs, not executable quotes or funding authority.

Clean published commit `430a829bed99e88596d27326aecb6e3aca21a35a` passed the dedicated 40-test permissionless-admission campaign, the complete 246-test application/security suite, 91 direct pinned-runtime tests plus bounded-filesystem rollback, 68 contract tests, both builds, all 30 sealed local campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32375971751). Its ignored mode-`0600` local-only evidence independently reconstructs to `sha256:acd75e9bd650883329ffac589e802c6c429d6afecab96e63d80bd220ec9e64c3`; it grants no funding authorization.

These controls follow the firm, short-lived RFQ shape used by established offchain-quote systems, but TreeSwap does not inherit their liquidity, monitoring, or execution guarantees.
