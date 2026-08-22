# Lightning close and sweep monitor

TreeSwap must stop new exposure whenever an LND node has an unresolved channel close, a pending HTLC, or a non-anchor sweep. The repository evaluator converts pinned LND `PendingChannels` and WalletKit `PendingSweeps` responses into one secret-free aggregate for the existing `lightning-node` safety domain. It never emits channel points, outpoints, transaction IDs, node keys, invoices, payment data, macaroons, or preimages.

The collector credential is a separate exact-role macaroon. Its close-monitor additions are read-only [`/lnrpc.Lightning/PendingChannels`](https://lightning.engineering/api-docs/api/lnd/lightning/pending-channels/) and [`/walletrpc.WalletKit/PendingSweeps`](https://lightning.engineering/api-docs/api/lnd/wallet-kit/pending-sweeps/). Payer and invoice credentials do not receive WalletKit access.

## Fail-closed classification

The aggregate is `unsafe` if either RPC response is malformed, the policy is malformed, the total limbo balance is nonzero, any cooperative/force/waiting close exists, any close has a pending HTLC, or any HTLC/non-anchor sweep exists. Treating limbo itself as unsafe prevents an incomplete close array from appearing healthy. A matured or deadline-reached non-anchor also receives the explicit `OVERDUE_NON_ANCHOR_SWEEP` reason. The resulting digest and unsafe status feed the normal safety monitor, which closes quote issuance, submits the same digest to the guardian halt path, and alerts only after attempting both closures. It has no reopen authority and does not block claims, refunds, or solver withdrawals.

Only pinned LND `COMMITMENT_ANCHOR` sweeps may remain healthy, and only under every bound below:

| Bound | v1 maximum/minimum |
| --- | ---: |
| value per anchor | 330 sats maximum |
| anchors per node | 4 maximum |
| aggregate anchor value per node | 1,320 sats maximum |
| age after reported maturity | 1,008 blocks maximum |
| broadcast attempts | 1,008 maximum |
| remaining LND sweep deadline | 144 blocks minimum |

An excepted anchor must also be matured, non-immediate, non-forced, have a positive fee budget no larger than its value, and have a future deadline. Crossing any single limit makes the observation unsafe. This is a bounded operational exception for an uneconomic output, not a claim that the output was recovered or can be ignored permanently.

## Local evidence

`npm run regtest:force-close-smoke` reads both RPCs through the exact observer macaroon, requires a healthy baseline, force-closes the only payer channel, requires an unsafe aggregate before any new dispatch, advances through the node-reported CSV maturity, and requires all non-anchor and pending-close exposure to clear. Service may recover with only anchors that meet every bound. The evidence is aggregate-only and feeds the same `lightning-node` safety observation used by the gate monitor.

The standalone filter accepts one exact JSON object on standard input:

```sh
npm run monitor:lightning-close < private-lnd-observation.json
```

The input file can contain private LND identifiers and must remain inside the operator trust domain; only the returned aggregate may enter shared monitoring evidence.

## Published local checkpoint

Source commit [`7a8cd7dd49ff67d007e8cb8b2e2fce44009804d8`](https://github.com/bobofbuilding/treeswap/commit/7a8cd7dd49ff67d007e8cb8b2e2fce44009804d8), reviewed in [PR #39](https://github.com/bobofbuilding/treeswap/pull/39), passed [main-branch CI](https://github.com/bobofbuilding/treeswap/actions/runs/32592074931) and exact Vercel production deployment [`dpl_59ULvwvs83ekjwz5psny1em3wCt8`](https://treeswap-nlb0iimdj-bittrees-tech.vercel.app). Its sealed qualification passed all 41 campaigns, including 3,603 seconds and 119 continuous observations with a midpoint adapter restart and zero dispatch, followed by the genuine force-close/CSV-sweep/bounded-anchor/replacement-channel campaign. The private mode-`0600` evidence independently reconstructs byte-for-byte to `sha256:91f0d1c75242d4112a3d0d77c2e64c505e234eac76c2c617c2ee3ae85e54aa2a`; all 140 configuration hashes and three immutable image pins reproduce, privacy checks pass, and no disposable lab volume remains.

This checkpoint is local-only. It does not supply independent collectors, production alert delivery, actual operator-node recovery evidence, public-testnet traffic, production infrastructure, inventory, or funding authorization.

## Deployment gate

Before funding, deploy at least two supervised collectors under independent service identities for every operator node, keep raw responses private, and set the generic safety monitor freshness window no longer than the collector schedule. Prove stale/missing/unsafe observations close both quote issuance and the deployed onchain gate, page two retained alert channels, and never block exits. Retain private operator evidence for an actual force close, anchor-limit breach, non-anchor overdue sweep, collector outage, and recovery. Reopening requires a new healthy observation set plus the signed release process; no collector can reopen the gate itself.
