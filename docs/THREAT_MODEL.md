# TreeSwap adversarial review

Status: the repository hardening pass covers every listed finding, but funded operation remains blocked by the external evidence in the launch checklist. This is not a smart-contract audit, Lightning implementation audit, or assurance that the system is safe for real funds.

Reviewed surfaces:

- signed intents and solver quotes;
- short-lived RFQs and selected signed solver quotes;
- BIT escrow and Ethereum finality;
- BOLT 11 and Lightning hold-invoice settlement;
- fee and decimal accounting;
- segregated solver-owned BIT and Lightning inventory;
- coordinators, governance, keys, and operational recovery.

## Resolution ledger

“Repository resolved” means the control and local evidence exist. “External gate” means the repository fails closed but funded operation still needs deployed infrastructure, fork/regtest evidence, live values, or independent review.

| Finding | Repository disposition | Remaining external gate |
| --- | --- | --- |
| TS-C01 | Risk, price, inventory, cap, fee, attestation policy, and local actual-gate monitor halt implemented | Live pinned BIT state, independent executable-price inputs, continuous monitor/alerts, review |
| TS-C02 | Both beneficiary-bound escrows implemented | Independent review |
| TS-C03 | Ordered-deadline derivation and exact boundaries implemented | Bitcoin regtest, Ethereum fork, congestion/restart/force-close drills |
| TS-C04 | Multi-solver signed received-set selection implemented | None; global-best availability is explicitly not claimed |
| TS-H01 | Chain/contract/version/direction/nonce replay protection and ERC-1271 implemented | EOA-only SIWE remains an explicit account limitation |
| TS-H02 | Dual-signed user exercise plus local atomic admission, capability expiry, authenticated endpoint response, capacity, and last-look accounting implemented | Deployed shared enforcement/readers, live reliability telemetry, objective bond decision |
| TS-H03 | Closed expiring gate, token runtime checks, local guardian-halt monitor, and finalized closed-deployment observer implemented | Live continuous proxy monitor, independently observed hashes, deployed multisigs, public-testnet campaign |
| TS-H04 | Integer units, rounding, overflow, dust, and conservation implemented | None |
| TS-H05 | BIT-only signed capped fee accounting implemented | Pin deployed collector and caps |
| TS-H06 | Public pool/shares/yield/rewards/partial fills disabled | Live solver reconciliation and failure drills |
| TS-H07 | Least-privilege isolated regtest adapters, signed actions, solver-node possession proof, durable replay and chain-progress state, stateless fail-closed initialization, production-duration timing, credential and real TLS rotation/rollback, lost-response coordinator recovery, and secret-free audit implemented | Deployed isolation/monitoring, independent review |
| TS-H08 | Full-fill invoice policy and sealed shared hash registry implemented | Live LND decoding and regtest integration |
| TS-H09 | Finality authorization, dispatch-time revalidation, exact EVM claim outbox, mandatory two-provider read-only agreement, and local finality/reorg/replacement/rotation campaigns implemented | Pinned BIT-fork and public-testnet repetition through independent providers |
| TS-M01 | Maker rewards excluded from v1 | None |
| TS-M02 | Fill/reward incentives excluded from v1 | None |
| TS-M03 | RFQ quotas, cancellation, work bounds, and local atomic capacity admission implemented | Deployed distributed enforcement |
| TS-M04 | Signed routing cap, short-lived three-key solver binding, authenticated endpoint challenge/response, and fresh independently observed directional capacity boundary implemented | Deployed endpoint/readers, reconciliation, and routing telemetry |
| TS-M05 | Preimage relays cannot redirect either payout | Independent review |
| TS-M06 | Full BOLT 11 field and invoice-digest validation implemented | Isolated live decoder integration |
| TS-M07 | Canonical identifiers, text-only rendering, safe logs, and response headers implemented | Production header/log verification |
| TS-M08 | Blind pricing, selected-solver disclosure, redaction, and deletion policy implemented | Storage-layer deletion evidence |
| TS-M09 | Immutable escrows, constrained gate, sealed registry, strict deployment policy, finalized topology observer, and local actual-gate alert ordering implemented | Deployed role-separated multisigs, independent providers/review, continuous event monitoring, and external alert delivery |
| TS-M10 | Strict EOA SIWE and short rotated sessions implemented | Durable atomic production account storage, or disable accounts |
| TS-M11 | Email delivery hard-disabled; pending data expires in 24 hours | None for swaps; a new reviewed release is required to send mail |
| TS-M12 | Frozen one-shot wallet dispatch and unknown-outcome handling implemented | Trusted wallet confirmation remains the user security boundary |

