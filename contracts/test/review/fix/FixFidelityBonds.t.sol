// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FidelityBonds} from "../../../src/FidelityBonds.sol";
import {HvmMock} from "../../utils/HvmMock.sol";
import {BondFixtures} from "../../FidelityBonds.t.sol";

/// @dev The two pure helpers of FidelityBonds before the fix review's change.
interface IOldBondHelpers {
    function bondScript(bytes calldata witnessScript) external pure returns (bytes memory);
    function witnessScriptFor(uint32 locktime, bytes calldata pubkey) external pure returns (bytes memory);
}

/// @notice Fix review (docs/SECURITY-AUDIT.md): `bondScript` and `witnessScriptFor` against the rule
/// `checkBond` applies to the template, the key and the locktime. All pass.
/// @dev The oracle: with no 0x44 tip set, `checkBond` stops at its third step, so its verdict is BadWitnessScript or
/// BadLocktime exactly when the template, key or locktime is refused, and NoBitcoinView otherwise.
contract FixFidelityBondsTest is BondFixtures {
    FidelityBonds internal fb;
    IOldBondHelpers internal old;

    uint256 internal constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    function setUp() public {
        HvmMock.install(); // no tip: checkBond stops at NoBitcoinView once the script passes
        fb = new FidelityBonds();
        bytes memory oldCode = vm.parseBytes(vm.readFile("test/fixtures/review-fix/FidelityBonds-before-fix.initcode.hex"));
        assertEq(keccak256(oldCode), 0x4741c48718a3754e2814e721bab685fc07ca9cb7d077abcebd317decd8154b81, "before-fix pin");
        address a;
        assembly {
            a := create(0, add(oldCode, 32), mload(oldCode))
        }
        require(a != address(0), "old deploy");
        old = IOldBondHelpers(a);
    }

    // ---- oracle ------------------------------------------------------------------------------------

    /// @dev Whether checkBond accepts ws's template, key and locktime (its first two steps), and the locktime it read.
    function _accepted(bytes memory ws) internal view returns (bool ok, uint32 lt) {
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
        if (c.verdict == FidelityBonds.Verdict.BadWitnessScript || c.verdict == FidelityBonds.Verdict.BadLocktime) {
            return (false, 0);
        }
        assertEq(uint8(c.verdict), uint8(FidelityBonds.Verdict.NoBitcoinView), "oracle: third step");
        assertEq(c.witnessProgram, sha256(ws), "oracle: program");
        return (true, c.locktime);
    }

    function _check(bytes memory ws) internal view {
        (bool ok,) = _accepted(ws);
        bytes memory s = fb.bondScript(ws);
        if (ok) {
            assertEq(s, abi.encodePacked(hex"0020", sha256(ws)), "accepted: 0x0020 || sha256(ws)");
            assertEq(s.length, 34);
        } else {
            assertEq(s.length, 0, "refused: empty");
        }
        // The change only removes answers: where the new one is non-empty it is the old one.
        if (s.length != 0) assertEq(s, old.bondScript(ws), "same as before the fix");
    }

    /// @dev A 42-byte template from fuzz parts, optionally with one byte overwritten or the length changed.
    function _structured(uint32 lt, uint8 prefixSel, uint256 x, uint8 mutate, uint8 pos, uint8 val)
        internal
        pure
        returns (bytes memory ws)
    {
        bytes1 prefix = [bytes1(0x02), 0x03, 0x04, 0x00][prefixSel % 4];
        if (x % 4 == 0) x = P - 1 + (x % 3); // the x boundary: p-1, p, p+1
        ws = abi.encodePacked(hex"04", _le(lt), hex"b17521", prefix, bytes32(x), hex"ac");
        uint8 m = mutate % 8;
        if (m == 5) ws[pos % 42] = bytes1(val);
        if (m == 6) ws = abi.encodePacked(ws, bytes1(val)); // 43 bytes
        if (m == 7) {
            bytes memory cut = new bytes(41);
            for (uint256 i; i < 41; ++i) {
                cut[i] = ws[i];
            }
            ws = cut;
        }
    }

    // ---- bondScript --------------------------------------------------------------------------------

    /// @dev Arbitrary bytes: empty exactly when checkBond refuses the template, key or locktime.
    function testFuzz_fix_bondScript_arbitraryBytes(bytes calldata ws) public view {
        _check(ws);
    }

    /// @dev Near-template inputs, so the accepting region and every boundary are hit.
    function testFuzz_fix_bondScript_structured(uint32 lt, uint8 prefixSel, uint256 x, uint8 mutate, uint8 pos, uint8 val)
        public
        view
    {
        _check(_structured(lt, prefixSel, x, mutate, pos, val));
    }

    /// @dev The inputs that matter most: nothing short of a bond script gives a P2WSH, so no helper chain can give
    /// the P2WSH of the empty script (anyone can spend) or of OP_TRUE.
    function test_fix_bondScript_refusesTheDangerousInputs() public view {
        assertEq(fb.bondScript("").length, 0, "empty script");
        assertEq(fb.bondScript(hex"51").length, 0, "OP_TRUE");
        assertEq(fb.bondScript(new bytes(42)).length, 0, "42 zero bytes");
        bytes memory good = _ws();
        assertEq(fb.bondScript(good), _p2wsh(good));
        bytes[4] memory badKeys = [
            abi.encodePacked(bytes1(0x02), bytes32(P)),
            abi.encodePacked(hex"04", bytes32(uint256(1)), bytes32(uint256(2))),
            bytes(hex"02aabb"),
            bytes("")
        ];
        for (uint256 i; i < badKeys.length; ++i) {
            assertEq(fb.bondScript(fb.witnessScriptFor(LOCKTIME, badKeys[i])).length, 0, "chained bad key");
        }
        uint32[3] memory badLt = [uint32(0), 499_999_999, uint32(1 << 31)];
        for (uint256 i; i < badLt.length; ++i) {
            assertEq(fb.bondScript(fb.witnessScriptFor(badLt[i], PUBKEY)).length, 0, "chained bad locktime");
            assertEq(fb.bondScript(_ws(badLt[i], PUBKEY)).length, 0, "bad locktime");
        }
    }

    /// @dev Non-standard ABI encodings reach bondScript and checkBond through the same calldata decoder: trailing
    /// garbage after the bytes is ignored by both, and the answer is the one for the 42 bytes.
    function test_fix_bondScript_trailingCalldataIgnored() public view {
        bytes memory ws = _ws();
        bytes memory cd = abi.encodePacked(abi.encodeCall(FidelityBonds.bondScript, (ws)), bytes32(uint256(0xdead)));
        (bool ok, bytes memory ret) = address(fb).staticcall(cd);
        assertTrue(ok);
        assertEq(abi.decode(ret, (bytes)), _p2wsh(ws));
    }

    // ---- witnessScriptFor --------------------------------------------------------------------------

    function _expectBuilt(uint32 lt, bytes memory key) internal view {
        bool keyOk = key.length == 33 && (key[0] == 0x02 || key[0] == 0x03);
        if (keyOk) {
            uint256 x;
            assembly {
                x := mload(add(key, 33))
            }
            keyOk = x < P;
        }
        bool want = keyOk && lt >= 500_000_000 && uint256(lt) < (1 << 31);
        bytes memory out = fb.witnessScriptFor(lt, key);
        if (!want) {
            assertEq(out.length, 0, "refused: empty");
        } else {
            assertEq(out, _ws(lt, key), "the template");
            (bool acc, uint32 got) = _accepted(out);
            assertTrue(acc, "checkBond accepts what witnessScriptFor builds");
            assertEq(got, lt, "same locktime");
            assertEq(fb.bondScript(out), _p2wsh(out));
        }
        // For a 33-byte key the template exists: checkBond accepts it exactly when witnessScriptFor builds it.
        if (key.length == 33) {
            (bool acc2,) = _accepted(_ws(lt, key));
            assertEq(acc2, want, "witnessScriptFor and checkBond agree");
        }
        // Only removals against the build before the fix.
        if (out.length != 0) assertEq(out, old.witnessScriptFor(lt, key), "same as before the fix");
    }

    function testFuzz_fix_witnessScriptFor_arbitrary(uint32 lt, bytes calldata key) public view {
        _expectBuilt(lt, key);
    }

    function testFuzz_fix_witnessScriptFor_structured(uint32 lt, uint8 prefixSel, uint256 x, uint8 ltSel) public view {
        uint32[8] memory edges =
            [uint32(0), 499_999_999, 500_000_000, 500_000_001, 2_147_483_646, 2_147_483_647, 2_147_483_648, type(uint32).max];
        if (ltSel % 2 == 0) lt = edges[(ltSel / 2) % 8];
        bytes1 prefix = [bytes1(0x02), 0x03, 0x04, 0x00][prefixSel % 4];
        if (x % 4 == 0) x = P - 1 + (x % 3);
        _expectBuilt(lt, abi.encodePacked(prefix, bytes32(x)));
    }

    /// @dev Every script checkBond accepts is one witnessScriptFor builds: the helper covers the whole accepted set.
    function testFuzz_fix_everyAcceptedScriptIsBuildable(uint32 lt, uint8 prefixSel, uint256 x, uint8 mutate, uint8 pos, uint8 val)
        public
        view
    {
        bytes memory ws = _structured(lt, prefixSel, x, mutate, pos, val);
        (bool acc, uint32 got) = _accepted(ws);
        if (!acc) return;
        bytes memory key = new bytes(33);
        for (uint256 i; i < 33; ++i) {
            key[i] = ws[8 + i];
        }
        assertEq(fb.witnessScriptFor(got, key), ws);
    }

    /// @dev The boundary grid: locktime x prefix x key x, three views agreeing on every cell.
    function test_fix_boundaryGrid() public view {
        uint32[6] memory lts = [uint32(0), 499_999_999, 500_000_000, 2_147_483_647, 2_147_483_648, type(uint32).max];
        bytes1[4] memory prefixes = [bytes1(0x00), 0x02, 0x03, 0x04];
        uint256[5] memory xs = [uint256(0), 1, P - 1, P, type(uint256).max];
        uint256 built;
        for (uint256 i; i < lts.length; ++i) {
            for (uint256 j; j < prefixes.length; ++j) {
                for (uint256 k; k < xs.length; ++k) {
                    bytes memory key = abi.encodePacked(prefixes[j], bytes32(xs[k]));
                    _expectBuilt(lts[i], key);
                    _check(_ws(lts[i], key));
                    if (fb.witnessScriptFor(lts[i], key).length != 0) ++built;
                }
            }
        }
        // 2 locktimes x 2 prefixes x 3 x values (0, 1, p-1) are valid
        assertEq(built, 12);
    }
}
