# Dual-route solver daemon evidence

Status: a concrete local client and provider-side request boundary are implemented. No route, operator, requester key, certificate, replay store, evidence producer, or funded deployment is supplied by the repository.

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

Active policy preparation accepts nonempty evidence controls only when they are the original same-process object returned by this factory. A spread copy or deployment-injected callback object is rejected. An empty control object remains valid but fail-closed: it can only leave reservation and reconciliation waiting and dispatch gates closed.

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

## Provider requirement

Each route must independently authenticate the request with `verifySolverDaemonEvidenceRequest`, derive the requested observation from its own approved data path, and sign the resulting evidence record with only its assigned release key. `buildSolverDaemonEvidenceRouteResponse` refuses to produce a response unless the operator supplies a durable atomic replay consumer. That consumer must mark `(requesterKeyId, requestId)` used before returning `true`; a duplicate or storage failure must return false or throw. An in-memory set is suitable only for tests.

The lower-level request verifier checks signature, key ID, time, and exact schema but deliberately does not claim replay protection on its own. A provider must not call it and then respond without the durable consume step.

Routes must not log request or response bodies. Although the protocol contains no invoice text, preimage, macaroon, email, wallet link, endpoint secret, or private key, its settlement, reservation, action, and transaction commitments are operational metadata and must follow the signed retention policy.

## Independence boundary

Different URLs, keys, signatures, containers, or service commitments do not prove independent operation. Before test inventory, retained deployment evidence must show that the two routes use the service identities, trust domains, credentials, operators, and organizations required by the release and service-isolation policies. Reviewers must also prove that both routes are not aliases for one backend observation or one administrator.

The route response is authenticated by the policy-pinned EIP-712 signer, not by trusting an HTTP success. Standard TLS verification must remain enabled, and deployment evidence must retain the certificate/trust-root, network-policy, requester-key provisioning, rotation, revocation, replay-store persistence, and outage behavior for both origins.

## Remaining deployment gate

An operator-owned active entrypoint must still construct the original solver capability, private-packet client, this dual-route evidence client, Lightning adapter configuration, EVM signer/provider quorum, and release-bound policy in the same process. It must run one externally enforced replica, use a durable volume, deliver independent alerts, and pass shutdown, timeout, provider, route, adapter, replay-store, and abrupt-process crash drills on public testnet. Until that evidence and independent review exist, the default coordinator continues to refuse active execution and funded operation remains closed.
