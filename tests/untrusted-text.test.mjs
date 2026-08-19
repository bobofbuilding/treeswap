import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRelaySource,
  escapeHtmlText,
  safeAuditLine,
  sanitizeDisplayText,
  sanitizeInvoiceMemo,
  sanitizeSolverLabel,
  sanitizeTokenLabel,
} from "../lib/untrusted-text.mjs";

test("bounds and normalizes untrusted display labels without interpreting markup", () => {
  assert.equal(sanitizeSolverLabel("  Rootline\n<script>alert(1)</script>  "), "Rootline <script>alert(1)</script>");
  assert.equal(sanitizeSolverLabel("\u202eSolver"), "Solver");
  assert.equal(sanitizeSolverLabel(""), "Unnamed solver");
  assert.equal(Array.from(sanitizeInvoiceMemo("x".repeat(10_000))).length, 280);
  assert.equal(sanitizeTokenLabel("ＢＩＴ"), "BIT");
  assert.equal(sanitizeDisplayText("a\u0000b\u200bc"), "abc");
});

test("escapes text for the exceptional case of server-built HTML", () => {
  assert.equal(
    escapeHtmlText('<img src=x onerror="steal()">', { maxLength: 100 }),
    "&lt;img src=x onerror=&quot;steal()&quot;&gt;",
  );
});

test("serializes audit records as one JSON line despite forged log content", () => {
  const line = safeAuditLine("quote\naccepted", { solver: "Rootline\r\nadmin=true", memo: "\u202efake" });
  assert.equal(line.split("\n").length, 1);
  assert.deepEqual(JSON.parse(line), {
    event: "quote accepted",
    solver: "Rootline admin=true",
    memo: "fake",
  });
});

test("rejects rather than silently canonicalizing signed relay identifiers", () => {
  assert.equal(canonicalRelaySource("relay-a"), "relay-a");
  for (const source of ["Relay-A", " relay-a", "relay/a", "relay\nadmin", "\u202erelay-a", "a".repeat(65)]) {
    assert.throws(() => canonicalRelaySource(source), /invalid quote source/);
  }
});
