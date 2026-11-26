// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {Hvm} from "../src/Hvm.sol";
import {BitcoinFacts} from "../src/BitcoinFacts.sol";
import {PopFinality} from "../src/PopFinality.sol";
import {Deploy, Deployments} from "../script/Deploy.s.sol";
import {HvmMock} from "./utils/HvmMock.sol";

/// @dev Exposes the abrev parser for direct tests.
contract PopFinalityHarness is PopFinality {
    function parseAbrev(bytes memory a) external pure returns (Keystone memory) {
        return _parseAbrev(a);
    }

    function blockHashOf(uint256 n) external view returns (bytes32) {
        return _blockHash(n);
    }
}

/// @dev A history contract that returns 64 bytes.
contract LongAnswer {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(bytes32(uint256(1)), bytes32(uint256(2)));
    }
}

/// @dev A history contract that spins until it runs out of gas.
contract Spinner {
    fallback(bytes calldata) external returns (bytes memory) {
        uint256 i;
        while (gasleft() > 0) ++i;
        return abi.encode(i);
    }
}

/// @dev Mainnet PoP fixtures (docs/BRIEF.md; DECISIONS.md D-003; re-read read-only on 2026-11-21).
abstract contract PopFixtures {
    uint32 internal constant TIP_HEIGHT = 976_833;
    bytes32 internal constant TIP_HASH = 0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a;

    /// Keystone 5620225, published by d4ed6ec2…845e (Bitcoin block 973746), vout 1.
    uint256 internal constant K1 = 5_620_225;
    bytes32 internal constant K1_HASH = 0x60d1b3e5d6c873e1408ddef4f2b6736366484b781f704d45c501f883e85cc4d4;
    bytes32 internal constant POP1 = 0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e;
    bytes internal constant ABREV1 =
        hex"01019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef4";
    /// cast call 0x…42 0xd4ed…845e003c0703 --rpc-url https://rpc.hemi.network/rpc
    bytes internal constant POP1_TX_OUTPUTS =
        hex"00020000000000004510001976a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac00000000000000000000536a4c5048454d4901019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef400";
    uint32 internal constant POP1_CONFS = 3101;

    /// Keystone 5734725, published by c6835b0e…6a23 (Bitcoin block 975836), vout 1.
    uint256 internal constant K2 = 5_734_725;
    bytes32 internal constant K2_HASH = 0xaba3a4a528a1d75f06c9401803c6cc67cc79fb2f28549856c65bfbc42f624743;
    bytes32 internal constant POP2 = 0xc6835b0e6675122e8ccf103d361af4ef1c7d4883d46e48c1be91a858e66c6a23;
    bytes internal constant ABREV2 =
        hex"010193107000578145bafef2e72dafe581470b89f044fc1222471baa496ca1c2ba645ee626c1fa5b66f2bebcb60c08d627533446263043bfd39c965c66b011ffaba3a4a528a1d75f06c94018";
    bytes internal constant POP2_TX_OUTPUTS =
        hex"00020000000000006dca001976a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac00000000000000000000536a4c5048454d49010193107000578145bafef2e72dafe581470b89f044fc1222471baa496ca1c2ba645ee626c1fa5b66f2bebcb60c08d627533446263043bfd39c965c66b011ffaba3a4a528a1d75f06c9401800";
    uint32 internal constant POP2_CONFS = 1011;

    bytes7 internal constant PREFIX = 0x6a4c5048454d49;
    bytes internal constant P2PKH_OUT = hex"0000000000004510001976a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac00";
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    /// cast code 0x0000F90827F1C53a10cb7A02335B175320002935 --rpc-url https://rpc.hemi.network/rpc (D-008)
    bytes internal constant HISTORY_CODE =
        hex"3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";

    function _tip() internal pure returns (Hvm.Header memory h) {
        h = HvmMock.header(TIP_HEIGHT);
        h.hash = TIP_HASH;
    }

    function _mainnetPops() internal {
        HvmMock.setTip(_tip());
        HvmMock.setRaw(0x42, abi.encodePacked(POP1, Hvm.TX_FLAGS_OUTPUTS), POP1_TX_OUTPUTS);
        HvmMock.setConfirmations(POP1, POP1_CONFS);
        HvmMock.setRaw(0x42, abi.encodePacked(POP2, Hvm.TX_FLAGS_OUTPUTS), POP2_TX_OUTPUTS);
        HvmMock.setConfirmations(POP2, POP2_CONFS);
    }

    /// @dev The packed checkpoint slot value: blockHashPrefix in the low 12 bytes, hemiBlock above it.
    function _checkpointWord(bytes32 blockHash, uint64 hemiBlock) internal pure returns (bytes32) {
        return bytes32(uint256(uint96(bytes12(blockHash))) | (uint256(hemiBlock) << 96));
    }

    function _checkpointSlot(uint256 k) internal pure returns (bytes32) {
        return keccak256(abi.encode(k, uint256(0)));
    }

    /// @dev The first of a stored publication's three slots: `_publications` (slot 1) is keyed by its subject.
    function _publicationSlot(uint256 k, bytes32 txid, uint16 vout) internal pure returns (bytes32) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return keccak256(abi.encode(keccak256(abi.encodePacked(uint32(k), txid, vout)), uint256(1)));
    }

    /// @dev K's best pointer: `_best` (slot 2) holds the best publication's subject.
    function _bestSlot(uint256 k) internal pure returns (bytes32) {
        return keccak256(abi.encode(k, uint256(2)));
    }

    function _subject(uint256 k, bytes32 txid, uint16 vout) internal pure returns (bytes32) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return keccak256(abi.encodePacked(uint32(k), txid, vout));
    }

    /// @dev A 0x42 answer (flags 003c0703) for a two-output PoP transaction: the P2PKH, then `script` at vout 1.
    function _popTx(bytes memory script, uint8 utxoByte) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(2), P2PKH_OUT, uint64(0), uint16(script.length), script, utxoByte);
    }

    /// @dev An 83-byte PoP script for keystone k with the given block hash, version 1, filler elsewhere.
    function _popScript(uint256 k, bytes32 blockHash) internal pure returns (bytes memory) {
        return abi.encodePacked(PREFIX, _abrev(1, k, blockHash));
    }

    function _abrev(uint8 version, uint256 k, bytes32 blockHash) internal pure returns (bytes memory) {
        return abi.encodePacked(
            version,
            uint32(26_301_090),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint32(k),
            bytes11(keccak256("parent")),
            bytes12(keccak256("prev")),
            keccak256("state"),
            bytes12(blockHash)
        );
    }
}

