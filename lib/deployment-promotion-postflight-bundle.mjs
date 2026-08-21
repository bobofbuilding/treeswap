import { verifyClosedTestnetDeploymentPostflight } from "./closed-testnet-deployment-postflight.mjs";

const BUNDLE_FIELDS = Object.freeze([
  "attestations",
  "observations",
  "plan",
  "policy",
  "preflightAttestations",
  "preflightObservations",
  "preflightPolicy",
  "preflightRecord",
  "record",
  "schema",
]);

function exactKeys(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

export function verifyDeploymentPromotionPostflightBundle({ bundle, deploymentPolicy, promotedAt }) {
  exactKeys(bundle, BUNDLE_FIELDS, "deployment promotion postflight bundle");
  if (bundle.schema !== "treeswap.deployment-promotion-postflight-bundle.v1") {
    throw new TypeError("deployment promotion postflight bundle schema is invalid");
  }
  return verifyClosedTestnetDeploymentPostflight({
    preflight: {
      plan: bundle.plan,
      policy: bundle.preflightPolicy,
      record: bundle.preflightRecord,
      observations: bundle.preflightObservations,
      attestations: bundle.preflightAttestations,
    },
    deploymentPolicy,
    policy: bundle.policy,
    record: bundle.record,
    observations: bundle.observations,
    attestations: bundle.attestations,
    now: promotedAt,
  });
}
