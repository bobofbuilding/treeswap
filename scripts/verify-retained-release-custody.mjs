#!/usr/bin/env node

import { writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import { inspectRetainedReleaseCustody } from "../lib/release-retention-custody.mjs";

const USAGE = "Usage: verify-retained-release-custody --inputs /absolute/custody.json --out custody-summary.json";

function argumentsFromCommandLine(values) {
  if (values.length !== 4) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (![
      "--inputs",
      "--out",
    ].includes(flag) || !value || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  if (!result["--inputs"] || !result["--out"]) throw new Error(USAGE);
  return result;
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const summary = await inspectRetainedReleaseCustody({ manifestPath: args["--inputs"] });
const output = await writeExclusiveJson(args["--out"], summary);
process.stdout.write(`${JSON.stringify({
  ...summary,
  output,
  rotationAuthorization: false,
  lightningDispatchAuthorization: false,
  newExposureAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
