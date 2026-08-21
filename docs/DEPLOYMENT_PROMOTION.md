# Signed deployment-manifest promotion

Status: the repository can verify promotion of matching finalized deployment observations into candidate reviewed-manifest evidence. Observation schema `treeswap.deployment-observation.v2` additionally binds the raw BIT balances and contract accounting at that same canonical block. No independent provider, reviewer, deployed public-testnet contract, Safe, hardware signer, or funding authorization is included.

Promotion validates finalized state and the external review-artifact set. It does not reconstruct the transactions that created that state. The separate [signed deployment postflight](./CLOSED_TESTNET_DEPLOYMENT_POSTFLIGHT.md) binds the exact preflight to all four creation receipts and three Safe receipts. Both ceremonies are required; making release authorization cryptographically require the postflight digest remains an open release blocker.

## Purpose

An RPC observation is not a reviewed deployment manifest. A label such as “provider two,” a matching JSON file, or a copied `eligible: true` result cannot prove who observed the deployment, which policy was applied, which reviews were completed, or what exact finalized block was approved.

`lib/deployment-manifest-promotion.mjs` therefore requires one exact `treeswap.deployment-promotion-record.v1` under one exact `treeswap.deployment-promotion-policy.v1`. The record binds:

- the environment, chain, gate, reviewed source commit, exact deployment-policy digest, and exact manifest digest;
- one canonical finalized block number and hash;
- at least two canonically ordered provider identities and their exact observation digests;
- nonzero review digests for matched source bundles, compiler inputs, roles and storage, upgrade behavior, provider independence, and findings disposition;
- observations no more than one hour old when promoted and a promotion valid for no more than one day; and
- distinct provider signers plus exactly one distinct contract reviewer and one distinct operations reviewer.

The verifier rechecks every observation rather than trusting a comparison result. All providers must report the identical source, chain, finalized block, canonical EIP-1898 anchor, manifest, and manifest digest. It then applies the strict deployment policy to the observed closed gate, role-separated contract wallets, sealed two-escrow registry, immutable escrows, BIT proxy and implementation, EIP-1967 slot, bytecode hashes, fee and price limits, reference price, and exact zero-balance postconditions. The vault's `totalAvailable`, `totalLocked`, `accountedBalance`, and raw BIT balance must all reconcile and equal zero. The user escrow's `totalLocked` and raw BIT balance must reconcile and equal zero. A consistent but pre-funded deployment is still rejected.

The aggregate review-bundle digest must be the exact `independentReviewDigest` in both the observed manifest and deployment policy. Any changed review artifact, observation, policy, code hash, signer, validity window, or block invalidates every approval.

## Promotion ceremony

1. Freeze the reviewed source commit and exact deployment policy. Complete and retain the six review artifacts; only their nonzero digests enter the promotion record.
2. Create one public, secret-free `treeswap.deployment-observation-input.v1` file containing exactly `schema`, `reviewedBuildCommit`, `independentReviewDigest`, and `addresses`. `addresses` contains the exact `bitProxy`, `controller`, `feeCollector`, `gate`, `guardian`, `paymentHashRegistry`, `userEscrow`, and `vault` addresses from the reviewed deployment package. Observe the latest finalized block through provider one:

```sh
ETHEREUM_RPC_URL=<authenticated-secret> \
ETHEREUM_RPC_PROVIDER_LABEL=<operator-label> \
ETHEREUM_RPC_PROVIDER_IDENTITY=<public-bytes32-identity-commitment> \
npm run observe:deployment-manifest -- \
  --input deployment-observation-input.json \
  --out provider-1.json
```

Provider two must be independently operated and must observe the exact first finalized block:

```sh
ETHEREUM_RPC_URL=<second-authenticated-secret> \
ETHEREUM_RPC_PROVIDER_LABEL=<second-operator-label> \
ETHEREUM_RPC_PROVIDER_IDENTITY=<second-public-bytes32-identity-commitment> \
npm run observe:deployment-manifest -- \
  --input deployment-observation-input.json \
  --block <provider-1-finalized-block-number> \
  --out provider-2.json
```

RPC URLs are accepted only through the environment and never written to evidence. Outputs are non-overwriting mode-`0600` files. Do not treat two endpoints backed by one operator or execution backend as independent.
3. Assemble the canonical record, policy, deployment policy, and ordered observation set. The deployment must still be closed and the payment-hash registry must already be irreversibly sealed to the two exact escrows.
4. Each listed provider operator and reviewer independently prepares the exact EIP-712 payload:

```sh
npm run prepare:deployment-promotion -- \
  --record promotion-record.json \
  --policy promotion-policy.json \
  --deployment-policy deployment-policy.json \
  --observations observations.json \
  --role provider \
  --approver-id 0x...
```

The command emits typed data only. It never accepts a private key or signs for an operator. Each approver signs with the separately controlled identity named in policy.

5. Collect one canonically ordered attestation per approver and verify the complete bundle:

```sh
npm run verify:deployment-promotion -- \
  --record promotion-record.json \
  --policy promotion-policy.json \
  --deployment-policy deployment-policy.json \
  --observations observations.json \
  --attestations attestations.json
```

The verifier returns the exact record and policy digests, a privacy-safe summary, and candidate deployment/provider/findings evidence. It returns no funding capability.

## Fail-closed boundary

Unknown fields, a legacy observation schema, an unreviewed status change, one provider, duplicate identities, shared signer identities, missing reviewer roles, noncanonical ordering, disagreement, stale or future observations, an unfinalized or noncanonical anchor, the wrong EIP-1967 slot, topology or code drift, an unsealed registry, an open gate, nonzero or unreconciled escrow balances, a review mismatch, replayed signatures, expired promotion, secret-bearing fields, endpoints, invoices, and private-key material all fail closed. Input files used by the CLIs must be regular non-symlink JSON files no larger than 1 MB.

Module-private provenance protects the derived release mapping. A copied or reconstructed verification object cannot create candidate evidence. The mapping is explicitly scoped `candidate-release-evidence-no-funding-authorization`; it cannot open the gate, fund a solver, sign a release, or promote itself into production.

## Local qualification evidence

Clean published source commit [`bcbf2b03e7064be136cb54a8c567f905abec8516`](https://github.com/bobofbuilding/treeswap/commit/bcbf2b03e7064be136cb54a8c567f905abec8516) passed 271 application/security tests, 91 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both web build paths, all 33 sealed local qualification campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32401732721). The sealed run lasted from `2026-08-20T18:12:50.167Z` through `2026-08-20T19:20:55.699Z`. Its ignored mode-`0600` evidence independently reconstructs to `sha256:cbb4f5b62033429e8db734a8fd98f29db6b4c444ccdf5ec18949f91059f90152`.

This proves the local promotion verifier, preparation and verification CLIs, negative signature and policy cases, and all earlier repository campaigns against the exact published source. The evidence explicitly records `publicTestnetIncluded: false`, `independentReviewIncluded: false`, `productionInfrastructureIncluded: false`, and `simulatedEvmReservation: true`. It is not a signed promotion and contains no real independent provider, reviewer, deployed contract, production Safe, hardware signer, inventory, or funding authorization.

## Trust boundary

Signatures prove that the listed keys approved the exact promotion record and policy. They do not prove provider ownership, organizational independence, reviewer competence, artifact truth, Safe owner custody, or hardware-key use. Those facts require retained external evidence and human review. Until the real deployment, providers, reviewers, and signatures exist, the corresponding launch-checklist items remain open.
