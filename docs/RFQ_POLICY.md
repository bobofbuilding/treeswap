# TreeSwap RFQ and quote-selection policy

Status: blind multipath quote discovery, deterministic signed-offer selection, two-stage exact user authorization, atomic dual-resource reservation before disclosure, one-use durable executable-quote binding, atomic non-dispatching settlement acceptance, selected-solver private finalization, open cryptographic repository admission, authenticated endpoint transport, and concrete capacity-reader protocols are implemented locally. Independently operated endpoints/readers, encrypted disclosure deployment, shared persistence, wallet integration, and independent solver/relay operation remain testnet deployment gates. Funded operation is closed.

## Two-stage quote boundary

TreeSwap does not publish private settlement fields to an RFQ relay.

The public pricing request contains only an unlinkable pricing ID, direction, chain, exact output and unit, fee and routing caps, minimum capacity epoch, and short expiry. It contains no wallet, beneficiary, private settlement ID, payment hash, invoice digest, invoice, payee, route hints, email, or signature.

Each competing solver returns a blind EIP-712 offer bound to:

- the pricing ID, direction, solver, exact gross BIT, BIT fee, Lightning amount, routing cap, and expiry;
- the solver's own capacity epoch;
- the locally verified capability and capacity-snapshot digests;
- the endpoint-key and settlement-runtime digests; and
- exact verified BIT and Lightning capacity.

The blind offer is sufficient to compare price and currently verified capacity. Its fee cap is checked with exact integer cross-multiplication, so basis-point division cannot round an over-cap fee into validity. It cannot authorize an invoice payment, BIT reservation, or settlement because it deliberately omits the private settlement fields.

After the user selects one blind offer, the client prepares a short-lived EIP-712 selection authorization. It displays and binds the selected solver, exact gross BIT, BIT fee, Lightning amount, maximum routing fee, user, beneficiary, request nonce and digest, direction-specific pre-existing invoice commitments, the complete received-set commitment, and both expiries. `reserveSelectedBlindQuote` requires an in-process verification of that exact user signature as well as the exact module-private selection and capability used during authenticated collection. Schema v7 persists the selection-authorization digest in the same `BEGIN IMMEDIATE` transaction as the capacity reservation. Lightning → BIT reserves both gross solver BIT and inbound Lightning sats. BIT → Lightning reserves the exact output plus the solver-signed maximum routing headroom. Only an active, unexpired, unmodified database record and authorization can unlock the authenticated encrypted peer-bound disclosure defined in [`PRIVACY.md`](PRIVACY.md); copied objects, wrong wallets, fake stores, replaced methods, cancellation, expiry, capacity drift, request substitution, or record mutation fail closed.

The solver then returns one full executable EIP-712 quote. `finalizeSelectedBlindQuote` independently validates it and requires the offer ID, solver, economic terms, routing cap, capacity epoch, capability, snapshot, endpoint key, escrow runtime, and exact capacities to match the selected blind offer. The executable expiry may become shorter but never longer. The private quote additionally binds chain, escrow, request ID, direction, user, beneficiary, request and offer nonces, and direction-specific invoice fields. The coordinator atomically binds that exact private-request digest and executable-offer digest to the firm record, but this candidate still cannot authorize settlement.

The client must then show the complete invoice and exact executable terms and obtain a second short-lived EIP-712 user signature. That execution authorization binds the first authorization, request, executable offer, durable execution record, selected solver, beneficiary, amounts, routing ceiling, payment hash, invoice digest, and expiry. Schema v7 atomically persists its digest, signed expiry, and verification time. Use rechecks the active durable record and fails at the exact expiry boundary. Only the module-private result of this second verification can bind the solver invoice or enter a value-moving flow. A byte-identical retry is idempotent; a second invoice, payment hash, quote, request, or approval cannot reuse the reservation. A library selection, reservation copy, solver-finalization copy, or copied user-verification result is not authority.

A capability-bound full quote received outside that selected-solver transition remains useful for validation but cannot authorize settlement. Copies of a blind selection, delivery collection, capability result, or finalization do not carry module-private provenance.

## Invoice ownership

