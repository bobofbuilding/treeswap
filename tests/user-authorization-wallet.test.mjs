import assert from "node:assert/strict";
import test from "node:test";
import { id, TypedDataEncoder, Wallet } from "ethers";
import {
  USER_EXECUTION_AUTHORIZATION_TYPES,
  USER_SELECTION_AUTHORIZATION_TYPES,
  prepareExactUserAuthorizationPrompt,
  signExactUserAuthorizationPrompt,
  userAuthorizationDomain,
} from "../lib/user-authorization-wallet.mjs";

const NOW = 2_000_000_000;
const BIT = 10n ** 18n;
const user = new Wallet(`0x${"51".repeat(32)}`);
const other = new Wallet(`0x${"52".repeat(32)}`);
const solver = "0x3333333333333333333333333333333333333333";
const beneficiary = "0x4444444444444444444444444444444444444444";
const verifyingContract = "0x5555555555555555555555555555555555555555";
const domain = userAuthorizationDomain({ chainId: 1, verifyingContract });

function authorizationMaterial(step, overrides = {}) {
  const selection = {
    pricingId: id("wallet pricing"),
    pricingDigest: id("wallet pricing digest"),
    receivedSetDigest: id("wallet received set"),
    selectedBlindOfferDigest: id("wallet selected offer"),
    requestId: id("wallet request"),
    requestDigest: id("wallet request digest"),
    direction: id("bit-to-lightning"),
    user: user.address,
    beneficiary,
    selectedSolver: solver,
    grossBitAmount: 252n * BIT,
    feeBitAmount: 2n * BIT,
    lightningAmountSats: 25_000n,
    maxRoutingFeeSats: 20n,
    paymentHash: id("wallet payment hash"),
    invoiceDigest: id("wallet invoice digest"),
    requestNonce: 7n,
    quoteExpiresAt: NOW + 90,
    authorizationExpiresAt: NOW + 60,
  };
  const execution = {
    selectionAuthorizationDigest: id("wallet selection authorization"),
    requestDigest: selection.requestDigest,
    executableOfferDigest: id("wallet executable offer"),
    executionBindingDigest: id("wallet execution binding"),
    direction: selection.direction,
    user: selection.user,
    beneficiary: selection.beneficiary,
    selectedSolver: selection.selectedSolver,
    grossBitAmount: selection.grossBitAmount,
    feeBitAmount: selection.feeBitAmount,
    lightningAmountSats: selection.lightningAmountSats,
    maxRoutingFeeSats: selection.maxRoutingFeeSats,
    paymentHash: selection.paymentHash,
    invoiceDigest: selection.invoiceDigest,
    quoteExpiresAt: selection.quoteExpiresAt,
    authorizationExpiresAt: selection.authorizationExpiresAt,
  };
  const types = step === "selection"
    ? USER_SELECTION_AUTHORIZATION_TYPES
    : USER_EXECUTION_AUTHORIZATION_TYPES;
  const message = { ...(step === "selection" ? selection : execution), ...overrides };
  return {
    domain,
    types,
    message,
    digest: TypedDataEncoder.hash(domain, types, message),
  };
}

function walletProvider({
  signer = user,
  chainId = "0x1",
  chainAfterSignature = chainId,
  firstAccount = user.address,
  accountAfterSignature = firstAccount,
  signatureGate = null,
  signatureOverride = null,
  rejectedSignatures = 0,
} = {}) {
  const calls = [];
  let signed = false;
  let remainingRejections = rejectedSignatures;
  let markSignatureRequested;
  const signatureRequested = new Promise((resolve) => {
    markSignatureRequested = resolve;
  });
  return {
    calls,
    signatureRequested,
    async request({ method, params }) {
      calls.push(method);
      if (method === "eth_chainId") return signed ? chainAfterSignature : chainId;
      if (method === "eth_accounts") return [signed ? accountAfterSignature : firstAccount];
      if (method === "eth_signTypedData_v4") {
        markSignatureRequested();
        if (signatureGate) await signatureGate;
        if (remainingRejections > 0) {
          remainingRejections -= 1;
          throw new Error("User rejected the request");
        }
        assert.equal(params[0], user.address);
        const typedData = JSON.parse(params[1]);
        const types = { ...typedData.types };
        delete types.EIP712Domain;
        const signature = signatureOverride
          ?? await signer.signTypedData(typedData.domain, types, typedData.message);
        signed = true;
        return signature;
      }
      throw new Error(`unexpected wallet method ${method}`);
    },
  };
}

