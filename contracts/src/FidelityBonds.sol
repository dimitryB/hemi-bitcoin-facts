// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Hvm} from "./Hvm.sol";

/// @title FidelityBonds
/// @notice Records BTC that is time-locked on Bitcoin and named for an agent's EVM address, as read through Hemi's
/// hVM precompiles inside a Hemi transaction. A bond is proof of locked funds, not collateral: nothing here can
/// slash, move or hold anything, and the registry neither scores nor ranks bonds.
/// @dev Ownerless, non-upgradeable, holds no funds and refuses ETH (no receive, no fallback, nothing payable).
///
/// A bond (docs/BRIEF.md "FidelityBonds", DECISIONS.md D-004, D-014, D-017) is one Bitcoin output paying P2WSH of the
/// 42-byte witness script JoinMarket uses for fidelity bonds:
///     04 <locktime: 4 bytes little-endian> b1 75 21 <33-byte compressed key: 02/03…> ac
///     = <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG
/// with a timestamp locktime in [500,000,000, 2^31): at least the BIP65 timestamp threshold, and below 2^31 so the
/// 4-byte script number is positive (a negative one makes CLTV fail forever). Every such value needs all 4 bytes,
/// so the push is minimal. The same transaction carries a tag output, exactly
///     6a 30 "HFB1" <chain id: 4 bytes big-endian> <this contract: 20 bytes> <agent: 20 bytes>    (50 bytes)
/// which binds the bond to the agent when the transaction is signed. Nobody else can claim it later and no signature
/// is parsed here. A tunnel deposit's OP_RETURN (an EVM address as ASCII hex) cannot pass for it: an ASCII hex
/// string never starts with "H" and is not 48 bytes after `6a 30`.
///
/// Rules:
/// - `checkBond` is a view that never reverts and returns a verdict and the data; only `Ok` makes it a bond.
/// - `recordBond` runs the same check in its own transaction, reverts `NotRecordable(verdict)` unless it is `Ok`,
///   stores one entry per bond id and emits every stored field. One bond per output; anyone may record it, and
///   recording a stored id again changes nothing.
/// - `refresh` re-reads the spend status and marks a bond ended only on `Hvm.Spend.Spent`; `Unknown` and `Unspent`
///   change nothing (D-017). `liveBond` re-reads it inside the caller's own call, so a consumer never acts on a stale
///   flag, and never reports `Unknown` as live.
/// - Every recorded fact carries the Bitcoin height and hash it is "as of", from `0x44` in the same transaction.
///
/// What the tag and the thresholds do not cover (docs/security-review.md):
/// - The tag binds only if every input of the funding transaction signs SIGHASH_ALL (or taproot's DEFAULT). With
///   NONE or SINGLE a relayer could add a second tag (the bond is then AmbiguousTag for good) or tag an untagged
///   output for its own agent. Witnesses are stripped on mainnet's hVM, so this is not checked here; `hbf bond
///   create` signs ALL/DEFAULT only (finding 6).
/// - The key must be 02/03 with x below the field prime; whether it is on the curve is not checked. A bond to an
///   off-curve key can never be redeemed (finding 7).
/// - MIN_CONFIRMATIONS counts against hVM's upstream tip; in hVM's indexed view (`0x44`) that is about 4. "Live"
///   means unspent as of `0x44`, about two Bitcoin blocks behind. A consumer should require a margin before the
///   locktime rather than act on a bond that expires within the next hours (finding 8).
contract FidelityBonds {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice The outcome of `checkBond`, in the order the checks run: the first failing step. Only `Ok` is a bond.
    enum Verdict {
        /// Every requirement holds.
        Ok,
        /// The witness script is not the 42-byte template (length, an opcode, a push length, the key prefix, or a key
        /// x at or above the field prime).
        BadWitnessScript,
        /// The template matches but the locktime is below 500,000,000 (a height, or too small) or at least 2^31.
        BadLocktime,
        /// `0x44` gave no usable Bitcoin header.
        NoBitcoinView,
        /// `0x42` does not list the transaction (not in hVM's index, or no usable answer), or a vout is at or past
        /// its output count.
        NotFound,
        /// The transaction has more than 128 outputs, past `0x42`'s window, so the tag cannot be shown to be the
        /// only one.
        TooManyOutputs,
        /// The bond output's script is not `0x0020 ‖ sha256(witnessScript)`.
        NotABond,
        /// `Hvm.spendStatus` says the bond output is spent.
        Spent,
        /// `Hvm.spendStatus` cannot say whether it is spent (Unknown: only positive answers count, D-014).
        SpendUnknown,
        /// The tag output is not a 50-byte `6a 30 "HFB1" …` script naming a nonzero agent.
        BadTag,
        /// The tag names another chain id.
        WrongChain,
        /// The tag names another contract.
        WrongContract,
        /// Another output of the transaction is also an "HFB1" tag, for any chain, contract or agent (security
        /// review finding 5: one output must not be a bond in two registries).
        AmbiguousTag,
        /// The bond holds fewer than MIN_SATS.
        BelowFloor,
        /// `0x43` failed, or gave 0 or a count above the `0x44` height + 1,000 (an underflow, D-011).
        NoConfirmations,
        /// Fewer than MIN_CONFIRMATIONS Bitcoin confirmations.
        FewConfirmations
    }

    /// @notice What `liveBond` says about a stored bond now. The zero value is NotRecorded.
    enum Status {
        /// No bond is stored under this id.
        NotRecorded,
        /// Unspent (0x48 answers with its value and script), and both the 0x44 header's time and Hemi's
        /// block.timestamp are before the locktime: normally the owner cannot spend it yet (see `_expired` for when
        /// that does not hold).
        Live,
        /// Unspent, and the 0x44 header's time or Hemi's block.timestamp is at or past the locktime: the owner can
        /// spend it soon or now.
        Expired,
        /// Spent: marked by `refresh`, or `Hvm.spendStatus` says Spent now.
        Ended,
        /// `Hvm.spendStatus` is Unknown, or 0x44 gave no header. Never read as live.
        Unknown
    }

    /// @notice A stored bond: one mapping entry, five storage slots.
    struct Bond {
        bytes32 txid; // display order
        bytes32 witnessProgram; // sha256(witnessScript): the P2WSH program; the output script is 0x0020 ‖ this
        bytes32 btcBlockHash; // as of: 0x44's hash at recording, display order
        address agent; // from the tag
        uint64 sats;
        uint32 locktime; // the witness script's CLTV value (a Unix time)
        uint64 hemiBlock; // the Hemi block of the recording transaction; nonzero for every stored bond
        uint64 endedHemiBlock; // the Hemi block of the refresh that saw it spent; 0 while not ended
        uint32 btcHeight; // as of: 0x44's height at recording
        uint32 endedBtcHeight; // 0x44's height when refresh saw it spent; 0 while not ended
        uint32 confirmations; // 0x43 at recording
        uint16 vout;
        uint16 tagVout;
    }

    /// @notice What `checkBond` returns, filled as far as the checks got.
    struct BondCheck {
        Verdict verdict;
        bytes32 bondId;
        bool recorded;
        address agent;
        uint64 sats;
        uint32 locktime;
        bytes32 witnessProgram;
        uint32 confirmations;
        uint32 btcHeight;
        bytes32 btcBlockHash;
        /// @dev The 0x44 header's timestamp.
        uint32 btcTime;
        /// @dev btcTime or block.timestamp >= locktime: `liveBond` would say Expired for it. Not a reason to refuse it.
        bool expired;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant KIND_BOND = keccak256("hemi-bitcoin-facts/bond");
    /// @notice "HFB1": the tag's first four data bytes.
    bytes4 public constant TAG_MAGIC = 0x48464231;
    uint256 public constant TAG_LENGTH = 50;
    uint256 public constant WITNESS_SCRIPT_LENGTH = 42;
    /// @notice The smallest bond: 10,000 sats (docs/streams/c-bonds.md C-1).
    uint64 public constant MIN_SATS = 10_000;
    uint32 public constant MIN_CONFIRMATIONS = 6;
    /// @notice BIP65's threshold: a smaller CLTV value is a block height.
    uint32 public constant MIN_LOCKTIME = 500_000_000;
    /// @notice Exclusive upper bound: from 2^31 the 4-byte script number is negative.
    uint256 public constant LOCKTIME_LIMIT = 1 << 31;
    /// @notice A 0x43 count above the 0x44 height plus this is an underflow, not a count (D-011).
    uint256 public constant CONFIRMATIONS_SLACK = 1000;

    /// @dev The first six tag bytes: OP_RETURN, push 48, "HFB1".
    bytes6 private constant TAG_PREFIX = 0x6a3048464231;
    /// @dev The P2WSH script prefix: OP_0, push 32.
    bytes2 private constant P2WSH_PREFIX = 0x0020;
    /// @dev secp256k1's field prime. A compressed key's x must be below it (security review finding 7). Whether x
    /// is on the curve is not checked on chain; a bond to an off-curve key can never be redeemed, which only
    /// locks the funds harder, and the SDK refuses such keys.
    uint256 private constant SECP256K1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    // ---------------------------------------------------------------------------------------------
    // Storage, events, errors
    // ---------------------------------------------------------------------------------------------

    mapping(bytes32 bondId => Bond) private _bonds;

    /// @notice Every stored field of a new bond, plus the witness script (emitted, not stored).
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

    /// @notice `refresh` saw the bond spent: the Bitcoin header it was seen at and the Hemi block of the refresh.
    event BondEnded(
        bytes32 indexed bondId, address indexed agent, uint32 btcHeight, bytes32 btcBlockHash, uint64 hemiBlock
    );

    /// @notice A record call whose check did not return Ok.
    error NotRecordable(Verdict verdict);
    /// @notice `refresh` of an id with no stored bond.
    error UnknownBond(bytes32 bondId);

    // ---------------------------------------------------------------------------------------------
    // Check and record
    // ---------------------------------------------------------------------------------------------

    /// @notice Whether output `bondVout` of Bitcoin transaction `txid` (display order) is a bond for this chain and
    /// this contract, with the tag at `tagVout`. Never reverts.
    /// @dev Steps, each failing with its verdict (the enum's order): the witness script template and its locktime
    /// (no hVM call); the 0x44 header; 0x42 (flags 003c0703) lists the transaction with both vouts and at most 128
    /// outputs; the bond output's listed script is 0x0020 ‖ sha256(witnessScript); `Hvm.spendStatus` with the
    /// listed value is Unspent, which means 0x48 answered for the output with that same value and script (so the
    /// value is 0x48's); the tag (`readTag`); the value is at least MIN_SATS; 0x43 gives at least
    /// MIN_CONFIRMATIONS. 0x43 runs last, so an unknown txid never burns its cap.
    function checkBond(bytes32 txid, uint16 bondVout, uint16 tagVout, bytes calldata witnessScript)
        external
        view
        returns (BondCheck memory)
    {
        return _checkBond(txid, bondVout, tagVout, witnessScript);
    }

    /// @notice Runs `checkBond` and stores the bond if it is Ok and new. Returns the bond id either way.
    function recordBond(bytes32 txid, uint16 bondVout, uint16 tagVout, bytes calldata witnessScript)
        external
        returns (bytes32 id)
    {
        BondCheck memory c = _checkBond(txid, bondVout, tagVout, witnessScript);
        if (c.verdict != Verdict.Ok) revert NotRecordable(c.verdict);
        id = c.bondId;
        if (c.recorded) return id;
        // A Hemi block number fits in 64 bits for the next billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 hemiBlock = uint64(block.number);
        Bond memory b = Bond({
            txid: txid,
            witnessProgram: c.witnessProgram,
            btcBlockHash: c.btcBlockHash,
            agent: c.agent,
            sats: c.sats,
            locktime: c.locktime,
            hemiBlock: hemiBlock,
            endedHemiBlock: 0,
            btcHeight: c.btcHeight,
            endedBtcHeight: 0,
            confirmations: c.confirmations,
            vout: bondVout,
            tagVout: tagVout
        });
        _bonds[id] = b;
        _emitRecorded(id, b, witnessScript);
    }

    // ---------------------------------------------------------------------------------------------
    // Liveness
    // ---------------------------------------------------------------------------------------------

    /// @notice Re-reads a stored bond's spend status and marks it ended if, and only if, `Hvm.spendStatus` says
    /// Spent (and 0x44 gives the header to date it). Unknown and Unspent change nothing. Anyone may call it.
    /// Ended is permanent: if hVM later shows the output unspent again (a Bitcoin reorg undid the spend, or hVM's
    /// answer was corrected), the bond stays Ended and recording it again returns the same id. This errs on the side
    /// of "not live"; whoever holds the key can spend the output at any time after the locktime anyway, and can make a
    /// new bond (independent audit, finding 3).
    /// @return ended whether the bond is ended after the call (true also if it already was)
    function refresh(bytes32 bondId) external returns (bool ended) {
        Bond memory b = _bonds[bondId];
        if (b.hemiBlock == 0) revert UnknownBond(bondId);
        if (b.endedHemiBlock != 0) return true;
        if (Hvm.spendStatus(b.txid, b.vout, b.sats, _scriptHash(b.witnessProgram)) != Hvm.Spend.Spent) return false;
        (bool headerOk, Hvm.Header memory h) = Hvm.lastHeader();
        if (!headerOk) return false;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 hemiBlock = uint64(block.number);
        Bond storage s = _bonds[bondId];
        s.endedBtcHeight = h.height;
        s.endedHemiBlock = hemiBlock;
        // Every hVM call is a STATICCALL to a precompile, so nothing can re-enter before this event.
        // forge-lint: disable-next-line(reentrancy-events)
        emit BondEnded(bondId, b.agent, h.height, h.hash, hemiBlock);
        return true;
    }

    /// @notice What a stored bond is now, re-read inside this call. Never reverts.
    /// @dev Ended if `refresh` marked it, or if `Hvm.spendStatus` says Spent now (refresh not yet called). Unknown
    /// if spendStatus is Unknown or 0x44 gives no header. Otherwise Expired when the 0x44 header's time or Hemi's
    /// block.timestamp is at or past the locktime (`_expired`), else Live. Bitcoin enforces a timestamp locktime
    /// against the median time past of the last 11 blocks, which runs about 1–2 hours behind Hemi's clock, so a bond
    /// reads Expired about 1–2 hours before its owner can actually spend it (docs/streams/c-bonds.md C-3).
    /// Gas: about 60k normally; for a spent bond whose funding transaction lists 128 outputs of long scripts, about
    /// 310k. With less it runs out of gas rather than answer wrongly, so a consumer should give it about 310k, or
    /// call it with try/catch and treat a failure as not live (security review finding 4).
    /// @return status the bond's status now
    /// @return agent the agent the bond is named for (zero if not recorded)
    /// @return sats the bond's value
    /// @return locktime the witness script's CLTV time
    function liveBond(bytes32 bondId)
        external
        view
        returns (Status status, address agent, uint64 sats, uint32 locktime)
    {
        Bond memory b = _bonds[bondId];
        if (b.hemiBlock == 0) return (Status.NotRecorded, address(0), 0, 0);
        agent = b.agent;
        sats = b.sats;
        locktime = b.locktime;
        if (b.endedHemiBlock != 0) return (Status.Ended, agent, sats, locktime);
        Hvm.Spend spend = Hvm.spendStatus(b.txid, b.vout, b.sats, _scriptHash(b.witnessProgram));
        if (spend == Hvm.Spend.Spent) return (Status.Ended, agent, sats, locktime);
        if (spend != Hvm.Spend.Unspent) return (Status.Unknown, agent, sats, locktime);
        (bool headerOk, Hvm.Header memory h) = Hvm.lastHeader();
        if (!headerOk) return (Status.Unknown, agent, sats, locktime);
        status = _expired(h.time, b.locktime) ? Status.Expired : Status.Live;
    }

    /// @dev Expired once either clock reaches the locktime: the 0x44 header's time, or Hemi's own block.timestamp.
    /// Hemi's clock keeps running when hVM's Bitcoin view is stale, and it normally runs 1–2 hours ahead of Bitcoin's
    /// median time past (which is what enforces the locktime), so Live means "not yet redeemable" while that holds
    /// (independent audit, finding 1). It is not guaranteed: if Hemi's clock lags real time (catch-up blocks after a
    /// sequencer halt carry past timestamps), or Bitcoin's median time past runs ahead of real time (most of the last
    /// 11 blocks stamped in the future), a redeemable bond can still read Live; keep a margin before the locktime.
    /// The header time alone can go down from one Bitcoin block to the next, so before Hemi's clock reaches the
    /// locktime an early Expired can turn back into Live; from then on it is Expired for good.
    function _expired(uint32 headerTime, uint32 locktime) private view returns (bool) {
        return headerTime >= locktime || block.timestamp >= locktime;
    }

    /// @notice The stored bond with this id; all zero if none.
    function bond(bytes32 bondId) external view returns (Bond memory) {
        return _bonds[bondId];
    }

    /// @notice What output `tagVout` of `txid` says as a tag, by the same rule `checkBond` applies: Ok and the agent;
    /// NotFound or TooManyOutputs when 0x42 cannot list the transaction and that vout; else BadTag, WrongChain,
    /// WrongContract or AmbiguousTag. Never reverts. One 0x42 call; nothing about the bond output is checked.
    function readTag(bytes32 txid, uint16 tagVout) external view returns (Verdict verdict, address agent) {
        (bool txOk, uint256 total, Hvm.TxOutput[] memory outs) = Hvm.txOutputs(txid);
        if (!txOk || tagVout >= total) return (Verdict.NotFound, address(0));
        if (total > outs.length) return (Verdict.TooManyOutputs, address(0));
        return _tagIn(outs, tagVout);
    }

    // ---------------------------------------------------------------------------------------------
    // Ids, tags and scripts (the SDK reproduces each of these)
    // ---------------------------------------------------------------------------------------------

    /// @notice keccak256(txid ‖ vout as 2 big-endian bytes): 34 bytes hashed, as BitcoinFacts' output subject.
    function bondSubject(bytes32 txid, uint16 vout) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(txid, vout));
    }

    /// @notice keccak256(abi.encode(KIND_BOND, bondSubject(txid, vout))): one id per output, ever.
    function bondId(bytes32 txid, uint16 vout) public pure returns (bytes32) {
        return keccak256(abi.encode(KIND_BOND, bondSubject(txid, vout)));
    }

    /// @notice The 50-byte tag script naming `agent` for this chain and this contract. Empty for the zero agent, or on
    /// a chain whose id does not fit in 32 bits: `checkBond` refuses both (BadTag, WrongChain).
    function tagScript(address agent) public view returns (bytes memory) {
        if (agent == address(0) || block.chainid > type(uint32).max) return "";
        // The chain id fits in 32 bits: checked just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(TAG_PREFIX, uint32(block.chainid), address(this), agent);
    }

    /// @notice The P2WSH scriptPubKey of a bond's witness script: 0x0020 ‖ sha256(witnessScript). Empty for anything
    /// that is not a valid bond script (the template, a valid key and a locktime `checkBond` accepts): the P2WSH of
    /// an arbitrary script, the empty one above all, can be spendable by anyone (delta review finding 2).
    function bondScript(bytes calldata witnessScript) external pure returns (bytes memory) {
        (bool ok, uint32 locktime) = _parseWitnessScript(witnessScript);
        if (!ok || locktime < MIN_LOCKTIME || locktime >= LOCKTIME_LIMIT) return "";
        return abi.encodePacked(P2WSH_PREFIX, sha256(witnessScript));
    }

    /// @notice The 42-byte witness script for `locktime` and `pubkey` (33 bytes, compressed: 02/03 and x below the
    /// field prime). Empty for any other key, or a locktime outside [MIN_LOCKTIME, LOCKTIME_LIMIT), so a caller
    /// cannot build a script `checkBond` would refuse for its template, key or locktime (delta review finding 5).
    function witnessScriptFor(uint32 locktime, bytes calldata pubkey) external pure returns (bytes memory) {
        if (locktime < MIN_LOCKTIME || locktime >= LOCKTIME_LIMIT) return "";
        if (pubkey.length != 33 || (pubkey[0] != 0x02 && pubkey[0] != 0x03)) return "";
        if (uint256(bytes32(pubkey[1:33])) >= SECP256K1_P) return "";
        return abi.encodePacked(hex"04", bytes4(_le32(locktime)), hex"b17521", pubkey, hex"ac");
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _checkBond(bytes32 txid, uint16 bondVout, uint16 tagVout, bytes calldata ws)
        internal
        view
        returns (BondCheck memory c)
    {
        c.bondId = bondId(txid, bondVout);
        c.recorded = _bonds[c.bondId].hemiBlock != 0;

        (bool templateOk, uint32 locktime) = _parseWitnessScript(ws);
        if (!templateOk) {
            c.verdict = Verdict.BadWitnessScript;
            return c;
        }
        c.locktime = locktime;
        c.witnessProgram = sha256(ws);
        if (locktime < MIN_LOCKTIME || uint256(locktime) >= LOCKTIME_LIMIT) {
            c.verdict = Verdict.BadLocktime;
            return c;
        }

        (bool headerOk, Hvm.Header memory h) = Hvm.lastHeader();
        if (!headerOk) {
            c.verdict = Verdict.NoBitcoinView;
            return c;
        }
        c.btcHeight = h.height;
        c.btcBlockHash = h.hash;
        c.btcTime = h.time;
        c.expired = _expired(h.time, locktime);

        Verdict v = _readOutputs(c, txid, bondVout, tagVout);
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
        c.verdict = conf < MIN_CONFIRMATIONS ? Verdict.FewConfirmations : Verdict.Ok;
    }

    /// @dev The 0x42 steps, the spend status and the tag. Fills sats and agent. Returns Ok or the verdict.
    function _readOutputs(BondCheck memory c, bytes32 txid, uint16 bondVout, uint16 tagVout)
        private
        view
        returns (Verdict)
    {
        (bool txOk, uint256 total, Hvm.TxOutput[] memory outs) = Hvm.txOutputs(txid);
        if (!txOk || bondVout >= total || tagVout >= total) return Verdict.NotFound;
        if (total > outs.length) return Verdict.TooManyOutputs;

        Hvm.TxOutput memory o = outs[bondVout];
        bytes memory expected = abi.encodePacked(P2WSH_PREFIX, c.witnessProgram);
        bytes32 expectedHash = keccak256(expected);
        if (o.scriptLength != expected.length || keccak256(o.script) != expectedHash) return Verdict.NotABond;
        Hvm.Spend spend = Hvm.spendStatus(txid, bondVout, o.sats, expectedHash);
        if (spend == Hvm.Spend.Spent) return Verdict.Spent;
        if (spend != Hvm.Spend.Unspent) return Verdict.SpendUnknown;
        c.sats = o.sats;

        (Verdict tv, address agent) = _tagIn(outs, tagVout);
        if (tv != Verdict.Ok) return tv;
        c.agent = agent;
        if (o.sats < MIN_SATS) return Verdict.BelowFloor;
        return Verdict.Ok;
    }

    /// @dev The tag at `tagVout` of a fully listed transaction, and no second "HFB1" tag of any kind: one output is
    /// a bond for at most one agent in one registry on one chain.
    function _tagIn(Hvm.TxOutput[] memory outs, uint256 tagVout) private view returns (Verdict, address) {
        (Verdict tv, address agent) = _readTag(outs[tagVout]);
        if (tv != Verdict.Ok) return (tv, address(0));
        for (uint256 i; i < outs.length; ++i) {
            if (i == tagVout) continue;
            if (_isAnyTag(outs[i])) return (Verdict.AmbiguousTag, address(0));
        }
        return (Verdict.Ok, agent);
    }

    /// @dev Whether `t` is a 50-byte `6a 30 "HFB1" …` script, whatever chain, contract or agent it names.
    function _isAnyTag(Hvm.TxOutput memory t) private pure returns (bool) {
        bytes memory s = t.script;
        if (t.scriptLength != TAG_LENGTH || s.length != TAG_LENGTH) return false;
        bytes32 head;
        assembly ("memory-safe") {
            head := mload(add(s, 32))
        }
        return bytes6(head) == TAG_PREFIX;
    }

    /// @dev Ok and the agent if `t` is exactly this chain's and this contract's tag for a nonzero agent.
    function _readTag(Hvm.TxOutput memory t) private view returns (Verdict, address agent) {
        bytes memory s = t.script;
        if (t.scriptLength != TAG_LENGTH || s.length != TAG_LENGTH) return (Verdict.BadTag, address(0));
        bytes32 head;
        bytes32 tail;
        assembly ("memory-safe") {
            head := mload(add(s, 32)) // bytes 0..31
            tail := mload(add(s, 62)) // bytes 30..61; the top 20 are bytes 30..49, the agent
        }
        // The casts below cut fixed byte ranges out of the 50-byte tag on purpose; the chain id is compared only
        // after checking it fits in 32 bits.
        // forge-lint: disable-start(unsafe-typecast)
        agent = address(bytes20(tail));
        if (bytes6(head) != TAG_PREFIX || agent == address(0)) return (Verdict.BadTag, address(0));
        if (block.chainid > type(uint32).max || uint32(bytes4(head << 48)) != uint32(block.chainid)) {
            return (Verdict.WrongChain, address(0));
        }
        if (address(bytes20(head << 80)) != address(this)) return (Verdict.WrongContract, address(0));
        // forge-lint: disable-end(unsafe-typecast)
        return (Verdict.Ok, agent);
    }

    /// @dev The template `04 <lt:4 LE> b1 75 21 <02|03 + 32 bytes> ac`; returns the locktime when it matches.
    function _parseWitnessScript(bytes calldata ws) internal pure returns (bool ok, uint32 locktime) {
        if (ws.length != WITNESS_SCRIPT_LENGTH) return (false, 0);
        if (ws[0] != 0x04 || ws[5] != 0xb1 || ws[6] != 0x75 || ws[7] != 0x21 || ws[41] != 0xac) return (false, 0);
        if (ws[8] != 0x02 && ws[8] != 0x03) return (false, 0);
        if (uint256(bytes32(ws[9:41])) >= SECP256K1_P) return (false, 0);
        locktime = uint32(uint8(ws[1])) | (uint32(uint8(ws[2])) << 8) | (uint32(uint8(ws[3])) << 16)
            | (uint32(uint8(ws[4])) << 24);
        return (true, locktime);
    }

    /// @dev keccak256 of the P2WSH scriptPubKey for a witness program, as `Hvm.spendStatus` takes it.
    function _scriptHash(bytes32 witnessProgram) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(P2WSH_PREFIX, witnessProgram));
    }

    /// @dev `x` with its four bytes reversed (little-endian).
    function _le32(uint32 x) private pure returns (uint32) {
        return (x >> 24) | ((x >> 8) & 0xff00) | ((x << 8) & 0xff0000) | (x << 24);
    }

    /// @dev Split out of recordBond to keep the stack shallow.
    function _emitRecorded(bytes32 id, Bond memory b, bytes calldata ws) private {
        // Every hVM call is a STATICCALL to a precompile, so nothing can re-enter before this event.
        // forge-lint: disable-start(reentrancy-events)
        emit BondRecorded(
            id,
            b.agent,
            b.txid,
            b.vout,
            b.tagVout,
            b.sats,
            b.locktime,
            b.witnessProgram,
            b.confirmations,
            b.btcHeight,
            b.btcBlockHash,
            b.hemiBlock,
            ws
        );
        // forge-lint: disable-end(reentrancy-events)
    }
}
