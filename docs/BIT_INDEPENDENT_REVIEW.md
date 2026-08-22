# BIT independent review evidence

Status: TreeSwap can bind two separately controlled reviewer approvals to the exact, still-live [signed BIT provider evidence](./BIT_PROVIDER_EVIDENCE.md), source/compiler artifacts, roles and storage analysis, upgrade analysis, provider-independence report, findings disposition, and finalized block. No real provider, reviewer, report, organizational-independence finding, deployment promotion, or funding authorization is included.

## Purpose

Provider signatures prove that two named keys approved the same observations. They do not prove that the providers are independent, that the published proxy and implementation source reproduce the observed runtime, or that the upgrade, pause, role, and storage behavior has been reviewed.

The BIT independent-review boundary requires two exact roles:

- `contract-security-reviewer` checks the proxy and implementation source bundles, compiler input, runtime reproduction, immutables, EIP-1967 implementation slot, roles, storage layout, pause behavior, and upgrade authority; and
- `provider-independence-reviewer` checks the retained provider identities, organizational/control relationships, account and service control, upstream execution architecture, and signer custody.

Both reviewers sign the same canonical record and policy. Reviewer identities, organizations, identity-evidence commitments, and signers must be distinct from one another. They also may not reuse any provider signer, provider organization, or provider identity/evidence commitment. Signatures prove approval by the configured keys; they do not prove reviewer competence, organizational facts, custody, or report truth. Those facts remain subject to retained-evidence audit.

## Exact inputs

Complete the substantive review before the live ceremony. Keep every candidate, policy, attestation, report, and summary in a private mode-`0700` evidence directory outside the clean checkout. Retain the full reports outside the repository and use only nonzero lowercase `bytes32` commitments in the secret-free inputs.

The artifact file has this exact shape, with seven globally distinct digests:

```json
{
  "compilerInputDigest": "<bytes32>",
  "findingsDispositionDigest": "<bytes32>",
  "implementationSourceBundleDigest": "<bytes32>",
  "providerIndependenceReportDigest": "<bytes32>",
  "proxySourceBundleDigest": "<bytes32>",
  "rolesAndStorageReportDigest": "<bytes32>",
  "upgradeBehaviorReportDigest": "<bytes32>"
}
```

The finding-count file has this exact shape:

```json
{
  "critical": 0,
  "high": 0,
  "informational": 0,
  "low": 0,
  "medium": 0,
  "open": 0
}
```

Critical, high, or open findings fail closed. Medium and lower findings may be counted only when the exact disposition artifact is retained and committed.

The policy must name exactly two canonically ordered reviewers:

```json
{
  "schema": "treeswap.bit-independent-review-policy.v1",
  "chainId": 1,
  "verifyingContract": "0x57A447E4d5e18A9423408C365963A73F08B9d18C",
  "sourceCommit": "<exact-current-origin-main-commit>",
  "maximumReviewLifetimeSeconds": 3600,
  "reviewApprovers": [
    {
      "role": "contract-security-reviewer",
      "reviewerIdentity": "<bytes32>",
      "organizationId": "<bytes32>",
      "signer": "<checksummed-address>",
      "identityEvidenceDigest": "<bytes32>"
    },
    {
      "role": "provider-independence-reviewer",
      "reviewerIdentity": "<bytes32>",
      "organizationId": "<bytes32>",
      "signer": "<checksummed-address>",
      "identityEvidenceDigest": "<bytes32>"
    }
  ]
}
```

## Short-lived ceremony

The signed provider evidence expires after at most one hour. Prepare review artifacts and policy in advance, then capture provider observations and complete every signature from separate clean checkouts within the same validity window. Candidate preparation refuses to begin with less than five minutes remaining; the review policy may shorten but never extend the provider deadline.

Prepare a private, non-overwriting mode-`0600` review candidate. This command re-verifies both provider signatures in-process and refuses a copied provider summary:

