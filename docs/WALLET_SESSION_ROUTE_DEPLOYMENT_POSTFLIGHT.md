# Wallet-session route deployment postflight

Status: repository-only verification for accountable live-deployment claims. This gate does not query Sites or D1, inspect retained evidence contents, establish observer independence, deploy a route, create credentials, activate the wallet edge, settle a swap, or authorize funding. Funded operation remains closed.

## Purpose

The private [deployment preflight](./WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT.md) approves only a plan. After authorized human operators eventually execute that plan, a separate postflight must bind what three distinctly identified observers claim they saw to the original review, exact deployment plan, configuration, and evidence custody. The packet enforces identity and organization separation; an external reviewer must still establish their real-world independence.

The required roles are:

- `sites-platform-observer` for exact source/version, private access, D1 bindings, runtime-value identities, initial credential state, and old-version retirement;
- `wallet-edge-observer` for pinned private access, signed active/inactive reads, forged/stale/failure behavior, no retry or asset action, admission closure, and paging; and
- `privacy-data-observer` for body-log/trace/analytics/cache suppression, telemetry privacy, D1 least privilege, backup/restore/purge evidence, and incident drills.

Each role has an exact six-control digest. All three observer identities, organizations, evidence, signers, collection methods, retained artifacts, custody records, and findings dispositions must be globally distinct. No observer may reuse either route reviewer or either deployment operator.

## Evidence boundary

The evidence schema is `treeswap.wallet-session-route-deployment-postflight-evidence.v1`. It must repeat the exact reviewed branch, commit, preflight evidence digest, plan digest, and every planned configuration value. The claimed deployment time must follow the later signed deployment-operator `attestedAt`, preventing a retroactive preflight. Public access, a production database, migration/R2 scope, a retiring initial credential, key reuse, body capture, or any other configuration drift fails because it no longer exactly matches the signed plan.

Each report must:

- use its canonical role and exact control-set digest;
- have status `live-private-deployment-controls-passed-no-open-findings`;
- record zero critical, high, medium, and open findings;
- commit to one collection method, evidence artifact, custody record, and findings disposition;
- be observed no more than ten minutes before verification, within two minutes of the other reports; and
- expire within fifteen minutes and no later than the signed deployment preflight.

The repository deliberately does not define a free-form evidence field. Raw dashboards, API responses, logs, keys, endpoints, session data, or screenshots stay in a private evidence store; only one-way commitments enter the ceremony.

## Ceremony

1. Complete the exact two-reviewer route ceremony and two-operator deployment preflight.
2. Authorized humans deploy only the approved private closed-test route.
3. Each observer independently collects and retains its live artifacts, verifies every assigned control, records findings, and prepares the common exact evidence JSON.
4. Each observer reconstructs the exact still-published route source and all upstream signatures, then prepares its EIP-712 payload:

   ```sh
   npm run prepare:wallet-session-route-deployment-postflight-attestation -- \
     --review-artifact route-artifact.json \
     --review-policy route-review-policy.json \
     --review-reports route-review-reports.json \
     --review-attestations route-review-attestations.json \
     --plan deployment-plan.json \
     --preflight-attestations deployment-preflight-attestations.json \
     --evidence deployment-postflight-evidence.json \
     --role sites-platform-observer
   ```

   Repeat for `wallet-edge-observer` and `privacy-data-observer`. The command emits typed data only; it accepts no private key and performs no signing or platform action.

5. Store three exact attestation records in canonical role order. Each contains only `role`, `observerId`, `signer`, `attestedAt`, and `signature`. Copy `attestedAt` from the prepared typed message; it is signed and must be no earlier than that observer's report and the claimed deployment.
6. Verify the complete packet while every upstream and report window remains valid:

   ```sh
   npm run verify:wallet-session-route-deployment-postflight -- \
     --review-artifact route-artifact.json \
     --review-policy route-review-policy.json \
     --review-reports route-review-reports.json \
     --review-attestations route-review-attestations.json \
     --plan deployment-plan.json \
     --preflight-attestations deployment-preflight-attestations.json \
     --evidence deployment-postflight-evidence.json \
     --attestations deployment-postflight-attestations.json \
     --out deployment-postflight-summary.json
   ```

Both commands reconstruct the exact remote source before processing and recheck that the branch still points to the same commit afterward. Output creation is exclusive and does not overwrite an existing file.

The short report window is a freshness boundary for this original ceremony, not a deadline for completing a credible later review. The downstream live-review tools revalidate the repository review, preflight, and postflight at their respective signed `attestedAt` boundaries. That historical reconstruction proves the original chain was valid then; it does not claim the old evidence is currently fresh or grant present authority.

## What a valid summary means

The summary separates accountable claims from verification performed by this software. It records that all three observers signed the complete claim set. It simultaneously records that this verifier did not query a platform API, inspect retained artifact contents, establish real organizational independence, complete a continuous monitoring window, complete independent live review, or establish broader release readiness.

Deployment, signing, wallet/Lightning dispatch, settlement, gate-opening, and funding authority remain false. A valid postflight must therefore go through the separate three-role, 24-hour [independent live-review boundary](./WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW.md). Those reviewers must inspect the retained artifacts and collection methods, examine whether observers and operators are actually independent, repeat critical platform checks directly, and retain a disposition before the wallet path can be considered for activation.

This gate does not change pricing: executable Lightning/BIT prices still come only from competing signed solver RFQs; `1 BIT = 100 sats` remains reference-only; and an absent BIT/WBTC pool contributes zero evidence.
