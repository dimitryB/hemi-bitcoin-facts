// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hvm} from "../../src/Hvm.sol";
import {BitcoinFacts} from "../../src/BitcoinFacts.sol";
import {PopFinality} from "../../src/PopFinality.sol";
import {FidelityBonds} from "../../src/FidelityBonds.sol";
import {Deploy, Deployments} from "../../script/Deploy.s.sol";
import {HvmMock} from "../utils/HvmMock.sol";
import {HvmHarness} from "../Hvm.t.sol";

/// @notice Internal review scratch tests for Hvm.sol parsing and Deploy.s.sol (docs/SECURITY-AUDIT.md).
contract ReviewHvmTest is Test {
    HvmHarness internal h;

    function setUp() public {
        HvmMock.install();
        h = new HvmHarness();
    }

    function _cut(bytes memory s) internal pure returns (bytes memory c) {
        uint256 n = s.length < 128 ? s.length : 128;
        c = new bytes(n);
        for (uint256 i; i < n; ++i) {
            c[i] = s[i];
        }
    }

    /// @dev Any well-formed 0x42 output listing parses back to exactly what was written, and one byte more or less
    /// is refused, never misread.
    function testFuzz_review_txOutputs_roundTripAndExactLength(bytes[] memory raw, uint64 seed, uint8 extra) public {
        // at most 8 outputs, scripts at most 300 bytes (so some are cut at 128 and some are not)
        bytes[] memory scripts = new bytes[](raw.length < 8 ? raw.length : 8);
        for (uint256 i; i < scripts.length; ++i) {
            uint256 n = raw[i].length < 300 ? raw[i].length : 300;
            scripts[i] = new bytes(n);
            for (uint256 j; j < n; ++j) {
                scripts[i][j] = raw[i][j];
            }
        }
        bytes32 txid = keccak256(abi.encode("review rt", seed));
        uint256 total = scripts.length + (extra % 4);
        bytes memory r = abi.encodePacked(uint16(total));
        for (uint256 i; i < scripts.length; ++i) {
            r = abi.encodePacked(
                r, uint64(uint256(seed) + i), uint16(scripts[i].length), _cut(scripts[i]), uint8((seed >> i) & 1)
            );
        }
        bytes memory flags = abi.encodePacked(txid, Hvm.TX_FLAGS_OUTPUTS);
        HvmMock.setRaw(0x42, flags, r);
        (bool ok, uint256 t, Hvm.TxOutput[] memory outs) = h.txOutputs(txid);
        if (total != scripts.length) {
            // fewer entries than the count says (and the count is below 128): not a complete listing
            assertFalse(ok);
        } else {
            assertTrue(ok);
            assertEq(t, total);
            assertEq(outs.length, scripts.length);
            for (uint256 i; i < outs.length; ++i) {
                assertEq(outs[i].sats, uint64(uint256(seed) + i));
                assertEq(outs[i].scriptLength, scripts[i].length);
                assertEq(outs[i].script, _cut(scripts[i]));
                assertEq(outs[i].inUtxoSet, (seed >> i) & 1 == 1);
            }
        }
        // one trailing byte more, or one byte less, is malformed
        HvmMock.setRaw(0x42, flags, abi.encodePacked(r, hex"00"));
        (ok,,) = h.txOutputs(txid);
        assertFalse(ok);
        if (r.length > 2) {
            bytes memory shorter = new bytes(r.length - 1);
            for (uint256 i; i < shorter.length; ++i) {
                shorter[i] = r[i];
            }
            HvmMock.setRaw(0x42, flags, shorter);
            (ok,,) = h.txOutputs(txid);
            assertFalse(ok);
        }
    }

    /// @dev spendStatus says Spent only on 0x48 silence plus a 0x42 listing with UTXO byte 0x00 and the same complete
    /// value and script; Unspent only on a complete 0x48 answer with flag 1 and the same value and script.
    function testFuzz_review_spendStatus_onlyPositiveAnswers(
        bytes memory r48,
        bool use48,
        uint64 sats,
        bytes memory script,
        uint8 utxo,
        uint16 vout,
        bool sameSats
    ) public {
        vm.assume(script.length <= 200);
        vout = uint16(bound(vout, 0, 3));
        bytes32 txid = keccak256(abi.encode("review spend", vout, sats));
        bytes32 sh = keccak256(script);
        bytes memory r = abi.encodePacked(uint16(4));
        for (uint256 i; i < 4; ++i) {
            if (i == vout) {
                r = abi.encodePacked(
                    r, sameSats ? sats : sats ^ 1, uint16(script.length), _cut(script), uint8(utxo % 3)
                );
            } else {
                r = abi.encodePacked(r, uint64(1), uint16(1), hex"51", uint8(0));
            }
        }
        HvmMock.setRaw(0x42, abi.encodePacked(txid, Hvm.TX_FLAGS_OUTPUTS), r);
        if (use48) HvmMock.setRaw(0x48, abi.encodePacked(txid, vout, uint16(10_000)), r48);
        Hvm.Spend s = h.spendStatus(txid, vout, sats, sh);
        if (s == Hvm.Spend.Spent) {
            (bool ok48,) = h.output(txid, vout, 10_000);
            assertFalse(ok48, "Spent while 0x48 answered");
            assertTrue(sameSats && utxo % 3 == 0 && script.length <= 128, "Spent without a matching 0x00 listing");
        } else if (s == Hvm.Spend.Unspent) {
            (bool ok48, Hvm.Output memory o) = h.output(txid, vout, 10_000);
            assertTrue(ok48);
            assertEq(o.sats, sats);
            assertEq(keccak256(o.script), sh);
            assertEq(o.script.length, o.scriptLength);
        }
    }
}

