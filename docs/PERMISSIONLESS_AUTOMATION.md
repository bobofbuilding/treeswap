# Permissionless and automatic operation

Status: target architecture. Local atomic RFQ/admission persistence, cryptographic solver capability verification, authenticated endpoint transport, and concrete capacity-reader protocols are implemented, but the current prototype does not yet open permissionless solver admission or execute swaps. Independently operated deployments, the complete solver daemon, deployed shared persistence, independent solvers/relays, and testnet fault evidence remain required.

## Recommended boundary

TreeSwap can be permissionless where permissionlessness improves competition without turning the protocol into an unbounded custodian:

| Surface | Target |
| --- | --- |
| Intent publication | Open through multiple relays and direct solver endpoints |
| Quote creation | Any solver may sign and return a quote |
| Quote verification | Local, deterministic, and independent of the relay |
| Lightning → BIT settlement | Permissionless solver after exact BIT pre-funding |
| BIT → Lightning settlement | Permissionless with a tiny unknown-solver cap; higher limits require objective history or a reviewed bond |
| Preimage relay | Permissionless; the beneficiary cannot change |
| User custody | Never permissionless: only the user wallet authorizes user funds |
| Public pooled liquidity | Excluded from this protocol version |

The contracts should not contain a solver allowlist. Safety comes from signatures, exact escrows, solver-owned inventory, one-use hashes/nonces, caps, and timeouts. The coordinator may rate-limit transport abuse, but it must not be the source of settlement authority.

## Open intent network

1. The client creates a short-lived blind RFQ containing only the direction, exact amount/unit, chain, maximum routing cost, expiry, and an unlinkable request identifier.
2. It sends the RFQ to several relays and optionally known solver endpoints.
3. Any solver may return a signed capability declaration and exact offer. BIT → Lightning offers all bind the user's one invoice; each Lightning → BIT solver instead binds its own distinct hold invoice. Relays cannot alter a signature or create an executable quote.
4. The client bounds work, retains at most one quote per solver, validates capacity freshness and every signed field, and commits the exact received set.
5. The user selects and signs one quote. For Lightning → BIT, only that offer's hold invoice becomes payable. There is no silent fallback to another solver or invoice.
6. The appropriate immutable escrow enforces the quote. Anyone may relay the preimage, but only the already-bound beneficiary is paid.

An ERC-7683-compatible resolver can later expose TreeSwap orders to general intent solvers, but it must identify Lightning verification, availability, finality, and node-capacity assumptions explicitly. A resolver does not make those assumptions trustless by itself.

## Automatic solver state machine

```text
observe intent
  → validate risk and capacity
  → sign exact offer
  → observe exact user acceptance
  → reserve inventory or observe user escrow
  → wait for canonical EVM finality
  → revalidate all mutable state
  → perform one idempotent Lightning action
  → relay the matching preimage
  → reconcile both assets
  → close, or halt new exposure on any mismatch
```

Every transition must be durable before its external side effect. A retry uses the same request ID and exact payload; it never creates a second invoice, payment, reservation, or claim. An ambiguous Lightning or EVM response enters `UNKNOWN` and is reconciled before another value-moving call.

## User automation

- BIT actions remain explicit wallet transactions; the bridge must never request an unlimited allowance.
- A connected Lightning wallet may use a one-shot capability for one exact invoice and maximum fee, but the default remains explicit wallet confirmation.
- Solver nodes may run unattended because they use operator-owned inventory and preconfigured caps.
- The web client never receives an LND macaroon or solver signing key.

## Admission without a gatekeeper

Unknown solvers may compete immediately, but their executable exposure starts small. Limits can increase from objective onchain completions, fresh signed capacity, reconciliation, uptime, and an optional bond whose slashing condition is mechanically provable. Subjective moderation, pay-to-list placement, and unverifiable “best price” claims are excluded.

The local verifier requires three independent proofs before a solver snapshot reaches admission: an EVM EIP-712 signature over the exact declaration, an Ed25519 endpoint-key signature, and an LND node signature whose recovered public key exactly matches the declaration. The endpoint client supplies a fresh 32-byte challenge, requires an exact short-lived signed response, refuses redirects and private or mixed DNS, pins the public connection address while preserving TLS hostname verification, and applies a hard transport deadline. It then requires fresh independently observed BIT inventory and Lightning capacity; signed self-report alone is never treated as capacity. The durable store carries the capability expiry and rejects a firm quote that outlives it. [Solver endpoint protocol](./SOLVER_ENDPOINT.md) defines the boundary.

The permissionless capability must remain disabled until the endpoint and reader protocols are deployed with independent operators, the complete solver daemon and relay federation are operating, per-solver limits are reviewed, and at least two independent testnet solvers pass the failure campaign. A signed Lightning aggregate authenticates its observer but cannot make private channel state publicly trustless, so unknown solvers remain subject to tiny caps, reconciliation, and objective history.
