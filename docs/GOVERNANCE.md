# Governance and deployment boundary

Status: immutable contracts, a fail-closed deployment policy, a finalized RPC observer, and a closed local deployment rehearsal are implemented. No production roles or contracts have been deployed.

TreeSwap’s two asset escrows have no administrator, proxy, fee setter, treasury setter, or pause function. Their token, payment-hash registry, safety gate, fee collector, reference limits, volume limits, and absolute fee caps are constructor immutables. The payment-hash registry accepts exactly two escrow consumers and is then irreversibly sealed.

Only the open gate has safety roles. Its controller and guardian must be different deployed contract wallets. Reopening always waits at least 24 hours, every opening expires within at most seven days, and every scheduling, opening, and halt emits an event. The guardian or controller may immediately block new exposure; neither can block a solver withdrawal, user refund, or valid claim already in progress.

Before deployment approval, a manifest must prove:

- distinct 2-of-3-or-stronger contract wallets for controller, guardian, and fee collection, including exact unique owner lists and no shared owner quorum;
- exact escrow, gate, registry, role-wallet, BIT proxy, and BIT implementation code hashes matching a separately reviewed policy;
- a sealed registry with exactly the two reviewed escrows;
- immutable non-proxy escrows bound to the exact BIT proxy, fee collector, gate, and registry, with reviewed price/reference limits and fees no higher than 5%;
- an exact reviewed source commit and independent-review digest matching policy; and
- a closed gate with a delay and maximum-open window inside policy.

`lib/deployment-observer.mjs` reconstructs those facts at one canonical finalized block. It reads contract-wallet owners and thresholds, EIP-1967 BIT implementation state, every runtime code hash, gate roles and closed state, both escrow immutable bindings and limits, and the sealed registry set. Two observations are eligible only when distinct provider identities agree on the exact block and canonical manifest digest.

## Local closed-deployment evidence

Run:

```sh
npm run test:deployment-rehearsal
```

The campaign deploys the actual TreeSwap gate, registry, vault, and user escrow to a fresh timed Anvil chain. Three distinct test-only wallet contracts expose disjoint three-owner/two-threshold role sets. The registry is sealed to the exact escrows, the gate remains emergency-closed with no staged reopen, and both escrows retain zero inventory and liabilities. Primary and proxy RPC identities reconstruct the same finalized manifest; a captured owner quorum fails policy, and production policy rejects the local chain, test token, test wallets, and absent independent review.

The deterministic campaign digest is `0xcab23fa2503054e2bc95c25238ac153f83f44f4f38b17cb316359972a4deef2a`. Both RPC identities share one local backend, the token is a test-only EIP-1967 probe, and the wallet executor is deliberately not a production multisig. This is reproducibility evidence only: it includes no public testnet, independent provider, hardware-backed signer, independent review, production infrastructure, inventory, liability, or funding authorization.

Live deployment remains blocked until real addresses, independently operated providers, hardware-backed owners, thresholds, reviewed hashes, and review evidence exist and a watcher alerts on every role or gate event.
