// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hvm} from "../src/Hvm.sol";
import {Deployments} from "../script/Deploy.s.sol";
import {HvmHarness} from "./Hvm.t.sol";
import {HvmMock} from "./utils/HvmMock.sol";

/// @notice The library on a fork of Hemi mainnet. Forge cannot run hVM's precompiles, so MockHvm is laid over them
/// and fed the exact raw bytes mainnet's precompiles returned (DECISIONS.md D-004 and docs/research/spike/out/s0-context.txt); the
/// harness is deployed through the real CREATE2 deployer. The real precompiles are checked by check-live.sh.
contract HvmForkTest is Test {
    bytes32 internal constant UNSPENT_TXID = 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4;
    bytes internal constant UNSPENT_SCRIPT = hex"001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831";
    bytes32 internal constant SPENT_TXID = 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e;
    bytes internal constant SPENT_SCRIPT = hex"0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4";

    /// mainnet 0x44 at Bitcoin height 976833 (docs/research/spike/out/s0-context.txt)
    bytes internal constant HEADER_976833 =
        hex"000ee7c1000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a2040000000000000000000000001fd5370bb8f5442a216f7ade4ce830b16e8993d5ce00ed8f21daa0653f57ce3191ed624cc6e06ff620bdb890aa0edff39d4c4f5f795486b010df917021673a032f206";
    /// mainnet 0x48 for the unspent fixture, vout 0 (D-004)
    bytes internal constant UNSPENT_48 = hex"00000000000003e80016001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec83101";
    /// mainnet 0x42 (flags 003c0703) for the spent fixture (D-004)
    bytes internal constant SPENT_42 =
        hex"0002000000001b8430890022512068d343ef205a6afa4ae74508ab4aefb92dd46549e30d5eecf63acf3155c0798e000000000004f33e1000220020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c400";

    function test_fork_libraryOnMainnetBytes() public {
        uint64[10] memory nonceBefore;
        HvmMock.install();
        for (uint160 p = 0x40; p <= 0x49; ++p) nonceBefore[p - 0x40] = vm.getNonce(address(p));
        HvmMock.setAny(0x44, HEADER_976833);
        HvmMock.setRaw(0x48, abi.encodePacked(UNSPENT_TXID, uint16(0), uint16(Hvm.MAX_SCRIPT_BYTES)), UNSPENT_48);
        HvmMock.setRaw(0x42, abi.encodePacked(SPENT_TXID, Hvm.TX_FLAGS_OUTPUTS), SPENT_42);
        // keep the mocks and the data contracts they created when the fork is selected
        for (uint160 p = 0x40; p <= 0x49; ++p) {
            vm.makePersistent(address(p));
            for (uint64 n = nonceBefore[p - 0x40]; n < vm.getNonce(address(p)); ++n) {
                vm.makePersistent(vm.computeCreateAddress(address(p), n));
            }
        }

        vm.createSelectFork(vm.envOr("HEMI_FORK_URL", string("hemi")));
        assertEq(block.chainid, Deployments.HEMI_MAINNET);
        assertEq(Deployments.CREATE2_DEPLOYER.codehash, Deployments.CREATE2_DEPLOYER_CODEHASH);

        bytes32 salt = keccak256("hemi-bitcoin-facts/test/HvmHarness");
        (bool ok, bytes memory ret) =
            Deployments.CREATE2_DEPLOYER.call(abi.encodePacked(salt, type(HvmHarness).creationCode));
        assertTrue(ok);
        HvmHarness h = HvmHarness(address(bytes20(ret)));
        assertGt(address(h).code.length, 0);

        (bool hOk, Hvm.Header memory hdr) = h.lastHeader();
        assertTrue(hOk);
        assertEq(hdr.height, 976_833);
        assertEq(hdr.hash, 0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a);

        (bool oOk, bool complete, Hvm.Output memory o) = h.outputFull(UNSPENT_TXID, 0);
        assertTrue(oOk);
        assertTrue(complete);
        assertEq(o.sats, 1000);
        assertEq(o.script, UNSPENT_SCRIPT);

        assertEq(uint8(h.spendStatus(UNSPENT_TXID, 0, 1000, keccak256(UNSPENT_SCRIPT))), uint8(Hvm.Spend.Unspent));
        assertEq(
            uint8(h.spendStatus(SPENT_TXID, 1, 83_050_000, keccak256(SPENT_SCRIPT))), uint8(Hvm.Spend.Spent)
        );
        assertEq(uint8(h.spendStatus(bytes32(uint256(1)), 0, 1, bytes32(0))), uint8(Hvm.Spend.Unknown));
    }
}
