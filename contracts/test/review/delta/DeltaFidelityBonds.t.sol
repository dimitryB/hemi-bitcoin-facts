// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";
import {FidelityBonds} from "../../../src/FidelityBonds.sol";
import {HvmMock} from "../../utils/HvmMock.sol";
import {BondFixtures} from "../../FidelityBonds.t.sol";

/// @notice Delta review (docs/SECURITY-AUDIT.md) of FidelityBonds after the internal review's fixes: "any HFB1 tag is ambiguous", the
/// x < p key check and the stricter `witnessScriptFor`. `test_delta_F…` tests failed against the code the
/// review read (the evidence for its findings) and pass since the fixes; the others pass.
contract DeltaFidelityBondsTest is BondFixtures {
    FidelityBonds internal fb;

    uint256 internal constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    function setUp() public {
        HvmMock.install();
        fb = new FidelityBonds();
        vm.roll(5_780_432);
    }

    function _key(bytes1 prefix, uint256 x) internal pure returns (bytes memory) {
        return abi.encodePacked(prefix, bytes32(x));
    }

    /// @dev A funding tx (bond 0, tag 1, change 2, 6 confirmations) for an arbitrary witness script.
    function _fund(bytes32 txid, bytes memory ws) internal {
        _setTip(TIP_TIME);
        HvmMock.setOutput(txid, 0, SATS, _p2wsh(ws), false);
        HvmMock.setOutput(txid, 1, 0, _tag(block.chainid, address(fb), AGENT), true);
        HvmMock.setOutput(txid, 2, 5_000, CHANGE_SCRIPT, false);
        HvmMock.setConfirmations(txid, 6);
    }

    // =============================================================================================
    // Findings: the helpers
    // =============================================================================================

    /// @dev `witnessScriptFor` now returns empty bytes for a key it refuses, and `bondScript` hashes whatever it is
    /// given. Chained, as an integrator building a funding address from the two public helpers would do, a bad key
    /// (x >= p, a 65-byte uncompressed key, a typo'd length) gives `0x0020 ‖ sha256("")`: P2WSH of the empty
    /// script. Under BIP141 that output is spent by the witness [0x01, <empty script>] (the empty script leaves the
    /// single TRUE): anyone can take it. Before the internal review's fixes the same chain gave a script with the bad key in it, which
    /// at worst burned the funds. Failed before the fix.
    function test_delta_F_witnessScriptForInvalidKey_doesNotComposeToAnyoneCanSpend() public view {
        bytes memory anyoneCanSpend = abi.encodePacked(hex"0020", sha256(""));
        bytes[3] memory badKeys = [
            _key(0x02, type(uint256).max), // x >= p
            abi.encodePacked(hex"04", bytes32(uint256(1)), bytes32(uint256(2))), // uncompressed, 65 bytes
            bytes(hex"02aabb") // wrong length
        ];
        for (uint256 i; i < badKeys.length; ++i) {
            bytes memory ws = fb.witnessScriptFor(LOCKTIME, badKeys[i]);
            bytes memory spk = fb.bondScript(ws);
            console2.logBytes(spk);
            assertTrue(
                keccak256(spk) != keccak256(anyoneCanSpend),
                "bondScript(witnessScriptFor(bad key)) is P2WSH of the empty script: anyone can spend it"
            );
        }
    }

    /// @dev The new NatSpec says `witnessScriptFor` is "Empty for any other key, so a caller cannot build a script
    /// `checkBond` would refuse". The locktime is not checked: 0, 499,999,999 (a height) and 2^31 (a negative script
    /// number, so CLTV fails for ever and the output can never be spent) all give a 42-byte script that `checkBond`
    /// refuses as BadLocktime. Failed before the fix.
    function test_delta_F_witnessScriptFor_neverBuildsAScriptCheckBondRefuses() public {
        uint32[3] memory bad = [uint32(0), 499_999_999, uint32(1 << 31)];
        for (uint256 i; i < bad.length; ++i) {
            bytes memory ws = fb.witnessScriptFor(bad[i], PUBKEY);
            bytes32 txid = keccak256(abi.encodePacked("delta: bad locktime", i));
            _fund(txid, ws);
            uint8 v = uint8(fb.checkBond(txid, 0, 1, ws).verdict);
            console2.log("locktime / script length / checkBond verdict:", bad[i], ws.length, v);
            assertTrue(
                ws.length == 0 || v != uint8(FidelityBonds.Verdict.BadLocktime),
                "witnessScriptFor built a script checkBond refuses (BadLocktime)"
            );
        }
    }

    // =============================================================================================
    // Sound: the field-prime check
    // =============================================================================================

    /// @dev x = p - 1 is the largest accepted; x = p and above are refused; the same boundary in `checkBond` (the only
    /// place a key enters a stored bond) and in `witnessScriptFor`, for both prefixes. The x bytes are ws[9:41].
    function test_delta_fieldPrimeBoundary() public {
        bytes1[2] memory prefixes = [bytes1(0x02), bytes1(0x03)];
        uint256[4] memory xs = [uint256(0), P - 1, P, type(uint256).max];
        for (uint256 j; j < 2; ++j) {
            for (uint256 i; i < xs.length; ++i) {
                bytes memory key = _key(prefixes[j], xs[i]);
                bytes memory ws = _ws(LOCKTIME, key);
                bytes32 txid = keccak256(abi.encodePacked("delta: key", i, j));
                _fund(txid, ws);
                FidelityBonds.Verdict v = fb.checkBond(txid, 0, 1, ws).verdict;
                bool accepted = xs[i] < P;
                assertEq(v == FidelityBonds.Verdict.Ok, accepted);
                assertEq(v == FidelityBonds.Verdict.BadWitnessScript, !accepted);
                bytes memory built = fb.witnessScriptFor(LOCKTIME, key);
                assertEq(built.length, accepted ? 42 : 0);
                if (accepted) assertEq(built, ws);
            }
        }
    }

    function testFuzz_delta_fieldPrime(uint256 x, bool odd) public {
        bytes memory key = _key(odd ? bytes1(0x03) : bytes1(0x02), x);
        bytes memory ws = _ws(LOCKTIME, key);
        _fund(TXID, ws);
        FidelityBonds.Verdict v = fb.checkBond(TXID, 0, 1, ws).verdict;
        assertEq(v == FidelityBonds.Verdict.BadWitnessScript, x >= P);
        assertEq(fb.witnessScriptFor(LOCKTIME, key).length, x >= P ? 0 : 42);
    }

    // =============================================================================================
    // Sound: "any HFB1 tag is ambiguous"
    // =============================================================================================

    /// @dev Another output of the funding tx makes the bond AmbiguousTag exactly when it is a 50-byte script starting
    /// `6a 30 "HFB1"`, whatever follows: the form every deployment of this code accepts as a tag. `readTag` agrees.
    /// Outputs are fixed by the txid, so with SIGHASH_ALL/DEFAULT nobody outside the funding transaction can add one
    /// (reasoning; the NONE/SINGLE case is the first review's finding 6, now documented).
    function testFuzz_delta_anyTagRule(bytes memory extra, bool forceTag, bytes32 rest1, bytes12 rest2) public {
        if (forceTag) extra = abi.encodePacked(hex"6a3048464231", rest1, rest2); // 6 + 32 + 12 = 50
        if (extra.length > 128) extra = new bytes(0);
        bytes memory ws = _bondTx(address(fb));
        HvmMock.setOutput(TXID, 3, 0, extra, true);
        bool isTag = extra.length == 50 && bytes6(_head(extra)) == bytes6(hex"6a3048464231");
        FidelityBonds.Verdict v = fb.checkBond(TXID, 0, 1, ws).verdict;
        assertEq(v == FidelityBonds.Verdict.AmbiguousTag, isTag);
        if (!isTag) assertEq(uint8(v), uint8(FidelityBonds.Verdict.Ok));
        (FidelityBonds.Verdict tv, address agent) = fb.readTag(TXID, 1);
        assertEq(uint8(tv), uint8(v));
        assertEq(agent, isTag ? address(0) : AGENT);
    }

    function _head(bytes memory b) internal pure returns (bytes32 h) {
        assembly ("memory-safe") {
            h := mload(add(b, 32))
        }
    }
}
