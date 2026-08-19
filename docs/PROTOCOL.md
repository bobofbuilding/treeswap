# TreeSwap protocol sketch

Status: prototype specification and local contract harness; not audited and not ready for real funds.

## 1. Product boundary

TreeSwap coordinates full-fill swaps between Lightning sats and BIT on Ethereum at contract `0x57A447E4d5e18A9423408C365963A73F08B9d18C`.

The product displays `1 BIT = 100 sats` as a project reference value. The BIT contract does not enforce that price. TreeSwap never promises unconditional redemption at par; users accept exact integer amounts from short-lived solver quotes.

The user experience is invoice-first. BIT → Lightning starts with an exact, amount-bearing BOLT 11 invoice supplied by the user. Lightning → BIT fixes the BIT amount and Ethereum beneficiary before the selected solver creates the hold invoice. Amountless invoices remain unsupported in v1.

## 2. Minimal participants

| Participant | Responsibility |
| --- | --- |
| User | Requests a quote, validates the invoice or escrow, and selects one signed solver quote. |
| Solver | Maintains its own BIT inventory and Lightning node, signs firm quotes, and completes accepted swaps. |
| RFQ relay | Delivers requests and quotes. It cannot select a beneficiary or move funds. The client may contact multiple relays or solvers. |
| BIT vault | Segregates solver balances and locks exact BIT amounts to one beneficiary and payment hash. |
| Lightning adapter | Runs beside the solver node with least-privilege credentials and enforces invoice, amount, hash, and capacity policy. |

There is no central limit order book, shared LP pool, market-making reward, partial fill, or permissionless solver admission in v1.

## 3. Selected-quote intent

For the implemented Lightning → BIT vault, the user accepts the exact selected terms with EIP-712 typed data. The domain binds protocol name, version, chain ID, and verifying vault. The message binds:

```ts
type SelectedQuote = {
  quoteId: `0x${string}`;
  user: `0x${string}`;
  solver: `0x${string}`;
  beneficiary: `0x${string}`;
  amount: bigint; // gross BIT wei reserved
  fee: bigint; // BIT wei
  lightningAmountSats: bigint;
  paymentHash: `0x${string}`;
  invoiceDigest: `0x${string}`;
  nonce: bigint;
  quoteExpiresAt: number;
  lastSafeClaimAt: number;
  refundAfter: number;
};
```

The user chooses among the solver quotes it actually receives, then signs one complete quote for onchain reservation. TreeSwap may label the largest net output as “best received,” but never claims a globally best price. A future BIT → Lightning escrow must use a separate direction-specific type hash or verifying contract so signatures cannot cross directions.

## 4. BIT inventory

`contracts/src/TreeSwapBitVault.sol` is the first executable prototype for solver-owned BIT liquidity. It is immutable, has no administrator, and supports:

- exact-balance deposits into a solver-specific account;
- withdrawals of unreserved inventory only;
- solver-created full-fill reservations accepted by the user's EIP-712 signature;
- immutable beneficiary, payment hash, invoice digest, amounts, fee, nonce, and three deadlines;
- chain- and vault-domain replay protection, plus single-use user nonces;
- an immutable reference-price band, per-swap cap, and per-solver epoch cap;
- an enforced ordering from quote expiry to last safe claim time to Ethereum refund;
- permissionless preimage relay with payment only to the bound beneficiary;
- timeout return to the original solver balance;
- globally single-use payment hashes; and
- an immutable protocol-fee ceiling.

The prototype accepts canonical 65-byte EOA signatures and rejects high-s signatures. EIP-1271 contract-wallet signatures are not yet supported. The price band and volume limits are immutable deployment parameters; they limit damage from a stale reference but do not establish an external fair price or monitor the upgradeable BIT token.

## 5. Lightning inventory

Lightning liquidity remains on each solver's node. TreeSwap records only a short-lived, conservative capacity declaration.

For BIT → Lightning, the solver needs outbound Lightning capacity to pay the user's invoice. For Lightning → BIT, it needs sufficient inbound capacity to accept the user's held payment plus BIT inventory to deliver.

