# Safety monitoring boundary

Status: one bounded fail-closed monitoring cycle, exact-two release-bound signed collectors per safety domain, and a local actual-gate collector-outage halt campaign are implemented. A continuously scheduled deployment, genuinely independently operated collectors and monitor instances, redundant guardian transaction delivery, public alert routing, retention, and operator drills remain funding gates.

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

`lib/safety-observation-attestation.mjs` requires an exact, maximum-seven-day v2 policy bound to the release-record digest, chain, deployed gate, freshness limit, and exactly two collectors for every domain. Collector identities and signers are globally unique; the two collectors in each domain must carry distinct operator commitments. The same operator commitment may cover multiple domains with separate least-privilege keys. Each observation signature binds the policy digest, release digest, collector, kind, status, evidence digest, observation time, and expiry. The monitor accepts only the original same-process result of signature verification under the exact configured policy digest. Unsigned JSON, copied verified objects, changed policy, reused collector identities or signers, same-operator pairs, expired signatures, and freshness settings that differ from policy fail closed.

After authentication, every monitor input deliberately contains only five fields: collector commitment, fixed kind, `healthy` or `unsafe` status, observed time, and a lowercase evidence digest. One missing collector is a collector outage, conflicting statuses are disagreement, and either condition takes the halt path. Duplicate collectors, future, stale, expired, unsafe, malformed, extra-field, unsigned, or wrong-policy input also produces fixed reason codes and halts. Canonical evidence ordering is independent of delivery order. The policy digest is included in the evidence-set and alert commitments. Raw invoices, preimages, signatures, keys, RPC URLs, unrestricted addresses, and remote error text are never copied into an alert.

## Halt ordering

One unsafe cycle performs three bounded steps in order:

1. close new RFQs and quote issuance;
2. submit the same alert digest to `TreeSwapOpenGate.halt` through the guardian boundary; and
3. deliver the fixed secret-free alert after both closure attempts.

The result distinguishes complete closure, closure with failed alert delivery, and incomplete closure. Failed paging never reopens exposure. A healthy cycle performs no mutation and has no schedule/open authority. Reopening remains a separate controller/multisig procedure with a fresh reviewed risk digest and the immutable delay.

## Local evidence

Run:

```sh
npm run test:safety-monitor
```

The campaign deploys the actual `TreeSwapOpenGate` with distinct test-only controller and guardian contract callers, opens it through its real 24-hour delay, creates a release- and gate-bound policy with sixteen distinct test collector signers and two operator commitments, verifies their short-lived EIP-712 observations, removes one BIT collector, closes quote issuance, submits the guardian halt, verifies the gate is closed, and only then records alert delivery. A healthy cycle cannot reopen it. An observation carrying an extra invoice-like field loses its same-process signature provenance, fails closed, and cannot copy that field into the alert.

The deterministic v3 campaign digest is `0x7edc064bdc0a21005230490fd75116040a32e923c7a008e29a40cbc23707a8e0`; its exact monitor-policy digest is `0x72cc9e332186f72a82c986c40cde2cb48b88b50ec2ab49a37f5de7a41c49e642`. The contract suite separately proves an emergency halt blocks new reservations/opens while existing claims, refunds, and solver withdrawals remain callable.

Published checkpoint `4b40a3ca682b63f8d1fec11fa1900448d33676f5` passed 233 application/security tests, 81 direct pinned-runtime tests plus the bounded-filesystem rollback campaign, 68 contract tests, both web builds, this actual-gate campaign, and [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32345936040). All 28 sealed local qualification campaigns ran from `2026-08-20T07:52:32.228Z` through `2026-08-20T08:59:56.235Z`; independent canonical reconstruction matches `sha256:2644372eebed253ae9649c625a770953ed8c90b9d8da7876cb69ec514e265450`. The ignored mode-`0600` record is bound to clean published `main` and explicitly records local-only scope, a simulated EVM reservation, no public testnet, no production infrastructure, no independent review, and no funding authorization.

## Explicit limitations

This is a local one-process harness with two nominal test operators, test collector keys, a test-only alert sink, and a local guardian signer. A valid signature authenticates the configured collector's claim; an operator commitment does not prove the collector is honest, online, organizationally independent, or observing an independent correct upstream system. Two keys in one process prove the protocol, not operational redundancy. This is not a continuously scheduled service, independent observation network, public paging provider, production multisig, redundant transaction broadcaster, or incident drill. A process that is not running cannot submit a halt; production therefore also needs supervised redundant monitor instances and a short reviewed gate-attestation lifetime that bounds complete-monitor-outage exposure.

Before funded testnet, bind the exact monitor-policy digest into retained signed operational evidence, keep collector keys separate from controller, guardian, coordinator, and solver keys, deploy at least two supervised monitor instances in separate failure domains, use independently operated providers, route alerts to at least two operator channels, submit guardian halts through redundant authenticated broadcasters, prove delivery and escalation, and repeat every incident while confirming outstanding exits remain available. The exact alert, monitor, drill, reconciliation, and retention commitments must pass the separate [operational-readiness evidence](./OPERATIONAL_READINESS_EVIDENCE.md) ceremony and match the signed bootstrap roster or campaign. No monitor may possess controller authority or automatically reopen the gate.
