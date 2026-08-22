# Authenticated multipath RFQ delivery

Status: the local blind-pricing client protocol, path-diversity gate, authenticated batch merge, selected-solver executable finalization, and adversarial tests are implemented. No relay is deployed, no operator independence has been established, and funded operation remains closed.

## Purpose

A solver signature protects quote terms, but it does not prove how the quote reached the user. A caller-supplied source label or timestamp would let one relay impersonate several paths, manufacture receipt ordering, or submit only a preferred subset to selection. Sending full settlement quotes through those paths would also expose cross-network identifiers that TreeSwap promises to reveal only to the selected solver.

TreeSwap therefore separates three authorities:

- the relay or endpoint Ed25519 signature authenticates delivery of one exact blind-offer batch;
- each solver's EIP-712 signature authenticates its blind price and capability terms; and
- only the selected solver's later full EIP-712 quote can bind private settlement terms.

## Public collection

The client sends only the exact privacy-safe pricing request under a fresh 32-byte challenge. The request binds its canonical digest, configured path-identity digest, and a short expiry. It contains no user, beneficiary, private request ID, invoice, invoice digest, payment hash, payee, route hint, email, or signature.

Every relay or direct solver endpoint signs the exact echoed request and complete bounded blind-offer batch. The client records receipt time only after the response body arrives. The collector queries the complete configured plan concurrently and requires at least two authenticated relay responses plus two distinct capability-bound direct solver responses. A direct response must match the exact capability digest, capacity snapshot, endpoint key, runtime, epoch, and inventory configured for that path; an older endpoint key cannot deliver an offer under a different capability. The book becomes selectable only when each minimum path count supplied at least one retained, valid blind solver offer.

Identical offers delivered over several paths appear once in the quote book but every path remains committed in the delivery receipt. A relay mutation fails the solver signature. A relay cannot select a quote because complete collection and deterministic validation finish before the user chooses.

## Private finalization

The blind offer deliberately cannot move funds. Before private disclosure, the coordinator must atomically reserve that exact one-use offer and capacity; a library selection alone is not a reservation or authority. After selection, the existing privacy boundary discloses addresses and direction-appropriate invoice/hash data only to the selected solver over an authenticated encrypted peer-bound channel. BIT → Lightning discloses the user's fixed invoice; Lightning → BIT leaves invoice fields empty so only the selected solver can create its hold invoice. That solver returns one full capability-bound executable quote. Finalization refuses repricing, solver substitution, capacity or runtime changes, longer expiry, request linkage, or a copied selection.

A legacy or flat executable envelope list cannot bind an invoice. `bindFinalizedSolverInvoice` accepts only the module-private result of blind selection plus exact private finalization.

## Path identity and transport

Each path is configured locally. Relay paths bind a canonical public HTTPS origin, Ed25519 public-key digest, path identifier, and retained operator-evidence commitment. Direct paths bind those fields plus a distinct solver EVM address and its module-private verified capability. The direct origin and key must exactly match that capability.

The plan rejects duplicate identifiers, origins, keys, operator commitments, identity digests, or direct solver identities before network access. The default `POST /v1/rfq` transport permits only canonical credential-free HTTPS origins on the default port, resolves only public addresses, refuses mixed public/private DNS, pins the selected address while preserving TLS hostname verification and `Host`, refuses redirects, bounds JSON and bytes, and applies a hard deadline.

The merged receipt commits the blind pricing digest, complete configured plan, attempt count, authenticated response digests, local receipt times, bounded expiries, privacy-safe failure codes, retained blind offers, and final user selection. It retains no private settlement fields.

## Qualification checkpoint

Clean published source [`28a3542d0f70027aef028e9f52d828958c846964`](https://github.com/bobofbuilding/treeswap/commit/28a3542d0f70027aef028e9f52d828958c846964), merged through [PR #32](https://github.com/bobofbuilding/treeswap/pull/32), passed 438 application/security tests with no skips, both production web build paths, 68 contract tests, all 41 sealed local campaigns from `2026-08-22T12:35:19.483Z` through `2026-08-22T13:44:47.684Z`, and [hosted main-branch CI](https://github.com/bobofbuilding/treeswap/actions/runs/32573377971). Exact Vercel deployment [`dpl_2zxDPfgrrmrCzQdnj3P14NY8wT9C`](https://treeswap-60re0ks7w-bittrees-tech.vercel.app) is ready and serves both official aliases.

The ignored regular mode-`0600` qualification artifact independently reconstructs to `sha256:61fdb565cb75c8cf7e2f89f90a32d87a52e50f8c56ebe2b8e253c663e8323d3a`. All 135 configuration hashes, 41 unique passed campaigns, three pinned images, exact clean remote-`main` source, privacy exclusions, and lab teardown reproduce. The one-hour Lightning campaign passed 3,603 monotonic seconds, 119 observations, midpoint adapter replacement with persisted chain-progress state, deterministic stale-chain rejection, and zero dispatch. The artifact is local-only, records a simulated EVM reservation, and grants no funding authority.

## What remains unprovable

No client can prove that a relay forwarded every quote it saw or that no better quote existed elsewhere. Two keys and two operator commitments also do not prove organizational independence. TreeSwap therefore continues to say “Best received quote,” excludes market-making rewards, and requires retained deployment evidence from independently controlled relays and solvers.

Before funded testnet operation:

1. deploy at least two independently operated relay services and at least two independently operated capability-bound solver endpoints;
2. deploy and review the encrypted selected-solver disclosure endpoint;
3. retain reviewed ownership, hosting/control, key-custody, availability, and rotation evidence for every path;
4. measure suppression, duplication, latency, expiry, empty/malformed batches, private-finalization failures, path outage, key rotation, and failover; and
5. bind the real path roster and campaign results into signed release evidence.

The local tests use in-process keys and simulated HTTPS responses. They prove protocol behavior and that public wire records exclude the fixture's private settlement identifiers; they do not establish external independence, deployed encryption, or funding authority.
