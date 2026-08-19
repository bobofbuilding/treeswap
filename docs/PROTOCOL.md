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

The target production architecture opens quote creation and solver competition without opening public pooled custody. See [`PERMISSIONLESS_AUTOMATION.md`](PERMISSIONLESS_AUTOMATION.md). Optional EVM-to-Lightning identity linking is described in [`LIGHTNING_ACCOUNTS.md`](LIGHTNING_ACCOUNTS.md), and immutable version transitions are described in [`UPGRADES.md`](UPGRADES.md).

The RFQ client follows [`RFQ_POLICY.md`](RFQ_POLICY.md): it validates complete solver-signed offers, bounds work and one retained offer per solver, orders the verified received set by executable input price and receipt time, and commits that set before the user selects one quote. It never claims that a relay supplied a globally complete market.

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

The user chooses among the solver quotes it actually receives, then signs one complete quote for onchain reservation. TreeSwap may label the largest net output as “best received,” but never claims a globally best price. The BIT → Lightning user escrow uses a separate type hash and verifying contract so signatures cannot cross directions.

## 4. BIT inventory

`contracts/src/TreeSwapBitVault.sol` is the executable prototype for solver-owned BIT liquidity. It is immutable, has no administrator, and supports:

- exact-balance deposits into a solver-specific account;
- withdrawals of unreserved inventory only;
- user-exercised full-fill reservations signed by both the user and pre-funded solver;
- immutable beneficiary, payment hash, invoice digest, amounts, fee, nonce, and three deadlines;
- chain- and vault-domain replay protection, plus single-use user nonces;
- an immutable reference-price band, per-swap cap, and per-solver epoch cap;
- an enforced ordering from quote expiry to last safe claim time to Ethereum refund;
- permissionless preimage relay with payment only to the bound beneficiary;
- timeout return to the original solver balance;
- globally single-use payment hashes through a sealed shared cross-direction registry; and
- an immutable protocol-fee ceiling.

The escrows accept canonical 65-byte EOA signatures, reject high-s signatures, and support ERC-1271 contract signatures through a shared static signature checker. Lightning → BIT reservations require the user and pre-funded solver to sign the same exact quote; only the named user can exercise it, so the solver has no transaction-time last-look after signing. Both escrows require a live, time-bounded authorization from the immutable `TreeSwapOpenGate` and reject an unexpected BIT pause or decimal setting at open. Gate expiry or emergency halt affects only new exposure; TreeSwap never calls it from withdrawal, claim, or refund.

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

`contracts/src/TreeSwapUserEscrow.sol` implements the complementary user-funded exact escrow. A direction-specific solver signature binds the user, solver beneficiary, gross BIT, BIT fee, Lightning output, invoice digest, payment hash, nonce, and deadlines before the user deposits. Anyone may relay a valid preimage, but only the bound solver beneficiary can receive the BIT payout. A timeout returns the complete deposit to the original user without an execution fee. Local cross-direction integration and stateful invariants pass; mainnet-fork and cross-chain infrastructure tests remain required before testnet funding.

### Lightning → BIT

1. Solvers return signed quotes; the user selects one.
2. The selected solver creates a hold invoice and signs the exact selected quote against its pre-funded vault inventory.
3. The user countersigns and exercises the quote. The vault verifies both signatures, the live-open gate, BIT runtime settings, price and exposure caps, and deadline ordering. The user then verifies the finalized reservation and every supported BOLT 11 field before paying.
4. The solver settles the hold invoice with the preimage.
5. The user or a relayer supplies the preimage to claim BIT.
6. If the held payment expires, the BIT reservation returns to the solver after the Ethereum refund deadline.

## 7. Fees and units

- The contract transfers exact BIT wei and performs no onchain par conversion.
- [`UNITS_AND_ROUNDING.md`](UNITS_AND_ROUNDING.md) defines the only signable unit model: `uint96` BIT wei, whole `uint64` sats, exact millisatoshi divisibility, and integer basis points.
- Quotes use whole sats in v1 and reject incompatible millisatoshi dust.
- The protocol fee is denominated on the BIT leg in both directions.
- [`FEES.md`](FEES.md) defines the exact fee, spread, routing, and refund boundary.
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

