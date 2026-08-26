# TreeSwap

TreeSwap is a product, protocol, and contract prototype for intent-based swaps between Bitcoin Lightning and Bittrees BIT.

The prototype assumes a business par value of **1 BIT = 100 sats**. This value is not enforced by the BIT token contract, so a production TreeSwap deployment must make its pricing rule explicit and protect every intent with a user-signed limit.

## What is included

- Invoice-first preview for paying Lightning invoices with BIT or receiving BIT through a solver invoice
- Competing, short-lived independent-solver quotes
- User-selected signed-quote model with no global best-price promise
- Directional fees, with the BIT → Lightning path priced higher
- Hash-locked settlement walkthrough
- Two-sided solver inventory planner for Lightning and BIT
- EIP-4361 Sign-In with Ethereum using one-time server nonces and opaque sessions
- Secret-free owner-only live D1 authentication qualification in [`docs/LIVE_ACCOUNT_EVIDENCE.md`](docs/LIVE_ACCOUNT_EVIDENCE.md)
- Optional offchain email preferences for invoice notices and transaction receipts
- Non-custodial direct sends: standard BIT transfers on Ethereum mainnet and exact BOLT 11 payments through a Lightning wallet
- Immutable, direction-separated BIT escrow prototypes with signed quotes, beneficiary binding, price and exposure caps, ordered deadlines, and Foundry tests
- Product and protocol specification in [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Liquidity operations plan in [`docs/LIQUIDITY_FUNDING.md`](docs/LIQUIDITY_FUNDING.md)
- Fail-closed market, proxy, finality, and inventory policy in [`docs/RISK_POLICY.md`](docs/RISK_POLICY.md)
- Future BIT/WBTC request-sized TWAP/probe signal used only to help price the primary Lightning ↔ BIT bridge, with a separate pool rollout gate in [`docs/BIT_WBTC_MARKET_REFERENCE.md`](docs/BIT_WBTC_MARKET_REFERENCE.md). The pool is not required for bridge development or closed testnet work and can count as only one independently checked market venue after it exists and matures.
- Secret-free fail-closed monitoring with two-provider finalized gate-state agreement and actual-gate halt evidence in [`docs/MONITORING.md`](docs/MONITORING.md)
- Finalized read-only deployment observation and closed governance rehearsal in [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md)
- Deterministic unsigned Sepolia deployment preparation, a short-lived signed two-provider preflight, and signed finalized receipt reconstruction in [`docs/CLOSED_TESTNET_DEPLOYMENT.md`](docs/CLOSED_TESTNET_DEPLOYMENT.md) and [`docs/CLOSED_TESTNET_DEPLOYMENT_POSTFLIGHT.md`](docs/CLOSED_TESTNET_DEPLOYMENT_POSTFLIGHT.md)
- Provider- and reviewer-signed deployment-manifest promotion in [`docs/DEPLOYMENT_PROMOTION.md`](docs/DEPLOYMENT_PROMOTION.md)
- Deterministic cross-chain clock and payment-authorization policy in [`docs/SETTLEMENT_POLICY.md`](docs/SETTLEMENT_POLICY.md)
- Multi-solver signed RFQ validation, deterministic received-set policy, authenticated multipath delivery, authority-free quote ingress with a lifecycle-bound concrete reader, durable replay/quota control, one-use user-signed selection-to-reservation handoff, and the capability-bound selected-solver client plus durable recovery-aware provider protocol in [`docs/RFQ_POLICY.md`](docs/RFQ_POLICY.md), [`docs/RFQ_DELIVERY.md`](docs/RFQ_DELIVERY.md), [`docs/RFQ_QUOTE_INGRESS.md`](docs/RFQ_QUOTE_INGRESS.md), and [`docs/SELECTED_SOLVER_FINALIZATION.md`](docs/SELECTED_SOLVER_FINALIZATION.md)
- Canonical integer units and BIT-only fee policy in [`docs/UNITS_AND_ROUNDING.md`](docs/UNITS_AND_ROUNDING.md) and [`docs/FEES.md`](docs/FEES.md)
- Adversarial design review and launch gates in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
- Phase-by-phase evidence ledger in [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md)
- Ordered production gates in [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md)
- Permissionless solver target in [`docs/PERMISSIONLESS_AUTOMATION.md`](docs/PERMISSIONLESS_AUTOMATION.md)
- Signed multi-operator public-testnet campaign evidence in [`docs/PUBLIC_TESTNET_EVIDENCE.md`](docs/PUBLIC_TESTNET_EVIDENCE.md)
- Short-lived signed bootstrap-operator roster with derived counts and exact deployment-provider matching in [`docs/PUBLIC_TESTNET_BOOTSTRAP_EVIDENCE.md`](docs/PUBLIC_TESTNET_BOOTSTRAP_EVIDENCE.md)
- Five-role signed review evidence with exact finding accounting in [`docs/INDEPENDENT_REVIEW_EVIDENCE.md`](docs/INDEPENDENT_REVIEW_EVIDENCE.md)
- Five-role signed operational-readiness evidence with exact drills, alerts, backup, reconciliation, support, and loss-allocation commitments in [`docs/OPERATIONAL_READINESS_EVIDENCE.md`](docs/OPERATIONAL_READINESS_EVIDENCE.md)
- Exact public adoption policy for fees, caps, solver liveness, privacy, loss allocation, support, and immutable upgrades in [`docs/ADOPTION_POLICY.md`](docs/ADOPTION_POLICY.md)
- Single ordered staffing, deployment, evidence, approval, activation, and campaign handoff for a tiny operator-owned Sepolia adoption in [`docs/ADOPTION_HANDOFF.md`](docs/ADOPTION_HANDOFF.md)
- Three-role signed service-isolation evidence with exact service, trust-domain, ingress, transport, and credential-scope commitments in [`docs/SERVICE_ISOLATION_EVIDENCE.md`](docs/SERVICE_ISOLATION_EVIDENCE.md)
- Evidence-derived tiny-bootstrap and campaign-qualified release preparation in [`docs/PUBLIC_TESTNET_RELEASE_CANDIDATES.md`](docs/PUBLIC_TESTNET_RELEASE_CANDIDATES.md)
- Guarded five-role payload and live contract-wallet approval verification in [`docs/PUBLIC_TESTNET_RELEASE_APPROVALS.md`](docs/PUBLIC_TESTNET_RELEASE_APPROVALS.md)
- Same-process approval, reconciliation, live-provider, and runtime activation in [`docs/PUBLIC_TESTNET_RELEASE_ACTIVATION.md`](docs/PUBLIC_TESTNET_RELEASE_ACTIVATION.md)
- Private old-release custody, restored-host readiness, witnessed old/new recovery drills, and fail-closed rotation decisions in [`docs/RETAINED_RELEASE_CUSTODY.md`](docs/RETAINED_RELEASE_CUSTODY.md)
- Reviewed one-use recovery operator composition with recovery-only evidence controls in [`docs/RECOVERY_OPERATOR_ENTRYPOINT.md`](docs/RECOVERY_OPERATOR_ENTRYPOINT.md)
- Immutable public-testnet operator campaign snapshots via `npm run manage:testnet-campaign`
- Authenticated solver request/response boundary in [`docs/SOLVER_ENDPOINT.md`](docs/SOLVER_ENDPOINT.md)
- Concrete two-route active-daemon evidence client with fixed operator HTTPS transport and provider replay boundary in [`docs/SOLVER_DAEMON_EVIDENCE_CLIENT.md`](docs/SOLVER_DAEMON_EVIDENCE_CLIENT.md)
- Fail-closed provider handler, strict durable replay and clock-rollback ledger, and loss/rotation runbook in [`docs/DURABLE_EVIDENCE_PROVIDER.md`](docs/DURABLE_EVIDENCE_PROVIDER.md)
- Optional Lightning account linking in [`docs/LIGHTNING_ACCOUNTS.md`](docs/LIGHTNING_ACCOUNTS.md)
- Immutable version transitions in [`docs/UPGRADES.md`](docs/UPGRADES.md)
- Pinned two-node Lightning lab in [`docs/LIGHTNING_REGTEST.md`](docs/LIGHTNING_REGTEST.md)
- Atomic coordinator, one-dispatch Lightning recovery, revoking release/recovery verification supervisors, fail-closed same-process recovery bootstrap, bounded restart-only action loop, and exact-transaction EVM claim outbox in [`docs/COORDINATOR.md`](docs/COORDINATOR.md)
- Controlled EVM finality, provider-disagreement, nonce-replacement, and relayer-rotation evidence in [`docs/EVM_OUTBOX_EVIDENCE.md`](docs/EVM_OUTBOX_EVIDENCE.md)
- Reproducible BIT source, provider-comparison, and live-token fork evidence in [`docs/BIT_MAINNET_EVIDENCE.md`](docs/BIT_MAINNET_EVIDENCE.md)
- Deterministic static preflight for the short-lived two-provider/two-reviewer ceremony in [`docs/BIT_CEREMONY_PREFLIGHT.md`](docs/BIT_CEREMONY_PREFLIGHT.md)
- Provenance-only reviewed BIT token-deployment manifest derivation in [`docs/BIT_REVIEWED_MANIFEST.md`](docs/BIT_REVIEWED_MANIFEST.md)
- Hermetic clean-published-commit local qualification with secret-free schema-v2 evidence via `npm run qualify:local`; `npm run verify:local-qualification -- --artifact <file>` independently reconstructs a private artifact against the exact current published `main`, and the one-hour Lightning measurements are digest-bound while disposable regtest volumes are destroyed before and after every sealed run
- Exact final-artifact reconstruction and independent reviewer binding via [`docs/QUALIFICATION_REVIEW_EVIDENCE.md`](docs/QUALIFICATION_REVIEW_EVIDENCE.md); candidate v6 rejects opaque qualification digests, copied provenance, and operational evidence that omits the exact monitor upstream-record, safety-policy, or confirmer bindings
- Deterministic two-direction execution-client reorg evidence via `npm run test:escrow-reorg`

The bridge interface remains a swap simulation: it does not lock BIT, pay a swap invoice, create a payable solver invoice, or publish quotes. The separate **Send** tool can move real funds only after a second review and explicit confirmation in the user's wallet. BIT sends call the token's standard `transfer` function directly and never request an allowance. Lightning sends pass an exact, amount-bearing mainnet BOLT 11 invoice to an available WebLN provider, with a `lightning:` wallet link as the fallback. These direct payments bypass TreeSwap solvers, liquidity, fees, and swap protections.

Sign-In with Ethereum is an account login only. Its plaintext signature is never accepted as permission for a BIT transfer or Lightning payment.

Accounts are enabled only when the deployment proves that its durable nonce, session, and notification tables exist. A deployment without that exact storage capability disables sign-in before requesting a wallet signature.

Email preferences are attached to the signed-in wallet account, never included in the SIWE message or an onchain intent, and can be detached at any time. Unverified records become ineligible after 24 hours and are purged when account storage is next accessed; outbound delivery is hard-disabled in this build.

## Security status

This repository is not audited and the bridge is not ready for real funds. The design removes the shared public pool, public order book, and rewards from v1. Immutable escrows, deterministic timeout policy, blind signed-quote selection, authenticated two-relay/two-direct-path collection, atomic dual-resource quote reservation before private disclosure, one-use durable executable-quote binding, private selected-solver finalization, a three-key short-lived solver capability verifier, an authenticated replay-resistant solver endpoint protocol, a dual-provider finalized BIT-vault reader, static two-provider/two-reviewer ceremony preflight, short-lived provider-signed live-BIT comparison, two-role independent-review handoffs, provenance-only reviewed BIT manifest derivation, privacy-minimized signed Lightning-capacity observations, fail-closed risk gates, a pinned BIT mainnet-fork campaign, postflight-bound provider/reviewer-signed deployment promotion and release authorization, five-role signed external-review evidence with zero-open-finding accounting, three-role signed service-isolation evidence, five-role signed operational-readiness v4 evidence with one immutable safety-monitor policy snapshot, its exact upstream record, isolated confirmer assignments, finalized-gate control claims, drills, and artifact reconciliation, deterministic final-release monitor-policy derivation, evidence-derived tiny-bootstrap and campaign-qualified public-testnet releases, guarded five-role approval verification, exact closed-Sepolia plan and preflight workflows, signed finalized creation/Safe receipt reconstruction, isolated invoice/payer LND adapters with live credential, node-possession, and hold-invoice fault evidence, a crash-safe Lightning coordinator, a TLS-only authenticated one-use private-packet protocol with a strict durable provider handler, a two-route one-use solver-evidence client with a strict durable provider replay ledger, a bounded solver executor, an exact-transaction EVM claim outbox, and a secret-free actual-gate halt monitor with two-route guardian delivery, two-route finalized-state agreement, and alert failover now pass locally. No public-testnet deployment has occurred. Production deployment of those readers, evidence routes, packet providers, endpoints, relays, encrypted disclosure, and monitor, independently verified service identities/networks/secret scopes, genuinely independent provider/reviewer/guardian/confirmer/alert evidence, public-testnet finality and chain/channel campaigns, deployed solver daemons and persistence, multisigs, verified live transaction, finality, and alert delivery, incident drills, support/loss review, and actual independent review remain release-blocking. Direct sends are ordinary wallet payments rather than bridge transactions, but they are irreversible and depend on the user's wallet, destination, token contract, and invoice validation.

## Local preview

```bash
npm run dev
```

Then open the local URL printed by the development server.

Run the BIT vault campaign separately:

```bash
forge test
```

Run the pinned live-BIT fork campaign with a secret archive endpoint:

```bash
MAINNET_RPC_URL=<secret> npm run test:fork
MAINNET_RPC_URL=<secret> npm run test:live-bit-reorg
```

## Production work still required

Start with the ordered [TreeSwap adoption handoff](docs/ADOPTION_HANDOFF.md). It keeps the bridge closed while real operators, reviewers, signers, and infrastructure complete the external evidence chain for a tiny operator-owned Sepolia bootstrap.

- Repeat the passing EVM outbox/reorg campaigns on public testnet using two independently operated authenticated providers and genuine finality transitions
- Obtain matching signed observations from two genuinely independent authenticated Ethereum providers, complete the two-role BIT review with retained reports, and derive the short-lived reviewed BIT manifest
- Independently rebuild and review the closed Sepolia plan, deploy its exact transactions through hardware-backed operators, and capture matching finalized v2 TreeSwap manifests proving reconciled zero balances before test inventory
- Deploy the reviewed same-process recovery operator launcher with real retained custody, concrete runtime adapters, persistent storage, and independently operated providers; then qualify its exact restored-database job set through host-restart, backup/restore, safety-monitoring, redundant-guardian, and external-alert drills
- Deploy the persistent activation coordinator with independently operated runtime reconciliation signers; never restore funding authority from serialized activation output
- Deploy the implemented quote reader, reservation service, and public/private ceremony routes behind preserving reviewed HTTPS listeners, connect the retained reservation to the selected-solver packet path, and deploy the solver endpoint, capacity-reader, dual-route daemon-evidence protocols, and independent quote-delivery paths
- Create and mature the BIT/WBTC pool in observation-only mode, then independently review its exact pool/feed/quoter policy and the other executable BIT venues before it can help bound funded quotes
- Bridge-escrow wallet integration with exact intent authorization and explicit approval boundaries
- Keep email delivery disabled; a later mail release requires ownership verification, unsubscribe, rate limits, auditing, and sender authentication
- Independent reconciliation inputs, production proxy monitoring, live incident drills using [`docs/INCIDENT_RUNBOOK.md`](docs/INCIDENT_RUNBOOK.md), and external review
- Testnet deployment before any mainnet liquidity

## Reference asset

- BIT on Ethereum: [`0x57A447E4d5e18A9423408C365963A73F08B9d18C`](https://etherscan.io/token/0x57A447E4d5e18A9423408C365963A73F08B9d18C#code)

## License

MIT