The authoritative phase gates are in [Launch checklist](./LAUNCH_CHECKLIST.md). Today only the public-prototype phase passes.

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

Implemented now: the vault enforces an immutable reference-price band, maximum BIT per swap, maximum BIT per solver epoch, and maximum fee. The fail-closed policy in `lib/risk-policy.mjs` additionally requires a fresh ERC-1967 implementation and code-hash match, an unpaused 18-decimal token, healthy Ethereum finality, three independent fresh executable price sources, a bounded source spread, a market/reference band, per-direction inventory reserves, and scarcity fees. The bounded monitor requires digest-only health across eight domains, closes quotes, submits the alert digest through an actual guardian-gate halt, and emits only fixed secret-free reason codes afterward. `docs/RISK_POLICY.md` and `docs/MONITORING.md` define halt and recovery behavior. These controls are executable and tested, but production quotes remain disabled until live inputs, pinned values, continuous redundant collectors, external alerts, deployed multisigs, and the recovery process are independently reviewed.

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
**Status:** Direction-correct multi-solver signed validation and deterministic received-set selection implemented; global availability is explicitly not claimed

An offchain relay can hide a better quote, delay one solver, or fabricate receipt order. The escrow can enforce the exact selected quote but cannot prove that it was globally best.

Safeguards:

- have users sign the exact selected quote and enforce its output and fee caps onchain;
- have the client request quotes from multiple independent solvers or relays;
- show “best received quote,” never “global best price”;
- let the user choose the signed quote rather than letting the relay select it;
- bind the selected quote's exact output, fee, recipient, hash, and expiry;
- require one unchanged user invoice across BIT → Lightning offers, but a distinct solver-owned hold invoice for every Lightning → BIT offer;
- keep public order-book rewards outside v1.

The escrows verify direction-specific accepted terms onchain. `lib/rfq.mjs` now verifies the solver's complete EIP-712 offer before selection, accepts a bounded response set, retains one best offer per independent solver, orders exact-output offers by input price and receipt time, commits the verified received set, and requires the user to select one exact offer. Every fallback solver requires fresh user authorization. `docs/RFQ_POLICY.md` defines the claim boundary: this proves the selected terms and reproduces the client's received set, but it cannot prove that an untrusted relay delivered every quote available elsewhere. The product therefore says “Best received quote,” requires multiple solver identities, and makes no global-best claim.

## High-severity findings

### TS-H01 — Replay across contracts, chains, or versions

**Status:** Implemented in both direction-specific escrows; account-login SIWE remains EOA-only by design

EIP-712 itself does not supply a nonce policy. A signature can be replayed unless the domain and message bind `chainId`, verifying escrow contract, protocol version, maker nonce, direction, amounts, recipient, payment hash, and expiry. The contract must cancel or consume each nonce exactly once.

Both escrows bind chain, verifying contract, protocol version, direction-specific type, participants, amount, fee, invoice digest, payment hash, nonce, and deadlines. User and solver nonces and payment hashes are consumed once. Canonical low-s EOA signatures and ERC-1271 contract signatures are supported through a shared static signature checker; malformed return data, a wrong magic value, a revert, or the wrong owner fails closed. The account-login SIWE surface remains EOA-only and does not advertise contract-wallet login.

### TS-H02 — Reservation griefing and solver last-look

**Status:** Dual-signed user-exercised BIT reservations and local atomic persistent admission controls implemented; deployed shared enforcement and live reliability telemetry remain deployment gates

An attacker can request many quotes, while a solver can advertise attractive liquidity, wait for market movement, and abandon only losing fills.

