// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {Hvm} from "../src/Hvm.sol";
import {BitcoinFacts} from "../src/BitcoinFacts.sol";
import {Deploy, Deployments} from "../script/Deploy.s.sol";
import {HvmMock} from "./utils/HvmMock.sol";

/// @dev Exposes BitcoinFacts' script rules for direct tests.
contract BitcoinFactsHarness is BitcoinFacts {
    function parses(bytes memory s) external pure returns (bool) {
        return _parses(s);
    }

    function isUnspendable(uint256 fullLength, bytes memory s) external pure returns (bool) {
        return _isUnspendable(fullLength, s);
    }
}

/// @dev Mainnet fixtures (docs/BRIEF.md; raw bytes from DECISIONS.md D-001 to D-004, D-007).
abstract contract Fixtures {
    uint32 internal constant TIP_HEIGHT = 976_833;
    bytes32 internal constant TIP_HASH = 0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a;

    bytes32 internal constant UNSPENT_TXID = 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4;
    bytes internal constant UNSPENT_SCRIPT = hex"001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831";
    bytes internal constant UNSPENT_CHANGE_SCRIPT = hex"0014208fa508568396937efe008cbae70b4fe8a1ae45";
    uint32 internal constant UNSPENT_CONFS = 1596;

    bytes32 internal constant SPENT_TXID = 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e;
    bytes internal constant SPENT_SCRIPT = hex"0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4";
    uint32 internal constant SPENT_CONFS = 1647;
    /// 0x42 with flags 003c0703 on the spent fixture, as mainnet answered it (D-004).
    bytes internal constant SPENT_TX_OUTPUTS =
        hex"0002000000001b8430890022512068d343ef205a6afa4ae74508ab4aefb92dd46549e30d5eecf63acf3155c0798e000000000004f33e1000220020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c400";

    bytes32 internal constant POP_TXID = 0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e;
    /// 0x42 with flags 003c0703 on the first PoP transaction (D-003): a spent P2PKH and the 83-byte OP_RETURN.
    bytes internal constant POP_TX_OUTPUTS = hex"0002" hex"0000000000004510" hex"0019"
        hex"76a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac" hex"00" hex"0000000000000000" hex"0053"
        hex"6a4c5048454d4901019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff89"
        hex"41746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef4" hex"00";

    string internal constant P2PKH_ADDR = "18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm";
    bytes internal constant P2PKH_SCRIPT = hex"76a9144f364626b44b11929dd604d3cc592c4b8d887d1c88ac";
    uint64 internal constant P2PKH_SATS = 108_217;
    string internal constant P2WPKH_ADDR = "bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkv";
    string internal constant P2WPKH_ADDR_UPPER = "BC1Q64MN3PVWZRVTTVAWSQZ8EWMH2RSZ3DHJP4CNKV";
    bytes internal constant P2WPKH_SCRIPT = hex"0014d57738858e10d8b5b3ae80047cbb7750e028b6f2";
    uint64 internal constant P2WPKH_SATS = 691_317;

    function _tip() internal pure returns (Hvm.Header memory h) {
        h = HvmMock.header(TIP_HEIGHT);
        h.hash = TIP_HASH;
    }

    function _mainnetFixtures() internal {
        HvmMock.setTip(_tip());
        HvmMock.setOutput(UNSPENT_TXID, 0, 1000, UNSPENT_SCRIPT, false);
        HvmMock.setOutput(UNSPENT_TXID, 1, 859, UNSPENT_CHANGE_SCRIPT, false);
        HvmMock.setConfirmations(UNSPENT_TXID, UNSPENT_CONFS);
        HvmMock.setRaw(0x42, abi.encodePacked(SPENT_TXID, Hvm.TX_FLAGS_OUTPUTS), SPENT_TX_OUTPUTS);
        HvmMock.setConfirmations(SPENT_TXID, SPENT_CONFS);
        HvmMock.setRaw(0x42, abi.encodePacked(POP_TXID, Hvm.TX_FLAGS_OUTPUTS), POP_TX_OUTPUTS);
        HvmMock.setConfirmations(POP_TXID, 3088);
        HvmMock.setScript(P2PKH_ADDR, P2PKH_SCRIPT);
        HvmMock.setBalance(P2PKH_ADDR, P2PKH_SATS);
        HvmMock.setScript(P2WPKH_ADDR, P2WPKH_SCRIPT);
        HvmMock.setScript(P2WPKH_ADDR_UPPER, P2WPKH_SCRIPT);
        HvmMock.setBalance(P2WPKH_ADDR, P2WPKH_SATS);
        HvmMock.setBalance(P2WPKH_ADDR_UPPER, P2WPKH_SATS);
    }
}

