// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy, Deployments} from "../../../script/Deploy.s.sol";

/// @notice Delta review (docs/SECURITY-AUDIT.md) of Deploy.s.sol's pinned init-code hashes. `test_delta_F…` failed
/// against the script the review read (the evidence for its finding) and passes since the fix. `deploy-bypass.sh` next to this
/// file shows the same on a local anvil with a non-default build.
contract DeltaDeployTest is Test {
    function _deployer() internal {
        if (Deployments.CREATE2_DEPLOYER.codehash != Deployments.CREATE2_DEPLOYER_CODEHASH) {
            vm.etch(
                Deployments.CREATE2_DEPLOYER,
                hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
            );
        }
    }

    /// @dev Both guards (`checkInitCode` and CONFIRM_MAINNET_DEPLOY) live in `run()`. `deployAll(bool)` is public and
    /// broadcasts itself (`vm.startBroadcast` when its argument is true), so `forge script … --sig 'deployAll(bool)'
    /// true --broadcast` sends the deployments with neither check. Here: on chain 43111, with CONFIRM_MAINNET_DEPLOY
    /// unset, `deployAll(true)` went through. Failed before the fix.
    function test_delta_F_deployAllBroadcastNeedsTheSameGuardsAsRun() public {
        _deployer();
        assertEq(vm.envOr("CONFIRM_MAINNET_DEPLOY", string("")), "", "run this with CONFIRM_MAINNET_DEPLOY unset");
        Deploy d = new Deploy();
        // run() refuses on mainnet without the confirmation (in a test the context is not ScriptBroadcast, so
        // only the pin check runs there; it passes for this build)
        vm.chainId(Deployments.HEMI_MAINNET);
        try d.deployAll(true) returns (address[] memory addrs) {
            assertGt(addrs[0].code.length, 0);
            fail("deployAll(true) deployed on chain 43111 without CONFIRM_MAINNET_DEPLOY=yes and without checkInitCode");
        } catch {}
    }

    /// @dev The pins match this build, and run()'s order is pin check, then deploy (passes).
    function test_delta_pinsMatchThisBuild() public {
        Deploy d = new Deploy();
        d.checkInitCode();
        Deploy.Target[] memory t = d.targets();
        assertEq(t.length, 3);
        assertEq(keccak256(t[0].initCode), Deployments.BITCOIN_FACTS_INITCODE_HASH);
        assertEq(keccak256(t[1].initCode), Deployments.POP_FINALITY_INITCODE_HASH);
        assertEq(keccak256(t[2].initCode), Deployments.FIDELITY_BONDS_INITCODE_HASH);
    }
}