V1 has no public order reservation. `TreeSwapBitVault` now requires the user and solver to sign the same exact quote. The solver pre-funds its segregated BIT balance, only the named user may exercise the quote, and one active reservation is permitted per user until claim or refund. The solver therefore cannot apply last-look after releasing its signature. `lib/admission-policy.mjs` separates non-reserving RFQs from firm quotes; it enforces authenticated per-identity concurrency and rolling quotas, minimum size, cancellation sequences, short expiries, admitted solvers, fresh capacity epochs, bounded firm commitments, capability expiry, and measured fill reliability. Schema v4 persists those controls under `BEGIN IMMEDIATE`: only opaque identity commitments are retained, cancellation sequences never decrease, capacity epochs never go backward, a firm quote cannot outlive its capability, legacy v3 capabilities migrate expired, conflicts latch new quotes closed, and fills atomically release competing commitments. Two independently opened local connections cannot exceed identity or solver limits. Repeated solver-attributable failures suspend the solver, while user expiry or abandonment does not. BIT → Lightning remains a refundable liveness risk because Ethereum cannot force a Lightning payment. Bonds are deferred until a non-subjective failure adjudicator and operating data exist. The local endpoint transport now proves a fresh bound endpoint response and refuses replay, mutation, timeout, redirect, and SSRF targets; deployment, shared persistence, capacity reconciliation, and live reliability telemetry remain required.

### TS-H03 — BIT proxy upgrade or pause

**Status:** Fail-closed, time-bounded onchain open gate, runtime token checks, pinned mainnet-fork and live-BIT reorg campaigns, and a finalized local closed-deployment observer implemented; live monitor, reviewed manifest, production multisig roles, and public-testnet evidence remain deployment gates

BIT is an ERC-1967 proxy and its current implementation is pausable and upgradeable. The recorded v1 pause blocks mint and redeem but not ordinary ERC-20 transfers. An implementation change could alter transfers, decimals, pause behavior, or trust assumptions.

The risk monitor pins the ERC-1967 implementation slot, proxy and implementation code hashes, decimals, pause state, finality, and executable-price inputs. `buildBitRiskAttestation` commits the exact healthy snapshot. The immutable `TreeSwapOpenGate` deploys closed, requires a delayed controller action to open, expires automatically, and lets a separate guardian halt immediately. Both escrows require that live gate and independently fail closed unless `decimals() == 18` and `paused() == false` at the opening transition. Exact sender and recipient balance deltas are enforced on token movement. The gate is never consulted by withdrawal, claim, or refund, so it cannot trap existing positions. A mainnet fork proves exits remain transferable under the recorded v1 pause; a clean-published Anvil fork of the same pinned live BIT state proves pre-authorization, post-authorization, and post-claim block replacement fails closed in both directions. The local hostile-token suite separately proves state rolls back if a future implementation blocks transfers. Production still requires live pinned values, continuous monitoring, multisig-controlled roles, alerting, and independent review before funding.

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

**Status:** Exact RPC manifests, expiring credential/TLS isolation, overlap credential rotation and live old-root revocation, real TLS certificate/pin rotation with rollback, hold-invoice terminal faults, accepted-state restart, live fee/amount/in-flight caps, channel-offline recovery, signed intent-bound authorization, durable replay and chain-progress state, stateless fail-closed initialization, production-duration timing, payer- and invoice-side coordinator lost-response recovery, and secret-free audits pass isolated regtest; deployed isolation, monitoring, and independent review remain deployment gates

An adapter that can create, settle, cancel, and inspect every invoice is a hot-wallet control plane. A broad LND admin macaroon can also affect the node beyond TreeSwap.

