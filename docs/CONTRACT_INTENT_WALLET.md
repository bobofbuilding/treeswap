# Contract-intent wallet boundary

Status: a repository core prepares and reviews the exact user-wallet transaction for either TreeSwap escrow, records the wallet outcome without authorizing retry, verifies a reported or same-nonce replacement transaction, and classifies its receipt, reservation event, finality, mismatch, revert, disappearance, or reorg. A strict private SQLite journal durably claims the attempt and records each original core artifact. A fixed same-process dispatcher requires fresh explicit confirmation, the original preflight, an original journal claim, and an exact chain/account check before making one EIP-1193 request; every uncertain result becomes reconciliation-only work. A Node-only ownership boundary issues one opaque short-lived handle from the original preflight, binds it to the exact wallet and SIWE-session digest, consumes it before gateway staging, and exposes the private handoff once. A Node-only same-origin edge hashes the raw cookie locally and verifies the existing mainnet SIWE session through a separate signed, pinned-HTTPS, hash-only D1 reader/provider protocol; it derives rather than accepts the session digest, binds HMAC CSRF tokens to the handle or gateway claim, exclusively consumes a strict private restart-safe per-session abuse ledger, owns the reader and ownership service exclusively, and composes one claim plus exact outcome into the separate private gateway. The gateway issues one non-replayable claim only after the durable journal transition and records an exact wallet outcome idempotently. A browser-only adapter independently verifies the coordinator signature and expected contract intent, requires live user activation, atomically retains a digest-only cross-tab no-resend tombstone, calls the exact request once, and produces one bounded outcome report. This is local repository evidence, not a deployed D1 route, listener, browser UI, HTTPS service composition, or coordinator integration. It calls no Lightning node and its two-observation result does not prove independent provider operation or authorize funds. Funded operation remains closed.

## Pricing and settlement scope

The wallet boundary consumes the already authorized winning Lightning/BIT solver intent. Competing signed RFQs remain the only source of executable amounts and fees. `1 BIT = 100 sats` is a non-binding reference, not a wallet or contract invariant.

No BIT/WBTC pool exists, so it supplies no evidence. A future separately reviewed, mature, sufficiently liquid pool may supply at most one request-sized pre-selection risk signal. It cannot choose the solver, rewrite the signed intent, become this settlement transaction, satisfy price quorum alone, or restore fixed-par pricing.

## Exact preflight

`prepareContractIntentWalletPreflight` accepts only the original same-process authorized contract intent. It decodes and canonically re-encodes `TreeSwapBitVault.reserve` or `TreeSwapUserEscrow.open`, rechecks the calldata hash, quote ID, user, chain, target, runtime-code commitment, expiry, and zero ETH value, and produces one reviewable `eth_sendTransaction` request.

The function does not call `ethereum.request`. It neither connects an account nor switches a chain. The returned request and review carry `walletDispatchAuthority: false`, `lightningDispatchAuthority: false`, and `fundingAuthorization: false`.

Immediately before a future dispatcher may use that request, `verifyContractIntentWalletContext` requires the configured chain and the exact intent sender as the first active wallet account. A copied preflight has no provenance and rejects.

## Opaque session-bound ownership handle

`createContractIntentWalletOwnershipService` closes the gap between an original finalized preflight and the SIWE-session edge. It accepts only the original same-process preflight, requires the authenticated wallet to equal the transaction sender, binds a nonzero opaque session digest, and returns a random 256-bit handle that expires after at most 60 seconds. The browser-visible handle discloses no request digest, contract intent, quote, invoice, wallet, or session value and grants no wallet, Lightning, or funding authority.

Claiming requires the exact handle, wallet, and session. The service consumes the handle before staging the original preflight in the gateway, so simultaneous, later, substituted-wallet, or substituted-session claims fail. It then exposes one module-provenance-bound private handoff containing the original preflight and a request window of at most 30 seconds. A copy cannot be taken, and the original handoff cannot be taken twice. Handle state is memory-only; restart destroys every handle rather than reconstructing browser authority. An expired unclaimed handle never stages the gateway. A consumed handle remains terminal for that preflight until the preflight expires, including when gateway staging or the later private request fails.

