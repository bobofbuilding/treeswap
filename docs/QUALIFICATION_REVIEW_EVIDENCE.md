# Qualification review evidence

Status: the repository can reconstruct the exact sealed local qualification file, enforce the complete release campaign and configuration boundary, verify one independent reviewer's short-lived signature, and require that live provenance in both bootstrap and full public-testnet release candidates. No reviewer, report, deployed release, signature, or funding authority is supplied by the repository.

## Boundary

The release path no longer accepts an opaque `testQualification` digest. Candidate v5 requires one module-private qualification-review verification created in the same process from:

- the exact raw qualification file bytes and both SHA-256 commitments;
- the exact clean published source commit in the artifact;
- all 41 mandatory campaign names in canonical order;
- the exact versioned 160-file configuration manifest shared by the qualification runner and verifier, including the qualification, release-candidate, active-daemon, coordinator fault-smoke, and reviewer boundaries;
- at least three unique immutable container image pins;
- validated uncompressed production-duration Lightning evidence;
- a bounded public-testnet policy naming one reviewer, organization commitment, identity-evidence commitment, deployment, protocol version, and funding mode;
- a retained review-report digest and findings-disposition digest with status `passed-no-open-findings`; and
- one exact EIP-712 reviewer signature over the derived record and policy digests, raw artifact commitments, reviewer identity, review time, and expiry.

The verifier rejects changed whitespace or bytes, a recomputed artifact with missing coverage, path traversal in configuration names, or a changed source, report, findings record, reviewer, deployment, mode, date, signature, or validity window. Its in-memory provenance cannot be restored from JSON or copied into another process.

Candidate assembly additionally requires the qualification review's exact evidence digest to match both the signed bootstrap/campaign record and all five signed operational-readiness records. The qualification reviewer must not overlap any deployment signer or owner, infrastructure participant, other reviewer, operational signer, or release approver; its organization commitment must remain separate from review and operations organizations. Prepared candidate v4 is rejected.

## Reviewer ceremony

Generate the final artifact only from the exact clean release commit already published on `origin/main`:

```sh
npm run qualify:local -- --out-name final-release-qualification.json
```

Keep the mode-`0600` artifact outside Git when moving it to the independent reviewer. The reviewer must independently reproduce the source and configuration hashes, inspect the complete output and retained reports, and create:

- `qualification-policy.json` using schema `treeswap.qualification-review-policy.v1`;
- `qualification-review.json` using schema `treeswap.qualification-review.v1`; and
- retained private identity, report, and findings evidence whose public commitments are distinct.

The policy may tighten the seven-day artifact-age and twenty-four-hour review-lifetime hard maxima. It cannot expand them.

Prepare the exact typed data without accessing a private key:

```sh
npm run prepare:qualification-review-attestation -- \
  --artifact /secure-review/final-release-qualification.json \
  --review /secure-review/qualification-review.json \
  --policy /secure-review/qualification-policy.json
```

After the reviewer signs the displayed EIP-712 payload with its policy-pinned key, verify the package:

```sh
npm run verify:qualification-review-evidence -- \
  --artifact /secure-review/final-release-qualification.json \
  --review /secure-review/qualification-review.json \
  --policy /secure-review/qualification-policy.json \
  --attestation /secure-review/qualification-attestation.json
```

The summary is secret-free and non-authorizing. Candidate preparation must receive the original four files—not the summary—so it can recreate live module-private provenance and bind the exact review into the signed release record.

## Trust boundary

Cryptography proves which reviewer signed which exact artifact and report commitments. It does not prove reviewer competence, organizational independence, report truth, or that retained private evidence exists. Those remain external review facts. The result cannot sign, broadcast, open the gate, deposit inventory, or authorize funding. Any source or artifact change requires a new qualification run, review, release candidate, and five-role approval.
