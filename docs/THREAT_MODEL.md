# TreeSwap adversarial review

Status: design review for the prototype. This is not a smart-contract audit, Lightning implementation audit, or assurance that the system is safe for real funds.

Reviewed surfaces:

- signed intents and solver quotes;
- short-lived RFQs and selected signed solver quotes;
- BIT escrow and Ethereum finality;
- BOLT 11 and Lightning hold-invoice settlement;
- fee and decimal accounting;
- segregated solver-owned BIT and Lightning inventory;
- coordinators, governance, keys, and operational recovery.

## Executive conclusion

The v1 mechanism is a bilateral RFQ followed by one full-fill hash-locked settlement. It deliberately excludes a public order book, public LP deposits, rewards, and partial fills. It is not safe merely because both sides use a hash: the beneficiary, amount, hash, timeouts, fee caps, and replay domain all have to be bound before a Lightning payment becomes irreversible.

The prototype is appropriate for product exploration. Real funds should remain disabled until every critical and high item below is implemented, tested in adversarial regtest/fork environments, and independently reviewed.

## Release-blocking findings

### TS-C01 — Fixed-par inventory drain

**Severity:** Critical  
**Status:** Repository controls implemented; live monitor, pinned deployment values, and independent executable-price sources remain a testnet gate

The 100-sat par value is not enforced by the BIT token contract. If BIT's executable market value or BNote redemption value moves below 100 sats, an attacker can acquire discounted BIT and repeatedly drain the Lightning side at TreeSwap's stale par. If BIT moves above par, the BIT side can be drained instead.

Safeguards:

- treat 100 sats as a reference, not an unconditional redemption promise;
- enforce separate per-direction and per-epoch notional caps;
- add inventory-band fees that increase as one side becomes scarce;
- stop new intents when backing, redemption, contract implementation, or external executable-price signals breach configured limits;
- require multisig recovery to resume after a circuit breaker;
- display that par is a project rule, not an onchain guarantee;
- start with solver-owned inventory so no public LP absorbs an undefined peg risk.

Implemented now: the vault enforces an immutable reference-price band, maximum BIT per swap, maximum BIT per solver epoch, and maximum fee. The fail-closed policy in `lib/risk-policy.mjs` additionally requires a fresh ERC-1967 implementation and code-hash match, an unpaused 18-decimal token, healthy Ethereum finality, three independent fresh executable price sources, a bounded source spread, a market/reference band, per-direction inventory reserves, and scarcity fees. `docs/RISK_POLICY.md` defines halt and recovery behavior. These controls are executable and tested, but production quotes remain disabled until the live inputs, pinned values, monitor, alerts, and multisig recovery process are deployed and independently reviewed.

### TS-C02 — Unbound preimage claim

**Severity:** Critical  
**Status:** Implemented in both direction-specific escrow prototypes

The preimage becomes public in a claim transaction and is known to a Lightning invoice creator. An escrow that pays `msg.sender` or allows the recipient to be chosen when the preimage is revealed can be stolen or front-run.

Safeguards:

- bind one exact Ethereum beneficiary during an onchain `RESERVED` transition before the Lightning payment starts;
- require `sha256(preimage) == paymentHash` but transfer only to the bound beneficiary;
- include escrow ID, payment hash, maker, beneficiary, amounts, fees, and expiry in the reservation event;
- make beneficiary changes impossible after payment authorization;
- mark every payment hash consumed globally so it cannot be reused.

The solver-funded vault binds the user's beneficiary in the user-signed Lightning → BIT quote before inventory is reserved. The user-funded escrow independently binds the solver beneficiary in a direction-specific, solver-signed BIT → Lightning quote before BIT is deposited. In both contracts anyone may relay the preimage, but the transfer target cannot change; payment hashes and direction-specific nonces are single-use, and the complete amount, fee, invoice digest, and deadlines are signed before Lightning authorization.

### TS-C03 — Timeout and finality race

**Severity:** Critical  
**Status:** Deterministic derivation and boundary harness implemented; regtest, fork, and fault-injection campaigns remain a testnet gate

