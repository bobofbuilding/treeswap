# Controlled EVM reorg evidence

Status: deterministic local execution-client evidence. This is not live BIT-fork evidence, public-testnet finality evidence, a deployment manifest, or authorization to fund TreeSwap.

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

## Release limitation

Anvil snapshot replacement proves rollback and canonical-block handling but does not provide Ethereum consensus finality or a live BIT proxy. Release still requires the same campaign on a controlled fork of the pinned BIT state, genuine finalized/unfinalized transitions, provider disagreement and finality rollback, and authenticated public-testnet evidence. No local result may promote itself into the signed deployment manifest.