`lib/lightning-adapter-policy.mjs` defines separate exact-URI invoice, payer, and observer roles. It rejects broad or cross-role RPCs, browser-exposed/default/stale/revoked credentials, TLS or private-network failures, node-health and capacity-epoch changes, replayed request IDs or exposure hashes, mutated intent/hash/invoice/amount fields, insufficient directional liquidity, and per-payment/daily/in-flight cap breaches. Hold-invoice settlement also proves `sha256(preimage) == paymentHash`. Macaroons are injected only inside isolated read-only processes and are never accepted from an application request; audits contain no macaroon, preimage, or invoice text. Dynamic REST path data is redacted, stream error envelopes cannot masquerade as payment results, read-only failures remain safe to retry and non-ambiguous, and only uncertain value-moving outcomes remain ambiguous. A coordinator Ed25519 signature prevents the application from forging both the request and its matching intent. A separate exact-schema, mode-`0600` chain-progress record persists the last higher block height, best-block hash, header timestamp, and local advance time with file-and-directory sync. Fresh, deleted, or legacy hashless state rejects new exposure; restart cannot reset the clock; and a backward clock observation, height regression, same-height hash/header change, or impossible higher height with the old hash latches closed until a later height with a new hash. Regtest proves fresh and restarted adapters reject without dispatch, then allows exactly one payment only after a real higher block. The current production-duration campaign proves 3,603 monotonic seconds and 119 continuous observations without a block, with adapter recreation after 1,813 seconds preserving the same clock; the final exact payment rejects specifically for no progress with zero native dispatch. It also proves each baked credential has the exact declared root key, URI set, and expiry caveat; forbidden capability categories fail specifically for authorization; timeout and root-key revocation are enforced live; and the admin node stays healthy. Separate exact-URI `SignMessage` and `VerifyMessage` credentials prove four fresh domain-bound challenges recover the declared solver node, mutation fails, cross-role calls are denied, and both disposable roots are revoked. The old and replacement payer credentials work concurrently, old-root revocation deterministically disables only the old adapter, and the replacement remains available through baseline recovery. Separately, rotating the actual LND certificate/key changes the fingerprint without changing node identity or channel point; the old pin fails without payment dispatch, explicit peer reconnect restores channel liveness, the new pin restores adapter service, and a failure path can restore the previous pair. Wrong and late preimages cannot settle, cancellation is terminal, an accepted hold survives the invoice node restarting, exact payment and signed-action replay isolation hold, deliberately lost payer and invoice-settlement responses recover through fresh read-only requests with dispatch count one, both exposure directions stop before dispatch when the relevant live channel side is exhausted and recover only after rebalancing, and payer/invoice daily caps survive process restart. Exact UTC rollover drops only prior-day value; permanent request and payment-hash replay protection remains. The invoice recovery lookup contains no preimage, and SQLite, WAL, and shared-memory scans find none. [`LIGHTNING_ADAPTER.md`](LIGHTNING_ADAPTER.md) and [`COORDINATOR.md`](COORDINATOR.md) specify the remaining gates.

For BIT → Lightning, a successful signed tracking lookup now returns the exact hash-bound preimage only to the in-memory coordinator caller, including after a later coordinator restart. Missing or mismatched preimages fail closed, while non-success states expose none. The live lost-response campaign proves the invoice and both raw/textual preimage forms are absent from SQLite, WAL, and shared memory. A signed one-use private-packet protocol and bounded daemon executor now enforce exact action/deadline rehydration, module-private verification provenance, restart/reconciliation priority, direction-specific payment/claim order, independent finality authorization, one-shot dispatch, and both-assets terminal verification without persisting the invoice or preimage. Public or credential-bearing provider origins are forbidden. Full unattended execution remains disabled until the private provider has reviewed encrypted network identity, the finality authorizers and asset verifier are independently deployed, and the complete deployed path passes multi-operator fault evidence.

### TS-H08 — Partial-fill hash reuse

**Status:** Full-fill-only invoice policy, sealed cross-direction onchain payment-hash registry, and exact live LND regtest decode implemented; standard-invoice and failure campaigns remain deployment gates

A Lightning invoice is not a divisible onchain order. TreeSwap v1 now rejects partial and child intents rather than attempting to divide one invoice. `validateFullFillInvoice` accepts one exact, amount-bearing mainnet BOLT 11 invoice and rejects AMP, keysend, amountless invoices, BOLT 12, unsupported required features, duplicate singleton tags, and mismatched invoice kind. Basic MPP is allowed only as internal delivery of the single exact invoice total, never as separate TreeSwap fills. `TreeSwapPaymentHashRegistry` is configured with exactly the two reviewed direction contracts and irreversibly sealed; opening either direction consumes the hash globally, so the opposite escrow cannot reuse it. [`INVOICE_POLICY.md`](INVOICE_POLICY.md) defines the boundary. Live LND decoding and regtest integration remain required.

### TS-H09 — Reorg and payment authorization

**Status:** Canonical/finalized escrow gate, one-shot Lightning revalidation, live rapid-block 24-block cutoff, exact EVM claim outbox, two-provider read-only agreement, and local plus pinned live-BIT fork reorg/replacement campaigns implemented; public-testnet campaigns through independent providers remain deployment gates

