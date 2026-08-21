# Signed closed-deployment postflight

Status: the repository can reconstruct and cryptographically verify one finalized Sepolia deployment execution against its exact signed preflight. No public-testnet deployment, independent provider, Safe, signer, transaction, inventory, gate-opening permission, or funding authorization is included.

## What it proves

The postflight refuses a state-only success claim. Each provider independently proves all of the following:

- the original preflight signatures were valid, the plan was exact, the signed preflight block is still canonical, and every execution occurred after its anchored block timestamp and before its fifteen-minute expiry;
- the four contract-creation transactions used the exact deployer, consecutive planned nonces, zero value, reviewed init-code hashes, expected addresses, successful receipts, and strict order;
- the next three receipts called the reviewed controller Safe's standard `execTransaction`, with `CALL`, zero value, the exact registry target and calldata, and no Safe gas-token refund;
- each controller receipt contains exactly one `ExecutionSuccess` from that Safe and exactly one expected registry event: vault registration, user-escrow registration, then irreversible seal;
- every transaction and receipt agrees with its canonical block, all seven hashes are unique and ordered, and the selected state block is finalized after them;
- the single-purpose deployer remains code-empty, with anchored and before/after pending nonce equal to `startingNonce + 4`; and
- the finalized v2 manifest matches the reviewed deployment policy, gate and topology, uses the exact EIP-1967 BIT implementation, and has zero vault inventory, zero escrow liabilities, and zero raw BIT balances.

The transaction input file is public and secret-free:

```json
{
  "schema": "treeswap.closed-testnet-deployment-execution-transactions.v1",
  "deployments": [
    { "name": "gate", "transactionHash": "0x..." },
    { "name": "paymentHashRegistry", "transactionHash": "0x..." },
    { "name": "vault", "transactionHash": "0x..." },
    { "name": "userEscrow", "transactionHash": "0x..." }
  ],
  "controllerActions": [
    { "name": "register-vault", "transactionHash": "0x..." },
    { "name": "register-user-escrow", "transactionHash": "0x..." },
    { "name": "seal-registry", "transactionHash": "0x..." }
  ]
}
```

## Capture two observations

Run from the exact reviewed source. All JSON files are regular, non-symlink files no larger than 1 MB; outputs are new mode-`0600` files. The RPC endpoint stays only in the environment.

Provider one selects a finalized block:

```sh
ETHEREUM_RPC_URL=<authenticated-secret> \
ETHEREUM_RPC_PROVIDER_LABEL=<operator-label> \
ETHEREUM_RPC_PROVIDER_IDENTITY=<public-bytes32-identity-commitment> \
npm run observe:testnet-deployment-postflight -- \
  --plan unsigned-plan.json \
  --preflight-policy preflight-policy.json \
  --preflight-record preflight-record.json \
  --preflight-observations preflight-observations.json \
  --preflight-attestations preflight-attestations.json \
  --deployment-policy deployment-policy.json \
  --transactions execution-transactions.json \
  --out postflight-provider-1.json
```

An independently operated second provider must inspect the exact first provider's finalized block by adding `--block <number>`. Place both results in an array ordered by `providerIdentity`. Different URLs, labels, commitments, or signing keys are not proof of organizational independence; retain provider contracts and operator evidence separately.

## Approve the exact result

The `treeswap.closed-testnet-deployment-postflight-policy.v1` policy must retain the exact provider and operations-reviewer IDs and signers from the preflight, require two to five providers, and add exactly one distinct contract reviewer. Observations may be at most one hour old. The postflight record may live for at most one day.

Prepare the record:

```sh
npm run prepare:testnet-deployment-postflight -- \
  --plan unsigned-plan.json \
  --preflight-policy preflight-policy.json \
  --preflight-record preflight-record.json \
  --preflight-observations preflight-observations.json \
  --preflight-attestations preflight-attestations.json \
  --deployment-policy deployment-policy.json \
  --policy postflight-policy.json \
  --observations postflight-observations.json \
  --postflight-id <fresh-random-bytes32> \
  --out postflight-record.json
```

Each provider, the retained operations reviewer, and the independent contract reviewer reconstructs the typed payload with `npm run prepare:testnet-deployment-postflight-approval`. That command never signs. After external EIP-712 signing, place attestations in canonical `role:approverId` order and verify with:

```sh
npm run verify:testnet-deployment-postflight -- \
  --plan unsigned-plan.json \
  --preflight-policy preflight-policy.json \
  --preflight-record preflight-record.json \
  --preflight-observations preflight-observations.json \
  --preflight-attestations preflight-attestations.json \
  --deployment-policy deployment-policy.json \
  --policy postflight-policy.json \
  --record postflight-record.json \
  --observations postflight-observations.json \
  --attestations postflight-attestations.json
```

The output is a provenance-bound, privacy-safe summary. Copying or editing it destroys module-private provenance. It cannot sign, broadcast, open the gate, or authorize funding.

## Remaining boundary

This postflight proves exact transaction history plus finalized empty state. The separate [deployment-manifest promotion](./DEPLOYMENT_PROMOTION.md) still binds the external review-artifact set and findings disposition used by release authorization. Both ceremonies are required. The repository does not yet make a release capability cryptographically depend on this postflight; that binding remains a release-blocking implementation step. Real provider independence, hardware custody, Safe policy, monitor delivery, public-testnet operations, incident drills, and external review remain evidence gates.
