// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Hvm} from "../../src/Hvm.sol";
import {PopFinality} from "../../src/PopFinality.sol";
import {HvmMock} from "../utils/HvmMock.sol";
import {PopFixtures} from "../PopFinality.t.sol";
import {GasProbe, Raw42} from "./ReviewUtils.sol";

/// @notice Internal review scratch tests for PopFinality (docs/SECURITY-AUDIT.md, findings 1 and 9), rewritten after
/// the fix (docs/DECISIONS.md D-023, B-18 onward): every valid publication is stored, so a
/// forgery can no longer block or displace the real one, and `isBtcFinalVia` answers about a named publication.
/// `isBtcAnchored` still reads K's best publication and is forgeable by design; these tests pin that too.
contract ReviewPopFinalityTest is Test, PopFixtures {
    PopFinality internal p;
    GasProbe internal probe;

    uint256 internal constant K = 5_780_850;
    bytes32 internal constant K_HASH = keccak256("review: block K");
    bytes32 internal constant REAL = keccak256("review: the PoP miner's transaction");
    bytes32 internal constant FORGED = keccak256("review: an attacker's transaction");

    function setUp() public {
        HvmMock.install();
        p = new PopFinality();
        probe = new GasProbe();
        vm.roll(K + 100);
        vm.setBlockhash(K, K_HASH);
        HvmMock.setTip(_tip());
    }

    /// @dev The keystone Hemi's PoP rule (bfgd / op-node) counts: all 76 bytes equal the canonical abbreviation.
    function _canonical() internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(1),
            uint32(26_400_000), // L1 origin of block K
            uint32(K),
            bytes11(keccak256("block K-1")), // parent hash prefix
            bytes12(keccak256("block K-25")), // previous keystone hash prefix
            keccak256("state root of K"),
            bytes12(K_HASH)
        );
    }

    /// @dev What anyone can put on Bitcoin for ~one transaction fee once block K exists: only the version, K and
    /// K's hash prefix (the 17 bytes PopFinality checks) are right; the other 59 bytes are wrong, so Hemi's
    /// consensus ignores it.
    function _forged() internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(1), uint32(0xdeadbeef), uint32(K), bytes11(0), bytes12(0), bytes32(0), bytes12(K_HASH)
            );
    }

    function _publish(bytes32 txid, bytes memory abrev, uint32 confs) internal {
        HvmMock.setRaw(0x42, abi.encodePacked(txid, Hvm.TX_FLAGS_OUTPUTS), _popTx(abi.encodePacked(PREFIX, abrev), 0));
        HvmMock.setConfirmations(txid, confs);
    }

    function _record(bytes32 txid) internal returns (bool created, bool best) {
        return p.recordPublication(K, txid, 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Finding 1, after the fix
    // ---------------------------------------------------------------------------------------------

    /// @dev Was test_review_forgedKeystone_isRecordedAndReadsBitcoinFinal. Still true by design: the contract checks
    /// 17 of the 76 bytes, so a forgery records, and `isBtcAnchored` (anchored) and `isBtcFinalVia` on the forgery itself
    /// read final. That is why Hemi PoP finality is `isBtcFinalVia` on a publication matched off chain, never
    /// `isBtcAnchored`, and why `isBtcFinalVia` must never be asked about an unmatched publication.
    function test_review_forgedKeystone_isRecordedAndReadsAnchoredOnly() public {
        bytes memory forged = _forged();
        assertTrue(keccak256(forged) != keccak256(_canonical()), "forged differs from the canonical keystone");
        _publish(FORGED, forged, 9);

        PopFinality.PublicationCheck memory c = p.checkPublication(K, FORGED, 1);
        assertEq(uint8(c.verdict), uint8(PopFinality.Verdict.Ok));
        assertEq(c.keystone.l1Number, 0xdeadbeef);
        assertEq(c.keystone.stateRoot, bytes32(0));
        assertEq(c.keystone.parentHashPrefix, bytes11(0));
        assertEq(c.keystone.prevKeystoneHashPrefix, bytes12(0));
        assertEq(c.abrev, forged); // what an off-chain reader compares with the canonical keystone

        (bool created, bool best) = _record(FORGED);
        assertTrue(created && best);
        // Anchored on Bitcoin: K's number and hash prefix are there. Not Hemi PoP finality (documented).
        assertTrue(p.isBtcAnchored(K - 24, K));
        assertTrue(p.isBtcAnchored(K, K));
        // The contract cannot tell a forgery by name either: the via path is only as good as the caller's match.
        assertTrue(p.isBtcFinalVia(K, K, FORGED, 1));
        // A reader with the exact-match publication gets no answer from a forgery: the real one is not stored yet.
        assertFalse(p.isBtcFinalVia(K, K, REAL, 1));
        (PopFinality.Verdict v,) = p.btcConfirmationsVia(K, K, REAL, 1);
        assertEq(uint8(v), uint8(PopFinality.Verdict.NotRecorded));
    }

    /// @dev Was test_review_forgedFirst_realPublicationIsNeverStored.
    function test_review_forgedFirst_realPublicationIsStillRecorded() public {
        // The forger publishes as soon as K is cut; the PoP miner's transaction lands one Bitcoin block later.
        _publish(FORGED, _forged(), 2);
        _record(FORGED);
        _publish(REAL, _canonical(), 1);
        (bool created, bool best) = _record(REAL);
        assertTrue(created, "the real publication is stored");
        assertFalse(best, "the earlier forgery stays K's best");
        // Both keep confirming at the same rate: the forgery stays the best, the real one answers by name.
        for (uint32 i = 2; i < 200; i += 17) {
            HvmMock.setConfirmations(FORGED, i + 1);
            HvmMock.setConfirmations(REAL, i);
            PopFinality.PublicationCheck memory c = p.checkPublication(K, REAL, 1);
            assertEq(uint8(c.verdict), uint8(PopFinality.Verdict.Ok));
            assertTrue(c.recorded);
            assertFalse(c.becomesBest);
            (PopFinality.Verdict v, uint32 conf) = p.btcConfirmationsVia(K - 24, K, REAL, 1);
            assertEq(uint8(v), uint8(PopFinality.Verdict.Ok));
            assertEq(conf, i);
            assertEq(p.isBtcFinalVia(K - 24, K, REAL, 1), i >= 9);
        }
        assertEq(p.bestPublicationOf(K).btcTxid, FORGED);
        assertEq(p.publicationOf(K, REAL, 1).btcTxid, REAL);
        assertEq(p.publicationOf(K, REAL, 1).confirmations, 1); // the count when it was recorded
    }

    /// @dev Was test_review_forgedEarlier_displacesAStoredRealPublication. The forgery can still take the best
    /// (anchored) slot, but no longer removes the real publication.
    function test_review_forgedEarlier_takesTheBestButNotTheRealEntry() public {
        _publish(REAL, _canonical(), 5);
        (bool created, bool best) = _record(REAL);
        assertTrue(created && best);
        // A forgery mined one Bitcoin block before the real one, recorded afterwards, becomes the best.
        _publish(FORGED, _forged(), 6);
        (created, best) = _record(FORGED);
        assertTrue(created && best);
        assertEq(p.bestPublicationOf(K).btcTxid, FORGED);
        HvmMock.setConfirmations(FORGED, 9);
        HvmMock.setConfirmations(REAL, 8);
        assertTrue(p.isBtcAnchored(K, K)); // anchored, through the forgery
        assertFalse(p.isBtcFinalVia(K, K, REAL, 1)); // Hemi PoP finality: one more Bitcoin block
        HvmMock.setConfirmations(REAL, 9);
        assertTrue(p.isBtcFinalVia(K, K, REAL, 1));
        assertEq(p.publicationOf(K, REAL, 1).btcTxid, REAL);
        (created, best) = _record(REAL);
        assertFalse(created);
        assertFalse(best); // 9 against 10: the forgery stays the best, and that does not matter to the via path
    }

    // ---------------------------------------------------------------------------------------------
    // Sound: no gas limit lets a losing candidate become the best
    // ---------------------------------------------------------------------------------------------

    /// @dev The best is re-read (0x42, 0x43) in the candidate's transaction, and a failed re-read means "replace".
    /// A failed hVM call burns what it was given, so a caller could try to starve exactly that re-read. The 63/64
    /// rule leaves at most 1/64 of the gas after a starved call, far too little to write the best pointer.
    function test_review_gasSweep_losingCandidateNeverBecomesBest() public {
        _publish(REAL, _canonical(), 10);
        _record(REAL);
        _publish(FORGED, _forged(), 3);
        bytes memory data = abi.encodeCall(PopFinality.recordPublication, (K, FORGED, 1));
        uint256 successes;
        for (uint256 g = 20_000; g < 400_000; g += 97) {
            (bool ok, bytes memory ret) = probe.call(address(p), data, g);
            if (ok) {
                ++successes;
                (, bool best) = abi.decode(ret, (bool, bool));
                assertFalse(best, "a losing candidate became the best");
            }
            assertEq(p.bestPublicationOf(K).btcTxid, REAL);
        }
        assertGt(successes, 0, "the sweep reached the full-gas outcome");
        // the losing candidate is stored all the same
        assertEq(p.publicationOf(K, FORGED, 1).btcTxid, FORGED);
    }

    /// @dev The same for re-submitting a stored loser, which takes the cheaper path (no new entry).
    function test_review_gasSweep_resubmittedLoserNeverBecomesBest() public {
        _publish(REAL, _canonical(), 10);
        _record(REAL);
        _publish(FORGED, _forged(), 3);
        _record(FORGED);
        bytes memory data = abi.encodeCall(PopFinality.recordPublication, (K, FORGED, 1));
        for (uint256 g = 10_000; g < 300_000; g += 89) {
            probe.call(address(p), data, g);
            assertEq(p.bestPublicationOf(K).btcTxid, REAL);
        }
    }

    function testFuzz_review_losingCandidateNeverBecomesBest(uint256 g) public {
        g = bound(g, 0, 600_000);
        _publish(REAL, _canonical(), 10);
        _record(REAL);
        _publish(FORGED, _forged(), 3);
        probe.call(address(p), abi.encodeCall(PopFinality.recordPublication, (K, FORGED, 1)), g);
        assertEq(p.bestPublicationOf(K).btcTxid, REAL);
        assertEq(p.bestPublicationOf(K).confirmations, 10);
    }

    // ---------------------------------------------------------------------------------------------
    // Gas: the largest re-read a best publication can force on every later record
    // ---------------------------------------------------------------------------------------------

    /// @dev The best publication's transaction is chosen by whoever recorded it. The largest 0x42 answer is 128
    /// listed outputs with 128-byte scripts (about 17.7 KB). Every later competing record re-reads it.
    function test_review_gas_storedPublicationWith128x128Outputs() public {
        bytes memory pop = abi.encodePacked(PREFIX, _forged());
        HvmMock.setRaw(0x42, abi.encodePacked(FORGED, Hvm.TX_FLAGS_OUTPUTS), Raw42.big(948, 128, 201, 1, 1, pop));
        HvmMock.setConfirmations(FORGED, 20);
        (bool ok, uint256 used,) =
            probe.measure(address(p), abi.encodeCall(PopFinality.recordPublication, (K, FORGED, 1)));
        assertTrue(ok);
        console2.log("recordPublication of a 128x128-output PoP tx, gas:", used);
        _publish(REAL, _canonical(), 3);
        (ok, used,) = probe.measure(address(p), abi.encodeCall(PopFinality.recordPublication, (K, REAL, 1)));
        assertTrue(ok);
        console2.log("competing record that re-reads it, gas:", used);
        assertLt(used, 1_000_000);
        (ok, used,) = probe.measure(address(p), abi.encodeCall(PopFinality.isBtcAnchored, (K, K)));
        console2.log("isBtcAnchored, gas:", used);
        (ok, used,) = probe.measure(address(p), abi.encodeCall(PopFinality.isBtcFinalVia, (K, K, REAL, 1)));
        console2.log("isBtcFinalVia, gas:", used);
    }

    // ---------------------------------------------------------------------------------------------
    // Finding 9, after the fix: a best whose Bitcoin tx is reorged away is restored by re-submitting
    // ---------------------------------------------------------------------------------------------

    /// @dev Was test_review_storedReorgedAway_isBtcFinalFalseUntilSomeoneRecordsAgain.
    function test_review_storedReorgedAway_viaUnaffectedAndBestRestoredByResubmitting() public {
        _publish(FORGED, _forged(), 12);
        _record(FORGED);
        _publish(REAL, _canonical(), 11);
        _record(REAL);
        assertTrue(p.isBtcAnchored(K, K));
        // FORGED's Bitcoin block is orphaned and its inputs double-spent: hVM no longer knows the transaction.
        HvmMock.setRaw(0x42, abi.encodePacked(FORGED, Hvm.TX_FLAGS_OUTPUTS), "");
        HvmMock.setFailInput(0x43, abi.encodePacked(FORGED));
        assertFalse(p.isBtcAnchored(K, K), "the anchored view reads the best, which no longer verifies");
        assertTrue(p.isBtcFinalVia(K, K, REAL, 1), "the via path does not depend on the best");
        // Re-submitting the stored real publication writes no new entry and makes it the best.
        (bool created, bool best) = _record(REAL);
        assertFalse(created);
        assertTrue(best);
        assertTrue(p.isBtcAnchored(K, K));
        assertEq(p.bestPublicationOf(K).btcTxid, REAL);
    }
}