Paying Lightning before the BIT escrow is sufficiently final can leave the payer with a preimage but no durable escrow. `authorizeLightningAction` distinguishes an observed escrow from a matching canonical and finalized escrow, requires confirmation/finality thresholds, healthy finality lag, the exact intent digest, open risk gate, reconciled balances, and healthy synced adapter. Authorization then becomes a short-lived one-shot action bound to the escrow block and hash. Immediately before the LND RPC, dispatch re-reads canonicality, finality, intent, and service state; a post-authorization reorg, finality regression, state change, replay, or exact expiry rejects. The live rapid-block campaign advances an accepted HTLC to a 24-block reserve and proves the adapter rejects the correct preimage there; this is six blocks before pinned LND's observed auto-cancel boundary. The EVM claim runner separately binds one signed transaction hash before broadcast, treats every broadcast result as unknown, and accepts only byte-identical rebroadcasts. Its unattended path reads the exact transaction, canonical receipt, code, event, and finalized state from two provider origins before applying one durable observation; outage or disagreement leaves the action unknown. Local Anvil campaigns prove finalization, replacement/nonce contention, disagreement without mutation, relayer rotation, and a disappeared inclusion that produces a reorg halt. All six escrow block-replacement boundaries also pass on an Anvil fork of the pinned live BIT proxy with zero post-reorg dispatch and one canonical recovery payout. The agreeing origins and fork still use local execution infrastructure, so genuine public-testnet finality and the complete campaign through independently operated providers remain required before funding. See [EVM claim-outbox evidence](./EVM_OUTBOX_EVIDENCE.md) and [controlled EVM reorg evidence](./EVM_REORG_EVIDENCE.md).

## Medium-severity findings

### TS-M01 — One-tick reward sniping (not applicable to v1)

**Status:** Resolved by exclusion from the immutable v1 capability set

`V1_CAPABILITIES` disables the public order book and maker rewards, and the product exposes neither an order-resting nor reward-claim path. The capability test fails if those flags are enabled. If rewards are ever proposed, require a new protocol version and review with a minimum meaningful tick, minimum top duration, time-weighted accrual, executable quantity, and delayed challengeable settlement; it cannot be added as configuration to v1.

### TS-M02 — Wash fills and sybil rewards (not applicable to v1)

**Status:** Resolved by exclusion from the immutable v1 capability set

V1 issues no reward token, points, rebates, maker emissions, or volume incentives, and `V1_CAPABILITIES.makerRewards` is test-locked to false. A wash fill therefore has no TreeSwap reward to extract and still bears fees and execution cost. Any later incentive system requires a new protocol version plus a separate economic/sybil review and must never emit claimable value greater than independently paid fees.

### TS-M03 — Quote flooding and cancellation churn

**Status:** Bounded admission, nonce/cancellation sequencing, rolling quotas, minimum size, and local atomic solver capacity limits implemented; deployed distributed enforcement remains a deployment gate

`assessRfqAdmission` requires an authenticated request identity, a nonce above its cancellation sequence, minimum quantity, short expiry, per-key active-request limit, rolling request quota, and cancellation quota. `buildReceivedQuoteBook` rejects an envelope set above the hard maximum before signature verification and retains only one best offer per solver. Firm offers additionally require a verified unexpired solver capability, fresh capacity epoch, uncommitted capacity, active-offer limit, and reliability floor; the quote cannot outlive the capability. The coordinator now stores exact rolling events, request lifecycles, cancellation sequences, capability expiries, capacity snapshots, commitments, and reliability outcomes atomically; restart, local multi-connection races, backward time, conflicting epochs, early expiry, fail-closed legacy migration, and raw-identity persistence are adversarially tested. The pinned runtime also passes verified backup/fresh restore, corruption and unknown-schema refusal, SIGKILL/WAL recovery, version migration, actual bounded-filesystem exhaustion without partial state, authenticated solver response faults, and capacity-reader faults. Bonds remain deliberately disabled until objective failure adjudication exists. Production must deploy the capability endpoint and reader protocols with independent operators plus the solver daemon, deploy the reviewed shared persistence service, and test deployed-volume recovery plus real multi-instance races; the local SQLite, transport, and reader proofs are not distributed deployment evidence.

