# D1 access and least-privilege review

Status: the repository can verify a short-lived, two-reviewer attestation over one exact D1 access policy and one exact set of direct platform-inspection evidence. No reviewer, Cloudflare account, D1 database, credential, platform query, mutation, deployment, or production authorization is supplied.

## Risk boundary

D1 account data is optional and cannot move BIT or Lightning, but it still contains sensitive authentication and notification records. TreeSwap must not enable accounts for adoption until independent reviewers reconstruct every effective access path. Looking only at direct account-member roles is insufficient because effective permission is the union of direct member policies, user-group membership, inherited group policies, account-owned API credentials, and deployed Worker bindings.

The review uses Cloudflare's current [Permission Groups API](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), not legacy role identifiers. Cloudflare deprecated the account Roles API in favor of Permission Groups in July 2026. The ceremony must retain the exact permission-group names and identifiers observed at review time because names and product permissions can evolve.

TreeSwap requires a dedicated Cloudflare account for the reviewed D1 environment. D1 API credentials are account-scoped rather than bound to one database, so a long-lived D1 credential in a mixed-purpose account would expose unrelated databases. Application runtimes use database-specific Worker bindings instead. On-demand backup access is short-lived, account-owned, D1 Read only, and revoked after the ceremony.

## Exact principal policy

The policy contains eight canonical principals. Each principal identity, resource scope, and credential-custody record is represented by a separate nonzero commitment.

| Principal | Credential class | Effective capability | Standing | Required compensation |
| --- | --- | --- | --- | --- |
| Account web runtime | Worker D1 binding | D1 read/write | Yes | Exact reviewed source and database-specific binding |
| Wallet-session provider | Isolated Worker D1 binding | Technically D1 read/write; reviewed source issues one fixed bounded read | Yes | Separate deployment/failure domain, signed requests, source review |
| Maintenance scheduler | Scheduled Worker D1 and R2 bindings | D1 read/write plus R2 evidence write | Yes | No HTTP handler, fixed Cron, bounded transaction, locked evidence |
| Storage monitor | Isolated Worker D1 binding | Technically D1 read/write; reviewed source issues aggregate reads | Yes | Separate deployment, fixed aggregate queries, alerting |
| Backup export operator | On-demand account-owned API credential | Account-scoped D1 Read | No | Two-party creation, at most one hour, write-denial test, revocation |
| Deployment operator | Phishing-resistant account-member session | Worker deployment control with transitive D1 access | Yes | Two-party source/deployment approval, at most 12-hour session |
| Access-audit observer | Account-owned read credential | Membership, policy, credential-inventory, and audit read | Yes | No D1 permission, at most 24-hour credential, independent monitor |
| Break-glass recovery operator | Dormant phishing-resistant member | No standing D1 capability | No | Two-party activation, at most one hour, witnessed revocation |

A Worker D1 binding is not a platform-enforced read-only capability. Even the wallet-session provider and storage monitor are recorded as technically write-capable. Their narrower use is enforced by isolated, exact reviewed source and deployment controls. The review must reject any claim that relabels these bindings as platform-enforced D1 Read.

The deployment operator is also treated as transitively capable: a malicious deployment could change code that uses an existing D1 binding. Direct D1-query denial alone does not make a deployment principal low risk. Two-party deployment approval, exact source binding, short interactive sessions, immutable deployment evidence, and continuous change monitoring are mandatory compensating controls.

## Required private inspection package

The candidate uses `treeswap.d1-access-least-privilege-policy.v1` and `treeswap.d1-access-least-privilege-review-record.v1`. It binds the exact clean branch, published commit, deployment version, dedicated account, database, principal set, reviewer set, and separate commitments for:

