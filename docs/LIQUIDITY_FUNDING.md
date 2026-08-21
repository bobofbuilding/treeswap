# TreeSwap liquidity funding

Status: admitted-solver implementation plan with a fail-closed signed release boundary. No public funding endpoint, deployed signer set, signed release record, or audited contract deployment exists.

The product's Earn tab is a calculator, not a deposit surface. It creates no LP share, yield claim, pooled ownership, or wallet transaction. `V1_CAPABILITIES.webSolverFunding` remains disabled. A future operator-funding feature can be derived only from the provenance-bound five-role release authorization described in [Release authorization boundary](./RELEASE_AUTHORIZATION.md); a caller cannot enable it with an application flag.

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
7. For each firm quote, the solver signs the exact swap ID, payment hash, beneficiary, amount, BIT fee, and deadlines; the named user countersigns and exercises it against the solver's available vault balance.
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
- [x] Full dual-signed selected-quote EIP-712 verification
- [x] Complementary user-funded exact escrow
- [x] BIT mainnet-fork pause, implementation-slot, both-direction settlement, and balance-delta tests
- [x] Controlled local EVM reorg before and after Lightning authorization, in both directions and on the pinned live-BIT fork
- [x] Isolated signed Lightning regtest adapters with hold-invoice create, accept, settle, payment, role isolation, and restart-safe replay rejection
- [x] Full local Lightning failure injection and durable coordinator reconciliation, including restart, lost response, force close, stale chain, route failure, exact duplicates, and credential/TLS rotation
- [x] Deterministic cross-clock timeout model and boundary tests
- [x] Local dual-provider finalized BIT-vault reader and signed aggregate Lightning-capacity protocol
- [x] Short-lived signed bootstrap roster with derived provider, observer, monitor, relay, solver, and alert-channel counts; exact deployment-provider matching; and provenance-only release-candidate integration
- [ ] Deploy continuous reconciliation and capacity observations with independent operators
- [ ] Two independent solver deployments
- [ ] External review and tiny testnet limits
