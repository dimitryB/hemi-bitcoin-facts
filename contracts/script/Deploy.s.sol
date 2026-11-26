// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {BitcoinFacts} from "../src/BitcoinFacts.sol";
import {PopFinality} from "../src/PopFinality.sol";
import {FidelityBonds} from "../src/FidelityBonds.sol";

/// @notice Deployment constants shared by the script, the tests and (by value) the SDK and check-live.sh.
library Deployments {
    uint256 internal constant HEMI_MAINNET = 43_111;
    uint256 internal constant HEMI_TESTNET = 743_111;

    /// Arachnid's deterministic deployer, present on both Hemi networks (docs/BRIEF.md, facilitator D-003).
    /// Calldata is `<32-byte salt><initcode>`; it CREATE2s the initcode and returns the 20-byte address.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// keccak256 of the deployer's standard runtime code.
    bytes32 internal constant CREATE2_DEPLOYER_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    /// One salt per contract and version: keccak256("hemi-bitcoin-facts/<Contract>/v<N>"). A new version of a
    /// contract gets a new salt (and, with new code, a new address anyway).
    bytes32 internal constant BITCOIN_FACTS_SALT = keccak256("hemi-bitcoin-facts/BitcoinFacts/v1");
    bytes32 internal constant POP_FINALITY_SALT = keccak256("hemi-bitcoin-facts/PopFinality/v1");
    bytes32 internal constant FIDELITY_BONDS_SALT = keccak256("hemi-bitcoin-facts/FidelityBonds/v1");

    /// keccak256 of each contract's init code from the default profile (solc 0.8.28, cancun, 200 runs, no CBOR
    /// metadata). Every broadcast (`run()` or `deployAll(true)`) refuses anything else, so a build with other settings (the `verify` profile,
    /// another compiler) cannot put a contract at an address the SDK, the docs and bond tags do not name (security
    /// review finding 2). Change a contract, and its hash and address change here, in the README and in the SDK.
    bytes32 internal constant BITCOIN_FACTS_INITCODE_HASH =
        0x6b9a239be1b8d8ecd1fdad96ba73d03dd6bf5f13b89891b6713fac57b9a1234c;
    bytes32 internal constant POP_FINALITY_INITCODE_HASH =
        0x205b751f96b0a815e61940a2e10f9161e07837d826bb55e00cc0245de296c6bd;
    bytes32 internal constant FIDELITY_BONDS_INITCODE_HASH =
        0x2197004a2e44e2c65c00e439b04f9fa8e3072fca49cf36eccb9941cbca74b9b9;

    function create2Address(bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(initCode)))))
        );
    }
}

