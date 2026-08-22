# BIT mainnet boundary evidence

Status: reproducible pre-release evidence captured on 2026-08-19 and revalidated against the current published source on 2026-08-22. This is not a signed deployment manifest, security audit, or permission to fund TreeSwap.

## Pinned state

Every state read was anchored with EIP-1898 to canonical Ethereum block `25788856` (`0xf327faf6fee57fdf66e5973d19364e662da009ba266ab32899e242a2b22aef89`):

| Field | Recorded value |
| --- | --- |
| BIT proxy | `0x57A447E4d5e18A9423408C365963A73F08B9d18C` |
| Proxy runtime hash | `0xf5648c6316e00873ef8427290251866b3675668407ecf526bf3f467578ff9adc` |
| EIP-1967 implementation | `0xa27b118c0770939295f052aE1b003366E5eF806F` |
| Implementation runtime hash | `0x506816a3d5cf9e4f486659231f21540e9985d7fbc8438dbb385accd2e532b120` |
| Symbol / decimals / paused | `BIT` / `18` / `false` |

An authenticated Alchemy endpoint and an independently operated public BlockReq archive endpoint returned identical values for every compared field. This is useful diversity evidence, but the public endpoint does not satisfy the release requirement for two authenticated, independently operated providers. Re-run both observations from the published checkpoint with named operators before review.

## Current-source authenticated observation

Exact clean published commit `37fa0044554451b392447ac79c83021c5f41ea02` captured a fresh authenticated Alchemy observation at canonical finalized Ethereum block `25807484` (`0x35f1d60387e9297b483053ca76f68c3da60a8c0c7c212e777068894ca4003cf8`) on 2026-08-22. It reproduced the proxy and implementation runtime hashes above, implementation `0xa27b118c0770939295f052aE1b003366E5eF806F`, and `BIT` / `18` / `false` token state. The ignored evidence file is mode `0600` and has raw digest `sha256:4948f7b8dcf8e05120fc6d506783081f78cdc0d6a01ebec872c2939de34bfeda`.

A separate Alchemy CLI `0.22.0` pass re-read that exact block and every state value through its canonical block-hash anchor, recomputed both code hashes, decoded all three token calls, confirmed the provider still reported the block finalized, matched the exact published commit, and found no endpoint, RPC URL, API-key marker, or credential-like value in the retained JSON. Both passes use the same provider. This checkpoint therefore proves current-source reproducibility and credential-safe collection only; it does not prove provider independence, source review, signed promotion, or funding authorization.

## Independent-provider handoff

Historical observations above use schema v2 and remain reproducibility evidence only. New release-bound captures must use `treeswap.bit-deployment-observation.v3`; the comparison tool rejects v2 rather than silently upgrading it.

Before making an RPC request, v3 requires the canonical HTTPS TreeSwap origin, a clean `main` checkout, and an exact commit matching the current remote `origin/main`. Each operator must supply a stable nonzero `bytes32` provider-identity commitment and a credential-free display label. The observation has one exact canonical shape, recomputes its own safety result, rejects unknown or endpoint-bearing fields, and binds every read to one canonical finalized block.

Comparison v2 accepts bounded non-symlink inputs only. Both observations must be no more than one hour old, no more than thirty minutes apart, and no more than sixty seconds future-dated. It requires distinct identity commitments, case-insensitively distinct labels, and distinct exact canonical observation digests before comparing every safety-critical field. Its mode-`0600`, non-overwriting report retains both identities and digests, declares organizational independence externally unverified, and sets `fundingAuthorization` to `false`.

These controls make accidental reuse, relabeling, stale capture, input substitution, source drift, and unbound comparison visible. They cannot prove that two provider accounts, signers, companies, or endpoints are independently controlled. Reviewers must retain the real operator identities, control relationships, and provider agreements separately and bind their conclusions into the signed review and promotion records.

## Source reproduction

The proxy is an exact creation and runtime match in [Sourcify](https://repo.sourcify.dev/1/0x57A447E4d5e18A9423408C365963A73F08B9d18C). Sourcify identifies OpenZeppelin `ERC1967Proxy`, compiler `0.8.28+commit.7893614a`, optimizer enabled with 1,000 runs, and Paris EVM output.

The implementation is an exact match in [Etherscan](https://etherscan.io/address/0xa27b118c0770939295f052aE1b003366E5eF806F#code) with the same compiler, optimizer, and EVM settings. A local standard-JSON recompile reproduced all 12,734 runtime bytes after applying the three compiler-declared `UUPSUpgradeable.__self` immutable references to the implementation address. The resulting Keccak-256 hash exactly matched the pinned implementation runtime hash.

Explorer verification and local reproduction prove source-to-bytecode identity, not source safety. Independent reviewers must still assess BIT's upgrade authority, role holders, storage layout, transfer behavior, pause behavior, mint/redeem accounting, and how those external controls affect TreeSwap.

## Mainnet-fork campaign

`npm run test:fork` refuses to start without `MAINNET_RPC_URL` and forks the pinned block. Six campaigns pass against the actual BIT proxy:

1. exact proxy hash, implementation slot/hash, symbol, decimals, and pause state;
2. solver-owned BIT deposit, Lightning-to-BIT reserve, exact claim, fee, and refund deltas;
3. user-funded BIT-to-Lightning open, exact claim, fee, and refund deltas;
4. a real BIT administrator pause blocks new TreeSwap exposure while the recorded v1 implementation still permits existing ERC-20 exits, followed by unpause;
5. an incompatible implementation-slot change fails closed before new exposure; and
6. the sealed registry prevents one payment hash from being used across both directions.

The observer separately rejects an unfinalized target, a changing finalized hash, non-canonical state reads, a finalized-state regression, and provider disagreement. The [controlled EVM reorg campaign](./EVM_REORG_EVIDENCE.md) now proves both actual TreeSwap escrows fail closed across local block replacement before authorization, after authorization, and after claim with mock BIT and again on an Anvil fork using the pinned live BIT proxy. The clean-published live-fork digest is `0x1475c60668bf57ded78659302e1e03382f17a26c1d8479835f8a8a2436176507`. Genuine public-testnet finality transitions through two independent authenticated providers remain required for release evidence.

## Promotion rule

Do not copy this document into a production manifest automatically. Promotion requires two authenticated provider observations from the same published commit, both source bundles and compiler artifacts, a reviewer-signed comparison, live role and upgrade-authority evidence, the controlled reorg campaign, and closure of every independent-review finding.
