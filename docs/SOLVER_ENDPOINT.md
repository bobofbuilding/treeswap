# Solver endpoint protocol

Status: the local authenticated request/response protocol and fail-closed client are implemented and qualified. No public solver endpoint, production capacity reader, or permissionless admission service is deployed.

## Purpose

The endpoint proves that a responding service currently controls the endpoint key bound into one short-lived solver capability. It does not make the endpoint's capacity claim true. TreeSwap admits a capability only after separately verifying its EVM signature, Lightning-node possession proof, and fresh capacity observations.

## Request and response

The coordinator sends one canonical JSON `POST /v1/capability` request containing:

- schema version;
- a fresh random 32-byte challenge;
- exact solver EVM address;
- exact swap direction;
- request time; and
- expiry no more than 30 seconds later.

The solver returns the exact request unchanged, its complete capability envelope, service and expiry times, and an Ed25519 signature over the canonical response digest. The response may not outlive the request or capability. A changed challenge, solver, direction, amount, key, origin, epoch, or timestamp fails closed. A fresh challenge prevents a captured response from being replayed as current availability.

## Transport boundary

The default client accepts only a canonical credential-free HTTPS origin on port 443. It:

- refuses redirects and non-JSON or oversized responses;
- applies one hard deadline across DNS, connection, TLS, and body processing;
- resolves every address and refuses the request if any answer is private, reserved, mapped, local, or special-purpose;
- pins one validated public address for the connection while retaining the original hostname for TLS SNI, certificate verification, and the HTTP `Host` header;
- disables connection reuse for the capability probe; and
- returns generic, non-ambiguous read-only errors without upstream bodies or credentials.

This prevents DNS rebinding from turning an open solver URL into access to a coordinator's local services. The current denylist follows the IANA [IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry) and [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry) special-purpose registries. Production deployment must also enforce equivalent egress policy at the network layer.

## Identity and capacity

An executable capability requires all of the following:

1. the solver EVM key signed the exact EIP-712 declaration in the direction-specific escrow domain;
2. the endpoint Ed25519 key proved possession and signed the fresh response;
3. the declared LND node signed the domain-bound proof and an independent verifier recovered that exact node public key;
4. finalized onchain reads prove enough solver-owned BIT at the bound address or vault; and
5. a least-privilege internal Lightning reader proves enough active directional capacity at the bound node and epoch.

Signed self-report can only reduce the admitted amount; it never substitutes for either capacity reader. Onchain BIT inventory can be compared across independent finalized RPC providers. Lightning channel liquidity is private node state and cannot be made trustless by an intent wrapper. It therefore also requires tiny unknown-solver limits, reserved capacity, continuous reconciliation, completed-swap history, and a fail-closed operator boundary.

## Remaining deployment gates

- implement and review the finalized BIT inventory reader;
- implement a role-limited, privacy-minimized Lightning capacity reader;
- deploy the endpoint behind production TLS and network egress controls;
- connect the complete durable solver state machine and shared coordinator service;
- run at least two independently operated testnet solvers and multiple delivery paths;
- measure withholding, expiry, last-look, insolvency, restart, and reconciliation faults; and
- obtain independent security and operational review.

Until those gates have release evidence, the web product must not publish permissionless executable quotes or authorize funded swaps.
