# Reviewed BIT deployment manifest

Status: TreeSwap can now derive one exact, short-lived BIT deployment manifest from the complete live [provider evidence](./BIT_PROVIDER_EVIDENCE.md) and [independent review evidence](./BIT_INDEPENDENT_REVIEW.md) in one process. The repository includes no real second provider, reviewer, retained report, organizational-independence finding, production deployment, or funding authorization.

## Purpose

The provider and review signatures already bind the right facts, but their verified objects previously exposed only digests to later code. Reconstructing an operational BIT manifest from a saved provider candidate would have required trusting serialized data again. The reviewed-manifest boundary closes that repository gap.

It accepts only the module-private provider and review verification objects created during the current process. It then links and retains:

- exact clean published source commit, Ethereum chain, and BIT proxy;
- canonical finalized block and EIP-1898 state anchor;
- proxy address and runtime hash;
- EIP-1967 implementation slot, address, and runtime hash;
- symbol, decimals, and pause state;
- both provider identities, observation digests, observation times, and independently observed finalized heads;
- provider record, policy, set, and comparison digests;
- all seven review-artifact digests, finding counts, and review evidence digests; and
- both reviewer roles, identities, organization commitments, signers, and identity-evidence commitments.

The canonical manifest digest covers every field, including its promotion time and expiry. The retained summary includes enough non-secret data to reconstruct that digest independently. It contains no RPC endpoint or signature.

## Guarded derivation

Use one private mode-`0700` evidence directory outside the clean checkout. Validate and compare every static provider/reviewer input with the [BIT review ceremony preflight](./BIT_CEREMONY_PREFLIGHT.md) before either provider captures state. The preflight cannot enter manifest derivation. Before the resulting live provider/review evidence expires, run:

```sh
npm run promote:bit-reviewed-manifest -- \
  --provider-candidate bit-provider-candidate.json \
  --provider-attestations bit-provider-attestations.json \
  --review-candidate bit-review-candidate.json \
  --review-attestations bit-review-attestations.json \
  --out reviewed-bit-manifest.json
```

The command requires the canonical TreeSwap origin, branch `main`, a clean checkout, and exact equality between local `HEAD`, remote `origin/main`, and both candidates' source commit. It reads bounded non-symlink JSON, re-verifies both provider signatures and both reviewer signatures at one timestamp, derives the manifest without accepting a saved verification summary, checks source again, and writes one exclusive mode-`0600` output.

The command does not access a key, sign a transaction, make an RPC request, deploy a contract, open a gate, broadcast a transaction, or fund inventory.

## Fail-closed rules

Promotion fails when either verification lacks live module-private provenance; provider and review records disagree on source, chain, proxy, finalized block, comparison, or provider evidence; promotion predates verification; either evidence package is expired; the promotion is unreasonably future-dated; source changes during the command; an input is oversized, a symlink, malformed, duplicated, or substituted; or the output already exists.

Cloning or deserializing a provider verification, review verification, or promoted verification destroys its provenance. A saved manifest cannot be used as verified input to create another manifest or release capability.

## Authority boundary

Every output says:

```json
{
  "scope": "reviewed-mainnet-bit-deployment-no-funding-authorization",
  "providerIndependenceStatus": "reviewer-attested-requires-retained-evidence-audit",
  "fundingAuthorization": false
}
```

“Cryptographically reviewed” means the configured keys signed the linked evidence. It does not prove that providers use independent backends, organizations are unrelated, reviewers are competent, reports are truthful, signers use hardware custody, or BIT has remained unchanged after the finalized block. Operators must retain and independently inspect the real evidence.

This is the reviewed manifest for the external BIT token deployment only. It is not the separately required TreeSwap gate, registry, escrow, and Safe deployment manifest; it does not satisfy Sepolia postflight, public-testnet release, or future mainnet-release requirements. Funded operation remains closed.

## Local qualification checkpoint

Clean published source [`83f669d6c25b1814554cbdf17b640b704843bcff`](https://github.com/bobofbuilding/treeswap/commit/83f669d6c25b1814554cbdf17b640b704843bcff) passed 422 application/security tests with no skips, both production web build paths, 68 contract tests, all 41 sealed local campaigns, [hosted main-branch CI](https://github.com/bobofbuilding/treeswap/actions/runs/32568051678), and exact production deployment [`dpl_FtJvBKWtWjTHqA5ZSrbVonpzYVSh`](https://treeswap-pze2nd89b-bittrees-tech.vercel.app), also served through [the canonical alias](https://treeswap.vercel.app). The sealed qualification ran from `2026-08-22T10:39:12.817Z` through `2026-08-22T11:48:39.941Z`. Its ignored mode-`0600` evidence independently reconstructs to `sha256:54b8bfbb76603f0e847a421f97a9c7d5fc7ff3b8972e4cc2334607b2356415cc`; all 133 configuration hashes, 41 unique passed campaigns, three pinned images, canonical clean remote-`main` binding, privacy exclusions, and empty regtest teardown reproduce. The production-duration Lightning campaign passed 3,603 monotonic seconds, 119 observations, midpoint restart persistence, deterministic stale-chain rejection, and zero dispatch.

This checkpoint proves the repository derivation boundary and local fault campaigns only. The evidence remains `local-only-no-funding-authorization`, uses a simulated EVM reservation, and includes no real second provider, external reviewer, retained review report, organizational-independence finding, public testnet, production coordinator infrastructure, TreeSwap deployment, or funding authorization.
