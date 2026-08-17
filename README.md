# TreeSwap

TreeSwap is a local product and protocol prototype for intent-based swaps between Bitcoin Lightning and Bittrees BIT.

The prototype assumes a business par value of **1 BIT = 100 sats**. This value is not enforced by the BIT token contract, so a production TreeSwap deployment must make its pricing rule explicit and protect every intent with a user-signed limit.

## What is included

- Interactive Lightning → BIT and BIT → Lightning quote builder
- Competing counter-intent and independent-solver offers
- Price-time order book ranked by net executable output
- Directional fees, with the BIT → Lightning path priced higher
- Hash-locked settlement walkthrough
- Either-side liquidity funding simulator
- Product and protocol specification in [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Adversarial design review and launch gates in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)

The interface is a simulation. It does not connect wallets, create Lightning invoices, transfer BIT, or publish orders.

## Security status

This repository is not audited and is not ready for real funds. The review identified four release-blocking design areas: fixed-par inventory drain, beneficiary/preimage binding, cross-network timeout safety, and verifiable quote ordering. See the threat model before implementing the settlement contracts.

## Local preview

```bash
npm run dev
```

Then open the local URL printed by the development server.

## Production work intentionally deferred

- Ethereum escrow contracts and audits
- Lightning hold-invoice coordinator
- Solver daemon and quote transport
- Wallet integrations
- Persistent order book and indexer
- Mainnet liquidity, governance, and rewards
- GitHub and hosting publication

## Reference asset

- BIT on Ethereum: [`0x57A447E4d5e18A9423408C365963A73F08B9d18C`](https://etherscan.io/token/0x57A447E4d5e18A9423408C365963A73F08B9d18C#code)

## License

MIT
