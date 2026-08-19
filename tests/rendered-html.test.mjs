import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the TreeSwap prototype", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>TreeSwap \| Pay Lightning Invoices with BIT<\/title>/i);
  assert.match(html, /Swap through an invoice/);
  assert.match(html, />Swap</);
  assert.match(html, />Pay</);
  assert.match(html, />Earn</);
  assert.match(html, /Receive BIT/);
  assert.match(html, /Review invoice payment/);
  assert.match(html, /Best received of .*signed quotes/);
  assert.match(html, /1 BIT = 100 sats/);
  assert.match(html, /Swap prototype · Sends use your wallet/);
  assert.match(html, /Sends use your wallet/);
  assert.match(html, /Invoice in\. Quote out/i);
  assert.match(html, /There is no shared public liquidity pool/i);
  assert.match(html, /Escrow harness tested/i);
  assert.match(html, /Swaps simulated/i);
  assert.match(html, />Safety</i);
  assert.doesNotMatch(html, /Four checks block launch|security-section/i);
  assert.match(html, /application\/ld\+json/i);
  assert.match(html, /href="https:\/\/treeswap\.vercel\.app\/favicon\.png"/i);
  assert.match(html, /href="https:\/\/treeswap\.vercel\.app\/apple-touch-icon\.png"/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("keeps swaps non-production and direct sends explicitly wallet-authorized", async () => {
  const [page, invoiceQr, sendPanel, sendLogic, account, authServer, authVerify, layout, manifest, nextConfig, staticHeaders, inputHandling, readme, protocol, threatModel, vault, license] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/InvoiceQr.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SendPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/send.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/components/WalletAccount.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/siwe-server.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/verify/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/manifest.ts", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
    readFile(new URL("../docs/INPUT_HANDLING.md", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/PROTOCOL.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/THREAT_MODEL.md", import.meta.url), "utf8"),
    readFile(new URL("../contracts/src/TreeSwapBitVault.sol", import.meta.url), "utf8"),
    readFile(new URL("../LICENSE", import.meta.url), "utf8"),
  ]);

  assert.match(page, /Swap prototype/);
  assert.match(page, /Simulation only/);
  assert.match(page, /Amountless invoices are not supported/);
  assert.match(page, /checksum, signature, expiry/);
  assert.match(page, /short-lived, all-in prices/i);
  assert.match(page, /No shared LP pool/i);
  assert.match(page, /No LP deposits/i);
  assert.match(page, /No deposit, wallet, or node action occurred/i);
  assert.match(page, /aria-label="TreeSwap tools"[\s\S]*?>\s*Swap\s*<\/button>[\s\S]*?>\s*Pay\s*<\/button>[\s\S]*?>\s*Earn\s*<\/button>/);
  assert.match(page, /aria-label="Swap direction"/);
  assert.match(page, /<InvoiceQr/);
  assert.match(invoiceQr, /QRCode\.toCanvas/);
  assert.match(invoiceQr, /`lightning:\$\{invoice\}`/);
  assert.match(invoiceQr, /navigator\.clipboard/);
  assert.match(invoiceQr, /Copy invoice/);
  assert.match(invoiceQr, /Complete BOLT 11 invoice/);
  assert.match(layout, /metadataBase/);
  assert.match(layout, /canonical/);
  assert.match(layout, /og\.png/);
  assert.match(layout, /favicon\.png/);
  assert.match(layout, /apple-touch-icon\.png/);
  assert.match(manifest, /treeswap-neon-icon\.png/);
  assert.match(nextConfig, /Content-Security-Policy/);
  assert.match(nextConfig, /frame-ancestors 'none'/);
  assert.match(staticHeaders, /X-Content-Type-Options: nosniff/);
  assert.match(inputHandling, /never silently rewritten/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.match(account, /Sign in with Ethereum/);
  assert.match(account, /Attach email/);
  assert.match(account, /Delivery is disabled/i);
  assert.match(account, /automatically deleted after 24 hours/i);
  assert.match(sendPanel, /DIRECT SEND · REAL FUNDS/);
  assert.match(sendPanel, /Send from your wallet/);
  assert.match(sendPanel, /Direct sends are irreversible/);
  assert.match(sendPanel, /Sign-in is not used to authorize this payment/i);
  assert.match(sendPanel, /getFunction\("transfer"\)/);
  assert.doesNotMatch(sendPanel, /approve\(/);
  assert.match(sendPanel, /provider\.sendPayment\(checked\.invoice\)/);
  assert.match(sendPanel, /discarded the returned preimage/i);
  assert.match(sendPanel, /Check your Lightning wallet before trying again/i);
  assert.match(sendPanel, /validateBitTransactionResponse/);
  assert.match(sendLogic, /parseUnits/);
  assert.match(sendLogic, /zero address cannot receive BIT/i);
  assert.match(authVerify, /sameSite: "strict"/);
  assert.match(authServer, /SESSION_DURATION_SECONDS/);
  assert.match(readme, /never request an allowance/i);
  assert.match(protocol, /not audited and not ready for real funds/i);
  assert.match(protocol, /1 BIT = 100 sats/);
  assert.match(protocol, /There is no central limit order book/i);
  assert.match(protocol, /Amountless invoices remain unsupported/i);
  assert.match(protocol, /EIP-4361 Sign-In with Ethereum/i);
  assert.match(threatModel, /TS-C01 — Fixed-par inventory drain/);
  assert.match(threatModel, /TS-C04 — Relay can suppress or reorder quotes/);
  assert.match(threatModel, /TS-M10 — SIWE replay, phishing, or session theft/);
  assert.match(threatModel, /TS-M11 — Email correlation, spoofing, and unwanted delivery/);
  assert.match(vault, /SELECTED_QUOTE_TYPEHASH/);
  assert.match(vault, /maxPriceDeviationBps/);
  assert.match(vault, /lastSafeClaimAt/);
  assert.match(vault, /ClaimWindowClosed/);
  assert.doesNotMatch(page, /security-section|Four checks block launch/i);
  assert.match(license, /MIT License/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("docs/PROTOCOL.md", projectRoot));
});
