// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Hvm} from "./Hvm.sol";

/// @title PopFinality
/// @notice Records that a Hemi keystone's number and block hash prefix sit in a Bitcoin proof-of-proof (PoP)
/// transaction, read through Hemi's hVM precompiles inside a Hemi transaction, so a contract can ask how many Bitcoin
/// confirmations anchor a Hemi block, and whether it is Bitcoin-final (9 or more).
/// @dev Ownerless, non-upgradeable, holds no funds and refuses ETH (no receive, no fallback, nothing payable).
///
/// Keystones (docs/BRIEF.md "Verified context"; receipts `keystone.ts`). Every Hemi block K with K % 25 == 0 is a
/// keystone. PoP miners publish it on Bitcoin as an 83-byte OP_RETURN script: `6a 4c 50` + "HEMI" + a 76-byte
/// abbreviated keystone: [0] version 0x01, [1:5] L1 origin number, [5:9] L2 number (K), [9:20] parent hash prefix,
/// [20:32] previous keystone (block K − 25) hash prefix, [32:64] state root, [64:76] block K's hash prefix.
/// Integers are big-endian.
///
/// What a recorded publication attests, and what it does not:
/// - It attests that a Bitcoin transaction hVM has indexed carries, at the recorded output, a PoP script whose
///   L2 number is K and whose block hash prefix equals the first 12 bytes of block K's hash on this chain. With
///   `btcConfirmationsVia`, how many Bitcoin confirmations that transaction has now.
/// - It does NOT check the other keystone fields (L1 origin number, parent hash prefix, previous keystone hash
///   prefix, state root). Hemi's own rule (bfgd, op-node) counts a publication only if all 76 bytes equal the
///   canonical keystone, so this contract is looser: anyone who knows block K's hash can publish an OP_RETURN that
///   passes here and that Hemi's consensus ignores, for one Bitcoin transaction fee. A 12-byte prefix of block K's
///   hash in a Bitcoin block proves that block K existed by then ("anchored on Bitcoin"); it does not prove Hemi's
///   PoP machinery counted it. The L1 origin is not in block K's header, so a header could not pin it
///   (docs/streams/b-finality.md B-3; docs/security-review.md finding 1).
/// - Like every hVM read, the answer is what Hemi's full nodes recomputed; nothing proves it to a light client.
///
/// Every valid publication is kept (docs/streams/b-finality.md B-18), each once, keyed by (K, txid, vout), so a
/// forgery can never stop the real publication from being recorded. Two ways to ask about a block:
/// - `isBtcFinalVia(block, K, txid, vout)` / `btcConfirmationsVia`: about one stored publication the caller names.
///   **This is the Hemi PoP finality question**, provided the caller has checked off chain that all 76 bytes of that
///   publication equal the canonical keystone (as `hbf finality status` and `verify` do, and as the receipts SDK's
///   reader does). The contract does not check those bytes; naming a forged publication gives a forged answer.
/// - `isBtcAnchored(block, K)` / `anchorConfirmations`: about K's "best" publication, a pointer re-chosen on every
///   submission: a valid candidate replaces it if it has strictly more confirmations, or if the best no longer
///   verifies (then the first valid submission becomes the best, whatever its count, until a better one is
///   re-submitted; delta review finding 3). It means **"block K's number and hash prefix are anchored on Bitcoin under N confirmations"**,
///   nothing more. A forged keystone satisfies it for one Bitcoin fee, and a forgery mined before the real
///   publication stays the best. Do not use it as Hemi PoP finality.
///
/// Rules (docs/BRIEF.md "Contract rules"; DECISIONS.md D-003, D-005, D-008, D-011, D-018):
/// - The PoP output is read through `0x42` (`Hvm.txOutputs`), never `0x48`: an OP_RETURN is never in the UTXO set,
///   so `0x48` gives no answer for it (D-003). `0x42` lists it in full (83 bytes, under its 128-byte cut).
/// - `check…` functions are views that never revert. `checkpoint` and `recordPublication` run the same check in
///   their own transaction, revert `NotRecordable(verdict)` unless it is Ok, are permissionless and idempotent.
/// - Every publication carries the Bitcoin height and hash it is "as of", from `0x44` in the same transaction.
/// - Reads in an `eth_call` are live (D-007): check by call, record by transaction.
///
/// Block hashes. `blockhash` reaches 256 blocks back. Past that, the EIP-2935 history contract serves the hash up to
/// 8,191 blocks back (about 27 hours at 12 s) and reverts beyond (D-008). A keystone must therefore be checkpointed,
/// or its publication recorded, within 8,191 blocks of being cut. A missed keystone only delays the answer: a later
/// keystone anchors every earlier block, and the finality views take any keystone at or after the block's covering
/// keystone.
contract PopFinality {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice The outcome of a check. Only `Ok` is a positive answer. The first failing step decides it.
    enum Verdict {
        /// The check passed.
        Ok,
        /// K is 0, not a multiple of 25, or above 2^32 − 1 (the abbreviated keystone holds K in 4 bytes).
        NotKeystone,
        /// Block K is not in the past yet (K >= block.number), so its hash is not known.
        NotProduced,
        /// K has no checkpoint and block K's hash can no longer be read: more than 8,191 blocks back, or the
        /// EIP-2935 history contract is missing or gave no hash.
        OutsideWindow,
        /// `0x44` gave no usable Bitcoin header.
        NoBitcoinView,
        /// `0x42` gave no usable answer for the transaction (not in hVM's index, or malformed), or vout is at or past
        /// its output count.
        NotFound,
        /// vout is 128 or higher, past `0x42`'s 128-output window.
        VoutTooHigh,
        /// The output's script is not exactly 83 bytes.
        WrongLength,
        /// The script does not start with `6a4c5048454d49` (OP_RETURN OP_PUSHDATA1 0x50 "HEMI").
        WrongPrefix,
        /// `0x42` lists the OP_RETURN as in the UTXO set, which an OP_RETURN never is.
        Inconsistent,
        /// The abbreviated keystone's version byte is not 0x01.
        WrongVersion,
        /// The abbreviated keystone's L2 number (bytes [5:9]) is not K.
        WrongKeystone,
        /// The abbreviated keystone's block hash prefix (bytes [64:76]) is not block K's (the checkpoint).
        WrongBlockHash,
        /// `0x43` failed, or gave 0 or a count above the `0x44` height + 1,000 (an underflow, D-011).
        NoConfirmations,
        /// anchorConfirmations: K is before the block's covering keystone, so its publication does not anchor it.
        NotCovering,
        /// anchorConfirmations: no publication is recorded for K.
        NotRecorded
    }

    /// @notice A stored checkpoint: one slot.
    struct Checkpoint {
        bytes12 blockHashPrefix; // block K's hash [0:12]
        uint64 hemiBlock; // the Hemi block of the checkpointing transaction
    }

    /// @notice One stored publication: one mapping entry, three slots, under its subject (K, txid, vout).
    struct Publication {
        bytes32 btcTxid; // display order
        bytes32 btcBlockHash; // as of: 0x44's hash at recording
        uint64 hemiBlock; // the Hemi block of the recording transaction
        uint32 btcHeight; // as of: 0x44's height at recording
        uint32 confirmations; // 0x43 at recording: Bitcoin's own count (offset 0, D-005)
        uint16 vout;
    }

    /// @notice An abbreviated keystone, parsed.
    struct Keystone {
        uint8 version;
        uint32 l1Number;
        uint32 l2Number;
        bytes11 parentHashPrefix;
        bytes12 prevKeystoneHashPrefix;
        bytes32 stateRoot;
        bytes12 blockHashPrefix;
    }

    /// @notice What `checkPublication` returns. Fields are filled as far as the check got.
    struct PublicationCheck {
        Verdict verdict;
        /// The publication's id at this Bitcoin tip; set once 0x44 answered.
        bytes32 id;
        /// 0x43 now (Ok only).
        uint32 confirmations;
        uint32 btcHeight;
        bytes32 btcBlockHash;
        /// Block K's hash prefix the abrev is compared with, and whether it is stored (false: read now, and
        /// `recordPublication` stores it).
        bytes12 checkpoint;
        bool checkpointStored;
        Keystone keystone;
        /// The 76-byte abbreviated keystone (the script without its 7-byte prefix).
        bytes abrev;
        /// (K, btcTxid, vout) is already stored. `recordPublication` stores every Ok publication that is not.
        bool recorded;
        /// It is K's best publication now.
        bool best;
        /// `recordPublication` would make it K's best: Ok, not the best already, and K has no best, or the best fails
        /// the same check now, or this one has strictly more confirmations.
        bool becomesBest;
        /// K's best publication (zero if none) and its confirmations read now (0 if it fails the check now).
        bytes32 bestTxid;
        uint16 bestVout;
        uint32 bestConfirmations;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    /// @notice One keystone every 25 Hemi blocks (hemi.KeystoneHeaderPeriod).
    uint256 public constant KEYSTONE_PERIOD = 25;
    /// @notice The largest keystone: the largest multiple of 25 that fits in 32 bits (the abbreviated keystone's L2
    /// number), 4,294,967,275.
    uint256 public constant MAX_KEYSTONE = type(uint32).max - (type(uint32).max % KEYSTONE_PERIOD);
    /// @notice Bitcoin confirmations, counting the publication block, for Bitcoin finality (Hemi docs, bfgd v1).
    uint256 public constant BTC_FINAL_CONFIRMATIONS = 9;
    /// @notice A 0x43 count above the 0x44 height plus this is an underflow, not a count (D-011).
    uint256 public constant CONFIRMATIONS_SLACK = 1000;
    bytes32 public constant KIND_PUBLICATION = keccak256("hemi-bitcoin-facts/publication");
    uint256 public constant POP_SCRIPT_BYTES = 83;
    uint256 public constant ABREV_BYTES = 76;
    /// @notice OP_RETURN OP_PUSHDATA1 0x50 "HEMI".
    bytes7 public constant POP_SCRIPT_PREFIX = 0x6a4c5048454d49;
    uint8 public constant KEYSTONE_VERSION = 1;
    /// @notice The EIP-2935 block hash history contract, live on Hemi since Isthmus (D-008).
    address public constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;
    /// @notice EIP-2935 serves hashes of blocks at most this many blocks back.
    uint256 public constant HISTORY_SERVE_WINDOW = 8191;
    /// @notice The `blockhash` opcode reaches this many blocks back.
    uint256 public constant BLOCKHASH_WINDOW = 256;
    /// @dev The history contract's read path is a cold SLOAD and a few dozen opcodes (about 2,400 gas).
    uint256 internal constant HISTORY_GAS = 10_000;

    // ---------------------------------------------------------------------------------------------
    // Storage, events, errors
    // ---------------------------------------------------------------------------------------------

    mapping(uint256 keystone => Checkpoint) private _checkpoints;
    /// @dev Every stored publication, under its subject `publicationSubject(K, txid, vout)`.
    mapping(bytes32 subject => Publication) private _publications;
    /// @dev K's best publication (0 if none): see the contract NatSpec for how it is chosen. Not always the stored one
    /// with the most confirmations: after the best stops verifying, the next valid submission takes its place.
    mapping(uint256 keystone => bytes32 subject) private _best;

    /// @notice A new checkpoint: every stored field.
    event Checkpointed(uint256 indexed keystone, bytes12 blockHashPrefix, uint64 hemiBlock);

    /// @notice A new stored publication of `keystone`: every stored field, and the 76-byte abbreviated keystone
    /// (emitted, not stored).
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

    /// @notice K's best publication is now (btcTxid, vout), with `confirmations` read in this transaction; it was
    /// (previousTxid, previousVout), zero if K had none. The stored field is the pointer to the new best.
    event BestPublicationChanged(
        uint256 indexed keystone,
        bytes32 indexed btcTxid,
        uint16 vout,
        uint32 confirmations,
        bytes32 previousTxid,
        uint16 previousVout
    );

    /// @notice A checkpoint or record call whose check did not return Ok.
    error NotRecordable(Verdict verdict);

    // ---------------------------------------------------------------------------------------------
    // Checkpoints
    // ---------------------------------------------------------------------------------------------

    /// @notice Whether keystone K can be (or is) checkpointed, and block K's hash prefix. Never reverts.
    /// @return verdict  Ok, NotKeystone, NotProduced or OutsideWindow
    /// @return blockHashPrefix block K's hash [0:12] (stored, or read now)
    /// @return stored   true if the checkpoint is stored
    function checkCheckpoint(uint256 keystone)
        external
        view
        returns (Verdict verdict, bytes12 blockHashPrefix, bool stored)
    {
        return _checkpointOf(keystone);
    }

    /// @notice Stores the first 12 bytes of block K's hash, read by `blockhash` within 256 blocks and from the
    /// EIP-2935 history contract up to 8,191 blocks back. Permissionless; a second call changes nothing.
    function checkpoint(uint256 keystone) external returns (bytes12 blockHashPrefix) {
        (Verdict v, bytes12 prefix, bool stored) = _checkpointOf(keystone);
        if (v != Verdict.Ok) revert NotRecordable(v);
        if (!stored) _storeCheckpoint(keystone, prefix);
        return prefix;
    }

    /// @notice The stored checkpoint of K; all zero if none.
    function checkpointOf(uint256 keystone) external view returns (Checkpoint memory) {
        return _checkpoints[keystone];
    }

    // ---------------------------------------------------------------------------------------------
    // Publications
    // ---------------------------------------------------------------------------------------------

    /// @notice What hVM says about output `vout` of Bitcoin transaction `btcTxid` (display order) as a publication
    /// of keystone K, and what `recordPublication` would do with it. Never reverts.
    /// @dev Steps, the first failure being the verdict: NotKeystone, NotProduced (K itself); NoBitcoinView (0x44);
    /// NotFound, VoutTooHigh (0x42 lists the output); WrongLength, WrongPrefix, Inconsistent, WrongVersion,
    /// WrongKeystone (the script); OutsideWindow, WrongBlockHash (against the checkpoint, or block K's hash read now
    /// if none is stored); NoConfirmations (0x43, called last so a failed check never burns its cap).
    function checkPublication(uint256 keystone, bytes32 btcTxid, uint16 vout)
        external
        view
        returns (PublicationCheck memory)
    {
        return _checkPublication(keystone, btcTxid, vout);
    }

    /// @notice Runs `checkPublication` and, if it is Ok, stores the publication under (K, btcTxid, vout) unless it is
    /// stored already (checkpointing K first if no checkpoint is stored yet), then re-runs the choice of K's best: it
    /// becomes the best if K has none, or if, read in this same transaction, the best fails the check (for example
    /// its Bitcoin block was reorged away) or has strictly fewer confirmations. On a tie the best stays. So a
    /// publication is always recorded, whatever was recorded before it, and re-submitting a stored one restores a
    /// best that stopped verifying.
    /// @return created true if this call stored the publication (false: it was stored already)
    /// @return best true if it is K's best publication after the call
    function recordPublication(uint256 keystone, bytes32 btcTxid, uint16 vout)
        external
        returns (bool created, bool best)
    {
        PublicationCheck memory c = _checkPublication(keystone, btcTxid, vout);
        if (c.verdict != Verdict.Ok) revert NotRecordable(c.verdict);
        // k <= type(uint32).max: an Ok check passed _isKeystone.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 subject = publicationSubject(uint32(keystone), btcTxid, vout);
        if (!c.recorded) {
            if (!c.checkpointStored) _storeCheckpoint(keystone, c.checkpoint);
            // A Hemi block number fits in 64 bits for the next billions of years.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 hemiBlock = uint64(block.number);
            _publications[subject] = Publication({
                btcTxid: btcTxid,
                btcBlockHash: c.btcBlockHash,
                hemiBlock: hemiBlock,
                btcHeight: c.btcHeight,
                confirmations: c.confirmations,
                vout: vout
            });
            _emitPublication(keystone, btcTxid, vout, c, hemiBlock);
            created = true;
        }
        if (c.becomesBest) {
            _best[keystone] = subject;
            // Every external call is a STATICCALL (hVM precompiles, the history contract), so nothing re-enters.
            // forge-lint: disable-next-line(reentrancy-events)
            emit BestPublicationChanged(keystone, btcTxid, vout, c.confirmations, c.bestTxid, c.bestVout);
        }
        best = c.best || c.becomesBest;
    }

    /// @notice The stored publication (K, btcTxid, vout); all zero if it is not stored.
    function publicationOf(uint256 keystone, bytes32 btcTxid, uint16 vout) external view returns (Publication memory) {
        if (!_isKeystone(keystone)) return _publications[bytes32(0)];
        // forge-lint: disable-next-line(unsafe-typecast)
        return _publications[publicationSubject(uint32(keystone), btcTxid, vout)];
    }

    /// @notice K's best publication, as last chosen (see the contract NatSpec); all zero if none.
    function bestPublicationOf(uint256 keystone) external view returns (Publication memory) {
        return _publications[_best[keystone]];
    }

    // ---------------------------------------------------------------------------------------------
    // Finality
    // ---------------------------------------------------------------------------------------------

    /// @notice ANCHORED, NOT HEMI POP FINALITY: Bitcoin confirmations of keystone K's best stored publication, as the
    /// anchor of Hemi block `blockNumber`, read live from 0x43. Never reverts, so other contracts can call it safely.
    /// @dev It says that block K's number and 12-byte hash prefix sit in a Bitcoin transaction under this many
    /// confirmations. That transaction may be a forgery that Hemi's consensus ignores: anyone who knows block K's
    /// hash can publish one for one Bitcoin fee, and if it is mined before the real publication it stays the best.
    /// For Hemi PoP finality use `btcConfirmationsVia` with a publication whose 76 bytes were matched off chain.
    /// K must be at or after the block's covering keystone (the smallest multiple of 25 at or above it, see
    /// `coveringKeystone`): publishing keystone K commits to block K's hash and so to every earlier block. For a
    /// multiple of 25 that is simply K >= blockNumber. The count is Bitcoin's own (offset 0, D-005), counted against
    /// hVM's upstream tip. Called inside a transaction it is consensus; in an eth_call it is the node's live view. If
    /// the best's transaction stops verifying, this reads it anyway: NoConfirmations if `0x43` fails for it, else its
    /// count, until someone submits a publication (`recordPublication` re-runs the choice of the best).
    /// @return verdict Ok, NotKeystone, NotCovering, NotRecorded, NoBitcoinView or NoConfirmations
    /// @return confirmations 0 unless the verdict is Ok
    function anchorConfirmations(uint256 blockNumber, uint256 keystone)
        public
        view
        returns (Verdict verdict, uint32 confirmations)
    {
        if (!_isKeystone(keystone)) return (Verdict.NotKeystone, 0);
        if (keystone < blockNumber) return (Verdict.NotCovering, 0);
        return _liveConfirmations(_publications[_best[keystone]].btcTxid);
    }

    /// @notice ANCHORED, NOT HEMI POP FINALITY: true if `anchorConfirmations(blockNumber, keystone)` is Ok with 9 or more
    /// confirmations. Never reverts. A forged keystone makes it true for one Bitcoin fee (see `anchorConfirmations`);
    /// use `isBtcFinalVia` with an exact-matched publication for Hemi PoP finality. False means "not shown anchored
    /// through K", never "not final": another keystone may anchor the block.
    function isBtcAnchored(uint256 blockNumber, uint256 keystone) external view returns (bool) {
        (Verdict v, uint32 conf) = anchorConfirmations(blockNumber, keystone);
        return v == Verdict.Ok && conf >= BTC_FINAL_CONFIRMATIONS;
    }

    /// @notice Bitcoin confirmations of the stored publication (K, btcTxid, vout), as the anchor of Hemi block
    /// `blockNumber`, read live from 0x43. Never reverts.
    /// @dev This is the Hemi PoP finality reading when the caller has matched all 76 bytes of that publication with the
    /// canonical keystone off chain (bfgd's rule; `hbf finality status`/`verify` and the receipts SDK reader do). The
    /// contract checked only K and the block hash prefix when it was recorded. K must cover the block as in
    /// `anchorConfirmations`. The answer does not depend on which publication is K's best.
    /// @return verdict Ok, NotKeystone, NotCovering, NotRecorded (that publication is not stored), NoBitcoinView or
    /// NoConfirmations
    /// @return confirmations 0 unless the verdict is Ok
    function btcConfirmationsVia(uint256 blockNumber, uint256 keystone, bytes32 btcTxid, uint16 vout)
        public
        view
        returns (Verdict verdict, uint32 confirmations)
    {
        if (!_isKeystone(keystone)) return (Verdict.NotKeystone, 0);
        if (keystone < blockNumber) return (Verdict.NotCovering, 0);
        // forge-lint: disable-next-line(unsafe-typecast)
        Publication storage p = _publications[publicationSubject(uint32(keystone), btcTxid, vout)];
        if (p.btcBlockHash == bytes32(0)) return (Verdict.NotRecorded, 0);
        return _liveConfirmations(btcTxid);
    }

    /// @notice True if `btcConfirmationsVia(blockNumber, keystone, btcTxid, vout)` is Ok with 9 or more
    /// confirmations. Never reverts. Hemi PoP finality of the block when (K, btcTxid, vout) was matched off chain with
    /// all 76 bytes of the canonical keystone; the contract does not check that match.
    function isBtcFinalVia(uint256 blockNumber, uint256 keystone, bytes32 btcTxid, uint16 vout)
        external
        view
        returns (bool)
    {
        (Verdict v, uint32 conf) = btcConfirmationsVia(blockNumber, keystone, btcTxid, vout);
        return v == Verdict.Ok && conf >= BTC_FINAL_CONFIRMATIONS;
    }

    /// @notice The keystone that gives `blockNumber` its Bitcoin finality: the block itself if it is a nonzero
    /// multiple of 25, else the next multiple of 25 (op-node getKeystoneProvidingFinality; receipts
    /// `coveringKeystone`), so 25 for block 0, which every keystone commits to. 0, which is not a keystone, for a block
    /// above MAX_KEYSTONE. Every other answer is a keystone the views accept.
    function coveringKeystone(uint256 blockNumber) public pure returns (uint256) {
        if (blockNumber == 0) return KEYSTONE_PERIOD;
        if (blockNumber > MAX_KEYSTONE) return 0;
        uint256 r = blockNumber % KEYSTONE_PERIOD;
        return r == 0 ? blockNumber : blockNumber - r + KEYSTONE_PERIOD;
    }

    // ---------------------------------------------------------------------------------------------
    // Ids
    // ---------------------------------------------------------------------------------------------

    /// @notice keccak256(abi.encode(kind, subject, btcBlockHash)), as in BitcoinFacts.
    function factId(bytes32 kind, bytes32 subject, bytes32 btcBlockHash) public pure returns (bytes32) {
        return keccak256(abi.encode(kind, subject, btcBlockHash));
    }

    /// @notice keccak256(K as 4 big-endian bytes ‖ txid ‖ vout as 2 big-endian bytes): 38 bytes hashed.
    function publicationSubject(uint32 keystone, bytes32 btcTxid, uint16 vout) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(keystone, btcTxid, vout));
    }

    function publicationId(uint32 keystone, bytes32 btcTxid, uint16 vout, bytes32 btcBlockHash)
        public
        pure
        returns (bytes32)
    {
        return factId(KIND_PUBLICATION, publicationSubject(keystone, btcTxid, vout), btcBlockHash);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _isKeystone(uint256 k) internal pure returns (bool) {
        return k != 0 && k % KEYSTONE_PERIOD == 0 && k <= type(uint32).max;
    }

    function _plausible(uint32 conf, uint32 btcHeight) internal pure returns (bool) {
        return conf != 0 && uint256(conf) <= uint256(btcHeight) + CONFIRMATIONS_SLACK;
    }

    /// @dev The live 0x43 count of a stored publication's transaction, bounded by 0x44's height (D-011).
    function _liveConfirmations(bytes32 txid) private view returns (Verdict, uint32) {
        if (txid == bytes32(0)) return (Verdict.NotRecorded, 0);
        (bool headerOk, Hvm.Header memory h) = Hvm.lastHeader();
        if (!headerOk) return (Verdict.NoBitcoinView, 0);
        (bool ok, uint32 conf) = Hvm.confirmations(txid);
        if (!ok || !_plausible(conf, h.height)) return (Verdict.NoConfirmations, 0);
        return (Verdict.Ok, conf);
    }

    /// @dev Ok with the stored prefix, Ok with the prefix read now, or the reason neither is possible.
    function _checkpointOf(uint256 k) internal view returns (Verdict, bytes12, bool) {
        if (!_isKeystone(k)) return (Verdict.NotKeystone, bytes12(0), false);
        if (k >= block.number) return (Verdict.NotProduced, bytes12(0), false);
        // A stored checkpoint has a nonzero Hemi block (K >= 25 is below it); a prefix can be zero.
        Checkpoint memory cp = _checkpoints[k];
        if (cp.hemiBlock != 0) return (Verdict.Ok, cp.blockHashPrefix, true);
        bytes32 h = _blockHash(k);
        if (h == bytes32(0)) return (Verdict.OutsideWindow, bytes12(0), false);
        // The prefix is the point: the first 12 bytes, as the abbreviated keystone carries them.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (Verdict.Ok, bytes12(h), false);
    }

    function _storeCheckpoint(uint256 k, bytes12 prefix) private {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 hemiBlock = uint64(block.number);
        _checkpoints[k] = Checkpoint({blockHashPrefix: prefix, hemiBlock: hemiBlock});
        // The only external call before this is a STATICCALL (the history contract), so nothing re-enters.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Checkpointed(k, prefix, hemiBlock);
    }

    /// @dev Block n's hash: `blockhash` within 256 blocks, else EIP-2935 within 8,191; zero when neither answers.
    function _blockHash(uint256 n) internal view returns (bytes32 h) {
        if (n >= block.number) return bytes32(0);
        uint256 age = block.number - n;
        if (age <= BLOCKHASH_WINDOW) {
            h = blockhash(n);
            if (h != bytes32(0)) return h;
        }
        if (age > HISTORY_SERVE_WINDOW || HISTORY_STORAGE.code.length == 0) return bytes32(0);
        // get(n): the 32-byte block number in, the hash out; it reverts outside its window. At most 32 bytes are
        // copied back, whatever the callee returns.
        address target = HISTORY_STORAGE;
        uint256 gasCap = HISTORY_GAS;
        bool ok;
        uint256 size;
        assembly ("memory-safe") {
            mstore(0x00, n)
            ok := staticcall(gasCap, target, 0x00, 0x20, 0x00, 0x20)
            size := returndatasize()
            h := mload(0x00)
        }
        if (!ok || size != 32) return bytes32(0);
    }

    function _checkPublication(uint256 k, bytes32 txid, uint16 vout) internal view returns (PublicationCheck memory c) {
        if (!_isKeystone(k)) {
            c.verdict = Verdict.NotKeystone;
            return c;
        }
        if (k >= block.number) {
            c.verdict = Verdict.NotProduced;
            return c;
        }
        (bool headerOk, Hvm.Header memory h) = Hvm.lastHeader();
        if (!headerOk) {
            c.verdict = Verdict.NoBitcoinView;
            return c;
        }
        c.btcHeight = h.height;
        c.btcBlockHash = h.hash;
        // k <= type(uint32).max: checked by _isKeystone.
        // forge-lint: disable-next-line(unsafe-typecast)
        c.id = publicationId(uint32(k), txid, vout, h.hash);
        c.verdict = _readPublication(c, k, txid, vout, h.height);
        if (c.verdict != Verdict.Ok) return c;

        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 subject = publicationSubject(uint32(k), txid, vout);
        c.recorded = _publications[subject].btcBlockHash != bytes32(0);
        bytes32 bestSubject = _best[k];
        if (bestSubject == bytes32(0)) {
            c.becomesBest = true;
        } else if (bestSubject == subject) {
            c.best = true;
            c.bestTxid = txid;
            c.bestVout = vout;
            c.bestConfirmations = c.confirmations;
        } else {
            // Both read in this same call (or transaction): the best stays unless it fails now or has strictly fewer.
            Publication storage b = _publications[bestSubject];
            c.bestTxid = b.btcTxid;
            c.bestVout = b.vout;
            PublicationCheck memory bc;
            Verdict bv = _readPublication(bc, k, b.btcTxid, b.vout, h.height);
            c.bestConfirmations = bv == Verdict.Ok ? bc.confirmations : 0;
            c.becomesBest = bv != Verdict.Ok || c.confirmations > bc.confirmations;
        }
    }

    /// @dev The output, script and confirmation steps of the check. K is a valid keystone below block.number.
    function _readPublication(PublicationCheck memory c, uint256 k, bytes32 txid, uint16 vout, uint32 btcHeight)
        private
        view
        returns (Verdict)
    {
        (bool txOk, uint256 total, Hvm.TxOutput[] memory outs) = Hvm.txOutputs(txid);
        if (!txOk || vout >= total) return Verdict.NotFound;
        if (vout >= outs.length) return Verdict.VoutTooHigh;
        Hvm.TxOutput memory t = outs[vout];
        if (t.scriptLength != POP_SCRIPT_BYTES || t.script.length != POP_SCRIPT_BYTES) return Verdict.WrongLength;
        // The first 7 of 83 bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (bytes7(t.script) != POP_SCRIPT_PREFIX) return Verdict.WrongPrefix;
        if (t.inUtxoSet) return Verdict.Inconsistent;
        c.abrev = _abrev(t.script);
        c.keystone = _parseAbrev(c.abrev);
        if (c.keystone.version != KEYSTONE_VERSION) return Verdict.WrongVersion;
        if (c.keystone.l2Number != k) return Verdict.WrongKeystone;

        (Verdict cv, bytes12 prefix, bool stored) = _checkpointOf(k);
        c.checkpoint = prefix;
        c.checkpointStored = stored;
        if (cv != Verdict.Ok) return cv;
        if (c.keystone.blockHashPrefix != prefix) return Verdict.WrongBlockHash;

        (bool confOk, uint32 conf) = Hvm.confirmations(txid);
        if (!confOk || !_plausible(conf, btcHeight)) return Verdict.NoConfirmations;
        c.confirmations = conf;
        return Verdict.Ok;
    }

    /// @dev The 76 bytes after the 7-byte prefix of an 83-byte script.
    function _abrev(bytes memory script) private pure returns (bytes memory a) {
        a = new bytes(ABREV_BYTES);
        assembly ("memory-safe") {
            mcopy(add(a, 32), add(script, 39), 76)
        }
    }

    /// @dev Parses a 76-byte abbreviated keystone by offset.
    function _parseAbrev(bytes memory a) internal pure returns (Keystone memory k) {
        bytes32 w0;
        bytes32 w1;
        bytes32 w2;
        assembly ("memory-safe") {
            w0 := mload(add(a, 32)) // a[0:32]
            w1 := mload(add(a, 64)) // a[32:64]
            w2 := mload(add(a, 96)) // a[64:76], then whatever follows in memory (unused)
        }
        // Each cast keeps exactly the field's leading bytes after shifting it to the front.
        // forge-lint: disable-start(unsafe-typecast)
        k.version = uint8(w0[0]);
        k.l1Number = uint32(bytes4(w0 << 8));
        k.l2Number = uint32(bytes4(w0 << 40));
        k.parentHashPrefix = bytes11(w0 << 72);
        k.prevKeystoneHashPrefix = bytes12(w0 << 160);
        k.stateRoot = w1;
        k.blockHashPrefix = bytes12(w2);
        // forge-lint: disable-end(unsafe-typecast)
    }

    /// @dev Split out of recordPublication to keep the stack shallow.
    function _emitPublication(uint256 k, bytes32 txid, uint16 vout, PublicationCheck memory c, uint64 hemiBlock)
        private
    {
        // Every external call is a STATICCALL (hVM precompiles, the history contract), so nothing re-enters.
        // forge-lint: disable-start(reentrancy-events)
        emit PublicationRecorded(c.id, k, txid, vout, c.confirmations, c.btcHeight, c.btcBlockHash, hemiBlock, c.abrev);
        // forge-lint: disable-end(reentrancy-events)
    }
}
