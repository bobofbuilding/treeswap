# Retained-release custody and rotation

Status: the fail-closed repository boundary is implemented and locally tested. It does not prove that any operator actually retains an old provider, key, runtime image, backup, or evidence package. It supplies no funding, Lightning-dispatch, new-exposure, or rotation authority by itself. Funded operation remains closed.

## Why this gate exists

A release can expire or be replaced while a settlement bound to it is still claimable, refundable, or awaiting reconciliation. Rotating providers, wallet owners, solver keys, coordinator schema, or runtime images without preserving that release can turn a routine upgrade into permanent loss.

TreeSwap therefore treats every nonterminal settlement as a release-specific liability. A rotation is permitted only when either:

1. a fresh read of the original live coordinator database proves there are zero nonterminal liabilities; or
2. every nonterminal release has a complete private custody package and independently witnessed recovery actions pass under distinct old and new operating sets while the onchain release gate is closed.

No manifest, summary, witness statement, or copied object can authorize a swap or move value.

## Required private package

The package uses `treeswap.retained-release-custody.v1`. Its directory and every referenced file must exclude all group and other permissions. Symlinks, hard links, path traversal, duplicate paths, changed files, unexpected fields, oversized files, and digest or size mismatches fail closed.

The top-level package contains:

- a verified schema-v7 coordinator backup;
- the host and process instance commitments at sealing time;
- a bounded two-to-five-witness policy with at least two distinct signer and organization commitments; and
- one canonically ordered release entry for every and only release represented by a nonterminal settlement.

Each release entry retains:

- every raw bootstrap or campaign-qualified candidate input, not a serialized candidate;
- the original five-role approval bundle;
- the exact provider identity/configuration file, with credentials remaining outside the package;
- every daemon-evidence policy named by a nonterminal settlement;
- one recovery-authority record per policy, binding the solver, direction, endpoint-key digest, Lightning-node digest, custodian, organization, and external custody-evidence digest;
- the reviewed source commit and coordinator schema; and
- the exact SHA-256 commitment and privately retained bytes of the compatible coordinator runtime archive.

Inspection reconstructs each candidate from all original deployment, campaign/bootstrap, review, operations, service-isolation, adoption, and qualification evidence. It then derives the release and policy digests again. Merely retaining a matching record template is insufficient.

The database inventory is produced by `CoordinatorStore.releaseLiabilitySnapshot()`. Inspection first copies the already hash-verified backup to a fresh private working path, verifies the copy again, reads liabilities from that copy, and then re-verifies both the copy and sealed source. This prevents a transient source-file mutation from influencing the inventory and then being hidden. The inventory commits to every nonterminal settlement's release, direction, evidence policy, historical solver capability, execution binding, state, reconciliation flag, halt state, and last action without publishing settlement IDs. Any nonterminal settlement without an execution-policy binding fails custody. An active firm offer not already selected by a nonterminal settlement also fails custody.

## Offline inspection

After copying and privately sealing all inputs, run:

```bash
npm run verify:retained-release-custody -- \
  --inputs /absolute/private-custody/release-custody.json \
  --out /absolute/private-custody/custody-summary.json
```

The command writes an exclusive private summary containing only aggregate counts and commitments. It does not persist a candidate, capability, provider URL, signature, solver endpoint, invoice, payment hash, or preimage. It always reports false funding, dispatch, new-exposure, and rotation authorization.

## Restored-host readiness

`verifyRetainedReleaseRecoveryReadiness` must run inside the future trusted recovery process. It requires all of the following at once:

1. the original in-process custody verification result;
2. a coordinator backup restored to a fresh path and opened as an original `CoordinatorStore`;
3. a fresh same-process recovery-only release activation backed by current provider agreement;
4. one fresh, fully verified three-possession solver capability for every retained daemon policy; and
5. restored host and process commitments distinct from the sealing host and process.

The restored database's complete liability commitment must equal the retained backup. The fresh capability may use a rotated capacity epoch, but its EVM solver, direction, escrow address and runtime hash, endpoint key, and Lightning node must match the retained recovery authority. This verifies that the recovery identities still exist without storing any private key in the package.

The readiness result is short-lived at the earliest provider-observation or solver-capability expiry. It is module-private provenance; copying or serializing it removes validity. It proves only that the inputs and authorities can be reconstructed. It does not claim that a recovery action succeeded.

## Witnessed old/new drill

`buildRetainedReleaseRecoveryDrillApproval` derives the exact EIP-712 statement for an actual recovery action. The statement binds:

- the release, custody package, and exact liability snapshot;
- the old or new operating-set digest;
- the restored host and process;
- a retained recovery-evidence digest and postcondition digest;
- a positive recovered-action count and bounded start/finish times; and
- exactly zero Lightning dispatches, new exposures, and funding actions.

`verifyRetainedReleaseRecoveryDrill` accepts only configured witnesses with distinct signers and organization commitments. Missing, duplicated, unknown, overlapping, malformed, future, expired, or bad signatures fail. Repository verification cannot establish that claimed organizations are independent or that the retained evidence is truthful; those facts must be checked out of band and during independent review.

## Rotation decision

`assessRetainedReleaseRotation` never trusts the backup alone. Immediately before rotation it reads the original live store again and requires the liability snapshot to remain byte-for-byte equivalent to the sealed commitment. This closes the race where a zero-liability backup is followed by a newly accepted settlement.

With zero liabilities, the exact live match is sufficient for the narrow rotation decision. With liabilities, rotation requires distinct verified old and new custody packages covering the identical backup liability commitment and release set. This prevents relabeling one host or process as two operating sets and lets a real key rotation bind the prior key in the old package and its replacement in the new package. Every retained release then needs one verified old-set drill from the old package and one verified new-set drill from the new package. Both must:

- cover the exact current liability snapshot;
- remain within the witness policy's freshness window;
- come from distinct operating-set digests;
- use fresh same-process recovery activations that observed the onchain gate closed; and
- retain zero value-moving authorization.

The package delta must match the named change: provider rotation changes the retained provider configuration, solver-key rotation changes the recovery-authority commitments, and service-runtime rotation changes the verified archive bytes. Merely changing a host or process label is insufficient. Custody schema v1 does not permit wallet-owner or storage-schema rotation with nonterminal liabilities; those changes must wait for a fresh zero-liability decision. A later schema may relax that only with an independently reviewed compatibility proof.

Wallet-owner or provider changes that make an old release unverifiable will therefore fail the new-set drill. Those changes must wait until its liability count is zero or preserve a genuinely compatible recovery path.

The resulting decision is ephemeral and scoped only to the named rotation kind (`provider`, `wallet-owner`, `solver-key`, `storage-schema`, or `service-runtime`). It is not a release capability and cannot open the gate, accept an intent, pay Lightning, claim BIT, or fund inventory.

## Required deployed evidence

Before this checklist item can be closed, operators must retain real packages on independent encrypted storage, prove restoration after an actual process and host replacement, execute and witness old/new recovery actions for every rotation class that will be used, retain all signatures and raw evidence, and demonstrate that the prior package remains available until its last liability is terminal. Independent reviewers must verify custody ownership, organization separation, backup access, image reproducibility, key recovery, provider continuity, and deletion only after a fresh zero-liability decision.
