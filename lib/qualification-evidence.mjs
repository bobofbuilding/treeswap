import { createHash } from "node:crypto";
import { verifyProductionDurationEvidence } from "./production-duration-evidence.mjs";
import {
  RELEASE_QUALIFICATION_CAMPAIGN_NAMES,
  RELEASE_QUALIFICATION_CONFIGURATION_FILES,
} from "./qualification-plan.mjs";

export {
  RELEASE_QUALIFICATION_CAMPAIGN_NAMES,
  RELEASE_QUALIFICATION_CONFIGURATION_FILES,
} from "./qualification-plan.mjs";

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isoTimestamp(value, name) {
  const raw = String(value ?? "");
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) throw new TypeError(`${name} must be canonical ISO-8601`);
  return raw;
}

export function assertQualificationEvidenceIsSecretFree(value) {
  const forbiddenKey = /(macaroon|preimage|payment.?request|invoice.?text|private.?key|rpc.?url|wallet.?seed|email)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string") {
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(entry) || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)) {
          throw new Error("qualification evidence contains secret material");
        }
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`qualification evidence contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

export function buildQualificationEvidence(input) {
  exactKeys(input, [
    "branch",
    "campaigns",
    "configurationHashes",
    "finishedAt",
    "pinnedImages",
    "productionDurationEvidence",
    "runtimeVersions",
    "sourceCommit",
    "startedAt",
  ], "qualification evidence input");
  if (input.branch !== "main") throw new Error("qualification evidence must bind published main");
  if (!/^[0-9a-f]{40}$/.test(String(input.sourceCommit))) throw new TypeError("source commit is invalid");
  const startedAt = isoTimestamp(input.startedAt, "startedAt");
  const finishedAt = isoTimestamp(input.finishedAt, "finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new RangeError("qualification timestamps are reversed");
  if (!Array.isArray(input.campaigns) || input.campaigns.length === 0) throw new TypeError("campaigns are required");
  const campaigns = input.campaigns.map((campaign) => {
    exactKeys(campaign, ["name", "status"], "campaign");
    if (!/^[a-z0-9:-]{2,80}$/.test(String(campaign.name)) || campaign.status !== "passed") {
      throw new Error("every qualification campaign must have a safe name and pass");
    }
    return Object.freeze({ name: campaign.name, status: "passed" });
  });
  if (new Set(campaigns.map(({ name }) => name)).size !== campaigns.length) {
    throw new Error("qualification campaign names must be unique");
  }
  if (campaigns.filter(({ name }) => name === "lightning:production-duration-chain-delay").length !== 1) {
    throw new Error("qualification evidence requires exactly one production-duration campaign");
  }
  const configurationHashes = Object.fromEntries(Object.entries(input.configurationHashes).sort());
  if (Object.keys(configurationHashes).length === 0) throw new TypeError("configuration hashes are required");
  for (const [name, digest] of Object.entries(configurationHashes)) {
    const segments = name.split("/");
    if (!/^[A-Za-z0-9._/-]+$/.test(name)
        || name.startsWith("/")
        || segments.some((segment) => segment === "" || segment === "." || segment === "..")
        || !/^sha256:[0-9a-f]{64}$/.test(String(digest))) {
      throw new TypeError("configuration hash entry is invalid");
    }
  }
  const pinnedImages = [...input.pinnedImages].sort();
  if (pinnedImages.length < 3 || pinnedImages.some((image) => !/@sha256:[0-9a-f]{64}$/.test(String(image)))) {
    throw new Error("qualification evidence requires immutable image digests");
  }
  exactKeys(input.runtimeVersions, ["docker", "dockerCompose", "forge", "node"], "runtime versions");
  for (const version of Object.values(input.runtimeVersions)) {
    if (typeof version !== "string" || version.length === 0 || version.length > 240 || /[\r\n]/.test(version)) {
      throw new TypeError("runtime version is invalid");
    }
  }
  const productionDuration = verifyProductionDurationEvidence(input.productionDurationEvidence, {
    expectedSourceCommit: input.sourceCommit,
  });
  if (Date.parse(productionDuration.startedAt) < Date.parse(startedAt)
    || Date.parse(productionDuration.finishedAt) > Date.parse(finishedAt)) {
    throw new Error("production-duration evidence is outside the qualification interval");
  }
  const evidence = Object.freeze({
    schema: "treeswap.local-qualification-evidence.v2",
    status: "passed",
    scope: "local-only-no-funding-authorization",
    source: Object.freeze({ branch: input.branch, commit: input.sourceCommit, clean: true, published: true }),
    startedAt,
    finishedAt,
    runtimeVersions: Object.freeze({ ...input.runtimeVersions }),
    pinnedImages: Object.freeze(pinnedImages),
    configurationHashes: Object.freeze(configurationHashes),
    campaigns: Object.freeze(campaigns),
    productionDuration,
    privacy: Object.freeze({ commandOutputIncluded: false, secretMaterialIncluded: false }),
    limitations: Object.freeze({
      independentReviewIncluded: false,
      productionInfrastructureIncluded: false,
      publicTestnetIncluded: false,
      simulatedEvmReservation: true,
    }),
  });
  assertQualificationEvidenceIsSecretFree(evidence);
  return Object.freeze({
    ...evidence,
    evidenceDigest: sha256(JSON.stringify(canonical(evidence))),
  });
}

export function verifyQualificationEvidence(value) {
  exactKeys(value, [
    "campaigns",
    "configurationHashes",
    "evidenceDigest",
    "finishedAt",
    "limitations",
    "pinnedImages",
    "privacy",
    "productionDuration",
    "runtimeVersions",
    "schema",
    "scope",
    "source",
    "startedAt",
    "status",
  ], "qualification evidence");
  exactKeys(value.source, ["branch", "clean", "commit", "published"], "qualification source");
  exactKeys(value.privacy, ["commandOutputIncluded", "secretMaterialIncluded"], "qualification privacy");
  exactKeys(value.limitations, [
    "independentReviewIncluded",
    "productionInfrastructureIncluded",
    "publicTestnetIncluded",
    "simulatedEvmReservation",
  ], "qualification limitations");
  if (value.schema !== "treeswap.local-qualification-evidence.v2"
      || value.status !== "passed"
      || value.scope !== "local-only-no-funding-authorization"
      || value.source.branch !== "main"
      || value.source.clean !== true
      || value.source.published !== true
      || value.privacy.commandOutputIncluded !== false
      || value.privacy.secretMaterialIncluded !== false
      || value.limitations.independentReviewIncluded !== false
      || value.limitations.productionInfrastructureIncluded !== false
      || value.limitations.publicTestnetIncluded !== false
      || value.limitations.simulatedEvmReservation !== true) {
    throw new Error("qualification evidence identity, privacy, or limitations are invalid");
  }
  const rebuilt = buildQualificationEvidence({
    branch: value.source.branch,
    sourceCommit: value.source.commit,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    runtimeVersions: value.runtimeVersions,
    pinnedImages: value.pinnedImages,
    configurationHashes: value.configurationHashes,
    campaigns: value.campaigns,
    productionDurationEvidence: value.productionDuration,
  });
  if (JSON.stringify(canonical(rebuilt)) !== JSON.stringify(canonical(value))) {
    throw new Error("qualification evidence digest or content is invalid");
  }
  return rebuilt;
}

export function verifyReleaseQualificationEvidence(value) {
  const verified = verifyQualificationEvidence(value);
  const campaignNames = verified.campaigns.map(({ name }) => name);
  if (campaignNames.length !== RELEASE_QUALIFICATION_CAMPAIGN_NAMES.length
      || campaignNames.some((name, index) => name !== RELEASE_QUALIFICATION_CAMPAIGN_NAMES[index])) {
    throw new Error("release qualification evidence does not contain the exact mandatory campaign plan");
  }
  const configurationNames = Object.keys(verified.configurationHashes);
  const requiredConfigurationNames = [...RELEASE_QUALIFICATION_CONFIGURATION_FILES].sort();
  if (configurationNames.length !== requiredConfigurationNames.length
      || configurationNames.some((name, index) => name !== requiredConfigurationNames[index])) {
    throw new Error("release qualification evidence does not contain the exact configuration manifest");
  }
  if (new Set(verified.pinnedImages).size !== verified.pinnedImages.length) {
    throw new Error("release qualification image pins must be unique");
  }
  return verified;
}

export function hashQualificationFile(bytes) {
  return sha256(bytes);
}
