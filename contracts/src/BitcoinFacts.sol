// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Hvm} from "./Hvm.sol";

/// @title BitcoinFacts
/// @notice Records what a Bitcoin output holds and what a Bitcoin address holds, as of a named Bitcoin block, as
/// read through Hemi's hVM precompiles inside a Hemi transaction.
/// @dev Ownerless, non-upgradeable, holds no funds and refuses ETH (no receive, no fallback, nothing payable).
///
/// Rules (docs/BRIEF.md "Contract rules", DECISIONS.md D-004, D-005, D-011, D-014):
/// - `checkOutput` / `checkBalance` are views that never revert. They return a verdict and the fact. Fields are
///   filled as far as the checks got; only an `Ok` verdict makes them a fact.
/// - `recordOutput` / `recordBalance` run the same check in their own transaction, revert with
///   `NotRecordable(verdict)` unless it is `Ok`, store the fact under its id and emit every stored field. Anyone may
///   record. Recording an id that is already stored changes nothing: no event, no revert, the id is returned.
/// - Every fact is "as of" the Bitcoin header `0x44` reports in the same transaction (height and hash).
/// - A fact id is `keccak256(abi.encode(kind, subject, btcBlockHash))`:
///     output:  kind = KIND_OUTPUT,  subject = keccak256(abi.encodePacked(txid, uint16 vout))  (34 bytes hashed)
///     balance: kind = KIND_BALANCE, subject = keccak256(scriptPubKey from 0x46)
///   so two spellings of one address give one subject, and recording twice at one Bitcoin tip gives one id.
/// - Nothing is marked as consumed. A fact says what hVM saw; whether it may be relied on once is the caller's job.
///
/// Reads in an `eth_call` are live and not atomic (D-007): the Bitcoin view can move between two precompile calls of
/// one check. In a transaction all reads see one consensus view. Check by call, record by transaction.
contract BitcoinFacts {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice The outcome of a check. Only `Ok` is a positive answer; every other value means "no fact", and in
    /// particular nothing other than `Ok` with `spent == true` ever means "spent".
    enum Verdict {
        /// The fact is complete: every field holds hVM's answer.
        Ok,
        /// `0x44` gave no usable Bitcoin header, so nothing can be "as of" a block.
        NoBitcoinView,
        /// Output: `0x48` has no answer and `0x42` does not list the transaction or that vout (the transaction is
        /// not in hVM's index, `0x42`'s answer is unusable, or vout is at or past the output count).
        NotFound,
        /// Output: not in the UTXO set, and vout is 128 or higher, past `0x42`'s 128-output window. It is spent or
        /// unspendable, but which, and its value and script, cannot be read.
        VoutTooHigh,
        /// Output: the script is provably unspendable (btcd `txscript.IsUnspendable`: starts with OP_RETURN, is
        /// longer than 10,000 bytes, or does not parse), or the output is a genesis-block coinbase, which Bitcoin
        /// never lets anyone spend though hVM lists it in its UTXO set. Neither spent nor unspent.
        Unspendable,
        /// Output: not in the UTXO set and its script is longer than 128 bytes, which `0x42` cuts, so its hash
        /// cannot be computed.
        ScriptTooLong,
        /// Output: `0x42` lists it as in the UTXO set but `0x48` gave no answer for it.
        Inconsistent,
        /// Output: `0x43` failed, or gave 0 or a count above the `0x44` height + 1,000 (an underflow, D-011), for a
        /// transaction `0x48` or `0x42` answered for.
        NoConfirmations,
        /// Balance: the address is shorter than 24 or longer than 200 bytes, or `0x46` could not decode it.
        BadAddress,
        /// Balance: `0x40` gave no answer for an address `0x46` decoded.
        NoBalance
    }

    /// @notice Which mapping an id is stored in.
    enum Kind {
        None,
        Output,
        Balance
    }

    /// @notice A stored output fact: one mapping entry, four storage slots.
    struct OutputFact {
        bytes32 txid; // display order
        bytes32 scriptHash; // keccak256 of the complete scriptPubKey
        bytes32 btcBlockHash; // as of: 0x44's hash, display order
        uint64 sats;
        uint32 confirmations; // 0x43 at recording: Bitcoin's own count (offset 0, D-005)
        uint32 btcHeight; // as of: 0x44's height
        uint64 hemiBlock; // the Hemi block of the recording transaction
        uint16 vout;
        uint16 scriptLength;
        bool spent; // true: spent as of btcBlockHash (D-014); false: unspent (in the UTXO set)
    }

    /// @notice A stored balance fact: one mapping entry, three storage slots.
    struct BalanceFact {
        bytes32 scriptHash; // the subject: keccak256 of the scriptPubKey 0x46 gives for the address
        bytes32 btcBlockHash; // as of
        uint64 sats; // 0x40: confirmed balance as of btcBlockHash
        uint32 btcHeight; // as of
        uint64 hemiBlock; // the Hemi block of the recording transaction
        uint16 scriptLength;
    }

    /// @notice What `checkOutput` returns. `id` is set once the header is known; `recorded` says whether that id
    /// is already stored. `script` is the complete scriptPubKey when the verdict is Ok (it is emitted, not stored).
    struct OutputCheck {
        Verdict verdict;
        bytes32 id;
        bool recorded;
        uint64 sats;
        bytes32 scriptHash;
        uint16 scriptLength;
        bool spent;
        uint32 confirmations;
        uint32 btcHeight;
        bytes32 btcBlockHash;
        bytes script;
    }

    /// @notice What `checkBalance` returns. `id` is set once the header and the script are known.
    struct BalanceCheck {
        Verdict verdict;
        bytes32 id;
        bool recorded;
        uint64 sats;
        bytes32 scriptHash;
        uint16 scriptLength;
        uint32 btcHeight;
        bytes32 btcBlockHash;
        bytes script;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant KIND_OUTPUT = keccak256("hemi-bitcoin-facts/output");
    bytes32 public constant KIND_BALANCE = keccak256("hemi-bitcoin-facts/balance");
    /// @notice Mainnet's op-geth rejects longer address strings in 0x40 and 0x46 (D-011); refusing them here first
    /// keeps a failing 0x46 call from burning its gas cap. The same limit as `Hvm.MAX_ADDRESS_BYTES`.
    uint256 public constant MAX_ADDRESS_BYTES = Hvm.MAX_ADDRESS_BYTES;
    /// @notice A 0x43 count above the 0x44 height plus this is an underflow, not a count (D-011).
    uint256 public constant CONFIRMATIONS_SLACK = 1000;
    /// @notice btcd's txscript.MaxScriptSize: a longer scriptPubKey is unspendable.
    uint256 internal constant MAX_SCRIPT_SIZE = 10_000;
    uint8 internal constant OP_RETURN = 0x6a;
    /// @notice The genesis block's coinbase (display order) on mainnet, testnet3, signet and regtest. hVM lists its
    /// 50 BTC output as in the UTXO set, but Bitcoin has never allowed it to be spent, so it is reported Unspendable
    /// (security review finding 3).
    bytes32 public constant GENESIS_COINBASE_TXID = 0x4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b;
    /// @notice testnet4's genesis coinbase, for the same reason (delta review finding 4: heminetwork supports
    /// testnet4, and CREATE2 puts the same bytecode on every chain).
    bytes32 public constant TESTNET4_GENESIS_COINBASE_TXID =
        0x7aa0a7ae1e223414cb807e40cd57e667b718e42aaf9306db9102fe28912b7b4e;

    // ---------------------------------------------------------------------------------------------
    // Storage, events, errors
    // ---------------------------------------------------------------------------------------------

    mapping(bytes32 id => OutputFact) private _outputs;
    mapping(bytes32 id => BalanceFact) private _balances;

    /// @notice Every stored field of a new output fact, plus the script itself (emitted, not stored).
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

    /// @notice Every stored field of a new balance fact, plus the scriptPubKey (emitted, not stored).
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

    /// @notice A record call whose check did not return Ok.
    error NotRecordable(Verdict verdict);

    // ---------------------------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------------------------

    /// @notice What hVM says about output `vout` of Bitcoin transaction `txid` (display order). Never reverts.
    /// @dev Unspent comes from 0x48 (complete script up to 10,000 bytes). 0x48 gives no answer for a spent output
    /// (D-004), so spent comes from 0x42: the transaction listed, the vout present, its complete script (128 bytes
    /// or fewer) and UTXO byte 0x00, and the script spendable (D-014). The verdict is the first failing step:
    /// NoBitcoinView; then Unspendable for either genesis coinbase (any vout, before any output call); then
    /// NotFound, VoutTooHigh, Inconsistent, Unspendable, ScriptTooLong (reading the output); then NoConfirmations.
    function checkOutput(bytes32 txid, uint16 vout) external view returns (OutputCheck memory) {
        return _checkOutput(txid, vout);
    }

    /// @notice Runs `checkOutput` and stores the fact if it is Ok and new. Returns the fact id either way.
    function recordOutput(bytes32 txid, uint16 vout) external returns (bytes32 id) {
        OutputCheck memory c = _checkOutput(txid, vout);
        if (c.verdict != Verdict.Ok) revert NotRecordable(c.verdict);
        id = c.id;
        if (c.recorded) return id;
        // A Hemi block number fits in 64 bits for the next billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 hemiBlock = uint64(block.number);
        _outputs[id] = OutputFact({
            txid: txid,
            scriptHash: c.scriptHash,
            btcBlockHash: c.btcBlockHash,
            sats: c.sats,
            confirmations: c.confirmations,
            btcHeight: c.btcHeight,
            hemiBlock: hemiBlock,
            vout: vout,
            scriptLength: c.scriptLength,
            spent: c.spent
        });
        _emitOutput(id, txid, vout, c, hemiBlock);
    }

    /// @notice The stored output fact with this id; all zero if none.
    function outputFact(bytes32 id) external view returns (OutputFact memory) {
        return _outputs[id];
    }

    // ---------------------------------------------------------------------------------------------
    // Balances
    // ---------------------------------------------------------------------------------------------

    /// @notice The confirmed balance of a Bitcoin address as of the 0x44 header. Never reverts.
    /// @dev The subject is keccak256 of the scriptPubKey from 0x46, so every spelling of an address that decodes to
    /// one script gives one subject. 0x46 fails (and burns its capped gas) on an address it cannot decode; that is
    /// the BadAddress verdict. The verdict is the first failing step: NoBitcoinView, BadAddress, NoBalance.
    function checkBalance(string calldata btcAddress) external view returns (BalanceCheck memory) {
        return _checkBalance(btcAddress);
    }

    /// @notice Runs `checkBalance` and stores the fact if it is Ok and new. Returns the fact id either way.
    function recordBalance(string calldata btcAddress) external returns (bytes32 id) {
        BalanceCheck memory c = _checkBalance(btcAddress);
        if (c.verdict != Verdict.Ok) revert NotRecordable(c.verdict);
        id = c.id;
        if (c.recorded) return id;
        // A Hemi block number fits in 64 bits for the next billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 hemiBlock = uint64(block.number);
        _balances[id] = BalanceFact({
            scriptHash: c.scriptHash,
            btcBlockHash: c.btcBlockHash,
            sats: c.sats,
            btcHeight: c.btcHeight,
            hemiBlock: hemiBlock,
            scriptLength: c.scriptLength
        });
        // Every hVM call is a STATICCALL to a precompile, so nothing can re-enter before this event.
        // forge-lint: disable-start(reentrancy-events)
        emit BalanceRecorded(
            id, c.scriptHash, c.btcBlockHash, c.sats, c.scriptLength, c.btcHeight, hemiBlock, c.script
        );
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @notice The stored balance fact with this id; all zero if none.
    function balanceFact(bytes32 id) external view returns (BalanceFact memory) {
        return _balances[id];
    }

    // ---------------------------------------------------------------------------------------------
    // Ids
    // ---------------------------------------------------------------------------------------------

    /// @notice Which kind of fact is stored under `id`, or None.
    function kindOf(bytes32 id) external view returns (Kind) {
        if (_outputs[id].btcBlockHash != bytes32(0)) return Kind.Output;
        if (_balances[id].btcBlockHash != bytes32(0)) return Kind.Balance;
        return Kind.None;
    }

    function factId(bytes32 kind, bytes32 subject, bytes32 btcBlockHash) public pure returns (bytes32) {
        return keccak256(abi.encode(kind, subject, btcBlockHash));
    }

    function outputSubject(bytes32 txid, uint16 vout) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(txid, vout));
    }

    function outputId(bytes32 txid, uint16 vout, bytes32 btcBlockHash) public pure returns (bytes32) {
        return factId(KIND_OUTPUT, outputSubject(txid, vout), btcBlockHash);
    }

    /// @param scriptHash keccak256 of the scriptPubKey (the subject)
    function balanceId(bytes32 scriptHash, bytes32 btcBlockHash) public pure returns (bytes32) {
        return factId(KIND_BALANCE, scriptHash, btcBlockHash);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _checkOutput(bytes32 txid, uint16 vout) internal view returns (OutputCheck memory c) {
        (bool headerOk, Hvm.Header memory h) = Hvm.lastHeader();
        if (!headerOk) {
            c.verdict = Verdict.NoBitcoinView;
            return c;
        }
        c.btcHeight = h.height;
        c.btcBlockHash = h.hash;
        c.id = outputId(txid, vout, h.hash);
        c.recorded = _outputs[c.id].btcBlockHash != bytes32(0);

        Verdict v = _readOutput(c, txid, vout);
        if (v != Verdict.Ok) {
            c.verdict = v;
            return c;
        }

        (bool confOk, uint32 conf) = Hvm.confirmations(txid);
        if (!confOk || conf == 0 || uint256(conf) > uint256(h.height) + CONFIRMATIONS_SLACK) {
            c.verdict = Verdict.NoConfirmations;
            return c;
        }
        c.confirmations = conf;
        c.verdict = Verdict.Ok;
    }

    /// @dev Fills sats, scriptLength and, when complete, script, scriptHash and spent. Returns Ok or the verdict.
    function _readOutput(OutputCheck memory c, bytes32 txid, uint16 vout) private view returns (Verdict) {
        if (txid == GENESIS_COINBASE_TXID || txid == TESTNET4_GENESIS_COINBASE_TXID) return Verdict.Unspendable;
        (bool ok, Hvm.Output memory o) = Hvm.output(txid, vout, Hvm.MAX_SCRIPT_BYTES);
        if (ok) {
            // In the UTXO set: unspent. hVM's indexer leaves out of that set exactly the scripts btcd's
            // IsUnspendable rejects (security review: heminetwork crawler.go), so the full parse is not repeated
            // here (finding 4: it cost about 1.1M gas for a 10,000-byte script). The cheap checks stay: OP_RETURN
            // first, too long, or cut.
            c.sats = o.sats;
            c.scriptLength = o.scriptLength;
            if (o.scriptLength > MAX_SCRIPT_SIZE || (o.script.length > 0 && uint8(o.script[0]) == OP_RETURN)) {
                return Verdict.Unspendable;
            }
            if (o.script.length != o.scriptLength) return Verdict.ScriptTooLong;
            c.script = o.script;
            c.scriptHash = keccak256(o.script);
            c.spent = false;
            return Verdict.Ok;
        }

        // No answer from 0x48: spent, unspendable or unknown. Only a positive 0x42 listing counts (D-014).
        (bool txOk, uint256 total, Hvm.TxOutput[] memory outs) = Hvm.txOutputs(txid);
        if (!txOk || vout >= total) return Verdict.NotFound;
        if (vout >= outs.length) return Verdict.VoutTooHigh;
        Hvm.TxOutput memory t = outs[vout];
        c.sats = t.sats;
        c.scriptLength = t.scriptLength;
        if (t.inUtxoSet) return Verdict.Inconsistent;
        // UTXO byte 0x00 also means "unspendable", so an unspendable script is never reported spent.
        if (_isUnspendable(t.scriptLength, t.script)) return Verdict.Unspendable;
        if (t.script.length != t.scriptLength) return Verdict.ScriptTooLong;
        c.script = t.script;
        c.scriptHash = keccak256(t.script);
        c.spent = true;
        return Verdict.Ok;
    }

    function _checkBalance(string memory btcAddress) internal view returns (BalanceCheck memory c) {
        (bool headerOk, Hvm.Header memory h) = Hvm.lastHeader();
        if (!headerOk) {
            c.verdict = Verdict.NoBitcoinView;
            return c;
        }
        c.btcHeight = h.height;
        c.btcBlockHash = h.hash;

        uint256 len = bytes(btcAddress).length;
        if (len < Hvm.MIN_ADDRESS_BYTES || len > MAX_ADDRESS_BYTES) {
            c.verdict = Verdict.BadAddress;
            return c;
        }
        // 0x46 first (D-001): it decodes the address, and an undecodable one fails here, within its cap.
        (bool scriptOk, bytes memory script) = Hvm.addressScript(btcAddress);
        if (!scriptOk || script.length > type(uint16).max) {
            c.verdict = Verdict.BadAddress;
            return c;
        }
        c.script = script;
        // Checked against type(uint16).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        c.scriptLength = uint16(script.length);
        c.scriptHash = keccak256(script);
        c.id = balanceId(c.scriptHash, h.hash);
        c.recorded = _balances[c.id].btcBlockHash != bytes32(0);

        (bool balanceOk, uint64 sats) = Hvm.balance(btcAddress);
        if (!balanceOk) {
            c.verdict = Verdict.NoBalance;
            return c;
        }
        c.sats = sats;
        c.verdict = Verdict.Ok;
    }

    /// @dev Split out of recordOutput to keep the stack shallow.
    function _emitOutput(bytes32 id, bytes32 txid, uint16 vout, OutputCheck memory c, uint64 hemiBlock) private {
        // Every hVM call is a STATICCALL to a precompile, so nothing can re-enter before this event.
        // forge-lint: disable-start(reentrancy-events)
        emit OutputRecorded(
            id,
            txid,
            c.btcBlockHash,
            vout,
            c.sats,
            c.scriptHash,
            c.scriptLength,
            c.spent,
            c.confirmations,
            c.btcHeight,
            hemiBlock,
            c.script
        );
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @dev btcd's txscript.IsUnspendable for a script of full length `fullLength` whose first bytes are `script`:
    /// OP_RETURN first, longer than MAX_SCRIPT_SIZE, or (when `script` is complete) a push that runs past the end.
    function _isUnspendable(uint256 fullLength, bytes memory script) internal pure returns (bool) {
        if (fullLength > MAX_SCRIPT_SIZE) return true;
        if (script.length > 0 && uint8(script[0]) == OP_RETURN) return true;
        if (script.length != fullLength) return false; // cannot tell from a cut script; callers handle that
        return !_parses(script);
    }

    /// @dev Whether every data push in `s` fits inside it, as btcd's script tokenizer requires: 0x01–0x4b push that
    /// many bytes; OP_PUSHDATA1/2/4 (0x4c–0x4e) take a 1/2/4-byte little-endian length; every other opcode is one byte.
    function _parses(bytes memory s) internal pure returns (bool ok) {
        assembly ("memory-safe") {
            let p := add(s, 32)
            let n := mload(s)
            let i := 0
            ok := 1
            for {} lt(i, n) {} {
                let op := byte(0, mload(add(p, i)))
                i := add(i, 1)
                if and(gt(op, 0), lt(op, 0x4f)) {
                    let len := op
                    if gt(op, 0x4b) {
                        let w := 1
                        if eq(op, 0x4d) { w := 2 }
                        if eq(op, 0x4e) { w := 4 }
                        if gt(add(i, w), n) {
                            ok := 0
                            break
                        }
                        let word := mload(add(p, i))
                        len := byte(0, word)
                        if gt(w, 1) { len := or(len, shl(8, byte(1, word))) }
                        if gt(w, 2) { len := or(len, or(shl(16, byte(2, word)), shl(24, byte(3, word)))) }
                        i := add(i, w)
                    }
                    if gt(len, sub(n, i)) {
                        ok := 0
                        break
                    }
                    i := add(i, len)
                }
            }
        }
    }
}