Lightning HTLCs expire in Bitcoin block-height terms while BOLT 11 invoices and Ethereum reservations use wall-clock or Ethereum timestamps. A refund that opens too early can race a valid Lightning settlement; a claim window that is too short can let one party receive one leg while the other leg refunds.

Safeguards:

- define one monotonic settlement policy derived from current Bitcoin height, invoice expiry, final CLTV delta, Ethereum finality target, and a claim buffer;
- require the Ethereum refund deadline to outlive the last safe Lightning settlement time plus Ethereum confirmation and congestion margins;
- wait for sufficient Ethereum confirmations before authorizing a Lightning payment;
- make `CLAIMED` and `REFUNDED` mutually exclusive terminal states;
- test reorgs, delayed blocks, mempool congestion, force-close, and boundary timestamps;
- reject invoices whose expiry or final CLTV cannot satisfy the safety policy.

Both escrows enforce `quoteExpiresAt < lastSafeClaimAt`, a minimum settlement window, a minimum claim-to-refund buffer, a maximum lock duration, and a deterministic boundary where claims close exactly when refunds open. `lib/settlement-policy.mjs` now derives those values from the signed invoice timestamp, expiry, final CLTV, observed Bitcoin height, Ethereum finality target, and explicit relay and congestion margins. It requires a larger final CLTV for hold invoices, checks the actual accepted HTLC height without ever extending the signed deadline, and distinguishes an observed escrow from a canonical, finalized escrow authorized for Lightning action. `docs/SETTLEMENT_POLICY.md` defines the policy. Bitcoin regtest, Ethereum fork, reorg, restart, congestion, delayed/fast-block, HTLC-timeout, and force-close campaigns remain required before testnet funding.

### TS-C04 — Relay can suppress or reorder quotes

**Severity:** High for swaps
**Status:** Multi-solver signed validation and deterministic received-set selection implemented; global availability is explicitly not claimed

An offchain relay can hide a better quote, delay one solver, or fabricate receipt order. The escrow can enforce the exact selected quote but cannot prove that it was globally best.

Safeguards:

- have users sign the exact selected quote and enforce its output and fee caps onchain;
- have the client request quotes from multiple independent solvers or relays;
- show “best received quote,” never “global best price”;
- let the user choose the signed quote rather than letting the relay select it;
- bind the selected quote's exact output, fee, recipient, hash, and expiry; and
- keep public order-book rewards outside v1.

The escrows verify direction-specific accepted terms onchain. `lib/rfq.mjs` now verifies the solver's complete EIP-712 offer before selection, accepts a bounded response set, retains one best offer per independent solver, orders exact-output offers by input price and receipt time, commits the verified received set, and requires the user to select one exact offer. Every fallback solver requires fresh user authorization. `docs/RFQ_POLICY.md` defines the claim boundary: this proves the selected terms and reproduces the client's received set, but it cannot prove that an untrusted relay delivered every quote available elsewhere. The product therefore says “Best received quote,” requires multiple solver identities, and makes no global-best claim.

## High-severity findings

### TS-H01 — Replay across contracts, chains, or versions

**Status:** Implemented in both direction-specific escrows; account-login SIWE remains EOA-only by design

EIP-712 itself does not supply a nonce policy. A signature can be replayed unless the domain and message bind `chainId`, verifying escrow contract, protocol version, maker nonce, direction, amounts, recipient, payment hash, and expiry. The contract must cancel or consume each nonce exactly once.

Both escrows bind chain, verifying contract, protocol version, direction-specific type, participants, amount, fee, invoice digest, payment hash, nonce, and deadlines. User and solver nonces and payment hashes are consumed once. Canonical low-s EOA signatures and ERC-1271 contract signatures are supported through a shared static signature checker; malformed return data, a wrong magic value, a revert, or the wrong owner fails closed. The account-login SIWE surface remains EOA-only and does not advertise contract-wallet login.

### TS-H02 — Reservation griefing and solver last-look

**Status:** Dual-signed user-exercised BIT reservations and executable admission controls implemented; persistent quotas and live reliability telemetry remain a deployment gate

An attacker can request many quotes, while a solver can advertise attractive liquidity, wait for market movement, and abandon only losing fills.

