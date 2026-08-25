# Safety monitoring boundary

Status: one bounded fail-closed monitoring cycle, exact-two release-bound signed collectors per safety domain, exact-two policy-bound guardian broadcasters, exact-two policy-bound finalized gate confirmers, exact-two policy-bound alert routes, and a local actual-gate outage campaign are implemented. A continuously scheduled deployment, genuinely independently operated collectors, confirmers, and monitor instances, real redundant guardian transaction delivery, public alert routing, retention, and operator drills remain funding gates.

## Required observations

`lib/safety-monitor.mjs` requires exactly two fresh, digest-only observations from distinct policy-pinned operator commitments for each safety domain:

- BIT proxy, implementation, runtime code, decimals, and pause state;
- executable-price quorum;
- Ethereum canonical finality;
- EVM reconciliation-provider quorum;
- Lightning node health and chain progress;
- direction-specific solver capacity;
- BIT, Lightning, in-flight, and terminal asset reconciliation; and
- the secret-free audit pipeline.

The future BIT/WBTC pool remains one optional input to executable-price quorum, not a ninth safety domain or a settlement route. Its in-process verifier rejects unsafe BIT or WBTC state before that source can count. If it is unavailable, it contributes nothing; if the remaining eligible sources cannot meet the signed minimum, `price-quorum` must report unsafe. A failed optional venue does not halt a healthy bridge when the signed policy's other independent executable sources still provide quorum.

`lib/safety-observation-attestation.mjs` requires an exact, maximum-seven-day v4 policy bound to the release-record digest, chain, deployed gate, freshness limit, exactly two collectors for every domain, one quote-closure route, two guardian-broadcast routes, two gate-confirmation routes, and two alert routes. Collector identities and signers are globally unique; the two collectors in each domain must carry distinct operator commitments. All seven action-route identities are globally unique. Guardian broadcasters and gate confirmers use four globally distinct operator commitments; alert-route operators are distinct from one another. The same collector operator commitment may cover multiple observation domains with separate least-privilege keys. Each observation signature binds the policy digest, release digest, collector, kind, status, evidence digest, observation time, and expiry. The monitor accepts only the original same-process result of signature verification under the exact configured policy digest.

Before an action can run, `bindSafetyMonitorActions` matches every executable callback to those exact route and operator commitments and stores the functions only in module-private same-process provenance. A copied, serialized, missing, reordered, substituted, or extra-field action plan is non-executable and produces `MONITOR_ACTION_PLAN_INVALID`. A plan bound while the policy was active cannot later produce a healthy cycle after policy expiry: it produces `MONITOR_POLICY_INACTIVE` and may execute only the existing fail-safe closure/halt/alert path. Route commitments identify the reviewed configuration; they do not authenticate a remote service, prove delivery, or establish organizational independence. Those facts remain retained operational evidence.

After authentication, every monitor input deliberately contains only five fields: collector commitment, fixed kind, `healthy` or `unsafe` status, observed time, and a lowercase evidence digest. One missing collector is a collector outage, conflicting statuses are disagreement, and either condition takes the halt path. Duplicate collectors, future, stale, expired, unsafe, malformed, extra-field, unsigned, or wrong-policy input also produces fixed reason codes and halts. Canonical evidence ordering is independent of delivery order. The policy digest is included in the evidence-set and alert commitments. Raw invoices, preimages, signatures, keys, RPC URLs, unrestricted addresses, and remote error text are never copied into an alert.

## Halt ordering

One unsafe cycle performs four bounded stages in order:

1. close new RFQs and quote issuance;
2. attempt both policy-bound guardian broadcasters concurrently with independent timeouts and retain only exact nonzero transaction hashes bound to the same alert digest;
3. after both broadcast attempts finish, ask both policy-bound read-only confirmation providers to independently confirm one accepted transaction, its successful receipt and exact `Halted` event, canonical finalized block, exact gate address and alert digest, closed/emergency state, zero active risk, and no pending reopen; and
4. after both confirmation attempts finish, attempt both policy-bound alert routes concurrently with independent timeouts.

