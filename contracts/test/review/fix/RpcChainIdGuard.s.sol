// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Fix review, finding 1: a sketch of the suggested change for the `--chain` / FOUNDRY_CHAIN_ID bypass. It reads
/// the chain id of the RPC the script will broadcast to (`eth_chainId`), which `--chain` does not change, next to
/// `block.chainid`, which it does. Run on a local anvil only:
///   forge script test/review/fix/RpcChainIdGuard.s.sol --rpc-url http://127.0.0.1:<port> [--chain 1]
/// Sends nothing.
contract RpcChainIdGuard is Script {
    function rpcChainId() public returns (uint256) {
        bytes memory r = vm.rpc("eth_chainId", "[]");
        // the JSON result "0x…" comes back as its bytes, big-endian
        uint256 id;
        for (uint256 i; i < r.length; ++i) {
            id = (id << 8) | uint8(r[i]);
        }
        return id;
    }

    function run() external {
        uint256 rpc = rpcChainId();
        console2.log("block.chainid:", block.chainid);
        console2.log("eth_chainId of the RPC:", rpc);
        console2.log(rpc == block.chainid ? "agree" : "DISAGREE: a guard on block.chainid alone is bypassed");
    }
}
