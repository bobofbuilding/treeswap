import { X509Certificate, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const HEX32 = /^0x[0-9a-f]{64}$/;
const TERMINAL_PAYMENT_STATES = new Set(["SUCCEEDED", "FAILED"]);

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function hex32ToBase64(value, name) {
  if (!HEX32.test(String(value ?? ""))) throw new TypeError(`${name} must be lowercase bytes32`);
  return Buffer.from(value.slice(2), "hex").toString("base64");
}

export function bytes32PathSegment(value, name = "value") {
  if (!HEX32.test(String(value ?? ""))) throw new TypeError(`${name} must be lowercase bytes32`);
  return Buffer.from(value.slice(2), "hex")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function pemFingerprint(pem) {
  return `sha256:${new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase()}`;
}

function sanitizePath(path) {
  const value = String(path ?? "");
  if (!value.startsWith("/") || value.includes("\n") || value.includes("\r")) throw new TypeError("LND path is invalid");
  return value;
}

function rpcLabel(method, path) {
  const pathname = path.split("?", 1)[0];
  if (pathname.startsWith("/v1/payreq/")) return `${method} /v1/payreq/[redacted]`;
  if (pathname.startsWith("/v2/router/track/")) return `${method} /v2/router/track/[redacted]`;
  return `${method} ${pathname}`;
}

export function isPrivateLndHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) {
    const [first, second] = host.split(".").map(Number);
    return first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (family === 6) return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return /^[a-z0-9-]+$/.test(host)
    || host.endsWith(".internal")
    || host.endsWith(".local")
    || host.endsWith(".svc.cluster.local");
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`LND returned malformed ${label}`);
  }
}

export class LndRestError extends Error {
  constructor(message, { httpStatus = null, grpcCode = null, ambiguous = false } = {}) {
    super(message);
    this.name = "LndRestError";
    this.httpStatus = httpStatus;
    this.grpcCode = grpcCode;
    this.ambiguous = ambiguous;
  }
}

export function unwrapLndStreamFrame(frame, { requestLabel = "stream RPC", errorAmbiguous = true } = {}) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new LndRestError(`LND returned a malformed ${requestLabel} frame`, { ambiguous: errorAmbiguous });
  }
  if (Object.hasOwn(frame, "error")) {
    const parsedCode = Number(frame.error?.code);
    const grpcCode = Number.isInteger(parsedCode) ? parsedCode : null;
    throw new LndRestError(`LND rejected ${requestLabel}`, { grpcCode, ambiguous: errorAmbiguous });
  }
  return frame.result ?? frame;
}

export class LndRestClient {
  #baseUrl;
  #macaroonHex;
  #tlsCert;
  #fingerprint;
  #request;
  #maximumResponseBytes;

  constructor({ baseUrl, macaroonHex, tlsCert, expectedCertificateFingerprint, requestImpl, maximumResponseBytes }) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") throw new TypeError("LND REST URL must use HTTPS");
    if (url.username || url.password || url.search || url.hash) throw new TypeError("LND REST URL must not contain credentials or query data");
    if (!isPrivateLndHostname(url.hostname)) throw new TypeError("LND REST URL must target an explicitly private hostname");
    this.#baseUrl = url;
    this.#macaroonHex = macaroonHex;
    this.#tlsCert = tlsCert;
    this.#fingerprint = pemFingerprint(tlsCert);
    if (this.#fingerprint !== expectedCertificateFingerprint) throw new Error("configured LND certificate pin does not match the credential bundle");
    this.#request = requestImpl ?? httpsRequest;
    this.#maximumResponseBytes = integer(maximumResponseBytes ?? 1_048_576, "maximumResponseBytes", 8_388_608);
  }

  static async create({ baseUrl, macaroonPath, tlsCertPath, expectedCertificateFingerprint, requestImpl, maximumResponseBytes }) {
    const [macaroon, tlsCert, macaroonStat] = await Promise.all([
      readFile(macaroonPath),
      readFile(tlsCertPath),
      stat(macaroonPath),
    ]);
    if (macaroon.length === 0 || macaroon.length > 65_536) throw new Error("LND macaroon file has an unsafe size");
    if ((macaroonStat.mode & 0o077) !== 0) throw new Error("LND macaroon file must not be group/world accessible");
    return new LndRestClient({
      baseUrl,
      macaroonHex: macaroon.toString("hex"),
      tlsCert,
      expectedCertificateFingerprint,
      requestImpl,
      maximumResponseBytes,
    });
  }

  get certificateFingerprint() {
    return this.#fingerprint;
  }

  get privateNetworkVerified() {
    return true;
  }

