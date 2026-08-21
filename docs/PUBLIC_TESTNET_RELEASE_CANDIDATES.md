# Public-testnet release candidates

Status: TreeSwap can prepare two exact, non-authorizing public-testnet release candidates from verified upstream evidence. No public-testnet deployment, signer, operator, inventory, approval, gate opening, or funding authority is included.

## Why there are two stages

A seven-day multi-solver campaign cannot be required before any testnet execution is possible. It is also unsafe to let a pre-campaign bootstrap record silently become the ordinary testnet release. Release v2 therefore has two distinct funding modes:

1. `operator-testnet-bootstrap` permits only operator-owned public-testnet inventory under hard code-level ceilings of 500 sats per swap, 1,000 sats in flight, 5,000 sats per epoch, 10,000 sats per day, 50 sats routing fee, and 250 basis points price band. It may omit the not-yet-existent campaign digest, but it still requires the exact signed deployment promotion, two operators in every critical role, two alert channels, all operational evidence, all five review digests, loss allocation, support policy, and five-role release approval.
2. `operator-testnet` is the campaign-qualified mode. It requires the complete signed seven-day campaign and derives its release record from both the fresh deployment promotion and campaign verification. It cannot reuse the bootstrap release or omit campaign evidence. Code-level ceilings remain 5,000 sats per swap, 10,000 sats in flight, 50,000 sats per epoch, 100,000 sats per day, 100 sats routing fee, and 500 basis points price band; signed policy may only tighten them.

Both modes remain public-testnet-only. Release v2 rejects every mainnet environment and funding mode.

## Evidence-safe assembly

`lib/public-testnet-release-candidate.mjs` removes the manual merge between deployment and campaign evidence. It accepts only live module-private verifications; copied JSON verification claims fail. It then:

- requires the source commit, chain, gate, deployment manifest, EVM provider count, campaign timing, promotion lifetime, both release-authorizing wallet identities and code hashes, and all three Safe owner/threshold observations to agree;
- rejects a Lightning operator, security reviewer, or incident commander that is also an owner of any controller, guardian, or fee-recipient wallet;
- derives the release environment, chain, gate, source, manifest, operator counts, and policy digests instead of accepting them from an operator;
- commits to both the record and policy digest for postflight, promotion, and campaign evidence;
- combines deployment and campaign provider-quorum evidence instead of allowing one to overwrite the other;
- combines deployment review, deployment findings, and campaign findings into one release commitment;
- binds the exact campaign EVM-provider identities into the ERC-1271 provider-set digest;
- requires independent monitor counts in addition to providers, Lightning observers, relays, solvers, alert channels, and multisig counts; and
- refuses missing loss allocation, support policy, or any contract, Lightning, coordinator, identity/privacy, or operations review digest.

The output contains the exact release record, release policy, EIP-712 approval payload, upstream digest summary, and only false authority flags. It is written once with mode `0600`. It does not sign, broadcast, open the gate, move inventory, or activate funding.

## Bootstrap preparation

Prepare three secret-free inputs:

- `record-template.json`: release ID/version, finalized approval block, prior release, loss-allocation and support digests, all five review digests, exact 3-owner/2-threshold multisig values, tiny limits, safe features, and validity window;
- `policy-template.json`: five release approvers, the same or tighter tiny-limit policy, maximum release lifetime, and maximum runtime-observation age; and
- `bootstrap-evidence.json`: exact admission, risk, fee, qualification, provider, solver, monitoring, backup, incident, and findings digests, plus two-to-twenty counts for every operator role. Approval-provider identities are never accepted from this unsigned file; they are derived from the signed deployment promotion.

Then independently re-verify the complete postflight-bound promotion and derive the candidate:

```sh
npm run prepare:testnet-bootstrap-release-candidate -- \
  --record-template record-template.json \
  --policy-template policy-template.json \
  --bootstrap-evidence bootstrap-evidence.json \
  --promotion-record promotion-record.json \
  --promotion-policy promotion-policy.json \
  --deployment-policy deployment-policy.json \
  --promotion-observations promotion-observations.json \
  --promotion-attestations promotion-attestations.json \
  --postflight-bundle postflight-bundle.json \
  --out bootstrap-release-candidate.json
```

The verifier rejects a stale or copied promotion, provider-count mismatch, non-canonical provider set, Safe substitution, zero review or operations digest, weak participant count, excessive bootstrap limit, unsafe feature, reversed time, symlink, overwrite, oversized file, or unknown field.

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
  --out qualified-release-candidate.json
```

Use a fresh deployment observation and promotion near release approval; promotion remains valid for no more than one day. The release validity cannot begin before both campaign completion and that fresh promotion. Each of the five release approvers must independently reproduce the candidate and compare the record and policy digests through a separate channel before signing.

## Remaining external boundary

Cryptographic agreement does not prove organizational independence, hardware custody, reviewer competence, artifact truth, incident performance, or alert delivery. The bootstrap must use deployed Sepolia contracts, production Safe implementations, hardware-backed owners, genuinely independent providers and operators, retained evidence, and real external review. The qualified candidate additionally requires the real seven-day campaign. Funding stays disabled until the resulting release signatures and a fresh reconciled runtime snapshot separately pass the release authorization boundary.