A guardian broadcaster's acceptance result is not onchain proof. The monitor establishes `onchainGateHalted` only when both configured confirmers return the same exact accepted transaction hash, block number and hash, gate address, alert digest, and fully closed gate state. One confirmer outage, timeout, malformed result, false-finality claim, wrong transaction, provider disagreement, open gate, residual active risk, or pending reopen leaves the halt incomplete. Alerts still run, so a confirmation failure cannot suppress escalation. One successful alert route is enough to establish alert delivery. The result exposes attempted and successful/delivered counts plus separate broadcaster, confirmer, and alert degradation flags. Noncanonical, zero-hash, wrong-digest, or secret-bearing extra-field callback results do not count and are never copied into output. Failed paging never reopens exposure. A healthy cycle performs no action and has no schedule/open authority. Reopening remains a separate controller/multisig procedure with a fresh reviewed risk digest and the immutable delay.

## Local evidence

Run:

```sh
npm run test:safety-monitor
```

The campaign deploys the actual `TreeSwapOpenGate` with distinct test-only controller and guardian contract callers, opens it through its real 24-hour delay, creates a release- and gate-bound policy with sixteen distinct test collector signers, two collector-operator commitments, two guardian-broadcast routes, two gate-confirmation routes, and two alert routes, then verifies the short-lived EIP-712 observations. It removes one BIT collector, closes quote issuance, deliberately fails one guardian route, halts through the other actual contract path, advances the test chain through genuine Anvil finalized-block behavior, and requires both read-only confirmers to agree on the successful halt receipt, event, finalized block, and exact closed state. It then deliberately fails one alert route and delivers through the other. A second campaign proves that two broadcaster callbacks claiming success cannot establish closure when their claimed transactions have no receipts. A healthy cycle invokes no action. A copied action plan invokes no route. Malformed, secret-bearing, divergent, unfinalized, wrong-transaction, open-state, residual-risk, pending-reopen, hostile-proxy, and timed-out confirmation results fail closed without suppressing alerts.

The deterministic v5 campaign digest is `0x6aa1e5046fb587f732d5387a0d218539f60d8b27eb61d28ef9b58e668e4bacf2`; its exact v4 monitor-policy digest is `0xbdf2e365f5c4aaf1385a50f0637c0380e0d9a25ce15554658be57ada73b2c207`. The harness uses a fixed evidence clock, asserts both commitments, configures a short deterministic Anvil epoch, and rejects a preoccupied RPC port so host timing or a stale process cannot change them. The contract suite separately proves an emergency halt blocks new reservations/opens while existing claims, refunds, and solver withdrawals remain callable.

Published checkpoint `4b40a3ca682b63f8d1fec11fa1900448d33676f5` passed 233 application/security tests, 81 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both web builds, this actual-gate campaign, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32345936040). All 28 sealed local qualification campaigns ran from `2026-08-20T07:52:32.228Z` through `2026-08-20T08:59:56.235Z`; independent canonical reconstruction matches `sha256:2644372eebed253ae9649c625a770953ed8c90b9d8da7876cb69ec514e265450`. The ignored mode-`0600` record is bound to clean published `main` and explicitly records local-only scope, a simulated EVM reservation, no public testnet, no production infrastructure, no independent review, and no funding authorization.

## Explicit limitations

This is a local one-process harness with nominal test operators, test collector keys, local action callbacks, two confirmations reading the same local backend, test-only alert sinks, and local controller/guardian signers. A valid signature authenticates the configured collector's claim; an operator or route commitment does not prove that a collector, broadcaster, confirmer, or alert provider is honest, online, independently controlled, or observing/delivering the claimed result. Two routes in one process prove protocol semantics, not operational independence. Production confirmers must use separately governed authenticated providers and independently reproduce the exact finalized receipt, event, block, and gate state. This is not a continuously scheduled service, independent observation network, public paging provider, production multisig, externally redundant transaction broadcaster, or incident drill. A process that is not running cannot submit a halt; production therefore also needs supervised redundant monitor instances and a short reviewed gate-attestation lifetime that bounds complete-monitor-outage exposure.

Before funded testnet, bind the exact monitor-policy digest into retained signed operational evidence, keep collector and confirmer credentials separate from controller, guardian, coordinator, and solver keys, deploy at least two supervised monitor instances in separate failure domains, use independently operated providers, route alerts to at least two operator channels, submit guardian halts through redundant authenticated broadcasters, prove dual-provider finalized-state agreement plus delivery and escalation, and repeat every incident while confirming outstanding exits remain available. The exact alert, monitor, drill, reconciliation, and retention commitments must pass the separate [operational-readiness evidence](./OPERATIONAL_READINESS_EVIDENCE.md) ceremony and match the signed bootstrap roster or campaign. No monitor may possess controller authority or automatically reopen the gate.
