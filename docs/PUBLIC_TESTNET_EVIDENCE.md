# Public-testnet campaign evidence

Status: the exact campaign policy, immutable hash-linked operator workspace, multi-operator EIP-712 attestation verifier, privacy-safe adoption summary, and release-evidence mapper are implemented. No real public-testnet campaign, independent operator set, or funding authorization is included in the repository.

Published implementation checkpoint `e662885346791b80153835c3123f0f77b63ad9f5` passed 263 application/security tests, 91 direct pinned-runtime tests plus the real bounded-filesystem rollback campaign, 68 contract tests, both web build paths, all 32 sealed local qualification campaigns from `2026-08-20T16:49:58.056Z` through `2026-08-20T17:57:51.589Z`, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32394191747). The ignored mode-`0600` evidence independently reconstructs to `sha256:de647c4a2b35e411bed48a2062e2964c008702f6f17715072b5d9c9388575e6d`. It explicitly records a simulated EVM reservation and no public testnet, production infrastructure, independent review, or funding authorization.

## Purpose

Local tests cannot establish that two RPC providers, Lightning observers, solvers, relays, or monitor operators are independently operated. A green dashboard also cannot prove which source, deployment, policy, scenario set, or inventory limits were exercised. `lib/public-testnet-evidence.mjs` therefore accepts only one exact `treeswap.public-testnet-campaign.v1` record under one exact `treeswap.public-testnet-evidence-policy.v1`.

The record and policy bind:

- the public-testnet chain, gate, reviewed source commit, deployment-manifest digest, admission policy, risk policy, and fee schedule;
- at least two separately identified EVM providers, Lightning observers, monitors, relays, solvers, and alert channels;
- retained evidence digests and EIP-712 attestations from every participant;
- a campaign lasting at least seven days and no more than thirty-one days;
- at least twenty selected swaps per solver, including at least ten in each direction;
- exact quote, outcome, timeout, failure, completion-time, capacity-freshness, and halt-history metrics per solver;
- every required success, outage, disagreement, reorg, censorship, restart, insolvency, credential, backup, reconciliation, and incident scenario;
- operator-owned test inventory only, with mainnet assets, public deposits, LP shares, yield, rewards, and partial fills disabled; and
- a closed gate at the start and finish, proven halt-with-exits behavior, and zero unreconciled liabilities observed no more than five minutes before campaign completion.

Policies cannot weaken the absolute seven-day, operator-count, bidirectional sample, freshness, latency, timeout, failure, reconciliation, or evidence-age limits. Unknown fields, non-canonical ordering, duplicate identities, self-counted participants, missing scenarios, unbalanced outcomes, stale reconciliation, stale evidence, replayed signatures, changed policy, changed record, secret-bearing fields, and unrestricted endpoint material fail closed. Collections are bounded before signature work.

## Guarded operator workflow

1. Freeze a reviewed source commit, policies, fee schedule, and closed testnet deployment manifest. Promote the manifest only through the [signed deployment-manifest promotion](./DEPLOYMENT_PROMOTION.md) boundary after matching independent observations and reviews exist.
2. Record retained organizational evidence for every participant. `participants.json` must be an array of exact `{ role, operatorId, signer, evidenceDigest }` objects. An operator digest is a pseudonymous commitment, not proof of independence. The workspace derives role counts and rejects reuse of an operator identity or signer across any participant roles.
3. Initialize revision zero. The output is created once with mode `0600`; an existing path or symlink input is rejected.

```sh
npm run manage:testnet-campaign -- init \
  --policy campaign-policy.json \
  --participants participants.json \
  --campaign-id 0x... \
  --started-at 1800000000 \
  --out campaign-r000.json
```

4. Run the campaign using only operator-owned test assets. For each required scenario, retain the underlying evidence outside the repository and create an exact secret-free entry with `name`, `status`, `startedAt`, `finishedAt`, canonically ordered `observerOperatorIds`, and `evidenceDigest`. Add one entry into a new snapshot; never reuse the output path.

```sh
npm run manage:testnet-campaign -- scenario \
  --state campaign-r000.json \
  --entry scenario-alert-delivery.json \
  --out campaign-r001.json
```

