# Pinned live-BIT cross-chain deadline evidence

Status: the credentialed runner and fail-closed evidence verifier passed on clean published `main` commit `9ba7d89a8b555f749c2a0f9a450effff340d6833`. The pinned-live-BIT-fork timing sub-gate is complete. Public-testnet finality and independently operated infrastructure remain open, so funded operation is still blocked.

## Purpose

The normal `test:cross-chain-deadlines` campaign combines actual TreeSwap escrows and live LND regtest invoices but uses mock BIT on isolated Anvil. The existing `test:live-bit-reorg` campaign uses the pinned live BIT proxy but does not execute the complete Lightning deadline sequence. This runner joins those boundaries without allowing either result to impersonate the other.

```sh
MAINNET_RPC_URL=<authorized-archive-endpoint> npm run test:live-bit-cross-chain-deadlines
```

To retain the successful secret-free record, supply one safe filename. The writer exclusively creates the file under the private `outputs/` directory, refuses an existing target or symlink, verifies both evidence digests and the exact no-funding limitations, syncs it, and requires mode `0600`:

```sh
MAINNET_RPC_URL=<authorized-archive-endpoint> npm run test:live-bit-cross-chain-deadlines -- --out-name live-bit-cross-chain-deadline-<source>.json
```

The endpoint is passed only to the ephemeral Anvil process and is never written to state or evidence. The runner refuses a dirty worktree, any branch other than `main`, a commit different from locally known `origin/main`, a missing endpoint, a non-loopback execution endpoint, or any mnemonic other than Anvil's public test mnemonic. Temporary state is created under a mode-`0700` directory, the state file is mode `0600`, and cleanup deletes it.

## Exact fork boundary

The campaign starts Anvil at Ethereum block `25788856` and independently requires:

| Field | Required value |
| --- | --- |
| Canonical block hash | `0xf327faf6fee57fdf66e5973d19364e662da009ba266ab32899e242a2b22aef89` |
| BIT proxy | `0x57A447E4d5e18A9423408C365963A73F08B9d18C` |
| Proxy runtime hash | `0xf5648c6316e00873ef8427290251866b3675668407ecf526bf3f467578ff9adc` |
| BIT implementation | `0xa27b118c0770939295f052aE1b003366E5eF806F` |
| Implementation runtime hash | `0x506816a3d5cf9e4f486659231f21540e9985d7fbc8438dbb385accd2e532b120` |
| EIP-1967 implementation slot | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` |
| Token configuration | symbol `BIT`, 18 decimals, unpaused |

Every mismatch stops before evidence finalization. High-index public test accounts must have no code at the fork. Only the already pinned live holder is impersonated, only inside the ephemeral fork, to seed test inventory.

## Combined sequence

Both directions use the same policy as the credential-free deadline campaign:

1. Deploy the actual TreeSwap vault, user escrow, gate, and sealed payment-hash registry against the pinned BIT proxy.
2. Bind the live BOLT 11 invoice fields, payment hash, beneficiary, exact amount, fees, quote expiry, last-safe-claim time, and refund time into the real EIP-712 quote.
3. Require twelve locally simulated EVM confirmations before any Lightning action.
4. For BIT to Lightning, pay only after finality and claim live forked BIT only with the returned hash-bound proof.
5. For Lightning to BIT, observe the actual accepted HTLC expiry, use the stricter route-adjusted safety height, reject settlement at that exact height, release the payer, prove refund is unavailable there, then prove claim and refund are mutually exclusive at the exact EVM refund timestamp.
6. Re-read the canonical fork block, proxy and implementation code, implementation slot, symbol, decimals, and pause state before final evidence.

## Evidence boundary

Successful execution emits `treeswap.live-bit-cross-chain-deadline-evidence.v1` with scope `pinned-live-bit-fork-local-lnd-no-funding-authorization`. It contains the clean published source commit, exact live-BIT provenance, and the independently rebuilt deadline evidence. It omits the archive endpoint, invoices, payment hashes, invoice digests, preimages, and unrestricted URLs. Durable output is optional so the normal qualification remains ephemeral; when requested, persistence occurs only after the privacy scan and exact-schema checks pass.

The schema explicitly records that the EVM provider is one local fork, EVM finality is simulated, public testnet and independent providers are absent, production infrastructure is absent, and funding authorization is false. A passing result can close only the pinned live-BIT-fork timing sub-gate. Public-testnet finality, independently operated providers and solvers, monitoring, incident drills, reviews, multisigs, and the signed release record remain mandatory.

## Recorded checkpoint

Clean published source `9ba7d89a8b555f749c2a0f9a450effff340d6833` passed the complete credentialed sequence against the exact pinned BIT boundary and live LND regtest in both directions. BIT to Lightning paid only after twelve simulated EVM confirmations and then claimed before refund. Lightning to BIT reached the stricter observed 24-block safety boundary, rejected settlement, released the payer, and preserved exact claim/refund mutual exclusion. The retained outer evidence digest is `0xb9711ca69dcdad37f41de2ca2bd321534f0404bebd8d6facf89ad2f9f8cad70c`; its nested deadline digest is `0xe2c2efc01ae1f8e04f9765e21e1069ff9f071e87b5fea3e313e3d5816bd10f8e`.

The mode-`0600` ignored artifact was independently re-read through the production evidence verifier. Both digests, the policy digest, pinned proxy and implementation identity, direction timings, confirmation count, boundary heights, exact limitations, and privacy exclusions reproduced. It contains no archive endpoint, invoice, payment hash, invoice digest, preimage, unrestricted URL, key, macaroon, seed, or email. It explicitly records one local fork provider, simulated EVM finality, no public testnet, no independent providers, no production infrastructure, and no funding authorization.
