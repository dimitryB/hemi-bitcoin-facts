// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy, Deployments} from "../../../script/Deploy.s.sol";

/// @notice Fix review (docs/SECURITY-AUDIT.md): the broadcast guard in Deploy.s.sol, in-EVM. The end-to-end
/// check on a local anvil is fix-deploy-anvil.sh next to this file. All pass.
/// @dev In a test the forge context is never ScriptBroadcast, so `run()` always takes the simulation path; the
/// broadcast path is reached here by calling `deployAll(true)` directly, as `--sig 'deployAll(bool)' true` does.
/// The two tests that set CONFIRM_MAINNET_DEPLOY change the process environment, which the other tests here and
/// DeltaDeployTest read in parallel, so they are skipped unless asked for, and then need one thread:
///   REVIEW_FIX_ENV_TESTS=true forge test --match-contract FixDeployTest -j 1
contract FixDeployTest is Test {
    string internal constant MSG = "Deploy: broadcasting to Hemi mainnet needs CONFIRM_MAINNET_DEPLOY=yes";

    function setUp() public {
        if (Deployments.CREATE2_DEPLOYER.codehash != Deployments.CREATE2_DEPLOYER_CODEHASH) {
            vm.etch(
                Deployments.CREATE2_DEPLOYER,
                hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
            );
        }
    }

    function _envTests() internal returns (bool on) {
        on = vm.envOr("REVIEW_FIX_ENV_TESTS", false);
        if (!on) vm.skip(true);
    }

    function _unconfirmed() internal view {
        assertEq(vm.envOr("CONFIRM_MAINNET_DEPLOY", string("")), "", "run this with CONFIRM_MAINNET_DEPLOY unset");
    }

    function _noCodeAtTargets(Deploy d) internal view {
        Deploy.Target[] memory t = d.targets();
        for (uint256 i; i < t.length; ++i) {
            assertEq(d.predicted(t[i]).code.length, 0, "nothing deployed");
        }
    }

    /// @dev On 43111, deployAll(true) refuses every value but "yes", before any deployer call. Case and a leading
    /// space matter; forge's envOr strips trailing whitespace and surrounding quotes, so "yes " and "\"yes\"" are a
    /// yes. Opt-in (sets the environment).
    function test_fix_env_deployAllTrue_mainnet_needsYes() public {
        if (!_envTests()) return;
        vm.chainId(Deployments.HEMI_MAINNET);
        Deploy d = new Deploy();
        string[8] memory bad = ["", "no", "YES", "Yes", "y", "yes!", "ye s", " yes"];
        for (uint256 i; i < bad.length; ++i) {
            vm.setEnv("CONFIRM_MAINNET_DEPLOY", bad[i]);
            vm.expectRevert(bytes(MSG));
            d.deployAll(true);
        }
        _noCodeAtTargets(d);
        string[2] memory alsoYes = ["yes ", "\"yes\""];
        for (uint256 i; i < alsoYes.length; ++i) {
            vm.setEnv("CONFIRM_MAINNET_DEPLOY", alsoYes[i]);
            uint256 snap = vm.snapshotState();
            assertGt(d.deployAll(true)[0].code.length, 0, "normalised by forge: accepted");
            vm.revertToState(snap);
        }
        vm.setEnv("CONFIRM_MAINNET_DEPLOY", "yes");
        address[] memory a = d.deployAll(true);
        assertEq(a[0], 0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC);
        assertEq(a[1], 0x0706C1582E7C27c09953803384396efd4fa62486);
        assertEq(a[2], 0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e);
        for (uint256 i; i < 3; ++i) {
            assertGt(a[i].code.length, 0);
        }
        vm.setEnv("CONFIRM_MAINNET_DEPLOY", "");
    }

    /// @dev The guard keys on block.chainid, which a script's `--chain` flag or FOUNDRY_CHAIN_ID sets (see
    /// fix-deploy-anvil.sh A7–A9): with the confirmation unset, the same Deploy refuses on 43111 and deploys under
    /// any other id. In a script the transactions still go to the RPC's chain. Fixed: in a broadcast or resume,
    /// `_guardBroadcast` now also requires block.chainid to equal the RPC's eth_chainId, so A7–A9 are refused (checked
    /// on a local anvil); a forge test has no RPC to broadcast to, so this test still shows block.chainid alone.
    function test_fix_guardFollowsBlockChainId() public {
        _unconfirmed();
        Deploy d = new Deploy();
        vm.chainId(Deployments.HEMI_MAINNET);
        vm.expectRevert(bytes(MSG));
        d.deployAll(true);
        vm.chainId(1);
        assertGt(d.deployAll(true)[0].code.length, 0, "no confirmation needed once block.chainid is not 43111");
    }

    /// @dev Off mainnet only the pin check applies (it passes for this build); testnet needs no confirmation.
    function test_fix_deployAllTrue_testnet_noConfirmationNeeded() public {
        _unconfirmed();
        vm.chainId(Deployments.HEMI_TESTNET);
        Deploy d = new Deploy();
        address[] memory a = d.deployAll(true);
        assertGt(a[2].code.length, 0);
    }

    /// @dev The simulation path never reads the confirmation: deployAll(false) and run() (outside a broadcast)
    /// work on 43111 without it. Neither calls vm.startBroadcast, so a script run records no transaction.
    function test_fix_simulation_mainnet_noConfirmation() public {
        _unconfirmed();
        vm.chainId(Deployments.HEMI_MAINNET);
        Deploy d = new Deploy();
        uint256 snap = vm.snapshotState();
        d.run();
        assertGt(address(0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC).code.length, 0, "run() simulates");
        vm.revertToState(snap);
        address[] memory a = d.deployAll(false);
        assertGt(a[0].code.length, 0, "deployAll(false) simulates");
        // already deployed: a broadcast attempt still hits the guard first
        vm.expectRevert(bytes(MSG));
        d.deployAll(true);
    }

    /// @dev The guard runs before the deployer check and the skip logic.
    function test_fix_guardRunsFirst() public {
        _unconfirmed();
        vm.chainId(Deployments.HEMI_MAINNET);
        Deploy d = new Deploy();
        vm.etch(Deployments.CREATE2_DEPLOYER, hex"00"); // a wrong deployer
        vm.expectRevert(bytes(MSG)); // the confirmation fails first, not checkDeployer
        d.deployAll(true);
    }

    /// @dev Opt-in (sets the environment): with the confirmation given, a wrong deployer is still refused.
    function test_fix_env_confirmedStillChecksTheDeployer() public {
        if (!_envTests()) return;
        vm.chainId(Deployments.HEMI_MAINNET);
        Deploy d = new Deploy();
        vm.etch(Deployments.CREATE2_DEPLOYER, hex"00");
        vm.setEnv("CONFIRM_MAINNET_DEPLOY", "yes");
        vm.expectRevert(bytes("Deploy: deterministic deployer 0x4e59...956C missing or unexpected"));
        d.deployAll(true);
        vm.setEnv("CONFIRM_MAINNET_DEPLOY", "");
    }
}