### TS-M04 — Hidden routing and stale capacity

**Status:** Signed routing cap, exact output, three-key short-lived capability binding, authenticated endpoint challenge/response, fresh independently observed capacity boundary, atomic commitment accounting, reliability suspension, and fresh-authorized fallback implemented; deployed endpoint/readers and routing telemetry remain deployment gates

Every solver offer binds the exact Lightning output, `maxRoutingFeeSats`, short expiry, and signed capacity epoch. Offers above the user's routing cap or from a stale epoch are rejected. `verifySolverCapability` binds the EVM solver, direction-specific escrow domain, recovered LND node, HTTPS origin, Ed25519 endpoint key, exact capacities, monotonic epoch, and expiry. It accepts no caller-supplied verification flag and refuses signed self-report unless independently read BIT inventory and Lightning capacity are fresh, belong to the bound identities, and cover the declaration. `queryVerifiedSolverCapability` adds a fresh random request challenge, exact response echo, Ed25519 response authentication, short authority windows, canonical public HTTPS, DNS/IP pinning with TLS hostname preservation, no redirects, hard timeout, and bounded response parsing before admission. The BIT reader compares canonical finalized vault state across two independently labeled/function-distinct providers, pins exact runtime/proxy/implementation hashes and vault accounting, and applies a reserve. The Lightning protocol binds a separate observer signature to the request, capability, direction, node, epoch, reserve, budget, and aggregate active-channel/in-flight state without returning channel identifiers. The latter authenticates a private-state observer but is not a publicly verifiable balance proof. The admission policy persists the capability expiry, subtracts active commitments from fresh capacity before releasing a firm signature, bounds active firm quotes, and suspends repeated solver-attributable failures. The UI calls the result a quote—not guaranteed channel capacity—and `fallbackAuthorization` rejects a different solver/offer until the user authorizes the new exact terms. Production must still deploy the endpoint and readers with independent operators, reconcile channels and in-flight HTLCs continuously, and measure routing failures across independent testnet solvers before funding. [Solver endpoint protocol](./SOLVER_ENDPOINT.md) records this trust boundary.

### TS-M05 — Mempool preimage disclosure

**Status:** Resolved by immutable beneficiary binding in both escrow directions

Anyone, including an unrelated mempool bot, may relay a valid preimage, but both escrow directions transfer only to the beneficiary fixed in the signed quote before Lightning authorization. Tests claim from an attacker address and prove that it receives zero while the bound beneficiary receives the exact payout. The beneficiary cannot be mutated after signing, and the shared registry prevents reuse in the other direction. Private transaction submission may improve inclusion reliability but is neither trusted nor required for theft resistance.

### TS-M06 — Invoice substitution and malformed invoice data

**Status:** Full decoded BOLT 11 field validation and exact invoice-digest binding implemented; live LND decoder integration remains a deployment gate

`validateFullFillInvoice` requires a successful BOLT 11 checksum/signature decode and validates the exact mainnet network, invoice digest, payment hash, whole-satoshi amount, payee, nonzero payment secret, expiry, final CLTV, required features, route-hint bound, singleton tags, and direction-specific hold/standard kind. Amountless, ambiguous, mutated, duplicate-tag, stale, and unsupported invoices fail closed. Both EIP-712 quote shapes bind `invoiceDigest` and `paymentHash`, and the isolated Lightning adapter rechecks those fields with LND before an RPC. The exact hold-invoice path passes regtest; the standard-invoice and malformed-live-input matrix remains required.

### TS-M07 — Data and UI injection

**Status:** Resolved with canonical signed identifiers, bounded text-only displays, structured logs, and browser response controls

Invoice descriptions, solver names, token metadata, and memos are untrusted strings. Escape them in every interface and log, cap length, avoid rendering arbitrary markup, and never treat invoice text as instructions.

Signed relay identifiers now fail unless their original bytes are already canonical; they are never rewritten into a possibly colliding identity. Display-only labels are Unicode-normalized, stripped of invisible and bidirectional controls, forced onto one line, and length-capped. React renders dynamic values as text, audit helpers emit one bounded JSON record, and no invoice text is passed to an instruction or authorization path. CSP, anti-framing, no-sniff, referrer, cross-origin, and browser-permission headers are defined for both Next.js/Vercel and the static worker output. Adversarial tests cover markup, Unicode controls, oversized values, canonicalization collisions, and log-line forgery. See [Untrusted text boundary](./INPUT_HANDLING.md).