V1 has no public order reservation. `TreeSwapBitVault` now requires the user and solver to sign the same exact quote. The solver pre-funds its segregated BIT balance, only the named user may exercise the quote, and one active reservation is permitted per user until claim or refund. The solver therefore cannot apply last-look after releasing its signature. `lib/admission-policy.mjs` separates non-reserving RFQs from firm quotes; it enforces authenticated per-identity concurrency and rolling quotas, minimum size, cancellation sequences, short expiries, admitted solvers, fresh capacity epochs, bounded firm commitments, and measured fill reliability. Repeated solver-attributable failures suspend the solver, while user expiry does not. BIT → Lightning remains a refundable liveness risk because Ethereum cannot force a Lightning payment. Bonds are deferred until a non-subjective failure adjudicator and operating data exist. Production transport, atomic persistent counters, capacity reconciliation, and reliability telemetry remain required.

### TS-H03 — BIT proxy upgrade or pause

**Status:** Fail-closed, time-bounded onchain open gate and runtime token checks implemented; live monitor, pinned mainnet values, multisig roles, and fork upgrade/pause tests remain deployment gates

BIT is an ERC-1967 proxy and its current implementation is pausable and upgradeable. An implementation change could alter transfers, decimals, or trust assumptions; a pause can prevent escrow movement.

The risk monitor pins the ERC-1967 implementation slot, proxy and implementation code hashes, decimals, pause state, finality, and executable-price inputs. `buildBitRiskAttestation` commits the exact healthy snapshot. The immutable `TreeSwapOpenGate` deploys closed, requires a delayed controller action to open, expires automatically, and lets a separate guardian halt immediately. Both escrows require that live gate and independently fail closed unless `decimals() == 18` and `paused() == false` at the opening transition. Exact sender and recipient balance deltas are enforced on token movement. The gate is never consulted by withdrawal, claim, or refund, so it cannot trap existing positions; BIT's own pause may still delay transfers until the token is unpaused. Production requires live pinned values, continuous monitoring, multisig-controlled roles, alerting, and mainnet-fork upgrade/pause tests before funding.

### TS-H04 — Rounding and unit mismatch

**Status:** Canonical integer units, explicit rounding order, exact-output minimality, and conservation tests implemented

BIT uses 18 decimals, Lightning routes in millisatoshis, and the product quotes whole satoshis. At 100 sats per BIT, one sat equals `0.01 BIT`. Unsupported dust, inconsistent rounding, or fee order can leak value over many fills.

`lib/units.mjs` is the canonical quote-unit boundary. It uses `bigint` only, accepts Lightning outputs as whole `uint64` sats, converts adapter millisatoshis only when divisible by 1,000, bounds escrow BIT to `uint96` wei, and fixes one reference sat at exactly `10^16` BIT wei. The BIT protocol fee rounds down. BIT → Lightning output rounds down to whole sats after the fee, routing is then subtracted, and the remaining sub-satoshi BIT wei is explicitly recorded on the solver leg rather than treated as protocol revenue. Exact-output quotes compute the smallest sufficient integer input. Conservation is asserted for every direction, boundary values, dust, and 10,000 small fills. UI decimal previews remain informational and cannot supply signed integer fields.

### TS-H05 — Fee denomination ambiguity

**Status:** BIT-only protocol fee, immutable recipient/cap, signed routing cap, and fee-free refund behavior implemented in both directions

TreeSwap charges the protocol fee only in BIT wei in both directions and never attempts to skim Lightning. Both escrows bind the exact BIT fee in the signed quote, reject it above an immutable deployment cap, and send it to an immutable collector only on a valid preimage claim. Refund returns the full locked amount and charges no fee. Solver spread is embedded in the signed exchange amounts; BIT → Lightning also binds a maximum routing fee and exact Lightning output. A changed fee requires a new short-lived quote and fresh authorization. [`FEES.md`](FEES.md) defines the display and accounting rules.

### TS-H06 — Liquidity-pool insolvency and adverse selection

**Status:** Public LP deposits, shares, yield claims, rewards, partial fills, and web funding disabled in v1; solver reconciliation and fault campaigns remain deployment gates

