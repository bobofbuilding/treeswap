# Safety monitoring boundary

Status: one bounded fail-closed monitoring cycle, exact-two release-bound signed collectors per safety domain, exact-two policy-bound guardian broadcasters, exact-two policy-bound alert routes, and a local actual-gate collector/broadcaster/alert-outage campaign are implemented. A continuously scheduled deployment, genuinely independently operated collectors and monitor instances, real redundant guardian transaction delivery, public alert routing, retention, and operator drills remain funding gates.

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

`lib/safety-observation-attestation.mjs` requires an exact, maximum-seven-day v3 policy bound to the release-record digest, chain, deployed gate, freshness limit, exactly two collectors for every domain, one quote-closure route, two guardian-broadcast routes, and two alert routes. Collector identities and signers are globally unique; the two collectors in each domain must carry distinct operator commitments. Guardian-broadcast operators are distinct from one another, alert-route operators are distinct from one another, and all five action-route identities are globally unique. The same operator commitment may cover multiple domains with separate least-privilege keys. Each observation signature binds the policy digest, release digest, collector, kind, status, evidence digest, observation time, and expiry. The monitor accepts only the original same-process result of signature verification under the exact configured policy digest.

Before an action can run, `bindSafetyMonitorActions` matches every executable callback to those exact route and operator commitments and stores the functions only in module-private same-process provenance. A copied, serialized, missing, reordered, substituted, or extra-field action plan is non-executable and produces `MONITOR_ACTION_PLAN_INVALID`. A plan bound while the policy was active cannot later produce a healthy cycle after policy expiry: it produces `MONITOR_POLICY_INACTIVE` and may execute only the existing fail-safe closure/halt/alert path. Route commitments identify the reviewed configuration; they do not authenticate a remote service, prove delivery, or establish organizational independence. Those facts remain retained operational evidence.

After authentication, every monitor input deliberately contains only five fields: collector commitment, fixed kind, `healthy` or `unsafe` status, observed time, and a lowercase evidence digest. One missing collector is a collector outage, conflicting statuses are disagreement, and either condition takes the halt path. Duplicate collectors, future, stale, expired, unsafe, malformed, extra-field, unsigned, or wrong-policy input also produces fixed reason codes and halts. Canonical evidence ordering is independent of delivery order. The policy digest is included in the evidence-set and alert commitments. Raw invoices, preimages, signatures, keys, RPC URLs, unrestricted addresses, and remote error text are never copied into an alert.

## Halt ordering

One unsafe cycle performs three bounded stages in order:

1. close new RFQs and quote issuance;
2. attempt both policy-bound guardian broadcasters concurrently with independent timeouts, accepting closure only when at least one returns an exact nonzero transaction hash bound to the same alert digest; and
3. after both broadcast attempts finish, attempt both policy-bound alert routes concurrently with independent timeouts.

One successful guardian route is enough to establish the local halt result; one successful alert route is enough to establish alert delivery. The result always exposes attempted and successful/delivered counts plus separate guardian and alert degradation flags. Two failures make the halt incomplete or the alert undelivered. Noncanonical, zero-hash, wrong-digest, or secret-bearing extra-field callback results do not count and are never copied into output. Failed paging never reopens exposure. A healthy cycle performs no action and has no schedule/open authority. Reopening remains a separate controller/multisig procedure with a fresh reviewed risk digest and the immutable delay.

## Local evidence

Run:

```sh
npm run test:safety-monitor
```

The campaign deploys the actual `TreeSwapOpenGate` with distinct test-only controller and guardian contract callers, opens it through its real 24-hour delay, creates a release- and gate-bound policy with sixteen distinct test collector signers, two collector-operator commitments, two guardian-broadcast routes, and two alert routes, then verifies the short-lived EIP-712 observations. It removes one BIT collector, closes quote issuance, deliberately fails one guardian route, halts through the other actual contract path, deliberately fails one alert route, and delivers through the other only after the gate is closed. Both degradations are explicit. A healthy cycle invokes no action. A copied action plan invokes no route. An observation carrying an extra invoice-like field loses its same-process signature provenance, fails closed, and cannot copy that field into the alert.

The deterministic v4 campaign digest is `0x562faa1cb1fb8b80cd02ee3d74cea7b845126a1ba8a07fc092ccb522881cdb81`; its exact v3 monitor-policy digest is `0xf0bc1d21383118d59270adf4612684d35e0594afe4d15d63ec4848f8e43cf3d2`. The harness uses a fixed evidence clock, asserts both commitments, and rejects a preoccupied RPC port so host timing or a stale process cannot change them. The contract suite separately proves an emergency halt blocks new reservations/opens while existing claims, refunds, and solver withdrawals remain callable.

Published checkpoint `4b40a3ca682b63f8d1fec11fa1900448d33676f5` passed 233 application/security tests, 81 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both web builds, this actual-gate campaign, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32345936040). All 28 sealed local qualification campaigns ran from `2026-08-20T07:52:32.228Z` through `2026-08-20T08:59:56.235Z`; independent canonical reconstruction matches `sha256:2644372eebed253ae9649c625a770953ed8c90b9d8da7876cb69ec514e265450`. The ignored mode-`0600` record is bound to clean published `main` and explicitly records local-only scope, a simulated EVM reservation, no public testnet, no production infrastructure, no independent review, and no funding authorization.

## Explicit limitations

This is a local one-process harness with nominal test operators, test collector keys, local action callbacks, test-only alert sinks, and local controller/guardian signers. A valid signature authenticates the configured collector's claim; an operator or route commitment does not prove that a collector, broadcaster, or alert provider is honest, online, independently controlled, or observing/delivering the claimed result. Two routes in one process prove failover semantics, not operational redundancy. This is not a continuously scheduled service, independent observation network, public paging provider, production multisig, externally redundant transaction broadcaster, or incident drill. A process that is not running cannot submit a halt; production therefore also needs supervised redundant monitor instances and a short reviewed gate-attestation lifetime that bounds complete-monitor-outage exposure.

Before funded testnet, bind the exact monitor-policy digest into retained signed operational evidence, keep collector keys separate from controller, guardian, coordinator, and solver keys, deploy at least two supervised monitor instances in separate failure domains, use independently operated providers, route alerts to at least two operator channels, submit guardian halts through redundant authenticated broadcasters, prove delivery and escalation, and repeat every incident while confirming outstanding exits remain available. The exact alert, monitor, drill, reconciliation, and retention commitments must pass the separate [operational-readiness evidence](./OPERATIONAL_READINESS_EVIDENCE.md) ceremony and match the signed bootstrap roster or campaign. No monitor may possess controller authority or automatically reopen the gate.
