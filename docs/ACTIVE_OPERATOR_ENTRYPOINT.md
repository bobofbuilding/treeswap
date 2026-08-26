# Active operator entrypoint

TreeSwap's funded coordinator must be started through
`startCoordinatorActiveOperatorService` in
`lib/coordinator-active-operator-policy.mjs`. The lower-level active service is
reusable lifecycle infrastructure; it is not the deployment entrypoint.

The operator entrypoint accepts one original, one-use policy preparer created by
`createCoordinatorActiveOperatorPolicyPreparer`. Each configured solver policy
must contain all of the following original same-process objects:

- a `createSolverCapabilityClient` result that performs a fresh public HTTPS
  capability challenge using the module-owned Node HTTPS transport, system
  clock, cryptographic entropy, local LND compact-signature recovery, the
  finalized two-provider BIT vault reader, and a separately signed production
  Lightning-capacity reader created with `createAuthenticatedLightningCapacityReader`.
  That reader uses its own module-owned private Node HTTPS `/v1/capacity`
  transport, pins one address only after every DNS answer is private while
  preserving hostname verification, fixes the system clock and cryptographic
  entropy, bounds the complete response, and requires one exact private
  port-443 observer origin;
- a `createAuthenticatedPrivatePacketClient` result using the module-owned fixed
  Node HTTPS transport, system clock, and cryptographic request-ID source, with
  a requester key distinct from the provider key; every DNS answer must be
  private before one address is pinned while TLS and HTTP retain the reviewed
  hostname;
- a `createSolverDaemonEvidenceControls` result using two distinct private
  HTTPS routes, the module-owned fixed Node HTTPS transport, system clock,
  cryptographic request-ID source, and a policy digest that exactly matches the
  policy being prepared; each route independently requires private-only DNS
  answers and one pinned connection with hostname verification;
- a `createCoordinatorLightningActionConfig` result for one credential-free
  private HTTPS Lightning-adapter origin on port 443, one private Ed25519
  authorization-key handle, and the module-owned fixed Node HTTPS transport;
  and
- a `createCoordinatorEvmActionConfig` result for one gas-only claim signer,
  one exact HTTPS broadcast URL, and exactly two reconciliation providers with
  different labels and origins, all using the module-owned fixed Node HTTPS
  JSON-RPC transport.

The preparer refreshes all solver capabilities during the active service's
bounded unhealthy preparation phase. The fresh capability's chain, settlement
contract, and runtime-code hash must equal the EVM action configuration. The
capability's solver and direction must equal the daemon-evidence policy, and the
evidence controls must have been constructed from that exact policy digest.
Only then is the existing release-, lease-, store-, solver-, and runtime-bound
active policy set prepared.

Preparation is one-use and cancellation-aware. Shutdown aborts outstanding
solver endpoint requests; a late result cannot be handed to the active
lifecycle. A copied client, runtime, config, controls object, or preparer has no
factory provenance and is rejected. Solver-capability, Lightning-capacity,
private-packet, or evidence clients made with an injected request callback,
clock, entropy source, or node-signature verifier are test-only and reject
before operator-policy or runtime creation. Lightning action configuration has no transport-callback field at
all: plaintext, a nonstandard port, public or credential-bearing origins, and
caller transport substitution reject before runtime creation.
EVM action configuration likewise accepts no RPC callback: broadcast and both
reconciliation routes must use HTTPS on port 443 through fresh
certificate-verifying connections, and disabled process-wide TLS verification
rejects before runtime creation. Lower-level loopback request injection remains
an explicit test-only path. Every launcher, action configuration, policy entry,
policy array, and
lower-level policy-set input is read only through exact own enumerable data
properties. Symbols, hidden fields, accessors, sparse or decorated arrays,
unsupported nested values, and extra prototype-named fields reject without
invoking a getter. Nested policy snapshots preserve an own `__proto__` key so
the downstream exact schema rejects it instead of silently changing or losing
the field. No endpoint, key, invoice, address, or settlement identifier is
added to coordinator health output.

## Deployment-owned code

The repository intentionally does not build authority-bearing objects from a
JSON environment manifest. A thin operator-owned entrypoint must load secret
key handles and fixed endpoint clients through the deployment's reviewed secret
and network boundary, construct the objects above, and call the official
launcher. Do not pass raw private keys, macaroons, RPC credentials, invoices, or
private packet data through command arguments, logs, health output, or the web
application.

Active health is also liability-wide: one unmatched or halted nonterminal settlement closes all advertised authority before any cycle work, and a halt or gate closure reached during execution stops the remaining cycle. Operators must alert on degraded state and clear or safely recover the liability; restarting the same release cannot turn that state healthy.

The operator must still prove all external facts separately:

- the BIT providers, Lightning capacity observer, evidence producers, and EVM
  reconciliation providers are live and
  independently controlled as required by the release;
- the capacity observer is reached only through reviewed private DNS and a
  private CA or equivalent service-mesh identity on port 443; its terminator
  forwards only `/v1/capacity` to the non-published adapter, and trust-root and
  certificate rotation are tested without disabling Node verification;
- both evidence routes use the repository's [durable provider
  boundary](./DURABLE_EVIDENCE_PROVIDER.md), separate initialized replay-ledger
  volumes, independent readers, reviewed TLS identities/trust roots, and the
  fixed Node HTTPS client path;
- the private-packet provider uses an independently reviewed TLS identity and
  trust root through its fixed Node HTTPS client path;
- the Lightning adapter is reached only through reviewed private DNS and a
  private CA or equivalent service-mesh identity on port 443; its TLS
  terminator forwards only to the non-published adapter listener, and its trust
  root and certificate rotation are tested without disabling Node verification;
- the Lightning adapter and EVM claim signer have least-privilege credentials;
- each EVM URL and its TLS identity or trust root is independently reviewed;
  any path/query RPC credential is loaded only inside the operator process and
  never enters command arguments, logs, health, alerts, or public evidence;
  distinct URLs remain configuration separation rather than proof of distinct
  upstream provider control;
- the coordinator database and crash journal are on a persistent private
  volume;
- the orchestrator enforces exactly one funded replica and delivers alerts for
  preparation, degraded health, stale heartbeat, and crash-loop state; and
- shutdown, provider loss, evidence-route loss, replay-store loss, wall-clock
  rollback after request pruning, adapter ambiguity, process crash, host restart,
  and retained-liability recovery drills pass against the deployed services.

A provider restart must open its existing ledger with `initialize: false`.
Missing, empty, corrupted, or rolled-back state is an outage, not permission to
create a fresh ledger. Loss recovery requires the old route to remain offline,
requester-key and key-ID rotation, expiry of every old request, explicit new
ledger initialization, and a witnessed replay drill.

Provider health must page on a persisted clock-regression failure. Operators may
wait until real time reaches the durable high-water mark or perform the complete
loss-recovery ceremony above; they must never edit the recorded mark backward.

Different labels, URLs, callback objects, keys, or processes are configuration
separation, not proof of organizational independence or honest observations.
Those claims require retained operator and incident evidence plus independent
review. Until that evidence exists and the release ceremony activates the exact
deployment, funded operation remains closed.