test("renders and signs the exact first quote-reservation confirmation", async () => {
  const material = authorizationMaterial("selection");
  const prompt = prepareExactUserAuthorizationPrompt({
    step: "selection",
    material,
    expected: material,
    now: NOW,
  });

  assert.equal(prompt.schema, "treeswap.user-authorization-prompt.v1");
  assert.equal(prompt.primaryType, "UserSelectionAuthorization");
  assert.equal(prompt.review.title, "Reserve this quote");
  assert.match(prompt.review.effect, /does not move funds/i);
  assert.equal(prompt.review.youPay, "252.0 BIT");
  assert.equal(prompt.review.youReceive, "25000 sats");
  assert.equal(prompt.review.feeBitAmount, "2.0 BIT");
  assert.equal(prompt.review.paymentHash, material.message.paymentHash);
  assert.equal(prompt.review.receivedSetDigest, material.message.receivedSetDigest);
  assert.equal(prompt.typedData.domain.chainId, "1");
  assert.equal(prompt.typedData.message.grossBitAmount, (252n * BIT).toString());

  const provider = walletProvider();
  const signed = await signExactUserAuthorizationPrompt({ provider, prompt, now: () => NOW + 1 });
  assert.equal(signed.schema, "treeswap.user-authorization-signature.v1");
  assert.equal(signed.digest, material.digest);
  assert.equal(signed.signer, user.address);
  assert.equal(signed.authorization.quoteExpiresAt, NOW + 90);
  assert.equal(signed.authorization.authorizationExpiresAt, NOW + 60);
  assert.deepEqual(provider.calls, [
    "eth_chainId",
    "eth_accounts",
    "eth_signTypedData_v4",
    "eth_chainId",
    "eth_accounts",
  ]);
  assert.equal(provider.calls.includes("wallet_switchEthereumChain"), false);
  assert.equal(provider.calls.includes("eth_requestAccounts"), false);
});

test("makes the second confirmation bind the full executable invoice", async () => {
  const material = authorizationMaterial("execution");
  const prompt = prepareExactUserAuthorizationPrompt({
    step: "execution",
    material,
    expected: material,
    now: NOW,
  });

  assert.equal(prompt.primaryType, "UserExecutionAuthorization");
  assert.equal(prompt.review.title, "Authorize this exact invoice");
  assert.match(prompt.review.effect, /not a token allowance/i);
  assert.equal(prompt.review.invoiceCommitment, "Exact invoice digest and payment hash are bound");
  assert.equal(prompt.review.invoiceDigest, material.message.invoiceDigest);
  assert.equal(prompt.review.paymentHash, material.message.paymentHash);
  assert.equal(prompt.review.bindingDigest, material.message.executionBindingDigest);

  await assert.rejects(
    signExactUserAuthorizationPrompt({ provider: walletProvider({ chainId: "0xaa36a7" }), prompt, now: () => NOW }),
    /wallet chain does not match/,
  );
  await assert.rejects(
    signExactUserAuthorizationPrompt({ provider: walletProvider({ firstAccount: other.address }), prompt, now: () => NOW }),
    /connect the exact RFQ wallet/,
  );
  await assert.rejects(
    signExactUserAuthorizationPrompt({ provider: walletProvider({ signer: other }), prompt, now: () => NOW }),
    /signature does not match the exact RFQ user/,
  );
  await assert.rejects(
    signExactUserAuthorizationPrompt({
      provider: walletProvider({ accountAfterSignature: other.address }),
      prompt,
      now: () => NOW,
    }),
    /connect the exact RFQ wallet/,
  );
  await assert.rejects(
    signExactUserAuthorizationPrompt({
      provider: walletProvider({ chainAfterSignature: "0xaa36a7" }),
      prompt,
      now: () => NOW,
    }),
    /wallet chain changed/,
  );
  await assert.rejects(
    signExactUserAuthorizationPrompt({
      provider: walletProvider({ signatureOverride: "0xdeadbeef" }),
      prompt,
      now: () => NOW,
    }),
    /malformed EIP-712 signature/,
  );
});

