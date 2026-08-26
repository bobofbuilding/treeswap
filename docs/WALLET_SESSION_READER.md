# Authenticated wallet-session reader

Status: repository route, protocol core, and local adversarial evidence only. TreeSwap now has a narrow, signed, read-only protocol and one server-only Sites route that let the Node wallet edge verify an existing Sites/D1 SIWE session without importing D1 into the coordinator process or sending the raw session cookie across a service boundary. The route is hard-locked to `closed-test`, stays inert with an identifier-free `503` unless every required deployment value is present, and uses the existing `DB` binding without a schema change. No route key, live Sites version, wallet-edge listener, authenticated HTTPS composition, or production process is deployed by this checkpoint. It does not authorize a wallet call, Lightning action, swap settlement, pool funding, or release activation. Funded operation remains closed.

## Boundary

The browser continues to send the exact `__Host-treeswap_session` cookie only to the same-origin wallet edge. The edge validates and hashes that cookie locally. It sends one signed request containing only the lowercase SHA-256 token hash, one random request ID, the observation time, and a five-second expiry to the fixed `/api/internal/wallet-session-read` path. A non-secret requester-key identifier is repeated in a fixed request header so the route can select the current or retiring credential slot without parsing or copying the sensitive request body; the provider requires that header to equal the key identifier inside the signed body.

The provider owns the D1 binding and performs only this fixed query:

```sql
SELECT
  token_hash AS tokenHash,
  wallet_address AS walletAddress,
  chain_id AS chainId,
  created_at AS createdAt,
  expires_at AS expiresAt
FROM auth_sessions
WHERE token_hash = ? AND expires_at > ?
LIMIT 2
```

It accepts no cookie, browser origin, bearer authorization, redirect, alternate path, caller-selected SQL, or caller-selected database operation. Exactly one canonical mainnet row becomes a signed active attestation; no row becomes a signed inactive attestation. The response is bound to the exact signed request digest and expiry and never echoes the token hash. Duplicate rows, malformed rows, an unsafe lifetime, D1 failure, or clock rollback halt the provider and complete route instance and return the same identifier-free `503` rejection. Unknown or expired requester-key identifiers reject before D1.

The reader uses one fixed default-port HTTPS origin, public-address DNS validation, address pinning through the connection, TLS hostname verification, the exact route, a five-second total deadline, bounded strict JSON, and no redirects. It makes one request and performs no automatic retry. It independently verifies the response key, signature, request ID, request digest, time window, wallet, chain, and session lifetime. Transport loss, a non-200 response, mutation, staleness, key substitution, malformed framing, clock rollback, or lifecycle failure permanently halts that reader instance.

The edge owns the reader through a module-private one-use lease. A signed inactive result is an ordinary authentication failure and maps to the existing generic `401`. A reader or provider integrity failure halts wallet admission and the outer perimeter maps it to the existing generic `503`. The result itself is provenance-bound and consumable once; copies and rebinding to another token hash or observation time fail.

## Key and privacy rules

The request-signing and response-signing Ed25519 keys must be different from each other and from both wallet-gateway keys. The request private key belongs only to the wallet-edge process. The response private key belongs only to the D1 provider. Neither private key belongs in browser code, D1, the coordinator database, build output, logs, traces, or qualification evidence.

The route accepts one current credential pair and, only during rotation, one complete retiring pair. All four public-key identities must be distinct. The retiring slot has an absolute expiry no more than 900 seconds after route initialization; a request arriving at or after expiry rejects before D1, and a response whose D1 read crosses expiry is discarded instead of delivered. The intended order is provider deployment with new-current plus old-retiring keys, wallet-edge replacement with only the new pair, observation of zero old traffic, expiry, and provider replacement without the retiring pair. Missing, partial, overlong, reused, or dynamically reloaded rotation state fails closed. This bounded overlap is authentication availability only and grants no settlement or release authority.

The route's lifecycle, counters, and halt flag are isolate-local. A hosting restart can construct a fresh instance, and a version rollout can temporarily leave old instances reachable. The separately supervised single wallet-edge reader remains the durable fail-closed consumer: it performs no retry and permanently halts on one failed or unverifiable response. Before any funded release, the hosting provider must prove exact-version cutover and retirement, and an external monitor must close admission on route errors; this repository route is intentionally unable to enter a mode other than `closed-test` until that evidence and independent review exist.

