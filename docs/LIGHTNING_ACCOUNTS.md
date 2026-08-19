# EVM identity and Lightning accounts

Status: recommended account model; no Lightning-wallet credential is stored by TreeSwap today.

An EVM address cannot natively become a Lightning account. The two systems use different keys, protocols, and payment state. TreeSwap can prove control of an EVM address and bind it to a separate Lightning receive or wallet capability.

## Recommended v1 model

1. The user signs in with Ethereum using the existing short-lived SIWE flow.
2. The user optionally links one of two Lightning capabilities:
   - a receive-only Lightning Address/LNURL-pay endpoint; or
   - a revocable Nostr Wallet Connect connection for invoice creation and exact user-approved payment.
3. The link record is separate from swap intents and never grants BIT authority.
4. A public `0x…@pay.treeswap` alias is opt-in. The default alias is random because publishing the EVM address creates permanent cross-network correlation.
5. Revocation immediately detaches the capability. Existing escrows still use only their already-signed invoice digest and payment hash.

## What each option means

| Option | Custody | Can receive | Can pay | Recommendation |
| --- | --- | --- | --- | --- |
| Lightning Address / LNURL-pay | User or chosen provider | Yes | No | Default receive identity |
| Nostr Wallet Connect | User's connected wallet | Yes, if supported | Yes, within wallet-issued capability | Preferred optional wallet connection |
| TreeSwap-hosted per-user balance | TreeSwap/custodian | Yes | Yes | Exclude from v1; requires custody, ledger, withdrawal, recovery, and regulatory design |
| Dedicated self-hosted node | User | Yes | Yes | Advanced operator path, not normal onboarding |

## Security requirements

- SIWE proves only EVM-account control; it does not authorize a Lightning payment or swap.
- Each NWC connection uses a unique, revocable client key and explicit method/budget limits.
- The NWC secret must not appear in URLs, logs, analytics, email, server-rendered HTML, or swap records.
- Prefer client-held encrypted capability storage. Unattended server-side user payment is a separate custodial/security release.
- Every invoice is still decoded and bound by amount, network, payment hash, expiry, final CLTV, payee/signature, and exact invoice digest.
- Receive aliases reveal no balance and cannot authorize payment.
- Wallet linking is optional; invoice paste/QR flows remain available without an account.

## Minimal stored record

```text
EVM address
link type
random public alias or user-approved public address
capability public identifier / encrypted reference
created, verified, and revoked timestamps
consented permissions
```

Do not store a wallet seed, LND macaroon, Lightning preimage, raw NWC connection URI, or reusable payment authorization in the application database.
