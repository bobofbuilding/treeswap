# RFQ settlement handoff

Status: the exact second user authorization and its durable settlement record are now committed atomically in the local coordinator. A successful browser authorization response proves only that the non-dispatching settlement record exists. It grants no EVM reservation, Lightning payment, funding, claim, or settlement-dispatch authority. Funded operation remains closed.

## Product and pricing boundary

This handoff serves the Lightning ↔ BIT bridge only. Competing signed solver RFQs determine the executable amounts and fees. `1 BIT = 100 sats` remains a non-binding product reference.

No BIT/WBTC pool exists, so BIT/WBTC contributes zero price evidence today. The bridge implementation, local qualification, and closed testnet work do not wait for that pool. After a separately reviewed pool is created, mature, sufficiently liquid, independently observed, and admitted by a signed release policy, it may contribute at most one request-sized risk signal before quote selection. It cannot select a solver, determine settlement terms by itself, satisfy price quorum by itself, become a settlement route, or trigger fallback to fixed par.

## Atomic acceptance rule

`authorizeFinalizedBlindQuote` derives the settlement only from the original module-private RFQ, selected blind offer, firm reservation, solver finalization, and exact verified second EIP-712 authorization. It calls `CoordinatorStore.acceptAuthorizedFirmOfferSettlement`, which uses one SQLite `BEGIN IMMEDIATE` transaction to:

1. recheck the active firm offer, RFQ, direction, amount, capacity epoch, signed windows, first selection authorization, executable binding, and second authorization;
2. bind the second user-authorization digest to that firm offer;
3. insert the unique `INTENT_ACCEPTED` settlement; and
4. write the settlement event before commit.

If validation, uniqueness, disk, or commit fails, both the user-authorization binding and settlement insert roll back. The private browser route returns no successful authorization acknowledgement. An exact retry is idempotent; changed terms under the same identifier reject.

The authorization acknowledgement is `treeswap.selected-solver-authorization-ack.v2`. It contains the private settlement identifier and record digest so the browser can bind its receipt to durable state, while explicitly reporting:

- `fundingAuthorization: false`;
- `evmReservationAuthority: false`;
- `lightningDispatchAuthority: false`; and
- `settlementDispatchAuthority: false`.

The accepted settlement has no EVM reservation and no planned asset action. Later executable use re-reads the durable settlement and compares its record digest, direction, identifiers, nonces, authorization, invoice, payment hash, amount, quote-set commitments, selected offer, capacity epoch, and acceptance time with the original in-process provenance. Missing or changed durable state fails closed.

## Exact commitment mapping

| Durable field | Authoritative source |
| --- | --- |
| `settlementId` | private RFQ request ID |
| `pricingId` | public blind-pricing ID |
| `direction` | private RFQ direction |
| `nonceAuthorityDigest` | first user selection-authorization digest |
| `intentNonce` | private escrow-intent nonce |
| `intentDigest` | second user execution-authorization digest |
| `paymentHash` / `invoiceDigest` | verified final solver offer |
| `amountSats` | exact Lightning swap output |
| `quoteReceiptDigest` | authenticated received quote-set digest |
| `selectedSetDigest` | selected blind-offer digest |
| `selectedOfferId` / `capacityEpoch` | durable selected firm offer |
| `createdAt` | exact second-authorization acceptance time |

The public quote-request nonce and private escrow-intent nonce are separate replay domains and are not required to be equal. For Lightning → BIT, the firm Lightning amount equals the exact invoice amount. For BIT → Lightning, the durable settlement amount equals the invoice output while the firm capacity commitment separately includes the maximum routing-fee headroom. Collapsing either distinction would mis-account capacity or couple unrelated replay domains.

`intentDigest` at this stage names the verified offchain execution-authorization commitment. It is not yet a completed `TreeSwapBitVault.SelectedQuote` or `TreeSwapUserEscrow.SolverQuote` digest and must not be presented as an onchain reservation.

## Remaining asset-action gate

Before even capped funded testnet use, a separate reviewed consumer must derive the direction-specific escrow quote from this exact durable settlement and original provenance, including beneficiary, BIT amount and fee, Lightning amount, payment hash, invoice digest, user and solver nonces, `quoteExpiresAt`, `lastSafeClaimAt`, and `refundAfter`. It must verify both required signatures, produce exact reviewed calldata, obtain the user's wallet transaction where required, bind the confirmed EVM reservation to the settlement, and only then permit the direction-correct Lightning action through the existing active daemon and private-packet controls.

That consumer must preserve the tested deadline ordering, chain and escrow domains, release/risk/evidence-policy binding, one-use payment hash and nonce rules, finality checks, outbox/restart recovery, and no-preimage persistence. Deployment listeners, persistent-volume failure drills, independently operated solvers and evidence providers, multisig/open-gate controls, public-testnet campaigns, monitoring, and independent review remain separate release gates.
