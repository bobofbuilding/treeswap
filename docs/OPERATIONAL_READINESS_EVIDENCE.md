# Operational readiness evidence

Status: strict local evidence schema, five-role EIP-712 attestation ceremony, verifier, operator CLIs, verified service-isolation dependency, and release-candidate binding implemented. No production operators, isolated deployment, alert channels, drill results, support service, or funding authority are supplied by the repository.

## Purpose

A release must not treat one opaque `incidentDrills`, `monitoring`, `backupRestore`, `lossAllocation`, or `supportPolicy` hash as proof that operations are complete. `lib/operational-readiness-evidence.mjs` requires one canonical package that exposes the required structure without disclosing operational secrets.

The package is bound to the exact public-testnet funding mode, chain, gate, source commit, protocol version, deployment manifest, preparation time, and validity window. It requires exactly one participant for each role:

- backup operator;
- incident commander;
- Lightning operator;
- monitoring operator; and
- support owner.

Operator IDs, signers, and identity-evidence commitments must be distinct. At least two organization commitments are required. Organization commitments remain claims that external reviewers must validate; a collection of keys does not prove real organizational independence.

## Required evidence

The record contains distinct nonzero commitments for:

- alert delivery and escalation;
- verified backup and fresh-path restore;
- the complete incident-drill collection;
- loss allocation;
- continuous monitoring;
- privacy retention and deletion;
- provider quorum;
- zero-liability reconciliation;
- the verified service-isolation release binding;
- solver operations;
- support and escalation policy; and
- the exact test-qualification artifact.

It also requires at least two canonically ordered alert-channel delivery digests. Every required drill has bounded start and finish times, one named primary operator, at least two distinct retained observers, passed status, and its own evidence digest. The exact drill set covers alert delivery, backup/restore, BIT implementation change, BIT pause, credential compromise, EVM finality rollback, provider disagreement, provider outage, gate halt with preserved exits, inventory mismatch, LND outage, monitoring outage, suspected preimage leakage, and price-source disagreement.

Evidence freshness is capped at thirty days, validity and drill age at ninety days, and one drill duration at twenty-four hours. Signed policy may tighten those limits but cannot remove a drill, reduce alert channels below two, or reduce organization commitments below two.

## Attestation ceremony

Each participant independently reproduces the record and policy, then prepares its exact EIP-712 payload:

```sh
npm run prepare:operational-readiness-attestation -- \
  --record operations-record.json \
  --policy operations-policy.json \
  --isolation-record isolation-record.json \
  --isolation-policy isolation-policy.json \
  --isolation-attestations isolation-attestations.json \
  --role monitoring-operator \
  --operator-id 0x...
```

The command does not access a key or sign. Collect one signature per exact participant in canonical role order, then verify the complete package:

```sh
npm run verify:operational-readiness-evidence -- \
  --record operations-record.json \
  --policy operations-policy.json \
  --attestations operations-attestations.json \
  --isolation-record isolation-record.json \
  --isolation-policy isolation-policy.json \
  --isolation-attestations isolation-attestations.json
```

Input files must satisfy the common bounded regular-file reader. Before any operational payload is prepared, the verifier requires live, same-process [service-isolation evidence](./SERVICE_ISOLATION_EVIDENCE.md) provenance; matches its source, chain, gate, protocol, deployment, and validity interval; and requires the exact derived isolation digest in the operational record. The verifier rejects copied provenance, unknown fields, secrets, unrestricted endpoints, invoices, payment data, duplicated roles or evidence, weak alert routing, incomplete drills, future/stale evidence, participant substitution, signature replay, or a changed record or policy.

## Release binding

Both public-testnet release-candidate commands require `--operations-record`, `--operations-policy`, `--operations-attestations`, `--isolation-record`, `--isolation-policy`, and `--isolation-attestations`. Candidate preparation re-verifies both packages in the same process and requires:

- exact source, protocol, chain, gate, deployment manifest, funding mode, and release-time agreement;
- an exact provenance-bound service-isolation digest whose validity covers the complete operational and release interval;
- the isolation Lightning operator to match the operational/release Lightning identity, the isolation security reviewer to match the release security reviewer, and the isolation infrastructure operator to remain separate from operational, deployment, review, and release authorities;
- the operational Lightning operator and incident commander to match their release-policy identities;
- the monitoring identity and signer to be one exact signed upstream monitor operator, while every other operational signer remains separate from upstream infrastructure operators;
- no operational signer overlap with deployment wallets, deployment-promotion signers, or independent reviewers;
- exact alert-channel agreement with the signed bootstrap roster or completed campaign;
- exact backup, incident, monitoring, provider, solver, and qualification artifact agreement with upstream evidence;
- exact campaign reconciliation and per-drill evidence agreement for the campaign-qualified path; and
- release validity wholly inside the operational evidence interval.

Operational-readiness v1 is rejected. The former release-record template v2 and prepared candidate v2 schemas are rejected. Template v3 no longer accepts operator-entered loss-allocation, support-policy, or service-isolation hashes. Candidate v3 derives those commitments and every operational release digest only from live verifier provenance.

## Authority boundary

Preparation and verification expose no private key, raw signature in a summary, provider URL, invoice, preimage, signing authority, broadcast authority, gate-opening authority, reusable activation provenance, or funding capability. Real infrastructure, retained evidence, signer custody, alert delivery, drill truth, organizational separation, support readiness, and loss-allocation review remain external launch gates.