- the current Permission Groups API response;
- all direct account-member policies;
- every user-group membership and inherited group policy;
- the reconstructed effective permission union for every member and service identity;
- the complete account-owned credential inventory and evidence that user-owned API credentials and global API keys are absent;
- every Worker-to-D1 binding and deployed source/version;
- documented D1 audit-log coverage;
- application-level query-audit compensation;
- the exact observed principal inventory;
- negative authority tests;
- revocation and rotation evidence;
- direct platform-inspection evidence;
- one separate direct-inspection record, full report, findings disposition, and exact finding counts for each reviewer, with no commitment reuse; and
- no open critical, high, medium, low, or otherwise unresolved finding in either report.

Cloudflare's [D1 audit logs](https://developers.cloudflare.com/d1/observability/audit-logs/) cover documented control-plane operations but do not provide a complete query-level record of every row read and write. The record must therefore set `queryLevelD1AuditCoverageClaimed` to `false` and bind separately reviewed application/Worker query-audit compensation. Claiming complete query-level coverage from D1 audit logs fails verification.

## Mandatory negative tests

Reviewers must exercise the exact deployed identities without retaining credential values or account records in the public summary:

1. a revoked credential is denied after cache and session expiry;
2. the on-demand backup credential can export/read but cannot write;
3. the access-audit observer has no D1 query capability;
4. a deployment credential cannot directly query D1, while its transitive code-deployment authority remains explicitly recorded;
5. no browser bundle, browser runtime value, public route, or repository artifact contains a D1 credential;
6. every runtime binding matches the exact database and reviewed deployment version;
7. the maintenance scheduler has no HTTP handler or reusable browser credential;
8. every direct and inherited policy union is reconstructed from current permission groups;
9. user-owned API credentials, global API keys, and routine standing human direct-D1 credentials are absent;
10. no principal outside the eight-role policy can reach the database or change a bound deployment; and
11. account-owned credentials and break-glass activation expire and are revoked within their policy limits.

The negative-test evidence must be independent from the policy snapshots, reviewer identities, report, disposition, and all other evidence commitments.

## Independent review ceremony

Two reviewers from distinct organizations and with distinct EIP-712 signers are required:

- `cloudflare-access-security-reviewer` reconstructs permission groups, members, groups, credentials, bindings, transitive deployment authority, expiration, revocation, and negative tests.
- `data-privacy-least-privilege-reviewer` traces every D1 data action to a purpose, reviews query minimization and application-level audit compensation, and confirms no browser, account, payment, or settlement authority is introduced.

The review window is at most six hours. Both attestations must be produced after inspection completes and expire no more than 24 hours later. The policy defaults should be materially shorter. Any source, deployment version, database, account, principal, credential class, resource scope, permission group, group membership, binding, evidence, finding, or reviewer change invalidates the ceremony.

Prepare each reviewer message only from a clean branch whose exact commit is published on `origin`:

```sh
npm run prepare:d1-access-policy-review-attestation -- \
  --candidate /secure-review/d1-access-candidate.json \
  --role cloudflare-access-security-reviewer
```

Repeat for `data-privacy-least-privilege-reviewer`, sign the displayed EIP-712 message outside this repository, and verify both signatures:

```sh
npm run verify:d1-access-policy-review -- \
  --candidate /secure-review/d1-access-candidate.json \
  --attestations /secure-review/d1-access-attestations.json \
  --out /secure-review/d1-access-summary.json
```

The verified summary is secret-free. Keep the candidate, raw platform responses, negative-test transcripts, reviewer reports, dispositions, identities, organization evidence, and signatures in the approved private evidence store.

## What verification does not prove

The local verifier authenticates internally consistent signed claims. It does not query Cloudflare, inspect a credential, establish reviewer competence or independence, exercise a permission, revoke access, deploy a Worker, enable accounts, dispatch a wallet or Lightning payment, settle a swap, fund liquidity, open a release gate, or prove continuous monitoring.

The parent launch-checklist item remains open until the real dedicated account and final deployed version pass this ceremony. The result must then be consumed by the wallet-session deployment postflight/live review and account-storage monitor. Any subsequent access change requires immediate account-route closure, credential review, a fresh ceremony, and a new monitored observation window.
