# Solver endpoint protocol

Status: the local authenticated endpoint, finalized BIT-vault reader, privacy-minimized Lightning-capacity protocol, and open cryptographic repository admission are implemented. No public solver endpoint, independently operated production reader, or permissionless execution service is deployed.

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

1. the solver EVM key signed the exact EIP-712 declaration in the direction-specific escrow domain, including that escrow's expected runtime code hash;
2. the endpoint Ed25519 key proved possession and signed the fresh response;
3. the declared LND node signed the domain-bound proof with LND `SignMessage`
   using its default `single_hash=false`, and TreeSwap locally recovered that
   exact compressed node public key from the canonical zbase32 compact
   signature;
4. finalized onchain reads prove enough solver-owned BIT at the bound address or vault; and
5. a least-privilege internal Lightning reader proves enough active directional capacity at the bound node and epoch.

Signed self-report can only reduce the admitted amount; it never substitutes for either capacity reader. Local key recovery proves possession, not that LND currently considers the node active in its channel graph and not that the node has routable liquidity. The separate signed Lightning-capacity reader supplies that private operational statement. The executable offer must reproduce the verifier-issued capability and snapshot digests, exact capacities, endpoint-key digest, runtime code hash, epoch, and expiry. Onchain BIT inventory can be compared across independent finalized RPC providers. Lightning channel liquidity is private node state and cannot be made trustless by an intent wrapper. It therefore also requires tiny unknown-solver limits, reserved capacity, continuous reconciliation, completed-swap history, and a fail-closed operator boundary.

The official active and recovery operator client fixes the local verifier,
module-owned Node HTTPS request path, wall clock, and cryptographic challenge
source. A separate injected factory exists only for bounded transport tests;
operator composition rejects it before any capability read.

## Remaining deployment gates

- independently review the finalized BIT inventory reader and its pinned deployment manifest;
- deploy two independently operated EVM providers and a separately keyed, role-limited Lightning observation boundary;
- deploy the endpoint behind production TLS and network egress controls;
- connect the complete durable solver state machine and shared coordinator service;
- run at least two independently operated testnet solvers and multiple delivery paths;
- measure withholding, expiry, last-look, insolvency, restart, and reconciliation faults; and
- obtain independent security and operational review.

Until those gates have release evidence, the web product must not publish permissionless executable quotes or authorize funded swaps.

## Local reader evidence

`createFinalizedBitVaultInventoryReader` compares two independently labeled and function-distinct providers at their common finalized height. Each provider must prove the chosen block finalized and canonical, and every code, implementation-slot, immutable, token-state, vault-accounting, and solver-balance read is bound to the exact block hash with EIP-1898. Lightning → BIT admits only solver-owned available vault inventory after a configured reserve; BIT → Lightning admits zero solver BIT because the user funds the direction-specific user escrow.

The Lightning adapter accepts only a fresh, short-lived coordinator-signed capacity request bound to the exact capability digest, epoch, direction, solver, and LND node. A distinct capacity key signs a response containing gross directional sats, in-flight sats, reserve, budget, and admitted availability—never channel identifiers. The coordinator verifies exact deductions, freshness, key separation, and request binding. This authenticates an observer's statement about private LND state; it does not turn private channel liquidity into a publicly verifiable proof.

Published commit `67655f859ec70c191501d073e75cba808ce06def` passed the live two-direction Lightning-capacity campaign, the adversarial dual-provider BIT-reader suite, and all 26 local qualification campaigns. Its independently rebuilt local-only evidence digest is `sha256:0c20cb3ea69ca7eb56ed5f79b215ad317523908ee09436ac4203966c90ac3d58`; [hosted CI](https://github.com/bobofbuilding/treeswap/actions/runs/32323948108) also passed. This is repository and local-regtest evidence, not independently operated Ethereum-provider evidence, production capacity, or funding authorization.
