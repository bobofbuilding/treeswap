# TreeSwap Lightning adapter boundary

Status: executable authorization and audit policy. No LND credentials are stored in this repository and no live or regtest adapter is deployed.

## Isolation

The adapter runs beside a dedicated solver LND node on a private network. The browser, public API, RFQ relay, and application database never receive a macaroon, TLS private key, node seed, invoice preimage store, or unrestricted LND endpoint. TLS verification and a pinned peer-certificate fingerprint are mandatory.

Use distinct positive macaroon root-key IDs and exact URI permissions for three processes:

- invoice: `AddHoldInvoice`, `SettleInvoice`, `CancelInvoice`, `SubscribeSingleInvoice`, and `LookupInvoice`;
- payer: `DecodePayReq`, `SendPaymentV2`, and `TrackPaymentV2`; and
- observer: `GetInfo`, `ListChannels`, and `PendingChannels`.

Never deploy an admin, default broad invoice, router, or read-only macaroon. LND supports baking URI-scoped macaroons, IP caveats, and revocation by deleting the dedicated root-key ID. Credential deletion without root-key revocation is not sufficient.

## Independent authorization

LND permissions are only the outer boundary. Before every RPC, `authorizeLightningRpc` independently requires:

1. an active, unexpired, non-browser credential for the exact service role and URI;
2. verified private-network TLS with the pinned certificate;
3. a healthy, chain-synced node and current capacity epoch;
4. an unused adapter request ID;
5. the accepted intent's exact digest, payment hash, invoice digest, and whole-satoshi amount;
6. per-payment, daily-value, and in-flight caps; and
7. for settlement, a 32-byte preimage whose SHA-256 is the bound payment hash.

The audit record contains hashes, integer amount, method, decision, and reason codes. It excludes macaroons, preimages, and complete invoice text.

## Rotation and incident response

Bake each role from a dedicated root key, record issuance and expiry, rotate before the configured maximum age, and revoke the old root-key ID after overlap testing. If a credential, TLS identity, adapter host, signer, or node may be compromised: halt new quotes, stop Lightning authorization, revoke the affected root key, rotate the TLS pin if needed, reconcile every in-flight hash, and do not reopen from the same process image.

## Deployment gate

Before testnet funding, implement these checks in a separate adapter process, prove the baked permission list with `ListPermissions`/`CheckMacaroonPermissions`, run negative RPC tests for every non-allowlisted method, and exercise rotation, revocation, restart, timeout, force-close, replay, and amount-limit failures on Bitcoin regtest.
