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
- Immutable, segregated BIT vault prototype with user-signed quotes, beneficiary binding, price and exposure caps, ordered deadlines, and Foundry invariants
- Product and protocol specification in [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Liquidity operations plan in [`docs/LIQUIDITY_FUNDING.md`](docs/LIQUIDITY_FUNDING.md)
- Adversarial design review and launch gates in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)

The interface remains a swap simulation. It can connect an injected Ethereum wallet and request a standard sign-in message, but it does not request token approvals, submit transactions, create payable Lightning invoices, transfer BIT, or publish quotes. The Solidity vault is local and undeployed.

Email preferences are attached to the signed-in wallet account, never included in the SIWE message or an onchain intent, and can be detached at any time. Records remain pending and no email is delivered until an ownership-verification and delivery service is configured.

## Security status

This repository is not audited and is not ready for real funds. The design removes the shared public pool, public order book, and rewards from v1. The current vault limits stale-reference exposure but does not prove a fair market price. Cross-network timeout derivation, BIT proxy behavior, the reverse-direction escrow, and Lightning operations remain release-blocking.

## Local preview

```bash
npm run dev
```

Then open the local URL printed by the development server.

Run the BIT vault campaign separately:

```bash
forge test
```

## Production work still required

- Mainnet-fork testing of BIT upgrades, pauses, and balance behavior
- Complementary user-funded BIT → Lightning escrow with direction-separated signatures
- Lightning hold-invoice coordinator
- Solver daemon and quote transport
- Transaction-capable wallet integration with explicit approval boundaries
- Email ownership verification, delivery provider, unsubscribe handling, and retention policy
- Reconciliation, proxy monitoring, incident controls, and external review
- Testnet deployment before any mainnet liquidity

## Reference asset

- BIT on Ethereum: [`0x57A447E4d5e18A9423408C365963A73F08B9d18C`](https://etherscan.io/token/0x57A447E4d5e18A9423408C365963A73F08B9d18C#code)

## License

MIT
