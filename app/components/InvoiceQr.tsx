"use client";

import { useEffect, useRef, useState } from "react";

type InvoiceQrProps = {
  invoice: string;
  label: string;
  prototype?: boolean;
};

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Copy is unavailable in this browser.");
}

export default function InvoiceQr({ invoice, label, prototype = false }: InvoiceQrProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [qrError, setQrError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    let active = true;

    async function renderQr() {
      try {
        const QRCode = (await import("qrcode")).default;
        if (!active || !canvasRef.current) return;
        await QRCode.toCanvas(canvasRef.current, `lightning:${invoice}`, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 252,
          color: {
            dark: "#0b2e20ff",
            light: "#ffffffff",
          },
        });
      } catch {
        if (active) setQrError("This invoice is too long to show as a QR code. Copy it instead.");
      }
    }

    void renderQr();
    return () => {
      active = false;
    };
  }, [invoice]);

  async function copyInvoice() {
    try {
      await copyText(invoice);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <div className="invoice-qr-card">
      <div className="invoice-qr-heading">
        <span>{label}</span>
        {prototype && <b>PROTOTYPE</b>}
      </div>

      <div className={`invoice-qr-frame ${qrError ? "error" : ""}`}>
        {qrError ? (
          <p role="alert">{qrError}</p>
        ) : (
          <canvas ref={canvasRef} width={252} height={252} role="img" aria-label="QR code for the Lightning invoice" />
        )}
      </div>
      <p className="invoice-qr-instruction">Scan with a Lightning wallet</p>

      <div className="invoice-copy-box">
        <div>
          <span>Complete BOLT 11 invoice</span>
          <code title={invoice}>{invoice}</code>
        </div>
        <button type="button" onClick={copyInvoice} aria-live="polite">
          {copyState === "copied" ? "Copied ✓" : copyState === "error" ? "Copy failed" : "Copy invoice"}
        </button>
      </div>
    </div>
  );
}
