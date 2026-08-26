# Recovery operator entrypoint

TreeSwap recovery execution must be started through
`startCoordinatorRecoveryOperatorService` in
`lib/coordinator-recovery-operator-policy.mjs`. The reusable recovery service
does not itself prove retained custody or construct authority-bearing runtime
objects, so it is not the deployment entrypoint.

The operator entrypoint accepts one original, one-use preparer created by
`createCoordinatorRecoveryOperatorPolicyPreparer`. Its configuration fixes one
absolute private custody-manifest path, one release-record digest, distinct
restored-host and restored-process commitments, and every retained execution
policy before the coordinator opens. Accessors, symbol fields, extra fields,
unbounded nested policy data, copied factory objects, duplicate policies, and
relative custody paths reject. Prototype-named policy fields remain visible to
exact-schema validation and reject; nested runtime configuration rejects a
`__proto__` key rather than copying it into an authority-bearing prototype.

For every retained policy the operator must construct:

- a `createSolverCapabilityClient` result that performs a fresh authenticated
  solver challenge through the module-owned Node HTTPS transport, system
  clock, cryptographic entropy, local LND compact-signature verifier, finalized
  BIT reader, and a signed production Lightning-capacity reader with its own
  module-owned private Node HTTPS `/v1/capacity` transport, private-only DNS
  answer validation and connection pinning with hostname verification, system
  clock, cryptographic entropy, bounded complete response, and exact private
  port-443 observer origin;
- a `createAuthenticatedPrivatePacketClient` result using the module-owned fixed
  Node HTTPS transport, system clock, and cryptographic request-ID source, with
  a requester key distinct from the provider key;
- `createSolverDaemonRecoveryEvidenceControls`, using two distinct private
  evidence routes through the module-owned fixed Node HTTPS transport, system
  clock, and cryptographic request-ID source, and exposing only reservation
  observation, EVM-claim authorization, and terminal asset verification;
- a `createCoordinatorLightningActionConfig` result bound to the module-owned
  fixed Node HTTPS transport and one credential-free private port-443 adapter
  origin, used only to reconcile an already-created Lightning action; and
- a `createCoordinatorEvmActionConfig` result with the gas-only claim signer,
  one exact HTTPS broadcast route, and two distinct read-only reconciliation
  origins, all using the module-owned fixed Node HTTPS JSON-RPC transport.

The recovery-only evidence object has no `authorizeLightning` method. Passing
the active evidence object, a copied recovery object, or a caller-built
lookalike rejects before service startup. Solver-capability,
Lightning-capacity, private-packet, or evidence clients constructed with an
injected request callback, clock, entropy source, or node-signature verifier
are test-only and reject before policy or runtime creation. The runtime still contains the Lightning reconciliation
adapter because an interrupted historical action may need a read-only status
lookup; the recovery planner and execution fence independently reject Lightning
planning and dispatch. The configuration accepts no adapter request callback;
plaintext, nonstandard-port, public, credential-bearing, and path-bearing
origins cannot enter the recovery runtime.

The EVM configuration likewise has no request callback. Plaintext,
nonstandard-port, URL-credential, fragment, caller-transport, and globally
disabled TLS-verification paths reject before recovery startup; explicit
loopback injection remains confined to lower-level local evidence campaigns.

## One uninterrupted preparation

During the service's bounded unhealthy preparation phase, the preparer:

1. proves ownership of the original single-host recovery lease;
2. privately inspects the complete retained-release custody package;
3. proves lease ownership again and refreshes every solver capability;
4. requires each fresh solver, direction, chain, escrow address, escrow runtime
   hash, and evidence policy to match its fixed recovery runtime;
5. obtains the current same-process recovery activation without refreshing it;
6. verifies restored-host readiness against the exact opened coordinator store;
7. derives every and only fixed recovery job from that store; and
8. proves lease ownership once more before returning the one-use job-set proof.

Shutdown aborts outstanding capability requests and waits for preparation to
drain. A copied preparer, copied custody summary, copied activation, copied
capability, changed database, changed runtime, changed policy, lost lease,
expired evidence, or second invocation fails closed. No settlement identifier,
invoice, payment hash, preimage, provider URL, key, or raw signature enters the
public recovery health record.

## Deployment-owned code and remaining evidence

The repository deliberately does not construct this boundary from a JSON
manifest containing secrets. A thin operator-owned process must load fixed
network clients and opaque secret handles from its reviewed deployment,
construct the objects above, and call the official launcher. It must never
accept recovery jobs over a network or restore a preparation proof from disk.

The launcher proves local composition, not deployment truth. Before funded
testnet operation, operators must still demonstrate a private persistent
restored volume, one enforced replica, independently operated provider and
evidence routes, reviewed TLS identities and trust roots for every Lightning
and EVM route, least-privilege Lightning and EVM
credentials, retained compatible runtime bytes and solver recovery keys,
external alerts, and witnessed process/host restart drills against real
nonterminal testnet liabilities. Funded operation remains closed until those
external facts and independent review exist.
