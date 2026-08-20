#!/usr/bin/env node

import {
  readBoundedJson,
  rebuildReviewedClosedTestnetDeploymentArtifacts,
  repositoryFromModule,
  writeExclusiveJson,
} from "../lib/closed-testnet-deployment-files.mjs";
import { buildClosedTestnetDeploymentPlan } from "../lib/closed-testnet-deployment-plan.mjs";

const USAGE = "Usage: prepare-closed-testnet-deployment --input deployment-input.json --out unsigned-plan.json";

function argumentsFrom(values) {
  if (values.length !== 4) throw new Error(USAGE);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (!["--input", "--out"].includes(flag) || options[flag] || !values[index + 1]) throw new Error(USAGE);
    options[flag] = values[index + 1];
  }
  if (!options["--input"] || !options["--out"]) throw new Error(USAGE);
  return options;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const repository = repositoryFromModule(import.meta.url);
  const input = await readBoundedJson(options["--input"], "deployment input");
  if (input.environment !== "public-testnet") throw new Error("the operator CLI prepares public-testnet plans only");
  const { artifacts, sourceVerification } = await rebuildReviewedClosedTestnetDeploymentArtifacts({
    repository,
    reviewedBuildCommit: input.reviewedBuildCommit,
  });
  const plan = await buildClosedTestnetDeploymentPlan({ input, artifacts });
  const output = await writeExclusiveJson(options["--out"], plan);
  process.stdout.write(`${JSON.stringify({
    status: "prepared-exact-unsigned-closed-testnet-plan",
    scope: plan.scope,
    chainId: plan.network.chainId,
    sourceVerification,
    inputDigest: plan.inputDigest,
    planDigest: plan.planDigest,
    output,
    fundingAuthorization: false,
  }, null, 2)}\n`);
}

await main();
