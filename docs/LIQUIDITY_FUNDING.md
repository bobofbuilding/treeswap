# TreeSwap liquidity funding

Status: implementation plan. No live funding endpoint or audited contract deployment exists.

## Chosen model

TreeSwap v1 uses segregated solver inventory. It does not accept public LP deposits and does not create a shared claim across Lightning and BIT.

This choice avoids pretending Lightning channel balances behave like ERC-20 vault assets. It also gives every solver a bounded failure domain: one solver's node or inventory problem stops that solver's quotes without making another solver insolvent.

## BIT funding sequence

1. Verify the expected BIT proxy implementation, decimals, pause state, and transfer behavior.
2. Connect the solver's dedicated Ethereum inventory wallet.
3. Approve only the intended BIT funding amount to the reviewed immutable vault.
4. Call `deposit(amount)` and wait for the configured finality threshold.
5. Reconcile `availableBalance(solver)` with vault events and the vault's actual BIT balance.
6. Enable quotes only below a separately configured inventory budget.
7. For each accepted quote, the solver calls `reserve` with one swap ID, payment hash, beneficiary, exact amount, fee, and refund time.
8. Withdraw only unreserved inventory. Remove allowances when the solver is disabled.

Before testnet, reservations must also prove authorization from the selected signed quote and deployment tooling must verify bytecode and constructor immutables.

## Lightning funding sequence

1. Run the adapter beside a dedicated solver node; never in the public web process.
2. Bake least-privilege credentials for only the invoice, payment, and lookup methods required by the chosen direction.
3. Set distinct operator budgets for outbound payments and inbound held payments.
4. Reserve channel funds for commitments, channel reserves, routing uncertainty, and force-close recovery.
5. Reconcile node balances and in-flight HTLCs before every quote batch.
6. Sign only quotes within the conservative capacity snapshot and expire them quickly.
7. Debit capacity as soon as a quote is accepted, not when the payment finishes.
8. Release capacity only after settlement or a confirmed terminal failure.

## Capacity accounting

```text
available BIT = deposited BIT - locked BIT

outbound Lightning available = min(
  operator outbound budget,
  spendable local channel balance - channel reserve,
  daily limit remaining
) - accepted outbound commitments

inbound Lightning available = min(
  operator inbound budget,
  receivable remote channel balance - safety reserve,
  daily limit remaining
) - accepted held payments
```

The UI's current 25% unquoted buffer and 5% suggested first-fill cap are conservative product defaults for planning only. They are not audited safety parameters.

## Automatic stop conditions

The solver must stop issuing new quotes when any of these occurs:

- BIT is paused or its proxy implementation changes;
- vault liabilities do not equal its BIT balance;
- the Lightning node is unhealthy, behind, or cannot reconcile in-flight HTLCs;
- capacity data is stale;
- routing failure rate crosses the configured threshold;
- the reference-value deviation or directional epoch cap is breached;
- Ethereum or Bitcoin finality assumptions are degraded; or
- the solver's signer or macaroon may be compromised.

Stopping new quotes must not disable valid claim, refund, or solver withdrawal paths.

## Testnet readiness checklist

- [x] Segregated BIT vault prototype
- [x] Deterministic unit and stateful accounting tests
- [ ] Full selected-quote EIP-712 verification
- [ ] Complementary user-funded exact escrow
- [ ] BIT mainnet-fork pause, upgrade, and balance-delta tests
- [ ] Lightning regtest adapter with hold invoices
- [ ] Cross-clock timeout model and race tests
- [ ] Reconciliation service and signed capacity heartbeats
- [ ] Two independent solver deployments
- [ ] External review and tiny testnet limits