  #call(path, {
    method = "GET",
    body = null,
    timeoutMs = 10_000,
    stream = false,
    firstStreamValue = false,
    errorAmbiguous = false,
    streamErrorAmbiguous = errorAmbiguous,
  } = {}) {
    const safePath = sanitizePath(path);
    const requestLabel = rpcLabel(method, safePath);
    const timeout = integer(timeoutMs, "timeoutMs", 120_000);
    const url = new URL(safePath, this.#baseUrl);
    const serializedBody = body === null ? null : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      let received = 0;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        callback(value);
      };
      const req = this.#request(url, {
        method,
        ca: this.#tlsCert,
        rejectUnauthorized: true,
        headers: {
          "content-type": "application/json",
          "grpc-metadata-macaroon": this.#macaroonHex,
          ...(serializedBody === null ? {} : { "content-length": Buffer.byteLength(serializedBody) }),
        },
      }, (response) => {
        let buffer = "";
        let lastStreamValue = null;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (settled) return;
          try {
            received += Buffer.byteLength(chunk);
            if (received > this.#maximumResponseBytes) {
              throw new Error("LND response exceeded the configured limit");
            }
            buffer += chunk;
            if (stream) {
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines.filter(Boolean)) {
                lastStreamValue = unwrapLndStreamFrame(parseJson(line, "stream data"), {
                  requestLabel,
                  errorAmbiguous: streamErrorAmbiguous,
                });
                if (firstStreamValue) {
                  finish(resolve, lastStreamValue);
                  response.destroy();
                  return;
                }
              }
            }
          } catch (error) {
            response.destroy();
            finish(reject, error instanceof LndRestError
              ? error
              : new LndRestError(`LND returned unusable data for ${requestLabel}`, { ambiguous: errorAmbiguous }));
          }
        });
        response.on("end", () => {
          if (settled) return;
          try {
            if (stream && buffer.trim()) {
              lastStreamValue = unwrapLndStreamFrame(parseJson(buffer, "stream data"), {
                requestLabel,
                errorAmbiguous: streamErrorAmbiguous,
              });
            }
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              let grpcCode = null;
              try {
                const parsed = JSON.parse(buffer);
                grpcCode = parsed?.code ?? parsed?.error?.code ?? null;
              } catch {}
              finish(reject, new LndRestError(`LND rejected ${requestLabel}`, {
                httpStatus: response.statusCode ?? null,
                grpcCode,
                ambiguous: errorAmbiguous && (response.statusCode ?? 500) >= 500,
              }));
              return;
            }
            if (stream) {
              if (!lastStreamValue) {
                finish(reject, new LndRestError(`LND returned no result for ${requestLabel}`, { ambiguous: errorAmbiguous }));
                return;
              }
              finish(resolve, lastStreamValue);
              return;
            }
            finish(resolve, buffer.trim() ? parseJson(buffer, "JSON") : {});
          } catch (error) {
            finish(reject, error instanceof LndRestError
              ? error
              : new LndRestError(`LND returned unusable data for ${requestLabel}`, { ambiguous: errorAmbiguous }));
          }
        });
      });
      const deadline = setTimeout(() => {
        req.destroy(new LndRestError(`LND timed out during ${requestLabel}`, { ambiguous: errorAmbiguous }));
      }, timeout);
      req.on("error", (error) => finish(reject, error instanceof LndRestError
        ? error
        : new LndRestError(`LND transport failed during ${requestLabel}`, { ambiguous: errorAmbiguous })));
      if (serializedBody !== null) req.write(serializedBody);
      req.end();
    });
  }

  getInfo(timeoutMs) {
    return this.#call("/v1/getinfo", { timeoutMs });
  }

  listChannels(timeoutMs) {
    return this.#call("/v1/channels", { timeoutMs });
  }

  pendingChannels(timeoutMs) {
    return this.#call("/v1/channels/pending", { timeoutMs });
  }

  decodePaymentRequest(paymentRequest, timeoutMs) {
    return this.#call(`/v1/payreq/${encodeURIComponent(paymentRequest)}`, { timeoutMs });
  }

  addHoldInvoice({ paymentHash, amountSats, memo, expirySeconds, cltvExpiry, isPrivate }, timeoutMs) {
    return this.#call("/v2/invoices/hodl", {
      method: "POST",
      timeoutMs,
      errorAmbiguous: true,
      body: {
        hash: hex32ToBase64(paymentHash, "paymentHash"),
        value: String(amountSats),
        memo,
        expiry: String(expirySeconds),
        cltv_expiry: String(cltvExpiry),
        private: isPrivate,
      },
    });
  }

  lookupInvoice(paymentHash, timeoutMs) {
    const query = new URLSearchParams({ payment_hash: hex32ToBase64(paymentHash, "paymentHash") });
    return this.#call(`/v2/invoices/lookup?${query}`, { timeoutMs });
  }

  settleInvoice(preimage, timeoutMs) {
    return this.#call("/v2/invoices/settle", {
      method: "POST",
      timeoutMs,
      errorAmbiguous: true,
      body: { preimage: hex32ToBase64(preimage, "preimage") },
    });
  }

  cancelInvoice(paymentHash, timeoutMs) {
    return this.#call("/v2/invoices/cancel", {
      method: "POST",
      timeoutMs,
      errorAmbiguous: true,
      body: { payment_hash: hex32ToBase64(paymentHash, "paymentHash") },
    });
  }

  async sendPayment({ paymentRequest, timeoutSeconds, feeLimitSats }, timeoutMs) {
    const result = await this.#call("/v2/router/send", {
      method: "POST",
      timeoutMs,
      stream: true,
      errorAmbiguous: true,
      body: {
        payment_request: paymentRequest,
        timeout_seconds: timeoutSeconds,
        fee_limit_sat: String(feeLimitSats),
        no_inflight_updates: true,
      },
    });
    if (!TERMINAL_PAYMENT_STATES.has(result.status)) {
      throw new LndRestError("LND payment stream ended without a terminal state", { ambiguous: true });
    }
    return result;
  }

  trackPayment(paymentHash, timeoutMs) {
    const encoded = bytes32PathSegment(paymentHash, "paymentHash");
    return this.#call(`/v2/router/track/${encoded}?no_inflight_updates=false`, {
      timeoutMs,
      stream: true,
      firstStreamValue: true,
      streamErrorAmbiguous: false,
    });
  }
}

export function lndCertificateFingerprint(pem) {
  return pemFingerprint(pem);
}

export function invoiceDigest(paymentRequest) {
  return `0x${createHash("sha256").update(String(paymentRequest)).digest("hex")}`;
}
