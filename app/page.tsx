"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import InvoiceQr from "@/app/components/InvoiceQr";
import SendPanel from "@/app/components/SendPanel";
import WalletAccount from "@/app/components/WalletAccount";
import {
  calculateLiquidityPlan,
  calculateRequiredInput,
  hasMainnetBolt11Shape,
  normalizeBolt11,
  parseAmount,
  parseBolt11AmountSats,
  roundUpAmount,
  sanitizeAmount,
} from "@/lib/product.mjs";
import { sanitizeSolverLabel } from "@/lib/untrusted-text.mjs";

type Direction = "lightning-to-bit" | "bit-to-lightning";
type View = "pay-invoice" | "get-bit" | "send" | "pool";

type Offer = {
  name: string;
  kind: "Solver";
  feeBps: number;
  routeFee: number;
  speed: string;
  color: string;
};

const BIT_CONTRACT = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";
const DEMO_INVOICE = "lnbc2500u1qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const DEMO_ADDRESS = "0x1111111111111111111111111111111111111111";
const DEMO_PAYMENT_HASH = `0x${"7ea4".repeat(16)}`;
const offerBook: Record<Direction, Offer[]> = {
  "lightning-to-bit": [
    { name: sanitizeSolverLabel("Rootline"), kind: "Solver", feeBps: 18, routeFee: 0, speed: "~12 sec", color: "mint" },
    { name: sanitizeSolverLabel("Arbor Nine"), kind: "Solver", feeBps: 28, routeFee: 0, speed: "~18 sec", color: "orange" },
    { name: sanitizeSolverLabel("Canopy Labs"), kind: "Solver", feeBps: 34, routeFee: 0, speed: "~21 sec", color: "violet" },
  ],
  "bit-to-lightning": [
    { name: sanitizeSolverLabel("Rootline"), kind: "Solver", feeBps: 72, routeFee: 6, speed: "~9 sec", color: "mint" },
    { name: sanitizeSolverLabel("Canopy Labs"), kind: "Solver", feeBps: 85, routeFee: 12, speed: "~15 sec", color: "orange" },
    { name: sanitizeSolverLabel("Arbor Nine"), kind: "Solver", feeBps: 97, routeFee: 8, speed: "~19 sec", color: "blue" },
  ],
};

