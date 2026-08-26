# Wallet-session route independent review

Status: TreeSwap can reconstruct one exact published wallet-session route source package and verify short-lived EIP-712 attestations from two distinct external reviewer roles. The repository supplies no reviewer, organization, report, signature, deployed route, D1 access policy, secret, monitoring, release approval, or funding authority. A prepared or verified package is not permission to deploy.

## What this gate proves

The review artifact binds the exact Git commit and published branch plus the fixed set of route, D1 schema, session protocol, wallet edge, transport, hosting, threat-model, test, documentation, and review-verifier files. It is canonical JSON with an exact SHA-256 digest and one digest for every source file. Preparation requires a clean checkout whose current commit exactly equals the same branch on the canonical TreeSwap origin. Verification reconstructs every byte from that still-published remote commit and rejects a moved or deleted branch.

The two required roles are:

1. `application-security-reviewer`, covering the closed-test lock, signed request/response binding, read-only D1 query, fail-closed behavior, credential overlap, privacy, replay limits, causal separation across deployment preflight/postflight signatures, and absence of browser, wallet, Lightning, settlement, or funding authority; and
2. `platform-data-isolation-reviewer`, covering authoritative D1 binding, server-only runtime values, lack of application body logging, cache and disclosure headers, inert initialization, isolate/version limitations, the distinction between postflight claims and direct platform proof, and the external deployment evidence that remains missing.

Each role has one exact control-set digest. The policy requires separate reviewer identities, signers, organizations, and retained identity-evidence commitments. Each report must bind its role's complete control set, use status `repository-scope-passed-no-open-findings`, record zero open findings, and expire within the policy's maximum of 24 hours. Both reviewers sign the same artifact, policy, and complete report set.

Successful verification still reports these live facts as false:

- deployed route;
- D1 access-policy evidence;
- request/response body-log suppression;
- exact version retirement;
- monitoring and incident drills; and
- every deployment, signing, dispatch, settlement, gate-opening, and funding authorization.

## Prepare the exact artifact

Run this only after pushing the exact clean review branch:

```sh
npm run prepare:wallet-session-route-review -- \
  --out /secure-review/wallet-session-route-artifact.json
```

The output is created once as a mode-`0600` file. The receipt prints its exact branch, commit, artifact-file digest, and both role control-set digests without exposing source contents or secrets. Keep the artifact, reports, policy, and attestations outside Git.

A branch artifact supports pre-merge review only. Any merge, rebase, source edit, control change, or deployment change invalidates it. Before a release can rely on this gate, regenerate and re-review an artifact for the exact final commit published on `origin/main`.

## External reviewer ceremony

Each reviewer must independently clone the canonical repository, fetch the named branch and commit, regenerate the artifact, compare its bytes and digests, inspect the complete source and tests, and retain its report, finding details, identity evidence, and organizational-independence evidence privately.

The reviewers jointly prepare:

- `wallet-session-route-policy.json` using schema `treeswap.wallet-session-route-review-policy.v1`, environment `closed-test`, review scope `repository-only`, `deploymentEvidenceRequired: true`, the exact artifact/branch/commit, a lifetime no greater than 86,400 seconds, and both canonical reviewer records;
- `wallet-session-route-reports.json`, an array in canonical role order using schema `treeswap.wallet-session-route-review-report.v1`, the printed control-set digest, exact finding counts with `open: 0`, private report and disposition commitments, and a short review window; and
- one attestation per reviewer, ordered by canonical role, containing only `role`, `reviewerId`, `signer`, and `signature`.

No private key is accepted by repository tooling. Each reviewer prepares its own exact typed payload:

```sh
npm run prepare:wallet-session-route-review-attestation -- \
  --artifact /secure-review/wallet-session-route-artifact.json \
  --policy /secure-review/wallet-session-route-policy.json \
  --reports /secure-review/wallet-session-route-reports.json \
  --role application-security-reviewer
```

Repeat with `--role platform-data-isolation-reviewer`. The command first rebuilds the artifact from the exact still-published source, then prints EIP-712 data for offline signing. It never reads a key or signs anything.

After collecting both signatures, verify the complete package:

```sh
npm run verify:wallet-session-route-review -- \
  --artifact /secure-review/wallet-session-route-artifact.json \
  --policy /secure-review/wallet-session-route-policy.json \
  --reports /secure-review/wallet-session-route-reports.json \
  --attestations /secure-review/wallet-session-route-attestations.json \
  --out /secure-review/wallet-session-route-review-summary.json
```

The verifier rejects incomplete or reordered roles, shared identities/organizations/signers/evidence, missing controls, open findings, overlong or stale review windows, source drift, artifact mutation, copied or substituted signatures, extensible envelopes, and secret-bearing review material. The summary contains digests and explicit false authorities, not reports, signatures, wallets, session hashes, endpoints, or key material.

## Deployment gates that remain

Repository review does not verify Sites configuration. The next repository gate is the two-operator [wallet-session route deployment preflight](./WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT.md), which binds a short-lived, owner-only, non-production, no-body-capture plan to this original verified review without granting deployment authority. After an authorized private deployment, the three-observer [deployment postflight](./WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT.md) binds accountable claims and retained evidence commitments for private access, generated and separated route keys, non-production D1 use, CDN and application body-log suppression, cache behavior, exact version cutover and retirement, pinned wallet-edge HTTPS, external admission halt monitoring, D1 outage and rotation drills, backup/restore, and purge controls. Its verifier does not inspect the artifact contents or platform, so those controls still require independent live review, broader qualification, operational evidence, and release approvals already defined by the production checklist.

Executable Lightning/BIT pricing remains competing signed solver RFQs. `1 BIT = 100 sats` remains a non-binding reference. The absent BIT/WBTC pool contributes no price evidence and this review mechanism cannot change that boundary.
