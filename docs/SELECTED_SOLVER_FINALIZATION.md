# Selected-solver finalization

Status: the exact client, strict repository-only `/v1/finalize` handler, private durable claim/response journal, recovery-capable finalizer boundary, signed response construction, same-process reservation consumer, stable retry identity, two-direction invoice binding, independent bounded BOLT 11 decoder, strict browser finalization/authorization route, second user authorization, atomic authorization-to-settlement handoff, authenticated replay-safe solver contract-signing protocol, deterministic LND invoice-material core, and fail-closed coordinator restart policy are implemented and tested locally. The Lightning → BIT path is composed through a signed, TLS-pinned private invoice-material client/service with durable replay; BIT → Lightning provably bypasses it. No public solver listener, reviewed production requester key, deployed browser adapter, or independently operated solver exists. Funded operation remains closed.

## Purpose

Public RFQ paths see only unlinkable Lightning/BIT pricing fields. After the user selects and signs one blind quote, TreeSwap durably reserves that solver's exact capacity. Only then may the selected solver receive the private request and either:

- return the user's unchanged invoice for BIT → Lightning; or
- create one exact invoice for Lightning → BIT.

The future BIT/WBTC pool is not involved in this exchange. It can later contribute one request-bound price-risk signal before selection, but it cannot receive the private request, produce an invoice, settle the bridge, or replace solver competition.

## Authenticated wire boundary

`lib/selected-solver-finalization-transport.mjs` fixes the production request to the capability-bound canonical HTTPS origin at `POST /v1/finalize`. The shared endpoint transport resolves only public addresses, pins that address through TLS while preserving hostname verification and SNI, refuses redirects, and accepts only strict identity JSON with `Cache-Control: no-store` under one complete-body deadline.

The coordinator request is Ed25519-signed by a separate finalization-request key. It binds:

- one stable request ID derived from the capability, private disclosure, and requester key;
- the exact capability, capacity snapshot, endpoint key, solver, and direction;
- the complete private disclosure and its digest;
- the allowlisted requester public-key digest; and
- one lifetime of at most 30 seconds.

The solver must compare the requester-key digest with its deployment allowlist before doing any invoice or quote work. A self-presented key is not sufficient. The solver response is signed by the endpoint key already proven in the selected capability and binds the original request ID and digest, capability, solver, invoice, executable EIP-712 envelope, and response window.

The response invoice must hash to the executable offer's invoice digest. BIT → Lightning must reproduce the user's original invoice byte-canonically; Lightning → BIT must supply one non-empty solver invoice. The existing executable-quote verifier then rechecks the complete EIP-712 offer and refuses changes to solver, price, fee, amounts, capacity, endpoint key, settlement runtime, or expiry.

The reservation consumer then independently parses the raw invoice through `lib/bolt11.mjs`; it never accepts decoded fields from the solver, relay, LND response, browser, or caller. User invoices fail before disclosure. Solver invoices fail before the second prompt unless their signature recovers the capability-bound Lightning node and their exact amount, hash, digest, payment secret, expiry, final CLTV, features, route/fallback structure, singleton fields, and resource bounds pass the reviewed invoice policy. BOLT 11 carries no verifiable hold/standard creation flag, so TreeSwap accepts no such remote assertion. The reference solver separately proves its own local `AddHoldInvoice` path, while the cross-party safety condition remains conservative timing plus finalized EVM state before Lightning action.

## Retry and authorization

One prepared attempt retains one signed request packet. A transport loss or timeout is ambiguous, so the same in-memory attempt may resend only that byte-identical packet. Concurrent sends reject, and the first verified response is cached for exact local replay. A non-ambiguous invalid or unauthorized response makes the reservation's finalization terminal; the user must obtain fresh competition instead of asking the solver for changed terms.

This stable request ID is also the provider's idempotency key. `lib/selected-solver-finalization-provider.mjs` durably claims the exact request ID and digest in a private SQLite journal before calling the finalizer, and commits the exact signed response before returning it. An exact retry receives the stored response bytes; a different digest under the same stable ID rejects. `CLAIMED` and `READY` are the only durable states. The store uses full synchronous commits, WAL, a monotonic clock high-water mark, strict schema verification, mode-`0600` files, bounded live rows, short expiring recovery leases, and aggregate-only status.

If the process dies after an external invoice or quote record is created but before `READY` commits, the row remains `CLAIMED`. A retry during the current lease receives `425`; after lease expiry the provider invokes only the finalizer's separate `recover` method, never `finalize` again. A handler failure after claiming receives `503`. The client treats both states as ambiguous and can resend only the byte-identical request. The recovery adapter is required to look up or create one request-bound result idempotently in its own durable system—for Lightning → BIT, ultimately by a precommitted payment hash or equivalent LND lookup key. The repository finalizer wrapper establishes and tests this interface but does not prove that an actual LND deployment honors it.

The provider rejects malformed or cacheable HTTP, compression, wrong method/origin/path, stale authority, requester/endpoint substitution, clock rollback, copied store/finalizer provenance, response expiry, invoice/digest mismatch, and a changed BIT → Lightning invoice or payment hash. Local tests cover exact replay after restart, concurrent requests, a lost response, conflicting re-signing, interrupted finalization, recovery after lease expiry, and SIGKILL/WAL recovery. The handler exposes no listener and the store grants no funding, payment, EVM, or settlement authority. Because the exact response contains private invoice data, its volume and backups still require deployment encryption, access control, retention, and deletion policy.

