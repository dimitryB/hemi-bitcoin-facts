// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {Hvm} from "../../../src/Hvm.sol";
import {PopFinality} from "../../../src/PopFinality.sol";
import {HvmMock} from "../../utils/HvmMock.sol";
import {PopFixtures} from "../../PopFinality.t.sol";
import {GasProbe, Raw42} from "../ReviewUtils.sol";

/// @notice Delta review (docs/SECURITY-AUDIT.md) of PopFinality after the internal review's fixes: every valid publication is kept, K's best
/// is a pointer chosen pairwise on each submission, and the `…Via` views read one named publication.
/// Tests named `test_delta_F…` assert a property the NatSpec or docs claim and failed against the code the review read: each
/// is the evidence for one of its findings, and passes since the fix. Every other test passes and pins a property found sound.
contract DeltaPopFinalityTest is Test, PopFixtures {
    PopFinality internal p;
    GasProbe internal probe;

    uint256 internal constant K = 5_780_850;
    bytes32 internal constant K_HASH = keccak256("delta: block K");

    bytes32 internal constant TOPIC_RECORDED =
        keccak256("PublicationRecorded(bytes32,uint256,bytes32,uint16,uint32,uint32,bytes32,uint64,bytes)");
    bytes32 internal constant TOPIC_BEST = keccak256("BestPublicationChanged(uint256,bytes32,uint16,uint32,bytes32,uint16)");

    function setUp() public {
        HvmMock.install();
        p = new PopFinality();
        probe = new GasProbe();
        vm.roll(K + 100);
        vm.setBlockhash(K, K_HASH);
        HvmMock.setTip(_tip());
    }

    function _tx(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("delta: PoP tx", i));
    }

    /// @dev A valid publication of K (17 checked bytes right; the rest arbitrary) at vout 1 of `txid`.
    function _publish(bytes32 txid, uint32 confs) internal {
        HvmMock.setRaw(0x42, abi.encodePacked(txid, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(K, K_HASH), 0));
        HvmMock.setConfirmations(txid, confs);
    }

    /// @dev The transaction's Bitcoin block is orphaned and nothing re-mines it: 0x42 has no answer, 0x43 fails.
    function _drop(bytes32 txid) internal {
        HvmMock.setRaw(0x42, abi.encodePacked(txid, Hvm.TX_FLAGS_OUTPUTS), "");
        HvmMock.setFailInput(0x43, abi.encodePacked(txid));
    }

    function _record(bytes32 txid) internal returns (bool created, bool best) {
        return p.recordPublication(K, txid, 1);
    }

    function _viaConfs(bytes32 txid) internal view returns (PopFinality.Verdict v, uint32 c) {
        return p.btcConfirmationsVia(K, K, txid, 1);
    }

    // =============================================================================================
    // Finding: after the best stops verifying, the next submission takes the best whatever its count
    // =============================================================================================

    /// @dev `_best`'s @dev, `bestPublicationOf`'s @notice, docs/SCHEMA.md ("the one with the most confirmations") and
    /// B-19 say K's best is the stored publication with the most confirmations. The choice is pairwise against the
    /// current best only. Once the best fails (its Bitcoin block was orphaned), the first Ok submission becomes the
    /// best, even when another stored publication that verifies now has many more confirmations. `isBtcAnchored` then
    /// reads the newcomer and can be false while a stored, verifying publication is final, until someone re-submits
    /// that one. The via path is unaffected. Kept as the documented behaviour: the NatSpec and SCHEMA.md were
    /// corrected to say so (delta finding 3); the contract was not changed.
    function test_delta_bestAfterFailure_isTheNextValidSubmission() public {
        bytes32 a = _tx(1);
        bytes32 b = _tx(2);
        bytes32 c = _tx(3);
        _publish(a, 30);
        _record(a);
        _publish(b, 20);
        (, bool bBest) = _record(b);
        assertFalse(bBest);
        assertEq(p.bestPublicationOf(K).btcTxid, a);

        _drop(a); // a's Bitcoin block is orphaned
        _publish(c, 5); // c is mined later; `watch` (or anyone) records it first
        (bool created, bool best) = _record(c);
        assertTrue(created && best, "c took the best: the failing best is compared with c only");

        // b is stored, verifies now and has 20 confirmations; the anchored view reads c's 5.
        (PopFinality.Verdict vb, uint32 cb) = _viaConfs(b);
        assertEq(uint8(vb), uint8(PopFinality.Verdict.Ok));
        assertEq(cb, 20);
        assertTrue(p.isBtcFinalVia(K, K, b, 1));
        (, uint32 bestConfs) = p.anchorConfirmations(K, K);
        assertEq(bestConfs, 5);
        assertFalse(p.isBtcAnchored(K, K), "isBtcAnchored is false while a stored, verifying publication has 20");

        assertEq(p.bestPublicationOf(K).btcTxid, c, "documented: the next valid submission becomes the best");
    }

    /// @dev The same situation heals by a re-submission (anyone can send it, `watch` does not): passes.
    function test_delta_bestAfterFailure_healsByResubmitting() public {
        bytes32 a = _tx(1);
        bytes32 b = _tx(2);
        bytes32 c = _tx(3);
        _publish(a, 30);
        _record(a);
        _publish(b, 20);
        _record(b);
        _drop(a);
        _publish(c, 5);
        _record(c);
        (bool created, bool best) = _record(b);
        assertFalse(created);
        assertTrue(best);
        assertTrue(p.isBtcAnchored(K, K));
    }

    // =============================================================================================
    // Sound: stateful fuzz of the best pointer and the events
    // =============================================================================================

    struct World {
        bytes32[6] txid;
        uint32[6] off; // confirmations = base + off: a fixed Bitcoin order, so "most" is "mined earliest"
        bool[6] dropped;
        bool[6] stored;
        uint32 base;
        uint256 nStored;
        uint256 nRecordedEvents;
        bool anyDrop;
        bytes32 lastBestEventTxid;
    }

    function _setConfs(World memory w) internal {
        for (uint256 i; i < 6; ++i) {
            if (!w.dropped[i]) HvmMock.setConfirmations(w.txid[i], w.base + w.off[i]);
        }
    }

    function _bestIndex(World memory w) internal view returns (bool has, uint256 idx) {
        bytes32 t = p.bestPublicationOf(K).btcTxid;
        if (t == bytes32(0)) return (false, 0);
        for (uint256 i; i < 6; ++i) {
            if (w.txid[i] == t) return (true, i);
        }
        revert("the best names a transaction that was never submitted");
    }

    /// @dev Random sequences of submissions, Bitcoin progress and (optionally) orphaned transactions, over six valid
    /// publications of one K. After every step:
    /// - the best is empty exactly when nothing is stored, and otherwise is a stored entry (publicationOf agrees);
    /// - right after a successful submission the best verifies (a submission never points it at a failing entry);
    /// - with no orphaned transaction in the run, the best is the stored entry with the most confirmations;
    /// - `recordPublication` returns what `checkPublication` predicted, never reverts for an Ok candidate, and emits
    ///   PublicationRecorded once per entry and BestPublicationChanged exactly when the pointer moves.
    function testFuzz_delta_bestPointerInvariants(uint256 seed, bool allowDrops) public {
        World memory w;
        w.base = 1;
        for (uint256 i; i < 6; ++i) {
            w.txid[i] = _tx(i + 100);
            w.off[i] = uint32(uint256(keccak256(abi.encode(seed, "off", i))) % 200);
            HvmMock.setRaw(0x42, abi.encodePacked(w.txid[i], Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(K, K_HASH), 0));
        }
        _setConfs(w);
        for (uint256 step; step < 30; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = r % 8;
            uint256 i = (r >> 8) % 6;
            if (op < 5) {
                _submit(w, i);
            } else if (op < 7) {
                w.base += uint32((r >> 16) % 7) + 1;
                _setConfs(w);
            } else if (allowDrops && !w.dropped[i]) {
                w.dropped[i] = true;
                w.anyDrop = true;
                _drop(w.txid[i]);
            }
            _checkInvariants(w);
        }
    }

    function _submit(World memory w, uint256 i) internal {
        bytes32 before = p.bestPublicationOf(K).btcTxid;
        PopFinality.PublicationCheck memory c = p.checkPublication(K, w.txid[i], 1);
        if (w.dropped[i]) {
            assertTrue(c.verdict != PopFinality.Verdict.Ok);
            vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, c.verdict));
            p.recordPublication(K, w.txid[i], 1);
            return;
        }
        assertEq(uint8(c.verdict), uint8(PopFinality.Verdict.Ok));
        assertEq(c.recorded, w.stored[i]);
        assertEq(c.bestTxid, c.best ? w.txid[i] : before);
        vm.recordLogs();
        (bool created, bool best) = p.recordPublication(K, w.txid[i], 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(created, !w.stored[i], "created");
        assertEq(best, c.best || c.becomesBest, "best");
        uint256 recordedEvents;
        uint256 bestEvents;
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].topics[0] == TOPIC_RECORDED) {
                ++recordedEvents;
                assertEq(logs[j].topics[3], w.txid[i]);
            } else if (logs[j].topics[0] == TOPIC_BEST) {
                ++bestEvents;
                assertEq(logs[j].topics[2], w.txid[i]);
                (,, bytes32 prevTxid,) = abi.decode(logs[j].data, (uint16, uint32, bytes32, uint16));
                assertEq(prevTxid, before, "previousTxid is the best before the call");
                w.lastBestEventTxid = w.txid[i];
            }
        }
        assertEq(recordedEvents, created ? 1 : 0);
        assertEq(bestEvents, c.becomesBest ? 1 : 0);
        w.nRecordedEvents += recordedEvents;
        if (created) {
            w.stored[i] = true;
            ++w.nStored;
        }
        // Right after a submission the best verifies: the pointer never moves to (or stays on) a failing entry.
        (bool has, uint256 bi) = _bestIndex(w);
        assertTrue(has);
        assertFalse(w.dropped[bi], "a submission left the best on a publication that fails");
    }

    function _checkInvariants(World memory w) internal view {
        (bool has, uint256 bi) = _bestIndex(w);
        assertEq(has, w.nStored > 0, "best empty exactly when nothing is stored");
        assertEq(w.nRecordedEvents, w.nStored, "one PublicationRecorded per stored entry");
        if (!has) return;
        assertTrue(w.stored[bi], "the best is a stored entry");
        PopFinality.Publication memory b = p.bestPublicationOf(K);
        PopFinality.Publication memory e = p.publicationOf(K, b.btcTxid, b.vout);
        assertEq(keccak256(abi.encode(b)), keccak256(abi.encode(e)), "bestPublicationOf is publicationOf(best)");
        assertTrue(b.btcBlockHash != bytes32(0));
        assertEq(w.lastBestEventTxid, b.btcTxid, "the last BestPublicationChanged names the stored pointer");
        if (!w.anyDrop) {
            for (uint256 i; i < 6; ++i) {
                if (w.stored[i]) assertGe(w.off[bi], w.off[i], "without reorgs the best has the most confirmations");
            }
        }
    }

    // =============================================================================================
    // Sound: never-revert and record/check agreement with a stored best and arbitrary hVM answers
    // =============================================================================================

    /// @dev The existing never-revert fuzz runs on an empty K only. Here a best is stored first, then the best's and
    /// the candidate's 0x42/0x43 answers are arbitrary or failing, so the new re-read path is fuzzed too.
    function testFuzz_delta_checkWithStoredBest_neverRevertsAndRecordAgrees(
        bytes memory bestRaw42,
        bytes memory candRaw42,
        uint8 mode,
        uint32 bestConfs,
        uint32 candConfs,
        uint16 vout
    ) public {
        bytes32 best = _tx(1);
        bytes32 cand = _tx(2);
        _publish(best, 50);
        _record(best);
        if (mode & 1 != 0) HvmMock.setRaw(0x42, abi.encodePacked(best, Hvm.TX_FLAGS_OUTPUTS), bestRaw42);
        if (mode & 2 != 0) HvmMock.setFailInput(0x43, abi.encodePacked(best));
        else HvmMock.setConfirmations(best, bestConfs);
        if (mode & 4 != 0) {
            HvmMock.setRaw(0x42, abi.encodePacked(cand, Hvm.TX_FLAGS_OUTPUTS), candRaw42);
        } else {
            HvmMock.setRaw(0x42, abi.encodePacked(cand, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(K, K_HASH), 0));
            vout = 1;
        }
        if (mode & 8 != 0) HvmMock.setFailInput(0x43, abi.encodePacked(cand));
        else HvmMock.setConfirmations(cand, candConfs);
        // another 0x44 height moves the plausibility bound (HvmMock.header's time overflows above ~4.3M)
        if (mode & 16 != 0) HvmMock.setTip(HvmMock.header(uint32(bound(bestConfs, 0, 4_000_000))));

        PopFinality.PublicationCheck memory c = p.checkPublication(K, cand, vout);
        if (c.verdict != PopFinality.Verdict.Ok) {
            vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, c.verdict));
            p.recordPublication(K, cand, vout);
            assertEq(p.bestPublicationOf(K).btcTxid, best);
            return;
        }
        assertFalse(c.recorded);
        assertFalse(c.best);
        assertEq(c.bestTxid, best);
        (bool created, bool isBest) = p.recordPublication(K, cand, vout);
        assertTrue(created);
        assertEq(isBest, c.becomesBest);
        assertEq(p.bestPublicationOf(K).btcTxid, c.becomesBest ? cand : best);
        assertEq(p.publicationOf(K, cand, vout).btcTxid, cand);
        // The best's own entry is never touched by a competing submission.
        assertEq(p.publicationOf(K, best, 1).confirmations, 50);
    }

    // =============================================================================================
    // Sound: cost does not grow with the number of stored publications
    // =============================================================================================

    /// @dev No loop runs over a keystone's entries: the cost of the next record, and of both finality views, is the
    /// same with 2 and with 60 entries for K (each forgery costs the forger a Bitcoin output and Hemi gas).
    function test_delta_gas_flatInTheNumberOfStoredPublications() public {
        _publish(_tx(0), 500);
        _record(_tx(0));
        uint256[3] memory early;
        uint256[3] memory late;
        for (uint256 i = 1; i <= 60; ++i) {
            bytes32 t = _tx(i);
            _publish(t, uint32(500 - i));
            (bool ok, uint256 used,) = probe.measure(address(p), abi.encodeCall(PopFinality.recordPublication, (K, t, 1)));
            assertTrue(ok);
            uint256[3] memory m = i == 2 ? early : late;
            m[0] = used;
            (, m[1],) = probe.measure(address(p), abi.encodeCall(PopFinality.isBtcAnchored, (K, K)));
            (, m[2],) = probe.measure(address(p), abi.encodeCall(PopFinality.isBtcFinalVia, (K, K, t, 1)));
        }
        console2.log("record with 2 / 60 entries:", early[0], late[0]);
        console2.log("isBtcAnchored with 2 / 60:", early[1], late[1]);
        console2.log("isBtcFinalVia with 2 / 60:", early[2], late[2]);
        assertApproxEqAbs(late[0], early[0], 300, "record cost grows with stored entries");
        assertApproxEqAbs(late[1], early[1], 300);
        assertApproxEqAbs(late[2], early[2], 300);
    }

    // =============================================================================================
    // Sound: gas starvation cannot flip an outcome, with the extra writes
    // =============================================================================================

    /// @dev A winning candidate (more confirmations than the best) under every gas limit: the call either reverts and
    /// changes nothing, or stores it as the best. Never "stored but not the best".
    function test_delta_gasSweep_winnerNeverStoredWithoutTheBest() public {
        bytes32 real = _tx(1);
        bytes32 win = _tx(2);
        _publish(real, 10);
        _record(real);
        _publish(win, 20);
        bytes memory data = abi.encodeCall(PopFinality.recordPublication, (K, win, 1));
        uint256 successes;
        for (uint256 g = 20_000; g < 400_000; g += 101) {
            (bool ok, bytes memory ret) = probe.call(address(p), data, g);
            bool stored = p.publicationOf(K, win, 1).btcTxid == win;
            if (ok) {
                ++successes;
                (, bool best) = abi.decode(ret, (bool, bool));
                assertTrue(best);
                assertEq(p.bestPublicationOf(K).btcTxid, win);
                break; // stored now; the rest of the sweep would be the re-submission path
            }
            assertFalse(stored, "a reverted call left an entry");
            assertEq(p.bestPublicationOf(K).btcTxid, real);
        }
        assertEq(successes, 1);
    }

    /// @dev The smallest gas limit at which `data` succeeds, found by bisection with state snapshots (nothing kept).
    function _minGas(bytes memory data, uint256 lo, uint256 hi) internal returns (uint256) {
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = probe.call(address(p), data, mid);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    /// @dev The best's re-read is the step a starving caller would target: for a candidate with fewer confirmations,
    /// a starved 0x42 or 0x43 on the best reads as "fails", which means "replace". The re-read sits before the three
    /// entry writes, so its windows lie up to ~130k below the minimum gas G. Sweep that range on the new-entry path,
    /// restoring state after each success so every probe takes the same path, and check the pointer never moves.
    function test_delta_gasSweep_fineAroundTheBestReRead_newEntry() public {
        bytes32 real = _tx(1);
        bytes32 loser = _tx(2);
        _publish(real, 10);
        _record(real);
        _publish(loser, 3);
        bytes memory data = abi.encodeCall(PopFinality.recordPublication, (K, loser, 1));
        uint256 g0 = _minGas(data, 20_000, 600_000);
        console2.log("min gas, new losing entry:", g0);
        uint256 snap = vm.snapshotState();
        uint256 successes;
        for (uint256 g = g0 - 130_000; g < g0 + 200; g += 17) {
            (bool ok, bytes memory ret) = probe.call(address(p), data, g);
            assertEq(p.bestPublicationOf(K).btcTxid, real, "a starved re-read moved the best");
            if (ok) {
                ++successes;
                (, bool best) = abi.decode(ret, (bool, bool));
                assertFalse(best);
                vm.revertToState(snap);
                snap = vm.snapshotState();
            }
        }
        assertGt(successes, 0);
    }

    /// @dev The same on the re-submission path, which writes nothing for a loser: flipping it would need the pointer
    /// write (2,900 gas, behind EIP-2200's 2,300 sentry), and a starved call leaves at most ~400.
    function test_delta_gasSweep_fineAroundTheBestReRead_resubmission() public {
        bytes32 real = _tx(1);
        bytes32 loser = _tx(2);
        _publish(real, 10);
        _record(real);
        _publish(loser, 3);
        _record(loser);
        bytes memory data = abi.encodeCall(PopFinality.recordPublication, (K, loser, 1));
        uint256 g0 = _minGas(data, 10_000, 600_000);
        console2.log("min gas, re-submitted loser:", g0);
        for (uint256 g = g0 > 70_000 ? g0 - 70_000 : 0; g < g0 + 200; g += 7) {
            probe.call(address(p), data, g);
            assertEq(p.bestPublicationOf(K).btcTxid, real, "a starved re-read moved the best (re-submission)");
        }
    }

    /// @dev The first record of K when block K is older than 256 blocks: the checkpoint comes from the EIP-2935
    /// contract (real bytecode). Starving that call reads "no hash" (OutsideWindow) and reverts; no gas limit stores a
    /// wrong checkpoint or an entry without its checkpoint.
    function test_delta_gasSweep_firstRecordThroughHistory() public {
        vm.etch(HISTORY, HISTORY_CODE);
        vm.setBlockhash(K, bytes32(0));
        vm.roll(K + 1_000);
        assertEq(blockhash(K), bytes32(0), "past the blockhash window");
        vm.store(HISTORY, bytes32(K % 8191), K_HASH);
        bytes32 t = _tx(1);
        _publish(t, 10);
        bytes memory data = abi.encodeCall(PopFinality.recordPublication, (K, t, 1));
        bool done;
        for (uint256 g = 20_000; g < 300_000; g += 37) {
            (bool ok,) = probe.call(address(p), data, g);
            bytes12 cp = p.checkpointOf(K).blockHashPrefix;
            if (ok) {
                assertEq(cp, bytes12(K_HASH));
                assertEq(p.bestPublicationOf(K).btcTxid, t);
                done = true;
                break;
            }
            assertEq(cp, bytes12(0), "a reverted call stored a checkpoint");
            assertEq(p.publicationOf(K, t, 1).btcTxid, bytes32(0));
        }
        assertTrue(done);
    }

    /// @dev A consumer contract calling the views with a gas budget it does not control: a starved 0x43 reads as
    /// NoConfirmations (false), never as final. Not final (5 confirmations): no budget gives true.
    function test_delta_gasSweep_viewsNeverReadFinalWhenNot() public {
        bytes32 t = _tx(1);
        _publish(t, 5);
        _record(t);
        for (uint256 g = 0; g < 60_000; g += 13) {
            (bool ok, bytes memory ret) = probe.call(address(p), abi.encodeCall(PopFinality.isBtcFinalVia, (K, K, t, 1)), g);
            if (ok) assertFalse(abi.decode(ret, (bool)));
            (ok, ret) = probe.call(address(p), abi.encodeCall(PopFinality.isBtcAnchored, (K, K)), g);
            if (ok) assertFalse(abi.decode(ret, (bool)));
        }
    }

    // =============================================================================================
    // Sound: the covering rule of the via views, and the keystone bounds
    // =============================================================================================

    /// @dev For a positive multiple of 25 below 2^32, "K >= block" is exactly "K at or after the block's covering
    /// keystone", and the via views answer (not NotCovering) exactly then.
    function testFuzz_delta_viaCoveringRule(uint256 blockNumber, uint256 kMul) public {
        uint256 k = bound(kMul, 1, type(uint32).max / 25) * 25;
        blockNumber = bound(blockNumber, 0, uint256(type(uint32).max) + 100);
        bytes32 t = _tx(7);
        bytes32 base = _publicationSlot(k, t, 1);
        vm.store(address(p), base, t);
        vm.store(address(p), bytes32(uint256(base) + 1), TIP_HASH);
        HvmMock.setConfirmations(t, 50);
        uint256 ck = p.coveringKeystone(blockNumber);
        bool covers = k >= blockNumber;
        // coveringKeystone is 0 only above the largest keystone, where no K covers the block (pre-mainnet audit L-1).
        if (ck == 0) assertFalse(covers, "no keystone covers a block above MAX_KEYSTONE");
        else assertEq(covers, k >= ck, "K >= block is K >= coveringKeystone(block)");
        (PopFinality.Verdict v, uint32 c) = p.btcConfirmationsVia(blockNumber, k, t, 1);
        assertEq(v == PopFinality.Verdict.Ok, covers);
        assertEq(v == PopFinality.Verdict.NotCovering, !covers);
        assertEq(c, covers ? 50 : 0);
        assertEq(p.isBtcFinalVia(blockNumber, k, t, 1), covers);
    }

    function test_delta_keystoneBounds() public view {
        uint256 top = (uint256(type(uint32).max) / 25) * 25; // 4,294,967,275
        (PopFinality.Verdict v,) = p.btcConfirmationsVia(0, top, _tx(1), 1);
        assertEq(uint8(v), uint8(PopFinality.Verdict.NotRecorded)); // a keystone, nothing stored
        (v,) = p.btcConfirmationsVia(0, top + 25, _tx(1), 1);
        assertEq(uint8(v), uint8(PopFinality.Verdict.NotKeystone));
        (v,) = p.btcConfirmationsVia(0, 0, _tx(1), 1);
        assertEq(uint8(v), uint8(PopFinality.Verdict.NotKeystone));
        assertEq(p.publicationOf(top + 25, _tx(1), 1).btcTxid, bytes32(0));
        assertEq(p.bestPublicationOf(top + 25).btcTxid, bytes32(0));
        assertEq(p.bestPublicationOf(type(uint256).max).btcTxid, bytes32(0));
    }

    /// @dev The same (txid, vout) stored under K is not visible under another keystone, and the three mappings do
    /// not overlap (slots 0, 1, 2 with differently keyed preimages).
    function test_delta_keysDoNotCollide() public {
        bytes32 t = _tx(1);
        _publish(t, 10);
        _record(t);
        assertEq(p.publicationOf(K, t, 1).btcTxid, t);
        assertEq(p.publicationOf(K + 25, t, 1).btcTxid, bytes32(0));
        assertEq(p.publicationOf(K, t, 0).btcTxid, bytes32(0));
        assertEq(p.bestPublicationOf(K + 25).btcTxid, bytes32(0));
        assertTrue(_publicationSlot(K, t, 1) != _bestSlot(K));
        assertTrue(_publicationSlot(K, t, 1) != _checkpointSlot(K));
        assertEq(vm.load(address(p), _bestSlot(K)), _subject(K, t, 1));
    }

    // =============================================================================================
    // Gas: a forger-chosen fat best, re-read by every later competing record
    // =============================================================================================

    /// @dev Bounded (the largest 0x42 answer), as the first review measured; now the loser is stored too.
    function test_delta_gas_competingRecordAgainstAFatBest() public {
        bytes32 fat = _tx(1);
        HvmMock.setRaw(
            0x42, abi.encodePacked(fat, Hvm.TX_FLAGS_OUTPUTS), Raw42.big(948, 128, 201, 1, 1, _popScript(K, K_HASH))
        );
        HvmMock.setConfirmations(fat, 20);
        _record(fat);
        bytes32 honest = _tx(2);
        _publish(honest, 3);
        (bool ok, uint256 used,) = probe.measure(address(p), abi.encodeCall(PopFinality.recordPublication, (K, honest, 1)));
        assertTrue(ok);
        console2.log("honest record against a 128x128 best:", used);
        assertLt(used, 500_000);
    }
}
