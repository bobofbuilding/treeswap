# Durable coordinator boundary

Status: the atomic settlement and RFQ/admission store, short-lived solver capability verifier, authenticated solver endpoint protocol, concrete capacity-reader protocols, exact signed Lightning dispatcher, EVM claim outbox, restart recovery, verified backup/fresh-path restore, startup integrity refusal, aggregate metrics, live Lightning lost-response campaigns, and local execution-client claim/reorg campaigns are implemented. Both actual direction-specific escrows now pass block replacement before authorization, after authorization, and after claim. The full solver daemon, independently operated endpoint/reader deployments, deployed-volume backup/restore and retention drill, alert delivery, live BIT/public-chain finality evidence, and independent review remain testnet gates.

## Separate trust domain

The coordinator is not part of the public web application and does not use its D1 account database. The local deployment model runs it in a dedicated read-only container with only:

- one Ed25519 coordinator private key;
- one file-backed SQLite database on its own volume; and
- network access to the isolated role-specific Lightning adapters and authenticated Ethereum RPC providers.

It receives no LND macaroon, node seed, web session secret, email record, user private key, or solver-inventory withdrawal key. An authenticated public identity is compared to its RFQ only in memory; the database retains an opaque identity commitment and a binding digest, never the raw wallet identity. An optional claim-relayer key may spend only its own capped ETH gas because `claim` is permissionless and its beneficiary is already fixed onchain. The adapters receive only the coordinator public key and one role-specific macaroon. A production deployment must preserve these as distinct hosts, service identities, networks, secret scopes, and backup policies.

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
- one request ID, payload digest, and dispatch count for each value-moving action;
- an EVM claim's chain, sender, contract, nonce, transaction hash, signed-byte digest, broadcast count, and one observed inclusion; and
- one mutually exclusive terminal result supported by a both-assets reconciliation proof.

Schema v4 also persists RFQ/admission state in the same transaction boundary:

- an opaque authenticated identity commitment and permanent cancellation sequence;
- exact request ID, direction, notional, nonce, expiry, and lifecycle state;
- rolling accepted-request and cancellation events;
- a verified solver capability digest and expiry, monotonic capacity epoch, fresh available capacity, committed capacity, and conflict latch;
- one exact firm offer per solver/request, with expiry and mutually exclusive outcome; and
- successful fills, attributable failures, consecutive-failure suspension, and aggregate-only metrics.

Admission first expires stale requests and releases their exact commitments, then evaluates persisted usage inside `BEGIN IMMEDIATE`. A duplicate request or offer ID is idempotent only for the same committed terms. Cancellation sequences only advance. Two local database connections cannot exceed the active-request limit or reserve the same solver capacity concurrently. A filled offer exercises its RFQ and releases every competing commitment in the same transaction; user abandonment and expiry release capacity without harming solver reliability.

Each transition and its secret-free event commit in one `BEGIN IMMEDIATE` transaction. Foreign keys, uniqueness constraints, strict tables, WAL journaling, `synchronous=FULL`, a five-second busy timeout, a mode-`0600` database, and a mode-`0700` parent directory are enforced. Startup runs a fail-closed quick integrity and foreign-key check before accepting work, refuses an unknown schema before adding or migrating tables, and exposes a full integrity check for backup and recovery workflows. SQLite serializes independently opened local connections, and adversarial tests cover competing admission and capacity reservations. Multi-host or multi-replica operation is not supported by this version.

The pinned runtime is Node `22.22.0`. Its built-in SQLite API remains experimental in that release even though the underlying database and the exact API surface used here are pinned. TreeSwap uses Node's SQLite online-backup wrapper rather than copying a live database/WAL pair. A backup is written to a private temporary file, fully integrity- and foreign-key-checked, synced, copied without overwrite, mode-locked to `0600`, and synced with its directory. Restore verifies the source and writes only to a new path; it never replaces a live database. The exact pinned image now passes local schema-v4 parity, v2 migration, fail-closed v3 capability migration, verified backup/restore, corruption refusal, SIGKILL/WAL recovery, and bounded-filesystem `SQLITE_FULL` rollback. Real volume failure, host power loss, off-site retention, restore objectives, and a reviewed stable driver remain production operations gates. See the [Node 22 SQLite API](https://nodejs.org/download/release/v22.18.0/docs/api/sqlite.html) and [SQLite online backup API](https://www.sqlite.org/backup.html).

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

An `UNKNOWN` action blocks every later action and every terminal transition. The recovery call uses a fresh signed, read-only `TrackPaymentV2` or `LookupInvoiceV2` request. It compares the returned hash and amount to the durable action before recording the observation. LND REST stream error envelopes are parsed before result validation: a read-only gRPC `NotFound` becomes sanitized `NOT_FOUND`, while a send-stream error remains ambiguous. `NOT_FOUND` is not proof that a value-moving call was never accepted, so it intentionally leaves the action blocked.

### EVM claim outbox

`lib/evm-action-runner.mjs` accepts only an EIP-1559 call to the configured immutable escrow's exact `claim(bytes32,bytes32)` selector. It checks the reservation ID, `sha256(preimage)`, chain, sender, contract, pinned runtime-code hash, nonce, total gas-cost ceiling, fee fields, zero native value, and canonical calldata against the durable action before signing. Chain ID and runtime code are re-read before broadcast, and the code is re-read by canonical block hash during reconciliation. Only the transaction hash and a digest of the signed bytes are persisted; the preimage and signed raw transaction remain transient.

