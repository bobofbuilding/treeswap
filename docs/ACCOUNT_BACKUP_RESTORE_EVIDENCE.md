# Account backup and isolated restore evidence

Status: the exact two-role evidence and signature verifier is implemented and locally tested. No live D1 export, import, restore, deletion, key operation, platform mutation, or account enablement is included.

## Recovery method

Cloudflare D1 Time Travel is always available on the production storage backend and supports point-in-time recovery, but its current restore operation overwrites a database in place and cancels in-flight queries. Cloudflare's documentation says cloning or forking to a new database through Time Travel is not yet available. TreeSwap therefore does not use an in-place Time Travel restore for the launch drill.

The safer evidence ceremony uses the documented D1 [full export and import flow](https://developers.cloudflare.com/d1/best-practices/import-export-data/):

1. confirm the exact clean TreeSwap commit and private Sites deployment version;
2. obtain and commit the current [Time Travel bookmark](https://developers.cloudflare.com/d1/reference/time-travel/) without restoring the source;
3. run one full remote D1 export inside a temporary encrypted operator workspace;
4. encrypt the export before retention, separate its decryption-key custody, and delete every plaintext copy;
5. create a new empty D1 database that has no production route, binding, runtime value, account authority, outbound notification delivery, or traffic;
6. import the export into only that isolated target;
7. compare the exact three-table schema, aggregate counts, and an HMAC-SHA-256 commitment over canonical ordered table exports using one ephemeral verification key;
8. destroy the ephemeral verification key, retain the encrypted export and private ceremony evidence, then destroy the isolated target; and
9. have the account-data custodian and an independent restore witness separately sign the exact evidence record.

This ceremony complements Time Travel rather than replacing it. Production incident recovery may use Time Travel after a separately approved destructive-change procedure, preserving the previous bookmark returned by the platform. The adoption drill proves that a retained export can be restored without touching the live database.

## Exact evidence boundary

`lib/account-backup-restore-evidence.mjs` requires:

- one full published source commit, branch, Sites deployment version, and source-database identity commitment;
- a distinct fresh target-database commitment;
- distinct commitments for the source bookmark, encrypted export, encryption-key custody, target isolation, and witness report;
- equal source/restore schema digests;
- equal source/restore aggregate counts for challenges, sessions, and notification records;
- equal keyed canonical content commitments, with the verification key destroyed;
- causal export, encryption, import, verification, and target-destruction timestamps inside a maximum six-hour ceremony;
- retained encrypted export with no retained plaintext;
- separate encryption-key custody;
- an initially empty target, no in-place source restore or source mutation, and no production authority, traffic, outbound notification delivery, or funding; and
- two canonical EIP-712 attestations after target destruction from distinct custodian and witness identities, organizations, signers, and evidence commitments.

Copied verification output has no provenance. Reordered roles, stale or future signatures, schema/count/content mismatch, a reused database, retained plaintext, source mutation, production attachment, commitment reuse, decorated/coercible/accessor input, and any authority claim fail closed.

The summary contains only digests, counts of participants, timestamps, explicit attested claims, verifier limitations, and false authority flags. It contains no export bytes, row values, wallet, challenge, session hash, email, invoice, endpoint, platform credential, key, bookmark, database identifier, or signature.

## Ceremony workflow

The operator creates one private `candidate.json` containing only the exact policy and secret-free record. Raw exports, platform responses, target identifiers, access records, keys, and reports remain in the private evidence store. Both roles independently inspect the retained facts and prepare their own typed payload from an exact clean branch already published on the canonical repository:

```sh
npm run prepare:account-backup-restore-attestation -- \
  --candidate /secure/account-backup/candidate.json \
  --role account-data-custodian
```

Repeat with `--role independent-restore-witness`. These commands do not read a key, sign, export, import, restore, delete, or call a platform. After offline signing, verify the canonical two-entry attestation array:

```sh
npm run verify:account-backup-restore-evidence -- \
  --candidate /secure/account-backup/candidate.json \
  --attestations /secure/account-backup/attestations.json \
  --out /secure/account-backup/verified-summary.json
```

The verifier rechecks that the current clean checkout still exactly equals the same published branch and commit before and after verification. Output is non-overwriting and private. A later main-branch or deployment change requires a completely new ceremony.

## What remains external

The verifier authenticates signed claims; it does not query Cloudflare, inspect the encrypted export, authenticate operator organizations, perform a restore, or prove deletion. Before accounts may be enabled for adoption, operators still must:

- obtain independent D1 least-privilege review;
- use a separately scoped export identity and independently held decryption key;
- run the ceremony against the exact reviewed private deployment;
- retain the private platform/audit, encryption, import, comparison, destruction, and witness evidence;
- prove alert delivery for export, import, integrity, or deletion failure;
- have the independent live review inspect the retained artifacts; and
- separately drill the approved in-place Time Travel incident procedure without public traffic or funded operation.

Until then, the launch-checklist backup/restore item remains open and accounts stay private or disabled.
