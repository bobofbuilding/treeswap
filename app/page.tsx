"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Direction = "lightning-to-bit" | "bit-to-lightning";
type View = "swap" | "pool";

type Offer = {
  name: string;
  kind: "Solver";
  feeBps: number;
  routeFee: number;
  speed: string;
  color: string;
};

const BIT_CONTRACT = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";
const PAR_SATS = 100;

const offerBook: Record<Direction, Offer[]> = {
  "lightning-to-bit": [
    {
      name: "Rootline",
      kind: "Solver",
      feeBps: 18,
      routeFee: 0,
      speed: "~12 sec",
      color: "mint",
    },
    {
      name: "Arbor Nine",
      kind: "Solver",
      feeBps: 28,
      routeFee: 0,
      speed: "~18 sec",
      color: "orange",
    },
    {
      name: "Canopy Labs",
      kind: "Solver",
      feeBps: 34,
      routeFee: 0,
      speed: "~21 sec",
      color: "violet",
    },
  ],
  "bit-to-lightning": [
    {
      name: "Rootline",
      kind: "Solver",
      feeBps: 72,
      routeFee: 6,
      speed: "~9 sec",
      color: "mint",
    },
    {
      name: "Canopy Labs",
      kind: "Solver",
      feeBps: 85,
      routeFee: 12,
      speed: "~15 sec",
      color: "orange",
    },
    {
      name: "Arbor Nine",
      kind: "Solver",
      feeBps: 97,
      routeFee: 8,
      speed: "~19 sec",
      color: "blue",
    },
  ],
};

const intentSteps = [
  { title: "Swap terms signed", note: "Amounts, fees, recipient, and expiry are fixed" },
  { title: "Selected quote locked", note: "One solver is bound to the terms" },
  { title: "Payment hash matched", note: "Both legs share one secret" },
  { title: "Assets released", note: "Preimage settles the swap" },
];

