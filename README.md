# TreeSwap

TreeSwap is a product, protocol, and contract prototype for intent-based swaps between Bitcoin Lightning and Bittrees BIT.

The prototype assumes a business par value of **1 BIT = 100 sats**. This value is not enforced by the BIT token contract, so a production TreeSwap deployment must make its pricing rule explicit and protect every intent with a user-signed limit.

## What is included

- Interactive Lightning → BIT and BIT → Lightning quote builder
- Competing, short-lived independent-solver quotes
- User-selected signed-quote model with no global best-price promise
- Directional fees, with the BIT → Lightning path priced higher
- Hash-locked settlement walkthrough
- Two-sided solver inventory planner for Lightning and BIT
- Immutable, segregated BIT vault prototype with Foundry tests and invariants
- Product and protocol specification in [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Liquidity operations plan in [`docs/LIQUIDITY_FUNDING.md`](docs/LIQUIDITY_FUNDING.md)
- Adversarial design review and launch gates in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)

The interface remains a simulation. It does not connect wallets, create Lightning invoices, transfer BIT, or publish quotes. The Solidity vault is local and undeployed.

## Security status

This repository is not audited and is not ready for real funds. The design removes the shared public pool, public order book, and rewards from v1. Fixed-par inventory drain, cross-network timeout safety, BIT proxy behavior, and Lightning operations remain release-blocking.

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

- EIP-712 selected-quote enforcement and complementary user-funded escrow
- Lightning hold-invoice coordinator
- Solver daemon and quote transport
- Wallet integrations
- Reconciliation, proxy monitoring, incident controls, and external review
- Testnet deployment before any mainnet liquidity

## Reference asset

- BIT on Ethereum: [`0x57A447E4d5e18A9423408C365963A73F08B9d18C`](https://etherscan.io/token/0x57A447E4d5e18A9423408C365963A73F08B9d18C#code)

## License

MIT
