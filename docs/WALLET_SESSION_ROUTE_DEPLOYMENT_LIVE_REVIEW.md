# Wallet-session route deployment live review

Status: repository-only verification of three signed independent-live-review claims. This gate does not query Sites or D1, inspect retained evidence itself, establish real-world independence or reviewer competence, observe the monitoring window, deploy a route, create credentials, activate the wallet edge, settle a swap, or authorize funding. Funded operation remains closed.

## Purpose

The [deployment postflight](./WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT.md) proves only that three observers signed a common set of live claims. The live-review boundary requires three new reviewers to inspect the privately retained artifacts, reproduce critical controls, examine real-world independence, and sign their conclusions after at least 24 continuous hours of private monitoring.

The original review, operator preflight, and observer postflight remain short-lived freshness ceremonies. They are reconstructed later at their own signed evidence boundaries rather than falsely presented as currently fresh. This historical reconstruction verifies the original signatures, ordering, source, configuration, and validity windows; it grants no present authority and does not excuse a later source or configuration change.

The required roles are:

- `platform-control-live-reviewer` for direct platform/API, access, binding, runtime-value identity, version-retirement, cache/routing, and retained-platform-artifact checks;
- `wallet-security-live-reviewer` for direct pinned-edge/TLS, signed read, forged/stale/replay, outage/latency/clock, rotation, no-action, browser-exclusion, and exclusive-ownership checks; and
- `privacy-operations-live-reviewer` for every body-retention layer, telemetry privacy, D1 least privilege, backup/restore/purge, real-world independence, continuous monitoring, incident drills, custody, and findings disposition.

Each role has one exact seven-control digest. All three reviewer identities, organizations, identity evidence, and signers must be distinct from one another and from both repository reviewers, both deployment operators, and all three postflight observers.

## Timing and evidence

The policy is `treeswap.wallet-session-route-deployment-live-review-policy.v1`. It binds the exact source, postflight evidence and record, configuration, monitoring interval, reviewer set, and validity interval.

The monitoring interval must:

- begin no earlier than the claimed private deployment;
- last at least 86,400 seconds;
- end no earlier than the final postflight observer attestation; and
- end within seven days of that attestation.

The policy is prepared after the monitoring interval and remains valid for at most 24 hours. Every report must follow the policy, use its canonical role and complete control set, record zero critical, high, medium, and open findings, and expire within that same bounded window.

Each report commits separately to its private report, direct platform query, retained-artifact inspection, independence evidence, direct reproduction, monitoring evidence, and complete findings disposition. Every commitment must be distinct from every other live-review and upstream evidence commitment. Raw platform responses, endpoints, credentials, logs, traffic captures, wallets, sessions, and identity records remain in the private evidence store.

## Ceremony

1. Retain the exact repository-review artifact, policy, reports, and signatures; deployment plan and operator signatures; and postflight evidence and observer signatures.
2. Keep the private deployment closed and unfunded for at least 24 continuous monitored hours.
3. Each live reviewer independently inspects its assigned original artifacts, repeats its direct checks, verifies custody and findings, and prepares the common exact policy and report set.
4. Each reviewer reconstructs the exact still-published source and all historical signatures, then prepares its EIP-712 payload:

   ```sh
   npm run prepare:wallet-session-route-deployment-live-review-attestation -- \
     --review-artifact route-artifact.json \
     --review-policy route-review-policy.json \
     --review-reports route-review-reports.json \
     --review-attestations route-review-attestations.json \
     --plan deployment-plan.json \
     --preflight-attestations deployment-preflight-attestations.json \
     --postflight-evidence deployment-postflight-evidence.json \
     --postflight-attestations deployment-postflight-attestations.json \
     --live-review-policy deployment-live-review-policy.json \
     --live-review-reports deployment-live-review-reports.json \
     --role platform-control-live-reviewer
   ```

   Repeat for `wallet-security-live-reviewer` and `privacy-operations-live-reviewer`. The command emits typed data only; it accepts no private key and performs no signing or platform action.

5. Store three exact attestation records in canonical role order. Each contains only `role`, `reviewerId`, `signer`, `attestedAt`, and `signature`. The signed timestamp must follow that reviewer's report.
6. Verify the full packet while the live-review reports remain valid:

   ```sh
   npm run verify:wallet-session-route-deployment-live-review -- \
     --review-artifact route-artifact.json \
     --review-policy route-review-policy.json \
     --review-reports route-review-reports.json \
     --review-attestations route-review-attestations.json \
     --plan deployment-plan.json \
     --preflight-attestations deployment-preflight-attestations.json \
     --postflight-evidence deployment-postflight-evidence.json \
     --postflight-attestations deployment-postflight-attestations.json \
     --live-review-policy deployment-live-review-policy.json \
     --live-review-reports deployment-live-review-reports.json \
     --live-review-attestations deployment-live-review-attestations.json \
     --out deployment-live-review-summary.json
   ```

Both commands reconstruct the exact remote route source before processing and recheck that the published branch still points to the same commit afterward. Output creation is exclusive and does not overwrite an existing file.

## What a valid result means

A valid result proves that three distinct policy-pinned signers authenticated the exact report set and claimed that they directly inspected and reproduced the required live controls with no blocking findings.

It does not prove those claims are true. The verifier itself does not query a platform API, inspect an artifact, establish legal or organizational independence, observe the monitoring interval, or assess reviewer competence. It also does not establish the broader EVM, Lightning, solver, coordinator, multisig, incident, reconciliation, testnet, or adoption gates.

Deployment, signing, wallet/Lightning dispatch, settlement, gate-opening, and funding authority remain false. Any source, route, configuration, key, access, data, provider, identity, or operating-set change requires the appropriate ceremonies to be repeated.

This gate does not change pricing: executable Lightning/BIT prices still come only from competing signed solver RFQs; `1 BIT = 100 sats` remains reference-only; and an absent BIT/WBTC pool contributes zero evidence.