The command validates the scenario against the frozen policy and participants, carries all previous evidence forward, increments the revision by exactly one, and binds `parentStateDigest` to the entire previous normalized snapshot. It does not call a testnet, inspect the retained artifact, or prove that the observers are independent.

5. After each solver's sample is complete, add its exact reconciled metric entry into another new snapshot:

```sh
npm run manage:testnet-campaign -- solver-metric \
  --state campaign-r024.json \
  --entry solver-a-metrics.json \
  --out campaign-r025.json
```

The metric must reconcile quote selection, both directions, and every terminal outcome and must already satisfy the frozen sample, latency, capacity-freshness, timeout, and failure limits.

6. Operators and reviewers should retain every revision and compare checkpoint digests through a channel outside the campaign host. A single current snapshot cannot prove that an earlier snapshot was never discarded; the retained chain and independently recorded checkpoints make removal or substitution detectable.

```sh
npm run manage:testnet-campaign -- checkpoint --state campaign-r026.json
npm run manage:testnet-campaign -- verify-transition \
  --previous campaign-r025.json \
  --next campaign-r026.json
```

A checkpoint reports missing scenarios and solver operators, the earliest policy-compliant finish time, and the exact state digest. “Collection complete” means only that every required entry is present. It is not a statement that seven days elapsed, that artifacts are truthful, or that reconciliation passed.

7. Close the gate and reconcile BIT, Lightning, and in-flight state to zero unexplained liabilities no more than the policy age before campaign completion. `finalization.json` contains only exact `alertChannelEvidenceDigests`, `artifacts`, `gate`, and `reconciliation` objects. The finalizer derives participant counts and fixes every feature flag to operator-owned test inventory only:

```sh
npm run manage:testnet-campaign -- finalize \
  --state campaign-r026.json \
  --finalization finalization.json \
  --finished-at 1800604800 \
  --out campaign.json
```

The finalizer applies the same record validator used by signature verification. It refuses an incomplete or short campaign, stale/non-zero reconciliation, insufficient alert evidence, unsafe feature set, weak solver metrics, or an existing output. Its stdout binds the source-state, record, and policy digests and remains explicitly scoped to construction only—no signing or funding authorization.

8. Each listed operator independently prepares the exact EIP-712 payload:

```sh
npm run prepare:testnet-attestation -- \
  --record campaign.json \
  --policy campaign-policy.json \
  --role solver \
  --operator-id 0x...
```

The command emits typed data only. It never accepts a private key or signs for the operator. Sign with the separately controlled key that matches the participant record, then collect one canonical attestation per participant.

9. Verify the complete candidate bundle:

```sh
npm run verify:testnet-evidence -- \
  --record campaign.json \
  --policy campaign-policy.json \
  --attestations attestations.json
```

The verifier returns the exact record and policy digests, release-evidence mapping, and privacy-safe per-solver adoption summary. It returns no funding capability.

10. Independent reviewers must validate the entire snapshot chain, separately recorded checkpoint digests, organizational independence, external alert delivery, artifact truth, source/deployment correspondence, and findings disposition. Only then may the record digest be placed in a separately approved mainnet release record.

## Required scenarios

The non-removable baseline covers successful swaps in both directions; solver competition, withholding, restart, and insolvency; relay censorship; EVM finalized success, provider outage/disagreement, finality rollback, and reorgs before authorization and after claim; BIT implementation change and pause; executable-price disagreement; LND outage; monitor outage; alert delivery/escalation; credential compromise; inventory mismatch; backup/restore; suspected preimage-leak response; and an emergency halt that preserves claims, refunds, and withdrawals.

A stricter policy may add canonically named scenarios. It cannot remove the baseline.

## Trust boundary

Hash-linked snapshots prove exact single-entry transitions only when the full sequence and prior checkpoint digests are retained. They do not prove wall-clock continuity, artifact truth, or that a parallel history was never created. Cryptographic attestations prove that the listed keys approved the exact final record and policy. They do not prove organizational independence, provider ownership, hardware-key custody, reviewer competence, or artifact truth. Those facts remain retained external evidence and independent-review gates.

This record is intended to close the evidence gap after a signed tiny-limit testnet bootstrap. It is not permission to bootstrap itself, deploy mainnet, hold public liquidity, or fund a solver. `V1_CAPABILITIES.webSolverFunding` remains disabled unless a separate active release authorization and fresh reconciled runtime state pass.
