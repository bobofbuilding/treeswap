# Authenticated wallet-session reader

Status: repository core only. TreeSwap now has a narrow, signed, read-only protocol that lets the Node wallet edge verify an existing Sites/D1 SIWE session without importing D1 into the coordinator process or sending the raw session cookie across a service boundary. No application route, listener, Worker binding, deployment secret, DNS name, or production process is added by this checkpoint. It does not authorize a wallet call, Lightning action, swap settlement, pool funding, or release activation. Funded operation remains closed.

## Boundary

The browser continues to send the exact `__Host-treeswap_session` cookie only to the same-origin wallet edge. The edge validates and hashes that cookie locally. It sends one signed request containing only the lowercase SHA-256 token hash, one random request ID, the observation time, and a five-second expiry to the fixed `/api/internal/wallet-session-read` path.

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

It accepts no cookie, browser origin, bearer authorization, redirect, alternate path, caller-selected SQL, or caller-selected database operation. Exactly one canonical mainnet row becomes a signed active attestation; no row becomes a signed inactive attestation. The response is bound to the exact signed request digest and expiry and never echoes the token hash. Duplicate rows, malformed rows, an unsafe lifetime, D1 failure, or clock rollback halt the provider and return the same identifier-free `503` rejection.

The reader uses one fixed default-port HTTPS origin, public-address DNS validation, address pinning through the connection, TLS hostname verification, the exact route, a five-second total deadline, bounded strict JSON, and no redirects. It makes one request and performs no automatic retry. It independently verifies the response key, signature, request ID, request digest, time window, wallet, chain, and session lifetime. Transport loss, a non-200 response, mutation, staleness, key substitution, malformed framing, clock rollback, or lifecycle failure permanently halts that reader instance.

The edge owns the reader through a module-private one-use lease. A signed inactive result is an ordinary authentication failure and maps to the existing generic `401`. A reader or provider integrity failure halts wallet admission and the outer perimeter maps it to the existing generic `503`. The result itself is provenance-bound and consumable once; copies and rebinding to another token hash or observation time fail.

## Key and privacy rules

The request-signing and response-signing Ed25519 keys must be different from each other and from both wallet-gateway keys. The request private key belongs only to the wallet-edge process. The response private key belongs only to the D1 provider. Neither private key belongs in browser code, D1, the coordinator database, build output, logs, traces, or qualification evidence.

The raw cookie never crosses the reader protocol and is not returned or placed in aggregate status. The request necessarily contains the D1 lookup hash, and an active response necessarily contains the authenticated wallet and session timestamps, so request and response bodies must be excluded from CDN logs, application logs, tracing, analytics, error reporting, caches, and retained traffic captures. Status contains only aggregate active, inactive, rejected, failure, pending, and in-flight counts.

A captured still-live signed read request can be replayed for at most its original five-second window. That replay performs the same read-only lookup and returns an attestation bound to the original request; it cannot select a quote, reserve inventory, construct an intent, dispatch a wallet, pay Lightning, or fund a pool. The provider deliberately keeps no replay ledger because adding a write to every authentication read would introduce a new availability and recovery authority. TLS, body-log suppression, short expiry, request binding, separate key custody, and the absence of any dispatch capability are the replay controls.

## Local evidence

The adversarial suite covers active and inactive sessions, exact D1 query/bind values, raw-cookie exclusion, one-use result provenance, signed read replay, cookie and framing rejection, response mutation, stale responses, clock rollback on both sides, malformed/duplicate/unreadable D1 state, fixed production factories, exclusive lifecycle ownership, aggregate-only status, and the response shape returned by the pinned HTTPS adapter. The complete two-direction RFQ-to-wallet flow now composes the SIWE edge through this reader instead of direct database injection.

This evidence is local. The provider factory is not imported by a live Sites route, and no route or D1 migration was deployed.

## Deployment gates

Before even a closed funded testnet may use this path:

1. add and independently review one server-only Sites route that constructs the provider from the existing authoritative D1 binding and exact environment-held keys;
2. prove the route is absent from browser bundles, accepts only the signed protocol, preserves exact framing through the CDN, and has request/response-body logging, caching, tracing, and analytics disabled;
3. deploy the wallet edge separately with pinned DNS/TLS, separate key custody, explicit rotation and overlap procedures, process supervision, latency/error/clock alerts, and the existing single-replica abuse-ledger and fence controls;
4. repeat active, inactive, forged, stale, rollback, D1 outage/latency, key-rotation, process-kill, and lost-response campaigns against a non-production D1 database and the deployed HTTPS path;
5. retain D1 access-policy, backup/restore, purge, and least-privilege evidence and obtain independent privacy, authentication, infrastructure, and operations review; and
6. keep release activation, wallet dispatch, Lightning dispatch, BIT/WBTC admission, and pool funding disabled until every separate production gate passes.

Executable Lightning/BIT pricing remains competing signed solver RFQs. `1 BIT = 100 sats` remains a non-binding reference. The absent BIT/WBTC pool contributes zero evidence and this reader does not change that policy.
