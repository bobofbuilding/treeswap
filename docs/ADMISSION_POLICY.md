# TreeSwap RFQ admission and firm-quote policy

Status: executable repository policy. Authenticated transport, persistent atomic counters, independent solver operators, and production reliability telemetry remain deployment gates.

## Two stages, one inventory lock

An RFQ request is only a short-lived request for prices. It does not reserve BIT or Lightning. The gateway accepts it only from an authenticated identity, applies a minimum quantity, active-request and rolling-window quotas, and rejects a nonce at or below that identity's cancellation sequence.

A response becomes a firm quote only after an admitted solver signs the exact terms and its fresh capacity epoch has enough uncommitted inventory. Capacity accounting must be written atomically before the signature is released. One solver cannot occupy more than its configured number of active firm-quote slots.

For Lightning → BIT, the onchain vault is the final commitment: the solver pre-funds its segregated balance and signs the same selected quote as the user. Only the named user can exercise it, and the solver no longer has a transaction-time veto. The vault permits one active reservation per user and releases that slot only at `CLAIMED` or `REFUNDED`.

For BIT → Lightning, Ethereum cannot force an offchain Lightning payment. The user-funded escrow is fully refundable and charges no fee on failure, while the admission layer records failures attributable to a solver. Consecutive failures suspend that solver. User abandonment or an unexercised expiry does not count against the solver.

## Deliberate v1 limits

- Solvers are explicitly admitted; there is no permissionless public solver set.
- Quotes are full-fill, short-lived, exact, and signed.
- No public order reservation exists before a user selects a quote.
- Every fallback requires a new user authorization.
- Bonds and slashing are deferred because an honest-failure adjudicator does not yet exist. Reliability and small exposure caps are safer than a subjective slashing admin.

These controls follow the firm, short-lived RFQ shape used by established offchain-quote systems, but TreeSwap does not inherit their liquidity, monitoring, or execution guarantees.
