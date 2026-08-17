"use client";

import { useEffect, useState } from "react";

type Direction = "lightning-to-bit" | "bit-to-lightning";
type View = "swap" | "pool";

type Offer = {
  name: string;
  kind: "Counter-intent" | "Solver";
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
      name: "Open intent #842",
      kind: "Counter-intent",
      feeBps: 18,
      routeFee: 0,
      speed: "direct match",
      color: "mint",
    },
    {
      name: "Rootline",
      kind: "Solver",
      feeBps: 28,
      routeFee: 0,
      speed: "~12 sec",
      color: "orange",
    },
    {
      name: "Arbor Nine",
      kind: "Solver",
      feeBps: 34,
      routeFee: 0,
      speed: "~18 sec",
      color: "violet",
    },
  ],
  "bit-to-lightning": [
    {
      name: "Open intent #839",
      kind: "Counter-intent",
      feeBps: 72,
      routeFee: 6,
      speed: "direct match",
      color: "mint",
    },
    {
      name: "Rootline",
      kind: "Solver",
      feeBps: 85,
      routeFee: 12,
      speed: "~9 sec",
      color: "orange",
    },
    {
      name: "Canopy Labs",
      kind: "Solver",
      feeBps: 97,
      routeFee: 8,
      speed: "~15 sec",
      color: "blue",
    },
  ],
};

const activity = [
  { pair: "BIT → LN", amount: "84,200 sats", solver: "Rootline", age: "4s" },
  { pair: "LN → BIT", amount: "1,248 BIT", solver: "Intent #842", age: "19s" },
  { pair: "LN → BIT", amount: "412 BIT", solver: "Arbor Nine", age: "37s" },
  { pair: "BIT → LN", amount: "220,800 sats", solver: "Canopy", age: "1m" },
];

