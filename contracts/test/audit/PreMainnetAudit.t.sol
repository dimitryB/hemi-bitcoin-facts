// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Pre-mainnet audit, 2026-11-22 (docs/SECURITY-AUDIT.md, pre-mainnet audit). The contract findings L-1,
// L-2, I-1 and I-2, each asserting the fix.
import {Test} from "forge-std/Test.sol";
import {Hvm} from "../../src/Hvm.sol";
import {BitcoinFacts} from "../../src/BitcoinFacts.sol";
import {FidelityBonds} from "../../src/FidelityBonds.sol";
import {PopFinality} from "../../src/PopFinality.sol";
import {HvmMock} from "../utils/HvmMock.sol";
import {HvmHarness} from "../Hvm.t.sol";
import {BondFixtures} from "../FidelityBonds.t.sol";

contract PreMainnetAuditTest is BondFixtures {
    PopFinality internal p;
    FidelityBonds internal fb;
    BitcoinFacts internal facts;
    HvmHarness internal h;

    function setUp() public {
        HvmMock.install();
        p = new PopFinality();
        fb = new FidelityBonds();
        facts = new BitcoinFacts();
        h = new HvmHarness();
    }

    function _address(uint256 len) internal pure returns (string memory) {
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) b[i] = "q";
        return string(b);
    }

    // ---- L-1: coveringKeystone's every nonzero answer is a keystone ------------------------------------------------

    function test_L1_block0IsCoveredByKeystone25() public {
        assertEq(p.coveringKeystone(0), 25);
        vm.roll(100);
        // Block 0 through keystone 25: the views take it as covering (NotRecorded here, not NotKeystone/NotCovering).
        (PopFinality.Verdict v,) = p.anchorConfirmations(0, p.coveringKeystone(0));
        assertEq(uint8(v), uint8(PopFinality.Verdict.NotRecorded));
    }

    function test_L1_aboveTheLargestKeystoneIsZero() public view {
        uint256 top = p.MAX_KEYSTONE();
        assertEq(top, 4_294_967_275);
        assertEq(p.coveringKeystone(top), top);
        for (uint256 b = top + 1; b <= uint256(type(uint32).max) + 30; ++b) assertEq(p.coveringKeystone(b), 0);
    }

    // ---- L-2: tagScript is empty where checkBond would refuse the tag ----------------------------------------------

    function test_L2_tagScriptEmptyForTheZeroAgent() public view {
        assertEq(fb.tagScript(address(0)).length, 0);
        assertEq(fb.tagScript(AGENT).length, fb.TAG_LENGTH());
    }

    function test_L2_tagScriptEmptyAbove32BitChainIds() public {
        vm.chainId(uint256(type(uint32).max) + 1);
        assertEq(fb.tagScript(AGENT).length, 0);
        vm.chainId(type(uint32).max);
        bytes memory t = fb.tagScript(AGENT);
        assertEq(t.length, 50);
        assertEq(t, _tag(type(uint32).max, address(fb), AGENT));
    }

    // ---- I-1: Hvm refuses addresses longer than 200 bytes without calling the precompile ---------------------------

    function test_I1_hvmRefusesLongAddressesWithoutACall() public {
        string memory a200 = _address(200);
        string memory a201 = _address(201);
        // The mock would answer for both: only the length check can make the 201-byte one fail.
        HvmMock.setBalance(a200, 7);
        HvmMock.setBalance(a201, 7);
        HvmMock.setScript(a200, hex"0014aabbccddeeff00112233445566778899aabbccdd");
        HvmMock.setScript(a201, hex"0014aabbccddeeff00112233445566778899aabbccdd");
        HvmMock.setRaw(0x41, abi.encodePacked(a201, uint24(0), uint8(0)), hex"00");

        (bool ok, uint64 sats) = h.balance(a200);
        assertTrue(ok);
        assertEq(sats, 7);
        (ok, sats) = h.balance(a201);
        assertFalse(ok);
        assertEq(sats, 0);

        bytes memory script;
        (ok, script) = h.addressScript(a200);
        assertTrue(ok);
        (ok, script) = h.addressScript(a201);
        assertFalse(ok);
        assertEq(script.length, 0);

        Hvm.Utxo[] memory list;
        (ok, list) = h.utxos(a201, 0, 0);
        assertFalse(ok);
        assertEq(list.length, 0);
    }

    function test_I1_bitcoinFactsUsesTheLibraryLimit() public view {
        assertEq(facts.MAX_ADDRESS_BYTES(), Hvm.MAX_ADDRESS_BYTES);
        assertEq(facts.MAX_ADDRESS_BYTES(), 200);
    }

    // ---- I-2: a stored checkpoint is told by its Hemi block, not its prefix -----------------------------------------

    function test_I2_storedCheckpointWithAZeroPrefix() public {
        vm.roll(1_000);
        uint256 k = 975;
        vm.setBlockhash(k, keccak256("block 975")); // readable: before the fix this read as "not stored"
        // A stored checkpoint whose 12-byte prefix is zero (a 2^-96 chance on chain), recorded at Hemi block 980.
        vm.store(address(p), keccak256(abi.encode(k, uint256(0))), bytes32(uint256(980) << 96));
        (PopFinality.Verdict v, bytes12 prefix, bool stored) = p.checkCheckpoint(k);
        assertEq(uint8(v), uint8(PopFinality.Verdict.Ok));
        assertTrue(stored, "read as stored, not as absent");
        assertEq(prefix, bytes12(0));
        assertEq(p.checkpoint(k), bytes12(0), "checkpoint changes nothing");
        assertEq(p.checkpointOf(k).hemiBlock, 980);
    }

    function test_I2_unstoredCheckpointReadsTheBlockHash() public {
        vm.roll(1_000);
        bytes32 bh = keccak256("block 975");
        vm.setBlockhash(975, bh);
        (PopFinality.Verdict v, bytes12 prefix, bool stored) = p.checkCheckpoint(975);
        assertEq(uint8(v), uint8(PopFinality.Verdict.Ok));
        assertFalse(stored);
        assertEq(prefix, bytes12(bh));
    }
}
