# Public-testnet release approval ceremony

Status: TreeSwap can prepare each of five exact release-signing payloads and verify a complete approval bundle through the candidate-bound finalized RPC quorum. The verifier writes a private, non-overwriting receipt and deliberately discards the module-private capability provenance. It cannot sign, broadcast, open the gate, move inventory, or activate funding. No real candidate, approval, Safe, provider, or public-testnet deployment is supplied by this repository.

## Safety boundary

A JSON candidate loaded from disk can prove only internal consistency: its release record, policy, record digest, policy digest, and EIP-712 payload agree. Deserialization cannot preserve the module-private provenance created when TreeSwap originally verified deployment, bootstrap or campaign, five-reviewer evidence, and five-role operational-readiness evidence.

Every signer must therefore:

1. start from the original postflight, promotion, bootstrap or campaign, signed independent-review, and signed operational-readiness inputs;
2. independently rerun the appropriate candidate-preparation command from a clean reviewed checkout;
3. compare the release ID, record digest, and policy digest with the other four roles over a separate authenticated channel; and
4. inspect the exact chain, gate, approval block, validity window, funding mode, limits, reserves, evidence digests, review digests, and feature exclusions before signing.

A copied candidate, somebody else's terminal output, or the later verification receipt is not evidence that those upstream checks occurred.

## Prepare one role's payload

Run the command separately for `controller`, `guardian`, `lightningOperator`, `securityReviewer`, and `incidentCommander`:

```sh
npm run prepare:testnet-release-approval -- \
  --candidate independently-reproduced-release-candidate.json \
  --role securityReviewer
```

The command accepts only the two v3 public-testnet candidate kinds: tiny bootstrap and campaign-qualified. Candidate v1 is rejected because it accepted operator-entered review hashes; candidate v2 is rejected because it lacked a dedicated operational-readiness provenance boundary. The command rebuilds the canonical message and typed digest, requires exact false authority flags, rejects unknown fields or digest/domain/type mutation, and refuses an expired candidate. It selects the signer and signature kind from the signed policy; the operator cannot override them on the command line. All five roles should compare the same typed digest as well as the record and policy digests.

Controller and guardian must remain ERC-1271 contract-wallet signers with the exact reviewed runtime hashes. Lightning operator, security reviewer, and incident commander must remain their distinct policy-pinned EIP-712 identities. The output is an unsigned payload only. It never reads a private key or requests a wallet signature.

## Collect the approval bundle

Each signer returns one exact envelope with `role`, `signer`, `signatureKind`, and `signature`. Collect all five in a private file:

```json
{
  "schema": "treeswap.public-testnet-release-approvals.v1",
  "releaseId": "0x...",
  "recordDigest": "0x...",
  "policyDigest": "0x...",
  "approvals": [
    {
      "role": "controller",
      "signer": "0x...",
      "signatureKind": "erc1271",
      "signature": "0x..."
    }
  ]
}
```

The real file must contain exactly one approval for every role. Do not put signatures in tickets, chat, shell history, repository files, or the public verification receipt. Contract-wallet signatures must be encoded exactly as their deployed wallet expects for `isValidSignature(bytes32,bytes)`.

## Configure the live provider quorum

Provider configuration contains public identity digests and environment-variable names only:

```json
{
  "schema": "treeswap.public-testnet-release-approval-providers.v1",
  "providers": [
    {
      "identity": "0x...",
      "urlEnvironmentVariable": "TREESWAP_RELEASE_RPC_PROVIDER_ONE_URL"
    },
    {
      "identity": "0x...",
      "urlEnvironmentVariable": "TREESWAP_RELEASE_RPC_PROVIDER_TWO_URL"
    }
  ]
}
```

Export each authenticated URL only in its named environment variable. Remote endpoints must use HTTPS. The tool requires two to eight distinct identities, environment-variable names, URLs, and URL origins; their sorted identity digest and count must exactly match the candidate. Distinct origins are a technical anti-duplication check, not proof of independent ownership or operation.

## Verify without activating

```sh
TREESWAP_RELEASE_RPC_PROVIDER_ONE_URL=<secret> \
TREESWAP_RELEASE_RPC_PROVIDER_TWO_URL=<independent-secret> \
npm run verify:testnet-release-approvals -- \
  --candidate independently-reproduced-release-candidate.json \
  --approvals release-approvals.json \
  --providers release-providers.json \
  --out release-approval-receipt.json
```

For controller and guardian, every configured provider must agree on:

- the chain ID;
- the exact approval block number, hash, and timestamp;
- finalization of that block;
- canonical EIP-1898 state reads at that block hash;
- the contract-wallet runtime code hash; and
- the ERC-1271 magic value for the exact EIP-712 digest and supplied signature.

The verifier also recovers the other three EIP-712 signatures, checks all five distinct policy identities, checks expiry and replay bindings, and hashes the normalized approval bundle. Provider URLs and raw signatures never enter the receipt or summary. The receipt is written once with mode `0600`.

The receipt records `upstreamEvidenceReverifiedFromReceipt: false`, `activationProvenance: false`, and false signing, broadcast, gate-opening, and funding authority. Passing it to `activateReleaseCapabilities` fails. A production coordinator must use the separate [same-process activation boundary](./PUBLIC_TESTNET_RELEASE_ACTIVATION.md), which rebuilds the provenance-bound candidate, re-verifies this approval bundle through the live provider set, verifies a fresh two-party reconciliation, and observes the release-bound deployment without restarting. This command intentionally provides no activation route.

## Fail-closed cases

Verification fails on any candidate mutation, unknown field, authority flag, wrong schema or funding mode, signer-kind downgrade, missing or duplicate role, wrong identity, malformed or oversized signature, changed record or policy digest, replayed bundle, expired record, provider-set substitution, provider disagreement, wrong chain, non-canonical or unfinalized block, timestamp change, wallet-code change, invalid ERC-1271 response, symlink, oversized file, or output overwrite.

It still cannot prove organizational independence, hardware custody, Safe threshold policy, signer intent, upstream evidence truth, provider ownership, review quality, or incident readiness. Those are retained external launch gates.

## Standards

- [EIP-712 typed structured data](https://eips.ethereum.org/EIPS/eip-712)
- [ERC-1271 contract signature validation](https://eips.ethereum.org/EIPS/eip-1271)
- [EIP-1898 canonical block-hash state reads](https://eips.ethereum.org/EIPS/eip-1898)
- [Safe signature verification](https://docs.safe.global/reference-smart-account/signatures/checkNSignatures)