A Lightning pool is not an ERC-20 vault: channel balances, in-flight HTLCs, force closes, reserves, and node-key compromise affect solvency. Public LPs can also be selected against when par is stale.

TreeSwap v1 does not accept public LP funds or create a pooled claim. `V1_CAPABILITIES` keeps public deposits, LP shares, promised yield, rewards, partial fills, permissionless solver admission, and web funding disabled. The Earn tab is retained as a calculator for admitted solver operators and now states that it performs no deposit and offers no LP share, APY, or yield. Each vault deposit remains owned and withdrawable only by that solver, while accepted liabilities reduce its own available balance. Lightning stays on that solver's node under a separate budget. Live reconciliation, force-close, restart, and insolvency tests remain required. Any third-party deposit or yield product requires a new contract, custody/economic/legal review, and explicit capability change; it is not an extension of this v1 vault.

### TS-H07 — Lightning adapter or macaroon compromise

**Status:** Exact RPC allowlists, credential/TLS isolation, intent-bound authorization, value caps, rotation checks, and secret-free audits implemented as repository policy; regtest adapter and credential drills remain deployment gates

An adapter that can create, settle, cancel, and inspect every invoice is a hot-wallet control plane. A broad LND admin macaroon can also affect the node beyond TreeSwap.

`lib/lightning-adapter-policy.mjs` defines separate exact-URI invoice, payer, and observer roles. It rejects broad or cross-role RPCs, browser-exposed/default/stale/revoked credentials, TLS or private-network failures, node-health and capacity-epoch changes, replayed request IDs, mutated intent/hash/invoice/amount fields, and per-payment/daily/in-flight cap breaches. Hold-invoice settlement also proves `sha256(preimage) == paymentHash`. Macaroons are injected only inside the isolated adapter and are never accepted from an application request; audits contain no macaroon, preimage, or invoice text. [`LIGHTNING_ADAPTER.md`](LIGHTNING_ADAPTER.md) specifies dedicated root-key IDs, exact URI baking, rotation, revocation, and incident response. A live regtest process, permission-negative tests, and rotation/restart/force-close drills remain required before funding.

### TS-H08 — Partial-fill hash reuse

A Lightning invoice is not a divisible onchain order. Reusing its payment hash for multiple independent fills creates replay and over-claim risks. Split partial orders into child intents with unique hashes, amounts, recipients, nonces, and expiries before publication. Do not support AMP, keysend, amountless invoices, or BOLT 12 in v1.

### TS-H09 — Reorg and payment authorization

Paying Lightning before the BIT escrow is sufficiently final can leave the payer with a preimage but no durable escrow. Define confirmation thresholds, detect Ethereum reorgs, stop authorization when the chain is unhealthy, and separate `escrow seen` from `escrow final enough to pay`.

## Medium-severity findings

### TS-M01 — One-tick reward sniping (not applicable to v1)

V1 has no order book or maker reward. If rewards are ever proposed, require a minimum meaningful tick, minimum top duration, time-weighted accrual, executable quantity, and delayed challengeable settlement.

### TS-M02 — Wash fills and sybil rewards (not applicable to v1)

V1 issues no rewards. Any later incentive system needs a separate economic and sybil review and must not emit rewards greater than fees paid.

### TS-M03 — Quote flooding and cancellation churn

Signed offchain intents are cheap to spam. Add maker nonces, rate limits, minimum quantity, cancellation sequence numbers, per-key quotas, and solver admission/bonding. Keep matching complexity bounded per request.

### TS-M04 — Hidden routing and stale capacity

Lightning route fees and capacity are uncertain. A quote must be firm up to a signed maximum routing cost and expire quickly. Penalize repeated failure, avoid presenting probes as guarantees, and fall back to the next quote only with fresh user authorization if output changes.

### TS-M05 — Mempool preimage disclosure

Once a preimage appears in a public Ethereum transaction, bots can copy it. Beneficiary binding makes copying harmless, but only if all state transitions pay the pre-bound address. Consider private transaction submission for reliability, not as the primary security control.

### TS-M06 — Invoice substitution and malformed invoice data