The three deadlines are derived by the fail-closed policy in [`SETTLEMENT_POLICY.md`](SETTLEMENT_POLICY.md), not selected by a user or solver. An escrow being visible is not enough to authorize Lightning: the adapter also requires canonical finality, an exact intent digest, reconciled balances, healthy chain and node state, and time remaining before the direction-specific cutoff.

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

## 10. Identity and optional email

TreeSwap uses EIP-4361 Sign-In with Ethereum only for an offchain account session. This authentication signature is separate from the EIP-712 selected-quote signature and cannot approve BIT, reserve inventory, or authorize a swap.

The server issues a random 128-bit, ten-minute nonce bound to an allowlisted request origin, exact domain and URI. Verification requires Ethereum mainnet, the exact no-transaction statement, matching message times, a valid wallet signature, and an unused nonce. A successful sign-in replaces prior sessions for the wallet and creates an opaque 24-hour session in a `Secure`, `HttpOnly`, `SameSite=Strict`, host-only cookie; only its hash is stored server-side.

An authenticated user may separately attach one email and choose invoice notices, transaction receipts, or both. The email is stored offchain, omitted from wallet signatures and intents, detachable immediately, and automatically expires after 24 hours while unverified. Outbound delivery is hard-disabled. Enabling it requires ownership verification, enforced unsubscribe, rate limits, minimal retention, access auditing, and authenticated sender configuration.

SIWE currently supports externally owned accounts. Contract-wallet authentication requires an EIP-1271-capable verifier and an Ethereum provider before it can be advertised.

## 11. Direct send boundary

The separate Send tool is a non-custodial convenience surface, not an intent, swap, or bridge settlement:

- a BIT send requests an ordinary `transfer(recipient, amount)` from the verified BIT contract on Ethereum mainnet;
- it never calls `approve`, creates an allowance, deposits into a TreeSwap contract, or charges a TreeSwap fee;
- before review, the client canonicalizes the address and amount, rejects the zero address, checks the mainnet contract code, symbol, 18-decimal setting, pause state, and wallet balance;
- before submission, it repeats the mutable contract and balance checks, simulates the exact transfer, estimates gas, and requires a separate wallet transaction confirmation;
- a Lightning send accepts only a mainnet, amount-bearing BOLT 11 invoice that encodes a whole-satoshi amount;
- an available WebLN provider receives the exact frozen invoice only after a second user action; otherwise the client opens the standard `lightning:` wallet link;
- the Lightning wallet remains responsible for complete checksum, signature, expiry, feature, payee, and amount validation; and
- TreeSwap does not store the Lightning preimage. An on-screen direct-send receipt is not an emailed receipt or bridge-settlement proof.

Direct sends do not inherit solver quotes, reference-par pricing, bridge fee logic, escrow, refunds, or bridge timeout protection. Sign-In with Ethereum is optional and cannot authorize either asset movement.

## 12. Implementation order

1. Exercise the current signed, capped BIT inventory vault against the mainnet-fork BIT proxy, including pause and implementation-change scenarios.
2. Repeat the locally complete complementary BIT → Lightning and cross-direction campaigns against the deployed BIT proxy on a controlled mainnet fork.
3. Build the least-privilege Lightning regtest adapter and derive `lastSafeClaimAt` from validated BOLT 11 expiry, CLTV, Bitcoin height, and operating margins.
4. Test reorgs and boundary races across both chain clocks, including delayed blocks, congestion, restart, and force-close cases.
5. Add BIT proxy monitoring, reconciliation, quote shutdown, and an incident runbook without blocking existing claims or refunds.
6. Keep email delivery disabled; treat verification, delivery, unsubscribe, and abuse controls as a separately reviewed future release.
7. Run two or three independent solvers on testnet with tiny limits and no public deposits.
8. Obtain independent contract, Lightning, identity, privacy, and operational review before any mainnet funding.

See [`THREAT_MODEL.md`](THREAT_MODEL.md) for the adversarial review and launch gates.
The evidence required for each phase is tracked in [`LAUNCH_CHECKLIST.md`](LAUNCH_CHECKLIST.md), and response sequencing is defined in [`INCIDENT_RUNBOOK.md`](INCIDENT_RUNBOOK.md).
The ordered path from the current prototype to a capped mainnet beta is in [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md).
