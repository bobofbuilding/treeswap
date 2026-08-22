import {
  formatUnits,
  getAddress,
  id,
  TypedDataEncoder,
  verifyTypedData,
} from "ethers";

function frozenTypedFields(fields) {
  return Object.freeze(fields.map((field) => Object.freeze({ ...field })));
}

export const USER_SELECTION_AUTHORIZATION_FIELDS = frozenTypedFields([
  { name: "pricingId", type: "bytes32" },
  { name: "pricingDigest", type: "bytes32" },
  { name: "receivedSetDigest", type: "bytes32" },
  { name: "selectedBlindOfferDigest", type: "bytes32" },
  { name: "requestId", type: "bytes32" },
  { name: "requestDigest", type: "bytes32" },
  { name: "direction", type: "bytes32" },
  { name: "user", type: "address" },
  { name: "beneficiary", type: "address" },
  { name: "selectedSolver", type: "address" },
  { name: "grossBitAmount", type: "uint256" },
  { name: "feeBitAmount", type: "uint256" },
  { name: "lightningAmountSats", type: "uint64" },
  { name: "maxRoutingFeeSats", type: "uint64" },
  { name: "paymentHash", type: "bytes32" },
  { name: "invoiceDigest", type: "bytes32" },
  { name: "requestNonce", type: "uint256" },
  { name: "quoteExpiresAt", type: "uint64" },
  { name: "authorizationExpiresAt", type: "uint64" },
]);

export const USER_EXECUTION_AUTHORIZATION_FIELDS = frozenTypedFields([
  { name: "selectionAuthorizationDigest", type: "bytes32" },
  { name: "requestDigest", type: "bytes32" },
  { name: "executableOfferDigest", type: "bytes32" },
  { name: "executionBindingDigest", type: "bytes32" },
  { name: "direction", type: "bytes32" },
  { name: "user", type: "address" },
  { name: "beneficiary", type: "address" },
  { name: "selectedSolver", type: "address" },
  { name: "grossBitAmount", type: "uint256" },
  { name: "feeBitAmount", type: "uint256" },
  { name: "lightningAmountSats", type: "uint64" },
  { name: "maxRoutingFeeSats", type: "uint64" },
  { name: "paymentHash", type: "bytes32" },
  { name: "invoiceDigest", type: "bytes32" },
  { name: "quoteExpiresAt", type: "uint64" },
  { name: "authorizationExpiresAt", type: "uint64" },
]);

export const USER_SELECTION_AUTHORIZATION_TYPES = Object.freeze({
  UserSelectionAuthorization: USER_SELECTION_AUTHORIZATION_FIELDS,
});
export const USER_EXECUTION_AUTHORIZATION_TYPES = Object.freeze({
  UserExecutionAuthorization: USER_EXECUTION_AUTHORIZATION_FIELDS,
});

