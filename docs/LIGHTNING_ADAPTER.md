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
3. a healthy node whose chain and wallet are synced, whose best-header timestamp is inside configured past-age and future-skew limits, and whose observed height/header has not stopped progressing beyond the age ceiling, with at least one active channel, enough direction-specific local or remote liquidity, and the current capacity epoch;
4. an unused adapter request ID;
5. the accepted intent's exact digest, payment hash, invoice digest, and whole-satoshi amount;
6. per-payment, daily-value, and in-flight caps; and
7. for settlement, a 32-byte preimage whose SHA-256 is the bound payment hash.

Hold-invoice creation uses the all-zero digest only before an invoice exists. The adapter returns the SHA-256 digest of the exact generated BOLT 11 string, and every later decode, pay, lookup, settle, or cancel authorization binds that digest. Payment dispatch decodes the invoice again and checks the exact hash, whole-satoshi and millisatoshi values, expiry margin, and final CLTV. Settlement additionally requires an accepted exact-value HTLC outside the configured block-safety margin and the matching preimage.

The audit record contains hashes, integer amount, method, decision, and reason codes. It excludes macaroons, preimages, and complete invoice text. Dynamic invoice/hash URL segments are redacted from transport errors. LND REST stream error frames are parsed before result validation: all read-only failures are non-ambiguous and safe to retry because they cannot move value, missing payment tracking maps to `NOT_FOUND`, and transport or stream uncertainty on a value-moving action remains ambiguous. An append-only journal is synced before dispatch; request IDs and exposure payment hashes cannot be reused. A lost response is recorded as `unknown` and is never automatically resent. The durable coordinator now recovers payer actions through a fresh signed `TrackPaymentV2` snapshot and invoice actions through `LookupInvoiceV2`; only a method-compatible exact terminal observation clears `UNKNOWN`.

Chain freshness is also durable. Each role requires its own absolute `CHAIN_PROGRESS_PATH` on persistent storage with one adapter process writing it. The exact-schema mode-`0600` record is atomically replaced and both the file and parent directory are synced. A first observation never authorizes new exposure; a later higher LND block height with a new best-block hash is required. Restart preserves the last-advance clock, while a backward wall-clock observation, height regression, changed hash or header timestamp at the same height, or higher height with an unchanged hash latches a conflict until a genuinely higher block is observed. The v1 hashless record migrates into a closed v2 baseline. Missing or legacy state therefore closes new exposure until the chain advances instead of resetting a stale-node clock.

The `TrackPaymentV2` REST path encodes its 32-byte hash as padded URL-safe base64. The pinned grpc-gateway decoder requires valid Base64 padding, while the URL-safe alphabet keeps `/` and `+` out of the route segment. Standard base64 is retained only for protobuf JSON/query byte fields. Regression coverage includes hashes whose standard form contains reserved `/` and `+` characters.

## Regtest evidence

`npm run regtest:adapter-smoke` proves a signed 10,000-sat hold invoice can be created on Bob, paid from Alice, observed as `ACCEPTED`, settled with the matching preimage, and completed as `SUCCEEDED`. It then restarts the payer adapter and proves the same signed request remains rejected by the durable journal. The invoice adapter also rejects a correctly signed payer action, and the underlying macaroons reject representative non-role RPCs.

`npm run regtest:credential-smoke` proves each node/role credential has exactly its declared root-key ID, URI set, and one expiry caveat; every granted URI exists in the pinned LND registry; representative forbidden capability categories fail specifically for authorization; a two-second credential expires; and deleting a disposable credential's root-key ID revokes it without taking down the node.

`npm run regtest:credential-rotation-smoke` proves an exact replacement payer credential can overlap with the old credential, the old root key can then be revoked without interrupting the replacement adapter, and a fresh standard credential can be restored. Native LND and the isolated old adapter both reject after revocation. The campaign cleans up the replacement root and file, passes four consecutive runs, and emits no credential, invoice, preimage, or payment hash.

`npm run regtest:tls-rotation-smoke` rotates the real LND certificate and private key, not just the configured pin. LND must generate a different certificate while preserving its node identity and existing channel point. The old pinned adapter rejects an exact read-only request non-ambiguously, payment history proves zero dispatch, and explicit peer reconnection restores the channel. The campaign deliberately restores the old pair and proves the old pin recovers, rotates again, then requires a freshly exported certificate plus observed pin to restore adapter service. A recoverable backup is deleted only after success and an exit trap handles unexpected failure. Four consecutive campaigns pass.

`npm run regtest:invoice-fault-smoke` proves hold-invoice expiry and late-settle rejection, wrong-preimage rejection without state mutation, explicit cancellation, cancellation replay rejection, and accepted-invoice persistence across an LND restart. The original in-flight payer request completes only after the recovered invoice is settled; the campaign never issues a replacement payment.

`npm run regtest:policy-fault-smoke` proves excessive fee and per-payment requests never reach LND, saturates the node with two real held HTLCs and enforces the aggregate in-flight cap, rejects while the only channel is offline, recovers after the peer and channel return, and refuses to start a disposable adapter with a mismatched TLS pin. Each pre-dispatch rejection is followed by read-only `NOT_FOUND` tracking once the service is healthy.

`npm run regtest:directional-capacity-smoke` drains the live channel side below a 100,000-sat exposure and proves both payer outbound capacity and invoice inbound capacity fail closed before dispatch. It proves no payment or hold invoice was created, rebalances the channel, then requires the exact previously rejected payment and hold-invoice creation to recover. The payment executes once, the hold invoice is canceled, and the channel transfer is restored. Three consecutive warm-state runs pass.

