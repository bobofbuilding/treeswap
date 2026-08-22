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

## Deployment gate

Before funding, deploy at least two supervised collectors under independent service identities for every operator node, keep raw responses private, and set the generic safety monitor freshness window no longer than the collector schedule. Prove stale/missing/unsafe observations close both quote issuance and the deployed onchain gate, page two retained alert channels, and never block exits. Retain private operator evidence for an actual force close, anchor-limit breach, non-anchor overdue sweep, collector outage, and recovery. Reopening requires a new healthy observation set plus the signed release process; no collector can reopen the gate itself.