### TS-M08 — Privacy leakage

**Status:** Two-stage minimum-disclosure policy implemented; production storage deletion remains a deployment gate

A public intent can expose payment hashes, amounts, timing, Ethereum addresses, and Lightning route hints. Publish the minimum needed to price an intent; reveal the full invoice only to the reserved taker, minimize retention, and document the cross-network linkage created by settlement.

Quote discovery now has an explicit blind projection: an unlinkable pricing identifier, direction, exact output and unit, chain, caps, capacity epoch, and short expiry. It rejects wallet addresses, payment hashes, invoice digests, invoices, payees, route hints, signatures, and email anywhere in the public object. Only the chosen solver may receive the private settlement packet, and only through an authenticated, encrypted channel bound to that solver. Audit projection redacts cross-network identifiers and executable retention deadlines cover pricing data, unselected quotes, private packets, pending email, and minimal receipts. The exact amount is necessarily disclosed for executable pricing, and final settlement remains linkable; the product makes no anonymity claim. See [Privacy boundary](./PRIVACY.md). A production database must enforce and evidence deletion before live swaps open.

### TS-M09 — Governance capture

**Status:** Resolved in contract architecture, strict deployment policy, and a finalized local closed-deployment rehearsal; live multisig deployment, independent review, and monitoring remain launch gates

An admin that can instantly change fees, upgrade escrow, redirect a treasury, or pause exits can steal or trap value. Prefer an immutable escrow; otherwise use a multisig, timelock, public change events, hard fee caps, and a pause that blocks only new opens/reservations.

Both escrows are immutable, non-upgradeable, have constructor-fixed fee collectors and limits, and expose no administrator. The shared registry becomes irreversibly sealed to exactly two escrows. The open gate rejects EOAs, a shared controller/guardian, reopen delays under 24 hours, and open windows over seven days. Its public events and automatic expiry cover every state transition, while halt affects new exposure only. A deployment manifest fails closed unless policy-matched source/review/code digests, exact unique owner lists, quorum separation, 2-of-3-or-stronger contract wallets, registry seal, immutable escrow topology, BIT configuration, reference/price limits, and fee caps all match. The finalized RPC observer reconstructs those facts instead of trusting declarations; its local rehearsal deliberately fails production policy and carries no funds. See [Governance and deployment boundary](./GOVERNANCE.md). Live wallets, signers, independent providers, monitoring, and review evidence do not yet exist.

### TS-M10 — SIWE replay, phishing, or session theft

**Status:** Resolved for EOA account metadata; durable production storage remains a deployment gate

A generic wallet signature, reusable nonce, mismatched domain, or readable session token can let an attacker impersonate a wallet account. The current account surface cannot move funds, but notification data and any later private swap history still require protection.

TreeSwap uses the EIP-4361 plaintext format with an exact no-transaction statement. The server generates a random 128-bit nonce, binds it to an allowlisted HTTPS origin, exact domain and URI, Ethereum mainnet, issue time, and exact ten-minute expiry, and atomically consumes it once. Optional resources and mutable scope fields fail closed. The client rechecks address and chain after signing. A random 256-bit session is stored only by hash, replaces prior wallet sessions, and expires in 24 hours. Its cookie is `HttpOnly`, `Secure`, `SameSite=Strict`, host-only via the `__Host-` prefix, and scoped to `/`; account mutations require the exact origin and all auth responses disable caching. Contract-wallet SIWE remains disabled until chain-aware EIP-1271 verification and session invalidation are available. See [Authentication boundary](./AUTHENTICATION.md).

### TS-M11 — Email correlation, spoofing, and unwanted delivery

**Status:** Risk contained by hard-disabled delivery, immediate detach, and 24-hour pending retention; verified delivery is excluded from this release

Attaching email creates a durable correlation between an Ethereum address and an offchain identity. Accepting an unverified address can also send unwanted messages to a third party.

