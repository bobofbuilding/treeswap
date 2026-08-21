# Public-testnet release candidates

Status: TreeSwap can prepare two exact, non-authorizing public-testnet release candidates from verified upstream evidence. No public-testnet deployment, signer, operator, inventory, approval, gate opening, or funding authority is included.

## Why there are two stages

A seven-day multi-solver campaign cannot be required before any testnet execution is possible. It is also unsafe to let a pre-campaign bootstrap record silently become the ordinary testnet release. Release v2 therefore has two distinct funding modes:

1. `operator-testnet-bootstrap` permits only operator-owned public-testnet inventory under hard code-level ceilings of 500 sats per swap, 1,000 sats in flight, 5,000 sats per epoch, 10,000 sats per day, 50 sats routing fee, and 250 basis points price band. It may omit the not-yet-existent campaign digest, but it still requires the exact signed deployment promotion, an independently signed bootstrap roster with two operators in every critical role, two alert channels, all operational evidence, a five-reviewer signed review package, loss allocation, support policy, and five-role release approval.
2. `operator-testnet` is the campaign-qualified mode. It requires the complete signed seven-day campaign and derives its release record from both the fresh deployment promotion and campaign verification. It cannot reuse the bootstrap release or omit campaign evidence. Code-level ceilings remain 5,000 sats per swap, 10,000 sats in flight, 50,000 sats per epoch, 100,000 sats per day, 100 sats routing fee, and 500 basis points price band; signed policy may only tighten them.

Both modes remain public-testnet-only. Release v2 rejects every mainnet environment and funding mode.

## Evidence-safe assembly

`lib/public-testnet-release-candidate.mjs` removes the manual merge between deployment and campaign evidence. It accepts only live module-private verifications; copied JSON verification claims fail. It then:

- requires the source commit, protocol version, chain, gate, deployment manifest, EVM provider count, campaign timing, review interval, promotion lifetime, both release-authorizing wallet identities and code hashes, and all three Safe owner/threshold observations to agree;
- rejects a Lightning operator, security reviewer, or incident commander that is also an owner of any controller, guardian, or fee-recipient wallet;
- rejects an external reviewer signer that overlaps any deployment wallet, deployment-wallet owner, deployment-promotion attester, bootstrap/campaign operator, or release approver;
- derives the release environment, chain, gate, source, manifest, operator counts, and policy digests instead of accepting them from an operator;
- derives all five review digests from a live provenance-bound [independent review verification](./INDEPENDENT_REVIEW_EVIDENCE.md), rather than accepting hashes from the release template;
- commits to both the record and policy digest for postflight, promotion, and campaign evidence;
- combines deployment and campaign provider-quorum evidence instead of allowing one to overwrite the other;
- combines deployment review, deployment findings, campaign findings, and the signed five-reviewer record, policy, attestation set, and reconciled findings into one release commitment;
- binds the exact campaign EVM-provider identities into the ERC-1271 provider-set digest;
- derives bootstrap counts from the complete signed operator roster and requires its EVM-provider identities and signers to match the deployment promotion exactly;
- commits the bootstrap record, policy, participant set, and attestation set into the release's provider, monitoring, solver, backup, incident, qualification, and findings evidence;
- requires independent monitor counts in addition to providers, Lightning observers, relays, solvers, alert channels, and multisig counts; and
- refuses missing loss allocation, support policy, or a missing, stale, copied, incomplete, unresolved, or authority-overlapping review package.

The output contains the exact release record, release policy, EIP-712 approval payload, upstream digest summary, and only false authority flags. It is written once with mode `0600`. It does not sign, broadcast, open the gate, move inventory, or activate funding.

## Bootstrap preparation

First complete the [signed bootstrap operator-evidence workflow](./PUBLIC_TESTNET_BOOTSTRAP_EVIDENCE.md). It requires at least two EVM providers, Lightning observers, monitors, relays, and solvers. Every operator signs the same source-, deployment-, artifact-, feature-, and time-bound EIP-712 record. Counts are derived from distinct operator identities and signers; they are not accepted from an unsigned file.

Complete the [five-reviewer evidence ceremony](./INDEPENDENT_REVIEW_EVIDENCE.md), then prepare eight secret-free inputs:

