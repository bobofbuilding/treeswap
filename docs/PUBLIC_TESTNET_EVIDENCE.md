# Public-testnet campaign evidence

Status: the exact campaign policy, multi-operator EIP-712 attestation verifier, privacy-safe adoption summary, and release-evidence mapper are implemented. No real public-testnet campaign, independent operator set, or funding authorization is included in the repository.

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

## Operator workflow

1. Freeze a reviewed source commit, policies, fee schedule, and closed testnet deployment manifest.
2. Record retained organizational evidence for every participant. An operator digest is a pseudonymous commitment, not proof of independence.
3. Run the campaign using only operator-owned test assets. Preserve secret-free evidence digests for all required scenarios and alert deliveries.
4. Close the gate, reconcile BIT, Lightning, and in-flight state to zero unexplained liabilities, and assemble the canonically ordered record.
5. Each listed operator independently prepares the exact EIP-712 payload:

```sh
npm run prepare:testnet-attestation -- \
  --record campaign.json \
  --policy campaign-policy.json \
  --role solver \
  --operator-id 0x...
```

The command emits typed data only. It never accepts a private key or signs for the operator. Sign with the separately controlled key that matches the participant record, then collect one canonical attestation per participant.

6. Verify the complete candidate bundle:

```sh
npm run verify:testnet-evidence -- \
  --record campaign.json \
  --policy campaign-policy.json \
  --attestations attestations.json
```

The verifier returns the exact record and policy digests, release-evidence mapping, and privacy-safe per-solver adoption summary. It returns no funding capability.

7. Independent reviewers must validate that operator evidence represents genuinely separate organizations, alert channels delivered externally, artifacts are truthful, testnet contracts match reviewed source, and no finding is hidden. Only then may the record digest be placed in a separately approved mainnet release record.

## Required scenarios

The non-removable baseline covers successful swaps in both directions; solver competition, withholding, restart, and insolvency; relay censorship; EVM finalized success, provider outage/disagreement, finality rollback, and reorgs before authorization and after claim; BIT implementation change and pause; executable-price disagreement; LND outage; monitor outage; alert delivery/escalation; credential compromise; inventory mismatch; backup/restore; suspected preimage-leak response; and an emergency halt that preserves claims, refunds, and withdrawals.

A stricter policy may add canonically named scenarios. It cannot remove the baseline.

## Trust boundary

Cryptographic attestations prove that the listed keys approved the exact record and policy. They do not prove organizational independence, provider ownership, hardware-key custody, reviewer competence, or artifact truth. Those facts remain retained external evidence and independent-review gates.

This record is intended to close the evidence gap after a signed tiny-limit testnet bootstrap. It is not permission to bootstrap itself, deploy mainnet, hold public liquidity, or fund a solver. `V1_CAPABILITIES.webSolverFunding` remains disabled unless a separate active release authorization and fresh reconciled runtime state pass.
