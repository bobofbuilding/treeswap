# BIT mainnet boundary evidence

Status: reproducible pre-release evidence captured on 2026-08-19. This is not a signed deployment manifest, security audit, or permission to fund TreeSwap.

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

The observer separately rejects an unfinalized target, a changing finalized hash, non-canonical state reads, a finalized-state regression, and provider disagreement. A controlled execution-client reorg before and after escrow authorization remains required for release evidence.

## Promotion rule

Do not copy this document into a production manifest automatically. Promotion requires two authenticated provider observations from the same published commit, both source bundles and compiler artifacts, a reviewer-signed comparison, live role and upgrade-authority evidence, the controlled reorg campaign, and closure of every independent-review finding.
