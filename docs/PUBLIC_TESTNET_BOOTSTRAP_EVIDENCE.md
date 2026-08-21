# Public-testnet bootstrap operator evidence

Status: the repository verifies one short-lived, independently signed bootstrap roster and binds it into tiny-limit release-candidate preparation. It does not deploy services, prove organizational independence, sign a release, open the gate, or authorize funding. No real roster or public-testnet evidence is included.

## Why this exists

The pre-campaign bootstrap is the first point where operator-owned test inventory could be exposed. A file containing claimed operator counts is not enough: one person could write `2` for every role without either alleged operator seeing the source, deployment, evidence, or limits.

`treeswap.public-testnet-bootstrap-evidence.v2` removes that unsigned-count boundary. It names every EVM provider, Lightning observer, monitor, relay, and solver by a distinct pseudonymous operator commitment and EIP-712 signer. Counts are derived from the exact roster. Every participant signs the same complete record and policy before a bootstrap release candidate can be prepared.

## Exact boundary

The record binds:

- one bootstrap ID, public-testnet chain, deployed gate, reviewed source commit, and deployment-manifest digest;
- a preparation time and expiry;
- at least two participants in each of five roles;
- one distinct operator ID, signer, and retained-evidence digest per participant;
- at least two distinct alert-delivery evidence digests;
- admission, risk, fee, provider-quorum, solver, monitoring, backup/restore, incident, qualification, and finding-disposition artifacts; and
- operator-owned test inventory with mainnet assets, public deposits, LP shares, rewards, yield, and partial fills disabled.

One operator ID or signer cannot count in multiple roles. Participant evidence digests must also be distinct. Collections are canonically ordered and bounded. Policy cannot allow fewer than two or more than twenty participants in any role, evidence older than one hour, or a signed interval longer than one day.

The verifier derives counts; neither the record nor an operator supplies them. The two EVM-provider operator IDs and signing addresses must later match the provider approvers in the separately verified deployment promotion exactly. Matching labels or counts are insufficient.

## Operator workflow

1. Complete the signed closed-deployment postflight and deployment promotion while the gate is closed and balances are zero.
2. Each prospective operator retains its own deployment, key-custody, separation, restore, monitoring, and escalation evidence outside the repository. Commit that material to one nonzero `evidenceDigest`; do not place endpoints, credentials, invoices, or private infrastructure details in the roster.
3. Assemble `bootstrap-record.json` and `bootstrap-policy.json`. Participants are ordered by `role:operatorId`; alert evidence digests are ordered by digest.
4. Every listed participant independently reconstructs the record and prepares its own unsigned typed payload:

```sh
npm run prepare:testnet-bootstrap-attestation -- \
  --record bootstrap-record.json \
  --policy bootstrap-policy.json \
  --role solver \
  --operator-id 0x...
```

5. The operator inspects the source, chain, gate, manifest, complete roster, artifacts, safe features, and validity window before signing with the exact listed EIP-712 identity. The command never reads a key or signs.
6. Collect exactly one canonical attestation per participant and verify the complete set:

```sh
npm run verify:testnet-bootstrap-evidence -- \
  --record bootstrap-record.json \
  --policy bootstrap-policy.json \
  --attestations bootstrap-attestations.json
```

The summary contains no raw signatures or participant list and grants no authority. Candidate preparation must re-run this verification in-process; a copied summary or deserialized verification object fails provenance checks.

7. Complete the separate [five-role independent-review ceremony](./INDEPENDENT_REVIEW_EVIDENCE.md), [three-role service-isolation ceremony](./SERVICE_ISOLATION_EVIDENCE.md), and [five-role operational-readiness ceremony](./OPERATIONAL_READINESS_EVIDENCE.md), then prepare the tiny-limit candidate from the original signed deployment, bootstrap, review, isolation, and operations inputs:

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
  --isolation-record isolation-record.json \
  --isolation-policy isolation-policy.json \
  --isolation-attestations isolation-attestations.json \
  --operations-record operations-record.json \
  --operations-policy operations-policy.json \
  --operations-attestations operations-attestations.json \
  --out bootstrap-release-candidate.json
```

The release approval block and the entire candidate validity window must remain inside the signed bootstrap, independent-review, service-isolation, and operational-readiness intervals. Candidate preparation commits the roster record, policy, participant set, and exact attestation set into release evidence; it separately commits the operational record, policy, participant, drill, alert-channel, isolation, and attestation sets. It derives review, service-isolation, loss-allocation, support, incident, backup, monitoring, solver, provider, and qualification commitments only from live verifier provenance; the release template cannot supply them.

## Fail-closed cases

Preparation fails on an unknown field, wrong schema or chain, source/manifest/gate mismatch, unsafe feature, zero artifact, shared or duplicated operator or reviewer identity, signer, organization, or evidence digest, non-canonical order, weak count, open or unreconciled review finding, accepted critical/high risk, stale/future/expired evidence, excessive lifetime, missing or substituted attestation, changed record or policy, wrong signature, copied verification, deployment-provider mismatch, reviewer overlap with a deployment or release authority, secret-bearing field, endpoint material, oversized input, symlink, or output overwrite.

## Remaining external boundary

Distinct operator and reviewer commitments and valid signatures do not prove independent organizations. A single party can control many keys, sign false evidence, or commit to nonexistent infrastructure. EIP-712 proves which listed key approved the exact bytes; it does not prove the evidence behind a digest is truthful.

Before any operator-owned test inventory is exposed, independent reviewers must inspect the retained artifacts, verify organizational and infrastructure separation, test service identities and secret scopes, witness backup/restore and alert delivery, and confirm that the provider roster represents independently operated backends. Five release roles must then independently reproduce the entire candidate and complete the separate release ceremony. Funded operation remains closed until those external facts exist and live activation re-verifies them in-process.

## Standards

- [EIP-712 typed structured data](https://eips.ethereum.org/EIPS/eip-712)