The ownership service and gateway must be original factory products, share the exact deployment abort signal, match production/test mode, and have a one-to-one binding. Once the SIWE-session edge claims the ownership service, only its original module-private lease can issue, claim, or take a handle; direct use and a second edge fail closed. Aggregate status exposes counts only and explicitly omits handles, request and contract-intent digests, quote or invoice material, wallets, and session digests. Local both-direction tests cover copied provenance, wrong wallet/session, accessor input, simultaneous claim, duplicate take, expiry, restart, second-edge and direct-use rejection, status privacy, and durable-database exclusion of the handle.

The ownership service alone does not verify a cookie, derive the session digest, implement CSRF or rate limiting, prove browser intent, make a network request, or persist a handle. The edge core below supplies the repository-only session and browser-request boundary; deployment evidence remains open.

## Wallet outcome and retry rule

The response recorder admits exactly three outcomes:

- a lowercase transaction hash reported by the wallet;
- exact EIP-1193 user rejection code `4001`; or
- an ambiguous result with neither a hash nor a claimed error code.

It reads chain and accounts again after the wallet returns. If the chain changes, the wallet disconnects, or the post-request context cannot be read after returning a hash, the hash is retained under `SUBMISSION_REPORTED_CONTEXT_CHANGED`; `postContextUnavailable` distinguishes an unreadable post-context. It is never discarded. Every non-rejection requires independent reconciliation and every outcome has `retryAuthorized: false`; an unknown result cannot be converted into a second send.

## Transaction and replacement rule

The current v1 verifier accepts only a projected type-2 EIP-1559 transaction with canonical JSON-RPC quantities. Sender, destination, calldata, zero ETH value, chain, and reported hash must match the reviewed request exactly.

A replacement is accepted only when it has a different hash, the same nonce, and the same exact intent semantics. A cancellation, value transfer, other contract, other calldata, other chain, other sender, or different nonce rejects. Legacy/type-1 wallet transactions are deliberately outside v1 until their exact transport and replacement behavior is separately reviewed.

## Receipt and event rule

An observation validates the reviewed escrow runtime-code hash, receipt transaction identity, canonical inclusion block, receipt status, and the complete direction-specific `Reserved` or `Opened` event. The decoded quote ID, payment hash, user, solver, beneficiary, BIT amount, fee, Lightning amount, invoice digest, nonce, and all three deadlines must equal the authorized calldata.

The repository core classifies observations as:

- `NOT_FOUND` or `REORGED` when the transaction/receipt disappears;
- `REVERTED` for status zero;
- `MISMATCH` when the exact reservation event is absent or changed;
- `INCLUDED` before the provider's finalized head reaches inclusion; or
- `FINALIZED` when it does.

Two original observations must use distinct provider identities and agree on the exact transaction, receipt, inclusion block, finalized head, runtime-code hash, request, and contract-intent commitments. Even then the result is named `REPOSITORY_CORE_VERIFIED` and keeps `canonicalFinalizedReservation: false`: caller-supplied identity labels and projections do not prove that two independent providers were actually operated.

## Durable attempt journal

`ContractIntentWalletStore` is a Node-only, non-dispatching storage boundary. Before a future wallet dispatcher can be composed, it must durably claim the original preflight in this journal. That claim is an unresolved wallet attempt on every restart; serialization never restores same-process preflight provenance or permission to call the wallet.

The journal uses one exact strict SQLite schema, full synchronous writes, WAL, foreign keys, a monotonic high-water clock, bounded intent/artifact counts, canonical payloads, record digests, and owner-only regular files under an owner-only directory. It stores the exact chain, sender, escrow, calldata and digest, runtime-code commitment, quote commitments, expiry, wallet outcome, transaction/replacement chain, nonce, inclusion block, provider observations, and repository quorum. It stores no raw invoice, preimage, private key, provider URL, or wallet credential.

Only original same-process core artifacts can append. A copied object, second conflicting submission, invalid transition, future-dated observation, clock rollback, malformed path, permissive or symlinked database, changed schema, changed record, changed artifact, or inconsistent transition fails closed. Exact retries are idempotent.

Startup recovery returns one of four authority-free actions:

