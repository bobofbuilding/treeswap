# Lightning close and sweep monitor

TreeSwap must stop new exposure whenever an LND node has an unresolved channel close, a pending HTLC, or a non-anchor sweep. The repository evaluator converts pinned LND `PendingChannels` and WalletKit `PendingSweeps` responses into one secret-free aggregate for the existing `lightning-node` safety domain. It never emits channel points, outpoints, transaction IDs, node keys, invoices, payment data, macaroons, or preimages.

The collector credential is a separate exact-role macaroon. Its close-monitor additions are read-only [`/lnrpc.Lightning/PendingChannels`](https://lightning.engineering/api-docs/api/lnd/lightning/pending-channels/) and [`/walletrpc.WalletKit/PendingSweeps`](https://lightning.engineering/api-docs/api/lnd/wallet-kit/pending-sweeps/). Payer and invoice credentials do not receive WalletKit access.

## Deployable two-collector boundary

`infra/lightning-close-collector` is a one-shot, non-listening collector. It pins one private LND HTTPS endpoint and certificate, reads only `GetInfo`, `PendingChannels`, and `PendingSweeps` through its own exact-URI macaroon, reduces the responses locally, signs the aggregate with Ed25519, writes one JSON line, and exits. A transport, parse, timeout, credential, or policy failure is signed as `unsafe`; remote error text is discarded. The image runs unprivileged, read-only, without Linux capabilities or a published port.

Every LND node requires exactly two collectors with different IDs, Ed25519 keys, exact-role macaroons, supervisor identities, and failure domains. Each signature binds the opaque node commitment, collector ID, status, observation time, expiry, evaluator digest, and sorted reason codes. Attestations live for at most 60 seconds; the recommended production lifetime is 30 seconds on a schedule of 10 seconds or less. The verifier accepts exactly one fresh report from each configured public key. A missing, duplicate, unknown, stale, future, malformed, wrong-node, wrong-key, or unsafe report yields one `unsafe` `lightning-node` observation.

The signing key and macaroon must be separate mode-`0400` files and may exist only on that collector host. The public verifier receives public keys only. Collectors have no adapter, coordinator, EVM signer, gate, channel-management, invoice, payment, funding, claim, refund, alert-suppression, or reopen authority. Run them under an external systemd timer or Kubernetes CronJob with restart/failure alerts and deliver signed reports over authenticated encrypted transport. Do not co-locate both collectors on one host or put their private keys in one secret manager/control account; two containers on one machine prove the protocol, not operational independence.

The quorum process accepts one exact object on standard input:

```sh
LIGHTNING_CLOSE_COLLECTOR_A_ID=node-a-close-1 \
LIGHTNING_CLOSE_COLLECTOR_A_PUBLIC_KEY_PATH=/run/treeswap/node-a-close-1-public.pem \
LIGHTNING_CLOSE_COLLECTOR_B_ID=node-a-close-2 \
LIGHTNING_CLOSE_COLLECTOR_B_PUBLIC_KEY_PATH=/run/treeswap/node-a-close-2-public.pem \
LIGHTNING_NODE_COMMITMENT=0x… \
MAXIMUM_COLLECTOR_ATTESTATION_LIFETIME_SECONDS=30 \
MAXIMUM_COLLECTOR_CLOCK_SKEW_SECONDS=5 \
npm run verify:lightning-close-collectors < collector-pair.json
```

`collector-pair.json` contains only `{ "attestations": [...], "now": 0 }`; replace `now` with the verifier's current Unix time. The quorum output omits signatures and all raw LND data, retaining only collector/public-key/evidence/attestation digests, status, and time. The verifier output must immediately replace the generic monitor's `lightning-node` observation. If collection or delivery produces no pair, invoke the verifier with the incomplete set so absence becomes an explicit halt; never reuse the previous healthy quorum.

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

`npm run regtest:force-close-smoke` creates two distinct exact-role macaroons and Ed25519 identities, runs both hardened one-shot containers against pinned LND REST, verifies a signed healthy quorum, force-closes the only payer channel, and requires both signed collectors plus the adapter to halt before any new dispatch. It advances through the node-reported CSV maturity, requires all non-anchor and pending-close exposure to clear, opens a fresh balanced channel, and requires a new healthy quorum. Service may recover with only anchors that meet every bound. Reports and quorum evidence remain aggregate-only and feed the same `lightning-node` safety observation used by the gate monitor.

The standalone filter accepts one exact JSON object on standard input:

```sh
npm run monitor:lightning-close < private-lnd-observation.json
```

The input file can contain private LND identifiers and must remain inside the operator trust domain; only the returned aggregate may enter shared monitoring evidence.

## Published local checkpoint

Source commit [`7a8cd7dd49ff67d007e8cb8b2e2fce44009804d8`](https://github.com/bobofbuilding/treeswap/commit/7a8cd7dd49ff67d007e8cb8b2e2fce44009804d8), reviewed in [PR #39](https://github.com/bobofbuilding/treeswap/pull/39), passed [main-branch CI](https://github.com/bobofbuilding/treeswap/actions/runs/32592074931) and exact Vercel production deployment [`dpl_59ULvwvs83ekjwz5psny1em3wCt8`](https://treeswap-nlb0iimdj-bittrees-tech.vercel.app). Its sealed qualification passed all 41 campaigns, including 3,603 seconds and 119 continuous observations with a midpoint adapter restart and zero dispatch, followed by the genuine force-close/CSV-sweep/bounded-anchor/replacement-channel campaign. The private mode-`0600` evidence independently reconstructs byte-for-byte to `sha256:91f0d1c75242d4112a3d0d77c2e64c505e234eac76c2c617c2ee3ae85e54aa2a`; all 140 configuration hashes and three immutable image pins reproduce, privacy checks pass, and no disposable lab volume remains.

This published checkpoint predates the deployable signed-collector implementation described above. Its evidence remains local-only and does not supply independently operated production collectors, production alert delivery, actual operator-node recovery evidence, public-testnet traffic, production infrastructure, inventory, or funding authorization.

## Deployment gate

Before funding, deploy at least two supervised collectors under independent service identities and failure domains for every operator node, keep raw responses private, schedule collection at least as often as the generic safety-monitor freshness window, and set that window no longer than 15 seconds for the recommended 10-second schedule. Prove stale/missing/unsafe observations close both quote issuance and the deployed onchain gate, page two retained alert channels, and never block exits. Retain private operator evidence for an actual force close, anchor-limit breach, non-anchor overdue sweep, collector outage, key and macaroon rotation/revocation, and recovery. Reopening requires a new healthy observation set plus the signed release process; no collector can reopen the gate itself.
