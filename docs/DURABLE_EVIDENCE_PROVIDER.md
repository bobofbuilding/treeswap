# Durable solver-evidence provider

Status: the repository supplies a fail-closed provider handler and a durable
SQLite request-replay ledger. It does not supply an HTTPS listener, evidence
data source, production key, persistent volume, operator, monitoring, or proof
of independence. Funded operation remains closed.

## Boundary

`lib/solver-daemon-evidence-provider.mjs` is the provider-side counterpart to
the [dual-route client](./SOLVER_DAEMON_EVIDENCE_CLIENT.md). Each of the two
required organizations must deploy its own instance, database volume, EIP-712
role signer, requester-key allowlist, TLS identity, and independently governed
evidence reader. The two routes must not share a database, signer, evidence
backend, administrator, or recovery process.

The module intentionally exposes a WHATWG `Request` handler rather than a
network server. Operator-owned code must terminate authenticated private HTTPS
on port 443, construct the native request without rewriting its target or body,
and pass it to the handler. Plain HTTP, another port, a path or query change,
compressed, cacheable, malformed, or oversized input rejects generically.
Snapshotting preserves prototype-named properties as ordinary own data, so an
extra `__proto__` field reaches exact-schema validation and rejects instead of
being silently reinterpreted as an object prototype.

The matching client-side route builder accepts only exact data records and
snapshots its request, policy, record, and approval once before replay
consumption. It validates and returns those same frozen snapshots. Property
getters are not invoked, and mutation by the caller while the replay claim is
being consumed cannot change the response that was already validated.

The provider has no pricing, quote-selection, inventory, Lightning payment,
EVM broadcast, release-gate, or funding authority. TreeSwap settlement remains
Lightning/BIT only. A future BIT/WBTC market may inform the separately reviewed
price policy but cannot enter this evidence path or authorize a swap.

## One-use flow

For every request, the handler performs this order:

1. sample the local wall clock and durably advance its monotonic high-water mark;
2. authenticate the exact Ed25519 request and pinned requester key ID;
3. match the release, evidence-policy, chain, escrow code, solver, and direction;
4. atomically insert `(requesterKeyId, requestId)` as `CLAIMED` in the private
   replay ledger;
5. call the provenance-bound reader through the request's abort signal;
6. accept only the four-field observation result and derive all authority fields
   from the signed request and pinned policy;
7. sign the derived EIP-712 record with the exact policy role;
8. re-sample and latch time across the read, signing, and consumption boundaries;
9. atomically change the claim to `CONSUMED`; and
10. return one bounded `no-store` response.

A duplicate or concurrent copy cannot reach the evidence reader. If the reader,
signer, clock, database, or response validation fails after the claim, the claim
stays unusable until its signed expiry. If the process stops after consumption
but before response delivery, the client receives no approval and retrying the
same request still fails. This sacrifices liveness to prevent double use.

The reader may discover the reservation for a `RESERVATION` request. For every
later evidence kind, it must return `reservation: null`; the handler retains the
reservation already bound by the request. The reader cannot choose the release,
solver, direction, settlement, intent, action, deadlines, terminal state, or
recipient. Both independent readers must nevertheless produce the same
canonical record or the client rejects both responses.

## Replay-ledger lifecycle

The database uses an exact strict schema, full synchronous writes, WAL on disk,
a bounded live-request count, integrity checks, a mode-`0600` regular file, and
a mode-`0700` parent directory. It stores only requester key ID, request ID,
expiry, state, claim/consume times, and the highest locally observed Unix second.
It never stores an evidence body, reservation or transaction commitment, intent,
proof digest, approval, or request signature. Aggregate status contains no
identifiers or timestamp.

Every handler phase and aggregate route-health check refuses a local time below
that durable high-water mark. Consequently, a forward clock jump may expire and
prune a request, but moving the host clock backward cannot make that request
apparently live again. A restart retains the same bound. This deliberately
sacrifices availability: clock correction after a forward jump requires operator
investigation and waiting until real time reaches the recorded mark; manually
lowering it is forbidden. The mark does not detect a restored or rolled-back
volume, so the loss procedure below still applies.

Initialization is an explicit one-time ceremony:

- Provision a new private volume and call `SolverDaemonEvidenceReplayStore.open`
  with `initialize: true` before the route accepts traffic.
- Schema v2 is intentionally not migrated from an earlier replay ledger. An
  older schema refuses startup. If its requester-key epoch was ever used, treat
  replacement as ledger loss and follow the rotation/wait procedure below.
- Every ordinary start and restart must use `initialize: false`. A missing,
  empty, permissive, symlinked, corrupted, altered, or unknown database refuses
  startup. `:memory:` plus `allowMemory: true` is test-only.
- Retain crash-consistent volume evidence and monitor the provider's aggregate
  status plus host clock/NTP rollback alerts. Do not copy or restore this
  database as an ordinary backup.

If the ledger is lost, replaced, or suspected of rollback, keep that route
offline. Revoke the old requester credential, rotate both the Ed25519 requester
key and its key ID, wait at least 60 seconds so every old 30-second request plus
maximum accepted skew is dead, initialize a new empty ledger, and re-run the
loss/replay drill before restoring service. Never restore a stale ledger under
the same requester key epoch. The other route cannot act as a fallback because
the client requires both approvals.

## Required deployment evidence

Before tiny public-testnet inventory, retain and independently review:

- two private HTTPS endpoints with pinned identity and standard certificate
  verification;
- two separate persistent volumes and successful restart, full-disk, loss,
  volume rollback, clock rollback after expiry/pruning, corruption, concurrent
  replay, and abrupt-stop drills;
- requester and EIP-712 signer provisioning, revocation, and rotation evidence;
- least-privilege, read-only evidence adapters and proof that the providers do
  not share one observation backend or administrator;
- bounded logs proving bodies and identifiers are excluded, plus delivered
  alerts for route, reader, database, clock, and process failure; and
- agreement and disagreement campaigns across reservation, Lightning dispatch,
  EVM claim, completed, and refunded evidence on the pinned BIT fork and
  Lightning regtest/public-testnet setup.

These controls close a repository implementation seam. They do not make an
operator independent, make an observation true, create the future BIT/WBTC
market, or authorize real funds.
