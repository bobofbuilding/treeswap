import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const STATES = new Set(["dispatching", "succeeded", "failed", "unknown"]);
const TERMINAL = new Set(["succeeded", "failed", "unknown"]);

function validateRecord(record) {
  if (!record || record.schema !== "treeswap.lightning-action-record.v1") throw new TypeError("invalid journal record schema");
  if (!BYTES32.test(String(record.requestId ?? ""))) throw new TypeError("invalid journal requestId");
  if (!STATES.has(record.state)) throw new TypeError("invalid journal state");
  if (!Number.isSafeInteger(record.recordedAt) || record.recordedAt < 0) throw new TypeError("invalid journal timestamp");
  if (record.state === "dispatching") {
    if (!String(record.method ?? "").startsWith("/")) throw new TypeError("invalid journal method");
    if (!BYTES32.test(String(record.intentDigest ?? ""))) throw new TypeError("invalid journal intent digest");
    if (!BYTES32.test(String(record.paymentHash ?? ""))) throw new TypeError("invalid journal payment hash");
    if (!/^(?:0|[1-9][0-9]*)$/.test(String(record.amountSats ?? ""))) throw new TypeError("invalid journal amount");
    if (typeof record.countsExposure !== "boolean") throw new TypeError("invalid journal exposure flag");
  }
  return record;
}

async function appendDurably(path, record) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class LightningActionJournal {
  #path;
  #records;
  #queue = Promise.resolve();

  constructor(path, records) {
    this.#path = path;
    this.#records = records;
  }

  static async open(path) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const records = new Map();
    for (const line of content.split("\n").filter(Boolean)) {
      const record = validateRecord(JSON.parse(line));
      const history = records.get(record.requestId) ?? [];
      if (record.state === "dispatching" && history.length > 0) throw new Error("journal contains a duplicate reservation");
      if (record.state !== "dispatching" && (history.length !== 1 || history[0].state !== "dispatching")) {
        throw new Error("journal contains an invalid state transition");
      }
      history.push(Object.freeze(record));
      records.set(record.requestId, history);
    }
    return new LightningActionJournal(path, records);
  }

  #serialize(task) {
    const result = this.#queue.then(task, task);
    this.#queue = result.catch(() => {});
    return result;
  }

  reserve({ requestId, method, intentDigest, paymentHash, amountSats, countsExposure, recordedAt }) {
    return this.#serialize(async () => {
      if (this.#records.has(requestId)) throw new Error("adapter request identifier was already used");
      const record = validateRecord({
        schema: "treeswap.lightning-action-record.v1",
        requestId,
        method,
        intentDigest,
        paymentHash,
        amountSats: String(amountSats),
        countsExposure,
        state: "dispatching",
        recordedAt,
      });
      await appendDurably(this.#path, record);
      this.#records.set(requestId, [Object.freeze(record)]);
      return record;
    });
  }

  complete(requestId, state, recordedAt, outcomeCode) {
    return this.#serialize(async () => {
      if (!TERMINAL.has(state)) throw new TypeError("journal completion state is invalid");
      const history = this.#records.get(requestId);
      if (!history || history.length !== 1 || history[0].state !== "dispatching") {
        throw new Error("adapter request is not awaiting completion");
      }
      const record = validateRecord({
        schema: "treeswap.lightning-action-record.v1",
        requestId,
        state,
        recordedAt,
        outcomeCode: String(outcomeCode ?? "unspecified").slice(0, 80),
      });
      await appendDurably(this.#path, record);
      history.push(Object.freeze(record));
      return record;
    });
  }

  has(requestId) {
    return this.#records.has(requestId);
  }

  hasExposurePaymentHash(paymentHash) {
    for (const history of this.#records.values()) {
      if (history[0].countsExposure && history[0].paymentHash === paymentHash) return true;
    }
    return false;
  }

  state(requestId) {
    const history = this.#records.get(requestId);
    return history?.at(-1)?.state ?? null;
  }

  usageForUtcDay(nowSeconds) {
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new TypeError("nowSeconds must be a timestamp");
    const start = Math.floor(nowSeconds / 86_400) * 86_400;
    let dailyValueSats = 0n;
    const requestIds = [];
    for (const [requestId, history] of this.#records) {
      const reservation = history[0];
      requestIds.push(requestId);
      if (reservation.countsExposure && reservation.recordedAt >= start && reservation.recordedAt < start + 86_400) {
        dailyValueSats += BigInt(reservation.amountSats);
      }
    }
    return Object.freeze({ dailyValueSats, requestIds: Object.freeze(requestIds) });
  }
}
