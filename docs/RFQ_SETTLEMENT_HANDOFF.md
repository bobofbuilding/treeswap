# RFQ settlement handoff

Status: the exact second user authorization and its durable settlement record are committed atomically in the local coordinator. A same-process consumer derives the exact direction-specific contract typed data, approved deadlines, required EOA signatures, and zero-ETH calldata from that original RFQ provenance. The capability-bound authenticated solver-signing client and durable repository-only provider obtain the selected solver's exact EIP-712 signature with ambiguity-safe replay. A separate wallet core prepares and reviews that exact transaction, durably claims it, preserves and verifies a reported hash or same-intent replacement, and classifies exact reservation receipts and two-observation agreement. A Node-only ownership boundary issues one opaque maximum-60-second handle from the original preflight, binds its exact wallet/session, consumes it before gateway staging, and exposes one private handoff. The Node-only private gateway core binds the resulting short-lived SIWE-edge request to the durable claim and permits idempotent recording of only its exact wallet outcome. A browser-only adapter independently verifies the coordinator claim, pins the expected contract intent, and writes a digest-only atomic no-resend tombstone before one user-activated EIP-1193 call. Coordinator schema v10 independently verifies and durably binds the signed contract intent before any execution-policy binding, reservation, private packet, evidence request, or action can use it. No SIWE edge, browser UI composition, gateway listener, independently operated solver listener, or Ethereum provider is deployed, no wallet is called through the deployed application, and no transaction is confirmed onchain. A browser authorization response still proves only that the non-dispatching settlement record exists and grants no EVM reservation, Lightning payment, funding, claim, or settlement-dispatch authority. Funded operation remains closed.

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

`intentDigest` names the verified offchain execution-authorization commitment. It remains distinct from the later `contractIntentDigest`, which names the exact signed `TreeSwapBitVault.SelectedQuote` or `TreeSwapUserEscrow.BitToLightningQuote`. Neither digest alone proves an onchain reservation.

## Exact contract-intent preparation

`lib/rfq-contract-intent.mjs` accepts only the original same-process authorized finalization. It independently revalidates the canonical BOLT 11 invoice, requires the exact approved settlement-policy v1 values, derives `quoteExpiresAt`, `lastSafeClaimAt`, and `refundAfter`, and shortens quote expiry to the earliest offer or user-authorization boundary. A fresh quote is required when fewer than 30 seconds remain for wallet submission.

For Lightning → BIT it reproduces `TreeSwapBitVault.SelectedQuote`, uses the private request nonce in the user-scoped contract replay domain, binds the user's beneficiary, and requires both user and solver EOA signatures. For BIT → Lightning it reproduces `TreeSwapUserEscrow.BitToLightningQuote`, uses the solver's signed offer nonce in the solver-scoped replay domain, and pins the BIT payout to the authenticated solver EOA; v1 does not accept an unproven separate solver beneficiary. Both directions use the selected gross BIT amount and fee, exact Lightning amount, payment hash, invoice digest, chain, escrow, and runtime-code commitment. The quote ID is deterministically separated from the RFQ identifiers and commits the private settlement, selected offer, and second authorization.

Only exact low-S 65-byte signatures from the required EOAs produce calldata. The result fixes chain, sender, target, calldata digest, and zero ETH value. Prepared and signed artifacts are same-process provenance objects; copies reject. They explicitly retain `walletDispatchAuthority: false` and `lightningDispatchAuthority: false`. EIP-1271 contract-account support remains excluded from this v1 consumer even though the Solidity escrows support it.

## Durable contract-intent boundary

`persistAuthorizedContractIntent` accepts only the original same-process signed result and resolves its coordinator store from the retained authorized RFQ provenance; a caller cannot choose another store or serialize an object into authority. `CoordinatorStore.bindContractIntent` then independently verifies both direction-specific EIP-712 signatures, reconstructs the exact `reserve` or `open` calldata, checks its Keccak digest, and fixes the chain, sender, escrow, zero-ETH value, quote ID, addresses, amounts, fee, payment hash, invoice digest, nonce, and ordered deadlines. It also rechecks the durable authorized settlement and selected firm offer before one atomic write changes the settlement to `CONTRACT_INTENT_BOUND`.

