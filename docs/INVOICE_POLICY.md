# TreeSwap invoice and payment-hash policy

Status: executable decoded-invoice policy, sealed cross-escrow onchain payment-hash registry, and live standard/hold LND regtest campaigns pass. Deployed adapter isolation and independent review remain deployment gates.

## One invoice, one intent, one full fill

TreeSwap v1 accepts only a signed mainnet BOLT 11 invoice with an exact whole-satoshi amount. The accepted intent binds the complete invoice digest, payment hash, payment secret, payee, amount, kind, and settlement deadlines before either irreversible action.

Independent partial fills are disabled. AMP, keysend, amountless invoices, BOLT 12 offers/invoices, and child intents are rejected. Basic MPP may be used only by the Lightning node to deliver one exact invoice total; its parts are not separate TreeSwap fills or claims.

`validateFullFillInvoice` requires a successful checksum/signature decode, `lnbc` mainnet, exact amount and hash, nonzero payment secret, valid compressed payee key, safe remaining expiry/final CLTV, supported required features, bounded route hints, and one copy of each singleton tag. Lightning → BIT additionally requires the hold-invoice record created for that intent. BIT → Lightning requires the user's standard invoice.

## Cross-direction uniqueness

Each escrow already consumes its own nonce and local payment hash. `TreeSwapPaymentHashRegistry` adds one global onchain namespace across the two direction contracts:

1. A deployment registrar installs exactly the reviewed vault and user escrow.
2. The registrar irreversibly seals the two-address allowlist before funding.
3. Either escrow atomically consumes the payment hash when it opens.
4. The other escrow can never consume that hash, even in the opposite direction.

The registrar has no function after sealing that can add an escrow, clear a hash, or bypass uniqueness. Deployment tooling must verify both registered addresses and sealed state.

## Direct-send distinction

The website's separate direct-send tool performs only a lightweight preview and delegates complete invoice validation to the user's Lightning wallet. It is not a bridge intent and receives no escrow or refund protection. The full decoded policy above is mandatory for TreeSwap solver settlement.