The transaction hash is bound before broadcast. An RPC acceptance, rejection, timeout, or lost response always leaves the action `UNKNOWN`. Recovery may reconstruct and rebroadcast only byte-identical signed transaction data with the same transaction hash; it cannot fee-bump, replace, change the nonce, or change calldata. Reconciliation validates the RPC transaction fields, canonical inclusion block, receipt status, exact escrow address, exact `Claimed` event, and the provider's `finalized` head. A pending or unfinalized transaction remains blocked. A reverted finalized transaction fails. A disappeared or changed observed inclusion, mutated RPC transaction, or success receipt without the exact event halts the settlement.

The full invoice or preimage is supplied only in memory for an exact dispatch. The database stores its commitment or the resulting proof digest, never the raw value. Metrics expose only aggregate state counts, including EVM outbox state, and the secret-free event view excludes settlement IDs, transaction hashes, payment hashes, addresses, invoices, preimages, and email.

## Evidence

Run:

```sh
npm run regtest:coordinator-smoke
npm run regtest:coordinator-invoice-smoke
npm run test:coordinator-runtime
```

The payer campaign creates a real 10,000-sat standard regtest invoice, pays it through the signed payer adapter, deliberately discards the successful adapter response, proves the database contains `UNKNOWN`, closes and reopens the store, and recovers `SUCCEEDED` through a new read-only tracking authorization. It requires dispatch count `1` and scans the database to prove the BOLT 11 string was not persisted. Its deterministic evidence digest is `0x795152765a0312b638f56c6102f86dee26a27a5845d42a0e506d5ba70670dcf4`.

The invoice campaign accepts a real 10,000-sat hold payment, settles it through the invoice adapter, deliberately discards the successful response, reopens in `UNKNOWN`, and recovers `SETTLED` through a fresh `LookupInvoiceV2` authorization that contains no preimage. It requires dispatch count `1`, scans the SQLite database, WAL, and shared-memory files for both raw and textual preimage bytes, and requires none. Its deterministic evidence digest is `0xbedd1c725f66526954e2143f7a78cfed108f220daa2ade3b9a9441b75425e37d`.

Both campaigns use a simulated finalized-reservation record, so they are Lightning/coordinator evidence—not cross-chain finality evidence.

`tests/admission-store.test.mjs` proves rolling quotas and cancellation sequences survive restart, backward time fails closed, stale or conflicting capacity epochs reject, capability and quote expiry reject, fills and competing-offer release are atomic, attributable failures suspend while user abandonment does not, v2 migrates forward, v3 capability records migrate expired, raw user identity is absent from SQLite files, and independent local connections cannot oversubscribe an identity or solver. `tests/solver-capability.test.mjs` additionally proves exact EVM/LND/endpoint identity binding, cross-direction replay rejection, independent capacity observations, safe epoch bounds, expiry persistence, and fail-closed malformed inputs. `tests/solver-endpoint-transport.test.mjs` proves fresh challenge/response authentication, identity/origin pinning, response-mutation rejection before external reads, hard deadlines, size bounds, and public-only DNS/IP pinning with TLS hostname preservation. Published checkpoint `f474e9c577f9c4e70183275f693ce89216e24032` passed all 25 local qualification campaigns from `2026-08-20T00:43:19.448Z` through `2026-08-20T01:49:47.891Z`, independently rebuilt to evidence digest `sha256:55170d90bb3509ca5c0f133327290863d158f2cfa6e0401178a7b8ce3d523b3a`, and passed [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32318279120). The hosted coordinator job passed all 36 admission, recovery, capability, and endpoint-transport tests inside the pinned runtime.

Published recovery checkpoint `dbc9f1daa205549a0af559bc024c40b347ca8ecd` directly runs the admission and coordinator suites inside the immutable Node `22.22.0-alpine` coordinator image. It proves a committed WAL transaction survives SIGKILL, the concurrent uncommitted transaction disappears, corrupted and unknown-schema databases refuse startup, a live verified backup restores identical commitments only to a fresh path, and a real 512 KiB filesystem exhaustion rolls back the failing transaction and restarts with full integrity. All 18 pinned-image persistence tests, the separate disk-full process, 165 application/security tests, both builds, 68 contract tests, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32311057995) passed. This is local single-host recovery evidence—not deployed-volume, host-power-loss, multi-replica, retention, or operator evidence.

Run the separate local execution-client campaign:

```sh
npm run test:coordinator-evm
```

It deploys a test-only claim surface to a fresh Anvil chain, binds and broadcasts one real signed EIP-1559 claim, proves RPC acceptance remains `UNKNOWN`, observes the canonical receipt as `INCLUDED`, reverts the chain snapshot, and proves the disappeared receipt becomes `REORGED` and halts the settlement. It scans the closed SQLite files to prove the raw preimage was not persisted. The deterministic evidence digest is `0x015f51463f43ae3896b54829f45f4ea47a5a3e02cc60f6b282352ea4ab9f4e32`. Anvil does not advance its `finalized` tag, so finalized-success behavior is covered by deterministic adversarial tests and still requires authenticated public-testnet evidence through independent providers.

## Remaining gate

Before funded testnet:

1. prove finalized EVM claim success, reorgs before and after authorization/claim, dropped transactions, nonce contention, RPC disagreement, and relayer-key rotation against controlled forks and public testnet;
2. deploy the implemented capability, endpoint, and reader protocols with independent operators, connect the complete solver state machine to the ledger, then qualify it on the deployed stable persistence service;
3. repeat storage exhaustion, abrupt-kill/WAL recovery, corruption, and backup/restore against the deployed persistent volume; add encrypted off-site retention, measured recovery objectives, host-power-loss and coordinator-key-rotation drills;
4. deploy structured metrics, alert routing, and automatic new-exposure halt while preserving exits;
5. operate against independent relays and at least two independently run testnet solvers; and
6. obtain independent persistence, concurrency, signer, privacy, and recovery review.
