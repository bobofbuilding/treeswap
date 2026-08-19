# Direct-send boundary

Status: wallet-delegated BIT and Lightning sends are hardened, but remain ordinary irreversible wallet payments rather than bridge settlements.

BIT review freezes Ethereum mainnet, the exact BIT address and runtime-code hash, sender, recipient, and integer amount into a digest. Immediately before submission the client reloads code, symbol, decimals, pause state, balance, chain, and account; simulates the exact transfer; and estimates gas. It sends no ETH and never requests approval. A wallet response is displayed only if its hash, target, sender, calldata, and value match the frozen transfer. Confirmation requires a successful receipt for that exact hash.

Lightning review freezes one amount-bearing mainnet BOLT 11 invoice. A second user action passes that exact invoice to WebLN or opens a `lightning:` link. The UI never treats opening a wallet as payment. A WebLN result is reported only as the wallet's report, its preimage is discarded, and the user is told to verify wallet history.

Both dispatch paths use an in-memory one-shot guard. If the provider errors after a submission or payment request may have left the page, TreeSwap reports the status as unknown and instructs the user to inspect the wallet before retrying. This avoids turning a transport failure into a duplicate payment.

The browser provider is untrusted. These checks catch accidental and many injected changes, but a compromised page or wallet can lie about every read. The wallet's own trusted confirmation must display the expected full destination, amount, chain, token call, or invoice. Direct sends have no solver, TreeSwap fee, escrow, refund, or bridge protection.
