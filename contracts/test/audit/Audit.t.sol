// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Independent audit, 2026-11-21. Demonstrations of behaviours the report describes; none is a loss-of-funds or
// false-fact proof. After the audit (docs/SECURITY-AUDIT.md, independent audit): A-1 was fixed and now asserts the fix; A-2 is narrowed by the
// same fix and asserts both sides; A-3 is kept as a documented property.
import {Hvm} from "../../src/Hvm.sol";
import {FidelityBonds} from "../../src/FidelityBonds.sol";
import {HvmMock} from "../utils/HvmMock.sol";
import {BondFixtures} from "../FidelityBonds.t.sol";

contract AuditFidelityBonds is BondFixtures {
    FidelityBonds internal fb;

    function setUp() public {
        HvmMock.install();
        fb = new FidelityBonds();
    }

    function _record() internal returns (bytes32 id, bytes memory ws) {
        ws = _bondTx(address(fb));
        id = fb.recordBond(TXID, 0, 1, ws);
    }

    function _status(bytes32 id) internal view returns (FidelityBonds.Status s) {
        (s,,,) = fb.liveBond(id);
    }

    /// A-1. hVM's Bitcoin view stops advancing (0x44 keeps an old header) while Hemi keeps producing blocks.
    /// Six hours after the locktime by Hemi's own clock, well past the point the owner can redeem on Bitcoin, liveBond
    /// said Live. Fixed (finding 1): Expired also once block.timestamp reaches the locktime.
    function test_audit_A1_liveWhileHemiClockIsHoursPastTheLocktime() public {
        (bytes32 id,) = _record();
        assertEq(uint8(_status(id)), uint8(FidelityBonds.Status.Live));
        vm.warp(uint256(LOCKTIME) + 6 hours);
        vm.roll(block.number + 1800);
        assertEq(uint8(_status(id)), uint8(FidelityBonds.Status.Expired), "Expired by Hemi's clock on a stale view");
        assertTrue(fb.checkBond(TXID, 0, 1, _ws()).expired, "checkBond's expired flag agrees");
    }

    /// A-2. Bitcoin lets a block's time be lower than its parent's, so an early Expired (from the header time) can turn
    /// back into Live while Hemi's clock is before the locktime, when the bond is not yet redeemable. Once Hemi's
    /// clock reaches the locktime it stays Expired, whatever the header time does.
    function test_audit_A2_expiredCanTurnBackIntoLive() public {
        (bytes32 id,) = _record();
        _setTip(LOCKTIME + 30);
        assertEq(uint8(_status(id)), uint8(FidelityBonds.Status.Expired));
        _setTip(LOCKTIME - 30); // the next header's time is a minute lower: valid on Bitcoin
        assertEq(uint8(_status(id)), uint8(FidelityBonds.Status.Live), "before Hemi's clock reaches the locktime");
        vm.warp(LOCKTIME);
        assertEq(uint8(_status(id)), uint8(FidelityBonds.Status.Expired), "from Hemi's clock on, for good");
        _setTip(LOCKTIME - 600);
        assertEq(uint8(_status(id)), uint8(FidelityBonds.Status.Expired));
    }

    /// A-3. Ended is permanent. After refresh has seen the output spent, a Bitcoin reorg (or a corrected hVM
    /// answer) that shows the output unspent again changes nothing, and recording again does not reset it.
    function test_audit_A3_endedStaysEndedWhenTheOutputReadsUnspentAgain() public {
        (bytes32 id, bytes memory ws) = _record();
        bytes memory script = _p2wsh(ws);
        HvmMock.setOutput(TXID, 0, SATS, script, true);
        assertTrue(fb.refresh(id));
        assertEq(uint8(_status(id)), uint8(FidelityBonds.Status.Ended));

        HvmMock.setOutput(TXID, 0, SATS, script, false); // unspent again in hVM's view
        assertEq(uint8(Hvm.spendStatus(TXID, 0, SATS, keccak256(script))), uint8(Hvm.Spend.Unspent));
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
        assertEq(uint8(c.verdict), uint8(FidelityBonds.Verdict.Ok), "the bond checks Ok again");
        assertEq(fb.recordBond(TXID, 0, 1, ws), id, "recording again returns the same id");
        assertTrue(fb.refresh(id));
        assertEq(uint8(_status(id)), uint8(FidelityBonds.Status.Ended), "and it still reads Ended");
    }
}