- `SEARCH_QUOTE_NO_RESEND` when the attempt was claimed or the wallet response was ambiguous;
- `RECONCILE_TRANSACTION_NO_RESEND` for a reported, pending, or temporarily missing transaction;
- `RECONCILE_RECEIPT_NO_LIGHTNING` after inclusion but before acceptable external finality; or
- `HALT_AND_RECONCILE_NO_RESEND` after revert, mismatch, or reorg.

A repository quorum returns `REQUIRE_DEPLOYED_FINALITY_PROOF_NO_LIGHTNING`. Every recovery has `retryAuthorized: false`; none authorizes wallet dispatch, Lightning, provider independence, canonical finality, or funding.

## Fixed one-shot dispatcher

`createContractIntentWalletDispatcher` fixes the system clock and a bounded wallet-response window. It accepts no connect or switch method. For one original preflight it performs this sequence:

1. present the exact frozen review and `eth_sendTransaction` request to the configured explicit-confirmation function;
2. durably create the journal claim;
3. read `eth_chainId` and `eth_accounts`, then verify the exact chain and first account;
4. consume the original same-process claim once immediately before dispatch;
5. call the wallet exactly once with the original frozen request;
6. classify exact code `4001`, a lowercase transaction hash, or every other result as ambiguous;
7. re-read context and durably record the original outcome before returning.

A timeout, malformed response, non-data or inherited rejection code, provider error, lost response, or unreadable post-context cannot trigger another send. If the journal fails after the request may have started, the dispatcher returns an explicit reconciliation-required error with any already-returned hash and `retryAuthorized: false`. If context fails after the claim but before the wallet request, restart still returns `SEARCH_QUOTE_NO_RESEND`. A declined confirmation creates no claim and contacts no provider. Concurrent or later use of the same claimed request cannot send again.

The production factory has no injected clock or timeout. A separately named test factory is the only path that accepts them. Local tests exercise both directions, exact request identity, rejection, response loss, post-hash disconnect, wrong chain, duplicate use, copied preflight, declined confirmation, and restart.

This module cannot prove that a callback represented a human gesture, prevent unrelated application code from directly calling an injected provider, or bridge the Node-only journal into a remote browser by itself. Those are deployment and architecture gates, not properties claimed by this checkpoint.

## Authenticated wallet gateway core

`createContractIntentWalletGateway` is a Node-only route core for the private hop between a SIWE-authenticated web edge and the persistent coordinator. It does not accept a SIWE cookie, bearer authorization header, browser `Origin`, wallet provider, or arbitrary callback. The edge and coordinator use separate Ed25519 request and response keys. The configured API origin must be private HTTPS on port 443, request bodies use exact bounded JSON and unambiguous framing, and all failures return the same identifier-free rejection.

The intended two-hop sequence is:

1. the web edge verifies the live SIWE session, exact wallet, CSRF/user gesture, and application rate limit, then atomically consumes the implemented opaque ownership handle for that wallet/session;
2. the ownership service stages only its original preflight and exposes one private handoff from which the edge signs a claim containing the preflight digest, wallet, opaque session digest, requester-key ID, and a window of at most 30 seconds;
3. the coordinator matches the claim to one original in-memory staged preflight and atomically writes `WALLET_REQUEST_CLAIMED` before returning anything;
4. the coordinator returns a separately signed response containing the exact request and review, a random 256-bit claim token, the dispatch expiry, and a bounded report deadline;
5. the edge verifies that response against the original locally built claim and preflight before relaying the exact material to the browser;
6. only the browser's separately implemented explicit-confirmation path may make one wallet request; and
7. the edge signs the observed before/after context and exact reported, rejected, or ambiguous result back to the private coordinator route.

The claim is deliberately not idempotent. Concurrent or later requests cannot receive a second claim token. If the first claim response is lost, the durable attempt remains claimed and startup recovery says `SEARCH_QUOTE_NO_RESEND`; neither the edge nor the coordinator may ask the wallet again. The claim token and session digest exist only in process memory and are never added to the wallet journal or aggregate status.

Outcome recording has the opposite retry rule: the exact same signed outcome request may be repeated and returns the exact cached signed response, while any competing outcome, token, session, wallet, preflight, requester key, or context rejects. The response verifier independently binds the coordinator signature to the original verified claim, expected preflight, token, session, chain/account context, transaction hash, and derived journal state. Restart destroys claim-token provenance, so a late outcome cannot be accepted after restart; the durable claim still forbids resend and must be reconciled independently.

