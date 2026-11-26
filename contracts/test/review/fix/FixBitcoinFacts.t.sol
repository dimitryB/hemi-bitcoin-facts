// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BitcoinFacts} from "../../../src/BitcoinFacts.sol";
import {HvmMock} from "../../utils/HvmMock.sol";
import {Fixtures} from "../../BitcoinFacts.t.sol";

/// @notice Fix review (docs/SECURITY-AUDIT.md): testnet4's genesis coinbase. All pass.
contract FixBitcoinFactsTest is Test, Fixtures {
    BitcoinFacts internal f;
    BitcoinFacts internal old; // the build before the fix review's change

    /// testnet4's genesis coinbase, serialized as Bitcoin Core's CreateGenesisBlock builds it
    /// (src/kernel/chainparams.cpp CTestNet4Params): scriptSig `04ffff001d 0104 4c4c <76-byte message>`, one output
    /// of 50 BTC to `21 <33 zero bytes> ac`.
    bytes internal constant TESTNET4_COINBASE =
        hex"01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff5504ffff001d01044c4c"
        hex"30332f4d61792f323032342030303030303030303030303030303030303030303165626435386332343439373062336161396437"
        hex"383362623030313031316662653865613865393865303065ffffffff0100f2052a01000000232100000000000000000000000000"
        hex"0000000000000000000000000000000000000000ac00000000";
    /// mainnet's (= testnet3's, signet's and regtest's) genesis coinbase.
    bytes internal constant MAINNET_COINBASE =
        hex"01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468"
        hex"652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e642062"
        hex"61696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828"
        hex"e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000";

    function setUp() public {
        HvmMock.install();
        f = new BitcoinFacts();
        bytes memory oldCode = vm.parseBytes(vm.readFile("test/fixtures/review-fix/BitcoinFacts-before-fix.initcode.hex"));
        assertEq(keccak256(oldCode), 0x144f76e76993801d16aeeb2efaea316759bd9535ca42cea5cb497ee87f71e37c, "before-fix pin");
        address a;
        assembly {
            a := create(0, add(oldCode, 32), mload(oldCode))
        }
        require(a != address(0), "old deploy");
        old = BitcoinFacts(a);
        vm.roll(5_780_440);
        _mainnetFixtures();
    }

    function _reverse(bytes32 x) internal pure returns (bytes32 r) {
        for (uint256 i; i < 32; ++i) {
            r |= bytes32(uint256(uint8(x[i])) << (8 * i));
        }
    }

    function _txidDisplay(bytes memory rawTx) internal pure returns (bytes32) {
        return _reverse(sha256(abi.encodePacked(sha256(rawTx))));
    }

    function _le32(uint32 x) internal pure returns (bytes4) {
        return bytes4((x >> 24) | ((x >> 8) & 0xff00) | ((x << 8) & 0xff0000) | (x << 24));
    }

    /// @dev Both constants are sha256d of the real coinbase, byte-reversed (display order, as every txid this contract
    /// takes), and the coinbase is the real one: the genesis header built on it hashes to the genesis hash Core
    /// asserts, which carries the proof of work.
    function test_fix_genesisTxidsAreDerivedFromTheCoinbases() public view {
        bytes32 t4 = _txidDisplay(TESTNET4_COINBASE);
        assertEq(t4, f.TESTNET4_GENESIS_COINBASE_TXID(), "testnet4");
        assertEq(t4, 0x7aa0a7ae1e223414cb807e40cd57e667b718e42aaf9306db9102fe28912b7b4e);
        assertEq(_txidDisplay(MAINNET_COINBASE), f.GENESIS_COINBASE_TXID(), "mainnet");

        // testnet4 genesis header: version 1, prev 0, merkle root (internal order) = sha256d(coinbase), time
        // 1714777860, bits 0x1d00ffff, nonce 393743547.
        bytes memory header = abi.encodePacked(
            _le32(1),
            bytes32(0),
            sha256(abi.encodePacked(sha256(TESTNET4_COINBASE))),
            _le32(1_714_777_860),
            _le32(0x1d00ffff),
            _le32(393_743_547)
        );
        assertEq(
            _reverse(sha256(abi.encodePacked(sha256(header)))),
            0x00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043,
            "testnet4 genesis block hash"
        );
    }

    /// @dev The new constant short-circuits before any output call, as the mainnet one does, for every vout.
    function test_fix_testnet4Genesis_anyVoutUnspendableWithoutOutputCalls() public {
        bytes32 t4 = f.TESTNET4_GENESIS_COINBASE_TXID();
        HvmMock.setOutput(t4, 0, 5_000_000_000, abi.encodePacked(hex"21", new bytes(33), hex"ac"), false);
        HvmMock.setConfirmations(t4, 100_000);
        vm.expectCall(address(0x48), "", 0);
        vm.expectCall(address(0x42), "", 0);
        vm.expectCall(address(0x43), "", 0);
        uint16[4] memory vouts = [uint16(0), 1, 127, type(uint16).max];
        for (uint256 i; i < vouts.length; ++i) {
            BitcoinFacts.OutputCheck memory c = f.checkOutput(t4, vouts[i]);
            assertEq(uint8(c.verdict), uint8(BitcoinFacts.Verdict.Unspendable));
            assertEq(c.sats, 0);
            assertFalse(c.spent);
            assertEq(c.btcBlockHash, TIP_HASH);
        }
        vm.expectRevert(abi.encodeWithSelector(BitcoinFacts.NotRecordable.selector, BitcoinFacts.Verdict.Unspendable));
        f.recordOutput(t4, 0);
    }

    /// @dev Differential, old (before the fix) against new: for every txid other than testnet4's genesis coinbase,
    /// `checkOutput` returns exactly the same struct, whatever hVM answers. So the new comparison hides nothing
    /// else, a near miss of the constant included. For testnet4's txid the new build says Unspendable.
    function testFuzz_fix_checkOutput_sameAsBefore_exceptTestnet4Genesis(
        uint8 txSel,
        bytes32 randomTxid,
        uint8 bitFlip,
        uint16 vout,
        uint64 sats,
        bytes memory script,
        uint8 flag,
        uint32 confs,
        bool withConfs
    ) public {
        bytes32 t4 = f.TESTNET4_GENESIS_COINBASE_TXID();
        bytes32 txid;
        uint256 s = txSel % 5;
        if (s == 0) txid = t4;
        else if (s == 1) txid = t4 ^ bytes32(uint256(1) << (bitFlip % 256)); // one bit off
        else if (s == 2) txid = f.GENESIS_COINBASE_TXID();
        else if (s == 3) txid = UNSPENT_TXID;
        else txid = randomTxid;
        vout = vout % 4;
        if (script.length > 300) assembly { mstore(script, 300) }
        HvmMock.setOutputFlag(txid, vout, sats, script, flag % 3);
        if (withConfs) HvmMock.setConfirmations(txid, confs);

        BitcoinFacts.OutputCheck memory n = f.checkOutput(txid, vout);
        BitcoinFacts.OutputCheck memory o = old.checkOutput(txid, vout);
        if (txid == t4) {
            assertEq(uint8(n.verdict), uint8(BitcoinFacts.Verdict.Unspendable));
            assertEq(n.sats, 0);
            assertEq(n.scriptHash, bytes32(0));
            assertFalse(n.spent);
        } else {
            assertEq(abi.encode(n), abi.encode(o), "same answer as before the fix");
        }
    }
}
