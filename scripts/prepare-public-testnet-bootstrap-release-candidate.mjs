#!/usr/bin/env node

import { writeExclusiveJson } from "../lib/closed-testnet-deployment-files.mjs";
import {
  buildPublicTestnetReleaseCandidateSummary,
} from "../lib/public-testnet-release-candidate.mjs";
import { rebuildPublicTestnetBootstrapReleaseCandidateFromFiles } from "../lib/public-testnet-release-files.mjs";

const FLAGS = Object.freeze([
  "--adoption-policy",
  "--bootstrap-attestations",
  "--bootstrap-policy",
  "--bootstrap-record",
  "--deployment-policy",
  "--isolation-attestations",
  "--isolation-policy",
  "--isolation-record",
  "--out",
  "--operations-attestations",
  "--operations-policy",
  "--operations-record",
  "--operations-safety-monitor-policy",
  "--policy-template",
  "--qualification-artifact",
  "--qualification-attestation",
  "--qualification-policy",
  "--qualification-review",
  "--postflight-bundle",
  "--promotion-attestations",
  "--promotion-observations",
  "--promotion-policy",
  "--promotion-record",
  "--record-template",
  "--review-attestations",
  "--review-policy",
  "--review-record",
]);
const USAGE = "Usage: prepare-public-testnet-bootstrap-release-candidate --record-template record-template.json --policy-template policy-template.json --adoption-policy adoption-policy.json --bootstrap-record bootstrap-record.json --bootstrap-policy bootstrap-policy.json --bootstrap-attestations bootstrap-attestations.json --promotion-record promotion-record.json --promotion-policy promotion-policy.json --deployment-policy deployment-policy.json --promotion-observations promotion-observations.json --promotion-attestations promotion-attestations.json --postflight-bundle postflight-bundle.json --review-record review-record.json --review-policy review-policy.json --review-attestations review-attestations.json --qualification-artifact qualification.json --qualification-review qualification-review.json --qualification-policy qualification-policy.json --qualification-attestation qualification-attestation.json --isolation-record isolation-record.json --isolation-policy isolation-policy.json --isolation-attestations isolation-attestations.json --operations-record operations-record.json --operations-policy operations-policy.json --operations-attestations operations-attestations.json --operations-safety-monitor-policy safety-monitor-policy.json --out bootstrap-release-candidate.json";

function argumentsFromCommandLine(values) {
  if (values.length !== FLAGS.length * 2) throw new Error(USAGE);
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || !FLAGS.includes(flag) || result[flag]) throw new Error(USAGE);
    result[flag] = value;
  }
  return result;
}

const args = argumentsFromCommandLine(process.argv.slice(2));
const candidate = await rebuildPublicTestnetBootstrapReleaseCandidateFromFiles({
  recordTemplate: args["--record-template"],
  policyTemplate: args["--policy-template"],
  adoptionPolicy: args["--adoption-policy"],
  bootstrapRecord: args["--bootstrap-record"],
  bootstrapPolicy: args["--bootstrap-policy"],
  bootstrapAttestations: args["--bootstrap-attestations"],
  promotionRecord: args["--promotion-record"],
  promotionPolicy: args["--promotion-policy"],
  deploymentPolicy: args["--deployment-policy"],
  promotionObservations: args["--promotion-observations"],
  promotionAttestations: args["--promotion-attestations"],
  postflightBundle: args["--postflight-bundle"],
  reviewRecord: args["--review-record"],
  reviewPolicy: args["--review-policy"],
  reviewAttestations: args["--review-attestations"],
  operationsRecord: args["--operations-record"],
  operationsPolicy: args["--operations-policy"],
  operationsAttestations: args["--operations-attestations"],
  operationsSafetyMonitorPolicy: args["--operations-safety-monitor-policy"],
  isolationRecord: args["--isolation-record"],
  isolationPolicy: args["--isolation-policy"],
  isolationAttestations: args["--isolation-attestations"],
  qualificationArtifact: args["--qualification-artifact"],
  qualificationReview: args["--qualification-review"],
  qualificationPolicy: args["--qualification-policy"],
  qualificationAttestation: args["--qualification-attestation"],
});
if (Buffer.byteLength(JSON.stringify(candidate)) > 1_000_000) {
  throw new Error("public-testnet bootstrap release candidate exceeds 1 MB");
}
const output = await writeExclusiveJson(args["--out"], candidate);
process.stdout.write(`${JSON.stringify({
  ...buildPublicTestnetReleaseCandidateSummary(candidate),
  output,
  signingAuthorization: false,
  broadcastAuthorization: false,
  gateOpeningAuthorization: false,
  fundingAuthorization: false,
}, null, 2)}\n`);
