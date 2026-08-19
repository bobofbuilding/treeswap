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

The selected terms use EIP-712 typed data with a domain containing protocol name, version, chain ID, and verifying vault. The message binds:

```ts
type SelectedQuote = {
  quoteId: `0x${string}`;
  direction: "LIGHTNING_TO_BIT" | "BIT_TO_LIGHTNING";
  user: `0x${string}`;
  solver: `0x${string}`;
  bitAmountWei: bigint;
  lightningAmountSats: bigint;
  protocolFeeBitWei: bigint;
  paymentHash: `0x${string}`;
  invoiceDigest: `0x${string}`;
  nonce: bigint;
  expiresAt: number;
  refundAfter: number;
};
```

The user chooses among the signed quotes it actually receives. TreeSwap may label the largest net output as “best received,” but never claims a globally best price.

## 4. BIT inventory

`contracts/src/TreeSwapBitVault.sol` is the first executable prototype for solver-owned BIT liquidity. It is immutable, has no administrator, and supports:

- exact-balance deposits into a solver-specific account;
- withdrawals of unreserved inventory only;
- solver-created full-fill reservations;
- immutable beneficiary, payment hash, amount, fee, and refund deadline;
- permissionless preimage relay with payment only to the bound beneficiary;
- timeout return to the original solver balance;
- globally single-use payment hashes; and
- an immutable protocol-fee ceiling.

The prototype does not yet verify the full EIP-712 quote onchain. The solver creates a reservation from its own inventory, and the user must compare the resulting event to the selected quote before authorizing Lightning. Signature enforcement is required before a public testnet.

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
3. The user verifies the finalized reservation and every supported BOLT 11 field before paying.
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
- Payment hashes and quote nonces are globally single-use.
- Ethereum refund is later than the final safe Lightning settlement time plus finality and congestion buffers.
- Every fee is exact, signed, and under an immutable cap.
- BIT implementation changes or pauses stop new quotes and reservations.
- Real swaps remain disabled when balances or Lightning capacity cannot be reconciled.

## 10. Implementation order

1. Complete the BIT inventory vault and stateful campaign on a mainnet fork.
2. Add the complementary user-funded exact BIT escrow for BIT → Lightning.
3. Enforce the selected EIP-712 solver quote onchain.
4. Build the least-privilege Lightning regtest adapter and hold-invoice lifecycle.
5. Formally parameterize timeout ordering and test both chain clocks.
6. Run two or three independent solvers on testnet with tiny limits and no public deposits.
7. Obtain independent contract, Lightning, and operational review before any mainnet funding.

See [`THREAT_MODEL.md`](THREAT_MODEL.md) for the adversarial review and launch gates.