contract PopFinalityTest is Test, PopFixtures {
    PopFinality internal p;
    PopFinalityHarness internal harness;

    event Checkpointed(uint256 indexed keystone, bytes12 blockHashPrefix, uint64 hemiBlock);
    event PublicationRecorded(
        bytes32 indexed id,
        uint256 indexed keystone,
        bytes32 indexed btcTxid,
        uint16 vout,
        uint32 confirmations,
        uint32 btcHeight,
        bytes32 btcBlockHash,
        uint64 hemiBlock,
        bytes abrev
    );
    event BestPublicationChanged(
        uint256 indexed keystone,
        bytes32 indexed btcTxid,
        uint16 vout,
        uint32 confirmations,
        bytes32 previousTxid,
        uint16 previousVout
    );

    uint8 internal constant OK = uint8(PopFinality.Verdict.Ok);
    uint8 internal constant NOT_KEYSTONE = uint8(PopFinality.Verdict.NotKeystone);
    uint8 internal constant NOT_PRODUCED = uint8(PopFinality.Verdict.NotProduced);
    uint8 internal constant OUTSIDE = uint8(PopFinality.Verdict.OutsideWindow);
    uint8 internal constant NO_VIEW = uint8(PopFinality.Verdict.NoBitcoinView);
    uint8 internal constant NOT_FOUND = uint8(PopFinality.Verdict.NotFound);
    uint8 internal constant VOUT_TOO_HIGH = uint8(PopFinality.Verdict.VoutTooHigh);
    uint8 internal constant WRONG_LENGTH = uint8(PopFinality.Verdict.WrongLength);
    uint8 internal constant WRONG_PREFIX = uint8(PopFinality.Verdict.WrongPrefix);
    uint8 internal constant INCONSISTENT = uint8(PopFinality.Verdict.Inconsistent);
    uint8 internal constant WRONG_VERSION = uint8(PopFinality.Verdict.WrongVersion);
    uint8 internal constant WRONG_KEYSTONE = uint8(PopFinality.Verdict.WrongKeystone);
    uint8 internal constant WRONG_HASH = uint8(PopFinality.Verdict.WrongBlockHash);
    uint8 internal constant NO_CONFS = uint8(PopFinality.Verdict.NoConfirmations);
    uint8 internal constant NOT_COVERING = uint8(PopFinality.Verdict.NotCovering);
    uint8 internal constant NOT_RECORDED = uint8(PopFinality.Verdict.NotRecorded);

    function setUp() public {
        HvmMock.install();
        p = new PopFinality();
        harness = new PopFinalityHarness();
        // Hemi today: block K2 + about 46,000; both fixture keystones are far outside every window.
        vm.roll(5_780_884);
    }

    function _v(PopFinality.Verdict v) internal pure returns (uint8) {
        return uint8(v);
    }

    function _pubVerdict(uint256 k, bytes32 txid, uint16 vout) internal view returns (uint8) {
        return _v(p.checkPublication(k, txid, vout).verdict);
    }

    function _cpVerdict(uint256 k) internal view returns (uint8 v) {
        (PopFinality.Verdict verdict,,) = p.checkCheckpoint(k);
        return _v(verdict);
    }

    function _storeCheckpoint(uint256 k, bytes32 blockHash) internal {
        vm.store(address(p), _checkpointSlot(k), _checkpointWord(blockHash, 1));
    }

    function _etchHistory() internal {
        vm.etch(HISTORY, HISTORY_CODE);
    }

    /// @dev What the EIP-2935 contract holds for block n: its ring buffer slot n % 8191.
    function _setHistory(uint256 n, bytes32 h) internal {
        vm.store(HISTORY, bytes32(n % 8191), h);
    }

    // =============================================================================================
    // checkpoint
    // =============================================================================================

    function test_checkpoint_blockhash() public {
        uint256 k = 5_780_850;
        bytes32 h = keccak256("block 5780850");
        vm.setBlockhash(k, h);
        (PopFinality.Verdict v, bytes12 prefix, bool stored) = p.checkCheckpoint(k);
        assertEq(_v(v), OK);
        assertEq(prefix, bytes12(h));
        assertFalse(stored);

        vm.expectEmit(true, true, true, true, address(p));
        emit Checkpointed(k, bytes12(h), uint64(block.number));
        assertEq(p.checkpoint(k), bytes12(h));
        PopFinality.Checkpoint memory c = p.checkpointOf(k);
        assertEq(c.blockHashPrefix, bytes12(h));
        assertEq(c.hemiBlock, block.number);
        (,, stored) = p.checkCheckpoint(k);
        assertTrue(stored);
        // the slot layout check-live.sh and the e2e test write by state override
        assertEq(vm.load(address(p), _checkpointSlot(k)), _checkpointWord(h, uint64(block.number)));
    }

    function test_checkpoint_blockhashWindowEdges() public {
        _etchHistory();
        bytes32 h = keccak256("edge");
        // age 256: blockhash
        uint256 k = 5_780_625;
        vm.roll(k + 256);
        vm.setBlockhash(k, h);
        assertEq(harness.blockHashOf(k), h);
        assertEq(_cpVerdict(k), OK);
        // age 257: blockhash gives 0, so the history contract answers
        vm.roll(k + 257);
        assertEq(harness.blockHashOf(k), bytes32(0));
        assertEq(_cpVerdict(k), OUTSIDE); // nothing in its slot yet
        _setHistory(k, h);
        assertEq(harness.blockHashOf(k), h);
        (PopFinality.Verdict v, bytes12 prefix,) = p.checkCheckpoint(k);
        assertEq(_v(v), OK);
        assertEq(prefix, bytes12(h));
    }

    function test_checkpoint_history() public {
        _etchHistory();
        uint256 k = 5_779_875; // 1,009 blocks back
        bytes32 h = keccak256("block 5779875");
        _setHistory(k, h);
        vm.expectEmit(true, true, true, true, address(p));
        emit Checkpointed(k, bytes12(h), uint64(block.number));
        assertEq(p.checkpoint(k), bytes12(h));
        assertEq(p.checkpointOf(k).blockHashPrefix, bytes12(h));
    }

    function test_checkpoint_historyWindowEdges() public {
        _etchHistory();
        bytes32 h = keccak256("old");
        uint256 k = 5_772_675;
        _setHistory(k, h);
        // age 8,191: the last block the history contract serves
        vm.roll(k + 8191);
        assertEq(_cpVerdict(k), OK);
        // age 8,192: it reverts; nothing else reaches that far
        vm.roll(k + 8192);
        assertEq(_cpVerdict(k), OUTSIDE);
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.OutsideWindow));
        p.checkpoint(k);
        // a stored checkpoint outlives the window
        vm.roll(k + 8191);
        p.checkpoint(k);
        vm.roll(k + 1_000_000);
        (PopFinality.Verdict v, bytes12 prefix, bool stored) = p.checkCheckpoint(k);
        assertEq(_v(v), OK);
        assertEq(prefix, bytes12(h));
        assertTrue(stored);
    }

    function test_checkpoint_beyondBothWindows() public {
        // the fixtures: tens of thousands of blocks back, history contract present or not
        assertEq(_cpVerdict(K1), OUTSIDE);
        _etchHistory();
        _setHistory(K1, K1_HASH); // even with its slot holding the right value, the window check refuses
        assertEq(_cpVerdict(K1), OUTSIDE);
        assertEq(_cpVerdict(K2), OUTSIDE);
    }

    function test_checkpoint_historyMissingOrOdd() public {
        uint256 k = 5_779_875;
        // no code at the history address
        assertEq(_cpVerdict(k), OUTSIDE);
        // a slot that was never written answers zero: no hash
        _etchHistory();
        assertEq(_cpVerdict(k), OUTSIDE);
        // an answer that is not 32 bytes
        vm.etch(HISTORY, type(LongAnswer).runtimeCode);
        assertEq(_cpVerdict(k), OUTSIDE);
        // a callee that burns its gas: capped
        vm.etch(HISTORY, type(Spinner).runtimeCode);
        uint256 g = gasleft();
        assertEq(_cpVerdict(k), OUTSIDE);
        assertLt(g - gasleft(), 30_000);
    }

    function test_checkpoint_notKeystoneNotProduced() public {
        assertEq(_cpVerdict(0), NOT_KEYSTONE);
        assertEq(_cpVerdict(24), NOT_KEYSTONE);
        assertEq(_cpVerdict(K1 + 1), NOT_KEYSTONE);
        assertEq(_cpVerdict(4_294_967_300), NOT_KEYSTONE); // a multiple of 25 above 2^32 - 1
        assertEq(_cpVerdict(type(uint256).max), NOT_KEYSTONE);
        assertEq(_cpVerdict(5_780_875), OK); // 9 blocks back, blockhash
        vm.roll(5_780_875);
        assertEq(_cpVerdict(5_780_875), NOT_PRODUCED); // the current block
        assertEq(_cpVerdict(5_780_900), NOT_PRODUCED);
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.NotKeystone));
        p.checkpoint(24);
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.NotProduced));
        p.checkpoint(5_780_900);
    }

    function test_checkpoint_idempotent() public {
        uint256 k = 5_780_850;
        bytes32 h = keccak256("x");
        vm.setBlockhash(k, h);
        p.checkpoint(k);
        uint256 at = vm.getBlockNumber();
        vm.roll(at + 5);
        vm.setBlockhash(k, keccak256("a reorg the checkpoint cannot see"));
        vm.recordLogs();
        vm.record();
        assertEq(p.checkpoint(k), bytes12(h));
        (, bytes32[] memory writes) = vm.accesses(address(p));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(p.checkpointOf(k).hemiBlock, at);
    }

    // =============================================================================================
    // checkPublication: Ok on the real fixtures
    // =============================================================================================

    function test_checkPublication_realFixture() public {
        _mainnetPops();
        _storeCheckpoint(K1, K1_HASH);
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, POP1, 1);
        assertEq(_v(c.verdict), OK);
        assertEq(c.confirmations, POP1_CONFS);
        assertEq(c.btcHeight, TIP_HEIGHT);
        assertEq(c.btcBlockHash, TIP_HASH);
        assertEq(c.checkpoint, bytes12(K1_HASH));
        assertTrue(c.checkpointStored);
        assertEq(c.abrev, ABREV1);
        assertEq(c.id, p.publicationId(uint32(K1), POP1, 1, TIP_HASH));
        assertFalse(c.recorded);
        assertFalse(c.best);
        assertTrue(c.becomesBest);
        assertEq(c.bestTxid, bytes32(0));
        // parsed: the values D-003 rebuilt from Hemi RPC
        assertEq(c.keystone.version, 1);
        assertEq(c.keystone.l1Number, 26_301_090);
        assertEq(c.keystone.l2Number, K1);
        assertEq(c.keystone.parentHashPrefix, bytes11(0x04ddfaf81653745406b60e));
        assertEq(c.keystone.prevKeystoneHashPrefix, bytes12(0x74126bbe37be01ec07b30197)); // block 5620200
        assertEq(c.keystone.stateRoot, 0x76d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb7933);
        assertEq(c.keystone.blockHashPrefix, bytes12(K1_HASH));

        _storeCheckpoint(K2, K2_HASH);
        c = p.checkPublication(K2, POP2, 1);
        assertEq(_v(c.verdict), OK);
        assertEq(c.confirmations, POP2_CONFS);
        assertEq(c.keystone.l1Number, 26_415_216);
        assertEq(c.keystone.l2Number, K2);
        assertEq(c.keystone.blockHashPrefix, bytes12(K2_HASH));
    }

    function test_checkPublication_checkpointReadNow() public {
        // no stored checkpoint, but block k's hash is still readable: Ok, and the check says record would store it
        HvmMock.setTip(_tip());
        uint256 k = 5_780_850;
        bytes32 h = keccak256("recent");
        vm.setBlockhash(k, h);
        bytes32 txid = keccak256("pop");
        HvmMock.setRaw(0x42, abi.encodePacked(txid, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(k, h), 0));
        HvmMock.setConfirmations(txid, 4);
        PopFinality.PublicationCheck memory c = p.checkPublication(k, txid, 1);
        assertEq(_v(c.verdict), OK);
        assertEq(c.checkpoint, bytes12(h));
        assertFalse(c.checkpointStored);
        assertTrue(c.becomesBest);
    }

    function test_parseAbrev() public view {
        PopFinality.Keystone memory k = harness.parseAbrev(ABREV2);
        assertEq(k.version, 1);
        assertEq(k.l1Number, 0x01931070);
        assertEq(k.l2Number, 0x00578145);
        assertEq(k.parentHashPrefix, bytes11(0xbafef2e72dafe581470b89));
        assertEq(k.prevKeystoneHashPrefix, bytes12(0xf044fc1222471baa496ca1c2));
        assertEq(k.stateRoot, 0xba645ee626c1fa5b66f2bebcb60c08d627533446263043bfd39c965c66b011ff);
        assertEq(k.blockHashPrefix, bytes12(0xaba3a4a528a1d75f06c94018));
    }

    // =============================================================================================
    // checkPublication: every other verdict
    // =============================================================================================

    function test_checkPublication_notKeystoneNotProduced() public {
        _mainnetPops();
        assertEq(_pubVerdict(0, POP1, 1), NOT_KEYSTONE);
        assertEq(_pubVerdict(K1 + 1, POP1, 1), NOT_KEYSTONE);
        assertEq(_pubVerdict(4_294_967_300, POP1, 1), NOT_KEYSTONE);
        assertEq(_pubVerdict(5_780_900, POP1, 1), NOT_PRODUCED);
    }

    function test_checkPublication_noBitcoinView() public {
        HvmMock.setRaw(0x42, abi.encodePacked(POP1, Hvm.TX_FLAGS_OUTPUTS), POP1_TX_OUTPUTS);
        HvmMock.setConfirmations(POP1, POP1_CONFS);
        _storeCheckpoint(K1, K1_HASH);
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, POP1, 1);
        assertEq(_v(c.verdict), NO_VIEW);
        assertEq(c.id, bytes32(0));
        HvmMock.setAny(0x44, new bytes(115));
        assertEq(_pubVerdict(K1, POP1, 1), NO_VIEW);
    }

    function test_checkPublication_notFound() public {
        _mainnetPops();
        _storeCheckpoint(K1, K1_HASH);
        // an unknown txid: 0x42 has no answer and 0x43 is never called (its failure would burn its cap)
        HvmMock.setFail(0x43, true);
        uint256 g = gasleft();
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, keccak256("unknown"), 1);
        assertLt(g - gasleft(), 80_000);
        assertEq(_v(c.verdict), NOT_FOUND);
        assertEq(c.btcHeight, TIP_HEIGHT); // filled as far as the check got
        // vout at or past the output count
        assertEq(_pubVerdict(K1, POP1, 2), NOT_FOUND);
        assertEq(_pubVerdict(K1, POP1, type(uint16).max), NOT_FOUND);
    }

    function test_checkPublication_malformed0x42() public {
        HvmMock.setTip(_tip());
        _storeCheckpoint(K1, K1_HASH);
        bytes32 t1 = keccak256("t1");
        bytes32 t2 = keccak256("t2");
        bytes32 t3 = keccak256("t3");
        bytes32 t4 = keccak256("t4");
        bytes32 t5 = keccak256("t5");
        // truncated by one byte
        bytes memory cut = new bytes(POP1_TX_OUTPUTS.length - 1);
        for (uint256 i; i < cut.length; ++i) {
            cut[i] = POP1_TX_OUTPUTS[i];
        }
        HvmMock.setRaw(0x42, abi.encodePacked(t1, Hvm.TX_FLAGS_OUTPUTS), cut);
        // one trailing byte
        HvmMock.setRaw(0x42, abi.encodePacked(t2, Hvm.TX_FLAGS_OUTPUTS), abi.encodePacked(POP1_TX_OUTPUTS, hex"00"));
        // UTXO byte 2
        HvmMock.setRaw(0x42, abi.encodePacked(t3, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(K1, K1_HASH), 2));
        // one byte; count 0
        HvmMock.setRaw(0x42, abi.encodePacked(t4, Hvm.TX_FLAGS_OUTPUTS), hex"00");
        HvmMock.setRaw(0x42, abi.encodePacked(t5, Hvm.TX_FLAGS_OUTPUTS), hex"0000");
        for (uint256 i; i < 5; ++i) {
            bytes32 t = [t1, t2, t3, t4, t5][i];
            HvmMock.setConfirmations(t, 5);
            assertEq(_pubVerdict(K1, t, 1), NOT_FOUND);
        }
        // a failing 0x42
        HvmMock.setFail(0x42, true);
        HvmMock.setConfirmations(POP1, 5);
        assertEq(_pubVerdict(K1, POP1, 1), NOT_FOUND);
    }

    function test_checkPublication_voutTooHigh() public {
        HvmMock.setTip(_tip());
        _storeCheckpoint(K1, K1_HASH);
        bytes32 t = keccak256("wide");
        // 200 outputs, the first 128 listed (1-sat outputs with an empty script)
        bytes memory r = abi.encodePacked(uint16(200));
        for (uint256 i; i < 128; ++i) {
            r = abi.encodePacked(r, uint64(1), uint16(0), uint8(0));
        }
        HvmMock.setRaw(0x42, abi.encodePacked(t, Hvm.TX_FLAGS_OUTPUTS), r);
        HvmMock.setConfirmations(t, 5);
        assertEq(_pubVerdict(K1, t, 150), VOUT_TOO_HIGH);
        assertEq(_pubVerdict(K1, t, 128), VOUT_TOO_HIGH);
        assertEq(_pubVerdict(K1, t, 127), WRONG_LENGTH);
        assertEq(_pubVerdict(K1, t, 200), NOT_FOUND);
    }

    function test_checkPublication_wrongLength() public {
        _mainnetPops();
        _storeCheckpoint(K1, K1_HASH);
        // the P2PKH output of the PoP transaction
        assertEq(_pubVerdict(K1, POP1, 0), WRONG_LENGTH);
        HvmMock.setConfirmations(keccak256("82"), 5);
        HvmMock.setConfirmations(keccak256("84"), 5);
        bytes memory s = _popScript(K1, K1_HASH);
        bytes memory short = new bytes(82);
        for (uint256 i; i < 82; ++i) {
            short[i] = s[i];
        }
        HvmMock.setRaw(0x42, abi.encodePacked(keccak256("82"), Hvm.TX_FLAGS_OUTPUTS), _popTx(short, 0));
        HvmMock.setRaw(
            0x42, abi.encodePacked(keccak256("84"), Hvm.TX_FLAGS_OUTPUTS), _popTx(abi.encodePacked(s, hex"00"), 0)
        );
        assertEq(_pubVerdict(K1, keccak256("82"), 1), WRONG_LENGTH);
        assertEq(_pubVerdict(K1, keccak256("84"), 1), WRONG_LENGTH);
        // a 300-byte OP_RETURN: listed cut at 128 bytes
        HvmMock.setOutput(keccak256("300"), 0, 0, abi.encodePacked(s, new bytes(217)), true);
        HvmMock.setConfirmations(keccak256("300"), 5);
        assertEq(_pubVerdict(K1, keccak256("300"), 0), WRONG_LENGTH);
    }

    function test_checkPublication_wrongPrefix() public {
        HvmMock.setTip(_tip());
        _storeCheckpoint(K1, K1_HASH);
        bytes memory good = _popScript(K1, K1_HASH);
        // "HEMJ", a different push opcode, a non-OP_RETURN first byte
        uint8[3] memory at = [uint8(6), 1, 0];
        bytes1[3] memory to = [bytes1(0x4a), 0x4d, 0x00];
        for (uint256 i; i < 3; ++i) {
            bytes memory s = bytes.concat(good);
            s[at[i]] = to[i];
            bytes32 t = keccak256(abi.encode("prefix", i));
            HvmMock.setRaw(0x42, abi.encodePacked(t, Hvm.TX_FLAGS_OUTPUTS), _popTx(s, 0));
            HvmMock.setConfirmations(t, 5);
            assertEq(_pubVerdict(K1, t, 1), WRONG_PREFIX);
        }
    }

    function test_checkPublication_inconsistent() public {
        HvmMock.setTip(_tip());
        _storeCheckpoint(K1, K1_HASH);
        bytes32 t = keccak256("in utxo set");
        HvmMock.setRaw(0x42, abi.encodePacked(t, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(K1, K1_HASH), 1));
        HvmMock.setConfirmations(t, 5);
        assertEq(_pubVerdict(K1, t, 1), INCONSISTENT);
    }

    function test_checkPublication_wrongVersion() public {
        HvmMock.setTip(_tip());
        _storeCheckpoint(K1, K1_HASH);
        bytes32 t = keccak256("v2");
        HvmMock.setRaw(
            0x42, abi.encodePacked(t, Hvm.TX_FLAGS_OUTPUTS), _popTx(abi.encodePacked(PREFIX, _abrev(2, K1, K1_HASH)), 0)
        );
        HvmMock.setConfirmations(t, 5);
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, t, 1);
        assertEq(_v(c.verdict), WRONG_VERSION);
        assertEq(c.keystone.version, 2);
    }

    function test_checkPublication_wrongKeystone() public {
        _mainnetPops();
        _storeCheckpoint(K1, K1_HASH);
        _storeCheckpoint(K2, K2_HASH);
        // the real publication of K1 offered as K2's, and the other way round
        assertEq(_pubVerdict(K2, POP1, 1), WRONG_KEYSTONE);
        assertEq(_pubVerdict(K1, POP2, 1), WRONG_KEYSTONE);
        // the next keystone's number with K1's hash
        bytes32 t = keccak256("k+25");
        HvmMock.setRaw(0x42, abi.encodePacked(t, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(K1 + 25, K1_HASH), 0));
        HvmMock.setConfirmations(t, 5);
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, t, 1);
        assertEq(_v(c.verdict), WRONG_KEYSTONE);
        assertEq(c.keystone.l2Number, K1 + 25);
    }

    function test_checkPublication_outsideWindow() public {
        _mainnetPops();
        // no checkpoint for K1, and block K1 is ~160,000 blocks back
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, POP1, 1);
        assertEq(_v(c.verdict), OUTSIDE);
        assertEq(c.keystone.l2Number, K1); // parsed before the comparison
        assertEq(c.abrev, ABREV1);
    }

    function test_checkPublication_wrongBlockHash() public {
        _mainnetPops();
        _storeCheckpoint(K1, K2_HASH);
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, POP1, 1);
        assertEq(_v(c.verdict), WRONG_HASH);
        assertEq(c.checkpoint, bytes12(K2_HASH));
        // one bit off in the last byte of the prefix
        _storeCheckpoint(K1, bytes32(uint256(K1_HASH) ^ (uint256(1) << 160)));
        assertEq(_pubVerdict(K1, POP1, 1), WRONG_HASH);
        // the hash read now (no stored checkpoint) is compared the same way
        HvmMock.setTip(_tip());
        uint256 k = 5_780_850;
        vm.setBlockhash(k, keccak256("real"));
        bytes32 t = keccak256("forged");
        HvmMock.setRaw(0x42, abi.encodePacked(t, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(k, keccak256("fake")), 0));
        HvmMock.setConfirmations(t, 5);
        assertEq(_pubVerdict(k, t, 1), WRONG_HASH);
    }

    function test_checkPublication_noConfirmations() public {
        HvmMock.setTip(_tip());
        HvmMock.setRaw(0x42, abi.encodePacked(POP1, Hvm.TX_FLAGS_OUTPUTS), POP1_TX_OUTPUTS);
        _storeCheckpoint(K1, K1_HASH);
        // 0x43 fails: its cap is burnt, no more
        uint256 g = gasleft();
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, POP1, 1);
        assertLt(g - gasleft(), 120_000);
        assertEq(_v(c.verdict), NO_CONFS);
        assertEq(c.abrev, ABREV1);
        // zero, an underflowed count, one past the bound; the bound itself is Ok
        HvmMock.setConfirmations(POP1, 0);
        assertEq(_pubVerdict(K1, POP1, 1), NO_CONFS);
        HvmMock.setConfirmations(POP1, type(uint32).max - 3);
        assertEq(_pubVerdict(K1, POP1, 1), NO_CONFS);
        HvmMock.setConfirmations(POP1, TIP_HEIGHT + 1001);
        assertEq(_pubVerdict(K1, POP1, 1), NO_CONFS);
        HvmMock.setConfirmations(POP1, TIP_HEIGHT + 1000);
        assertEq(_pubVerdict(K1, POP1, 1), OK);
        // wrong-length answers
        HvmMock.setAny(0x43, hex"000009");
        assertEq(_pubVerdict(K1, POP1, 1), NO_CONFS);
    }

    // =============================================================================================
    // recordPublication
    // =============================================================================================

    function test_record_storesAndEmitsEveryField() public {
        _mainnetPops();
        _storeCheckpoint(K1, K1_HASH);
        bytes32 id = p.publicationId(uint32(K1), POP1, 1, TIP_HASH);
        vm.expectEmit(true, true, true, true, address(p));
        emit PublicationRecorded(id, K1, POP1, 1, POP1_CONFS, TIP_HEIGHT, TIP_HASH, uint64(block.number), ABREV1);
        vm.expectEmit(true, true, true, true, address(p));
        emit BestPublicationChanged(K1, POP1, 1, POP1_CONFS, bytes32(0), 0);
        (bool created, bool best) = p.recordPublication(K1, POP1, 1);
        assertTrue(created);
        assertTrue(best);
        PopFinality.Publication memory s = p.publicationOf(K1, POP1, 1);
        assertEq(s.btcTxid, POP1);
        assertEq(s.vout, 1);
        assertEq(s.confirmations, POP1_CONFS);
        assertEq(s.btcHeight, TIP_HEIGHT);
        assertEq(s.btcBlockHash, TIP_HASH);
        assertEq(s.hemiBlock, block.number);
        assertEq(keccak256(abi.encode(p.bestPublicationOf(K1))), keccak256(abi.encode(s)));
        // the stored fields recompute the id
        assertEq(p.publicationId(uint32(K1), s.btcTxid, s.vout, s.btcBlockHash), id);
        // the slot layout check-live.sh writes by state override: three slots under the subject, and the best pointer
        bytes32 base = _publicationSlot(K1, POP1, 1);
        assertEq(vm.load(address(p), base), POP1);
        assertEq(vm.load(address(p), bytes32(uint256(base) + 1)), TIP_HASH);
        assertEq(
            vm.load(address(p), bytes32(uint256(base) + 2)),
            bytes32(
                uint256(block.number) | (uint256(TIP_HEIGHT) << 64) | (uint256(POP1_CONFS) << 96) | (uint256(1) << 128)
            )
        );
        assertEq(vm.load(address(p), _bestSlot(K1)), _subject(K1, POP1, 1));
        assertEq(_subject(K1, POP1, 1), p.publicationSubject(uint32(K1), POP1, 1));
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, POP1, 1);
        assertTrue(c.recorded);
        assertTrue(c.best);
        assertFalse(c.becomesBest);
        // another output, a non-keystone: all zero
        assertEq(p.publicationOf(K1, POP1, 0).btcBlockHash, bytes32(0));
        assertEq(p.publicationOf(K1 + 1, POP1, 1).btcBlockHash, bytes32(0));
        assertEq(p.bestPublicationOf(K2).btcTxid, bytes32(0));
    }

    function test_record_slotsWritten() public {
        HvmMock.setTip(_tip());
        uint256 k = 5_780_850;
        bytes32 h = keccak256("recent");
        vm.setBlockhash(k, h);
        bytes32 txid = keccak256("pop");
        HvmMock.setRaw(0x42, abi.encodePacked(txid, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(k, h), 0));
        HvmMock.setConfirmations(txid, 4);
        // the first publication of a keystone with no checkpoint: checkpoint, three slots, the best pointer
        vm.recordLogs();
        vm.record();
        p.recordPublication(k, txid, 1);
        (, bytes32[] memory writes) = vm.accesses(address(p));
        assertEq(_distinct(writes), 5);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        assertEq(logs[0].topics[0], Checkpointed.selector);
        assertEq(logs[1].topics[0], PublicationRecorded.selector);
        assertEq(logs[2].topics[0], BestPublicationChanged.selector);
        assertEq(p.checkpointOf(k).blockHashPrefix, bytes12(h));
        // a second publication that does not become the best: its three slots only
        bytes32 txid2 = keccak256("pop 2");
        HvmMock.setRaw(0x42, abi.encodePacked(txid2, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(k, h), 0));
        HvmMock.setConfirmations(txid2, 3);
        vm.recordLogs();
        vm.record();
        (bool created, bool best) = p.recordPublication(k, txid2, 1);
        assertTrue(created);
        assertFalse(best);
        (, writes) = vm.accesses(address(p));
        assertEq(_distinct(writes), 3);
        logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], PublicationRecorded.selector);
        // with a checkpoint stored, the first publication of another keystone: three slots and the pointer
        uint256 k2 = 5_780_825;
        bytes32 h2 = keccak256("recent 2");
        vm.setBlockhash(k2, h2);
        p.checkpoint(k2);
        bytes32 txid3 = keccak256("pop 3");
        HvmMock.setRaw(0x42, abi.encodePacked(txid3, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(k2, h2), 0));
        HvmMock.setConfirmations(txid3, 4);
        vm.record();
        p.recordPublication(k2, txid3, 1);
        (, writes) = vm.accesses(address(p));
        assertEq(_distinct(writes), 4);
    }

    function test_record_revertsWithVerdict() public {
        _mainnetPops();
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.OutsideWindow));
        p.recordPublication(K1, POP1, 1);
        _storeCheckpoint(K1, K1_HASH);
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.WrongLength));
        p.recordPublication(K1, POP1, 0);
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.NotFound));
        p.recordPublication(K1, keccak256("unknown"), 1);
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.WrongKeystone));
        p.recordPublication(K1, POP2, 1);
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.NotKeystone));
        p.recordPublication(K1 + 1, POP1, 1);
        HvmMock.setFailInput(0x43, abi.encodePacked(POP1));
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.NoConfirmations));
        p.recordPublication(K1, POP1, 1);
        assertEq(p.publicationOf(K1, POP1, 1).btcTxid, bytes32(0));
        assertEq(p.bestPublicationOf(K1).btcTxid, bytes32(0));
    }

    function test_record_idempotent() public {
        _mainnetPops();
        _storeCheckpoint(K1, K1_HASH);
        p.recordPublication(K1, POP1, 1);
        PopFinality.Publication memory before = p.publicationOf(K1, POP1, 1);
        // later Hemi block, a new Bitcoin tip, more confirmations: nothing changes
        vm.roll(vm.getBlockNumber() + 50);
        HvmMock.setTip(TIP_HEIGHT + 3);
        HvmMock.setConfirmations(POP1, POP1_CONFS + 3);
        vm.recordLogs();
        vm.record();
        (bool created, bool best) = p.recordPublication(K1, POP1, 1);
        assertFalse(created);
        assertTrue(best);
        (, bytes32[] memory writes) = vm.accesses(address(p));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        PopFinality.Publication memory again = p.publicationOf(K1, POP1, 1);
        assertEq(again.hemiBlock, before.hemiBlock);
        assertEq(again.confirmations, POP1_CONFS);
        assertEq(again.btcBlockHash, TIP_HASH);
    }

    // =============================================================================================
    // Every publication is kept; K's best is the one with most confirmations (B-18, B-19)
    // =============================================================================================

    /// @dev Two valid publications of keystone k = 5780850, a and b, with confirmations ca and cb.
    function _twoPublications(uint32 ca, uint32 cb) internal returns (uint256 k, bytes32 a, bytes32 b) {
        HvmMock.setTip(_tip());
        k = 5_780_850;
        bytes32 h = keccak256("block");
        vm.setBlockhash(k, h);
        a = keccak256("a");
        b = keccak256("b");
        HvmMock.setRaw(0x42, abi.encodePacked(a, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(k, h), 0));
        HvmMock.setRaw(0x42, abi.encodePacked(b, Hvm.TX_FLAGS_OUTPUTS), _popTx(_popScript(k, h), 0));
        HvmMock.setConfirmations(a, ca);
        HvmMock.setConfirmations(b, cb);
    }

    function test_every_fewerConfirmationsIsStoredButNotBest() public {
        (uint256 k, bytes32 a, bytes32 b) = _twoPublications(10, 3);
        p.recordPublication(k, a, 1);
        PopFinality.PublicationCheck memory c = p.checkPublication(k, b, 1);
        assertEq(_v(c.verdict), OK);
        assertFalse(c.recorded);
        assertFalse(c.best);
        assertFalse(c.becomesBest);
        assertEq(c.bestTxid, a);
        assertEq(c.bestVout, 1);
        assertEq(c.bestConfirmations, 10);
        bytes32 id = p.publicationId(uint32(k), b, 1, TIP_HASH);
        vm.expectEmit(true, true, true, true, address(p));
        emit PublicationRecorded(
            id, k, b, 1, 3, TIP_HEIGHT, TIP_HASH, uint64(block.number), _abrev(1, k, keccak256("block"))
        );
        vm.recordLogs();
        (bool created, bool best) = p.recordPublication(k, b, 1);
        assertTrue(created);
        assertFalse(best);
        assertEq(vm.getRecordedLogs().length, 1); // no BestPublicationChanged
        assertEq(p.bestPublicationOf(k).btcTxid, a);
        assertEq(p.publicationOf(k, b, 1).confirmations, 3);
        // both are answerable by name; the anchored view reads the best
        (PopFinality.Verdict v, uint32 conf) = p.btcConfirmationsVia(k, k, b, 1);
        assertEq(_v(v), OK);
        assertEq(conf, 3);
        (, conf) = p.anchorConfirmations(k, k);
        assertEq(conf, 10);
    }

    function test_every_moreConfirmationsBecomesBest() public {
        (uint256 k, bytes32 a, bytes32 b) = _twoPublications(10, 3);
        p.recordPublication(k, a, 1);
        p.recordPublication(k, b, 1);
        // later b has more: re-submitting it (no new entry) makes it the best, and the event names a
        HvmMock.setConfirmations(b, 11);
        vm.recordLogs();
        vm.record();
        vm.expectEmit(true, true, true, true, address(p));
        emit BestPublicationChanged(k, b, 1, 11, a, 1);
        (bool created, bool best) = p.recordPublication(k, b, 1);
        assertFalse(created);
        assertTrue(best);
        (, bytes32[] memory writes) = vm.accesses(address(p));
        assertEq(_distinct(writes), 1); // the pointer only
        assertEq(p.bestPublicationOf(k).btcTxid, b);
        assertEq(p.bestPublicationOf(k).confirmations, 3); // the count stored when b was recorded
        assertEq(p.publicationOf(k, a, 1).confirmations, 10); // a stays stored
    }

    function test_every_tieKeepsTheBest() public {
        (uint256 k, bytes32 a, bytes32 b) = _twoPublications(10, 10);
        p.recordPublication(k, a, 1);
        (bool created, bool best) = p.recordPublication(k, b, 1);
        assertTrue(created);
        assertFalse(best);
        assertEq(p.bestPublicationOf(k).btcTxid, a);
        // a's own count at recording does not matter: both are read now
        HvmMock.setConfirmations(a, 20);
        HvmMock.setConfirmations(b, 19);
        vm.recordLogs();
        vm.record();
        (created, best) = p.recordPublication(k, b, 1);
        assertFalse(created);
        assertFalse(best);
        (, bytes32[] memory writes) = vm.accesses(address(p));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        HvmMock.setConfirmations(b, 20);
        (, best) = p.recordPublication(k, b, 1);
        assertFalse(best); // a tie keeps the best
        HvmMock.setConfirmations(b, 21);
        (, best) = p.recordPublication(k, b, 1);
        assertTrue(best);
        assertEq(p.bestPublicationOf(k).btcTxid, b);
    }

    /// @dev Internal review finding 9: a best whose Bitcoin transaction is reorged away is replaced by re-submitting another stored
    /// publication, even one with fewer confirmations.
    function test_every_bestThatStopsVerifyingIsRestoredByResubmitting() public {
        (uint256 k, bytes32 a, bytes32 b) = _twoPublications(10, 1);
        p.recordPublication(k, a, 1);
        p.recordPublication(k, b, 1);
        assertEq(p.bestPublicationOf(k).btcTxid, a);
        HvmMock.setFailInput(0x43, abi.encodePacked(a)); // a's Bitcoin block is reorged away
        (PopFinality.Verdict v,) = p.anchorConfirmations(k, k);
        assertEq(_v(v), NO_CONFS);
        PopFinality.PublicationCheck memory c = p.checkPublication(k, b, 1);
        assertTrue(c.recorded);
        assertTrue(c.becomesBest);
        assertEq(c.bestConfirmations, 0);
        vm.expectEmit(true, true, true, true, address(p));
        emit BestPublicationChanged(k, b, 1, 1, a, 1);
        (bool created, bool best) = p.recordPublication(k, b, 1);
        assertFalse(created);
        assertTrue(best);
        (v,) = p.anchorConfirmations(k, k);
        assertEq(_v(v), OK);
        // a is still stored, and still answers by name (NoConfirmations while hVM does not find it)
        assertEq(p.publicationOf(k, a, 1).btcTxid, a);
        (v,) = p.btcConfirmationsVia(k, k, a, 1);
        assertEq(_v(v), NO_CONFS);
        // the reorged one cannot be re-submitted: its check fails
        vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, PopFinality.Verdict.NoConfirmations));
        p.recordPublication(k, a, 1);
    }

    function test_every_sameTxOtherVout() public {
        (uint256 k, bytes32 a,) = _twoPublications(10, 1);
        bytes32 h = keccak256("block");
        // a transaction with the same PoP script at vouts 0 and 1: two entries, one count
        bytes memory s = _popScript(k, h);
        bytes32 t = keccak256("two outputs");
        HvmMock.setRaw(
            0x42,
            abi.encodePacked(t, Hvm.TX_FLAGS_OUTPUTS),
            abi.encodePacked(uint16(2), uint64(0), uint16(83), s, uint8(0), uint64(0), uint16(83), s, uint8(0))
        );
        HvmMock.setConfirmations(t, 4);
        (bool created, bool best) = p.recordPublication(k, t, 0);
        assertTrue(created && best);
        (created, best) = p.recordPublication(k, t, 1);
        assertTrue(created);
        assertFalse(best); // the same count: the best stays
        assertEq(p.bestPublicationOf(k).vout, 0);
        (, best) = p.recordPublication(k, a, 1); // a has more (10 > 4)
        assertTrue(best);
        assertEq(p.bestPublicationOf(k).btcTxid, a);
        assertEq(p.publicationOf(k, t, 1).vout, 1);
    }

    // =============================================================================================
    // anchorConfirmations / isBtcAnchored
    // =============================================================================================

    function _recordK1() internal {
        _mainnetPops();
        _storeCheckpoint(K1, K1_HASH);
        p.recordPublication(K1, POP1, 1);
    }

    function test_anchorConfirmations_realFixture() public {
        _recordK1();
        (PopFinality.Verdict v, uint32 c) = p.anchorConfirmations(5_620_209, K1);
        assertEq(_v(v), OK);
        assertEq(c, POP1_CONFS);
        assertTrue(p.isBtcAnchored(5_620_209, K1));
        // live: the count follows 0x43, not the stored value
        HvmMock.setConfirmations(POP1, POP1_CONFS + 7);
        (, c) = p.anchorConfirmations(5_620_209, K1);
        assertEq(c, POP1_CONFS + 7);
        assertEq(p.bestPublicationOf(K1).confirmations, POP1_CONFS);
    }

    function test_anchorConfirmations_coveringBoundaries() public {
        _recordK1();
        assertEq(p.coveringKeystone(K1), K1);
        assertEq(p.coveringKeystone(K1 - 24), K1);
        assertEq(p.coveringKeystone(K1 + 1), K1 + 25);
        assertEq(p.coveringKeystone(K1 - 25), K1 - 25);
        (PopFinality.Verdict v,) = p.anchorConfirmations(K1, K1); // block = K
        assertEq(_v(v), OK);
        (v,) = p.anchorConfirmations(K1 - 24, K1); // the first block K covers
        assertEq(_v(v), OK);
        (v,) = p.anchorConfirmations(K1 - 25, K1); // covered by K - 25 itself, and K is later: anchored
        assertEq(_v(v), OK);
        (v,) = p.anchorConfirmations(1, K1); // a later keystone anchors every earlier block
        assertEq(_v(v), OK);
        uint32 c;
        (v, c) = p.anchorConfirmations(K1 + 1, K1); // covered by K + 25 only
        assertEq(_v(v), NOT_COVERING);
        assertEq(c, 0);
        assertFalse(p.isBtcAnchored(K1 + 1, K1));
        (v,) = p.anchorConfirmations(type(uint256).max, K1);
        assertEq(_v(v), NOT_COVERING);
    }

    function test_anchorConfirmations_otherVerdicts() public {
        (PopFinality.Verdict v,) = p.anchorConfirmations(K1, K1 + 1);
        assertEq(_v(v), NOT_KEYSTONE);
        (v,) = p.anchorConfirmations(0, 0);
        assertEq(_v(v), NOT_KEYSTONE);
        (v,) = p.anchorConfirmations(K1, K1);
        assertEq(_v(v), NOT_RECORDED);
        (v,) = p.anchorConfirmations(K1, K1 + 25); // the next keystone is not recorded
        assertEq(_v(v), NOT_RECORDED);
        _recordK1();
        // 0x44 gone: the plausibility bound cannot be applied
        HvmMock.setAny(0x44, "");
        (v,) = p.anchorConfirmations(K1, K1);
        assertEq(_v(v), NO_VIEW);
        assertFalse(p.isBtcAnchored(K1, K1));
        HvmMock.clearAny(0x44);
        // 0x43: fails (Bitcoin reorg dropped it), zero, underflowed
        HvmMock.setFailInput(0x43, abi.encodePacked(POP1));
        (v,) = p.anchorConfirmations(K1, K1);
        assertEq(_v(v), NO_CONFS);
        assertFalse(p.isBtcAnchored(K1, K1));
    }

    function test_anchorConfirmations_implausibleCounts() public {
        _recordK1();
        HvmMock.setConfirmations(POP1, 0);
        (PopFinality.Verdict v,) = p.anchorConfirmations(K1, K1);
        assertEq(_v(v), NO_CONFS);
        HvmMock.setConfirmations(POP1, type(uint32).max);
        (v,) = p.anchorConfirmations(K1, K1);
        assertEq(_v(v), NO_CONFS);
        assertFalse(p.isBtcAnchored(K1, K1)); // an underflow never reads as final
    }

    function test_btcConfirmationsVia_namesOnePublication() public {
        _recordK1();
        (PopFinality.Verdict v, uint32 c) = p.btcConfirmationsVia(5_620_209, K1, POP1, 1);
        assertEq(_v(v), OK);
        assertEq(c, POP1_CONFS);
        assertTrue(p.isBtcFinalVia(5_620_209, K1, POP1, 1));
        // live, like anchorConfirmations
        HvmMock.setConfirmations(POP1, 8);
        assertFalse(p.isBtcFinalVia(K1, K1, POP1, 1));
        HvmMock.setConfirmations(POP1, 9);
        assertTrue(p.isBtcFinalVia(K1, K1, POP1, 1));
        // the covering rule: block = K, K - 24 and every earlier block; not K + 1
        (v,) = p.btcConfirmationsVia(K1 - 24, K1, POP1, 1);
        assertEq(_v(v), OK);
        (v,) = p.btcConfirmationsVia(1, K1, POP1, 1);
        assertEq(_v(v), OK);
        (v, c) = p.btcConfirmationsVia(K1 + 1, K1, POP1, 1);
        assertEq(_v(v), NOT_COVERING);
        assertEq(c, 0);
        // a publication that is not stored: another vout, another txid, another keystone
        (v,) = p.btcConfirmationsVia(K1, K1, POP1, 0);
        assertEq(_v(v), NOT_RECORDED);
        (v,) = p.btcConfirmationsVia(K1, K1, POP2, 1);
        assertEq(_v(v), NOT_RECORDED);
        (v,) = p.btcConfirmationsVia(K2, K2, POP1, 1);
        assertEq(_v(v), NOT_RECORDED);
        assertFalse(p.isBtcFinalVia(K2, K2, POP1, 1));
        (v,) = p.btcConfirmationsVia(K1, K1 + 1, POP1, 1);
        assertEq(_v(v), NOT_KEYSTONE);
        // 0x44 gone, 0x43 fails, an underflowed count
        HvmMock.setAny(0x44, "");
        (v,) = p.btcConfirmationsVia(K1, K1, POP1, 1);
        assertEq(_v(v), NO_VIEW);
        HvmMock.clearAny(0x44);
        HvmMock.setConfirmations(POP1, type(uint32).max);
        assertFalse(p.isBtcFinalVia(K1, K1, POP1, 1));
        HvmMock.setFailInput(0x43, abi.encodePacked(POP1));
        (v,) = p.btcConfirmationsVia(K1, K1, POP1, 1);
        assertEq(_v(v), NO_CONFS);
    }

    function test_isBtcAnchored_threshold() public {
        _recordK1();
        HvmMock.setConfirmations(POP1, 8);
        assertFalse(p.isBtcAnchored(K1, K1));
        HvmMock.setConfirmations(POP1, 9);
        assertTrue(p.isBtcAnchored(K1, K1));
        assertEq(p.BTC_FINAL_CONFIRMATIONS(), 9);
    }

    function test_laterKeystoneAnchorsEarlierBlocks() public {
        // only K2 recorded: every block up to K2 is anchored by it, K1's own range included
        _mainnetPops();
        _storeCheckpoint(K2, K2_HASH);
        p.recordPublication(K2, POP2, 1);
        (PopFinality.Verdict v, uint32 c) = p.anchorConfirmations(5_620_209, K2);
        assertEq(_v(v), OK);
        assertEq(c, POP2_CONFS);
        (v,) = p.anchorConfirmations(5_620_209, K1);
        assertEq(_v(v), NOT_RECORDED);
    }

    function testFuzz_coveringKeystone(uint256 b) public view {
        uint256 k = p.coveringKeystone(b);
        if (b == 0) {
            assertEq(k, 25); // block 0 is an ancestor of every keystone; the first one covers it
        } else if (b > p.MAX_KEYSTONE()) {
            assertEq(k, 0); // no keystone covers it
        } else {
            // receipts keystone.ts: b % 25 == 0 ? b : (b / 25 + 1) * 25
            assertEq(k, b % 25 == 0 ? b : (b / 25 + 1) * 25);
            assertGe(k, b);
            assertLt(k - b, 25);
        }
        // Every nonzero answer is a keystone the views accept, at or after the block (pre-mainnet audit L-1).
        if (k != 0) {
            assertTrue(k % 25 == 0 && k <= type(uint32).max && k >= b);
            (PopFinality.Verdict v,) = p.anchorConfirmations(b, k);
            assertTrue(v != PopFinality.Verdict.NotKeystone && v != PopFinality.Verdict.NotCovering);
        }
    }

    function test_coveringKeystone_extremes() public view {
        assertEq(p.coveringKeystone(0), 25);
        assertEq(p.coveringKeystone(1), 25);
        assertEq(p.coveringKeystone(25), 25);
        assertEq(p.coveringKeystone(26), 50);
        uint256 top = p.MAX_KEYSTONE(); // the largest multiple of 25 that fits in 32 bits
        assertEq(top, 4_294_967_275);
        assertEq(top % 25, 0);
        assertGt(top + 25, type(uint32).max);
        assertEq(p.coveringKeystone(top), top);
        assertEq(p.coveringKeystone(top - 1), top);
        assertEq(p.coveringKeystone(top - 24), top);
        assertEq(p.coveringKeystone(top + 1), 0); // the next multiple of 25 is not a keystone
        assertEq(p.coveringKeystone(type(uint32).max), 0);
        assertEq(p.coveringKeystone(type(uint256).max), 0);
    }

    // =============================================================================================
    // Fuzz: no answer from any precompile makes a check revert, and records agree with checks
    // =============================================================================================

    function testFuzz_checkPublication_neverReverts(
        bytes memory r44,
        bytes memory r42,
        bytes memory r43,
        uint8 mode,
        uint256 k,
        bytes32 txid,
        uint16 vout,
        bytes32 hash
    ) public {
        if (mode & 1 == 0) HvmMock.setTip(_tip());
        else HvmMock.setAny(0x44, r44);
        if (mode & 2 != 0) HvmMock.setAny(0x42, r42);
        else if (mode & 4 != 0) HvmMock.setAny(0x42, _popTx(_popScript(k, hash), uint8(mode >> 7)));
        if (mode & 8 != 0) HvmMock.setAny(0x43, r43);
        else HvmMock.setConfirmations(txid, uint32(uint256(hash)));
        if (mode & 16 != 0) HvmMock.setFail(0x43, true);
        if (mode & 32 != 0) HvmMock.setFail(0x42, true);
        if (mode & 64 != 0) k = bound(k, 1, 6_000_000) * 25;
        if (k % 25 == 0 && k < block.number) _storeCheckpoint(k, hash);
        PopFinality.PublicationCheck memory c = p.checkPublication(k, txid, vout);
        if (c.verdict == PopFinality.Verdict.Ok) {
            assertEq(c.keystone.l2Number, k);
            assertEq(c.keystone.blockHashPrefix, c.checkpoint);
            assertEq(c.abrev.length, 76);
            assertTrue(c.confirmations != 0);
            assertFalse(c.recorded);
            assertTrue(c.becomesBest); // nothing is stored for k in a fresh run
            (bool created, bool best) = p.recordPublication(k, txid, vout);
            assertTrue(created && best);
            assertEq(p.publicationOf(k, txid, vout).btcTxid, txid);
            assertEq(p.bestPublicationOf(k).btcTxid, txid);
            assertTrue(p.checkPublication(k, txid, vout).recorded);
        } else {
            assertFalse(c.becomesBest || c.best || c.recorded);
            vm.expectRevert(abi.encodeWithSelector(PopFinality.NotRecordable.selector, c.verdict));
            p.recordPublication(k, txid, vout);
        }
    }

    function testFuzz_finalityViewsNeverRevert(
        uint256 blockNumber,
        uint256 k,
        bytes memory r43,
        bytes memory r44,
        uint8 mode,
        bytes32 txid,
        uint16 vout
    ) public {
        if (mode & 1 != 0) k = bound(k, 1, 1_000_000) * 25;
        if (mode & 2 != 0) blockNumber = bound(blockNumber, 0, k);
        if (mode & 4 != 0 && k <= type(uint32).max && k % 25 == 0) {
            // a stored publication (txid, vout) of k, made the best: its txid and a nonzero as-of hash
            if (txid == bytes32(0)) txid = bytes32(uint256(1));
            bytes32 base = _publicationSlot(k, txid, vout);
            vm.store(address(p), base, txid);
            vm.store(address(p), bytes32(uint256(base) + 1), TIP_HASH);
            vm.store(address(p), _bestSlot(k), _subject(k, txid, vout));
        }
        if (mode & 8 != 0) HvmMock.setAny(0x43, r43);
        if (mode & 16 != 0) HvmMock.setAny(0x44, r44);
        else HvmMock.setTip(_tip());
        if (mode & 32 != 0) HvmMock.setFail(0x43, true);
        (PopFinality.Verdict v, uint32 c) = p.anchorConfirmations(blockNumber, k);
        bool fin = p.isBtcAnchored(blockNumber, k);
        if (v != PopFinality.Verdict.Ok) assertEq(c, 0);
        assertEq(fin, v == PopFinality.Verdict.Ok && c >= 9);
        if (v == PopFinality.Verdict.Ok) {
            assertGe(k, blockNumber);
            if (mode & 16 == 0) assertLe(uint256(c), uint256(TIP_HEIGHT) + 1000);
        }
        (PopFinality.Verdict vv, uint32 cv) = p.btcConfirmationsVia(blockNumber, k, txid, vout);
        assertEq(p.isBtcFinalVia(blockNumber, k, txid, vout), vv == PopFinality.Verdict.Ok && cv >= 9);
        if (vv != PopFinality.Verdict.Ok) assertEq(cv, 0);
        // with the best stored as (txid, vout), both readings agree
        if (mode & 4 != 0) {
            assertEq(uint8(vv), uint8(v));
            assertEq(cv, c);
        }
        p.coveringKeystone(blockNumber);
        p.checkCheckpoint(k);
    }

    // =============================================================================================
    // Ids (sdk/test/finality.test.ts holds the same vectors)
    // =============================================================================================

    function test_ids_encoding() public view {
        assertEq(p.KIND_PUBLICATION(), keccak256("hemi-bitcoin-facts/publication"));
        bytes32 subject = keccak256(abi.encodePacked(uint32(K1), POP1, uint16(1)));
        assertEq(p.publicationSubject(uint32(K1), POP1, 1), subject);
        assertEq(
            p.publicationId(uint32(K1), POP1, 1, TIP_HASH),
            keccak256(abi.encode(p.KIND_PUBLICATION(), subject, TIP_HASH))
        );
        // 38 bytes hashed: K as 4 bytes, the txid, vout as 2 bytes
        assertEq(
            p.publicationSubject(0x01020304, bytes32(0), 0x0506),
            keccak256(abi.encodePacked(hex"01020304", bytes32(0), hex"0506"))
        );
    }

    /// @dev Cross-checked with `cast keccak` and asserted again in sdk/test/finality.test.ts.
    function test_ids_vectors() public view {
        assertEq(p.KIND_PUBLICATION(), 0xaca80b0419e9bbfa912cafe37427934507668a2c285c3d5516c6a149df40b901);
        assertEq(
            p.publicationSubject(uint32(K1), POP1, 1),
            0x2948946b05df0e10a0991c069d33caf8eaf06bf304d50b4f8e58b1b537e35512
        );
        assertEq(
            p.publicationId(uint32(K1), POP1, 1, TIP_HASH),
            0x8f4f2caf3b437a371175137bb1efc6b3b4b00dc6d74b7ad9e3d4508b2ff73699
        );
    }

    // =============================================================================================
    // Holds no funds
    // =============================================================================================

    function test_refusesEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(p).call{value: 1}("");
        assertFalse(ok);
        (ok,) = address(p).call{value: 1}(hex"deadbeef");
        assertFalse(ok);
        _mainnetPops();
        _storeCheckpoint(K1, K1_HASH);
        (ok,) = address(p).call{value: 1}(abi.encodeCall(PopFinality.recordPublication, (K1, POP1, 1)));
        assertFalse(ok);
        uint256 k = 5_780_850;
        vm.setBlockhash(k, keccak256("x"));
        (ok,) = address(p).call{value: 1}(abi.encodeCall(PopFinality.checkpoint, (k)));
        assertFalse(ok);
        (ok,) = address(p).call(abi.encodeCall(PopFinality.recordPublication, (K1, POP1, 1)));
        assertTrue(ok);
        (ok,) = address(p).call(abi.encodeCall(PopFinality.checkpoint, (k)));
        assertTrue(ok);
        assertEq(address(p).balance, 0);
    }

    function test_unknownSelectorReverts() public {
        (bool ok,) = address(p).call(hex"deadbeef");
        assertFalse(ok);
    }

    // =============================================================================================
    // Gas (with MockHvm, indicative only; check-live.sh measures the real figures by eth_estimateGas)
    // =============================================================================================

    function test_gas() public {
        _etchHistory();
        HvmMock.setTip(_tip());
        uint256 k = 5_780_850;
        vm.setBlockhash(k, keccak256("a"));
        uint256 g = gasleft();
        p.checkpoint(k);
        console2.log("gas checkpoint via blockhash:          ", g - gasleft());
        uint256 k2 = 5_779_875;
        _setHistory(k2, keccak256("b"));
        g = gasleft();
        p.checkpoint(k2);
        console2.log("gas checkpoint via EIP-2935:           ", g - gasleft());
        g = gasleft();
        p.checkpoint(k2);
        console2.log("gas checkpoint again (no-op):          ", g - gasleft());

        _mainnetPops();
        _storeCheckpoint(K1, K1_HASH);
        g = gasleft();
        p.recordPublication(K1, POP1, 1);
        console2.log("gas recordPublication (MockHvm):       ", g - gasleft());
        g = gasleft();
        p.recordPublication(K1, POP1, 1);
        console2.log("gas recordPublication again (no-op):   ", g - gasleft());
        g = gasleft();
        p.isBtcAnchored(K1, K1);
        console2.log("gas isBtcAnchored (MockHvm):              ", g - gasleft());
        g = gasleft();
        p.isBtcFinalVia(K1, K1, POP1, 1);
        console2.log("gas isBtcFinalVia (MockHvm):           ", g - gasleft());

        // a second, competing publication of K1: stored, read against the best (which re-reads 0x42 and 0x43)
        bytes32 other = keccak256("another publication of K1");
        HvmMock.setRaw(0x42, abi.encodePacked(other, Hvm.TX_FLAGS_OUTPUTS), POP1_TX_OUTPUTS);
        HvmMock.setConfirmations(other, POP1_CONFS - 1);
        g = gasleft();
        p.recordPublication(K1, other, 1);
        console2.log("gas second publication, not best:      ", g - gasleft());
        HvmMock.setConfirmations(other, POP1_CONFS + 1);
        g = gasleft();
        p.recordPublication(K1, other, 1);
        console2.log("gas re-submit that becomes the best:   ", g - gasleft());
    }

    // =============================================================================================
    // Helpers
    // =============================================================================================

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

