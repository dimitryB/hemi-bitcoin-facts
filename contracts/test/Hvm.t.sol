// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hvm} from "../src/Hvm.sol";
import {HvmMock} from "./utils/HvmMock.sol";

/// @dev Exposes the internal library so tests can call it and measure gas.
contract HvmHarness {
    function balance(string memory a) external view returns (bool, uint64) {
        return Hvm.balance(a);
    }

    function utxos(string memory a, uint24 page, uint8 size) external view returns (bool, Hvm.Utxo[] memory) {
        return Hvm.utxos(a, page, size);
    }

    function txByTxid(bytes32 txid, bytes4 flags) external view returns (bool, bytes memory) {
        return Hvm.txByTxid(txid, flags);
    }

    function containingBlock(bytes32 txid) external view returns (bool, bytes32) {
        return Hvm.containingBlock(txid);
    }

    function confirmations(bytes32 txid) external view returns (bool, uint32) {
        return Hvm.confirmations(txid);
    }

    function lastHeader() external view returns (bool, Hvm.Header memory) {
        return Hvm.lastHeader();
    }

    function headerAt(uint32 h) external view returns (bool, Hvm.Header memory) {
        return Hvm.headerAt(h);
    }

    function addressScript(string memory a) external view returns (bool, bytes memory) {
        return Hvm.addressScript(a);
    }

    function input(bytes32 txid, uint16 i, uint256 max) external view returns (bool, Hvm.Input memory) {
        return Hvm.input(txid, i, max);
    }

    function output(bytes32 txid, uint16 i, uint256 max) external view returns (bool, Hvm.Output memory) {
        return Hvm.output(txid, i, max);
    }

    function outputFull(bytes32 txid, uint16 i) external view returns (bool, bool, Hvm.Output memory) {
        return Hvm.outputFull(txid, i);
    }

    function witness(bytes32 txid, uint16 i, uint16 w, uint256 max) external view returns (bool, uint16, bytes memory) {
        return Hvm.witness(txid, i, w, max);
    }

    function txOutputs(bytes32 txid) external view returns (bool, uint256, Hvm.TxOutput[] memory) {
        return Hvm.txOutputs(txid);
    }

    function spendStatus(bytes32 txid, uint16 vout, uint64 sats, bytes32 scriptHash) external view returns (Hvm.Spend) {
        return Hvm.spendStatus(txid, vout, sats, scriptHash);
    }
}

