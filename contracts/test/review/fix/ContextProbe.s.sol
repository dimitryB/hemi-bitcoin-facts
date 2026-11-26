// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice Fix review follow-up (F-1, F-2): which forge contexts a script sees, for the suggested change to the RPC
/// chain-id check (run it in every script context, ScriptGroup, so a dry run that records transactions is checked
/// too). Sends nothing. Local anvil only:
///   forge script test/review/fix/ContextProbe.s.sol --rpc-url http://127.0.0.1:<port> [--broadcast ...]
contract ContextProbe is Script {
    function run() external {
        console2.log("ScriptGroup:", vm.isContext(VmSafe.ForgeContext.ScriptGroup));
        console2.log("ScriptDryRun:", vm.isContext(VmSafe.ForgeContext.ScriptDryRun));
        console2.log("ScriptBroadcast:", vm.isContext(VmSafe.ForgeContext.ScriptBroadcast));
        console2.log("ScriptResume:", vm.isContext(VmSafe.ForgeContext.ScriptResume));
        console2.log("TestGroup:", vm.isContext(VmSafe.ForgeContext.TestGroup));
    }
}