/// @notice Fork test on Hemi mainnet: the real CREATE2 deployer and EIP-2935 history contract, MockHvm in place of
/// the precompiles (forge cannot run them) answering with the exact bytes mainnet returned for both PoP fixtures.
/// Block 5620225 is far outside 8,191 blocks, so its checkpoint slot is set by vm.store, as check-live.sh sets it
/// by state override. Mocks are configured before forking and marked persistent, as in BitcoinFactsForkTest.
contract PopFinalityForkTest is Test, PopFixtures {
    function test_fork_realFixtures() public {
        HvmMock.install();
        uint64[10] memory nonceBefore;
        for (uint160 a = 0x40; a <= 0x49; ++a) {
            nonceBefore[a - 0x40] = vm.getNonce(address(a));
        }
        _mainnetPops();
        for (uint160 a = 0x40; a <= 0x49; ++a) {
            vm.makePersistent(address(a));
            for (uint64 n = nonceBefore[a - 0x40]; n < vm.getNonce(address(a)); ++n) {
                vm.makePersistent(vm.computeCreateAddress(address(a), n));
            }
        }
        Deploy d = new Deploy();
        vm.makePersistent(address(d));
        vm.makePersistent(Deployments.create2Address(Deployments.BITCOIN_FACTS_SALT, type(BitcoinFacts).creationCode));
        address target = Deployments.create2Address(Deployments.POP_FINALITY_SALT, type(PopFinality).creationCode);
        vm.makePersistent(target);

        vm.createSelectFork(vm.envOr("HEMI_FORK_URL", string("hemi")));
        assertEq(block.chainid, Deployments.HEMI_MAINNET);
        address[] memory addrs = d.deployAll(false);
        PopFinality p = PopFinality(addrs[1]);
        assertEq(address(p), target);
        assertGt(address(p).code.length, 0);

        // The real chain: the fixtures are outside both windows; a keystone ~1,000 blocks back reads through the
        // real EIP-2935 contract and one within 256 through blockhash, and the two sources agree.
        assertGt(HISTORY.code.length, 0);
        assertEq(keccak256(HISTORY.code), keccak256(HISTORY_CODE));
        (PopFinality.Verdict v,,) = p.checkCheckpoint(K1);
        assertEq(uint8(v), uint8(PopFinality.Verdict.OutsideWindow));
        uint256 recent = ((block.number - 30) / 25) * 25;
        (bool ok, bytes memory ret) = HISTORY.staticcall(abi.encode(recent));
        assertTrue(ok);
        assertEq(bytes32(ret), blockhash(recent));
        bytes12 prefix;
        (v, prefix,) = p.checkCheckpoint(recent);
        assertEq(uint8(v), 0);
        assertEq(prefix, bytes12(blockhash(recent)));
        uint256 older = ((block.number - 1000) / 25) * 25;
        (ok, ret) = HISTORY.staticcall(abi.encode(older));
        assertTrue(ok);
        assertTrue(bytes32(ret) != bytes32(0));
        assertEq(p.checkpoint(older), bytes12(bytes32(ret)));

        // keystone 5620225: checkpoint slot by vm.store, then the real 0x42 bytes pass every check
        vm.store(address(p), keccak256(abi.encode(K1, uint256(0))), _checkpointWord(K1_HASH, 1));
        PopFinality.PublicationCheck memory c = p.checkPublication(K1, POP1, 1);
        assertEq(uint8(c.verdict), 0);
        assertEq(c.keystone.l2Number, K1);
        assertEq(c.keystone.blockHashPrefix, bytes12(K1_HASH));
        (bool created, bool best) = p.recordPublication(K1, POP1, 1);
        assertTrue(created && best);
        (v,) = p.anchorConfirmations(5_620_209, K1);
        assertEq(uint8(v), 0);
        assertTrue(p.isBtcAnchored(5_620_209, K1));
        assertFalse(p.isBtcAnchored(K1 + 1, K1));
        // the exact-match path: these 76 bytes are the canonical keystone (D-003 rebuilt it from Hemi RPC)
        assertTrue(p.isBtcFinalVia(5_620_209, K1, POP1, 1));
        assertFalse(p.isBtcFinalVia(K1 + 1, K1, POP1, 1));

        // keystone 5734725 likewise
        vm.store(address(p), keccak256(abi.encode(K2, uint256(0))), _checkpointWord(K2_HASH, 1));
        (created, best) = p.recordPublication(K2, POP2, 1);
        assertTrue(created && best);
        assertTrue(p.isBtcFinalVia(K2, K2, POP2, 1));
        uint32 conf;
        (v, conf) = p.anchorConfirmations(K2 - 24, K2);
        assertEq(uint8(v), 0);
        assertEq(conf, POP2_CONFS);
        assertTrue(p.isBtcAnchored(K2, K2));
        // idempotent on the fork too
        (created, best) = p.recordPublication(K1, POP1, 1);
        assertFalse(created);
        assertTrue(best);
    }
}
