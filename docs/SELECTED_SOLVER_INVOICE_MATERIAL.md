# Selected-solver invoice material

Status: the non-listening Lightning → BIT hold-invoice core, signed private client/service protocol, durable key-version and response journal, TLS-pinned local listener, selected-solver finalizer composition, and pinned-LND regtest campaigns are implemented. A hard service-process kill replays the byte-identical signed response without creating a second invoice. The boundary cannot settle or cancel an invoice and grants no funding, EVM, BIT-transfer, or bridge-opening authority. It is not independently deployed or externally reviewed, so funded operation remains closed.

## Purpose and boundary

Lightning → BIT requires the selected solver to return one hold invoice after blind competition and durable capacity reservation. The invoice must remain reconstructible if the public provider crashes after LND creates it but before the provider commits its signed response. Creating a fresh random invoice during recovery would change the payment hash and could leave multiple live liabilities.

`lib/selected-solver-invoice-material.mjs` is the private cryptographic/LND core for that one operation. It accepts only the exact selected-solver request ID and digest, capability digest, selected offer ID, and Lightning amount. It owns:

- one versioned symmetric payment-secret key loaded from an owner-controlled 32-byte file;
- one pinned private-network LND REST client opened from a mode-restricted macaroon and pinned TLS certificate; and
- one fixed memo and bounded hold-invoice policy.

The core exposes no listener. `lib/selected-solver-invoice-material-provider.mjs` places it behind an exact private `POST /v1/invoice-material` route with Ed25519 requester allowlisting, a separately signed response, TLS-required origin, strict framing, bounded time and body work, a durable claim lease, and exact response replay. `lib/selected-solver-invoice-material-finalizer.mjs` gives the selected-solver provider only the verified invoice material; it never receives the LND client, macaroon, symmetric key, or preimage. The browser, RFQ relay, coordinator database, BIT/WBTC price reader, and public provider journal must likewise never receive those secrets. BIT → Lightning bypasses the service and preserves the user's validated invoice unchanged.

## Deterministic recovery key

The core derives a 32-byte preimage with HMAC-SHA256 over a domain-separated, length-framed tuple containing the payment-secret key ID and every exact request commitment. It immediately hashes that transient buffer with SHA-256 to obtain the LND payment hash and overwrites the local preimage buffer. It returns only the payment hash, invoice, invoice digest, request commitments, LND state/add index, and key ID. It never returns, persists, or logs the preimage.

Changing the request ID, request digest, capability, selected offer, amount, key ID, or key changes the payment hash. Restarting with the same exact key version and request reconstructs the same hash. This is an idempotency key, not randomness supplied by the public caller.

The key ID and key bytes must remain immutable for every live request and remain recoverable until every invoice derived from that version is terminal and the corresponding EVM claim/refund is finalized. An operator must not rotate the file in place. The private SQLite journal now binds each claimed semantic request to exactly one payment-secret key ID before LND work and rejects key-version substitution across restart. Production still needs retained old-key custody, rotation/revocation drills, a two-person recovery procedure, and verified deletion only after every liability is terminal.

## LND resolution rule

Resolution first looks up the exact derived payment hash. A valid existing `OPEN` or `ACCEPTED` hold invoice is returned. Creation is allowed only after the pinned LND REST response is reduced to one exact non-sensitive missing-invoice classification. Pinned LND can return either HTTP 500/gRPC 2 when its invoice database is empty or HTTP 404/gRPC 5 once other invoices exist. The shared LND transport maps only recognized missing-invoice text to `invoice-not-found`; permission failures map to `permission-denied`; all remote text is discarded.

When creation is allowed, the core calls `AddHoldInvoice` with the same deterministic payment hash, exact amount, fixed expiry and CLTV, fixed memo, and `private: true` route-hint request. It then performs a mandatory lookup and trusts only that lookup record. A duplicate or lost add response can therefore recover through the same hash; no retry may choose a different hash.

The lookup must prove:

