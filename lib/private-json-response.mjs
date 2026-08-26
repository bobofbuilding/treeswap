function headerValue(response, name) {
  const value = response?.headers?.get?.(name);
  return value === null || value === undefined ? null : String(value);
}

function responseError(label, reason) {
  return new Error(`${label} ${reason}`);
}

export async function readStrictPrivateJsonResponse(response, {
  label,
  maximumResponseBytes,
  signal = null,
}) {
  if (typeof label !== "string" || !label) throw new TypeError("private response label is invalid");
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes <= 0) {
    throw new RangeError("private response size limit is invalid");
  }

  const contentType = String(headerValue(response, "content-type") ?? "")
    .split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw responseError(label, "content type is invalid");
  }
  const cacheControl = String(headerValue(response, "cache-control") ?? "").toLowerCase();
  if (!cacheControl.split(",").some((directive) => directive.trim() === "no-store")) {
    throw responseError(label, "must disable storage");
  }
  const contentEncoding = String(headerValue(response, "content-encoding") ?? "identity")
    .trim().toLowerCase();
  if (contentEncoding !== "" && contentEncoding !== "identity") {
    throw responseError(label, "content encoding is invalid");
  }
  const declaredHeader = headerValue(response, "content-length");
  if (declaredHeader !== null && !/^(?:0|[1-9][0-9]*)$/.test(declaredHeader)) {
    throw responseError(label, "content length is invalid");
  }
  const transferEncoding = headerValue(response, "transfer-encoding");
  if (declaredHeader !== null && transferEncoding !== null) {
    throw responseError(label, "response framing is ambiguous");
  }
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && declared > maximumResponseBytes) {
    throw responseError(label, "is too large");
  }
  if (!response?.body || typeof response.body.getReader !== "function") {
    throw responseError(label, "returned an empty response");
  }

  const reader = response.body.getReader();
  const cancelOnAbort = () => { void reader.cancel().catch(() => {}); };
  if (signal?.aborted) cancelOnAbort();
  else signal?.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks = [];
  let received = 0;
  try {
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
        await reader.cancel().catch(() => {});
        throw responseError(label, "body chunk is invalid");
      }
      received += value.byteLength;
      if (received > maximumResponseBytes) {
        await reader.cancel().catch(() => {});
        throw responseError(label, "is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
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
}
