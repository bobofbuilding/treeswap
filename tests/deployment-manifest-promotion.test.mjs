import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { id } from "ethers";
import {
  NOW,
  attestations,
  fixture,
  hash,
  verify,
} from "./fixtures/verified-deployment-promotion.mjs";
import {
  buildDeploymentPromotionReleaseEvidence,
  buildDeploymentPromotionSummary,
} from "../lib/deployment-manifest-promotion.mjs";
import { verifyDeploymentPromotionPostflightBundle } from "../lib/deployment-promotion-postflight-bundle.mjs";

test("promotes one exact finalized manifest only after provider and reviewer attestations", async () => {
  const candidate = await fixture();
  const result = await verify(candidate);
  assert.equal(result.status, "cryptographically-verified-deployment-promotion");
  assert.equal(result.scope, "candidate-deployment-evidence-no-funding-authorization");
  const releaseEvidence = buildDeploymentPromotionReleaseEvidence(result);
  assert.equal(releaseEvidence.deploymentManifest, candidate.record.manifestDigest);
  assert.equal(releaseEvidence.findingsDisposition, candidate.record.reviewArtifacts.findingsDisposition);
  assert.equal(releaseEvidence.scope, "candidate-release-evidence-no-funding-authorization");
  const summary = buildDeploymentPromotionSummary(result);
  assert.equal(summary.providerCount, 2);
  assert.equal(summary.finalizedBlockNumber, candidate.record.finalizedBlockNumber);
  assert.equal(summary.postflightRecordDigest, candidate.record.postflightRecordDigest);
  assert.equal(JSON.stringify(summary).includes(candidate.approvers[0].wallet.privateKey), false);
});

test("release mapping and summary require module-private verification provenance", async () => {
  const result = await verify();
  const clone = structuredClone(result);
  assert.throws(() => buildDeploymentPromotionReleaseEvidence(clone), /provenance/);
  assert.throws(() => buildDeploymentPromotionSummary(clone), /provenance/);
});

test("promotion requires the exact live verified postflight, retained approvers, and matching deployment", async () => {
  const legacy = await fixture();
  legacy.record.schema = "treeswap.deployment-promotion-record.v1";
  await assert.rejects(() => attestations(legacy), /schema is invalid/);

  const unsupportedMainnet = await fixture();
  unsupportedMainnet.policy.environment = "capped-mainnet-beta";
  unsupportedMainnet.record.environment = "capped-mainnet-beta";
  await assert.rejects(() => attestations(unsupportedMainnet), /only the closed public-testnet/);

  const copied = await fixture();
  copied.postflightVerification = structuredClone(copied.postflightVerification);
  await assert.rejects(() => attestations(copied), /postflight provenance/);

  const substitutedDigest = await fixture();
  substitutedDigest.record.postflightRecordDigest = id("substituted postflight").toLowerCase();
  substitutedDigest.policy.postflightRecordDigest = substitutedDigest.record.postflightRecordDigest;
  await assert.rejects(() => attestations(substitutedDigest), /postflight record digest/);

  const replacedReviewer = await fixture();
  replacedReviewer.policy.approvers[0].approverId = id("replacement contract reviewer").toLowerCase();
  await assert.rejects(() => attestations(replacedReviewer), /retain the exact verified postflight approver set/);

  const wrongBlock = await fixture();
  wrongBlock.record.finalizedBlockHash = id("different promotion block").toLowerCase();
  await assert.rejects(() => attestations(wrongBlock), /postflight finalized block hash/);

  const late = await fixture();
  late.record.promotedAt = late.postflightVerification.validUntil + 1;
  late.record.validUntil = late.record.promotedAt + 60;
  await assert.rejects(() => attestations(late), /postflight validity window/);

  const malformed = await fixture();
  assert.throws(() => verifyDeploymentPromotionPostflightBundle({
    bundle: {
      schema: "treeswap.deployment-promotion-postflight-bundle.v1",
      plan: malformed.postflight.preflight.plan,
      preflightPolicy: malformed.postflight.preflight.policy,
      preflightRecord: malformed.postflight.preflight.record,
      preflightObservations: malformed.postflight.preflight.observations,
      preflightAttestations: malformed.postflight.preflight.attestations,
      policy: malformed.postflight.policy,
      record: malformed.postflight.record,
      observations: malformed.postflight.observations,
      attestations: malformed.postflightAttestations,
      trusted: true,
    },
    deploymentPolicy: malformed.deploymentPolicy,
    promotedAt: malformed.record.promotedAt,
  }), /fields are not exact/);
});

