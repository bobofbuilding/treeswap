# Dual-route solver daemon evidence

Status: a concrete local client, provider handler, and durable provider replay
store are implemented. No HTTPS listener, operator, production requester key,
certificate, persistent volume, evidence producer, independent data path, or
funded deployment is supplied by the repository.

## Purpose

The solver daemon already refuses reservation, Lightning dispatch, EVM-claim dispatch, and terminal reconciliation unless it receives an original module-private verification of one fresh record signed by the release's Lightning operator and security reviewer. Previously, a deployment still had to supply four arbitrary callback functions to obtain those records.

`lib/solver-daemon-evidence-client.mjs` narrows that deployment surface to one fixed protocol. `createSolverDaemonEvidenceControls` returns exactly the four controls accepted by active execution:

| Control | Required evidence kind |
| --- | --- |
| observe reservation | `RESERVATION` |
| authorize Lightning | `LIGHTNING_DISPATCH` |
| authorize EVM claim | `EVM_CLAIM_DISPATCH` |
| verify both assets | `TERMINAL_COMPLETED` or `TERMINAL_REFUNDED` |

The client does not quote, select a solver, create work, open the release gate, hold inventory, or grant funding authority.

`createSolverDaemonRecoveryEvidenceControls` derives a separately provenance-bound recovery object from the same protocol but exposes only reservation observation, EVM-claim authorization, and terminal asset verification. It has no `authorizeLightning` property and is not accepted as an active control set. Conversely, the four-method active object is not accepted by the reviewed recovery operator runtime. This removes Lightning payment authorization from the restart-only composition before the planner and execution fence apply their independent prohibition.

Active policy preparation accepts nonempty evidence controls only when they are the original same-process object returned by this factory. A spread copy or deployment-injected callback object is rejected. An empty control object remains valid but fail-closed: it can only leave reservation and reconciliation waiting and dispatch gates closed.

The factory owns a direct `node:https` request implementation. Controls
constructed without a request override are marked `fixed-node-https`; controls
constructed with any injected request function are marked `injected-test`.
Both reviewed active and recovery operator runtimes accept only the former.
The fixed transport opens a fresh port-443 connection with certificate and
hostname verification enabled; it does not use global `fetch`, a shared agent,
or the process-wide Undici dispatcher. This prevents deployment code from
silently replacing the HTTPS request path while retaining otherwise-valid
control provenance. Injected transport remains available only for isolated
protocol tests and is not accepted by either official operator launcher.

## Request and response boundary

For each control call, the client:

1. creates one fresh random request ID and a request lasting at most thirty seconds;
2. binds the request to the active release and evidence-policy digests, chain, escrow and runtime, solver, direction, settlement and intent;
3. additionally binds the observed reservation for every post-reservation request and the exact action, private-packet response, and three deadlines for a dispatch request;
4. signs the exact request with the coordinator's Ed25519 requester key;
5. sends that same envelope concurrently to the configured Lightning-operator and security-reviewer routes;
6. requires two different private HTTPS origins on port 443, no credentials or path data in either configured origin, no redirect, JSON, `Cache-Control: no-store`, a bounded complete body, and a hard deadline;
7. requires each route to echo the exact signed request and return only its assigned EIP-712 approval;
8. requires both routes to return canonically identical evidence records; and
9. re-verifies both approvals, policy binding, record lifetime, and purpose through `verifySolverDaemonEvidence` before returning its uncopyable result.

One missing, late, malformed, cacheable, redirected, disagreeing, copied, wrongly signed, or wrong-role response fails the control. There is no one-route fallback.

Every authority-bearing client, control-call, request, policy, record, and
approval input must be an exact own-enumerable data record or an undecorated
dense array. The boundary snapshots each bounded input once without invoking
property getters and validates, signs, replay-consumes, and returns those same
snapshots. A provider caller therefore cannot change the returned signed record
or approval while replay consumption is in progress. Symbols, hidden fields,
accessors, sparse or decorated arrays, unsafe integers, unsupported values,
excessive nesting, and unknown fields reject. An own `__proto__` field remains
an ordinary own field so the downstream exact schema rejects it instead of a
clone silently dropping it. This protects the in-process data handoff; it does
not establish that a proxy's traps or a provider's underlying observation are
honest.

## Provider requirement

Each route must independently authenticate the request, derive the requested
observation from its own approved data path, and sign the resulting evidence
record with only its assigned release key. The concrete
`createSolverDaemonEvidenceProviderRoute` performs that derivation and accepts
only the repository's provenance-bound evidence reader and
`SolverDaemonEvidenceReplayStore`. It claims `(requesterKeyId, requestId)`
atomically before reading or signing and consumes the claim before responding.
A route response snapshots the request, record, policy, and approval before
replay consumption, validates the exact snapshots, and returns those same
frozen values after successful consumption.
A duplicate, concurrent request, storage failure, copied reader/store, policy
mismatch, or expired response fails closed. The strict SQLite store must be
initialized explicitly once; normal startup refuses a missing or empty ledger.
It also persists the highest locally observed clock second and rejects any
request or health check after a backward clock step, including after expiry has
pruned an older request. In-memory storage is test-only. See [Durable solver-evidence
provider](./DURABLE_EVIDENCE_PROVIDER.md) for the deployment and loss-recovery
rules.

The lower-level request verifier checks signature, key ID, time, and exact schema but deliberately does not claim replay protection on its own. A provider must not call it and then respond without the durable consume step.

Routes must not log request or response bodies. Although the protocol contains no invoice text, preimage, macaroon, email, wallet link, endpoint secret, or private key, its settlement, reservation, action, and transaction commitments are operational metadata and must follow the signed retention policy.

## Independence boundary

Different URLs, keys, signatures, containers, or service commitments do not prove independent operation. Before test inventory, retained deployment evidence must show that the two routes use the service identities, trust domains, credentials, operators, and organizations required by the release and service-isolation policies. Reviewers must also prove that both routes are not aliases for one backend observation or one administrator.

The route response is authenticated by the policy-pinned EIP-712 signer, not by trusting an HTTP success. The official launchers require the fixed Node HTTPS transport, which fixes the request path and port, does not follow redirects, explicitly enables certificate verification, and refuses operation whenever Node TLS verification is globally disabled. Deployment evidence must still retain and independently review the certificate/trust-root, hostname resolution, network policy, requester-key provisioning, rotation, revocation, replay-store persistence, and outage behavior for both origins.

## Remaining deployment gate

An operator-owned active entrypoint must still construct the original solver
capability, private-packet client, this dual-route evidence client, both durable
provider routes, Lightning adapter configuration, EVM signer/provider quorum,
and release-bound policy in the proper isolated processes. It must run one
externally enforced funded coordinator replica, use separate durable volumes,
deliver independent alerts, and pass shutdown, timeout, provider, route,
adapter, replay-store loss/rollback, and abrupt-process crash drills on public
testnet. Until that evidence and independent review exist, the default
coordinator continues to refuse active execution and funded operation remains
closed.
