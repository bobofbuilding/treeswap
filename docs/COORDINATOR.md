# Durable coordinator boundary

Status: the atomic store, exact signed Lightning dispatcher, EVM claim outbox, restart recovery, read-only reconciliation, aggregate metrics, live Lightning lost-response campaign, and local execution-client claim/reorg campaign are implemented. The full solver daemon, production backup/restore drill, alert delivery, public-chain finality evidence, and independent review remain testnet gates.

## Separate trust domain

The coordinator is not part of the public web application and does not use its D1 account database. The local deployment model runs it in a dedicated read-only container with only:

- one Ed25519 coordinator private key;
- one file-backed SQLite database on its own volume; and
- network access to the isolated role-specific Lightning adapters and authenticated Ethereum RPC providers.

It receives no LND macaroon, node seed, web session secret, email record, user key, or solver-inventory withdrawal key. An optional claim-relayer key may spend only its own capped ETH gas because `claim` is permissionless and its beneficiary is already fixed onchain. The adapters receive only the coordinator public key and one role-specific macaroon. A production deployment must preserve these as distinct hosts, service identities, networks, secret scopes, and backup policies.

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

An `UNKNOWN` action blocks every later action and every terminal transition. The recovery call uses a fresh signed, read-only `TrackPaymentV2` or `LookupInvoiceV2` request. It compares the returned hash and amount to the durable action before recording the observation. LND REST stream error envelopes are parsed before result validation: a read-only gRPC `NotFound` becomes sanitized `NOT_FOUND`, while a send-stream error remains ambiguous. `NOT_FOUND` is not proof that a value-moving call was never accepted, so it intentionally leaves the action blocked.

### EVM claim outbox

`lib/evm-action-runner.mjs` accepts only an EIP-1559 call to the configured immutable escrow's exact `claim(bytes32,bytes32)` selector. It checks the reservation ID, `sha256(preimage)`, chain, sender, contract, pinned runtime-code hash, nonce, total gas-cost ceiling, fee fields, zero native value, and canonical calldata against the durable action before signing. Chain ID and runtime code are re-read before broadcast, and the code is re-read by canonical block hash during reconciliation. Only the transaction hash and a digest of the signed bytes are persisted; the preimage and signed raw transaction remain transient.

The transaction hash is bound before broadcast. An RPC acceptance, rejection, timeout, or lost response always leaves the action `UNKNOWN`. Recovery may reconstruct and rebroadcast only byte-identical signed transaction data with the same transaction hash; it cannot fee-bump, replace, change the nonce, or change calldata. Reconciliation validates the RPC transaction fields, canonical inclusion block, receipt status, exact escrow address, exact `Claimed` event, and the provider's `finalized` head. A pending or unfinalized transaction remains blocked. A reverted finalized transaction fails. A disappeared or changed observed inclusion, mutated RPC transaction, or success receipt without the exact event halts the settlement.

The full invoice or preimage is supplied only in memory for an exact dispatch. The database stores its commitment or the resulting proof digest, never the raw value. Metrics expose only aggregate state counts, including EVM outbox state, and the secret-free event view excludes settlement IDs, transaction hashes, payment hashes, addresses, invoices, preimages, and email.

## Evidence

Run:

```sh
npm run regtest:coordinator-smoke
```

The campaign creates a real 10,000-sat standard regtest invoice, pays it through the signed payer adapter, deliberately discards the successful adapter response, proves the database contains `UNKNOWN`, closes and reopens the store, and recovers `SUCCEEDED` through a new read-only tracking authorization. It requires dispatch count `1` and scans the database to prove the BOLT 11 string was not persisted. Its EVM reservation record is explicitly simulated; this campaign is Lightning/coordinator evidence, not cross-chain finality evidence.

Run the separate local execution-client campaign:

```sh
npm run test:coordinator-evm
```

It deploys a test-only claim surface to a fresh Anvil chain, binds and broadcasts one real signed EIP-1559 claim, proves RPC acceptance remains `UNKNOWN`, observes the canonical receipt as `INCLUDED`, reverts the chain snapshot, and proves the disappeared receipt becomes `REORGED` and halts the settlement. It scans the closed SQLite files to prove the raw preimage was not persisted. The deterministic evidence digest is `0x015f51463f43ae3896b54829f45f4ea47a5a3e02cc60f6b282352ea4ab9f4e32`. Anvil does not advance its `finalized` tag, so finalized-success behavior is covered by deterministic adversarial tests and still requires authenticated public-testnet evidence through independent providers.

## Remaining gate

Before funded testnet:

1. prove finalized EVM claim success, reorgs before and after authorization/claim, dropped transactions, nonce contention, RPC disagreement, and relayer-key rotation against controlled forks and public testnet;
2. implement the complete solver state machine and atomic persistent RFQ/admission counters;
3. run disk-full, abrupt-kill, WAL recovery, backup/restore, corruption, and coordinator-key rotation drills;
4. deploy structured metrics, alert routing, and automatic new-exposure halt while preserving exits;
5. operate against independent relays and at least two independently run testnet solvers; and
6. obtain independent persistence, concurrency, signer, privacy, and recovery review.