test("review bundle, deployment policy, implementation slot, topology, and code are exact", async () => {
  for (const mutate of [
    (candidate) => { candidate.record.reviewArtifacts.compilerInputs = id("changed compiler inputs").toLowerCase(); },
    (candidate) => { candidate.deploymentPolicy.absoluteMaxFeeBps = 50; },
    (candidate) => { candidate.observations[0].manifest.bit.implementationSlot = id("wrong slot").toLowerCase(); },
    (candidate) => { candidate.observations[0].manifest.paymentHashRegistry.sealed = false; },
    (candidate) => { candidate.observations[0].manifest.gate.codeHash = id("wrong code").toLowerCase(); },
    (candidate) => { candidate.observations[0].manifest.accounting.vaultBitBalanceWei = "1"; },
  ]) {
    const candidate = await fixture();
    mutate(candidate);
    await assert.rejects(() => attestations(candidate), /review|policy digest|implementation slot|disagree|manifest digest|approved/);
  }
});

test("promotion rejects nonzero, missing, malformed, or provider-disputed accounting", async () => {
  for (const mutate of [
    (candidate) => {
      candidate.observations[0].manifest.accounting.vaultTotalAvailableWei = "1";
      candidate.observations[0].manifest.accounting.vaultAccountedBalanceWei = "1";
      candidate.observations[0].manifest.accounting.vaultBitBalanceWei = "1";
    },
    (candidate) => { delete candidate.observations[0].manifest.accounting.vaultBitBalanceWei; },
    (candidate) => { candidate.observations[0].manifest.accounting.userEscrowTotalLockedWei = "01"; },
    (candidate) => { candidate.observations[1].manifest.accounting.userEscrowBitBalanceWei = "1"; },
  ]) {
    const candidate = await fixture();
    mutate(candidate);
    await assert.rejects(
      () => attestations(candidate),
      /accounting|inventory|liabilities|disagree|manifest digest|fields are not exact|canonical uint256/,
    );
  }
});

test("provider observations must be fresh, canonical, finalized, ordered, distinct, and identical", async () => {
  const mutations = [
    (candidate) => { candidate.observations[0].observedAt = new Date((NOW - 3_601) * 1_000).toISOString(); },
    (candidate) => { candidate.observations[0].stateAnchor.requireCanonical = false; },
    (candidate) => { candidate.observations[0].providerFinalizedHead.number = 99; },
    (candidate) => { candidate.observations.reverse(); },
    (candidate) => { candidate.observations[1].providerIdentity = candidate.observations[0].providerIdentity; },
    (candidate) => { candidate.observations[1].manifest.gate.defaultClosed = false; },
  ];
  for (const mutate of mutations) {
    const candidate = await fixture();
    mutate(candidate);
    await assert.rejects(() => attestations(candidate), /stale|canonical|finalized|ordered|match|disagree|manifest digest/);
  }
});

test("policy cannot weaken provider count, freshness, lifetime, reviewer roles, or signer separation", async () => {
  for (const mutate of [
    (candidate) => { candidate.policy.minimumProviderCount = 1; },
    (candidate) => { candidate.policy.maximumObservationAgeSeconds = 3_601; },
    (candidate) => { candidate.policy.maximumPromotionLifetimeSeconds = 86_401; },
    (candidate) => { candidate.policy.approvers = candidate.policy.approvers.filter((value) => value.role !== "contract-reviewer"); },
    (candidate) => { candidate.policy.approvers[1].signer = candidate.policy.approvers[0].signer; },
  ]) {
    const candidate = await fixture();
    mutate(candidate);
    await assert.rejects(() => attestations(candidate), /two to five|one hour|one day|reviewer|distinct/);
  }
});

test("missing, duplicate, wrong-role, replayed, and tampered attestations fail closed", async () => {
  const candidate = await fixture();
  const signed = await attestations(candidate);
  await assert.rejects(() => verify(candidate, signed.slice(1)), /every promotion approver/);
  await assert.rejects(() => verify(candidate, [...signed.slice(0, -1), signed[0]]), /ordered|duplicated|every promotion/);
  const wrongRole = structuredClone(signed);
  wrongRole[0].role = "provider";
  await assert.rejects(() => verify(candidate, wrongRole), /ordered|does not match|signature/);
  const replay = structuredClone(signed);
  replay[0].approverId = candidate.policy.approvers[1].approverId;
  await assert.rejects(() => verify(candidate, replay), /ordered|does not match|signature/);
  const changed = await fixture();
  changed.record.validUntil += 1;
  await assert.rejects(() => verify(changed, signed), /signature/);
});