contract BitcoinFactsTest is Test, Fixtures {
    BitcoinFacts internal f;
    BitcoinFactsHarness internal harness;

    event OutputRecorded(
        bytes32 indexed id,
        bytes32 indexed txid,
        bytes32 indexed btcBlockHash,
        uint16 vout,
        uint64 sats,
        bytes32 scriptHash,
        uint16 scriptLength,
        bool spent,
        uint32 confirmations,
        uint32 btcHeight,
        uint64 hemiBlock,
        bytes script
    );

    event BalanceRecorded(
        bytes32 indexed id,
        bytes32 indexed scriptHash,
        bytes32 indexed btcBlockHash,
        uint64 sats,
        uint16 scriptLength,
        uint32 btcHeight,
        uint64 hemiBlock,
        bytes script
    );

    function setUp() public {
        HvmMock.install();
        f = new BitcoinFacts();
        harness = new BitcoinFactsHarness();
        vm.roll(5_780_432);
    }

    function _v(BitcoinFacts.Verdict v) internal pure returns (uint8) {
        return uint8(v);
    }

    function _outVerdict(bytes32 txid, uint16 vout) internal view returns (uint8) {
        return _v(f.checkOutput(txid, vout).verdict);
    }

    function _balVerdict(string memory a) internal view returns (uint8) {
        return _v(f.checkBalance(a).verdict);
    }

    uint8 internal constant OK = uint8(BitcoinFacts.Verdict.Ok);
    uint8 internal constant NO_VIEW = uint8(BitcoinFacts.Verdict.NoBitcoinView);
    uint8 internal constant NOT_FOUND = uint8(BitcoinFacts.Verdict.NotFound);
    uint8 internal constant VOUT_TOO_HIGH = uint8(BitcoinFacts.Verdict.VoutTooHigh);
    uint8 internal constant UNSPENDABLE = uint8(BitcoinFacts.Verdict.Unspendable);
    uint8 internal constant TOO_LONG = uint8(BitcoinFacts.Verdict.ScriptTooLong);
    uint8 internal constant INCONSISTENT = uint8(BitcoinFacts.Verdict.Inconsistent);
    uint8 internal constant NO_CONFS = uint8(BitcoinFacts.Verdict.NoConfirmations);
    uint8 internal constant BAD_ADDRESS = uint8(BitcoinFacts.Verdict.BadAddress);
    uint8 internal constant NO_BALANCE = uint8(BitcoinFacts.Verdict.NoBalance);

    // =============================================================================================
    // checkOutput: Ok
    // =============================================================================================

    function test_checkOutput_unspentFixture() public {
        _mainnetFixtures();
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 0);
        assertEq(_v(c.verdict), OK);
        assertEq(c.sats, 1000);
        assertEq(c.scriptHash, keccak256(UNSPENT_SCRIPT));
        assertEq(c.scriptLength, 22);
        assertEq(c.script, UNSPENT_SCRIPT);
        assertFalse(c.spent);
        assertEq(c.confirmations, UNSPENT_CONFS);
        assertEq(c.btcHeight, TIP_HEIGHT);
        assertEq(c.btcBlockHash, TIP_HASH);
        assertEq(c.id, f.outputId(UNSPENT_TXID, 0, TIP_HASH));
        assertFalse(c.recorded);
    }

    /// @dev The exact 0x42 bytes mainnet returned for the spent fixture; 0x48 gives no answer for it.
    function test_checkOutput_spentFixture_mainnetBytes() public {
        _mainnetFixtures();
        BitcoinFacts.OutputCheck memory c = f.checkOutput(SPENT_TXID, 1);
        assertEq(_v(c.verdict), OK);
        assertTrue(c.spent);
        assertEq(c.sats, 83_050_000);
        assertEq(c.scriptHash, keccak256(SPENT_SCRIPT));
        assertEq(c.scriptLength, 34);
        assertEq(c.script, SPENT_SCRIPT);
        assertEq(c.confirmations, SPENT_CONFS);
        // vout 0 of the same transaction: 461,648,009 sats to a P2TR, also spent
        c = f.checkOutput(SPENT_TXID, 0);
        assertEq(_v(c.verdict), OK);
        assertTrue(c.spent);
        assertEq(c.sats, 461_648_009);
        assertEq(c.scriptLength, 34);
    }

    function test_checkOutput_spentTypedMock() public {
        HvmMock.setTip(_tip());
        HvmMock.setOutput(UNSPENT_TXID, 1, 859, UNSPENT_CHANGE_SCRIPT, true);
        HvmMock.setConfirmations(UNSPENT_TXID, 7);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 1);
        assertEq(_v(c.verdict), OK);
        assertTrue(c.spent);
        assertEq(c.sats, 859);
        assertEq(c.confirmations, 7);
    }

    function test_checkOutput_spentP2pkhOfPopTx() public {
        _mainnetFixtures();
        BitcoinFacts.OutputCheck memory c = f.checkOutput(POP_TXID, 0);
        assertEq(_v(c.verdict), OK);
        assertTrue(c.spent);
        assertEq(c.sats, 17_680);
        assertEq(c.scriptLength, 25);
    }

    function test_checkOutput_highVoutAndLongScriptUnspent() public {
        HvmMock.setTip(_tip());
        bytes memory s = _pushes(9_000); // a parseable 9,000-byte script
        HvmMock.setOutput(UNSPENT_TXID, 900, 5, s, false);
        HvmMock.setConfirmations(UNSPENT_TXID, 3);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 900);
        assertEq(_v(c.verdict), OK);
        assertEq(c.scriptLength, 9_000);
        assertEq(c.scriptHash, keccak256(s));
        assertFalse(c.spent);
    }

    function test_checkOutput_emptyScriptIsSpendable() public {
        HvmMock.setTip(_tip());
        HvmMock.setOutput(UNSPENT_TXID, 0, 5, "", true);
        HvmMock.setConfirmations(UNSPENT_TXID, 3);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 0);
        assertEq(_v(c.verdict), OK);
        assertTrue(c.spent);
        assertEq(c.scriptLength, 0);
        assertEq(c.scriptHash, keccak256(""));
    }

    function test_checkOutput_recordedFlag() public {
        _mainnetFixtures();
        f.recordOutput(UNSPENT_TXID, 0);
        assertTrue(f.checkOutput(UNSPENT_TXID, 0).recorded);
        assertFalse(f.checkOutput(UNSPENT_TXID, 1).recorded);
    }

    // =============================================================================================
    // checkOutput: every other verdict
    // =============================================================================================

    function test_checkOutput_noBitcoinView() public {
        // nothing at 0x44
        assertEq(_outVerdict(UNSPENT_TXID, 0), NO_VIEW);
        // short
        HvmMock.setAny(0x44, new bytes(115));
        assertEq(_outVerdict(UNSPENT_TXID, 0), NO_VIEW);
        // long
        HvmMock.setAny(0x44, new bytes(117));
        assertEq(_outVerdict(UNSPENT_TXID, 0), NO_VIEW);
        // zero hash
        bytes memory raw = HvmMock.encodeHeader(_tip());
        for (uint256 i = 4; i < 36; ++i) raw[i] = 0;
        HvmMock.setAny(0x44, raw);
        assertEq(_outVerdict(UNSPENT_TXID, 0), NO_VIEW);
        // failing call
        HvmMock.clearAny(0x44);
        HvmMock.setTip(_tip());
        HvmMock.setFail(0x44, true);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 0);
        assertEq(_v(c.verdict), NO_VIEW);
        assertEq(c.id, bytes32(0));
        assertEq(c.btcBlockHash, bytes32(0));
    }

    function test_checkOutput_notFound() public {
        _mainnetFixtures();
        // unknown txid: neither 0x48 nor 0x42 answer, and 0x43 is never called
        uint256 g = gasleft();
        BitcoinFacts.OutputCheck memory c = f.checkOutput(bytes32(uint256(0x1111)), 0);
        uint256 used = g - gasleft();
        assertEq(_v(c.verdict), NOT_FOUND);
        assertEq(c.id, f.outputId(bytes32(uint256(0x1111)), 0, TIP_HASH));
        HvmMock.setFail(0x43, true);
        assertEq(_outVerdict(bytes32(uint256(0x1111)), 0), NOT_FOUND);
        assertLt(used, 120_000);
        // vout past the output count
        assertEq(_outVerdict(UNSPENT_TXID, 2), NOT_FOUND);
        assertEq(_outVerdict(SPENT_TXID, 2), NOT_FOUND);
        assertEq(_outVerdict(SPENT_TXID, type(uint16).max), NOT_FOUND);
    }

    function test_checkOutput_notFound_malformed0x42() public {
        HvmMock.setTip(_tip());
        HvmMock.setConfirmations(SPENT_TXID, 9);
        // truncated mainnet answer
        bytes memory cut = new bytes(SPENT_TX_OUTPUTS.length - 1);
        for (uint256 i; i < cut.length; ++i) cut[i] = SPENT_TX_OUTPUTS[i];
        HvmMock.setRaw(0x42, abi.encodePacked(SPENT_TXID, Hvm.TX_FLAGS_OUTPUTS), cut);
        assertEq(_outVerdict(SPENT_TXID, 1), NOT_FOUND);
        // UTXO byte 2
        HvmMock.setAny(0x42, abi.encodePacked(uint16(1), uint64(5), uint16(1), hex"51", uint8(2)));
        assertEq(_outVerdict(SPENT_TXID, 0), NOT_FOUND);
        // trailing junk
        HvmMock.setAny(0x42, abi.encodePacked(uint16(1), uint64(5), uint16(1), hex"51", uint8(0), hex"00"));
        assertEq(_outVerdict(SPENT_TXID, 0), NOT_FOUND);
        // one byte
        HvmMock.setAny(0x42, hex"00");
        assertEq(_outVerdict(SPENT_TXID, 0), NOT_FOUND);
        // failing 0x42
        HvmMock.clearAny(0x42);
        HvmMock.setFail(0x42, true);
        assertEq(_outVerdict(SPENT_TXID, 1), NOT_FOUND);
    }

    /// @dev A malformed 0x48 answer is not an answer; the output is then judged by 0x42 alone.
    function test_checkOutput_malformed0x48() public {
        HvmMock.setTip(_tip());
        HvmMock.setConfirmations(UNSPENT_TXID, 9);
        // flag byte 2: 0x48 malformed, and 0x42 (same flag) malformed too
        HvmMock.setOutputFlag(UNSPENT_TXID, 0, 1000, UNSPENT_SCRIPT, 2);
        assertEq(_outVerdict(UNSPENT_TXID, 0), NOT_FOUND);
        // a length field that does not match; 0x42 still says in the UTXO set
        HvmMock.setOutput(UNSPENT_TXID, 0, 1000, UNSPENT_SCRIPT, false);
        HvmMock.setAny(0x48, abi.encodePacked(uint64(1000), uint16(22), new bytes(21), uint8(1)));
        assertEq(_outVerdict(UNSPENT_TXID, 0), INCONSISTENT);
        // flag 0x00 is never written by 0x48 on mainnet; read as no answer
        HvmMock.setAny(0x48, abi.encodePacked(uint64(1000), uint16(22), UNSPENT_SCRIPT, uint8(0)));
        assertEq(_outVerdict(UNSPENT_TXID, 0), INCONSISTENT);
        // ten bytes
        HvmMock.setAny(0x48, new bytes(10));
        assertEq(_outVerdict(UNSPENT_TXID, 0), INCONSISTENT);
    }

    function test_checkOutput_voutTooHigh() public {
        HvmMock.setTip(_tip());
        HvmMock.setConfirmations(UNSPENT_TXID, 9);
        // 201 outputs; 0x42 lists the first 128, of which vout 127 is a spent P2WPKH. (Built raw: MockHvm's typed
        // 0x42 reads one slot per output and would run past Hvm's gas cap for this many.)
        HvmMock.setRaw(
            0x42,
            abi.encodePacked(UNSPENT_TXID, Hvm.TX_FLAGS_OUTPUTS),
            _rawOutputs(201, 127, 7, UNSPENT_SCRIPT, false)
        );
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 200);
        assertEq(_v(c.verdict), VOUT_TOO_HIGH);
        assertEq(c.sats, 0);
        assertEq(_outVerdict(UNSPENT_TXID, 128), VOUT_TOO_HIGH);
        // vout 127 is the last one 0x42 lists
        assertEq(_outVerdict(UNSPENT_TXID, 127), OK);
        // past the true count is NotFound, not VoutTooHigh
        assertEq(_outVerdict(UNSPENT_TXID, 201), NOT_FOUND);
        // an unspent output past 127 still reads through 0x48
        HvmMock.at(0x48).setOutput(UNSPENT_TXID, 150, 9, UNSPENT_SCRIPT, 1);
        assertEq(_outVerdict(UNSPENT_TXID, 150), OK);
    }

    function test_checkOutput_unspendable_popOpReturn() public {
        _mainnetFixtures();
        BitcoinFacts.OutputCheck memory c = f.checkOutput(POP_TXID, 1);
        assertEq(_v(c.verdict), UNSPENDABLE);
        assertEq(c.scriptLength, 83);
        assertFalse(c.spent);
        assertEq(c.scriptHash, bytes32(0));
    }

    function test_checkOutput_unspendable_cases() public {
        HvmMock.setTip(_tip());
        HvmMock.setConfirmations(UNSPENT_TXID, 9);
        // OP_RETURN through the typed mock (0x48 empty, 0x42 byte 0x00)
        HvmMock.setOutput(UNSPENT_TXID, 0, 0, hex"6a0548454d4931", true);
        assertEq(_outVerdict(UNSPENT_TXID, 0), UNSPENDABLE);
        // bare OP_RETURN
        HvmMock.setOutput(UNSPENT_TXID, 1, 0, hex"6a", true);
        assertEq(_outVerdict(UNSPENT_TXID, 1), UNSPENDABLE);
        // a push that runs past the end (does not parse)
        HvmMock.setOutput(UNSPENT_TXID, 2, 10, hex"05aabb", true);
        assertEq(_outVerdict(UNSPENT_TXID, 2), UNSPENDABLE);
        HvmMock.setOutput(UNSPENT_TXID, 3, 10, hex"4c", true);
        assertEq(_outVerdict(UNSPENT_TXID, 3), UNSPENDABLE);
        // OP_RETURN with a long payload: Unspendable, not ScriptTooLong
        bytes memory longReturn = new bytes(300);
        longReturn[0] = 0x6a;
        HvmMock.setOutput(UNSPENT_TXID, 4, 0, longReturn, true);
        assertEq(_outVerdict(UNSPENT_TXID, 4), UNSPENDABLE);
        // even if 0x48 answered for an OP_RETURN, it is not "unspent"
        HvmMock.setOutput(UNSPENT_TXID, 5, 0, hex"6a00", false);
        assertEq(_outVerdict(UNSPENT_TXID, 5), UNSPENDABLE);
        // an unparseable script that 0x48 answered for: hVM's UTXO set never holds one (its indexer drops what
        // IsUnspendable rejects), so the parse is not repeated on the unspent path (security review finding 4)
        HvmMock.setOutput(UNSPENT_TXID, 6, 1, hex"4d0100", false);
        assertEq(_outVerdict(UNSPENT_TXID, 6), OK);
        // the same script on the spent path is still parsed and refused (its own tx: the typed 0x42 mock lists only
        // a few outputs within Hvm's gas cap)
        bytes32 other = bytes32(uint256(0x7e57));
        HvmMock.setConfirmations(other, 9);
        HvmMock.setOutput(other, 0, 1, hex"4d0100", true);
        assertEq(_outVerdict(other, 0), UNSPENDABLE);
    }

    function test_checkOutput_unspendable_over10000Bytes() public {
        HvmMock.setTip(_tip());
        HvmMock.setConfirmations(UNSPENT_TXID, 9);
        bytes memory s = new bytes(10_001);
        // 0x48 path: length field 10,001, 10,000 bytes returned
        HvmMock.setOutput(UNSPENT_TXID, 0, 1, s, false);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 0);
        assertEq(_v(c.verdict), UNSPENDABLE);
        assertEq(c.scriptLength, 10_001);
        // 0x42 path: length field 10,001, 128 bytes listed
        HvmMock.setOutput(UNSPENT_TXID, 1, 1, s, true);
        assertEq(_outVerdict(UNSPENT_TXID, 1), UNSPENDABLE);
        // exactly 10,000 parseable bytes is spendable
        bytes memory edge = _pushes(10_000);
        HvmMock.setOutput(UNSPENT_TXID, 2, 1, edge, false);
        assertEq(_outVerdict(UNSPENT_TXID, 2), OK);
    }

    function test_checkOutput_scriptTooLong() public {
        HvmMock.setTip(_tip());
        HvmMock.setConfirmations(UNSPENT_TXID, 9);
        bytes memory s = _pushes(129);
        HvmMock.setOutput(UNSPENT_TXID, 0, 7, s, true);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 0);
        assertEq(_v(c.verdict), TOO_LONG);
        assertEq(c.sats, 7);
        assertEq(c.scriptLength, 129);
        assertEq(c.scriptHash, bytes32(0));
        // exactly 128 is complete
        HvmMock.setOutput(UNSPENT_TXID, 1, 7, _pushes(128), true);
        assertEq(_outVerdict(UNSPENT_TXID, 1), OK);
        // the same 129 bytes unspent read fine through 0x48
        HvmMock.setOutput(UNSPENT_TXID, 2, 7, s, false);
        assertEq(_outVerdict(UNSPENT_TXID, 2), OK);
    }

    function test_checkOutput_inconsistent() public {
        HvmMock.setTip(_tip());
        HvmMock.setConfirmations(UNSPENT_TXID, 9);
        HvmMock.setOutput(UNSPENT_TXID, 0, 1000, UNSPENT_SCRIPT, false); // 0x42: UTXO byte 0x01
        HvmMock.setFail(0x48, true); // 0x48: no answer
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 0);
        assertEq(_v(c.verdict), INCONSISTENT);
        assertFalse(c.spent);
    }

    function test_checkOutput_noConfirmations() public {
        HvmMock.setTip(_tip());
        HvmMock.setOutput(UNSPENT_TXID, 0, 1000, UNSPENT_SCRIPT, false);
        // 0x43 fails (unknown txid): burns its cap and no more
        uint256 g = gasleft();
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, 0);
        uint256 used = g - gasleft();
        assertEq(_v(c.verdict), NO_CONFS);
        assertEq(c.sats, 1000);
        assertEq(c.confirmations, 0);
        assertLt(used, 150_000);
        // wrong length
        HvmMock.setAny(0x43, hex"000009");
        assertEq(_outVerdict(UNSPENT_TXID, 0), NO_CONFS);
        HvmMock.setAny(0x43, hex"0000000009");
        assertEq(_outVerdict(UNSPENT_TXID, 0), NO_CONFS);
        HvmMock.clearAny(0x43);
        // zero
        HvmMock.setConfirmations(UNSPENT_TXID, 0);
        assertEq(_outVerdict(UNSPENT_TXID, 0), NO_CONFS);
        // an underflowed count (D-011)
        HvmMock.setConfirmations(UNSPENT_TXID, type(uint32).max - 1);
        assertEq(_outVerdict(UNSPENT_TXID, 0), NO_CONFS);
        // the bound: height + 1,000 is accepted, one more is not
        HvmMock.setConfirmations(UNSPENT_TXID, TIP_HEIGHT + 1000);
        assertEq(_outVerdict(UNSPENT_TXID, 0), OK);
        HvmMock.setConfirmations(UNSPENT_TXID, TIP_HEIGHT + 1001);
        assertEq(_outVerdict(UNSPENT_TXID, 0), NO_CONFS);
        // spent path too
        HvmMock.setRaw(0x42, abi.encodePacked(SPENT_TXID, Hvm.TX_FLAGS_OUTPUTS), SPENT_TX_OUTPUTS);
        assertEq(_outVerdict(SPENT_TXID, 1), NO_CONFS);
    }

    /// @dev A 0xFFFFFFFF height must not overflow the plausibility bound into a revert.
    function test_checkOutput_maxHeightDoesNotRevert() public {
        Hvm.Header memory h = _tip();
        h.height = type(uint32).max;
        HvmMock.setTip(h);
        HvmMock.setOutput(UNSPENT_TXID, 0, 1000, UNSPENT_SCRIPT, false);
        HvmMock.setConfirmations(UNSPENT_TXID, type(uint32).max);
        assertEq(_outVerdict(UNSPENT_TXID, 0), OK);
    }

    // =============================================================================================
    // checkBalance
    // =============================================================================================

    function test_checkBalance_ok() public {
        _mainnetFixtures();
        BitcoinFacts.BalanceCheck memory c = f.checkBalance(P2PKH_ADDR);
        assertEq(_v(c.verdict), OK);
        assertEq(c.sats, P2PKH_SATS);
        assertEq(c.scriptHash, keccak256(P2PKH_SCRIPT));
        assertEq(c.scriptLength, 25);
        assertEq(c.script, P2PKH_SCRIPT);
        assertEq(c.btcHeight, TIP_HEIGHT);
        assertEq(c.btcBlockHash, TIP_HASH);
        assertEq(c.id, f.balanceId(keccak256(P2PKH_SCRIPT), TIP_HASH));
        assertFalse(c.recorded);
    }

    function test_checkBalance_twoSpellingsOneSubject() public {
        _mainnetFixtures();
        BitcoinFacts.BalanceCheck memory a = f.checkBalance(P2WPKH_ADDR);
        BitcoinFacts.BalanceCheck memory b = f.checkBalance(P2WPKH_ADDR_UPPER);
        assertEq(_v(a.verdict), OK);
        assertEq(_v(b.verdict), OK);
        assertEq(a.scriptHash, b.scriptHash);
        assertEq(a.id, b.id);
        assertEq(a.sats, P2WPKH_SATS);
    }

    function test_checkBalance_zeroIsOk() public {
        HvmMock.setTip(_tip());
        HvmMock.setScript(P2PKH_ADDR, P2PKH_SCRIPT);
        HvmMock.setBalance(P2PKH_ADDR, 0);
        BitcoinFacts.BalanceCheck memory c = f.checkBalance(P2PKH_ADDR);
        assertEq(_v(c.verdict), OK);
        assertEq(c.sats, 0);
    }

    function test_checkBalance_noBitcoinView() public {
        HvmMock.setScript(P2PKH_ADDR, P2PKH_SCRIPT);
        HvmMock.setBalance(P2PKH_ADDR, 1);
        assertEq(_balVerdict(P2PKH_ADDR), NO_VIEW);
        HvmMock.setAny(0x44, new bytes(100));
        assertEq(_balVerdict(P2PKH_ADDR), NO_VIEW);
    }

    function test_checkBalance_badAddress() public {
        HvmMock.setTip(_tip());
        // undecodable: 0x46 fails and burns its cap (2 x 25,000), no more
        uint256 g = gasleft();
        BitcoinFacts.BalanceCheck memory c = f.checkBalance("bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkq");
        uint256 used = g - gasleft();
        assertEq(_v(c.verdict), BAD_ADDRESS);
        assertEq(c.id, bytes32(0));
        assertGt(used, 50_000);
        assertLt(used, 80_000);
        // too short or too long: 0x46 is never called (a call would burn its 50,000-gas cap)
        HvmMock.setFail(0x46, true);
        HvmMock.setFail(0x40, true);
        string memory long = string(new bytes(201));
        g = gasleft();
        assertEq(_balVerdict("11111111111111111111111"), BAD_ADDRESS); // 23 bytes
        assertLt(g - gasleft(), 40_000);
        g = gasleft();
        assertEq(_balVerdict(long), BAD_ADDRESS);
        assertLt(g - gasleft(), 40_000);
        assertEq(_balVerdict(""), BAD_ADDRESS);
        // 0x46 answers empty
        HvmMock.setFail(0x46, false);
        HvmMock.setAny(0x46, "");
        assertEq(_balVerdict(P2PKH_ADDR), BAD_ADDRESS);
    }

    function test_checkBalance_lengthBounds() public {
        HvmMock.setTip(_tip());
        string memory a24 = "111111111111111111111111";
        string memory a200 = string(_repeat("1", 200));
        HvmMock.setScript(a24, hex"51");
        HvmMock.setBalance(a24, 1);
        HvmMock.setScript(a200, hex"52");
        HvmMock.setBalance(a200, 2);
        assertEq(_balVerdict(a24), OK);
        assertEq(_balVerdict(a200), OK);
    }

    function test_checkBalance_noBalance() public {
        HvmMock.setTip(_tip());
        HvmMock.setScript(P2PKH_ADDR, P2PKH_SCRIPT);
        BitcoinFacts.BalanceCheck memory c = f.checkBalance(P2PKH_ADDR);
        assertEq(_v(c.verdict), NO_BALANCE);
        assertEq(c.scriptHash, keccak256(P2PKH_SCRIPT)); // filled as far as the check got
        // wrong length
        HvmMock.setAny(0x40, hex"00000000000001");
        assertEq(_balVerdict(P2PKH_ADDR), NO_BALANCE);
        HvmMock.setAny(0x40, hex"000000000000000100");
        assertEq(_balVerdict(P2PKH_ADDR), NO_BALANCE);
        // failing
        HvmMock.clearAny(0x40);
        HvmMock.setFail(0x40, true);
        assertEq(_balVerdict(P2PKH_ADDR), NO_BALANCE);
    }

    // =============================================================================================
    // recordOutput
    // =============================================================================================

    function test_recordOutput_storesAndEmitsEveryField() public {
        _mainnetFixtures();
        bytes32 id = f.outputId(UNSPENT_TXID, 0, TIP_HASH);
        vm.expectEmit(true, true, true, true, address(f));
        emit OutputRecorded(
            id,
            UNSPENT_TXID,
            TIP_HASH,
            0,
            1000,
            keccak256(UNSPENT_SCRIPT),
            22,
            false,
            UNSPENT_CONFS,
            TIP_HEIGHT,
            uint64(block.number),
            UNSPENT_SCRIPT
        );
        assertEq(f.recordOutput(UNSPENT_TXID, 0), id);

        BitcoinFacts.OutputFact memory s = f.outputFact(id);
        assertEq(s.txid, UNSPENT_TXID);
        assertEq(s.vout, 0);
        assertEq(s.sats, 1000);
        assertEq(s.scriptHash, keccak256(UNSPENT_SCRIPT));
        assertEq(s.scriptLength, 22);
        assertFalse(s.spent);
        assertEq(s.confirmations, UNSPENT_CONFS);
        assertEq(s.btcHeight, TIP_HEIGHT);
        assertEq(s.btcBlockHash, TIP_HASH);
        assertEq(s.hemiBlock, block.number);
        assertEq(uint8(f.kindOf(id)), uint8(BitcoinFacts.Kind.Output));
        // the stored fields recompute the id
        assertEq(f.outputId(s.txid, s.vout, s.btcBlockHash), id);
    }

    function test_recordOutput_spent() public {
        _mainnetFixtures();
        bytes32 id = f.outputId(SPENT_TXID, 1, TIP_HASH);
        vm.expectEmit(true, true, true, true, address(f));
        emit OutputRecorded(
            id,
            SPENT_TXID,
            TIP_HASH,
            1,
            83_050_000,
            keccak256(SPENT_SCRIPT),
            34,
            true,
            SPENT_CONFS,
            TIP_HEIGHT,
            uint64(block.number),
            SPENT_SCRIPT
        );
        f.recordOutput(SPENT_TXID, 1);
        BitcoinFacts.OutputFact memory s = f.outputFact(id);
        assertTrue(s.spent);
        assertEq(s.sats, 83_050_000);
    }

    function test_recordOutput_usesFourSlots() public {
        _mainnetFixtures();
        vm.record();
        f.recordOutput(UNSPENT_TXID, 0);
        (, bytes32[] memory writes) = vm.accesses(address(f));
        assertEq(_distinct(writes), 4);
    }

    function test_recordOutput_idempotent() public {
        _mainnetFixtures();
        bytes32 id = f.recordOutput(UNSPENT_TXID, 0);
        BitcoinFacts.OutputFact memory before = f.outputFact(id);

        // later Hemi block, more confirmations, same Bitcoin tip: nothing changes
        vm.roll(vm.getBlockNumber() + 50);
        HvmMock.setConfirmations(UNSPENT_TXID, UNSPENT_CONFS + 2);
        vm.recordLogs();
        vm.record();
        assertEq(f.recordOutput(UNSPENT_TXID, 0), id);
        (, bytes32[] memory writes) = vm.accesses(address(f));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(writes.length, 0);
        assertEq(logs.length, 0);

        BitcoinFacts.OutputFact memory again = f.outputFact(id);
        assertEq(again.hemiBlock, before.hemiBlock);
        assertEq(again.confirmations, UNSPENT_CONFS);
    }

    function test_recordOutput_newTipNewId() public {
        _mainnetFixtures();
        bytes32 a = f.recordOutput(UNSPENT_TXID, 0);
        HvmMock.setTip(TIP_HEIGHT + 1);
        bytes32 b = f.recordOutput(UNSPENT_TXID, 0);
        assertTrue(a != b);
        assertEq(f.outputFact(a).btcHeight, TIP_HEIGHT);
        assertEq(f.outputFact(b).btcHeight, TIP_HEIGHT + 1);
        assertEq(f.outputFact(b).btcBlockHash, HvmMock.header(TIP_HEIGHT + 1).hash);
    }

    function test_recordOutput_revertsWithVerdict() public {
        vm.expectRevert(abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, BitcoinFacts.Verdict.NoBitcoinView));
        f.recordOutput(UNSPENT_TXID, 0);

        _mainnetFixtures();
        vm.expectRevert(abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, BitcoinFacts.Verdict.NotFound));
        f.recordOutput(bytes32(uint256(1)), 0);
        vm.expectRevert(abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, BitcoinFacts.Verdict.Unspendable));
        f.recordOutput(POP_TXID, 1);

        HvmMock.setOutput(bytes32(uint256(2)), 0, 1, UNSPENT_SCRIPT, false);
        vm.expectRevert(
            abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, BitcoinFacts.Verdict.NoConfirmations)
        );
        f.recordOutput(bytes32(uint256(2)), 0);
    }

    // =============================================================================================
    // recordBalance
    // =============================================================================================

    function test_recordBalance_storesAndEmitsEveryField() public {
        _mainnetFixtures();
        bytes32 id = f.balanceId(keccak256(P2PKH_SCRIPT), TIP_HASH);
        vm.expectEmit(true, true, true, true, address(f));
        emit BalanceRecorded(
            id, keccak256(P2PKH_SCRIPT), TIP_HASH, P2PKH_SATS, 25, TIP_HEIGHT, uint64(block.number), P2PKH_SCRIPT
        );
        assertEq(f.recordBalance(P2PKH_ADDR), id);
        BitcoinFacts.BalanceFact memory s = f.balanceFact(id);
        assertEq(s.scriptHash, keccak256(P2PKH_SCRIPT));
        assertEq(s.sats, P2PKH_SATS);
        assertEq(s.scriptLength, 25);
        assertEq(s.btcHeight, TIP_HEIGHT);
        assertEq(s.btcBlockHash, TIP_HASH);
        assertEq(s.hemiBlock, block.number);
        assertEq(uint8(f.kindOf(id)), uint8(BitcoinFacts.Kind.Balance));
        assertEq(f.balanceId(s.scriptHash, s.btcBlockHash), id);
    }

    function test_recordBalance_usesThreeSlots() public {
        _mainnetFixtures();
        vm.record();
        f.recordBalance(P2PKH_ADDR);
        (, bytes32[] memory writes) = vm.accesses(address(f));
        assertEq(_distinct(writes), 3);
    }

    function test_recordBalance_idempotentAcrossSpellings() public {
        _mainnetFixtures();
        bytes32 id = f.recordBalance(P2WPKH_ADDR);
        uint256 recordedAt = vm.getBlockNumber();
        vm.roll(recordedAt + 1);
        vm.recordLogs();
        vm.record();
        assertEq(f.recordBalance(P2WPKH_ADDR_UPPER), id);
        assertEq(f.recordBalance(P2WPKH_ADDR), id);
        (, bytes32[] memory writes) = vm.accesses(address(f));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(f.balanceFact(id).hemiBlock, recordedAt);
    }

    function test_recordBalance_revertsWithVerdict() public {
        _mainnetFixtures();
        vm.expectRevert(abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, BitcoinFacts.Verdict.BadAddress));
        f.recordBalance("bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkq");
        HvmMock.setScript("bc1qnobalance0000000000000000000000000000", hex"0014");
        vm.expectRevert(abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, BitcoinFacts.Verdict.NoBalance));
        f.recordBalance("bc1qnobalance0000000000000000000000000000");
    }

    function test_kinds_doNotCollide() public {
        _mainnetFixtures();
        bytes32 o = f.recordOutput(UNSPENT_TXID, 0);
        bytes32 b = f.recordBalance(P2PKH_ADDR);
        assertEq(f.balanceFact(o).btcBlockHash, bytes32(0));
        assertEq(f.outputFact(b).btcBlockHash, bytes32(0));
        assertEq(uint8(f.kindOf(bytes32(uint256(123)))), uint8(BitcoinFacts.Kind.None));
        assertEq(f.outputFact(bytes32(uint256(123))).hemiBlock, 0);
    }

    // =============================================================================================
    // Ids: the encoding the SDK reproduces (sdk/test/facts.test.ts holds the same vectors)
    // =============================================================================================

    function test_ids_encoding() public view {
        assertEq(f.KIND_OUTPUT(), keccak256("hemi-bitcoin-facts/output"));
        assertEq(f.KIND_BALANCE(), keccak256("hemi-bitcoin-facts/balance"));
        bytes32 subject = keccak256(abi.encodePacked(UNSPENT_TXID, uint16(0)));
        assertEq(f.outputSubject(UNSPENT_TXID, 0), subject);
        assertEq(f.outputId(UNSPENT_TXID, 0, TIP_HASH), keccak256(abi.encode(f.KIND_OUTPUT(), subject, TIP_HASH)));
        assertEq(
            f.balanceId(keccak256(P2PKH_SCRIPT), TIP_HASH),
            keccak256(abi.encode(f.KIND_BALANCE(), keccak256(P2PKH_SCRIPT), TIP_HASH))
        );
        // A 34-byte preimage: txid then vout as two big-endian bytes
        assertEq(f.outputSubject(bytes32(0), 0x0102), keccak256(abi.encodePacked(bytes32(0), hex"0102")));
    }

    /// @dev Cross-checked with `cast keccak` and asserted again in sdk/test/facts.test.ts.
    function test_ids_vectors() public view {
        assertEq(
            f.outputId(UNSPENT_TXID, 0, TIP_HASH), 0x5c7f60897e18b23a4c7d6570671f5839f997c18491134654624ae386a00f683a
        );
        assertEq(
            f.balanceId(keccak256(P2PKH_SCRIPT), TIP_HASH),
            0xec31ca3396707a7e550791a4eb5b2c39c81a2174a362ccc2f8ad50a760e5156e
        );
    }

    // =============================================================================================
    // Holds no funds
    // =============================================================================================

    function test_refusesEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(f).call{value: 1}("");
        assertFalse(ok);
        (ok,) = address(f).call{value: 1}(hex"deadbeef");
        assertFalse(ok);
        _mainnetFixtures();
        (ok,) = address(f).call{value: 1}(abi.encodeCall(BitcoinFacts.recordOutput, (UNSPENT_TXID, 0)));
        assertFalse(ok);
        (ok,) = address(f).call{value: 1}(abi.encodeCall(BitcoinFacts.recordBalance, (P2PKH_ADDR)));
        assertFalse(ok);
        (ok,) = address(f).call(abi.encodeCall(BitcoinFacts.recordOutput, (UNSPENT_TXID, 0)));
        assertTrue(ok);
        assertEq(address(f).balance, 0);
    }

    function test_unknownSelectorReverts() public {
        (bool ok,) = address(f).call(hex"deadbeef");
        assertFalse(ok);
    }

    // =============================================================================================
    // Script rules (btcd txscript.IsUnspendable)
    // =============================================================================================

    function test_parses() public view {
        assertTrue(harness.parses(""));
        assertTrue(harness.parses(hex"00"));
        assertTrue(harness.parses(UNSPENT_SCRIPT));
        assertTrue(harness.parses(SPENT_SCRIPT));
        assertTrue(harness.parses(P2PKH_SCRIPT));
        assertTrue(harness.parses(hex"a914000000000000000000000000000000000000000087")); // P2SH
        assertTrue(harness.parses(hex"4c00"));
        assertTrue(harness.parses(hex"4c01ff"));
        assertTrue(harness.parses(hex"4d0100ff"));
        assertTrue(harness.parses(hex"4e01000000ff"));
        assertTrue(harness.parses(hex"4e00000000"));
        assertTrue(harness.parses(hex"ffffff"));
        assertFalse(harness.parses(hex"01"));
        assertFalse(harness.parses(hex"0201"));
        assertFalse(harness.parses(hex"4c"));
        assertFalse(harness.parses(hex"4c01"));
        assertFalse(harness.parses(hex"4d01"));
        assertFalse(harness.parses(hex"4d0100"));
        assertFalse(harness.parses(hex"4e010000"));
        assertFalse(harness.parses(hex"4effffffff00"));
        assertFalse(harness.parses(abi.encodePacked(hex"4b", new bytes(74))));
        assertTrue(harness.parses(abi.encodePacked(hex"4b", new bytes(75))));
        assertTrue(harness.parses(_pushes(10_000)));
    }

    function test_isUnspendable() public view {
        assertTrue(harness.isUnspendable(1, hex"6a"));
        assertTrue(harness.isUnspendable(83, hex"6a4c50")); // cut, but OP_RETURN first
        assertTrue(harness.isUnspendable(10_001, new bytes(128)));
        assertFalse(harness.isUnspendable(200, new bytes(128))); // cut: cannot tell
        assertFalse(harness.isUnspendable(22, UNSPENT_SCRIPT));
        assertTrue(harness.isUnspendable(3, hex"05aabb"));
    }

    function testFuzz_parsesMatchesReference(bytes memory s) public view {
        assertEq(harness.parses(s), _refParses(s));
    }

    // =============================================================================================
    // Fuzz: no answer from any precompile makes a check revert
    // =============================================================================================

    function testFuzz_checkOutput_neverReverts(
        bytes memory r44,
        bytes memory r48,
        bytes memory r42,
        bytes memory r43,
        uint8 mode,
        bytes32 txid,
        uint16 vout
    ) public {
        if (mode & 1 == 0) HvmMock.setTip(_tip());
        else HvmMock.setAny(0x44, r44);
        if (mode & 2 != 0) HvmMock.setAny(0x48, r48);
        if (mode & 4 != 0) HvmMock.setAny(0x42, r42);
        if (mode & 8 != 0) HvmMock.setAny(0x43, r43);
        if (mode & 16 != 0) HvmMock.setFail(0x43, true);
        if (mode & 32 != 0) HvmMock.setFail(0x42, true);
        if (mode & 64 != 0) HvmMock.setFail(0x48, true);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(txid, vout);
        _assertOutputCoherent(c);
        _assertRecordMatchesCheck(c, txid, vout);
    }

    /// @dev Well-formed answers of every shape: the verdict follows the documented rules exactly.
    function testFuzz_checkOutput_structured(
        uint64 sats,
        bytes memory script,
        uint16 vout,
        bool spent,
        uint32 conf,
        bool hasConf
    ) public {
        vm.assume(script.length <= 1500);
        vout = uint16(bound(vout, 0, 300));
        HvmMock.setTip(_tip());
        HvmMock.at(0x48).setOutput(UNSPENT_TXID, vout, sats, script, spent ? 0 : 1);
        HvmMock.setRaw(
            0x42,
            abi.encodePacked(UNSPENT_TXID, Hvm.TX_FLAGS_OUTPUTS),
            _rawOutputs(uint256(vout) + 1 + (sats % 3), vout, sats, script, !spent)
        );
        if (hasConf) HvmMock.setConfirmations(UNSPENT_TXID, conf);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(UNSPENT_TXID, vout);
        _assertOutputCoherent(c);

        uint8 want;
        // Unspent (0x48 answered): only OP_RETURN first counts as unspendable; hVM's UTXO set never holds a script
        // that does not parse, so that check runs on the spent path only (security review finding 4).
        bool opReturn = script.length > 0 && uint8(script[0]) == 0x6a;
        bool unspendable = opReturn || (spent && !_refParses(script));
        bool confOk = hasConf && conf != 0 && uint256(conf) <= uint256(TIP_HEIGHT) + 1000;
        if (spent && vout >= 128) want = VOUT_TOO_HIGH;
        else if (spent && (script.length > 0 && uint8(script[0]) == 0x6a)) want = UNSPENDABLE;
        else if (spent && script.length > 128) want = TOO_LONG;
        else if (unspendable) want = UNSPENDABLE;
        else if (!confOk) want = NO_CONFS;
        else want = OK;
        assertEq(_v(c.verdict), want);
        if (want == OK) {
            assertEq(c.spent, spent);
            assertEq(c.sats, sats);
            assertEq(c.scriptHash, keccak256(script));
            assertEq(c.confirmations, conf);
        }
        _assertRecordMatchesCheck(c, UNSPENT_TXID, vout);
    }

    function testFuzz_checkBalance_neverReverts(
        bytes memory r44,
        bytes memory r46,
        bytes memory r40,
        uint8 mode,
        string memory addr
    ) public {
        if (mode & 1 == 0) HvmMock.setTip(_tip());
        else HvmMock.setAny(0x44, r44);
        if (mode & 2 != 0) HvmMock.setAny(0x46, r46);
        else if (bytes(addr).length >= 24) HvmMock.setScript(addr, P2PKH_SCRIPT);
        if (mode & 4 != 0) HvmMock.setAny(0x40, r40);
        else if (bytes(addr).length >= 24) HvmMock.setBalance(addr, 5);
        if (mode & 8 != 0) HvmMock.setFail(0x46, true);
        if (mode & 16 != 0) HvmMock.setFail(0x40, true);
        BitcoinFacts.BalanceCheck memory c = f.checkBalance(addr);
        if (c.verdict == BitcoinFacts.Verdict.Ok) {
            assertEq(c.scriptHash, keccak256(c.script));
            assertEq(c.scriptLength, c.script.length);
            assertEq(c.id, f.balanceId(c.scriptHash, c.btcBlockHash));
            uint256 len = bytes(addr).length;
            assertTrue(len >= 24 && len <= 200);
        }
        if (c.verdict == BitcoinFacts.Verdict.Ok) {
            assertEq(f.recordBalance(addr), c.id);
        } else {
            vm.expectRevert(abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, c.verdict));
            f.recordBalance(addr);
        }
    }

    function _assertOutputCoherent(BitcoinFacts.OutputCheck memory c) internal pure {
        if (c.verdict != BitcoinFacts.Verdict.Ok) return;
        assertEq(c.scriptHash, keccak256(c.script));
        assertEq(c.scriptLength, c.script.length);
        assertTrue(c.confirmations != 0);
        assertTrue(c.btcBlockHash != bytes32(0));
    }

    function _assertRecordMatchesCheck(BitcoinFacts.OutputCheck memory c, bytes32 txid, uint16 vout) internal {
        if (c.verdict == BitcoinFacts.Verdict.Ok) {
            assertEq(f.recordOutput(txid, vout), c.id);
            BitcoinFacts.OutputFact memory s = f.outputFact(c.id);
            assertEq(s.sats, c.sats);
            assertEq(s.spent, c.spent);
            assertEq(s.scriptHash, c.scriptHash);
        } else {
            vm.expectRevert(abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, c.verdict));
            f.recordOutput(txid, vout);
        }
    }

    // =============================================================================================
    // Gas (with MockHvm; its answers cost a few thousand gas where hVM charges fixed amounts, so these are
    // indicative only. check-live.sh measures the real figures by eth_estimateGas.)
    // =============================================================================================

    function test_gas_records() public {
        _mainnetFixtures();
        uint256 g = gasleft();
        f.recordOutput(UNSPENT_TXID, 0);
        console2.log("gas recordOutput unspent (MockHvm):", g - gasleft());
        g = gasleft();
        f.recordOutput(SPENT_TXID, 1);
        console2.log("gas recordOutput spent (MockHvm):  ", g - gasleft());
        g = gasleft();
        f.recordBalance(P2PKH_ADDR);
        console2.log("gas recordBalance (MockHvm):       ", g - gasleft());
        g = gasleft();
        f.recordOutput(UNSPENT_TXID, 0);
        console2.log("gas recordOutput again (no-op):    ", g - gasleft());
    }

    // =============================================================================================
    // Helpers
    // =============================================================================================

    /// @dev A 0x42 answer for flags 003c0703: `total` outputs, the first min(total, 128) listed. `vout` holds the given
    /// output; the others are 1-sat outputs with an empty script, not in the UTXO set.
    function _rawOutputs(uint256 total, uint16 vout, uint64 sats, bytes memory script, bool inUtxoSet)
        internal
        pure
        returns (bytes memory r)
    {
        uint256 n = total < 128 ? total : 128;
        r = abi.encodePacked(uint16(total));
        for (uint256 i; i < n; ++i) {
            if (i != vout) {
                r = abi.encodePacked(r, uint64(1), uint16(0), uint8(0));
                continue;
            }
            uint256 cut = script.length < 128 ? script.length : 128;
            bytes memory listed = new bytes(cut);
            for (uint256 j; j < cut; ++j) listed[j] = script[j];
            r = abi.encodePacked(r, sats, uint16(script.length), listed, inUtxoSet ? uint8(1) : uint8(0));
        }
    }

    function _distinct(bytes32[] memory slots) internal pure returns (uint256 n) {
        for (uint256 i; i < slots.length; ++i) {
            bool seen;
            for (uint256 j; j < i; ++j) {
                if (slots[j] == slots[i]) seen = true;
            }
            if (!seen) ++n;
        }
    }

    /// @dev A parseable script of exactly `n` bytes: OP_1 (0x51) repeated.
    function _pushes(uint256 n) internal pure returns (bytes memory s) {
        s = new bytes(n);
        for (uint256 i; i < n; ++i) s[i] = 0x51;
    }

    function _repeat(bytes1 b, uint256 n) internal pure returns (bytes memory s) {
        s = new bytes(n);
        for (uint256 i; i < n; ++i) s[i] = b;
    }

    /// @dev A plain reading of btcd's tokenizer, for the fuzz comparison.
    function _refParses(bytes memory s) internal pure returns (bool) {
        uint256 i = 0;
        while (i < s.length) {
            uint8 op = uint8(s[i]);
            i += 1;
            uint256 len;
            if (op >= 0x01 && op <= 0x4b) {
                len = op;
            } else if (op == 0x4c) {
                if (s.length - i < 1) return false;
                len = uint8(s[i]);
                i += 1;
            } else if (op == 0x4d) {
                if (s.length - i < 2) return false;
                len = uint256(uint8(s[i])) | (uint256(uint8(s[i + 1])) << 8);
                i += 2;
            } else if (op == 0x4e) {
                if (s.length - i < 4) return false;
                len = uint256(uint8(s[i])) | (uint256(uint8(s[i + 1])) << 8) | (uint256(uint8(s[i + 2])) << 16)
                    | (uint256(uint8(s[i + 3])) << 24);
                i += 4;
            } else {
                continue;
            }
            if (s.length - i < len) return false;
            i += len;
        }
        return true;
    }
}

