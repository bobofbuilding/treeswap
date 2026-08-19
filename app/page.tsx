"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  calculateLiquidityPlan,
  calculateQuote,
  parseAmount,
  PAR_SATS,
  sanitizeAmount,
} from "@/lib/product.mjs";

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
const offerBook: Record<Direction, Offer[]> = {
  "lightning-to-bit": [
    { name: "Rootline", kind: "Solver", feeBps: 18, routeFee: 0, speed: "~12 sec", color: "mint" },
    { name: "Arbor Nine", kind: "Solver", feeBps: 28, routeFee: 0, speed: "~18 sec", color: "orange" },
    { name: "Canopy Labs", kind: "Solver", feeBps: 34, routeFee: 0, speed: "~21 sec", color: "violet" },
  ],
  "bit-to-lightning": [
    { name: "Rootline", kind: "Solver", feeBps: 72, routeFee: 6, speed: "~9 sec", color: "mint" },
    { name: "Canopy Labs", kind: "Solver", feeBps: 85, routeFee: 12, speed: "~15 sec", color: "orange" },
    { name: "Arbor Nine", kind: "Solver", feeBps: 97, routeFee: 8, speed: "~19 sec", color: "blue" },
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
  const inputAmount = parseAmount(amount);
  const activeOffer = offers[selectedOffer] ?? offers[0];
  const activeQuote = calculateQuote(
    direction,
    inputAmount,
    activeOffer.feeBps,
    activeOffer.routeFee,
  );
  const inputIsSats = activeQuote.inputIsSats;
  const inputAsset = inputIsSats ? "sats" : "BIT";
  const outputAsset = inputIsSats ? "BIT" : "sats";
  const parOutput = activeQuote.referenceOutput;
  const outputAmount = activeQuote.output;
  const feeLabel = `${(activeOffer.feeBps / 100).toFixed(2)}%`;
  const outputDigits = inputIsSats ? 2 : 0;

  const {
    lightningReserve,
    bitReserve,
    usableLightning,
    usableBit,
    balancedCapacity,
    fillCap,
  } = calculateLiquidityPlan(parseAmount(lightningLiquidity), parseAmount(bitLiquidity));

  useEffect(() => {
    if (!intentOpen || intentPhase >= intentSteps.length) return;
    const timer = window.setTimeout(() => {
      setIntentPhase((phase) => Math.min(phase + 1, intentSteps.length));
    }, 1050);
    return () => window.clearTimeout(timer);
  }, [intentOpen, intentPhase]);

  function selectView(next: View) {
    setView(next);
    setPoolReceipt(false);
  }

  function flipDirection() {
    const next = direction === "lightning-to-bit" ? "bit-to-lightning" : "lightning-to-bit";
    const converted = direction === "lightning-to-bit" ? inputAmount / PAR_SATS : inputAmount * PAR_SATS;
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
        <span>Prototype</span>
        <span>No wallets connected · No real funds</span>
      </div>

      <nav className="nav-shell" aria-label="Main navigation">
        <Link href="/" className="brand" aria-label="TreeSwap home">
          <span className="brand-mark" aria-hidden="true"><i /><b>ϟ</b></span>
          <span>treeswap</span>
        </Link>
        <div className="nav-links">
          <a className="active" href="#trade">Trade</a>
          <a href="#mechanism">How it works</a>
          <a href="#security">Safety</a>
          <a href="https://github.com/bobofbuilding/treeswap" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <a className="network-pill" href="#security"><span /> Safety-first</a>
      </nav>

      <section className="trade-stage" id="trade">
        <header className="trade-intro">
          <p className="eyebrow">BITCOIN LIGHTNING ↔ BIT</p>
          <h1>Swap sats and BIT.</h1>
          <p>Compare signed solver quotes. Review one clear price.</p>
        </header>

        <section className="exchange-card" aria-label={view === "swap" ? "TreeSwap quote builder" : "Solver liquidity planner"}>
          <div className="card-tabs" role="group" aria-label="TreeSwap tools">
            <button
              type="button"
              aria-pressed={view === "swap"}
              className={view === "swap" ? "active" : ""}
              onClick={() => selectView("swap")}
            >
              Swap
            </button>
            <button
              type="button"
              aria-pressed={view === "pool"}
              className={view === "pool" ? "active" : ""}
              onClick={() => selectView("pool")}
            >
              Solver liquidity
            </button>
            <a href="#security" aria-label="Read TreeSwap safety requirements">Safety ↗</a>
          </div>

          {view === "swap" ? (
            <div className="swap-view">
              <div className="amount-panel">
                <div className="panel-label"><label htmlFor="swap-amount">You pay</label><span>Prototype balance</span></div>
                <div className="amount-row">
                  <input
                    id="swap-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(sanitizeAmount(event.target.value))}
                    aria-label={`Amount in ${inputAsset}`}
                  />
                  <span className={`asset-chip ${inputIsSats ? "btc" : "bit"}`}>
                    <i>{inputIsSats ? "₿" : "B"}</i>{inputAsset}
                  </span>
                </div>
              </div>

              <button type="button" className="direction-button" onClick={flipDirection} aria-label="Reverse swap direction">↓</button>

              <div className="amount-panel receive-panel">
                <div className="panel-label"><span>You receive</span><span>Exact quote</span></div>
                <div className="amount-row">
                  <strong>{numberFormat(outputAmount, outputDigits)}</strong>
                  <span className={`asset-chip ${inputIsSats ? "bit" : "btc"}`}>
                    <i>{inputIsSats ? "B" : "₿"}</i>{outputAsset}
                  </span>
                </div>
              </div>

              <details className="quote-drawer">
                <summary>
                  <span className={`solver-dot ${activeOffer.color}`} />
                  <span className="summary-copy"><strong>{activeOffer.name}</strong><small>Best of {offers.length} signed quotes</small></span>
                  <span className="summary-price"><strong>{feeLabel}</strong><small>expires 00:24</small></span>
                  <span className="chevron">⌄</span>
                </summary>
                <div className="offer-list">
                  {offers.map((offer, index) => {
                    const offerOutput = calculateQuote(direction, inputAmount, offer.feeBps, offer.routeFee).output;
                    return (
                      <button
                        type="button"
                        className={`offer-row ${selectedOffer === index ? "selected" : ""}`}
                        key={offer.name}
                        onClick={() => setSelectedOffer(index)}
                      >
                        <span className={`solver-dot ${offer.color}`} />
                        <span className="offer-name"><strong>{offer.name}</strong><small>{offer.kind} · {offer.speed}</small></span>
                        <span className="offer-price"><strong>{numberFormat(offerOutput, outputDigits)} {outputAsset}</strong><small>{(offer.feeBps / 100).toFixed(2)}% fee</small></span>
                        {index === 0 && <span className="best-tag">BEST</span>}
                      </button>
                    );
                  })}
                </div>
              </details>

              <details className="swap-details">
                <summary><span>Swap details</span><strong>1 BIT = 100 sats <i>⌄</i></strong></summary>
                <div className="detail-rows">
                  <div><span>Reference conversion</span><strong>{numberFormat(parOutput, outputDigits)} {outputAsset}</strong></div>
                  <div><span>Solver fee</span><strong>{feeLabel}</strong></div>
                  {!inputIsSats && <div><span>Estimated Lightning routing</span><strong>{activeOffer.routeFee} sats</strong></div>}
                  <div><span>Settlement</span><strong>One payment hash</strong></div>
                </div>
              </details>

              <button type="button" className="primary-action" onClick={beginIntent} disabled={inputAmount <= 0}>
                Review swap <span>→</span>
              </button>
              <p className="microcopy">Simulation only. No signature or payment will be requested.</p>
            </div>
          ) : (
            <div className="pool-view">
              <div className="pool-heading">
                <div><span>Solver inventory</span><h2>Fund both sides.</h2></div>
                <span className="status-pill"><i /> Self-custodied</span>
              </div>

              <div className="amount-panel pool-input">
                <div className="panel-label"><label htmlFor="lightning-liquidity">Lightning budget</label><span>Stays on your node</span></div>
                <div className="amount-row">
                  <input
                    id="lightning-liquidity"
                    inputMode="numeric"
                    value={lightningLiquidity}
                    onChange={(event) => { setLightningLiquidity(sanitizeAmount(event.target.value, false)); setPoolReceipt(false); }}
                  />
                  <span className="asset-chip btc"><i>₿</i>sats</span>
                </div>
              </div>

              <div className="amount-panel pool-input">
                <div className="panel-label"><label htmlFor="bit-liquidity">BIT inventory</label><span>Segregated vault</span></div>
                <div className="amount-row">
                  <input
                    id="bit-liquidity"
                    inputMode="decimal"
                    value={bitLiquidity}
                    onChange={(event) => { setBitLiquidity(sanitizeAmount(event.target.value)); setPoolReceipt(false); }}
                  />
                  <span className="asset-chip bit"><i>B</i>BIT</span>
                </div>
              </div>

              <div className="capacity-card">
                <span>Balanced swap capacity</span>
                <strong>{numberFormat(balancedCapacity)} sats</strong>
                <small>After keeping 25% of each side unquoted</small>
              </div>

              <details className="swap-details">
                <summary><span>Funding details</span><strong>Separate custody <i>⌄</i></strong></summary>
                <div className="detail-rows">
                  <div><span>Usable Lightning</span><strong>{numberFormat(usableLightning)} sats</strong></div>
                  <div><span>Usable BIT</span><strong>{numberFormat(usableBit, 2)} BIT</strong></div>
                  <div><span>Suggested first-fill cap</span><strong>{numberFormat(fillCap)} sats</strong></div>
                  <div><span>Pool structure</span><strong>No shared LP pool</strong></div>
                </div>
              </details>

              <button
                type="button"
                className="primary-action"
                disabled={lightningReserve <= 0 || bitReserve <= 0}
                onClick={() => setPoolReceipt(true)}
              >
                Review funding plan <span>→</span>
              </button>
              {poolReceipt && (
                <div className="funding-receipt" role="status">
                  <span><b>1</b> Verify node identity and Lightning limit</span>
                  <span><b>2</b> Deposit BIT into your solver vault account</span>
                  <span><b>3</b> Activate quotes after both balances reconcile</span>
                  <small>Plan created. No wallet or node action occurred.</small>
                </div>
              )}
            </div>
          )}
        </section>

        <div className="trade-trust" aria-label="Swap guarantees">
          <span><i>✓</i> Best of 3 quotes</span>
          <span><i>✓</i> Exact output</span>
          <span><i>✓</i> No real funds</span>
        </div>
      </section>

      <section className="mechanism" id="mechanism">
        <div className="section-heading">
          <p className="eyebrow">HOW IT WORKS</p>
          <h2>One swap. Three steps.</h2>
          <p>There is no shared public liquidity pool. Independent solvers compete to fill a signed request.</p>
        </div>
        <div className="mechanism-grid">
          <article><span>01</span><h3>Enter an amount</h3><p>Choose Lightning sats or BIT and state the exact outcome you want.</p></article>
          <article><span>02</span><h3>Pick a quote</h3><p>Compare short-lived, all-in prices from independent solvers.</p></article>
          <article><span>03</span><h3>Settle together</h3><p>One payment secret completes both legs—or the timeout returns the funds.</p></article>
        </div>
      </section>

      <section className="facts-section" aria-label="TreeSwap market details">
        <article className="fee-card">
          <p className="eyebrow">DIRECTIONAL FEES</p>
          <h2>Lightning out costs more.</h2>
          <p>BIT → Lightning includes routing and outbound-capacity costs.</p>
          <div className="fee-comparison">
            <div><span>Lightning → BIT</span><strong>from 0.18%</strong></div>
            <div><span>BIT → Lightning</span><strong>from 0.72%</strong></div>
          </div>
        </article>

        <article className="asset-card">
          <p className="eyebrow">SETTLEMENT ASSET</p>
          <h2>BIT, not a wrapper.</h2>
          <p>Existing BIT moves through isolated escrow. TreeSwap does not mint a substitute token.</p>
          <a href={`https://etherscan.io/token/${BIT_CONTRACT}#code`} target="_blank" rel="noreferrer" className="contract-link">
            <span><i /> Ethereum mainnet</span><strong>{shortAddress(BIT_CONTRACT)}</strong><b>↗</b>
          </a>
        </article>
      </section>

      <section className="security-section" id="security" aria-labelledby="security-title">
        <div className="security-heading">
          <p className="eyebrow">BEFORE REAL FUNDS</p>
          <h2 id="security-title">Four checks block launch.</h2>
          <p>Price limits, recipient binding, safe deadlines, and independently verifiable quotes are required.</p>
          <a href="https://github.com/bobofbuilding/treeswap/blob/agent/simplify-marketing-seo/docs/THREAT_MODEL.md" target="_blank" rel="noreferrer">Read the threat model <span>↗</span></a>
        </div>
        <div className="security-grid">
          <article><span>01</span><div><h3>Bound the price</h3><p>Cap exposure around the 100-sat reference.</p></div></article>
          <article><span>02</span><div><h3>Bind the recipient</h3><p>Fix the Ethereum beneficiary before payment.</p></div></article>
          <article><span>03</span><div><h3>Order the clocks</h3><p>Keep a tested buffer between settle and refund.</p></div></article>
          <article><span>04</span><div><h3>Verify the quote</h3><p>Make the selected terms reproducible.</p></div></article>
        </div>
      </section>

      <footer>
        <Link href="/" className="brand footer-brand"><span className="brand-mark" aria-hidden="true"><i /><b>ϟ</b></span><span>treeswap</span></Link>
        <p>Competitive swaps between Bitcoin Lightning and Bittrees BIT.</p>
        <span><a href="https://github.com/bobofbuilding/treeswap" target="_blank" rel="noreferrer">Open-source prototype</a> · MIT</span>
      </footer>

      {intentOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setIntentOpen(false)}>
          <section className="intent-modal" role="dialog" aria-modal="true" aria-labelledby="intent-title" onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close" onClick={() => setIntentOpen(false)} aria-label="Close simulation">×</button>
            <span className="modal-kicker">SANDBOX SETTLEMENT</span>
            <h2 id="intent-title">{intentPhase >= intentSteps.length ? "Intent settled." : "Following the secret…"}</h2>
            <p>{inputIsSats ? `${numberFormat(inputAmount)} sats → ${numberFormat(outputAmount, 2)} BIT` : `${numberFormat(inputAmount, 2)} BIT → ${numberFormat(outputAmount)} sats`}</p>
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
            <div className="hash-card"><span>Shared payment hash</span><code>7ea4…c91b</code></div>
            {intentPhase >= intentSteps.length ? (
              <button type="button" className="primary-action" onClick={() => setIntentOpen(false)}>Done <span>✓</span></button>
            ) : (
              <div className="settling-line"><i /> Simulating settlement</div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
