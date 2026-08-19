# Lightning regtest lab

Status: reproducible two-node lab and hold-invoice smoke pass locally. Failure injection and adapter integration remain.

The lab uses immutable multi-architecture image digests for:

- Bitcoin Core `v31.1`;
- LND `v0.21.2-beta`; and
- two isolated LND nodes connected by a private 1,000,000-sat channel with balanced directional liquidity.

The Docker network is internal and publishes no host ports. Runtime RPC and wallet passwords are generated locally with restrictive permissions under ignored `.state` storage. They are regtest-only and must never be reused.

## Commands

```sh
npm run regtest:up
npm run regtest:smoke
npm run regtest:status
npm run regtest:down
```

`regtest:up` initializes both wallets without printing their test seeds, mines spendable regtest funds, opens and confirms the private channel, and bakes separate credentials under distinct root-key IDs:

- observer: exact read-only info, channel, decode, and lookup RPCs;
- invoice: exact hold-invoice create, lookup, subscribe, settle, and cancel RPCs; and
- payer: exact decode, send-payment, and track-payment RPCs.

The bootstrap proves the invoice credential cannot call `GetInfo` and the payer credential cannot create an invoice.

`regtest:smoke` creates a fresh preimage and 10,000-sat hold invoice on Bob, decodes and pays it from Alice, waits for `ACCEPTED`, settles only with the matching preimage, and requires `SUCCEEDED`. Its temporary payment result is mode-restricted and deleted after validation.

## Remaining campaigns

- Standard invoice success, route failure, fee cap, duplicate request, and ambiguous-response reconciliation.
- Hold invoice cancel, expiry, wrong preimage, late settle, replay, restart while accepted, and HTLC cutoff.
- Delayed and fast blocks, force close, channel offline, unsynced node, stale capacity epoch, and exhausted liquidity.
- TLS pin change, credential timeout, root-key revocation, negative URI matrix, and stateless initialization.
- Integration of the repository policy with a real adapter process; no application or browser receives a macaroon.
- Secret-free evidence export with binary/config hashes and exact test timestamps.

This lab is local evidence, not permission to fund testnet or mainnet.
