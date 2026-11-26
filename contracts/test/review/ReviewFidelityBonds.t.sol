// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";
import {Hvm} from "../../src/Hvm.sol";
import {FidelityBonds} from "../../src/FidelityBonds.sol";
import {HvmMock} from "../utils/HvmMock.sol";
import {BondFixtures} from "../FidelityBonds.t.sol";
import {GasProbe, Raw42} from "./ReviewUtils.sol";

/// @dev A consumer that acts on liveBond inside its own transaction with a gas budget it does not control.
contract BondConsumer {
    FidelityBonds internal immutable fb;

    constructor(FidelityBonds fb_) {
        fb = fb_;
    }

    function statusWith(bytes32 id, uint256 g) external view returns (bool ok, uint8 status) {
        try fb.liveBond{gas: g}(id) returns (FidelityBonds.Status s, address, uint64, uint32) {
            return (true, uint8(s));
        } catch {
            return (false, 0);
        }
    }
}

/// @notice Internal review scratch tests for FidelityBonds (docs/SECURITY-AUDIT.md).
contract ReviewFidelityBondsTest is BondFixtures {
    FidelityBonds internal fb;
    GasProbe internal probe;
    BondConsumer internal consumer;

    function setUp() public {
        HvmMock.install();
        fb = new FidelityBonds();
        probe = new GasProbe();
        consumer = new BondConsumer(fb);
        vm.roll(5_780_432);
    }

    function _record() internal returns (bytes32 id, bytes memory ws) {
        ws = _bondTx(address(fb));
        id = fb.recordBond(TXID, 0, 1, ws);
    }

    // ---------------------------------------------------------------------------------------------
    // Sound: no gas limit makes refresh end an unspent bond, or liveBond misreport one
    // ---------------------------------------------------------------------------------------------

    function test_review_gasSweep_refreshNeverEndsAnUnspentBond() public {
        (bytes32 id,) = _record();
        bytes memory data = abi.encodeCall(FidelityBonds.refresh, (id));
        uint256 successes;
        for (uint256 g = 5_000; g < 300_000; g += 61) {
            (bool ok, bytes memory ret) = probe.call(address(fb), data, g);
            if (ok) {
                ++successes;
                assertFalse(abi.decode(ret, (bool)));
            }
            assertEq(fb.bond(id).endedHemiBlock, 0, "unspent bond ended");
        }
        assertGt(successes, 0);
    }

    function testFuzz_review_refreshNeverEndsAnUnspentBond(uint256 g) public {
        (bytes32 id,) = _record();
        probe.call(address(fb), abi.encodeCall(FidelityBonds.refresh, (id)), bound(g, 0, 400_000));
        assertEq(fb.bond(id).endedHemiBlock, 0);
    }

    function test_review_gasSweep_liveBondUnderAnyBudget() public {
        (bytes32 id, bytes memory ws) = _record();
        uint256 lives;
        for (uint256 g = 2_000; g < 200_000; g += 53) {
            (bool ok, uint8 s) = consumer.statusWith(id, g);
            if (!ok) continue; // ran out of gas: a revert, never a wrong answer
            assertTrue(
                s == uint8(FidelityBonds.Status.Live) || s == uint8(FidelityBonds.Status.Unknown),
                "unspent bond read as Ended or Expired"
            );
            if (s == uint8(FidelityBonds.Status.Live)) ++lives;
        }
        assertGt(lives, 0);
        // spent now (refresh not called): never Live or Expired under any budget
        bytes memory script = _p2wsh(ws);
        HvmMock.setOutput(TXID, 0, SATS, script, true);
        uint256 endeds;
        for (uint256 g = 2_000; g < 200_000; g += 53) {
            (bool ok, uint8 s) = consumer.statusWith(id, g);
            if (!ok) continue;
            assertTrue(
                s == uint8(FidelityBonds.Status.Ended) || s == uint8(FidelityBonds.Status.Unknown),
                "spent bond read as Live or Expired"
            );
            if (s == uint8(FidelityBonds.Status.Ended)) ++endeds;
        }
        assertGt(endeds, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Informational: one locked output, two agents, in two FidelityBonds deployments
    // ---------------------------------------------------------------------------------------------

    /// @dev Finding 5, fixed: a second "HFB1" tag for another deployment makes the bond ambiguous in both, so one
    /// output can no longer be counted as a bond for two agents.
    function test_review_oneOutputIsABondForTwoAgentsInTwoDeployments() public {
        FidelityBonds other = new FidelityBonds();
        bytes memory ws = _bondTx(address(fb)); // tag at vout 1: this chain, fb, AGENT
        HvmMock.setOutput(TXID, 3, 0, _tag(block.chainid, address(other), OTHER_AGENT), true);
        assertEq(uint8(fb.checkBond(TXID, 0, 1, ws).verdict), uint8(FidelityBonds.Verdict.AmbiguousTag));
        assertEq(uint8(other.checkBond(TXID, 0, 3, ws).verdict), uint8(FidelityBonds.Verdict.AmbiguousTag));
        vm.expectRevert(abi.encodeWithSelector(FidelityBonds.NotRecordable.selector, FidelityBonds.Verdict.AmbiguousTag));
        fb.recordBond(TXID, 0, 1, ws);
    }

    // ---------------------------------------------------------------------------------------------
    // Informational: the key is not checked to be on the curve
    // ---------------------------------------------------------------------------------------------

    /// @dev Finding 7, partly fixed: a key whose x is not a field element (>= p) is refused. A key with x < p that
    /// is not on the curve is still accepted (documented): the bond can then never be redeemed.
    function test_review_offCurveKeyIsAccepted() public {
        bytes memory badKey = abi.encodePacked(hex"02", bytes32(type(uint256).max));
        bytes memory ws = _ws(LOCKTIME, badKey);
        _setTip(TIP_TIME);
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), false);
        HvmMock.setOutput(TXID, 1, 0, _tag(block.chainid, address(fb), AGENT), true);
        HvmMock.setConfirmations(TXID, 6);
        assertEq(uint8(fb.checkBond(TXID, 0, 1, ws).verdict), uint8(FidelityBonds.Verdict.BadWitnessScript));

        // x = 5 is a field element but 5^3 + 7 = 132 is not a square mod p, so (02, 5) is off the curve
        bytes32 tx2 = keccak256("review: off-curve key below p");
        bytes memory offCurve = abi.encodePacked(hex"02", bytes32(uint256(5)));
        bytes memory ws2 = _ws(LOCKTIME, offCurve);
        HvmMock.setOutput(tx2, 0, SATS, _p2wsh(ws2), false);
        HvmMock.setOutput(tx2, 1, 0, _tag(block.chainid, address(fb), AGENT), true);
        HvmMock.setConfirmations(tx2, 6);
        assertEq(uint8(fb.checkBond(tx2, 0, 1, ws2).verdict), uint8(FidelityBonds.Verdict.Ok));
    }

    /// @dev Finding 7, fixed: witnessScriptFor builds only the 42-byte template, for a valid compressed key.
    function test_review_witnessScriptForDoesNotCheckTheKeyLength() public view {
        assertEq(fb.witnessScriptFor(LOCKTIME, hex"02aabb").length, 0);
        assertEq(fb.witnessScriptFor(LOCKTIME, abi.encodePacked(hex"04", bytes32(uint256(1)))).length, 0);
        assertEq(fb.witnessScriptFor(LOCKTIME, abi.encodePacked(hex"02", bytes32(type(uint256).max))).length, 0);
        assertEq(fb.witnessScriptFor(LOCKTIME, abi.encodePacked(hex"03", bytes32(uint256(1)))).length, 42);
    }

    // ---------------------------------------------------------------------------------------------
    // Gas: liveBond and refresh of a spent bond whose funding tx lists 128 outputs of 128-byte scripts
    // ---------------------------------------------------------------------------------------------

    function test_review_gas_liveBondSpentPathWorstCase() public {
        bytes memory ws = _ws();
        bytes memory script = _p2wsh(ws);
        bytes memory tag = _tag(block.chainid, address(fb), AGENT);
        _setTip(TIP_TIME);
        // 128 outputs; bond at 0 (unspent), tag at 1, 126 fillers of 201-byte scripts listed cut to 128 bytes
        bytes memory r = abi.encodePacked(uint16(128), SATS, uint16(34), script, uint8(1));
        r = abi.encodePacked(r, uint64(0), uint16(50), tag, uint8(0));
        bytes memory fill = Raw42.big(0, 126, 201, 1, type(uint256).max, "");
        // drop the 2-byte count Raw42.big wrote
        bytes memory tail = new bytes(fill.length - 2);
        for (uint256 i; i < tail.length; ++i) {
            tail[i] = fill[i + 2];
        }
        r = abi.encodePacked(r, tail);
        HvmMock.setRaw(0x42, abi.encodePacked(TXID, Hvm.TX_FLAGS_OUTPUTS), r);
        HvmMock.at(0x48).setOutput(TXID, 0, SATS, script, 1);
        HvmMock.setConfirmations(TXID, 6);
        (bool ok, uint256 used,) = probe.measure(address(fb), abi.encodeCall(FidelityBonds.recordBond, (TXID, 0, 1, ws)));
        assertTrue(ok);
        console2.log("recordBond of a 128-output funding tx, gas:", used);
        bytes32 id = fb.bondId(TXID, 0);
        (ok, used,) = probe.measure(address(fb), abi.encodeCall(FidelityBonds.liveBond, (id)));
        console2.log("liveBond, unspent, gas:", used);
        // now spent: 0x48 goes silent and the UTXO byte flips
        HvmMock.at(0x48).setOutput(TXID, 0, SATS, script, 0);
        r[2 + 8 + 2 + 34] = 0x00;
        HvmMock.setRaw(0x42, abi.encodePacked(TXID, Hvm.TX_FLAGS_OUTPUTS), r);
        (ok, used,) = probe.measure(address(fb), abi.encodeCall(FidelityBonds.liveBond, (id)));
        assertTrue(ok);
        console2.log("liveBond, spent path, gas:", used);
        assertLt(used, 1_000_000);
        (ok, used,) = probe.measure(address(fb), abi.encodeCall(FidelityBonds.refresh, (id)));
        assertTrue(ok);
        console2.log("refresh, spent path, gas:", used);
        assertGt(fb.bond(id).endedHemiBlock, 0);
    }
}
