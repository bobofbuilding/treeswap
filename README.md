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
- Optional offchain email preferences for invoice notices and transaction receipts
- Non-custodial direct sends: standard BIT transfers on Ethereum mainnet and exact BOLT 11 payments through a Lightning wallet
- Immutable, direction-separated BIT escrow prototypes with signed quotes, beneficiary binding, price and exposure caps, ordered deadlines, and Foundry tests
- Product and protocol specification in [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Liquidity operations plan in [`docs/LIQUIDITY_FUNDING.md`](docs/LIQUIDITY_FUNDING.md)
- Fail-closed market, proxy, finality, and inventory policy in [`docs/RISK_POLICY.md`](docs/RISK_POLICY.md)
- Deterministic cross-chain clock and payment-authorization policy in [`docs/SETTLEMENT_POLICY.md`](docs/SETTLEMENT_POLICY.md)
- Multi-solver signed RFQ validation and deterministic received-set policy in [`docs/RFQ_POLICY.md`](docs/RFQ_POLICY.md)
- Canonical integer units and BIT-only fee policy in [`docs/UNITS_AND_ROUNDING.md`](docs/UNITS_AND_ROUNDING.md) and [`docs/FEES.md`](docs/FEES.md)
- Adversarial design review and launch gates in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
- Phase-by-phase evidence ledger in [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md)
- Ordered production gates in [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md)
- Permissionless solver target in [`docs/PERMISSIONLESS_AUTOMATION.md`](docs/PERMISSIONLESS_AUTOMATION.md)
- Authenticated solver request/response boundary in [`docs/SOLVER_ENDPOINT.md`](docs/SOLVER_ENDPOINT.md)
- Optional Lightning account linking in [`docs/LIGHTNING_ACCOUNTS.md`](docs/LIGHTNING_ACCOUNTS.md)
- Immutable version transitions in [`docs/UPGRADES.md`](docs/UPGRADES.md)
- Pinned two-node Lightning lab in [`docs/LIGHTNING_REGTEST.md`](docs/LIGHTNING_REGTEST.md)
- Atomic coordinator, one-dispatch Lightning recovery, and exact-transaction EVM claim outbox in [`docs/COORDINATOR.md`](docs/COORDINATOR.md)
- Controlled EVM finality, provider-disagreement, nonce-replacement, and relayer-rotation evidence in [`docs/EVM_OUTBOX_EVIDENCE.md`](docs/EVM_OUTBOX_EVIDENCE.md)
- Reproducible BIT source, provider-comparison, and live-token fork evidence in [`docs/BIT_MAINNET_EVIDENCE.md`](docs/BIT_MAINNET_EVIDENCE.md)
- Clean-published-commit local qualification with secret-free evidence output via `npm run qualify:local`
- Deterministic two-direction execution-client reorg evidence via `npm run test:escrow-reorg`

The bridge interface remains a swap simulation: it does not lock BIT, pay a swap invoice, create a payable solver invoice, or publish quotes. The separate **Send** tool can move real funds only after a second review and explicit confirmation in the user's wallet. BIT sends call the token's standard `transfer` function directly and never request an allowance. Lightning sends pass an exact, amount-bearing mainnet BOLT 11 invoice to an available WebLN provider, with a `lightning:` wallet link as the fallback. These direct payments bypass TreeSwap solvers, liquidity, fees, and swap protections.

Sign-In with Ethereum is an account login only. Its plaintext signature is never accepted as permission for a BIT transfer or Lightning payment.

Email preferences are attached to the signed-in wallet account, never included in the SIWE message or an onchain intent, and can be detached at any time. Unverified records expire after 24 hours and outbound delivery is hard-disabled in this build.

## Security status

This repository is not audited and the bridge is not ready for real funds. The design removes the shared public pool, public order book, and rewards from v1. Immutable escrows, deterministic timeout policy, signed quote selection, a three-key short-lived solver capability verifier, an authenticated replay-resistant solver endpoint protocol, a dual-provider finalized BIT-vault reader, privacy-minimized signed Lightning-capacity observations, fail-closed risk gates, a pinned BIT mainnet-fork campaign, isolated invoice/payer LND adapters with live credential, node-possession, and hold-invoice fault evidence, a crash-safe Lightning coordinator, an authenticated one-use private-packet protocol, a bounded solver executor, and an exact-transaction EVM claim outbox now pass locally. Production deployment of those readers, packet providers, and endpoints, independent-provider/operator evidence, public-testnet finality and chain/channel campaigns, deployed solver daemons and persistence, multisigs, monitoring, and independent review remain release-blocking. Direct sends are ordinary wallet payments rather than bridge transactions, but they are irreversible and depend on the user's wallet, destination, token contract, and invoice validation.

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
```

## Production work still required

- Repeat the passing local EVM outbox/reorg campaigns on the pinned BIT fork and public testnet using two independently operated authenticated providers
- Deploy and qualify the bounded solver daemon, backup/restore drills, and alert delivery
- Deploy the implemented solver endpoint, private-packet, and capacity-reader protocols plus independent quote-delivery paths
- Bridge-escrow wallet integration with exact intent authorization and explicit approval boundaries
- Keep email delivery disabled; a later mail release requires ownership verification, unsubscribe, rate limits, auditing, and sender authentication
- Reconciliation, proxy monitoring, live incident drills using [`docs/INCIDENT_RUNBOOK.md`](docs/INCIDENT_RUNBOOK.md), and external review
- Testnet deployment before any mainnet liquidity

## Reference asset

- BIT on Ethereum: [`0x57A447E4d5e18A9423408C365963A73F08B9d18C`](https://etherscan.io/token/0x57A447E4d5e18A9423408C365963A73F08B9d18C#code)

## License

MIT