For Lightning → BIT, the repository now composes the provider finalizer with the separate [selected-solver invoice-material service](./SELECTED_SOLVER_INVOICE_MATERIAL.md). The public-side finalizer loads the exact selected offer amount from the solver's private offer journal, sends only request commitments through the signed private client, and accepts only the verified response. The private service durably binds the request to one key version, derives one payment hash, and creates or recovers that exact hold invoice through a two-URI LND credential. The public provider never receives the LND client, macaroon, payment-secret key, or preimage. BIT → Lightning makes no private-service call and preserves the user's invoice.

After the response passes transport and executable-quote validation, the reservation service returns the exact second EIP-712 prompt. It includes the final payment hash, invoice digest, amounts, beneficiary, selected solver, first authorization, executable-offer digest, durable execution binding, and expiry. The signature does not move assets immediately and is not a token allowance, but it is settlement authorization for those exact terms. A separate Lightning payment or onchain wallet action remains necessary.

After verifying that signature, the service derives the settlement only from the original private RFQ, authenticated selection, firm offer, and verified finalization. The coordinator binds the second authorization and inserts the unique `INTENT_ACCEPTED` settlement in one transaction. Browser success is returned only after commit. A constraint, storage, validation, or commit failure rolls back both writes. The v2 acknowledgement binds the settlement ID and record digest while explicitly granting no EVM-reservation, Lightning-dispatch, settlement-dispatch, or funding authority. The durable row is re-read and compared with the original module-private provenance before later executable use. See [RFQ settlement handoff](./RFQ_SETTLEMENT_HANDOFF.md).

The service retains the original module-private authorized result for the later contract-intent consumer. Its aggregate status contains no bearer token, invoice, address, signature, request ID, payment hash, or private failure reason and grants no network-listener, funding, signing, EVM-reservation, Lightning-dispatch, or settlement-dispatch authority.

`lib/rfq-private-ceremony.mjs` now exposes that second stage only through exact credential-free browser POSTs. The execution route owns the original finalization lease, permits only `/v1/selection/finalize` and `/v1/selection/authorize`, applies the same strict origin, CORS, framing, UTF-8, body, concurrency, deadline, and no-store rules as the first ceremony, and never receives a wallet signer, solver key, LND credential, payment-secret key, or preimage. It hashes the reservation token for its in-memory pending index. If its HTTP deadline expires while the solver call is still running, the route returns generic `425`, prevents a second call for that token, and later serves the verified result. Provider ambiguity permits only the existing byte-identical signed attempt. Terminal errors stay generic. Shutdown refuses while an unresolved operation remains unless the shared deployment signal aborts; a late transport result is then rejected before it can bind the firm offer. Restart deliberately does not deserialize bearer or private-request authority: the old browser token cannot reach the solver.

`lib/rfq-finalization-restart-policy.mjs` now reconciles the remaining non-secret durable liability before a production process can finish startup. Unsettled reserved, finalized, and authorized offers wait until their exact signed expiry and then release both capacity resources neutrally, with no new provider, LND, invoice, or settlement call. Any offer referenced by a durable settlement is never released by restart, RFQ expiry, cancellation, or abandonment; it reports `settlement-recovery-required` until the settlement recovery path reconciles it. Inconsistent settlement ownership halts atomically, a persisted clock high-water mark rejects rollback across restarts, cleanup is bounded, and status remains identifier-free. See [RFQ finalization restart policy](./RFQ_FINALIZATION_RESTART_POLICY.md).

## Remaining release gates

Before any funded testnet use:

1. deploy the private client, service, public selected-solver finalization listener, and contract-signing route behind reviewed network policy, TLS, logging/tracing exclusions, encrypted secret volumes, backups, restart controls, and rate limits;
2. publish the separately scoped finalization, contract-signing requester/provider, and solver EVM key identities through reviewed deployment policy and drill rotation, revocation, retained payment-secret recovery, hardware-backed or equivalently reviewed signing, and two-person custody;
3. deploy the implemented raw BOLT 11 decoder in the same reviewed process boundary and prove through live standard/hold, malformed, stale, unknown-feature, oversized, and payee-substitution drills that no pay action or second authorization bypasses it;
4. deploy and independently review the implemented atomic settlement handoff and coordinator restart policy, prove startup-before-listener ordering and periodic bounded cleanup on the persistent volume, and retain disk-full/commit-failure plus real process-kill evidence that browser success never precedes durable settlement, browser authority stays burned, no provider/LND call repeats, expired unowned capacity releases, and settlement-owned liability remains in recovery;
5. deploy the implemented second-prompt browser route and retain wallet evidence for EOA plus an explicit ERC-1271 support decision;
6. run deployed ambiguous-response, timeout-during-LND, accepted-HTLC, LND/process/host restart, real-volume-full, backup/restore, cache-loss, key-rotation, stale-capability, malformed-invoice, and both-direction drills; and
7. obtain independent protocol, Lightning, application-security, privacy, and operations review.

Until those gates pass, the implemented clients and consumers are repository evidence only. They cannot fund a pool, open the bridge, pay an invoice, broadcast an EVM transaction, or settle a swap. The remaining consumer must strictly preflight and verify the user's wallet action, transaction and receipt, then confirm the exact escrow reservation through two finalized providers before constructing the direction-correct private packet and permitting any Lightning action.