Decode and validate the BOLT 11 signature, exact payment hash, exact amount, payee, network, payment secret, expiry, final CLTV, and supported features. Bind an invoice digest to the accepted quote. Reject ambiguous or amountless invoices.

### TS-M07 — Data and UI injection

Invoice descriptions, solver names, token metadata, and memos are untrusted strings. Escape them in every interface and log, cap length, avoid rendering arbitrary markup, and never treat invoice text as instructions.

### TS-M08 — Privacy leakage

A public intent can expose payment hashes, amounts, timing, Ethereum addresses, and Lightning route hints. Publish the minimum needed to price an intent; reveal the full invoice only to the reserved taker, minimize retention, and document the cross-network linkage created by settlement.

### TS-M09 — Governance capture

An admin that can instantly change fees, upgrade escrow, redirect a treasury, or pause exits can steal or trap value. Prefer an immutable escrow; otherwise use a multisig, timelock, public change events, hard fee caps, and a pause that blocks only new opens/reservations.

### TS-M10 — SIWE replay, phishing, or session theft

A generic wallet signature, reusable nonce, mismatched domain, or readable session token can let an attacker impersonate a wallet account. The current account surface cannot move funds, but notification data and any later private swap history still require protection.

TreeSwap uses the EIP-4361 plaintext format with an explicit no-transaction statement. The server generates a random 128-bit nonce, binds it to the exact domain and URI, limits it to ten minutes, verifies Ethereum mainnet and message times, atomically consumes it once, and creates a random opaque session. The cookie is `HttpOnly`, `SameSite=Strict`, scoped to `/`, and secure outside localhost. State-changing account requests require the exact request origin. Contract-wallet SIWE remains disabled until EIP-1271 verification is available.

### TS-M11 — Email correlation, spoofing, and unwanted delivery

Attaching email creates a durable correlation between an Ethereum address and an offchain identity. Accepting an unverified address can also send unwanted messages to a third party.

Email is optional, omitted from SIWE and swap intents, stored separately, and detachable. Invoice and receipt consent are independent. Every new or changed address returns to `pending`; the prototype sends nothing. Delivery must remain disabled until ownership verification, unsubscribe enforcement, rate limits, minimal retention, access logging, and deletion procedures exist.

### TS-M12 — Direct-send substitution or confused authorization

A clipboard attacker, injected provider, stale tab, or last-second account/network change can substitute a BIT recipient or Lightning invoice. A user may also mistake a harmless SIWE login signature for payment authorization, or assume a direct payment has bridge escrow and refund protection.

The direct-send client keeps authentication and payment authorization separate, freezes canonical destination and amount data in a dedicated real-funds review, and requires a second wallet action. BIT sends are restricted to Ethereum mainnet and the expected contract address, reject the zero address and self-send, recheck the connected account, token symbol, decimals, pause state, and balance immediately before use, simulate the exact `transfer`, and never request approval. Lightning sends accept only amount-bearing mainnet invoices with whole-satoshi amounts and pass the frozen invoice to the wallet for full validation; the fallback reports only that a wallet was opened, never that payment succeeded. The UI states that direct sends are irreversible and have no solver, bridge fee, escrow, or refund protection. Users must still verify the complete destination and amount in a trusted wallet because a web client cannot make a compromised provider safe.

## Contract invariants

A production escrow test suite should prove at least:

1. BIT out never exceeds BIT deposited for an escrow.
2. `CLAIMED` and `REFUNDED` cannot both occur.
3. Only a pre-bound beneficiary receives a claim.
4. A claim requires `sha256(preimage) == paymentHash`.
5. A payment hash and maker nonce are consumed at most once.
6. Applied fees never exceed the signed caps.
7. No fee is collected from an unmatched or expired intent.
8. Claims and refunds remain available when new intent creation is paused.
9. Reservation expiry cannot shorten the absolute refund safety window.
10. Every amount conversion is deterministic and conserves value modulo documented dust.
11. A BIT transfer must produce the exact expected escrow balance delta.
12. An implementation-slot change in BIT prevents new reservations until reviewed.

## RFQ and quote-selection properties