contract HvmTest is Test {
    HvmHarness internal h;

    string internal constant ADDR = "bc1qv6v32p9kw0azmlv6mz6ffamwf5acaxkyq9x8cg"; // 42 chars
    bytes32 internal constant TXID = 0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4;
    bytes internal constant P2WPKH = hex"001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831";

    function setUp() public {
        HvmMock.install();
        h = new HvmHarness();
    }

    // ---- 0x40 ----------------------------------------------------------------------------------

    function test_balance() public {
        HvmMock.setBalance(ADDR, 123_456);
        (bool ok, uint64 sats) = h.balance(ADDR);
        assertTrue(ok);
        assertEq(sats, 123_456);
    }

    function test_balance_zeroIsEightZeroBytes() public {
        HvmMock.setBalance(ADDR, 0);
        (bool ok, uint64 sats) = h.balance(ADDR);
        assertTrue(ok);
        assertEq(sats, 0);
    }

    function test_balance_emptyIsNoAnswer() public view {
        (bool ok, uint64 sats) = h.balance(ADDR);
        assertFalse(ok);
        assertEq(sats, 0);
    }

    function test_balance_shortAddressNotCalled() public {
        HvmMock.setFail(0x40, true); // would burn gas if called
        uint256 g = gasleft();
        (bool ok,) = h.balance("1short");
        assertFalse(ok);
        assertLt(g - gasleft(), 10_000);
    }

    function test_balance_wrongLength() public {
        HvmMock.setAny(0x40, hex"00000000000001");
        (bool ok,) = h.balance(ADDR);
        assertFalse(ok);
        HvmMock.setAny(0x40, hex"000000000000000100");
        (ok,) = h.balance(ADDR);
        assertFalse(ok);
    }

    // ---- 0x41 ----------------------------------------------------------------------------------

    function test_utxos() public {
        bytes memory resp = abi.encodePacked(
            uint8(2), TXID, uint16(0), uint64(1000), bytes32(uint256(7)), uint16(40), uint64(5)
        );
        HvmMock.setRaw(0x41, abi.encodePacked(ADDR, uint24(0), uint8(10)), resp);
        (bool ok, Hvm.Utxo[] memory list) = h.utxos(ADDR, 0, 10);
        assertTrue(ok);
        assertEq(list.length, 2);
        assertEq(list[0].txid, TXID);
        assertEq(list[0].sats, 1000);
        assertEq(list[1].vout, 40);
        assertEq(list[1].sats, 5);
    }

    function test_utxos_emptyPage() public {
        HvmMock.setAny(0x41, hex"00");
        (bool ok, Hvm.Utxo[] memory list) = h.utxos(ADDR, 3, 10);
        assertTrue(ok);
        assertEq(list.length, 0);
    }

    function test_utxos_countMismatch() public {
        HvmMock.setAny(0x41, abi.encodePacked(uint8(2), TXID, uint16(0), uint64(1000)));
        (bool ok,) = h.utxos(ADDR, 0, 10);
        assertFalse(ok);
    }

    // ---- 0x42 ----------------------------------------------------------------------------------

    function test_containingBlock() public {
        HvmMock.setBlock(TXID, bytes32(uint256(0xb10c)));
        (bool ok, bytes32 b) = h.containingBlock(TXID);
        assertTrue(ok);
        assertEq(b, bytes32(uint256(0xb10c)));
    }

    function test_containingBlock_wrongLength() public {
        HvmMock.setAny(0x42, new bytes(33));
        (bool ok,) = h.containingBlock(TXID);
        assertFalse(ok);
    }

    function test_txByTxid_raw() public {
        HvmMock.setRaw(0x42, abi.encodePacked(TXID, bytes4(0x08000000)), hex"00000000");
        (bool ok, bytes memory data) = h.txByTxid(TXID, 0x08000000);
        assertTrue(ok);
        assertEq(data, hex"00000000");
    }

    // ---- 0x43 ----------------------------------------------------------------------------------

    function test_confirmations() public {
        HvmMock.setConfirmations(TXID, 9);
        (bool ok, uint32 n) = h.confirmations(TXID);
        assertTrue(ok);
        assertEq(n, 9);
    }

    function test_confirmations_unknownTxidFailsWithinCap() public view {
        uint256 g = gasleft();
        (bool ok, uint32 n) = h.confirmations(bytes32(uint256(1)));
        uint256 used = g - gasleft();
        assertFalse(ok);
        assertEq(n, 0);
        // the failed call burns the whole cap (2 x 5,000) and no more
        assertLt(used, Hvm.GAS_TX_CONFIRMATIONS * Hvm.GAS_CAP_FACTOR + 15_000);
    }

    function test_confirmations_wrongLength() public {
        HvmMock.setAny(0x43, hex"000009");
        (bool ok,) = h.confirmations(TXID);
        assertFalse(ok);
    }

    // ---- 0x44 / 0x45 ---------------------------------------------------------------------------

    function test_lastHeader() public {
        Hvm.Header memory t = HvmMock.setTip(975_300);
        (bool ok, Hvm.Header memory got) = h.lastHeader();
        assertTrue(ok);
        assertEq(got.height, t.height);
        assertEq(got.hash, t.hash);
        assertEq(got.version, t.version);
        assertEq(got.prevHash, t.prevHash);
        assertEq(got.merkleRoot, t.merkleRoot);
        assertEq(got.time, t.time);
        assertEq(got.bits, t.bits);
        assertEq(got.nonce, t.nonce);
    }

    function test_lastHeader_emptyAndShort() public {
        (bool ok,) = h.lastHeader();
        assertFalse(ok);
        HvmMock.setAny(0x44, new bytes(115));
        (ok,) = h.lastHeader();
        assertFalse(ok);
    }

    function test_lastHeader_zeroHashRejected() public {
        bytes memory raw = HvmMock.encodeHeader(HvmMock.header(5));
        for (uint256 i = 4; i < 36; ++i) raw[i] = 0;
        HvmMock.setAny(0x44, raw);
        (bool ok,) = h.lastHeader();
        assertFalse(ok);
    }

    function test_headerAt() public {
        HvmMock.setTip(100);
        (bool ok, Hvm.Header memory got) = h.headerAt(100);
        assertTrue(ok);
        assertEq(got.hash, HvmMock.header(100).hash);
        (ok,) = h.headerAt(101);
        assertFalse(ok);
    }

    function test_headerAt_heightMismatchRejected() public {
        HvmMock.setAny(0x45, HvmMock.encodeHeader(HvmMock.header(99)));
        (bool ok,) = h.headerAt(100);
        assertFalse(ok);
    }

    // ---- 0x46 ----------------------------------------------------------------------------------

    function test_addressScript() public {
        HvmMock.setScript(ADDR, P2WPKH);
        (bool ok, bytes memory s) = h.addressScript(ADDR);
        assertTrue(ok);
        assertEq(s, P2WPKH);
    }

    function test_addressScript_undecodableFails() public view {
        (bool ok, bytes memory s) = h.addressScript("not-a-bitcoin-address-at-all");
        assertFalse(ok);
        assertEq(s.length, 0);
    }

    // ---- 0x47 ----------------------------------------------------------------------------------

    function test_input() public {
        Hvm.Input memory inp = Hvm.Input({
            witnessCount: 2,
            prevSats: 50_000,
            prevTxid: bytes32(uint256(0xabc)),
            prevVout: 3,
            scriptSigLength: 0,
            scriptSig: hex"160014aabbccdd",
            sequence: 0xfffffffd
        });
        HvmMock.setInput(TXID, 1, inp);
        (bool ok, Hvm.Input memory got) = h.input(TXID, 1, 100);
        assertTrue(ok);
        assertEq(got.witnessCount, 2);
        assertEq(got.prevSats, 50_000);
        assertEq(got.prevTxid, bytes32(uint256(0xabc)));
        assertEq(got.prevVout, 3);
        assertEq(got.scriptSigLength, 7);
        assertEq(got.scriptSig, hex"160014aabbccdd");
        assertEq(got.sequence, 0xfffffffd);

        (ok, got) = h.input(TXID, 1, 3);
        assertTrue(ok);
        assertEq(got.scriptSigLength, 7);
        assertEq(got.scriptSig, hex"160014");
        assertEq(got.sequence, 0xfffffffd);
    }

    function test_input_malformed() public {
        HvmMock.setAny(0x47, new bytes(49));
        (bool ok,) = h.input(TXID, 0, 100);
        assertFalse(ok);
        // claims a 5-byte scriptSig but carries none
        HvmMock.setAny(0x47, abi.encodePacked(new bytes(44), uint16(5), uint32(0)));
        (ok,) = h.input(TXID, 0, 100);
        assertFalse(ok);
    }

    // ---- 0x48 ----------------------------------------------------------------------------------

    function test_output() public {
        HvmMock.setOutput(TXID, 0, 1000, P2WPKH, false);
        (bool ok, Hvm.Output memory o) = h.output(TXID, 0, 100);
        assertTrue(ok);
        assertEq(o.sats, 1000);
        assertEq(o.scriptLength, 22);
        assertEq(o.script, P2WPKH);
    }

    /// @dev Mainnet's 0x48 gives no answer for a spent output (DECISIONS.md D-004).
    function test_output_spentIsNoAnswer() public {
        HvmMock.setOutput(TXID, 1, 83_050_000, P2WPKH, true);
        (bool ok, Hvm.Output memory o) = h.output(TXID, 1, 100);
        assertFalse(ok);
        assertEq(o.sats, 0);
    }

    function test_output_highIndexAndLongScript() public {
        bytes memory longScript = new bytes(9_000);
        for (uint256 i; i < longScript.length; ++i) longScript[i] = bytes1(uint8(i));
        HvmMock.setOutput(TXID, 400, 7, longScript, false);
        (bool ok, bool complete, Hvm.Output memory o) = h.outputFull(TXID, 400);
        assertTrue(ok);
        assertTrue(complete);
        assertEq(o.scriptLength, 9_000);
        assertEq(keccak256(o.script), keccak256(longScript));
    }

    function test_output_truncated() public {
        HvmMock.setOutput(TXID, 0, 1000, P2WPKH, false);
        (bool ok, Hvm.Output memory o) = h.output(TXID, 0, 5);
        assertTrue(ok);
        assertEq(o.scriptLength, 22);
        assertEq(o.script, hex"0014669915");
    }

    function test_outputFull_incompleteAboveMax() public {
        bytes memory s = new bytes(Hvm.MAX_SCRIPT_BYTES + 1);
        HvmMock.setOutput(TXID, 0, 1, s, false);
        (bool ok, bool complete, Hvm.Output memory o) = h.outputFull(TXID, 0);
        assertTrue(ok);
        assertFalse(complete);
        assertEq(o.scriptLength, Hvm.MAX_SCRIPT_BYTES + 1);
        assertEq(o.script.length, Hvm.MAX_SCRIPT_BYTES);
    }

    function test_output_maxIsClamped() public {
        bytes memory s = new bytes(Hvm.MAX_SCRIPT_BYTES + 50);
        HvmMock.setOutput(TXID, 0, 1, s, false);
        (bool ok, Hvm.Output memory o) = h.output(TXID, 0, 60_000);
        assertTrue(ok);
        assertEq(o.script.length, Hvm.MAX_SCRIPT_BYTES);
    }

    function test_output_badFlagRejected() public {
        HvmMock.setOutputFlag(TXID, 0, 1000, P2WPKH, 2);
        (bool ok, Hvm.Output memory o) = h.output(TXID, 0, 100);
        assertFalse(ok);
        assertEq(o.sats, 0);
        // 0x00 never occurs on mainnet; if it did, it is not read as an answer
        HvmMock.setAny(0x48, abi.encodePacked(uint64(1000), uint16(22), P2WPKH, uint8(0)));
        (ok,) = h.output(TXID, 0, 100);
        assertFalse(ok);
    }

    function test_output_lengthMismatch() public {
        // says 22-byte script but carries 21
        HvmMock.setAny(0x48, abi.encodePacked(uint64(1000), uint16(22), new bytes(21), uint8(1)));
        (bool ok,) = h.output(TXID, 0, 100);
        assertFalse(ok);
        HvmMock.setAny(0x48, new bytes(10));
        (ok,) = h.output(TXID, 0, 100);
        assertFalse(ok);
    }

    function test_output_unknownIsNoAnswer() public view {
        (bool ok,) = h.output(TXID, 9, 100);
        assertFalse(ok);
    }

    // ---- 0x49 ----------------------------------------------------------------------------------

    function test_witness() public {
        HvmMock.setWitness(TXID, 0, 1, hex"0102030405");
        (bool ok, uint16 len, bytes memory item) = h.witness(TXID, 0, 1, 100);
        assertTrue(ok);
        assertEq(len, 5);
        assertEq(item, hex"0102030405");
        (ok, len, item) = h.witness(TXID, 0, 1, 2);
        assertTrue(ok);
        assertEq(len, 5);
        assertEq(item, hex"0102");
    }

    function test_witness_malformed() public {
        HvmMock.setAny(0x49, abi.encodePacked(uint16(5), hex"0102"));
        (bool ok,,) = h.witness(TXID, 0, 0, 100);
        assertFalse(ok);
    }

    // ---- failures ------------------------------------------------------------------------------

    function test_everyPrecompileFailureIsOkFalse() public {
        for (uint160 p = 0x40; p <= 0x49; ++p) HvmMock.setFail(p, true);
        (bool ok,) = h.balance(ADDR);
        assertFalse(ok);
        (ok,) = h.utxos(ADDR, 0, 0);
        assertFalse(ok);
        (ok,) = h.txByTxid(TXID, 0x40000000);
        assertFalse(ok);
        (ok,) = h.confirmations(TXID);
        assertFalse(ok);
        (ok,) = h.lastHeader();
        assertFalse(ok);
        (ok,) = h.headerAt(1);
        assertFalse(ok);
        (ok,) = h.addressScript(ADDR);
        assertFalse(ok);
        (ok,) = h.input(TXID, 0, 10);
        assertFalse(ok);
        (ok,) = h.output(TXID, 0, 10);
        assertFalse(ok);
        (ok,,) = h.witness(TXID, 0, 0, 10);
        assertFalse(ok);
    }

    // ---- fuzz: any bytes from any precompile never make the library revert --------------------

    function testFuzz_neverReverts(bytes memory junk, bytes32 txid, uint16 idx, uint16 max) public {
        for (uint160 p = 0x40; p <= 0x49; ++p) HvmMock.setAny(p, junk);
        h.balance(ADDR);
        h.utxos(ADDR, 0, 0);
        h.txByTxid(txid, 0x40000000);
        h.containingBlock(txid);
        h.confirmations(txid);
        h.lastHeader();
        h.headerAt(uint32(idx));
        h.addressScript(ADDR);
        h.input(txid, idx, max);
        h.output(txid, idx, max);
        h.outputFull(txid, idx);
        h.witness(txid, idx, idx, max);
        h.txOutputs(txid);
        h.spendStatus(txid, idx, 1, keccak256(junk));
    }

    function testFuzz_outputRoundTrip(bytes memory script, uint64 sats, uint16 idx, uint16 max, bool spent) public {
        vm.assume(script.length <= 2000);
        HvmMock.setOutput(TXID, idx, sats, script, spent);
        (bool ok, Hvm.Output memory o) = h.output(TXID, idx, max);
        assertEq(ok, !spent);
        if (spent) return;
        assertEq(o.sats, sats);
        assertEq(o.scriptLength, script.length);
        uint256 cut = script.length < max ? script.length : max;
        assertEq(o.script.length, cut);
    }

    // ---- 0x42 outputs and spendStatus ----------------------------------------------------------

    bytes32 internal constant SPENT_TXID = 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e;
    bytes internal constant SPENT_SCRIPT = hex"0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4";

    /// @dev The exact bytes mainnet's 0x42 returned for the spent fixture with flags 003c0703 (DECISIONS.md D-004).
    function _mainnetSpentFixture() internal {
        HvmMock.setRaw(
            0x42,
            abi.encodePacked(SPENT_TXID, Hvm.TX_FLAGS_OUTPUTS),
            hex"0002000000001b8430890022512068d343ef205a6afa4ae74508ab4aefb92dd46549e30d5eecf63acf3155c0798e000000000004f33e1000220020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c400"
        );
    }

    function test_txOutputs_mainnetBytes() public {
        _mainnetSpentFixture();
        (bool ok, uint256 total, Hvm.TxOutput[] memory outs) = h.txOutputs(SPENT_TXID);
        assertTrue(ok);
        assertEq(total, 2);
        assertEq(outs.length, 2);
        assertEq(outs[0].sats, 461_648_009);
        assertEq(outs[0].scriptLength, 34);
        assertFalse(outs[0].inUtxoSet);
        assertEq(outs[1].sats, 83_050_000);
        assertEq(outs[1].script, SPENT_SCRIPT);
        assertFalse(outs[1].inUtxoSet);
    }

    function test_txOutputs_fromTypedMock() public {
        HvmMock.setOutput(TXID, 0, 1000, P2WPKH, false);
        HvmMock.setOutput(TXID, 1, 859, hex"0014208fa508568396937efe008cbae70b4fe8a1ae45", true);
        (bool ok, uint256 total, Hvm.TxOutput[] memory outs) = h.txOutputs(TXID);
        assertTrue(ok);
        assertEq(total, 2);
        assertTrue(outs[0].inUtxoSet);
        assertFalse(outs[1].inUtxoSet);
        assertEq(outs[1].sats, 859);
    }

    function test_txOutputs_longScriptCutTo128() public {
        bytes memory s = new bytes(200);
        HvmMock.setOutput(TXID, 0, 1, s, false);
        (bool ok,, Hvm.TxOutput[] memory outs) = h.txOutputs(TXID);
        assertTrue(ok);
        assertEq(outs[0].scriptLength, 200);
        assertEq(outs[0].script.length, 128);
    }

    function test_txOutputs_malformed() public {
        // bad UTXO byte
        HvmMock.setAny(0x42, abi.encodePacked(uint16(1), uint64(5), uint16(1), hex"51", uint8(2)));
        (bool ok,,) = h.txOutputs(TXID);
        assertFalse(ok);
        // trailing junk
        HvmMock.setAny(0x42, abi.encodePacked(uint16(1), uint64(5), uint16(1), hex"51", uint8(1), hex"00"));
        (ok,,) = h.txOutputs(TXID);
        assertFalse(ok);
        // count says 2, one present
        HvmMock.setAny(0x42, abi.encodePacked(uint16(2), uint64(5), uint16(1), hex"51", uint8(1)));
        (ok,,) = h.txOutputs(TXID);
        assertFalse(ok);
        // script length longer than the bytes present
        HvmMock.setAny(0x42, abi.encodePacked(uint16(1), uint64(5), uint16(9), hex"51", uint8(1)));
        (ok,,) = h.txOutputs(TXID);
        assertFalse(ok);
    }

    function test_spendStatus_unspent() public {
        HvmMock.setOutput(TXID, 0, 1000, P2WPKH, false);
        assertEq(uint8(h.spendStatus(TXID, 0, 1000, keccak256(P2WPKH))), uint8(Hvm.Spend.Unspent));
    }

    function test_spendStatus_spentOnMainnetBytes() public {
        _mainnetSpentFixture();
        assertEq(uint8(h.spendStatus(SPENT_TXID, 1, 83_050_000, keccak256(SPENT_SCRIPT))), uint8(Hvm.Spend.Spent));
    }

    function test_spendStatus_unknownCases() public {
        // nothing indexed
        assertEq(uint8(h.spendStatus(TXID, 0, 1000, keccak256(P2WPKH))), uint8(Hvm.Spend.Unknown));
        // unspent but the expectation does not match
        HvmMock.setOutput(TXID, 0, 1000, P2WPKH, false);
        assertEq(uint8(h.spendStatus(TXID, 0, 999, keccak256(P2WPKH))), uint8(Hvm.Spend.Unknown));
        assertEq(uint8(h.spendStatus(TXID, 0, 1000, keccak256("other"))), uint8(Hvm.Spend.Unknown));
        // spent path: value mismatch, index past the list
        _mainnetSpentFixture();
        assertEq(uint8(h.spendStatus(SPENT_TXID, 1, 1, keccak256(SPENT_SCRIPT))), uint8(Hvm.Spend.Unknown));
        assertEq(uint8(h.spendStatus(SPENT_TXID, 2, 83_050_000, keccak256(SPENT_SCRIPT))), uint8(Hvm.Spend.Unknown));
        // spent path but 0x42 has no answer
        HvmMock.setOutput(bytes32(uint256(5)), 0, 7, P2WPKH, true);
        HvmMock.setFail(0x42, true);
        assertEq(uint8(h.spendStatus(bytes32(uint256(5)), 0, 7, keccak256(P2WPKH))), uint8(Hvm.Spend.Unknown));
    }

    function test_spendStatus_scriptOver128OnSpentPathIsUnknown() public {
        bytes memory s = new bytes(129);
        HvmMock.setOutput(TXID, 0, 1, s, true);
        assertEq(uint8(h.spendStatus(TXID, 0, 1, keccak256(s))), uint8(Hvm.Spend.Unknown));
    }
}
