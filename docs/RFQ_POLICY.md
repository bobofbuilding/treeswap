# TreeSwap RFQ and quote-selection policy

Status: deterministic signed-offer validation, selection, local atomic admission persistence, a short-lived solver capability verifier, authenticated endpoint transport, and concrete capacity-reader protocols are implemented. Independently operated endpoints/readers and independent solver/relay operation remain testnet deployment gates.

## What TreeSwap can prove

Every solver offer is an EIP-712 message bound to protocol version, Ethereum chain, direction-specific verifying contract, request ID, direction, user, beneficiary, exact amounts, BIT fee, maximum routing fee, payment hash, invoice digest, request and offer nonces, expiry, and capacity epoch.

Invoice ownership differs by direction:

- For BIT → Lightning, the user supplies one exact standard invoice. Its payment hash and invoice digest are fixed in the request and every solver must quote against those same values.
- For Lightning → BIT, the pricing request uses the all-zero payment hash and invoice digest because no shared invoice can represent competing solver nodes. Every solver creates and signs a distinct short-lived hold invoice, and its offer binds that invoice's nonzero hash and digest. Duplicate hashes or invoice digests across competing solver identities are rejected.

After the user selects a Lightning → BIT offer, `bindSelectedSolverInvoice` converts only that signed offer's hash and invoice digest into the private settlement intent and commits the received-set digest. The user must decode and validate that exact hold invoice before countersigning or paying. Unselected hold invoices receive no payment and expire or are canceled by their owning solver under bounded firm-quote admission.

The client rejects any offer that changes an exact request field, exceeds a user cap, uses stale capacity, lacks a canonical solver signature, or outlives the short request window.

For the offers actually received, selection is reproducible:

1. Keep at most one best valid offer per solver.
2. Compare exact-input cost for the requested exact output.
3. Break equal-price ties by local receipt time and then offer ID.
4. Commit the complete verified received set to `receiptDigest`.
5. Require the user to select and authorize one exact offer.
6. Require fresh user authorization before any fallback solver is used.

Input work is bounded before signature verification, duplicate offer IDs are rejected, and a single solver cannot gain extra positions by flooding variants.

## What TreeSwap cannot prove

No contract or client can prove that an untrusted relay delivered every quote that existed elsewhere. TreeSwap therefore:

- requests offers directly from multiple independent solver identities and, where available, more than one relay;
- refuses to label a result “global best” or “market best”;
- displays “Best received quote” and the number of verified solvers and sources;
- lets the user inspect and choose the signed offer; and
- excludes order-book rewards from v1.

The `receiptDigest` makes the client's observed set reproducible; it does not turn that observed set into global availability proof.

## Deployment gate

Before testnet swaps, connect at least two independently operated solvers, use short-lived capacity epochs, authenticate the transport, retain privacy-minimized receipt evidence, and measure suppression, latency, expiry, and fill failures. Public rewards or a global-best claim require a separate mechanism and review.

`lib/solver-capability.mjs` now binds each short-lived capability to the EVM solver, chain and direction-specific escrow, Lightning node public key, canonical HTTPS endpoint origin, Ed25519 endpoint key, exact capacities, monotonic epoch, and expiry. The EVM identity signs the full EIP-712 declaration; the endpoint key and LND node key separately prove possession of the exact domain-bound challenge. The verifier accepts capacity only when independent BIT and Lightning observations are fresh, belong to the bound solver/node, and cover the declared amounts. Capability expiry is persisted, a firm quote may not outlive it, and legacy records migrate expired rather than gaining authority.

`lib/solver-endpoint-transport.mjs` implements the bound endpoint protocol: a random challenge and exact solver/direction are echoed in a response signed by the declared Ed25519 key; short time windows, canonical HTTPS, public-only DNS pinning, TLS hostname verification, no redirects, bounded JSON, and a hard deadline fail closed before capability admission. The pinned regtest campaign independently recovers the declared LND node from four fresh signatures, rejects a mutated challenge, and proves the signer and verifier credentials cannot call each other's RPC. The capacity-reader campaign separately compares exact finalized vault state across two providers and verifies direction-bound signed Lightning aggregates with reserves, budgets, no channel identifiers, and distinct observer keys. This is local transport, node-control, and reader evidence. Production still needs independently operated endpoints/readers, live invoice decoding, and at least two independently operated testnet solvers. See [Solver endpoint protocol](./SOLVER_ENDPOINT.md).
