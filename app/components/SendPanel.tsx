"use client";

import { useEffect, useState } from "react";
import { BrowserProvider, Contract, formatUnits, getAddress } from "ethers";
import { hasMainnetBolt11Shape, parseBolt11AmountSats, sanitizeAmount } from "@/lib/product.mjs";
import { sanitizeDisplayText } from "@/lib/untrusted-text.mjs";
import {
  BIT_DECIMALS,
  prepareBitSend,
  prepareLightningSend,
} from "@/lib/send.mjs";
import type { EthereumProvider } from "@/types/wallets";

const BIT_CONTRACT = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";
const BIT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

type Asset = "bit" | "lightning";

type BitReview = {
  kind: "bit";
  sender: string;
  recipient: string;
  amountWei: bigint;
  displayAmount: string;
  balance: string;
};

type LightningReview = {
  kind: "lightning";
  invoice: string;
  amountSats: number;
};

type Review = BitReview | LightningReview;

type Receipt =
  | {
      kind: "bit";
      amount: string;
      recipient: string;
      transactionHash: string;
      confirmed: boolean;
    }
  | {
      kind: "lightning";
      amountSats: number;
      status: "paid" | "opened";
    };

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function explainWalletError(cause: unknown, fallback: string) {
  if (typeof cause === "object" && cause !== null) {
    const error = cause as { code?: number; message?: string; shortMessage?: string };
    if (error.code === 4001) return "The wallet request was cancelled.";
    if (error.shortMessage) return sanitizeDisplayText(error.shortMessage, { maxLength: 240 });
    if (error.message && !/internal json-rpc error/i.test(error.message)) {
      return sanitizeDisplayText(error.message, { maxLength: 240 });
    }
  }
  return fallback;
}

async function requireMainnet(wallet: EthereumProvider) {
  let chainId = (await wallet.request({ method: "eth_chainId" })) as string;
  if (chainId !== "0x1") {
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x1" }],
    });
    chainId = (await wallet.request({ method: "eth_chainId" })) as string;
  }
  if (chainId !== "0x1") throw new Error("Switch the wallet to Ethereum mainnet.");
}