Local adversarial tests cover both swap directions, ownership-handle expiry/substitution/concurrency/restart, simultaneous gateway claim requests, a lost claim response, restart between claim and outcome, exact outcome replay, conflicting outcomes, wrong key/session/token/origin/framing, stale and changed signatures, copied provenance, accessor and sparse-array inputs, response substitution, bounded responses, and raw-database exclusion of the ownership handle, claim token, and session digest.

This core intentionally has no listener, SIWE/session store, CSRF control, browser wallet provider, human-gesture proof, cross-process claim recovery, distributed lock, transaction broadcaster, Ethereum reader, Lightning credential, settlement authority, or funding authority. A deployment must keep the edge requester key out of the browser, keep the coordinator response key out of the edge, suppress request/response-body logging and tracing, bind one SIWE session to one wallet and preflight, demonstrate process-kill and volume-failure behavior, and remain single-replica until a separately reviewed shared fence exists.

## Same-origin SIWE-session edge core

`createContractIntentWalletSiweEdge` is a Node-only route core for the browser-facing hop. It accepts the exact `__Host-treeswap_session` cookie format already issued by TreeSwap and hashes it locally. The raw cookie never enters the reader request. An exclusively claimed `createContractIntentWalletSessionReader` sends only that hash in one signed five-second request over a fixed pinned-HTTPS path to a separately keyed provider that owns the D1 binding and exact read-only `auth_sessions` query. The provider returns a signed request-bound active or inactive attestation and never echoes the hash. Exactly one canonical active mainnet row is accepted; malformed or duplicate rows, D1 failure, protocol failure, key substitution, staleness, or clock rollback halt the session path. The raw cookie remains only in short-lived edge memory, where an HMAC derives the opaque session digest; the browser cannot supply the wallet or digest. See [Authenticated wallet-session reader](./WALLET_SESSION_READER.md).

The edge requires exact same-origin `POST` requests, an allowlisted canonical origin, `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: cors`, `Sec-Fetch-Dest: empty`, no `Sec-Fetch-User` or `Authorization`, `Cache-Control: no-store`, identity encoding, strict bounded JSON, unambiguous framing, a fixed five-second total body-read deadline with cancellation, and generic non-cacheable errors. Separate HMAC CSRF values bind the verified session to either the ownership handle or gateway claim and to the exact expiry. The mandatory private abuse ledger allows eight requests per verified session per 60 seconds, caps active rate windows at 128, retains a global clock high-water mark across restart, and halts the edge on rollback or storage failure. Active claim state remains memory-only and capped at 128.

Preparation is server-side only: `issue` receives the original preflight directly from trusted same-process composition, verifies the browser session metadata, and returns only the opaque ownership handle plus its CSRF value. Claim consumes that exact handle through the edge's exclusive ownership lease, builds one maximum-30-second signed private gateway request, invokes the original gateway core, independently verifies its signed response against the original preflight, and returns the exact claim with a separately bound outcome CSRF value. The browser's full bounded report must match that preflight, wallet, request digest, contract-intent digest, and all false authority flags. Exact outcome replay is idempotent; a conflicting outcome, session, token, wallet, expiry, or report is rejected. Claim failure or a lost claim response never authorizes a second claim or wallet send.

All ownership handles, CSRF values, raw session tokens, session digests, gateway claim tokens, and active outcome state remain memory-only and are explicitly absent from aggregate status and the wallet SQLite journal. The separate abuse ledger stores only a domain-separated one-way commitment to the session digest plus bounded time/count fields; it stores none of those values or any wallet, request, quote, or invoice. Reader/provider status is aggregate-only and contains no hash, wallet, key ID, request ID, or session time. Restart or lifecycle abort clears ephemeral state; the abuse count and clock high-water mark survive, and any durable gateway attempt remains no-resend reconciliation. Both-direction tests cover duplicate and wrong cookies, Origin/Fetch Metadata failures, wrong and overlong CSRF windows, wrong session, concurrent claim, exact and conflicting outcome replay, persistent per-session exhaustion, second-edge/direct ownership, reader or ledger rejection, status/database privacy, and clock rollback. Dedicated reader tests cover invalid chain/lifetime/timestamps, duplicate rows, raw-cookie exclusion, signed read replay, key/response mutation, strict HTTPS response shape, D1 failure, and provider/reader rollback.

