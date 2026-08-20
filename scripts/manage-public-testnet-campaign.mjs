#!/usr/bin/env node

import {
  constants,
  lstat,
  open,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendPublicTestnetScenario,
  appendPublicTestnetSolverMetric,
  buildPublicTestnetCampaignCheckpoint,
  finalizePublicTestnetCampaign,
  initializePublicTestnetCampaign,
  publicTestnetCampaignStateDigest,
  verifyPublicTestnetCampaignTransition,
} from "../lib/public-testnet-campaign-workflow.mjs";

const USAGE = `Usage:
  manage-public-testnet-campaign init --policy policy.json --participants participants.json --campaign-id 0x... --started-at UNIX_SECONDS --out snapshot.json
  manage-public-testnet-campaign scenario --state snapshot.json --entry scenario.json --out next-snapshot.json
  manage-public-testnet-campaign solver-metric --state snapshot.json --entry metric.json --out next-snapshot.json
  manage-public-testnet-campaign checkpoint --state snapshot.json
  manage-public-testnet-campaign verify-transition --previous snapshot.json --next next-snapshot.json
  manage-public-testnet-campaign finalize --state snapshot.json --finalization finalization.json --finished-at UNIX_SECONDS --out campaign.json`;

const COMMAND_FLAGS = Object.freeze({
  init: Object.freeze(["--campaign-id", "--out", "--participants", "--policy", "--started-at"]),
  scenario: Object.freeze(["--entry", "--out", "--state"]),
  "solver-metric": Object.freeze(["--entry", "--out", "--state"]),
  checkpoint: Object.freeze(["--state"]),
  "verify-transition": Object.freeze(["--next", "--previous"]),
  finalize: Object.freeze(["--finalization", "--finished-at", "--out", "--state"]),
});

function parseArguments(values) {
  const [command, ...rest] = values;
  if (command === "--help" || command === "help") return { help: true };
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) throw new Error(USAGE);
  if (rest.length !== allowed.length * 2) throw new Error(USAGE);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!allowed.includes(flag) || !value || options[flag]) throw new Error(USAGE);
    options[flag] = value;
  }
  if (Object.keys(options).length !== allowed.length) throw new Error(USAGE);
  return { command, options };
}

function unixSeconds(value, name) {
  if (!/^[1-9][0-9]{0,15}$/.test(String(value ?? ""))) throw new TypeError(`${name} must be UNIX seconds`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceeds the safe integer range`);
  return result;
}

async function boundedJson(path, name) {
  const target = resolve(path);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0 || before.size > 1_000_000) {
      throw new Error(`${name} must be a non-symlink JSON file no larger than 1 MB`);
    }
    const bytes = await handle.readFile("utf8");
    const after = await handle.stat();
    if (Buffer.byteLength(bytes) > 1_000_000 || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`${name} changed while it was being read`);
    }
    try {
      return JSON.parse(bytes);
    } catch {
      throw new Error(`${name} is not valid JSON`);
    }
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`${name} must be a non-symlink JSON file no larger than 1 MB`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeExclusiveJson(path, value) {
  const target = resolve(path);
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("output parent must be a real directory");
  }
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directoryHandle = await open(dirname(target), constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return target;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const { command, options } = parsed;
  if (command === "init") {
    const [policy, participants] = await Promise.all([
      boundedJson(options["--policy"], "policy"),
      boundedJson(options["--participants"], "participants"),
    ]);
    const state = initializePublicTestnetCampaign({
      policy,
      participants,
      campaignId: options["--campaign-id"],
      startedAt: unixSeconds(options["--started-at"], "startedAt"),
    });
    const target = await writeExclusiveJson(options["--out"], state);
    output({
      status: "initialized-immutable-campaign-snapshot",
      scope: state.scope,
      revision: state.revision,
      stateDigest: publicTestnetCampaignStateDigest(state),
      output: target,
    });
    return;
  }
  if (command === "scenario" || command === "solver-metric") {
    const [state, entry] = await Promise.all([
      boundedJson(options["--state"], "campaign workspace"),
      boundedJson(options["--entry"], command === "scenario" ? "scenario" : "solver metric"),
    ]);
    const next = command === "scenario"
      ? appendPublicTestnetScenario(state, entry)
      : appendPublicTestnetSolverMetric(state, entry);
    const transition = verifyPublicTestnetCampaignTransition(state, next);
    const target = await writeExclusiveJson(options["--out"], next);
    output({
      status: "wrote-hash-linked-immutable-campaign-snapshot",
      scope: next.scope,
      revision: next.revision,
      previousStateDigest: transition.previousStateDigest,
      stateDigest: transition.stateDigest,
      addition: transition.addition,
      output: target,
    });
    return;
  }
  if (command === "checkpoint") {
    const state = await boundedJson(options["--state"], "campaign workspace");
    output(buildPublicTestnetCampaignCheckpoint(state));
    return;
  }
  if (command === "verify-transition") {
    const [previous, next] = await Promise.all([
      boundedJson(options["--previous"], "previous campaign workspace"),
      boundedJson(options["--next"], "next campaign workspace"),
    ]);
    output(verifyPublicTestnetCampaignTransition(previous, next));
    return;
  }
  const [state, finalization] = await Promise.all([
    boundedJson(options["--state"], "campaign workspace"),
    boundedJson(options["--finalization"], "campaign finalization"),
  ]);
  const finalized = finalizePublicTestnetCampaign({
    state,
    finalization,
    finishedAt: unixSeconds(options["--finished-at"], "finishedAt"),
  });
  const target = await writeExclusiveJson(options["--out"], finalized.record);
  output({
    status: finalized.status,
    scope: finalized.scope,
    sourceStateDigest: finalized.sourceStateDigest,
    recordDigest: finalized.recordDigest,
    policyDigest: finalized.policyDigest,
    output: target,
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "public-testnet campaign workflow failed"}\n`);
  process.exitCode = 1;
});
