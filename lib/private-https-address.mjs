import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateLndHostname } from "./lnd-rest-client.mjs";

export async function resolvePinnedPrivateAddress(hostname, lookupImpl = dnsLookup) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!isPrivateLndHostname(host)) {
    throw new Error("private HTTPS target hostname is not private");
  }
  if (typeof lookupImpl !== "function") {
    throw new TypeError("private HTTPS DNS resolver is invalid");
  }
  const literalFamily = isIP(host);
  const resolved = literalFamily === 0
    ? await lookupImpl(host, { all: true, verbatim: true })
    : [{ address: host, family: literalFamily }];
  if (!Array.isArray(resolved) || resolved.length === 0) {
    throw new Error("private HTTPS target did not resolve");
  }
  const normalized = resolved.map((entry) => Object.freeze({
    address: String(entry?.address ?? "").toLowerCase().replace(/^\[|\]$/g, ""),
    family: Number(entry?.family),
  }));
  if (normalized.some((entry) => (entry.family !== 4 && entry.family !== 6)
      || isIP(entry.address) !== entry.family || !isPrivateLndHostname(entry.address))) {
    throw new Error("private HTTPS target resolved outside the private network");
  }
  return normalized[0];
}

export function privateHttpsServername(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return isIP(host) === 0 ? host : undefined;
}
