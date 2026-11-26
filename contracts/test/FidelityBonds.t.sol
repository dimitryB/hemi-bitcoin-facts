// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {Hvm} from "../src/Hvm.sol";
import {FidelityBonds} from "../src/FidelityBonds.sol";
import {Deploy, Deployments} from "../script/Deploy.s.sol";
import {HvmMock} from "./utils/HvmMock.sol";

/// @dev Shared bond fixtures. The witness script, tag and P2WSH script are built here independently of the
/// contract's own helpers, which the tests then compare against them.
abstract contract BondFixtures is Test {
    address internal constant AGENT = 0x000000000000000000000000000000000000A9E1;
    address internal constant OTHER_AGENT = 0x00000000000000000000000000000000000b0B0b;
    /// The secp256k1 generator, compressed: a valid key whose private key (1) is public. Fixture only.
    bytes internal constant PUBKEY = hex"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    uint32 internal constant LOCKTIME = 1_800_000_000; // 2027-01-15T08:00:00Z
    uint64 internal constant SATS = 20_000;
    bytes32 internal constant TXID = keccak256("hemi-bitcoin-facts/test/bond-funding-tx");
    uint32 internal constant TIP_HEIGHT = 976_900;
    uint32 internal constant TIP_TIME = LOCKTIME - 1 days;
    bytes internal constant CHANGE_SCRIPT = hex"0014208fa508568396937efe008cbae70b4fe8a1ae45";

    // Mainnet bytes (DECISIONS.md D-002, D-003, D-004)
    bytes32 internal constant UNSPENT_TXID = 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4;
    bytes internal constant UNSPENT_SCRIPT = hex"001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831";
    bytes32 internal constant SPENT_TXID = 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e;
    bytes internal constant SPENT_TX_OUTPUTS =
        hex"0002000000001b8430890022512068d343ef205a6afa4ae74508ab4aefb92dd46549e30d5eecf63acf3155c0798e000000000004f33e1000220020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c400";
    bytes32 internal constant POP_TXID = 0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e;
    bytes internal constant POP_TX_OUTPUTS = hex"0002" hex"0000000000004510" hex"0019"
        hex"76a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac" hex"00" hex"0000000000000000" hex"0053"
        hex"6a4c5048454d4901019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff89"
        hex"41746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef4" hex"00";

    function _le(uint32 x) internal pure returns (bytes4) {
        return bytes4(uint32((x >> 24) | ((x >> 8) & 0xff00) | ((x << 8) & 0xff0000) | (x << 24)));
    }

    function _ws(uint32 lt, bytes memory key) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"04", _le(lt), hex"b17521", key, hex"ac");
    }

    function _ws() internal pure returns (bytes memory) {
        return _ws(LOCKTIME, PUBKEY);
    }

    function _p2wsh(bytes memory ws) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"0020", sha256(ws));
    }

    function _tag(uint256 chainId, address registry, address agent) internal pure returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(hex"6a30", bytes4("HFB1"), uint32(chainId), registry, agent);
    }

    function _header(uint32 time) internal pure returns (Hvm.Header memory h) {
        h = HvmMock.header(TIP_HEIGHT);
        h.time = time;
    }

    function _setTip(uint32 time) internal returns (Hvm.Header memory h) {
        h = _header(time);
        HvmMock.setTip(h);
    }

    /// @dev The funding transaction `bond create` builds: bond at 0, tag at 1, change at 2, six confirmations.
    function _bondTx(address registry) internal returns (bytes memory ws) {
        ws = _ws();
        _setTip(TIP_TIME);
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), false);
        HvmMock.setOutput(TXID, 1, 0, _tag(block.chainid, registry, AGENT), true);
        HvmMock.setOutput(TXID, 2, 5_000, CHANGE_SCRIPT, false);
        HvmMock.setConfirmations(TXID, 6);
    }

    /// @dev One precompile's typed output only. The script is an argument, so any sha256 call that builds it runs
    /// before the vm.prank inside HvmMock.at (a precompile call would otherwise consume the prank).
    function _setOne(uint160 precompile, bytes32 txid, uint16 index, uint64 sats, bytes memory script, uint8 flag)
        internal
    {
        HvmMock.at(precompile).setOutput(txid, index, sats, script, flag);
    }

    /// @dev A 0x42 answer for flags 003c0703 with these outputs (each listed with its whole script, < 128 bytes).
    function _raw42(uint256 total, uint64[] memory sats, bytes[] memory scripts, bool[] memory unspent)
        internal
        pure
        returns (bytes memory r)
    {
        r = abi.encodePacked(uint16(total));
        for (uint256 i; i < sats.length; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            r = abi.encodePacked(r, sats[i], uint16(scripts[i].length), scripts[i], unspent[i] ? uint8(1) : uint8(0));
        }
    }
}

