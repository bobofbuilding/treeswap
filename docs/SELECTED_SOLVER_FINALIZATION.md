# Selected-solver finalization

Status: exact client, provider request verification, signed response construction, same-process reservation consumer, stable retry identity, two-direction invoice binding, and second user authorization are implemented and tested locally. No `/v1/finalize` provider listener, browser route, production requester key, solver response cache, independent BOLT 11 decoder, or deployed solver exists. Funded operation remains closed.

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

## Retry and authorization

One prepared attempt retains one signed request packet. A transport loss or timeout is ambiguous, so the same in-memory attempt may resend only that byte-identical packet. Concurrent sends reject, and the first verified response is cached for exact local replay. A non-ambiguous invalid or unauthorized response makes the reservation's finalization terminal; the user must obtain fresh competition instead of asking the solver for changed terms.

This stable request ID is also the provider's required idempotency key. A solver implementation must durably claim the request ID and digest before creating a Lightning-to-BIT invoice, then durably store the exact signed response before returning it. An exact retry returns the same response; a different request under the same ID rejects. That provider-side durable claim/cache is specified here but is not yet implemented or deployed.

After the response passes transport and executable-quote validation, the reservation service returns the exact second EIP-712 prompt. It includes the final payment hash, invoice digest, amounts, beneficiary, selected solver, first authorization, executable-offer digest, durable execution binding, and expiry. The signature does not move assets immediately and is not a token allowance, but it is settlement authorization for those exact terms. A separate Lightning payment or onchain wallet action remains necessary.

The service retains the original module-private authorized result for the later settlement consumer. Its aggregate status contains no bearer token, invoice, address, signature, request ID, payment hash, or private failure reason and grants no network-listener, funding, signing, or settlement-dispatch authority.

## Remaining release gates

Before any funded testnet use:

1. implement a solver-owned `/v1/finalize` listener that durably claims the request before invoice creation and commits the exact signed response before returning it;
2. deploy the client and provider behind reviewed TLS, logging, tracing, secret-volume, backup, restart, and rate-limit controls;
3. use a separately scoped requester key, publish its allowlisted digest through reviewed deployment policy, and drill key rotation and revocation;
4. independently decode and validate every returned BOLT 11 invoice—network, checksum/signature, amount, payment hash/secret, payee, expiry, final CLTV, features, route hints, hold-invoice requirement, and replay state—before showing a pay action;
5. persist enough token/request commitment to recover or safely burn an in-flight reservation across coordinator restart without creating another invoice;
6. expose the second prompt through the strict private browser ceremony and retain wallet evidence for EOA plus an explicit ERC-1271 support decision;
7. run ambiguous-response, duplicate, conflicting-replay, timeout, shutdown, crash, database-full, cache-loss, key-rotation, stale-capability, malformed-invoice, and both-direction regtest drills; and
8. obtain independent protocol, Lightning, application-security, privacy, and operations review.

Until those gates pass, the implemented client and consumer are repository evidence only. They cannot fund a pool, open the bridge, pay an invoice, broadcast an EVM transaction, or settle a swap.
