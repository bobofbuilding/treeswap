# Lightning regtest lab

Status: reproducible two-node lab, bounded credential lifecycle, hold-invoice lifecycle faults, isolated signed-adapter smoke, and durable lost-response coordinator recovery pass locally. The full chain/channel failure-injection matrix remains.

The lab uses immutable multi-architecture image digests for:

- Bitcoin Core `v31.1`;
- LND `v0.21.2-beta`; and
- two isolated LND nodes connected by a private 1,000,000-sat channel with balanced directional liquidity.

The Docker network is internal and publishes no host ports. Runtime RPC and wallet passwords are generated locally with restrictive permissions under ignored `.state` storage. They are regtest-only and must never be reused.

The persistent lab uses a deliberately high 100,000,000-sat test-only daily ceiling so repeated qualification runs retain replay journals without exhausting the day. This is not a production recommendation. Separate disposable adapters enforce a 10,000-sat live test ceiling, and deterministic journal coverage proves the exact UTC rollover. Production must publish a much smaller reviewed limit.

## Commands

```sh
npm run regtest:up
npm run regtest:smoke
npm run regtest:adapter-smoke
npm run regtest:credential-smoke
npm run regtest:credential-rotation-smoke
npm run regtest:tls-rotation-smoke
npm run regtest:invoice-fault-smoke
npm run regtest:policy-fault-smoke
npm run regtest:directional-capacity-smoke
npm run regtest:daily-cap-smoke
npm run regtest:stale-chain-smoke
npm run regtest:unsynced-chain-smoke
npm run regtest:force-close-smoke
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

`regtest:credential-rotation-smoke` bakes a replacement payer credential under a new root-key ID, verifies its exact permission and expiry manifest, and runs old and replacement adapters concurrently. Both decode the same exact invoice during the overlap window. The campaign then deletes only the old root key, requires both native LND and the old adapter to reject it, proves the replacement adapter remains available, and restores a fresh standard credential. Read-only authorization and transport failures are explicitly non-ambiguous because they cannot move value; value-moving unknown outcomes remain ambiguous. The initial run plus three consecutive warm-state repetitions pass, and cleanup leaves neither the temporary root key nor credential behind.

`regtest:tls-rotation-smoke` moves Alice's real LND certificate and key into recoverable node-local backups, restarts the pinned node so LND generates a new certificate pair, and explicitly reconnects the existing private peer. The new certificate fingerprint must differ while the node identity and exact channel-point set remain unchanged. The still-running old pinned adapter must reject an exact read-only decode non-ambiguously and native payment history must remain empty for that hash. A deliberate rollback then restores the previous pair and old adapter pin before the campaign rotates again. The final rollout copies the new public certificate, binds its observed fingerprint, recreates the adapters, and requires the same invoice decode to succeed. The backup pair is deleted only after recovery; an exit trap also restores it on unexpected failure. Four consecutive successful campaigns pass without dispatch or secret output.

`regtest:invoice-fault-smoke` proves an unaccepted hold invoice expires to `CANCELED` and rejects a late preimage. It accepts a second hold payment, rejects a wrong preimage without changing `ACCEPTED`, cancels it, confirms `CANCELED`, rejects an exact signed cancellation replay and a correct late preimage, and requires the payer to report failure. Finally, it restarts and unlocks Bob's LND while a third HTLC is `ACCEPTED`, requires the same invoice and channel to recover, settles with the bound preimage, and requires the original one-shot payer request—not a replacement payment—to finish `SUCCEEDED`. Payment-result files are mode-restricted and removed.

`regtest:policy-fault-smoke` submits valid invoices with an excessive fee limit and excessive amount, then requires adapter rejection and `NOT_FOUND` tracking proof that neither payment was dispatched. It also proves the tracking error contains neither the raw nor REST-encoded payment hash. It holds two real 80,000-sat HTLCs, reads at least 160,000 sats in flight from LND, rejects another exposure above the 150,000-sat cap, and cancels both probes. It then stops Bob, waits until Alice reports zero active channels, rejects a fresh payment, recovers and unlocks Bob, requires both channel views to become active, and again proves the rejected hash is unknown to LND. Finally, a disposable payer-adapter process must refuse a deliberately mismatched TLS pin while the unchanged pinned adapter still decodes the exact invoice. The campaign does not emit invoices, macaroons, or preimages.

`regtest:directional-capacity-smoke` rebalances the live private channel until Alice has less than a 100,000-sat payment in local capacity and Bob has less than the same amount in remote capacity. The payer adapter must reject outgoing payment exposure and prove `NOT_FOUND`; the invoice adapter must reject incoming hold-invoice exposure and native lookup must prove no invoice exists. The campaign then rebalances the channel, requires that exact previously rejected payment to succeed once, creates and cancels the previously rejected hold invoice, and restores the transferred balance. Three consecutive warm-state runs pass.

`regtest:daily-cap-smoke` gives disposable payer and invoice adapters separate 10,000-sat daily limits and durable journals. Each adapter opens exactly 10,000 sats of real exposure, restarts against the same journal, and rejects a fresh one-sat exposure specifically because the daily cap is exhausted. Read-only tracking proves the rejected payment is absent, native lookup proves the rejected hold invoice is absent, the successful payment is rebalanced, and the successful hold invoice is canceled. Deterministic journal coverage separately proves that value usage resets at the exact UTC-day boundary after restart while request-ID and payment-hash replay protection remain permanent. Four consecutive live runs pass.

`regtest:stale-chain-smoke` reads the pinned LND node's real `wallet_synced`, height, and `best_header_timestamp`, then gives a disposable payer adapter a read-only baseline observation. After a deliberate no-block interval crosses its compressed one-second no-progress limit, the adapter must reject an exact signed payment specifically because the same header made no local progress; read-only tracking through the normally configured adapter must prove the payment was never dispatched. Reported past age, locally observed no-progress time, and future skew are independent limits, so the baseline remains valid even when the newest honest block is already several seconds old. The normal adapter uses 3,600-second age and no-progress ceilings, regtest separately allows its synthetic timestamp up to 7,200 seconds ahead, and the same invoice remains decodable there. Repeated stale → force-close → stale sequences pass without emitting invoices, hashes, macaroons, or preimages.

`regtest:unsynced-chain-smoke` pauses the real Alice LND process, advances Bitcoin regtest by 500 blocks, and resumes Alice into a genuine catch-up state. The campaign observes `synced_to_chain=false` or `wallet_synced=false`, requires the adapter to reject an exact signed payment non-ambiguously, waits for both flags and the channel to recover, and uses read-only tracking to prove zero dispatch. The recovered adapter then decodes the same invoice. Three consecutive warm-state runs pass.

`regtest:force-close-smoke` unilaterally closes Alice's only active channel and requires an exact signed payment to be rejected before dispatch while the channel is in LND's waiting-close state. It confirms the commitment transaction, reads the pinned node's actual CSV maturity, advances through that maturity, confirms the resulting sweep, and requires all pending-close exposure to clear. Only then does it open and confirm a fresh balanced private channel, prove the rejected payment is `NOT_FOUND`, and decode the same invoice through the recovered adapter. Three consecutive warm-state runs pass without accumulating pending closes.

`regtest:route-fault-smoke` starts a third synced LND node with no channels and obtains a standard 10,000-sat invoice from it. Alice's healthy adapter dispatches exactly once and must receive terminal `FAILED` with `NO_ROUTE`. Pinned LND may subsequently track that attempt as the exact bound `FAILED` payment or return non-ambiguous, hash-redacted `NOT_FOUND`; neither observation permits another send. The exact authorization replay and a fresh authorization that reuses the payment hash must both fail at the adapter. A lab-only administrative count confirms LND still has exactly one matching payment record. The zero-state campaign and five consecutive warm-state campaigns pass.

`regtest:htlc-cutoff-smoke` accepts a real hold payment with an 80-block final CLTV, derives its actual HTLC expiry height, and mines enough blocks rapidly for both LND nodes to reach exactly the configured 24-block reserve. The invoice must still be `ACCEPTED`; the adapter must reject even the correct preimage specifically because the HTLC is inside its settlement margin; cancellation must release the original payer as failed. An earlier trial showed pinned LND auto-canceling at 18 blocks, which is why the TreeSwap reserve was raised to 24 rather than relying on the node's terminal boundary.

`regtest:coordinator-smoke` rebuilds and uses a separate coordinator container and credential volume so stale local images cannot satisfy the campaign. It has the Ed25519 private key and its own SQLite volume but no LND macaroon. The payer adapter has only the public key and its payer macaroon. The campaign pays a real standard 10,000-sat invoice, discards the successful response, reopens the durable store in `UNKNOWN`, and uses bounded fresh signed read-only tracking attempts to recover `SUCCEEDED`. A transient non-ambiguous `NOT_FOUND` remains unresolved and can only trigger another read; it never permits another send. The campaign requires one dispatch and proves the raw invoice was not written to the coordinator database. The reservation input is simulated, so this is not EVM finality evidence.

`regtest:coordinator-invoice-smoke` gives the same credential-free coordinator a transient matching preimage for a real accepted 10,000-sat hold invoice. It settles through the invoice adapter, discards the successful response, reopens in `UNKNOWN`, and recovers `SETTLED` with one preimage-free signed lookup. It requires one dispatch and scans the closed SQLite database, WAL, and shared-memory files for both the raw and textual preimage. The original payer must succeed, and no replacement action is issued. Its reservation input is also simulated.

## Local qualification evidence

`npm run qualify:local` requires a clean `main` whose commit exactly matches the locally known `origin/main`. It reruns lint, both web builds, all application/security tests, contract formatting and tests, the EVM coordinator fault campaign, and every Lightning campaign above. Any failure prevents evidence creation, and the lab is stopped in all cases.

On success it writes one new mode-`0600` JSON record under ignored `outputs/`. The record contains only the published commit, UTC start/finish times, runtime versions, immutable external image identifiers, SHA-256 configuration hashes, campaign names/pass states, explicit limitations, and its own deterministic digest. It contains no command output, environment value, path, invoice, payment hash, preimage, macaroon, RPC URL, private key, wallet seed, or email. The command refuses a dirty/unpublished tree, mutable external image, failed campaign, unsafe filename, symlinked output directory, or overwrite. This local record is evidence—not funding authorization, independent review, public-testnet evidence, or a deployment manifest.

Published checkpoint `2d5e97cb5538177140bb4daaeffae12590c84318` completed all 21 local campaigns from `2026-08-19T19:22:42.702Z` through `2026-08-19T19:27:31.380Z`. Its validated evidence digest is `sha256:cb96070fe11c3a5bffff80f23c6bc3d1878f6360ebcfeaa17055e8cca3933d0d`; the matching [hosted security-and-build run](https://github.com/bobofbuilding/treeswap/actions/runs/32292680022) also passed. This is a reproducible checkpoint, not the final release artifact.

## Remaining campaigns

- Standard-invoice success, genuine no-route failure, exact-request replay, same-hash duplicate exposure rejection, excessive-fee and amount rejection, no-dispatch tracking, and both payer/invoice lost-response reconciliations now pass.
- Hold-invoice cancel, expiry, wrong preimage, late settle, signed-action replay, restart while accepted, and the 24-block HTLC cutoff under rapid block advancement now pass.
- Stale capacity epoch and production-duration delay remain. Rapid blocks, genuine 500-block unsynced-node catch-up, full force-close/CSV-sweep/channel-replacement recovery, compressed-threshold stale-header rejection with zero dispatch, accepted-state LND restart, channel-offline rejection/recovery, live directional exhaustion/rebalancing, and live in-flight-cap saturation now pass.
- Live payer/invoice daily-cap saturation and restart persistence pass, and deterministic journal coverage proves exact UTC rollover without weakening permanent replay protection.
- Stateless initialization remains. Real certificate replacement and pin rollout, overlap credential rotation, deterministic old-root revocation, uninterrupted replacement service, TLS-pin mismatch, exact grant manifests, timeout enforcement, and representative forbidden-RPC categories now pass.
- Promote a clean published-checkpoint qualification record into the reviewed release manifest. The secret-free generator and schema are implemented; a record from the final release commit remains required.

This lab is local evidence, not permission to fund testnet or mainnet.