1. The client compares only valid signed quotes for the same exact request.
2. Net output includes every mandatory fee in the same order and unit.
3. A relay cannot change a signed amount, beneficiary, hash, or expiry.
4. Cancelling or consuming a nonce prevents every later attempt to use it.
5. A quote cannot be accepted after expiry or beyond its executable quantity.
6. A quote is unavailable while BIT collateral or Lightning capacity is stale.
7. Selecting a fallback quote after a failure requires fresh user authorization when output changes.

## Required adversarial tests

- Stateful fuzzing of every escrow transition and signature field.
- Claim/refund transactions in the same block and around every timeout boundary. **Deterministic and contract boundary harness complete.**
- Preimage copied from the mempool by an unrelated account.
- Ethereum reorg after escrow creation and after claim. **Authorization rejects an orphaned escrow; fork fault injection remains.**
- Bitcoin block delay, LND restart, held HTLC timeout, and force-close. **Policy harness complete; regtest fault injection remains.**
- Replayed intent on another chain, escrow address, protocol version, and nonce.
- Replayed or mutated SIWE domain, URI, nonce, chain, issued time, and expiry.
- Cross-origin session mutation, expired session use, and notification access from a different wallet.
- Unverified-email delivery, preference bypass, unsubscribe failure, and wallet/email deletion.
- BIT recipient or amount mutation between review and submission, account/network changes, paused or upgraded token behavior, failed transfer simulation, malformed invoices, WebLN rejection, and `lightning:` fallback falsely reported as paid.
- BIT pause and implementation upgrade while escrows are open.
- Fee rounding across dust, maximum values, and thousands of small fills.
- Solver quote spam, cancellation, capacity exhaustion, and deliberate last-look failure.
- Relay suppression, quote substitution, and stale fallback selection.
- LP withdrawal while liabilities are reserved or in flight.

## Launch gates

### Prototype publication

- Clearly mark bridge flows as simulations and direct sends as real, irreversible wallet payments without bridge protection.
- SIWE may sign a login message, but it cannot authorize a payment; BIT sends request no approval and require their own transaction confirmation.
- Threat model and par-value caveat public.
- MIT license and reproducible build.

### Testnet

- Mainnet-fork escrow campaign, including BIT proxy changes and pauses.
- Regtest hold-invoice adapter and forced-timeout tests.
- Complementary BIT → Lightning escrow and direction-replay tests. **Repository harness complete; mainnet-fork and cross-chain integration remain.**
- EIP-1271 SIWE support if contract wallets are accepted.
- Verified email delivery, unsubscribe enforcement, retention limits, and abuse controls before sending mail.
- Monitoring for BIT proxy upgrades and pauses.
- No public LP deposits, order book, or rewards.

### Capped mainnet beta

- Independent contract and Lightning design review.
- Multisig/timelock, circuit breakers, caps, reconciliation, and incident runbook.
- Solver bonds and measurable fill reliability.
- Public risk disclosures and explicit loss allocation.
- Very small per-swap and per-epoch limits.

### Public liquidity

- Separate review of custody, LP share accounting, insolvency, withdrawal queues, adverse selection, and applicable legal obligations.

## Primary technical references

- [BOLT 11 payment encoding](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md)
- [BOLT 2 HTLC peer protocol](https://github.com/lightning/bolts/blob/master/02-peer-protocol.md)
- [BOLT 4 final-hop validation](https://github.com/lightning/bolts/blob/master/04-onion-routing.md)
- [LND AddHoldInvoice API](https://lightning.engineering/api-docs/api/lnd/invoices/add-hold-invoice/)
- [LND macaroon permissions and revocation](https://docs.lightning.engineering/lightning-network-tools/lnd/macaroons)
- [EIP-712 typed structured data](https://eips.ethereum.org/EIPS/eip-712)
- [ERC-1967 proxy storage](https://eips.ethereum.org/EIPS/eip-1967)
- [0x firm RFQ lifecycle](https://docs.0x.org/docs/introduction/quickstart/swap-tokens-with-0x-swap-api)
- [BIT verified proxy and implementation](https://etherscan.io/token/0x57A447E4d5e18A9423408C365963A73F08B9d18C#code)
