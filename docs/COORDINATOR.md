# Durable coordinator boundary

Status: the atomic store, exact signed Lightning dispatcher, restart recovery, read-only reconciliation, aggregate metrics, and a live lost-response regtest campaign are implemented. The full solver daemon, EVM transaction outbox, production backup/restore drill, alert delivery, and independent review remain testnet gates.

## Separate trust domain

The coordinator is not part of the public web application and does not use its D1 account database. The local deployment model runs it in a dedicated read-only container with only:

- one Ed25519 coordinator private key;
- one file-backed SQLite database on its own volume; and
- network access to the isolated role-specific Lightning adapters.

It receives no LND macaroon, node seed, web session secret, email record, wallet private key, or unrestricted RPC endpoint. The adapters receive only the corresponding public key and one role-specific macaroon. A production deployment must preserve these as distinct hosts, service identities, networks, secret scopes, and backup policies.

## Atomic record

`lib/coordinator-store.mjs` binds one private settlement identifier to all of the durable settlement commitments:

- a different unlinkable public pricing identifier;
- direction and nonce-authority digest;
- exact intent nonce and intent digest;
- globally unique payment hash;
- invoice digest and whole-satoshi amount;
- received-quote-set digest, selected-set digest, and selected offer;
- capacity epoch;
- exact EVM reservation transaction, block, and intent proof;
- one request ID, payload digest, and dispatch count for each value-moving action; and
- one mutually exclusive terminal result supported by a both-assets reconciliation proof.

Each transition and its secret-free event commit in one `BEGIN IMMEDIATE` transaction. Foreign keys, uniqueness constraints, strict tables, WAL journaling, `synchronous=FULL`, a five-second busy timeout, a mode-`0600` database, and a mode-`0700` parent directory are enforced. One process owns a solver database; multi-writer or multi-replica operation is not supported by this version.

The pinned runtime is Node `22.22.0`. Its built-in SQLite API remains experimental in that release even though the underlying database and the exact API surface used here are pinned. Before funded beta, either qualify that exact image through backup, restore, corruption, disk-full, power-loss, and version-upgrade drills or move the same schema and transaction tests to a stable reviewed driver.

## Dispatch and recovery

`lib/coordinator-action-runner.mjs` requires the transient operation to hash to the persisted payload commitment before it signs or contacts an adapter. The coordinator then changes `PENDING` to `DISPATCHING` durably before the external call. A request can be claimed once and its dispatch count can never exceed one.

| Observation | Durable result | Automatic retry |
| --- | --- | --- |
| Exact validated success proof | `CONFIRMED` | No |
| Coordinator-local rejection before dispatch | remains `PENDING` | No call occurred |
| Any adapter rejection, timeout, transport loss, replay conflict, or malformed success after durable dispatch | `UNKNOWN` | Never |
| Process restarts while `DISPATCHING` | `UNKNOWN` | Never |
| Read-only `IN_FLIGHT`, `OPEN`, `ACCEPTED`, or `NOT_FOUND` | remains `UNKNOWN` | Never |
| Exact `SUCCEEDED`, `SETTLED`, or method-compatible terminal proof | `CONFIRMED` | No |
| Impossible terminal observation | settlement `HALTED` | No |

An `UNKNOWN` action blocks every later action and every terminal transition. The recovery call uses a fresh signed, read-only `TrackPaymentV2` or `LookupInvoiceV2` request. It compares the returned hash and amount to the durable action before recording the observation. `NOT_FOUND` is not proof that a value-moving call was never accepted, so it intentionally leaves the action blocked.

The full invoice or preimage is supplied only in memory for an exact dispatch. The database stores its commitment or the resulting proof digest, never the raw value. Metrics expose only aggregate state counts, and the secret-free event view excludes settlement IDs, payment hashes, addresses, invoices, preimages, and email.

## Evidence

Run:

```sh
npm run regtest:coordinator-smoke
```

The campaign creates a real 10,000-sat standard regtest invoice, pays it through the signed payer adapter, deliberately discards the successful adapter response, proves the database contains `UNKNOWN`, closes and reopens the store, and recovers `SUCCEEDED` through a new read-only tracking authorization. It requires dispatch count `1` and scans the database to prove the BOLT 11 string was not persisted. Its EVM reservation record is explicitly simulated; this campaign is Lightning/coordinator evidence, not cross-chain finality evidence.

## Remaining gate

Before funded testnet:

1. connect the same outbox semantics to solver EVM claim transactions and canonical receipt/reorg reconciliation;
2. implement the complete solver state machine and atomic persistent RFQ/admission counters;
3. run disk-full, abrupt-kill, WAL recovery, backup/restore, corruption, and coordinator-key rotation drills;
4. deploy structured metrics, alert routing, and automatic new-exposure halt while preserving exits;
5. operate against independent relays and at least two independently run testnet solvers; and
6. obtain independent persistence, concurrency, privacy, and recovery review.
