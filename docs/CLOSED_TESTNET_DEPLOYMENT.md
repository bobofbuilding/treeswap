# Closed public-testnet deployment plan

Status: the repository can deterministically prepare and independently reproduce an unsigned Sepolia deployment plan, verify a short-lived signed preflight over two matching live-provider observations, and verify the exact finalized deployment/Safe receipts in a separate signed postflight. No public-testnet contract, Safe, token, provider, signer, transaction, inventory, or funding approval is supplied by this workflow.

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

## Signed live preflight

The plan is not a live-chain observation. Before a separate signer ceremony, two independently operated authenticated providers must agree on:

1. Sepolia chain ID and the deployer's exact nonce;
2. the code, owners, and threshold of all three role wallets;
3. the BIT proxy, EIP-1967 implementation, both runtime hashes, symbol, decimals, and unpaused state; and
4. the reviewed source, compiler output, findings disposition, and independent-review digest.

The observer anchors every state read to one canonical block hash. It proves that the deployer has no runtime code, reads its nonce at that block, and reads the provider's pending nonce immediately before and after the state snapshot. All three nonce values must equal the plan's starting nonce. It also proves all four predicted deployment addresses are still empty and reconstructs each contract wallet's code, owners, and threshold and the full BIT proxy boundary. Any drift stops collection.

Provider one captures the latest eligible block. Secrets stay in environment variables and are never written:

```sh
ETHEREUM_RPC_URL=<authenticated-secret> \
ETHEREUM_RPC_PROVIDER_LABEL=<operator-label> \
ETHEREUM_RPC_PROVIDER_IDENTITY=<public-bytes32-identity-commitment> \
npm run observe:testnet-deployment-preflight -- \
  --plan /secure-operator-workspace/unsigned-plan.json \
  --out /secure-operator-workspace/provider-1.json
```

Provider two must be independently operated and inspect the exact first block:

```sh
ETHEREUM_RPC_URL=<second-authenticated-secret> \
ETHEREUM_RPC_PROVIDER_LABEL=<second-operator-label> \
ETHEREUM_RPC_PROVIDER_IDENTITY=<second-public-bytes32-identity-commitment> \
npm run observe:testnet-deployment-preflight -- \
  --plan /secure-operator-workspace/unsigned-plan.json \
  --block <provider-1-anchor-block-number> \
  --out /secure-operator-workspace/provider-2.json
```

Place the two observations in one JSON array ordered by `providerIdentity`. The policy schema is `treeswap.closed-testnet-deployment-preflight-policy.v1`. It binds the exact plan, input, source, review digest, Sepolia chain, expected gate address, two-to-five provider identities/signers, exactly one distinct operations reviewer, observation and block ages of at most ten minutes, and a lifetime of at most fifteen minutes.

Create the record without hand-copying the observed state:

```sh
npm run prepare:testnet-deployment-preflight -- \
  --plan /secure-operator-workspace/unsigned-plan.json \
  --policy /secure-operator-workspace/preflight-policy.json \
  --observations /secure-operator-workspace/observations.json \
  --preflight-id <fresh-random-bytes32> \
  --out /secure-operator-workspace/preflight-record.json
```

Each provider and the operations reviewer independently reconstructs its EIP-712 message. The command emits typed data but never signs:

```sh
npm run prepare:testnet-deployment-preflight-approval -- \
  --plan /secure-operator-workspace/unsigned-plan.json \
  --policy /secure-operator-workspace/preflight-policy.json \
  --record /secure-operator-workspace/preflight-record.json \
  --observations /secure-operator-workspace/observations.json \
  --role <provider-or-operations-reviewer> \
  --approver-id <policy-pinned-bytes32-id>
```

After collecting the externally produced signatures in canonical role/ID order, verify the exact package:

```sh
npm run verify:testnet-deployment-preflight -- \
  --plan /secure-operator-workspace/unsigned-plan.json \
  --policy /secure-operator-workspace/preflight-policy.json \
  --record /secure-operator-workspace/preflight-record.json \
  --observations /secure-operator-workspace/observations.json \
  --attestations /secure-operator-workspace/attestations.json
```

The verified output is deliberately only a fresh preflight fact. It grants no signing, broadcast, gate-opening, or funding authority. A moved nonce, pending transaction, contract deployer, occupied predicted address, block replacement, Safe change, BIT change, observation substitution, duplicate provider/signer, missing review, bad signature, secret-bearing field, or expiry invalidates the package. If anything moves or the fifteen-minute window expires, discard the preflight and start again. Do not edit the plan or record.

Use a fresh single-purpose deployer and review its signing device before the ceremony. Standard Ethereum RPC exposes the next pending nonce, not a complete authenticated inventory of every provider-hidden or non-contiguous queued transaction. Two providers plus before/after reads reduce disagreement and race risk but cannot prove that no other signed transaction exists. If deployer-key custody or transaction inventory is uncertain, abandon that deployer and regenerate the plan from a new address.

## Signed postflight and required external postconditions

After separately authorized Safe/deployer execution, the [signed deployment postflight](./CLOSED_TESTNET_DEPLOYMENT_POSTFLIGHT.md) must reconstruct all four deployment transactions and all three standard Safe `execTransaction` calls against the exact signed preflight. It then uses the finalized deployment observer to prove through two independent providers that:

- all four contract addresses and runtime code match;
- the gate is closed and has no pending open;
- the registry is sealed to exactly the vault and user escrow;
- the role wallets, constructor immutables, BIT boundary, risk limits, and fee recipient match; and
- vault available inventory, locked inventory, accounted balance, and raw BIT balance all reconcile and equal zero; and
- user-escrow locked liabilities and raw BIT balance reconcile and equal zero.

Use the credential-safe `npm run observe:testnet-deployment-postflight` workflow. The result binds every canonical receipt and all six accounting fields to the exact plan, preflight, provider identity, and finalized state anchor. A pre-funded deployment is ineligible even when its internal accounting is consistent. The separate [signed deployment-manifest promotion](./DEPLOYMENT_PROMOTION.md) remains required for review-artifact and findings-disposition evidence.

Only then can the seven-day public-testnet campaign begin. Opening the gate or adding test inventory requires the separate signed release boundary. This file and its CLIs never grant that permission.

## Trust boundary

The workflow proves deterministic reviewed calldata and cryptographic agreement over exact live preflight and postflight packages. Different labels, identity commitments, endpoints, or signing keys do not themselves prove organizational independence. It does not prove hardware custody, provider truth, Safe signing policy, review quality, monitor availability, Lightning readiness, or asset solvency. A compromised compiler or host remains possible; independent rebuilds, signed artifact digests, external review, and cryptographic release binding are still mandatory. Mainnet requires a later plan bound to the reviewed live BIT deployment and completed public-testnet evidence; this Sepolia plan cannot be relabeled for mainnet.