The edge now grants one exclusive provenance-bound lease to the perimeter described below. Once claimed, a retained direct edge reference or a second perimeter cannot issue, claim, inspect, or stop the edge. The edge itself still creates no listener or application route. A separate server-only Sites route now wires the D1 provider to the existing `env.DB` binding in `closed-test` mode, with inert missing configuration, generic no-cache responses, route-wide halt on D1 or clock failure, and one bounded current/retiring credential overlap. It is not configured or deployed in this checkpoint, and the current test composition still calls the provider and private gateway cores in process rather than proving either deployed authenticated HTTPS hop.

## Durable authenticated-session abuse ledger

`ContractIntentWalletAbuseStore` is a separate strict SQLite boundary required by every SIWE edge. It fixes eight accepted requests per session per 60 seconds and at most 128 active windows. One `BEGIN IMMEDIATE` transaction verifies and advances a global durable clock high-water mark, prunes expired windows, and inserts or conditionally advances the exact session window. The ninth request is a durable rejection; process restart cannot reset it. A backward clock, schema or policy change, storage error, copied store, second edge, or lifecycle substitution halts the wallet path. The edge owns one exclusive lease, while retained direct access fails.

The ledger key is a domain-separated SHA-256 commitment to the pseudorandom session digest. Its strict table contains only that commitment, window start, request count, session expiry, and last-seen time. Raw tokens, server token hashes, session digests, wallets, handles, CSRF values, claims, request bodies, quotes, and invoices are absent. Persistent startup requires a canonical private mode-`0600` file under a mode-`0700` directory, explicit one-time initialization, exact policy metadata, full synchronous writes, and a successful integrity/layout check. See [Durable wallet-intent abuse ledger](./DURABLE_WALLET_ABUSE_STORE.md).

This closes the restart-reset gap for the conservative single-replica deployment. A repository-local volume campaign now verifies a private full-integrity backup, fresh-path restore with the exact rate state, a real `SIGKILL` with the crash fence retained, and fail-closed rollback on an actual full tmpfs. It is not a distributed rate limiter or fence. The deployed ledger still needs a persistent owner-controlled volume, witnessed execution of those procedures on that volume, capacity and halt alerts, retention/access review, and independent review. See [Wallet-edge volume recovery evidence](./WALLET_EDGE_VOLUME_RECOVERY.md).

## Pre-session perimeter and single-replica fence

`createContractIntentWalletEdgePerimeter` is the required outer route core. Before any session query it requires an exact positive `Content-Length` no larger than 64 KiB, a body, at most 32 headers and 8 KiB of header data, identity encoding, and no authorization, proxy authorization, transfer encoding, upgrade, or `Expect`. It cancels rejected bodies, allows at most 16 concurrent requests and 32 total requests per one-second global window, checks the replica fence before every admitted request, validates the bounded no-store edge response, and halts the edge on clock rollback, fence loss, or an invalid internal response. Its aggregate status contains no cookie, handle, CSRF, claim, wallet, request, quote, invoice, path, or fence-owner token. The module has no request/body logger or tracing hook.

`acquireContractIntentWalletEdgeReplicaFence` creates one private exclusive directory and owner record under a canonical owner-controlled mode-`0700` runtime directory. A second process cannot start while that directory exists. There is deliberately no age-based or automatic stale takeover: a crash leaves the fence closed until an operator independently proves the old replica is dead and removes or reconciles the retained fence. Every admitted request revalidates the original private owner record; replacement or mutation halts the edge before D1. Graceful shutdown may release the exact original fence. Tests cover second-replica refusal, explicit release/reacquisition, fence mutation, exclusive perimeter ownership, pre-D1 body rejection and cancellation, two-request concurrency exhaustion, the global rate ceiling, clock rollback, status privacy, and both swap directions.

