import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

const SCHEMA = "treeswap.lightning-chain-progress.v2";
const LEGACY_SCHEMA = "treeswap.lightning-chain-progress.v1";
const EXACT_KEYS = [
  "bestBlockHash",
  "bestHeaderTimestamp",
  "blockHeight",
  "conflicted",
  "initialized",
  "lastAdvancedAt",
  "schema",
];
const LEGACY_KEYS = EXACT_KEYS.filter((key) => key !== "bestBlockHash");

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function blockHash(value) {
  const raw = String(value ?? "");
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new TypeError("bestBlockHash must be a canonical 32-byte hex value");
  return raw;
}

function exactRecordKeys(value, expected) {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("chain-progress fields do not match the schema");
  }
}

function validateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid chain-progress record");
  exactRecordKeys(value, EXACT_KEYS);
  if (value.schema !== SCHEMA) throw new TypeError("invalid chain-progress schema");
  if (typeof value.initialized !== "boolean" || typeof value.conflicted !== "boolean") {
    throw new TypeError("invalid chain-progress flags");
  }
  return Object.freeze({
    schema: SCHEMA,
    bestBlockHash: blockHash(value.bestBlockHash),
    blockHeight: integer(value.blockHeight, "blockHeight"),
    bestHeaderTimestamp: integer(value.bestHeaderTimestamp, "bestHeaderTimestamp"),
    lastAdvancedAt: integer(value.lastAdvancedAt, "lastAdvancedAt"),
    initialized: value.initialized,
    conflicted: value.conflicted,
  });
}

function validateLegacyRecord(value) {
  exactRecordKeys(value, LEGACY_KEYS);
  if (value.schema !== LEGACY_SCHEMA) throw new TypeError("invalid chain-progress schema");
  if (typeof value.initialized !== "boolean" || typeof value.conflicted !== "boolean") {
    throw new TypeError("invalid chain-progress flags");
  }
  integer(value.blockHeight, "blockHeight");
  integer(value.bestHeaderTimestamp, "bestHeaderTimestamp");
  integer(value.lastAdvancedAt, "lastAdvancedAt");
}

async function readRecord(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("chain-progress path must be a regular file");
  if ((metadata.mode & 0o077) !== 0) throw new Error("chain-progress file must not be group/world accessible");
  if (metadata.size === 0 || metadata.size > 4_096) throw new Error("chain-progress file has an unsafe size");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("chain-progress file is not valid JSON");
  }
  if (parsed?.schema === LEGACY_SCHEMA) {
    validateLegacyRecord(parsed);
    return null;
  }
  return validateRecord(parsed);
}

async function replaceDurably(path, record) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let directoryHandle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = null;
  } finally {
    await handle?.close().catch(() => {});
    await directoryHandle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export class LightningChainProgressStore {
  #path;
  #record;
  #queue = Promise.resolve();

  constructor(path, record) {
    this.#path = path;
    this.#record = record;
  }

  static async open(path) {
    if (!String(path ?? "").startsWith("/")) throw new TypeError("chain-progress path must be absolute");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return new LightningChainProgressStore(path, await readRecord(path));
  }

  #serialize(task) {
    const result = this.#queue.then(task, task);
    this.#queue = result.catch(() => {});
    return result;
  }

  observe({ blockHeight, bestBlockHash, bestHeaderTimestamp, observedAt }) {
    return this.#serialize(async () => {
      const height = integer(blockHeight, "blockHeight");
      const hash = blockHash(bestBlockHash);
      const headerTimestamp = integer(bestHeaderTimestamp, "bestHeaderTimestamp");
      const now = integer(observedAt, "observedAt");
      const previous = this.#record;
      let next = previous;

      if (!previous) {
        next = validateRecord({
          schema: SCHEMA,
          bestBlockHash: hash,
          blockHeight: height,
          bestHeaderTimestamp: headerTimestamp,
          lastAdvancedAt: now,
          initialized: false,
          conflicted: false,
        });
      } else if (now < previous.lastAdvancedAt) {
        next = validateRecord({ ...previous, conflicted: true });
      } else if (height > previous.blockHeight && hash !== previous.bestBlockHash) {
        next = validateRecord({
          schema: SCHEMA,
          bestBlockHash: hash,
          blockHeight: height,
          bestHeaderTimestamp: headerTimestamp,
          lastAdvancedAt: now,
          initialized: true,
          conflicted: false,
        });
      } else if (height !== previous.blockHeight
        || hash !== previous.bestBlockHash
        || headerTimestamp !== previous.bestHeaderTimestamp) {
        next = validateRecord({ ...previous, conflicted: true });
      }

      if (next !== previous) {
        await replaceDurably(this.#path, next);
        this.#record = next;
      }
      return Object.freeze({
        initialized: this.#record.initialized,
        conflicted: this.#record.conflicted,
        noProgressSeconds: Math.max(0, now - this.#record.lastAdvancedAt),
        blockHeight: height,
        bestBlockHash: hash,
        bestHeaderTimestamp: headerTimestamp,
      });
    });
  }
}
