# Adoption policy boundary

Status: an exact public-testnet policy schema, verifier, operational-attestation binding, and release-candidate binding are implemented. The repository supplies test fixtures, not a staffed support service, real operators, signatures, deployment, or funding authority.

## Purpose

TreeSwap previously committed several operating decisions as opaque hashes. That proved byte-level agreement but did not let a user or release signer verify what the limits, fees, support promises, privacy retention, loss allocation, solver rules, or upgrade response actually said. `lib/adoption-policy.mjs` replaces that ambiguity with one exact, public, canonical policy.

The policy is bound to one public-testnet funding mode, chain, gate, source commit, protocol version, deployment manifest, admission policy, risk policy, fee schedule, support owner, incident commander, and validity interval. It contains no key, endpoint credential, invoice, preimage, email address, or funding authority.

## Minimum-risk profile

The current schema accepts only `operator-testnet-bootstrap` and `operator-testnet`. It rejects mainnet. Bootstrap is operator-owned inventory only and keeps public permissionless execution disabled. Campaign-qualified testnet may admit permissionless solvers, but it does not permit public LP deposits, shares, rewards, promised yield, or partial fills.

The schema enforces these ceilings:

| Control | Bootstrap | Campaign-qualified testnet |
| --- | ---: | ---: |
| Maximum swap | 500 sats | 5,000 sats |
| Maximum in flight | 1,000 sats | 10,000 sats |
| Maximum epoch | 5,000 sats | 50,000 sats |
| Maximum daily Lightning | 10,000 sats | 100,000 sats |
| Maximum routing fee | 50 sats | 100 sats |
| Maximum reference-price band | 250 bps | 500 bps |

Every actual release supplies exact values at or below those ceilings plus exact minimum BIT and Lightning reserves. Candidate preparation rejects any difference between the adoption policy and release record.

The fee object names both direction-specific base fees, the maximum fee, reserve floor, and scarcity start. BIT → Lightning must have the strictly higher base fee because it consumes outbound Lightning capacity. The repository fixture uses 72 bps for BIT → Lightning and 18 bps for Lightning → BIT; these are test policy values, not a live quote or immutable promise. All three fee values must also fit the deployed escrow's immutable `maxFeeBps`.

## Solver and user protections

The exact policy:

- forbids solver last-look and partial fills;
- caps quote lifetime, capacity age, active quotes, consecutive failures, unknown-solver exposure, established-solver exposure, and global BIT → Lightning in-flight exposure;
- permits established status only from objective completed-fill history and a minimum reliability sample, with no subjective bond slashing;
- discloses that a selected solver may correlate both settlement legs and that onchain linkage exists;
- forbids raw invoice and preimage logging, disables email delivery, and caps pricing, packet, and receipt retention;
- states that no insurance fund or automatic reimbursement exists, assigns routing and Lightning-delivery failure to the solver, inventory custody risk to its owner, and wallet/network fees to the user;
- requires unresolved incidents to halt and enter case review;
- requires distinct public HTTPS support, security, and status paths plus a named support owner and incident commander; and
- forbids active-liability migration or emergency risk increases. A TreeSwap contract change requires a new immutable release; a BIT implementation change or pause halts new exposure pending review.

## Signed release path

Operational-readiness v3 requires `--adoption-policy`. All five operational roles sign an EIP-712 payload that displays the exact adoption-policy digest as well as the operational record and policy digests. The record's loss-allocation, privacy-retention, and support commitments are derived from the same complete policy digest, so changing any adoption term changes the signed package.

Prepared public-testnet release candidates v4 retain that digest, compare every release limit to the exact policy, compare the policy's admission/risk/fee commitments to signed upstream evidence, and check the policy fees against both deployed escrow ceilings. A copied policy, copied verification object, legacy schema, mismatched cap, changed fee commitment, unbound support owner, short validity interval, or permissionless bootstrap fails closed.

The policy and every derived artifact expose only false signing, broadcast, gate-opening, and funding authorizations. Real support coverage, public endpoints, loss-allocation acceptance, retention enforcement, solver history, operator identity, organizational independence, deployment, and signatures remain external evidence requirements.
