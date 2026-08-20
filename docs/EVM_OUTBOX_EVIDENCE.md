# EVM claim-outbox evidence

Status: controlled local execution-client evidence passes. Independent RPC backends, the pinned live BIT fork, public testnet, and deployed relayer operation remain funding gates.

## Safety boundary

An EVM claim is bound to one EIP-1559 transaction hash before broadcast. The coordinator may reconstruct and rebroadcast only the same signed bytes; it cannot change the signer, nonce, fee, contract, reservation, or preimage. Every broadcast outcome remains `UNKNOWN` until reconciliation.

The unattended daemon requires exactly two reconciliation providers with different labels and URL origins. Both providers perform read-only checks against the exact transaction, canonical inclusion, runtime code, receipt, claim event, and finalized head. No inclusion or action transition is written while those observations are in progress. A provider outage or any difference in the normalized safety result leaves the action `UNKNOWN`; exact agreement causes one durable transition.

Different URL origins are only a configuration floor. They do not prove different operators, infrastructure, upstream nodes, or failure domains. Production evidence must identify and independently review both provider backends.

## Controlled campaign

Run:

```sh
npm run test:evm-outbox-faults
```

The campaign starts two isolated Anvil `1.7.1` chains and a bounded loopback proxy, deploys a real claim surface, and proves:

- a real signed claim becomes successful only after the execution client's genuine `finalized` tag reaches its canonical inclusion;
- two read-only observations of one backend agree and cause exactly one durable confirmation;
- divergent local chains disagree before any durable inclusion or action-state mutation, and reconciliation succeeds only after agreement is restored;
- a higher-fee same-nonce replacement is mined while the bound claim remains unexecuted and `UNKNOWN`; recovery attempts only the original byte-identical transaction and never manufactures a fee bump;
- substituting a new relayer key into an already bound action fails before broadcast, while a newly prepared action bound to the rotated relayer finalizes; and
- SQLite, WAL, and shared-memory files contain none of the campaign preimages.

The deterministic campaign evidence digest is `0x9af0dadc8c5249949111b90eb0736fdb4fe2f683ef460d37fc69229faf4edd3b`.

Published checkpoint `cd2a81c0f5ecc7ab1902a1fa576d71f4c7520509` passed 226 application/security tests, 74 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both build paths, this execution-client campaign, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32339918956). Its 27-campaign sealed qualification ran from `2026-08-20T06:32:18.096Z` through `2026-08-20T07:39:19.663Z` and independently reconstructs to `sha256:f0e362260e813c3880b4328800a074c8f57df1459ec6b37a045369a718d17e5a`. The ignored mode-`0600` record explicitly grants no funding authorization.

## Explicit limitations

The two agreeing origins in the success path intentionally share one local Anvil backend, so the record states `independentProviderBackends: false`. The second isolated chain proves only the disagreement path. The campaign contains no public-testnet transaction, live BIT contract, independent provider, production key, or funding authorization.

Before funded testnet, repeat the exact transaction, replacement, provider-outage/disagreement, finality, and relayer-rotation cases against the pinned live BIT fork and a public testnet using two independently operated authenticated providers. Retain deployment identities, provider ownership, transaction and block commitments, alert delivery, and reviewer sign-off in the deployment evidence without storing claim preimages or RPC credentials.
