// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Review of the audit fixes (docs/SECURITY-AUDIT.md). Scratch tests: they pin
// what the new two-clock Expired rule does, and show the wall-clock dependency it adds to a fork test's fixture.
import {Hvm} from "../../../src/Hvm.sol";
import {FidelityBonds} from "../../../src/FidelityBonds.sol";
import {HvmMock} from "../../utils/HvmMock.sol";
import {BondFixtures} from "../../FidelityBonds.t.sol";

contract AuditFixesFidelityBonds is BondFixtures {
    FidelityBonds internal fb;
    bytes32 internal id;

    function setUp() public {
        HvmMock.install();
        fb = new FidelityBonds();
        bytes memory ws = _bondTx(address(fb));
        id = fb.recordBond(TXID, 0, 1, ws);
    }

    function _status() internal view returns (FidelityBonds.Status s) {
        (s,,,) = fb.liveBond(id);
    }

    /// The rule, exhaustively over both clocks: Live iff the 0x44 header's time and block.timestamp are both
    /// before the locktime; Expired otherwise (the bond is unspent and 0x44 answers). checkBond's expired flag is
    /// the same predicate, so `check.expired == (liveBond == Expired)` for an unspent stored bond.
    function testFuzz_audit_twoClockRule(uint32 headerTime, uint256 ts) public {
        ts = bound(ts, 0, type(uint64).max);
        _setTip(headerTime);
        vm.warp(ts);
        FidelityBonds.Status s = _status();
        bool live = headerTime < LOCKTIME && ts < LOCKTIME;
        assertEq(uint8(s), uint8(live ? FidelityBonds.Status.Live : FidelityBonds.Status.Expired));
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, _ws());
        assertEq(uint8(c.verdict), uint8(FidelityBonds.Verdict.Ok), "expired is never a reason to refuse");
        assertEq(c.expired, !live);
        assertEq(c.btcTime, headerTime, "btcTime is still the header's time alone");
        if (s == FidelityBonds.Status.Live) assertLt(ts, LOCKTIME, "Live implies Hemi's clock is before the locktime");
    }

    /// Once block.timestamp has reached the locktime, no header time (higher, lower, zero) brings back Live.
    function testFuzz_audit_expiredForGoodFromHemiClock(uint32 headerTime, uint256 dt) public {
        dt = bound(dt, 0, 100 * 365 days);
        vm.warp(uint256(LOCKTIME) + dt);
        _setTip(headerTime);
        assertEq(uint8(_status()), uint8(FidelityBonds.Status.Expired));
    }

    /// The new clock does not reach past the other statuses: Ended, Unknown and NotRecorded are unchanged by it.
    function test_audit_hemiClockDoesNotMaskOtherStatuses() public {
        vm.warp(uint256(LOCKTIME) + 1 days);
        assertEq(uint8(_status()), uint8(FidelityBonds.Status.Expired));
        HvmMock.setFail(0x48, true); // spendStatus Unknown (0x42 still lists the output unspent)
        assertEq(uint8(_status()), uint8(FidelityBonds.Status.Unknown));
        HvmMock.setFail(0x48, false);
        HvmMock.setFail(0x44, true); // no header
        assertEq(uint8(_status()), uint8(FidelityBonds.Status.Unknown));
        HvmMock.setFail(0x44, false);
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(_ws()), true);
        assertEq(uint8(_status()), uint8(FidelityBonds.Status.Ended));
        (FidelityBonds.Status nr,,,) = fb.liveBond(bytes32(uint256(1)));
        assertEq(uint8(nr), uint8(FidelityBonds.Status.NotRecorded));
    }

    /// `test_fork_deployRecordLiveRefresh` (test/FidelityBonds.t.sol) forks Hemi mainnet at its latest block and
    /// asserts Live for a bond whose locktime is the fixture's 1,800,000,000 (2027-01-15T08:00:00Z), with the mocked
    /// header a day before it. Before the audit fixes only the mocked header decided; now the fork's real block.timestamp
    /// does too. This is that assertion with the clock the fork will have from that date: Expired, so the fork test
    /// failed from 2027-01-15T08:00:00Z on (finding R-1). Fixed since: the fork test now warps a day before.
    function test_audit_forkFixtureStopsBeingLiveAtItsLocktime() public {
        _setTip(TIP_TIME);
        vm.warp(LOCKTIME - 1);
        assertEq(uint8(_status()), uint8(FidelityBonds.Status.Live));
        vm.warp(LOCKTIME);
        assertEq(uint8(_status()), uint8(FidelityBonds.Status.Expired));
    }

    /// The header's time, the only clock checkBond reports (btcTime), is not what made it expired: a consumer that
    /// reads `expired` next to `btcTime < locktime` sees an apparent contradiction (and the SDK's `bond record`
    /// note says "the hVM Bitcoin header's time is already at or past the locktime" when it is not; finding R-3).
    function test_audit_expiredFlagWithHeaderTimeBeforeTheLocktime() public {
        _setTip(LOCKTIME - 1 hours);
        vm.warp(LOCKTIME);
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, _ws());
        assertTrue(c.expired);
        assertLt(c.btcTime, c.locktime);
    }

    /// The header-time path is unchanged and still conservative: header time >= locktime gives Expired with Hemi's
    /// clock anywhere before it (Bitcoin's median time past is at or below the newest header's time).
    function testFuzz_audit_headerPathUnchanged(uint32 headerTime, uint256 ts) public {
        headerTime = uint32(bound(headerTime, LOCKTIME, type(uint32).max));
        ts = bound(ts, 0, uint256(LOCKTIME) - 1);
        vm.warp(ts);
        _setTip(headerTime);
        assertEq(uint8(_status()), uint8(FidelityBonds.Status.Expired));
        assertEq(uint8(Hvm.spendStatus(TXID, 0, SATS, keccak256(_p2wsh(_ws())))), uint8(Hvm.Spend.Unspent));
    }
}
