# Independent review evidence

Status: TreeSwap can verify one exact, short-lived review package signed by five distinct external review roles. This is a verification boundary only. The repository supplies no reviewer, organization, report, engagement, signature, approval, gate opening, or funding authority.

## Why report hashes are not enough

A nonzero hash does not prove who produced a report, which source and deployment it reviewed, whether the reviewer saw the same findings disposition, or whether any finding remains open. Release templates therefore no longer accept five operator-entered review hashes.

`lib/independent-review-evidence.mjs` requires one common record and policy for:

- contracts;
- coordinator and solver automation;
- identity and privacy;
- Lightning; and
- operations.

Every role has a distinct reviewer identity, signer, organization commitment, and retained identity-evidence digest. All five sign the same EIP-712 record and policy. Distinct commitments make substitution and double-counting mechanically detectable; they do not by themselves prove real-world independence or competence.

## Exact review boundary

The signed record binds:

- the public-testnet chain and exact gate;
- the reviewed source commit and protocol version;
- the exact promoted deployment-manifest digest;
- review start, finish, expiry, and one common review ID;
- one distinct report digest and findings-disposition digest per role; and
- complete finding counts for fixed, explicitly risk-accepted, not-applicable, and open findings.

Every report count must reconcile exactly. Open findings are forbidden. Critical and high findings cannot be risk-accepted. Medium, low, or informational acceptance remains visible in the signed count and disposition artifact and must still be approved by the later five-role release ceremony. A report may contain no more than the policy bound, with an absolute ceiling of 1,000 findings.

Evidence freshness may not exceed thirty days and its validity may not exceed ninety days. A release approval block and the complete release validity window must fall inside the signed review interval.

## Reviewer ceremony

Each reviewer independently verifies the plaintext record, policy, report artifacts, disposition artifacts, source checkout, and deployment manifest. Prepare that reviewer's exact typed payload without exposing a key:

```sh
npm run prepare:independent-review-attestation -- \
  --record review-record.json \
  --policy review-policy.json \
  --role contracts \
  --reviewer-id 0x...
```

Collect exactly one EIP-712 signature from every listed reviewer, ordered by role, then verify the complete bundle:

```sh
npm run verify:independent-review-evidence -- \
  --record review-record.json \
  --policy review-policy.json \
  --attestations review-attestations.json
```

The verifier rejects missing, duplicated, reordered, substituted, replayed, stale, expired, or mutated evidence. It also rejects shared reviewer IDs, organizations, signers, identity evidence, reports, and findings dispositions. Its output is secret-free and contains no raw report, finding, URL, signature, or personal contact information.

## Release binding

Both bootstrap and campaign-qualified candidate preparation re-run this verifier in-process. Candidate preparation then:

- derives all five release `reviewDigests` from verified reports instead of a template;
- commits the review record, policy, attestation set, and complete findings accounting into release finding evidence;
- requires source, protocol version, chain, gate, and deployment manifest to match promotion evidence exactly;
- rejects a reviewer signer that is also a deployment wallet, deployment-wallet owner, deployment-promotion attester, bootstrap/campaign operator, signed operational-readiness role, or release approver; and
- rejects copied verification JSON because module-private verifier provenance does not survive serialization.

Release-candidate schema v3 is the only accepted candidate artifact. Candidate v1/template v1 are rejected because they accepted unsigned review hashes; candidate v2/template v2 are rejected because they lacked the separate provenance-bound operational-readiness package.

## Remaining external boundary

Cryptography proves that five keys signed one exact package. It does not prove a reviewer's qualifications, organization, independence, hardware custody, report quality, or the truth of a report. Before test inventory, operators must verify those facts out of band, retain the complete reports and finding dispositions, and have each release approver independently reproduce the candidate from the original artifacts.
