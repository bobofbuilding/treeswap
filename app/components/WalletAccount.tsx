"use client";

import { useEffect, useState } from "react";
import { buildSiweMessage } from "@/lib/account.mjs";
import { sanitizeDisplayText } from "@/lib/untrusted-text.mjs";
import type { EthereumProvider } from "@/types/wallets";

type NotificationPreferences = {
  email: string;
  invoiceEmails: boolean;
  receiptEmails: boolean;
  verificationStatus: "pending" | "verified";
  retentionExpiresAt: string;
};

type Session = {
  walletAddress: string;
  chainId: number;
  expiresAt: string;
  notifications: NotificationPreferences | null;
};

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "The request could not be completed.");
  return body;
}

export default function WalletAccount() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [accountReady, setAccountReady] = useState(true);
  const [working, setWorking] = useState(false);
  const [email, setEmail] = useState("");
  const [invoiceEmails, setInvoiceEmails] = useState(true);
  const [receiptEmails, setReceiptEmails] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function applySession(nextSession: Session | null) {
    setSession(nextSession);
    if (nextSession?.notifications) {
      setEmail(nextSession.notifications.email);
      setInvoiceEmails(nextSession.notifications.invoiceEmails);
      setReceiptEmails(nextSession.notifications.receiptEmails);
    }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => readJson<{ session: Session | null }>(response))
      .then(({ session: nextSession }) => {
        if (active) applySession(nextSession);
      })
      .catch(() => setAccountReady(false))
      .finally(() => {
        if (active) setLoadingSession(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  async function signIn() {
    setWorking(true);
    setError("");
    setNotice("");

    try {
      const wallet = window.ethereum as EthereumProvider | undefined;
      if (!wallet) throw new Error("Install or open an Ethereum wallet to continue.");

      const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0];
      if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new Error("The wallet did not return a valid address.");

      let chainId = (await wallet.request({ method: "eth_chainId" })) as string;
      if (chainId !== "0x1") {
        await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
        chainId = (await wallet.request({ method: "eth_chainId" })) as string;
      }
      if (chainId !== "0x1") throw new Error("Switch the wallet to Ethereum mainnet.");

      const nonceResponse = await fetch("/api/auth/nonce", { cache: "no-store" });
      const challenge = await readJson<{
        nonce: string;
        domain: string;
        uri: string;
        expiresAt: string;
      }>(nonceResponse);
      const issuedAt = new Date().toISOString();
      const message = buildSiweMessage({
        domain: challenge.domain,
        address,
        uri: challenge.uri,
        nonce: challenge.nonce,
        issuedAt,
        expiresAt: challenge.expiresAt,
      });
      const signature = (await wallet.request({
        method: "personal_sign",
        params: [message, address],
      })) as string;
      const [signedAccount] = (await wallet.request({ method: "eth_accounts" })) as string[];
      const signedChainId = (await wallet.request({ method: "eth_chainId" })) as string;
      if (signedAccount?.toLowerCase() !== address.toLowerCase() || signedChainId !== "0x1") {
        throw new Error("The wallet account or network changed while signing. Start again.");
      }

      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      const { session: nextSession } = await readJson<{ session: Session }>(verifyResponse);
      applySession(nextSession);
      setNotice("Wallet verified. No transaction was submitted.");
    } catch (cause) {
      setError(sanitizeDisplayText(cause instanceof Error ? cause.message : "Wallet sign-in was cancelled.", { maxLength: 240 }));
    } finally {
      setWorking(false);
      setLoadingSession(false);
    }
  }

  async function saveNotifications() {
    setWorking(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, invoiceEmails, receiptEmails }),
      });
      const { notifications } = await readJson<{ notifications: NotificationPreferences }>(response);
      setSession((current) => (current ? { ...current, notifications } : current));
      setNotice("Email attached for 24 hours. Delivery is disabled in this build.");
    } catch (cause) {
      setError(sanitizeDisplayText(cause instanceof Error ? cause.message : "Email preferences could not be saved.", { maxLength: 240 }));
    } finally {
      setWorking(false);
    }
  }

  async function detachEmail() {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/notifications", { method: "DELETE" });
      await readJson<{ notifications: null }>(response);
      setSession((current) => (current ? { ...current, notifications: null } : current));
      setEmail("");
      setNotice("Email detached from this wallet account.");
    } catch (cause) {
      setError(sanitizeDisplayText(cause instanceof Error ? cause.message : "The email could not be detached.", { maxLength: 240 }));
    } finally {
      setWorking(false);
    }
  }

  async function signOut() {
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/auth/session", { method: "DELETE" });
      await readJson<{ session: null }>(response);
      setSession(null);
      setEmail("");
      setNotice("");
      setOpen(false);
    } catch (cause) {
      setError(sanitizeDisplayText(cause instanceof Error ? cause.message : "Sign-out could not be completed.", { maxLength: 240 }));
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="account-button"
        onClick={() => setOpen(true)}
        disabled={!accountReady}
        title={accountReady ? "Open TreeSwap account" : "Account storage is unavailable on this preview"}
      >
        <span /> {loadingSession ? "Account" : !accountReady ? "Account preview" : session ? shortAddress(session.walletAddress) : "Sign in"}
      </button>

      {open && (
        <div className="account-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            className="account-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" className="modal-close" onClick={() => setOpen(false)} aria-label="Close account">
              ×
            </button>
            <p className="modal-kicker">TREESWAP ACCOUNT</p>
            <h2 id="account-title">{session ? "Wallet verified." : "Sign in with Ethereum."}</h2>

            {!session ? (
              <>
                <p>Sign one readable message to prove this wallet is yours. No transaction, approval, or gas is required.</p>
                <div className="signin-assurances">
                  <span><i>✓</i> Ethereum mainnet</span>
                  <span><i>✓</i> One-time nonce</span>
                  <span><i>✓</i> 24-hour session</span>
                </div>
                <button type="button" className="primary-action" onClick={signIn} disabled={working}>
                  {working ? "Waiting for wallet…" : "Sign in with Ethereum"} <span>→</span>
                </button>
                <p className="account-fineprint">The signed message cannot move funds. TreeSwap verifies its domain, nonce, chain, expiry, and wallet signature.</p>
              </>
            ) : (
              <>
                <div className="wallet-identity">
                  <span><i /> Ethereum mainnet</span>
                  <strong>{shortAddress(session.walletAddress)}</strong>
                </div>

                <div className="notification-settings">
                  <div className="settings-heading">
                    <div><span>OPTIONAL EMAIL</span><h3>Send me swap updates.</h3></div>
                    {session.notifications && <small>{session.notifications.verificationStatus}</small>}
                  </div>
                  <label className="email-field" htmlFor="account-email">
                    Email address
                    <input
                      id="account-email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value.slice(0, 254))}
                      placeholder="you@example.com"
                    />
                  </label>
                  <label className="preference-row">
                    <span><strong>Invoice notices</strong><small>Invoice created, expiring, or settled</small></span>
                    <input type="checkbox" checked={invoiceEmails} onChange={(event) => setInvoiceEmails(event.target.checked)} />
                  </label>
                  <label className="preference-row">
                    <span><strong>Transaction receipts</strong><small>BIT reservation, claim, or refund</small></span>
                    <input type="checkbox" checked={receiptEmails} onChange={(event) => setReceiptEmails(event.target.checked)} />
                  </label>
                  <p className="privacy-note">Email stays offchain and can be detached at any time. Delivery is disabled, and an unverified address is automatically deleted after 24 hours.</p>
                  <button type="button" className="primary-action" onClick={saveNotifications} disabled={working}>
                    {working ? "Saving…" : session.notifications ? "Update email preferences" : "Attach email"} <span>→</span>
                  </button>
                  {session.notifications && (
                    <button type="button" className="text-action" onClick={detachEmail} disabled={working}>Detach email</button>
                  )}
                </div>

                <button type="button" className="signout-action" onClick={signOut} disabled={working}>Sign out</button>
              </>
            )}

            <div className="account-message" aria-live="polite">
              {error && <span className="error">{error}</span>}
              {!error && notice && <span>{notice}</span>}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
