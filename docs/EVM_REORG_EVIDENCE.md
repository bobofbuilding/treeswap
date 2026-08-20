# Controlled EVM reorg evidence

Status: deterministic local execution-client and pinned live-BIT mainnet-fork evidence. This is not public-testnet consensus-finality evidence, a deployment manifest, or authorization to fund TreeSwap.

## Scope

`npm run test:escrow-reorg` starts a fresh Anvil chain, deploys the actual immutable `TreeSwapBitVault`, `TreeSwapUserEscrow`, and sealed shared payment-hash registry, then exercises real EIP-712 quotes and transactions in both swap directions. A test-only BIT implementation and always-open test gate isolate the reorg behavior from the separately recorded live BIT boundary.

For each direction the campaign proves three boundaries:

1. **Before Lightning authorization:** the locked escrow transaction and its block are replaced. Its receipt disappears, the swap returns to `UNSET`, the shared payment hash is unused, and authorization fails because the recorded escrow block hash is no longer canonical.
2. **After Lightning authorization but before dispatch:** a one-shot authorization is issued against the actual locked escrow block, that block is replaced, immediate dispatch revalidation rejects the authorization, and no Lightning dispatch occurs.
3. **After claim:** the actual claim receipt and block are replaced. The swap returns to `LOCKED`, beneficiary and fee balances roll back, the orphaned receipt is rejected, and a new canonical claim pays the permanently bound beneficiary exactly once.

The campaign runs with Anvil `1.7.1`. It binds the deployed runtime code hashes:

- `TreeSwapBitVault`: `0x97d32f338aae9c2c1f47c782870e2540c433d75abd0f051bfb40d275bd10467d`
- `TreeSwapUserEscrow`: `0xaafca0b736cdeac81e6a078d659d2752327fc547b6c791ce74ebb680710d338f`

Two parallel clean runs produced the same secret-free evidence digest:

`0xe38046a40518cd12d684f2ee49dfe598a2889fcf5cf0de30a91cb537f2326134`

## Pinned live-BIT fork repetition

`MAINNET_RPC_URL=<secret> npm run test:live-bit-reorg` refuses a dirty tree, any branch other than `main`, or a commit that differs from locally known `origin/main`. It starts an ephemeral Anvil fork at exact Ethereum block `25788856`, verifies that block's hash, the live BIT proxy and implementation runtime hashes, the EIP-1967 implementation address, `BIT` symbol, 18 decimals, and unpaused state, then runs the same six reorg boundaries above against both actual TreeSwap escrows. The endpoint is never recorded.

Mainnet state exposed an important harness boundary: familiar first mnemonic accounts may already have code or delegation on the fork and therefore enter the ERC-1271 signature path. The qualifying mode uses high deterministic accounts, proves each has no code at the pinned block, and funds them only inside the ephemeral fork. A live BIT holder is impersonated only inside Anvil to seed those test actors.

Published commit `1908b539e2bcb6fa48ce9c2883a0770979b82b01` produced:

- source: clean published `main` at that exact commit;
- live vault runtime hash: `0x62aea6119b6da88f0b34aeed030c1abdfbef377d517c435a8cfdac9b67112afd`;
- live user-escrow runtime hash: `0xdfa6351264038fd6f134eb38a1df8752382c917b1c24c3ad48bdb68a32e48960`;
- zero Lightning dispatch after block replacement;
- no accepted orphaned claim receipt; and
- one canonical beneficiary payout after each rolled-back claim.

The secret-free evidence digest is `0x1475c60668bf57ded78659302e1e03382f17a26c1d8479835f8a8a2436176507`. The matching [hosted security-and-build run](https://github.com/bobofbuilding/treeswap/actions/runs/32366965287) passed; hosted CI syntax-checks the credentialed runner but deliberately does not receive or use a mainnet RPC credential.

## Release limitation

Anvil snapshot replacement now proves rollback and canonical-block handling against both mock BIT and the pinned live BIT proxy, but it does not provide Ethereum consensus finality. Release still requires genuine finalized/unfinalized transitions, provider disagreement and finality rollback through two independently operated authenticated providers, deployed public-testnet escrows, and retained operator evidence. No local result may promote itself into the signed deployment manifest.