/// @title Deploy
/// @notice Idempotent CREATE2 deployment of this project's contracts through the deterministic deployer. A target
/// whose address already has code is skipped. The contracts take no constructor arguments, so each lands at the
/// same address on every chain that has the deployer.
/// @dev
///   forge script script/Deploy.s.sol --sig 'plan()' --rpc-url <url>              read-only: addresses, code present
///   forge script script/Deploy.s.sol --rpc-url <url>                             simulation, nothing sent
///   forge script script/Deploy.s.sol --rpc-url <url> --broadcast <signer flags>  sends the deployments
/// Broadcasting on Hemi mainnet additionally needs CONFIRM_MAINNET_DEPLOY=yes, and each mainnet deployment waits
/// for its own go (docs/BRIEF.md, Rules). Build with the default profile (no CBOR metadata), or the init code and
/// so the addresses change.
///
/// To add a contract: give it a salt in `Deployments` and append one entry to `targets()`.
contract Deploy is Script {
    struct Target {
        string name;
        bytes32 salt;
        bytes initCode;
        bytes32 initCodeHash; // the pinned keccak256 of initCode (Deployments)
    }

    /// @notice Every contract this script deploys, in deployment order.
    function targets() public pure returns (Target[] memory t) {
        t = new Target[](3);
        t[0] = Target(
            "BitcoinFacts",
            Deployments.BITCOIN_FACTS_SALT,
            type(BitcoinFacts).creationCode,
            Deployments.BITCOIN_FACTS_INITCODE_HASH
        );
        t[1] = Target(
            "PopFinality", Deployments.POP_FINALITY_SALT, type(PopFinality).creationCode, Deployments.POP_FINALITY_INITCODE_HASH
        );
        t[2] = Target(
            "FidelityBonds",
            Deployments.FIDELITY_BONDS_SALT,
            type(FidelityBonds).creationCode,
            Deployments.FIDELITY_BONDS_INITCODE_HASH
        );
    }

    function predicted(Target memory t) public pure returns (address) {
        return Deployments.create2Address(t.salt, t.initCode);
    }

    /// @notice What the deployer is called with: `<salt><initcode>`.
    function deployerCalldata(Target memory t) public pure returns (bytes memory) {
        return abi.encodePacked(t.salt, t.initCode);
    }

    /// @notice Read-only. One line per target:
    /// `PLAN <name> <address> <code present: 0|1> <salt> <initcode keccak256> <pinned | NOT-THE-PINNED-BUILD>`, then
    /// `INITCODE <name> <hex>`.
    function plan() external view {
        checkDeployer();
        Target[] memory t = targets();
        for (uint256 i; i < t.length; ++i) {
            address a = predicted(t[i]);
            console2.log(
                string.concat(
                    "PLAN ",
                    t[i].name,
                    " ",
                    vm.toString(a),
                    " ",
                    a.code.length > 0 ? "1" : "0",
                    " ",
                    vm.toString(t[i].salt),
                    " ",
                    vm.toString(keccak256(t[i].initCode)),
                    keccak256(t[i].initCode) == t[i].initCodeHash ? " pinned" : " NOT-THE-PINNED-BUILD"
                )
            );
            console2.log(string.concat("INITCODE ", t[i].name, " ", vm.toString(t[i].initCode)));
        }
    }

    /// @notice Simulates, or with `--broadcast` sends, every deployment. A simulation needs no confirmation and records
    /// no transaction; a broadcast goes through `deployAll(true)` and its guards.
    function run() external {
        // `--resume` never runs the script (it replays a recorded sequence), so only ScriptBroadcast can be true here.
        bool broadcasting = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        console2.log("chain id:", block.chainid);
        console2.log("mode:", broadcasting ? "BROADCAST" : "simulation (no transactions are sent)");
        checkInitCode();
        deployAll(broadcasting);
    }

    /// @dev Every path that broadcasts passes here, `run()` and a direct `--sig 'deployAll(bool)' true` alike
    /// (delta review finding 1): only the pinned build, and on Hemi mainnet only with CONFIRM_MAINNET_DEPLOY=yes.
    /// In any `forge script` run (a dry run or a broadcast), `block.chainid` must also be the chain id of the RPC the
    /// transactions go to: forge's `--chain` and FOUNDRY_CHAIN_ID change `block.chainid` but not where forge sends,
    /// which would otherwise skip the mainnet confirmation (review of 1f85744, finding 1). The check runs in dry runs
    /// too because `forge script --resume` does not run the script at all: it sends whatever sequence an earlier run
    /// recorded, so no sequence may be recorded unchecked (follow-up of da39b8e, F-1). A forge test is not a script
    /// run and has no RPC to send to, so there only `block.chainid` applies.
    function _guardBroadcast() internal {
        checkInitCode();
        if (vm.isContext(VmSafe.ForgeContext.ScriptGroup)) {
            uint256 rpcChainId = _rpcChainId();
            console2.log("RPC eth_chainId:", rpcChainId);
            require(
                rpcChainId == block.chainid,
                "Deploy: block.chainid (--chain / FOUNDRY_CHAIN_ID) is not the RPC's eth_chainId; refusing to broadcast"
            );
        }
        if (block.chainid == Deployments.HEMI_MAINNET) {
            require(
                keccak256(bytes(vm.envOr("CONFIRM_MAINNET_DEPLOY", string("")))) == keccak256("yes"),
                "Deploy: broadcasting to Hemi mainnet needs CONFIRM_MAINNET_DEPLOY=yes"
            );
        }
    }

    /// @notice Deploys every target that has no code yet and returns the addresses in `targets()` order.
    /// @param broadcast wrap each deployer call in vm.startBroadcast (false in tests)
    function deployAll(bool broadcast) public returns (address[] memory addrs) {
        if (broadcast) _guardBroadcast();
        checkDeployer();
        Target[] memory t = targets();
        addrs = new address[](t.length);
        for (uint256 i; i < t.length; ++i) {
            address a = predicted(t[i]);
            addrs[i] = a;
            if (a.code.length > 0) {
                console2.log(string.concat("[skip]   ", t[i].name, ": code already at"), a);
                continue;
            }
            console2.log(string.concat("[deploy] ", t[i].name, " ->"), a);
            if (broadcast) vm.startBroadcast();
            (bool ok, bytes memory ret) = Deployments.CREATE2_DEPLOYER.call(deployerCalldata(t[i]));
            if (broadcast) vm.stopBroadcast();
            require(ok, string.concat("Deploy: deployer call reverted for ", t[i].name));
            require(ret.length == 20 && address(bytes20(ret)) == a, string.concat("Deploy: wrong address for ", t[i].name));
            require(a.code.length > 0, string.concat("Deploy: no code after deploying ", t[i].name));
        }
    }

    /// @dev The chain id of the RPC this script sends to (`eth_chainId`; the result comes back as its big-endian bytes).
    function _rpcChainId() internal returns (uint256 id) {
        bytes memory r = vm.rpc("eth_chainId", "[]");
        for (uint256 i; i < r.length; ++i) {
            id = (id << 8) | uint8(r[i]);
        }
    }

    /// @notice Reverts unless every target's init code hashes to its pinned value (Deployments).
    function checkInitCode() public pure {
        Target[] memory t = targets();
        for (uint256 i; i < t.length; ++i) {
            require(
                keccak256(t[i].initCode) == t[i].initCodeHash,
                string.concat("Deploy: init code of ", t[i].name, " is not the pinned build (default profile?)")
            );
        }
    }

    /// @notice Reverts unless the deterministic deployer is present with its standard code.
    function checkDeployer() public view {
        require(
            Deployments.CREATE2_DEPLOYER.codehash == Deployments.CREATE2_DEPLOYER_CODEHASH,
            "Deploy: deterministic deployer 0x4e59...956C missing or unexpected"
        );
    }
}