This is a conservative single-replica control, not a distributed consensus fence. Deployment must mount the runtime and abuse-ledger directories from owner-controlled persistent storage with the required POSIX semantics, forbid automated stale-lock deletion, and alert for retained crash fences or a halted/full abuse ledger. Separate hosts, independent volumes, serverless replicas, or automatic failover remain unsupported until a separately reviewed distributed fence and distributed abuse policy exist. Because the wallet edge still has no listener or trustworthy client-IP before the session read, the deployed CDN/listener must add its own coarser unauthenticated connection and request controls outside that process. Deployment must complete the two-role [wallet-session route review](./WALLET_SESSION_ROUTE_REVIEW.md) on the exact final source, privately deploy the implemented D1 route, suppress request/response bodies and token material across proxies, tracing, analytics, traffic capture, and error reporting, keep the two session-reader keys separate from both wallet-gateway keys, follow the maximum-900-second current/retiring overlap sequence, and repeat the implemented process-kill, disk-full, backup/restore and crash-fence campaigns on the real volume together with D1 outage, key-rotation, reload, and multi-tab evidence.

## Browser claim and one-shot wallet adapter

`lib/contract-intent-wallet-browser.mjs` is the browser half of the gateway protocol. It imports the pinned coordinator Ed25519 SPKI public key through Web Crypto, reproduces the gateway response digest, verifies the signature, and compares the signed request against the browser's already displayed request digest, contract-intent digest, wallet, chain, escrow, quote, calldata digest, and expiry. A second verification of the same claim in one page rejects. The response key is public; neither the edge requester key nor any wallet credential enters the browser.

Before any provider read, the production adapter requires both the exact confirmed request digest and `navigator.userActivation.isActive`. It then acquires one named Web Lock and updates one bounded `localStorage` record before touching EIP-1193. That record retains only a domain-separated claim digest, expiry, and monotonic clock high-water mark—never the claim token, wallet, session digest, transaction, or invoice. Malformed storage, clock rollback, a duplicate, lock/storage unavailability, or inability to reread the exact write rejects before the provider. The active interaction is checked again after the durable write. The adapter never requests accounts, connects, changes chain, or retries; it only reads `eth_chainId` and `eth_accounts`, calls the exact signed `eth_sendTransaction` request once, rereads context, and returns reported, exact `4001` rejection, or ambiguous outcome material for the SIWE edge to sign.

The tombstone makes reload and simultaneous-tab mistakes substantially safer but is not custody or proof of informed consent. A user or compromised application can clear origin storage, invoke code during an unrelated click, bypass the adapter, or retain sensitive page memory. Therefore the deployed application must never persist the signed claim response, must exclude it from logs, history state, service-worker caches, analytics, and error reporting, must make this adapter the only provider-call module under a reviewed CSP/build, and must display the complete immutable review immediately beside the final button. Missing Web Locks or durable storage is unsupported and fails closed. Onchain one-use payment hash and nonce enforcement remains the final duplicate-execution backstop.

## Remaining release gates

This checkpoint intentionally leaves the production checklist open. Before either asset can move, TreeSwap still needs:

1. deploy the implemented ownership service, same-origin SIWE-session edge, signed hash-only D1 reader/provider, private durable abuse ledger, exclusive pre-session perimeter, conservative single-replica fence, and private gateway with the authoritative session store, a reviewed server-only session route and outer CDN/listener, and both authenticated HTTPS compositions; retain four-way separate key custody and no handle/session/claim/body logs, use owner-controlled persistent storage for the abuse ledger and one shared POSIX fence volume with no automatic stale takeover, compose the implemented browser adapter as the only provider path under reviewed CSP/build controls, repeat the repository D1-fault, `SIGKILL`, disk-full, backup/restore and retained-fence campaigns on the deployed paths and volumes, and prove that a process, network, key rotation, reload, multi-tab retry, or edge restart cannot reset the rate limit or become another wallet request;
2. composition of the wallet-attempt journal into the persistent coordinator plus its own process-kill, disk-full, backup/restore, and multi-replica conflict drills;
3. fixed authenticated Ethereum clients that project raw responses into this core, prove two genuinely independent providers, and bind the finalized reservation to the durable coordinator settlement;
4. deployed testnet evidence for both directions and common wallet types, including rejection, disconnect, dropped response, speed-up, cancellation, nonce contention, revert, provider disagreement/outage, and reorg before and after finality;
5. independent contract, wallet, coordinator, and operations review.

EIP-1271 user accounts remain excluded from this v1 wallet path. Supporting them requires a separately reviewed onchain signature-verification and deployed-wallet compatibility path.
