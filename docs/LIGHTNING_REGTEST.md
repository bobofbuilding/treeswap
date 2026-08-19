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
npm run regtest:policy-fault-smoke
npm run regtest:route-fault-smoke
npm run regtest:htlc-cutoff-smoke
npm run regtest:coordinator-smoke
npm run regtest:coordinator-invoice-smoke
npm run qualify:local
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

`regtest:policy-fault-smoke` submits valid invoices with an excessive fee limit and excessive amount, then requires adapter rejection and `NOT_FOUND` tracking proof that neither payment was dispatched. It also proves the tracking error contains neither the raw nor REST-encoded payment hash. It holds two real 80,000-sat HTLCs, reads at least 160,000 sats in flight from LND, rejects another exposure above the 150,000-sat cap, and cancels both probes. It then stops Bob, waits until Alice reports zero active channels, rejects a fresh payment, recovers and unlocks Bob, requires both channel views to become active, and again proves the rejected hash is unknown to LND. Finally, a disposable payer-adapter process must refuse a deliberately mismatched TLS pin while the unchanged pinned adapter still decodes the exact invoice. The campaign does not emit invoices, macaroons, or preimages.

`regtest:route-fault-smoke` starts a third synced LND node with no channels and obtains a standard 10,000-sat invoice from it. Alice's healthy adapter dispatches exactly once and must receive terminal `FAILED` with `NO_ROUTE`; signed read-only tracking must return the same failed payment and bound amount. The exact authorization replay and a fresh authorization that reuses the payment hash must both fail at the adapter. A lab-only administrative count confirms LND still has exactly one matching payment record. The zero-state campaign passes after deleting all regtest Docker volumes.

`regtest:htlc-cutoff-smoke` accepts a real hold payment with an 80-block final CLTV, derives its actual HTLC expiry height, and mines enough blocks rapidly for both LND nodes to reach exactly the configured 24-block reserve. The invoice must still be `ACCEPTED`; the adapter must reject even the correct preimage specifically because the HTLC is inside its settlement margin; cancellation must release the original payer as failed. An earlier trial showed pinned LND auto-canceling at 18 blocks, which is why the TreeSwap reserve was raised to 24 rather than relying on the node's terminal boundary.

`regtest:coordinator-smoke` rebuilds and uses a separate coordinator container and credential volume so stale local images cannot satisfy the campaign. It has the Ed25519 private key and its own SQLite volume but no LND macaroon. The payer adapter has only the public key and its payer macaroon. The campaign pays a real standard 10,000-sat invoice, discards the successful response, reopens the durable store in `UNKNOWN`, and uses a new signed read-only tracking request to recover `SUCCEEDED`. It requires one dispatch and proves the raw invoice was not written to the coordinator database. The reservation input is simulated, so this is not EVM finality evidence.

`regtest:coordinator-invoice-smoke` gives the same credential-free coordinator a transient matching preimage for a real accepted 10,000-sat hold invoice. It settles through the invoice adapter, discards the successful response, reopens in `UNKNOWN`, and recovers `SETTLED` with one preimage-free signed lookup. It requires one dispatch and scans the closed SQLite database, WAL, and shared-memory files for both the raw and textual preimage. The original payer must succeed, and no replacement action is issued. Its reservation input is also simulated.

## Local qualification evidence

`npm run qualify:local` requires a clean `main` whose commit exactly matches the locally known `origin/main`. It reruns lint, both web builds, all application/security tests, contract formatting and tests, the EVM coordinator fault campaign, and every Lightning campaign above. Any failure prevents evidence creation, and the lab is stopped in all cases.

On success it writes one new mode-`0600` JSON record under ignored `outputs/`. The record contains only the published commit, UTC start/finish times, runtime versions, immutable external image identifiers, SHA-256 configuration hashes, campaign names/pass states, explicit limitations, and its own deterministic digest. It contains no command output, environment value, path, invoice, payment hash, preimage, macaroon, RPC URL, private key, wallet seed, or email. The command refuses a dirty/unpublished tree, mutable external image, failed campaign, unsafe filename, symlinked output directory, or overwrite. This local record is evidence—not funding authorization, independent review, public-testnet evidence, or a deployment manifest.

Published checkpoint `a3aad9f0fd11b6e5fc6524e7fdf091c36ddf4412` completed all 13 local campaigns from `2026-08-19T16:55:41.519Z` through `2026-08-19T16:58:05.650Z`. Its validated evidence digest is `sha256:91289a6613e6d23aa0945852d3cbbdf51396ab5921e22bb74b1334db4d4906d3`; the matching [hosted security-and-build run](https://github.com/bobofbuilding/treeswap/actions/runs/32278699370) also passed. This is a reproducible checkpoint, not the final release artifact.

## Remaining campaigns

- Standard-invoice success, genuine no-route failure, exact-request replay, same-hash duplicate exposure rejection, excessive-fee and amount rejection, no-dispatch tracking, and both payer/invoice lost-response reconciliations now pass.
- Hold-invoice cancel, expiry, wrong preimage, late settle, signed-action replay, restart while accepted, and the 24-block HTLC cutoff under rapid block advancement now pass.
- Prolonged block delay, force close, unsynced node, and stale capacity epoch. Rapid blocks, accepted-state LND restart, channel-offline rejection/recovery, and live in-flight-cap saturation now pass.
- Real certificate rotation, overlap credential rotation, and stateless initialization. TLS-pin mismatch, exact grant manifests, timeout enforcement, root-key revocation, and representative forbidden-RPC categories now pass.
- Promote a clean published-checkpoint qualification record into the reviewed release manifest. The secret-free generator and schema are implemented; a record from the final release commit remains required.

This lab is local evidence, not permission to fund testnet or mainnet.
