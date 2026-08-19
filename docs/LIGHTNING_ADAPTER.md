# TreeSwap Lightning adapter boundary

Status: executable invoice and payer adapters pass the isolated two-node regtest campaign. No production adapter is deployed and funded operation remains closed.

## Isolation

The adapter runs beside a dedicated solver LND node on a private network. The browser, public API, RFQ relay, and application database never receive a macaroon, TLS private key, node seed, invoice preimage store, or unrestricted LND endpoint. TLS verification and a pinned peer-certificate fingerprint are mandatory.

The pinned adapter image contains only Node.js and the adapter modules; it does not install the web application dependencies. It runs read-only, without Linux capabilities, with `no-new-privileges`, a small no-execute temporary filesystem, no host port, a dedicated journal volume, and exactly one role credential volume.

Use distinct positive macaroon root-key IDs, exact URI permissions, and bounded `time-before` caveats. The two value roles share only the read methods needed to fail closed on node and channel health:

- invoice: `GetInfo`, `ListChannels`, `PendingChannels`, `AddHoldInvoice`, `SettleInvoice`, `CancelInvoice`, and `LookupInvoiceV2`;
- payer: `GetInfo`, `ListChannels`, `PendingChannels`, `DecodePayReq`, `SendPaymentV2`, and `TrackPaymentV2`; and
- observer: `GetInfo`, `ListChannels`, `PendingChannels`, and `ChannelBalance`.

Never deploy an admin, default broad invoice, router, or read-only macaroon. LND supports baking URI-scoped macaroons, IP caveats, and revocation by deleting the dedicated root-key ID. Credential deletion without root-key revocation is not sufficient.

## Independent authorization

LND permissions are only the outer boundary. The coordinator signs an exact canonical authorization with an Ed25519 key kept outside the adapter. The adapter has only the corresponding public key and rejects a changed method, amount, payment hash, invoice digest, capacity epoch, operation, key ID, issuance time, expiry, or signature. An application therefore cannot make a mutation pass by supplying both sides of an intent comparison.

Before every RPC, `authorizeLightningRpc` independently requires:

1. an active, unexpired, non-browser credential for the exact service role and URI;
2. verified private-network TLS with the pinned certificate;
3. a healthy, chain-synced node, at least one active channel, enough direction-specific local or remote liquidity, and the current capacity epoch;
4. an unused adapter request ID;
5. the accepted intent's exact digest, payment hash, invoice digest, and whole-satoshi amount;
6. per-payment, daily-value, and in-flight caps; and
7. for settlement, a 32-byte preimage whose SHA-256 is the bound payment hash.

Hold-invoice creation uses the all-zero digest only before an invoice exists. The adapter returns the SHA-256 digest of the exact generated BOLT 11 string, and every later decode, pay, lookup, settle, or cancel authorization binds that digest. Payment dispatch decodes the invoice again and checks the exact hash, whole-satoshi and millisatoshi values, expiry margin, and final CLTV. Settlement additionally requires an accepted exact-value HTLC outside the configured block-safety margin and the matching preimage.

The audit record contains hashes, integer amount, method, decision, and reason codes. It excludes macaroons, preimages, and complete invoice text. An append-only journal is synced before dispatch; request IDs and exposure payment hashes cannot be reused. A lost response is recorded as `unknown` and is never automatically resent. The durable coordinator now recovers payer actions through a fresh signed `TrackPaymentV2` snapshot and invoice actions through `LookupInvoiceV2`; only a method-compatible exact terminal observation clears `UNKNOWN`.

## Regtest evidence

`npm run regtest:adapter-smoke` proves a signed 10,000-sat hold invoice can be created on Bob, paid from Alice, observed as `ACCEPTED`, settled with the matching preimage, and completed as `SUCCEEDED`. It then restarts the payer adapter and proves the same signed request remains rejected by the durable journal. The invoice adapter also rejects a correctly signed payer action, and the underlying macaroons reject representative non-role RPCs.

`npm run regtest:credential-smoke` proves each node/role credential has exactly its declared root-key ID, URI set, and one expiry caveat; every granted URI exists in the pinned LND registry; representative forbidden capability categories fail specifically for authorization; a two-second credential expires; and deleting a disposable credential's root-key ID revokes it without taking down the node.

`npm run regtest:coordinator-smoke` pays a real 10,000-sat standard invoice, deliberately loses the successful response, reopens the coordinator database in `UNKNOWN`, and recovers success through read-only tracking without a second dispatch. See [Durable coordinator boundary](./COORDINATOR.md).

## Rotation and incident response

Bake each role from a dedicated root key, record issuance and expiry, rotate before the configured maximum age, and revoke the old root-key ID after overlap testing. If a credential, TLS identity, adapter host, signer, or node may be compromised: halt new quotes, stop Lightning authorization, revoke the affected root key, rotate the TLS pin if needed, reconcile every in-flight hash, and do not reopen from the same process image.

## Deployment gate

Before testnet funding, add cancel, invoice expiry, late-settle, fee-limit, amount-limit, exhausted-liquidity, delayed/fast-block, force-close, TLS-pin, overlap-rotation, and invoice-side ambiguous-response campaigns; export a secret-free evidence bundle; and independently review the implementation and evidence. Exact grant manifests, credential timeout, and root-key revocation now pass locally.
