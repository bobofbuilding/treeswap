# Privacy boundary

Status: enforced as a coordinator policy harness. The current prototype has no public intent relay or swap-history database.

TreeSwap uses two stages:

1. An unlinkable pricing request contains only a random pricing identifier, direction, exact output amount and unit, chain, user caps, capacity epoch, and short expiry. It contains no wallet address, payment hash, invoice digest, invoice, payee, route hints, email, or signature.
2. After the user chooses one solver, only that solver receives the private settlement identifier, addresses, hash, invoice digest, and invoice over an authenticated, encrypted, peer-bound channel. The public pricing identifier and private settlement identifier must differ.

The exact amount remains visible to competing solvers because it is necessary to produce an executable price. Final onchain settlement links the recipient, amount, timing, and eventually the Lightning preimage; TreeSwap cannot promise cross-network anonymity. Users should assume a selected solver can correlate both legs.

Raw invoices and private settlement packets are deleted within one hour of a terminal outcome. Unselected quotes and public pricing requests expire within ten minutes. Pending email is deleted within 24 hours and minimal receipts within 30 days unless a shorter legal or user-requested deletion applies. Preimages, macaroons, route hints, and full invoices are excluded from logs. A production coordinator must enforce these deadlines in its storage layer and prove deletion before enabling swaps.