The raw cookie never crosses the reader protocol and is not returned or placed in aggregate status. The request necessarily contains the D1 lookup hash, and an active response necessarily contains the authenticated wallet and session timestamps, so request and response bodies must be excluded from CDN logs, application logs, tracing, analytics, error reporting, caches, and retained traffic captures. Every repository response adds origin-cache, CDN-cache, surrogate-cache, indexing, framing, and content-sniffing prohibitions and strips cookies and server timing. These headers do not prove that the hosting control plane has disabled body logging. Status contains only aggregate active, inactive, rejected, failure, rotation-slot, and in-flight counts; it excludes wallets, hashes, request IDs, key IDs, deployment identity, and secret material.

A captured still-live signed read request can be replayed for at most its original five-second window. That replay performs the same read-only lookup and returns an attestation bound to the original request; it cannot select a quote, reserve inventory, construct an intent, dispatch a wallet, pay Lightning, or fund a pool. The provider deliberately keeps no replay ledger because adding a write to every authentication read would introduce a new availability and recovery authority. TLS, body-log suppression, short expiry, request binding, separate key custody, and the absence of any dispatch capability are the replay controls.

## Local evidence

The adversarial suite covers active and inactive sessions, exact D1 query/bind values, raw-cookie exclusion, one-use result provenance, signed read replay, cookie and framing rejection, response mutation, stale responses, clock rollback on the reader, provider, and route, malformed/duplicate/unreadable D1 state, unknown-key rejection before D1, bounded current/retiring credential overlap and expiry, partial or reused key rejection, storage-outage containment without application logging, fixed production factories, environment-only route construction, inert missing configuration, exclusive lifecycle ownership, aggregate-only status, cache/logging response headers, and the response shape returned by the pinned HTTPS adapter. The complete two-direction RFQ-to-wallet flow composes the SIWE edge through this reader instead of direct database injection.

The application route now imports the provider through `lib/contract-intent-wallet-session-route.mjs`, reads only the existing Sites `env.DB` binding and named secret-manager values, caches an initialization rejection for the isolate lifetime, and contains no request-body parser, logger, trace hook, `process.env` fallback, browser import, wallet call, Lightning call, or funding path. `.env.example` names the required values but contains no key material. This is still local evidence: no configured Sites route, secret, D1 migration, deployed overlap, traffic capture, or live provider/reader composition was created.

An independent-review boundary now reconstructs the exact published route scope and requires separate application-security and platform/data-isolation reviewers to sign one canonical, short-lived package with zero open repository findings. It rejects source drift, incomplete controls, shared reviewer authority, stale evidence, and signature substitution while keeping every deployment and funding authority false. This is review tooling, not a review: no external reviewer, report, signature, deployment setting, or live evidence is included. See [Wallet-session route independent review](./WALLET_SESSION_ROUTE_REVIEW.md).

## Deployment gates

Before even a closed funded testnet may use this path:

1. complete the [wallet-session route independent-review ceremony](./WALLET_SESSION_ROUTE_REVIEW.md) against the exact final commit on `origin/main`, with both external roles, zero open repository findings, and retained reports and independence evidence;
2. deploy it only to a private closed environment with generated four-way-separated keys, exact origin, owner-only access policy, no public bypass, and a non-production D1 copy; do not put key bytes in source, build output, D1, evidence, or command logs;
3. prove the route is absent from browser bundles, accepts only the signed protocol, preserves exact length and identity framing through the CDN, and has request/response-body logging, caching, tracing, analytics, traffic capture, and error-body retention disabled at every layer;
4. deploy the wallet edge separately with pinned DNS/TLS, separate key custody, the bounded overlap sequence above, process supervision, latency/error/clock alerts, and the existing single-replica abuse-ledger and fence controls;
5. repeat active, inactive, forged, stale, rollback, D1 outage/latency, current/retiring/expired-key rotation, process-kill, and lost-response campaigns against that non-production D1 database and deployed HTTPS path;
6. retain D1 access-policy, backup/restore, purge, and least-privilege evidence and obtain independent privacy, authentication, infrastructure, and operations review; and
7. keep release activation, wallet dispatch, Lightning dispatch, BIT/WBTC admission, and pool funding disabled until every separate production gate passes.

Executable Lightning/BIT pricing remains competing signed solver RFQs. `1 BIT = 100 sats` remains a non-binding reference. The absent BIT/WBTC pool contributes zero evidence and this reader does not change that policy.