```sh
npm run prepare:bit-independent-review -- \
  --provider-candidate bit-provider-candidate.json \
  --provider-attestations bit-provider-attestations.json \
  --policy bit-review-policy.json \
  --artifacts bit-review-artifacts.json \
  --findings bit-review-findings.json \
  --out bit-review-candidate.json
```

Each reviewer independently rechecks the complete input set and prepares only their own EIP-712 payload:

```sh
npm run prepare:bit-independent-review-attestation -- \
  --candidate bit-review-candidate.json \
  --provider-candidate bit-provider-candidate.json \
  --provider-attestations bit-provider-attestations.json \
  --role contract-security-reviewer
```

The command never accesses a private key. After each reviewer signs through a separately controlled wallet, combine the results in strict role order:

```json
[
  {
    "role": "contract-security-reviewer",
    "reviewerIdentity": "<bytes32>",
    "signer": "<checksummed-address>",
    "signature": "<signature>"
  },
  {
    "role": "provider-independence-reviewer",
    "reviewerIdentity": "<bytes32>",
    "signer": "<checksummed-address>",
    "signature": "<signature>"
  }
]
```

Verify the complete set before provider evidence expiry:

```sh
npm run verify:bit-independent-review -- \
  --candidate bit-review-candidate.json \
  --provider-candidate bit-provider-candidate.json \
  --provider-attestations bit-provider-attestations.json \
  --attestations bit-review-attestations.json \
  --out bit-review-summary.json
```

Every CLI requires the exact clean commit currently published at the canonical TreeSwap `origin/main`, uses bounded non-symlink JSON inputs, refuses ambiguous duplicate controls, and revalidates source before retaining output. Candidate and summary outputs are mode `0600` and non-overwriting.

## Fail-closed boundary

Unknown or extra fields, legacy or changed schemas, copied provider verification, provider expiry, extended review lifetime, wrong source, chain, contract, finalized block, comparison, provider record, policy or set, reused reviewer/provider control, missing reviewer roles, noncanonical order, duplicated evidence commitments, artifact substitution, critical/high/open findings, wrong or replayed signatures, expiry, future dating, secrets, endpoints, symlinks, oversized inputs, and output overwrite all fail closed.

The verified summary always reports `fundingAuthorization: false` and `providerIndependenceStatus: "reviewer-attested-requires-retained-evidence-audit"`. It is a review handoff only. It cannot deploy contracts, promote a manifest, open a gate, activate release capabilities, or fund a solver.

## Local qualification checkpoint

Clean published source [`e893b65038cea566ecbd7a2c63795d6ab99abe7f`](https://github.com/bobofbuilding/treeswap/commit/e893b65038cea566ecbd7a2c63795d6ab99abe7f) passed 414 application/security tests with one intentional deployment-only skip, both production web build paths, 68 contract tests, all 39 sealed local campaigns, [hosted main-branch CI](https://github.com/bobofbuilding/treeswap/actions/runs/32559681865), and the exact [production deployment](https://treeswap-o24m03oo6-bittrees-tech.vercel.app). The qualification ran from `2026-08-22T07:31:35.891Z` through `2026-08-22T08:40:43.586Z`. Its ignored regular mode-`0600` evidence independently reconstructs to `sha256:ffb53940aa999e2cb4556d4cf5037a157697b31fb9a3c46744395f8ce9ca4b00`; all 130 configuration hashes, 39 unique passed campaigns, three pinned images, canonical clean remote-`main` binding, privacy exclusions, and empty regtest teardown reproduce. The uncompressed Lightning campaign held payment closed for 3,603 monotonic seconds across 119 no-progress observations and a midpoint adapter restart.

This checkpoint proves the repository boundary and local fault campaigns only. The evidence remains `local-only-no-funding-authorization`, uses a simulated EVM reservation, and includes no real second provider, external reviewer, retained review reports, organizational-independence finding, public testnet, production coordinator infrastructure, or funding authorization.
