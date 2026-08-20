# Governance and deployment boundary

Status: immutable contracts, a fail-closed deployment policy, a finalized RPC observer, a provider- and reviewer-signed manifest-promotion boundary, a closed local deployment rehearsal, and a cryptographic release-authorization boundary are implemented. No production roles, contracts, signed manifest promotion, or signed release record have been deployed.

TreeSwap’s two asset escrows have no administrator, proxy, fee setter, treasury setter, or pause function. Their token, payment-hash registry, safety gate, fee collector, reference limits, volume limits, and absolute fee caps are constructor immutables. The payment-hash registry accepts exactly two escrow consumers and is then irreversibly sealed.

Only the open gate has safety roles. Its controller and guardian must be different deployed contract wallets. Reopening always waits at least 24 hours, every opening expires within at most seven days, and every scheduling, opening, and halt emits an event. The guardian or controller may immediately block new exposure; neither can block a solver withdrawal, user refund, or valid claim already in progress.

Before deployment approval, a manifest must prove:

- distinct 2-of-3-or-stronger contract wallets for controller, guardian, and fee collection, including exact unique owner lists and no shared owner quorum;
- exact escrow, gate, registry, role-wallet, BIT proxy, and BIT implementation code hashes matching a separately reviewed policy;
- a sealed registry with exactly the two reviewed escrows;
- immutable non-proxy escrows bound to the exact BIT proxy, fee collector, gate, and registry, with reviewed price/reference limits and fees no higher than 5%;
- an exact reviewed source commit and independent-review digest matching policy; and
- a closed gate with a delay and maximum-open window inside policy.

Funding authorization is a separate later step. It requires one exact expiring release record and its exact policy digest approved by controller, guardian, Lightning operator, security reviewer, and incident commander. Controller and guardian ERC-1271 approvals must agree at one canonical finalized block across at least two configured provider identities and match the reviewed wallet runtime hashes. The record also binds external evidence, reviews, operator counts, feature exclusions, and exact risk limits. See [Release authorization boundary](./RELEASE_AUTHORIZATION.md).

`lib/deployment-observer.mjs` reconstructs those facts at one canonical finalized block. It reads contract-wallet owners and thresholds, EIP-1967 BIT implementation state, every runtime code hash, gate roles and closed state, both escrow immutable bindings and limits, and the sealed registry set. Two observations are eligible only when distinct provider identities agree on the exact block and canonical manifest digest.

Matching observations remain unreviewed until the [signed deployment-manifest promotion](./DEPLOYMENT_PROMOTION.md) ceremony passes. That boundary revalidates the deployment policy and exact observations, binds the review bundle and findings disposition, and requires every provider plus separate contract and operations reviewers to sign one short-lived EIP-712 record and policy. Its module-private result can derive candidate evidence only; it cannot open the gate or authorize funding.

## Closed Sepolia plan

The [closed public-testnet deployment workflow](./CLOSED_TESTNET_DEPLOYMENT.md) turns one exact reviewed input into four unsigned deterministic CREATE transactions and three hash-linked controller calls. Preparation and verification each require the exact clean commit already published on `origin/main`, force a fresh offline Foundry rebuild, compare artifact source commitments with that commit, and refuse any change to calldata or ordering. The generated plan grants no signing, broadcast, gate-opening, or funding authority.

This closes the repository-side deployment reproducibility gap. Real Sepolia wallets, hardware owners, BIT test deployment, independent providers, external review, nonce preflight, signing, broadcast, finalized observation, monitoring, and zero-balance confirmation remain external gates.

## Local closed-deployment evidence

Run:

```sh
npm run test:deployment-rehearsal
```

The campaign builds the same exact closed-deployment plan used by the operator workflow and executes its four generated transactions plus three ordered controller calls against a fresh timed Anvil chain. Three distinct test-only wallet contracts expose disjoint three-owner/two-threshold role sets. The registry is sealed to the exact escrows, the gate remains emergency-closed with no staged reopen, and both escrows retain zero inventory and liabilities. Primary and proxy RPC identities reconstruct the same finalized manifest; a captured owner quorum fails policy, and production policy rejects the local chain, test token, test wallets, and absent independent review.

The earlier deployment-observer checkpoint had deterministic campaign digest `0xcab23fa2503054e2bc95c25238ac153f83f44f4f38b17cb316359972a4deef2a`; the plan-backed rehearsal emits a new source-bound plan and evidence digest on every reviewed checkpoint. Both RPC identities share one local backend, the token is a test-only EIP-1967 probe, and the wallet executor is deliberately not a production multisig. This is reproducibility evidence only: it includes no public testnet, independent provider, hardware-backed signer, independent review, production infrastructure, inventory, liability, or funding authorization.

Published deployment-observer checkpoint `44d929e708768d8bbe53087b415eda0f4ac75f43` passed 239 application/security tests, 89 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both web builds, all 29 sealed local campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32360223386). The qualification ran from `2026-08-20T10:44:40.005Z` through `2026-08-20T11:52:49.730Z`; its independently reconstructed mode-`0600` evidence digest is `sha256:9a0bb29bc90d603327b56606603489247f2b3cab5f3be5ecad18d2cd8417d5e9`. It covers the closed local rehearsal and observer policy only. It records no independent provider, production multisig, public testnet, production infrastructure, independent review, or funding authorization.

Published signed-release checkpoint [`2e2917389b6191a4c62bdbe56f6bab9904141406`](https://github.com/bobofbuilding/treeswap/commit/2e2917389b6191a4c62bdbe56f6bab9904141406) passed 252 application/security tests, 91 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both web builds, all 31 sealed local campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32384877772). The qualification ran from `2026-08-20T15:15:57.828Z` through `2026-08-20T16:34:26.514Z`; its independently reconstructed ignored mode-`0600` evidence digest is `sha256:22011a8ab9c608dbbac34cc88b09074d9f4a562626666d33e208ae22922a6fa3`. It verifies the local five-role signed boundary and unforgeable funding capability, but includes no public testnet, independent providers, production multisigs or infrastructure, hardware signers, independent review, or funding authorization.

Published deployment-promotion source checkpoint [`bcbf2b03e7064be136cb54a8c567f905abec8516`](https://github.com/bobofbuilding/treeswap/commit/bcbf2b03e7064be136cb54a8c567f905abec8516) passed 271 application/security tests, 91 direct pinned-runtime tests plus bounded-filesystem rollback, 68 contract tests, both web builds, all 33 sealed local campaigns, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32401732721). The sealed qualification ran from `2026-08-20T18:12:50.167Z` through `2026-08-20T19:20:55.699Z`; its independently reconstructed ignored mode-`0600` digest is `sha256:cbb4f5b62033429e8db734a8fd98f29db6b4c444ccdf5ec18949f91059f90152`. It proves the local signed-promotion boundary only and records no public testnet, independent provider or reviewer, production infrastructure, hardware signer, or funding authorization.

Live deployment remains blocked until real addresses, independently operated providers, hardware-backed owners, thresholds, reviewed hashes, review and drill evidence, and continuous alerts exist. A copied verification object, nominal audit boolean, or arbitrary feature flag cannot replace the signed release record.
