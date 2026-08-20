# Safety monitoring boundary

Status: one bounded fail-closed monitoring cycle and a local actual-gate halt campaign are implemented. A continuously scheduled deployment, independently sourced observations, redundant guardian transaction delivery, public alert routing, retention, and operator drills remain funding gates.

## Required observations

`lib/safety-monitor.mjs` requires exactly one fresh, digest-only observation from each safety domain:

- BIT proxy, implementation, runtime code, decimals, and pause state;
- executable-price quorum;
- Ethereum canonical finality;
- EVM reconciliation-provider quorum;
- Lightning node health and chain progress;
- direction-specific solver capacity;
- BIT, Lightning, in-flight, and terminal asset reconciliation; and
- the secret-free audit pipeline.

Every observation has exactly four fields: fixed kind, `healthy` or `unsafe` status, observed time, and a lowercase evidence digest. Missing, duplicate, future, stale, unsafe, malformed, or extra-field input produces fixed reason codes and takes the halt path. Raw invoices, preimages, keys, RPC URLs, addresses, and remote error text are never copied into an alert.

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

The campaign deploys the actual `TreeSwapOpenGate` with distinct test-only controller and guardian contract callers, opens it through its real 24-hour delay, injects an unsafe BIT observation, closes quote issuance, submits the guardian halt, verifies the gate is closed, and only then records alert delivery. A healthy cycle cannot reopen it. An observation carrying an extra invoice-like field fails closed without copying that field into the alert.

The deterministic campaign digest is `0x74481a51a58446577c0b6ec3843b286abdd66af13b11e02a830881d3f03f2c32`. The contract suite separately proves an emergency halt blocks new reservations/opens while existing claims, refunds, and solver withdrawals remain callable.

## Explicit limitations

This is a local one-process harness with a test-only alert sink and local guardian signer. It is not a continuously scheduled service, independent observation network, public paging provider, production multisig, redundant transaction broadcaster, or incident drill. A process that is not running cannot submit a halt; production therefore also needs supervised redundant instances and a short reviewed gate-attestation lifetime that bounds monitor-outage exposure.

Before funded testnet, deploy the collectors and scheduler under separate identities, use independently operated providers, route alerts to at least two operator channels, submit guardian halts through redundant authenticated broadcasters, prove delivery and escalation, and repeat every incident while confirming outstanding exits remain available. No monitor may possess controller authority or automatically reopen the gate.
