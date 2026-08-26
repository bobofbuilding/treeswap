import assert from "node:assert/strict";
import test from "node:test";
import { readStrictPrivateJsonResponse } from "../lib/private-json-response.mjs";

function strictResponse(body, headers = {}) {
  const bytes = Buffer.from(body);
  return new Response(bytes, {
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(bytes.length),
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function read(response, overrides = {}) {
  return readStrictPrivateJsonResponse(response, {
    label: "operator response",
    maximumResponseBytes: 1_024,
    ...overrides,
  });
}

test("accepts one exact identity-encoded JSON body with matching framing", async () => {
  assert.deepEqual(await read(strictResponse('{"safe":true}')), { safe: true });

  const chunked = new Response('{"safe":true}', {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "transfer-encoding": "chunked",
    },
  });
  assert.deepEqual(await read(chunked), { safe: true });
});

test("rejects compression, ambiguous framing, noncanonical length, and truncation", async () => {
  await assert.rejects(
    read(strictResponse('{"safe":true}', { "content-encoding": "gzip" })),
    /content encoding is invalid/,
  );
  await assert.rejects(
    read(strictResponse('{"safe":true}', { "transfer-encoding": "chunked" })),
    /framing is ambiguous/,
  );
  await assert.rejects(
    read(strictResponse('{"safe":true}', { "content-length": "013" })),
    /content length is invalid/,
  );
  await assert.rejects(
    read(strictResponse('{"safe":true}', { "content-length": "14" })),
    /length changed/,
  );
  await assert.rejects(
    read(new Response('{"safe":true}', {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "transfer-encoding": "gzip",
      },
    })),
    /framing is ambiguous/,
  );
  await assert.rejects(
    read(strictResponse('{"safe":true}', { "content-type": "application/json; charset=utf-16" })),
    /content type is invalid/,
  );
});

test("enforces the declared and received byte ceilings before parsing", async () => {
  await assert.rejects(
    read(strictResponse("{}", { "content-length": "1025" })),
    /is too large/,
  );
  const actualOversize = new Response(new Uint8Array(1_025), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
  await assert.rejects(read(actualOversize), /is too large/);
});

test("rejects malformed streams and an already-aborted read", async () => {
  const invalidChunk = {
    headers: new Headers({
      "cache-control": "no-store",
      "content-type": "application/json",
    }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue("not bytes");
        controller.close();
      },
    }),
  };
  await assert.rejects(read(invalidChunk), /body chunk is invalid/);

  const failedStream = {
    headers: invalidChunk.headers,
    body: new ReadableStream({
      start(streamController) {
        streamController.error(new Error("secret remote stream failure"));
      },
    }),
  };
  await assert.rejects(
    read(failedStream),
    (error) => error.message === "operator response was interrupted",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    read(strictResponse('{"safe":true}'), { signal: controller.signal }),
    /was interrupted/,
  );
  await assert.rejects(read(strictResponse("not json")), /malformed JSON/);

  const activeController = new AbortController();
  const stalled = new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
  const pending = read(stalled, { signal: activeController.signal });
  queueMicrotask(() => activeController.abort());
  await assert.rejects(pending, /was interrupted/);
});

test("requires fatal BOM-free UTF-8 before JSON parsing", async () => {
  assert.deepEqual(await read(strictResponse('{"label":"árvore 🌳"}')), { label: "árvore 🌳" });

  const encodedResponse = (bytes) => ({
    headers: new Headers({
      "cache-control": "no-store",
      "content-length": String(bytes.length),
      "content-type": "application/json; charset=utf-8",
    }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from(bytes));
        controller.close();
      },
    }),
  });

  await assert.rejects(
    read(encodedResponse([0x22, 0x61, 0xc0, 0xaf, 0x22])),
    /not valid UTF-8/,
  );
  await assert.rejects(
    read(encodedResponse([0x22, 0xe2, 0x82, 0x22])),
    /not valid UTF-8/,
  );
  await assert.rejects(
    read(encodedResponse([0xef, 0xbb, 0xbf, ...Buffer.from('{"safe":true}')])),
    /forbidden UTF-8 byte order mark/,
  );

  const originalDecoder = globalThis.TextDecoder;
  try {
    globalThis.TextDecoder = class ForgedTextDecoder {
      decode() {
        return '{"safe":true}';
      }
    };
    await assert.rejects(
      read(encodedResponse([0x22, 0xc0, 0xaf, 0x22])),
      /not valid UTF-8/,
    );
  } finally {
    globalThis.TextDecoder = originalDecoder;
  }
});

test("cancels rejected bodies without awaiting responder-controlled teardown", async () => {
  let earlyCancels = 0;
  const earlyRejected = {
    headers: new Headers({
      "cache-control": "no-store",
      "content-type": "text/plain",
    }),
    body: {
      cancel() {
        earlyCancels += 1;
        return new Promise(() => {});
      },
    },
  };
  await assert.rejects(read(earlyRejected), /content type is invalid/);
  assert.equal(earlyCancels, 1);

  let lockedCancels = 0;
  const invalidChunk = {
    headers: new Headers({
      "cache-control": "no-store",
      "content-type": "application/json",
    }),
    body: {
      getReader() {
        return {
          read: async () => ({ done: false, value: "not bytes" }),
          cancel() {
            lockedCancels += 1;
            return new Promise(() => {});
          },
        };
      },
    },
  };
  await assert.rejects(read(invalidChunk), /body chunk is invalid/);
  assert.equal(lockedCancels, 1);
});