test("rejects concurrent wallet prompts and permits a clean retry after rejection", async () => {
  const material = authorizationMaterial("execution");
  const prompt = prepareExactUserAuthorizationPrompt({
    step: "execution",
    material,
    expected: material,
    now: NOW,
  });
  let releaseSignature;
  const signatureGate = new Promise((resolve) => {
    releaseSignature = resolve;
  });
  const waitingProvider = walletProvider({ signatureGate });
  const firstAttempt = signExactUserAuthorizationPrompt({
    provider: waitingProvider,
    prompt,
    now: () => NOW,
  });
  await waitingProvider.signatureRequested;
  await assert.rejects(
    signExactUserAuthorizationPrompt({ provider: walletProvider(), prompt, now: () => NOW }),
    /already awaiting a wallet/,
  );
  releaseSignature();
  assert.equal((await firstAttempt).signer, user.address);

  const retryProvider = walletProvider({ rejectedSignatures: 1 });
  await assert.rejects(
    signExactUserAuthorizationPrompt({ provider: retryProvider, prompt, now: () => NOW }),
    /User rejected the request/,
  );
  assert.equal(
    (await signExactUserAuthorizationPrompt({ provider: retryProvider, prompt, now: () => NOW })).signer,
    user.address,
  );

  await assert.rejects(
    signExactUserAuthorizationPrompt({ provider: walletProvider(), prompt, now: NOW }),
    /wallet signing clock override must be a function/,
  );

  let releaseExpiredSignature;
  let clockNow = NOW;
  const expiryGate = new Promise((resolve) => {
    releaseExpiredSignature = resolve;
  });
  const expiryProvider = walletProvider({ signatureGate: expiryGate });
  const expiringAttempt = signExactUserAuthorizationPrompt({
    provider: expiryProvider,
    prompt,
    now: () => clockNow,
  });
  await expiryProvider.signatureRequested;
  clockNow = NOW + 60;
  releaseExpiredSignature();
  await assert.rejects(expiringAttempt, /expired or outside its short-lived window/);
});

test("rejects copied prompts, changed typed data, incomplete commitments, and expiry", async () => {
  const material = authorizationMaterial("selection");
  const changed = authorizationMaterial("selection", { beneficiary: other.address });
  assert.throws(() => prepareExactUserAuthorizationPrompt({
    step: "selection",
    material: changed,
    expected: material,
    now: NOW,
  }), /does not match the locally expected exact terms/);

  const changedTypes = {
    ...material,
    types: {
      UserSelectionAuthorization: material.types.UserSelectionAuthorization.map((field, index) => (
        index === 0 ? { ...field, name: "substitutedPricingId" } : field
      )),
    },
  };
  assert.throws(() => prepareExactUserAuthorizationPrompt({
    step: "selection",
    material: changedTypes,
    expected: material,
    now: NOW,
  }), /typed fields changed/);

  const incomplete = authorizationMaterial("selection", { invoiceDigest: `0x${"00".repeat(32)}` });
  assert.throws(() => prepareExactUserAuthorizationPrompt({
    step: "selection",
    material: incomplete,
    expected: incomplete,
    now: NOW,
  }), /invoice commitments are incomplete/);

  assert.throws(() => prepareExactUserAuthorizationPrompt({
    step: "selection",
    material,
    expected: material,
    now: NOW + 60,
  }), /expired or outside/);

  const prompt = prepareExactUserAuthorizationPrompt({
    step: "selection",
    material,
    expected: material,
    now: NOW,
  });
  await assert.rejects(
    signExactUserAuthorizationPrompt({ provider: walletProvider(), prompt: { ...prompt }, now: () => NOW }),
    /original verified user authorization prompt/,
  );
});

test("shows that a Lightning-to-BIT first confirmation has no invoice yet", () => {
  const zero = `0x${"00".repeat(32)}`;
  const material = authorizationMaterial("selection", {
    direction: id("lightning-to-bit"),
    paymentHash: zero,
    invoiceDigest: zero,
  });
  const prompt = prepareExactUserAuthorizationPrompt({
    step: "selection",
    material,
    expected: material,
    now: NOW,
  });
  assert.equal(prompt.review.direction, "lightning-to-bit");
  assert.match(prompt.review.invoiceCommitment, /created only after/i);
  assert.equal(prompt.review.youPay, "25000 sats");
  assert.equal(prompt.review.youReceive, "250.0 BIT");

  const execution = authorizationMaterial("execution", { direction: id("lightning-to-bit") });
  assert.doesNotThrow(() => prepareExactUserAuthorizationPrompt({
    step: "execution",
    material: execution,
    expected: execution,
    now: NOW,
  }));
});
