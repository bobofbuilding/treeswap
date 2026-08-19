import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";

test("renders a Lightning wallet QR for an amount-bearing invoice", async () => {
  const invoice = "lnbc2500u1qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const svg = await QRCode.toString(`lightning:${invoice}`, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
  });

  assert.match(svg, /^<svg/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /<path/);
});