- `record-template.json`: release ID/version, finalized approval block, prior release, loss-allocation and support digests, exact 3-owner/2-threshold multisig values, tiny limits, safe features, and validity window; release-record template v2 contains no operator-entered review digests;
- `policy-template.json`: five release approvers, the same or tighter tiny-limit policy, maximum release lifetime, and maximum runtime-observation age; and
- `bootstrap-record.json`: the exact operator roster, retained-evidence commitments, operational artifact digests, safe test-only features, and short validity interval;
- `bootstrap-policy.json`: the exact source/deployment boundary, minimum counts, maximum one-hour freshness, and maximum one-day lifetime; and
- `bootstrap-attestations.json`: exactly one canonical EIP-712 attestation from every listed operator;
- `review-record.json`: the exact source, protocol, deployment, reviewers, reports, finding counts, and review interval;
- `review-policy.json`: the maximum age, lifetime, and finding bound for that exact source and deployment; and
- `review-attestations.json`: exactly one canonical EIP-712 attestation from each of the five review roles.

Then independently re-verify the complete postflight-bound promotion and derive the candidate:

```sh
npm run prepare:testnet-bootstrap-release-candidate -- \
  --record-template record-template.json \
  --policy-template policy-template.json \
  --bootstrap-record bootstrap-record.json \
  --bootstrap-policy bootstrap-policy.json \
  --bootstrap-attestations bootstrap-attestations.json \
  --promotion-record promotion-record.json \
  --promotion-policy promotion-policy.json \
  --deployment-policy deployment-policy.json \
  --promotion-observations promotion-observations.json \
  --promotion-attestations promotion-attestations.json \
  --postflight-bundle postflight-bundle.json \
  --review-record review-record.json \
  --review-policy review-policy.json \
  --review-attestations review-attestations.json \
  --out bootstrap-release-candidate.json
```

The verifier rejects a stale or copied promotion, bootstrap, or review verification; provider identity/signer/count mismatch; non-canonical roster; shared operator, reviewer, organization, or signer; missing or replayed signature; open or unreconciled finding; accepted critical/high risk; Safe substitution; weak participant count; excessive bootstrap limit; unsafe feature; a candidate validity window outside the signed bootstrap or review interval; symlink; overwrite; oversized file; or unknown field.

## Campaign-qualified preparation

After the bootstrap release is separately approved, activated, operated, halted, reconciled, and the seven-day campaign is fully signed, use the same templates with the completed campaign:

```sh
npm run prepare:testnet-release-candidate -- \
  --record-template record-template.json \
  --policy-template policy-template.json \
  --promotion-record promotion-record.json \
  --promotion-policy promotion-policy.json \
  --deployment-policy deployment-policy.json \
  --promotion-observations promotion-observations.json \
  --promotion-attestations promotion-attestations.json \
  --postflight-bundle postflight-bundle.json \
  --campaign-record campaign.json \
  --campaign-policy campaign-policy.json \
  --campaign-attestations campaign-attestations.json \
  --review-record review-record.json \
  --review-policy review-policy.json \
  --review-attestations review-attestations.json \
  --out qualified-release-candidate.json
```

Use a fresh deployment observation and promotion near release approval; promotion remains valid for no more than one day. The release validity cannot begin before both campaign completion and that fresh promotion. Each of the five release approvers must independently reproduce the candidate and compare the record and policy digests through a separate channel before signing.

The next step is the guarded [public-testnet release approval ceremony](./PUBLIC_TESTNET_RELEASE_APPROVALS.md). It derives each role's exact signer and typed payload from the candidate, verifies one five-role bundle through the candidate-bound finalized provider quorum, and writes only a non-authorizing receipt. Loading this candidate from disk proves self-consistency, not the upstream evidence provenance that each signer must independently reproduce.

## Remaining external boundary

Cryptographic agreement does not prove organizational independence, hardware custody, reviewer competence, artifact truth, incident performance, or alert delivery. The bootstrap must use deployed Sepolia contracts, production Safe implementations, hardware-backed owners, genuinely independent providers, operators, and reviewers, retained complete reports and dispositions, and real external review. The qualified candidate additionally requires the real seven-day campaign. Funding stays disabled until the approvals are reverified with live providers inside the same trusted process that evaluates a fresh release-bound reconciled runtime snapshot. The standalone approval receipt deliberately cannot activate that process.