test("future, expired, unknown-field, and secret-bearing promotions fail closed", async () => {
  const future = await fixture();
  const futureAttestations = await attestations(future);
  await assert.rejects(() => verify(future, futureAttestations, NOW - 1), /future-dated/);
  const expired = await fixture();
  const expiredAttestations = await attestations(expired);
  await assert.rejects(() => verify(expired, expiredAttestations, NOW + 3_601), /expired/);
  const unknown = await fixture();
  unknown.record.approved = true;
  await assert.rejects(() => attestations(unknown), /fields are not exact/);
  const unknownPolicy = await fixture();
  unknownPolicy.policy.assumeIndependent = true;
  await assert.rejects(() => attestations(unknownPolicy), /fields are not exact/);
  const unknownObservation = await fixture();
  unknownObservation.observations[0].rpcHealthy = true;
  await assert.rejects(() => attestations(unknownObservation), /fields are not exact/);
  const secret = await fixture();
  secret.observations[0].providerLabel = "https://private-rpc.example";
  secret.record.providerObservations[0].observationDigest = hash(secret.observations[0]);
  await assert.rejects(() => attestations(secret), /secret|endpoint/);
});

test("prepare and verify CLIs emit typed data and evidence without signing or funding", async () => {
  const candidate = await fixture();
  const signed = await attestations(candidate);
  const directory = await mkdtemp(join(tmpdir(), "treeswap-deployment-promotion-"));
  try {
    const values = {
      record: candidate.record,
      policy: candidate.policy,
      deploymentPolicy: candidate.deploymentPolicy,
      observations: candidate.observations,
      attestations: signed,
      postflightPlan: candidate.postflight.preflight.plan,
      postflightPreflightPolicy: candidate.postflight.preflight.policy,
      postflightPreflightRecord: candidate.postflight.preflight.record,
      postflightPreflightObservations: candidate.postflight.preflight.observations,
      postflightPreflightAttestations: candidate.postflight.preflight.attestations,
      postflightPolicy: candidate.postflight.policy,
      postflightRecord: candidate.postflight.record,
      postflightObservations: candidate.postflight.observations,
      postflightAttestations: candidate.postflightAttestations,
    };
    const paths = Object.fromEntries(Object.keys(values).map((name) => [name, join(directory, `${name}.json`)]));
    await Promise.all(Object.entries(values).map(([name, value]) => writeFile(
      paths[name], `${JSON.stringify(value)}\n`, { mode: 0o600 },
    )));
    const postflightBundle = join(directory, "postflight-bundle.json");
    const preparedBundle = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-deployment-promotion-postflight-bundle.mjs",
      "--plan", paths.postflightPlan,
      "--preflight-policy", paths.postflightPreflightPolicy,
      "--preflight-record", paths.postflightPreflightRecord,
      "--preflight-observations", paths.postflightPreflightObservations,
      "--preflight-attestations", paths.postflightPreflightAttestations,
      "--deployment-policy", paths.deploymentPolicy,
      "--policy", paths.postflightPolicy,
      "--record", paths.postflightRecord,
      "--observations", paths.postflightObservations,
      "--attestations", paths.postflightAttestations,
      "--promotion-record", paths.record,
      "--out", postflightBundle,
    ], { encoding: "utf8" }));
    assert.equal(preparedBundle.fundingAuthorization, false);
    const common = [
      "--record", paths.record,
      "--policy", paths.policy,
      "--deployment-policy", paths.deploymentPolicy,
      "--observations", paths.observations,
      "--postflight-bundle", postflightBundle,
    ];
    const approver = candidate.approvers[0];
    const prepared = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-deployment-promotion-approval.mjs",
      ...common,
      "--role", approver.role,
      "--approver-id", approver.approverId,
    ], { encoding: "utf8" }));
    assert.equal(prepared.primaryType, "ManifestPromotionApproval");
    assert.match(prepared.scope, /no-funding-authorization/);
    assert.equal(JSON.stringify(prepared).includes("privateKey"), false);

    const verified = JSON.parse(execFileSync(process.execPath, [
      "scripts/verify-deployment-promotion.mjs",
      ...common,
      "--attestations", paths.attestations,
    ], { encoding: "utf8" }));
    assert.equal(verified.status, "cryptographically-verified-deployment-promotion");
    assert.match(verified.scope, /no-funding-authorization/);
    assert.match(verified.releaseEvidence.scope, /no-funding-authorization/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
