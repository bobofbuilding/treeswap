# Protocol upgrades

Status: recommended governance model. TreeSwap escrow contracts remain immutable and non-upgradeable.

## Rule: upgrade by version, not by replacing code under funds

TreeSwap should never proxy-upgrade an escrow holding user or solver assets. A new protocol release deploys a new gate, sealed payment-hash registry, BIT vault, and user escrow. Every intent includes the protocol version, chain ID, and exact verifying contract, so governance cannot redirect a signed order to new logic.

Existing releases follow one of three states:

| State | New exposure | Existing claim/refund/withdrawal |
| --- | --- | --- |
| Candidate | Closed | Available for controlled tests only |
| Active | Allowed while its expiring risk attestation is open | Available |
| Retired | Permanently closed | Remains available until all liabilities are zero |

Retirement never migrates a live swap. Users and solvers exit through the exact contract they entered.

## Release process

1. Freeze a source commit, compiler/toolchain versions, dependency lock, and threat-model delta.
2. Deploy the complete new immutable contract set in the closed state.
3. Seal the registry to exactly the two new escrows and reproduce every constructor immutable and runtime code hash.
4. Publish a release manifest containing the old and new versions, contract addresses, hashes, fee caps, risk caps, the normalized admission-policy digest, BIT observation, test evidence, and independent-review digests.
5. Wait the governance review period. Controller, guardian, Lightning operator, security reviewer, and incident commander sign the same canonical release record. The controller and guardian signatures must pass finalized ERC-1271 quorum verification against their reviewed runtime hashes; the other three signatures must recover the exact policy-pinned EIP-712 identities.
6. Run a capped canary with operator-owned inventory. Do not route ordinary users automatically to the candidate.
7. Open the candidate for a short expiring window. Keep the prior release available until the candidate is proven.
8. Retire the prior release by stopping new exposure only. Monitor until all liabilities are zero.

## Governance roles

- **Controller multisig:** may stage a reviewed risk attestation for one exact release.
- **Guardian multisig:** may immediately stop new exposure; it cannot reopen alone.
- **Fee-recipient multisig:** receives immutable per-release fees and has no safety authority.
- **Release signers:** produce an offchain threshold-signed manifest; they cannot alter deployed bytecode.

Use distinct hardware-backed owners and thresholds. Any optional onchain release catalog should be append-only metadata, never a mutable router that chooses the escrow after the user signs.

## Component upgrades

- **Escrows, gate, registry:** deploy a complete new immutable version.
- **Coordinator and relays:** use backwards-compatible message versions; roll out canaries and retain the last known-good binary for rollback. The first RFQ binds one admission-policy digest to the durable coordinator namespace. A cap or threshold change uses a new release namespace and database; the prior coordinator closes new RFQs and drains all existing liabilities instead of mutating policy underneath them.
- **Lightning adapter:** pin binary/config hashes and LND compatibility; rotate credentials during a staged maintenance window.
- **Web client:** ship signed release manifests and reject unknown versions or code hashes.
- **External BIT proxy:** TreeSwap cannot govern it. An EIP-1967 implementation change or pause automatically closes new exposure and requires a new reviewed BIT observation before reopening.

## Emergency changes

Emergency authority can only reduce risk: halt new quotes, reservations, and opens. It cannot change a beneficiary, fee, amount, hash, deadline, implementation, or existing exit path. A fix is a new reviewed release, not an emergency proxy upgrade.

`lib/release-authorization.mjs` enforces this process before any operator-funding capability can exist. Mainnet authorization requires a prior release digest, complete public-testnet and operating evidence, every independent-review digest, exact caps and reserves, and disposition of all findings. The signed authorization expires; raising a cap or changing an evidence, feature, chain, gate, or deployment digest requires a new record and all five approvals.
