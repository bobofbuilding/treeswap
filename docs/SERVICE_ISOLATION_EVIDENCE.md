# Service isolation evidence

Status: strict local evidence schema, three-role EIP-712 attestation ceremony, verifier, operator CLIs, and operational-readiness binding implemented. No deployed service identity, network policy, credential, backup, operator, or funding authority is supplied by the repository.

## Purpose

A diagram or an opaque infrastructure hash does not prove that the public browser, web server, quote relay, coordinator, Lightning adapters, EVM services, monitor, guardian broadcaster, and backup store use separate trust domains and least-privilege credentials. `lib/service-isolation-evidence.mjs` requires a canonical, secret-free inventory for all twelve roles before operational readiness can be signed.

Every service has its own committed service identity, trust domain, network policy, and deployment evidence. Every credential-bearing service has its own committed credential set and a review/expiry window. The record contains commitments only: it rejects endpoints, URLs, invoices, raw macaroons, private keys, seeds, passwords, wallet links, email, and preimages.

## Exact boundary

The policy requires these placements and credential classes:

| Service | Zone | Public ingress | Credential classes |
| --- | --- | --- | --- |
| browser client | public client | no | none |
| web server | public edge | yes | account-storage capability |
| quote relay | public edge | yes | none |
| coordinator | private control | no | coordinator database credential |
| Lightning payer adapter | private Lightning | no | payer macaroon and pinned TLS identity |
| Lightning invoice adapter | private Lightning | no | invoice macaroon and pinned TLS identity |
| EVM finality authorizer | private EVM | no | read-provider credential |
| EVM relayer | private EVM | no | transaction signer |
| asset verifier | private EVM | no | read-provider credential |
| safety monitor | private monitoring | no | read-provider credential |
| guardian broadcaster | private governance | no | guardian transaction signer |
| backup store | offline backup | no | backup encryption key |

All twelve trust-domain, service, network-policy, and deployment-evidence commitments must be unique. Credential-set commitments must be unique across all credential-bearing services. A credential-free role must use exact zero credential fields. Every transport is required to be encrypted, and credential validity is capped at ninety days.

The record and policy are bound to the exact public-testnet chain, gate, source commit, protocol version, deployment manifest, preparation time, and validity window. The infrastructure operator, Lightning operator, and security reviewer must use distinct operator IDs, signers, and identity evidence across at least two organization commitments. Those commitments and signatures do not establish real-world independence; reviewers must inspect the retained deployment, network, secret-scope, and rotation evidence.

## Attestation ceremony

Each role independently reproduces the same secret-free record and policy, then prepares its exact EIP-712 payload:

```sh
npm run prepare:service-isolation-attestation -- \
  --record isolation-record.json \
  --policy isolation-policy.json \
  --role security-reviewer \
  --operator-id 0x...
```

The command never accesses a key or signs. After collecting one signature per participant in canonical role order, verify the complete package:

```sh
npm run verify:service-isolation-evidence -- \
  --record isolation-record.json \
  --policy isolation-policy.json \
  --attestations isolation-attestations.json
```

Input files use the common bounded regular-file reader. Unknown fields, a missing service, shared trust domains or credential sets, unsafe ingress, plaintext transport, overbroad credential classes, invalid rotation windows, identity substitution, stale evidence, signature replay, and copied verification objects fail closed.

## Operational and release binding

Operational-readiness schema v2 adds one exact `serviceIsolation` artifact. Preparing or verifying that five-role package now requires the original isolation record, policy, and attestations. The isolation package is re-verified in the same process, its deployment and validity fields must match, and its derived evidence digest must equal the operational artifact. A copied JSON verification has no provenance and is rejected.

The public-testnet and tiny-limit bootstrap release-candidate commands also require the three isolation inputs. The signed isolation Lightning operator must be the exact operational and release-policy Lightning operator, while the signed isolation security reviewer must be the exact release-policy security reviewer. The infrastructure operator may not overlap an operational role, release authority, deployment wallet or attester, or independent reviewer. Their operational composite hashes include both the isolation evidence and participant-set digests, so changing any service, trust domain, credential scope, signer, or validity interval changes the release record and invalidates every release approval.

## Local qualification checkpoint

Clean published source `0bd76995350011fdaf4cdd2f1e22c3db47a2e4f8` passed 388 application/security tests, the production Vercel build, 68 contract tests, and all 37 sealed local campaigns from `2026-08-21T22:58:49.911Z` through `2026-08-22T00:07:59.522Z`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32534947589) passed the same exact source. The ignored mode-`0600` artifact independently reconstructs to `sha256:49fe2e48498ac10d251f975663bcdca17c1fd8a68ecb3c12e3502a67b75cc3a7`. All 116 configuration hashes, the exact 37-campaign order, regular-file safety, privacy exclusions, and regtest teardown reproduce independently.

This proves the repository boundary and local campaigns at that commit. It does not prove that twelve deployed services, separate trust domains, scoped production credentials, independent operators, external reviewers, public-testnet infrastructure, or a funding authority exist.

## Authority boundary

Preparation and verification expose no credential, endpoint, private key, raw signature in a summary, signing authority, broadcast authority, gate-opening authority, or funding capability. A valid record proves only that three keys signed the exact commitments. Production still requires deployed identities and networks, separately scoped secrets, encrypted independently retained backups, rotation/revocation tests, fresh-path restore evidence, witnessed review, and continuous monitoring.
