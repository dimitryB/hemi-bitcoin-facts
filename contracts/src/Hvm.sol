// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Hvm
/// @notice Bounds-checked raw access to Hemi's hVM Bitcoin precompiles at 0x40–0x49.
/// @dev Layouts and gas are from hemilabs/op-geth branch `hemi`, commit 67f25b90, `core/vm/contracts.go` and
/// `params/protocol_params.go`. Mainnet runs op-geth 539f4e33, which has the same layouts and gas (DECISIONS.md
/// D-011); the spike checked every layout used here on mainnet (D-001 to D-011). Behaviour on mainnet today:
/// - `0x48` answers only for an output in the UTXO set, always with flag 0x01. Spent outputs, OP_RETURNs and
///   unknown txids or indexes all give no answer (D-004). `0x42` lists outputs with a byte that is 0x00 for spent
///   or unspendable; `spendStatus` combines the two into a rule that never reads "no answer" as "spent".
/// - `0x45` gives no answer at any height (D-006); `headerAt` is kept for when that is fixed.
/// - Witnesses are stripped: `0x49` gives no answer and `0x47`'s witness count is 0 (D-011).
///
/// Rules every function follows:
/// - One `staticcall` with raw bytes (never ABI) and an explicit gas cap. A failed hVM call burns all the gas it
///   is given (`0x43` on an unknown txid, `0x46` on an undecodable address), so the cap bounds that loss.
/// - `ok` comes first. It is false for a failed call, an empty return ("no answer", never zero) or a return whose
///   length does not fit the layout exactly. When `ok` is false every other return value is zero.
/// - Output is parsed by offset after one exact length check. Nothing here reverts.
/// - Txids and block hashes are bytes32 in display order (the order explorers print), as the precompiles take them.
/// - None of hBK's caps apply: any output index, any script length up to MAX_SCRIPT_BYTES.
library Hvm {
    // ---------------------------------------------------------------------------------------------
    // Addresses
    // ---------------------------------------------------------------------------------------------

    address internal constant BTC_BAL_ADDR = address(0x40);
    address internal constant BTC_UTXOS_ADDR_LIST = address(0x41);
    address internal constant BTC_TX_BY_TXID = address(0x42);
    address internal constant BTC_TX_CONFIRMATIONS = address(0x43);
    address internal constant BTC_LAST_HEADER = address(0x44);
    address internal constant BTC_HEADER_N = address(0x45);
    address internal constant BTC_ADDR_TO_SCRIPT = address(0x46);
    address internal constant BTC_INPUT_BY_TXID = address(0x47);
    address internal constant BTC_OUTPUT_BY_TXID = address(0x48);
    address internal constant BTC_TX_GET_INPUT_WITNESS = address(0x49);

    // ---------------------------------------------------------------------------------------------
    // Gas. Each precompile charges a fixed RequiredGas. The cap passed to each call is twice that, so a future
    // reprice of up to 2x does not silently break a non-upgradeable caller, while a failed call burns at most the
    // cap. See DECISIONS.md for the measured figures.
    // ---------------------------------------------------------------------------------------------

    uint256 internal constant GAS_BAL_ADDR = 50_000;
    uint256 internal constant GAS_UTXOS_ADDR_LIST = 100_000;
    uint256 internal constant GAS_TX_BY_TXID = 25_000;
    uint256 internal constant GAS_TX_CONFIRMATIONS = 5000;
    uint256 internal constant GAS_LAST_HEADER = 5000;
    uint256 internal constant GAS_HEADER_N = 6000;
    uint256 internal constant GAS_ADDR_TO_SCRIPT = 25_000;
    uint256 internal constant GAS_INPUT_BY_TXID = 15_000;
    uint256 internal constant GAS_OUTPUT_BY_TXID = 15_000;
    uint256 internal constant GAS_TX_GET_INPUT_WITNESS = 15_000;
    uint256 internal constant GAS_CAP_FACTOR = 2;

    // ---------------------------------------------------------------------------------------------
    // Limits and layout constants
    // ---------------------------------------------------------------------------------------------

    /// @notice Largest script, scriptSig or witness item a caller may request. Larger requests are clamped.
    uint256 internal constant MAX_SCRIPT_BYTES = 10_000;
    /// @notice The precompiles reject address strings shorter than this (op-geth MIN_BTC_ADDRESS_LENGTH).
    uint256 internal constant MIN_ADDRESS_BYTES = 24;
    /// @notice Mainnet's op-geth rejects longer address strings (D-011): 0x46 then burns its whole cap, and 0x40 and
    /// 0x41 burn theirs for an empty answer. The helpers below refuse them without a call.
    uint256 internal constant MAX_ADDRESS_BYTES = 200;
    /// @notice A header is height(4) hash(32) version(4) prev(32) merkle(32) time(4) bits(4) nonce(4).
    uint256 internal constant HEADER_BYTES = 116;
    /// @notice One 0x41 UTXO entry is txid(32) vout(2) sats(8).
    uint256 internal constant UTXO_ENTRY_BYTES = 42;
    /// @notice The only flag byte `0x48` writes. It comes from TBC's `ScriptHashAvailableToSpend`, which is true
    /// while the outpoint is in the UTXO set; a spent outpoint makes that lookup error, and `0x48` then gives no
    /// answer at all (spike check S4, DECISIONS.md D-004). Any other byte is treated as a malformed answer.
    uint8 internal constant OUTPUT_FLAG_UNSPENT = 1;
    /// @notice `0x42` flags: outputs (bit 5 of byte 2), their scripts (bit 4), unspendable outputs too (bit 3) and
    /// the UTXO byte (bit 2); up to 2^7 = 128 outputs (byte 3) and 2^(4+3) = 128 script bytes (byte 4).
    bytes4 internal constant TX_FLAGS_OUTPUTS = 0x003c0703;
    uint256 internal constant TX_MAX_OUTPUTS = 128;
    uint256 internal constant TX_MAX_SCRIPT_BYTES = 128;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    struct Header {
        uint32 height;
        bytes32 hash;
        uint32 version;
        bytes32 prevHash;
        bytes32 merkleRoot;
        uint32 time;
        uint32 bits;
        uint32 nonce;
    }

    /// @notice An output `0x48` answered for. An answer means the output is in the UTXO set, i.e. unspent.
    struct Output {
        uint64 sats;
        /// @dev The full script length as the precompile reports it (saturates at 65535).
        uint16 scriptLength;
        /// @dev The script, cut to the requested maximum. Complete when `script.length == scriptLength`.
        bytes script;
    }

    /// @notice One output as `0x42` lists it.
    struct TxOutput {
        uint64 sats;
        /// @dev Full script length (saturates at 65535).
        uint16 scriptLength;
        /// @dev Cut to TX_MAX_SCRIPT_BYTES.
        bytes script;
        /// @dev The UTXO byte: true (0x01) if in the UTXO set; false (0x00) if spent, unspendable, or on a lookup error.
        bool inUtxoSet;
    }

    /// @notice What can be said about whether an output is spent. `Unknown` is never read as either.
    enum Spend {
        Unknown,
        Unspent,
        Spent
    }

    struct Input {
        uint16 witnessCount;
        uint64 prevSats;
        bytes32 prevTxid;
        /// @dev Saturates at 65535.
        uint16 prevVout;
        uint16 scriptSigLength;
        bytes scriptSig;
        uint32 sequence;
    }

    struct Utxo {
        bytes32 txid;
        uint16 vout;
        uint64 sats;
    }

    // ---------------------------------------------------------------------------------------------
    // 0x40 btcBalAddr: address as ASCII -> sats (8)
    // ---------------------------------------------------------------------------------------------

    /// @notice Confirmed balance of a Bitcoin address as of the header `lastHeader` reports.
    function balance(string memory btcAddress) internal view returns (bool ok, uint64 sats) {
        bytes memory addr = bytes(btcAddress);
        if (addr.length < MIN_ADDRESS_BYTES || addr.length > MAX_ADDRESS_BYTES) return (false, 0);
        bytes memory ret;
        (ok, ret) = _call(BTC_BAL_ADDR, GAS_BAL_ADDR, addr);
        if (!ok || ret.length != 8) return (false, 0);
        sats = uint64(_uint(ret, 0, 8));
    }

    // ---------------------------------------------------------------------------------------------
    // 0x41 btcUtxosAddrList: address + page (3) + page size (1; 0 means 10) -> count (1) + count * 42
    // ---------------------------------------------------------------------------------------------

    /// @notice One page of an address's UTXOs.
    function utxos(string memory btcAddress, uint24 page, uint8 pageSize)
        internal
        view
        returns (bool ok, Utxo[] memory list)
    {
        uint256 len = bytes(btcAddress).length;
        if (len < MIN_ADDRESS_BYTES || len > MAX_ADDRESS_BYTES) return (false, list);
        bytes memory ret;
        (ok, ret) = _call(BTC_UTXOS_ADDR_LIST, GAS_UTXOS_ADDR_LIST, abi.encodePacked(btcAddress, page, pageSize));
        if (!ok || ret.length == 0) return (false, list);
        uint256 count = uint8(ret[0]);
        if (ret.length != 1 + count * UTXO_ENTRY_BYTES) return (false, list);
        list = new Utxo[](count);
        for (uint256 i; i < count; ++i) {
            uint256 off = 1 + i * UTXO_ENTRY_BYTES;
            list[i] = Utxo({
                txid: _bytes32(ret, off),
                vout: uint16(_uint(ret, off + 32, 2)),
                sats: uint64(_uint(ret, off + 34, 8))
            });
        }
    }

    // ---------------------------------------------------------------------------------------------
    // 0x42 btcTxByTxid: txid + 4 bitflag bytes -> the selected parts
    // ---------------------------------------------------------------------------------------------

    /// @notice Bit 6 of the first flag byte: include the containing block hash (32 bytes, first in the output).
    /// @dev op-geth reads the same bit as "include witness array size" for inputs, so set it only without inputs.
    bytes4 internal constant TX_FLAG_CONTAINING_BLOCK = 0x40000000;

    /// @notice Raw 0x42 call. The output layout depends on `flags`; see DECISIONS.md for the bit table.
    function txByTxid(bytes32 txid, bytes4 flags) internal view returns (bool ok, bytes memory data) {
        (ok, data) = _call(BTC_TX_BY_TXID, GAS_TX_BY_TXID, abi.encodePacked(txid, flags));
        if (!ok || data.length == 0) return (false, "");
    }

    /// @notice The hash (display order) of the Bitcoin block that contains `txid`, in hVM's tx index.
    function containingBlock(bytes32 txid) internal view returns (bool ok, bytes32 blockHash) {
        bytes memory ret;
        (ok, ret) = txByTxid(txid, TX_FLAG_CONTAINING_BLOCK);
        if (!ok || ret.length != 32) return (false, bytes32(0));
        blockHash = _bytes32(ret, 0);
    }

    /// @notice A transaction's outputs with their UTXO bytes, from `0x42` with TX_FLAGS_OUTPUTS.
    /// @return ok    false for no answer or a malformed one
    /// @return total the transaction's output count (saturates at 65535); `outs` holds the first min(total, 128)
    function txOutputs(bytes32 txid) internal view returns (bool ok, uint256 total, TxOutput[] memory outs) {
        bytes memory ret;
        (ok, ret) = txByTxid(txid, TX_FLAGS_OUTPUTS);
        if (!ok || ret.length < 2) return (false, 0, outs);
        total = _uint(ret, 0, 2);
        uint256 n = total < TX_MAX_OUTPUTS ? total : TX_MAX_OUTPUTS;
        outs = new TxOutput[](n);
        uint256 off = 2;
        for (uint256 i; i < n; ++i) {
            if (off + 10 > ret.length) return (false, 0, new TxOutput[](0));
            uint256 len = _uint(ret, off + 8, 2);
            uint256 cut = _min(len, TX_MAX_SCRIPT_BYTES);
            if (off + 11 + cut > ret.length) return (false, 0, new TxOutput[](0));
            uint8 utxo = uint8(ret[off + 10 + cut]);
            if (utxo > 1) return (false, 0, new TxOutput[](0));
            outs[i] = TxOutput({
                sats: uint64(_uint(ret, off, 8)),
                scriptLength: uint16(len),
                script: _slice(ret, off + 10, cut),
                inUtxoSet: utxo == 1
            });
            off += 11 + cut;
        }
        if (off != ret.length) return (false, 0, new TxOutput[](0));
    }

    /// @notice Whether output (`txid`, `vout`) holding exactly `sats` to the script with keccak256 `scriptHash` is
    /// spent, as of `lastHeader`. Only positive answers count:
    /// - Unspent: `0x48` answers for it (so it is in the UTXO set) with that value and script.
    /// - Spent: `0x48` gives no answer, and `0x42` lists the transaction with that output, value and complete
    ///   script, and its UTXO byte is 0x00. The caller must only ask about spendable scripts (not OP_RETURN), since
    ///   0x00 also means "unspendable".
    /// - Unknown: anything else (no answers, a mismatch, an index past 0x42's 128-output window, a script over
    ///   128 bytes on the spent path). Never read Unknown as spent or unspent.
    function spendStatus(bytes32 txid, uint16 vout, uint64 sats, bytes32 scriptHash) internal view returns (Spend) {
        (bool ok, bool complete, Output memory o) = outputFull(txid, vout);
        if (ok) {
            return complete && o.sats == sats && keccak256(o.script) == scriptHash ? Spend.Unspent : Spend.Unknown;
        }
        (bool txOk,, TxOutput[] memory outs) = txOutputs(txid);
        if (!txOk || vout >= outs.length) return Spend.Unknown;
        TxOutput memory t = outs[vout];
        if (t.inUtxoSet || t.sats != sats || t.script.length != t.scriptLength || keccak256(t.script) != scriptHash) {
            return Spend.Unknown;
        }
        return Spend.Spent;
    }

    // ---------------------------------------------------------------------------------------------
    // 0x43 btcTxConfirmations: txid (32) -> count (4)
    // ---------------------------------------------------------------------------------------------

    /// @notice Bitcoin confirmations of `txid`, counted against hVM's upstream tip (ahead of `lastHeader`).
    /// @dev Fails, burning the cap, for a txid hVM has not indexed.
    function confirmations(bytes32 txid) internal view returns (bool ok, uint32 count) {
        bytes memory ret;
        (ok, ret) = _call(BTC_TX_CONFIRMATIONS, GAS_TX_CONFIRMATIONS, abi.encodePacked(txid));
        if (!ok || ret.length != 4) return (false, 0);
        count = uint32(_uint(ret, 0, 4));
    }

    // ---------------------------------------------------------------------------------------------
    // 0x44 btcLastHeader / 0x45 btcHeaderN -> header (116)
    // ---------------------------------------------------------------------------------------------

    /// @notice The Bitcoin header hVM's indexers have reached. Balances, UTXO lists and spent flags are as of it.
    function lastHeader() internal view returns (bool ok, Header memory header) {
        bytes memory ret;
        (ok, ret) = _call(BTC_LAST_HEADER, GAS_LAST_HEADER, "");
        return _header(ok, ret);
    }

    /// @notice The canonical header at `height` in hVM's own index. No answer above `lastHeader().height`, and on
    /// mainnet today no answer at any height (D-006).
    function headerAt(uint32 height) internal view returns (bool ok, Header memory header) {
        bytes memory ret;
        (ok, ret) = _call(BTC_HEADER_N, GAS_HEADER_N, abi.encodePacked(height));
        (ok, header) = _header(ok, ret);
        if (ok && header.height != height) return (false, _emptyHeader());
    }

    // ---------------------------------------------------------------------------------------------
    // 0x46 btcAddrToScript: address as ASCII -> scriptPubKey
    // ---------------------------------------------------------------------------------------------

    /// @notice The scriptPubKey an address pays to. Fails, burning the cap, for an address that does not decode.
    function addressScript(string memory btcAddress) internal view returns (bool ok, bytes memory script) {
        bytes memory addr = bytes(btcAddress);
        if (addr.length < MIN_ADDRESS_BYTES || addr.length > MAX_ADDRESS_BYTES) return (false, "");
        (ok, script) = _call(BTC_ADDR_TO_SCRIPT, GAS_ADDR_TO_SCRIPT, addr);
        if (!ok || script.length == 0) return (false, "");
    }

    // ---------------------------------------------------------------------------------------------
    // 0x47 btcInputByTxid: txid + input index (2) + max scriptSig (2)
    //   -> witness count (2) + prevout sats (8) + prev txid (32) + prev vout (2) + scriptSig length (2)
    //      + scriptSig cut to max + sequence (4)
    // ---------------------------------------------------------------------------------------------

    function input(bytes32 txid, uint16 index, uint256 maxScriptSig) internal view returns (bool ok, Input memory inp) {
        uint16 max = _clampMax(maxScriptSig);
        bytes memory ret;
        (ok, ret) = _call(BTC_INPUT_BY_TXID, GAS_INPUT_BY_TXID, abi.encodePacked(txid, index, max));
        if (!ok || ret.length < 50) return (false, inp);
        uint16 sigLen = uint16(_uint(ret, 44, 2));
        uint256 cut = _min(sigLen, max);
        if (ret.length != 50 + cut) return (false, inp);
        inp.witnessCount = uint16(_uint(ret, 0, 2));
        inp.prevSats = uint64(_uint(ret, 2, 8));
        inp.prevTxid = _bytes32(ret, 10);
        inp.prevVout = uint16(_uint(ret, 42, 2));
        inp.scriptSigLength = sigLen;
        inp.scriptSig = _slice(ret, 46, cut);
        inp.sequence = uint32(_uint(ret, 46 + cut, 4));
    }

    // ---------------------------------------------------------------------------------------------
    // 0x48 btcOutputByTxid: txid + output index (2) + max script (2)
    //   -> sats (8) + full script length (2) + script cut to max + UTXO flag (1, always 0x01)
    // ---------------------------------------------------------------------------------------------

    /// @notice An unspent output. No answer (ok false) for a spent output, an OP_RETURN, or an unknown tx or index:
    /// use `spendStatus` to tell spent from unknown.
    function output(bytes32 txid, uint16 index, uint256 maxScript) internal view returns (bool ok, Output memory out) {
        uint16 max = _clampMax(maxScript);
        bytes memory ret;
        (ok, ret) = _call(BTC_OUTPUT_BY_TXID, GAS_OUTPUT_BY_TXID, abi.encodePacked(txid, index, max));
        if (!ok || ret.length < 11) return (false, out);
        uint16 scriptLen = uint16(_uint(ret, 8, 2));
        uint256 cut = _min(scriptLen, max);
        if (ret.length != 11 + cut) return (false, out);
        if (uint8(ret[10 + cut]) != OUTPUT_FLAG_UNSPENT) return (false, out);
        out.sats = uint64(_uint(ret, 0, 8));
        out.scriptLength = scriptLen;
        out.script = _slice(ret, 10, cut);
    }

    /// @notice `output` asking for the whole script (up to MAX_SCRIPT_BYTES). `complete` is false when it was cut.
    function outputFull(bytes32 txid, uint16 index) internal view returns (bool ok, bool complete, Output memory out) {
        (ok, out) = output(txid, index, MAX_SCRIPT_BYTES);
        complete = ok && out.script.length == out.scriptLength;
    }

    // ---------------------------------------------------------------------------------------------
    // 0x49 btcTxGetInputWitness: txid + input index (2) + witness index (2) + max (2)
    //   -> full length (2) + the item cut to max
    // ---------------------------------------------------------------------------------------------

    function witness(bytes32 txid, uint16 inputIndex, uint16 witnessIndex, uint256 maxBytes)
        internal
        view
        returns (bool ok, uint16 fullLength, bytes memory item)
    {
        uint16 max = _clampMax(maxBytes);
        bytes memory ret;
        (ok, ret) =
            _call(BTC_TX_GET_INPUT_WITNESS, GAS_TX_GET_INPUT_WITNESS, abi.encodePacked(txid, inputIndex, witnessIndex, max));
        if (!ok || ret.length < 2) return (false, 0, "");
        fullLength = uint16(_uint(ret, 0, 2));
        uint256 cut = _min(fullLength, max);
        if (ret.length != 2 + cut) return (false, 0, "");
        item = _slice(ret, 2, cut);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev The one place a precompile is called. `ok` is false on failure or empty return.
    function _call(address precompile, uint256 requiredGas, bytes memory data)
        private
        view
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = precompile.staticcall{gas: requiredGas * GAS_CAP_FACTOR}(data);
        if (!ok || ret.length == 0) return (false, "");
    }

    function _header(bool ok, bytes memory ret) private pure returns (bool, Header memory h) {
        if (!ok || ret.length != HEADER_BYTES) return (false, h);
        h.height = uint32(_uint(ret, 0, 4));
        h.hash = _bytes32(ret, 4);
        h.version = uint32(_uint(ret, 36, 4));
        h.prevHash = _bytes32(ret, 40);
        h.merkleRoot = _bytes32(ret, 72);
        h.time = uint32(_uint(ret, 104, 4));
        h.bits = uint32(_uint(ret, 108, 4));
        h.nonce = uint32(_uint(ret, 112, 4));
        if (h.hash == bytes32(0)) return (false, _emptyHeader());
        return (true, h);
    }

    function _emptyHeader() private pure returns (Header memory h) {}

    function _clampMax(uint256 requested) private pure returns (uint16) {
        return uint16(requested > MAX_SCRIPT_BYTES ? MAX_SCRIPT_BYTES : requested);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @dev Big-endian unsigned integer of `n` (1..32) bytes at `off`. Caller has checked `off + n <= b.length`.
    function _uint(bytes memory b, uint256 off, uint256 n) private pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := shr(sub(256, mul(n, 8)), mload(add(add(b, 32), off)))
        }
    }

    /// @dev 32 bytes at `off`. Caller has checked `off + 32 <= b.length`.
    function _bytes32(bytes memory b, uint256 off) private pure returns (bytes32 v) {
        assembly ("memory-safe") {
            v := mload(add(add(b, 32), off))
        }
    }

    /// @dev Copy of `len` bytes at `off`. Caller has checked `off + len <= b.length`.
    function _slice(bytes memory b, uint256 off, uint256 len) private pure returns (bytes memory out) {
        out = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(out, 32), add(add(b, 32), off), len)
        }
    }
}