- the exact payment hash, whole-satoshi amount, memo, expiry, and final CLTV;
- canonical LND scalar encodings and a nonzero add index;
- `OPEN` or `ACCEPTED`, not settled or canceled;
- a nonzero payment address/payment secret;
- no revealed preimage;
- no AMP, keysend, or blinded-invoice mode; and
- one bounded invoice whose digest is recomputed locally.

The LND `private` response field is not used as a confidentiality claim. In pinned LND it describes route-hint construction and may be false even when creation requested `private: true`. Independent BOLT 11 decoding remains mandatory before the invoice reaches a pay action.

Any transport ambiguity, permission failure, malformed record, conflicting existing invoice, changed policy field, unsafe state, or post-add lookup failure returns a closed or explicitly ambiguous result. An ambiguous result permits only another exact request/payment-hash recovery attempt.

## Credential and container isolation

Production `LndRestClient` objects can now be created only through the credential-file factory and are immutable after construction. The payment-secret loader requires one non-symlinked, owner-controlled, mode-restricted 32-byte file inside a private directory and wipes the read buffer after constructing the secret key object.

The regtest role `invoice-material` has a distinct root-key ID and only:

- `/invoicesrpc.Invoices/AddHoldInvoice`; and
- `/invoicesrpc.Invoices/LookupInvoiceV2`.

It cannot cancel, settle, list invoices, list payments, inspect wallet balances, administer macaroons, or use node/channel authority. The private service and client containers are read-only, unprivileged, capability-free, and attached only to the internal regtest network. Their credential volumes are disjoint: only the service receives the narrow LND bundle, payment secret, provider private key, requester public key, and TLS private key; only the client receives the requester private key, provider public key, and pinned public certificate. Runtime checks prove the opposite-side credentials are absent. Test cleanup uses separate lab authority.

## Evidence

`npm run regtest:selected-solver-invoice-smoke` uses pinned LND `v0.21.2-beta` to create one exact 10,000-sat, 3,600-second, 80-block hold invoice. It recreates the core from the retained payment-secret file, recovers the exact payment hash, invoice, digest, and add index, proves the narrow credential cannot cancel it, and then cancels through separate lab authority.

`npm run regtest:selected-solver-invoice-private-service-smoke` adds the real private boundary. It pins a self-contained TLS identity and separate requester/provider Ed25519 identities, commits one signed response to a mode-restricted SQLite volume, hard-kills the service process, restarts against the same volumes, and requires the fresh authenticated request to receive the byte-identical response. LND must contain exactly one matching liability before and after restart. Unit tests additionally cover every signed field, concurrent claims, semantic conflict, key substitution, simulated failure after LND creation but before response commit, persistent restart, strict HTTP, service ownership, both-direction composition, fixed deterministic invoice derivation, duplicate/lost-add recovery, unsafe LND states, provenance, and lifecycle shutdown.

This campaign is now part of the mandatory local qualification plan. It is local evidence, not independent operation, public-testnet proof, a deployed listener, a funded solver, or permission to open TreeSwap.

## Remaining gates

Before funded testnet use:

1. independently decode the returned BOLT 11 invoice and recheck network, checksum/signature, amount, payment hash/secret, payee, expiry, final CLTV, features, route hints, and hold-invoice kind;
2. prove payment-secret and requester/provider key rotation, retained-key recovery, volume-full rollback, encrypted backup/restore, and complete deletion behavior under two-person custody;
3. extend the real process campaign through timeout during LND work, an accepted HTLC, LND restart, and restored-host recovery;
4. deploy the private service and the public selected-solver listener with reviewed network policy, encrypted volumes, TLS identities, secrets, rate limits, monitoring, alerts, and log/tracing exclusions;
5. recover or safely burn in-flight coordinator reservations across restart without creating another invoice; and
6. obtain independent Lightning, protocol, application-security, privacy, and operations review.

## Primary references

- [LND AddHoldInvoice API](https://lightning.engineering/api-docs/api/lnd/invoices/add-hold-invoice/)
- [LND LookupInvoiceV2 API](https://lightning.engineering/api-docs/api/lnd/invoices/lookup-invoice-v2/)
- [LND REST missing-invoice status issue](https://github.com/lightningnetwork/lnd/issues/4135)