- BIT → Lightning begins with the user's exact amount-bearing invoice, but the public pricing stage exposes only its amount and caps. The invoice, SHA-256 digest of its canonical BOLT 11 string, payment hash, and payee are disclosed only to the selected solver. The same digest definition is used by invoice validation, RFQ disclosure, private packets, and the Lightning adapter. The selected solver's executable quote must bind that exact invoice data before BIT is deposited or Lightning is paid.
- Lightning → BIT uses no invoice during public pricing. The selected solver creates one short-lived invoice only after private selection and binds its nonzero payment hash and invoice digest in the executable quote. The reference solver uses its isolated `AddHoldInvoice` path, but BOLT 11 does not expose creation kind and the client trusts no remote kind flag. The client independently decodes the raw invoice, requires the signature payee to equal the capability-bound Lightning node, and applies conservative timing before countersigning or paying it.

This reduces cross-network linkage and avoids creating one invoice per unselected solver. A selected solver may still discover that it cannot route or honor the private invoice. It may not reprice or substitute terms; the attempt fails, affects objective reliability under the admission policy, and any next solver requires a fresh private disclosure and exact user authorization.

## Received-set selection

For offers actually received, selection is reproducible:

1. Authenticate the complete configured path plan and locally timestamp each bounded response.
2. Require at least two relay paths and two distinct direct solver paths to each contribute a retained valid blind offer.
3. Keep at most one best valid blind offer per solver.
4. Compare exact-input cost for the requested exact output.
5. Break equal-price ties by local receipt time and then offer ID.
6. Commit the path attempts, response digests, safe failures, and complete verified offer set.
7. Require the user to select one exact blind offer.
8. Require exact user selection authorization before reservation or private disclosure.
9. Privately finalize only that solver's matching executable quote.
10. Require a second exact user authorization over the full quote and invoice commitments before execution.
11. Require both authorizations again before any fallback solver is used.

Input work is bounded before expensive quote validation. Duplicate offer IDs, path identifiers, origins, keys, operator commitments, identity digests, and direct solver identities reject. An authenticated empty path does not satisfy offer-delivery diversity. See [Authenticated multipath RFQ delivery](./RFQ_DELIVERY.md).

## What TreeSwap cannot prove

No contract or client can prove that an untrusted relay delivered every quote that existed elsewhere. Distinct keys and operator commitments do not prove distinct organizations or hosting control. TreeSwap therefore:

- requests blind offers from multiple relay and direct-solver paths;
- refuses to label a result “global best” or “market best”;
- displays “Best received quote” with verified solver and path counts;
- lets the user inspect and choose the signed blind offer;
- requires an exact matching private finalization plus its second user authorization, then atomically commits that authorization with the non-dispatching settlement before browser success; and
- excludes order-book rewards from v1.

The combined receipt makes the client's observed delivery and offer set reproducible. It does not turn that set into global availability proof.

## Deployment gate

Before testnet swaps, deploy at least two independently operated relays and two independently operated direct solver endpoints, use short-lived capability epochs, retain privacy-minimized receipt evidence, inspect key and infrastructure control, and measure suppression, duplication, latency, expiry, private-finalization failure, path outage, key rotation, and fill failure. Public rewards or a global-best claim require a separate mechanism and review.

`lib/solver-capability.mjs` binds each short-lived capability to the EVM solver, chain, direction-specific escrow and runtime code hash, Lightning node public key, canonical HTTPS endpoint origin, Ed25519 endpoint key, exact capacities, monotonic epoch, and expiry. Its EVM, endpoint, and Lightning-node possession proofs plus independent BIT and Lightning observations must all validate before either a blind or executable quote can use the capability.

The durable admission store has no solver allowlist. Unknown BIT → Lightning solvers receive the configured first-fill cap, and one global in-flight ceiling spans every identity. Higher capacity requires objectively proven completed settlements. A selected solver that cannot privately finalize or execute cannot silently substitute terms and is accounted under the reviewed reliability policy.

Production still needs independently operated relays, endpoints and readers, a deployed encrypted selected-solver disclosure service backed by shared durable coordinator storage, live invoice decoding, and at least two independently operated testnet solvers.