The solver adapter computes usable capacity as the minimum of:

```text
operator budget
node-reported spendable or receivable capacity
daily risk limit remaining
available inventory after accepted in-flight swaps
```

The public web application never receives a node macaroon, seed, preimage store, or unrestricted RPC endpoint.

## 6. Settlement flows

### BIT → Lightning

1. The user creates an exact BOLT 11 invoice and requests quotes.
2. The user selects one solver quote and deposits or reserves the quoted BIT to the solver-bound escrow.
3. The solver waits for the configured Ethereum finality threshold and validates the invoice.
4. The solver pays the invoice and receives the preimage.
5. Anyone may relay the preimage, but BIT is paid only to the bound solver beneficiary.
6. If payment never occurs, the user's exact-swap escrow refunds after the longer deadline.

The current inventory vault models solver-funded BIT, so the complementary user-funded exact escrow remains a required contract before this direction is complete.

### Lightning → BIT

1. Solvers return signed quotes; the user selects one.
2. The selected solver creates a hold invoice and reserves exact BIT from its vault to the user's Ethereum address.
3. The vault verifies the user's exact signed quote, price and exposure caps, and deadline ordering. The user then verifies the finalized reservation and every supported BOLT 11 field before paying.
4. The solver settles the hold invoice with the preimage.
5. The user or a relayer supplies the preimage to claim BIT.
6. If the held payment expires, the BIT reservation returns to the solver after the Ethereum refund deadline.

## 7. Fees and units

- The contract transfers exact BIT wei and performs no onchain par conversion.
- Quotes use whole sats in v1 and reject incompatible dust.
- The protocol fee is denominated on the BIT leg in both directions.
- BIT → Lightning carries the higher solver fee because it consumes outbound Lightning liquidity and routing certainty.
- Every active swap fixes its exact fee; no later configuration can reprice it.
- No protocol execution fee is charged on refund.

## 8. Funding model

“Fund liquidity” means configuring a solver, not buying a transferable LP share:

- the solver deposits BIT into its segregated vault account;
- the solver assigns a capped Lightning budget to its own node adapter;
- 25% is left unquoted by the current product prototype as an operational buffer;
- every accepted quote reduces available capacity immediately;
- withdrawals cannot consume reserved BIT or Lightning committed to an in-flight payment; and
- quotes stop automatically if reconciliation, node health, BIT proxy monitoring, or circuit breakers fail.

See [`LIQUIDITY_FUNDING.md`](LIQUIDITY_FUNDING.md) for the operational sequence.

## 9. Mandatory invariants

- Vault BIT balance equals available solver inventory plus locked inventory.
- A solver can withdraw only its own unreserved inventory.
- A claim pays only the beneficiary bound before Lightning authorization.
- `CLAIMED` and `REFUNDED` are mutually exclusive.
- Payment hashes are single-use within the vault, and each user's quote nonce is single-use.
- Ethereum refund is later than the final safe Lightning settlement time plus finality and congestion buffers.
- Every fee is exact, signed, and under an immutable cap.
- BIT implementation changes or pauses stop new quotes and reservations.
- Real swaps remain disabled when balances or Lightning capacity cannot be reconciled.

## 10. Implementation order

1. Exercise the current signed, capped BIT inventory vault against the mainnet-fork BIT proxy, including pause and implementation-change scenarios.
2. Add the complementary user-funded exact BIT escrow for BIT → Lightning with a direction-separated EIP-712 type.
3. Build the least-privilege Lightning regtest adapter and derive `lastSafeClaimAt` from validated BOLT 11 expiry, CLTV, Bitcoin height, and operating margins.
4. Test reorgs and boundary races across both chain clocks, including delayed blocks, congestion, restart, and force-close cases.
5. Add BIT proxy monitoring, reconciliation, quote shutdown, and an incident runbook without blocking existing claims or refunds.
6. Run two or three independent solvers on testnet with tiny limits and no public deposits.
7. Obtain independent contract, Lightning, and operational review before any mainnet funding.

See [`THREAT_MODEL.md`](THREAT_MODEL.md) for the adversarial review and launch gates.
