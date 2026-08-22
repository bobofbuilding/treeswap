# Authenticated multipath RFQ delivery

Status: the local blind-pricing client protocol, path-diversity gate, authenticated batch merge, durable pre-disclosure capacity reservation, one-use executable binding, selected-solver finalization, and adversarial tests are implemented. No relay or encrypted disclosure service is deployed, no shared coordinator or operator independence has been established, and funded operation remains closed.

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

The blind offer deliberately cannot move funds. Before private disclosure, the coordinator requires the exact authenticated selection and exact locally verified capability, matches the active RFQ and capacity snapshot, then atomically reserves the record. Lightning → BIT locks gross BIT and inbound Lightning capacity; BIT → Lightning locks output plus maximum routing headroom. A library selection alone is not a reservation or authority. Disclosure re-reads the exact active firm, RFQ, and capacity records, rejects backward time, and sends the complete private request only over an authenticated encrypted channel bound to the selected solver. BIT → Lightning discloses the fixed invoice only after its canonical digest matches; Lightning → BIT leaves invoice fields empty so only the selected solver can create its hold invoice.

That solver returns one full capability-bound executable quote. Finalization refuses repricing, solver substitution, capacity or runtime changes, longer expiry, request linkage, or copied provenance, then atomically binds the exact private-request and executable EIP-712 digests to the firm record. A byte-identical retry is the only idempotent replay. A second invoice or quote variant fails across coordinator connections, and further private disclosure stops once the executable binding exists.

A legacy or flat executable envelope list cannot bind an invoice. `bindFinalizedSolverInvoice` accepts only the module-private result of active durable reservation plus exact private finalization.

## Path identity and transport

Each path is configured locally. Relay paths bind a canonical public HTTPS origin, Ed25519 public-key digest, path identifier, and retained operator-evidence commitment. Direct paths bind those fields plus a distinct solver EVM address and its module-private verified capability. The direct origin and key must exactly match that capability.

The plan rejects duplicate identifiers, origins, keys, operator commitments, identity digests, or direct solver identities before network access. The default `POST /v1/rfq` transport permits only canonical credential-free HTTPS origins on the default port, resolves only public addresses, refuses mixed public/private DNS, pins the selected address while preserving TLS hostname verification and `Host`, refuses redirects, bounds JSON and bytes, and applies a hard deadline.

The merged receipt commits the blind pricing digest, complete configured plan, attempt count, authenticated response digests, local receipt times, bounded expiries, privacy-safe failure codes, retained blind offers, and final user selection. It retains no private settlement fields.

## Qualification checkpoint

Clean published source [`b4f10c1604ed2d4c384d05cc1971afc050536533`](https://github.com/bobofbuilding/treeswap/commit/b4f10c1604ed2d4c384d05cc1971afc050536533), merged through [PR #34](https://github.com/bobofbuilding/treeswap/pull/34), passed 443 application/security tests with one intentional deployment-only skip, both production web build paths, 68 contract tests, the expanded 97-test pinned schema-v5 coordinator matrix plus bounded-filesystem rollback, all 41 sealed local campaigns from `2026-08-22T14:22:19.243Z` through `2026-08-22T15:31:47.379Z`, and [hosted main-branch CI](https://github.com/bobofbuilding/treeswap/actions/runs/32578495706). Vercel production deployment passed and both official aliases return HTTP 200.

The ignored regular mode-`0600` qualification artifact independently reconstructs to `sha256:f6c7d23181fcc17989ef6f122ff8f08b52f4eae3b90d72157c1168dfd8397272`. All 137 configuration hashes, 41 passed campaigns, three pinned images, exact clean remote-`main` source, privacy exclusions, and lab teardown reproduce. The one-hour Lightning campaign passed 3,603 monotonic seconds, 119 observations, midpoint adapter replacement with persisted chain-progress state, deterministic stale-chain rejection, and zero dispatch. The artifact is local-only, records a simulated EVM reservation, and grants no funding authority.

## What remains unprovable

No client can prove that a relay forwarded every quote it saw or that no better quote existed elsewhere. Two keys and two operator commitments also do not prove organizational independence. TreeSwap therefore continues to say “Best received quote,” excludes market-making rewards, and requires retained deployment evidence from independently controlled relays and solvers.

Before funded testnet operation:

1. deploy at least two independently operated relay services and at least two independently operated capability-bound solver endpoints;
2. deploy and review the encrypted selected-solver disclosure endpoint;
3. retain reviewed ownership, hosting/control, key-custody, availability, and rotation evidence for every path;
4. measure suppression, duplication, latency, expiry, empty/malformed batches, private-finalization failures, path outage, key rotation, and failover; and
5. bind the real path roster and campaign results into signed release evidence.

The local tests use in-process keys and simulated HTTPS responses. They prove protocol behavior and that public wire records exclude the fixture's private settlement identifiers; they do not establish external independence, deployed encryption, or funding authority.
