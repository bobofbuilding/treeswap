# Wallet-session route deployment preflight

Status: repository-only, secret-free deployment-plan validation. This gate does not deploy the wallet-session route, create or migrate a D1 database, configure Sites runtime values, sign on behalf of an operator, activate a wallet path, settle a swap, or authorize funding. Funded operation remains closed.

## Purpose

The wallet-session route needs a narrow private deployment before its first live closed-test exercise. A reviewed source tree is necessary but cannot prove the hosting configuration that will surround it. This preflight binds one still-unexecuted deployment plan to the exact independently reviewed and published route source and requires two separate operators to approve that plan:

- `sites-deployment-owner` controls the private Sites deployment boundary; and
- `wallet-edge-operations-owner` controls the only intended reader of the route.

The operators must have distinct signers, participant identities, organizations, and identity evidence. None may reuse either independent route reviewer or any reviewer commitment. The plan and approvals expire within one hour and cannot outlive the route review.

## Exact plan boundary

The JSON plan uses schema `treeswap.wallet-session-route-deployment-plan.v1`. It is accepted only when all of these properties are exact:

- source branch and commit equal the verified route-review artifact;
- route is `/api/internal/wallet-session-read` in `closed-test` mode;
- access is owner-only private, with no anonymous access, public bypass, workspace group, or external visitor;
- exactly two owners correspond to the two planned operators;
- existing `DB` is a non-production copy, with no migration or schema change;
- no R2 binding is present;
- runtime configuration comes only from Sites runtime values, never a process-environment fallback;
- initial rollout has no retiring credential slot;
- wallet-session request, wallet-session response, wallet-gateway request, and wallet-gateway response key IDs are four distinct non-secret SHA-256 identifiers;
- API origin and deployment identity are represented only by one-way digests, not endpoints;
- request/response logging, persistence, analytics, tracing, traffic capture, error-body retention, caching, and CDN caching are all disabled; and
- nine distinct policy digests bind access, body handling, D1 access, backup/restore, purge, incident drills, key custody, monitoring, and exact-version retirement.

The preflight rejects extra fields, accessors, inherited data, endpoints, private/public keys, session or invoice material, wallet addresses, tokens, authorization material, reused commitments, and noncanonical participant or attestation order.

## Ceremony

1. Publish the exact candidate branch without merging it.
2. Reconstruct the wallet-session route artifact from that remote commit.
3. Obtain the two independent route-review reports and EIP-712 attestations described in [Wallet-session route review](./WALLET_SESSION_ROUTE_REVIEW.md).
4. Author the exact secret-free deployment plan. `preparedAt` must be at or after both signed report times; `validUntil` must be no more than one hour later and no later than either signed review expiry. A later local re-verification does not move this signed time boundary.
5. Each planned operator independently reconstructs the published route and runs:

   ```sh
   npm run prepare:wallet-session-route-deployment-preflight-attestation -- \
     --review-artifact route-artifact.json \
     --review-policy route-review-policy.json \
     --review-reports route-review-reports.json \
     --review-attestations route-review-attestations.json \
     --plan deployment-plan.json \
     --role sites-deployment-owner
   ```

   The other operator uses `--role wallet-edge-operations-owner`. The command emits EIP-712 typed data only. It has no private-key input and performs no signing or deployment.

6. Store the signatures in canonical role order as exact records containing `role`, `participantId`, `signer`, the signed `attestedAt`, and `signature`. Each operator timestamp must follow the later repository-review attestation. The later operator timestamp is the earliest permitted deployment time; retroactive approval fails the downstream postflight.
7. Verify the complete packet while it is still valid:

   ```sh
   npm run verify:wallet-session-route-deployment-preflight -- \
     --review-artifact route-artifact.json \
     --review-policy route-review-policy.json \
     --review-reports route-review-reports.json \
     --review-attestations route-review-attestations.json \
     --plan deployment-plan.json \
     --attestations deployment-preflight-attestations.json \
     --out deployment-preflight-summary.json
   ```

Both commands reconstruct the exact remote source before processing and recheck that the remote branch still points to the same commit afterward. Output creation is exclusive and will not overwrite an existing summary.

## What the summary does not prove

A valid summary keeps every live-evidence flag false. A separate post-deployment capture still must prove the exact deployed route and version, D1 binding and data class, private access behavior, runtime-value identities, body-log suppression, version retirement, monitoring, and incident drills. That evidence must be independently reviewed before any wallet path can be activated.

The summary also keeps deployment, signing, dispatch, settlement, gate-opening, and funding authority false. It is an approval of a bounded plan, not permission for this repository or an automated agent to execute it.

## Remaining live sequence

After the independent review and this preflight both succeed, authorized human operators may perform a private closed-test deployment. They must complete the separate three-observer [deployment postflight](./WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT.md), retain secret-free commitments to evidence from the hosting platform, D1 control plane, fixed wallet edge, privacy systems, exact-version retirement, monitoring, and drills, keep the route closed and unfunded for at least 24 continuously monitored hours, and then complete the three-role [independent live review](./WALLET_SESSION_ROUTE_DEPLOYMENT_LIVE_REVIEW.md) over the retained facts. No public access, production session data, live swap, inventory, or pool funding belongs in that exercise.