const intentSteps = [
  { title: "Invoice checked", note: "Amount, network, expiry, and payment hash are fixed" },
  { title: "Solver quote locked", note: "One signed, exact-output quote is selected" },
  { title: "Payment hash matched", note: "The Lightning and BIT legs share one secret" },
  { title: "Invoice settled", note: "The preimage releases the destination asset" },
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
  const [view, setView] = useState<View>("pay-invoice");
  const [invoice, setInvoice] = useState("");
  const [receiveBitAmount, setReceiveBitAmount] = useState("2500");
  const [receiveAddress, setReceiveAddress] = useState("");
  const [selectedOffer, setSelectedOffer] = useState(0);
  const [intentOpen, setIntentOpen] = useState(false);
  const [confirmationStep, setConfirmationStep] = useState<1 | 2>(1);
  const [intentPhase, setIntentPhase] = useState(0);
  const [paymentStarted, setPaymentStarted] = useState(false);
  const [lightningLiquidity, setLightningLiquidity] = useState("5000000");
  const [bitLiquidity, setBitLiquidity] = useState("50000");
  const [poolReceipt, setPoolReceipt] = useState(false);
  const intentModalRef = useRef<HTMLElement | null>(null);

  const direction: Direction = view === "get-bit" ? "lightning-to-bit" : "bit-to-lightning";
  const isPayInvoice = view === "pay-invoice";
  const isSwapView = view === "pay-invoice" || view === "get-bit";
  const offers = offerBook[direction];
  const activeOffer = offers[selectedOffer] ?? offers[0];
  const decodedInvoiceAmount = parseBolt11AmountSats(invoice);
  const desiredOutput = isPayInvoice
    ? decodedInvoiceAmount ?? 0
    : parseAmount(receiveBitAmount);
  const requiredInput = calculateRequiredInput(
    direction,
    desiredOutput,
    activeOffer.feeBps,
    activeOffer.routeFee,
  );
  const inputIsSats = direction === "lightning-to-bit";
  const inputAsset = inputIsSats ? "sats" : "BIT";
  const displayInput = roundUpAmount(requiredInput, inputIsSats ? 0 : 6);
  const feeLabel = `${(activeOffer.feeBps / 100).toFixed(2)}%`;
  const inputDigits = inputIsSats ? 0 : 6;
  const invoiceHasShape = hasMainnetBolt11Shape(invoice);
  const receiveAddressHasShape = /^0x[0-9a-fA-F]{40}$/.test(receiveAddress);
  const canReview = isPayInvoice
    ? invoiceHasShape && desiredOutput > 0
    : receiveAddressHasShape && desiredOutput > 0;
  const generatedInvoice = `lnbc${Math.max(Math.ceil(displayInput * 10), 1)}n1qpzry9x8gf2tvdw0s3jn54khce6mua7l`;

  const {
    lightningReserve,
    bitReserve,
    usableLightning,
    usableBit,
    balancedCapacity,
    fillCap,
  } = calculateLiquidityPlan(parseAmount(lightningLiquidity), parseAmount(bitLiquidity));

  useEffect(() => {
    if (!intentOpen || !paymentStarted || intentPhase >= intentSteps.length) return;
    const timer = window.setTimeout(() => {
      setIntentPhase((phase) => Math.min(phase + 1, intentSteps.length));
    }, 1050);
    return () => window.clearTimeout(timer);
  }, [intentOpen, intentPhase, paymentStarted]);

  useEffect(() => {
    if (intentOpen) intentModalRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [confirmationStep, intentOpen, paymentStarted]);

  function selectView(next: View) {
    setView(next);
    setSelectedOffer(0);
    setPoolReceipt(false);
  }

  function loadDemoInvoice() {
    setInvoice(DEMO_INVOICE);
  }

  function beginIntent() {
    setConfirmationStep(1);
    setIntentPhase(0);
    setPaymentStarted(false);
    setIntentOpen(true);
  }

  return (
    <main>
      <div className="prototype-strip">
        <span>Prototype</span>
        <span>Swap prototype · Sends use your wallet</span>
      </div>

      <nav className="nav-shell" aria-label="Main navigation">
        <Link href="/" className="brand" aria-label="TreeSwap home">
          <span className="brand-mark" aria-hidden="true"><i /><b>ϟ</b></span>
          <span>treeswap</span>
        </Link>
        <div className="nav-links">
          <a className="active" href="#trade">Trade</a>
          <a href="#mechanism">How it works</a>
          <a href="https://github.com/bobofbuilding/treeswap/blob/main/docs/THREAT_MODEL.md" target="_blank" rel="noreferrer">Safety</a>
          <a href="https://github.com/bobofbuilding/treeswap" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <WalletAccount />
      </nav>

      <section className="trade-stage" id="trade">
        <header className="trade-intro">
          <p className="eyebrow">BITCOIN LIGHTNING ↔ BIT</p>
          <h1>{view === "send" ? "Pay from your wallet." : view === "pool" ? "Run a solver." : "Swap through an invoice."}</h1>
          <p>{view === "send" ? "Pay a Lightning invoice or send BIT directly." : view === "pool" ? "Estimate solver-owned inventory. No public deposits or promised yield." : "Paste an invoice to pay with BIT, or create one to receive BIT."}</p>
        </header>

        <section
          className="exchange-card"
          aria-label={
            view === "pool"
              ? "Solver liquidity planner"
              : view === "send"
                ? "Send BIT or Lightning directly"
              : isPayInvoice
                ? "Pay a Lightning invoice with BIT"
                : "Create a Lightning invoice to receive BIT"
          }
        >
          <div className="card-tabs" role="group" aria-label="TreeSwap tools">
            <button
              type="button"
              aria-pressed={isSwapView}
              className={isSwapView ? "active" : ""}
              onClick={() => selectView("pay-invoice")}
            >
              Swap
            </button>
            <button
              type="button"
              aria-pressed={view === "send"}
              className={view === "send" ? "active" : ""}
              onClick={() => selectView("send")}
            >
              Pay
            </button>
            <button
              type="button"
              aria-pressed={view === "pool"}
              className={view === "pool" ? "active" : ""}
              onClick={() => selectView("pool")}
            >
              Earn
            </button>
          </div>

          {view === "send" ? (
            <SendPanel />
          ) : view !== "pool" ? (
            <div className="swap-view">
              <div className="swap-direction-tabs" role="group" aria-label="Swap direction">
                <button
                  type="button"
                  aria-pressed={view === "pay-invoice"}
                  className={view === "pay-invoice" ? "active" : ""}
                  onClick={() => selectView("pay-invoice")}
                >
                  Pay invoice
                </button>
                <button
                  type="button"
                  aria-pressed={view === "get-bit"}
                  className={view === "get-bit" ? "active" : ""}
                  onClick={() => selectView("get-bit")}
                >
                  Receive BIT
                </button>
              </div>
              {isPayInvoice ? (
                <>
                  <div className="invoice-panel">
                    <div className="invoice-label">
                      <label htmlFor="lightning-invoice">Lightning invoice</label>
                      <button type="button" onClick={loadDemoInvoice}>Use demo</button>
                    </div>
                    <textarea
                      id="lightning-invoice"
                      value={invoice}
                      onChange={(event) => setInvoice(event.target.value.slice(0, 4096))}
                      placeholder="Paste a mainnet BOLT 11 invoice (lnbc…)"
                      rows={3}
                      spellCheck={false}
                    />
                    <div className={`invoice-status ${invoice && (!invoiceHasShape || !decodedInvoiceAmount) ? "error" : ""}`}>
                      <i />
                      <span>
                        {!invoice
                          ? "Paste an invoice. Nothing is sent yet."
                          : !invoiceHasShape
                            ? "This does not look like a mainnet BOLT 11 invoice."
                            : !decodedInvoiceAmount
                              ? "Amountless invoices are not supported. The amount must be encoded."
                              : "Basic invoice shape recognized. Full verification is required before payment."}
                      </span>
                    </div>
                  </div>

                  <div className="amount-panel invoice-amount-panel">
                    <div className="panel-label">
                      <span>Invoice receives</span>
                      <span>Read from invoice</span>
                    </div>
                    <div className="amount-row">
                      <strong>{decodedInvoiceAmount ? numberFormat(decodedInvoiceAmount) : "Amount required"}</strong>
                      <span className="asset-chip btc"><i>₿</i>sats</span>
                    </div>
                  </div>

                  <div className="invoice-flow-arrow" aria-hidden="true">↓</div>

                  <div className="amount-panel receive-panel">
                    <div className="panel-label"><span>You lock</span><span>Reference quote preview</span></div>
                    <div className="amount-row">
                      <strong>{numberFormat(displayInput, inputDigits)}</strong>
                      <span className="asset-chip bit"><i>B</i>BIT</span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="amount-panel">
                    <div className="panel-label"><label htmlFor="bit-receive-amount">You receive</label><span>Exact amount</span></div>
                    <div className="amount-row">
                      <input
                        id="bit-receive-amount"
                        inputMode="decimal"
                        value={receiveBitAmount}
                        onChange={(event) => setReceiveBitAmount(sanitizeAmount(event.target.value))}
                        aria-label="BIT to receive"
                      />
                      <span className="asset-chip bit"><i>B</i>BIT</span>
                    </div>
                  </div>

                  <div className="address-panel">
                    <div className="invoice-label">
                      <label htmlFor="bit-receive-address">BIT receive address</label>
                      <button type="button" onClick={() => setReceiveAddress(DEMO_ADDRESS)}>Use demo</button>
                    </div>
                    <input
                      id="bit-receive-address"
                      value={receiveAddress}
                      onChange={(event) => setReceiveAddress(event.target.value.trim().slice(0, 42))}
                      placeholder="0x…"
                      spellCheck={false}
                    />
                    <div className={`invoice-status ${receiveAddress && !receiveAddressHasShape ? "error" : ""}`}>
                      <i />
                      <span>
                        {!receiveAddress
                          ? "This address is bound before the invoice can be paid."
                          : receiveAddressHasShape
                            ? "Recipient fixed for this quote preview."
                            : "Enter a 42-character Ethereum address."}
                      </span>
                    </div>
                  </div>

                  <div className="invoice-flow-arrow" aria-hidden="true">↓</div>

                  <div className="amount-panel receive-panel">
                    <div className="panel-label"><span>Lightning invoice</span><span>Created after review</span></div>
                    <div className="amount-row">
                      <strong>{numberFormat(displayInput)}</strong>
                      <span className="asset-chip btc"><i>₿</i>sats</span>
                    </div>
                  </div>
                </>
              )}

              <details className="quote-drawer">
                <summary>
                  <span className={`solver-dot ${activeOffer.color}`} />
                  <span className="summary-copy">
                    <strong>{activeOffer.name}</strong>
                    <small>{selectedOffer === 0 ? `Best of ${offers.length}` : `Selected from ${offers.length}`} example quotes</small>
                  </span>
                  <span className="summary-price"><strong>{feeLabel}</strong><small>expires 00:24</small></span>
                  <span className="chevron">⌄</span>
                </summary>
                <div className="offer-list">
                  {offers.map((offer, index) => {
                    const offerInput = calculateRequiredInput(direction, desiredOutput, offer.feeBps, offer.routeFee);
                    const displayOfferInput = roundUpAmount(offerInput, inputIsSats ? 0 : 6);
                    return (
                      <button
                        type="button"
                        className={`offer-row ${selectedOffer === index ? "selected" : ""}`}
                        key={offer.name}
                        onClick={() => setSelectedOffer(index)}
                      >
                        <span className={`solver-dot ${offer.color}`} />
                        <span className="offer-name"><strong>{offer.name}</strong><small>{offer.kind} · {offer.speed}</small></span>
                        <span className="offer-price"><strong>{numberFormat(displayOfferInput, inputDigits)} {inputAsset}</strong><small>{(offer.feeBps / 100).toFixed(2)}% fee</small></span>
                        {index === 0 && <span className="best-tag">BEST</span>}
                      </button>
                    );
                  })}
                </div>
              </details>

              <details className="swap-details">
                <summary><span>Quote details</span><strong>Reference only · 100 sats/BIT <i>⌄</i></strong></summary>
                <div className="detail-rows">
                  <div><span>{isPayInvoice ? "Invoice receives" : "Invoice amount"}</span><strong>{numberFormat(isPayInvoice ? desiredOutput : displayInput, 0)} sats</strong></div>
                  <div><span>{isPayInvoice ? "BIT locked" : "BIT recipient"}</span><strong>{isPayInvoice ? `${numberFormat(displayInput, 6)} BIT` : receiveAddressHasShape ? shortAddress(receiveAddress) : "Required"}</strong></div>
                  <div><span>BIT fee</span><strong>{feeLabel}</strong></div>
                  <div><span>Live pricing</span><strong>Verified markets required</strong></div>
                  <div><span>Future BIT/WBTC pool</span><strong>One price check only</strong></div>
                  {isPayInvoice && <div><span>Estimated Lightning routing</span><strong>{activeOffer.routeFee} sats</strong></div>}
                  <div>
                    <span>Settlement protection</span>
                    <strong>{isPayInvoice ? "Escrow harness tested" : "Signed · capped · time-bound"}</strong>
                  </div>
                  <div><span>Invoice verification</span><strong>Required before live use</strong></div>
                </div>
              </details>

              <button type="button" className="primary-action" onClick={beginIntent} disabled={!canReview}>
                {isPayInvoice ? "Review invoice payment" : "Create Lightning invoice"} <span>→</span>
              </button>
              <p className="microcopy">Simulation only. No BIT will be locked and no invoice will be paid.</p>
            </div>
          ) : (
            <div className="pool-view">
              <div className="solver-boundary" role="note">
                <strong>Solver operators only</strong>
                <span>There is no shared LP pool. This is a planning calculator—not a deposit, LP share, APY, or yield product.</span>
              </div>
              <div className="pool-heading">
                <div><span>Solver-owned inventory</span><h2>Plan both sides.</h2></div>
                <span className="status-pill"><i /> No LP deposits</span>
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
                <span>Reference-balanced capacity</span>
                <strong>{numberFormat(balancedCapacity)} sats</strong>
                <small>At 100 sats/BIT, after keeping 25% of each side unquoted</small>
              </div>

              <details className="swap-details">
                <summary><span>Funding details</span><strong>Separate custody <i>⌄</i></strong></summary>
                <div className="detail-rows">
                  <div><span>Usable Lightning</span><strong>{numberFormat(usableLightning)} sats</strong></div>
                  <div><span>Usable BIT</span><strong>{numberFormat(usableBit, 2)} BIT</strong></div>
                  <div><span>Suggested first-fill cap</span><strong>{numberFormat(fillCap)} sats</strong></div>
                  <div><span>Live pricing</span><strong>Verified markets required</strong></div>
                  <div><span>Ownership</span><strong>One solver only</strong></div>
                  <div><span>LP shares / APY</span><strong>None</strong></div>
                </div>
              </details>

              <button
                type="button"
                className="primary-action"
                disabled={lightningReserve <= 0 || bitReserve <= 0}
                onClick={() => setPoolReceipt(true)}
              >
                Preview solver capacity <span>→</span>
              </button>
              {poolReceipt && (
                <div className="funding-receipt" role="status">
                  <span><b>1</b> Verify node identity and Lightning limit</span>
                  <span><b>2</b> Deposit BIT into your solver vault account</span>
                  <span><b>3</b> Activate quotes after both balances reconcile</span>
                  <small>Preview only. No deposit, wallet, or node action occurred.</small>
                </div>
              )}
            </div>
          )}
        </section>

        <div className="trade-trust" aria-label="Swap guarantees">
          <span><i>✓</i> Invoice-first</span>
          <span><i>✓</i> Competing solver quotes</span>
          <span><i>✓</i> Swaps simulated</span>
          <span><i>✓</i> Sends use your wallet</span>
        </div>
      </section>

      <section className="mechanism" id="mechanism">
        <div className="section-heading">
          <p className="eyebrow">HOW IT WORKS</p>
          <h2>Invoice in. Quote out.</h2>
          <p>There is no shared public liquidity pool. Independent solvers compete to fill a signed request.</p>
        </div>
        <div className="mechanism-grid">
          <article><span>01</span><h3>Paste or create</h3><p>Bring an invoice to pay with BIT, or create one to receive BIT.</p></article>
          <article><span>02</span><h3>Pick a quote</h3><p>Compare short-lived, all-in prices for the exact invoice amount.</p></article>
          <article><span>03</span><h3>Pay once</h3><p>One payment hash binds the invoice and BIT escrow—or timeout returns the funds.</p></article>
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

      <footer>
        <Link href="/" className="brand footer-brand"><span className="brand-mark" aria-hidden="true"><i /><b>ϟ</b></span><span>treeswap</span></Link>
        <p>Competitive swaps between Bitcoin Lightning and Bittrees BIT.</p>
        <span><a href="https://github.com/bobofbuilding/treeswap" target="_blank" rel="noreferrer">Open-source prototype</a> · MIT</span>
      </footer>

      {intentOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setIntentOpen(false)}>
          <section ref={intentModalRef} className="intent-modal" role="dialog" aria-modal="true" aria-labelledby="intent-title" onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close" onClick={() => setIntentOpen(false)} aria-label="Close simulation">×</button>
            <span className="modal-kicker">TWO CONFIRMATIONS · PROTOTYPE</span>
            <h2 id="intent-title">
              {!paymentStarted
                ? confirmationStep === 1
                  ? "Reserve this quote."
                  : "Authorize the exact invoice."
                : intentPhase >= intentSteps.length
                  ? "Invoice settled."
                  : "Following the payment hash…"}
            </h2>
            <p>
              {isPayInvoice
                ? `${numberFormat(displayInput, 6)} BIT pays a ${numberFormat(desiredOutput)} sat invoice.`
                : `${numberFormat(displayInput)} sats releases ${numberFormat(desiredOutput, 2)} BIT.`}
            </p>

            {!paymentStarted ? (
              <>
                <div className="confirmation-progress" aria-label={`Confirmation ${confirmationStep} of 2`}>
                  <span className={confirmationStep === 1 ? "active" : "complete"}><i>{confirmationStep === 1 ? "1" : "✓"}</i> Quote</span>
                  <b />
                  <span className={confirmationStep === 2 ? "active" : ""}><i>2</i> Invoice</span>
                </div>

                {confirmationStep === 1 ? (
                  <>
                    {isPayInvoice && (
                      <InvoiceQr
                        key={normalizeBolt11(invoice)}
                        invoice={normalizeBolt11(invoice)}
                        label="Invoice to be paid"
                      />
                    )}
                    <div className="authorization-card" role="note">
                      <span>CONFIRMATION 1 OF 2</span>
                      <h3>Reserve this quote</h3>
                      <p>A live wallet signs the selected solver, complete received quote set, recipient, exact amounts, invoice commitment, and short expiry.</p>
                      <strong>No funds move. This only reserves capacity and permits private finalization.</strong>
                    </div>
                    <div className="checkout-rows">
                      <div><span>Selected solver</span><strong>{activeOffer.name}</strong></div>
                      <div><span>You pay</span><strong>{isPayInvoice ? `${numberFormat(displayInput, 6)} BIT` : `${numberFormat(displayInput)} sats`}</strong></div>
                      <div><span>You receive</span><strong>{isPayInvoice ? `${numberFormat(desiredOutput)} sats` : `${numberFormat(desiredOutput, 6)} BIT`}</strong></div>
                      <div><span>Maximum BIT fee</span><strong>{feeLabel}</strong></div>
                      <div><span>Invoice binding</span><strong>{isPayInvoice ? "Bound now" : "Added in confirmation 2"}</strong></div>
                    </div>
                    <div className="checkout-warning">
                      Prototype preview only. This screen does not open a wallet, reserve capacity, lock BIT, create an invoice, or move funds.
                    </div>
                    <button type="button" className="primary-action" onClick={() => setConfirmationStep(2)}>
                      Review exact invoice <span>→</span>
                    </button>
                  </>
                ) : (
                  <>
                    <InvoiceQr
                      key={isPayInvoice ? normalizeBolt11(invoice) : generatedInvoice}
                      invoice={isPayInvoice ? normalizeBolt11(invoice) : generatedInvoice}
                      label={isPayInvoice ? "Exact invoice to be paid" : "Exact invoice to pay"}
                      prototype={!isPayInvoice}
                    />
                    <div className="authorization-card final" role="note">
                      <span>CONFIRMATION 2 OF 2</span>
                      <h3>Authorize this exact invoice</h3>
                      <p>A live wallet signs the finalized executable quote, payment hash, invoice digest, recipient, solver, exact amounts, and expiry.</p>
                      <strong>Any changed invoice, hash, amount, solver, recipient, or expiry requires a new confirmation.</strong>
                    </div>
                    <div className="checkout-rows">
                      <div><span>Selected solver</span><strong>{activeOffer.name}</strong></div>
                      <div><span>Invoice amount</span><strong>{numberFormat(isPayInvoice ? desiredOutput : displayInput)} sats</strong></div>
                      <div><span>BIT amount</span><strong>{numberFormat(isPayInvoice ? displayInput : desiredOutput, 6)} BIT</strong></div>
                      <div><span>BIT fee</span><strong>{feeLabel}</strong></div>
                    </div>
                    <div className="hash-card full-hash-card">
                      <span>Exact payment hash</span><code>{DEMO_PAYMENT_HASH}</code>
                    </div>
                    <div className="checkout-warning">
                      Prototype preview only. A live flow must fully verify the BOLT 11 checksum, signature, expiry, network, amount, features, and payment hash before this wallet request appears.
                    </div>
                    <p className="checkout-account-note">This second signature is not a token allowance. Email delivery is disabled during the prototype.</p>
                    <button
                      type="button"
                      className="primary-action"
                      onClick={() => { setIntentPhase(0); setPaymentStarted(true); }}
                    >
                      Simulate final confirmation <span>→</span>
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="intent-path" aria-label="Invoice settlement progress">
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
                  <div className="settling-line"><i /> Simulating invoice settlement</div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