const EIP712_DOMAIN_FIELDS = frozenTypedFields([
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
]);
const BYTES32 = /^0x[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const DIRECTION_BY_DIGEST = new Map([
  [id("lightning-to-bit"), "lightning-to-bit"],
  [id("bit-to-lightning"), "bit-to-lightning"],
]);
const VERIFIED_PROMPTS = new WeakMap();
const IN_FLIGHT_PROMPTS = new WeakSet();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function address(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function uint(value, name, maximum) {
  const raw = String(value ?? "");
  if (!UINT_DECIMAL.test(raw) || raw.length > maximum.toString().length) {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
  const parsed = BigInt(raw);
  if (parsed > maximum) throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  return parsed;
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function observedNow(value) {
  const raw = typeof value === "function" ? value() : value;
  const now = raw === undefined ? Math.floor(Date.now() / 1_000) : raw;
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative safe integer");
  return now;
}

function observedSigningNow(clock) {
  if (clock !== undefined && typeof clock !== "function") {
    throw new TypeError("wallet signing clock override must be a function");
  }
  return observedNow(clock);
}

function normalizedDomain(raw) {
  exactKeys(raw, ["name", "version", "chainId", "verifyingContract"], "user authorization domain");
  if (raw.name !== "TreeSwap User Confirmation" || raw.version !== "1") {
    throw new Error("user authorization domain changed");
  }
  const chainId = uint(raw.chainId, "domain.chainId", UINT256_MAX);
  if (chainId === 0n) throw new RangeError("user authorization chain must be positive");
  return Object.freeze({
    name: raw.name,
    version: raw.version,
    chainId,
    verifyingContract: address(raw.verifyingContract, "domain.verifyingContract"),
  });
}

function exactTypes(raw, primaryType, fields) {
  exactKeys(raw, [primaryType], "user authorization types");
  if (!Array.isArray(raw[primaryType]) || raw[primaryType].length !== fields.length) {
    throw new TypeError("user authorization typed fields changed");
  }
  raw[primaryType].forEach((field, index) => {
    exactKeys(field, ["name", "type"], `user authorization typed field ${index}`);
    if (field.name !== fields[index].name || field.type !== fields[index].type) {
      throw new Error("user authorization typed fields changed");
    }
  });
}

function normalizedMessage(raw, fields) {
  exactKeys(raw, fields.map(({ name }) => name), "user authorization message");
  const message = {};
  for (const field of fields) {
    if (field.type === "address") {
      message[field.name] = address(raw[field.name], `message.${field.name}`);
    } else if (field.type === "bytes32") {
      message[field.name] = bytes32(raw[field.name], `message.${field.name}`);
    } else if (field.type === "uint64") {
      message[field.name] = uint(raw[field.name], `message.${field.name}`, UINT64_MAX);
    } else if (field.type === "uint256") {
      message[field.name] = uint(raw[field.name], `message.${field.name}`, UINT256_MAX);
    } else {
      throw new TypeError("user authorization field type is unsupported");
    }
  }
  return Object.freeze(message);
}

function authorizationShape(step) {
  if (step === "selection") {
    return Object.freeze({
      fields: USER_SELECTION_AUTHORIZATION_FIELDS,
      primaryType: "UserSelectionAuthorization",
      types: USER_SELECTION_AUTHORIZATION_TYPES,
    });
  }
  if (step === "execution") {
    return Object.freeze({
      fields: USER_EXECUTION_AUTHORIZATION_FIELDS,
      primaryType: "UserExecutionAuthorization",
      types: USER_EXECUTION_AUTHORIZATION_TYPES,
    });
  }
  throw new RangeError("user authorization step is unsupported");
}

function normalizedMaterial(raw, step, name) {
  exactKeys(raw, ["digest", "domain", "message", "types"], name);
  const shape = authorizationShape(step);
  exactTypes(raw.types, shape.primaryType, shape.fields);
  const domain = normalizedDomain(raw.domain);
  const message = normalizedMessage(raw.message, shape.fields);
  const digest = TypedDataEncoder.hash(domain, shape.types, message);
  if (bytes32(raw.digest, `${name}.digest`) !== digest) {
    throw new Error(`${name} digest does not match its exact typed data`);
  }
  return Object.freeze({ ...shape, digest, domain, message });
}

function directionFrom(message) {
  const direction = DIRECTION_BY_DIGEST.get(message.direction);
  if (!direction) throw new Error("user authorization direction is unsupported");
  return direction;
}

function checkSemantics(step, material, now) {
  const message = material.message;
  const direction = directionFrom(message);
  if (message.grossBitAmount === 0n || message.lightningAmountSats === 0n) {
    throw new RangeError("user authorization amounts must be positive");
  }
  if (message.feeBitAmount >= message.grossBitAmount) {
    throw new RangeError("user authorization BIT fee must be below the gross BIT amount");
  }
  if (message.quoteExpiresAt <= BigInt(now)) throw new Error("user authorization quote is expired");
  if (message.authorizationExpiresAt <= BigInt(now)
      || message.authorizationExpiresAt > message.quoteExpiresAt
      || message.authorizationExpiresAt - BigInt(now) > 120n) {
    throw new Error("user authorization is expired or outside its short-lived window");
  }
  const hasPaymentHash = message.paymentHash !== ZERO_BYTES32;
  const hasInvoiceDigest = message.invoiceDigest !== ZERO_BYTES32;
  if (hasPaymentHash !== hasInvoiceDigest) {
    throw new Error("user authorization invoice commitments are incomplete");
  }
  if (step === "execution" && !hasPaymentHash) {
    throw new Error("execution authorization must bind the exact invoice and payment hash");
  }
  if (step === "selection" && direction === "lightning-to-bit" && hasPaymentHash) {
    throw new Error("Lightning-to-BIT selection cannot prebind a solver invoice");
  }
  if (step === "selection" && direction === "bit-to-lightning" && !hasPaymentHash) {
    throw new Error("BIT-to-Lightning selection must bind the user's exact invoice");
  }
  return direction;
}

function serializedDomain(domain) {
  return Object.freeze({
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId.toString(),
    verifyingContract: domain.verifyingContract,
  });
}

function serializedMessage(message, fields) {
  return Object.freeze(Object.fromEntries(fields.map((field) => [
    field.name,
    typeof message[field.name] === "bigint" ? message[field.name].toString() : message[field.name],
  ])));
}

function protocolMessage(message, fields) {
  return Object.freeze(Object.fromEntries(fields.map((field) => [
    field.name,
    field.name === "quoteExpiresAt" || field.name === "authorizationExpiresAt"
      ? Number(message[field.name])
      : message[field.name],
  ])));
}

function isoTimestamp(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("user authorization timestamp is too large");
  return new Date(Number(value) * 1_000).toISOString();
}

function readableReview(step, material, direction) {
  const message = material.message;
  const netBitAmount = message.grossBitAmount - message.feeBitAmount;
  const paymentCommitted = message.paymentHash !== ZERO_BYTES32;
  return Object.freeze({
    step,
    title: step === "selection" ? "Reserve this quote" : "Authorize this exact invoice",
    effect: step === "selection"
      ? "Reserves the selected solver's capacity and permits private quote finalization. It does not move funds."
      : "Authorizes only this finalized quote and invoice until the signed expiry. It is not a token allowance.",
    direction,
    network: material.domain.chainId === 1n ? "Ethereum mainnet" : `EVM chain ${material.domain.chainId}`,
    signer: message.user,
    beneficiary: message.beneficiary,
    selectedSolver: message.selectedSolver,
    verifyingContract: material.domain.verifyingContract,
    youPay: direction === "lightning-to-bit"
      ? `${message.lightningAmountSats} sats`
      : `${formatUnits(message.grossBitAmount, 18)} BIT`,
    youReceive: direction === "lightning-to-bit"
      ? `${formatUnits(netBitAmount, 18)} BIT`
      : `${message.lightningAmountSats} sats`,
    grossBitAmount: `${formatUnits(message.grossBitAmount, 18)} BIT`,
    feeBitAmount: `${formatUnits(message.feeBitAmount, 18)} BIT`,
    maximumRoutingFee: `${message.maxRoutingFeeSats} sats`,
    paymentHash: message.paymentHash,
    invoiceDigest: message.invoiceDigest,
    invoiceCommitment: paymentCommitted
      ? "Exact invoice digest and payment hash are bound"
      : "Selected solver invoice is created only after this quote reservation",
    quoteExpiresAt: isoTimestamp(message.quoteExpiresAt),
    authorizationExpiresAt: isoTimestamp(message.authorizationExpiresAt),
    receivedSetDigest: step === "selection" ? message.receivedSetDigest : null,
    selectedOfferDigest: step === "selection" ? message.selectedBlindOfferDigest : message.executableOfferDigest,
    bindingDigest: step === "execution" ? message.executionBindingDigest : message.requestDigest,
  });
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function chainHex(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("wallet returned a malformed chain identifier");
  }
  return BigInt(value);
}

function activeWallet(accounts, expected) {
  if (!Array.isArray(accounts) || accounts.length === 0 || !sameAddress(accounts[0], expected)) {
    throw new Error("connect the exact RFQ wallet before signing");
  }
}

export function userAuthorizationDomain({ chainId, verifyingContract }) {
  const domain = normalizedDomain({
    name: "TreeSwap User Confirmation",
    version: "1",
    chainId,
    verifyingContract,
  });
  return domain;
}

/**
 * Produces the only wallet-signable representation of an exact authorization.
 * `expected` must be independently derived by the local verified RFQ path.
 */
export function prepareExactUserAuthorizationPrompt({ step, material, expected, now }) {
  const observedAt = observedNow(now);
  const received = normalizedMaterial(material, step, "received user authorization");
  const locallyExpected = normalizedMaterial(expected, step, "expected user authorization");
  if (received.digest !== locallyExpected.digest) {
    throw new Error("received user authorization does not match the locally expected exact terms");
  }
  const direction = checkSemantics(step, received, observedAt);
  checkSemantics(step, locallyExpected, observedAt);
  const typedData = Object.freeze({
    domain: serializedDomain(received.domain),
    primaryType: received.primaryType,
    types: Object.freeze({
      EIP712Domain: EIP712_DOMAIN_FIELDS,
      [received.primaryType]: received.fields,
    }),
    message: serializedMessage(received.message, received.fields),
  });
  const prompt = Object.freeze({
    schema: "treeswap.user-authorization-prompt.v1",
    step,
    digest: received.digest,
    signer: received.message.user,
    chainId: received.domain.chainId.toString(),
    primaryType: received.primaryType,
    typedData,
    review: readableReview(step, received, direction),
  });
  VERIFIED_PROMPTS.set(prompt, Object.freeze({
    material: received,
    protocolMessage: protocolMessage(received.message, received.fields),
  }));
  return prompt;
}

/**
 * Requests one exact EIP-712 signature without switching chain or account.
 * The caller must pass the original verified prompt; serialized/copy inputs fail.
 */
export async function signExactUserAuthorizationPrompt({ provider, prompt, now }) {
  const context = VERIFIED_PROMPTS.get(prompt);
  if (!context) throw new TypeError("wallet signing requires the original verified user authorization prompt");
  if (!provider || typeof provider.request !== "function") {
    throw new TypeError("an EIP-1193 wallet provider is required");
  }
  if (IN_FLIGHT_PROMPTS.has(prompt)) throw new Error("this user authorization prompt is already awaiting a wallet");
  checkSemantics(prompt.step, context.material, observedSigningNow(now));
  IN_FLIGHT_PROMPTS.add(prompt);
  try {
    const [beforeChain, beforeAccounts] = await Promise.all([
      provider.request({ method: "eth_chainId" }),
      provider.request({ method: "eth_accounts" }),
    ]);
    if (chainHex(beforeChain) !== context.material.domain.chainId) {
      throw new Error("wallet chain does not match the exact authorization domain");
    }
    activeWallet(beforeAccounts, prompt.signer);
    const signature = String(await provider.request({
      method: "eth_signTypedData_v4",
      params: [prompt.signer, JSON.stringify(prompt.typedData)],
    }));
    if (!SIGNATURE.test(signature)) throw new Error("wallet returned a malformed EIP-712 signature");
    let recovered;
    try {
      recovered = verifyTypedData(
        context.material.domain,
        context.material.types,
        context.material.message,
        signature,
      );
    } catch {
      throw new Error("wallet signature does not authorize the exact displayed terms");
    }
    if (!sameAddress(recovered, prompt.signer)) {
      throw new Error("wallet signature does not match the exact RFQ user");
    }
    const [afterChain, afterAccounts] = await Promise.all([
      provider.request({ method: "eth_chainId" }),
      provider.request({ method: "eth_accounts" }),
    ]);
    if (chainHex(afterChain) !== context.material.domain.chainId) {
      throw new Error("wallet chain changed while authorizing the swap");
    }
    activeWallet(afterAccounts, prompt.signer);
    const authorizedAt = observedSigningNow(now);
    checkSemantics(prompt.step, context.material, authorizedAt);
    return Object.freeze({
      schema: "treeswap.user-authorization-signature.v1",
      step: prompt.step,
      digest: prompt.digest,
      signer: prompt.signer,
      authorization: context.protocolMessage,
      signature,
      authorizedAt,
    });
  } finally {
    IN_FLIGHT_PROMPTS.delete(prompt);
  }
}
