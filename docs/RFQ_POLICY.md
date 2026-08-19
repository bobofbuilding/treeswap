# TreeSwap RFQ and quote-selection policy

Status: deterministic signed-offer validation and selection harness. Live independent solver and relay transport remains a testnet deployment gate.

## What TreeSwap can prove

Every solver offer is an EIP-712 message bound to protocol version, Ethereum chain, direction-specific verifying contract, request ID, direction, user, beneficiary, exact amounts, BIT fee, maximum routing fee, payment hash, invoice digest, request and offer nonces, expiry, and capacity epoch.

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
