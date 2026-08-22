# Signed BIT provider evidence

Status: TreeSwap can prepare and verify one short-lived, two-provider EIP-712 handoff over the exact live BIT observations and comparison. No real independent provider, signer, organization, review, deployment, or funding authorization is included.

## What this boundary adds

The unsigned comparison remains useful for diagnostics, but a coordinator could otherwise invent two labels and identity commitments. The signed provider-evidence boundary requires exactly two provider approvers to sign the same canonical record and policy. It binds:

- both complete normalized observations and their exact digests;
- the eligible comparison and its exact digest;
- the published TreeSwap source commit;
- Ethereum mainnet, the BIT proxy, and the exact finalized block number and hash;
- each provider identity, signing address, organization commitment, retained identity-evidence digest, and retained service-evidence digest; and
- a validity window no longer than one hour.

Provider signers must be nonzero and distinct. Every provider identity, organization commitment, identity-evidence digest, and service-evidence digest must also be globally distinct, and provider entries must be canonically ordered. Extra fields, changed observations, a rebuilt comparison mismatch, wrong source or contract, stale or future evidence, excessive lifetime, duplicated or substituted signers, replayed signatures, endpoints, credentials, output overwrite, and symlinked or oversized inputs fail closed.

The candidate and verified summary are mode `0600`, non-overwriting, and secret-free. The signing-payload command never accesses a key. The verified summary contains no raw signature, provider URL, account credential, or private retained evidence. It always reports:

```json
{
  "independenceStatus": "requires-external-organizational-verification",
  "fundingAuthorization": false
}
```

## Operator ceremony

Each provider operator must use a separate clean checkout of the canonical repository, fetch `origin/main`, and capture the same finalized block as described in [Production readiness](./PRODUCTION_READINESS.md). Never put RPC URLs, API keys, identity documents, commercial agreements, or private keys in the policy, candidate, attestations, repository, issue, PR, or chat.

Create a private policy file whose `sourceCommit` is the exact current `origin/main`. Commitments are nonzero lowercase `bytes32` hashes of retained evidence, not the evidence itself. The provider list must be sorted by `providerIdentity`:

```json
{
  "schema": "treeswap.bit-provider-evidence-policy.v1",
  "chainId": 1,
  "verifyingContract": "0x57A447E4d5e18A9423408C365963A73F08B9d18C",
  "sourceCommit": "<exact-40-character-origin-main-commit>",
  "maximumEvidenceLifetimeSeconds": 3600,
  "providerApprovers": [
    {
      "providerIdentity": "<provider-a-bytes32>",
      "organizationId": "<provider-a-organization-commitment>",
      "signer": "<provider-a-checksummed-address>",
      "identityEvidenceDigest": "<provider-a-retained-identity-evidence-digest>",
      "serviceEvidenceDigest": "<provider-a-retained-service-control-evidence-digest>"
    },
    {
      "providerIdentity": "<provider-b-bytes32>",
      "organizationId": "<provider-b-organization-commitment>",
      "signer": "<provider-b-checksummed-address>",
      "identityEvidenceDigest": "<provider-b-retained-identity-evidence-digest>",
      "serviceEvidenceDigest": "<provider-b-retained-service-control-evidence-digest>"
    }
  ]
}
```

Before either provider captures live state, run the deterministic [BIT review ceremony preflight](./BIT_CEREMONY_PREFLIGHT.md) over this policy, the prepared reviewer policy, all seven review-artifact commitments, and finding counts. Every participant should reproduce and compare the same preflight digest from a separate clean checkout. A preflight is static validation only and cannot substitute for either live observation or signature.

Prepare one exact candidate while both observations are fresh:

```sh
npm run prepare:bit-provider-evidence -- \
  --policy provider-policy.json \
  bit-observation-a.json \
  bit-observation-b.json \
  --out bit-provider-candidate.json
```

Each operator independently inspects the complete candidate, reproduces the comparison, checks the retained policy evidence out of band, and prepares only their own signing payload:

```sh
npm run prepare:bit-provider-attestation -- \
  --candidate bit-provider-candidate.json \
  --provider-identity <that-operator-provider-identity>
```

The operator signs the displayed EIP-712 payload in a trusted wallet. Combine the two results in a private JSON array, strictly ordered by `providerIdentity`:

```json
[
  {
    "providerIdentity": "<provider-a-bytes32>",
    "signer": "<provider-a-checksummed-address>",
    "signature": "<provider-a-signature>"
  },
  {
    "providerIdentity": "<provider-b-bytes32>",
    "signer": "<provider-b-checksummed-address>",
    "signature": "<provider-b-signature>"
  }
]
```

Verify the complete set before its one-hour expiry:

```sh
npm run verify:bit-provider-evidence -- \
  --candidate bit-provider-candidate.json \
  --attestations bit-provider-attestations.json \
  --out bit-provider-summary.json
```

The verified summary is a review input only. The [BIT independent-review ceremony](./BIT_INDEPENDENT_REVIEW.md) must re-verify the complete provider candidate and both attestations in-process; a copied summary has no provenance. Neither boundary can be used as a deployment promotion, release approval, gate-opening instruction, or funding authorization.

## External facts still required

Two valid keys do not prove two organizations or two independently controlled RPC backends. Before this evidence may enter review, the two roles in [BIT independent review evidence](./BIT_INDEPENDENT_REVIEW.md) must inspect the retained operator identities, corporate/control relationships, provider agreements or account-control records, endpoint ownership and upstream architecture, signer custody, and the complete source/compiler/roles/storage/upgrade bundle. Both reviewers bind their conclusions, exact report commitments, reconciled findings, and the complete signed provider record into one short-lived EIP-712 package.