export default function SendPanel() {
  const [asset, setAsset] = useState<Asset>("bit");
  const [bitAmount, setBitAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [invoice, setInvoice] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const invoiceAmount = hasMainnetBolt11Shape(invoice) ? parseBolt11AmountSats(invoice) : null;

  useEffect(() => {
    if (!review) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !sending) setReview(null);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [review, sending]);

  function selectAsset(nextAsset: Asset) {
    setAsset(nextAsset);
    setError("");
    setReceipt(null);
  }

  async function reviewBitSend() {
    setPreparing(true);
    setError("");
    setReceipt(null);

    try {
      const prepared = prepareBitSend(recipient, bitAmount);
      const wallet = window.ethereum;
      if (!wallet) throw new Error("Install or open an Ethereum wallet to send BIT.");

      await wallet.request({ method: "eth_requestAccounts" });
      await requireMainnet(wallet);

      const provider = new BrowserProvider(wallet);
      const signer = await provider.getSigner();
      const sender = getAddress(await signer.getAddress());
      if (sender === prepared.recipient) throw new Error("The sender and recipient are the same address.");

      const code = await provider.getCode(BIT_CONTRACT);
      if (code === "0x") throw new Error("The BIT contract was not found on Ethereum mainnet.");

      const token = new Contract(BIT_CONTRACT, BIT_ABI, provider);
      const [symbol, decimals, paused, balance] = await Promise.all([
        token.symbol() as Promise<string>,
        token.decimals() as Promise<bigint>,
        token.paused() as Promise<boolean>,
        token.balanceOf(sender) as Promise<bigint>,
      ]);

      if (symbol !== "BIT" || decimals !== BigInt(BIT_DECIMALS)) {
        throw new Error("The connected contract does not match the expected BIT token settings.");
      }
      if (paused) throw new Error("BIT transfers are currently paused by the token contract.");
      if (balance < prepared.amountWei) throw new Error("This wallet does not have enough BIT.");

      setReview({
        kind: "bit",
        sender,
        recipient: prepared.recipient,
        amountWei: prepared.amountWei,
        displayAmount: prepared.displayAmount,
        balance: formatUnits(balance, BIT_DECIMALS),
      });
    } catch (cause) {
      setError(explainWalletError(cause, "The BIT transfer could not be prepared."));
    } finally {
      setPreparing(false);
    }
  }

  function reviewLightningSend() {
    setError("");
    setReceipt(null);
    try {
      setReview({ kind: "lightning", ...prepareLightningSend(invoice) });
    } catch (cause) {
      setError(explainWalletError(cause, "The Lightning invoice could not be prepared."));
    }
  }

  async function sendBit(checked: BitReview) {
    setSending(true);
    setError("");

    try {
      const wallet = window.ethereum;
      if (!wallet) throw new Error("The Ethereum wallet is no longer available.");
      await requireMainnet(wallet);

      const provider = new BrowserProvider(wallet);
      const signer = await provider.getSigner();
      const currentSender = getAddress(await signer.getAddress());
      if (currentSender !== checked.sender) {
        throw new Error("The active wallet changed. Close this review and check the transfer again.");
      }

      const token = new Contract(BIT_CONTRACT, BIT_ABI, signer);
      const [symbol, decimals, paused, balance] = await Promise.all([
        token.symbol() as Promise<string>,
        token.decimals() as Promise<bigint>,
        token.paused() as Promise<boolean>,
        token.balanceOf(currentSender) as Promise<bigint>,
      ]);
      if (symbol !== "BIT" || decimals !== BigInt(BIT_DECIMALS) || paused) {
        throw new Error("BIT contract safety checks changed. The transfer was stopped.");
      }
      if (balance < checked.amountWei) throw new Error("The BIT balance changed and is now too low.");

      const transfers = token.getFunction("transfer");
      const simulation = (await transfers.staticCall(checked.recipient, checked.amountWei)) as boolean;
      if (simulation !== true) throw new Error("The BIT contract did not accept the transfer simulation.");
      await transfers.estimateGas(checked.recipient, checked.amountWei);

      const transaction = await transfers(checked.recipient, checked.amountWei);
      const transactionHash = transaction.hash as string;
      setReceipt({
        kind: "bit",
        amount: checked.displayAmount,
        recipient: checked.recipient,
        transactionHash,
        confirmed: false,
      });
      setReview(null);

      void transaction.wait(1).then(() => {
        setReceipt((current) =>
          current?.kind === "bit" && current.transactionHash === transactionHash
            ? { ...current, confirmed: true }
            : current,
        );
      }).catch(() => {
        // The explorer link remains the source of truth if confirmation tracking is interrupted.
      });
    } catch (cause) {
      setError(explainWalletError(cause, "The BIT transfer was not submitted."));
    } finally {
      setSending(false);
    }
  }

  async function sendLightning(checked: LightningReview) {
    setSending(true);
    setError("");

    try {
      const provider = window.webln;
      if (!provider) {
        setReceipt({ kind: "lightning", amountSats: checked.amountSats, status: "opened" });
        setReview(null);
        window.location.assign(`lightning:${checked.invoice}`);
        return;
      }

      await provider.enable();
      await provider.sendPayment(checked.invoice);
      setReceipt({ kind: "lightning", amountSats: checked.amountSats, status: "paid" });
      setReview(null);
    } catch (cause) {
      setError(explainWalletError(cause, "The Lightning payment was not completed."));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="send-view">
      <div className="send-heading">
        <div><span>DIRECT WALLET SEND</span><h2>Send from your wallet.</h2></div>
        <span className="live-funds-pill"><i /> Real funds</span>
      </div>

      <div className="send-asset-tabs" role="group" aria-label="Asset to send">
        <button type="button" className={asset === "bit" ? "active" : ""} aria-pressed={asset === "bit"} onClick={() => selectAsset("bit")}>
          <span className="asset-chip bit"><i>B</i>BIT</span>
        </button>
        <button type="button" className={asset === "lightning" ? "active" : ""} aria-pressed={asset === "lightning"} onClick={() => selectAsset("lightning")}>
          <span className="asset-chip btc"><i>₿</i>Lightning</span>
        </button>
      </div>

      {asset === "bit" ? (
        <>
          <div className="amount-panel send-amount-panel">
            <div className="panel-label"><label htmlFor="send-bit-amount">You send</label><span>From Ethereum wallet</span></div>
            <div className="amount-row">
              <input
                id="send-bit-amount"
                inputMode="decimal"
                value={bitAmount}
                onChange={(event) => { setBitAmount(sanitizeAmount(event.target.value).slice(0, 80)); setError(""); setReceipt(null); }}
                placeholder="0"
                aria-label="BIT amount to send"
              />
              <span className="asset-chip bit"><i>B</i>BIT</span>
            </div>
          </div>

          <div className="address-panel send-recipient-panel">
            <div className="invoice-label"><label htmlFor="send-bit-recipient">Ethereum recipient</label><span>Mainnet</span></div>
            <input
              id="send-bit-recipient"
              value={recipient}
              onChange={(event) => { setRecipient(event.target.value.trim().slice(0, 42)); setError(""); setReceipt(null); }}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="invoice-status"><i /><span>TreeSwap calls BIT transfer directly. It never requests an approval.</span></div>
          </div>

          <div className="send-facts">
            <div><span>Network</span><strong>Ethereum mainnet</strong></div>
            <div><span>TreeSwap fee</span><strong>None</strong></div>
          </div>

          <button type="button" className="primary-action" onClick={reviewBitSend} disabled={preparing || !bitAmount || !recipient}>
            {preparing ? "Checking wallet and BIT…" : "Review BIT send"} <span>→</span>
          </button>
        </>
      ) : (
        <>
          <div className="invoice-panel send-invoice-panel">
            <div className="invoice-label"><label htmlFor="send-lightning-invoice">Lightning invoice</label><span>Exact amount only</span></div>
            <textarea
              id="send-lightning-invoice"
              value={invoice}
              onChange={(event) => { setInvoice(event.target.value.slice(0, 4096)); setError(""); setReceipt(null); }}
              placeholder="Paste a mainnet BOLT 11 invoice (lnbc…)"
              rows={4}
              spellCheck={false}
            />
            <div className={`invoice-status ${invoice && !invoiceAmount ? "error" : ""}`}>
              <i />
              <span>
                {!invoice
                  ? "Paste the recipient's payable invoice."
                  : invoiceAmount
                    ? `${invoiceAmount.toLocaleString("en-US")} sats encoded. Your wallet performs final validation.`
                    : "Use an amount-bearing mainnet invoice. Lightning addresses are not resolved yet."}
              </span>
            </div>
          </div>

          <div className="send-facts">
            <div><span>Invoice amount</span><strong>{invoiceAmount ? `${invoiceAmount.toLocaleString("en-US")} sats` : "Required"}</strong></div>
            <div><span>TreeSwap fee</span><strong>None</strong></div>
          </div>

          <button type="button" className="primary-action" onClick={reviewLightningSend} disabled={!invoice || !invoiceAmount}>
            Review Lightning payment <span>→</span>
          </button>
        </>
      )}

      <p className="send-warning">Direct sends are irreversible and do not use TreeSwap solvers, bridge liquidity, or swap protections. Verify the destination in your wallet.</p>

      {error && <p className="send-error" role="alert">{error}</p>}

      {receipt?.kind === "bit" && (
        <div className="send-receipt" role="status">
          <span className={receipt.confirmed ? "confirmed" : "pending"}>{receipt.confirmed ? "Confirmed" : "Submitted"}</span>
          <strong>{receipt.amount} BIT sent to {shortAddress(receipt.recipient)}</strong>
          <a href={`https://etherscan.io/tx/${receipt.transactionHash}`} target="_blank" rel="noreferrer">View transaction ↗</a>
        </div>
      )}

      {receipt?.kind === "lightning" && (
        <div className="send-receipt" role="status">
          <span className={receipt.status === "paid" ? "confirmed" : "pending"}>{receipt.status === "paid" ? "Wallet reports paid" : "Wallet opened"}</span>
          <strong>{receipt.amountSats.toLocaleString("en-US")} sat invoice</strong>
          <small>{receipt.status === "paid" ? "The payment preimage was not stored by TreeSwap." : "Return after paying; opening an invoice is not proof of payment."}</small>
        </div>
      )}

      {review && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!sending) setReview(null); }}>
          <section className="intent-modal send-modal" role="dialog" aria-modal="true" aria-labelledby="send-review-title" onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close" onClick={() => setReview(null)} aria-label="Close send review" disabled={sending}>×</button>
            <span className="modal-kicker">DIRECT SEND · REAL FUNDS</span>
            <h2 id="send-review-title">Check it once more.</h2>
            <p>Your wallet provides the final confirmation. Sign-in is not used to authorize this payment.</p>

            {review.kind === "bit" ? (
              <>
                <div className="checkout-rows send-review-rows">
                  <div><span>You send</span><strong>{review.displayAmount} BIT</strong></div>
                  <div><span>From</span><strong title={review.sender}>{shortAddress(review.sender)}</strong></div>
                  <div><span>To</span><strong className="full-review-address">{review.recipient}</strong></div>
                  <div><span>Available</span><strong>{review.balance} BIT</strong></div>
                  <div><span>Network</span><strong>Ethereum mainnet</strong></div>
                  <div><span>Token</span><strong title={BIT_CONTRACT}>{shortAddress(BIT_CONTRACT)}</strong></div>
                </div>
                <div className="checkout-warning send-live-warning">This transfer is irreversible. Check the full recipient address in your wallet. Network gas is paid in ETH.</div>
                {error && <p className="send-error" role="alert">{error}</p>}
                <button type="button" className="primary-action" onClick={() => sendBit(review)} disabled={sending}>
                  {sending ? "Waiting for wallet…" : `Send ${review.displayAmount} BIT`} <span>→</span>
                </button>
              </>
            ) : (
              <>
                <div className="invoice-code-card send-invoice-review">
                  <span>Invoice passed to your wallet</span>
                  <code>{review.invoice}</code>
                </div>
                <div className="checkout-rows send-review-rows">
                  <div><span>You pay</span><strong>{review.amountSats.toLocaleString("en-US")} sats</strong></div>
                  <div><span>Network</span><strong>Bitcoin mainnet</strong></div>
                  <div><span>TreeSwap fee</span><strong>None</strong></div>
                </div>
                <div className="checkout-warning send-live-warning">Lightning payments are irreversible. Your wallet must validate the invoice and show the same amount before you approve it.</div>
                {error && <p className="send-error" role="alert">{error}</p>}
                <button type="button" className="primary-action" onClick={() => sendLightning(review)} disabled={sending}>
                  {sending ? "Waiting for Lightning wallet…" : `Pay ${review.amountSats.toLocaleString("en-US")} sats`} <span>→</span>
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
