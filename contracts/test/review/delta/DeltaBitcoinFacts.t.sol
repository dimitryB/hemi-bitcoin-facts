// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Hvm} from "../../../src/Hvm.sol";
import {BitcoinFacts} from "../../../src/BitcoinFacts.sol";
import {HvmMock} from "../../utils/HvmMock.sol";
import {Fixtures} from "../../BitcoinFacts.t.sol";
import {GasProbe} from "../ReviewUtils.sol";

/// @notice Delta review (docs/SECURITY-AUDIT.md) of BitcoinFacts after the internal review's fixes: the genesis-coinbase verdict and the
/// dropped script parse on the 0x48 (unspent) path. `test_delta_F…` tests failed against the code the
/// review read (the evidence for its findings) and pass since the fixes; the others pass.
contract DeltaBitcoinFactsTest is Test, Fixtures {
    BitcoinFacts internal f;
    GasProbe internal probe;

    bytes32 internal constant GENESIS_CB = 0x4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b;
    /// Mainnet 0x48 answer for the genesis coinbase (internal review finding 3).
    bytes internal constant GENESIS_48 =
        hex"000000012a05f20000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac01";

    /// testnet4's genesis coinbase (BIP94; btcd chaincfg testNet4GenesisMerkleRoot, display order). Its only output
    /// is 50 BTC to `21 <33 zero bytes> ac`, a script that parses, so TBC's crawler (IsUnspendable false) would put it
    /// in the UTXO set exactly as it does mainnet's.
    bytes32 internal constant TESTNET4_GENESIS_CB = 0x7aa0a7ae1e223414cb807e40cd57e667b718e42aaf9306db9102fe28912b7b4e;

    function setUp() public {
        HvmMock.install();
        f = new BitcoinFacts();
        probe = new GasProbe();
        vm.roll(5_780_440);
        _mainnetFixtures();
    }

    // =============================================================================================
    // Genesis coinbase
    // =============================================================================================

    /// @dev Sound: the special case runs before any hVM output call, for every vout, so it never burns a cap and
    /// cannot be steered by what 0x48 / 0x42 answer. Mainnet, testnet3 and regtest (TBC's networks at the
    /// heminetwork commit mainnet pins) share this coinbase.
    function test_delta_genesis_anyVoutUnspendableWithoutOutputCalls() public {
        HvmMock.setRaw(0x48, abi.encodePacked(GENESIS_CB, uint16(0), uint16(10_000)), GENESIS_48);
        HvmMock.setConfirmations(GENESIS_CB, 976_861);
        uint16[4] memory vouts = [uint16(0), 1, 127, type(uint16).max];
        // over the whole loop: 0x48, 0x42 and 0x43 are never called
        vm.expectCall(address(0x48), "", 0);
        vm.expectCall(address(0x42), "", 0);
        vm.expectCall(address(0x43), "", 0);
        for (uint256 i; i < vouts.length; ++i) {
            BitcoinFacts.OutputCheck memory c = f.checkOutput(GENESIS_CB, vouts[i]);
            assertEq(uint8(c.verdict), uint8(BitcoinFacts.Verdict.Unspendable));
            assertEq(c.sats, 0);
            assertFalse(c.spent);
            assertEq(c.btcBlockHash, TIP_HASH); // the as-of header is still read and reported
        }
    }

    /// @dev Finding (informational): the constant is mainnet/testnet3/regtest's coinbase only. heminetwork `main`
    /// already runs TBC on testnet4 (`case "testnet4"` in service/tbc/tbc.go), whose genesis coinbase differs, and
    /// CREATE2 puts this same bytecode at the same address on any chain. On a Hemi network that follows testnet4 its
    /// genesis coinbase reads as an unspent 50 BTC output, which is what finding 3 removed. Failed before the fix.
    function test_delta_F_testnet4GenesisCoinbaseIsUnspendable() public {
        bytes memory script = abi.encodePacked(hex"21", bytes32(0), hex"00", hex"ac"); // 35 bytes
        HvmMock.setOutput(TESTNET4_GENESIS_CB, 0, 5_000_000_000, script, false);
        HvmMock.setConfirmations(TESTNET4_GENESIS_CB, 100_000);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(TESTNET4_GENESIS_CB, 0);
        console2.log("testnet4 genesis coinbase verdict (0 = Ok):", uint8(c.verdict));
        console2.log("sats:", c.sats);
        assertEq(uint8(c.verdict), uint8(BitcoinFacts.Verdict.Unspendable), "testnet4 genesis coinbase reads as unspent");
    }

    // =============================================================================================
    // The 0x48 path no longer parses the script
    // =============================================================================================

    /// @dev Sound, but by trust: the parse is gone from the 0x48 path, so if hVM's UTXO set ever held a script that
    /// does not parse, it would now read Ok/unspent where it read Unspendable before the internal review's fixes. It cannot today:
    /// heminetwork 44781989923a `processUtxos` (service/tbc/crawler.go:524) skips every output for which btcd v0.24.2
    /// `txscript.IsUnspendable` is true, and that function is "OP_RETURN first || longer than 10,000 ||
    /// checkScriptParses fails" (txscript/script.go:529). Nothing else writes the UTXO set (unprocessUtxos applies the
    /// same filter). Never "spent": the 0x42 path still parses and still says Unspendable.
    function test_delta_unparseableScript_0x48PathTrustsTbc_0x42PathStillParses() public {
        bytes32 txid = keccak256("delta: unparseable script");
        bytes memory bad = hex"4c"; // OP_PUSHDATA1 with no length byte: does not parse
        // as if hVM had (wrongly) indexed it as unspent
        HvmMock.setOutput(txid, 0, 1234, bad, false);
        HvmMock.setConfirmations(txid, 10);
        BitcoinFacts.OutputCheck memory c = f.checkOutput(txid, 0);
        assertEq(uint8(c.verdict), uint8(BitcoinFacts.Verdict.Ok));
        assertFalse(c.spent);
        assertEq(c.sats, 1234);
        // what hVM really does with it: not in the UTXO set, listed by 0x42 with UTXO byte 0x00
        bytes32 txid2 = keccak256("delta: unparseable script, real hVM");
        HvmMock.setOutput(txid2, 0, 1234, bad, true);
        HvmMock.setConfirmations(txid2, 10);
        c = f.checkOutput(txid2, 0);
        assertEq(uint8(c.verdict), uint8(BitcoinFacts.Verdict.Unspendable));
        assertFalse(c.spent);
    }

    /// @dev Sound: the cheap checks the 0x48 path kept still refuse OP_RETURN-first and over-long scripts, and the
    /// cost of the longest script hVM can return is now flat (was 1,131,707 gas for checkOutput, finding 4).
    function test_delta_unspentPath_cheapChecksAndGas() public {
        bytes32 t1 = keccak256("delta: op_return in utxo set");
        HvmMock.setOutput(t1, 0, 1, hex"6a0101", false);
        HvmMock.setConfirmations(t1, 10);
        assertEq(uint8(f.checkOutput(t1, 0).verdict), uint8(BitcoinFacts.Verdict.Unspendable));
        bytes32 t2 = keccak256("delta: 10,001-byte script in utxo set");
        HvmMock.setOutput(t2, 0, 1, new bytes(10_001), false);
        HvmMock.setConfirmations(t2, 10);
        assertEq(uint8(f.checkOutput(t2, 0).verdict), uint8(BitcoinFacts.Verdict.Unspendable));

        bytes32 t3 = keccak256("delta: 10,000-byte script");
        bytes memory s = new bytes(10_000);
        for (uint256 i; i < s.length; ++i) {
            s[i] = 0x51;
        }
        HvmMock.setOutput(t3, 0, 1, s, false);
        HvmMock.setConfirmations(t3, 10);
        (bool ok, uint256 used,) = probe.measure(address(f), abi.encodeCall(BitcoinFacts.checkOutput, (t3, uint16(0))));
        assertTrue(ok);
        console2.log("checkOutput, unspent 10,000-byte script, gas (mock):", used);
        assertLt(used, 300_000);
    }
}
