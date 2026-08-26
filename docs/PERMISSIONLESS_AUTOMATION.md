# Permissionless and automatic operation

Status: target architecture with open cryptographic repository admission implemented. Local atomic RFQ persistence, authenticated multipath delivery, dual-resource pre-disclosure reservation, one-use durable executable-quote binding, authenticated endpoint and TLS-only one-use private-packet transport, concrete capacity readers, capped unknown-solver exposure, objective fill-history promotion, and a bounded durable-state daemon executor are implemented. No public permissionless service or funded swap is authorized. Independently operated deployments, reviewed private-provider certificate and network identity, deployed finality/asset-verification controls, shared persistence, independent solvers/relays, and testnet fault evidence remain required.

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
2. It sends the exact bounded RFQ concurrently through at least two configured relays and to at least two distinct capability-bound solver endpoints. Every path receives a fresh challenge and signs its complete response batch; the client supplies receipt time.
3. Any solver may return a signed capability declaration and blind price/capacity offer. The relay sees no wallet, beneficiary, private request ID, invoice, digest, hash, payee, or signature-bearing private settlement packet.
4. The client rejects reused path identities, requires responsive relay and direct-solver diversity that actually contributes valid offers, bounds work, retains at most one quote per solver, validates capacity freshness and every signed field, and commits the exact path attempts and received set.
5. The user selects one blind offer. Only that solver receives the private settlement packet and must return an exact executable quote matching the selected solver, price, capability, capacity, endpoint, and escrow runtime. For Lightning → BIT, only then does it create the payable hold invoice. There is no silent fallback or repricing.
6. The user explicitly authorizes the finalized quote and the appropriate immutable escrow enforces it. Anyone may relay the preimage, but only the already-bound beneficiary is paid.

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

The repository planner derives exactly one next step from the coordinator database. The bounded runtime rehydrates only the exact invoice, preimage, or public EVM template needed for that step through a fresh, signed, one-use packet and then discards it. The runtime has no independent finality authority: every proposed Lightning dispatch must still pass a canonical/finalized escrow authorization bound to the exact packet immediately before the adapter call, and every EVM claim must still use the bound one-transaction outbox. A successful payment lookup returns the bound preimage only in memory, including after restart; it never enters coordinator storage. Ambiguous value-moving responses are never resent. Full unattended operation remains blocked until the packet provider, finality authorizers, asset verifier, and persistence service are independently deployed, protected, reviewed, and exercised by multiple operators.

## User automation

- BIT actions remain explicit wallet transactions; the bridge must never request an unlimited allowance.
- A connected Lightning wallet may use a one-shot capability for one exact invoice and maximum fee, but the default remains explicit wallet confirmation.
- Solver nodes may run unattended because they use operator-owned inventory and preconfigured caps.
- The web client never receives an LND macaroon or solver signing key.

## Admission without a gatekeeper

Unknown solvers may compete immediately, but their executable exposure starts small. Limits can increase from objective onchain completions, fresh signed capacity, reconciliation, uptime, and an optional bond whose slashing condition is mechanically provable. Subjective moderation, pay-to-list placement, and unverifiable “best price” claims are excluded.

The local verifier requires three independent proofs before a solver snapshot reaches admission: an EVM EIP-712 signature over the exact declaration, an Ed25519 endpoint-key signature, and an LND node signature whose recovered public key exactly matches the declaration. TreeSwap decodes LND's canonical 65-byte zbase32 compact signature and recovers the compressed secp256k1 public key over LND's default double-SHA256 `Lightning Signed Message:` domain; solvers must use `SignMessage` with `single_hash=false`. This proves possession of the declared node key. It does not reproduce LND's channel-graph activity policy or prove liquidity; the separate signed capacity observation remains mandatory. The official operator client fixes this verifier, the module-owned public Node HTTPS transport, the system clock, and cryptographic entropy. Its required production Lightning-capacity reader separately fixes a private port-443 Node HTTPS `/v1/capacity` transport, the system clock, cryptographic request entropy, and a bounded non-cacheable response. Injected variants of either layer cannot enter active or recovery operator composition. The endpoint client supplies a fresh 32-byte challenge, requires an exact short-lived signed response, refuses redirects and private or mixed DNS, pins the public connection address while preserving TLS hostname verification, and applies a hard transport deadline. It then requires fresh independently observed BIT inventory and Lightning capacity; signed self-report alone is never treated as capacity. An executable offer must bind the verifier-issued capability and capacity-snapshot digests, exact observed amounts, endpoint-key digest, direction-specific escrow address and runtime hash, chain, solver-specific epoch, and expiry. Indicative books cannot authorize invoice payment or settlement. Before private data is revealed, the durable store atomically reserves gross BIT plus inbound Lightning for Lightning → BIT, or outbound Lightning plus maximum routing headroom for BIT → Lightning. It then accepts only one exact private-request/executable-quote digest pair for that firm offer. The same store carries capability expiry, applies both the per-solver unknown cap and the all-solver global BIT → Lightning in-flight ceiling, and increments completed history only after an exact selected offer reaches `COMPLETED` with a both-assets proof. [Solver endpoint protocol](./SOLVER_ENDPOINT.md) defines the boundary.

Public permissionless execution must remain disabled until the endpoint, private-packet, and reader protocols are deployed with independent operators, the private-packet HTTPS identity and private trust root or equivalent service-mesh identity are reviewed, the bounded solver daemon and relay federation are operating, per-solver limits are reviewed, and at least two independent testnet solvers pass the failure campaign. A signed Lightning aggregate authenticates its observer but cannot make private channel state publicly trustless, so unknown solvers remain subject to tiny caps, reconciliation, and objective history.
