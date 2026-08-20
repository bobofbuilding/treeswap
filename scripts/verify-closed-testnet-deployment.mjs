#!/usr/bin/env node

import {
  readBoundedJson,
  rebuildReviewedClosedTestnetDeploymentArtifacts,
  repositoryFromModule,
} from "../lib/closed-testnet-deployment-files.mjs";
import { verifyClosedTestnetDeploymentPlan } from "../lib/closed-testnet-deployment-plan.mjs";

const USAGE = "Usage: verify-closed-testnet-deployment --input deployment-input.json --plan unsigned-plan.json";

function argumentsFrom(values) {
  if (values.length !== 4) throw new Error(USAGE);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (!["--input", "--plan"].includes(flag) || options[flag] || !values[index + 1]) throw new Error(USAGE);
    options[flag] = values[index + 1];
  }
  if (!options["--input"] || !options["--plan"]) throw new Error(USAGE);
  return options;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const repository = repositoryFromModule(import.meta.url);
  const [input, plan] = await Promise.all([
    readBoundedJson(options["--input"], "deployment input"),
    readBoundedJson(options["--plan"], "deployment plan"),
  ]);
  if (input.environment !== "public-testnet") throw new Error("the operator CLI verifies public-testnet plans only");
  const { artifacts, sourceVerification } = await rebuildReviewedClosedTestnetDeploymentArtifacts({
    repository,
    reviewedBuildCommit: input.reviewedBuildCommit,
  });
  const verification = await verifyClosedTestnetDeploymentPlan({ input, artifacts, plan });
  process.stdout.write(`${JSON.stringify({ ...verification, sourceVerification }, null, 2)}\n`);
}

await main();
