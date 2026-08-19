import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { id } from "ethers";
import { LightningActionJournal } from "../lib/lightning-action-journal.mjs";

const NOW = 2_000_000_000;

function reservation(requestId = id("journal-request").toLowerCase()) {
  return {
    requestId,
    method: "/routerrpc.Router/SendPaymentV2",
    intentDigest: id("journal-intent").toLowerCase(),
    paymentHash: id("journal-payment").toLowerCase(),
    amountSats: "10000",
    countsExposure: true,
    recordedAt: NOW,
  };
}

test("durably reserves before completion and rejects replay after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-journal-"));
  const path = join(directory, "actions.jsonl");
  const journal = await LightningActionJournal.open(path);
  const request = reservation();
  await journal.reserve(request);
  await journal.complete(request.requestId, "succeeded", NOW + 1, "payment-succeeded");

  const reopened = await LightningActionJournal.open(path);
  assert.equal(reopened.has(request.requestId), true);
  assert.equal(reopened.state(request.requestId), "succeeded");
  await assert.rejects(() => reopened.reserve(request), /already used/);
  assert.equal(reopened.usageForUtcDay(NOW + 10).dailyValueSats, 10_000n);
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);
});

test("counts unknown dispatches conservatively and does not double-count settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-journal-"));
  const journal = await LightningActionJournal.open(join(directory, "actions.jsonl"));
  const payment = reservation(id("unknown-payment").toLowerCase());
  await journal.reserve(payment);
  assert.equal(journal.hasExposurePaymentHash(payment.paymentHash), true);
  await journal.complete(payment.requestId, "unknown", NOW + 1, "transport-ambiguous");
  const settlement = {
    ...reservation(id("settlement").toLowerCase()),
    method: "/invoicesrpc.Invoices/SettleInvoice",
    countsExposure: false,
  };
  await journal.reserve(settlement);
  await journal.complete(settlement.requestId, "succeeded", NOW + 2, "invoice-settled");
  assert.equal(journal.usageForUtcDay(NOW + 10).dailyValueSats, 10_000n);
});

test("serializes concurrent duplicate reservations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-journal-"));
  const journal = await LightningActionJournal.open(join(directory, "actions.jsonl"));
  const results = await Promise.allSettled([journal.reserve(reservation()), journal.reserve(reservation())]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
});
