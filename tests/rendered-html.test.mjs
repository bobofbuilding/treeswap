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
  assert.match(html, /Review invoice payment/);
  assert.match(html, /Best received of .*signed quotes/);
  assert.match(html, /1 BIT = 100 sats/);
  assert.match(html, /No swaps execute · No real funds/);
  assert.match(html, /Invoice in\. Quote out/i);
  assert.match(html, /There is no shared public liquidity pool/i);
  assert.match(html, /Reverse escrow pending/i);
  assert.match(html, /Optional email receipts/i);
  assert.match(html, />Safety</i);
  assert.doesNotMatch(html, /Four checks block launch|security-section/i);
  assert.match(html, /application\/ld\+json/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("keeps the financial prototype explicitly non-production", async () => {
  const [page, account, authServer, authVerify, layout, readme, protocol, threatModel, vault, license] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/WalletAccount.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/siwe-server.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/verify/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/PROTOCOL.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/THREAT_MODEL.md", import.meta.url), "utf8"),
    readFile(new URL("../contracts/src/TreeSwapBitVault.sol", import.meta.url), "utf8"),
    readFile(new URL("../LICENSE", import.meta.url), "utf8"),
  ]);

  assert.match(page, /No real funds/);
  assert.match(page, /Simulation only/);
  assert.match(page, /Amountless invoices are not supported/);
  assert.match(page, /checksum, signature, expiry/);
  assert.match(page, /short-lived, all-in prices/i);
  assert.match(page, /No shared LP pool/i);
  assert.match(layout, /metadataBase/);
  assert.match(layout, /canonical/);
  assert.match(layout, /og\.png/);
  assert.match(account, /Sign in with Ethereum/);
  assert.match(account, /Attach email/);
  assert.match(account, /current prototype does not send messages/i);
  assert.match(authVerify, /sameSite: "strict"/);
  assert.match(authServer, /SESSION_DURATION_SECONDS/);
  assert.match(readme, /does not request token approvals/i);
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
