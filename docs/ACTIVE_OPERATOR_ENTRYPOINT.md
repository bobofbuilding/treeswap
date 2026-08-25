# Active operator entrypoint

TreeSwap's funded coordinator must be started through
`startCoordinatorActiveOperatorService` in
`lib/coordinator-active-operator-policy.mjs`. The lower-level active service is
reusable lifecycle infrastructure; it is not the deployment entrypoint.

The operator entrypoint accepts one original, one-use policy preparer created by
`createCoordinatorActiveOperatorPolicyPreparer`. Each configured solver policy
must contain all of the following original same-process objects:

- a `createSolverCapabilityClient` result that performs a fresh public HTTPS
  capability challenge using the finalized two-provider BIT vault reader and
  the separately signed Lightning-capacity reader;
- a `createAuthenticatedPrivatePacketClient` result;
- a `createSolverDaemonEvidenceControls` result using two distinct private
  HTTPS routes whose policy digest exactly matches the policy being prepared;
- a `createCoordinatorLightningActionConfig` result for one isolated private
  Lightning adapter and one private Ed25519 authorization-key handle; and
- a `createCoordinatorEvmActionConfig` result for one gas-only claim signer,
  one broadcast RPC client, and exactly two reconciliation providers with
  different labels, origins, and client functions.

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
factory provenance and is rejected. No endpoint, key, invoice, address, or
settlement identifier is added to coordinator health output.

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

- the BIT providers, Lightning capacity observer, Lightning node-signature
  verifier, evidence producers, and EVM reconciliation providers are live and
  independently controlled as required by the release;
- both evidence routes use the repository's [durable provider
  boundary](./DURABLE_EVIDENCE_PROVIDER.md), separate initialized replay-ledger
  volumes, independent readers, and reviewed TLS identity;
- the Lightning adapter and EVM claim signer have least-privilege credentials;
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