const intentSteps = [
  { title: "Intent signed", note: "Terms and expiry are fixed" },
  { title: "Best offer reserved", note: "Counter-intent #842 wins" },
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
  const [poolAsset, setPoolAsset] = useState<"Lightning" | "BIT">("Lightning");
  const [poolAmount, setPoolAmount] = useState("500000");
  const [poolReceipt, setPoolReceipt] = useState(false);

  const offers = offerBook[direction];
  const inputAmount = Number(amount.replaceAll(",", "")) || 0;
  const activeOffer = offers[selectedOffer] ?? offers[0];
  const inputIsSats = direction === "lightning-to-bit";
  const parOutput = inputIsSats ? inputAmount / PAR_SATS : inputAmount * PAR_SATS;
  const intentFee = (parOutput * activeOffer.feeBps) / 10_000;
  const outputAmount = Math.max(parOutput - intentFee - activeOffer.routeFee, 0);
  const feeLabel = `${(activeOffer.feeBps / 100).toFixed(2)}%`;

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
        <span>Local prototype</span>
        <span>No wallets connected · No real funds</span>
      </div>

      <nav className="nav-shell" aria-label="Main navigation">
        <a href="#top" className="brand" aria-label="TreeSwap home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <b>ϟ</b>
          </span>
          <span>treeswap</span>
        </a>
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
            Fund the pool
          </button>
          <a href="#mechanism">How it works</a>
        </div>
        <button className="network-pill" type="button">
          <span /> Ethereum + Lightning
        </button>
      </nav>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">THE INTENT MARKET FOR BIT</p>
          <h1>
            Swap across the
            <br />
            <em>canopy.</em>
          </h1>
          <p className="hero-deck">
            Trade Lightning sats and Bittrees BIT at a transparent par value.
            Opposite intents match first; independent solvers compete for the rest.
          </p>
          <div className="hero-stats" aria-label="Market summary">
            <div>
              <span>Par value</span>
              <strong>1 BIT = 100 sats</strong>
            </div>
            <div>
              <span>Settlement</span>
              <strong>Hash-locked</strong>
            </div>
            <div>
              <span>Best quote</span>
              <strong>Wins automatically</strong>
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
                  <p>CREATE AN INTENT</p>
                  <h2>Swap at par</h2>
                </div>
                <span className="live-badge"><i /> auction live</span>
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
                <span className="balance-line">Best of {offers.length} executable offers</span>
              </div>

              <div className="auction-head">
                <span>Competing offers</span>
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
                      {index === 0 && <span className="best-tag">BEST</span>}
                    </button>
                  );
                })}
              </div>

              <div className="quote-details">
                <div><span>Par conversion</span><strong>{numberFormat(parOutput, inputIsSats ? 2 : 0)} {inputIsSats ? "BIT" : "sats"}</strong></div>
                <div><span>Intent + solver fee</span><strong>{feeLabel}</strong></div>
                {!inputIsSats && <div><span>Estimated routing</span><strong>{activeOffer.routeFee} sats</strong></div>}
                <div><span>Price protection</span><strong>100 sats / BIT</strong></div>
              </div>

              <button
                className="primary-action"
                onClick={beginIntent}
                disabled={inputAmount <= 0}
              >
                Preview this intent <span>→</span>
              </button>
              <p className="microcopy">Simulation only. No wallet signature or payment will be requested.</p>
            </section>
          ) : (
            <section className="swap-card pool-card" aria-label="Liquidity pool simulator">
              <div className="card-heading">
                <div>
                  <p>PROVIDE LIQUIDITY</p>
                  <h2>Fund either side</h2>
                </div>
                <span className="live-badge"><i /> fee earning</span>
              </div>

              <div className="pool-balance">
                <div>
                  <span>Lightning reserve</span>
                  <strong>18.4M sats</strong>
                  <small>49.0% of par value</small>
                </div>
                <div>
                  <span>BIT reserve</span>
                  <strong>191,800 BIT</strong>
                  <small>51.0% of par value</small>
                </div>
                <span className="pool-balance-bar"><i /></span>
              </div>

              <div className="asset-selector" aria-label="Select liquidity asset">
                <button
                  className={poolAsset === "Lightning" ? "selected" : ""}
                  onClick={() => { setPoolAsset("Lightning"); setPoolAmount("500000"); setPoolReceipt(false); }}
                >
                  <span className="asset-icon btc">₿</span>
                  <span><strong>Lightning BTC</strong><small>Fund outgoing sats</small></span>
                </button>
                <button
                  className={poolAsset === "BIT" ? "selected" : ""}
                  onClick={() => { setPoolAsset("BIT"); setPoolAmount("5000"); setPoolReceipt(false); }}
                >
                  <span className="asset-icon bit">B</span>
                  <span><strong>Bittrees BIT</strong><small>Fund outgoing BIT</small></span>
                </button>
              </div>

              <div className="amount-panel pool-input">
                <label htmlFor="pool-amount">Deposit amount</label>
                <div className="amount-row">
                  <input
                    id="pool-amount"
                    inputMode="decimal"
                    value={poolAmount}
                    onChange={(event) => setPoolAmount(event.target.value.replace(/[^0-9.]/g, ""))}
                  />
                  <span className={`asset-chip ${poolAsset === "Lightning" ? "btc" : "bit"}`}>
                    <i>{poolAsset === "Lightning" ? "₿" : "B"}</i>
                    {poolAsset === "Lightning" ? "sats" : "BIT"}
                  </span>
                </div>
              </div>

              <div className="yield-card">
                <span>Illustrative share</span>
                <strong>{poolAsset === "Lightning" ? "2.64%" : "2.54%"}</strong>
                <small>Earns fees only when your side fills an intent. Not an APY promise.</small>
              </div>

              <div className="quote-details">
                <div><span>Withdrawal window</span><strong>24 hours</strong></div>
                <div><span>Maximum fee share</span><strong>80%</strong></div>
                <div><span>Pool accounting</span><strong>Separate per side</strong></div>
              </div>

              <button
                className="primary-action"
                onClick={() => setPoolReceipt(true)}
              >
                Simulate deposit <span>→</span>
              </button>
              {poolReceipt && (
                <p className="receipt" role="status">✓ Draft liquidity receipt created. Nothing was deposited.</p>
              )}
            </section>
          )}
        </div>
      </section>

      <section className="market-tape" aria-label="Recent prototype settlements">
        <div className="tape-label"><i /> PROTOTYPE MARKET</div>
        {activity.map((item) => (
          <div className="tape-item" key={`${item.pair}-${item.age}`}>
            <strong>{item.pair}</strong>
            <span>{item.amount}</span>
            <small>via {item.solver} · {item.age}</small>
          </div>
        ))}
      </section>

      <section className="book-section" aria-labelledby="book-title">
        <div className="book-intro">
          <p className="eyebrow">PRICE–TIME INTENT BOOK</p>
          <h2 id="book-title">The best executable edge leads.</h2>
          <p>
            Inspired by DeepState’s top-of-book mechanism, TreeSwap ranks each
            side by net output after every disclosed cost. Arrival time breaks
            ties. Only the leading executable bid and ask earn maker fee share.
          </p>
          <div className="book-rules">
            <span><b>1</b> Net price first</span>
            <span><b>2</b> Time breaks ties</span>
            <span><b>3</b> Collateral must stay live</span>
          </div>
        </div>

        <div className="order-book" aria-label="Prototype TreeSwap intent book">
          <div className="book-topline">
            <div><span>Best bid</span><strong>99.82</strong><small>sats / BIT</small></div>
            <div><span>Best ask</span><strong>100.72</strong><small>sats / BIT</small></div>
            <div><span>Net spread</span><strong>0.90%</strong><small>after quoted costs</small></div>
          </div>
          <div className="book-columns">
            <div className="book-side bids">
              <div className="book-side-title"><span>Lightning → BIT</span><small>BIDS · BUY BIT</small></div>
              <div className="book-row head"><span>Net price</span><span>Quantity</span><span>Age</span></div>
              <div className="book-row leader"><span>99.82</span><span>1,248 BIT</span><span>00:41</span><b>LEADS + EARNS</b></div>
              <div className="book-row"><span>99.72</span><span>4,800 BIT</span><span>01:07</span></div>
              <div className="book-row"><span>99.66</span><span>2,100 BIT</span><span>02:12</span></div>
              <div className="book-row"><span>99.58</span><span>8,400 BIT</span><span>03:44</span></div>
            </div>
            <div className="book-side asks">
              <div className="book-side-title"><span>BIT → Lightning</span><small>ASKS · SELL BIT</small></div>
              <div className="book-row head"><span>Net price</span><span>Quantity</span><span>Age</span></div>
              <div className="book-row leader"><span>100.72</span><span>842 BIT</span><span>00:18</span><b>LEADS + EARNS</b></div>
              <div className="book-row"><span>100.85</span><span>2,208 BIT</span><span>00:56</span></div>
              <div className="book-row"><span>100.97</span><span>930 BIT</span><span>01:49</span></div>
              <div className="book-row"><span>101.12</span><span>5,000 BIT</span><span>04:21</span></div>
            </div>
          </div>
          <div className="book-footer">
            <span><i /> Executable collateral checked 3s ago</span>
            <span>12 resting intents · 3 independent solvers</span>
          </div>
        </div>
      </section>

      <section className="mechanism" id="mechanism">
        <div className="section-heading">
          <p className="eyebrow">THE CLEARING MECHANISM</p>
          <h2>Two sides. One secret.</h2>
          <p>
            TreeSwap uses the same payment hash on Lightning and Ethereum. The
            revealed preimage is the receipt that releases BIT—without asking
            either participant to trust the other.
          </p>
        </div>
        <div className="mechanism-grid">
          <article>
            <span className="step-number">01</span>
            <div className="mechanism-icon intent-icon"><i /><b /></div>
            <h3>Publish the outcome</h3>
            <p>A maker signs an intent: asset in, minimum asset out, recipient, expiry, and fee ceiling.</p>
          </article>
          <article>
            <span className="step-number">02</span>
            <div className="mechanism-icon auction-icon"><i /><b /><em /></div>
            <h3>Compete to fill</h3>
            <p>Opposite user intents and independent solvers submit executable offers. Best net output wins.</p>
          </article>
          <article>
            <span className="step-number">03</span>
            <div className="mechanism-icon settle-icon"><i /></div>
            <h3>Settle atomically</h3>
            <p>The Lightning preimage unlocks the reserved BIT escrow. If time expires, funds return.</p>
          </article>
        </div>
      </section>

      <section className="rules-section">
        <div className="rules-card fee-card">
          <p className="eyebrow">DIRECTIONAL FEES</p>
          <h2>Liquidity has a direction.</h2>
          <p>
            BIT → Lightning carries a higher fee because the fulfiller must source
            outbound Lightning liquidity and absorb routing uncertainty.
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
          <span className="rule-note">Fee caps are signed into every intent. Governance can adjust defaults, never an active quote.</span>
          <span className="rule-note">V1 protocol fees settle on the BIT leg; Lightning routing and solver spread are locked into the net-sats quote.</span>
        </div>

        <div className="rules-card contract-card">
          <p className="eyebrow">SETTLEMENT ASSET</p>
          <h2>BIT stays BIT.</h2>
          <p>
            TreeSwap does not mint or redeem BIT. It moves the existing ERC-20
            through an isolated escrow and leaves BNote backing to the BIT protocol.
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

      <section className="security-section" aria-labelledby="security-title">
        <div className="security-heading">
          <p className="eyebrow">ADVERSARIAL BY DESIGN</p>
          <h2 id="security-title">Four launch gates before real funds.</h2>
          <p>
            Hash locks are only one piece. TreeSwap must also defend the par,
            bind the recipient, order both clocks safely, and make quote priority verifiable.
          </p>
          <a href="https://github.com/lightning/bolts/blob/master/11-payment-encoding.md" target="_blank" rel="noreferrer">
            Review basis: BOLT 11 + EIP-712 <span>↗</span>
          </a>
        </div>
        <div className="security-grid">
          <article>
            <span>01 · ECONOMIC</span>
            <h3>Par circuit breaker</h3>
            <p>Caps and inventory-aware fees stop a stale 100-sat reference from draining one side.</p>
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
            <h3>Verifiable priority</h3>
            <p>Signed, sequenced quotes let anyone reproduce price-time order before rewards activate.</p>
            <b>REQUIRED</b>
          </article>
        </div>
      </section>

      <footer>
        <a href="#top" className="brand footer-brand">
          <span className="brand-mark" aria-hidden="true"><i /><b>ϟ</b></span>
          <span>treeswap</span>
        </a>
        <p>Intent-based swaps between Bitcoin Lightning and Bittrees BIT.</p>
        <span>Prototype specification · August 2026</span>
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
