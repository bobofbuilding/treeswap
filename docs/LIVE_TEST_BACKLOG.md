# Live-test backlog

Inspected 2026-09-09 against published `main` at `6c304d3`, including rollout issue [#74](https://github.com/bobofbuilding/treeswap/issues/74), the launch checklist, and the scheduled monitor implementation. This is a working queue, not release evidence or authorization. The full requirements remain in [Launch checklist](./LAUNCH_CHECKLIST.md) and [Production readiness](./PRODUCTION_READINESS.md).

## Completed in this pass

- Reproduced a missing timeout in the scheduled account monitor: a stalled D1 probe or R2 write could prevent escalation indefinitely. Rejected observer responses could also hang while awaiting body cancellation.
- Added fixed 15-second storage deadlines and nonblocking observer cleanup. Missing database observations take the existing unsafe path; retention timeouts trigger both alert routes without a success receipt or write retry.
- Added a regression covering stalled D1, stalled R2, rejected-response cancellation, and an unfinished observer body. It also resolves an R2 write after timeout and verifies that no positive receipt or second write appears.
- Updated Next.js and its lint configuration to 16.3.4, Cloudflare's Vite plugin to 1.54.6, Wrangler to 4.130.0, and the matching Worker types. Refreshed affected transitive dependencies. The previous lockfile had one critical and seven high audit entries, including the [Next.js AVIF advisory](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4). A narrow `miniflare` override pins `sharp` to 0.35.4 because even the updated parent pins the affected 0.35.2; remove the override once the parent itself selects a patched version. See the [sharp advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).

## Validation and limits

- Both production web builds and lint pass with the updated dependencies on Node 22.22.0.
- Application suite on Node 22.22.0: 916 passed, one deliberate runtime-only skip; the isolated coordinator run separately passes that activation case.
- Solidity suite: 69 passed. Pinned coordinator container: 339 passed plus the separate activation case, both disk-full checks, and closed-start health check.
- Closed deployment rehearsal: passed against disposable local Anvil, including generated deployment execution, signed preflight/postflight, closed gate, sealed registry, and zero balances. Its providers and wallets are test fixtures, not independent live operators.
- Production application and coordinator dependency audits: zero reported vulnerabilities. The full dependency audit passes the existing high-severity threshold; four moderate entries remain in the development-only Drizzle Kit / old esbuild chain. Track an upstream-compatible fix; the audit's suggested downgrade to Drizzle Kit 0.18.1 is a breaking change, not an adopted remediation.
- These checks do not replace the sealed full Lightning campaign, current hosted CI, exact-source deployment, or external review. No new sealed qualification artifact was created from the modified working tree.

## Next engineering work

1. **Complete the monitor's backing services.** The scheduled monitor consumes authenticated access and maintenance observations plus two paging Service Bindings, but those real service deployments remain absent. Implement and test the maintenance observer against checksum-verified retained scheduler evidence, with exact source/deployment/database binding and stale/failed/backlogged/missing-object rejection. Complete the access collector using the independently reviewed control-plane audit scope; do not invent query-level D1 audit visibility. Build paging acknowledgements from actual provider acceptance, and add an external missing-Cron alarm. Acceptance: source-backed observations and witnessed delivery/failure tests through the private service composition.
2. **Exercise the deployed wallet journey in both directions.** Integrate the existing two readable signing prompts with the closed-test wallet flow, selected-solver finalization, session reader, and durable coordinator. Verify account/chain changes, expiry, cancellation, restart, ambiguous delivery, exact invoice binding, and recovery. Acceptance: retained journey evidence from the actual reviewed private deployment, followed by approved tiny-testnet transactions when the bootstrap release permits them.
3. **Requalify the final source.** After the engineering changes are reviewed and published, run the sealed local campaign and independent verifier against that exact clean `origin/main`. Reproduce both web builds, contract suite, pinned coordinator runtime and disk-full recovery, the full Lightning fault matrix, and the real one-hour guard with restart. Historical qualification digests from issue #74 do not qualify this changed tree.

Accounts remain optional. If the approved test configuration disables them, account-adoption ceremonies can be deferred; the wallet flow must still meet its own authentication, privacy, and authorization requirements. Do not remove a required session binding merely to avoid account work.

## External prerequisites, in dependency order

| Stage | Required result before advancing |
| --- | --- |
| Independent BIT evidence | Two genuinely independent provider observations, separate provider/contract reviewers, retained reports, and the reviewed token manifest. See [BIT ceremony preflight](./BIT_CEREMONY_PREFLIGHT.md). |
| Closed Sepolia deployment | Three distinct reviewed contract wallets, signed preflight, closed gate/registry/escrows, sealed registry, exact runtime/role/zero-balance postflight. See [Closed testnet deployment](./CLOSED_TESTNET_DEPLOYMENT.md). |
| Private service operation | Independently operated solvers, relays, readers, Lightning adapters, coordinator, monitors and paging; scoped credentials, encrypted transport, retained key custody, working backups and restore. |
| Account adoption, if enabled | Real D1 least-privilege review; route review/preflight/postflight; scheduled purge and monitor deployments; independently aged deletion fixtures; witnessed storage, audit, paging and restore drills; 24-hour retained monitoring and independent live review. |
| Tiny bootstrap approval | Independent security and operational evidence, tested incident handling, exact inventory/fee/risk limits, and all required release-role signatures. Reconstruct and activate through the existing bootstrap release verifier before any funded test. |
| Public-testnet campaign | At least seven days, two independent solvers, at least twenty selected swaps per solver with ten per direction, all mandatory failure scenarios, aggregate reliability metrics, and a final closed gate with zero liabilities. |
| Later funded beta | Campaign-qualified approvals, findings dispositions, published caps/support/loss policy, and a release schema that actually authorizes the target environment. Current release v2 rejects mainnet. |

The bootstrap path exists to start the constrained campaign without pretending that seven days of campaign evidence already exists. It still requires its own independent review, operations, deployment, and approval evidence. A BIT/WBTC pool is optional; its absence does not waive the current independent market/risk evidence requirements.

No deployment, provider independence, reviewer conclusion, signature, live swap, or funding readiness is established by this inspection.