Email is optional, omitted from SIWE and swap intents, stored separately, and immediately detachable. Invoice and receipt consent are independent. Every new or changed address returns to `pending`, receives an exact 24-hour deletion deadline, and is purged before account data is returned after expiry. There is no mail provider or send path, and the policy hard-denies delivery even if a caller presents nominal future controls. A reviewed code change must add and jointly enforce ownership verification, unsubscribe, per-wallet and per-address rate limits, minimal retention, access auditing, and authenticated sending before delivery can exist. Email is not a dependency for swaps or direct sends. See [Optional email boundary](./EMAIL.md).

### TS-M12 — Direct-send substitution or confused authorization

**Status:** Resolved as a wallet-delegated boundary with one-shot frozen dispatch and unknown-outcome protection

A clipboard attacker, injected provider, stale tab, or last-second account/network change can substitute a BIT recipient or Lightning invoice. A user may also mistake a harmless SIWE login signature for payment authorization, or assume a direct payment has bridge escrow and refund protection.

The direct-send client keeps authentication and payment authorization separate, freezes canonical destination and amount data in a dedicated real-funds review, and requires a second wallet action. BIT sends bind chain, expected contract, runtime-code hash, sender, recipient, and integer amount; recheck code, account, chain, token settings, pause, and balance; simulate and estimate the exact `transfer`; and reject a returned transaction unless its hash, sender, target, calldata, and zero-ETH value match. Only a successful receipt for the same hash becomes confirmed. Lightning sends accept only amount-bearing mainnet invoices with whole-satoshi amounts and pass the exact frozen invoice to the wallet; opening a wallet is never payment, and a WebLN result is explicitly only the wallet's report. Both paths have a one-shot dispatch guard. Any ambiguous error after dispatch becomes “status unknown” with a check-before-retry warning, preventing an automatic duplicate. The UI states that direct sends are irreversible and have no solver, bridge fee, escrow, or refund protection. Users must still verify the complete destination and amount in a trusted wallet because a web client cannot make a compromised provider safe. See [Direct-send boundary](./DIRECT_SEND.md).

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

- Stateful fuzzing of every escrow transition and signature field. **Complete for both local escrows: six invariants, 256 × 64-call campaigns per property, plus all-field digest tests.**
- Claim/refund transactions in the same block and around every timeout boundary. **Deterministic and contract boundary harness complete.**
- Preimage copied from the mempool by an unrelated account. **Complete: unrelated relayers receive no BIT in either direction.**
- Ethereum reorg after escrow creation and after claim. **Authorization rejects an orphaned escrow; fork fault injection remains.**
- Bitcoin block delay, LND restart, held HTLC timeout, and force-close. **Policy harness complete; regtest fault injection remains.**
- Replayed intent on another chain, escrow address, protocol version, and nonce. **Complete in local contract tests.**
- Replayed or mutated SIWE domain, URI, nonce, chain, issued time, and expiry. **Complete in the EOA policy harness.**
- Cross-origin session mutation, expired session use, and notification access from a different wallet. **Complete in policy tests; durable store integration remains a deployment gate.**
- Unverified-email delivery, preference bypass, unsubscribe failure, and wallet/email deletion. **Delivery is hard-disabled; authorization and 24-hour deletion policy tests complete.**
- BIT recipient or amount mutation between review and submission, account/network changes, paused or upgraded token behavior, failed transfer simulation, malformed invoices, WebLN rejection, and `lightning:` fallback falsely reported as paid. **Client policy and rendered-boundary tests complete; a compromised wallet remains outside the web client's trust boundary.**
- BIT pause and implementation upgrade while escrows are open. **Local hostile-token recovery plus pinned mainnet-fork pause, implementation-slot, and exact-delta tests complete; finality fault injection and independent review remain external gates.**
- Fee rounding across dust, maximum values, and thousands of small fills. **Complete.**
- Solver quote spam, cancellation, capacity exhaustion, and deliberate last-look failure. **Repository policy complete; persistent distributed enforcement remains a deployment gate.**
- Relay suppression, quote substitution, and stale fallback selection. **Substitution and fallback tests complete; suppression is disclosed and global-best is not claimed.**
- LP withdrawal while liabilities are reserved or in flight. **Solver-vault stateful invariant complete; live Lightning reconciliation remains a deployment gate.**

The full local campaign report is in [`contracts/test/fuzz/report.md`](../contracts/test/fuzz/report.md).

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
