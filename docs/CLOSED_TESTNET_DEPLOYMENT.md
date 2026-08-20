# Closed public-testnet deployment plan

Status: the repository can deterministically prepare and independently reproduce an unsigned Sepolia deployment plan. No public-testnet contract, Safe, token, provider, signer, transaction, inventory, or funding approval is supplied by this workflow.

TreeSwap uses Sepolia (`chainId = 11155111`) for the first public EVM campaign because Ethereum currently recommends Sepolia as the default testnet for application development. This is a test boundary, not a claim that a Sepolia BIT proxy has been reviewed or deployed. See [Ethereum test networks](https://ethereum.org/developers/docs/networks/).

## What the plan fixes

One plan binds:

- the exact clean source commit already published on `origin/main` and one nonzero independent-review digest;
- the deployer and its exact starting nonce;
- distinct controller, guardian, and fee-recipient contract wallets, with disjoint owner sets, thresholds of at least two, and runtime code hashes;
- one reviewed, unpaused, 18-decimal public-testnet BIT proxy and implementation with exact runtime hashes;
- a gate with at least a 24-hour reopen delay and at most a seven-day open window;
- separate vault and user-escrow fee, price, amount, epoch, settlement, claim, and lock limits, including the 100-sat reference;
- Solidity `0.8.24`, optimizer runs `20,000`, Cancun EVM output, source commitments, init code, four deterministic CREATE addresses, and every constructor argument; and
- three hash-linked controller calls in order: register the vault, register the user escrow, then irreversibly seal the registry.

The plan explicitly sets signing, broadcast, gate-opening, and funding authorization to `false`.

## Preparation ceremony

Use a fresh checkout of the reviewed commit. The checkout must be clean, `HEAD` must equal `origin/main`, and the pinned compiler must already be installed. Keep input and output files outside the repository so the clean-tree check can pass.

The input uses schema `treeswap.closed-testnet-deployment-input.v1` and contains only public commitments and exact policy values. It must not contain RPC URLs, mnemonics, keys, signatures, invoices, preimages, email addresses, or macaroons.

```sh
npm run prepare:testnet-deployment -- \
  --input /secure-operator-workspace/deployment-input.json \
  --out /secure-operator-workspace/unsigned-plan.json
```

The command refuses symlinked or oversized JSON, refuses to overwrite an output, writes mode `0600`, and syncs both the file and its directory. Before deriving calldata, it forces an offline Foundry rebuild from the exact clean published commit and verifies every artifact source commitment against that commit.

A second operator should use a separate clean checkout and independently run:

```sh
npm run verify:testnet-deployment -- \
  --input /secure-operator-workspace/deployment-input.json \
  --plan /secure-operator-workspace/unsigned-plan.json
```

Verification rebuilds the contracts again and accepts only a byte-for-byte canonical reconstruction of the complete plan. A changed nonce, address, constructor argument, bytecode, action order, risk limit, postcondition, or digest fails.

## Required external preflight

The plan is not a live-chain observation. Before a signer ceremony, two independently operated authenticated providers must agree on:

1. Sepolia chain ID and the deployer's exact nonce;
2. the code, owners, and threshold of all three role wallets;
3. the BIT proxy, EIP-1967 implementation, both runtime hashes, symbol, decimals, and unpaused state; and
4. the reviewed source, compiler output, findings disposition, and independent-review digest.

If any value has moved, discard the plan and start again. Do not edit the plan.

## Required external postconditions

After separately authorized Safe/deployer execution, the existing finalized deployment observer must prove through two independent providers that:

- all four contract addresses and runtime code match;
- the gate is closed and has no pending open;
- the registry is sealed to exactly the vault and user escrow;
- the role wallets, constructor immutables, BIT boundary, risk limits, and fee recipient match; and
- vault available inventory, vault locked inventory, user-escrow liabilities, and every unreconciled liability are zero.

Only then can the seven-day public-testnet campaign begin. Opening the gate or adding test inventory requires the separate signed release boundary. This file and its CLIs never grant that permission.

## Trust boundary

The workflow proves deterministic reviewed calldata, not organizational independence, hardware custody, provider truth, nonce availability, deployed bytecode, Safe execution, review quality, monitor availability, Lightning readiness, or asset solvency. A compromised compiler or host remains possible; independent rebuilds, signed artifact digests, finalized observation, and external review are still mandatory. Mainnet requires a later plan bound to the reviewed live BIT deployment and completed public-testnet evidence; this Sepolia plan cannot be relabeled for mainnet.