function numberFormat(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
    Number.isFinite(value) ? Math.max(value, 0) : 0,
  );
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export default function Home() {
  const [view, setView] = useState<View>("swap");
  const [direction, setDirection] = useState<Direction>("lightning-to-bit");
  const [amount, setAmount] = useState("250000");
  const [selectedOffer, setSelectedOffer] = useState(0);
  const [intentOpen, setIntentOpen] = useState(false);
  const [intentPhase, setIntentPhase] = useState(0);
  const [lightningLiquidity, setLightningLiquidity] = useState("5000000");
  const [bitLiquidity, setBitLiquidity] = useState("50000");
  const [poolReceipt, setPoolReceipt] = useState(false);

  const offers = offerBook[direction];
  const inputAmount = Number(amount.replaceAll(",", "")) || 0;
  const activeOffer = offers[selectedOffer] ?? offers[0];
  const inputIsSats = direction === "lightning-to-bit";
  const parOutput = inputIsSats ? inputAmount / PAR_SATS : inputAmount * PAR_SATS;
  const intentFee = (parOutput * activeOffer.feeBps) / 10_000;
  const outputAmount = Math.max(parOutput - intentFee - activeOffer.routeFee, 0);
  const feeLabel = `${(activeOffer.feeBps / 100).toFixed(2)}%`;

  const lightningReserve = Number(lightningLiquidity) || 0;
  const bitReserve = Number(bitLiquidity) || 0;
  const usableLightning = Math.floor(lightningReserve * 0.75);
  const usableBit = bitReserve * 0.75;
  const balancedCapacity = Math.min(usableLightning, usableBit * PAR_SATS);
  const fillCap = Math.floor(balancedCapacity * 0.05);

  const quoteExpiry = "00:24";

  useEffect(() => {
    if (!intentOpen || intentPhase >= intentSteps.length) return;
    const timer = window.setTimeout(() => {
      setIntentPhase((phase) => Math.min(phase + 1, intentSteps.length));
    }, 1050);
    return () => window.clearTimeout(timer);
  }, [intentOpen, intentPhase]);

  function flipDirection() {
    const next =
      direction === "lightning-to-bit"
        ? "bit-to-lightning"
        : "lightning-to-bit";
    const converted =
      direction === "lightning-to-bit"
        ? inputAmount / PAR_SATS
        : inputAmount * PAR_SATS;
    setDirection(next);
    setAmount(String(Math.max(Math.round(converted * 100) / 100, 0)));
    setSelectedOffer(0);
  }

  function beginIntent() {
    setIntentPhase(0);
    setIntentOpen(true);
  }

  return (
    <main>
      <div className="prototype-strip">
        <span>Open prototype</span>
        <span>No wallets connected · No real funds</span>
      </div>

      <nav className="nav-shell" aria-label="Main navigation">
        <Link href="/" className="brand" aria-label="TreeSwap home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <b>ϟ</b>
          </span>
          <span>treeswap</span>
        </Link>
        <div className="nav-links">
          <button
            className={view === "swap" ? "active" : ""}
            onClick={() => setView("swap")}
          >
            Swap
          </button>
          <button
            className={view === "pool" ? "active" : ""}
            onClick={() => setView("pool")}
          >
            Solver liquidity
          </button>
          <a href="#mechanism">How it works</a>
          <a href="https://github.com/bobofbuilding/treeswap" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <a className="network-pill" href="#security"><span /> Safety-first prototype</a>
      </nav>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">BITCOIN LIGHTNING ↔ BIT</p>
          <h1>
            Swap Lightning sats
            <br />
            and <em>BIT.</em>
          </h1>
          <p className="hero-deck">
            Tell TreeSwap what you want to receive. Independent solvers return
            signed quotes, you choose one, and a shared payment secret settles both sides.
          </p>
          <div className="hero-actions">
            <a href="#top" onClick={() => setView("swap")}>Explore a swap</a>
            <a href="#top" className="secondary" onClick={() => setView("pool")}>Plan solver liquidity</a>
          </div>
          <div className="hero-stats" aria-label="Market summary">
            <div>
              <span>Reference value</span>
              <strong>1 BIT = 100 sats</strong>
            </div>
            <div>
              <span>Liquidity</span>
              <strong>Independent solvers</strong>
            </div>
            <div>
              <span>Settlement</span>
              <strong>One payment hash</strong>
            </div>
          </div>
        </div>

        <div className="product-stage">
          <div className="stage-orbit orbit-one" />
          <div className="stage-orbit orbit-two" />

          {view === "swap" ? (
            <section className="swap-card" aria-label="TreeSwap quote builder">
              <div className="card-heading">
                <div>
                  <p>SWAP PREVIEW</p>
                  <h2>Compare solver quotes</h2>
                </div>
                <span className="live-badge"><i /> 3 signed quotes</span>
              </div>

              <div className="amount-panel">
                <label htmlFor="swap-amount">You send</label>
                <div className="amount-row">
                  <input
                    id="swap-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))}
                    aria-label={`Amount in ${inputIsSats ? "sats" : "BIT"}`}
                  />
                  <span className={`asset-chip ${inputIsSats ? "btc" : "bit"}`}>
                    <i>{inputIsSats ? "₿" : "B"}</i>
                    {inputIsSats ? "sats" : "BIT"}
                  </span>
                </div>
                <span className="balance-line">Available · prototype balance</span>
              </div>

              <button
                className="direction-button"
                onClick={flipDirection}
                aria-label="Reverse swap direction"
              >
                ⇅
              </button>

              <div className="amount-panel receive-panel">
                <span>You receive</span>
                <div className="amount-row">
                  <strong>
                    {numberFormat(outputAmount, inputIsSats ? 2 : 0)}
                  </strong>
                  <span className={`asset-chip ${inputIsSats ? "bit" : "btc"}`}>
                    <i>{inputIsSats ? "B" : "₿"}</i>
                    {inputIsSats ? "BIT" : "sats"}
                  </span>
                </div>
                <span className="balance-line">Selected from {offers.length} solver quotes</span>
              </div>

              <div className="auction-head">
                <span>Solver quotes</span>
                <span>Quote expires {quoteExpiry}</span>
              </div>
              <div className="offer-list">
                {offers.map((offer, index) => {
                  const offerBase = inputIsSats
                    ? inputAmount / PAR_SATS
                    : inputAmount * PAR_SATS;
                  const offerOutput = Math.max(
                    offerBase - (offerBase * offer.feeBps) / 10_000 - offer.routeFee,
                    0,
                  );
                  return (
                    <button
                      className={`offer-row ${selectedOffer === index ? "selected" : ""}`}
                      key={offer.name}
                      onClick={() => setSelectedOffer(index)}
                    >
                      <span className={`solver-dot ${offer.color}`} />
                      <span className="offer-name">
                        <strong>{offer.name}</strong>
                        <small>{offer.kind} · {offer.speed}</small>
                      </span>
                      <span className="offer-price">
                        <strong>{numberFormat(offerOutput, inputIsSats ? 2 : 0)}</strong>
                        <small>{(offer.feeBps / 100).toFixed(2)}% fee</small>
                      </span>
                      {index === 0 && <span className="best-tag">LOWEST HERE</span>}
                    </button>
                  );
                })}
              </div>

              <div className="quote-details">
                <div><span>Reference conversion</span><strong>{numberFormat(parOutput, inputIsSats ? 2 : 0)} {inputIsSats ? "BIT" : "sats"}</strong></div>
                <div><span>Intent + solver fee</span><strong>{feeLabel}</strong></div>
                {!inputIsSats && <div><span>Estimated routing</span><strong>{activeOffer.routeFee} sats</strong></div>}
                <div><span>Reference, not a peg</span><strong>100 sats / BIT</strong></div>
              </div>

              <button
                className="primary-action"
                onClick={beginIntent}
                disabled={inputAmount <= 0}
              >
                Preview this swap <span>→</span>
              </button>
              <p className="microcopy">Simulation only. No wallet signature or payment will be requested.</p>
            </section>
          ) : (
            <section className="swap-card pool-card" aria-label="Solver liquidity planner">
              <div className="card-heading">
                <div>
                  <p>SOLVER INVENTORY</p>
                  <h2>Plan both reserves</h2>
                </div>
                <span className="live-badge"><i /> self-custodied</span>
              </div>

              <div className="pool-balance">
                <div>
                  <span>Usable Lightning</span>
                  <strong>{numberFormat(usableLightning)} sats</strong>
                  <small>For BIT → Lightning fills</small>
                </div>
                <div>
                  <span>Usable BIT</span>
                  <strong>{numberFormat(usableBit, 2)} BIT</strong>
                  <small>For Lightning → BIT fills</small>
                </div>
                <span className="pool-balance-bar"><i /></span>
              </div>

              <div className="funding-notice">
                <strong>No shared LP pool</strong>
                <span>Each solver keeps a separate vault account and its own Lightning node.</span>
              </div>

              <div className="dual-funding-inputs">
                <div className="amount-panel pool-input">
                  <label htmlFor="lightning-liquidity">Lightning node budget</label>
                  <div className="amount-row">
                    <input
                      id="lightning-liquidity"
                      inputMode="numeric"
                      value={lightningLiquidity}
                      onChange={(event) => { setLightningLiquidity(event.target.value.replace(/[^0-9]/g, "")); setPoolReceipt(false); }}
                    />
                    <span className="asset-chip btc"><i>₿</i>sats</span>
                  </div>
                  <span className="balance-line">Declared capacity · funds stay on your node</span>
                </div>

                <div className="amount-panel pool-input">
                  <label htmlFor="bit-liquidity">BIT vault inventory</label>
                  <div className="amount-row">
                    <input
                      id="bit-liquidity"
                      inputMode="decimal"
                      value={bitLiquidity}
                      onChange={(event) => { setBitLiquidity(event.target.value.replace(/[^0-9.]/g, "")); setPoolReceipt(false); }}
                    />
                    <span className="asset-chip bit"><i>B</i>BIT</span>
                  </div>
                  <span className="balance-line">Segregated onchain balance · exact reservations only</span>
                </div>
              </div>

              <div className="yield-card">
                <span>Symmetric usable capacity</span>
                <strong>{numberFormat(balancedCapacity)} sats</strong>
                <small>25% remains unquoted on each side. This is an operating limit, not a yield estimate.</small>
              </div>

              <div className="quote-details">
                <div><span>Suggested first-fill cap</span><strong>{numberFormat(fillCap)} sats</strong></div>
                <div><span>Lightning custody</span><strong>Solver node</strong></div>
                <div><span>BIT accounting</span><strong>Segregated by solver</strong></div>
              </div>

              <button
                className="primary-action"
                disabled={lightningReserve <= 0 || bitReserve <= 0}
                onClick={() => setPoolReceipt(true)}
              >
                Create guarded funding plan <span>→</span>
              </button>
              {poolReceipt && (
                <div className="funding-receipt" role="status">
                  <span><b>1</b> Verify node identity and capped Lightning budget</span>
                  <span><b>2</b> Approve and deposit BIT into your solver vault account</span>
                  <span><b>3</b> Activate quotes only after both balances reconcile</span>
                  <small>Funding plan created. No wallet or node action occurred.</small>
                </div>
              )}
            </section>
          )}
        </div>
      </section>

      <section className="principles-strip" aria-label="TreeSwap design principles">
        <span><b>01</b> Compare signed quotes</span>
        <span><b>02</b> Keep solver funds separate</span>
        <span><b>03</b> See every fee before signing</span>
        <span><b>04</b> Settle full swaps only</span>
      </section>

      <section className="audience-section" aria-labelledby="audience-title">
        <div className="audience-heading">
          <p className="eyebrow">ONE BRIDGE · TWO ROLES</p>
          <h2 id="audience-title">Swap, or help swaps happen.</h2>
          <p>
            TreeSwap is intentionally small: one quote request, one selected solver,
            and one full settlement. There is no shared public liquidity pool.
          </p>
        </div>
        <div className="audience-grid">
          <article>
            <span className="audience-label">FOR SWAPPERS</span>
            <h3>Choose the quote you trust.</h3>
            <p>Compare exact output, total fees, solver identity, and expiry before you approve anything.</p>
            <a href="#top" onClick={() => setView("swap")}>Preview a swap <b>→</b></a>
          </article>
          <article>
            <span className="audience-label">FOR SOLVERS</span>
            <h3>Bring your own liquidity.</h3>
            <p>Keep Lightning on your node and BIT in a segregated vault account. Quote only within your limits.</p>
            <a href="#top" onClick={() => setView("pool")}>Plan liquidity <b>→</b></a>
          </article>
        </div>
      </section>

      <section className="mechanism" id="mechanism">
        <div className="section-heading">
          <p className="eyebrow">THE CLEARING MECHANISM</p>
          <h2>Two sides. One secret.</h2>
          <p>
            The selected Lightning payment and BIT escrow use the same payment
            hash. Revealing its secret releases BIT to the address fixed in advance.
          </p>
        </div>
        <div className="mechanism-grid">
          <article>
            <span className="step-number">01</span>
            <div className="mechanism-icon intent-icon"><i /><b /></div>
            <h3>Request the outcome</h3>
            <p>Enter the asset, amount, recipient, expiry, and maximum fee you will accept.</p>
          </article>
          <article>
            <span className="step-number">02</span>
            <div className="mechanism-icon auction-icon"><i /><b /><em /></div>
            <h3>Compare signed quotes</h3>
            <p>Independent solvers return short-lived, all-in prices. You select one signed quote.</p>
          </article>
          <article>
            <span className="step-number">03</span>
            <div className="mechanism-icon settle-icon"><i /></div>
            <h3>Settle atomically</h3>
            <p>BIT is locked to one beneficiary. The Lightning payment secret releases it—or timeout returns it.</p>
          </article>
        </div>
      </section>

      <section className="rules-section">
        <div className="rules-card fee-card">
          <p className="eyebrow">DIRECTIONAL FEES</p>
          <h2>Outgoing Lightning costs more.</h2>
          <p>
            BIT → Lightning carries a higher quote because the solver pays the
            Lightning invoice and absorbs routing and outbound-capacity costs.
          </p>
          <div className="fee-comparison">
            <div>
              <span>Lightning → BIT</span>
              <strong>from 0.18%</strong>
              <small>Sender pays their own routing</small>
            </div>
            <div className="high-fee">
              <span>BIT → Lightning</span>
              <strong>from 0.72%</strong>
              <small>Routing estimate included</small>
            </div>
          </div>
          <span className="rule-note">Fee caps are signed into every intent. An immutable vault ceiling limits every active reservation.</span>
          <span className="rule-note">V1 protocol fees settle on the BIT leg; Lightning routing and solver spread are locked into the net-sats quote.</span>
        </div>

        <div className="rules-card contract-card">
          <p className="eyebrow">SETTLEMENT ASSET</p>
          <h2>No wrapped token.</h2>
          <p>
            TreeSwap does not mint a substitute asset. The design moves existing
            BIT through an isolated escrow and leaves backing to the BIT protocol.
          </p>
          <a
            href={`https://etherscan.io/token/${BIT_CONTRACT}#code`}
            target="_blank"
            rel="noreferrer"
            className="contract-link"
          >
            <span><i /> Ethereum mainnet</span>
            <strong>{shortAddress(BIT_CONTRACT)}</strong>
            <b>↗</b>
          </a>
          <div className="contract-facts">
            <span>ERC-20</span><span>18 decimals</span><span>Upgradeable</span><span>Escrowed, not wrapped</span>
          </div>
        </div>
      </section>

      <section className="security-section" id="security" aria-labelledby="security-title">
        <div className="security-heading">
          <p className="eyebrow">ADVERSARIAL BY DESIGN</p>
          <h2 id="security-title">What must be true before real funds.</h2>
          <p>
            Hash locks are only one piece. TreeSwap must limit price exposure,
            bind the recipient, order both clocks safely, and verify every selected quote.
          </p>
          <a href="https://github.com/lightning/bolts/blob/master/11-payment-encoding.md" target="_blank" rel="noreferrer">
            Review basis: BOLT 11 + EIP-712 <span>↗</span>
          </a>
        </div>
        <div className="security-grid">
          <article>
            <span>01 · ECONOMIC</span>
            <h3>Reference limits</h3>
            <p>100 sats is a reference, not a guarantee. Exposure caps stop one-sided inventory drain.</p>
            <b>REQUIRED</b>
          </article>
          <article>
            <span>02 · ATOMICITY</span>
            <h3>Bound beneficiary</h3>
            <p>The Ethereum recipient is fixed before payment, making a copied preimage harmless.</p>
            <b>REQUIRED</b>
          </article>
          <article>
            <span>03 · TIME</span>
            <h3>Ordered deadlines</h3>
            <p>Lightning&apos;s last safe settle precedes the Ethereum refund by a tested safety buffer.</p>
            <b>REQUIRED</b>
          </article>
          <article>
            <span>04 · MARKET</span>
            <h3>Exact signed quote</h3>
            <p>The selected amounts, fees, recipient, hash, and expiry must be independently verifiable.</p>
            <b>REQUIRED</b>
          </article>
        </div>
      </section>

      <footer>
        <Link href="/" className="brand footer-brand">
          <span className="brand-mark" aria-hidden="true"><i /><b>ϟ</b></span>
          <span>treeswap</span>
        </Link>
        <p>Competitive swaps between Bitcoin Lightning and Bittrees BIT.</p>
        <span><a href="https://github.com/bobofbuilding/treeswap" target="_blank" rel="noreferrer">Open-source prototype</a> · MIT</span>
      </footer>

      {intentOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setIntentOpen(false)}>
          <section
            className="intent-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="intent-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="modal-close" onClick={() => setIntentOpen(false)} aria-label="Close simulation">×</button>
            <span className="modal-kicker">SANDBOX SETTLEMENT</span>
            <h2 id="intent-title">
              {intentPhase >= intentSteps.length ? "Intent settled." : "Following the secret…"}
            </h2>
            <p>
              {inputIsSats
                ? `${numberFormat(inputAmount)} sats → ${numberFormat(outputAmount, 2)} BIT`
                : `${numberFormat(inputAmount, 2)} BIT → ${numberFormat(outputAmount)} sats`}
            </p>

            <div className="intent-path" aria-label="Intent settlement progress">
              {intentSteps.map((step, index) => {
                const complete = intentPhase > index;
                const active = intentPhase === index;
                return (
                  <div className={`${complete ? "complete" : ""} ${active ? "current" : ""}`} key={step.title}>
                    <span>{complete ? "✓" : index + 1}</span>
                    <div><strong>{step.title}</strong><small>{step.note}</small></div>
                  </div>
                );
              })}
            </div>

            <div className="hash-card">
              <span>Shared payment hash</span>
              <code>7ea4…c91b</code>
            </div>

            {intentPhase >= intentSteps.length ? (
              <button className="primary-action" onClick={() => setIntentOpen(false)}>Done <span>✓</span></button>
            ) : (
              <div className="settling-line"><i /> Simulating settlement</div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
