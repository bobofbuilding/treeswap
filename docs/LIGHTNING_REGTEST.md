# Lightning regtest lab

Status: reproducible two-node lab, bounded credential lifecycle, hold-invoice lifecycle faults, isolated signed-adapter smoke, and durable lost-response coordinator recovery pass locally. The full chain/channel failure-injection matrix remains.

The lab uses immutable multi-architecture image digests for:

- Bitcoin Core `v31.1`;
- LND `v0.21.2-beta`; and
- two isolated LND nodes connected by a private 1,000,000-sat channel with balanced directional liquidity.

The Docker network is internal and publishes no host ports. Runtime RPC and wallet passwords are generated locally with restrictive permissions under ignored `.state` storage. They are regtest-only and must never be reused.

## Commands

```sh
npm run regtest:up
npm run regtest:smoke
npm run regtest:adapter-smoke
npm run regtest:credential-smoke
npm run regtest:invoice-fault-smoke
npm run regtest:coordinator-smoke
npm run regtest:status
npm run regtest:down
```

`regtest:up` initializes both wallets without printing their test seeds, mines spendable regtest funds, opens and confirms the private channel, and bakes separate 24-hour credentials under distinct root-key IDs:

- observer: exact read-only node, channel, pending-channel, and balance RPCs;
- invoice: minimum node/channel health reads plus exact hold-invoice create, v2 lookup, settle, and cancel RPCs; and
- payer: minimum node/channel health reads plus exact decode, send-payment, and track-payment RPCs.

For all six node/role pairs, the bootstrap reads the baked macaroon back, requires the exact root-key ID, exact sorted URI set, and one bounded `time-before` caveat, and checks every granted URI against the pinned node's `ListPermissions` registry. It then requires representative wallet, invoice, payment-history, macaroon-administration, channel-balance, and network-graph commands to fail specifically with `permission denied`; a syntax or node failure cannot satisfy the test.

`regtest:smoke` creates a fresh preimage and 10,000-sat hold invoice on Bob, decodes and pays it from Alice, waits for `ACCEPTED`, settles only with the matching preimage, and requires `SUCCEEDED`. Its temporary payment result is mode-restricted and deleted after validation. The harness uses Bob's local regtest admin credential only to observe invoice state because `lncli lookupinvoice` targets the legacy lookup RPC; the isolated adapter campaign below uses only `LookupInvoiceV2` through its exact role credential.

`regtest:adapter-smoke` performs that lifecycle exclusively through the internal invoice and payer adapter processes. A local coordinator key signs exact 30-second authorizations; only its public key enters the adapter credential volumes. Each adapter verifies its pinned LND certificate, private-network hostname, role, signature, invoice, amount, hash, capacity epoch, live sync, active-channel liquidity, caps, and replay journal. After success, the campaign restarts the payer adapter and proves the exact request remains rejected, then proves the invoice adapter cannot execute a payer authorization.

`regtest:credential-smoke` first performs the exact six-role manifest and negative-authority checks. It then proves a disposable, two-second `GetInfo` credential works before its caveat and fails specifically as expired afterward. A second disposable credential works, its dedicated root-key ID is deleted, and the unchanged credential then fails while the admin node remains healthy. Test root keys and files are removed; no credential material is exported as evidence.

`regtest:invoice-fault-smoke` proves an unaccepted hold invoice expires to `CANCELED` and rejects a late preimage. It accepts a second hold payment, rejects a wrong preimage without changing `ACCEPTED`, cancels it, confirms `CANCELED`, rejects an exact signed cancellation replay and a correct late preimage, and requires the payer to report failure. Finally, it restarts and unlocks Bob's LND while a third HTLC is `ACCEPTED`, requires the same invoice and channel to recover, settles with the bound preimage, and requires the original one-shot payer request—not a replacement payment—to finish `SUCCEEDED`. Payment-result files are mode-restricted and removed.

`regtest:coordinator-smoke` uses a separate coordinator container and credential volume. It has the Ed25519 private key and its own SQLite volume but no LND macaroon. The payer adapter has only the public key and its payer macaroon. The campaign pays a real standard 10,000-sat invoice, discards the successful response, reopens the durable store in `UNKNOWN`, and uses a new signed read-only tracking request to recover `SUCCEEDED`. It requires one dispatch and proves the raw invoice was not written to the coordinator database. The reservation input is simulated, so this is not EVM finality evidence.

## Remaining campaigns

- Standard-invoice route failure, fee cap, and duplicate request. Success plus lost-response reconciliation now pass.
- HTLC cutoff under live block advancement. Hold-invoice cancel, expiry, wrong preimage, late settle, signed-action replay, and restart while accepted now pass.
- Delayed and fast blocks, force close, channel offline, unsynced node, stale capacity epoch, and exhausted liquidity. Accepted-state LND restart now passes.
- TLS pin change, overlap rotation, and stateless initialization. Exact grant manifests, timeout enforcement, root-key revocation, and representative forbidden-RPC categories now pass.
- Secret-free evidence export with binary/config hashes and exact test timestamps.

This lab is local evidence, not permission to fund testnet or mainnet.
