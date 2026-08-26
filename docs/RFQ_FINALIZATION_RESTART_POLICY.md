# RFQ finalization restart policy

Status: the durable coordinator cleanup policy and adversarial local tests are implemented. Deployment startup ordering, persistent-volume operation, real process-kill drills, monitoring, and independent review remain required. Funded operation remains closed.

## Safety rule

A coordinator restart destroys every in-memory browser token, private RFQ request, invoice, signature, selected quote object, and finalization lease. TreeSwap never rebuilds that authority from SQLite and never asks the selected solver or LND to create another invoice merely because the coordinator restarted.

The coordinator database retains only the non-secret commitments already needed for accounting: the RFQ and offer digests, selected solver, direction, separate BIT and Lightning capacity amounts, signed expiries, market-risk commitment, executable-offer binding, user-authorization digest, and any settlement reference. The restart policy reads that ledger through the original factory-opened store and classifies each active offer without returning an identifier:

- reserved, before an executable quote is durably bound;
- finalized, after the executable quote is bound but before the second user authorization;
- authorized, after a lower-level second-authorization write but before settlement handoff; or
- settlement-owned, after any durable settlement has selected the offer.

The first three states have lost their browser authority. They remain neutral capacity commitments until the exact signed firm-offer expiry. At or after that boundary, a bounded atomic sweep records `EXPIRED_UNEXERCISED`, releases both BIT and Lightning capacity, and does not count a solver failure. It cannot release early, invoke a provider, contact Lightning, create an invoice, fund a pool, dispatch settlement, or recover private request data.

A settlement-owned offer follows a different rule: restart cleanup, generic RFQ expiry, user cancellation, abandonment, and a caller-supplied offer outcome cannot release it even after quote expiry. The durable settlement and its offer remain attached for the existing settlement recovery and both-assets reconciliation path. `COMPLETED` can close the offer only with the exact completed-settlement proof. `REFUNDED`, `FAILED`, or `CANCELED` can release it neutrally only with that exact terminal proof after both assets reconcile; the RFQ becomes abandoned and solver reliability is unchanged. A terminal settlement whose offer accounting is not yet closed is protected until that operation succeeds. Any settlement-owned offer without both the executable binding and exact second user-authorization digest, with mismatched RFQ/economic fields, or sharing one RFQ with another settlement halts reconciliation instead of guessing which state is authoritative.

The atomic store also prevents a late settlement from claiming an expired offer, a pre-seeded settlement identifier from being turned into a later firm offer, and a second settlement from attaching to another offer for the same RFQ. These checks make the settlement-owned classification causal rather than a label added after capacity was released.

## Startup and ongoing operation

`createRfqFinalizationRestartPolicy` owns the production wall clock, requires a durable factory-opened coordinator store and an active deployment lifecycle, verifies the original reconciliation method, and performs one atomic sweep before returning. The policy cannot be constructed with an in-memory database or a substituted store method. Its test-only factory is separately named and branded.

Every later sweep is capped at 1,000 expired offers. An unexpired burned ceremony reports `waiting-for-expiry`, a remaining backlog reports `cleanup-incomplete`, and either state keeps new exposure closed. Any settlement-owned commitment reports `settlement-recovery-required`; an operator must transfer responsibility to the reviewed settlement recovery service before allowing new exposure. The coordinator compares its clock with both a persisted restart high-water mark and the latest durable liability event, so rollback across processes fails closed.

The status surface is aggregate-only. It reports phase counts, the earliest pending expiry, cleanup counts, settlement-owned counts, and a digest over those aggregates. It contains no wallet, solver, RFQ, offer, settlement, invoice, payment hash, endpoint, token, or private failure detail, and every authority flag is false.

An authorized offer without a durable settlement is still classified as browser-abandoned. The production high-level path now skips that crash window: it binds the exact second authorization and inserts the settlement in one transaction, then returns browser success only after commit. The lower-level authorization method remains an infrastructure/test boundary, so restart still handles a standalone authorized row defensively. No Lightning or EVM asset action may exist before the durable settlement is accepted. The next release gate is the settlement-to-contract-intent/private-packet consumer; the current prototype cannot reserve or dispatch either asset leg. See [RFQ settlement handoff](./RFQ_SETTLEMENT_HANDOFF.md).

Production orchestration must:

1. open and integrity-check the durable coordinator volume;
2. construct this policy before exposing the quote or private-ceremony listener;
3. wait out `waiting-for-expiry` liabilities and drain any `cleanup-incomplete` backlog;
4. route `settlement-recovery-required` liability to the existing recovery boundary without enabling new exposure; and
5. continue bounded sweeps while the process runs, retaining aggregate health and alert evidence.

The future BIT/WBTC pool has no role in this policy. While that pool is absent it contributes no price observation; after its separate launch and review it may still supply only a request-bound risk signal. It cannot change expiry, recover browser authority, create Lightning invoices, settle TreeSwap, or release either capacity ledger.

## Remaining evidence

Before funded testnet use, deploy this startup order against the same persistent coordinator volume as the browser and settlement services. Drill process kill before finalization, after invoice creation, after executable binding, after second authorization, after settlement acceptance, and after terminal reconciliation. Retain proof of exact-expiry release, zero duplicate provider/LND calls, settlement-liability preservation, bounded backlog drain, clock-rollback refusal, volume backup/restore, aggregate alert delivery, and independent protocol, Lightning, privacy, and operations review.
