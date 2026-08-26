function headerValue(response, name) {
  const value = response?.headers?.get?.(name);
  return value === null || value === undefined ? null : String(value);
}

function responseError(label, reason) {
  return new Error(`${label} ${reason}`);
}

function cancelReader(reader) {
  try {
    const cancel = reader?.cancel;
    if (typeof cancel !== "function") return;
    const pending = Reflect.apply(cancel, reader, []);
    if (pending && typeof pending.catch === "function") void pending.catch(() => {});
  } catch {
    // Rejected response teardown is best effort and never becomes authority.
  }
}

export function discardJsonResponseBody(response) {
  try {
    const body = response?.body;
    const cancel = body?.cancel;
    if (typeof cancel !== "function") return;
    const pending = Reflect.apply(cancel, body, []);
    if (pending && typeof pending.catch === "function") void pending.catch(() => {});
  } catch {
    // A rejected response never becomes authority, including when teardown fails.
  }
}

export const discardPrivateResponseBody = discardJsonResponseBody;

export async function readStrictJsonResponse(response, {
  label,
  maximumResponseBytes,
  signal = null,
}) {
  if (typeof label !== "string" || !label) throw new TypeError("response label is invalid");
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes <= 0) {
    throw new RangeError("response size limit is invalid");
  }
  if (signal !== null && (!signal || typeof signal !== "object"
      || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function")) {
    throw new TypeError("response abort signal is invalid");
  }

  let reader = null;
  let cancelOnAbort = null;
  try {
    const rawContentType = String(headerValue(response, "content-type") ?? "").trim();
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(rawContentType)) {
      throw responseError(label, "content type is invalid");
    }
    const cacheControl = String(headerValue(response, "cache-control") ?? "").toLowerCase();
    if (!cacheControl.split(",").some((directive) => directive.trim() === "no-store")) {
      throw responseError(label, "must disable storage");
    }
    const contentEncodingHeader = headerValue(response, "content-encoding");
    if (contentEncodingHeader !== null
        && String(contentEncodingHeader).trim().toLowerCase() !== "identity") {
      throw responseError(label, "content encoding is invalid");
    }
    const declaredHeader = headerValue(response, "content-length");
    if (declaredHeader !== null && !/^(?:0|[1-9][0-9]*)$/.test(declaredHeader)) {
      throw responseError(label, "content length is invalid");
    }
    const transferEncodingHeader = headerValue(response, "transfer-encoding");
    if (transferEncodingHeader !== null
        && (declaredHeader !== null || String(transferEncodingHeader).trim().toLowerCase() !== "chunked")) {
      throw responseError(label, "response framing is ambiguous");
    }
    const declaredBigInt = declaredHeader === null ? null : BigInt(declaredHeader);
    if (declaredBigInt !== null && declaredBigInt > BigInt(maximumResponseBytes)) {
      throw responseError(label, "is too large");
    }
    const declared = declaredBigInt === null ? null : Number(declaredBigInt);
    if (!response?.body || typeof response.body.getReader !== "function") {
      throw responseError(label, "returned an empty response");
    }

    reader = response.body.getReader();
    cancelOnAbort = () => { void cancelReader(reader); };
    if (signal?.aborted) cancelOnAbort();
    else signal?.addEventListener("abort", cancelOnAbort, { once: true });
    const chunks = [];
    let received = 0;
    while (true) {
      if (signal?.aborted) throw responseError(label, "was interrupted");
      let frame;
      try {
        frame = await reader.read();
      } catch {
        throw responseError(label, "was interrupted");
      }
      const { value, done } = frame;
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw responseError(label, "body chunk is invalid");
      }
      received += value.byteLength;
      if (received > maximumResponseBytes) {
        throw responseError(label, "is too large");
      }
      chunks.push(Buffer.from(value));
    }
    if (signal?.aborted) throw responseError(label, "was interrupted");
    if (declared !== null && received !== declared) {
      throw responseError(label, "length changed");
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw responseError(label, "returned malformed JSON");
    }
  } catch (error) {
    if (reader === null) discardJsonResponseBody(response);
    else cancelReader(reader);
    throw error;
  } finally {
    if (cancelOnAbort !== null) signal?.removeEventListener("abort", cancelOnAbort);
  }
}

export const readStrictPrivateJsonResponse = readStrictJsonResponse;
