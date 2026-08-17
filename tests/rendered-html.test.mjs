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
  assert.match(html, /<title>TreeSwap — Lightning ↔ BIT intents<\/title>/i);
  assert.match(html, /Swap across the/);
  assert.match(html, /1 BIT = 100 sats/);
  assert.match(html, /No wallets connected · No real funds/);
  assert.match(html, /Price–time intent book/i);
  assert.match(html, /Four launch gates before real funds/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("keeps the financial prototype explicitly non-production", async () => {
  const [page, layout, readme, protocol, threatModel, license] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/PROTOCOL.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/THREAT_MODEL.md", import.meta.url), "utf8"),
    readFile(new URL("../LICENSE", import.meta.url), "utf8"),
  ]);

  assert.match(page, /No real funds/);
  assert.match(page, /Simulation only/);
  assert.match(page, /net output after every disclosed cost/i);
  assert.match(layout, /local prototype/i);
  assert.match(readme, /does not connect wallets/i);
  assert.match(protocol, /not audited and not ready for real funds/i);
  assert.match(protocol, /1 BIT = 100 sats/);
  assert.match(protocol, /DeepState's price-first, time-second/i);
  assert.match(threatModel, /TS-C01 — Fixed-par inventory drain/);
  assert.match(threatModel, /TS-C04 — Coordinator can misstate the best quote/);
  assert.match(license, /MIT License/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("docs/PROTOCOL.md", projectRoot));
});
