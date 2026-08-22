# BIT review ceremony preflight

Status: deterministic static-input validation is implemented for the short-lived two-provider/two-reviewer BIT ceremony. It includes no RPC observation, signature, retained report, organizational-independence finding, reviewed manifest, or funding authorization.

## Purpose

Live BIT provider evidence expires after at most one hour, and the independent review must retain at least five minutes inside that same window. Provider/reviewer overlap, a malformed policy, a repeated artifact commitment, an unsafe finding count, or a source mismatch must therefore be found before live capture begins—not while evidence is already expiring.

The preflight validates the exact static inputs used later by the [provider evidence](./BIT_PROVIDER_EVIDENCE.md) and [independent review](./BIT_INDEPENDENT_REVIEW.md) ceremonies:

- two canonically ordered provider identities, signers, organizations, identity-evidence commitments, and service-control commitments;
- two canonically ordered reviewer roles, identities, signers, organizations, and identity-evidence commitments;
- exact Ethereum mainnet, BIT proxy, and clean published source binding;
- all seven distinct source/compiler/roles/upgrade/provider-independence/findings artifacts;
- zero critical, high, and open findings;
- no signer, organization, identity, evidence, or artifact commitment reuse across either provider and either reviewer; and
- an effective review window of at least five minutes after applying both policies.

That last check is a configured ceiling, not elapsed-time evidence. Live review preparation still refuses to proceed unless at least five actual minutes remain in the verified provider package.

## Run before live capture

Keep the four inputs in a private mode-`0700` evidence directory outside the checkout. Store only nonzero lowercase `bytes32` commitments in them; keep identity documents, provider agreements, reports, endpoints, credentials, and private keys elsewhere.

From an exact clean `main` checkout currently published at the canonical TreeSwap origin, run:

```sh
npm run preflight:bit-review-ceremony -- \
  --provider-policy provider-policy.json \
  --review-policy bit-review-policy.json \
  --artifacts bit-review-artifacts.json \
  --findings bit-review-findings.json \
  --out bit-review-preflight.json
```

The guarded command reads bounded non-symlink JSON, rejects duplicate or unknown controls, checks the current remote `main` before and after validation, refuses overwrite, and writes mode `0600`. Each of the four participants should reproduce the output from a separate clean checkout and compare `preflightDigest` out of band before either provider captures an observation.

The deterministic summary contains only source/chain/contract binding, policy/set/artifact/finding digests, counts, the effective time ceiling, finding counts, and these exact limitations:

```json
{
  "status": "static-inputs-valid",
  "liveEvidenceIncluded": false,
  "externalIndependenceVerified": false,
  "fundingAuthorization": false
}
```

Do not put the summary into a release record. No later verifier accepts it as provider, review, manifest, deployment, or funding provenance.

## Live order after preflight

1. Provider A captures one finalized observation from its independently controlled authenticated backend.
2. Provider B captures the exact same block from its independently controlled authenticated backend.
3. Prepare the provider candidate and have both providers independently reproduce and sign it.
4. Verify both provider signatures.
5. Prepare the independent-review candidate from the original provider candidate and signatures, then have both reviewers independently reproduce and sign it.
6. Verify both reviewer signatures and derive the [reviewed BIT deployment manifest](./BIT_REVIEWED_MANIFEST.md) in the same process before expiry.

Any changed static input invalidates the compared preflight digest and requires all participants to preflight again before a new live capture.

## Authority boundary

The preflight proves only that one exact set of static commitments passes repository rules. It does not prove that a provider is independent, a signer has authority, a report exists or is accurate, findings are complete, a key is hardware-backed, BIT stayed unchanged, or any deployment is safe. It cannot observe RPC state, access a key, produce a signing payload, sign, broadcast, deploy, open a gate, or fund inventory.

## Local qualification checkpoint

Clean published source [`83f669d6c25b1814554cbdf17b640b704843bcff`](https://github.com/bobofbuilding/treeswap/commit/83f669d6c25b1814554cbdf17b640b704843bcff) passed 422 application/security tests with no skips, both production web build paths, 68 contract tests, all 41 sealed local campaigns, [hosted main-branch CI](https://github.com/bobofbuilding/treeswap/actions/runs/32568051678), and exact production deployment [`dpl_FtJvBKWtWjTHqA5ZSrbVonpzYVSh`](https://treeswap-pze2nd89b-bittrees-tech.vercel.app), which serves the HTTP-200 [canonical alias](https://treeswap.vercel.app). The qualification ran from `2026-08-22T10:39:12.817Z` through `2026-08-22T11:48:39.941Z`. Its ignored mode-`0600` evidence independently reconstructs to `sha256:54b8bfbb76603f0e847a421f97a9c7d5fc7ff3b8972e4cc2334607b2356415cc`; all 133 configuration hashes, 41 unique passed campaigns, three pinned images, clean remote-`main` binding, privacy exclusions, and empty regtest teardown reproduce. The production-duration Lightning campaign passed 3,603 monotonic seconds, 119 observations, midpoint restart persistence, deterministic stale-chain rejection, and zero dispatch.

This checkpoint proves the repository and local fault boundaries only. It remains `local-only-no-funding-authorization`, uses a simulated EVM reservation, and includes no independently operated provider, external reviewer or retained report, organizational-independence finding, public testnet, production coordinator infrastructure, TreeSwap deployment, inventory, or funding authorization.