contract FidelityBondsTest is BondFixtures {
    FidelityBonds internal fb;

    event BondRecorded(
        bytes32 indexed bondId,
        address indexed agent,
        bytes32 indexed txid,
        uint16 vout,
        uint16 tagVout,
        uint64 sats,
        uint32 locktime,
        bytes32 witnessProgram,
        uint32 confirmations,
        uint32 btcHeight,
        bytes32 btcBlockHash,
        uint64 hemiBlock,
        bytes witnessScript
    );

    event BondEnded(
        bytes32 indexed bondId, address indexed agent, uint32 btcHeight, bytes32 btcBlockHash, uint64 hemiBlock
    );

    uint8 internal constant OK = uint8(FidelityBonds.Verdict.Ok);
    uint8 internal constant BAD_WS = uint8(FidelityBonds.Verdict.BadWitnessScript);
    uint8 internal constant BAD_LT = uint8(FidelityBonds.Verdict.BadLocktime);
    uint8 internal constant NO_VIEW = uint8(FidelityBonds.Verdict.NoBitcoinView);
    uint8 internal constant NOT_FOUND = uint8(FidelityBonds.Verdict.NotFound);
    uint8 internal constant TOO_MANY = uint8(FidelityBonds.Verdict.TooManyOutputs);
    uint8 internal constant BAD_TAG = uint8(FidelityBonds.Verdict.BadTag);
    uint8 internal constant WRONG_CHAIN = uint8(FidelityBonds.Verdict.WrongChain);
    uint8 internal constant WRONG_CONTRACT = uint8(FidelityBonds.Verdict.WrongContract);
    uint8 internal constant AMBIGUOUS = uint8(FidelityBonds.Verdict.AmbiguousTag);
    uint8 internal constant NOT_A_BOND = uint8(FidelityBonds.Verdict.NotABond);
    uint8 internal constant SPENT = uint8(FidelityBonds.Verdict.Spent);
    uint8 internal constant SPEND_UNKNOWN = uint8(FidelityBonds.Verdict.SpendUnknown);
    uint8 internal constant BELOW_FLOOR = uint8(FidelityBonds.Verdict.BelowFloor);
    uint8 internal constant NO_CONFS = uint8(FidelityBonds.Verdict.NoConfirmations);
    uint8 internal constant FEW_CONFS = uint8(FidelityBonds.Verdict.FewConfirmations);

    uint8 internal constant S_NOT_RECORDED = uint8(FidelityBonds.Status.NotRecorded);
    uint8 internal constant S_LIVE = uint8(FidelityBonds.Status.Live);
    uint8 internal constant S_EXPIRED = uint8(FidelityBonds.Status.Expired);
    uint8 internal constant S_ENDED = uint8(FidelityBonds.Status.Ended);
    uint8 internal constant S_UNKNOWN = uint8(FidelityBonds.Status.Unknown);

    function setUp() public {
        HvmMock.install();
        fb = new FidelityBonds();
        vm.roll(5_780_432);
    }

    function _verdict(bytes32 txid, uint16 bondVout, uint16 tagVout, bytes memory ws) internal view returns (uint8) {
        return uint8(fb.checkBond(txid, bondVout, tagVout, ws).verdict);
    }

    function _v(bytes memory ws) internal view returns (uint8) {
        return _verdict(TXID, 0, 1, ws);
    }

    function _v() internal view returns (uint8) {
        return _v(_ws());
    }

    function _status(bytes32 id) internal view returns (uint8 s) {
        (FidelityBonds.Status st,,,) = fb.liveBond(id);
        s = uint8(st);
    }

    function _record() internal returns (bytes32 id, bytes memory ws) {
        ws = _bondTx(address(fb));
        id = fb.recordBond(TXID, 0, 1, ws);
    }

    // =============================================================================================
    // checkBond: Ok
    // =============================================================================================

    function test_checkBond_ok() public {
        bytes memory ws = _bondTx(address(fb));
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
        assertEq(uint8(c.verdict), OK);
        assertEq(c.bondId, fb.bondId(TXID, 0));
        assertFalse(c.recorded);
        assertEq(c.agent, AGENT);
        assertEq(c.sats, SATS);
        assertEq(c.locktime, LOCKTIME);
        assertEq(c.witnessProgram, sha256(ws));
        assertEq(c.confirmations, 6);
        assertEq(c.btcHeight, TIP_HEIGHT);
        assertEq(c.btcBlockHash, HvmMock.header(TIP_HEIGHT).hash);
        assertEq(c.btcTime, TIP_TIME);
        assertFalse(c.expired);
    }

    function test_checkBond_okTagFirstOtherVouts() public {
        bytes memory ws = _ws();
        _setTip(TIP_TIME);
        HvmMock.setOutput(TXID, 0, 0, _tag(block.chainid, address(fb), AGENT), true);
        HvmMock.setOutput(TXID, 1, 1_000, CHANGE_SCRIPT, false);
        HvmMock.setOutput(TXID, 4, 123_456, _p2wsh(ws), false);
        HvmMock.setConfirmations(TXID, 1_000);
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 4, 0, ws);
        assertEq(uint8(c.verdict), OK);
        assertEq(c.sats, 123_456);
        assertEq(c.confirmations, 1_000);
        assertEq(c.bondId, fb.bondId(TXID, 4));
    }

    function test_checkBond_okBothKeyPrefixesAndLocktimeBounds() public {
        bytes memory key3 = PUBKEY;
        key3[0] = 0x03;
        uint32[3] memory lts = [uint32(500_000_000), LOCKTIME, uint32((1 << 31) - 1)];
        for (uint256 k; k < 2; ++k) {
            for (uint256 i; i < lts.length; ++i) {
                bytes memory ws = _ws(lts[i], k == 0 ? PUBKEY : key3);
                bytes32 txid = keccak256(abi.encode(k, i));
                _setTip(500_000_000 - 1);
                HvmMock.setOutput(txid, 0, SATS, _p2wsh(ws), false);
                HvmMock.setOutput(txid, 1, 0, _tag(block.chainid, address(fb), AGENT), true);
                HvmMock.setConfirmations(txid, 6);
                FidelityBonds.BondCheck memory c = fb.checkBond(txid, 0, 1, ws);
                assertEq(uint8(c.verdict), OK);
                assertEq(c.locktime, lts[i]);
            }
        }
    }

    function test_checkBond_expiredIsStillOk() public {
        bytes memory ws = _bondTx(address(fb));
        _setTip(LOCKTIME);
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
        assertEq(uint8(c.verdict), OK);
        assertTrue(c.expired);
        _setTip(LOCKTIME - 1);
        assertFalse(fb.checkBond(TXID, 0, 1, ws).expired);
    }

    function test_checkBond_recordedFlag() public {
        (bytes32 id, bytes memory ws) = _record();
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
        assertTrue(c.recorded);
        assertEq(c.bondId, id);
    }

    // =============================================================================================
    // checkBond: the witness script template, byte by byte
    // =============================================================================================

    function test_checkBond_badWitnessScript_eachFixedByte() public {
        _bondTx(address(fb));
        // positions that must hold one value: push 4, CLTV, DROP, push 33, CHECKSIG
        uint256[5] memory pos = [uint256(0), 5, 6, 7, 41];
        for (uint256 p; p < pos.length; ++p) {
            for (uint256 b; b < 256; b += 17) {
                bytes memory ws = _ws();
                if (uint8(ws[pos[p]]) == b) continue;
                ws[pos[p]] = bytes1(uint8(b));
                assertEq(_v(ws), BAD_WS);
            }
        }
        // the key prefix: only 02 and 03
        for (uint256 b; b < 256; ++b) {
            bytes memory ws = _ws();
            ws[8] = bytes1(uint8(b));
            if (b == 2 || b == 3) assertTrue(_v(ws) != BAD_WS);
            else assertEq(_v(ws), BAD_WS);
        }
    }

    function test_checkBond_badWitnessScript_shapes() public {
        _bondTx(address(fb));
        bytes memory ws = _ws();
        // wrong opcodes: OP_CHECKSEQUENCEVERIFY for CLTV, OP_2DROP for DROP, CHECKSIGVERIFY for CHECKSIG
        bytes memory csv = _ws();
        csv[5] = 0xb2;
        assertEq(_v(csv), BAD_WS);
        bytes memory twoDrop = _ws();
        twoDrop[6] = 0x6d;
        assertEq(_v(twoDrop), BAD_WS);
        bytes memory checksigverify = _ws();
        checksigverify[41] = 0xad;
        assertEq(_v(checksigverify), BAD_WS);
        // a 5-byte locktime push (43 bytes), a 3-byte one (41 bytes)
        assertEq(_v(abi.encodePacked(hex"05", _le(LOCKTIME), hex"00", hex"b17521", PUBKEY, hex"ac")), BAD_WS);
        assertEq(_v(abi.encodePacked(hex"03", hex"0065cd", hex"b17521", PUBKEY, hex"ac")), BAD_WS);
        // an uncompressed key: push 65, 04 prefix (75 bytes); and a 33-byte push starting 04
        bytes memory uncompressed = abi.encodePacked(
            hex"04", _le(LOCKTIME), hex"b17541", hex"04", bytes32(uint256(1)), bytes32(uint256(2)), hex"ac"
        );
        assertEq(uncompressed.length, 74);
        assertEq(_v(uncompressed), BAD_WS);
        bytes memory prefix04 = _ws();
        prefix04[8] = 0x04;
        assertEq(_v(prefix04), BAD_WS);
        // a 32-byte x-only key (41 bytes)
        bytes memory xonly = new bytes(32);
        assertEq(_v(abi.encodePacked(hex"04", _le(LOCKTIME), hex"b17520", xonly, hex"ac")), BAD_WS);
        // lengths
        assertEq(_v(""), BAD_WS);
        assertEq(_v(abi.encodePacked(ws, hex"00")), BAD_WS);
        bytes memory short = new bytes(41);
        for (uint256 i; i < 41; ++i) short[i] = ws[i];
        assertEq(_v(short), BAD_WS);
        // the bond's own P2WSH script is not a witness script
        assertEq(_v(_p2wsh(ws)), BAD_WS);
        // nothing is filled for a bad template
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, csv);
        assertEq(c.locktime, 0);
        assertEq(c.witnessProgram, bytes32(0));
        assertEq(c.btcHeight, 0);
        assertEq(c.bondId, fb.bondId(TXID, 0));
    }

    function test_checkBond_badWitnessScript_callsNoPrecompile() public {
        _bondTx(address(fb));
        for (uint160 p = 0x40; p <= 0x49; ++p) HvmMock.setFail(p, true);
        bytes memory ws = _ws();
        ws[0] = 0x05;
        uint256 g = gasleft();
        assertEq(_v(ws), BAD_WS);
        assertLt(g - gasleft(), 20_000);
    }

    function test_checkBond_badLocktime() public {
        // with no 0x44 answer, NoBitcoinView means the template and the locktime passed
        assertEq(_v(_ws(499_999_999, PUBKEY)), BAD_LT);
        assertEq(_v(_ws(0, PUBKEY)), BAD_LT);
        assertEq(_v(_ws(1, PUBKEY)), BAD_LT);
        assertEq(_v(_ws(976_900, PUBKEY)), BAD_LT); // a block height
        assertEq(_v(_ws(uint32(1 << 31), PUBKEY)), BAD_LT); // negative as a script number
        assertEq(_v(_ws(type(uint32).max, PUBKEY)), BAD_LT);
        assertEq(_v(_ws(500_000_000, PUBKEY)), NO_VIEW);
        assertEq(_v(_ws(uint32((1 << 31) - 1), PUBKEY)), NO_VIEW);
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, _ws(499_999_999, PUBKEY));
        assertEq(c.locktime, 499_999_999); // filled as far as the check got
        assertEq(c.witnessProgram, sha256(_ws(499_999_999, PUBKEY)));
    }

    // =============================================================================================
    // checkBond: hVM answers
    // =============================================================================================

    function test_checkBond_noBitcoinView() public {
        _bondTx(address(fb));
        HvmMock.setAny(0x44, new bytes(115));
        assertEq(_v(), NO_VIEW);
        HvmMock.setAny(0x44, new bytes(117));
        assertEq(_v(), NO_VIEW);
        bytes memory raw = HvmMock.encodeHeader(_header(TIP_TIME));
        for (uint256 i = 4; i < 36; ++i) raw[i] = 0;
        HvmMock.setAny(0x44, raw);
        assertEq(_v(), NO_VIEW);
        HvmMock.clearAny(0x44);
        HvmMock.setFail(0x44, true);
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, _ws());
        assertEq(uint8(c.verdict), NO_VIEW);
        assertEq(c.btcBlockHash, bytes32(0));
        assertEq(c.agent, address(0));
    }

    function test_checkBond_notFound() public {
        _bondTx(address(fb));
        // unknown txid: 0x42 has no answer, and 0x43 is never called (it would burn its cap)
        HvmMock.setFail(0x43, true);
        uint256 g = gasleft();
        assertEq(_verdict(bytes32(uint256(0x1111)), 0, 1, _ws()), NOT_FOUND);
        assertLt(g - gasleft(), 100_000);
        HvmMock.setFail(0x43, false);
        // vouts past the output count (3)
        assertEq(_verdict(TXID, 3, 1, _ws()), NOT_FOUND);
        assertEq(_verdict(TXID, 0, 3, _ws()), NOT_FOUND);
        assertEq(_verdict(TXID, type(uint16).max, 1, _ws()), NOT_FOUND);
        assertEq(_verdict(TXID, 0, type(uint16).max, _ws()), NOT_FOUND);
    }

    function test_checkBond_notFound_malformed0x42() public {
        bytes memory ws = _ws();
        _setTip(TIP_TIME);
        HvmMock.setConfirmations(TXID, 6);
        uint64[] memory sats = new uint64[](2);
        bytes[] memory scripts = new bytes[](2);
        bool[] memory unspent = new bool[](2);
        (sats[0], scripts[0], unspent[0]) = (SATS, _p2wsh(ws), true);
        (sats[1], scripts[1], unspent[1]) = (0, _tag(block.chainid, address(fb), AGENT), false);
        bytes memory good = _raw42(2, sats, scripts, unspent);
        bytes memory input = abi.encodePacked(TXID, Hvm.TX_FLAGS_OUTPUTS);
        _setOne(0x48, TXID, 0, SATS, _p2wsh(ws), 1);
        HvmMock.setRaw(0x42, input, good);
        assertEq(_v(ws), OK);
        // truncated by one byte
        bytes memory cut = new bytes(good.length - 1);
        for (uint256 i; i < cut.length; ++i) cut[i] = good[i];
        HvmMock.setRaw(0x42, input, cut);
        assertEq(_v(ws), NOT_FOUND);
        // trailing junk
        HvmMock.setRaw(0x42, input, abi.encodePacked(good, hex"00"));
        assertEq(_v(ws), NOT_FOUND);
        // a UTXO byte of 2
        bytes memory two = abi.encodePacked(good);
        two[two.length - 1] = 0x02;
        HvmMock.setRaw(0x42, input, two);
        assertEq(_v(ws), NOT_FOUND);
        // a count of 3 with two outputs listed
        bytes memory three = abi.encodePacked(good);
        three[1] = 0x03;
        HvmMock.setRaw(0x42, input, three);
        assertEq(_v(ws), NOT_FOUND);
        // one byte
        HvmMock.setRaw(0x42, input, hex"00");
        assertEq(_v(ws), NOT_FOUND);
        // a count of zero
        HvmMock.setRaw(0x42, input, hex"0000");
        assertEq(_v(ws), NOT_FOUND);
        // failing
        HvmMock.setFail(0x42, true);
        assertEq(_v(ws), NOT_FOUND);
    }

    function test_checkBond_tooManyOutputs() public {
        bytes memory ws = _ws();
        _setTip(TIP_TIME);
        HvmMock.setConfirmations(TXID, 6);
        _setOne(0x48, TXID, 0, SATS, _p2wsh(ws), 1);
        // 129 outputs: bond, tag, then 127 more listed, the 129th past 0x42's window
        bytes memory r = abi.encodePacked(
            uint16(129),
            abi.encodePacked(SATS, uint16(34), _p2wsh(ws), uint8(1)),
            abi.encodePacked(uint64(0), uint16(50), _tag(block.chainid, address(fb), AGENT), uint8(0))
        );
        for (uint256 i = 2; i < 128; ++i) r = abi.encodePacked(r, uint64(1), uint16(0), uint8(0));
        HvmMock.setRaw(0x42, abi.encodePacked(TXID, Hvm.TX_FLAGS_OUTPUTS), r);
        assertEq(_v(ws), TOO_MANY);
        // exactly 128 is fine
        bytes memory r128 = abi.encodePacked(r);
        r128[1] = 0x80;
        HvmMock.setRaw(0x42, abi.encodePacked(TXID, Hvm.TX_FLAGS_OUTPUTS), r128);
        assertEq(_v(ws), OK);
    }

    // =============================================================================================
    // checkBond: the tag
    // =============================================================================================

    function _withTag(bytes memory tag) internal returns (uint8) {
        HvmMock.setOutput(TXID, 1, 0, tag, true);
        return _v();
    }

    /// @dev The PoP transaction's 83-byte OP_RETURN as mainnet's 0x42 lists it: not a tag. checkBond stops earlier,
    /// at its spent P2PKH vout 0, which is not a bond.
    function test_readTag_popOpReturnMainnetBytes() public {
        _setTip(TIP_TIME);
        HvmMock.setRaw(0x42, abi.encodePacked(POP_TXID, Hvm.TX_FLAGS_OUTPUTS), POP_TX_OUTPUTS);
        HvmMock.setConfirmations(POP_TXID, 3088);
        (FidelityBonds.Verdict v, address agent) = fb.readTag(POP_TXID, 1);
        assertEq(uint8(v), BAD_TAG);
        assertEq(agent, address(0));
        (v,) = fb.readTag(POP_TXID, 0);
        assertEq(uint8(v), BAD_TAG);
        (v,) = fb.readTag(POP_TXID, 2);
        assertEq(uint8(v), NOT_FOUND);
        assertEq(_verdict(POP_TXID, 0, 1, _ws()), NOT_A_BOND);
    }

    function test_readTag() public {
        _bondTx(address(fb));
        (FidelityBonds.Verdict v, address agent) = fb.readTag(TXID, 1);
        assertEq(uint8(v), OK);
        assertEq(agent, AGENT);
        (v, agent) = fb.readTag(TXID, 0);
        assertEq(uint8(v), BAD_TAG);
        assertEq(agent, address(0));
        (v,) = fb.readTag(TXID, 3);
        assertEq(uint8(v), NOT_FOUND);
        (v,) = fb.readTag(bytes32(uint256(99)), 0);
        assertEq(uint8(v), NOT_FOUND);
        HvmMock.setOutput(TXID, 1, 0, _tag(43_111, address(fb), AGENT), true);
        (v,) = fb.readTag(TXID, 1);
        assertEq(uint8(v), WRONG_CHAIN);
        HvmMock.setOutput(TXID, 1, 0, _tag(block.chainid, address(0xdead), AGENT), true);
        (v,) = fb.readTag(TXID, 1);
        assertEq(uint8(v), WRONG_CONTRACT);
        HvmMock.setOutput(TXID, 1, 0, _tag(block.chainid, address(fb), AGENT), true);
        HvmMock.setOutput(TXID, 3, 0, _tag(block.chainid, address(fb), OTHER_AGENT), true);
        (v,) = fb.readTag(TXID, 1);
        assertEq(uint8(v), AMBIGUOUS);
        // no Bitcoin header is needed and no 0x48 or 0x43 call is made
        HvmMock.setFail(0x44, true);
        HvmMock.setFail(0x48, true);
        HvmMock.setFail(0x43, true);
        (v, agent) = fb.readTag(TXID, 3);
        assertEq(uint8(v), AMBIGUOUS);
        assertEq(agent, address(0));
    }

    function testFuzz_readTag_neverReverts(bytes memory r42, bool fail42, bytes32 txid, uint16 tagVout) public {
        _bondTx(address(fb));
        HvmMock.setAny(0x42, r42);
        if (fail42) HvmMock.setFail(0x42, true);
        (FidelityBonds.Verdict v, address agent) = fb.readTag(txid, tagVout);
        assertEq(v == FidelityBonds.Verdict.Ok, agent != address(0));
    }

    function test_checkBond_badTag_tunnelDepositAsciiHex() public {
        _bondTx(address(fb));
        // A Hemi tunnel deposit's OP_RETURN: the EVM address as ASCII hex, with and without 0x
        bytes memory hexAddr = bytes("a9e1000000000000000000000000000000000000");
        assertEq(_withTag(abi.encodePacked(hex"6a28", hexAddr)), BAD_TAG);
        assertEq(_withTag(abi.encodePacked(hex"6a2a", "0x", hexAddr)), BAD_TAG);
        // even 48 ASCII hex characters after 6a30 fail: they never spell "HFB1"
        bytes memory hex48 = bytes("0x0000a867a9e1000000000000000000000000000000000000");
        assertEq(hex48.length, 50);
        bytes memory forty8 = new bytes(48);
        for (uint256 i; i < 48; ++i) forty8[i] = hex48[i + 2];
        assertEq(_withTag(abi.encodePacked(hex"6a30", forty8)), BAD_TAG);
        assertEq(_withTag(abi.encodePacked(hex"6a30", bytes("48464231"), new bytes(40))), BAD_TAG);
    }

    function test_checkBond_badTag_shapes() public {
        _bondTx(address(fb));
        bytes memory good = _tag(block.chainid, address(fb), AGENT);
        // length: one byte short (push 47) and one long (push 49)
        bytes memory short = new bytes(49);
        for (uint256 i; i < 49; ++i) short[i] = good[i];
        short[1] = 0x2f;
        assertEq(_withTag(short), BAD_TAG);
        assertEq(_withTag(abi.encodePacked(hex"6a31", bytes4("HFB1"), uint32(block.chainid), address(fb), AGENT, hex"00")), BAD_TAG);
        // OP_PUSHDATA1 spelling of the same 48 bytes (51 bytes), and a 50-byte PUSHDATA1 variant
        bytes memory payload = new bytes(48);
        for (uint256 i; i < 48; ++i) payload[i] = good[i + 2];
        assertEq(_withTag(abi.encodePacked(hex"6a4c30", payload)), BAD_TAG);
        bytes memory p47 = new bytes(47);
        for (uint256 i; i < 47; ++i) p47[i] = payload[i];
        assertEq(_withTag(abi.encodePacked(hex"6a4c2f", p47)), BAD_TAG);
        // not OP_RETURN
        bytes memory notReturn = abi.encodePacked(good);
        notReturn[0] = 0x51;
        assertEq(_withTag(notReturn), BAD_TAG);
        // wrong push length byte with the right total length
        bytes memory push2f = abi.encodePacked(good);
        push2f[1] = 0x2f;
        assertEq(_withTag(push2f), BAD_TAG);
        // magic, byte by byte
        for (uint256 i = 2; i < 6; ++i) {
            bytes memory m = abi.encodePacked(good);
            m[i] = bytes1(uint8(m[i]) ^ 0x20); // "hfb1" case flips
            assertEq(_withTag(m), BAD_TAG);
        }
        assertEq(_withTag(abi.encodePacked(hex"6a30", bytes4("HFB2"), uint32(block.chainid), address(fb), AGENT)), BAD_TAG);
        // the zero agent
        assertEq(_withTag(_tag(block.chainid, address(fb), address(0))), BAD_TAG);
        // the tag's place holds a P2WPKH output
        assertEq(_withTag(CHANGE_SCRIPT), BAD_TAG);
        // the good one passes
        assertEq(_withTag(good), OK);
    }

    function test_checkBond_wrongChain() public {
        _bondTx(address(fb));
        assertEq(_withTag(_tag(43_111, address(fb), AGENT)), WRONG_CHAIN);
        assertEq(_withTag(_tag(block.chainid + 1, address(fb), AGENT)), WRONG_CHAIN);
        assertEq(_withTag(_tag(0, address(fb), AGENT)), WRONG_CHAIN);
        // a chain id that does not fit in 4 bytes never matches, even where its low 4 bytes do
        bytes memory tag = _tag(block.chainid, address(fb), AGENT);
        HvmMock.setOutput(TXID, 1, 0, tag, true);
        vm.chainId(uint256(1) << 32 | block.chainid);
        assertEq(_v(), WRONG_CHAIN);
    }

    function test_checkBond_wrongContract() public {
        _bondTx(address(fb));
        FidelityBonds other = new FidelityBonds();
        assertEq(_withTag(_tag(block.chainid, address(other), AGENT)), WRONG_CONTRACT);
        assertEq(_withTag(_tag(block.chainid, address(0), AGENT)), WRONG_CONTRACT);
        assertEq(_withTag(_tag(block.chainid, AGENT, AGENT)), WRONG_CONTRACT);
        // a transaction tagged for the other registry is a bond there, not here
        HvmMock.setOutput(TXID, 1, 0, _tag(block.chainid, address(other), AGENT), true);
        assertEq(uint8(other.checkBond(TXID, 0, 1, _ws()).verdict), OK);
        assertEq(_v(), WRONG_CONTRACT);
    }

    function test_checkBond_otherAgent() public {
        _bondTx(address(fb));
        HvmMock.setOutput(TXID, 1, 0, _tag(block.chainid, address(fb), OTHER_AGENT), true);
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, _ws());
        assertEq(uint8(c.verdict), OK);
        assertEq(c.agent, OTHER_AGENT); // the tag decides; no caller can choose another agent
    }

    function test_checkBond_ambiguousTag() public {
        _bondTx(address(fb));
        // a second tag for this chain and contract, another agent
        HvmMock.setOutput(TXID, 3, 0, _tag(block.chainid, address(fb), OTHER_AGENT), true);
        assertEq(_v(), AMBIGUOUS);
        // the same agent twice is ambiguous too
        HvmMock.setOutput(TXID, 3, 0, _tag(block.chainid, address(fb), AGENT), true);
        assertEq(_v(), AMBIGUOUS);
        assertEq(_verdict(TXID, 0, 3, _ws()), AMBIGUOUS);
        // any other "HFB1" tag makes it ambiguous, whatever chain, contract or agent it names, so one output is a
        // bond in at most one registry (security review finding 5)
        HvmMock.setOutput(TXID, 3, 0, _tag(43_111, address(fb), OTHER_AGENT), true);
        assertEq(_v(), AMBIGUOUS);
        HvmMock.setOutput(TXID, 3, 0, _tag(block.chainid, address(0xdead), OTHER_AGENT), true);
        assertEq(_v(), AMBIGUOUS);
        HvmMock.setOutput(TXID, 3, 0, _tag(block.chainid, address(fb), address(0)), true);
        assertEq(_v(), AMBIGUOUS);
        // an OP_RETURN that is not a 50-byte "HFB1" script does not count
        HvmMock.setOutput(TXID, 3, 0, hex"6a0548464231aa", true);
        assertEq(_v(), OK);
        bytes memory longer = abi.encodePacked(_tag(block.chainid, address(fb), OTHER_AGENT), hex"00");
        HvmMock.setOutput(TXID, 3, 0, longer, true);
        assertEq(_v(), OK);
    }

    // =============================================================================================
    // checkBond: the bond output
    // =============================================================================================

    function test_checkBond_notABond() public {
        bytes memory ws = _bondTx(address(fb));
        // the change output (P2WPKH) is not a bond
        assertEq(_verdict(TXID, 2, 1, ws), NOT_A_BOND);
        // the tag is not a bond
        assertEq(_verdict(TXID, 1, 1, ws), NOT_A_BOND);
        // another witness script than the one the output commits to
        assertEq(_v(_ws(LOCKTIME + 1, PUBKEY)), NOT_A_BOND);
        bytes memory key3 = PUBKEY;
        key3[0] = 0x03;
        assertEq(_v(_ws(LOCKTIME, key3)), NOT_A_BOND);
        // a P2WSH output of another script, and a P2TR output with the same 32 bytes
        HvmMock.setOutput(TXID, 0, SATS, abi.encodePacked(hex"0020", keccak256(ws)), false);
        assertEq(_v(ws), NOT_A_BOND);
        HvmMock.setOutput(TXID, 0, SATS, abi.encodePacked(hex"5120", sha256(ws)), false);
        assertEq(_v(ws), NOT_A_BOND);
        // a P2WSH script cut to 34 bytes from a longer one does not pass either
        HvmMock.setOutput(TXID, 0, SATS, abi.encodePacked(_p2wsh(ws), hex"00"), false);
        assertEq(_v(ws), NOT_A_BOND);
    }

    function test_checkBond_spent() public {
        bytes memory ws = _bondTx(address(fb));
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), true);
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
        assertEq(uint8(c.verdict), SPENT);
        assertEq(c.sats, 0); // not filled: there is no unspent value
        assertEq(c.agent, address(0)); // the tag comes after the spend status
        // spent wins over a bad tag: the output is checked before the tag
        HvmMock.setOutput(TXID, 1, 0, hex"6a00", true);
        assertEq(_v(ws), SPENT);
    }

    function test_checkBond_order_outputBeforeTag() public {
        bytes memory ws = _bondTx(address(fb));
        HvmMock.setOutput(TXID, 1, 0, CHANGE_SCRIPT, false); // no tag at all
        assertEq(_v(ws), BAD_TAG);
        assertEq(_verdict(TXID, 2, 1, ws), NOT_A_BOND); // a wrong bond output is reported first
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
        assertEq(c.sats, SATS); // filled: the output passed before the tag failed
        assertEq(c.agent, address(0));
    }

    function test_checkBond_spendUnknown_malformed0x48() public {
        bytes memory ws = _bondTx(address(fb));
        // 0x48 answers with another value than 0x42 lists
        _setOne(0x48, TXID, 0, SATS - 1, _p2wsh(ws), 1);
        assertEq(_v(), SPEND_UNKNOWN);
        _setOne(0x48, TXID, 0, SATS, _p2wsh(ws), 1);
        assertEq(_v(), OK);
        // malformed 0x48 answers are no answer; 0x42 still says in the UTXO set, so: Unknown, never spent
        bytes memory script = _p2wsh(ws);
        HvmMock.setAny(0x48, abi.encodePacked(SATS, uint16(34), script, uint8(0))); // flag 0
        assertEq(_v(), SPEND_UNKNOWN);
        HvmMock.setAny(0x48, abi.encodePacked(SATS, uint16(34), script, uint8(2))); // flag 2
        assertEq(_v(), SPEND_UNKNOWN);
        HvmMock.setAny(0x48, abi.encodePacked(SATS, uint16(34), script)); // no flag
        assertEq(_v(), SPEND_UNKNOWN);
        HvmMock.setAny(0x48, abi.encodePacked(SATS, uint16(35), script, uint8(1))); // length field too long
        assertEq(_v(), SPEND_UNKNOWN);
        HvmMock.setAny(0x48, new bytes(10));
        assertEq(_v(), SPEND_UNKNOWN);
        HvmMock.setAny(0x48, abi.encodePacked(SATS, uint16(34), script, uint8(1), hex"00")); // trailing byte
        assertEq(_v(), SPEND_UNKNOWN);
        HvmMock.clearAny(0x48);
        // 0x48 fails while 0x42 says in the UTXO set
        HvmMock.setFail(0x48, true);
        assertEq(_v(), SPEND_UNKNOWN);
    }

    function test_checkBond_belowFloor() public {
        bytes memory ws = _bondTx(address(fb));
        HvmMock.setOutput(TXID, 0, fb.MIN_SATS() - 1, _p2wsh(ws), false);
        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
        assertEq(uint8(c.verdict), BELOW_FLOOR);
        assertEq(c.sats, 9_999);
        HvmMock.setOutput(TXID, 0, fb.MIN_SATS(), _p2wsh(ws), false);
        assertEq(_v(ws), OK);
        HvmMock.setOutput(TXID, 0, 0, _p2wsh(ws), false);
        assertEq(_v(ws), BELOW_FLOOR);
    }

    function test_checkBond_confirmations() public {
        bytes memory ws = _bondTx(address(fb));
        for (uint32 n = 1; n < 6; ++n) {
            HvmMock.setConfirmations(TXID, n);
            FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
            assertEq(uint8(c.verdict), FEW_CONFS);
            assertEq(c.confirmations, n);
        }
        HvmMock.setConfirmations(TXID, 6);
        assertEq(_v(ws), OK);
        // no plausible count
        HvmMock.setConfirmations(TXID, 0);
        assertEq(_v(ws), NO_CONFS);
        HvmMock.setConfirmations(TXID, TIP_HEIGHT + 1000);
        assertEq(_v(ws), OK);
        HvmMock.setConfirmations(TXID, TIP_HEIGHT + 1001);
        assertEq(_v(ws), NO_CONFS);
        HvmMock.setConfirmations(TXID, type(uint32).max - 1); // an underflowed count (D-011)
        assertEq(_v(ws), NO_CONFS);
        HvmMock.setAny(0x43, hex"000006");
        assertEq(_v(ws), NO_CONFS);
        HvmMock.setAny(0x43, hex"0000000006");
        assertEq(_v(ws), NO_CONFS);
        HvmMock.setAny(0x43, "");
        assertEq(_v(ws), NO_CONFS);
        HvmMock.clearAny(0x43);
        // 0x43 fails (an unknown txid): burns its cap and no more
        HvmMock.setFail(0x43, true);
        uint256 g = gasleft();
        assertEq(_v(ws), NO_CONFS);
        assertLt(g - gasleft(), 200_000);
    }

    function test_checkBond_maxHeightDoesNotRevert() public {
        bytes memory ws = _bondTx(address(fb));
        Hvm.Header memory h = _header(TIP_TIME);
        h.height = type(uint32).max;
        HvmMock.setTip(h);
        HvmMock.setConfirmations(TXID, type(uint32).max);
        assertEq(_v(ws), OK);
    }

    // =============================================================================================
    // recordBond
    // =============================================================================================

    function test_recordBond_storesAndEmitsEveryField() public {
        bytes memory ws = _bondTx(address(fb));
        bytes32 id = fb.bondId(TXID, 0);
        bytes32 tipHash = HvmMock.header(TIP_HEIGHT).hash;
        vm.expectEmit(true, true, true, true, address(fb));
        emit BondRecorded(
            id, AGENT, TXID, 0, 1, SATS, LOCKTIME, sha256(ws), 6, TIP_HEIGHT, tipHash, uint64(block.number), ws
        );
        assertEq(fb.recordBond(TXID, 0, 1, ws), id);

        FidelityBonds.Bond memory b = fb.bond(id);
        assertEq(b.txid, TXID);
        assertEq(b.witnessProgram, sha256(ws));
        assertEq(b.btcBlockHash, tipHash);
        assertEq(b.agent, AGENT);
        assertEq(b.sats, SATS);
        assertEq(b.locktime, LOCKTIME);
        assertEq(b.hemiBlock, block.number);
        assertEq(b.endedHemiBlock, 0);
        assertEq(b.btcHeight, TIP_HEIGHT);
        assertEq(b.endedBtcHeight, 0);
        assertEq(b.confirmations, 6);
        assertEq(b.vout, 0);
        assertEq(b.tagVout, 1);
        // the stored fields recompute the id and the output script
        assertEq(fb.bondId(b.txid, b.vout), id);
        assertEq(fb.bondScript(ws), abi.encodePacked(hex"0020", b.witnessProgram));
    }

    function test_recordBond_usesFiveSlots() public {
        bytes memory ws = _bondTx(address(fb));
        vm.record();
        fb.recordBond(TXID, 0, 1, ws);
        (, bytes32[] memory writes) = vm.accesses(address(fb));
        assertEq(_distinct(writes), 5);
    }

    function test_recordBond_idempotent() public {
        (bytes32 id, bytes memory ws) = _record();
        FidelityBonds.Bond memory before = fb.bond(id);
        // later Hemi block, more confirmations, a new Bitcoin tip: nothing changes
        vm.roll(block.number + 50);
        HvmMock.setConfirmations(TXID, 60);
        Hvm.Header memory h = HvmMock.header(TIP_HEIGHT + 3);
        h.time = TIP_TIME + 1800;
        HvmMock.setTip(h);
        vm.recordLogs();
        vm.record();
        assertEq(fb.recordBond(TXID, 0, 1, ws), id);
        (, bytes32[] memory writes) = vm.accesses(address(fb));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        FidelityBonds.Bond memory again = fb.bond(id);
        assertEq(again.hemiBlock, before.hemiBlock);
        assertEq(again.confirmations, 6);
        assertEq(again.btcHeight, TIP_HEIGHT);
    }

    function test_recordBond_onePerOutput() public {
        bytes memory ws = _bondTx(address(fb));
        // a second bond output in the same transaction, under the same tag: its own id
        HvmMock.setOutput(TXID, 3, 50_000, _p2wsh(ws), false);
        bytes32 a = fb.recordBond(TXID, 0, 1, ws);
        bytes32 b = fb.recordBond(TXID, 3, 1, ws);
        assertTrue(a != b);
        assertEq(fb.bond(b).sats, 50_000);
        assertEq(fb.bond(b).agent, AGENT);
    }

    function test_recordBond_revertsWithVerdict() public {
        bytes memory ws = _ws();
        vm.expectRevert(abi.encodeWithSelector(FidelityBonds.NotRecordable.selector, FidelityBonds.Verdict.NoBitcoinView));
        fb.recordBond(TXID, 0, 1, ws);
        _bondTx(address(fb));
        vm.expectRevert(abi.encodeWithSelector(FidelityBonds.NotRecordable.selector, FidelityBonds.Verdict.BadWitnessScript));
        fb.recordBond(TXID, 0, 1, hex"00");
        vm.expectRevert(abi.encodeWithSelector(FidelityBonds.NotRecordable.selector, FidelityBonds.Verdict.BadLocktime));
        fb.recordBond(TXID, 0, 1, _ws(100, PUBKEY));
        vm.expectRevert(abi.encodeWithSelector(FidelityBonds.NotRecordable.selector, FidelityBonds.Verdict.NotFound));
        fb.recordBond(bytes32(uint256(1)), 0, 1, ws);
        vm.expectRevert(abi.encodeWithSelector(FidelityBonds.NotRecordable.selector, FidelityBonds.Verdict.NotABond));
        fb.recordBond(TXID, 2, 1, ws);
        HvmMock.setConfirmations(TXID, 5);
        vm.expectRevert(
            abi.encodeWithSelector(FidelityBonds.NotRecordable.selector, FidelityBonds.Verdict.FewConfirmations)
        );
        fb.recordBond(TXID, 0, 1, ws);
    }

    function test_recordBond_afterItIsSpent() public {
        (bytes32 id, bytes memory ws) = _record();
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), true);
        vm.expectRevert(abi.encodeWithSelector(FidelityBonds.NotRecordable.selector, FidelityBonds.Verdict.Spent));
        fb.recordBond(TXID, 0, 1, ws);
        assertEq(fb.bond(id).sats, SATS); // still stored, untouched
    }

    function test_recordBond_permissionless() public {
        bytes memory ws = _bondTx(address(fb));
        vm.prank(address(0xbeef));
        bytes32 id = fb.recordBond(TXID, 0, 1, ws);
        assertEq(fb.bond(id).agent, AGENT); // the recorder is not the agent
    }

    // =============================================================================================
    // refresh
    // =============================================================================================

    function test_refresh_unknownBondReverts() public {
        vm.expectRevert(abi.encodeWithSelector(FidelityBonds.UnknownBond.selector, bytes32(uint256(7))));
        fb.refresh(bytes32(uint256(7)));
    }

    function test_refresh_unspentChangesNothing() public {
        (bytes32 id,) = _record();
        vm.recordLogs();
        vm.record();
        assertFalse(fb.refresh(id));
        (, bytes32[] memory writes) = vm.accesses(address(fb));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(fb.bond(id).endedHemiBlock, 0);
    }

    function test_refresh_unknownChangesNothing() public {
        (bytes32 id, bytes memory ws) = _record();
        // nothing answers: Unknown
        HvmMock.setFail(0x48, true);
        HvmMock.setFail(0x42, true);
        vm.recordLogs();
        vm.record();
        assertFalse(fb.refresh(id));
        (, bytes32[] memory writes) = vm.accesses(address(fb));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        // 0x48 is silent and 0x42 lists it with another value: Unknown, not spent
        HvmMock.setFail(0x42, false);
        _setOne(0x42, TXID, 0, SATS + 1, _p2wsh(ws), 0);
        assertFalse(fb.refresh(id));
        // 0x48 is silent and 0x42 says in the UTXO set: Unknown
        _setOne(0x42, TXID, 0, SATS, _p2wsh(ws), 1);
        assertFalse(fb.refresh(id));
        // 0x48 is silent and the transaction is unknown to 0x42
        HvmMock.setAny(0x42, "");
        assertFalse(fb.refresh(id));
        assertEq(fb.bond(id).endedHemiBlock, 0);
        assertEq(_status(id), S_UNKNOWN);
    }

    function test_refresh_spentEnds() public {
        (bytes32 id, bytes memory ws) = _record();
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), true);
        Hvm.Header memory h = HvmMock.header(TIP_HEIGHT + 7);
        h.time = LOCKTIME + 4000;
        HvmMock.setTip(h);
        vm.roll(block.number + 9);
        vm.expectEmit(true, true, true, true, address(fb));
        emit BondEnded(id, AGENT, TIP_HEIGHT + 7, h.hash, uint64(block.number));
        vm.prank(address(0xc0ffee)); // anyone
        assertTrue(fb.refresh(id));
        FidelityBonds.Bond memory b = fb.bond(id);
        assertEq(b.endedBtcHeight, TIP_HEIGHT + 7);
        assertEq(b.endedHemiBlock, block.number);
        assertEq(b.sats, SATS); // the recorded fields stay
        assertEq(b.btcHeight, TIP_HEIGHT);
        assertEq(_status(id), S_ENDED);
        // a second refresh changes nothing
        vm.recordLogs();
        vm.record();
        assertTrue(fb.refresh(id));
        (, bytes32[] memory writes) = vm.accesses(address(fb));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        // ended is final: even if hVM later answered unspent again, the bond stays ended
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), false);
        assertEq(_status(id), S_ENDED);
    }

    function test_refresh_spentWithoutHeaderWaits() public {
        (bytes32 id, bytes memory ws) = _record();
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), true);
        HvmMock.setFail(0x44, true);
        assertFalse(fb.refresh(id));
        assertEq(fb.bond(id).endedHemiBlock, 0);
        HvmMock.setFail(0x44, false);
        assertTrue(fb.refresh(id));
    }

    // =============================================================================================
    // liveBond
    // =============================================================================================

    function test_liveBond_notRecorded() public view {
        (FidelityBonds.Status s, address agent, uint64 sats, uint32 lt) = fb.liveBond(bytes32(uint256(5)));
        assertEq(uint8(s), S_NOT_RECORDED);
        assertEq(agent, address(0));
        assertEq(sats, 0);
        assertEq(lt, 0);
    }

    function test_liveBond_liveThenExpired() public {
        (bytes32 id,) = _record();
        (FidelityBonds.Status s, address agent, uint64 sats, uint32 lt) = fb.liveBond(id);
        assertEq(uint8(s), S_LIVE);
        assertEq(agent, AGENT);
        assertEq(sats, SATS);
        assertEq(lt, LOCKTIME);
        _setTip(LOCKTIME - 1);
        assertEq(_status(id), S_LIVE);
        _setTip(LOCKTIME);
        assertEq(_status(id), S_EXPIRED);
        _setTip(LOCKTIME + 100_000);
        assertEq(_status(id), S_EXPIRED);
    }

    function test_liveBond_endedBeforeRefresh() public {
        (bytes32 id, bytes memory ws) = _record();
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), true);
        // the stored flag is not set yet, but the caller's own read sees the spend
        assertEq(fb.bond(id).endedHemiBlock, 0);
        assertEq(_status(id), S_ENDED);
        // without a header too: spent does not depend on it
        HvmMock.setFail(0x44, true);
        assertEq(_status(id), S_ENDED);
    }

    function test_liveBond_unknownIsNeverLive() public {
        (bytes32 id, bytes memory ws) = _record();
        // unspent but no header: Unknown
        HvmMock.setFail(0x44, true);
        assertEq(_status(id), S_UNKNOWN);
        HvmMock.setFail(0x44, false);
        // 0x48 answers with another value
        _setOne(0x48, TXID, 0, SATS + 1, _p2wsh(ws), 1);
        assertEq(_status(id), S_UNKNOWN);
        // 0x48 silent, 0x42 silent
        HvmMock.setFail(0x48, true);
        HvmMock.setFail(0x42, true);
        assertEq(_status(id), S_UNKNOWN);
        // malformed 0x48
        HvmMock.setFail(0x48, false);
        HvmMock.setFail(0x42, false);
        HvmMock.setAny(0x48, hex"00");
        assertEq(_status(id), S_UNKNOWN);
    }

    // =============================================================================================
    // Ids, helpers, funds
    // =============================================================================================

    function test_ids_encoding() public view {
        assertEq(fb.KIND_BOND(), keccak256("hemi-bitcoin-facts/bond"));
        bytes32 subject = keccak256(abi.encodePacked(TXID, uint16(3)));
        assertEq(fb.bondSubject(TXID, 3), subject);
        assertEq(fb.bondId(TXID, 3), keccak256(abi.encode(fb.KIND_BOND(), subject)));
        assertEq(fb.bondSubject(bytes32(0), 0x0102), keccak256(abi.encodePacked(bytes32(0), hex"0102")));
    }

    /// @dev Cross-checked with `cast keccak` and asserted again in sdk/test/bonds.test.ts.
    function test_ids_vectors() public view {
        assertEq(fb.bondId(UNSPENT_TXID, 0), 0xc0cc984bb9d0a5ee009b84a036bbdff3aa543eabcace67aeebbf4af34f818a39);
    }

    function test_helpers_matchTheFixtures() public view {
        bytes memory ws = _ws();
        assertEq(ws.length, 42);
        assertEq(fb.witnessScriptFor(LOCKTIME, PUBKEY), ws);
        assertEq(fb.bondScript(ws), _p2wsh(ws));
        assertEq(fb.tagScript(AGENT), _tag(block.chainid, address(fb), AGENT));
        assertEq(fb.tagScript(AGENT).length, fb.TAG_LENGTH());
        // the locktime is little-endian in the script: 1,800,000,000 = 0x6b49d200
        assertEq(uint8(ws[1]), 0x00);
        assertEq(uint8(ws[2]), 0xd2);
        assertEq(uint8(ws[3]), 0x49);
        assertEq(uint8(ws[4]), 0x6b);
    }

    function test_refusesEth() public {
        bytes memory ws = _bondTx(address(fb));
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(fb).call{value: 1}("");
        assertFalse(ok);
        (ok,) = address(fb).call{value: 1}(hex"deadbeef");
        assertFalse(ok);
        (ok,) = address(fb).call{value: 1}(abi.encodeCall(FidelityBonds.recordBond, (TXID, 0, 1, ws)));
        assertFalse(ok);
        (ok,) = address(fb).call(abi.encodeCall(FidelityBonds.recordBond, (TXID, 0, 1, ws)));
        assertTrue(ok);
        (ok,) = address(fb).call{value: 1}(abi.encodeCall(FidelityBonds.refresh, (fb.bondId(TXID, 0))));
        assertFalse(ok);
        assertEq(address(fb).balance, 0);
    }

    function test_unknownSelectorReverts() public {
        (bool ok,) = address(fb).call(hex"deadbeef");
        assertFalse(ok);
    }

    // =============================================================================================
    // Fuzz
    // =============================================================================================

    function testFuzz_checkBond_neverReverts(
        bytes memory r44,
        bytes memory r42,
        bytes memory r48,
        bytes memory r43,
        uint16 mode,
        bytes32 txid,
        uint16 bondVout,
        uint16 tagVout,
        bytes memory ws
    ) public {
        if (mode & 1 == 0) _bondTx(address(fb));
        if (mode & 2 != 0) HvmMock.setAny(0x44, r44);
        if (mode & 4 != 0) HvmMock.setAny(0x42, r42);
        if (mode & 8 != 0) HvmMock.setAny(0x48, r48);
        if (mode & 16 != 0) HvmMock.setAny(0x43, r43);
        if (mode & 32 != 0) HvmMock.setFail(0x42, true);
        if (mode & 64 != 0) HvmMock.setFail(0x48, true);
        if (mode & 128 != 0) HvmMock.setFail(0x43, true);
        if (mode & 256 != 0) HvmMock.setFail(0x44, true);
        if (mode & 512 != 0) {
            // aim at the real bond so the deeper steps run often
            txid = TXID;
            bondVout = uint16(bound(bondVout, 0, 3));
            tagVout = uint16(bound(tagVout, 0, 3));
            if (mode & 1024 == 0) ws = _ws();
        }
        FidelityBonds.BondCheck memory c = fb.checkBond(txid, bondVout, tagVout, ws);
        assertEq(c.bondId, fb.bondId(txid, bondVout));
        if (c.verdict == FidelityBonds.Verdict.Ok) {
            assertTrue(c.agent != address(0));
            assertGe(c.sats, fb.MIN_SATS());
            assertGe(c.confirmations, fb.MIN_CONFIRMATIONS());
            assertTrue(c.btcBlockHash != bytes32(0));
            assertEq(c.witnessProgram, sha256(ws));
            assertTrue(c.locktime >= 500_000_000 && c.locktime < (1 << 31));
            assertEq(fb.recordBond(txid, bondVout, tagVout, ws), c.bondId);
            assertEq(fb.bond(c.bondId).agent, c.agent);
        } else {
            vm.expectRevert(abi.encodeWithSelector(FidelityBonds.NotRecordable.selector, c.verdict));
            fb.recordBond(txid, bondVout, tagVout, ws);
        }
    }

    /// @dev A 42-byte script passes the template exactly when its fixed bytes are right, whatever the others hold.
    function testFuzz_witnessScriptTemplate(bytes32 a, bytes32 b, bytes10 c, bool fixBytes) public view {
        bytes memory ws = abi.encodePacked(a, c); // 42 bytes
        (b);
        if (fixBytes) {
            ws[0] = 0x04;
            ws[5] = 0xb1;
            ws[6] = 0x75;
            ws[7] = 0x21;
            ws[8] = uint8(ws[8]) % 2 == 0 ? bytes1(0x02) : bytes1(0x03);
            ws[41] = 0xac;
        }
        bool template = ws[0] == 0x04 && ws[5] == 0xb1 && ws[6] == 0x75 && ws[7] == 0x21
            && (ws[8] == 0x02 || ws[8] == 0x03) && ws[41] == 0xac;
        uint32 lt = uint32(uint8(ws[1])) | (uint32(uint8(ws[2])) << 8) | (uint32(uint8(ws[3])) << 16)
            | (uint32(uint8(ws[4])) << 24);
        uint8 want = !template ? BAD_WS : (lt < 500_000_000 || lt >= (1 << 31)) ? BAD_LT : NO_VIEW; // no 0x44 set
        assertEq(_v(ws), want);
    }

    function testFuzz_liveBond_neverReverts(bytes memory r44, bytes memory r42, bytes memory r48, uint8 mode)
        public
    {
        (bytes32 id,) = _record();
        if (mode & 1 != 0) HvmMock.setAny(0x44, r44);
        if (mode & 2 != 0) HvmMock.setAny(0x42, r42);
        if (mode & 4 != 0) HvmMock.setAny(0x48, r48);
        if (mode & 8 != 0) HvmMock.setFail(0x44, true);
        if (mode & 16 != 0) HvmMock.setFail(0x42, true);
        if (mode & 32 != 0) HvmMock.setFail(0x48, true);
        uint8 s = _status(id);
        // Live needs 0x48's exact answer and a header before the locktime
        if (s == S_LIVE) {
            assertTrue(mode & 4 == 0 || keccak256(r48) == keccak256(abi.encodePacked(SATS, uint16(34), _p2wsh(_ws()), uint8(1))));
            assertTrue(mode & 32 == 0);
            assertTrue(mode & 8 == 0);
        }
        assertTrue(s != S_NOT_RECORDED);
        bool ended = fb.refresh(id);
        assertEq(ended, fb.bond(id).endedHemiBlock != 0);
        if (ended) assertEq(_status(id), S_ENDED);
    }

    // =============================================================================================
    // Gas (with MockHvm; indicative only — check-live.sh and the SDK e2e measure eth_estimateGas)
    // =============================================================================================

    function test_gas_calls() public {
        bytes memory ws = _bondTx(address(fb));
        uint256 g = gasleft();
        fb.checkBond(TXID, 0, 1, ws);
        console2.log("gas checkBond Ok (MockHvm):          ", g - gasleft());
        g = gasleft();
        bytes32 id = fb.recordBond(TXID, 0, 1, ws);
        console2.log("gas recordBond (MockHvm):            ", g - gasleft());
        g = gasleft();
        fb.recordBond(TXID, 0, 1, ws);
        console2.log("gas recordBond again, no-op (MockHvm):", g - gasleft());
        g = gasleft();
        fb.liveBond(id);
        console2.log("gas liveBond Live (MockHvm):          ", g - gasleft());
        g = gasleft();
        fb.refresh(id);
        console2.log("gas refresh, unspent no-op (MockHvm): ", g - gasleft());
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), true);
        g = gasleft();
        fb.liveBond(id);
        console2.log("gas liveBond spent, not refreshed:    ", g - gasleft());
        g = gasleft();
        fb.refresh(id);
        console2.log("gas refresh, spent -> ended (MockHvm):", g - gasleft());
        g = gasleft();
        fb.liveBond(id);
        console2.log("gas liveBond Ended (stored):          ", g - gasleft());
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
}

