// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Hvm} from "../../src/Hvm.sol";
import {BitcoinFacts} from "../../src/BitcoinFacts.sol";
import {HvmMock} from "../utils/HvmMock.sol";
import {Fixtures} from "../BitcoinFacts.t.sol";
import {GasProbe, Raw42} from "./ReviewUtils.sol";

/// @notice Internal review scratch tests for BitcoinFacts (docs/SECURITY-AUDIT.md).
contract ReviewBitcoinFactsTest is Test, Fixtures {
    BitcoinFacts internal f;
    GasProbe internal probe;

    /// Bitcoin's genesis coinbase, read live on 2026-11-21 (Hemi block 5781326, 0x44 height 976858):
    ///   cast call 0x…48 0x4a5e1e4b…da33b00000064 --rpc-url https://rpc.hemi.network/rpc
    ///   cast call 0x…42 0x4a5e1e4b…da33b003c0703 --rpc-url https://rpc.hemi.network/rpc
    ///   cast call 0x…43 0x4a5e1e4b…da33b         --rpc-url https://rpc.hemi.network/rpc  -> 0x000ee7dd
    bytes32 internal constant GENESIS_CB = 0x4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b;
    bytes internal constant GENESIS_48 =
        hex"000000012a05f20000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac01";
    bytes internal constant GENESIS_42 =
        hex"0001000000012a05f20000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac01";

    function setUp() public {
        HvmMock.install();
        f = new BitcoinFacts();
        probe = new GasProbe();
        vm.roll(5_780_440);
        _mainnetFixtures();
    }

    // ---------------------------------------------------------------------------------------------
    // Sound: a starved hVM call is never recorded as "spent" (or as "unspent")
    // ---------------------------------------------------------------------------------------------

    /// @dev recordOutput reads 0x48 first and treats no answer as "maybe spent", then needs 0x42 to list the output
    /// with UTXO byte 0x00. A caller who starves 0x48 (gas limit chosen so 63/64 of it is below what 0x48 needs)
    /// keeps only 1/64, which is too little for 0x42, so the record reverts instead of storing "spent".
    function test_review_gasSweep_unspentIsNeverStoredSpent() public {
        bytes32 id = f.outputId(UNSPENT_TXID, 0, TIP_HASH);
        bytes memory data = abi.encodeCall(BitcoinFacts.recordOutput, (UNSPENT_TXID, uint16(0)));
        uint256 successes;
        for (uint256 g = 10_000; g < 400_000; g += 89) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = probe.call(address(f), data, g);
            if (ok) {
                ++successes;
                BitcoinFacts.OutputFact memory o = f.outputFact(id);
                assertFalse(o.spent, "unspent output stored as spent");
                assertEq(o.sats, 1000);
                assertEq(o.confirmations, UNSPENT_CONFS);
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
    }

    function testFuzz_review_unspentIsNeverStoredSpent(uint256 g) public {
        g = bound(g, 0, 500_000);
        probe.call(address(f), abi.encodeCall(BitcoinFacts.recordOutput, (UNSPENT_TXID, uint16(0))), g);
        BitcoinFacts.OutputFact memory o = f.outputFact(f.outputId(UNSPENT_TXID, 0, TIP_HASH));
        assertFalse(o.spent);
    }

    function test_review_gasSweep_spentIsNeverStoredUnspent() public {
        bytes32 id = f.outputId(SPENT_TXID, 1, TIP_HASH);
        bytes memory data = abi.encodeCall(BitcoinFacts.recordOutput, (SPENT_TXID, uint16(1)));
        uint256 successes;
        for (uint256 g = 10_000; g < 400_000; g += 89) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = probe.call(address(f), data, g);
            if (ok) {
                ++successes;
                BitcoinFacts.OutputFact memory o = f.outputFact(id);
                assertTrue(o.spent);
                assertEq(o.sats, 83_050_000);
                assertEq(o.confirmations, SPENT_CONFS);
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Informational: hVM's UTXO set holds the genesis coinbase, which Bitcoin consensus can never spend
    // ---------------------------------------------------------------------------------------------

    function test_review_genesisCoinbaseReadsAsAnUnspent50BtcOutput() public {
        HvmMock.setRaw(0x48, abi.encodePacked(GENESIS_CB, uint16(0), uint16(10_000)), GENESIS_48);
        HvmMock.setRaw(0x42, abi.encodePacked(GENESIS_CB, Hvm.TX_FLAGS_OUTPUTS), GENESIS_42);
        HvmMock.setConfirmations(GENESIS_CB, 976_861);
        // Finding 3, fixed: the genesis coinbase is Unspendable, though hVM lists it in its UTXO set
        BitcoinFacts.OutputCheck memory c = f.checkOutput(GENESIS_CB, 0);
        assertEq(uint8(c.verdict), uint8(BitcoinFacts.Verdict.Unspendable));
        assertFalse(c.spent);
        assertEq(GENESIS_CB, f.GENESIS_COINBASE_TXID());
        vm.expectRevert(abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, BitcoinFacts.Verdict.Unspendable));
        f.recordOutput(GENESIS_CB, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Gas: the most a chosen Bitcoin transaction can make a check cost
    // ---------------------------------------------------------------------------------------------

    function test_review_gas_unspent10000ByteScript() public {
        bytes32 txid = keccak256("review: 10,000-byte unspent script");
        bytes memory script = new bytes(10_000);
        for (uint256 i; i < script.length; ++i) {
            script[i] = 0x51; // 10,000 one-byte opcodes: the longest walk _parses can be made to do
        }
        HvmMock.setOutput(txid, 0, 1, script, false);
        HvmMock.setConfirmations(txid, 10);
        (bool ok, uint256 used, bytes memory ret) =
            probe.measure(address(f), abi.encodeCall(BitcoinFacts.checkOutput, (txid, uint16(0))));
        assertTrue(ok);
        BitcoinFacts.OutputCheck memory c = abi.decode(ret, (BitcoinFacts.OutputCheck));
        assertEq(uint8(c.verdict), uint8(BitcoinFacts.Verdict.Ok));
        console2.log("checkOutput, unspent 10,000-byte script, gas:", used);
        (ok, used,) = probe.measure(address(f), abi.encodeCall(BitcoinFacts.recordOutput, (txid, uint16(0))));
        assertTrue(ok);
        console2.log("recordOutput of it, gas:", used);
        assertLt(used, 2_000_000);
    }

    function test_review_gas_spentPathParses128x128() public {
        bytes32 txid = keccak256("review: 948-output transaction");
        HvmMock.setRaw(0x42, abi.encodePacked(txid, Hvm.TX_FLAGS_OUTPUTS), Raw42.big(948, 128, 201, 1, 127, hex"51"));
        HvmMock.setConfirmations(txid, 10);
        (bool ok, uint256 used, bytes memory ret) =
            probe.measure(address(f), abi.encodeCall(BitcoinFacts.checkOutput, (txid, uint16(127))));
        assertTrue(ok);
        BitcoinFacts.OutputCheck memory c = abi.decode(ret, (BitcoinFacts.OutputCheck));
        assertEq(uint8(c.verdict), uint8(BitcoinFacts.Verdict.Ok));
        assertTrue(c.spent);
        console2.log("checkOutput, spent path through a 128 x 128-byte 0x42 answer, gas:", used);
        assertLt(used, 1_000_000);
    }

    // ---------------------------------------------------------------------------------------------
    // Property: "spent" is only ever a positive 0x42 listing; "unspent" only ever a 0x48 answer
    // ---------------------------------------------------------------------------------------------

    /// @dev Arbitrary well-formed 0x42 listings (any count, values, scripts up to 160 bytes, UTXO bytes 0/1) with
    /// 0x48 silent or answering. An Ok verdict must match exactly one of the two positive answers.
    function testFuzz_review_spentOnlyFromPositiveListing(
        uint8 n,
        uint16 vout,
        bytes memory script,
        uint64 sats,
        bool utxoByte,
        bool answer48,
        uint16 extra
    ) public {
        n = uint8(bound(n, 0, 130));
        vout = uint16(bound(vout, 0, 140));
        vm.assume(script.length <= 160);
        bytes32 txid = keccak256(abi.encode("review fuzz", n, vout));
        uint256 total = uint256(n) + (extra % 3);
        uint256 listed = n < 128 ? n : 128;
        bytes memory r = abi.encodePacked(uint16(total));
        for (uint256 i; i < listed; ++i) {
            if (i == vout) {
                uint256 cut = script.length < 128 ? script.length : 128;
                bytes memory s = new bytes(cut);
                for (uint256 j; j < cut; ++j) {
                    s[j] = script[j];
                }
                r = abi.encodePacked(r, sats, uint16(script.length), s, utxoByte ? uint8(1) : uint8(0));
            } else {
                r = abi.encodePacked(r, uint64(i), uint16(1), hex"51", uint8(i % 2));
            }
        }
        HvmMock.setRaw(0x42, abi.encodePacked(txid, Hvm.TX_FLAGS_OUTPUTS), r);
        if (answer48) {
            HvmMock.setRaw(
                0x48,
                abi.encodePacked(txid, vout, uint16(10_000)),
                abi.encodePacked(sats, uint16(script.length), script, uint8(1))
            );
        }
        HvmMock.setConfirmations(txid, 7);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(txid, vout);
        if (c.verdict != BitcoinFacts.Verdict.Ok) return;
        if (c.spent) {
            assertFalse(answer48, "spent while 0x48 answered");
            assertTrue(vout < listed && !utxoByte, "spent without a 0x00 listing");
            assertTrue(script.length <= 128 && (script.length == 0 || uint8(script[0]) != 0x6a));
            assertEq(c.scriptHash, keccak256(script));
            assertEq(c.sats, sats);
        } else {
            assertTrue(answer48, "unspent without a 0x48 answer");
            assertEq(c.scriptHash, keccak256(script));
        }
    }
}