/// @notice Fork test: real Hemi mainnet state (the CREATE2 deployer), MockHvm in place of the precompiles, which
/// forge cannot run. One fork. To keep its RPC use small, the mocks are configured before forking and marked
/// persistent, so their state stays local instead of being looked up on Hemi. HEMI_FORK_URL may point the fork at
/// a local proxy or node instead of the "hemi" alias in foundry.toml.
contract BitcoinFactsForkTest is Test, Fixtures {
    function test_fork_deployRecordReadBack() public {
        HvmMock.install();
        uint64[10] memory nonceBefore;
        for (uint160 p = 0x40; p <= 0x49; ++p) nonceBefore[p - 0x40] = vm.getNonce(address(p));
        _mainnetFixtures();
        for (uint160 p = 0x40; p <= 0x49; ++p) {
            vm.makePersistent(address(p));
            // MockHvm keeps each answer in a small data contract it CREATEs
            for (uint64 n = nonceBefore[p - 0x40]; n < vm.getNonce(address(p)); ++n) {
                vm.makePersistent(vm.computeCreateAddress(address(p), n));
            }
        }

        Deploy d = new Deploy();
        vm.makePersistent(address(d));
        // the empty account BitcoinFacts will be created at: a new account has no state on Hemi to look up
        vm.makePersistent(Deployments.create2Address(Deployments.BITCOIN_FACTS_SALT, type(BitcoinFacts).creationCode));

        vm.createSelectFork(vm.envOr("HEMI_FORK_URL", string("hemi")));
        assertEq(block.chainid, Deployments.HEMI_MAINNET);
        assertEq(Deployments.CREATE2_DEPLOYER.codehash, Deployments.CREATE2_DEPLOYER_CODEHASH);

        address[] memory addrs = d.deployAll(false);
        BitcoinFacts f = BitcoinFacts(addrs[0]);
        assertEq(address(f), Deployments.create2Address(Deployments.BITCOIN_FACTS_SALT, type(BitcoinFacts).creationCode));
        assertGt(address(f).code.length, 0);
        // a second run skips it
        assertEq(d.deployAll(false)[0], address(f));

        bytes32 unspent = f.recordOutput(UNSPENT_TXID, 0);
        bytes32 spent = f.recordOutput(SPENT_TXID, 1);
        bytes32 bal = f.recordBalance(P2PKH_ADDR);

        BitcoinFacts.OutputFact memory u = f.outputFact(unspent);
        assertEq(u.sats, 1000);
        assertEq(u.scriptHash, keccak256(UNSPENT_SCRIPT));
        assertFalse(u.spent);
        assertEq(u.btcBlockHash, TIP_HASH);
        assertEq(u.hemiBlock, block.number);
        BitcoinFacts.OutputFact memory s = f.outputFact(spent);
        assertTrue(s.spent);
        assertEq(s.sats, 83_050_000);
        BitcoinFacts.BalanceFact memory b = f.balanceFact(bal);
        assertEq(b.sats, P2PKH_SATS);
        assertEq(b.scriptHash, keccak256(P2PKH_SCRIPT));
        assertEq(uint8(f.kindOf(bal)), uint8(BitcoinFacts.Kind.Balance));
        // idempotent on the fork too
        assertEq(f.recordOutput(UNSPENT_TXID, 0), unspent);
    }
}