contract ReviewDeployTest is Test {
    /// keccak256 of the deterministic deployer's runtime (Deploy.s.sol). Forge's test EVM has it at 0x4e59…956C.
    function _deployer() internal {
        if (Deployments.CREATE2_DEPLOYER.codehash != Deployments.CREATE2_DEPLOYER_CODEHASH) {
            vm.etch(
                Deployments.CREATE2_DEPLOYER,
                hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
            );
        }
        assertEq(Deployments.CREATE2_DEPLOYER.codehash, Deployments.CREATE2_DEPLOYER_CODEHASH);
    }

    /// @dev The addresses docs/SCHEMA.md and the SDK fixtures name are what this source compiles to under the
    /// default profile (no CBOR metadata). Any other build settings give other addresses (see internal review finding 2's
    /// `FOUNDRY_PROFILE=verify` evidence), which Deploy.s.sol does not detect.
    function test_review_predictedAddressesMatchTheDocs() public {
        Deploy d = new Deploy();
        Deploy.Target[] memory t = d.targets();
        assertEq(d.predicted(t[0]), 0xAecbC8F5f6bB401c7d8A7625f53fE2225b730FfC, "BitcoinFacts");
        assertEq(d.predicted(t[1]), 0x0706C1582E7C27c09953803384396efd4fa62486, "PopFinality");
        assertEq(d.predicted(t[2]), 0xC527EDfEEE8972797D74252aA9111A05ea2C9A4e, "FidelityBonds");
    }

    /// @dev Finding 2, fixed: the init code of each target is pinned, and the pins match this build.
    function test_review_initCodeIsPinned() public {
        Deploy d = new Deploy();
        d.checkInitCode();
        Deploy.Target[] memory t = d.targets();
        for (uint256 i; i < t.length; ++i) {
            assertEq(keccak256(t[i].initCode), t[i].initCodeHash, t[i].name);
        }
    }

    /// @dev Anyone can deploy the same init code with the same salt first. It lands at the same address with the same
    /// code, and Deploy.s.sol then skips it: front-running gains nothing.
    function test_review_frontRunDeploymentIsHarmless() public {
        _deployer();
        Deploy d = new Deploy();
        Deploy.Target[] memory t = d.targets();
        vm.prank(address(0xBAD));
        (bool ok, bytes memory ret) = Deployments.CREATE2_DEPLOYER.call(d.deployerCalldata(t[2]));
        assertTrue(ok);
        assertEq(address(bytes20(ret)), d.predicted(t[2]));
        address[] memory addrs = d.deployAll(false);
        assertEq(addrs[2], d.predicted(t[2]));
        assertEq(addrs[2].code, type(FidelityBonds).runtimeCode);
        assertEq(addrs[0].code, type(BitcoinFacts).runtimeCode);
        assertEq(addrs[1].code, type(PopFinality).runtimeCode);
        // a second front-run of the same salt fails: CREATE2 cannot overwrite
        vm.prank(address(0xBAD));
        (ok,) = Deployments.CREATE2_DEPLOYER.call{gas: 5_000_000}(d.deployerCalldata(t[2]));
        assertFalse(ok);
    }
}
