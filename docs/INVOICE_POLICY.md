# TreeSwap invoice and payment-hash policy

Status: an independent bounded BOLT 11 decoder, executable raw-invoice policy, sealed cross-escrow onchain payment-hash registry, and live standard/hold LND regtest campaigns pass locally. Deployed adapter composition and independent review remain deployment gates.

## One invoice, one intent, one full fill

TreeSwap v1 accepts only a signed mainnet BOLT 11 invoice with an exact whole-satoshi amount. The accepted intent binds the complete invoice digest, payment hash, payee, amount, and settlement deadlines before either irreversible action. The payment secret is independently decoded and required but is not added to the public intent.

Independent partial fills are disabled. AMP, keysend, amountless invoices, BOLT 12 offers/invoices, and child intents are rejected. Basic MPP may be used only by the Lightning node to deliver one exact invoice total; its parts are not separate TreeSwap fills or claims.

`lib/bolt11.mjs` parses the raw string itself; no caller-supplied decoded record can authorize anything. It bounds invoice length and tag count, verifies Bech32 and the compact secp256k1 signature, recovers or validates the compressed payee key, parses every amount multiplier exactly, enforces tag lengths/padding/singletons, validates route-hint and fallback structure, applies BOLT 9 required-feature behavior, and retains no route-hint contents. `validateFullFillInvoice` then requires `lnbc` mainnet, exact digest/amount/hash/payee, a nonzero payment secret, safe remaining expiry and final CLTV, supported required features, bounded route hints, and an inline UTF-8 description. Hashed descriptions remain disabled because TreeSwap has no authenticated description preimage to verify.

## Invoice-kind boundary

BOLT 11 does not encode whether the receiver created an invoice through a normal or hold-invoice RPC. TreeSwap therefore does not accept a remote `invoiceKind` flag and does not claim that a browser can prove hold behavior from the invoice string.

The reference Lightning → BIT solver still creates its invoice through the isolated LND `AddHoldInvoice` path and retains that local provenance. Cross-party safety, however, rests on controls the user can verify: the invoice signature must recover the capability-bound Lightning node, its amount/hash/digest and conservative timing must match the executable quote, the BIT lock must be canonical and finalized before Lightning payment, and the preimage can pay only the already-bound beneficiary. A standard invoice that satisfies those same rules is not treated as less atomic merely because its private receiver-side creation RPC cannot be observed. Independent review must confirm this ordering before funding.

## Cross-direction uniqueness

Each escrow already consumes its own nonce and local payment hash. `TreeSwapPaymentHashRegistry` adds one global onchain namespace across the two direction contracts:

1. A deployment registrar installs exactly the reviewed vault and user escrow.
2. The registrar irreversibly seals the two-address allowlist before funding.
3. Either escrow atomically consumes the payment hash when it opens.
4. The other escrow can never consume that hash, even in the opposite direction.

The registrar has no function after sealing that can add an escrow, clear a hash, or bypass uniqueness. Deployment tooling must verify both registered addresses and sealed state.

## Direct-send distinction

The website's separate direct-send tool performs only a lightweight preview and delegates complete invoice validation to the user's Lightning wallet. It is not a bridge intent and receives no escrow or refund protection. The full decoded policy above is mandatory for TreeSwap solver settlement.

## Primary specifications

- [BOLT 11 invoice protocol](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md)
- [BOLT 9 assigned feature flags](https://github.com/lightning/bolts/blob/master/09-features.md)
- [BIP 173 Bech32](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki)
