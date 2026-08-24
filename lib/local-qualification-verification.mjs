import { constants, open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  RELEASE_QUALIFICATION_CONFIGURATION_FILES,
  hashQualificationFile,
  verifyReleaseQualificationEvidence,
} from "./qualification-evidence.mjs";

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_ARTIFACT_BYTES = 1_000_000;

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
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

function parseArtifact(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (raw.byteLength === 0 || raw.byteLength > MAXIMUM_ARTIFACT_BYTES) {
    throw new Error("qualification artifact must be a non-empty file no larger than 1 MB");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("qualification artifact is not valid JSON");
  }
  return Object.freeze({
    bytes: raw,
    qualification: verifyReleaseQualificationEvidence(parsed),
  });
}

function normalizeCurrentConfigurationHashes(value) {
  exactKeys(value, RELEASE_QUALIFICATION_CONFIGURATION_FILES, "current qualification configuration hashes");
  const normalized = Object.fromEntries(Object.entries(value).sort());
  for (const [name, digest] of Object.entries(normalized)) {
    if (!SHA256.test(String(digest ?? ""))) {
      throw new TypeError(`current qualification configuration hash is invalid: ${name}`);
    }
  }
  return Object.freeze(normalized);
}

export async function readPrivateQualificationArtifact(path) {
  const target = resolve(path);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()
        || before.size === 0
        || before.size > MAXIMUM_ARTIFACT_BYTES
        || before.nlink !== 1
        || (typeof process.getuid === "function" && before.uid !== process.getuid())
        || (before.mode & 0o777) !== 0o600) {
      throw new Error("qualification artifact must be one bounded owner-only mode-0600 non-symlink regular file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== before.size
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.nlink !== 1
        || (after.mode & 0o777) !== 0o600) {
      throw new Error("qualification artifact changed while it was being read");
    }
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("qualification artifact must be one bounded owner-only mode-0600 non-symlink regular file");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export function verifyCurrentReleaseQualification(input) {
  exactKeys(input, [
    "currentConfigurationHashes",
    "publishedSourceCommit",
    "qualificationFileBytes",
  ], "current qualification verification input");
  const {
    qualificationFileBytes,
    publishedSourceCommit,
    currentConfigurationHashes,
  } = input;
  if (!COMMIT.test(String(publishedSourceCommit ?? ""))) {
    throw new TypeError("published qualification source commit is invalid");
  }
  const parsed = parseArtifact(qualificationFileBytes);
  const qualification = parsed.qualification;
  if (qualification.source.commit !== publishedSourceCommit) {
    throw new Error("qualification artifact does not match the exact currently published main commit");
  }
  const current = normalizeCurrentConfigurationHashes(currentConfigurationHashes);
  for (const name of RELEASE_QUALIFICATION_CONFIGURATION_FILES) {
    if (qualification.configurationHashes[name] !== current[name]) {
      throw new Error(`qualification configuration changed after the artifact was produced: ${name}`);
    }
  }
  const receipt = Object.freeze({
    schema: "treeswap.local-qualification-verification-receipt.v1",
    status: "passed",
    scope: "verification-only-no-review-signing-broadcast-gate-opening-or-funding-authorization",
    source: Object.freeze({
      branch: qualification.source.branch,
      commit: qualification.source.commit,
      clean: qualification.source.clean,
      published: qualification.source.published,
    }),
    qualificationFileDigest: hashQualificationFile(parsed.bytes),
    qualificationEvidenceDigest: qualification.evidenceDigest,
    productionDurationEvidenceDigest: qualification.productionDuration.evidenceDigest,
    campaignCount: qualification.campaigns.length,
    configurationHashCount: Object.keys(qualification.configurationHashes).length,
    pinnedImageCount: qualification.pinnedImages.length,
    checks: Object.freeze({
      exactMandatoryCampaignPlan: true,
      exactCurrentConfigurationManifest: true,
      exactPublishedMainSource: true,
      immutableImagePins: true,
      secretFreeEvidence: true,
    }),
    authorizations: Object.freeze({
      externalReview: false,
      productionInfrastructure: false,
      publicTestnet: false,
      funding: false,
    }),
  });
  return Object.freeze({
    ...receipt,
    receiptDigest: hashQualificationFile(Buffer.from(JSON.stringify(canonical(receipt)))),
  });
}