Schema v10 stores the onchain quote and intent digest separately from the offchain authorization digest. It also stores the reviewed contract code hash, exact transaction and calldata digest, signers, beneficiary, economic values, deadlines, signatures, authorization time, and a canonical record digest. Every database open, backup verification, and explicit integrity check reconstructs the typed data and calldata and cryptographically verifies the persisted record again. Partial records or disk changes fail closed. Migration from schema v9 or earlier is permitted only for terminal history with no active firm offer or nonterminal settlement; missing contract authority is never invented for recoverable work.

Reservations must now identify the exact contract quote ID and contract intent digest. Private packets, dual-provider evidence requests, solver-daemon actions, and release-liability snapshots are all rebound to the contract digest. The prior offchain authorization digest cannot pass those gates. This is a durable commitment boundary only: it does not sign on behalf of a solver or user, send a wallet transaction, decide that a transaction is canonical or finalized, call Lightning, or grant funding authority.

## Selected-solver signature transport

The [solver contract-signing protocol](./SOLVER_CONTRACT_SIGNING.md) accepts only the original prepared intent and original verified capability. It signs one maximum-30-second request with a separately scoped requester key, fixes the selected solver origin and endpoint response key from that capability, and verifies the returned solver signature against the exact typed-data digest.

The provider claims the request, intent digest, and settlement in a strict private SQLite ledger before signing and commits the exact response before returning it. Ambiguous retries reuse the same bytes and replay after restart. A sealed signer keeps the EVM key in module-private memory and out of the database. This supplies repository-level signature transport only: it creates no public endpoint, user-wallet transaction, EVM confirmation, Lightning action, or funding authority.

## Remaining asset-action gate

The [contract-intent wallet boundary](./CONTRACT_INTENT_WALLET.md) supplies the validation core for the exact request, wallet outcome, transaction or same-intent replacement, receipt, direction-specific reservation event, finality, and reorg state. Its private SQLite journal durably claims the attempt and records only original core artifacts; restart is reconciliation-only and never authorizes resend. A fixed same-process EIP-1193 dispatcher requires explicit confirmation and one original claim before checking context and calling the exact request once. The ownership core accepts only the original preflight and binds one opaque handle to its wallet/session before permitting one gateway stage and private handoff. The separate private gateway authenticates the resulting maximum-30-second edge request, writes that same journal claim before issuing one signed random-token response, and allows exact outcome replay but never claim replay. The browser adapter verifies that signature and exact contract intent independently, then atomically records a digest-only no-resend tombstone before its one user-activated call. A lost response or process restart therefore leaves no reusable ownership or gateway token and, after a durable gateway claim, `SEARCH_QUOTE_NO_RESEND` rather than another wallet attempt. The remaining composition has no deployed listener or SIWE edge, and two-observation agreement remains repository evidence rather than independent canonical finality.

Before even capped funded testnet use, the remaining consumer must deploy the implemented ownership service and gateway behind a SIWE-authenticated and CSRF-protected edge that derives the session digest server-side and accepts only the issued opaque handle, preserve private TLS and key separation, suppress handle/body/claim logs and caches, make the reviewed browser adapter exclusive under CSP/build review, add fixed authenticated provider adapters, compose the journal and complete transaction lifecycle into the persistent coordinator, and independently confirm through two genuinely operated providers that the exact durable quote ID and contract intent are canonical and finalized in the reviewed escrow. It must remain one replica until a separately reviewed shared fence exists. Only then may it permit the direction-correct Lightning action through the existing active daemon and private-packet controls.

That consumer must preserve the tested deadline ordering, chain and escrow domains, release/risk/evidence-policy binding, one-use payment hash and nonce rules, finality checks, outbox/restart recovery, and no-preimage persistence. Deployment listeners, persistent-volume failure drills, independently operated solvers and evidence providers, multisig/open-gate controls, public-testnet campaigns, monitoring, and independent review remain separate release gates.
