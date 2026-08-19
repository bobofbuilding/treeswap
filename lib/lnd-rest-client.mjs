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

function pemFingerprint(pem) {
  return `sha256:${new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase()}`;
}

function sanitizePath(path) {
  const value = String(path ?? "");
  if (!value.startsWith("/") || value.includes("\n") || value.includes("\r")) throw new TypeError("LND path is invalid");
  return value;
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

  #call(path, { method = "GET", body = null, timeoutMs = 10_000, stream = false } = {}) {
    const safePath = sanitizePath(path);
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
                const parsed = parseJson(line, "stream data");
                lastStreamValue = parsed.result ?? parsed;
              }
            }
          } catch (error) {
            response.destroy();
            finish(reject, error instanceof LndRestError
              ? error
              : new LndRestError(`LND returned unusable data for ${method} ${safePath}`, { ambiguous: true }));
          }
        });
        response.on("end", () => {
          if (settled) return;
          try {
            if (stream && buffer.trim()) {
              const parsed = parseJson(buffer, "stream data");
              lastStreamValue = parsed.result ?? parsed;
            }
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              let grpcCode = null;
              try {
                grpcCode = JSON.parse(buffer)?.code ?? null;
              } catch {}
              finish(reject, new LndRestError(`LND rejected ${method} ${safePath}`, {
                httpStatus: response.statusCode ?? null,
                grpcCode,
                ambiguous: (response.statusCode ?? 500) >= 500,
              }));
              return;
            }
            if (stream) {
              if (!lastStreamValue) {
                finish(reject, new LndRestError(`LND returned no stream result for ${method} ${safePath}`, { ambiguous: true }));
                return;
              }
              finish(resolve, lastStreamValue);
              return;
            }
            finish(resolve, buffer.trim() ? parseJson(buffer, "JSON") : {});
          } catch (error) {
            finish(reject, error instanceof LndRestError
              ? error
              : new LndRestError(`LND returned unusable data for ${method} ${safePath}`, { ambiguous: true }));
          }
        });
      });
      const deadline = setTimeout(() => {
        req.destroy(new LndRestError(`LND timed out during ${method} ${safePath}`, { ambiguous: true }));
      }, timeout);
      req.on("error", (error) => finish(reject, error instanceof LndRestError
        ? error
        : new LndRestError(`LND transport failed during ${method} ${safePath}`, { ambiguous: true })));
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
      body: { preimage: hex32ToBase64(preimage, "preimage") },
    });
  }

  cancelInvoice(paymentHash, timeoutMs) {
    return this.#call("/v2/invoices/cancel", {
      method: "POST",
      timeoutMs,
      body: { payment_hash: hex32ToBase64(paymentHash, "paymentHash") },
    });
  }

  async sendPayment({ paymentRequest, timeoutSeconds, feeLimitSats }, timeoutMs) {
    const result = await this.#call("/v2/router/send", {
      method: "POST",
      timeoutMs,
      stream: true,
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
    const encoded = encodeURIComponent(hex32ToBase64(paymentHash, "paymentHash"));
    return this.#call(`/v2/router/track/${encoded}?no_inflight_updates=true`, { timeoutMs, stream: true });
  }
}

export function lndCertificateFingerprint(pem) {
  return pemFingerprint(pem);
}

export function invoiceDigest(paymentRequest) {
  return `0x${createHash("sha256").update(String(paymentRequest)).digest("hex")}`;
}
