const SOURCE_COMMITMENTS = Object.freeze({
  "contracts/src/TreeSwapBitVault.sol": "0xb1941d4f04141c5ebf2e8311a88cd1b29eb6497d6799f8ff0de2063091a5b433",
  "contracts/src/TreeSwapOpenGate.sol": "0x4a89f0ee93c72f7b70b7d908187fb8635b77f30ffc0e682ab1756eefd49f0e44",
  "contracts/src/TreeSwapPaymentHashRegistry.sol": "0xc6bd68f7851d0c65c1d76ca28e96860e983c750ec2fbd872c86a43de8c22f582",
  "contracts/src/TreeSwapSignatureChecker.sol": "0xf1bbe74a6e3559bf50a297a9da46d5f73a5acd1cab49709c4b8fc688b1788fa3",
  "contracts/src/TreeSwapUserEscrow.sol": "0x0db90d51a4fa643daf521f9162cac9215cdf6df85436e240b7d5a9b08a7b875b",
});

const addressInput = (name) => ({ name, type: "address", internalType: "address" });
const uintInput = (name, bits) => ({ name, type: `uint${bits}`, internalType: `uint${bits}` });
const riskComponents = Object.freeze([
  uintInput("maxFeeBps", 16),
  uintInput("maxPriceDeviationBps", 16),
  uintInput("referenceSatsPerBit", 32),
  uintInput("epochDuration", 32),
  uintInput("minSettlementWindow", 32),
  uintInput("minClaimBuffer", 32),
  uintInput("maxLockDuration", 32),
  uintInput("maxSwapAmount", 96),
  uintInput("maxEpochVolume", 96),
]);

function constructor(inputs) {
  return { type: "constructor", inputs, stateMutability: "nonpayable" };
}

function artifact({ abi, code, contract, path, sourcePaths }) {
  return {
    abi,
    bytecode: { object: `0x600${code}6000`, linkReferences: {} },
    deployedBytecode: { object: `0x600${code}`, linkReferences: {}, immutableReferences: {} },
    metadata: {
      compiler: { version: "0.8.24+commit.e11b9ed9" },
      settings: {
        optimizer: { enabled: true, runs: 20_000 },
        evmVersion: "cancun",
        metadata: { bytecodeHash: "ipfs" },
        compilationTarget: { [path]: contract },
      },
      sources: Object.fromEntries(sourcePaths.map((sourcePath) => [sourcePath, {
        keccak256: SOURCE_COMMITMENTS[sourcePath],
      }])),
    },
  };
}

export function closedTestnetArtifactFixtures() {
  const riskInput = {
    name: "config",
    type: "tuple",
    internalType: "struct RiskConfig",
    components: riskComponents,
  };
  return structuredClone({
    gate: artifact({
      abi: [constructor([
        addressInput("controller_"),
        addressInput("guardian_"),
        uintInput("resumeDelay_", 32),
        uintInput("maxOpenDuration_", 32),
      ])],
      code: "1",
      contract: "TreeSwapOpenGate",
      path: "contracts/src/TreeSwapOpenGate.sol",
      sourcePaths: ["contracts/src/TreeSwapOpenGate.sol"],
    }),
    paymentHashRegistry: artifact({
      abi: [
        constructor([addressInput("registrar_")]),
        {
          type: "function",
          name: "registerEscrow",
          inputs: [addressInput("escrow")],
          outputs: [],
          stateMutability: "nonpayable",
        },
        { type: "function", name: "seal", inputs: [], outputs: [], stateMutability: "nonpayable" },
      ],
      code: "2",
      contract: "TreeSwapPaymentHashRegistry",
      path: "contracts/src/TreeSwapPaymentHashRegistry.sol",
      sourcePaths: ["contracts/src/TreeSwapPaymentHashRegistry.sol"],
    }),
    vault: artifact({
      abi: [constructor([
        addressInput("bit"),
        addressInput("collector"),
        addressInput("gate"),
        addressInput("hashRegistry"),
        riskInput,
      ])],
      code: "3",
      contract: "TreeSwapBitVault",
      path: "contracts/src/TreeSwapBitVault.sol",
      sourcePaths: ["contracts/src/TreeSwapBitVault.sol", "contracts/src/TreeSwapSignatureChecker.sol"],
    }),
    userEscrow: artifact({
      abi: [constructor([
        addressInput("bit"),
        addressInput("collector"),
        addressInput("gate"),
        addressInput("hashRegistry"),
        riskInput,
      ])],
      code: "4",
      contract: "TreeSwapUserEscrow",
      path: "contracts/src/TreeSwapUserEscrow.sol",
      sourcePaths: ["contracts/src/TreeSwapUserEscrow.sol", "contracts/src/TreeSwapSignatureChecker.sol"],
    }),
  });
}