`npm run regtest:daily-cap-smoke` fills separate 10,000-sat payer and invoice daily limits with real exposure, restarts each disposable adapter against its durable journal, and proves a fresh one-sat exposure is rejected before dispatch. The successful payment is rebalanced and the successful hold invoice is canceled. Journal tests prove value usage rolls over at the exact UTC boundary after restart while replay protection for every historical request ID and exposure hash remains permanent. Four consecutive live runs pass.

`npm run regtest:stateless-init-smoke` starts a payer adapter with fresh durable chain state and proves an exact signed payment is rejected without dispatch. It restarts against the same state and requires the same rejection. After one real higher regtest block, the exact exposure succeeds once, native history confirms one matching payment, and the channel is rebalanced. Four consecutive live campaigns pass.

`npm run regtest:production-duration-smoke` is the uncompressed 3,600-second counterpart to the fast stale-chain campaign. It requires a higher real block and successful baseline exposure, checks the exact unchanged LND and Bitcoin Core height/hash plus LND header timestamp and service health every 30 seconds, recreates the adapter halfway through, and finally requires deterministic no-progress rejection plus zero native dispatch. It uses a 7,200-second header-age ceiling only to isolate the production-length 3,600-second local-progress limit. Published commit `f474e9c577f9c4e70183275f693ce89216e24032` passed with 3,603 monotonic seconds, 119 continuous observations, restart persistence after 1,813 seconds, deterministic no-progress rejection, and zero target-payment dispatch.

`npm run regtest:stale-chain-smoke` proves the adapter does not trust LND's chain-sync boolean or timestamp age alone. The adapter requires `wallet_synced`, bounds past age and future skew, and tracks local time without height/header progress. After one read-only baseline and a deliberate no-block interval at a compressed threshold, it rejects an exact signed payment and proves through read-only tracking that no payment reached LND. This remains deterministic with a future-dated synthetic regtest header, while the normally configured pinned adapter remains healthy on the same node.

Production should independently set `MAX_CHAIN_HEADER_AGE_SECONDS` for reported past age, `MAX_CHAIN_NO_PROGRESS_SECONDS` for the reviewed local stagnation interval, and `MAX_CHAIN_HEADER_FUTURE_SECONDS` for a deliberately small fail-closed skew, recommended at no more than 300 seconds. Regtest uses 3,600 seconds for age and no progress and 7,200 seconds for future skew because rapid synthetic mining can create consensus-valid timestamps far ahead of wall time; those lab values are not production defaults.

`npm run regtest:unsynced-chain-smoke` pauses the real payer LND node while regtest advances 500 blocks, observes a genuine false chain- or wallet-sync signal during catch-up, rejects an exact signed payment, and proves zero dispatch after both sync signals and the active channel recover. It passes across three consecutive warm-state runs.

`npm run regtest:force-close-smoke` force-closes the payer's only channel, rejects new payment exposure while the close is pending, confirms the commitment, advances through the node-reported CSV maturity, confirms its sweep, and requires all pending-close state to clear. A fresh balanced channel is confirmed before read-only tracking proves zero dispatch and the recovered adapter decodes the same invoice. Three consecutive warm-state runs pass.

`npm run regtest:route-fault-smoke` pays a standard invoice from a synced third node with no channels. It requires one terminal `FAILED/NO_ROUTE` dispatch; read-only tracking may return the exact failed payment or non-ambiguous, hash-redacted `NOT_FOUND`, and neither result permits retry. The campaign then requires rejection of the exact authorization replay, rejection of a new authorization that reuses the payment hash, and exactly one matching LND payment record. It passes from empty regtest volumes and across five consecutive warm-state runs.

`npm run regtest:htlc-cutoff-smoke` rapidly advances a real accepted HTLC to TreeSwap's 24-block settlement reserve. The adapter rejects the correct preimage at the exact boundary, then cancellation releases the original payer. The reserve is deliberately six blocks earlier than the 18-block LND auto-cancel boundary observed with the pinned release.

`npm run regtest:coordinator-smoke` pays a real 10,000-sat standard invoice, deliberately loses the successful response, reopens the coordinator database in `UNKNOWN`, and recovers success through bounded fresh read-only tracking without a second dispatch. A transient `NOT_FOUND` stays unresolved and permits only another read. See [Durable coordinator boundary](./COORDINATOR.md).

`npm run regtest:coordinator-invoice-smoke` settles a real accepted 10,000-sat hold invoice, deliberately loses that successful response, reopens in `UNKNOWN`, and recovers `SETTLED` through a fresh preimage-free lookup. The database, WAL, and shared-memory files contain neither raw nor textual preimage bytes, and dispatch count remains one.

## Rotation and incident response

Bake each role from a dedicated root key, record issuance and expiry, rotate before the configured maximum age, and revoke the old root-key ID after overlap testing. If a credential, TLS identity, adapter host, signer, or node may be compromised: halt new quotes, stop Lightning authorization, revoke the affected root key, rotate the TLS pin if needed, reconcile every in-flight hash, and do not reopen from the same process image.

## Deployment gate

Before testnet funding, export a secret-free final-release evidence bundle and independently review the implementation and evidence. Durable stateless initialization, the full production-duration block delay, real TLS certificate/pin rotation with rollback, exact grant manifests, credential timeout, overlap rotation and old-root revocation, hold-invoice terminal faults, accepted-state LND restart, payer- and invoice-side lost-response recovery, rapid-block HTLC cutoff, genuine unsynced-node catch-up, full force-close recovery, compressed-threshold stale-header rejection, fee/amount/in-flight/daily caps, exact UTC rollover, live directional exhaustion/rebalancing, channel-offline recovery, and TLS-pin mismatch now pass locally.
