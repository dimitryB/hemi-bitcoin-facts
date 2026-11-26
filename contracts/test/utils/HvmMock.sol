// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Hvm} from "../../src/Hvm.sol";
import {IMockHvmAdmin, MockHvm, MOCK_HVM_ADMIN} from "../mocks/MockHvm.sol";

/// @notice Test helpers: etch MockHvm at 0x40–0x49 and configure it with typed setters.
library HvmMock {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function install() internal {
        bytes memory code = type(MockHvm).runtimeCode;
        for (uint160 a = 0x40; a <= 0x49; ++a) {
            vm.etch(address(a), code);
        }
    }

    function at(uint160 precompile) internal returns (IMockHvmAdmin) {
        vm.prank(MOCK_HVM_ADMIN);
        return IMockHvmAdmin(address(precompile));
    }

    // ---- generic -------------------------------------------------------------------------------

    function setRaw(uint160 precompile, bytes memory input, bytes memory response) internal {
        at(precompile).setRaw(input, response);
    }

    function setAny(uint160 precompile, bytes memory response) internal {
        at(precompile).setAny(response);
    }

    function clearAny(uint160 precompile) internal {
        at(precompile).clearAny();
    }

    function setFail(uint160 precompile, bool on) internal {
        at(precompile).setFail(on);
    }

    function setFailInput(uint160 precompile, bytes memory input) internal {
        at(precompile).setFailInput(input);
    }

    // ---- typed ---------------------------------------------------------------------------------

    function setBalance(string memory btcAddress, uint64 sats) internal {
        at(0x40).setBalance(btcAddress, sats);
    }

    function setBlock(bytes32 txid, bytes32 blockHash) internal {
        at(0x42).setBlock(txid, blockHash);
    }

    function setConfirmations(bytes32 txid, uint32 count) internal {
        at(0x43).setConfirmations(txid, count);
    }

    function setTip(Hvm.Header memory h) internal {
        at(0x44).setTip(encodeHeader(h));
    }

    /// @notice A tip at `height` with a hash derived from the height, and the same header at 0x45.
    function setTip(uint32 height) internal returns (Hvm.Header memory h) {
        h = header(height);
        setTip(h);
        setHeader(h);
    }

    function setHeader(Hvm.Header memory h) internal {
        at(0x45).setHeader(h.height, encodeHeader(h));
    }

    function setScript(string memory btcAddress, bytes memory script) internal {
        at(0x46).setScript(btcAddress, script);
    }

    function setInput(bytes32 txid, uint16 index, Hvm.Input memory inp) internal {
        at(0x47).setInput(
            txid, index, inp.witnessCount, inp.prevSats, inp.prevTxid, inp.prevVout, inp.sequence, inp.scriptSig
        );
    }

    /// @notice An output as mainnet's hVM shows it: unspent, 0x48 answers (flag 0x01) and 0x42 lists it with UTXO
    /// byte 0x01; spent (or an OP_RETURN), 0x48 gives no answer and 0x42 lists it with UTXO byte 0x00.
    function setOutput(bytes32 txid, uint16 index, uint64 sats, bytes memory script, bool spent) internal {
        setOutputFlag(txid, index, sats, script, spent ? 0 : Hvm.OUTPUT_FLAG_UNSPENT);
    }

    /// @notice Raw flag byte, written by both 0x48 and 0x42 (0 = spent/unspendable, 1 = unspent, else malformed).
    function setOutputFlag(bytes32 txid, uint16 index, uint64 sats, bytes memory script, uint8 flag) internal {
        at(0x48).setOutput(txid, index, sats, script, flag);
        at(0x42).setOutput(txid, index, sats, script, flag);
    }

    function setWitness(bytes32 txid, uint16 inputIndex, uint16 witnessIndex, bytes memory item) internal {
        at(0x49).setWitness(txid, inputIndex, witnessIndex, item);
    }

    // ---- encoding ------------------------------------------------------------------------------

    function header(uint32 height) internal pure returns (Hvm.Header memory h) {
        h = Hvm.Header({
            height: height,
            hash: keccak256(abi.encodePacked("btc-block", height)),
            version: 0x20000000,
            prevHash: height == 0 ? bytes32(0) : keccak256(abi.encodePacked("btc-block", height - 1)),
            merkleRoot: keccak256(abi.encodePacked("merkle", height)),
            time: 1_700_000_000 + height * 600,
            bits: 0x17034219,
            nonce: height
        });
    }

    function encodeHeader(Hvm.Header memory h) internal pure returns (bytes memory) {
        return abi.encodePacked(h.height, h.hash, h.version, h.prevHash, h.merkleRoot, h.time, h.bits, h.nonce);
    }
}
