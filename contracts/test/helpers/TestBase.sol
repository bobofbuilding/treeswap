// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface Vm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function chainId(uint256 newChainId) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 actual, uint256 expected, string memory reason) internal pure {
        require(actual == expected, reason);
    }

    function assertEq(address actual, address expected, string memory reason) internal pure {
        require(actual == expected, reason);
    }

    function assertTrue(bool value, string memory reason) internal pure {
        require(value, reason);
    }
}

contract MockBit {
    string public constant name = "Mock BIT";
    string public constant symbol = "BIT";
    uint8 public decimals = 18;
    bool public paused;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function setDecimals(uint8 value) external {
        decimals = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[owner][msg.sender];
        if (allowed != type(uint256).max) allowance[owner][msg.sender] = allowed - amount;
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract MockOpenGate {
    bool public open = true;

    function setOpen(bool value) external {
        open = value;
    }

    function isOpen() external view returns (bool) {
        return open;
    }
}

contract MockPaymentHashRegistry {
    error PaymentHashAlreadyUsed();

    mapping(bytes32 paymentHash => bool used) public paymentHashUsed;

    function consumePaymentHash(bytes32 paymentHash) external {
        if (paymentHashUsed[paymentHash]) revert PaymentHashAlreadyUsed();
        paymentHashUsed[paymentHash] = true;
    }
}

contract Mock1271Wallet {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;
    uint256 internal constant SECP256K1N_DIV_2 = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_DIV_2 || (v != 27 && v != 28)) return 0xffffffff;
        return ecrecover(digest, v, r, s) == owner ? MAGIC_VALUE : bytes4(0xffffffff);
    }
}
