# Signed deployment-manifest promotion

Status: the repository can now verify promotion of matching finalized deployment observations into candidate reviewed-manifest evidence. No independent provider, reviewer, deployed public-testnet contract, Safe, hardware signer, or funding authorization is included.

## Purpose

An RPC observation is not a reviewed deployment manifest. A label such as “provider two,” a matching JSON file, or a copied `eligible: true` result cannot prove who observed the deployment, which policy was applied, which reviews were completed, or what exact finalized block was approved.

`lib/deployment-manifest-promotion.mjs` therefore requires one exact `treeswap.deployment-promotion-record.v1` under one exact `treeswap.deployment-promotion-policy.v1`. The record binds:

- the environment, chain, gate, reviewed source commit, exact deployment-policy digest, and exact manifest digest;
- one canonical finalized block number and hash;
- at least two canonically ordered provider identities and their exact observation digests;
- nonzero review digests for matched source bundles, compiler inputs, roles and storage, upgrade behavior, provider independence, and findings disposition;
- observations no more than one hour old when promoted and a promotion valid for no more than one day; and
- distinct provider signers plus exactly one distinct contract reviewer and one distinct operations reviewer.

The verifier rechecks every observation rather than trusting a comparison result. All providers must report the identical source, chain, finalized block, canonical EIP-1898 anchor, manifest, and manifest digest. It then applies the strict deployment policy to the observed closed gate, role-separated contract wallets, sealed two-escrow registry, immutable escrows, BIT proxy and implementation, EIP-1967 slot, bytecode hashes, fee and price limits, and reference price.

The aggregate review-bundle digest must be the exact `independentReviewDigest` in both the observed manifest and deployment policy. Any changed review artifact, observation, policy, code hash, signer, validity window, or block invalidates every approval.

## Promotion ceremony

1. Freeze the reviewed source commit and exact deployment policy. Complete and retain the six review artifacts; only their nonzero digests enter the promotion record.
2. Observe the same canonical finalized deployment block through at least two independently operated authenticated providers. Do not treat two endpoints backed by one operator or execution backend as independent.
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

Unknown fields, an unreviewed status change, one provider, duplicate identities, shared signer identities, missing reviewer roles, noncanonical ordering, disagreement, stale or future observations, an unfinalized or noncanonical anchor, the wrong EIP-1967 slot, topology or code drift, an unsealed registry, an open gate, a review mismatch, replayed signatures, expired promotion, secret-bearing fields, endpoints, invoices, and private-key material all fail closed. Input files used by the CLIs must be regular non-symlink JSON files no larger than 1 MB.

Module-private provenance protects the derived release mapping. A copied or reconstructed verification object cannot create candidate evidence. The mapping is explicitly scoped `candidate-release-evidence-no-funding-authorization`; it cannot open the gate, fund a solver, sign a release, or promote itself into production.

## Trust boundary

Signatures prove that the listed keys approved the exact promotion record and policy. They do not prove provider ownership, organizational independence, reviewer competence, artifact truth, Safe owner custody, or hardware-key use. Those facts require retained external evidence and human review. Until the real deployment, providers, reviewers, and signatures exist, the corresponding launch-checklist items remain open.