/// @notice Fork test: real Hemi mainnet state (the CREATE2 deployer, chain id 43111), MockHvm in place of the
/// precompiles. As in BitcoinFactsForkTest, the mocks are configured before forking and marked persistent, so their
/// state stays local. The tag names the CREATE2 address the deploy script will use and chain 43111.
contract FidelityBondsForkTest is BondFixtures {
    function test_fork_deployRecordLiveRefresh() public {
        HvmMock.install();
        uint64[10] memory nonceBefore;
        for (uint160 p = 0x40; p <= 0x49; ++p) nonceBefore[p - 0x40] = vm.getNonce(address(p));

        address predicted =
            Deployments.create2Address(Deployments.FIDELITY_BONDS_SALT, type(FidelityBonds).creationCode);
        bytes memory ws = _ws();
        _setTip(TIP_TIME);
        HvmMock.setOutput(TXID, 0, SATS, _p2wsh(ws), false);
        HvmMock.setOutput(TXID, 1, 0, _tag(Deployments.HEMI_MAINNET, predicted, AGENT), true);
        HvmMock.setOutput(TXID, 2, 5_000, CHANGE_SCRIPT, false);
        HvmMock.setConfirmations(TXID, 6);
        for (uint160 p = 0x40; p <= 0x49; ++p) {
            vm.makePersistent(address(p));
            for (uint64 n = nonceBefore[p - 0x40]; n < vm.getNonce(address(p)); ++n) {
                vm.makePersistent(vm.computeCreateAddress(address(p), n));
            }
        }
        Deploy d = new Deploy();
        vm.makePersistent(address(d));
        vm.makePersistent(predicted);
        vm.makePersistent(Deployments.create2Address(Deployments.BITCOIN_FACTS_SALT, d.targets()[0].initCode));

        vm.createSelectFork(vm.envOr("HEMI_FORK_URL", string("hemi")));
        // A bond reads Expired once Hemi's own clock reaches its locktime (independent audit, finding 1): pin the fork's clock a
        // day before LOCKTIME so this test does not start failing on 2027-01-15 (audit-fixes review R-1).
        vm.warp(uint256(LOCKTIME) - 1 days);
        assertEq(block.chainid, Deployments.HEMI_MAINNET);
        assertEq(Deployments.CREATE2_DEPLOYER.codehash, Deployments.CREATE2_DEPLOYER_CODEHASH);

        address[] memory addrs = d.deployAll(false);
        assertEq(addrs.length, 3);
        FidelityBonds fb = FidelityBonds(addrs[2]);
        assertEq(address(fb), predicted);
        assertGt(address(fb).code.length, 0);

        FidelityBonds.BondCheck memory c = fb.checkBond(TXID, 0, 1, ws);
        assertEq(uint8(c.verdict), uint8(FidelityBonds.Verdict.Ok));
        assertEq(c.agent, AGENT);
        bytes32 id = fb.recordBond(TXID, 0, 1, ws);
        assertEq(id, fb.bondId(TXID, 0));
        assertEq(fb.bond(id).hemiBlock, block.number);
        (FidelityBonds.Status s, address agent,,) = fb.liveBond(id);
        assertEq(uint8(s), uint8(FidelityBonds.Status.Live));
        assertEq(agent, AGENT);
        assertEq(fb.recordBond(TXID, 0, 1, ws), id); // idempotent on the fork too

        // spent: 0x48 now gives no answer and 0x42 lists the output with UTXO byte 0x00 (a mode bit and one raw
        // answer in the persistent mocks)
        HvmMock.setFail(0x48, true);
        HvmMock.setRaw(0x42, abi.encodePacked(TXID, Hvm.TX_FLAGS_OUTPUTS), _spentListing(ws, predicted));
        (s,,,) = fb.liveBond(id);
        assertEq(uint8(s), uint8(FidelityBonds.Status.Ended));
        assertTrue(fb.refresh(id));
        assertEq(fb.bond(id).endedBtcHeight, TIP_HEIGHT);
        assertEq(fb.bond(id).endedHemiBlock, block.number);
    }

    /// @dev 0x42's answer once the bond output is spent: UTXO byte 0x00 on it.
    function _spentListing(bytes memory ws, address registry) internal view returns (bytes memory) {
        return abi.encodePacked(
            uint16(3),
            abi.encodePacked(SATS, uint16(34), _p2wsh(ws), uint8(0)),
            abi.encodePacked(uint64(0), uint16(50), _tag(Deployments.HEMI_MAINNET, registry, AGENT), uint8(0)),
            abi.encodePacked(uint64(5_000), uint16(22), CHANGE_SCRIPT, uint8(1))
        );
    }
}
